import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserLaunchArgs } from '../tests/browser-support.ts';

const studio = resolve(import.meta.dirname, '..');
const artifacts = resolve(import.meta.dirname, 'artifacts');
const executablePath = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
await mkdir(artifacts, { recursive: true });

const cacheDir = await mkdtemp(resolve(tmpdir(), 'rauhwpx-skills-check-'));
const server = await createServer({
  cacheDir,
  configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false, hmr: false },
  logLevel: 'error',
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const orderKey = 'rhwp-skill-order';
let browser;

try {
  browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.protocol.startsWith('http') && url.origin !== origin) || /\.wasm$|\/api\//.test(url.pathname)) {
      void request.abort();
    } else {
      void request.continue();
    }
  });

  async function open(width = 480) {
    await page.goto(`${origin}/?controls=0&theme=light&width=${width}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview);
    await page.waitForFunction(() => {
      const input = document.querySelector('.ag-input');
      return input && !input.disabled;
    });
    await page.click('.ag-settings-btn');
    await page.waitForSelector('.ag-root.ag-settings-open');
    await page.click('.ag-settings-nav-button[data-destination="skills"]');
    await page.waitForSelector('#ag-settings-pane-skills .ag-skills-list');
    await page.waitForFunction(() => document.querySelectorAll('.ag-skills-list [data-skill-name]').length >= 3);
  }

  async function names() {
    return page.$$eval('.ag-skills-list [data-skill-name]', (nodes) =>
      nodes.map((node) => node.getAttribute('data-skill-name')),
    );
  }

  async function visibleImportButton() {
    const button = await page.$('.ag-skills-toolbar .ag-skill-text');
    assert(button, 'Skills toolbar import button is present.');
    assert.equal(await button.evaluate((node) => node.textContent?.trim()), '가져오기');
    return button;
  }

  await open();
  const initialNames = await names();
  assert.ok(initialNames.length >= 3, 'Catalog has enough rows for reorder coverage.');
  assert.deepEqual(await page.$eval('.ag-skills-list', (node) => ({ hidden: node.hidden, visible: node.checkVisibility() })), { hidden: false, visible: true });

  // Pointer drag moves a row and writes the durable order.
  const firstHandle = await page.$('.ag-skills-list [data-skill-name] .ag-skill-drag-handle');
  const secondHandle = await page.$$('.ag-skills-list [data-skill-name] .ag-skill-drag-handle').then((handles) => handles[1]);
  assert(firstHandle && secondHandle, 'Catalog rows expose drag handles.');
  const firstBox = await firstHandle.boundingBox();
  const secondBox = await secondHandle.boundingBox();
  assert(firstBox && secondBox, 'Drag handles are visible.');
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((name) => document.querySelector('.ag-skills-list [data-skill-name]')?.getAttribute('data-skill-name') === name, {}, initialNames[1]);
  const draggedNames = await names();
  const storedDraggedOrder = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), orderKey);
  assert.deepEqual(storedDraggedOrder, draggedNames, 'Pointer reorder persists the catalog order.');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview);
  await page.click('.ag-settings-btn');
  await page.waitForSelector('.ag-root.ag-settings-open');
  await page.click('.ag-settings-nav-button[data-destination="skills"]');
  await page.waitForSelector('#ag-settings-pane-skills .ag-skills-list');
  await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll('.ag-skills-list [data-skill-name]')].map((node) => node.getAttribute('data-skill-name'))) === JSON.stringify(expected), {}, draggedNames);

  // Keyboard reorder persists the same order as pointer drag. Escape cancels an in-flight drag.
  const beforeKeyboard = await names();
  await page.focus('.ag-skills-list [data-skill-name] .ag-skill-drag-handle');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction((before) => {
    const now = [...document.querySelectorAll('.ag-skills-list [data-skill-name]')].map((node) => node.getAttribute('data-skill-name'));
    return JSON.stringify(now) !== JSON.stringify(before);
  }, {}, beforeKeyboard);
  const keyboardNames = await names();
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), orderKey), keyboardNames, 'Keyboard reorder persists the catalog order.');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll('.ag-skills-list [data-skill-name]')].map((node) => node.getAttribute('data-skill-name'))) === JSON.stringify(expected), {}, beforeKeyboard);
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll('.ag-skills-list [data-skill-name]')].map((node) => node.getAttribute('data-skill-name'))) === JSON.stringify(expected), {}, keyboardNames);
  const keyboardDragHandle = await page.$('.ag-skills-list [data-skill-name] .ag-skill-drag-handle');
  assert(keyboardDragHandle);
  const keyboardDragBox = await keyboardDragHandle.boundingBox();
  assert(keyboardDragBox);
  const keyboardDragHandles = await page.$$('.ag-skills-list [data-skill-name] .ag-skill-drag-handle');
  const keyboardLastHandle = keyboardDragHandles.at(-1);
  assert(keyboardLastHandle);
  const keyboardLastBox = await keyboardLastHandle.boundingBox();
  assert(keyboardLastBox);
  await page.mouse.move(keyboardDragBox.x + keyboardDragBox.width / 2, keyboardDragBox.y + keyboardDragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(keyboardLastBox.x + keyboardLastBox.width / 2, keyboardLastBox.y + keyboardLastBox.height, { steps: 8 });
  await page.waitForFunction((before) => {
    const now = [...document.querySelectorAll('.ag-skills-list [data-skill-name]')].map((node) => node.getAttribute('data-skill-name'));
    return JSON.stringify(now) !== JSON.stringify(before);
  }, {}, keyboardNames);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll('.ag-skills-list [data-skill-name]')].map((node) => node.getAttribute('data-skill-name'))) === JSON.stringify(expected), {}, keyboardNames);
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), orderKey), keyboardNames, 'Escape rolls back the in-flight drag without changing persistence.');

  // Copy buttons expand in place and expose the description row to assistive tech.
  const copy = await page.$('.ag-skills-list .ag-skill-copy');
  assert(copy, 'Catalog rows expose copy buttons.');
  const copyName = await copy.evaluate((node) => node.closest('[data-skill-name]')?.getAttribute('data-skill-name'));
  assert(copyName);
  await copy.click();
  await page.waitForFunction((name) => {
    const row = document.querySelector(`[data-skill-name="${CSS.escape(name)}"]`);
    const button = row?.querySelector('.ag-skill-copy');
    return button?.getAttribute('aria-expanded') === 'true' && row?.classList.contains('ag-skill-expanded');
  }, {}, copyName);
  const secondCopy = await page.$$('.ag-skills-list .ag-skill-copy').then((copies) => copies[1]);
  assert(secondCopy, 'A second skill is available for single-expansion coverage.');
  const secondName = await secondCopy.evaluate((node) => node.closest('[data-skill-name]')?.getAttribute('data-skill-name'));
  assert(secondName);
  await secondCopy.click();
  await page.waitForFunction((names) => {
    const [first, second] = names;
    const firstRow = document.querySelector(`[data-skill-name="${CSS.escape(first)}"]`);
    const secondRow = document.querySelector(`[data-skill-name="${CSS.escape(second)}"]`);
    return firstRow?.classList.contains('ag-skill-expanded') === false
      && secondRow?.classList.contains('ag-skill-expanded') === true;
  }, {}, [copyName, secondName]);

  // Toggle keeps its row mounted while the async commit updates aria-pressed.
  const toggle = await page.$('.ag-skills-list .ag-skill-toggle');
  assert(toggle, 'Enabled catalog rows expose toggles.');
  await page.evaluate(() => {
    const button = document.querySelector('.ag-skills-list .ag-skill-toggle');
    window.__skillsToggleRow = button?.closest('[data-skill-name]');
    window.__skillsToggleBefore = button?.getAttribute('aria-pressed');
    window.__skillsToggleName = window.__skillsToggleRow?.getAttribute('data-skill-name');
    button?.click();
  });
  assert.equal(await page.evaluate(() => window.__skillsToggleRow?.isConnected), true, 'Toggle keeps the row mounted during its commit.');
  await page.waitForFunction(() => {
    const button = document.querySelector('.ag-skills-list .ag-skill-toggle');
    return button?.getAttribute('aria-pressed') !== window.__skillsToggleBefore;
  });
  assert.equal(await page.evaluate(() => window.__skillsToggleRow === document.querySelector(`[data-skill-name="${CSS.escape(window.__skillsToggleName)}"]`)), true, 'Toggle keeps the same row after its outcome.');

  // Import leaves the catalog mounted, waits for both events, and returns focus to the imported copy button.
  const catalogBeforeImport = await names();
  const importButton = await visibleImportButton();
  await importButton.click();
  await page.waitForSelector('.ag-skills-import-panel:not([hidden])');
  await page.waitForSelector('.ag-skill-import-row');
  assert.equal(await page.$eval('.ag-skills-list', (node) => node.checkVisibility()), true, 'Catalog stays visible while the import panel is open.');
  const importedName = await page.$eval('.ag-skill-import-row', (node) => node.getAttribute('data-skill-name') || node.querySelector('[data-skill-name]')?.getAttribute('data-skill-name') || node.querySelector('.ag-skill-item-name')?.textContent?.trim());
  assert(importedName, 'Import row identifies the skill it will add.');
  await page.click('.ag-skill-import-row');
  await page.waitForFunction((name) => {
    const row = document.querySelector(`.ag-skills-list [data-skill-name="${CSS.escape(name)}"]`);
    const panel = document.querySelector('.ag-skills-import-panel');
    return !!row && [...document.querySelectorAll('.ag-skills-list [data-skill-name]')][0] === row
      && (!panel || panel.hidden || !panel.checkVisibility());
  }, {}, importedName);
  const afterImport = await names();
  assert.equal(afterImport[0], importedName, 'Imported skill is inserted at the top of the catalog.');
  assert.deepEqual(afterImport.slice(1), catalogBeforeImport, 'Import shifts the existing catalog rows down.');
  await page.waitForFunction((name) => {
    const row = [...document.querySelectorAll('.ag-skills-list [data-skill-name]')]
      .find((node) => node.getAttribute('data-skill-name') === name);
    return row?.querySelector('.ag-skill-copy') === document.activeElement;
  }, {}, importedName);

  // Reduced motion and the minimum sidebar width must not introduce overflow.
  await page.setViewport({ width: 280, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${origin}/?controls=0&theme=light&width=280`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview);
  await page.click('.ag-settings-btn');
  await page.waitForSelector('.ag-root.ag-settings-open');
  await page.click('.ag-settings-nav-button[data-destination="skills"]');
  await page.waitForSelector('#ag-settings-pane-skills .ag-skills-list');
  await page.$eval('.ag-skills-toolbar .ag-skill-text', (button) => button.click());
  await page.waitForSelector('.ag-skills-import-panel:not([hidden])');
  const layout = await page.$eval('.ag-root', (node) => ({
    rootOverflow: node.scrollWidth - node.clientWidth,
    listOverflow: [...node.querySelectorAll('.ag-skills-list, .ag-skills-import-panel')].map((item) => item.scrollWidth - item.clientWidth),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
  assert.equal(layout.reducedMotion, true, 'Reduced-motion media preference is active in the check.');
  assert.equal(await page.$eval('.ag-skills-import-panel', (node) => node.getAnimations().length), 0, 'Reduced motion disables import-panel animation.');
  assert.ok(layout.rootOverflow <= 1, `Narrow sidebar has no horizontal overflow (${layout.rootOverflow}px).`);
  assert.ok(layout.listOverflow.every((overflow) => overflow <= 1), `Skills surfaces have no horizontal overflow (${layout.listOverflow.join(', ')}px).`);

  assert.deepEqual(errors, [], 'Skills interactions produce no browser errors.');
  console.log('Skills shelf regression checks passed: drag persistence, keyboard reorder and Escape rollback, expansion, toggle, import focus/order, reduced motion, and narrow layout.');
} finally {
  await browser?.close();
  await server.close();
}
