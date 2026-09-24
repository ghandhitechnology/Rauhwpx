/**
 * HFT 1.0 수식 서체의 cubic outline을 세션용 OpenType/CFF로 옮긴다.
 * 좌표/advance는 원본 값을 유지하며, 브라우저가 지원하지 않는 HFT hint만 제외한다.
 * 지원하지 않는 문자 인코딩/outline 명령은 대체 도형을 만들지 않고 거절한다.
 */
const MAGIC = 'Han Unified Font File 1.0\x1a';
type Point = [number, number];
type Outline = Array<{ op: 'move' | 'line' | 'curve' | 'close'; points: Point[] }>;
interface Glyph { code: number; advance: number; outline: Outline }
interface HftFont { family: string; italic: boolean; units: number; baseline: number; copyright: string; glyphs: Glyph[] }

class Reader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  check(at: number, length: number): void {
    if (!Number.isInteger(at) || at < 0 || length < 0 || at + length > this.bytes.length) throw new Error('잘못된 HFT 서체 범위입니다.');
  }
  u16(at: number): number { this.check(at, 2); return this.view.getUint16(at, true); }
  i16(at: number): number { this.check(at, 2); return this.view.getInt16(at, true); }
  u32(at: number): number { this.check(at, 4); return this.view.getUint32(at, true); }
}

/** HFT가 아니면 null. 손상되거나 지원하지 않는 HFT는 오류로 보고한다. */
export function convertHftToOpenType(bytes: ArrayBuffer, filename: string): ArrayBuffer | null {
  const source = new Uint8Array(bytes);
  if (source.length < MAGIC.length || ![...MAGIC].every((c, i) => source[i] === c.charCodeAt(0))) return null;
  return encodeOpenType(readHft(source, filename)).buffer as ArrayBuffer;
}

function readHft(bytes: Uint8Array, filename: string): HftFont {
  const r = new Reader(bytes);
  r.check(0, 0x200);
  if (r.u32(0x1a) !== 0x01020304 || r.u32(0x24) !== bytes.length) throw new Error('지원하지 않는 HFT 헤더입니다.');
  const widthAt = r.u32(0x1aa);
  const outlineAt = r.u32(0x1ae);
  r.check(widthAt, 10);
  r.check(outlineAt, 36);
  const first = r.u16(widthAt + 4);
  const last = r.u16(widthAt + 6);
  const count = last - first + 1;
  const knownEncoding = (first === 0x20 && last === 0x7f)
    || (first === 0x2200 && last === 0x22ff) || (first === 0x500 && last === 0x56f);
  if (!knownEncoding || r.u16(widthAt + 8) !== 1 || r.u16(outlineAt + 6) !== 1
    || r.u16(outlineAt + 8) !== 1 || r.u16(outlineAt + 20) !== first
    || r.u16(outlineAt + 22) !== last || r.u16(outlineAt + 24) !== count) {
    throw new Error('지원하지 않는 HFT 문자표 또는 outline 형식입니다.');
  }
  if (r.u32(widthAt) !== 10 + count * 2 || widthAt + r.u32(widthAt) !== outlineAt
    || outlineAt + r.u32(outlineAt) !== bytes.length) throw new Error('잘못된 HFT 테이블 길이입니다.');
  const units = r.u16(outlineAt + 4);
  const baseline = r.u16(0x194);
  if (units < 16 || units > 16384 || baseline > units) throw new Error('잘못된 HFT em 값입니다.');
  const base = outlineAt + 34;
  const offsets = base + 2;
  r.check(offsets, count * 4);
  const glyphs: Glyph[] = [];
  for (let index = 0; index < count; index++) {
    const start = base + r.u32(offsets + index * 4);
    const end = index + 1 < count ? base + r.u32(offsets + (index + 1) * 4) : bytes.length;
    if (start < offsets + count * 4 || end < start) throw new Error('잘못된 HFT glyph 순서입니다.');
    r.check(start, end - start);
    r.check(start, 11);
    const advance = r.u16(widthAt + 10 + index * 2);
    if (advance > 32767) throw new Error('HFT advance 범위를 벗어났습니다.');
    // 빈 glyph는 11-byte 기록을 쓰며, 일부 오래된 space에는 미완성 moveto가 있다.
    const empty = end - start <= 12 || r.u16(start + 6) === 0;
    let outline: Outline = [];
    if (!empty) {
      const length = r.u16(start + 10);
      if (length < 2 || start + 10 + length > end) throw new Error('잘못된 HFT glyph 길이입니다.');
      outline = decodeOutline(bytes.subarray(start + 12, start + 10 + length), baseline);
    }
    glyphs.push({ code: first + index, advance, outline });
  }
  const italic = bytes[0x158] === 1;
  // 내부 Johab family `수식` + 문자표로 bank를 식별한다. 파일을 바꿔 이름 붙여도 동일하다.
  const equationFamily = [0xae, 0x81, 0xaf, 0xa2, 0].every((byte, i) => bytes[0x6c + i] === byte);
  const family = equationFamily
    ? first === 0x500 ? 'HSUSFL' : first === 0x2200 ? 'HSUSSP' : italic ? 'HSUSRI' : 'HSUSR'
    : filename.replace(/^.*[\\/]/, '').replace(/\.hft$/i, '').trim() || 'Imported HFT';
  const copyright = new TextDecoder('ascii').decode(bytes.subarray(0xcc, 0x10c)).replace(/\0.*$/s, '').trim();
  return { family, italic, units, baseline, copyright, glyphs };
}

