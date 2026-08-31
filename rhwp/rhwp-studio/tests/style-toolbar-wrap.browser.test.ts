import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

test('narrow formatting ribbon stacks groups without overlap or clipping', { timeout: 30_000 }, async (context) => {
  const executablePath = BROWSER_CANDIDATES.find(existsSync);
  if (!executablePath) {
    context.skip('Chrome or Chromium is unavailable');
    return;
  }

  const root = new URL('../', import.meta.url).pathname;
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700 });
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#style-bar');

    const layout = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('#style-bar')!;
      const groups = [...bar.querySelectorAll<HTMLElement>(':scope > .sb-ribbon-group, :scope > .sb-command-band')]
        .filter((element) => getComputedStyle(element).display !== 'none')
        .map((element) => element.getBoundingClientRect());
      const overlaps = groups.some((first, index) => groups.slice(index + 1).some((second) => (
        first.left < second.right
        && first.right > second.left
        && first.top < second.bottom
        && first.bottom > second.top
      )));
      return {
        clientHeight: bar.clientHeight,
        scrollHeight: bar.scrollHeight,
        overlaps,
        rows: new Set(groups.map((rect) => Math.round(rect.top))).size,
      };
    });

    assert.equal(layout.overlaps, false);
    assert.equal(layout.clientHeight, layout.scrollHeight, 'all wrapped rows should remain visible');
    assert.ok(layout.rows >= 2, 'constrained formatting groups should occupy multiple rows');
  } finally {
    await browser?.close();
    await server.close();
  }
});
