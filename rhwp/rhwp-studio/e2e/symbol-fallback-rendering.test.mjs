/**
 * A saved Malgun Gothic middle dot keeps its 4.187 px document advance even
 * when the browser substitutes a wider face. The painted dot must stay round.
 *
 * Run with a local Vite server and a fresh headless browser:
 * VITE_URL=http://127.0.0.1:7741 CHROME_PATH=/path/to/chrome \
 *   node e2e/symbol-fallback-rendering.test.mjs --mode=headless
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, createPage, closeBrowser, loadApp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = fs.readFileSync(path.resolve(here, '../../samples/rendering-fidelity/symbol-fallback-advance.hwpx'));
const browser = await launchBrowser();

try {
  const page = await createPage(browser, 1440, 1000);
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
  await loadApp(page);
  // Pin the same bundled substitute on hosts that have Malgun Gothic installed.
  await page.evaluate(async () => {
    const face = new FontFace('맑은 고딕', 'url(/fonts/Pretendard-Regular.woff2)');
    await face.load();
    document.fonts.add(face);
  });

  const result = await page.evaluate(async bytes => {
    const requestId = 'symbol-fallback-rendering';
    const opened = new Promise((resolve, reject) => {
      const off = window.__eventBus.on('open-document-bytes:done', response => {
        if (response.requestId !== requestId) return;
        off();
        response.ok ? resolve() : reject(new Error(response.error));
      });
    });
    window.__eventBus.emit('open-document-bytes', {
      bytes: new Uint8Array(bytes), fileName: 'symbol-fallback-advance.hwpx',
      requestId, suppressDialogs: true, skipUnsavedGuard: true,
    });
    await opened;
    await document.fonts.ready;

    const tree = window.__wasm.getPageLayerTreeObject(0);
    const runs = [];
    const collect = node => {
      for (const op of node.ops ?? []) {
        if (op.type === 'textRun' && op.text.includes('∙')) runs.push(op);
      }
      for (const child of node.children ?? []) collect(child);
    };
    collect(tree.root);
    if (runs.length !== 1) throw new Error(`expected one middle-dot run, got ${runs.length}`);
    const run = runs[0];
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `${run.style.fontSize}px "${run.style.fontFamily}"`;
    const fallbackAdvance = probe.measureText('∙').width;

    // Use the production WASM Canvas2D renderer at native 8x resolution.
    const scale = 8;
    const canvas = document.createElement('canvas');
    window.__wasm.renderPageToCanvas(0, canvas, scale);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const left = Math.floor((run.bbox.x - 4) * scale);
    const top = Math.floor((run.bbox.y - 2) * scale);
    const width = Math.ceil((run.bbox.width + 8) * scale);
    const height = Math.ceil((run.bbox.height + 4) * scale);
    const pixels = context.getImageData(left, top, width, height).data;
    let minX = width; let maxX = -1; let minY = height; let maxY = -1;
    let inkPixels = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        if (pixels[offset + 3] < 128
          || pixels[offset] >= 140 || pixels[offset + 1] >= 140 || pixels[offset + 2] >= 140) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        inkPixels++;
      }
    }
    return {
      backend: window.__canvasView.getRenderBackend(),
      text: run.text,
      fontFamily: run.style.fontFamily,
      fallbackAdvance,
      advance: run.positions?.[1] - run.positions?.[0],
      bbox: run.bbox,
      ink: { width: maxX - minX + 1, height: maxY - minY + 1, pixels: inkPixels },
    };
  }, Array.from(sample));

  assert.equal(result.backend, 'canvas2d');
  assert.equal(result.text, '∙');
  assert.equal(result.fontFamily, '맑은 고딕');
  assert.ok(Math.abs(result.advance - 4.187) < 0.02, `saved dot advance: ${result.advance}`);
  assert.ok(result.fallbackAdvance > result.advance * 2,
    `test must exercise a wider fallback glyph: ${JSON.stringify(result)}`);
  assert.ok(result.ink.pixels >= 8, `missing painted dot: ${JSON.stringify(result.ink)}`);
  const aspect = result.ink.height / result.ink.width;
  assert.ok(aspect >= 1 / 1.35 && aspect <= 1.35,
    `middle dot is stretched: ${JSON.stringify({ ...result, aspect })}`);
  console.log(JSON.stringify({ advance: result.advance, ink: result.ink, aspect }));
} finally {
  await closeBrowser(browser);
}
