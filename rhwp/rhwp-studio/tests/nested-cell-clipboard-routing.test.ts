import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outer = { controlIndex: 3, cellIndex: 1, cellParaIndex: 2 };
const inner = { controlIndex: 0, cellIndex: 0, cellParaIndex: 4 };
const nestedStart = {
  sectionIndex: 0, paragraphIndex: 8, parentParaIndex: 8,
  controlIndex: 3, cellIndex: 1, cellParaIndex: 2, charOffset: 1,
  cellPath: [outer, inner],
};
const nestedEnd = {
  ...nestedStart, charOffset: 3,
  cellPath: [outer, { ...inner, cellParaIndex: 6 }],
};

test('copying text across nested cell paragraphs sends the innermost address to native copy and HTML export', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { onCopy } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
    const calls: [string, ...unknown[]][] = [];
    const data = new Map<string, string>();
    const handler = {
      active: true,
      cursor: {
        isInHeaderFooter: () => false,
        isInPictureObjectSelection: () => false,
        hasSelection: () => true,
        getSelectionOrdered: () => ({ start: nestedStart, end: nestedEnd }),
      },
      wasm: {
        copySelectionInCell: (...args: unknown[]) => { calls.push(['flatCopy', ...args]); return '{}'; },
        copySelectionInCellByPath: (...args: unknown[]) => { calls.push(['pathCopy', ...args]); return '{}'; },
        exportSelectionInCellHtml: (...args: unknown[]) => { calls.push(['flatHtml', ...args]); return '<p>wrong</p>'; },
        exportSelectionInCellByPathHtml: (...args: unknown[]) => { calls.push(['pathHtml', ...args]); return '<p>selected</p>'; },
        getClipboardText: () => 'selected',
      },
    };
    onCopy.call(handler, {
      preventDefault: () => {},
      clipboardData: { setData: (type: string, value: string) => data.set(type, value) },
    });
    assert.deepEqual(calls.map(([name]) => name), ['pathCopy', 'pathHtml']);
    assert.deepEqual(calls[0].slice(1), [0, 8, JSON.stringify(nestedStart.cellPath), 4, 1, 6, 3]);
    assert.deepEqual(calls[1].slice(1), [0, 8, JSON.stringify(nestedStart.cellPath), 4, 1, 6, 3]);
    assert.equal(data.get('text/plain'), 'selected');
    assert.match(data.get('text/html') ?? '', /<p>selected<\/p>/);
  } finally {
    await vite.close();
  }
});

test('pasting an internal table into a nested cell keeps the nested address and cursor position', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { onPaste } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
    const calls: [string, ...unknown[]][] = [];
    let finalPosition: any;
    const handler: any = {
      active: true, readOnly: false, userEditingLocked: false,
      cursor: {
        isInPictureObjectSelection: () => false,
        isInTableObjectSelection: () => false,
        hasSelection: () => false,
        getPosition: () => nestedStart,
        isInHeaderFooter: () => false,
      },
      wasm: {
        getClipboardText: () => '[표]',
        clipboardHasControl: () => true,
        hasInternalClipboard: () => true,
        pasteControl: (...args: unknown[]) => { calls.push(['bodyControl', ...args]); return '{"ok":true,"paraIdx":8}'; },
        pasteInternalInCellByPath: (...args: unknown[]) => {
          calls.push(['cellPaste', ...args]);
          return '{"ok":true,"cellParaIdx":5,"charOffset":0}';
        },
      },
      executeOperation: ({ operation }: any) => { finalPosition = operation(handler.wasm); },
    };
    onPaste.call(handler, { preventDefault: () => {}, clipboardData: null });
    assert.deepEqual(calls, [['cellPaste', 0, 8, JSON.stringify(nestedStart.cellPath), 1]]);
    assert.deepEqual(finalPosition.cellPath, [outer, { ...inner, cellParaIndex: 5 }]);
    assert.equal(finalPosition.charOffset, 0);
  } finally {
    await vite.close();
  }
});

test('a failed object copy leaves the selected object in the document on cut', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { onCopy, onCut } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
    let deleted = false;
    const handler: any = {
      active: true, readOnly: false, userEditingLocked: false,
      cursor: {
        isInHeaderFooter: () => false,
        isInPictureObjectSelection: () => true,
        getSelectedPictureRef: () => ({ sec: 0, ppi: 8, ci: 0, type: 'image' }),
        moveOutOfSelectedPicture: () => {},
      },
      wasm: { copyControl: () => { throw new Error('copy failed'); } },
      onCopy(event: unknown) { return onCopy.call(this, event); },
      eventBus: { emit: () => {} },
      executeOperation: () => { deleted = true; },
    };
    onCut.call(handler, { preventDefault: () => {}, clipboardData: null });
    assert.equal(deleted, false);
  } finally {
    await vite.close();
  }
});

