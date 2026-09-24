import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

test('CanvasKit omits discretionary hyphens without shifting positioned literal punctuation', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const vite = await createTestModuleServer(root);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    class FakeFont {
      constructor(_face: unknown, _size: number) {}
      setEdging() {}
      setHinting() {}
      setEmbeddedBitmaps() {}
      setLinearMetrics() {}
      setSubpixel() {}
      setEmbolden() {}
      setSkewX() {}
      getGlyphIDs(text: string) { return Array.from(text, ch => ch.codePointAt(0) ?? 0); }
      delete() {}
    }
    const kit = { Font: FakeFont, FontEdging: { AntiAlias: 1 }, FontHinting: { None: 0 } };
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, { face: 'default' });
    renderer.recordTextRunCoverageGaps = () => {};
    renderer.makeFillPaint = () => ({ setAntiAlias() {}, delete() {} });
    const drawn: Array<{ glyphs: number[]; positions: number[] } | { text: string }> = [];
    const canvas = {
      save() {}, restore() {},
      drawGlyphs(glyphs: Uint16Array, positions: Float32Array) {
        drawn.push({ glyphs: Array.from(glyphs), positions: Array.from(positions) });
      },
      drawText(text: string) { drawn.push({ text }); },
    };
    const op = {
      type: 'textRun',
      bbox: { x: 0, y: 0, width: 32, height: 18 },
      text: '\u00ad-A-',
      positions: [0, 0, 10, 18, 28],
      style: { fontSize: 16, color: '#000000' },
    };
    renderer.renderTextRun(canvas, op);
    assert.deepEqual(drawn, [{
      glyphs: [45, 65, 45],
      positions: [0, 0, 10, 0, 18, 0],
    }]);

    drawn.length = 0;
    renderer.renderTextRun(canvas, { ...op, positions: undefined });
    assert.deepEqual(drawn, [{ text: '-A-' }]);
  } finally {
    await vite.close();
  }
});
