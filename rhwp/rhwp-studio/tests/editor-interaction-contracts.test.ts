import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (relativePath: string): string => readFileSync(join(rootDir, relativePath), 'utf8');

function block(src: string, startText: string, endText: string): string {
  const start = src.indexOf(startText);
  assert.notEqual(start, -1, `${startText} not found`);
  const end = src.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `${endText} not found after ${startText}`);
  return src.slice(start, end);
}

test('Ctrl and Meta Shift+V scope plain-text paste to the physical key chord', () => {
  const keyboard = source('src/engine/input-handler-keyboard.ts');
  const earlyKeyDown = block(
    keyboard,
    'export function onKeyDown',
    'if (this.readOnly || this.userEditingLocked)',
  );

  assert.match(earlyKeyDown, /\(e\.ctrlKey \|\| e\.metaKey\)/);
  assert.match(earlyKeyDown, /e\.shiftKey/);
  assert.match(earlyKeyDown, /!e\.altKey/);
  assert.match(earlyKeyDown, /e\.code === 'KeyV'/);
  assert.match(earlyKeyDown, /this\.pasteWithoutFormattingArmed = \(/);
  assert.doesNotMatch(earlyKeyDown, /setTimeout/);
  assert.doesNotMatch(earlyKeyDown, /preventDefault/);

  const keyUp = block(keyboard, 'export function onKeyUp', 'export function handleCtrlKey');
  assert.match(keyUp, /e\.code === 'KeyV'/);
  assert.match(keyUp, /pasteWithoutFormattingArmed = false/);
});

test('plain-text paste is one atomic operation that normalizes and preserves cell paragraphs', () => {
  const keyboard = source('src/engine/input-handler-keyboard.ts');
  const paste = block(keyboard, 'export function onPaste', '/** 클립보드의 이미지 파일');
  const plain = block(keyboard, 'function pastePlainText', 'export function prepareRhwpInternalClipboardHtml');

  const consume = paste.indexOf('const pasteWithoutFormatting');
  const plainBranch = paste.indexOf('if (pasteWithoutFormatting)');
  const internalMarker = paste.indexOf('hasCurrentRhwpClipboardMarker');
  const imagePriority = paste.indexOf("item.type.startsWith('image/')");
  const htmlPriority = paste.indexOf('if (html)');
  assert.ok(consume < plainBranch && plainBranch < internalMarker);
  assert.ok(plainBranch < imagePriority && plainBranch < htmlPriority);
  assert.match(plain, /text\.replace\(\/\\r\\n\?\/g, '\\n'\)/);
  assert.match(plain, /operationType: 'pastePlainText'/);
  assert.match(plain, /deleteSelectionImmediate\(wasm, selection\.start, selection\.end\)/);
  assert.match(plain, /new SplitParagraphInCellCommand\(position\)\.execute\(wasm\)/);
  assert.doesNotMatch(plain, /kind: 'command'/);
});

test('triple mousedown selects editable cell text without starting drag selection', () => {
  const mouse = source('src/engine/input-handler-mouse.ts');
  const triple = block(mouse, 'e.detail >= 3', '// 표 객체 선택 중 클릭 처리');

  assert.match(triple, /!this\.readOnly/);
  assert.match(triple, /!this\.userEditingLocked/);
  assert.match(triple, /!isProtectedCellHit\(this, hit\)/);
  assert.match(triple, /this\.cursor\.moveToHit\(hit\)/);
  assert.match(triple, /this\.cursor\.selectAllInCurrentCell\(\)/);
  assert.match(triple, /this\.updateCaret\(\)/);
  assert.match(triple, /this\.textarea\.focus\(\)/);
  assert.doesNotMatch(triple, /startTextSelectionDrag|startCellSelectionDrag/);
});

test('cell Ctrl+A clears cell-block mode and uses the same cursor operation', () => {
  const keyboard = source('src/engine/input-handler-keyboard.ts');
  const selectAll = block(keyboard, 'export function handleSelectAll', 'export function onCopy');

  assert.match(selectAll, /this\.cursor\.isInCell\(\)/);
  assert.match(selectAll, /this\.cursor\.exitCellSelectionMode\(\)/);
  assert.match(selectAll, /this\.cellSelectionRenderer\?\.clear\(\)/);
  assert.match(selectAll, /this\.cursor\.selectAllInCurrentCell\(\)/);
  assert.match(selectAll, /sectionIndex: 0, paragraphIndex: 0, charOffset: 0/);
});

test('picture resize tracks outside the editor and reuses one preview element', () => {
  const mouse = source('src/engine/input-handler-mouse.ts');
  const picture = source('src/engine/input-handler-picture.ts');
  const renderer = source('src/engine/table-object-renderer.ts');
  const renderPreview = block(renderer, 'renderDragPreview(', '/** 레이어가 DOM에 없으면 재부착한다 */');
  const cleanup = block(picture, 'export function cleanupPictureResizeDrag', 'export function updatePictureMoveDrag');

  assert.equal(
    mouse.match(/document\.addEventListener\('mousemove', this\.onMouseMoveBound\);/g)?.length,
    6,
    'cell selection and every picture move, rotate, and resize path should install document mousemove',
  );
  assert.match(cleanup, /document\.removeEventListener\('mousemove', this\.onMouseMoveBound\)/);
  assert.match(renderPreview, /if \(!this\.previewEl\)/);
  assert.match(renderPreview, /this\.previewEl\.style\.left/);
  assert.doesNotMatch(renderPreview, /clearDragPreview\(\)/);
});

test('editor deactivation cancels picture previews without committing stale geometry', () => {
  const input = source('src/engine/input-handler.ts');
  const cancel = block(input, 'private cancelPicturePreviewDrags', '// ─── 그림 이동 드래그');
  const deactivate = block(input, 'deactivate(): void', 'dispose(): void');

  assert.match(cancel, /cleanupPictureResizeDrag\.call\(this\)/);
  assert.match(cancel, /cleanupPictureMoveDrag\.call\(this\)/);
  assert.match(cancel, /cleanupPictureRotateDrag\.call\(this\)/);
  assert.match(cancel, /removeEventListener\('mouseup', this\.onMouseUpBound\)/);
  assert.doesNotMatch(cancel, /finishPicture|onMouseUp\.call/);
  assert.match(deactivate, /this\.cancelPicturePreviewDrags\(\)/);
});
