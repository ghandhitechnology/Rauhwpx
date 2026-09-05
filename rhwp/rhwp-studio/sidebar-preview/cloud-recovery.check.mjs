import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkCloudRecovery(page, origin, artifacts) {
  await page.goto(`${origin}/?cloud=1&theme=light&reset=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview?.cloud && !document.querySelector('.ag-input').disabled);
  await page.click('[aria-label="프로바이더 선택"]');
  await page.click('.ag-provider-item[data-agent="codex"]');
  await page.evaluate(() => [...document.querySelectorAll('.ag-workspace-mode-option')].find((node) => node.textContent === '클라우드').click());
  await page.type('.ag-input', '이 제안서의 예산 표를 검토해 주세요.');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.transfers.length === 1
    && window.sidebarPreview.cloud.controller.getSnapshot().session.kind === 'running'
    && !document.querySelector('.ag-input').disabled);
  await page.evaluate(() => [...document.querySelectorAll('.ag-workspace-mode-option')].find((node) => node.textContent === '클라우드').click());
  await page.waitForFunction(() => document.querySelector('#cloud-workspace').dataset.displayState === 'live');
  const original = await page.evaluate(() => {
    const cloud = window.sidebarPreview.cloud;
    const session = cloud.controller.getSnapshot().session;
    return { ...session, startId: cloud.calls.transfers[0].startId,
      frame: document.querySelector('.cloud-workspace-image').src };
  });
  await page.screenshot({ path: resolve(artifacts, 'cloud-live.png') });
  await page.click('[data-document-view="local"]');
  assert.equal(await page.evaluate(() => window.sidebarPreview.workspace.workspaceView()), 'local');
  assert.equal(await page.evaluate(() => window.sidebarPreview.workspace.mode()), 'cloud');
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.controller.getSnapshot().session.sessionId), original.sessionId);
  await page.click('[data-document-view="cloud"]');
  await page.waitForFunction(() => document.querySelector('#cloud-workspace').dataset.displayState === 'live');

  // Text completion alone must not offer a partially persisted document.
  await page.evaluate(() => window.sidebarPreview.cloud.finishReply('검토를 마쳤습니다.'));
  assert.equal(await page.$eval('.ag-cloud-merge-button', (button) => button.hidden), true);
  await page.evaluate(() => window.sidebarPreview.cloud.commitTurn());
  await page.waitForFunction(() => !document.querySelector('.ag-cloud-merge-button').hidden);
  await page.screenshot({ path: resolve(artifacts, 'cloud-merge-ready.png') });
  await page.click('[data-document-view="local"]');
  await page.click('.ag-cloud-merge-button');
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.merges.length === 1);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.merges[0].checkpoint.operationId), 'preview-turn-1');
  assert.equal(await page.evaluate(() => window.sidebarPreview.workspace.mode()), 'cloud');
  await page.waitForFunction(() => document.querySelector('.ag-cloud-merge-button').hidden);
  await page.click('[data-document-view="cloud"]');
  await page.waitForFunction(() => document.querySelector('#cloud-workspace').dataset.displayState === 'live');
  original.frame = await page.$eval('.cloud-workspace-image', (node) => node.src);
  await page.click('#cloud-disconnect');
  await page.waitForFunction(() => document.querySelector('#cloud-workspace').dataset.displayState === 'stalled');
  assert.equal(await page.$eval('.cloud-workspace-image', (node) => node.src), original.frame);
  assert.equal(await page.$eval('.ag-input', (node) => node.disabled), true);
  assert.equal(await page.$eval('.ag-messages', (node) => node.innerText.includes('ECONNRESET')), false);
  assert.equal(await page.$eval('.ag-composer-target-message', (node) => node.hidden), true);
  await page.screenshot({ path: resolve(artifacts, 'cloud-disconnected.png') });

  // The recovery title and both actions must remain readable at minimum width.
  await page.select('#theme', 'dark');
  await page.focus('.ag-resize-handle');
  await page.keyboard.press('Home');
  await page.waitForFunction(() => {
    const handle = document.querySelector('.ag-resize-handle');
    return handle.getAttribute('aria-valuenow') === handle.getAttribute('aria-valuemin');
  });
  assert.equal(await page.$eval('.ag-cloud-recovery-strip', (strip) => {
    const bounds = strip.getBoundingClientRect();
    return [...strip.querySelectorAll('button')].every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right && rect.height >= 32
        && button.scrollWidth <= button.clientWidth + 1;
    });
  }), true);
  await page.screenshot({ path: resolve(artifacts, 'cloud-disconnected-narrow-dark.png') });

  // A blocked refresh must not prevent opening or closing the status panel.
  await page.evaluate(() => window.sidebarPreview.cloud.blockRefresh(true));
  const openedAt = performance.now();
  await page.click('.ag-cloud-btn');
  await page.waitForSelector('.ag-cloud-panel:not([hidden])', { timeout: 1000 });
  const panelMs = performance.now() - openedAt;
  assert.ok(panelMs < 1000);
  await page.evaluate(() => window.sidebarPreview.cloud.blockRefresh(false));
  assert.equal(await page.$eval('.ag-cloud-panel', (panel) => {
    const root = panel.closest('.ag-root').getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    return rect.left >= root.left && rect.right <= root.right;
  }), true);
  await page.screenshot({ path: resolve(artifacts, 'cloud-recovery-panel-narrow-dark.png') });
  await page.select('#theme', 'light');

  // Background snapshots must not replace a focused/pressed recovery button.
  assert.equal(await page.evaluate(() => {
    const button = document.querySelector('.ag-cloud-recovery-actions .ag-primary');
    button.focus();
    for (let index = 0; index < 25; index++) window.sidebarPreview.cloud.publish();
    return button.isConnected && document.activeElement === button;
  }), true);
  const reconnectAt = performance.now();
  await page.evaluate(() => {
    const button = document.querySelector('.ag-cloud-recovery-actions .ag-primary');
    button.click(); button.click(); button.click();
  });
  await page.waitForFunction(() => window.sidebarPreview.cloud.controller.getSnapshot().link.kind === 'ready'
    && document.querySelector('#cloud-workspace').dataset.displayState === 'live'
    && !document.querySelector('.ag-input').disabled);
  const reconnectMs = performance.now() - reconnectAt;
  assert.ok(reconnectMs < 1500);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.reconnect), 1);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.controller.getSnapshot().session.sessionId), original.sessionId);

  // Explicit rebuilding must transfer this same transcript with a fresh id.
  await page.type('.ag-input', 'Keep this unsent draft through server rebuilding.');
  await page.evaluate(() => window.sidebarPreview.cloud.requireReference('reference-missing'));
  await page.click('#cloud-disconnect');
  // Missing required references must stop before archive preparation or recreation.
  await page.evaluate(() => [...document.querySelectorAll('.ag-cloud-recovery-actions button')]
    .find((node) => node.textContent === '서버 다시 만들기').click());
  await page.waitForFunction(() => document.querySelector('.ag-messages').innerText.includes('reference-missing 참고자료를 찾지 못해'));
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.prepareRestart), 0);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.recreate), 0);
  await page.evaluate(() => { window.sidebarPreview.cloud.setLink('ready'); window.sidebarPreview.cloud.requireReference('reference-sample'); });
  await page.click('#cloud-disconnect');
  // An unavailable archive must stop before the destructive recreation.
  await page.evaluate(() => {
    window.sidebarPreview.cloud.setRestartArchiveAvailable(false);
    [...document.querySelectorAll('.ag-cloud-recovery-actions button')]
      .find((node) => node.textContent === '서버 다시 만들기').click();
  });
  await page.waitForFunction(() => document.querySelector('.ag-messages').innerText.includes('최신 Cloud 문서 보관본을 확인할 수 없습니다.')
    && [...document.querySelectorAll('.ag-cloud-recovery-actions button')]
      .some((node) => node.textContent === '서버 다시 만들기' && !node.disabled));
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.recreate), 0);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.transfers.length), 1);
  assert.equal(await page.$eval('.ag-input', (node) => node.value), 'Keep this unsent draft through server rebuilding.');
  await page.evaluate(() => {
    window.sidebarPreview.cloud.setRestartArchiveAvailable(true);
    const button = [...document.querySelectorAll('.ag-cloud-recovery-actions button')]
      .find((node) => node.textContent === '서버 다시 만들기');
    button.click(); button.click();
  });
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.transfers.length === 2
    && window.sidebarPreview.cloud.controller.getSnapshot().session.kind === 'running'
    && !document.querySelector('.ag-input').disabled);
  const restarted = await page.evaluate(() => {
    const { cloud } = window.sidebarPreview;
    return { transfer: cloud.calls.transfers[1], session: cloud.controller.getSnapshot().session,
      recreateCalls: cloud.calls.recreate };
  });
  assert.equal(restarted.recreateCalls, 1);
  const restartDocument = await page.evaluate(() => {
    const document = window.sidebarPreview.cloud.calls.transfers[1].document;
    return { text: new TextDecoder().decode(document.bytes), originSha256: document.originSha256,
      restartToken: document.restartToken };
  });
  assert.equal(restartDocument.text, 'Archived Cloud edits after the original transfer.');
  assert.equal(restartDocument.originSha256, null);
  assert.equal(restartDocument.restartToken, `preview-restart-${original.sessionId}`);
  assert.equal(restarted.transfer.references.length, 1);
  assert.equal(restarted.transfer.references[0].id, 'reference-sample');
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.transfers[1].references[0].bytes.every((byte) => byte === 7)), true);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.referenceReads), 2);
  assert.equal(await page.$eval('.ag-input', (node) => node.value), 'Keep this unsent draft through server rebuilding.');
  await page.$eval('.ag-input', (node) => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.notEqual(restarted.transfer.startId, original.startId);
  assert.notEqual(restarted.session.sessionId, original.sessionId);
  assert.equal(restarted.transfer.threadId, original.threadId);
  assert.equal(restarted.transfer.documentId, original.documentId);
  assert.equal(restarted.transfer.timeline.thread.messages.filter((message) =>
    message.text === '이 제안서의 예산 표를 검토해 주세요.').length, 1);
  await page.waitForFunction(() => document.querySelector('#cloud-workspace').dataset.displayState === 'live');
  await page.screenshot({ path: resolve(artifacts, 'cloud-restarted.png') });

  await page.evaluate(() => window.sidebarPreview.cloud.requireReference(null));

  // Stop while a reconnect is in flight, then start again in the same chat.
  await page.click('#cloud-disconnect');
  await page.evaluate(() => {
    document.querySelector('.ag-cloud-recovery-actions .ag-primary').click();
    [...document.querySelectorAll('.ag-cloud-panel-actions button')]
      .find((node) => node.textContent === '서버 강제 종료').click();
  });
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.stop === 1
    && window.sidebarPreview.cloud.controller.getSnapshot().session.kind === 'idle'
    && !document.querySelector('.ag-input').disabled);
  await page.type('.ag-input', '같은 대화에서 다시 시작합니다.');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.transfers.length === 3
    && !document.querySelector('.ag-input').disabled);
  assert.equal(await page.evaluate(() => new Set(window.sidebarPreview.cloud.calls.transfers.map((item) => item.startId)).size), 3);
  assert.equal(await page.evaluate(() => new Set(window.sidebarPreview.cloud.calls.transfers.map((item) => item.threadId)).size), 1);

  // A fresh local chat keeps the Cloud lease and conversation running, while
  // the local composer and retained editor copy become usable.
  await page.click('.ag-cloud-panel-close');
  await page.screenshot({ path: resolve(artifacts, 'cloud-new-local-chat.png') });
  await page.evaluate(() => window.sidebarPreview.cloud.blockRefresh(true));
  await page.click('.ag-new-local-chat');
  await page.waitForFunction(() => !document.querySelector('.ag-input').disabled
    && window.sidebarPreview.workspace.mode() === 'local', { timeout: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.cloudLease), 'local');
  await page.evaluate(() => window.sidebarPreview.cloud.blockRefresh(false));
  await page.waitForFunction(() => window.sidebarPreview.cloud.controller.getSnapshot().session.kind === 'idle'
    && !document.querySelector('.ag-input').disabled);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.getScope().selectedSessionId), undefined);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.controller.getSnapshot().lease.owner), 'cloud');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.cloudLease), 'local');
  assert.equal(await page.evaluate(() => window.sidebarPreview.workspace.workspaceView()), 'local');
  const localThreadId = await page.evaluate(() => window.sidebarPreview.cloud.getScope().threadId);
  assert.notEqual(localThreadId, original.threadId);
  assert.equal(await page.$eval('.ag-messages', (node) => node.innerText.includes('예산 표를 검토')), false);
  await page.type('.ag-input', '로컬에서 소개 문단을 작성해 주세요.');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  await page.evaluate(() => {
    window.sidebarPreview.cloud.finishReply('Cloud에서 예산 검토를 마쳤습니다.');
    window.sidebarPreview.cloud.setLink('failed');
  });
  assert.equal(await page.$eval('.ag-input', (node) => node.disabled), false);
  assert.equal(await page.$eval('.ag-send', (node) => node.getAttribute('aria-label')), '중지');
  assert.equal(await page.$eval('.ag-messages', (node) => node.innerText.includes('Cloud에서 예산 검토')), false);
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  assert.equal(await page.$eval('.ag-messages', (node) => node.innerText.includes('문서를 검토했습니다')), true);
  await page.screenshot({ path: resolve(artifacts, 'parallel-local-chat.png') });
  await page.evaluate(() => window.sidebarPreview.cloud.setLink('ready'));
  await page.click('.ag-header .ag-threads-btn');
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-threads-item')]
    .some((node) => node.checkVisibility() && node.querySelector('.ag-thread-mode')?.textContent === 'Cloud'));
  assert.equal(await page.evaluate(() => {
    const item = [...document.querySelectorAll('.ag-threads-item')].find((node) => node.checkVisibility()
      && node.querySelector('.ag-thread-mode')?.textContent === 'Cloud');
    item?.click();
    return Boolean(item);
  }), true);
  await page.waitForFunction(() => window.sidebarPreview.cloud.controller.getSnapshot().session.kind === 'running'
    && !document.querySelector('.ag-input').disabled);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.controller.getSnapshot().session.threadId), original.threadId);
  assert.equal(await page.evaluate(() => window.sidebarPreview.workspace.workspaceView()), 'cloud');
  assert.equal(await page.$eval('.ag-messages', (node) => node.innerText.includes('예산 표를 검토')), true);
  assert.equal(await page.$eval('.ag-messages', (node) => node.innerText.includes('Cloud에서 예산 검토를 마쳤습니다.')), true);
  assert.equal(await page.$eval('.ag-messages', (node) => node.innerText.includes('로컬에서 소개 문단')), false);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.transfers.length), 3);
  // Returning to the local thread restores its own history without a transfer.
  await page.click('.ag-header .ag-threads-btn');
  await page.screenshot({ path: resolve(artifacts, 'parallel-chat-list.png') });
  await page.evaluate(() => [...document.querySelectorAll('.ag-threads-item')]
    .find((node) => node.checkVisibility() && node.querySelector('.ag-thread-mode')?.textContent === 'Local').click());
  await page.waitForFunction(() => !document.querySelector('.ag-input').disabled
    && window.sidebarPreview.workspace.mode() === 'local');
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.getScope().threadId), localThreadId);
  assert.equal(await page.evaluate(() => window.sidebarPreview.workspace.workspaceView()), 'local');
  assert.equal(await page.$eval('.ag-messages', (node) => node.innerText.includes('로컬에서 소개 문단')), true);
  assert.equal(await page.$eval('.ag-messages', (node) => node.innerText.includes('Cloud에서 예산 검토')), false);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.stop), 1);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.transfers.length), 3);
  await page.click('.ag-header .ag-threads-btn');
  await page.evaluate(() => [...document.querySelectorAll('.ag-threads-item')]
    .find((node) => node.checkVisibility() && node.querySelector('.ag-thread-mode')?.textContent === 'Cloud').click());
  await page.waitForFunction(() => window.sidebarPreview.cloud.controller.getSnapshot().session.kind === 'running'
    && !document.querySelector('.ag-input').disabled);
  // Reopen after the old server is gone but its replacement transfer failed.
  await page.evaluate(() => window.sidebarPreview.cloud.rejectRestartTransfer(true));
  await page.click('#cloud-disconnect');
  await page.evaluate(() => document.querySelector('.ag-cloud-btn').click());
  await page.evaluate(() => [...document.querySelectorAll('.ag-cloud-recovery-actions button')]
    .find((node) => node.textContent === '서버 다시 만들기').click());
  await page.waitForFunction(() => document.querySelector('.ag-messages').innerText.includes('Preview restart transfer interrupted.'));
  const pendingRestart = await page.evaluate(async () => {
    const { listThreads, waitForThreadsPersistence } = window.sidebarPreview.threadStore;
    await waitForThreadsPersistence();
    return listThreads().find((thread) => thread.cloudRestartSourceSessionId);
  });
  assert.ok(pendingRestart.cloudStartId);
  await page.goto(`${origin}/?cloud=1&theme=light`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.querySelector('.ag-header .ag-threads-btn').click());
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-threads-item')].some((node) => node.checkVisibility()));
  await page.evaluate(() => [...document.querySelectorAll('.ag-threads-item')].find((node) => node.checkVisibility()).click());
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.transfers.length === 1
    && window.sidebarPreview.cloud.controller.getSnapshot().session.kind === 'running'
    && !document.querySelector('.ag-input').disabled);
  await page.waitForFunction(async (threadId) => {
    const { getThread } = window.sidebarPreview.threadStore;
    const thread = getThread(threadId);
    return Boolean(thread) && !thread.cloudRestartSourceSessionId;
  }, {}, pendingRestart.id);
  const reopened = await page.evaluate(async () => {
    const { listThreads, waitForThreadsPersistence } = window.sidebarPreview.threadStore;
    await waitForThreadsPersistence();
    return { transfer: window.sidebarPreview.cloud.calls.transfers[0],
      documentText: new TextDecoder().decode(window.sidebarPreview.cloud.calls.transfers[0].document.bytes),
      threads: listThreads() };
  });
  assert.equal(reopened.transfer.startId, pendingRestart.cloudStartId);
  assert.equal(reopened.transfer.threadId, pendingRestart.id);
  assert.equal(reopened.documentText, 'Archived Cloud edits after the original transfer.');
  assert.equal(reopened.transfer.timeline.thread.messages.filter((message) => message.messageId === pendingRestart.cloudStartId).length, 1);
  assert.equal(reopened.threads.find((thread) => thread.id === pendingRestart.id).cloudRestartSourceSessionId, undefined);
  console.log(`Cloud panel opened in ${Math.round(panelMs)}ms; fixture reconnect restored the preview in ${Math.round(reconnectMs)}ms`);
  await page.goto(`${origin}/?width=480`, { waitUntil: 'networkidle0' });
}
