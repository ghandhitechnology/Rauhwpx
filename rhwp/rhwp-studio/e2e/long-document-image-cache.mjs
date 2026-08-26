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

const SAMPLE = '2025 행정업무운영 편람(최종).hwpx';
const MAX_DECODED_PIXELS = 16_777_216;

function outputPath() {
  const arg = process.argv.find((value) => value.startsWith('--output='));
  return arg?.slice('--output='.length) ?? '';
}

const browser = await launchBrowser();
const page = await createPage(browser, 1280, 900);
try {
  await loadApp(page, '?renderer=canvas2d');
  const loaded = await loadHwpFile(page, SAMPLE);
  const result = await page.evaluate(async (pageCount) => {
    const container = document.querySelector('#scroll-container');
    const virtualScroll = window.__canvasView?.getVirtualScroll?.();
    if (!(container instanceof HTMLElement) || !virtualScroll) {
      throw new Error('long-document viewport is unavailable');
    }

    const startedAt = performance.now();
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      container.scrollTop = virtualScroll.getPageOffset(pageIndex);
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const stats = window.__wasm.getWebCanvasImageCacheStats();
    const activeCanvases = [...container.querySelectorAll('canvas')]
      .filter((canvas) => canvas.width > 0 && canvas.height > 0)
      .length;
    return {
      pageCount,
      scrollAndRenderMs: performance.now() - startedAt,
      activeCanvases,
      stats,
    };
  }, loaded.pageCount);

  assert.equal(result.pageCount, 390);
  assert.ok(result.activeCanvases > 0);
  assert.ok(
    result.stats.decodedCanvasPixels <= MAX_DECODED_PIXELS
      || result.stats.decodedCanvasEntries === 1,
    `decoded image cache exceeds budget: ${JSON.stringify(result.stats)}`,
  );
  const report = {
    sample: SAMPLE,
    documentLoadAndInitialRenderMs: loaded.documentLoadAndInitialRenderMs,
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
