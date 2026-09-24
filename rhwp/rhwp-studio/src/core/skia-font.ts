import type { CanvasKit, Font, Typeface } from 'canvaskit-wasm';

/** 페이지 좌표의 원본 outline을 확대율/픽셀 격자에 따른 변형 없이 그린다. */
export function createOutlineSkiaFont(
  kit: Pick<CanvasKit, 'Font' | 'FontEdging' | 'FontHinting'>,
  face: Typeface | null,
  size: number,
): Font {
  const font = new kit.Font(face, Math.max(1, size));
  font.setEdging(kit.FontEdging.AntiAlias);
  font.setHinting(kit.FontHinting.None);
  font.setEmbeddedBitmaps(false);
  font.setLinearMetrics(true);
  font.setSubpixel(true);
  return font;
}
