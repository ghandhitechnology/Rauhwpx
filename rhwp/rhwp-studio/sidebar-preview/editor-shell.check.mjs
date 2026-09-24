import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserLaunchArgs } from '../tests/browser-support.ts';

const studio = resolve(import.meta.dirname, '..');
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(path => path && existsSync(path));
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');

const cacheDir = await mkdtemp(resolve(tmpdir(), 'rauhwpx-editor-shell-'));
const server = await createServer({
  cacheDir,
  configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false, hmr: false },
  logLevel: 'error',
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
  const baseline = await browser.newPage();
  await baseline.goto(origin, { waitUntil: 'networkidle0' });
  const baselineSidebarColors = await baseline.$eval('.ag-root', el => {
    const style = getComputedStyle(el);
    return [style.backgroundColor, style.color, style.borderLeftColor];
  });
  await baseline.close();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/?editor=1`, { waitUntil: 'networkidle0' });

  assert.equal(await page.$('.editor-document-bar'), null);
  assert.equal(await page.$eval('#preview-controls', el => el.hidden), true);
  assert(await page.$('#studio-header'));
  assert(await page.$('#status-bar'));
  assert(await page.$('.ag-root'));
  const editorSidebarColors = await page.$eval('.ag-root', el => {
    const style = getComputedStyle(el);
    return [style.backgroundColor, style.color, style.borderLeftColor];
  });
  assert.deepEqual(editorSidebarColors, baselineSidebarColors);

  const geometry = () => page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
    };
    return {
      header: box('#studio-header'), editor: box('#editor-area'),
      footer: box('#status-bar'), sidebar: box('.ag-root'),
    };
  });
  const initialGeometry = await geometry();

  for (let i = 0; i < 2; i++) {
    await page.focus('.menu-item[data-menu="file"] .menu-title');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.$eval('.menu-item[data-menu="file"]', el => el.classList.contains('open')), true);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-cmd')), 'file:new-doc');
    assert.deepEqual(await geometry(), initialGeometry);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('.menu-item[data-menu="file"]', el => el.classList.contains('open')), false);
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'menu-title');
  }

  for (let i = 0; i < 2; i++) {
    await page.click('#editor-command-search');
    assert(await page.$('.cp-overlay'));
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'cp-input');
    assert.deepEqual(await geometry(), initialGeometry);
    await page.keyboard.press('Escape');
    assert.equal(await page.$('.cp-overlay'), null);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'editor-command-search');
  }
  await page.keyboard.down('Control');
  await page.keyboard.press('/');
  await page.keyboard.up('Control');
  assert(await page.$('.cp-overlay'));
  assert.deepEqual(await geometry(), initialGeometry);
  await page.keyboard.press('Escape');

  await page.focus('#icon-toolbar .tb-btn[data-cmd="table:create"]');
  await page.setViewport({ width: 500, height: 960 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'editor-toolbar-more');
  await page.setViewport({ width: 1440, height: 960 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.focus('#icon-toolbar .tb-btn[data-cmd="edit:undo"]');
  await page.setViewport({ width: 900, height: 960 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-cmd')), 'edit:undo');

  for (const width of [1440, 900, 768, 500, 390]) {
    await page.setViewport({ width, height: 960 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px has horizontal document overflow`);
    assert(await page.$eval('#icon-toolbar', el => el.getBoundingClientRect().height <= 44), `${width}px toolbar wraps`);
    assert.equal(await page.$eval('#icon-toolbar', el => getComputedStyle(el).visibility), 'visible');
    if (width === 500) {
      assert.equal(await page.$eval('#editor-toolbar-more', el => el.hidden), false);
      assert(await page.$('#editor-toolbar-overflow .tb-group'));
      await page.focus('#editor-toolbar-more');
      await page.keyboard.press('Enter');
      assert.equal(await page.$eval('#editor-toolbar-overflow', el => el.hidden), false);
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#editor-toolbar-overflow .tb-btn[data-cmd]'))), true);
      await page.setViewport({ width: 390, height: 960 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.$eval('#editor-toolbar-overflow', el => el.hidden), false);
      const lowerPopoverHit = await page.evaluate(() => {
        const headerBottom = document.querySelector('#studio-header').getBoundingClientRect().bottom;
        const sidebarLeft = document.querySelector('.ag-root').getBoundingClientRect().left;
        const candidate = [...document.querySelectorAll('#editor-toolbar-overflow .tb-btn[data-cmd]')]
          .find(button => {
            const rect = button.getBoundingClientRect();
            return rect.width && rect.height && rect.left + rect.width / 2 > sidebarLeft
              && rect.top + rect.height / 2 > headerBottom;
          });
        if (!candidate) return false;
        const rect = candidate.getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          ?.closest('.tb-btn') === candidate;
      });
      assert.equal(lowerPopoverHit, true, 'More commands below the header must be clickable above the sidebar');
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#editor-toolbar-overflow', el => el.hidden), true);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'editor-toolbar-more');
      await page.click('#editor-toolbar-more');
      const visibleCommand = await page.evaluate(() => [...document.querySelectorAll('#editor-toolbar-overflow .tb-btn[data-cmd]')]
        .find(element => element.getClientRects().length)?.getAttribute('data-cmd'));
      assert(visibleCommand);
      await page.click(`#editor-toolbar-overflow .tb-btn[data-cmd="${visibleCommand}"]`);
      assert.match(await page.$eval('#preview-status', el => el.value), /editor fixture/);
      await page.setViewport({ width: 500, height: 960 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
  }
  await page.click('.menu-item[data-menu="view"] .menu-title');
  await page.hover('.menu-item[data-menu="view"] .md-sub');
  const submenu = await page.$eval('.menu-item[data-menu="view"] .md-sub-panel', el => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth };
  });
  assert(submenu.left >= 0 && submenu.right <= submenu.width, `390px submenu leaves viewport: ${JSON.stringify(submenu)}`);
  assert.deepEqual(errors, []);
  console.log('PASS Editor shell layout, sidebar colors, menu keyboard flow, and command palette');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
