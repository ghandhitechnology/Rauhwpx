import assert from 'node:assert/strict';
import test from 'node:test';

import type { CloudController } from '../src/cloud/desktop-cloud.ts';
import {
  canSelectCloudWorkspace,
  composerExecution,
  createWorkspaceController,
  deriveComposerTarget,
  disposeCloudDependencies,
  type CloudWorkspace,
} from '../src/cloud/workspace.ts';
import type { CloudSessionState, CloudSnapshot } from '../src/cloud/types.ts';

class TestElement {
  id = '';
  inert = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: TestElement[] = [];
  parentElement: TestElement | null = null;
  ownerDocument: TestDocument;
  attributes = new Map<string, string>();

  constructor(ownerDocument: TestDocument) {
    this.ownerDocument = ownerDocument;
  }

  get parentNode(): TestElement | null {
    return this.parentElement;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: TestElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node: TestElement): TestElement {
    node.parentElement?.removeChild(node);
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  insertBefore(node: TestElement, reference: TestElement): TestElement {
    const index = this.children.indexOf(reference);
    assert.notEqual(index, -1);
    node.parentElement?.removeChild(node);
    node.parentElement = this;
    this.children.splice(index, 0, node);
    return node;
  }

  removeChild(node: TestElement): void {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentElement = null;
  }
}

class TestDocument {
  createElement(): TestElement {
    return new TestElement(this);
  }
}

const baseSession = {
  sessionId: 'session-workspace-01',
  version: 17,
  threadId: 'thread-workspace-01',
  documentId: 'document-workspace-01',
  documentName: 'workspace.hwpx',
};

const sessions: CloudSessionState[] = [
  { kind: 'idle' },
  { ...baseSession, kind: 'waiting-local-turn', message: 'waiting' },
  {
    ...baseSession,
    kind: 'transferring',
    stage: 'uploading',
    completedBytes: 1,
    totalBytes: 2,
    message: 'transferring',
  },
  { ...baseSession, kind: 'queued', position: 1, message: 'queued' },
  {
    ...baseSession,
    kind: 'running',
    startedAt: '2026-08-30T00:00:00.000Z',
    turn: 2,
    turnLimit: 20,
    elapsedMs: 1_000,
    timeLimitMs: 60_000,
    currentActivity: 'editing',
    phase: 'working',
    wait: null,
  },
  { ...baseSession, kind: 'pausing', message: 'pausing' },
  { ...baseSession, kind: 'suspended', reason: 'paused', resumable: true },
  { ...baseSession, kind: 'taking-over', message: 'taking over' },
  {
    ...baseSession,
    kind: 'completed',
    completedAt: '2026-08-30T00:01:00.000Z',
    result: {
      fileName: 'workspace.hwpx',
      byteLength: 1,
      sha256: 'a'.repeat(64),
      downloaded: true,
      availableOnThisDevice: true,
      expiresAt: null,
      conflict: 'none',
      preservedCopyName: null,
    },
  },
  { ...baseSession, kind: 'failed', code: 'FAILED', message: 'failed', retryable: true },
  { ...baseSession, kind: 'cancelled', cancelledAt: '2026-08-30T00:01:00.000Z' },
];

function snapshot(session: CloudSessionState, cloudLease = false): CloudSnapshot {
  return {
    revision: 1,
    profileEpoch: 1,
    available: true,
    profile: { kind: 'unconfigured' },
    server: {
      mode: null,
      preferredMode: null,
      providers: [],
      lifecycle: 'idle',
      message: null,
    },
    lease: cloudLease
      ? { owner: 'cloud', sessionId: baseSession.sessionId, acquiredAt: '2026-08-30T00:00:00.000Z' }
      : { owner: 'local' },
    session,
    sessions: session.kind === 'idle' ? [] : [session],
    queuedMessages: [],
    timeline: null,
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

test('every workspace mode derives its composer target from the lease and selected session', () => {
  for (const session of sessions) {
    assert.deepEqual(deriveComposerTarget('local', snapshot(session)), { kind: 'local-ready' });
    assert.deepEqual(deriveComposerTarget('local', snapshot(session, true)), {
      kind: 'local-blocked',
      reason: 'cloud-lease',
      message: 'Cloud 작업이 문서를 사용 중입니다. Cloud로 전환하거나 이 기기에서 이어받으세요.',
    });

    const cloudTarget = deriveComposerTarget('cloud', snapshot(session));
    if (session.kind === 'idle') {
      assert.equal(cloudTarget.kind, 'cloud-blocked');
      if (cloudTarget.kind === 'cloud-blocked') assert.equal(cloudTarget.reason, 'no-session');
    } else if (session.kind === 'running') {
      assert.deepEqual(cloudTarget, {
        kind: 'cloud-blocked',
        reason: 'timeline-unavailable',
        message: 'Cloud 대화를 연결하는 중입니다.',
      });
      assert.deepEqual(deriveComposerTarget('cloud', snapshot(session), {
        sessionId: baseSession.sessionId,
        threadId: baseSession.threadId,
        documentId: baseSession.documentId,
      }), {
        kind: 'cloud-ready',
        sessionId: baseSession.sessionId,
        threadId: baseSession.threadId,
        documentId: baseSession.documentId,
        expectedVersion: 17,
      });
    } else {
      assert.equal(cloudTarget.kind, 'cloud-blocked');
      if (cloudTarget.kind === 'cloud-blocked') assert.equal(cloudTarget.reason, 'not-accepting-messages');
    }
    assert.deepEqual(deriveComposerTarget('cloud', snapshot(session, true)), cloudTarget);
  }
});

test('composer execution keeps local and cloud routing explicit and leaves blocked drafts to the caller', () => {
  assert.deepEqual(composerExecution({ kind: 'local-ready' }), { kind: 'local' });
  assert.deepEqual(composerExecution({
    kind: 'cloud-ready',
    sessionId: 'session-workspace-01',
    threadId: 'thread-workspace-01',
    documentId: 'document-workspace-01',
    expectedVersion: 31,
  }), {
    kind: 'cloud',
    sessionId: 'session-workspace-01',
    threadId: 'thread-workspace-01',
    documentId: 'document-workspace-01',
    expectedVersion: 31,
  });
  assert.deepEqual(composerExecution({
    kind: 'local-blocked',
    reason: 'cloud-lease',
    message: 'draft stays',
  }), { kind: 'blocked', message: 'draft stays' });
});

test('an active Local turn cannot expose a Cloud composer target before authoritative turn-end', () => {
  const running = sessions.find((session) => session.kind === 'running')!;
  const binding = {
    sessionId: baseSession.sessionId,
    threadId: baseSession.threadId,
    documentId: baseSession.documentId,
  };
  let mode: 'local' | 'cloud' = 'local';
  const selectCloud = (localTurnRunning: boolean) => {
    if (canSelectCloudWorkspace(mode, localTurnRunning)) mode = 'cloud';
    return deriveComposerTarget(mode, snapshot(running), binding);
  };

  assert.equal(canSelectCloudWorkspace('local', true), false);
  assert.deepEqual(selectCloud(true), { kind: 'local-ready' });
  assert.equal(mode, 'local');

  assert.equal(canSelectCloudWorkspace('local', false), true);
  assert.equal(selectCloud(false).kind, 'cloud-ready');
  assert.equal(mode, 'cloud');
});

test('workspace controller mounts sibling roots, updates atomically, and cleans up once', () => {
  const doc = new TestDocument();
  const parent = doc.createElement();
  const localRoot = doc.createElement();
  localRoot.id = 'editor-area';
  const statusBar = doc.createElement();
  statusBar.id = 'status-bar';
  parent.append(localRoot, statusBar);
  const cloudRoot = doc.createElement();
  cloudRoot.id = 'cloud-workspace';
  let current = snapshot({ kind: 'idle' });
  const cloudListeners = new Set<(next: CloudSnapshot) => void>();
  let contextCalls = 0;
  let workspaceDisposals = 0;
  const cloudWorkspace: CloudWorkspace = {
    root: cloudRoot as unknown as HTMLElement,
    setContext() { contextCalls += 1; },
    getState: () => ({
      kind: 'unavailable',
      reason: 'session-not-running',
      message: 'idle',
    }),
    subscribe: () => () => {},
    dispose() { workspaceDisposals += 1; },
  };
  const cloud = {
    getSnapshot: () => current,
    subscribe(listener: (next: CloudSnapshot) => void) {
      cloudListeners.add(listener);
      listener(current);
      return () => cloudListeners.delete(listener);
    },
  } as Pick<CloudController, 'getSnapshot' | 'subscribe'>;

  const workspace = createWorkspaceController({
    localRoot: localRoot as unknown as HTMLElement,
    cloudWorkspace,
    cloud,
  });
  const stack = parent.children[0]!;
  assert.equal(stack.id, 'workspace-stack');
  assert.deepEqual(stack.children, [localRoot, cloudRoot]);
  assert.equal(parent.children[1], statusBar);
  assert.equal(localRoot.getAttribute('aria-hidden'), 'false');
  assert.equal(cloudRoot.getAttribute('aria-hidden'), 'true');

  const notices: string[] = [];
  const unsubscribe = workspace.subscribe((mode, target) => notices.push(`${mode}:${target.kind}`));
  workspace.select('cloud');
  assert.equal(localRoot.getAttribute('aria-hidden'), 'true');
  assert.equal(cloudRoot.getAttribute('aria-hidden'), 'false');
  assert.equal(workspace.composerTarget().kind, 'cloud-blocked');

  current = snapshot(sessions.find((session) => session.kind === 'running')!);
  for (const listener of cloudListeners) listener(current);
  workspace.bindCloud({
    sessionId: baseSession.sessionId,
    threadId: baseSession.threadId,
    documentId: baseSession.documentId,
  });
  for (const listener of cloudListeners) listener(current);
  assert.deepEqual(notices, [
    'local:local-ready',
    'cloud:cloud-blocked',
    'cloud:cloud-blocked',
    'cloud:cloud-ready',
  ]);
  assert.ok(contextCalls >= 3);

  unsubscribe();
  workspace.dispose();
  workspace.dispose();
  assert.equal(cloudListeners.size, 0);
  assert.equal(workspaceDisposals, 1);
});

test('workspace locks synchronously block a bound target until every owner releases', () => {
  const doc = new TestDocument();
  const parent = doc.createElement();
  const localRoot = doc.createElement();
  const cloudRoot = doc.createElement();
  parent.append(localRoot);
  const runningSession = sessions.find((session) => session.kind === 'running')!;
  const cloudWorkspace: CloudWorkspace = {
    root: cloudRoot as unknown as HTMLElement,
    setContext() {},
    getState: () => ({ kind: 'connecting', sessionId: baseSession.sessionId }),
    subscribe: () => () => {},
    dispose() {},
  };
  const cloud = {
    getSnapshot: () => snapshot(runningSession),
    subscribe: () => () => {},
  } as Pick<CloudController, 'getSnapshot' | 'subscribe'>;
  const workspace = createWorkspaceController({
    localRoot: localRoot as unknown as HTMLElement,
    cloudWorkspace,
    cloud,
    initialMode: 'cloud',
  });
  workspace.bindCloud({
    sessionId: baseSession.sessionId,
    threadId: baseSession.threadId,
    documentId: baseSession.documentId,
  });
  assert.equal(workspace.composerTarget().kind, 'cloud-ready');

  const transfer = workspace.lock('cloud-transfer');
  const authority = workspace.lock('authority-transition');
  assert.deepEqual(workspace.composerTarget(), {
    kind: 'workspace-blocked',
    reason: 'authority-transition',
    message: '문서 권한을 전환하는 중입니다.',
  });
  authority.release();
  assert.equal(workspace.composerTarget().kind, 'workspace-blocked');
  transfer.release();
  transfer.release();
  assert.equal(workspace.composerTarget().kind, 'cloud-ready');

  workspace.bindCloud({ ...baseSession, sessionId: 'other-session' });
  assert.equal(workspace.composerTarget().kind, 'cloud-blocked');
  workspace.dispose();
});

test('injected cloud dependencies are never disposed by the sidebar owner', () => {
  let workspaceDisposals = 0;
  let controllerDisposals = 0;
  const workspace = { dispose: () => { workspaceDisposals += 1; } };
  const controller = { dispose: () => { controllerDisposals += 1; } };
  disposeCloudDependencies(false, workspace, controller);
  assert.deepEqual([workspaceDisposals, controllerDisposals], [0, 0]);
  disposeCloudDependencies(true, workspace, controller);
  assert.deepEqual([workspaceDisposals, controllerDisposals], [1, 1]);
});
