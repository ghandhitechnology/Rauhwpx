import type { LocalFontRecord } from './local-fonts';
import { sfntCoversText, sfntEmToCellRatio, sfntTrueTypeRunMetrics } from './sfnt-cmap.ts';

const DEFAULT_FAMILIES = ['Latin Modern Math', 'STIX Two Text', 'STIX Two Math', 'Times New Roman', 'Times', 'serif'];
const LEGACY_FAMILIES = ['Times New Roman', 'Times', 'STIX Two Text', 'Latin Modern Math', 'STIX Two Math', 'serif'];

/** renderer/equation/font.rs와 같은 수식 표시 fallback. 원본 서체는 변경하지 않는다. */
export function equationFontFamilies(fontName?: string): string[] {
  const requested = fontName?.trim();
  const fallbacks = requested?.toLowerCase() === 'hyhwpeq' ? LEGACY_FAMILIES : DEFAULT_FAMILIES;
  return [...new Set([...(requested ? [requested] : []), ...fallbacks])];
}

/** 합성 기울임/굵기보다 감지된 해당 style의 실제 face를 우선한다. */
export function equationLocalFontFace(
  records: readonly LocalFontRecord[],
  family: string,
  italic: boolean,
  bold: boolean,
): LocalFontRecord | undefined {
  return records.find(record => (
    record.family.toLowerCase() === family.toLowerCase()
    && /italic|oblique/i.test(record.style) === italic
    && /bold|black|heavy/i.test(record.style) === bold
  ));
}

export function isLegacyEquationFont(name?: string): boolean {
  return name?.trim().toLowerCase() === 'hyhwpeq';
}

/** renderer/equation/font.rs의 HYhwpEQ cmap. 로드된 해당 서체에만 사용한다. */
export function legacyEquationGlyph(character: string, italic: boolean): [string, boolean] {
  const code = character.codePointAt(0)!;
  if (character >= 'A' && character <= 'Z') return [String.fromCodePoint(0xe000 + code - 65), italic];
  if (character >= 'a' && character <= 'z') return [String.fromCodePoint((italic ? 0xe0e5 : 0xe01a) + code - 97), false];
  if (character >= '1' && character <= '9') return [String.fromCodePoint(0xe034 + code - 49), false];
  if (character === '0') return ['\ue03d', false];
  const greek = [...'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω'].indexOf(character);
  if (italic && greek >= 0) return [String.fromCodePoint(0xe085 + greek), false];
  const symbols: Record<string, number> = {
    '!': 0xe03e, '@': 0xe03f, '#': 0xe040, '$': 0xe041, '%': 0xe042, '*': 0xe043,
    '(': 0xe044, ')': 0xe045, '-': 0xe046, '−': 0xe046, '=': 0xe047, '+': 0xe048,
    '[': 0xe049, ']': 0xe04a, '{': 0xe04b, '}': 0xe04c, '|': 0xe04d, ';': 0xe04e,
    ':': 0xe04f, ',': 0xe052, '.': 0xe053, '/': 0xe054, '<': 0xe055, '>': 0xe056, '?': 0xe057,
  };
  return symbols[character] ? [String.fromCodePoint(symbols[character]), false] : [character, italic];
}

export function legacyEquationRuns(text: string, italic: boolean): Array<{ text: string; italic: boolean }> {
  const runs: Array<{ text: string; italic: boolean }> = [];
  for (const character of text) {
    const [glyph, skew] = legacyEquationGlyph(character, italic);
    const last = runs.at(-1);
    if (last?.italic === skew) last.text += glyph;
    else runs.push({ text: glyph, italic: skew });
  }
  return runs;
}

/** 세션 FontFace.load 완료와 cmap coverage가 모두 확인되어야 PUA를 허용한다. */
export function createEquationFontResolver(
  resolveFont: (name: string) => LocalFontRecord | null,
  readBytes: (name: string) => ArrayBuffer | null,
): (source: string, glyphs: string) => string | null {
  const bytesByRecord = new WeakMap<LocalFontRecord, ArrayBuffer | null>();
  return (source, glyphs) => {
    const hft = /^(HSUSR|HSUSRI|HSUSFL|HSUSSP)$/i.test(source);
    if (!isLegacyEquationFont(source) && !hft) return null;
    const record = resolveFont(source);
    if (!record?.runtimeFamily || record.family.toLowerCase() !== source.toLowerCase()) return null;
    if (!bytesByRecord.has(record)) bytesByRecord.set(record, readBytes(source));
    const bytes = bytesByRecord.get(record);
    return bytes && sfntCoversText(bytes, glyphs) ? record.runtimeFamily : null;
  };
}

