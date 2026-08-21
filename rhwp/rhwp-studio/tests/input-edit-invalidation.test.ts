import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isPageLocalTextEditCommand,
  MAX_PAGE_LOCAL_TEXT_EDIT_CHARS,
} from '../src/engine/input-edit-invalidation.ts';
import type { DocumentPosition } from '../src/core/types.ts';

const baseCellPos: DocumentPosition = {
  sectionIndex: 0,
  paragraphIndex: 2,
  charOffset: 3,
  parentParaIndex: 2,
  controlIndex: 0,
  cellIndex: 1,
  cellParaIndex: 0,
  cellPath: [{ controlIndex: 0, cellIndex: 1, cellParaIndex: 0 }],
};

test('isPageLocalTextEditCommand는 같은 셀 내부 insert/delete만 허용한다', () => {
  assert.equal(
    isPageLocalTextEditCommand('insertText', baseCellPos, { ...baseCellPos, charOffset: 4 }, { insertedText: '가' }),
    true,
  );
  assert.equal(
    isPageLocalTextEditCommand('deleteText', baseCellPos, baseCellPos, { deleteCount: 1 }),
    true,
  );
});

test('텍스트 command는 page-local 판정용 payload hint를 노출한다', () => {
  const source = readFileSync(new URL('../src/engine/command.ts', import.meta.url), 'utf8');

  assert.match(source, /getPageLocalTextEditOptions\?\(\): \{ insertedText\?: string; deleteCount\?: number \}/);
  assert.match(source, /getPageLocalTextEditOptions\(\): \{ insertedText: string \} \{\s*return \{ insertedText: this\.text \};\s*\}/);
  assert.match(source, /getPageLocalTextEditOptions\(\): \{ deleteCount: number \} \{\s*return \{ deleteCount: this\.count \};\s*\}/);
});

