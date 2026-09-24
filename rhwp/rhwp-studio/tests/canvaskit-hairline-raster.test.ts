import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { createTestModuleServer } from './support/module-server.ts';

test('CanvasKit renders thin axis-aligned rules and square borders as one solid device pixel', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const vite = await createTestModuleServer(root);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const kit = await CanvasKitInit({
      locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)),
    });
    for (const scale of [1, 1.5, 2]) {
      const width = Math.ceil(72 * scale);
      const height = Math.ceil(48 * scale);
      const surface = kit.MakeSurface(width, height);
      assert.ok(surface);
      try {
        const canvas = surface.getCanvas();
        canvas.clear(kit.Color(255, 255, 255, 1));
        canvas.scale(scale, scale);
        const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
        renderer.currentRenderScale = scale;
        renderer.renderLine(canvas, {
          type: 'line', bbox: { x: 12.34, y: 4, width: 0.5, height: 22 },
          x1: 12.34, y1: 4, x2: 12.34, y2: 26,
          style: { color: '#000000', width: 0.5 },
        });
        renderer.renderLine(canvas, {
          type: 'line', bbox: { x: 4, y: 34.77, width: 22, height: 0.5 },
          x1: 4, y1: 34.77, x2: 26, y2: 34.77,
          style: { color: '#000000', width: 0.5 },
        });
        renderer.renderRectangle(canvas, {
          type: 'rectangle', bbox: { x: 42.22, y: 8.37, width: 17.73, height: 17.23 },
          style: { fillColor: '#ffffff', strokeColor: '#000000', strokeWidth: 0.5 },
        });
        renderer.currentRenderProfile = 'print';
        renderer.renderLine(canvas, {
          type: 'line', bbox: { x: 31.34, y: 4, width: 0.5, height: 22 },
          x1: 31.34, y1: 4, x2: 31.34, y2: 26,
          style: { color: '#000000', width: 0.5 },
        });
        renderer.currentRenderProfile = 'screen';
        surface.flush();
        const rgba = canvas.readPixels(0, 0, {
          width, height,
          colorType: kit.ColorType.RGBA_8888,
          alphaType: kit.AlphaType.Unpremul,
          colorSpace: kit.ColorSpace.SRGB,
        });
        assert.ok(rgba);
        const gray = (x: number, y: number) => rgba[(y * width + x) * 4];
        const verticalX = Math.round(12.34 * scale);
        const verticalY = Math.floor(15 * scale);
        assert.equal(gray(verticalX, verticalY), 0, `${scale}× vertical stroke`);
        assert.equal(gray(verticalX - 1, verticalY), 255);
        assert.equal(gray(verticalX + 1, verticalY), 255);
        const horizontalX = Math.floor(15 * scale);
        const horizontalY = Math.round(34.77 * scale);
        assert.equal(gray(horizontalX, horizontalY), 0, `${scale}× horizontal stroke`);
        assert.equal(gray(horizontalX, horizontalY - 1), 255);
        assert.equal(gray(horizontalX, horizontalY + 1), 255);
        const rectX = Math.round(42.22 * scale);
        const rectY = Math.floor(17 * scale);
        assert.equal(gray(rectX, rectY), 0, `${scale}× rectangle border`);
        assert.equal(gray(rectX - 1, rectY), 255);
        assert.equal(gray(rectX + 1, rectY), 255);
        assert.notEqual(gray(Math.round(31.34 * scale), verticalY), 0,
          `${scale}× print rule keeps its vector coverage`);
      } finally {
        surface.delete();
      }
    }
  } finally {
    await vite.close();
  }
});
