import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkCloudMergeRecovery(page, origin, artifacts) {
  await page.goto(`${origin}/?reset=1`, { waitUntil: 'networkidle0' });
  const result = await page.evaluate(async () => {
    const { createCloudAgentUi } = await import('/src/ui/agent-sidebar/cloud-ui.ts');
    const { createMockCloud } = await import('/src/sidebar-preview/mock-cloud.ts');
    const mock = createMockCloud();
    await mock.controller.refresh({ documentId: 'doc-recovered', threadId: 'local-thread' });
    let snapshot = mock.controller.getSnapshot();
    const request = { sessionId: 'old-worker-session', documentId: 'doc-recovered', threadId: 'old-thread',
      cloudStartId: 'durable-start', operationId: 'turn-op-4', revision: 4, turn: 4, kind: 'turn',
      fileName: 'recovered.hwpx', sha256: 'a'.repeat(64), size: 3, localAvailable: true };
    snapshot = { ...snapshot, mergeRequests: [request], session: { kind: 'idle' }, sessions: [], timeline: null,
      link: { kind: 'failed', error: 'Worker deleted', attempt: 1, canRecreate: true } };
    const listeners = new Set();
    let scope = { documentId: 'doc-recovered', threadId: 'local-thread' };
    const merged = new Set();
    const errors = [];
    const downloads = [];
    const applies = [];
    let releaseQuery;
    let holdQuery = false;
    const deps = {
      controller: { ...mock.controller, getSnapshot: () => snapshot,
        refresh: async () => snapshot,
        subscribe: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
        subscribeEvents: () => () => {},
        downloadCheckpoint: async (...args) => { downloads.push(args); return { ...request, byteLength: 3, bytes: new Uint8Array([1, 2, 3]) }; } },
      getScope: () => scope, isCloudMode: () => false,
      onRequestTransfer() {}, onCancelPendingTransfer() {}, onWorkspaceSwitchVisibilityChange() {},
      onCloseSettings() {}, onLeaseChange() {}, onWorkspaceLock: () => ({ release() {} }),
      onBeginAuthorityTransition: () => ({ release() {} }), onCloudBinding() {}, onTimeline: () => true,
      onAgentEvent() {}, onCheckpointPublished() {}, onResultResolved() {}, onBeforeTakeover: async () => true,
      onTakeover: async () => null, onTakeoverSettled() {}, onError: (message) => errors.push(message),
      isCloudCheckpointMerged: async (offer) => holdQuery ? await new Promise((resolve) => { releaseQuery = resolve; }) : merged.has(offer.operationId),
      onMergeCheckpoint: async (startId, checkpoint) => { applies.push(startId); merged.add(checkpoint.operationId); return true; },
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    let ui = createCloudAgentUi(deps);
    await tick();
    const recovered = !ui.mergeButton.hidden && !ui.mergeButton.disabled;
    scope = { ...scope, documentId: 'other-doc' };
    await ui.refreshLeaseScope();
    const otherDocumentHidden = ui.mergeButton.hidden;
    scope = { ...scope, documentId: 'doc-recovered' };
    await ui.refreshLeaseScope();
    ui.mergeButton.click();
    await tick();
    const reviewedHidden = ui.mergeButton.hidden;
    ui.dispose();
    ui = createCloudAgentUi(deps);
    await tick();
    const reopenedHidden = ui.mergeButton.hidden;
    ui.dispose();
    merged.clear();
    holdQuery = true;
    ui = createCloudAgentUi(deps);
    await tick();
    const oldQuery = releaseQuery;
    snapshot = { ...snapshot, account: { ...snapshot.account, account: { id: 'different-account', email: 'other@example.test' } }, mergeRequests: [] };
    for (const listener of listeners) listener(snapshot);
    oldQuery(true);
    await tick();
    const accountHidden = ui.mergeButton.hidden;
    holdQuery = false;
    snapshot = { ...snapshot, mergeRequests: [request] };
    for (const listener of listeners) listener(snapshot);
    await tick();
    const accountReviewIsolated = !ui.mergeButton.hidden;
    snapshot = { ...snapshot, mergeRequests: [] };
    for (const listener of listeners) listener(snapshot);
    const expiredHidden = ui.mergeButton.hidden;
    snapshot = { ...snapshot, mergeRequests: [request] };
    for (const listener of listeners) listener(snapshot);
    snapshot = { ...snapshot, profileEpoch: snapshot.profileEpoch + 1, mergeRequests: [] };
    for (const listener of listeners) listener(snapshot);
    const profileHidden = ui.mergeButton.hidden;
    ui.dispose();
    snapshot = { ...snapshot, mergeRequests: [request] };
    const evidenceUi = createCloudAgentUi(deps);
    const host = document.querySelector('.ag-composer') ?? document.body;
    host.append(evidenceUi.recoveryStrip, evidenceUi.mergeButton);
    await tick();
    window.cleanupMergeEvidence = () => { evidenceUi.dispose(); evidenceUi.recoveryStrip.remove(); evidenceUi.mergeButton.remove(); mock.controller.dispose(); };
    return { recovered, otherDocumentHidden, reviewedHidden, reopenedHidden, accountHidden,
      accountReviewIsolated, profileHidden, expiredHidden, errors, downloads, applies };
  });
  assert.equal(result.recovered, true, 'A durable offer survives an idle snapshot and deleted worker');
  assert.equal(result.otherDocumentHidden, true);
  assert.equal(result.reviewedHidden, true);
  assert.equal(result.reopenedHidden, true, 'Version ancestry keeps an integrated offer hidden after reopen');
  assert.equal(result.accountHidden, true);
  assert.equal(result.accountReviewIsolated, true, 'An old account query cannot mark the new account offer reviewed');
  assert.equal(result.profileHidden, true);
  assert.equal(result.expiredHidden, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.downloads, [['old-worker-session', 'turn-op-4', 'turn']]);
  assert.deepEqual(result.applies, ['durable-start']);
  if (artifacts) await page.screenshot({ path: resolve(artifacts, 'cloud-durable-merge-recovery.png') });
  await page.evaluate(() => window.cleanupMergeEvidence());
}