test('IME preedit은 조합 중 문서에 반영하고 커밋만 히스토리에 한 번 기록한다', () => {
  const inputHandlerSource = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
  const textSource = readFileSync(new URL('../src/engine/input-handler-text.ts', import.meta.url), 'utf8');

  assert.match(
    inputHandlerSource,
    /private afterTextInputEdit\(\s*beforePos: DocumentPosition,\s*afterPos: DocumentPosition,\s*pageLocalOptions: PageLocalTextEditOptions = \{\},\s*boundaryHandled = false,\s*\): void \{\s*if \(boundaryHandled\) \{\s*this\.afterEdit\(false\);\s*return;\s*\}/,
  );

  const imeStart = textSource.indexOf('if (this.isComposing && this.compositionAnchor)');
  const iosStart = textSource.indexOf('if (this._isIOS && !this.isComposing)');
  const generalStart = textSource.indexOf('// 일반 입력 (비조합)');
  assert.ok(imeStart >= 0 && iosStart > imeStart && generalStart > iosStart);

  const imeSource = textSource.slice(imeStart, iosStart);
  const iosSource = textSource.slice(iosStart, generalStart);
  assert.match(imeSource, /const preedit = this\.imeSession\.update\(text\);/);
  assert.match(imeSource, /syncCompositionDocument\.call\(this, preedit\)/);
  assert.match(textSource, /this\.replaceTextAtRaw\(anchor, this\.compositionLength, preedit\)/);
  assert.match(textSource, /this\.compositionLength = charCount\(preedit\);/);
  assert.match(textSource, /this\.afterTextInputEdit\(anchor, this\.cursor\.getPosition\(\)/);
  assert.match(textSource, /moveCompositionCaret\.call\(this, anchor, this\.compositionLength\)/);
  assert.doesNotMatch(inputHandlerSource, /private updateCompositionOverlay\(\)/);
  assert.doesNotMatch(textSource, /this\.textarea\.value/,
    '조합 갱신은 누적된 textarea value 전체가 아니라 imeSession.preedit 을 써야 한다');

  const compositionEndStart = textSource.indexOf('export function onCompositionEnd');
  const inputStart = textSource.indexOf('export function onInput', compositionEndStart);
  const compositionEndSource = textSource.slice(compositionEndStart, inputStart);
  assert.match(compositionEndSource, /this\.imeSession\.finish\(event\?\.data, textareaText\)/);
  assert.match(compositionEndSource, /kind: 'record',\s*command: new InsertTextCommand\(anchor, composed/);
  assert.match(compositionEndSource, /kind: 'record',\s*command: new InsertTextInHeaderFooterCommand/);
  assert.match(compositionEndSource, /kind: 'record',\s*command: new InsertTextInFootnoteCommand/);
  assert.doesNotMatch(compositionEndSource, /kind: 'command'/);
  assert.doesNotMatch(compositionEndSource, /this\.insertTextAtRaw\(anchor, composed\)/,
    'HF/FN 커밋은 이미 문서에 있는 preedit 을 다시 삽입하면 안 된다');
  assert.match(compositionEndSource, /applyCompositionPreview\.call\(this, ''\)/,
    '빈 커밋·취소는 문서의 preedit 을 되돌려야 한다');

  assert.match(iosSource, /this\.replaceTextAtRaw\(this\._iosAnchor, this\._iosLength, text\);/);
  assert.ok(
    iosSource.indexOf('this.consumeRawTextMutationBeforeCursor()') < iosSource.indexOf('this.cursor.moveTo('),
    'iOS effect는 cursor.moveTo 전에 소비해야 한다',
  );
  assert.match(iosSource, /this\._iosRequiresFullRefresh = this\._iosRequiresFullRefresh \|\| boundaryHandled;/);
  assert.match(
    iosSource,
    /this\.afterTextInputEdit\(iosAnchor, iosAfterPos, \{\s*insertedText: text,\s*beforePageIndex,\s*afterPageIndex,\s*\}, requiresFullRefresh\);/,
  );
  assert.doesNotMatch(iosSource, /this\._iosInputTimer = setTimeout/);
});

test('IME 조합 caret은 시작 시 보존한 anchor 좌표를 재사용한다', () => {
  const inputHandlerSource = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
  const textSource = readFileSync(new URL('../src/engine/input-handler-text.ts', import.meta.url), 'utf8');

  assert.match(inputHandlerSource, /private compositionAnchorRect: CursorRect \| null = null;/);
  assert.match(
    inputHandlerSource,
    /private captureCompositionAnchorRect\(anchor: DocumentPosition\): void \{[\s\S]*?CursorState\.comparePositions\(current, anchor\) === 0[\s\S]*?cellBounds: rect\.cellBounds \? \{ \.\.\.rect\.cellBounds \} : undefined,[\s\S]*?\}/,
    '조합 시작 좌표는 현재 logical cursor와 anchor가 정확히 같을 때만 캐시해야 한다',
  );
  assert.match(textSource, /this\.captureCompositionAnchorRect\(basePos\);\s*this\.imeSession\.start\(\);/);
  assert.match(
    inputHandlerSource,
    /private compositionStartRect\(\): CursorRect \| null \{[\s\S]*?this\.wasm\.getCursorRectInCell\(/,
    '캐시가 없을 때만 기존 exact anchor lookup으로 fallback해야 한다',
  );
  assert.match(
    inputHandlerSource,
    /this\.compositionAnchorRect = \{\s*\.\.\.startRect,\s*cellBounds: startRect\.cellBounds \? \{ \.\.\.startRect\.cellBounds \} : undefined,\s*\};/,
    'fallback exact lookup 결과도 이후 조합 갱신에서 재사용해야 한다',
  );
  assert.match(
    inputHandlerSource,
    /private completeResumablePagination\([\s\S]*?if \(this\.isComposing\) \{\s*this\.compositionAnchorRect = null;\s*\}[\s\S]*?this\.cursor\.moveTo\(position\);/,
    'shadow pagination commit은 이전 공개 레이아웃의 anchor 좌표를 폐기해야 한다',
  );
  assert.match(textSource, /this\.compositionAnchor = null;\s*this\.clearCompositionAnchorRect\(\);/);
});

test('raw 셀 입력은 command와 같은 typed mutation helper를 사용한다', () => {
  const textSource = readFileSync(new URL('../src/engine/input-handler-text.ts', import.meta.url), 'utf8');

  assert.match(
    textSource,
    /export function insertTextAtRaw\([\s\S]*?\): TextMutationEffects \{[\s\S]*?return insertTextWithMutationEffects\(this\.wasm, pos, text\);\s*\}/,
  );
  assert.match(
    textSource,
    /export function deleteTextAt\([\s\S]*?\): TextMutationEffects \{[\s\S]*?return deleteTextWithMutationEffects\(this\.wasm, pos, count\);\s*\}/,
  );
  const inputHandlerSource = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
  assert.match(
    inputHandlerSource,
    /private deleteTextAt\(pos: DocumentPosition, count: number\): void \{\s*this\.rawTextMutationEffects\.add\(_text\.deleteTextAt\.call\(this, pos, count\)\);\s*\}/,
    'IME 조합 치환의 delete와 insert effect를 한 accumulator에서 OR 누적해야 한다',
  );
});

test('depth-1 셀 IME replacement는 body fallback보다 먼저 atomic helper를 사용한다', () => {
  const textSource = readFileSync(
    new URL('../src/engine/input-handler-text.ts', import.meta.url),
    'utf8',
  );
  const replaceStart = textSource.indexOf('export function replaceTextAtRaw(');
  const deleteStart = textSource.indexOf('export function deleteTextAt(', replaceStart);
  const replaceSource = textSource.slice(replaceStart, deleteStart);

  assert.match(
    replaceSource,
    /canUseDeferredCellTextReplace\(pos, deleteCount, text\)/,
  );
  assert.match(
    replaceSource,
    /return replaceCellTextWithMutationEffects\(this\.wasm, pos, deleteCount, text\);/,
  );
  assert.ok(
    replaceSource.indexOf('canUseDeferredCellTextReplace') <
      replaceSource.indexOf('canUseLocalBodyTextReplace'),
    'cell atomic route must be checked before the body-only route',
  );
});

test('deferred pending이 실제로 있을 때만 page-local idle flush를 예약한다', () => {
  const inputHandlerSource = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
  const bridgeSource = readFileSync(new URL('../src/core/wasm-bridge.ts', import.meta.url), 'utf8');

  assert.match(
    inputHandlerSource,
    /if \(this\.deferredPaginationPending\) \{\s*this\.scheduleDeferredPaginationFlush\(\);\s*\}/,
  );
  assert.match(
    bridgeSource,
    /cellFlowChanged: paginationDeferred && parsed\.cellFlowChanged !== false/,
    '구형 deferred 결과의 누락 신호는 mutation 후 예외 대신 보수적 경계로 복구해야 한다',
  );
  assert.match(inputHandlerSource, /if \(!this\.deferredPaginationPending\) return false;/);
  assert.match(
    inputHandlerSource,
    /if \(effects\.paginationCompleted\) \{\s*this\.cancelDeferredPaginationFlush\(\);\s*this\.deferredPaginationRunner\.cancel\(\);\s*this\.deferredPaginationPending = false;\s*\}/,
  );
  assert.match(inputHandlerSource, /if \(effects\.flowChanged && effects\.paginationCompleted\) return true;/);
  assert.match(inputHandlerSource, /if \(!effects\.documentPaginationPending\) return false;/);
  assert.match(
    inputHandlerSource,
    /if \(!effects\.flowChanged && !replacesActiveJob\) return false;/,
  );
  assert.match(
    inputHandlerSource,
    /this\.deferredPaginationRunner\.start\(\);/,
    'cell-flow 경계는 동기 full flush 대신 resumable macrotask runner를 시작해야 한다',
  );
});

test('document pagination은 120ms idle과 명시 boundary에서 flush된다', () => {
  const inputHandlerSource = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
  const keyboardSource = readFileSync(new URL('../src/engine/input-handler-keyboard.ts', import.meta.url), 'utf8');
  const textSource = readFileSync(new URL('../src/engine/input-handler-text.ts', import.meta.url), 'utf8');
  const fileSource = readFileSync(new URL('../src/command/commands/file.ts', import.meta.url), 'utf8');

  assert.match(
    inputHandlerSource,
    /const DOCUMENT_PAGINATION_IDLE_FLUSH_DELAY_MS = 120;/,
  );
  assert.doesNotMatch(inputHandlerSource, /DEFERRED_PAGINATION_AUTO_FLUSH_PAGE_LIMIT/);
  assert.doesNotMatch(inputHandlerSource, /shouldAutoFlushDeferredPagination/);

  const undoStart = inputHandlerSource.indexOf('private handleUndo(): void {');
  const redoStart = inputHandlerSource.indexOf('private handleRedo(): void {');
  const restoreStart = inputHandlerSource.indexOf('private restoreEditContextAfterHistory', redoStart);
  const undoSource = inputHandlerSource.slice(undoStart, redoStart);
  const redoSource = inputHandlerSource.slice(redoStart, restoreStart);
  assert.ok(
    undoSource.indexOf("flushDeferredPaginationIfNeeded('before-undo', false)") <
      undoSource.indexOf('this.history.undo(this.wasm)'),
  );
  assert.ok(
    redoSource.indexOf("flushDeferredPaginationIfNeeded('before-redo', false)") <
      redoSource.indexOf('this.history.redo(this.wasm)'),
  );

  assert.match(keyboardSource, /PAGINATION_BOUNDARY_KEYS/);
  assert.match(
    keyboardSource,
    /this\.flushDeferredPaginationIfNeeded\('before-navigation', false\)/,
  );
  assert.match(
    textSource,
    /function processPendingNav[\s\S]*?this\.flushDeferredPaginationIfNeeded\('before-navigation', false\);/,
  );
  assert.match(inputHandlerSource, /private onInputBlurBound: \(\) => void;/);
  assert.match(
    inputHandlerSource,
    /this\.onInputBlurBound = \(\) => \{\s*if \(this\.isComposing\) _text\.onCompositionEnd\.call\(this\);\s*this\.resetIosInputSession\(\);[\s\S]*?this\.resetTextareaBuffer\(\);\s*this\.flushDeferredPaginationIfNeeded\('input-blur', false\);\s*\};/,
  );
  assert.match(inputHandlerSource, /this\.textarea\.addEventListener\('blur', this\.onInputBlurBound\);/);
  assert.match(inputHandlerSource, /this\.textarea\.removeEventListener\('blur', this\.onInputBlurBound\);/);
  assert.match(fileSource, /flushDeferredPaginationBeforeExplicitOutput/);
});

test('문서 전환은 deferred·IME·iOS 입력 세션 상태를 격리한다', () => {
  const inputHandlerSource = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
  const deactivateStart = inputHandlerSource.indexOf('deactivate(): void {');
  const disposeStart = inputHandlerSource.indexOf('dispose(): void {', deactivateStart);
  assert.ok(deactivateStart >= 0 && disposeStart > deactivateStart);
  const deactivateSource = inputHandlerSource.slice(deactivateStart, disposeStart);

  assert.doesNotMatch(deactivateSource, /onCompositionEnd/,
    '이미 교체된 문서에 이전 문서의 preedit을 확정하면 안 된다');
  assert.match(deactivateSource, /revertCompositionPreview\.call\(this\)/,
    '네이티브 preedit 은 문서에 들어가 있으므로 전환 전에 되돌려야 한다');
  assert.ok(
    deactivateSource.indexOf("this.flushDeferredPaginationIfNeeded('before-deactivate', false)") <
      deactivateSource.indexOf('this.active = false'),
  );
  assert.match(deactivateSource, /this\.cancelDeferredPaginationFlush\(\);/);
  assert.match(deactivateSource, /this\.deferredPaginationRunner\.cancel\(\);/);
  assert.match(deactivateSource, /this\.deferredPaginationPending = false;/);
  assert.match(deactivateSource, /this\.resetRawTextMutationEffects\(\);/);
  assert.match(deactivateSource, /this\.compositionAnchorRect = null;/);
  assert.match(deactivateSource, /this\.imeSession\.reset\(\);/);
  assert.match(deactivateSource, /this\._iosAnchor = null;/);
  assert.match(deactivateSource, /this\._iosRequiresFullRefresh = false;/);
  assert.match(deactivateSource, /this\.resetTextareaBuffer\(\);/,
    '문서 전환 시 textarea value와 consumed prefix 카운터를 함께 초기화해야 한다');
});

test('저장·다른 이름 저장·인쇄는 resumable job을 출력 전에 동기 barrier로 마감한다', () => {
  const fileCommandSource = readFileSync(
    new URL('../src/command/commands/file.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    fileCommandSource,
    /function flushDeferredPaginationBeforeExplicitOutput\([\s\S]*?flushDeferredPaginationIfNeeded\(reason\);[\s\S]*?hasDeferredPaginationPending\(\)[\s\S]*?throw new Error/,
    'flush 실패 뒤 pending이 남으면 저장·인쇄를 중단해야 한다',
  );
  for (const reason of ['save', 'save-as', 'print']) {
    assert.match(
      fileCommandSource,
      new RegExp(`flushDeferredPaginationBeforeExplicitOutput\\(services, '${reason}'\\)`),
      `${reason} 경로는 export/render 전에 pending pagination을 마감해야 한다`,
    );
  }
});

test('isPageLocalTextEditCommand는 같은 본문 문단의 짧은 텍스트 편집을 허용한다', () => {
  const bodyPos: DocumentPosition = {
    sectionIndex: 0,
    paragraphIndex: 2,
    charOffset: 3,
  };

  assert.equal(
    isPageLocalTextEditCommand(
      'insertText',
      bodyPos,
      { ...bodyPos, charOffset: 4 },
      { insertedText: '가', beforePageIndex: 0, afterPageIndex: 0 },
    ),
    true,
  );
  assert.equal(
    isPageLocalTextEditCommand(
      'deleteText',
      bodyPos,
      bodyPos,
      { deleteCount: 1, beforePageIndex: 0, afterPageIndex: 0 },
    ),
    true,
  );
});

test('isPageLocalTextEditCommand는 본문 경계와 구조 변경을 full refresh로 남긴다', () => {
  const bodyPos: DocumentPosition = {
    sectionIndex: 0,
    paragraphIndex: 2,
    charOffset: 3,
  };

  assert.equal(
    isPageLocalTextEditCommand(
      'insertText',
      bodyPos,
      { ...bodyPos, paragraphIndex: 3, charOffset: 1 },
      { insertedText: '가' },
    ),
    false,
  );
  assert.equal(isPageLocalTextEditCommand('splitParagraphInCell', baseCellPos, baseCellPos), false);
  assert.equal(isPageLocalTextEditCommand('deleteSelection', baseCellPos, baseCellPos), false);
});

test('isPageLocalTextEditCommand는 셀 경로가 바뀌면 full refresh를 요구한다', () => {
  assert.equal(
    isPageLocalTextEditCommand('insertText', baseCellPos, {
      ...baseCellPos,
      cellPath: [{ controlIndex: 0, cellIndex: 2, cellParaIndex: 0 }],
      charOffset: 4,
    }),
    false,
  );
  assert.equal(
    isPageLocalTextEditCommand('insertText', baseCellPos, { ...baseCellPos, cellParaIndex: 1, charOffset: 4 }),
    false,
  );
});

test('isPageLocalTextEditCommand는 긴 단일 paste와 줄바꿈/탭 삽입을 full refresh로 남긴다', () => {
  const shortText = '가'.repeat(MAX_PAGE_LOCAL_TEXT_EDIT_CHARS);
  const longText = '가'.repeat(MAX_PAGE_LOCAL_TEXT_EDIT_CHARS + 1);

  assert.equal(
    isPageLocalTextEditCommand(
      'insertText',
      baseCellPos,
      { ...baseCellPos, charOffset: baseCellPos.charOffset + shortText.length },
      { insertedText: shortText },
    ),
    true,
  );
  assert.equal(
    isPageLocalTextEditCommand(
      'insertText',
      baseCellPos,
      { ...baseCellPos, charOffset: baseCellPos.charOffset + longText.length },
      { insertedText: longText },
    ),
    false,
  );
  assert.equal(
    isPageLocalTextEditCommand(
      'insertText',
      baseCellPos,
      { ...baseCellPos, charOffset: baseCellPos.charOffset + 3 },
      { insertedText: '가\n나' },
    ),
    false,
  );
  assert.equal(
    isPageLocalTextEditCommand(
      'insertText',
      baseCellPos,
      { ...baseCellPos, charOffset: baseCellPos.charOffset + 3 },
      { insertedText: '가\t나' },
    ),
    false,
  );
});

test('isPageLocalTextEditCommand는 큰 삭제와 페이지 이동을 full refresh로 남긴다', () => {
  assert.equal(
    isPageLocalTextEditCommand(
      'deleteText',
      baseCellPos,
      baseCellPos,
      { deleteCount: MAX_PAGE_LOCAL_TEXT_EDIT_CHARS + 1 },
    ),
    false,
  );
  assert.equal(
    isPageLocalTextEditCommand(
      'insertText',
      baseCellPos,
      { ...baseCellPos, charOffset: 4 },
      { insertedText: '가', beforePageIndex: 0, afterPageIndex: 1 },
    ),
    false,
  );
});
