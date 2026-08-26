import assert from 'node:assert/strict';
import test from 'node:test';

import { manualEditorFamily } from '../src/merge/manual-conflict-editor.ts';

test('engine conflict kinds route to the matching structured editor family', () => {
  for (const kind of ['text', 'paragraph-property', 'formatting', 'formatting-interval']) {
    assert.equal(manualEditorFamily(kind), 'rich-text', kind);
  }
  for (const kind of ['table-cell', 'table-structure', 'cell-property', 'formula']) {
    assert.equal(manualEditorFamily(kind), 'table', kind);
  }
  for (const kind of ['shape-geometry', 'shape-style', 'chart-axis', 'chart-series', 'equation-property', 'ole-property']) {
    assert.equal(manualEditorFamily(kind), 'shape-chart', kind);
  }
  for (const kind of ['image-bytes', 'image-crop', 'image-placement', 'picture']) {
    assert.equal(manualEditorFamily(kind), 'image', kind);
  }
  for (const kind of [
    'section-property', 'column-settings', 'style', 'numbering', 'bullets',
    'field-properties', 'form-property', 'bookmark', 'resource-reference', 'fonts',
  ]) {
    assert.equal(manualEditorFamily(kind), 'document-properties', kind);
  }
});
