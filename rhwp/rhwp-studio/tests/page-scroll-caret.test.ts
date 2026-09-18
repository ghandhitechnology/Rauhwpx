import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { caretRectForPageScroll } from '../src/view/page-scroll-caret.ts';

const bodyRect = { pageIndex: 2, x: 12, y: 24, height: 18 };

function cursor(overrides: Record<string, unknown> = {}) {
  return {
    isInHeaderFooter: () => false,
    isInFootnote: () => false,
    isInPictureObjectSelection: () => false,
    isInTableObjectSelection: () => false,
    isInBlockSelectionMode: () => false,
    isInCellSelectionMode: () => false,
    isInTextBox: () => false,
    getRect: () => bodyRect,
    ...overrides,
  };
}

test('본문 캐럿은 PageUp/PageDown 과 함께 옮길 좌표를 준다', () => {
  assert.equal(caretRectForPageScroll(cursor()), bodyRect);
});

test('글상자 캐럿은 본문 hit-test 로 옮기지 않는다', () => {
  assert.equal(caretRectForPageScroll(cursor({ isInTextBox: () => true })), null);
});

test('머리말·개체 선택·셀 선택 캐럿도 화면만 옮긴다', () => {
  assert.equal(caretRectForPageScroll(cursor({ isInHeaderFooter: () => true })), null);
  assert.equal(caretRectForPageScroll(cursor({ isInPictureObjectSelection: () => true })), null);
  assert.equal(caretRectForPageScroll(cursor({ isInCellSelectionMode: () => true })), null);
  assert.equal(caretRectForPageScroll(cursor(), true), null);
});

test('키보드 PageUp/PageDown 은 추출한 캐럿 정책을 쓴다', () => {
  const source = readFileSync(
    new URL('../src/engine/input-handler-keyboard.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /from '@\/view\/page-scroll-caret'/);
  assert.match(source, /resolveCaretRectForPageScroll\(self\.cursor, self\.isFormMode\?\.\(\) === true\)/);
});

test('CanvasView는 viewport 높이와 세로 이동을 setPageDimensions에 전달한다', () => {
  const source = readFileSync(new URL('../src/view/canvas-view.ts', import.meta.url), 'utf8');
  const start = source.indexOf('private recalcLayout(): void {');
  const end = source.indexOf('this.scrollContent.style.height', start);
  const block = source.slice(start, end);

  assert.match(block, /setPageDimensions\(/);
  assert.match(block, /viewport\.width/);
  assert.match(block, /'vertical'/);
  assert.match(block, /viewport\.height/);
});
