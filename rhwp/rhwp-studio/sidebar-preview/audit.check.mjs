import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { auditScenarios } from '../src/sidebar-preview/audit-scenarios.ts';

const studio = resolve(import.meta.dirname, '..');
const artifacts = resolve(import.meta.dirname, 'artifacts');
const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((path) => path && existsSync(path));
assert(executablePath, 'Set CHROME_PATH to Chrome/Chromium.');
await mkdir(artifacts, { recursive: true });
const server = await createServer({ configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false, hmr: false }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  const external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.protocol.startsWith('http') && url.origin !== origin) || /\.wasm$|\/api\//.test(url.pathname)) {
      external.push(request.url());
      void request.abort();
    } else void request.continue();
  });
  const open = async (params) => {
    await page.goto(`${origin}/?${params}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.auditReady, { timeout: 15000 });
    assert.equal(await page.$eval('body', (node) => node.dataset.auditReady), 'true',
      await page.$eval('#preview-status', (node) => node.textContent));
  };
  for (const scene of auditScenarios) {
    const params = new URLSearchParams({ audit: '1', theme: 'light', width: '480', ...scene.params, auditScene: scene.id });
    await open(params);
    assert.equal(await page.$eval('.audit-scene-current a', (node) => node.firstChild.textContent), scene.title);
    if (scene.id === 'chat-review') assert.ok(await page.evaluate(() => window.sidebarPreview.snapshot().pendingChanges > 0));
    if (scene.params['cloud-phase']) assert.notEqual(await page.evaluate(() => window.sidebarPreview.cloud.controller.getSnapshot().session.kind), 'idle');
    if (['chat-empty', 'chat-review', 'cloud-options', 'cloud-disconnected'].includes(scene.id))
      await page.screenshot({ path: resolve(artifacts, `audit-${scene.id}.png`) });
    console.log(`PASS ${scene.id}`);
  }
  await open('audit=1&theme=dark&width=360');
  await page.screenshot({ path: resolve(artifacts, 'audit-dark-narrow.png') });
  await page.click('.audit-scene-current input');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.audit-scene-current input:checked');
  await page.type('.audit-search', 'quota exhausted');
  assert.equal(await page.$$eval('.audit-scene', (nodes) => nodes.length), 1);
  await page.click('.audit-scene-link');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('auditScene') === 'cloud-exhausted');
  await page.waitForFunction(() => document.body.dataset.auditReady === 'true');
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.controller.getSnapshot().account.quota.remainingMs), 0);
  await open('audit=1&theme=light');
  const dialogs = await page.$$eval('[data-audit-dialog]', (nodes) => nodes.map((node) => node.dataset.auditDialog));
  for (const dialog of dialogs) {
    await open('audit=1&theme=light');
    await page.evaluate(() => [...document.querySelectorAll('.audit-tabs button')].find((button) => button.textContent === 'Editor dialogs').click());
    await page.evaluate((id) => {
      const button = document.querySelector(`[data-audit-dialog="${id}"]`);
      button.closest('details').open = true;
      button.click();
    }, dialog);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await page.$eval('#preview-status', (node) => node.textContent.includes('Error')), false);
    if (dialog === dialogs[0]) await page.screenshot({ path: resolve(artifacts, 'audit-dialog.png') });
    console.log(`PASS dialog ${dialog}`);
  }
  assert.deepEqual(errors, [], 'No browser exceptions');
  assert.deepEqual(external, [], 'Fixtures stay local and engine-independent');
  console.log(`Audit passed: ${auditScenarios.length} scenes, ${dialogs.length} dialogs, navigation and persistence.`);
} finally {
  await browser?.close();
  await server.close();
}
