import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { startStudioServer } from '../document-runtime/studio-harness.mjs';
import { verifyDocumentShell } from '../document-runtime/document-shell.mjs';

test('published Studio assets render only the document and reject the old stacked layout', {
  skip: process.env.RAUHWpx_DOCUMENT_SHELL_PROOF !== '1'
    ? 'set RAUHWpx_DOCUMENT_SHELL_PROOF=1 with built Studio assets and Chromium' : false,
  timeout: 90_000,
}, async (t) => {
  const { default: puppeteer } = await import('puppeteer-core');
  const studioRoot = process.env.RAUHWpx_STUDIO_DIST || '/app/studio';
  const { server, origin } = await startStudioServer({ studioRoot, resources: new Map(), bootstrap: 'proof' });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${origin}/document.html`, { waitUntil: 'networkidle2' });
  await (await page.$('#file-input')).uploadFile(path.join(studioRoot, 'samples/field-01.hwp'));
  await page.waitForFunction(() => document.querySelector('#scroll-content canvas'), { timeout: 60_000 });

  for (const width of [1280, 640]) {
    await page.setViewport({ width, height: 900 });
    assert.deepEqual(await verifyDocumentShell(page), { installed: true, fillsWindow: true, chrome: [] });
  }
  await page.$eval('#scroll-container', (element) => { element.scrollTop = 300; });
  assert.equal(await page.$eval('#scroll-container', (element) => element.scrollTop), 300);

  // Simulate an image that still serves the pre-fix shell. The worker must not
  // advertise that display as ready just because the document itself loaded.
  await page.setViewport({ width: 1280, height: 900 });
  await page.$eval('#cloud-document-shell', (element) => { element.textContent = ''; });
  await assert.rejects(verifyDocumentShell(page), { code: 'STUDIO_DOCUMENT_LAYOUT_INVALID' });
});
