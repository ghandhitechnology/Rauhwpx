import { importedFontSlant, importedFontWeight, type LocalFontRecord } from '../core/local-fonts.ts';

function normalizedName(value: string): string {
  return value.replace(/\u0000/g, '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

export function physicalFontStyle(record: LocalFontRecord): { weight: number; bold: boolean; italic: boolean } {
  const style = record.style.trim();
  const weight = Number(importedFontWeight(style));
  return {
    weight,
    bold: weight >= 600,
    italic: importedFontSlant(style) === 'italic',
  };
}

/** Keep the nearest regular and bold weight for each physical slant. */
export function preferredFamilyStyleFaces(records: readonly LocalFontRecord[]): LocalFontRecord[] {
  const preferred = new Map<string, { record: LocalFontRecord; distance: number }>();
  for (const record of records) {
    const physical = physicalFontStyle(record);
    const key = `${physical.bold}:${physical.italic}`;
    const distance = Math.abs(physical.weight - (physical.bold ? 700 : 400));
    const current = preferred.get(key);
    if (!current || distance < current.distance) preferred.set(key, { record, distance });
  }
  return Array.from(preferred.values(), value => value.record);
}

function namesSpecificFace(requestedName: string, record: LocalFontRecord): boolean {
  const requested = normalizedName(requestedName);
  const family = normalizedName(record.family);
  return requested !== family && [
    record.fullName,
    record.postscriptName,
    `${record.family} ${record.style}`,
  ].some(name => normalizedName(name) === requested);
}

/** Select a loaded physical face before asking Skia to synthesize missing styles. */
export function selectPreparedFontFace(
  requestedName: string,
  resolved: LocalFontRecord,
  loadedFamilyFaces: readonly LocalFontRecord[],
  bold: boolean,
  italic: boolean,
): { record: LocalFontRecord; syntheticBold: boolean; syntheticItalic: boolean } {
  const family = normalizedName(resolved.family);
  const candidates = namesSpecificFace(requestedName, resolved)
    ? [resolved]
    : loadedFamilyFaces.filter(record => normalizedName(record.family) === family);
  const penalty = (record: LocalFontRecord): number => {
    const physical = physicalFontStyle(record);
    const weightPenalty = physical.bold && !bold
      ? 1000 + Math.abs(physical.weight - 400)
      : bold && !physical.bold
        ? 300 + Math.abs(physical.weight - 400)
        : Math.abs(physical.weight - (bold ? 700 : 400));
    const slantPenalty = physical.italic === italic ? 0 : physical.italic ? 1000 : 300;
    return weightPenalty + slantPenalty;
  };
  const available = candidates.length ? candidates : [resolved];
  const record = available.reduce(
    (best, next) => penalty(next) < penalty(best) ? next : best,
    available[0],
  );
  const physical = physicalFontStyle(record);
  return {
    record,
    syntheticBold: bold && !physical.bold,
    syntheticItalic: italic && !physical.italic,
  };
}
