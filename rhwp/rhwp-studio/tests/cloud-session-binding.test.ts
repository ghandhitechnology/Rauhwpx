import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloudBoundaryOperation,
  cloudEventMatchesBinding,
  cloudTimelineBinding,
  createSessionSelectionFence,
  runCloudSessionSelection,
} from '../src/cloud/session-binding.ts';
import type { PortableCloudTimelineV1 } from '../src/cloud/timeline.ts';
import type { CloudSessionState } from '../src/cloud/types.ts';

function running(sessionId: string, threadId: string, documentId: string): CloudSessionState {
  return {
    kind: 'running',
    sessionId,
    version: 9,
    threadId,
    documentId,
    documentName: `${sessionId}.hwpx`,
    startedAt: '2026-08-30T00:00:00.000Z',
    turn: 1,
    turnLimit: 20,
    elapsedMs: 1,
    timeLimitMs: 60_000,
    currentActivity: 'editing',
    phase: 'working',
    wait: null,
  };
}

function timeline(threadId: string): PortableCloudTimelineV1 {
  return {
    schema: 'rauhwpx.cloud.timeline',
    version: 1,
    exportedAt: '2026-08-30T00:00:00.000Z',
    thread: {
      id: threadId,
      title: threadId,
      titleRequested: true,
      createdAt: 1,
      updatedAt: 2,
      agent: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
      workflow: 'direct',
      docKey: `${threadId}.hwpx`,
      documentId: `document-${threadId}`,
      activeTemplateId: null,
      messages: [],
    },
  };
}

test('boundary operations route by session before transcript selection', () => {
  assert.deepEqual(cloudBoundaryOperation({
    sessionId: 'session-document-a',
    event: {
      type: 'boundary.committed',
      payload: { operationId: 'turn_4_document_a' },
    },
  }), {
    sessionId: 'session-document-a',
    operationId: 'turn_4_document_a',
  });
  assert.equal(cloudBoundaryOperation({
    sessionId: 'session-document-a',
    event: { type: 'agent.event', payload: {} },
  }), null);
});

test('only the latest session selection may mount its transcript', () => {
  const fence = createSessionSelectionFence();
  const selectionA = fence.begin();
  const selectionB = fence.begin();
  assert.equal(selectionA(), false);
  assert.equal(selectionB(), true);
  fence.invalidate();
  assert.equal(selectionB(), false);
});

test('selection race mounts only B and failed refresh rolls the picker back while locked', async () => {
  const fence = createSessionSelectionFence();
  const refreshA = Promise.withResolvers<string>();
  const refreshB = Promise.withResolvers<string>();
  const events: string[] = [];
  const run = (name: string, refresh: Promise<string>) => runCloudSessionSelection({
    acquire: () => {
      events.push(`lock:${name}`);
      return { release: () => events.push(`release:${name}`) };
    },
    begin: fence.begin,
    select: () => events.push(`select:${name}`),
    refresh: () => refresh,
    mount: (value) => {
      events.push(`mount:${value}`);
      return true;
    },
    rollback: () => events.push(`rollback:${name}`),
  });
  const selectionA = run('A', refreshA.promise);
  const selectionB = run('B', refreshB.promise);
  assert.deepEqual(events, ['lock:A', 'select:A', 'lock:B', 'select:B']);
  refreshA.resolve('A');
  assert.equal(await selectionA, false);
  assert.equal(events.includes('mount:A'), false);
  refreshB.resolve('B');
  assert.equal(await selectionB, true);
  assert.equal(events.includes('mount:B'), true);

  const failed = run('C', Promise.reject(new Error('refresh failed')));
  await assert.rejects(failed, /refresh failed/);
  assert.ok(events.indexOf('rollback:C') < events.indexOf('release:C'));
});

