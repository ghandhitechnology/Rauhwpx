import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import puppeteer from 'puppeteer-core';
import { transformWithOxc } from 'vite';

const BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

test('the real destructive dialog defaults to Cancel and mutates exactly once after approval', {
  timeout: 20_000,
}, async (context) => {
  const executablePath = BROWSER_CANDIDATES.find(existsSync);
  if (!executablePath) {
    context.skip('Chrome or Chromium is unavailable');
    return;
  }

  const source = readFileSync(
    new URL('../src/ui/agent-sidebar/cloud-destructive-confirmation.ts', import.meta.url),
    'utf8',
  );
  const css = readFileSync(new URL('../src/ui/agent-sidebar/cloud-ui.css', import.meta.url), 'utf8');
  const transformed = await transformWithOxc(`${source}\n(globalThis as any).__createCloudDestructiveGate = createCloudServerDestructiveActionGate;`, 'cloud-destructive-confirmation.ts', {
    lang: 'ts',
  });

  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>${css}</style>
      <main id="workspace">
        <button id="server-stop" type="button">서버 종료</button>
      </main>
    `);
    await page.addScriptTag({ content: transformed.code, type: 'module' });
    await page.waitForFunction(() => typeof (globalThis as unknown as {
      __createCloudDestructiveGate?: unknown;
    }).__createCloudDestructiveGate === 'function');
    await page.evaluate(() => {
      const browserGlobal = globalThis as unknown as {
        __createCloudDestructiveGate: (deps?: object) => {
          request(request: object): Promise<string>;
        };
        __cloudMutationCount?: number;
      };
      const trigger = document.querySelector<HTMLButtonElement>('#server-stop')!;
      const workspace = document.querySelector<HTMLElement>('#workspace')!;
      browserGlobal.__cloudMutationCount = 0;
      const gate = browserGlobal.__createCloudDestructiveGate();
      trigger.addEventListener('click', () => {
        void gate.request({
          action: 'delete',
          trigger,
          fallbackFocus: workspace,
          isCurrent: () => true,
          run: () => { browserGlobal.__cloudMutationCount = (browserGlobal.__cloudMutationCount ?? 0) + 1; },
        });
      });
    });

    const openDialog = async (): Promise<void> => {
      await page.click('#server-stop');
      await page.waitForSelector('.ag-cloud-destructive-dialog');
      await page.waitForFunction(() => document.activeElement?.classList.contains('ag-cancel'));
    };
    const expectCancelledAndFocused = async (): Promise<void> => {
      await page.waitForFunction(() => !document.querySelector('.ag-cloud-destructive-dialog'));
      await page.waitForFunction(() => document.activeElement?.id === 'server-stop');
      assert.equal(await page.evaluate(() => (
        globalThis as unknown as { __cloudMutationCount: number }
      ).__cloudMutationCount), 0);
    };

    await openDialog();
    const initial = await page.evaluate(() => ({
      role: document.querySelector('.ag-cloud-destructive-dialog')?.getAttribute('role'),
      modal: document.querySelector('.ag-cloud-destructive-dialog')?.getAttribute('aria-modal'),
      activeClass: document.activeElement?.className,
      copy: document.querySelector('.ag-cloud-destructive-dialog')?.textContent,
      mutations: (globalThis as unknown as { __cloudMutationCount: number }).__cloudMutationCount,
    }));
    assert.equal(initial.role, 'alertdialog');
    assert.equal(initial.modal, 'true');
    assert.match(String(initial.activeClass), /ag-cancel/);
    assert.match(String(initial.copy), /저장되지 않은 원격 문서 변경 내용은 복구할 수 없습니다/);
    assert.equal(initial.mutations, 0);

    await page.keyboard.press('Enter');
    await expectCancelledAndFocused();

    await openDialog();
    await page.keyboard.press('Escape');
    await expectCancelledAndFocused();

    await openDialog();
    await page.click('.ag-cloud-destructive-button.ag-cancel');
    await expectCancelledAndFocused();

    await openDialog();
    await page.$eval('.ag-cloud-destructive-button.ag-confirm', (button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => !document.querySelector('.ag-cloud-destructive-dialog'));
    await page.waitForFunction(() => (
      globalThis as unknown as { __cloudMutationCount: number }
    ).__cloudMutationCount === 1);
    assert.equal(await page.evaluate(() => (
      globalThis as unknown as { __cloudMutationCount: number }
    ).__cloudMutationCount), 1);
  } finally {
    await browser.close();
  }
});
