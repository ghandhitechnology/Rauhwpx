import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserLaunchArgs } from './browser-support.ts';

const studio = resolve(import.meta.dirname, '..');
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(path => path && existsSync(path));
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');

const cacheDir = await mkdtemp(resolve(tmpdir(), 'rauhwpx-toolbar-keyboard-'));
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
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    const { Toolbar } = await import('/src/ui/toolbar.ts');
    const fake = Object.create(Toolbar.prototype);
    const commands = [];
    fake.enabled = true;
    fake.dispatcher = { dispatch: id => { commands.push(id); } };
    for (const name of ['btnBold', 'btnItalic', 'btnUnderline', 'btnStrike']) {
      const button = document.createElement('button');
      button.id = name;
      document.body.append(button);
      fake[name] = button;
    }
    fake.setupFormatButtons();
    fake.setActive(fake.btnBold, true);
    if (fake.btnBold.getAttribute('aria-pressed') !== 'true') throw new Error('Active format needs aria-pressed');
    window.__toolbarKeyboardCommands = commands;
  });

  for (const [button, expected] of [
    ['btnBold', 'format:bold'],
    ['btnItalic', 'format:italic'],
    ['btnUnderline', 'format:underline'],
  ]) {
    await page.focus(`#${button}`);
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.__toolbarKeyboardCommands.splice(0)), [expected]);
    await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(() => window.__toolbarKeyboardCommands.splice(0)), [expected]);
  }
  console.log('PASS Style-bar formatting buttons dispatch once with Enter and Space');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
