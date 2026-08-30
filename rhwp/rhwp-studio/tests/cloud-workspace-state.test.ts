import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudWorkspaceState } from '../src/cloud/workspace-state.ts';
import type { PortableCloudTimelineV1 } from '../src/cloud/timeline.ts';
import type { CloudSessionState, CloudSnapshot } from '../src/cloud/types.ts';

const now = '2026-08-30T00:00:00.000Z';

function session(sessionId: string, version: number, threadId = `thread-${sessionId}`): Exclude<CloudSessionState, { kind: 'idle' }> {
  return {
    kind: 'running',
    sessionId,
    version,
    threadId,
    documentId: `doc-${sessionId}`,
    documentName: `${sessionId}.hwpx`,
    startedAt: now,
    turn: version,
    turnLimit: 100,
    elapsedMs: version * 1000,
    timeLimitMs: 8 * 60 * 60 * 1000,
    currentActivity: `${sessionId}-${version}`,
    phase: 'waiting',
    wait: null,
  };
}

function timeline(threadId: string, updatedAt: number): PortableCloudTimelineV1 {
  return {
    schema: 'rauhwpx.cloud.timeline',
    version: 1,
    exportedAt: new Date(updatedAt).toISOString(),
    thread: {
      id: threadId,
      title: threadId,
      titleRequested: true,
      createdAt: 1,
      updatedAt,
      agent: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      workflow: 'direct',
      docKey: `${threadId}.hwpx`,
      documentId: `doc-${threadId}`,
      activeTemplateId: null,
      messages: [],
    },
  };
}

function snapshot(
  revision: number,
  selected: Exclude<CloudSessionState, { kind: 'idle' }>,
  sessions: Exclude<CloudSessionState, { kind: 'idle' }>[] = [selected],
  selectedTimeline: PortableCloudTimelineV1 | null = null,
): CloudSnapshot {
  return {
    revision,
    available: true,
    profile: { kind: 'unconfigured' },
    server: { mode: null, preferredMode: null, providers: [], lifecycle: 'idle', message: null },
    lease: { owner: 'cloud', sessionId: 'origin-session', acquiredAt: now },
    session: selected,
    sessions,
    queuedMessages: [{ id: `queue-${revision}`, text: `revision ${revision}`, queuedAt: now, state: 'queued' }],
    timeline: selectedTimeline,
    updatedAt: now,
  };
}

test('workspace binding moves atomically between local and selected cloud sessions', () => {
  const state = new CloudWorkspaceState();

  assert.deepEqual(state.getBinding(), { kind: 'local' });
  const first = state.beginCloud('session-a');
  const firstSession = session('session-a', 1);
  state.observeSnapshot(snapshot(1, firstSession));
  assert.equal(state.isTransitioning(), true);
  assert.deepEqual(state.getBinding(), { kind: 'local' });
  assert.deepEqual(state.commit(first, snapshot(1, firstSession))?.binding, first.binding);
  assert.equal(state.matches(first.binding), true);
  assert.deepEqual(state.getBinding(), first.binding);

  state.selectLocal();
  assert.deepEqual(state.getBinding(), { kind: 'local' });
  assert.equal(state.matches(first.binding), false);
});

test('workspace binding rejects stale generations and another selected session', () => {
  const state = new CloudWorkspaceState();
  const first = state.beginCloud('session-a');
  const second = state.beginCloud('session-a');
  const selected = session('session-a', 2);

  assert.equal(state.matchesPending(first), false);
  assert.equal(state.commit(first, snapshot(2, selected)), null);
  assert.equal(state.matchesPending(second), true);
  state.observeSnapshot(snapshot(2, selected));
  assert.deepEqual(state.commit(second, snapshot(2, selected))?.binding, second.binding);

  const third = state.beginCloud('session-b');
  assert.equal(state.matches(second.binding), true, 'committed workspace remains active while staging');
  assert.equal(state.cancel(third), true);
  assert.equal(state.matches(second.binding), true);
});

test('workspace commit combines the newest global shell with the newest selected scope', () => {
  const state = new CloudWorkspaceState();
  const selectedV4 = session('session-a', 4);
  const selectedV6 = session('session-a', 6);
  const unrelatedV7 = session('session-b', 7);
  const receipt = state.beginCloud('session-a');

  state.observeSnapshot(snapshot(4, selectedV4, [selectedV4, unrelatedV7], timeline(selectedV4.threadId, 4)));
  state.observeSnapshot(snapshot(6, selectedV6, [selectedV6, unrelatedV7], timeline(selectedV6.threadId, 6)));
  state.observeSnapshot(snapshot(7, unrelatedV7, [selectedV6, unrelatedV7], timeline(unrelatedV7.threadId, 7)));

  const latestGlobal = {
    ...snapshot(7, unrelatedV7, [selectedV6, unrelatedV7], timeline(unrelatedV7.threadId, 7)),
    lease: { owner: 'local' as const },
  };
  const committed = state.commit(receipt, latestGlobal);

  assert.equal(committed?.snapshot.revision, 7);
  assert.deepEqual(committed?.snapshot.lease, { owner: 'local' });
  assert.equal(committed?.snapshot.session.kind === 'running' ? committed.snapshot.session.version : null, 6);
  assert.equal(committed?.snapshot.timeline?.thread.updatedAt, 6);
  assert.deepEqual(committed?.snapshot.queuedMessages, [{
    id: 'queue-6', text: 'revision 6', queuedAt: now, state: 'queued',
  }]);
});

test('workspace commit fails closed when the selected session disappears', () => {
  const state = new CloudWorkspaceState();
  const selected = session('session-a', 1);
  const other = session('session-b', 2);
  const receipt = state.beginCloud('session-a');
  state.observeSnapshot(snapshot(1, selected));

  assert.equal(state.commit(receipt, snapshot(2, other, [other])), null);
  assert.deepEqual(state.getBinding(), { kind: 'local' });
  assert.equal(state.matchesPending(receipt), true);
});
