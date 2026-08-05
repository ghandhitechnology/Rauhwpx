import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeExactTextDiff,
  pointAtNewScalarOffset,
  rangeForNewScalarOffsets,
} from '../src/agent/exact-text-diff.ts';
import type { DocRange } from '../src/agent/types.ts';

test('Korean word anchors refine to the changed grapheme', () => {
  const result = computeExactTextDiff('월별 실적을 취합하여 제출한다.', '주별 실적을 취합해 제출한다.');
  assert.deepEqual(result.hunks.map((h) => [h.kind, h.oldText, h.newText]), [
    ['replace', '월', '주'],
    ['replace', '하여', '해'],
  ]);
});

test('canonical-equivalent Hangul is visually unchanged', () => {
  const composed = '한글';
  const decomposed = composed.normalize('NFD');
  assert.deepEqual(computeExactTextDiff(decomposed, composed).hunks, []);
});

test('emoji remains a single grapheme hunk', () => {
  const result = computeExactTextDiff('승인 👍🏽 완료', '승인 👍🏻 완료');
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].oldText, '👍🏽');
  assert.equal(result.hunks[0].newText, '👍🏻');
});

test('punctuation and whitespace-only edits remain precise', () => {
  const result = computeExactTextDiff('문장,  다음', '문장: 다음');
  assert.deepEqual(result.hunks.map((h) => [h.oldText, h.newText]), [
    [', ', ':'],
  ]);
});

test('repeated phrases retain stable word anchors', () => {
  const result = computeExactTextDiff('검토 후 검토 후 제출', '검토 후 승인 후 제출');
  assert.deepEqual(result.hunks.map((h) => [h.oldText, h.newText]), [['검토', '승인']]);
});

test('paragraph boundaries align before intraparagraph refinement', () => {
  const result = computeExactTextDiff('첫 문단\n둘째 문단\n셋째 문단', '첫 문단\n새 둘째 문단\n셋째 문단');
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].kind, 'insert');
  assert.equal(result.hunks[0].newText, '새 ');
});

test('deletion-only replacement produces a zero-width new hunk', () => {
  const result = computeExactTextDiff('검토 후 즉시 제출', '검토 후 제출');
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].kind, 'delete');
  assert.equal(result.hunks[0].oldText, '즉시 ');
  assert.equal(result.hunks[0].newStart, [...'검토 후 '].length);
  assert.equal(result.hunks[0].newStart, result.hunks[0].newEnd);
});

test('budget exhaustion terminates with a coarse fallback hunk', () => {
  const result = computeExactTextDiff('가'.repeat(200), '나'.repeat(200), 25);
  assert.equal(result.exceededBudget, true);
  assert.ok(result.stepsUsed <= 25);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].fallback, true);
  assert.equal(result.hunks[0].oldText, '가'.repeat(200));
  assert.equal(result.hunks[0].newText, '나'.repeat(200));
});

test('paragraph budget exhaustion keeps one unresolved middle hunk', () => {
  const oldText = Array.from({ length: 8 }, (_, i) => `이전 문단 ${i}`).join('\n');
  const newText = Array.from({ length: 8 }, (_, i) => `새 문단 ${i}`).join('\n');
  const result = computeExactTextDiff(oldText, newText, 4);
  assert.equal(result.exceededBudget, true);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].fallback, true);
  assert.equal(result.hunks[0].oldText, oldText);
  assert.equal(result.hunks[0].newText, newText);
});

test('scalar offsets map through emoji and paragraph breaks', () => {
  const range: DocRange = {
    sectionIdx: 0,
    startParaIdx: 4,
    startCharOffset: 3,
    endParaIdx: 5,
    endCharOffset: 2,
  };
  assert.deepEqual(pointAtNewScalarOffset(range, 'A😀\nBC', 2), { paraIdx: 4, charOffset: 5 });
  assert.deepEqual(pointAtNewScalarOffset(range, 'A😀\nBC', 3), { paraIdx: 5, charOffset: 0 });
  assert.deepEqual(rangeForNewScalarOffsets(range, 'A😀\nBC', 1, 5), {
    sectionIdx: 0,
    cell: undefined,
    startParaIdx: 4,
    startCharOffset: 4,
    endParaIdx: 5,
    endCharOffset: 2,
  });
});

test('cell context is preserved while mapping exact spans', () => {
  const range: DocRange = {
    sectionIdx: 1,
    cell: { paraIdx: 7, controlIdx: 2, cellIdx: 3 },
    startParaIdx: 0,
    startCharOffset: 1,
    endParaIdx: 0,
    endCharOffset: 4,
  };
  assert.deepEqual(rangeForNewScalarOffsets(range, '새문장', 0, 1).cell, range.cell);
});
