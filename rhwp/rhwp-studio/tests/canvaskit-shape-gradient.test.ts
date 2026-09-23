import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { createTestModuleServer } from './support/module-server.ts';

test('CanvasKit paints shape gradients without inventing strokes for paintless shapes', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const vite = await createTestModuleServer(root);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const kit = await CanvasKitInit({
      locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)),
    });
    const surface = kit.MakeSurface(96, 80);
    assert.ok(surface);
    try {
      const canvas = surface.getCanvas();
      canvas.clear(kit.Color(255, 255, 255, 1));
      const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
      const gradient = {
        gradientType: 4,
        angle: 0,
        centerX: 50,
        centerY: 50,
        colors: ['#ff0000', '#0000ff'],
        positions: [0, 1],
      };
      const style = { fillColor: null, strokeColor: null, strokeWidth: 0, opacity: 1 };
      const pathAt = (x: number, y: number) => ({
        type: 'path',
        bbox: { x, y, width: 32, height: 32 },
        commands: [
          { type: 'moveTo', x, y },
          { type: 'lineTo', x: x + 32, y },
          { type: 'lineTo', x: x + 32, y: y + 32 },
          { type: 'lineTo', x, y: y + 32 },
          { type: 'closePath' },
        ],
        style,
      });
      renderer.renderPath(canvas, { ...pathAt(8, 8), gradient });
      renderer.renderRectangle(canvas, {
        type: 'rectangle', bbox: { x: 48, y: 8, width: 32, height: 32 }, style, gradient,
      });
      renderer.renderPath(canvas, pathAt(8, 48));
      renderer.renderRectangle(canvas, {
        type: 'rectangle', bbox: { x: 48, y: 48, width: 32, height: 24 }, style,
      });
      surface.flush();
      const rgba = canvas.readPixels(0, 0, {
        width: 96, height: 80,
        colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Unpremul,
        colorSpace: kit.ColorSpace.SRGB,
      });
      assert.ok(rgba);
      const pixel = (x: number, y: number) => [...rgba.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4)];
      assert.ok(pixel(24, 24)[0] > 180 && pixel(24, 24)[2] < 80, 'path gradient center is red');
      assert.ok(pixel(9, 9)[2] > 180 && pixel(9, 9)[0] < 80, 'path gradient edge is blue');
      assert.ok(pixel(64, 24)[0] > 180 && pixel(64, 24)[2] < 80, 'rectangle gradient is painted');
      assert.deepEqual(pixel(8, 48), [255, 255, 255, 255], 'paintless path has no outline');
      assert.deepEqual(pixel(48, 48), [255, 255, 255, 255], 'paintless rectangle has no outline');
    } finally {
      surface.delete();
    }
  } finally {
    await vite.close();
  }
});
