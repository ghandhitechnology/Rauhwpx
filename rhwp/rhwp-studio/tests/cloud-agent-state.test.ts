import assert from 'node:assert/strict';
import test from 'node:test';

import { createCloudController, parseCloudSnapshot } from '../src/cloud/desktop-cloud.ts';

const now = '2026-08-23T10:00:00.000Z';

function state(revision: number, session: Record<string, unknown> = { kind: 'idle' }) {
  return {
    revision,
    profileEpoch: 1,
    available: true,
    profile: {
      kind: 'configured',
      profile: {
        name: 'Tailscale VPS',
        host: '100.64.0.8',
        sshUser: 'ubuntu',
        sshPort: 22,
        auth: { kind: 'ssh-agent' },
        transport: { kind: 'tailscale' },
      },
      connection: 'ready',
      serviceVersion: '1.0.0',
      message: null,
    },
    lease: session.kind === 'running'
      ? { owner: 'cloud', sessionId: 'session-1', acquiredAt: now }
      : { owner: 'local' },
    session,
    queuedMessages: [],
    timeline: null,
    updatedAt: now,
  };
}

function running(version = 1) {
  return {
    kind: 'running',
    sessionId: 'session-1',
    version,
    threadId: 'thread-1',
    documentId: 'doc-1',
    documentName: 'cloud.hwpx',
    startedAt: now,
    turn: 3,
    turnLimit: 100,
    elapsedMs: 12_000,
    timeLimitMs: 28_800_000,
    currentActivity: '표를 정리하는 중',
  };
}

test('cloud state parser preserves the cloud lease and bounded running status', () => {
  const parsed = parseCloudSnapshot(state(7, running(4)));
  assert.equal(parsed?.revision, 7);
  assert.equal(parsed?.profile.kind === 'configured' ? parsed.profile.profile.tailscaleHttpsPort : null, 443);
  assert.deepEqual(parsed?.lease, { owner: 'cloud', sessionId: 'session-1', acquiredAt: now });
  assert.equal(parsed?.session.kind, 'running');
  if (parsed?.session.kind === 'running') {
    assert.equal(parsed.session.turnLimit, 100);
    assert.equal(parsed.session.timeLimitMs, 28_800_000);
  }
});

test('cloud state parser preserves a custom Tailscale HTTPS port and rejects invalid values', () => {
  const custom = state(8);
  const withPort = {
    ...custom,
    profile: {
      ...custom.profile,
      profile: { ...custom.profile.profile, tailscaleHttpsPort: 8443 },
    },
  };
  const parsed = parseCloudSnapshot(withPort);
  assert.equal(parsed?.profile.kind === 'configured' ? parsed.profile.profile.tailscaleHttpsPort : null, 8443);
  assert.equal(parseCloudSnapshot({
    ...withPort,
    profile: {
      ...withPort.profile,
      profile: { ...withPort.profile.profile, tailscaleHttpsPort: 65536 },
    },
  }), null);
  assert.equal(parseCloudSnapshot({
    ...withPort,
    profile: {
      ...withPort.profile,
      profile: { ...withPort.profile.profile, tailscaleHttpsPort: '8443' },
    },
  }), null);
});

test('cloud state parser rejects missing, malformed and partially valid snapshots', () => {
  assert.equal(parseCloudSnapshot({}), null);
  assert.equal(parseCloudSnapshot({ ...state(1), available: 'yes' }), null);
  assert.equal(parseCloudSnapshot({ ...state(1), revision: '1' }), null);
  assert.equal(parseCloudSnapshot({ ...state(1), profileEpoch: '1' }), null);
  const { profileEpoch: _profileEpoch, ...stateWithoutEpoch } = state(1);
  assert.equal(parseCloudSnapshot(stateWithoutEpoch), null);
  assert.equal(parseCloudSnapshot({ ...state(1), queuedMessages: [{ id: 'q', text: 'hello' }] }), null);
  assert.equal(parseCloudSnapshot(state(1, { ...running(), elapsedMs: -1 })), null);
  assert.equal(parseCloudSnapshot({ ...state(1), timeline: { schema: 'unknown' } }), null);
  assert.equal(parseCloudSnapshot({ ...state(1, running()), sessions: [running(), running()] }), null);
});

