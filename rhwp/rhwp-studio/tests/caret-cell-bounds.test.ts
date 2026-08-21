import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const caretRenderer = readFileSync(new URL('../src/engine/caret-renderer.ts', import.meta.url), 'utf8');
const inputHandler = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
const canvasView = readFileSync(new URL('../src/view/canvas-view.ts', import.meta.url), 'utf8');

test('표 셀 IME 조합 밑줄은 cellBounds 안에 제한한다', () => {
  assert.match(caretRenderer, /showCompositionUnderline\(/);
  assert.match(caretRenderer, /const bounds = startRect\.cellBounds \?\? endRect\.cellBounds;/);
  assert.match(caretRenderer, /w = Math\.min\(w, Math\.max\(0, maxX - x\)\);/);
});

test('IME 조합 글리프는 엔진 문서가 그리고 오버레이 복제 띠를 쓰지 않는다', () => {
  assert.match(canvasView, /renderedCanvas\.dataset\.rhwpPageIndex = String\(pageIdx\)/);
  assert.doesNotMatch(caretRenderer, /private compFlowEl/);
  assert.doesNotMatch(caretRenderer, /private renderCompositionFlow\(/);
  assert.match(caretRenderer, /private underlineEl: HTMLDivElement/);
});

test('지연 셀 입력이 가시 높이를 넘으면 즉시 전체 페이지네이션을 수행한다', () => {
  assert.match(inputHandler, /if \(this\.flushDeferredPaginationForCellOverflow\(\)\) return;/);
  assert.match(inputHandler, /private flushDeferredPaginationForCellOverflow\(\): boolean/);
  assert.match(inputHandler, /if \(!this\.cursor\.getRect\(\)\?\.cellOverflowed\) return false;/);
  assert.match(inputHandler, /this\.wasm\.flushDeferredPagination\(\);/);
  assert.match(inputHandler, /this\.cursor\.moveTo\(this\.cursor\.getPosition\(\)\);/);
});
