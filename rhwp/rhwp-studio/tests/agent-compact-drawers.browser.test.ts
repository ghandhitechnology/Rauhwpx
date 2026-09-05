import { browserExecutable, browserLaunchArgs } from './browser-support.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

const css = readFileSync(
  new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url),
  'utf8',
);

test('compact fullscreen sidebars remain temporary overlays', { timeout: 20_000 }, async (context) => {
  const executablePath = browserExecutable();

  const browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700 });
    await page.setContent(`
      <style>
        html, body { margin: 0; }
        .ag-root { --ag-rail-w: 280px; position: relative !important; width: 900px; height: 700px; }
        .ag-stage { height: 100%; }
        .ag-composer { height: 120px; }
        /* Linux CI Chrome reports hover:none / pointer:none, so the production
           @media (hover: hover) and (pointer: fine) rule never shows the edge
           target. Keep it hittable here; the stylesheet contract is tested
           separately. */
        .ag-fullscreen.ag-workspace-compact .ag-compact-rail-hover-target {
          position: absolute;
          top: 48px;
          bottom: 0;
          left: 0;
          z-index: 13;
          display: block;
          width: 24px;
        }
      </style>
      <main class="ag-root ag-fullscreen ag-workspace-compact ag-rail-collapsed">
        <div class="ag-stage">
          <header class="ag-workspace-bar"></header>
          <div class="ag-compact-rail-hover-target" aria-hidden="true"></div>
          <section class="ag-chat-page"><div class="ag-composer">Composer</div></section>
          <nav class="ag-threads-page">Threads</nav>
          <aside class="ag-review-column">Review</aside>
          <aside class="ag-plan-column">Plan</aside>
          <button class="ag-workspace-drawer-scrim" aria-label="Close drawer"></button>
        </div>
      </main>
    `);
    await page.addStyleTag({ content: css });
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector<HTMLElement>('.ag-threads-page')!).opacity === '0'
      && getComputedStyle(document.querySelector<HTMLElement>('.ag-threads-page')!).visibility === 'hidden'
    ));

    const closed = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.ag-root')!;
      const rail = document.querySelector<HTMLElement>('.ag-threads-page')!;
      const composer = document.querySelector<HTMLElement>('.ag-composer')!;
      const style = getComputedStyle(rail);
      return {
        opacity: style.opacity,
        visibility: style.visibility,
        pointerEvents: style.pointerEvents,
        composer: composer.getBoundingClientRect().toJSON(),
        chat: document.querySelector<HTMLElement>('.ag-chat-page')!.getBoundingClientRect().toJSON(),
        root: root.getBoundingClientRect().toJSON(),
      };
    });

    assert.equal(closed.opacity, '0');
    assert.equal(closed.visibility, 'hidden');
    assert.equal(closed.pointerEvents, 'none');
    assert.equal(closed.chat.width, closed.root.width);

    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.ag-root')!;
      root.classList.remove('ag-rail-collapsed');
      root.classList.add('ag-compact-rail-open');
    });

    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector<HTMLElement>('.ag-threads-page')!).opacity === '1'
    ));
    const settledOpened = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('.ag-threads-page')!;
      const composer = document.querySelector<HTMLElement>('.ag-composer')!;
      const style = getComputedStyle(rail);
      return {
        opacity: style.opacity,
        visibility: style.visibility,
        pointerEvents: style.pointerEvents,
        rail: rail.getBoundingClientRect().toJSON(),
        workspaceBar: document.querySelector<HTMLElement>('.ag-workspace-bar')!.getBoundingClientRect().toJSON(),
        composer: composer.getBoundingClientRect().toJSON(),
        chat: document.querySelector<HTMLElement>('.ag-chat-page')!.getBoundingClientRect().toJSON(),
      };
    });

    assert.equal(settledOpened.opacity, '1');
    assert.equal(settledOpened.visibility, 'visible');
    assert.equal(settledOpened.pointerEvents, 'auto');
    assert.equal(
      settledOpened.rail.top,
      settledOpened.workspaceBar.bottom,
      'the compact rail should begin directly below the workspace bar',
    );
    assert.deepEqual(settledOpened.composer, closed.composer, 'opening the rail must not resize or move the composer');
    assert.equal(settledOpened.chat.width, closed.chat.width);

    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.ag-root')!;
      root.classList.remove('ag-compact-rail-open');
      root.classList.add('ag-rail-collapsed', 'ag-review-drawer-open');
      root.classList.remove('ag-review-collapsed');
    });
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector<HTMLElement>('.ag-review-column')!).opacity === '1'
    ));
    const reviewOpened = await page.evaluate(() => ({
      review: document.querySelector<HTMLElement>('.ag-review-column')!.getBoundingClientRect().toJSON(),
      workspaceBar: document.querySelector<HTMLElement>('.ag-workspace-bar')!.getBoundingClientRect().toJSON(),
      composer: document.querySelector<HTMLElement>('.ag-composer')!.getBoundingClientRect().toJSON(),
      chat: document.querySelector<HTMLElement>('.ag-chat-page')!.getBoundingClientRect().toJSON(),
    }));

    assert.ok(reviewOpened.review.left > 0, 'the review drawer should enter from the right edge');
    assert.equal(reviewOpened.review.top, reviewOpened.workspaceBar.bottom);
    assert.deepEqual(reviewOpened.composer, closed.composer, 'opening review must not resize or move the composer');
    assert.equal(reviewOpened.chat.width, closed.chat.width);

    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.ag-root')!;
      const target = document.querySelector<HTMLElement>('.ag-compact-rail-hover-target')!;
      const rail = document.querySelector<HTMLElement>('.ag-threads-page')!;
      (window as unknown as { __compactRailClosedAfterHoverOpen: boolean })
        .__compactRailClosedAfterHoverOpen = false;
      root.classList.remove('ag-review-drawer-open', 'ag-compact-rail-open', 'ag-compact-rail-hover-open');
      root.classList.add('ag-review-collapsed', 'ag-rail-collapsed');

      let openTimer: number | null = null;
      let closeTimer: number | null = null;
      const scheduleClose = () => {
        if (!root.classList.contains('ag-compact-rail-hover-open')) return;
        if (closeTimer !== null) window.clearTimeout(closeTimer);
        closeTimer = window.setTimeout(() => {
          (window as unknown as { __compactRailClosedAfterHoverOpen: boolean })
            .__compactRailClosedAfterHoverOpen = true;
          root.classList.remove('ag-compact-rail-open', 'ag-compact-rail-hover-open');
          root.classList.add('ag-rail-collapsed');
        }, 100);
      };
      target.addEventListener('pointerenter', () => {
        if (openTimer !== null) window.clearTimeout(openTimer);
        if (closeTimer !== null) window.clearTimeout(closeTimer);
        openTimer = window.setTimeout(() => {
          root.classList.remove('ag-rail-collapsed');
          root.classList.add('ag-compact-rail-open', 'ag-compact-rail-hover-open');
        }, 260);
      });
      target.addEventListener('pointerleave', (event) => {
        if (openTimer !== null) window.clearTimeout(openTimer);
        if (event.relatedTarget instanceof Node && rail.contains(event.relatedTarget)) return;
        scheduleClose();
      });
      rail.addEventListener('pointerenter', () => {
        if (closeTimer !== null) window.clearTimeout(closeTimer);
      });
      rail.addEventListener('pointerleave', scheduleClose);
    });

    await page.mouse.move(300, 300);
    await page.mouse.move(20, 300, { steps: 8 });
    await new Promise((resolve) => setTimeout(resolve, 650));
    const hoverOpened = await page.evaluate(() => ({
      open: document.querySelector('.ag-root')!.classList.contains('ag-compact-rail-open'),
      targetOwnsPointer: document.elementFromPoint(20, 300)?.classList.contains('ag-compact-rail-hover-target'),
      closedAfterOpening: (window as unknown as { __compactRailClosedAfterHoverOpen: boolean })
        .__compactRailClosedAfterHoverOpen,
    }));
    assert.equal(hoverOpened.open, true, 'the hover-opened drawer must stay open under a stationary edge pointer');
    assert.equal(hoverOpened.closedAfterOpening, false, 'the drawer must not close and reopen under the edge pointer');
    assert.equal(hoverOpened.targetOwnsPointer, true, 'the edge target should retain pointer ownership above the drawer');
  } finally {
    await browser.close();
  }
});
