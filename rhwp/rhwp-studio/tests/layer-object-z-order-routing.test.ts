import test from 'node:test';
import assert from 'node:assert/strict';
import { isTopLevelLayerOrderTarget } from '../src/core/object-address.ts';

test('layer-order target includes supported top-level floating object kinds', () => {
  for (const type of ['shape', 'line', 'group', 'ole', 'image', 'table', 'equation']) {
    assert.equal(isTopLevelLayerOrderTarget({ sec: 0, ppi: 0, ci: 0, type }), true, type);
  }
  const picture = { sec: 0, ppi: 0, ci: 0, type: 'image' };
  assert.equal(isTopLevelLayerOrderTarget({ ...picture, cellPath: [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 0 }] }), false);
  assert.equal(isTopLevelLayerOrderTarget({ ...picture, headerFooter: { kind: 'header' } }), false);
  assert.equal(isTopLevelLayerOrderTarget({ ...picture, noteRef: { kind: 'footnote' } }), false);
  assert.equal(isTopLevelLayerOrderTarget({ ...picture, memoRef: { memoIndex: 0 } }), false);
});
