import test from 'node:test';
import assert from 'node:assert/strict';
import { indexExactTextRects, subtractExactTextRects } from '../src/agent/overlay-geometry.ts';

const rect = (pageIndex: number, x: number, y = 10, width = 100): SelectionRect => ({
  pageIndex, x, y, width, height: 10,
});

type SelectionRect = { pageIndex: number; x: number; y: number; width: number; height: number };

test('exact text subtraction only changes overlapping pages and keeps split widths', () => {
  const source = [rect(0, 0), rect(40, 0), rect(0, 200)];
  const exact = [rect(0, 40, 10, 20)];
  const result = subtractExactTextRects(source, exact);

  assert.deepEqual(result, [
    rect(0, 0, 10, 39.65),
    rect(0, 60.35, 10, 39.65),
    rect(40, 0),
    rect(0, 200),
  ]);
});

test('multiple exact spans are applied in x order without touching other pages', () => {
  const source = [rect(2, 0, 20, 160)];
  const exact = [rect(2, 110, 20, 10), rect(2, 20, 20, 10), rect(99, 20, 20, 10)];
  const result = subtractExactTextRects(source, exact);
  assert.deepEqual(result.map(({ x }) => x), [0, 30.35, 120.35]);
  assert.deepEqual(result.map(({ width }) => Number(width.toFixed(2))), [19.65, 79.3, 39.65]);
});

test('different-line exact text does not erase legacy ink', () => {
  const source = [rect(0, 0, 10, 100)];
  const exact = [rect(0, 40, 40, 20)];
  assert.deepEqual(subtractExactTextRects(source, exact), source);
});

test('a prebuilt page index can be reused across legacy ranges', () => {
  const exact = [rect(7, 40, 10, 20)];
  const index = indexExactTextRects(exact);
  assert.deepEqual(
    subtractExactTextRects([rect(7, 0)], exact, index),
    subtractExactTextRects([rect(7, 0)], exact),
  );
  assert.equal(index.has(999), false);
});
