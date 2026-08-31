import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

const BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

test('provider setup remains scrollable without showing a scrollbar', { timeout: 20_000 }, async (context) => {
  const executablePath = BROWSER_CANDIDATES.find(existsSync);
  if (!executablePath) {
    context.skip('Chrome or Chromium is unavailable');
    return;
  }

  const css = readFileSync(new URL('../src/ui/initial-setup/initial-setup.css', import.meta.url), 'utf8');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
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

    const before = await page.$eval('.rhwp-setup-dialog', (dialog) => ({
      clientHeight: dialog.clientHeight,
      scrollHeight: dialog.scrollHeight,
      scrollTop: dialog.scrollTop,
    }));
    assert.ok(before.scrollHeight > before.clientHeight, 'fixture must overflow the setup dialog');

    await page.hover('.rhwp-setup-card');
    await page.mouse.wheel({ deltaY: 800 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const after = await page.$eval('.rhwp-setup-dialog', (dialog) => ({
      scrollTop: dialog.scrollTop,
      scrollbarWidth: dialog.offsetWidth - dialog.clientWidth,
      behavior: getComputedStyle(dialog).scrollBehavior,
    }));
    assert.ok(after.scrollTop > 0, 'wheel input should reveal the lower provider cards and footer');
    assert.equal(after.scrollbarWidth, 0);
    assert.equal(after.behavior, 'smooth');
  } finally {
    await browser.close();
  }
});
