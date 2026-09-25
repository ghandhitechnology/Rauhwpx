import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMalformedCmapSentinels, repairUnderstatedCompositeBounds } from '../src/core/sfnt-repair.ts';

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

/** glyph 0: 단순 글리프 (0,300)-(500,700), glyph 1·2: glyph 0 을 쓰는 합성 글리프. */
function fontWithCompositeHeader(compositeYMax: number, pointMatched = false): ArrayBuffer {
  const buffer = new ArrayBuffer(192);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, 0x00010000, false);
  view.setUint16(4, 4, false);
  const records = [
    { tag: 'glyf', offset: 148, length: 44 },
    { tag: 'head', offset: 76, length: 54 },
    { tag: 'loca', offset: 140, length: 8 },
    { tag: 'maxp', offset: 132, length: 6 },
  ];
  records.forEach(({ tag, offset, length }, index) => {
    const record = 12 + index * 16;
    bytes.set(new TextEncoder().encode(tag), record);
    view.setUint32(record + 8, offset, false);
    view.setUint32(record + 12, length, false);
  });
  const bounds = (at: number, box: number[]) => box.forEach((value, index) => view.setInt16(at + 2 + index * 2, value, false));
  bounds(76 + 34, [0, 0, 500, 400]); // head 글꼴 bbox
  view.setUint16(132 + 4, 3, false); // maxp.numGlyphs
  [0, 12, 28, 44].forEach((offset, index) => view.setUint16(140 + index * 2, offset / 2, false));
  view.setInt16(148, 1, false);
  bounds(148, [0, 300, 500, 700]);
  for (const [at, flags] of [[160, 0x0002], [176, pointMatched ? 0x0000 : 0x0002]] as const) {
    view.setInt16(at, -1, false);
    bounds(at, [0, 0, 500, compositeYMax]);
    view.setUint16(at + 10, flags, false);
    view.setUint16(at + 12, 0, false); // component glyph 0, 인자 (0, 0)
  }
  return buffer;
}

test('widens understated composite glyph headers to the component union and keeps checksums valid', () => {
  const understated = fontWithCompositeHeader(400);
  const repaired = repairUnderstatedCompositeBounds(understated);
  assert.notEqual(repaired, understated);
  const view = new DataView(repaired);
  assert.equal(view.getInt16(160 + 8, false), 700);
  assert.equal(view.getInt16(176 + 8, false), 700);
  assert.equal(view.getInt16(76 + 42, false), 700, 'head.yMax');
  assert.equal(new DataView(understated).getInt16(160 + 8, false), 400);
  assert.equal(view.getUint32(12 + 4, false), wholeFontChecksum(repaired.slice(148, 192)));
  assert.equal(wholeFontChecksum(repaired), 0xb1b0afba);

  const correct = fontWithCompositeHeader(700);
  assert.equal(repairUnderstatedCompositeBounds(correct), correct);
});

test('leaves point-matched composites untouched', () => {
  const repaired = repairUnderstatedCompositeBounds(fontWithCompositeHeader(400, true));
  const view = new DataView(repaired);
  assert.equal(view.getInt16(160 + 8, false), 700);
  assert.equal(view.getInt16(176 + 8, false), 400);
});
