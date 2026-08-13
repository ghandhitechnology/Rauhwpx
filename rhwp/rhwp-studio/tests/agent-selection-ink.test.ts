import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampRectsToTextEnds,
  measureInkRange,
  newlineOffsets,
  type InkGeometryProbe,
} from '../src/agent/selection-ink.ts';
import type { SelectionRect } from '../src/core/types.ts';
import type { DocRange } from '../src/agent/types.ts';

function rect(
  pageIndex: number,
  x: number,
  y: number,
  width: number,
  height: number,
): SelectionRect {
  return { pageIndex, x, y, width, height };
}

test('clampRectsToTextEnds cuts a margin-wide line back to the text caret', () => {
  const line = rect(0, 72, 120, 451, 18);
  const caret = rect(0, 210, 120, 0, 18);
  assert.deepEqual(clampRectsToTextEnds([line], [caret]), [
    rect(0, 72, 120, 138, 18),
  ]);
});

test('clampRectsToTextEnds drops a rect that is only the ejected tail past the caret', () => {
  const line = rect(0, 72, 120, 451, 18);
  const caret = rect(0, 72, 120, 0, 18);
  assert.deepEqual(clampRectsToTextEnds([line], [caret]), []);
});

test('clampRectsToTextEnds leaves a line alone when no caret sits on it', () => {
  const first = rect(0, 72, 120, 451, 18);
  const second = rect(0, 72, 142, 180, 18);
  const caretOnSecond = rect(0, 180, 142, 0, 18);
  assert.deepEqual(clampRectsToTextEnds([first, second], [caretOnSecond]), [
    first,
    rect(0, 72, 142, 108, 18),
  ]);
});

test('newlineOffsets reports scalar offsets including after astral characters', () => {
  assert.deepEqual(newlineOffsets('가\n나', 4), [5]);
  assert.deepEqual(newlineOffsets('A\nB\nC', 0), [1, 3]);
  assert.deepEqual(newlineOffsets('😀\nx', 10), [11]);
});

test('measureInkRange clamps a single-paragraph forced break and the range end', () => {
  const range: DocRange = {
    sectionIdx: 0,
    startParaIdx: 2,
    startCharOffset: 0,
    endParaIdx: 2,
    endCharOffset: 7,
  };
  const probe: InkGeometryProbe = {
    rects: () => [
      rect(0, 72, 100, 451, 16),
      rect(0, 72, 120, 451, 16),
    ],
    paragraphLength: () => 7,
    text: () => '짧은\n끝',
    caret: (_para, offset) => {
      if (offset === 2) return rect(0, 140, 100, 0, 16); // \n
      if (offset === 7) return rect(0, 168, 120, 0, 16);
      throw new Error(`unexpected caret ${offset}`);
    },
  };

  const measured = measureInkRange(range, probe);
  assert.deepEqual(measured.rects, [
    rect(0, 72, 100, 68, 16),
    rect(0, 72, 120, 96, 16),
  ]);
  assert.equal(measured.paraEnds.length, 0);
});

test('measureInkRange keeps paragraph-end carets for enter marks', () => {
  const range: DocRange = {
    sectionIdx: 0,
    startParaIdx: 0,
    startCharOffset: 0,
    endParaIdx: 1,
    endCharOffset: 2,
  };
  const probe: InkGeometryProbe = {
    rects: () => [
      rect(0, 72, 80, 451, 16),
      rect(0, 72, 100, 80, 16),
    ],
    paragraphLength: (paraIdx) => (paraIdx === 0 ? 4 : 2),
    text: (paraIdx) => (paraIdx === 0 ? 'abcd' : 'ef'),
    caret: (paraIdx, offset) => {
      if (paraIdx === 0 && offset === 4) return rect(0, 160, 80, 0, 16);
      if (paraIdx === 1 && offset === 2) return rect(0, 120, 100, 0, 16);
      throw new Error(`unexpected caret ${paraIdx}/${offset}`);
    },
  };

  const measured = measureInkRange(range, probe);
  assert.equal(measured.paraEnds.length, 1);
  assert.equal(measured.paraEnds[0].paraIdx, 0);
  assert.deepEqual(measured.rects, [
    rect(0, 72, 80, 88, 16),
    rect(0, 72, 100, 48, 16),
  ]);
});
