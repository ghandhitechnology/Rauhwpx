import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMalformedCmapSentinels } from '../src/core/sfnt-repair.ts';

function fontWithFormat4Sentinel(delta: number, rangeOffset = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(116);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, 0x00010000, false);
  view.setUint16(4, 3, false);
  const records = [
    { tag: 'cmap', offset: 60, length: 36 },
    { tag: 'head', offset: 96, length: 12 },
    { tag: 'maxp', offset: 108, length: 6 },
  ];
  records.forEach(({ tag, offset, length }, index) => {
    const record = 12 + index * 16;
    bytes.set(new TextEncoder().encode(tag), record);
    view.setUint32(record + 8, offset, false);
    view.setUint32(record + 12, length, false);
  });
  view.setUint16(62, 1, false); // cmap encoding count
  view.setUint16(64, 3, false); // Windows platform
  view.setUint16(66, 1, false); // Unicode BMP encoding
  view.setUint32(68, 12, false); // format-4 subtable offset
  view.setUint16(72, 4, false);
  view.setUint16(74, 24, false);
  view.setUint16(78, 2, false); // one segment
  view.setUint16(86, 0xffff, false); // final endCode
  view.setUint16(90, 0xffff, false); // final startCode
  view.setUint16(92, delta, false);
  view.setUint16(94, rangeOffset, false);
  view.setUint16(112, 10, false); // maxp.numGlyphs
  return buffer;
}

function wholeFontChecksum(buffer: ArrayBuffer): number {
  const bytes = new Uint8Array(buffer);
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    const word = ((bytes[index] ?? 0) << 24)
      | ((bytes[index + 1] ?? 0) << 16)
      | ((bytes[index + 2] ?? 0) << 8)
      | (bytes[index + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

test('repairs only an out-of-range format-4 final sentinel and keeps valid font checksums', () => {
  const malformed = fontWithFormat4Sentinel(0);
  const repaired = normalizeMalformedCmapSentinels(malformed);
  assert.notEqual(repaired, malformed);
  assert.equal(new DataView(repaired).getUint16(92, false), 1);
  assert.equal(new DataView(malformed).getUint16(92, false), 0);
  assert.equal(new DataView(repaired).getUint32(16, false), wholeFontChecksum(repaired.slice(60, 96)));
  assert.equal(wholeFontChecksum(repaired), 0xb1b0afba);

  const valid = fontWithFormat4Sentinel(1);
  assert.equal(normalizeMalformedCmapSentinels(valid), valid);
  const glyphArraySentinel = fontWithFormat4Sentinel(0, 2);
  assert.equal(normalizeMalformedCmapSentinels(glyphArraySentinel), glyphArraySentinel);
});
