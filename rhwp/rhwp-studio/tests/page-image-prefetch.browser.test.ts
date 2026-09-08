import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('page invalidation and fallback release prefetch work without stale repaints', { timeout: 30_000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  });
  server.middlewares.use('/prefetch-test', (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Image prefetch test</title>');
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/prefetch-test`);
    const result = await page.evaluate(async () => {
      const prefetchModule = '/src/view/image-prefetch.ts';
      const { ImagePrefetcher } = await import(prefetchModule);
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
      // Exercise native decode and event settlement before substituting stalled decoders.
      await new ImagePrefetcher().prefetch([`data:image/png;base64,${png}`], new AbortController().signal);

      const rendererModule = '/src/view/page-renderer.ts';
      const { PageRenderer } = await import(rendererModule);
      const images: Array<{ src: string; onload: (() => void) | null; onerror: (() => void) | null }> = [];
      const NativeImage = window.Image;
      window.Image = class {
        src = '';
        onload = null;
        onerror = null;
        constructor() { images.push(this); }
        decode() { return new Promise(() => {}); }
        removeAttribute() { this.src = ''; }
      } as unknown as typeof Image;
      let reads = 0;
      let repaints = 0;
      const renderer = new PageRenderer({ getPageLayerTree() {
        reads += 1;
        return JSON.stringify({ root: { kind: 'leaf', ops: Array.from({ length: 20 }, (_, index) => ({
          type: 'image', mime: 'image/png', base64: png + ' '.repeat(index),
        })) } });
      } });
      renderer.reRenderPageCanvases = () => { repaints += 1; };
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const schedule = (revision: number) => renderer.scheduleReRender(0, canvas, 1, 20, 0, {
        retrySignature: String(revision), reuseStaticFlow: false, reuseStaticOverlay: false,
      });
      try {
        for (let revision = 0; revision < 100; revision++) {
          schedule(revision);
          renderer.invalidateDocumentRevision();
        }
        await Promise.resolve();
        const cancelledBeforeStart = { reads, decoders: images.length };

        schedule(100);
        await Promise.resolve();
        const activeDecoders = images.length;
        const lateOnLoad = images[0].onload!;
        renderer.invalidateDocumentRevision();
        lateOnLoad();
        await Promise.resolve();
        const cancelledAfterStart = { repaints, retained: images.filter(image => image.src).length };

        schedule(101);
        await new Promise(resolve => setTimeout(resolve, 1600));
        const fallback = { repaints, retained: images.filter(image => image.src).length, decoders: images.length };
        schedule(102);
        await Promise.resolve();
        renderer.dispose();
        return {
          cancelledBeforeStart, activeDecoders, cancelledAfterStart, fallback,
          retainedAfterDispose: images.filter(image => image.src).length,
        };
      } finally {
        renderer.dispose();
        window.Image = NativeImage;
      }
    });
    assert.deepEqual(result.cancelledBeforeStart, { reads: 0, decoders: 0 });
    assert.equal(result.activeDecoders, 4);
    assert.deepEqual(result.cancelledAfterStart, { repaints: 0, retained: 0 });
    assert.deepEqual(result.fallback, { repaints: 1, retained: 0, decoders: 8 });
    assert.equal(result.retainedAfterDispose, 0);
  } finally {
    await browser?.close();
    await server.close();
  }
});
