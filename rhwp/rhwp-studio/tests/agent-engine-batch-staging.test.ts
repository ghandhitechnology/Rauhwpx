/**
 * apply_engine_edits 스테이징 — 엔진 배치가 semantic 쓰기와 한 턴에 섞여 한 change set 으로
 * 검토되고, 거절하면 스냅샷으로 전부 되돌아가며 승인하면 그대로 남는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './agent-test-env.ts';
import { diffParagraphDigests } from '../src/agent/pending-edits.ts';

const ORIGINAL = ['첫 문단', '둘째 문단', '셋째 문단'];

/** 앞 semantic 쓰기 → 문단을 나누는 엔진 배치 → 뒤 semantic 쓰기 */
async function mixedTurn(env: ReturnType<typeof makeEnv>) {
  env.pending.beginTurn('claude');
  await env.call('insert_text', { sectionIdx: 0, paraIdx: 2, charOffset: 0, text: 'A' });
  const batch = await env.call('apply_engine_edits', {
    operations: [
      { method: 'insertText', args: [0, 0, 0, 'B'] },
      { method: 'splitParagraph', args: [0, 1, 2] },
    ],
  });
  await env.call('insert_text', { sectionIdx: 0, paraIdx: 3, charOffset: 1, text: 'C' });
  return batch;
}

test('engine batch mixes with semantic writes in one change set and reject restores everything', async () => {
  const env = makeEnv(ORIGINAL);
  const batch = await mixedTurn(env);
  assert.deepEqual(env.body, ['B첫 문단', '둘째', ' 문단', 'AC셋째 문단']);
  assert.deepEqual(batch.changedParagraphs, [{ sectionIdx: 0, paraStart: 0, paraEnd: 2 }]);

  const sets = env.pending.getChangeSets();
  assert.equal(sets.length, 1);
  assert.equal(batch.changeSetId, sets[0].id);
  const [first, engine, last] = sets[0].ops;
  assert.equal(engine.kind === 'object' && engine.obj.type, 'engineBatch');
  // 배치가 나눈 문단 뒤의 앞 op 은 한 문단 밀려 새 좌표를 가리킨다
  assert.equal(first.kind === 'insert' && first.range.startParaIdx, 3);
  assert.equal(last.kind === 'insert' && last.range.startParaIdx, 3);

  env.pending.endTurn('review');
  env.pending.reject(sets[0].id);
  assert.deepEqual(env.body, ORIGINAL);
  assert.equal(env.pending.hasPending(), false);
});

test('approving a mixed change set keeps the engine batch and the semantic writes', async () => {
  const env = makeEnv(ORIGINAL);
  await mixedTurn(env);
  const events: string[] = [];
  env.pending.onChange((event) => { events.push(event.type); });
  env.pending.endTurn('commit');
  assert.deepEqual(env.body, ['B첫 문단', '둘째', ' 문단', 'AC셋째 문단']);
  assert.equal(env.pending.hasPending(), false);
  assert.ok(events.includes('approved'));
  assert.ok(!events.includes('invalidated'));
});

test('a user edit after the batch keeps it in the document instead of wiping the edit', async () => {
  const env = makeEnv(ORIGINAL);
  env.pending.beginTurn('claude');
  await env.call('apply_engine_edits', { operations: [{ method: 'insertText', args: [0, 1, 0, 'B'] }] });
  // 사용자 입력 — 스냅샷 복원이 이것까지 지우므로 배치는 되돌리지 않는다
  env.body[0] = `${env.body[0]}!`;
  env.bus.emit('document-mutated', 'input-handler-edit');
  let leftInDocument: boolean | undefined;
  env.pending.onChange((event) => {
    if (event.type === 'invalidated') leftInDocument = event.leftInDocument;
  });
  env.pending.endTurn('review');
  env.pending.reject(env.pending.getChangeSets()[0].id);
  assert.deepEqual(env.body, ['첫 문단!', 'B둘째 문단', '셋째 문단']);
  assert.equal(leftInDocument, true);
});