test('external HTML with the same placeholder text does not paste a stale internal table', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { onPaste } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
    const calls: string[] = [];
    const body = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
    const handler: any = {
      active: true, readOnly: false, userEditingLocked: false,
      cursor: {
        isInPictureObjectSelection: () => false,
        isInTableObjectSelection: () => false,
        isInHeaderFooter: () => false,
        hasSelection: () => false,
        getPosition: () => body,
        clearSelection: () => {},
      },
      wasm: {
        getClipboardText: () => '[표]',
        clipboardHasControl: () => true,
        hasInternalClipboard: () => true,
        pasteControl: () => { calls.push('internalTable'); return '{"ok":true,"paraIdx":0}'; },
        pasteHtml: () => { calls.push('externalHtml'); return '{"ok":true,"paraIdx":0,"charOffset":1}'; },
      },
      executeOperation: ({ operation }: any) => { operation(handler.wasm); },
    };
    const data = new Map([['text/plain', '[표]'], ['text/html', '<p>external table</p>']]);
    onPaste.call(handler, {
      preventDefault: () => {},
      clipboardData: { getData: (type: string) => data.get(type) ?? '' },
    });
    assert.deepEqual(calls, ['externalHtml']);
  } finally {
    await vite.close();
  }
});

test('plain image placeholder still pastes the copied internal image when the marker is unavailable', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { onPaste } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
    const calls: string[] = [];
    const body = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
    const handler: any = {
      active: true, readOnly: false, userEditingLocked: false,
      cursor: {
        isInPictureObjectSelection: () => false,
        isInTableObjectSelection: () => false,
        isInHeaderFooter: () => false,
        hasSelection: () => false,
        getPosition: () => body,
      },
      wasm: {
        getClipboardText: () => '[그림]',
        clipboardHasControl: () => true,
        clipboardIsSingleControl: () => true,
        hasInternalClipboard: () => true,
        pasteControl: () => { calls.push('internalImage'); return '{"ok":true,"paraIdx":0}'; },
      },
      executeOperation: ({ operation }: any) => { operation(handler.wasm); },
    };
    onPaste.call(handler, {
      preventDefault: () => {},
      clipboardData: { getData: (type: string) => type === 'text/plain' ? '[그림]' : '' },
    });
    assert.deepEqual(calls, ['internalImage']);
  } finally {
    await vite.close();
  }
});

test('mixed text and image selection pastes every paragraph into the body', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { onPaste } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
    const calls: string[] = [];
    const body = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
    const handler: any = {
      active: true, readOnly: false, userEditingLocked: false,
      cursor: {
        isInPictureObjectSelection: () => false,
        isInTableObjectSelection: () => false,
        isInHeaderFooter: () => false,
        hasSelection: () => false,
        getPosition: () => body,
      },
      wasm: {
        getClipboardText: () => 'image\nfollowing text',
        clipboardHasControl: () => true,
        clipboardIsSingleControl: () => false,
        hasInternalClipboard: () => true,
        pasteControl: () => { calls.push('firstControlOnly'); return '{"ok":true,"paraIdx":0}'; },
        pasteInternal: () => { calls.push('wholeSelection'); return '{"ok":true,"paraIdx":1,"charOffset":14}'; },
      },
      executeOperation: ({ operation }: any) => { operation(handler.wasm); },
    };
    onPaste.call(handler, { preventDefault: () => {}, clipboardData: null });
    assert.deepEqual(calls, ['wholeSelection']);
  } finally {
    await vite.close();
  }
});

test('cell select-all includes text after an inline equation', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { CursorState } = await vite.ssrLoadModule('/src/engine/cursor.ts');
    const path = [{ controlIndex: 1, cellIndex: 2, cellParaIndex: 0 }];
    const wasm = {
      getCellParagraphCountByPath: () => 1,
      getCellParagraphLengthByPath: () => 4,
      getCellLogicalLengthByPath: () => 5,
    };
    const cursor: any = new CursorState(wasm);
    cursor.updateRect = () => {};
    cursor.moveTo({
      sectionIndex: 0, paragraphIndex: 0, parentParaIndex: 3,
      controlIndex: 1, cellIndex: 2, cellParaIndex: 0,
      cellPath: path, charOffset: 2,
    });
    assert.equal(cursor.selectAllInCurrentCell(), true);
    assert.equal(cursor.getSelectionOrdered()?.end.charOffset, 5);
  } finally {
    await vite.close();
  }
});

