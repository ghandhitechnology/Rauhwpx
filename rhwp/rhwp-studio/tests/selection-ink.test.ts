import test from 'node:test';
import assert from 'node:assert/strict';
import { clampRectsToTextEnds, newlineOffsets } from '../src/agent/selection-ink.ts';

test('newline offsets stay in scalar coordinates without allocating a spread array', () => {
  assert.deepEqual(newlineOffsets('a😀\nb\n', 4), [6, 8]);
});

test('clamp rects only scans text ends from the same page', () => {
  const rects = [
    { pageIndex: 4, x: 0, y: 10, width: 100, height: 10 },
    { pageIndex: 8, x: 0, y: 10, width: 100, height: 10 },
  ];
  const ends = [
    { pageIndex: 8, x: 100, y: 10, width: 0, height: 10 },
    { pageIndex: 4, x: 40, y: 10, width: 0, height: 10 },
  ];
  assert.deepEqual(clampRectsToTextEnds(rects, ends), [
    { pageIndex: 4, x: 0, y: 10, width: 40, height: 10 },
    { pageIndex: 8, x: 0, y: 10, width: 100, height: 10 },
  ]);
});