/** HSUSFL은 italic Greek bank이므로 roman wrapper에서는 Unicode fallback을 쓴다. */
export function equationHftBanks(italic: boolean): readonly string[] {
  return italic ? ['HSUSRI', 'HSUSFL', 'HSUSSP'] : ['HSUSR', 'HSUSSP'];
}

export interface EquationLiteralFont { family: string; emScale: number }

/** 구형 EQEDIT의 Unicode literal은 수식 bank가 아닌 일반 serif cell-height 글꼴이다. */
export function createEquationLiteralFontResolver(
  resolveFont: (name: string) => LocalFontRecord | null,
  readBytes: (name: string) => ArrayBuffer | null,
): (text: string) => EquationLiteralFont | null {
  const cache = new WeakMap<LocalFontRecord, { bytes: ArrayBuffer; scale: number } | null>();
  return text => {
    for (const source of ['HCR Batang', 'Batang', 'Times New Roman']) {
      const record = resolveFont(source);
      if (!record?.runtimeFamily) continue;
      if (!cache.has(record)) {
        const bytes = readBytes(source);
        const scale = bytes && sfntEmToCellRatio(bytes);
        cache.set(record, bytes && scale ? { bytes, scale } : null);
      }
      const metrics = cache.get(record);
      if (metrics && sfntCoversText(metrics.bytes, text)) return { family: record.runtimeFamily, emScale: metrics.scale };
    }
    return null;
  };
}

/** 수식 배치와 paint가 같은 run의 advance와 잉크 경계를 사용한다. */
export function createEquationTextMeasurer(
  resolveFont: (name: string) => LocalFontRecord | null,
  readBytes: (name: string) => ArrayBuffer | null,
): (source: string, text: string, size: number, italic: boolean, hft: boolean, literal: boolean, bold?: boolean) => { advance: number; inkLeft: number; inkRight: number } | null {
  const exact = createEquationFontResolver(resolveFont, readBytes);
  const unicode = createEquationLiteralFontResolver(resolveFont, readBytes);
  let context: CanvasRenderingContext2D | null = null;
  return (source, text, size, italic, hft, literal, bold = false) => {
    if (!Number.isFinite(size) || size <= 0 || !text) return null;
    if (isLegacyEquationFont(source) && !hft) {
      const glyphs = [...text].map(character => legacyEquationGlyph(character, italic)[0]).join('');
      if (exact(source, glyphs)) {
        const bytes = readBytes(source);
        const metrics = bytes && sfntTrueTypeRunMetrics(bytes, glyphs, size);
        if (metrics) return metrics;
      }
    }
    if (!context) context = globalThis.document?.createElement('canvas').getContext('2d') ?? null;
    if (!context) return null;
    const runs: Array<{ text: string; font: string }> = [];
    // HFT literal은 painter가 한 글자씩 그린다. 다른 경로는 같은 서체 run을 합쳐 커닝한다.
    const splitLiteral = hft && literal && /[^\x00-\x7f]/u.test(text);
    for (const character of text) {
      let family: string | null = null; let glyph = character; let skew = italic; let em = size;
      if (hft && isLegacyEquationFont(source)) {
        if (literal && /[^\x00-\x7f]/u.test(character)) {
          const resolved = unicode(character);
          if (!resolved) return null;
          family = resolved.family; em *= resolved.emScale; skew = false;
        } else {
          const banks = equationHftBanks(italic);
          family = banks.map(bank => exact(bank, character)).find(Boolean) ?? null; skew = false;
        }
      } else if (isLegacyEquationFont(source)) {
        [glyph, skew] = legacyEquationGlyph(character, italic);
        family = exact(source, glyph);
      } else {
        family = resolveFont(source)?.runtimeFamily ?? null;
      }
      if (!family) return null;
      const font = `${skew ? 'italic ' : ''}${bold ? 'bold ' : ''}${em.toFixed(3)}px ${JSON.stringify(family)}`;
      const last = runs.at(-1);
      if (!splitLiteral && last?.font === font) last.text += glyph;
      else runs.push({ text: glyph, font });
    }
    let advance = 0;
    let inkLeft = Number.NaN;
    let inkRight = 0;
    for (const run of runs) {
      context.font = run.font;
      const metrics = context.measureText(run.text);
      if (!Number.isFinite(metrics.width) || !Number.isFinite(metrics.actualBoundingBoxLeft)
          || !Number.isFinite(metrics.actualBoundingBoxRight)) return null;
      const left = advance - metrics.actualBoundingBoxLeft;
      if (Number.isNaN(inkLeft)) inkLeft = left;
      inkRight = Math.max(inkRight, advance + metrics.actualBoundingBoxRight);
      advance += metrics.width;
    }
    return { advance, inkLeft: Number.isNaN(inkLeft) ? 0 : inkLeft, inkRight };
  };
}
