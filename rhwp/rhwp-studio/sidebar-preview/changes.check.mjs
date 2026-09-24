import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const fullScene = 'audit=1&auditScene=chat-changes-full&scenario=review&review=full&permission=unrestricted&play=1&surface=changes';

export async function checkChangesPreview(page, origin, artifacts) {
  const open = async (query) => {
    await page.goto(`${origin}/?theme=light&width=480&${query}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.body.dataset.auditReady === 'true');
    await page.waitForFunction(() => document.querySelector('.ag-changes-diff-list .ag-changes-item'));
  };
  const itemCount = () => page.$$eval('.ag-changes-diff-list .ag-changes-item', (nodes) => nodes.length);

  await open(fullScene);
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.snapshot().changeEvents), ['set-finalized', 'approved']);
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().pendingChanges), 0);
  assert.equal(await page.$eval('.ag-changes-overlay', (node) => node.hidden), false);
  assert.equal(await itemCount(), 5);
  assert.match(await page.$eval('.ag-changes-review-slot', (node) => node.textContent), /적용됨/);
  assert.equal(await page.$$eval('.ag-changes-review-slot .ag-changes-pending-item', (nodes) => nodes.length), 3);
  assert.match(await page.$eval('.ag-changes-diff-list', (node) => node.textContent), /주문 접수부터 정산까지 이어지는 흐름도/);
  await page.screenshot({ path: resolve(artifacts, 'changes-full-applied.png') });
  assert.equal(await page.$eval('.ag-changes-expand', (node) => node.getAttribute('aria-expanded')), 'false');
  await page.click('.ag-changes-expand');
  assert.equal(await page.$eval('.ag-changes-expand', (node) => node.getAttribute('aria-expanded')), 'true');
  assert.equal(await page.$eval('.ag-changes-overlay', (node) => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: resolve(artifacts, 'changes-full-long-text.png') });

  await page.click('.ag-changes-commit-toggle');
  await page.waitForSelector('.ag-changes-commit-detail .ag-changes-item');
  assert.equal(await page.$eval('.ag-changes-commit-toggle', (node) => node.getAttribute('aria-expanded')), 'true');
  assert.match(await page.$eval('.ag-changes-commit-detail', (node) => node.textContent), /추진 일정과 기대 효과를 정리했습니다/);
  await page.click('.ag-changes-review-slot .ag-changes-undo');
  await page.waitForFunction(() => window.sidebarPreview.undoState.calls === 1);
  await page.waitForFunction(() => document.querySelectorAll('.ag-changes-diff-list .ag-changes-item').length === 0);
  assert.equal(await page.$('.ag-changes-review-slot .ag-changes-undo'), null);

  await open(fullScene);
  await page.evaluate(() => {
    window.sidebarPreview.undoState.entry = null;
    window.sidebarPreview.eventBus.emit('document-mutated');
  });
  await page.waitForFunction(() => !document.querySelector('.ag-changes-review-slot .ag-changes-undo'));
  await page.click('.ag-changes-diff-list .ag-changes-text-button');
  await page.waitForFunction(() => window.sidebarPreview.navigation.calls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.navigation.calls[0]),
    { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
  assert.equal(await page.$eval('.ag-root', (node) => node.classList.contains('ag-fullscreen')), false);

  await open(fullScene);
  await page.focus('.ag-changes-message');
  await page.type('.ag-changes-message', '작성 중인 커밋 메시지');
  await page.evaluate(() => window.sidebarPreview.eventBus.emit('document-mutated'));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await page.$eval('.ag-changes-message', (node) => node.value), '작성 중인 커밋 메시지');
  assert.equal(await page.$eval('.ag-changes-message', (node) => node === document.activeElement), true);

  await open(fullScene);
  await page.type('.ag-changes-message', '사업 목표와 예산표를 수정했습니다.');
  await page.click('.ag-changes-primary');
  await page.waitForFunction(() => document.querySelectorAll('.ag-changes-diff-list .ag-changes-item').length === 0);
  assert.match(await page.$eval('.ag-changes-history-list .ag-changes-commit-title', (node) => node.textContent), /사업 목표와 예산표를 수정했습니다/);
  await page.click('.ag-changes-commit-toggle');
  await page.waitForFunction(() => document.querySelectorAll('.ag-changes-commit-detail .ag-changes-item').length === 5);

  await open(fullScene);
  await page.click('.ag-changes-danger');
  await page.click('.ag-changes-confirm .ag-changes-text-button');
  assert.equal(await itemCount(), 5);
  await page.click('.ag-changes-danger');
  await page.click('.ag-changes-danger-solid');
  await page.waitForFunction(() => document.querySelectorAll('.ag-changes-diff-list .ag-changes-item').length === 0);
  assert.equal(await page.evaluate(() => window.sidebarPreview.versions.getState().dirty), false);

  await open('audit=1&scenario=review&review=full&play=1&surface=changes');
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().pendingChanges), 1);
  assert.equal(await page.$$eval('.ag-changes-review-slot .ag-changes-pending-item', (nodes) => nodes.length), 3);
  assert.equal(await page.$eval('.ag-changes-review-slot .ag-approve', (node) => node.disabled), false);
  await page.click('.ag-changes-review-slot .ag-reject');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().pendingChanges === 0);
  assert.equal(await page.$('.ag-changes-review-slot .ag-approve'), null);

  await open(fullScene);
  await page.evaluate(() => {
    const versions = window.sidebarPreview.versions;
    window.oldWorkingItems = versions.diffWorkingTree();
    let calls = 0;
    versions.diffWorkingTree = () => ++calls === 1
      ? new Promise((resolve) => { window.releaseOldWorkingDiff = resolve; })
      : Promise.resolve([]);
    window.sidebarPreview.eventBus.emit('document-mutated');
  });
  await page.waitForFunction(() => window.releaseOldWorkingDiff);
  await page.evaluate(() => {
    const versions = window.sidebarPreview.versions;
    versions.getState().documentId = 'preview-next-document';
    versions.getState().dirty = false;
    void versions.refresh();
  });
  await page.waitForFunction(() => document.querySelectorAll('.ag-changes-diff-list .ag-changes-item').length === 0);
  await page.evaluate(async () => {
    window.releaseOldWorkingDiff(await window.oldWorkingItems);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(await itemCount(), 0, 'old document diff must not appear after navigation');

  await open('scenario=review&play=1&hold=1&surface=changes');
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.isTurnRunning()), true);
  assert.equal(await page.$eval('.ag-changes-primary', (node) => node.disabled), true);
  assert.equal(await page.$eval('.ag-changes-danger', (node) => node.disabled), true);

  for (const width of [360, 560]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
      await page.goto(`${origin}/?theme=${theme}&width=${width}&${fullScene.replace('audit=1&', '')}`,
        { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.body.dataset.auditReady === 'true'
        && document.querySelector('.ag-changes-diff-list .ag-changes-item'));
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        drawer: document.querySelector('.ag-changes-drawer').scrollWidth
          - document.querySelector('.ag-changes-drawer').clientWidth,
      }));
      assert.ok(overflow.page <= 1 && overflow.drawer <= 1,
        `${width}px ${theme} overflow: ${JSON.stringify(overflow)}`);
    }
  }
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
}