function decodeOutline(bytes: Uint8Array, baseline: number): Outline {
  let at = 0;
  let x = 0;
  let y = 0;
  let start: Point = [0, 0];
  let open = false;
  const outline: Outline = [];
  const read = (): number => {
    if (at >= bytes.length) throw new Error('HFT outline이 잘렸습니다.');
    return bytes[at++];
  };
  const number = (): number => {
    const value = read();
    if (value >= 0x7c && value <= 0x7f) return (value - 0x7c) * 256 + 124 + read();
    if (value >= 0x81 && value <= 0x84) return -((0x84 - value) * 256 + 124 + read());
    if (value === 0x80) throw new Error('지원하지 않는 HFT 좌표 형식입니다.');
    return value < 128 ? value : value - 256;
  };
  const point = (dx: number, dy: number): Point => {
    x += dx; y += dy;
    if (Math.abs(x) > 32767 || Math.abs(y - baseline) > 32767) throw new Error('HFT 좌표 범위를 벗어났습니다.');
    return [x, y - baseline];
  };
  const move = (dx: number, dy: number): void => {
    if (open) outline.push({ op: 'close', points: [] });
    const p = point(dx, dy);
    start = [x, y];
    outline.push({ op: 'move', points: [p] });
    open = true;
  };
  while (at < bytes.length) {
    const op = read();
    if (op === 1) move(number(), 0);
    else if (op === 2) move(0, number());
    else if (op === 3) move(number(), number());
    else if (op === 4) {
      if (!open) throw new Error('잘못된 HFT contour입니다.');
      outline.push({ op: 'close', points: [] }); open = false; [x, y] = start;
    } else if (op === 5 || op === 6 || op === 7) {
      if (!open) throw new Error('잘못된 HFT contour입니다.');
      const dx = op === 6 ? 0 : number();
      const dy = op === 5 ? 0 : number();
      outline.push({ op: 'line', points: [point(dx, dy)] });
    } else if (op === 9 || op === 10 || op === 11) {
      if (!open) throw new Error('잘못된 HFT contour입니다.');
      const a = point(op === 10 ? 0 : number(), op === 9 ? 0 : number());
      const b = point(number(), number());
      const c = point(op === 9 ? 0 : number(), op === 10 ? 0 : number());
      outline.push({ op: 'curve', points: [a, b, c] });
    } else if (op >= 0x40 && op <= 0x43) {
      // hstem/vstem 및 3-stem hint. 곡선 좌표에는 영향을 주지 않는다.
      for (let n = 0; n < (op % 2 === 0 ? 2 : 6); n++) number();
    } else throw new Error(`지원하지 않는 HFT outline 명령: ${op}`);
  }
  if (open) outline.push({ op: 'close', points: [] });
  return outline;
}

const u16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string): number[] => [...s].map(c => c.charCodeAt(0) & 127);
const utf16 = (s: string): number[] => Array.from({ length: s.length }, (_, i) => u16(s.charCodeAt(i))).flat();
const set16 = (b: Uint8Array, at: number, n: number): void => { b.set(u16(n), at); };
const set32 = (b: Uint8Array, at: number, n: number): void => { b.set(u32(n), at); };
const checksum = (bytes: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum = (sum + (((bytes[i] ?? 0) * 0x1000000)
    + ((bytes[i + 1] ?? 0) << 16) + ((bytes[i + 2] ?? 0) << 8) + (bytes[i + 3] ?? 0))) >>> 0;
  return sum;
};

