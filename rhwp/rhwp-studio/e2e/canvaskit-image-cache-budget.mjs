import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  closeBrowser,
  closePage,
  createPage,
  launchBrowser,
  loadApp,
  loadHwpFile,
} from './helpers.mjs';

const IMAGE_EDGE = 2048;
const IMAGE_PIXELS = IMAGE_EDGE * IMAGE_EDGE;
const IMAGE_COUNT = 5;
const MAX_CACHE_PIXELS = 16 * 1024 * 1024;

function outputPath() {
  const arg = process.argv.find((value) => value.startsWith('--output='));
  return arg?.slice('--output='.length) ?? '';
}

const browser = await launchBrowser();
const page = await createPage(browser, 1280, 900);
try {
  await loadApp(page, '?renderer=canvaskit&canvaskitSurface=software');
  await loadHwpFile(page, 'pic-crop-01.hwp');
  const result = await page.evaluate(async ({ imageCount, imageEdge }) => {
    const renderer = window.__rendererSession?.getCanvasKitRenderer?.();
    if (!renderer || window.__canvasView?.getRenderBackend?.() !== 'canvaskit') {
      throw new Error('CanvasKit software renderer unavailable');
    }
    renderer.resetDocumentResources();
    const target = document.createElement('canvas');
    target.width = 32;
    target.height = 32;

    for (let index = 0; index < imageCount; index++) {
      const source = document.createElement('canvas');
      source.width = imageEdge;
      source.height = imageEdge;
      const context = source.getContext('2d');
      if (!context) throw new Error('2D image fixture context unavailable');
      context.fillStyle = `rgb(${index + 1}, 0, 0)`;
      context.fillRect(index, index, 1, 1);
      const base64 = source.toDataURL('image/png').split(',', 2)[1];
      renderer.renderPage(
        {
          pageWidth: 32,
          pageHeight: 32,
          root: {
            kind: 'leaf',
            bounds: { x: 0, y: 0, width: 32, height: 32 },
            ops: [{
              type: 'image',
              bbox: { x: 0, y: 0, width: 32, height: 32 },
              mime: 'image/png',
              base64,
              imageRef: index,
            }],
          },
        },
        target,
        1,
      );
    }
    return renderer.diagnostics();
  }, { imageCount: IMAGE_COUNT, imageEdge: IMAGE_EDGE });

  assert.equal(result.surfaceBackend, 'software');
  assert.equal(result.imageCacheMisses, IMAGE_COUNT);
  assert.ok(result.imageCacheEvictions >= 1);
  assert.ok(result.imageCachePixels <= MAX_CACHE_PIXELS || result.imageCacheEntries === 1);
  assert.equal(result.imageCachePixels, MAX_CACHE_PIXELS);

  const report = {
    fixtureImages: IMAGE_COUNT,
    pixelsPerImage: IMAGE_PIXELS,
    decodedInputPixels: IMAGE_COUNT * IMAGE_PIXELS,
    ...result,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  console.log(serialized);
  const output = outputPath();
  if (output) {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, serialized);
  }
} finally {
  await closePage(page);
  await closeBrowser(browser);
}
