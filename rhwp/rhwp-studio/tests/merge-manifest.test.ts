import assert from 'node:assert/strict';
import test from 'node:test';

import type { CompareDocumentSnapshot } from '../src/compare/types.ts';
import { snapshotToMergeTree } from '../src/merge/manifest.ts';

test('snapshot merge trees preserve paragraph and control ordering while grouping once', () => {
  const anchor = { pageIndex: 0, x: 0, y: 0, width: 1, height: 1 };
  const paragraph = (section: number, index: number, stableId: string) => ({
    section,
    paragraph: index,
    sectionPage: 1,
    globalIndex: index,
    stableId,
    text: stableId,
    normalizedText: stableId,
    controlCount: 0,
    signature: stableId,
    isAnchorCandidate: true,
  });
  const snapshot: CompareDocumentSnapshot = {
    meta: { name: 'ordered', sectionCount: 2, pageCount: 1 },
    paragraphs: [paragraph(1, 0, 's1-p0'), paragraph(0, 1, 's0-p1'), paragraph(0, 0, 's0-p0')],
    controls: [
      { key: 'second', type: 'shape', section: 0, paragraph: 1, summary: '', kind: 'shape', anchor },
      { key: 'other', type: 'shape', section: 1, paragraph: 0, summary: '', kind: 'shape', anchor },
      { key: 'first', type: 'image', section: 0, paragraph: 1, summary: '', kind: 'image', anchor },
    ],
  };

  const tree = snapshotToMergeTree(snapshot) as {
    sections: Array<{ paragraphs: Array<{ stableId: string; controls: Array<{ stableId: string }> }> }>;
  };
  assert.deepEqual(tree.sections[0].paragraphs.map((item) => item.stableId), ['s0-p1', 's0-p0']);
  assert.deepEqual(tree.sections[0].paragraphs[0].controls.map((item) => item.stableId), ['second', 'first']);
  assert.deepEqual(tree.sections[1].paragraphs[0].controls.map((item) => item.stableId), ['other']);
});
