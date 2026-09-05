import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatThread } from '../src/agent/threads.ts';
import {
  buildCloudStartTransfer,
  CLOUD_UNSAVED_MESSAGE,
  cloudDocumentOwner,
  cloudStartPhaseFromSession,
  cloudStartPhaseLabel,
  goalFromInitialMessage,
  isCloudSupportedAgent,
  validateCloudStartDocument,
} from '../src/cloud/cloud-start.ts';
import { exportCloudTimeline, initialMessageMatchesTimeline } from '../src/cloud/timeline.ts';
import type { CloudSessionState, CloudSnapshot } from '../src/cloud/types.ts';

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-start',
    title: '새 채팅',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    serviceTier: 'standard',
    workflow: 'direct',
    docKey: 'memo.hwpx',
    documentId: 'doc-start',
    activeTemplateId: null,
    messages: [{
      role: 'user',
      text: '표 제목을 고쳐줘',
      messageId: 'msg-1',
    }],
    ...overrides,
  };
}

function snapshot(session: CloudSessionState, extras: Partial<CloudSnapshot> = {}): CloudSnapshot {
  return {
    revision: 1,
    profileEpoch: 1,
    available: true,
    profile: { kind: 'unconfigured' },
    server: { mode: null, preferredMode: null, providers: [], lifecycle: 'idle', message: null },
    lease: { owner: 'local' },
    session,
    sessions: session.kind === 'idle' ? [] : [session],
    queuedMessages: [],
    timeline: null,
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...extras,
  };
}

test('never-saved and unsupported documents reject Cloud start but dirty saved snapshots can transfer', () => {
  assert.deepEqual(validateCloudStartDocument({
    hasDocument: true,
    isNew: true,
    isDirty: false,
    format: 'hwpx',
  }), { ok: false, reason: 'unsaved', message: CLOUD_UNSAVED_MESSAGE });
  assert.deepEqual(validateCloudStartDocument({
    hasDocument: true,
    isNew: false,
    isDirty: true,
    format: 'hwpx',
  }), { ok: true, format: 'hwpx' });
  assert.equal(validateCloudStartDocument({
    hasDocument: true,
    isNew: false,
    isDirty: false,
    format: 'rhwpx',
  }).ok, false);
  assert.deepEqual(validateCloudStartDocument({
    hasDocument: true,
    isNew: false,
    isDirty: false,
    format: 'hwpx',
  }), { ok: true, format: 'hwpx' });
});

test('goal text comes from the explicit first message, not a title fallback', () => {
  assert.equal(goalFromInitialMessage('  첫 지시  '), '첫 지시');
  const built = buildCloudStartTransfer({
    startId: 'start-1',
    thread: thread(),
    initialMessage: { id: 'msg-1', text: '표 제목을 고쳐줘', attachmentReferenceIds: [] },
    document: { bytes: new Uint8Array([1, 2, 3]), fileName: 'memo.hwpx', sha256: 'a'.repeat(64) },
    references: [],
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    workflow: 'direct',
  });
  assert.equal(built.startId, 'start-1');
  assert.equal(built.initialMessage.id, 'msg-1');
  assert.equal(goalFromInitialMessage(built.initialMessage.text), '표 제목을 고쳐줘');
  assert.equal(initialMessageMatchesTimeline(built.timeline, 'msg-1'), true);
});

test('transfer build rejects a first message that is missing or duplicated in the timeline', () => {
  assert.throws(() => buildCloudStartTransfer({
    startId: 'start-1',
    thread: thread({ messages: [] }),
    initialMessage: { id: 'msg-1', text: '표 제목을 고쳐줘', attachmentReferenceIds: [] },
    document: { bytes: new Uint8Array([1]), fileName: 'memo.hwpx', sha256: 'b'.repeat(64) },
    references: [],
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    workflow: 'direct',
  }), /한 번만 기록되지 않았습니다/);

  const duplicate = thread({
    messages: [
      { role: 'user', text: '표 제목을 고쳐줘', messageId: 'msg-1' },
      { role: 'user', text: '표 제목을 고쳐줘', messageId: 'msg-1' },
    ],
  });
  assert.equal(initialMessageMatchesTimeline(exportCloudTimeline(duplicate), 'msg-1'), false);
});

test('another active Cloud conversation on the same document blocks a new start', () => {
  const running: CloudSessionState = {
    kind: 'running',
    sessionId: 'session-owner',
    version: 3,
    threadId: 'thread-owner',
    documentId: 'doc-start',
    documentName: 'memo.hwpx',
    startedAt: '2026-08-31T00:00:00.000Z',
    turn: 1,
    turnLimit: 20,
    elapsedMs: 10,
    timeLimitMs: 60_000,
    currentActivity: 'editing',
    phase: 'working',
    wait: null,
  };
  assert.deepEqual(cloudDocumentOwner(snapshot(running), 'doc-start'), {
    sessionId: 'session-owner',
    threadId: 'thread-owner',
  });
  assert.equal(cloudDocumentOwner(snapshot({ kind: 'idle' }), 'doc-start'), null);
  assert.equal(cloudDocumentOwner(snapshot(running), 'doc-other'), null);
});

test('startup phases map onto one placeholder label', () => {
  assert.equal(cloudStartPhaseLabel('preparing-document'), '문서를 준비하는 중');
  assert.equal(cloudStartPhaseFromSession({
    kind: 'transferring',
    sessionId: 's',
    version: 1,
    threadId: 't',
    documentId: 'd',
    documentName: 'memo.hwpx',
    stage: 'uploading',
    completedBytes: 1,
    totalBytes: 2,
    message: 'uploading',
  }), 'uploading');
  assert.equal(cloudStartPhaseFromSession({
    kind: 'queued',
    sessionId: 's',
    version: 1,
    threadId: 't',
    documentId: 'd',
    documentName: 'memo.hwpx',
    position: 1,
    message: 'queued',
  }), 'queued');
});


test('Cloud provider support rejects local-only providers before transfer and preserves Astra selection', () => {
  for (const agent of ['claude', 'codex', 'pi', 'grok', 'cursor'] as const) {
    assert.equal(isCloudSupportedAgent(agent), true);
  }
  const input = {
    startId: 'start-astra',
    thread: thread(),
    initialMessage: { id: 'msg-1', text: '표 제목을 고쳐줘', attachmentReferenceIds: [] },
    document: { bytes: new Uint8Array([1]), fileName: 'memo.hwpx', sha256: 'a'.repeat(64) },
    references: [],
    agent: 'codex' as const,
    model: 'gpt-6-astra',
    effort: 'max',
    workflow: 'question' as const,
  };
  const transfer = buildCloudStartTransfer(input);
  assert.equal(transfer.model, 'gpt-6-astra');
  assert.equal(transfer.effort, 'max');
  assert.equal(transfer.workflow, 'question');
  for (const agent of ['opencode', 'rau'] as const) {
    assert.equal(isCloudSupportedAgent(agent), false);
    assert.throws(() => buildCloudStartTransfer({ ...input, agent }), /Cloud does not support/);
  }
});
