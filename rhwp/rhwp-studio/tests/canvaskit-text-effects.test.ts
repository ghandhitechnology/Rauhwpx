import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { createTestModuleServer } from './support/module-server.ts';

test('CanvasKit scales glyph ink without scaling saved positions and paints offset shadows', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const face = kit.Typeface.MakeFreeTypeFaceFromData(fs.readFileSync(new URL('../../assets/fonts/NotoSansKR-Regular.woff2', import.meta.url)));
  const surface = kit.MakeSurface(100, 70);
  assert.ok(face && surface);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, face, null);
    const canvas = surface.getCanvas();
    const op = { type: 'textRun', text: 'HH', bbox: { x: 10, y: 10, width: 60, height: 32 }, baseline: 32, positions: [0, 30, 60], style: { fontSize: 32, color: '#000000' } };
    const render = (style: object, overrides: object = {}) => {
      canvas.clear(kit.WHITE);
      renderer.renderTextRun(canvas, { ...op, ...overrides, style: { ...op.style, ...style } });
      const pixels = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(pixels);
      return pixels;
    };
    const bounds = (pixels: Uint8Array | Float32Array, left: number, right: number) => {
      const xs: number[] = [];
      for (let y = 0; y < 70; y++) for (let x = left; x < right; x++) {
        const at = (y * 100 + x) * 4;
        if (pixels[at] < 100 && pixels[at + 1] < 100) xs.push(x);
      }
      assert.ok(xs.length);
      return { left: Math.min(...xs), width: Math.max(...xs) - Math.min(...xs) + 1 };
    };
    const plain = render({ ratio: 1 });
    const narrow = render({ ratio: 0.5 });
    assert.ok(bounds(narrow, 10, 40).width < bounds(plain, 10, 40).width * 0.7);
    assert.equal(bounds(narrow, 40, 70).left - bounds(narrow, 10, 40).left, 30, 'saved glyph origins remain unchanged');
    const shadow = render({ ratio: 0.5, shadowType: 1, shadowColor: '#ff0000', shadowOffsetX: 3, shadowOffsetY: 2 });
    let red = 0;
    for (let at = 0; at < shadow.length; at += 4) if (shadow[at] > shadow[at + 1] + 60) red++;
    assert.ok(red > 20, 'colored shadow is drawn beneath original text');
    assert.deepEqual(render({ ratio: 0.5 }), narrow, 'shadow translation and paint do not leak');
    assert.ok(!renderer.unsupportedOps.has('textRun:ratioTextEffect'));
    assert.ok(!renderer.unsupportedOps.has('textRun:shadowTextEffect'));
    const boxed = { text: String.fromCodePoint(0xF02B1, 0xF02B2) };
    const boxedPlain = render({ ratio: 1 }, boxed);
    const boxedNarrow = render({ ratio: 0.5 }, boxed);
    assert.ok(bounds(boxedNarrow, 8, 38).width < bounds(boxedPlain, 8, 38).width * 0.7,
      'boxed fallback scales both enclosure and numeral');
    assert.equal(bounds(boxedNarrow, 38, 68).left - bounds(boxedNarrow, 8, 38).left, 30);
    render({ ratio: 0.5, shadowType: 1 }, { charOverlap: { borderType: 0, innerCharSize: 0 } });
    assert.ok(renderer.unsupportedOps.has('textRun:ratioTextEffect'));
    assert.ok(renderer.unsupportedOps.has('textRun:shadowTextEffect'));
  } finally { surface.delete(); face.delete(); await vite.close(); }
});