test('a failing engine batch restores the document and stages nothing', async () => {
  const env = makeEnv(ORIGINAL);
  env.pending.beginTurn('claude');
  await assert.rejects(env.call('apply_engine_edits', {
    operations: [
      { method: 'insertText', args: [0, 0, 0, 'B'] },
      { method: 'mergeParagraph', args: [0, 1] },
    ],
  }), /ENGINE_EDIT_UNAVAILABLE|unavailable/);
  assert.deepEqual(env.body, ORIGINAL);
  assert.equal(env.pending.hasPending(), false);
});

test('paragraph digest diff finds each changed span and the shift after it', () => {
  assert.deepEqual(diffParagraphDigests(['a', 'b', 'c'], ['a', 'x', 'y', 'c']), {
    spans: [{ paraStart: 1, paraEnd: 2 }], shifts: [{ from: 2, delta: 1 }],
  });
  assert.deepEqual(diffParagraphDigests(['a', 'b', 'c'], ['a', 'c']), {
    spans: [{ paraStart: 1, paraEnd: 1 }], shifts: [{ from: 2, delta: -1 }],
  });
  assert.deepEqual(diffParagraphDigests(['a', 'b'], ['a', 'b']), { spans: [], shifts: [] });
  // 떨어진 두 변경: 뒤 문단 수정(이동 없음)과 앞쪽 삽입 — 사이 문단(b, c)은 삽입만큼 민다
  assert.deepEqual(diffParagraphDigests(['a', 'b', 'c', 'd', 'e'], ['a', 'X', 'b', 'c', 'D', 'e']), {
    spans: [{ paraStart: 1, paraEnd: 1 }, { paraStart: 4, paraEnd: 4 }], shifts: [{ from: 1, delta: 1 }],
  });
  // 앞 삭제 + 뒤 삽입은 합이 0이어도 구간별로 민다 (뒤쪽 구간부터)
  assert.deepEqual(diffParagraphDigests(['a', 'b', 'c', 'd', 'e'], ['a', 'c', 'd', 'Y', 'e']), {
    spans: [{ paraStart: 1, paraEnd: 1 }, { paraStart: 3, paraEnd: 3 }],
    shifts: [{ from: 4, delta: 1 }, { from: 2, delta: -1 }],
  });
});

test('pending ops between two separate engine batch changes follow their paragraphs', async () => {
  const env = makeEnv(['a', 'b', 'c', 'd', 'e']);
  env.pending.beginTurn('claude');
  await env.call('insert_text', { sectionIdx: 0, paraIdx: 2, charOffset: 0, text: 'Q' });
  await env.call('apply_engine_edits', {
    operations: [
      { method: 'insertText', args: [0, 3, 1, '!'] },
      { method: 'splitParagraph', args: [0, 0, 1] },
    ],
  });
  assert.deepEqual(env.body, ['a', '', 'b', 'Qc', 'd!', 'e']);
  const [insert] = env.pending.getChangeSets()[0].ops;
  assert.equal(insert.kind === 'insert' && insert.range.startParaIdx, 3);
  env.pending.endTurn('review');
  env.pending.reject(env.pending.getChangeSets()[0].id);
  assert.deepEqual(env.body, ['a', 'b', 'c', 'd', 'e']);
});

test('rejectAll reverts a later engine batch set even after an earlier set was staged', async () => {
  const env = makeEnv(ORIGINAL);
  env.pending.beginTurn('claude');
  await env.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'A' });
  env.pending.endTurn('review');
  env.pending.beginTurn('claude');
  await env.call('apply_engine_edits', { operations: [{ method: 'insertText', args: [0, 2, 0, 'B'] }] });
  env.pending.endTurn('review');
  assert.deepEqual(env.body, ['A첫 문단', '둘째 문단', 'B셋째 문단']);
  env.pending.rejectAll();
  assert.deepEqual(env.body, ORIGINAL);
  assert.equal(env.pending.hasPending(), false);
});

test('undo/redo invalidation reverts every staged engine batch set, newest first', async () => {
  const env = makeEnv(ORIGINAL);
  for (const [para, text] of [[0, 'A'], [2, 'B']] as const) {
    env.pending.beginTurn('claude');
    await env.call('apply_engine_edits', { operations: [{ method: 'insertText', args: [0, para, 0, text] }] });
    env.pending.endTurn('review');
  }
  env.bus.emit('history-jumped');
  assert.deepEqual(env.body, ORIGINAL);
  assert.equal(env.pending.hasPending(), false);
});
