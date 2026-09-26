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

/** HYhwpEQ TrueType run metrics from the same glyf/hmtx fields as native. */
export function sfntTrueTypeRunMetrics(
  bytes: ArrayBuffer,
  text: string,
  size: number,
): { advance: number; inkLeft: number; inkRight: number } | null {
  try {
    if (!text || !Number.isFinite(size) || size <= 0) return null;
    const view = new DataView(bytes);
    const u16 = (offset: number) => view.getUint16(offset, false);
    const i16 = (offset: number) => view.getInt16(offset, false);
    const u32 = (offset: number) => view.getUint32(offset, false);
    if (u32(0) !== 0x00010000) return null;
    const tables = new Map<number, { offset: number; length: number }>();
    for (let i = 0; i < u16(4); i += 1) {
      const record = 12 + i * 16;
      const offset = u32(record + 8); const length = u32(record + 12);
      if (offset + length > bytes.byteLength) return null;
      tables.set(u32(record), { offset, length });
    }
    const table = (tag: number, minimum: number) => {
      const found = tables.get(tag);
      return found && found.length >= minimum ? found.offset : null;
    };
    const head = table(0x68656164, 54), hhea = table(0x68686561, 36);
    const maxp = table(0x6d617870, 6), hmtx = table(0x686d7478, 4);
    const loca = table(0x6c6f6361, 2), glyf = table(0x676c7966, 10);
    const cmap = table(0x636d6170, 4);
    if ([head, hhea, maxp, hmtx, loca, glyf, cmap].some(value => value === null)) return null;
    const upm = u16(head! + 18), glyphCount = u16(maxp! + 4), metricCount = u16(hhea! + 34);
    if (!upm || !glyphCount || !metricCount || metricCount > glyphCount) return null;
    const longLoca = i16(head! + 50) !== 0;
    if (tables.get(0x686d7478)!.length < metricCount * 4 + (glyphCount - metricCount) * 2
        || tables.get(0x6c6f6361)!.length < (glyphCount + 1) * (longLoca ? 4 : 2)) return null;
    const cmapLength = tables.get(0x636d6170)!.length;
    if (4 + u16(cmap! + 2) * 8 > cmapLength) return null;
    const cmapTables: number[] = [];
    for (let i = 0; i < u16(cmap! + 2); i += 1) {
      const record = cmap! + 4 + i * 8;
      const platform = u16(record), encoding = u16(record + 2);
      if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) {
        const offset = u32(record + 4);
        if (offset + 2 > cmapLength) return null;
        const subtable = cmap! + offset;
        const format = u16(subtable);
        if (format === 4) {
          if (offset + 16 > cmapLength) return null;
          const length = u16(subtable + 2);
          const count = u16(subtable + 6) / 2;
          if (length < 16 + count * 8 || offset + length > cmapLength) return null;
        } else if (format === 12) {
          if (offset + 16 > cmapLength) return null;
          const length = u32(subtable + 4);
          if (length < 16 + u32(subtable + 12) * 12 || offset + length > cmapLength) return null;
        } else continue;
        cmapTables.push(subtable);
      }
    }
    const glyphFor = (code: number): number => {
      for (const subtable of cmapTables) {
        const format = u16(subtable);
        if (format === 12) {
          for (let i = 0; i < u32(subtable + 12); i += 1) {
            const group = subtable + 16 + i * 12;
            if (code >= u32(group) && code <= u32(group + 4)) {
              return u32(group + 8) + code - u32(group);
            }
          }
        } else if (format === 4 && code <= 0xffff) {
          const count = u16(subtable + 6) / 2;
          const ends = subtable + 14, starts = ends + count * 2 + 2;
          const deltas = starts + count * 2, ranges = deltas + count * 2;
          for (let i = 0; i < count; i += 1) {
            if (code < u16(starts + i * 2) || code > u16(ends + i * 2)) continue;
            const range = u16(ranges + i * 2), delta = u16(deltas + i * 2);
            if (!range) return (code + delta) & 0xffff;
            const glyphOffset = ranges + i * 2 + range + 2 * (code - u16(starts + i * 2));
            if (glyphOffset + 2 > subtable + u16(subtable + 2)) return 0;
            const glyph = u16(glyphOffset);
            return glyph ? (glyph + delta) & 0xffff : 0;
          }
        }
      }
      return 0;
    };
    let advance = 0, inkLeft = Number.NaN, inkRight = 0;
    for (const character of text) {
      const glyph = glyphFor(character.codePointAt(0)!);
      if (!glyph || glyph >= glyphCount) return null;
      const metric = hmtx! + Math.min(glyph, metricCount - 1) * 4;
      const step = u16(metric) * size / upm;
      const lo = longLoca ? u32(loca! + glyph * 4) : u16(loca! + glyph * 2) * 2;
      const hi = longLoca ? u32(loca! + (glyph + 1) * 4) : u16(loca! + (glyph + 1) * 2) * 2;
      if (lo < hi) {
        const glyphOffset = glyf! + lo;
        if (glyphOffset + 10 > bytes.byteLength || hi > tables.get(0x676c7966)!.length) return null;
        const left = advance + i16(glyphOffset + 2) * size / upm;
        if (Number.isNaN(inkLeft)) inkLeft = left;
        inkRight = advance + i16(glyphOffset + 6) * size / upm;
      }
      advance += step;
    }
    if (Number.isNaN(inkLeft)) return { advance, inkLeft: 0, inkRight: advance };
    return { advance, inkLeft, inkRight };
  } catch { return null; }
}