function cffInteger(n: number): number[] {
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) return [247 + ((n - 108) >> 8), (n - 108) & 255];
  if (n >= -1131 && n <= -108) return [251 + ((-n - 108) >> 8), (-n - 108) & 255];
  if (n >= -32768 && n <= 32767) return [28, ...u16(n)];
  return [29, ...u32(n)];
}
function cffReal(n: number): number[] {
  const digits = n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  const nibbles = [...digits].map(c => c === '.' ? 10 : c === '-' ? 14 : Number(c));
  nibbles.push(15); if (nibbles.length % 2) nibbles.push(15);
  return [30, ...Array.from({ length: nibbles.length / 2 }, (_, i) => nibbles[i * 2] * 16 + nibbles[i * 2 + 1])];
}
function cffIndex(items: number[][]): number[] {
  if (!items.length) return [0, 0];
  const offsets = [1];
  for (const item of items) offsets.push(offsets.at(-1)! + item.length);
  const size = offsets.at(-1)! <= 0xffff ? 2 : 4;
  return [...u16(items.length), size, ...offsets.flatMap(n => size === 2 ? u16(n) : u32(n)), ...items.flat()];
}
function charString(glyph: Glyph): number[] {
  const out = cffInteger(glyph.advance);
  let x = 0; let y = 0;
  for (const command of glyph.outline) {
    if (command.op === 'close') continue; // Type 2 closes each contour at the next move/endchar.
    for (const [nx, ny] of command.points) {
      const dx = nx - x; const dy = ny - y;
      if ([dx, dy].some(n => n < -32768 || n > 32767)) throw new Error('HFT 상대 좌표 범위를 벗어났습니다.');
      out.push(...cffInteger(dx), ...cffInteger(dy)); x = nx; y = ny;
    }
    out.push(command.op === 'move' ? 21 : command.op === 'line' ? 5 : 8);
  }
  out.push(14);
  return out;
}
function cffTable(font: HftFont, bbox: number[]): Uint8Array {
  const postscript = font.family.replace(/[^A-Za-z0-9_-]/g, '') || 'ImportedHFT';
  const names = cffIndex([ascii(postscript)]);
  const strings = cffIndex(font.glyphs.map(g => ascii(`hft${g.code.toString(16)}`)));
  const charset = [0, ...font.glyphs.flatMap((_, i) => u16(391 + i))];
  const chars = cffIndex([[14], ...font.glyphs.map(charString)]);
  // 고정 32-bit DICT offset으로 INDEX 크기가 offset 값에 의존하지 않는다.
  const dict = (charsetAt: number, charsAt: number, privateAt: number): number[] => [
    ...bbox.flatMap(cffInteger), 5,
    ...[1 / font.units, 0, 0, 1 / font.units, 0, 0].flatMap(cffReal), 12, 7,
    29, ...u32(charsetAt), 15, 29, ...u32(charsAt), 17,
    139, 29, ...u32(privateAt), 18,
  ];
  const prefixSize = 4 + names.length + cffIndex([dict(0, 0, 0)]).length + strings.length + 2;
  const top = cffIndex([dict(prefixSize, prefixSize + charset.length, prefixSize + charset.length + chars.length)]);
  return Uint8Array.from([1, 0, 4, 4, ...names, ...top, ...strings, 0, 0, ...charset, ...chars]);
}

