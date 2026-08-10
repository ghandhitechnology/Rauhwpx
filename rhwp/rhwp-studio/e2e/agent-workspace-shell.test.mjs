import assert from 'node:assert/strict';
import { runTest, screenshot } from './helpers.mjs';

await runTest('agent fullscreen workspace shell', async ({ page }) => {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.waitForSelector('#agent-sidebar .ag-fullscreen-btn');
  await page.click('#agent-sidebar .ag-fullscreen-btn');
  await page.waitForFunction(
    () => document.querySelector('#agent-sidebar')?.classList.contains('ag-fullscreen'),
  );
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 450)));

  const conversation = await page.evaluate(() => {
    const root = document.querySelector('#agent-sidebar');
    const bar = root?.querySelector('.ag-workspace-bar');
    const threads = root?.querySelector('.ag-threads-page');
    const chat = root?.querySelector('.ag-chat-page');
    const barRect = bar?.getBoundingClientRect();
    const threadsRect = threads?.getBoundingClientRect();
    const chatRect = chat?.getBoundingClientRect();
    return {
      rootFullscreen: root?.classList.contains('ag-fullscreen') ?? false,
      barDisplay: bar ? getComputedStyle(bar).display : '',
      barRect: barRect && { x: barRect.x, y: barRect.y, width: barRect.width, height: barRect.height },
      threadsRect: threadsRect && { x: threadsRect.x, y: threadsRect.y, width: threadsRect.width },
      chatRect: chatRect && { x: chatRect.x, y: chatRect.y, width: chatRect.width },
      selectedTab: root?.querySelector('.ag-workspace-tab[aria-selected="true"]')?.innerText?.trim(),
    };
  });

  assert.equal(conversation.rootFullscreen, true);
  assert.equal(conversation.barDisplay, 'grid');
  assert.equal(conversation.barRect?.x, 0);
  assert.equal(conversation.barRect?.y, 0);
  assert.equal(conversation.barRect?.width, 1440);
  assert.equal(conversation.barRect?.height, 48);
  assert.equal(conversation.threadsRect?.y, 48);
  assert.equal(conversation.chatRect?.y, 48);
  assert.equal(conversation.selectedTab, '대화');
  await screenshot(page, 'agent-workspace-conversation');

  await page.click('.ag-workspace-tab[aria-controls="ag-review-column"]');
  await page.waitForFunction(
    () => document.querySelector('#agent-sidebar')?.classList.contains('ag-workspace-changes'),
  );
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 220)));

  const changes = await page.evaluate(() => {
    const root = document.querySelector('#agent-sidebar');
    const surface = root?.querySelector('.ag-review-column');
    const composer = root?.querySelector('.ag-composer');
    const surfaceRect = surface?.getBoundingClientRect();
    const style = surface ? getComputedStyle(surface) : null;
    return {
      selectedTab: root?.querySelector('.ag-workspace-tab[aria-selected="true"]')?.innerText?.trim(),
      surfaceRect: surfaceRect && {
        x: surfaceRect.x,
        y: surfaceRect.y,
        width: surfaceRect.width,
        height: surfaceRect.height,
      },
      borderRadius: style?.borderRadius,
      boxShadow: style?.boxShadow,
      composerInChanges: composer?.parentElement === surface,
    };
  });

  assert.equal(changes.selectedTab, '변경 사항');
  assert.equal(changes.surfaceRect?.y, 48);
  assert.equal(changes.surfaceRect?.height, 852);
  assert.equal(changes.borderRadius, '0px');
  assert.equal(changes.boxShadow, 'none');
  assert.equal(changes.composerInChanges, true);
  await screenshot(page, 'agent-workspace-changes');

  await page.click('.ag-workspace-tab[aria-controls="ag-chat-page"]');
  await page.click('.ag-workspace-threads-btn');
  await page.setViewport({ width: 720, height: 780, deviceScaleFactor: 1 });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 320)));
  const compact = await page.evaluate(() => {
    const bar = document.querySelector('.ag-workspace-bar');
    const composer = document.querySelector('.ag-chat-page > .ag-composer');
    const barRect = bar?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    return {
      barWidth: barRect?.width,
      barScrollWidth: bar?.scrollWidth,
      composerX: composerRect?.x,
      composerRight: composerRect?.right,
      railCollapsed: document.querySelector('#agent-sidebar')?.classList.contains('ag-rail-collapsed'),
    };
  });
  assert.equal(compact.railCollapsed, true);
  assert.equal(compact.barWidth, 720);
  assert.ok((compact.barScrollWidth ?? 721) <= 720);
  assert.ok((compact.composerX ?? -1) >= 0);
  assert.ok((compact.composerRight ?? 721) <= 720);
  await screenshot(page, 'agent-workspace-compact');
});
