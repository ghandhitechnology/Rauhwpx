import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserLaunchArgs, findBrowserExecutable } from '../tests/browser-support.ts';

const studio = resolve(import.meta.dirname, '..');
const artifacts = resolve(import.meta.dirname, 'artifacts');
const executablePath = findBrowserExecutable();
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
await mkdir(artifacts, { recursive: true });
const cacheDir = await mkdtemp(resolve(tmpdir(), 'rauhwpx-skill-editor-'));
const server = await createServer({ cacheDir, configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false, hmr: false }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${origin}/?controls=0&theme=light&width=480`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview);
  await page.waitForFunction(() => !document.querySelector('.ag-input')?.disabled);
  await page.click('.ag-settings-btn');
  await page.click('.ag-settings-nav-button[data-destination="skills"]');
  await page.waitForSelector('.ag-skills-list [data-skill-name]');
  await page.waitForSelector('.ag-skill-edit');

  const editable = await page.$('.ag-skill-edit');
  assert(editable, 'User skills expose an edit action.');
  const name = await editable.evaluate((button) => button.closest('[data-skill-name]')?.getAttribute('data-skill-name'));
  assert(name, 'Editable row has a name.');

  // Imported/sealed rows never expose an editor control.
  const readonlyRow = await page.$('[data-skill-name="imported-style-guide"]');
  assert(readonlyRow, 'Read-only imported fixture exists.');
  assert.equal(await readonlyRow.$('.ag-skill-edit'), null, 'Imported skills never expose edit.');
  const iconTrigger = `[data-skill-name="${name}"] .ag-skill-icon-button`;
  await page.click(iconTrigger);
  await page.waitForSelector('.ag-skill-icon-picker');
  assert.equal(await page.$$eval('.ag-skill-icon-option svg path', (paths) =>
    paths.every((path) => Boolean(path.getAttribute('d')) && path.getBBox().width > 0)), true,
    'Every selectable icon renders a nonempty path.');
  assert.equal(await page.$eval('.ag-skill-icon-picker', (picker) =>
    picker.scrollWidth <= picker.clientWidth), true, 'Icon grid fits inside its popup.');
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'skill-icon-popup.png') });
  await page.click(iconTrigger);
  assert.equal(await page.$('.ag-skill-icon-picker'), null, 'Clicking the same icon closes its popup.');
  await page.click(iconTrigger);
  await page.click('.ag-skills-search');
  assert.equal(await page.$('.ag-skill-icon-picker'), null, 'Clicking outside closes the popup.');
  await page.click(iconTrigger);
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.ag-skill-icon-picker'), null, 'Escape closes the popup.');
  await page.click('.ag-skill-new');
  await page.waitForSelector('.ag-skill-new-editor');
  assert.equal(await page.$eval('.ag-skill-new', (button) => getComputedStyle(button).display === 'none'), true, 'Create button hides while creating.');
  await page.$eval('.ag-root', (root) => root.classList.add('ag-fullscreen'));
  await page.$eval('.ag-root', (root) => root.classList.remove('ag-fullscreen'));
  const fill = async (selector, value) => page.$eval(selector, (node, next) => {
    node.value = next;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await fill('.ag-skill-editor-name', 'outline-to-actions');
  await fill('.ag-skill-editor-description', '회의 내용을 실행 항목으로 정리합니다.');
  await fill('.ag-skill-new-editor .ag-skill-editor-input', '# 실행 항목\n\n핵심 결정과 담당자를 표로 정리합니다.');
  assert.equal(await page.$('.ag-skill-editor-artifact'), null, 'New skill editor has no artifact preview.');
  await page.click('.ag-skill-new-editor .ag-skill-editor-save');
  await page.waitForSelector('[data-skill-name="outline-to-actions"]');
  assert.equal(await page.$('.ag-skill-new-editor'), null, 'Saved new skill closes its editor.');
  const reopen = async () => {
    await page.click(`[data-skill-name="${name}"] .ag-skill-edit`);
    await page.waitForFunction(() => {
      const input = document.querySelector('.ag-skill-editor-input');
      return input && !input.disabled;
    });
  };

  assert.equal(await page.$eval('.ag-skill-new', (button) => getComputedStyle(button).display !== 'none'), true, 'Create button returns after cancel.');
  await reopen();
  await page.waitForSelector('textarea.ag-skill-editor-input');
  assert.equal(await page.$eval('.ag-skill-new', (button) => getComputedStyle(button).display === 'none'), true, 'Create button hides while editing.');
  const editor = await page.$('textarea.ag-skill-editor-input');
  const original = await editor.evaluate((node) => node.value);
  await editor.focus();
  await page.keyboard.type('\n\n추가 규칙');
  const draft = await editor.evaluate((node) => node.value);
  assert.notEqual(draft, original, 'Typing changes the draft.');
  await page.click('.ag-skill-editor-cancel');
  await page.waitForFunction(() => !document.querySelector('textarea.ag-skill-editor-input'));
  await reopen();
  await page.waitForSelector('textarea.ag-skill-editor-input');
  assert.equal(await page.$eval('textarea.ag-skill-editor-input', (node) => node.value), original,
    'Cancel discards the draft.');

  await page.focus('textarea.ag-skill-editor-input');
  await page.keyboard.type('\n\n저장된 규칙');
  await page.click('.ag-skill-editor-save');
  await page.waitForFunction(() => !document.querySelector('textarea.ag-skill-editor-input'));
  await reopen();
  await page.waitForSelector('textarea.ag-skill-editor-input');
  assert.match(await page.$eval('textarea.ag-skill-editor-input', (node) => node.value), /저장된 규칙/,
    'Saved body survives reopening.');

  // Refreshes must not discard an active draft.
  await page.focus('textarea.ag-skill-editor-input');
  await page.keyboard.type('\n임시 초안');
  await page.evaluate(() => window.sidebarPreview.bridge.listSkills());
  await new Promise((resolve) => setTimeout(resolve, 60));
  await page.waitForFunction(() => document.querySelector('textarea.ag-skill-editor-input')?.value.includes('임시 초안'));
  assert.match(await page.$eval('textarea.ag-skill-editor-input', (node) => node.value), /임시 초안/,
    'Catalog refresh preserves the active draft.');
  await page.keyboard.press('Escape');
  assert.match(await page.$eval('textarea.ag-skill-editor-input', (node) => node.value), /임시 초안/,
    'Escape preserves the draft and keeps the editor open.');
  await page.keyboard.type('\n__FAIL_SAVE__');
  const failedDraft = await page.$eval('textarea.ag-skill-editor-input', (node) => node.value);
  await page.click('.ag-skill-editor-save');
  await page.waitForFunction(() => document.querySelector('.ag-skill-editor-status')?.textContent.includes('Preview save failed.'));
  assert.equal(await page.$eval('textarea.ag-skill-editor-input', (node) => node.value), failedDraft,
    'Save failure preserves the full draft.');
  await page.click('.ag-skill-editor-cancel');
  await page.waitForFunction(() => !document.querySelector('textarea.ag-skill-editor-input'));
  await reopen();
  await page.focus('.ag-skill-editor-input');
  await page.keyboard.type('\n키보드 저장');
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await page.waitForFunction(() => !document.querySelector('textarea.ag-skill-editor-input'));
  await reopen();
  assert.match(await page.$eval('.ag-skill-editor-input', (node) => node.value), /키보드 저장/);
  await page.$eval('.ag-skill-editor', (node) => node.scrollIntoView({ block: 'center' }));
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'skill-editor.png') });
  assert.equal(errors.length, 0, `Sidebar runtime errors: ${JSON.stringify(errors)}`);
  console.log('PASS inline skill editor read-only, cancel, save, refresh, and keyboard behavior');
} finally {
  await browser?.close();
  await server.close();
}