function unicodeEntries(glyphs: Glyph[]): Array<[number, number]> {
  const entries: Array<[number, number]> = [];
  glyphs.forEach((glyph, i) => {
    const code = glyph.code;
    const drawable = glyph.outline.some(command => command.op === 'line' || command.op === 'curve');
    if (!drawable && !(code === 0x20 && glyph.advance > 0)) return;
    if (code < 0x500 || code >= 0x2200) entries.push([code, i + 1]);
    else {
      // HFT Greek bank: Unicode Greek block + 0x190. 그 밖의 역사적 glyph는 PUA로 보존한다.
      if ((code >= 0x521 && code <= 0x559) || (code >= 0x560 && code <= 0x566)) entries.push([code - 0x190, i + 1]);
      entries.push([0xe000 + code - 0x500, i + 1]);
    }
  });
  return entries.sort((a, b) => a[0] - b[0]);
}
function cmapTable(glyphs: Glyph[]): Uint8Array {
  const groups = unicodeEntries(glyphs).map(([code, gid]) => [...u32(code), ...u32(code), ...u32(gid)]).flat();
  const subtable = [0, 12, 0, 0, ...u32(16 + groups.length), 0, 0, 0, 0, ...u32(groups.length / 12), ...groups];
  return Uint8Array.from([0, 0, 0, 1, 0, 3, 0, 10, ...u32(12), ...subtable]);
}
function nameTable(font: HftFont): Uint8Array {
  const style = font.italic ? 'Italic' : 'Regular';
  const names: Array<[number, string]> = [[0, font.copyright], [1, font.family], [2, style],
    [3, `${font.family};HFT1.0`], [4, `${font.family} ${style}`], [5, 'Version 1.000'],
    [6, font.family.replace(/[^A-Za-z0-9_-]/g, '') || 'ImportedHFT']];
  const data: number[] = []; const records: number[] = [];
  for (const [id, name] of names) {
    const value = utf16(name);
    records.push(0, 3, 0, 1, 4, 9, ...u16(id), ...u16(value.length), ...u16(data.length)); data.push(...value);
  }
  return Uint8Array.from([0, 0, ...u16(names.length), ...u16(6 + records.length), ...records, ...data]);
}
function encodeOpenType(font: HftFont): Uint8Array {
  const points = font.glyphs.flatMap(g => g.outline.flatMap(c => c.points));
  const bbox = points.length ? [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))] : [0, 0, 0, 0];
  const ascent = font.units - font.baseline; const descent = -font.baseline;
  const count = font.glyphs.length + 1;
  const maxAdvance = Math.max(...font.glyphs.map(g => g.advance));
  const head = new Uint8Array(54); set32(head, 0, 0x00010000); set32(head, 4, 0x00010000);
  set32(head, 12, 0x5f0f3cf5); set16(head, 16, 3); set16(head, 18, font.units);
  bbox.forEach((v, i) => set16(head, 36 + i * 2, v)); set16(head, 44, font.italic ? 2 : 0); set16(head, 46, 8);
  const hhea = new Uint8Array(36); set32(hhea, 0, 0x00010000);
  set16(hhea, 4, ascent); set16(hhea, 6, descent); set16(hhea, 10, maxAdvance);
  set16(hhea, 12, bbox[0]); set16(hhea, 14, Math.min(0, maxAdvance - bbox[2])); set16(hhea, 16, bbox[2]);
  set16(hhea, 18, 1); set16(hhea, 34, count);
  const hmtx = Uint8Array.from([0, 0, 0, 0, ...font.glyphs.flatMap(g => {
    const xs = g.outline.flatMap(c => c.points.map(p => p[0]));
    return [...u16(g.advance), ...u16(xs.length ? Math.min(...xs) : 0)];
  })]);
  const os2 = new Uint8Array(96); set16(os2, 0, 4); set16(os2, 2, Math.round(maxAdvance / 2));
  set16(os2, 4, 400); set16(os2, 6, 5); os2.set(ascii('RHWP'), 58); set16(os2, 62, font.italic ? 1 : 64);
  const codes = unicodeEntries(font.glyphs).map(e => e[0]); set16(os2, 64, codes.length ? Math.min(...codes) : 0); set16(os2, 66, codes.length ? Math.max(...codes) : 0);
  set16(os2, 68, ascent); set16(os2, 70, descent); set16(os2, 74, Math.max(ascent, bbox[3]));
  set16(os2, 76, Math.max(-descent, -bbox[1])); set16(os2, 86, Math.round(font.units * .5));
  set16(os2, 88, Math.round(font.units * .7)); set16(os2, 92, 32); set16(os2, 94, 1);
  const post = new Uint8Array(32); set32(post, 0, 0x00030000); set32(post, 4, font.italic ? -12 * 65536 : 0);
  set16(post, 8, -100); set16(post, 10, 50);
  const tables = new Map<string, Uint8Array>([
    ['CFF ', cffTable(font, bbox)], ['OS/2', os2], ['cmap', cmapTable(font.glyphs)], ['head', head],
    ['hhea', hhea], ['hmtx', hmtx], ['maxp', Uint8Array.from([...u32(0x5000), ...u16(count)])],
    ['name', nameTable(font)], ['post', post],
  ]);
  const sorted = [...tables].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let offset = 12 + sorted.length * 16;
  const size = offset + sorted.reduce((sum, [, data]) => sum + ((data.length + 3) & ~3), 0);
  const result = new Uint8Array(size); result.set(ascii('OTTO')); set16(result, 4, sorted.length);
  const power = Math.floor(Math.log2(sorted.length)); set16(result, 6, 16 * 2 ** power); set16(result, 8, power);
  set16(result, 10, sorted.length * 16 - 16 * 2 ** power);
  let headOffset = 0;
  sorted.forEach(([tag, data], i) => {
    const record = 12 + i * 16; result.set(ascii(tag), record); set32(result, record + 4, checksum(data));
    set32(result, record + 8, offset); set32(result, record + 12, data.length); result.set(data, offset);
    if (tag === 'head') headOffset = offset;
    offset += (data.length + 3) & ~3;
  });
  set32(result, headOffset + 8, (0xb1b0afba - checksum(result)) >>> 0);
  return result;
}