test('flat cell select-all resolves a one-entry logical path', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { CursorState } = await vite.ssrLoadModule('/src/engine/cursor.ts');
    const paths: string[] = [];
    const wasm = {
      getCellParagraphCount: () => 1,
      getCellParagraphLength: () => 4,
      getCellLogicalLengthByPath: (_sec: number, _parent: number, pathJson: string) => {
        paths.push(pathJson);
        return 5;
      },
    };
    const cursor: any = new CursorState(wasm);
    cursor.updateRect = () => {};
    cursor.moveTo({
      sectionIndex: 0, paragraphIndex: 0, parentParaIndex: 3,
      controlIndex: 1, cellIndex: 2, cellParaIndex: 0, cellPath: [], charOffset: 2,
    });
    assert.equal(cursor.selectAllInCurrentCell(), true);
    assert.equal(cursor.getSelectionOrdered()?.end.charOffset, 5);
    assert.deepEqual(paths, [JSON.stringify([{ controlIndex: 1, cellIndex: 2, cellParaIndex: 0 }])]);
  } finally {
    await vite.close();
  }
});

test('body document-end selection includes text after an inline equation', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { CursorState } = await vite.ssrLoadModule('/src/engine/cursor.ts');
    const wasm = {
      getSectionCount: () => 1,
      getParagraphCount: () => 1,
      getParagraphLength: () => 4,
      getLogicalLength: () => 5,
    };
    const cursor: any = new CursorState(wasm);
    cursor.updateRect = () => {};
    cursor.moveToDocumentStart();
    cursor.setAnchor();
    cursor.moveToDocumentEnd();
    assert.equal(cursor.getSelectionOrdered()?.end.charOffset, 5);
  } finally {
    await vite.close();
  }
});

test('중첩 셀 블록 복사·잘라내기·붙여넣기는 경로와 한 번의 실행 취소를 유지한다', async () => {
  const vite = await createTestModuleServer(root);
  try {
    const { onCopy, onCut, onPaste, clearSelectedCellBlock } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
    const calls: any[] = [];
    const data = new Map<string, string>();
    let operations = 0;
    const handler: any = {
      active: true,
      cursor: {
        isInCellSelectionMode: () => true,
        isProtectedCellSelectionMode: () => false,
        getCellTableContext: () => ({ sec: 0, ppi: 8, ci: 3, cellPath: [outer, inner] }),
        getSelectedCellRange: () => ({ startRow: 1, startCol: 0, endRow: 2, endCol: 1 }),
        getExcludedCells: () => new Set(),
        getPosition: () => nestedStart,
        hasSelection: () => false,
        isInHeaderFooter: () => false,
        isInPictureObjectSelection: () => false,
        isInTableObjectSelection: () => false,
      },
      wasm: {
        getTableCellTargetByPath: () => ({ cellIndex: 2, cellParaIndex: 0, charCount: 0 }),
        copyTableCellRange: (...args: any[]) => { calls.push(['copy', ...args]); return { ok: true, text: '가\t나', html: '<table><tr><td>가</td><td>나</td></tr></table>' }; },
        clearTableCellRange: (...args: any[]) => { calls.push(['clear', ...args]); return { ok: true }; },
        pasteTableCellRange: (...args: any[]) => { calls.push(['paste', ...args]); return { ok: true }; },
        hasInternalClipboard: () => true,
        getClipboardText: () => '가\t나',
      },
      executeOperation: ({ operation }: any) => { operations++; operation(handler.wasm); },
      updateCellSelection: () => {},
    };
    const event = { preventDefault: () => {}, clipboardData: {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
    } };
    assert.equal(onCopy.call(handler, event), true);
    assert.equal(data.get('text/plain'), '가\t나');
    assert.match(data.get('text/html')!, /<table>/);
    onCut.call(handler, event);
    assert.equal(operations, 1);
    onPaste.call(handler, event);
    assert.equal(operations, 2);
    clearSelectedCellBlock.call(handler);
    assert.equal(operations, 3);
    assert.deepEqual(calls.map(call => call[0]), ['copy', 'copy', 'clear', 'paste', 'clear']);
    assert.deepEqual(calls[0].slice(1), [0, 8, JSON.stringify([outer, inner]), 1, 0, 2, 1]);
    assert.deepEqual(calls[3].slice(1), [0, 8, JSON.stringify([outer, inner]), 1, 0]);
    handler.cursor.isInCellSelectionMode = () => false;
    handler.cursor.isInCell = () => true;
    handler.wasm.getCellInfoByPath = () => ({ row: 2, col: 1 });
    onPaste.call(handler, event);
    assert.equal(operations, 4);
    assert.deepEqual(calls.at(-1), ['paste', 0, 8, JSON.stringify(nestedStart.cellPath), 2, 1]);
    handler.cursor.isInCellSelectionMode = () => true;
    handler.cursor.isProtectedCellSelectionMode = () => true;
    onCut.call(handler, event);
    onPaste.call(handler, event);
    clearSelectedCellBlock.call(handler);
    assert.equal(operations, 4);
  } finally {
    await vite.close();
  }
});
