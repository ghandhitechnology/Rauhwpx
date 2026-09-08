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

  await page.goto(`${origin}/?cloud=1&controls=0&width=480&reset=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview?.cloud && !document.querySelector('.ag-input').disabled);
  await page.evaluate(() => {
    window.sidebarPreview.cloud.setDashboardState('unconfigured');
    window.sidebarPreview.cloud.setSpawnFailures(1);
  });
  await page.click('[aria-label="프로바이더 선택"]');
  await page.click('.ag-provider-item[data-agent="codex"]');
  const draft = '이 제안서의 예산 표와 결론을 다듬어 주세요.';
  await page.type('.ag-input', draft);
  await page.click('.ag-header [data-workspace-mode="cloud"]');
  await title('Cloud 서버 선택');
  assert.equal(await page.$eval('.ag-input', (node) => node.value), draft);
  await click('계속');
  await title('Raucloud 사용');
  assert.match(await page.$eval('.ag-cloud-setup-transfer-context', (node) => node.textContent), /보낼 작업Codex/);
  await click('준비하고 보내기');
  await title('Raucloud를 준비하지 못했습니다');
  assert.equal(await page.$eval('.ag-input', (node) => node.value), draft);
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.cloud.calls.spawnPayloads), [
    { providerId: 'raucloud', selectedProvider: 'codex' },
  ]);
  await page.screenshot({ path: resolve(artifacts, 'cloud-prepare-send-retry.png') });
  await click('다시 시도');
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.transfers.length === 1
    && document.querySelector('.ag-cloud-setup-overlay').hidden);
  assert.deepEqual(await page.evaluate(() => ({
    spawn: window.sidebarPreview.cloud.calls.spawn,
    provider: window.sidebarPreview.cloud.calls.transfers[0].agent,
    text: window.sidebarPreview.cloud.calls.transfers[0].initialMessage.text,
    draft: document.querySelector('.ag-input').value,
  })), { spawn: 2, provider: 'codex', text: draft, draft: '' });

  await page.goto(`${origin}/?cloud=1&controls=0&width=480&reset=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview?.cloud && !document.querySelector('.ag-input').disabled);
  await page.evaluate(() => window.sidebarPreview.cloud.setDashboardState('unconfigured'));
  await page.click('[aria-label="프로바이더 선택"]');
  await page.click('.ag-provider-item[data-agent="codex"]');
  await page.type('.ag-input', '취소한 요청');
  await page.click('.ag-header [data-workspace-mode="cloud"]');
  await title('Cloud 서버 선택');
  await click('취소');
  await page.evaluate(() => window.sidebarPreview.cloud.setDashboardState('self-hosted'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await page.evaluate(() => ({
    transfers: window.sidebarPreview.cloud.calls.transfers.length,
    draft: document.querySelector('.ag-input').value,
  })), { transfers: 0, draft: '취소한 요청' });

  await page.goto(`${origin}/?cloud=1&controls=0&width=480&reset=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview?.cloud && !document.querySelector('.ag-input').disabled);
  await page.evaluate(() => window.sidebarPreview.cloud.setDashboardState('unconfigured'));
  await page.click('[aria-label="프로바이더 선택"]');
  await page.click('.ag-provider-item[data-agent="codex"]');
  await page.type('.ag-input', '원래 채팅에서 보낼 요청');
  await page.click('.ag-header [data-workspace-mode="cloud"]');
  await click('계속');
  await click('준비하고 보내기');
  await title('Raucloud 준비 중');
  await click('숨기기');
  await page.$eval('.ag-input', (node) => {
    node.value = '다시 작성한 요청';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.sidebarPreview.cloud.controller.getSnapshot().server.lifecycle === 'ready');
  assert.deepEqual(await page.evaluate(() => ({
    transfers: window.sidebarPreview.cloud.calls.transfers.length,
    draft: document.querySelector('.ag-input').value,
    mode: window.sidebarPreview.workspace.mode(),
  })), { transfers: 0, draft: '다시 작성한 요청', mode: 'local' },
  '숨겨 둔 설정이 완료돼도 바뀐 초안을 보내지 않는다');

  await page.goto(`${origin}/?cloud=1&controls=0&width=480&reset=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview?.cloud && !document.querySelector('.ag-input').disabled);
  await page.evaluate(() => window.sidebarPreview.cloud.setDashboardState('unconfigured'));
  await page.click('[aria-label="프로바이더 선택"]');
  await page.click('.ag-provider-item[data-agent="codex"]');
  const hiddenDraft = '설정을 숨겨도 보낼 요청';
  await page.type('.ag-input', hiddenDraft);
  await page.click('.ag-header [data-workspace-mode="cloud"]');
  await click('계속');
  await click('준비하고 보내기');
  await title('Raucloud 준비 중');
  await click('숨기기');
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.transfers.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(await page.evaluate(() => ({
    transfers: window.sidebarPreview.cloud.calls.transfers.length,
    provider: window.sidebarPreview.cloud.calls.transfers[0].agent,
    text: window.sidebarPreview.cloud.calls.transfers[0].initialMessage.text,
  })), { transfers: 1, provider: 'codex', text: hiddenDraft },
  '완료 스냅샷과 명령 응답이 겹쳐도 한 번만 보낸다');

  await page.goto(`${origin}/?cloud=1&controls=0&width=480&reset=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview?.cloud && !document.querySelector('.ag-input').disabled);
  await page.evaluate(() => {
    window.sidebarPreview.cloud.setDashboardState('unconfigured');
    window.sidebarPreview.cloud.setSpawnFailures(1);
    window.sidebarPreview.cloud.setSandboxStatusRecovery(true);
  });
  await page.click('[aria-label="프로바이더 선택"]');
  await page.click('.ag-provider-item[data-agent="codex"]');
  const refreshDraft = '상태를 확인한 뒤 보낼 요청';
  await page.type('.ag-input', refreshDraft);
  await page.click('.ag-header [data-workspace-mode="cloud"]');
  await click('계속');
  await click('준비하고 보내기');
  await title('Raucloud를 준비하지 못했습니다');
  await click('상태 확인');
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.transfers.length === 1);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.transfers[0].initialMessage.text), refreshDraft);

  await page.evaluate(() => {
    window.sidebarPreview.cloud.setQueueAckFailures(1);
    window.sidebarPreview.cloud.blockQueueReceipt(true);
  });
  const fileChooser = page.waitForFileChooser();
  await page.click('.ag-reference-quick-add');
  await (await fileChooser).accept([resolve(artifacts, 'sample.txt')]);
  await page.waitForSelector('.ag-reference-upload-chip.ag-ready');
  await page.click('.ag-header [aria-label="Cloud 상태"]');
  await page.waitForSelector('.ag-cloud-panel:not([hidden])');
  assert.equal(await page.$eval('.ag-cloud-handoff-accepted', (node) => node.checkVisibility()), true);
  const followup = '첨부한 자료를 반영해 결론을 다듬어 주세요.';
  await page.type('.ag-input', followup);
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.commands
    .filter((command) => command.command === 'queue-message').length === 1
    && document.querySelector('.ag-send').disabled);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.controller
    .getSnapshot().queuedMessages.length), 0, '업로드 중에는 데스크톱 수신 상태가 아직 없다');
  assert.equal(await page.$eval('.ag-cloud-handoff-accepted', (node) => node.checkVisibility()), false,
    '업로드가 끝나기 전에도 즉시 안전 종료 안내를 숨긴다');
  await page.evaluate(() => window.sidebarPreview.cloud.blockQueueReceipt(false));
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.commands
    .filter((command) => command.command === 'queue-message').length === 1
    && document.querySelector('.ag-reference-upload-chip.ag-ready')
    && !document.querySelector('.ag-send').disabled);
  await page.waitForFunction(() => window.sidebarPreview.cloud.controller
    .getSnapshot().queuedMessages[0]?.delivery === 'pending');
  assert.equal(await page.$eval('.ag-input', (node) => node.value), followup);
  const pendingHandoff = await page.$eval('.ag-cloud-handoff-accepted', (node) => ({
    hidden: node.hidden,
    visible: node.checkVisibility(),
  }));
  assert.equal(pendingHandoff.visible, false,
    `최신 메시지의 영속 수신이 확인되기 전에는 노트북을 닫아도 된다고 안내하지 않는다: ${JSON.stringify(pendingHandoff)}`);
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.controller
    .getSnapshot().queuedMessages[0]?.delivery), 'pending');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.cloud.calls.commands
    .filter((command) => command.command === 'queue-message').length === 2
    && document.querySelector('.ag-input').value === '');
  const queuedIds = await page.evaluate(() => window.sidebarPreview.cloud.calls.commands
    .filter((command) => command.command === 'queue-message')
    .map((command) => command.messageId));
  assert.equal(queuedIds[1], queuedIds[0], '동일한 메시지와 파일의 재시도는 원래 messageId를 재사용한다');
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.controller
    .getSnapshot().queuedMessages[0]?.delivery), 'durable');
  assert.equal(await page.$eval('.ag-cloud-handoff-accepted', (node) => node.checkVisibility()), true,
    '최신 메시지의 영속 수신을 확인한 뒤에만 안전 종료 안내를 다시 보여 준다');
}
