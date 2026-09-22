import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkCloudStream(page, origin, artifacts) {
  await page.goto(`${origin}/?cloud=1&cloud-turn=1&cloud-phase=working&reset=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.dataset.auditReady === 'true');
  await page.evaluate(() => {
    const cloud = window.sidebarPreview.cloud;
    window.streamAuditTimeline = structuredClone(cloud.controller.getSnapshot().timeline);
    cloud.emitAgentEvent({ type: 'turn-start', agent: 'codex' });
    cloud.emitAgentEvent({ type: 'text-delta', agent: 'codex', text: 'First streaming fragment. ' });
  });
  await page.waitForFunction(() => document.querySelector('.ag-messages').textContent.includes('First streaming fragment.'));
  await page.evaluate(() => {
    const cloud = window.sidebarPreview.cloud;
    const operation = structuredClone(window.streamAuditTimeline);
    operation.exportedAt = new Date(Date.now() + 1000).toISOString();
    operation.thread.updatedAt += 1000;
    cloud.publishTimeline(operation);
    cloud.emitAgentEvent({ type: 'text-delta', agent: 'codex', text: 'Second streaming fragment.' });
  });
  await page.waitForFunction(() => document.querySelector('.ag-messages').textContent.includes('Second streaming fragment.'));
  assert.match(await page.$eval('.ag-messages', (node) => node.textContent), /First streaming fragment\.\s*Second streaming fragment\./);
  await page.evaluate(() => {
    const cloud = window.sidebarPreview.cloud;
    cloud.emitAgentEvent({ type: 'turn-end', agent: 'codex', stopReason: 'completed' });
    const operation = structuredClone(window.streamAuditTimeline);
    operation.exportedAt = new Date(Date.now() + 2000).toISOString();
    operation.thread.updatedAt += 2000;
    cloud.publishTimeline(operation);
  });
  assert.match(await page.$eval('.ag-messages', (node) => node.textContent), /First streaming fragment\.\s*Second streaming fragment\./);
  await page.evaluate(() => {
    const completed = structuredClone(window.streamAuditTimeline);
    completed.thread.messages.push({ role: 'assistant', agent: 'codex', text: 'First streaming fragment. Second streaming fragment.' });
    completed.exportedAt = new Date(Date.now() + 3000).toISOString();
    completed.thread.updatedAt += 3000;
    window.sidebarPreview.cloud.publishTimeline(completed);
  });
  assert.equal(await page.$$eval('.ag-msg-assistant', (nodes) => nodes.filter((node) => node.textContent.includes('First streaming fragment.')).length), 1);
  await page.evaluate(() => {
    window.sidebarPreview.cloud.emitAgentEvent({ type: 'turn-start', agent: 'codex' });
    window.sidebarPreview.cloud.emitAgentEvent({ type: 'text-delta', agent: 'codex', text: 'Continuing while away.' });
  });
  await page.evaluate(() => window.sidebarPreview.workspace.select('local'));
  await page.waitForFunction(() => window.sidebarPreview.workspace.mode() === 'local');
  await page.evaluate(() => window.sidebarPreview.cloud.finishReply('Cloud completed while Local was open.'));
  await page.evaluate(async () => {
    window.sidebarPreview.workspace.select('cloud');
    await window.sidebarPreview.cloud.controller.refresh(window.sidebarPreview.cloud.getScope());
  });
  await page.waitForFunction(() => window.sidebarPreview.workspace.mode() === 'cloud'
    && document.querySelector('.ag-messages').textContent.includes('Cloud completed while Local was open.'));
  const reconnects = await page.evaluate(() => window.sidebarPreview.cloud.calls.reconnect);
  await page.evaluate(() => window.sidebarPreview.cloud.emitStreamError(false, 'Pair this device again'));
  await page.waitForFunction(() => document.body.textContent.includes('Pair this device again'));
  assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.reconnect), reconnects);
  assert.equal(await page.$eval('.ag-send', (button) => button.disabled), true);
  assert.equal(await page.$eval('.ag-cloud-recovery', (node) => node.hidden), false);
  await page.screenshot({ path: resolve(artifacts, 'cloud-stream-preserved.png') });
}
