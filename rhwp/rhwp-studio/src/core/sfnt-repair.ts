/**
 * Some legacy TrueType fonts end a format-4 cmap with U+FFFF → glyph 65535.
 * That sentinel must map to glyph 0; Chrome's font sanitizer rejects the face.
 * Repair only this malformed sentinel and update the SFNT checksums.
 */
export function normalizeMalformedCmapSentinels(source: ArrayBuffer): ArrayBuffer {
  const input = new DataView(source);
  if (input.byteLength < 12) return source;
  const sfntVersion = input.getUint32(0, false);
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(sfntVersion)) return source;
  const tableCount = input.getUint16(4, false);
  if (12 + tableCount * 16 > input.byteLength) return source;

  const table = (tag: string) => {
    for (let index = 0; index < tableCount; index += 1) {
      const record = 12 + index * 16;
      const name = String.fromCharCode(...new Uint8Array(source, record, 4));
      if (name !== tag) continue;
      const offset = input.getUint32(record + 8, false);
      const length = input.getUint32(record + 12, false);
      if (offset > input.byteLength || length > input.byteLength - offset) return null;
      return { record, offset, length };
    }
    return null;
  };
  const cmap = table('cmap');
  const head = table('head');
  const maxp = table('maxp');
  if (!cmap || cmap.length < 4 || !head || head.length < 12 || !maxp || maxp.length < 6) {
    return source;
  }
  if (input.getUint16(maxp.offset + 4, false) === 0) return source;
  const encodingCount = input.getUint16(cmap.offset + 2, false);
  if (4 + encodingCount * 8 > cmap.length) return source;

  let output: ArrayBuffer | null = null;
  const visited = new Set<number>();
  for (let index = 0; index < encodingCount; index += 1) {
    const subtableOffset = input.getUint32(cmap.offset + 4 + index * 8 + 4, false);
    if (visited.has(subtableOffset)) continue;
    visited.add(subtableOffset);
    if (subtableOffset > cmap.length - 16) continue;
    const subtable = cmap.offset + subtableOffset;
    if (input.getUint16(subtable, false) !== 4) continue;
    const length = input.getUint16(subtable + 2, false);
    const segCountX2 = input.getUint16(subtable + 6, false);
    if (segCountX2 === 0 || segCountX2 % 2 !== 0) continue;
    const segments = segCountX2 / 2;
    if (length < 16 + segments * 8 || subtableOffset + length > cmap.length) continue;

    const lastEnd = subtable + 12 + segments * 2;
    const lastStart = subtable + 14 + segments * 4;
    const lastDelta = subtable + 14 + segments * 6;
    const lastRange = subtable + 14 + segments * 8;
    if (input.getUint16(lastEnd, false) !== 0xffff
      || input.getUint16(lastStart, false) !== 0xffff
      || input.getUint16(lastDelta, false) !== 0
      || input.getUint16(lastRange, false) !== 0) continue;
    output ??= source.slice(0);
    new DataView(output).setUint16(lastDelta, 1, false);
  }
  if (!output) return source;

  const bytes = new Uint8Array(output);
  const repaired = new DataView(output);
  const checksum = (offset: number, length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 4) {
      const word = ((bytes[offset + index] ?? 0) << 24)
        | ((index + 1 < length ? bytes[offset + index + 1] : 0) << 16)
        | ((index + 2 < length ? bytes[offset + index + 2] : 0) << 8)
        | (index + 3 < length ? bytes[offset + index + 3] : 0);
      sum = (sum + (word >>> 0)) >>> 0;
    }
    return sum;
  };
  repaired.setUint32(head.offset + 8, 0, false);
  repaired.setUint32(cmap.record + 4, checksum(cmap.offset, cmap.length), false);
  repaired.setUint32(head.record + 4, checksum(head.offset, head.length), false);
  repaired.setUint32(head.offset + 8, (0xb1b0afba - checksum(0, bytes.length)) >>> 0, false);
  return output;
}
