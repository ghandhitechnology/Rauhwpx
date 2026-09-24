import assert from 'node:assert/strict';
import test from 'node:test';
import { convertHftToOpenType } from '../src/core/hft-font.ts';
import { sfntCoversText } from '../src/core/sfnt-cmap.ts';

/** 직접 만든 contour만 포함한다. 상용 서체 데이터는 fixture로 저장하지 않는다. */
function syntheticHft(path = [3, 100, 0x7e, 64, 0x40, 0, 20, 9, 100, 50, 156, 206, 4, 1, 20, 5, 30, 6, 226, 7, 226, 0, 4]): ArrayBuffer {
  const first = 32; const count = 96; const widthAt = 512;
  const outlineAt = widthAt + 10 + count * 2; const base = outlineAt + 34;
  const records = Array.from({ length: count }, (_, i) => {
    const isA = i + first === 65;
    const glyph = new Uint8Array(isA ? 12 + path.length : 11);
    const v = new DataView(glyph.buffer);
    v.setUint16(6, isA ? 150 : 0, true);
    if (isA) { v.setUint16(10, path.length + 2, true); glyph.set(path, 12); }
    return glyph;
  });
  const start = base + 2 + count * 4;
  const bytes = new Uint8Array(start + records.reduce((sum, r) => sum + r.length, 0));
  const view = new DataView(bytes.buffer);
  const u16 = (at: number, n: number) => view.setUint16(at, n, true);
  const u32 = (at: number, n: number) => view.setUint32(at, n, true);
  bytes.set(new TextEncoder().encode('Han Unified Font File 1.0\x1a'));
  u32(0x1a, 0x01020304); u32(0x24, bytes.length); u16(0x194, 200);
  u32(0x1aa, widthAt); u32(0x1ae, outlineAt);
  u32(widthAt, 10 + count * 2); u16(widthAt + 4, first); u16(widthAt + 6, 127); u16(widthAt + 8, 1);
  for (let i = 0; i < count; i++) u16(widthAt + 10 + i * 2, 600);
  u32(outlineAt, bytes.length - outlineAt); u16(outlineAt + 4, 1000);
  u16(outlineAt + 6, 1); u16(outlineAt + 8, 1); u16(outlineAt + 20, first);
  u16(outlineAt + 22, 127); u16(outlineAt + 24, count);
  let offset = start;
  records.forEach((record, i) => { u32(base + 2 + i * 4, offset - base); bytes.set(record, offset); offset += record.length; });
  return bytes.buffer;
}
function tables(buffer: ArrayBuffer): Map<string, Uint8Array> {
  const view = new DataView(buffer); const bytes = new Uint8Array(buffer); const found = new Map<string, Uint8Array>();
  for (let i = 0; i < view.getUint16(4); i++) {
    const at = 12 + i * 16; const tag = new TextDecoder().decode(bytes.subarray(at, at + 4));
    const offset = view.getUint32(at + 8); found.set(tag, bytes.subarray(offset, offset + view.getUint32(at + 12)));
  }
  return found;
}
function readIndex(bytes: Uint8Array, at: number): { items: Uint8Array[]; end: number } {
  const count = bytes[at] * 256 + bytes[at + 1];
  if (!count) return { items: [], end: at + 2 };
  const size = bytes[at + 2]; const base = at + 3 + (count + 1) * size;
  const offset = (i: number) => { let n = 0; for (let k = 0; k < size; k++) n = n * 256 + bytes[at + 3 + i * size + k]; return base + n - 1; };
  return { items: Array.from({ length: count }, (_, i) => bytes.subarray(offset(i), offset(i + 1))), end: offset(count) };
}

test('HFT conversion preserves cubic coordinates, advance, Unicode coverage and SFNT checksum', () => {
  const converted = convertHftToOpenType(syntheticHft(), 'Example.hft')!;
  assert.equal(new TextDecoder().decode(new Uint8Array(converted, 0, 4)), 'OTTO');
  assert.equal(sfntCoversText(converted, 'A'), true);
  assert.equal(sfntCoversText(converted, 'λ'), false);
  assert.equal(sfntCoversText(converted, 'B'), false, 'empty glyph slots must retain fallback');
  assert.equal(sfntCoversText(converted, ' '), true, 'a real space keeps its advance');
  const found = tables(converted);
  const hmtx = new DataView(found.get('hmtx')!.buffer, found.get('hmtx')!.byteOffset);
  assert.equal(hmtx.getUint16(34 * 4), 600);
  const cff = found.get('CFF ')!;
  const name = readIndex(cff, 4); const top = readIndex(cff, name.end).items[0];
  // Top DICT의 CharStrings offset. CFF와 HFT 좌표 encoding은 서로 다르다.
  const operator = [...top].findIndex((b, i) => b === 17 && top[i - 5] === 29);
  const charAt = new DataView(top.buffer, top.byteOffset).getUint32(operator - 4);
  const program = readIndex(cff, charAt).items[34];
  assert.deepEqual([...program], [
    248, 236, // width 600
    239, 248, 136, 21, // move (100,500), HFT baseline 200 제거
    239, 139, 189, 39, 139, 89, 8, // cubic delta (100,0,50,-100,0,-50)
    251, 22, 247, 42, 21, // close 뒤 원래 시작점에서 hmoveto(+20)
    169, 139, 5, 139, 109, 5, 109, 139, 5, 14,
  ]);
  const view = new DataView(converted); let checksum = 0;
  for (let at = 0; at < converted.byteLength; at += 4) checksum = (checksum + view.getUint32(at)) >>> 0;
  assert.equal(checksum, 0xb1b0afba);
});

test('HFT conversion rejects unsupported commands, corrupt offsets and truncated coordinates', () => {
  assert.equal(convertHftToOpenType(new ArrayBuffer(64), 'Example.ttf'), null);
  assert.throws(() => convertHftToOpenType(syntheticHft([3, 0, 0, 255]), 'Example.hft'), /outline 명령/);
  assert.throws(() => convertHftToOpenType(syntheticHft([3, 0, 0x7c]), 'Example.hft'), /잘렸/);
  const invalid = syntheticHft(); new DataView(invalid).setUint32(0x1ae, 0xffffffff, true);
  assert.throws(() => convertHftToOpenType(invalid, 'Example.hft'), /범위/);
});

test('renaming an equation HFT file preserves its internal bank and style identity', () => {
  const source = syntheticHft();
  const bytes = new Uint8Array(source);
  bytes.set([0xae, 0x81, 0xaf, 0xa2, 0], 0x6c); // Johab family `수식`
  bytes[0x158] = 1;
  const converted = convertHftToOpenType(source, 'renamed-local-copy.hft')!;
  const name = tables(converted).get('name')!;
  const view = new DataView(name.buffer, name.byteOffset, name.byteLength);
  const strings = view.getUint16(4);
  const names = new Map<number, string>();
  for (let i = 0; i < view.getUint16(2); i++) {
    const at = 6 + i * 12; const length = view.getUint16(at + 8); const offset = strings + view.getUint16(at + 10);
    names.set(view.getUint16(at + 6), new TextDecoder('utf-16be').decode(name.subarray(offset, offset + length)));
  }
  assert.equal(names.get(1), 'HSUSRI');
  assert.equal(names.get(2), 'Italic');
});