test('cloud state parser requires the frozen takeover operation receipt', () => {
  const timeline = {
    schema: 'rauhwpx.cloud.timeline',
    version: 1,
    exportedAt: now,
    thread: {
      id: 'thread-1',
      title: 'Takeover',
      titleRequested: true,
      createdAt: Date.parse(now),
      updatedAt: Date.parse(now),
      agent: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
      workflow: 'direct',
      docKey: 'cloud.hwpx',
      documentId: 'doc-1',
      activeTemplateId: null,
      messages: [],
    },
  };
  const takeover = { operationId: 'operation-a', document: null, timeline };
  assert.equal(parseCloudSnapshot({ ...state(2), takeover })?.takeover?.operationId, 'operation-a');
  const { operationId: _operationId, ...unkeyed } = takeover;
  assert.equal(parseCloudSnapshot({ ...state(2), takeover: unkeyed }), null);
});

test('controller accepts scoped cross-device events and selects any VPS session', async () => {
  let emit: ((event: unknown) => void) | undefined;
  const calls: unknown[] = [];
  const remote = {
    ...running(5),
    sessionId: 'session-2',
    threadId: 'remote-thread',
    documentId: 'remote-device-doc-id',
    documentName: 'remote-report.hwp',
  };
  const remoteState = {
    ...state(5, remote),
    lease: { owner: 'local' },
    sessions: [running(4), remote],
  };
  const controller = createCloudController({
    cloudGetState: async (payload) => {
      calls.push(payload);
      return { snapshot: remoteState };
    },
    onCloudEvent: (listener) => {
      emit = listener;
      return () => { emit = undefined; };
    },
  });

  await controller.refresh({
    threadId: 'local-thread',
    documentId: 'local-device-doc-id',
    selectedSessionId: 'session-2',
  });
  emit?.({ snapshot: { ...remoteState, revision: 6, session: { ...remote, currentActivity: '새 표를 작성하는 중' } } });
  assert.equal(controller.getSnapshot().revision, 6);
  assert.equal(controller.getSnapshot().session.kind, 'running');
  assert.equal(controller.getSnapshot().session.kind === 'running'
    ? controller.getSnapshot().session.currentActivity
    : '', '새 표를 작성하는 중');
  assert.deepEqual(calls, [{
    threadId: 'local-thread',
    documentId: 'local-device-doc-id',
    selectedSessionId: 'session-2',
  }]);
  controller.dispose();
});

test('controller ignores stale events and uses explicit desktop payloads', async () => {
  let emit: ((event: unknown) => void) | undefined;
  const calls: Array<[string, unknown]> = [];
  const controller = createCloudController({
    cloudGetState: async (payload) => {
      calls.push(['get-state', payload]);
      return { snapshot: state(2, running(2)) };
    },
    cloudSetTransferIntent: async (payload) => {
      calls.push(['intent', payload]);
      return { snapshot: state(2, running(2)) };
    },
    cloudCommand: async (payload) => {
      calls.push(['command', payload]);
      return { snapshot: state(3, running(3)) };
    },
    cloudCompleteTakeover: async (payload) => {
      calls.push(['complete-takeover', payload]);
      return { snapshot: state(3, running(3)) };
    },
    cloudReadReference: async (payload) => {
      calls.push(['reference', payload]);
      return { bytes: new Uint8Array([1, 2, 3]) };
    },
    cloudResolveResult: async (payload) => {
      calls.push(['resolve', payload]);
      return {
        action: 'keep-both',
        path: '/documents/cloud-result.hwpx',
        bytes: new Uint8Array([9, 8, 7]),
        conflict: 'external-change',
        preservedCopyName: 'cloud-result.hwpx',
        snapshot: state(4),
      };
    },
    onCloudEvent: (listener) => {
      emit = listener;
      return () => { emit = undefined; };
    },
  });

  await controller.refresh({ threadId: 'thread-1', documentId: 'doc-1' });
  emit?.({ snapshot: state(1) });
  assert.equal(controller.getSnapshot().revision, 2);
  await controller.setTransferIntent({ pending: true, threadId: 'thread-1', documentId: 'doc-1' });

  await controller.command({
    sessionId: 'session-1',
    command: 'queue-message',
    expectedVersion: 2,
    message: '다음 경계에서 확인해줘',
    messageId: 'message-1',
  });
  await controller.completeTakeover('session-1', 'operation-a');
  const bytes = await controller.readReference({ id: 'ref-1', scope: 'document', scopeId: 'doc-1' });
  const resolution = await controller.resolveResult('session-1', 'replace');

  assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
  assert.equal(resolution.action, 'keep-both');
  assert.equal(resolution.conflict, 'external-change');
  assert.equal(resolution.preservedCopyName, 'cloud-result.hwpx');
  assert.deepEqual(calls, [
    ['get-state', { threadId: 'thread-1', documentId: 'doc-1' }],
    ['intent', { pending: true, threadId: 'thread-1', documentId: 'doc-1' }],
    ['command', {
      sessionId: 'session-1',
      command: 'queue-message',
      expectedVersion: 2,
      message: '다음 경계에서 확인해줘',
      messageId: 'message-1',
    }],
    ['complete-takeover', { sessionId: 'session-1', operationId: 'operation-a' }],
    ['reference', { id: 'ref-1', scope: 'document', scopeId: 'doc-1' }],
    ['resolve', { sessionId: 'session-1', action: 'replace' }],
  ]);
  controller.dispose();
});

