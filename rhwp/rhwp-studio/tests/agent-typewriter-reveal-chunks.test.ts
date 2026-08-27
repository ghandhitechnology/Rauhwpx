import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealChunksForInsertedText } from '../src/agent/typewriter-reveal.ts';

test('insert without oldText reveals the whole added string', () => {
  assert.deepEqual(
    revealChunksForInsertedText('새 문장').map((chunk) => [chunk.start, chunk.end, chunk.text]),
    [[0, 4, '새 문장']],
  );
});

test('replace keeps unchanged text out of the typewriter', () => {
  const chunks = revealChunksForInsertedText(
    '첫 문단\n새 둘째 문단\n셋째 문단',
    '첫 문단\n둘째 문단\n셋째 문단',
  );
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['새 ']);
});

test('replace with two local edits reveals only the added hunks', () => {
  const chunks = revealChunksForInsertedText(
    '주별 실적을 취합해 제출한다.',
    '월별 실적을 취합하여 제출한다.',
  );
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['주', '해']);
});

test('delete-only replace has nothing to type', () => {
  assert.deepEqual(revealChunksForInsertedText('검토 후 제출', '검토 후 즉시 제출'), []);
});

test('empty insert yields no chunks', () => {
  assert.deepEqual(revealChunksForInsertedText(''), []);
});
