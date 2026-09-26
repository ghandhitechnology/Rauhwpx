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

  writeSfntChecksums(output, head, [cmap]);
  return output;
}

interface SfntTableRef {
  record: number;
  offset: number;
  length: number;
}

function sfntChecksum(bytes: Uint8Array, offset: number, length: number): number {
  let sum = 0;
  for (let index = 0; index < length; index += 4) {
    const word = ((bytes[offset + index] ?? 0) << 24)
      | ((index + 1 < length ? bytes[offset + index + 1] : 0) << 16)
      | ((index + 2 < length ? bytes[offset + index + 2] : 0) << 8)
      | (index + 3 < length ? bytes[offset + index + 3] : 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/** 바뀐 테이블과 head 의 checksum, 그리고 글꼴 전체 checkSumAdjustment 를 다시 쓴다. */
function writeSfntChecksums(output: ArrayBuffer, head: SfntTableRef, changed: SfntTableRef[]): void {
  const bytes = new Uint8Array(output);
  const view = new DataView(output);
  view.setUint32(head.offset + 8, 0, false);
  for (const table of changed) {
    view.setUint32(table.record + 4, sfntChecksum(bytes, table.offset, table.length), false);
  }
  view.setUint32(head.record + 4, sfntChecksum(bytes, head.offset, head.length), false);
  view.setUint32(head.offset + 8, (0xb1b0afba - sfntChecksum(bytes, 0, bytes.length)) >>> 0, false);
}

// glyf 합성 글리프 component flag (OpenType glyf 명세)
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const SCALED_COMPONENT_OFFSET = 0x0800;

type GlyphBounds = [xMin: number, yMin: number, xMax: number, yMax: number];

/**
 * 합성 글리프 헤더 bbox 가 component 합집합보다 작은 TrueType 글꼴을 고친다.
 *
 * HY헤드라인M·돋움체 등 한컴 서체의 한글 합성 글리프는 헤더 bbox 가 실제 윤곽보다
 * 낮게 기록돼 있다. macOS Chrome(CoreText)은 글리프를 헤더 bbox 크기로 래스터해
 * 초성 윗획이 잘린다('초→조', '즉→슥'). 그런 합성 글리프 헤더만 component
 * bbox 합집합까지 넓히고, head 의 글꼴 bbox 도 같이 넓힌다. 윤곽·advance 는 그대로다.
 * 고칠 글리프가 없으면 원본 버퍼를 그대로 반환한다.
 */
export function repairUnderstatedCompositeBounds(source: ArrayBuffer): ArrayBuffer {
  const input = new DataView(source);
  if (input.byteLength < 12) return source;
  const sfntVersion = input.getUint32(0, false);
  if (sfntVersion !== 0x00010000 && sfntVersion !== 0x74727565) return source;
  const tableCount = input.getUint16(4, false);
  if (12 + tableCount * 16 > input.byteLength) return source;
  const table = (tag: string): SfntTableRef | null => {
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
  const head = table('head');
  const maxp = table('maxp');
  const loca = table('loca');
  const glyf = table('glyf');
  if (!head || head.length < 54 || !maxp || maxp.length < 6 || !loca || !glyf) return source;
  const numGlyphs = input.getUint16(maxp.offset + 4, false);
  const longLoca = input.getInt16(head.offset + 50, false) === 1;
  if (loca.length < (numGlyphs + 1) * (longLoca ? 4 : 2)) return source;

  const glyphRange = (glyph: number): [number, number] | null => {
    const start = longLoca
      ? input.getUint32(loca.offset + glyph * 4, false)
      : input.getUint16(loca.offset + glyph * 2, false) * 2;
    const end = longLoca
      ? input.getUint32(loca.offset + glyph * 4 + 4, false)
      : input.getUint16(loca.offset + glyph * 2 + 2, false) * 2;
    if (end - start < 10 || end > glyf.length) return null;
    return [glyf.offset + start, glyf.offset + end];
  };
  const headerBounds = (at: number): GlyphBounds => [
    input.getInt16(at + 2, false),
    input.getInt16(at + 4, false),
    input.getInt16(at + 6, false),
    input.getInt16(at + 8, false),
  ];

  // 합성 글리프 bbox = component bbox 를 변환한 네 꼭짓점의 합집합 (보수적 외접 사각형).
  // F2Dot14 배율 오차(-0.99988 등)로 1 단위씩 넓히지 않도록 정수로 반올림한다.
  const resolved = new Map<number, GlyphBounds | null>();
  const pending: number[] = [];
  const compositeBounds = (glyph: number, depth: number): GlyphBounds | null => {
    if (resolved.has(glyph)) return resolved.get(glyph)!;
    const range = glyphRange(glyph);
    if (!range || depth > 8) return null;
    const [start, end] = range;
    const header = headerBounds(start);
    if (input.getInt16(start, false) >= 0) {
      resolved.set(glyph, header);
      return header;
    }
    let union: GlyphBounds | null = null;
    let at = start + 10;
    let flags = MORE_COMPONENTS;
    while (flags & MORE_COMPONENTS) {
      if (at + 4 > end) return null;
      flags = input.getUint16(at, false);
      const component = input.getUint16(at + 2, false);
      at += 4;
      if (!(flags & ARGS_ARE_XY_VALUES)) {
        // 점 맞춤(point matching) 배치는 윤곽 좌표가 필요하므로 건드리지 않는다.
        resolved.set(glyph, null);
        return null;
      }
      const words = (flags & ARG_1_AND_2_ARE_WORDS) !== 0;
      if (at + (words ? 4 : 2) > end) return null;
      let dx = words ? input.getInt16(at, false) : input.getInt8(at);
      let dy = words ? input.getInt16(at + 2, false) : input.getInt8(at + 1);
      at += words ? 4 : 2;
      let [a, b, c, d] = [1, 0, 0, 1];
      const f2dot14 = (offset: number) => input.getInt16(offset, false) / 16384;
      if (flags & WE_HAVE_A_SCALE) {
        a = d = f2dot14(at);
        at += 2;
      } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
        a = f2dot14(at);
        d = f2dot14(at + 2);
        at += 4;
      } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
        a = f2dot14(at);
        b = f2dot14(at + 2);
        c = f2dot14(at + 4);
        d = f2dot14(at + 6);
        at += 8;
      }
      if (flags & SCALED_COMPONENT_OFFSET) {
        [dx, dy] = [a * dx + c * dy, b * dx + d * dy];
      }
      const inner = compositeBounds(component, depth + 1);
      if (!inner) {
        // 빈 component(공백 등)는 합집합에 영향이 없다.
        if (glyphRange(component)) {
          resolved.set(glyph, null);
          return null;
        }
        continue;
      }
      for (const [x, y] of [
        [inner[0], inner[1]], [inner[0], inner[3]], [inner[2], inner[1]], [inner[2], inner[3]],
      ] as const) {
        const tx = a * x + c * y + dx;
        const ty = b * x + d * y + dy;
        union = union
          ? [Math.min(union[0], tx), Math.min(union[1], ty), Math.max(union[2], tx), Math.max(union[3], ty)]
          : [tx, ty, tx, ty];
      }
    }
    const grown: GlyphBounds = union
      ? [
          Math.min(header[0], Math.round(union[0])),
          Math.min(header[1], Math.round(union[1])),
          Math.max(header[2], Math.round(union[2])),
          Math.max(header[3], Math.round(union[3])),
        ]
      : header;
    if (grown.some((value, index) => value !== header[index])
      && grown.every(value => value >= -32768 && value <= 32767)) {
      pending.push(glyph);
    }
    resolved.set(glyph, grown);
    return grown;
  };
  for (let glyph = 0; glyph < numGlyphs; glyph += 1) compositeBounds(glyph, 0);
  if (pending.length === 0) return source;

  const output = source.slice(0);
  const view = new DataView(output);
  const fontBounds = headerBounds(head.offset + 34);
  for (const glyph of pending) {
    const [start] = glyphRange(glyph)!;
    const bounds = resolved.get(glyph)!;
    bounds.forEach((value, index) => view.setInt16(start + 2 + index * 2, value, false));
    fontBounds[0] = Math.min(fontBounds[0], bounds[0]);
    fontBounds[1] = Math.min(fontBounds[1], bounds[1]);
    fontBounds[2] = Math.max(fontBounds[2], bounds[2]);
    fontBounds[3] = Math.max(fontBounds[3], bounds[3]);
  }
  fontBounds.forEach((value, index) => view.setInt16(head.offset + 36 + index * 2, value, false));
  writeSfntChecksums(output, head, [glyf]);
  return output;
}
