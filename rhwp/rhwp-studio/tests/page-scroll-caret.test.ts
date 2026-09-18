import test from 'node:test';
import assert from 'node:assert/strict';

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
