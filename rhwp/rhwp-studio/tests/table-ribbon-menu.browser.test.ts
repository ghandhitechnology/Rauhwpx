import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('table ribbon menus preserve selection and support keyboard navigation in overflow', { timeout: 30_000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'table-menu-harness',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== '/table-menu-harness') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html><html><head><style>#overflow { display: flex; gap: 180px; }</style></head><body>
            <input id="editor" value="selected text">
            <div id="toolbar" data-context-mode="table">
              <div id="overflow">
                <div class="tb-table-context-group" data-table-ribbon-menu>
                  <button class="tb-btn tb-table-menu-trigger" aria-haspopup="menu" aria-expanded="false" aria-controls="insert-menu">Insert</button>
                  <div id="insert-menu" class="tb-table-menu-panel" role="menu" hidden style="position:fixed;width:160px;height:100px">
                    <button class="tb-table-menu-item" role="menuitem" data-cmd="table:row">Row</button>
                    <button class="tb-table-menu-item" role="menuitem" data-cmd="table:disabled">Disabled</button>
                    <button class="tb-table-menu-item" role="menuitem" data-cmd="table:col">Column</button>
                  </div>
                </div>
                <div class="tb-table-context-group" data-table-ribbon-menu>
                  <button class="tb-btn tb-table-menu-trigger" aria-haspopup="menu" aria-expanded="false" aria-controls="cell-menu">Cell</button>
                  <div id="cell-menu" class="tb-table-menu-panel" role="menu" hidden style="position:fixed;width:160px;height:80px">
                    <button class="tb-table-menu-item" role="menuitem" data-cmd="table:merge">Merge</button>
                  </div>
                </div>
                <div class="tb-table-context-group tb-table-tile-equal"><button id="equal-height" class="tb-btn" type="button">Equal height</button><button id="equal-width" class="tb-btn" type="button">Equal width</button></div>
                <div class="tb-table-context-group"><button id="disabled-tile" class="tb-btn" type="button" disabled>Disabled</button></div>
                <div class="tb-table-context-group" hidden><button id="hidden-tile" class="tb-btn" type="button">Hidden overflow tile</button></div>
              </div>
            </div>
            <button id="outside">Outside</button>
          </body></html>`);
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/table-menu-harness`);
    await page.evaluate(async () => {
      const { setupTableRibbonMenus } = await import('../src/ui/table-ribbon-menu.ts');
      const calls: string[] = [];
      (window as typeof window & { menuCalls: string[] }).menuCalls = calls;
      setupTableRibbonMenus(
        document.getElementById('toolbar')!,
        (cmd) => calls.push(cmd),
        (cmd) => cmd !== 'table:disabled',
      );
    });

    await page.focus('#editor');
    await page.click('.tb-table-menu-trigger');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'editor');
    assert.equal(await page.$eval('#insert-menu', element => element.hasAttribute('hidden')), false);
    assert.equal(await page.$eval('[data-cmd="table:disabled"]', element => (element as HTMLButtonElement).disabled), true);

    await page.click('[data-cmd="table:col"]');
    assert.deepEqual(await page.evaluate(() => (window as typeof window & { menuCalls: string[] }).menuCalls), ['table:col']);
    assert.equal(await page.$eval('#insert-menu', element => element.hasAttribute('hidden')), true);

    await page.focus('.tb-table-menu-trigger');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.cmd), 'table:row');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.cmd), 'table:col');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('tb-table-menu-trigger')), true);
    assert.equal(await page.$eval('#insert-menu', element => element.hasAttribute('hidden')), true);

    await page.click('.tb-table-menu-trigger');
    await page.click('[aria-controls="cell-menu"]');
    assert.equal(await page.$eval('#insert-menu', element => element.hasAttribute('hidden')), true);
    assert.equal(await page.$eval('#cell-menu', element => element.hasAttribute('hidden')), false);
    await page.click('#outside');
    assert.equal(await page.$eval('#cell-menu', element => element.hasAttribute('hidden')), true);

    await page.focus('[aria-controls="insert-menu"]');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-controls')), 'cell-menu');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'equal-height');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'equal-width');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'equal-height');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-controls')), 'insert-menu');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'equal-height');

    await page.focus('[aria-controls="insert-menu"]');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => (window as typeof window & { menuCalls: string[] }).menuCalls), ['table:col', 'table:col']);
    await page.click('.tb-table-menu-trigger');
    await page.evaluate(() => document.getElementById('toolbar')!.setAttribute('data-context-mode', 'default'));
    await page.waitForFunction(() => document.getElementById('insert-menu')!.hasAttribute('hidden'));
  } finally {
    await browser?.close();
    await server.close();
  }
});
