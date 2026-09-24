/** SFNT의 실제 Unicode cmap으로 글립 존재를 확인한다. 서체 이름/대체 렌더링을 추측하지 않는다. */
export function sfntCoversText(bytes: ArrayBuffer, text: string): boolean {
  try {
    const view = new DataView(bytes);
    const u16 = (offset: number) => view.getUint16(offset, false);
    const u32 = (offset: number) => view.getUint32(offset, false);
    if (u32(0) !== 0x00010000 && u32(0) !== 0x4f54544f) return false;
    let cmap = 0;
    let numGlyphs = 0;
    for (let i = 0; i < u16(4); i++) {
      const record = 12 + i * 16;
      const offset = u32(record + 8);
      const length = u32(record + 12);
      if (offset + length > bytes.byteLength) return false;
      if (u32(record) === 0x636d6170) cmap = offset;
      if (u32(record) === 0x6d617870) numGlyphs = u16(offset + 4);
    }
    if (!cmap || !numGlyphs) return false;
    const subtables: number[] = [];
    for (let i = 0; i < u16(cmap + 2); i++) {
      const record = cmap + 4 + i * 8;
      const platform = u16(record), encoding = u16(record + 2);
      if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) {
        subtables.push(cmap + u32(record + 4));
      }
    }
    const glyphFor = (table: number, code: number): number => {
      const format = u16(table);
      if (format === 12) {
        for (let i = 0; i < u32(table + 12); i++) {
          const group = table + 16 + i * 12;
          if (code >= u32(group) && code <= u32(group + 4)) return u32(group + 8) + code - u32(group);
        }
      } else if (format === 4 && code <= 0xffff) {
        const count = u16(table + 6) / 2;
        const ends = table + 14, starts = ends + count * 2 + 2;
        const deltas = starts + count * 2, ranges = deltas + count * 2;
        for (let i = 0; i < count; i++) {
          if (code < u16(starts + i * 2) || code > u16(ends + i * 2)) continue;
          const range = u16(ranges + i * 2), delta = u16(deltas + i * 2);
          if (!range) return (code + delta) & 0xffff;
          const glyph = u16(ranges + i * 2 + range + 2 * (code - u16(starts + i * 2)));
          return glyph ? (glyph + delta) & 0xffff : 0;
        }
      }
      return 0;
    };
    return [...text].every(character => subtables.some(table => {
      const glyph = glyphFor(table, character.codePointAt(0)!);
      return glyph > 0 && glyph < numGlyphs;
    }));
  } catch {
    return false;
  }
}

/** 양수 cell-height를 사용하는 구형 수식 텍스트의 em 크기 변환. */
export function sfntEmToCellRatio(bytes: ArrayBuffer): number | null {
  try {
    const view = new DataView(bytes);
    if (![0x00010000, 0x4f54544f].includes(view.getUint32(0))) return null;
    let units = 0; let cell = 0;
    for (let i = 0; i < view.getUint16(4); i++) {
      const record = 12 + i * 16; const tag = view.getUint32(record);
      const offset = view.getUint32(record + 8); const length = view.getUint32(record + 12);
      if (offset + length > bytes.byteLength) return null;
      if (tag === 0x68656164 && length >= 20) units = view.getUint16(offset + 18);
      if (tag === 0x68686561 && length >= 8) cell = view.getInt16(offset + 4) - view.getInt16(offset + 6);
    }
    return units > 0 && cell >= units && cell <= units * 4 ? units / cell : null;
  } catch { return null; }
}
