import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sfntTrueTypeRunMetrics } from '../src/core/sfnt-cmap.ts';

const fixture = new URL('../../tests/fixtures/fonts/RHWPShapingFixture.ttf', import.meta.url);
const font = readFileSync(fixture);
const bytes = font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength);

test('reads TrueType run advance and glyph ink edges in source font units', () => {
  // The fixture has 1000 units/em. A and V each advance 600 units and
  // paint from x=50 to x=500 in their respective glyph coordinates.
  assert.deepEqual(sfntTrueTypeRunMetrics(bytes, 'AV', 10), {
    advance: 12,
    inkLeft: 0.5,
    inkRight: 11,
  });
  assert.deepEqual(sfntTrueTypeRunMetrics(bytes, 'A', 20), {
    advance: 12,
    inkLeft: 1,
    inkRight: 10,
  });
});

test('does not invent metrics for an unmapped glyph or malformed font', () => {
  assert.equal(sfntTrueTypeRunMetrics(bytes, 'Ω', 10), null);
  assert.equal(sfntTrueTypeRunMetrics(bytes.slice(0, 40), 'A', 10), null);
  for (const tag of ['hmtx', 'loca', 'cmap']) {
    const damaged = bytes.slice(0);
    const view = new DataView(damaged);
    const records = view.getUint16(4, false);
    for (let index = 0; index < records; index += 1) {
      const record = 12 + index * 16;
      const name = new TextDecoder().decode(new Uint8Array(damaged, record, 4));
      if (name === tag) view.setUint32(record + 12, 4, false);
    }
    assert.equal(sfntTrueTypeRunMetrics(damaged, 'A', 10), null, `${tag} must stay in bounds`);
  }
});
