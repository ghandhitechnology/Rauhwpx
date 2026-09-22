import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';
import { codeOnly, functionBodyFrom } from './support/source-guard.ts';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

async function withJournal(run: (Journal: any) => void) {
  const vite = await createTestModuleServer(rootDir);
  try {
    const { PictureResizeJournal } = await vite.ssrLoadModule('/src/engine/picture-resize-journal.ts');
    run(PictureResizeJournal);
  } finally { await vite.close(); }
}

function fake() {
  let current = { height: 7296, currentHeight: 7295, raw: 'original-146-bytes' };
  let next = 0;
  const store = new Map<number, typeof current>();
  const refs: unknown[] = [];
  return { store, refs, get current() { return current; },
    capturePictureTransform(ref: unknown) { refs.push(ref); const id = next++; store.set(id, { ...current }); return id; },
    swapPictureTransform(id: number) {
      const saved = store.get(id); assert.ok(saved);
      store.set(id, current); current = saved;
    },
    discardPictureTransform(id: number) { store.delete(id); },
    resize() { current = { height: 7696, currentHeight: 7696, raw: '' }; },
    setPictureProperties() { assert.fail('그림 Undo를 스칼라 setter로 우회하면 안 된다'); },
  };
}

test('실제 resize 뒤 Undo/Redo는 원본 변환을 교환하고 discard로 해제한다', async () => {
  await withJournal(Journal => {
    const wasm = fake();
    const ref = { sec: 0, ppi: 236, ci: 0, type: 'image' };
    const original = { ...wasm.current };
    const journal = Journal.capture(wasm, [ref]);
    wasm.resize();
    const changed = { ...wasm.current };
    const command = journal.command([{ ...ref, before: { height: 7296 }, after: { height: 7696 } }]);
    for (let i = 0; i < 3; i++) {
      command.undo(wasm); assert.deepEqual(wasm.current, original);
      command.execute(wasm); assert.deepEqual(wasm.current, changed);
    }
    assert.equal(command.snapshotResourceCount?.() ?? 0, 0);
    command.discard(wasm); assert.equal(wasm.store.size, 0);
  });
});

test('취소는 변경을 되돌리고 셀·머리말 경로는 캡처에 그대로 전달한다', async () => {
  await withJournal(Journal => {
    for (const location of [
      { cellPath: [{ controlIndex: 2, cellIndex: 0, cellParaIndex: 1 }] },
      { headerFooter: { kind: 'header', outerParaIdx: 3, outerControlIdx: 1 } },
    ]) {
      const wasm = fake();
      const ref = { sec: 0, ppi: 4, ci: 0, type: 'image', ...location };
      const original = { ...wasm.current };
      const journal = Journal.capture(wasm, [ref]);
      assert.deepEqual(wasm.refs[0], ref);
      wasm.resize(); journal.cancel(wasm);
      assert.deepEqual(wasm.current, original);
      assert.equal(wasm.store.size, 0);
    }
  });
});

test('다중 선택 캡처 실패는 앞서 캡처한 핸들을 해제한다', async () => {
  await withJournal(Journal => {
    const wasm = fake();
    const capture = wasm.capturePictureTransform.bind(wasm);
    wasm.capturePictureTransform = ref => {
      if (wasm.store.size) throw new Error('capture failed');
      return capture(ref);
    };
    assert.throws(() => Journal.capture(wasm, [{ type: 'image' }, { type: 'image' }]));
    assert.equal(wasm.store.size, 0);
  });
});

test('리사이즈 경로는 첫 뮤테이션 전에 저널을 보관하고 회전·머리말 계약은 유지한다', () => {
  const src = codeOnly(readFileSync(join(rootDir, 'src/engine/input-handler-picture.ts'), 'utf8'));

  const finish = functionBodyFrom(src, 'export function finishPictureResizeDrag(');
  const capture = finish.indexOf('PictureResizeJournal.capture(');
  assert.ok(capture > -1, 'finishPictureResizeDrag 는 저널을 보관한다');
  assert.ok(capture < finish.indexOf('setObjectProperties.call('), '보관은 첫 setObjectProperties 보다 앞선다');
  assert.equal(finish.match(/state\.resizeTransformJournal\.command\(/g)?.length, 2, '다중·단일 기록 모두 저널 커맨드를 쓴다');
  assert.equal(finish.match(/state\.resizeTransformJournal = null/g)?.length, 2, '기록 뒤 저널 소유권을 넘긴다');
  assert.doesNotMatch(finish, /new ResizeObjectCommand\(/);
  assert.equal(finish.match(/headerFooter: (r|state\.ref)\.headerFooter/g)?.length, 2, '머리말/꼬리말 marker 는 두 기록 대상 모두에 남는다');

  const arrow = functionBodyFrom(src, 'export function resizeSelectedPicture(');
  assert.ok(arrow.indexOf('PictureResizeJournal.capture(') < arrow.indexOf('setObjectProperties.call('));
  assert.match(arrow, /journal\.command\(/);
  assert.match(arrow, /journal\.cancel\(this\.wasm\)/);

  assert.match(functionBodyFrom(src, 'export function cleanupPictureResizeDrag('), /journal\.cancel\(this\.wasm\)/);
  assert.match(functionBodyFrom(src, 'export function finishPictureRotateDrag('), /new ResizeObjectCommand\(/, '회전은 스칼라 기록을 유지한다');
});
