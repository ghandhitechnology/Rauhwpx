import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const src = (rel: string): string => readFileSync(join(rootDir, rel), 'utf8');

test('#4121 history 복원용 HF 선택은 현재 target과 문단 경계를 다시 검증한다', async () => {
  const vite = await createTestModuleServer(rootDir);
  try {
    const { CursorState } = await vite.ssrLoadModule('/src/engine/cursor.ts');
    const wasm = {
      getCursorRectInHeaderFooter: (
        _sec: number, _header: boolean, _apply: number,
        paraIdx: number, charOffset: number, previewPage: number,
      ) => ({ pageIndex: previewPage, x: charOffset * 8, y: paraIdx * 20, height: 12 }),
      getHeaderFooterPreviewPage: () => 4,
      getHeaderFooterParaInfo: (_sec: number, _header: boolean, _apply: number, paraIdx: number) =>
        JSON.stringify({ paraCount: 2, charCount: paraIdx === 0 ? 5 : 4 }),
    };
    const cursor: any = new CursorState(wasm);
    cursor.enterHeaderFooterMode(true, 2, 1, 4);

    assert.equal(cursor.selectHeaderFooterRange(
      { sectionIdx: 2, isHeader: true, applyTo: 1, paraIdx: 0, charOffset: 2 },
      { sectionIdx: 2, isHeader: true, applyTo: 1, paraIdx: 1, charOffset: 3 },
      6,
    ), true);
    assert.equal(cursor.getHeaderFooterSelectionOrdered()?.previewPage, 4);

    cursor.clearSelection();
    assert.equal(cursor.selectHeaderFooterRange(
      { sectionIdx: 2, isHeader: true, applyTo: 1, paraIdx: 0, charOffset: 2 },
      { sectionIdx: 2, isHeader: true, applyTo: 1, paraIdx: 1, charOffset: 99 },
      6,
    ), false);
    assert.equal(cursor.getHeaderFooterSelectionOrdered(), null, 'stale 범위는 선택 없이 복원한다');
  } finally {
    await vite.close();
  }
});

test('#4121 HF snapshot command는 undo/redo 문맥과 선택 정책을 분리한다', async () => {
  const vite = await createTestModuleServer(rootDir);
  try {
    const { SubmodeSelectionSnapshotCommand } = await vite.ssrLoadModule('/src/engine/command.ts');
    let nextSnapshot = 1;
    const wasm: any = {
      saveSnapshot: () => nextSnapshot++,
      restoreSnapshot: () => {},
      discardSnapshot: () => {},
    };
    const before = {
      mode: 'headerFooter', sectionIdx: 0, isHeader: true, applyTo: 0,
      paraIdx: 1, charOffset: 3, previewPage: 4,
    };
    const after = {
      mode: 'headerFooter', sectionIdx: 0, isHeader: true, applyTo: 0,
      paraIdx: 0, charOffset: 2, previewPage: 4,
    };
    const selection = {
      mode: 'headerFooter',
      start: { sectionIdx: 0, isHeader: true, applyTo: 0, paraIdx: 0, charOffset: 2 },
      end: { sectionIdx: 0, isHeader: true, applyTo: 0, paraIdx: 1, charOffset: 3 },
      previewPage: 4,
    };
    const body = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
    const cmd = new SubmodeSelectionSnapshotCommand(
      'deleteSelectionInHeaderFooter', body, body, () => body,
      before, () => after, selection, null,
    );

    cmd.execute(wasm);
    assert.deepEqual(cmd.editContext(), after);
    assert.equal(cmd.selectionAfter(), null);
    cmd.undo(wasm);
    assert.deepEqual(cmd.editContext(), before);
    assert.deepEqual(cmd.selectionBefore(), selection);
    cmd.execute(wasm);
    assert.deepEqual(cmd.editContext(), after);
  } finally {
    await vite.close();
  }
});

test('#4121 HF IME 시작은 남아 있는 본문 selection을 삭제하지 않는다', async () => {
  const vite = await createTestModuleServer(rootDir);
  try {
    const { onCompositionStart } = await vite.ssrLoadModule('/src/engine/input-handler-text.ts');
    let bodyDeleteCalls = 0;
    const handler: any = {
      resetRawTextMutationEffects: () => {},
      headerFooterSelectionComposition: false,
      getNonEmptyHeaderFooterSelection: () => null,
      cursor: {
        isInHeaderFooter: () => true,
        isInFootnote: () => false,
        hasSelection: () => true,
        getPosition: () => ({ sectionIndex: 0, paragraphIndex: 9, charOffset: 3 }),
        hfCharOffset: 2,
      },
      textarea: { value: '' },
      deleteSelection: () => { bodyDeleteCalls++; },
      canInsertTextInFormMode: () => true,
      captureCompositionAnchorRect: () => {},
      imeSession: {
        isComposing: false,
        start() { handler.isComposing = true; this.isComposing = true; },
        reset() { handler.isComposing = false; this.isComposing = false; },
        cancel() {},
      },
      isComposing: false,
      compositionAnchor: null,
      compositionLength: 0,
    };

    onCompositionStart.call(handler);

    assert.equal(bodyDeleteCalls, 0);
    assert.equal(handler.isComposing, true);
    assert.deepEqual(handler.compositionAnchor, {
      sectionIndex: 0, paragraphIndex: 9, charOffset: 2,
    });
  } finally {
    await vite.close();
  }
});
