import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm/bin/full/canvaskit.js';
import { createOutlineSkiaFont } from '../src/core/skia-font.ts';

test('outline font advances stay fractional and scale linearly through actual CanvasKit', async () => {
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/full/${file}`, import.meta.url)) });
  const face = kit.Typeface.MakeFreeTypeFaceFromData(fs.readFileSync(new URL('../../assets/fonts/NotoSansKR-Regular.woff2', import.meta.url)));
  assert.ok(face);
  const small = createOutlineSkiaFont(kit, face, 13.333333);
  const large = createOutlineSkiaFont(kit, face, 21.3333328);
  try {
    const ids = small.getGlyphIDs('xiL12');
    assert.ok([...ids].every(id => id !== 0));
    const a = small.getGlyphWidths(ids), b = large.getGlyphWidths(ids);
    assert.ok([...a].some(width => Math.abs(width - Math.round(width)) > 0.1), 'small equation advances must not snap to whole pixels');
    a.forEach((width, i) => assert.ok(Math.abs(b[i] - width * 1.6) < 1 / 256, 'zoom must preserve glyph centers'));
    const surface = kit.MakeSurface(64, 32);
    assert.ok(surface);
    const paint = new kit.Paint(); paint.setColor(kit.BLACK); paint.setAntiAlias(true);
    const pixels = (x: number) => {
      const canvas = surface.getCanvas(); canvas.clear(kit.WHITE); canvas.drawText('x', x, 22, paint, small);
      return canvas.readPixels(0, 0, { width: 64, height: 32, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    };
    try {
      const first = pixels(5), shifted = pixels(5.25);
      assert.ok(first && shifted);
      assert.ok([...first].some((value, index) => index % 4 === 0 && value > 0 && value < 255), 'outline edges must use grayscale antialiasing');
      assert.notDeepEqual(first, shifted, 'fractional glyph origins must retain their raster phase');
    }
    finally { paint.delete(); surface.delete(); }
    assert.equal(small.getScaleX(), 1);
    assert.equal(small.isEmbolden(), false);
  } finally { small.delete(); large.delete(); face.delete(); }
});
