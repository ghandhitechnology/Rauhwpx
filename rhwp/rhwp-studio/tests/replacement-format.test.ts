import assert from 'node:assert/strict';
import test from 'node:test';
import { replacementCharShapes } from '../src/agent/replacement-format.ts';

test('replacement preserves mixed styles around changed text and inherits the local style', () => {
  assert.deepEqual(replacementCharShapes('Title: 123 kg', 'Title: 4567 kg', [
    { startOffset: 0, endOffset: 7, charShapeId: 1 },
    { startOffset: 7, endOffset: 10, charShapeId: 2 },
    { startOffset: 10, endOffset: 13, charShapeId: 3 },
  ]), [
    { startOffset: 0, endOffset: 7, charShapeId: 1 },
    { startOffset: 7, endOffset: 11, charShapeId: 2 },
    { startOffset: 11, endOffset: 14, charShapeId: 3 },
  ]);
});

test('replacement tracks scalar offsets across emoji and paragraph boundaries', () => {
  assert.deepEqual(replacementCharShapes('가😀\nXYZ', '가😀!\nXYZ', [
    { startOffset: 0, endOffset: 3, charShapeId: 4 },
    { startOffset: 3, endOffset: 6, charShapeId: 5 },
  ]), [
    { startOffset: 0, endOffset: 4, charShapeId: 4 },
    { startOffset: 4, endOffset: 7, charShapeId: 5 },
  ]);
});

test('canonically equivalent text with different scalar lengths has complete style coverage', () => {
  assert.deepEqual(replacementCharShapes('é!', 'e\u0301!', [
    { startOffset: 0, endOffset: 2, charShapeId: 7 },
  ]), [{ startOffset: 0, endOffset: 3, charShapeId: 7 }]);
});

test('canonically equivalent grapheme keeps the unchanged suffix style', () => {
  assert.deepEqual(replacementCharShapes('éX', 'e\u0301X', [
    { startOffset: 0, endOffset: 1, charShapeId: 7 },
    { startOffset: 1, endOffset: 2, charShapeId: 8 },
  ]), [
    { startOffset: 0, endOffset: 2, charShapeId: 7 },
    { startOffset: 2, endOffset: 3, charShapeId: 8 },
  ]);
});
