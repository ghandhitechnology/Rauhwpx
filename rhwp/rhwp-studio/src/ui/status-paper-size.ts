import { HWPUNIT_PER_MM } from '@/core/hwp-constants';
import type { PageDef } from '@/core/types';

const PAPER_SIZES = [
  ['A3', 297, 420],
  ['A4', 210, 297],
  ['A5', 148, 210],
  ['B4', 257, 364],
  ['B5', 182, 257],
  ['Letter', 215.9, 279.4],
  ['Legal', 215.9, 355.6],
] as const;

export function describePaperSize(pageDef: PageDef): { label: string; title: string } {
  const width = pageDef.width / HWPUNIT_PER_MM;
  const height = pageDef.height / HWPUNIT_PER_MM;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const preset = PAPER_SIZES.find(([, w, h]) => Math.abs(short - w) < 1 && Math.abs(long - h) < 1)?.[0];
  const landscape = pageDef.landscape || width > height;
  const displayWidth = landscape ? long : short;
  const displayHeight = landscape ? short : long;
  const format = (value: number) => Number(value.toFixed(1)).toString();
  const dimensions = `${format(displayWidth)} × ${format(displayHeight)} mm`;
  return {
    label: preset ? `${preset}${landscape ? ' 가로' : ''}` : dimensions,
    title: preset ? `${preset} · ${dimensions}` : dimensions,
  };
}
