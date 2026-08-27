const HWPUNIT_PER_MM = 7200 / 25.4;

export function hwpunitToMm(hu: number): number {
  return Math.round(hu * 25.4 / 7200 * 10) / 10;
}

export function mmToHwpunit(mm: number): number {
  return Math.round(mm * HWPUNIT_PER_MM);
}

export function hwp16ToMm(hu: number): number {
  return Math.round(hu * 25.4 / 7200 * 10) / 10;
}

export function mmToHwp16(mm: number): number {
  return Math.round(mm * HWPUNIT_PER_MM);
}

export function readHwpunitInput(input: { value: string }, original?: number): number {
  if (original != null && input.value === hwpunitToMm(original).toFixed(1)) return original;
  return mmToHwpunit(parseFloat(input.value) || 0);
}

export function readHwp16Input(input: { value: string }, original?: number): number {
  if (original != null && input.value === hwp16ToMm(original).toFixed(1)) return original;
  return mmToHwp16(parseFloat(input.value) || 0);
}
