import { browserExecutable, browserLaunchArgs } from './browser-support.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

type SetupScrollMetrics = {
  dialogOverflow: boolean;
  providersOverflow: boolean;
  overlayOverflow: boolean;
  dialogScrollTop: number;
  providersScrollTop: number;
  overlayScrollTop: number;
  dialogScrollbarWidth: number;
  providersScrollbarWidth: number;
  overlayScrollbarWidth: number;
  dialogBehavior: string;
};

function readSetupScrollMetrics(): SetupScrollMetrics {
  const measure = (selector: string) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
      return { overflow: false, scrollTop: 0, scrollbarWidth: 0 };
    }
    return {
      overflow: element.scrollHeight > element.clientHeight,
      scrollTop: element.scrollTop,
      scrollbarWidth: element.offsetWidth - element.clientWidth,
    };
  };
  const overlay = measure('.rhwp-setup-overlay');
  const dialog = measure('.rhwp-setup-dialog');
  const providers = measure('.rhwp-setup-providers');
  const dialogElement = document.querySelector('.rhwp-setup-dialog');
  return {
    dialogOverflow: dialog.overflow,
    providersOverflow: providers.overflow,
    overlayOverflow: overlay.overflow,
    dialogScrollTop: dialog.scrollTop,
    providersScrollTop: providers.scrollTop,
    overlayScrollTop: overlay.scrollTop,
    dialogScrollbarWidth: dialog.scrollbarWidth,
    providersScrollbarWidth: providers.scrollbarWidth,
    overlayScrollbarWidth: overlay.scrollbarWidth,
    dialogBehavior:
      dialogElement instanceof HTMLElement ? getComputedStyle(dialogElement).scrollBehavior : '',
  };
}

test('provider setup remains scrollable without showing a scrollbar', { timeout: 20_000 }, async (context) => {
  const executablePath = browserExecutable();

  const css = readFileSync(new URL('../src/ui/initial-setup/initial-setup.css', import.meta.url), 'utf8');
  const browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 640 });
    await page.setContent(`
      <style>${css}</style>
      <div class="rhwp-setup-overlay rhwp-setup-open">
        <section class="rhwp-setup-dialog" data-stage="providers">
          <nav class="rhwp-setup-nav"><span class="rhwp-setup-brand">Rauhwpx</span></nav>
          <header class="rhwp-setup-chrome"><h1 class="rhwp-setup-title">모델을 연결하세요</h1></header>
          <div class="rhwp-setup-providers">
            <div class="rhwp-setup-grid">
              ${Array.from({ length: 6 }, (_, index) => `
                <article class="rhwp-setup-card" data-agent="${index === 0 ? 'rau' : 'provider'}">
                  <h2 class="rhwp-setup-card-name">Provider ${index + 1}</h2>
                  <ul class="rhwp-setup-card-models"><li>Model</li></ul>
                  <button class="rhwp-setup-card-action">설정</button>
                </article>
              `).join('')}
            </div>
          </div>
          <footer class="rhwp-setup-footer"><button class="rhwp-setup-footer-btn">다음</button></footer>
        </section>
      </div>
    `);

    const before = await page.evaluate(readSetupScrollMetrics);
    assert.ok(
      before.providersOverflow || before.dialogOverflow || before.overlayOverflow,
      'fixture must overflow the provider pane, dialog, or overlay',
    );

    await page.hover('.rhwp-setup-card');
    await page.mouse.wheel({ deltaY: 800 });

    let after = await page.evaluate(readSetupScrollMetrics);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (after.providersScrollTop > 0 || after.dialogScrollTop > 0 || after.overlayScrollTop > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = await page.evaluate(readSetupScrollMetrics);
    }

    assert.ok(
      after.providersScrollTop > 0 || after.dialogScrollTop > 0 || after.overlayScrollTop > 0,
      'wheel input should reveal the lower provider cards and footer',
    );
    assert.equal(after.dialogScrollbarWidth, 0);
    assert.equal(after.providersScrollbarWidth, 0);
    assert.equal(after.overlayScrollbarWidth, 0);
    assert.equal(after.dialogBehavior, 'smooth');
  } finally {
    await browser.close();
  }
});
