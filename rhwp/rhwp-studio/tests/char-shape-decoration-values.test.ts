import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECORATION_LINE_SHAPES,
  changedFiniteSelectValue,
} from '../src/ui/decoration-line-shapes.ts';

test('character dialog exposes both supported wave decoration styles', () => {
  assert.deepEqual(DECORATION_LINE_SHAPES.slice(-2).map(([value]) => value), ['11', '12']);
});

test('unchanged and unrepresentable decoration selections emit no change', () => {
  assert.equal(changedFiniteSelectValue('12', 12), undefined);
  assert.equal(changedFiniteSelectValue('15', 15), undefined);
  assert.equal(changedFiniteSelectValue('', 15), undefined);
  assert.equal(changedFiniteSelectValue('11', 15), 11);
});