test('controller profile epochs fence late snapshots and checkpoint downloads', async () => {
  let emit: ((event: unknown) => void) | undefined;
  const staleSnapshot = Promise.withResolvers<unknown>();
  const staleCheckpoint = Promise.withResolvers<unknown>();
  const controller = createCloudController({
    cloudGetState: () => staleSnapshot.promise,
    cloudDownloadCheckpoint: () => staleCheckpoint.promise,
    onCloudEvent: (listener) => {
      emit = listener;
      return () => { emit = undefined; };
    },
  });
  const refresh = controller.refresh({ threadId: 'thread-a', documentId: 'document-a' });
  emit?.({ snapshot: { ...state(2), profileEpoch: 2 } });
  staleSnapshot.resolve({ snapshot: { ...state(3), profileEpoch: 1 } });
  await assert.rejects(refresh, { code: 'PROFILE_CHANGED' });
  assert.equal(controller.getSnapshot().profileEpoch, 2);

  const download = controller.downloadCheckpoint('session-a', 'operation-a');
  emit?.({ snapshot: { ...state(3), profileEpoch: 3 } });
  staleCheckpoint.resolve({
    sessionId: 'session-a', documentId: 'document-a', kind: 'turn', fileName: 'document.hwpx',
    bytes: new Uint8Array([1]), byteLength: 1, sha256: 'a'.repeat(64), revision: 1, turn: 1,
    operationId: 'operation-a',
  });
  await assert.rejects(download, { code: 'PROFILE_CHANGED' });
  assert.equal(controller.getSnapshot().profileEpoch, 3);
  controller.dispose();
});

test('controller dispatches only current-profile events from desktop batches', () => {
  let emit: ((event: unknown) => void) | undefined;
  const controller = createCloudController({
    onCloudEvent: (listener) => {
      emit = listener;
      return () => { emit = undefined; };
    },
  });
  const events: unknown[] = [];
  controller.subscribeEvents((event) => events.push(event));
  emit?.({
    type: 'cloud-event-batch',
    snapshot: { ...state(2), profileEpoch: 2 },
    events: [
      { type: 'session-event', profileEpoch: 1, sessionId: 'session-a' },
      { type: 'session-event', profileEpoch: 2, sessionId: 'session-b' },
    ],
  });
  assert.deepEqual(events, [
    { type: 'session-event', profileEpoch: 2, sessionId: 'session-b' },
  ]);
  controller.dispose();
});

test('controller rejects malformed and contradictory result resolutions', async () => {
  const malformed = createCloudController({
    cloudResolveResult: async () => ({
      action: 'replace',
      path: null,
      bytes: null,
      conflict: 'external-change',
      preservedCopyName: null,
      snapshot: state(2),
    }),
  });
  await assert.rejects(
    malformed.resolveResult('session-1', 'replace'),
    /결과 반영 정보가 올바르지 않습니다/,
  );
  malformed.dispose();
});
