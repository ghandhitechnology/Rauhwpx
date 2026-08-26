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
      title: root?.querySelector('.ag-workspace-title')?.textContent?.trim(),
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
  assert.equal(conversation.title, '대화');
  await screenshot(page, 'agent-workspace-conversation');

  await page.click('.ag-workspace-settings-btn');
  await page.waitForFunction(
    () => document.querySelector('#agent-sidebar')?.classList.contains('ag-settings-open'),
  );
  const wideSettings = await page.evaluate(() => {
    const root = document.querySelector('#agent-sidebar');
    const page = root?.querySelector('.ag-settings-page');
    const nav = root?.querySelector('.ag-settings-nav');
    const chat = root?.querySelector('.ag-chat-page');
    return {
      title: root?.querySelector('.ag-workspace-title')?.textContent,
      pageWidth: page?.getBoundingClientRect().width,
      navDirection: nav ? getComputedStyle(nav).flexDirection : '',
      chatVisibility: chat ? getComputedStyle(chat).visibility : '',
    };
  });
  assert.equal(wideSettings.title, '설정');
  assert.equal(wideSettings.pageWidth, 1440);
  assert.equal(wideSettings.navDirection, 'column');
  assert.equal(wideSettings.chatVisibility, 'hidden');
  await screenshot(page, 'agent-workspace-wide-settings');
  await page.click('.ag-workspace-settings-back');
  await page.waitForFunction(
    () => !document.querySelector('#agent-sidebar')?.classList.contains('ag-settings-open'),
  );

  await page.click('.ag-environment-changes');
  await page.waitForFunction(
    () => document.querySelector('#agent-sidebar')?.classList.contains('ag-review-drawer-open'),
  );
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 220)));

  const changes = await page.evaluate(() => {
    const root = document.querySelector('#agent-sidebar');
    const surface = root?.querySelector('.ag-review-column');
    const composer = root?.querySelector('.ag-composer');
    const surfaceRect = surface?.getBoundingClientRect();
    const style = surface ? getComputedStyle(surface) : null;
    return {
      drawerOpen: root?.classList.contains('ag-review-drawer-open') ?? false,
      surfaceRect: surfaceRect && {
        x: surfaceRect.x,
        y: surfaceRect.y,
        width: surfaceRect.width,
        height: surfaceRect.height,
      },
      borderRadius: style?.borderRadius,
      boxShadow: style?.boxShadow,
      hasComposer: !!composer,
      composerOutsideChanges: !!composer && composer.parentElement !== surface,
    };
  });

  assert.equal(changes.drawerOpen, true);
  assert.equal(changes.surfaceRect?.y, 48);
  assert.equal(changes.surfaceRect?.height, 852);
  assert.equal(changes.borderRadius, '0px');
  assert.equal(changes.boxShadow, 'none');
  assert.equal(changes.hasComposer, true);
  assert.equal(changes.composerOutsideChanges, true);
  await screenshot(page, 'agent-workspace-changes');

  await page.click('.ag-review-column-close');
  await page.waitForFunction(
    () => !document.querySelector('#agent-sidebar')?.classList.contains('ag-review-drawer-open'),
  );
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

  await page.click('.ag-workspace-settings-btn');
  await page.waitForFunction(
    () => document.querySelector('#agent-sidebar')?.classList.contains('ag-settings-open'),
  );
  const compactSettings = await page.evaluate(() => {
    const root = document.querySelector('#agent-sidebar');
    const page = root?.querySelector('.ag-settings-page');
    const nav = root?.querySelector('.ag-settings-nav');
    const threads = root?.querySelector('.ag-threads-page');
    const chat = root?.querySelector('.ag-chat-page');
    return {
      title: root?.querySelector('.ag-workspace-title')?.textContent,
      pageWidth: page?.getBoundingClientRect().width,
      navDirection: nav ? getComputedStyle(nav).flexDirection : '',
      backVisible: !!root?.querySelector('.ag-workspace-settings-back')?.getClientRects().length,
      threadsVisibility: threads ? getComputedStyle(threads).visibility : '',
      chatVisibility: chat ? getComputedStyle(chat).visibility : '',
    };
  });
  assert.equal(compactSettings.title, '설정');
  assert.equal(compactSettings.pageWidth, 720);
  assert.equal(compactSettings.navDirection, 'row');
  assert.equal(compactSettings.backVisible, true);
  assert.equal(compactSettings.threadsVisibility, 'hidden');
  assert.equal(compactSettings.chatVisibility, 'hidden');
  await screenshot(page, 'agent-workspace-compact-settings');

  await page.click('.ag-workspace-settings-back');
  await page.waitForFunction(
    () => !document.querySelector('#agent-sidebar')?.classList.contains('ag-settings-open'),
  );
  const returned = await page.evaluate(() => ({
    fullscreen: document.querySelector('#agent-sidebar')?.classList.contains('ag-fullscreen'),
    title: document.querySelector('.ag-workspace-title')?.textContent,
  }));
  assert.equal(returned.fullscreen, true);
  assert.equal(returned.title, '대화');
});