test('failed mount restores the committed controller scope before releasing the selection lock', async () => {
  let controllerScope = 'A';
  const ui = {
    picker: 'A',
    workspaceBinding: 'A',
    displayContext: 'A',
    transcript: 'A',
    composer: 'A',
  };
  let broadcastsFenced = false;
  const events: string[] = [];
  const listeners = new Set<(scope: string) => void>();
  listeners.add((scope) => {
    if (!broadcastsFenced) {
      ui.workspaceBinding = scope;
      ui.displayContext = scope;
      ui.transcript = scope;
      ui.composer = scope;
    }
    events.push(`broadcast:${scope}:${broadcastsFenced ? 'fenced' : 'open'}`);
  });
  const controller = {
    async refresh(scope: string) {
      controllerScope = scope;
      for (const listener of listeners) listener(scope);
      return scope;
    },
  };

  await assert.rejects(runCloudSessionSelection({
    acquire: () => {
      broadcastsFenced = true;
      events.push('lock');
      return { release: () => {
        events.push(`release:${controllerScope}:${Object.values(ui).join(':')}`);
        broadcastsFenced = false;
      } };
    },
    begin: createSessionSelectionFence().begin,
    select: () => { ui.picker = 'B'; },
    refresh: () => controller.refresh('B'),
    mount: () => { throw new Error('timeline rejected'); },
    rollback: async () => {
      ui.picker = 'A';
      const restored = await controller.refresh('A');
      ui.workspaceBinding = restored;
      ui.displayContext = restored;
      ui.transcript = restored;
      ui.composer = restored;
      events.push(`remount:${restored}`);
    },
  }), /timeline rejected/);

  assert.equal(controllerScope, 'A');
  assert.deepEqual(ui, {
    picker: 'A',
    workspaceBinding: 'A',
    displayContext: 'A',
    transcript: 'A',
    composer: 'A',
  });
  assert.deepEqual(events, [
    'lock',
    'broadcast:B:fenced',
    'broadcast:A:fenced',
    'remount:A',
    'release:A:A:A:A:A:A',
  ]);
});

test('timeline and live events require the same selected session and mounted thread', () => {
  const sessionA = running('session-a', 'thread-a', 'document-a');
  const sessionB = running('session-b', 'thread-b', 'document-b');
  const bindingA = cloudTimelineBinding(sessionA, timeline('thread-a'));
  assert.deepEqual(bindingA, {
    sessionId: 'session-a',
    threadId: 'thread-a',
    documentId: 'document-a',
  });
  assert.equal(cloudTimelineBinding(sessionB, timeline('thread-a')), null);
  assert.equal(cloudEventMatchesBinding(bindingA, 'session-a', 'thread-a'), true);
  assert.equal(cloudEventMatchesBinding(bindingA, 'session-b', 'thread-a'), false);
  assert.equal(cloudEventMatchesBinding(bindingA, 'session-a', 'thread-b'), false);
});

test('a delayed selected timeline establishes the missing binding and routes only its events', () => {
  const sessionB = running('session-b', 'thread-b', 'document-b');
  assert.equal(cloudTimelineBinding(sessionB, null), null);

  const bindingB = cloudTimelineBinding(sessionB, timeline('thread-b'));
  assert.ok(bindingB);
  assert.equal(cloudEventMatchesBinding(bindingB, 'session-b', 'thread-b'), true);
  assert.equal(cloudEventMatchesBinding(bindingB, 'session-a', 'thread-a'), false);
});

test('a failed selection restores the previous workspace and releases its execution lock', async () => {
  const events: string[] = [];
  await assert.rejects(runCloudSessionSelection({
    acquire: () => ({ release: () => events.push('release') }),
    begin: createSessionSelectionFence().begin,
    select: () => { throw new Error('selection failed'); },
    refresh: async () => { events.push('refresh'); },
    mount: () => true,
    rollback: () => { events.push('rollback'); },
  }), /selection failed/);
  assert.deepEqual(events, ['rollback', 'release']);
});
