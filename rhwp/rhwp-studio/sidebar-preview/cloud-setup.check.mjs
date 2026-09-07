import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkCloudSetup(page, origin, artifacts) {
  const title = (text) => page.waitForFunction((expected) =>
    document.querySelector('.ag-cloud-setup-title')?.textContent === expected, {}, text);
  async function click(label) {
    const buttons = await page.$$('.ag-cloud-setup-dialog button');
    for (const button of buttons) {
      if (await button.evaluate((node, text) => node.textContent === text && node.checkVisibility(), label)) {
        await button.click();
        return;
      }
    }
    assert.fail(`Missing setup button: ${label}`);
  }
  for (const width of [280, 480, 900]) {
    await page.goto(`${origin}/?cloud=1&page=settings&destination=cloud&controls=0&width=${width}&reset=1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview?.cloud);
    await page.evaluate(() => window.sidebarPreview.cloud.setDashboardState('unconfigured'));
    await page.click('.ag-cd-setup');
    await title('Cloud 서버 선택');
    await click('취소');
    assert.equal(await page.$eval('.ag-cloud-setup-overlay', (node) => node.hidden), true);
    await page.click('.ag-cd-setup');
    await click('계속');
    await title('Raucloud 사용');
    await click('뒤로');
    await title('Cloud 서버 선택');
    await click('계속');
    await title('Raucloud 사용');
    await page.screenshot({ path: resolve(artifacts, `cloud-first-server-${width}.png`) });
    assert.equal(await page.$eval('.ag-cloud-setup-dialog', (node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        && node.scrollWidth <= node.clientWidth;
    }), true, `setup fits at ${width}px`);
    await click('서버 만들기');
    await title('Raucloud 준비 중');
    await click('숨기기');
    await page.waitForFunction(() => window.sidebarPreview.cloud.controller.getSnapshot().server.lifecycle === 'ready');
    await page.click('.ag-cloud-settings-action');
    await title('Raucloud가 준비되었습니다');
    await click('상태 확인');
    await title('Raucloud가 준비되었습니다');
    assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.spawn), 1);
    await page.screenshot({ path: resolve(artifacts, `cloud-first-server-ready-${width}.png`) });
    await click('완료');
    await page.click('.ag-cloud-settings-action');
    await click('서버 종료');
    await title('Cloud 서버 선택');
    await click('계속');
    await click('서버 만들기');
    await title('Raucloud가 준비되었습니다');
    assert.deepEqual(await page.evaluate(() => ({
      spawn: window.sidebarPreview.cloud.calls.spawn,
      teardown: window.sidebarPreview.cloud.calls.teardown,
    })), { spawn: 2, teardown: 1 });
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('.ag-cloud-setup-overlay', (node) => node.hidden), true);
  }
}
