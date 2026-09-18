import assert from 'node:assert/strict';
import test from 'node:test';

import { API_KEY_MAX_BYTES, boundTextFields, textFitsByteLimit } from '../input-bounds.mjs';

test('credential byte limits reject both oversized ASCII and multibyte text', () => {
  assert.equal(textFitsByteLimit('k'.repeat(API_KEY_MAX_BYTES), API_KEY_MAX_BYTES), true);
  assert.equal(textFitsByteLimit('k'.repeat(API_KEY_MAX_BYTES + 1), API_KEY_MAX_BYTES), false);
  assert.equal(
    textFitsByteLimit('한'.repeat(Math.floor(API_KEY_MAX_BYTES / 3) + 1), API_KEY_MAX_BYTES),
    false,
  );
});

test('semantic request fields enforce character and UTF-8 aggregate limits', () => {
  assert.deepEqual(
    { ...boundTextFields({ goal: 'draft', notes: '참조' }, { goal: 5, notes: 10 }, { maxTotalChars: 15, maxTotalBytes: 32 }) },
    { goal: 'draft', notes: '참조' },
  );
  assert.throws(
    () => boundTextFields({ goal: '123456' }, { goal: 5 }, { maxTotalChars: 5, maxTotalBytes: 20 }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => boundTextFields({ a: '한'.repeat(5), b: '글'.repeat(5) }, { a: 5, b: 5 }, { maxTotalChars: 10, maxTotalBytes: 20 }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});
