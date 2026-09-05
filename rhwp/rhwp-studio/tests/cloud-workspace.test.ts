import assert from 'node:assert/strict';
import test from 'node:test';

import type { CloudController } from '../src/cloud/desktop-cloud.ts';
import type {
  CloudDisplayConnection,
  CloudDisplayEvent,
  CloudDisplayFrame,
  CloudSessionState,
} from '../src/cloud/types.ts';
import { createCloudWorkspace } from '../src/ui/cloud-workspace.ts';

class TestElement {
  id = '';
  className = '';
  textContent = '';
  type = '';
  alt = '';
  src = '';
  draggable = false;
  disabled = false;
  scrollLeft = 0;
  scrollTop = 0;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: TestElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  bounds = { left: 0, top: 0, width: 1280, height: 800 };

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }

  append(...nodes: TestElement[]): void {
    this.children.push(...nodes);
  }

  appendChild(node: TestElement): TestElement {
    this.children.push(node);
    return node;
  }

  addEventListener(name: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  click(): void {
    for (const listener of this.listeners.get('click') ?? []) listener();
  }

  dispatch(name: string, event: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  getBoundingClientRect() { return this.bounds; }
  focus() {}
  setPointerCapture() {}
  releasePointerCapture() {}
}

class TestDocument {
  createElement(): TestElement {
    return new TestElement();
  }
}

const baseSession = {
  sessionId: 'session-cloud-view-01',
  version: 4,
  threadId: 'thread-cloud-view-01',
  documentId: 'document-cloud-view-01',
  documentName: 'cloud-view.hwpx',
};

function running(sessionId = baseSession.sessionId): CloudSessionState {
  return {
    ...baseSession,
    sessionId,
    kind: 'running',
    startedAt: '2026-08-30T00:00:00.000Z',
    turn: 1,
    turnLimit: 20,
    elapsedMs: 500,
    timeLimitMs: 60_000,
    currentActivity: 'editing',
    phase: 'working',
    wait: null,
  };
}

function queued(sessionId = baseSession.sessionId): CloudSessionState {
  return { ...baseSession, sessionId, kind: 'queued', position: 1, message: 'queued' };
}

function suspended(sessionId = baseSession.sessionId): CloudSessionState {
  return { ...baseSession, sessionId, kind: 'suspended', reason: 'paused', resumable: true };
}

function frame(sessionId = baseSession.sessionId, sequence = 1): CloudDisplayFrame {
  return {
    kind: 'frame',
    sessionId,
    streamId: `stream-${sessionId}`,
    sequence,
    capturedAt: '2026-08-30T00:00:01.000Z',
    width: 1280,
    height: 800,
    mimeType: 'image/jpeg',
    byteLength: 4,
    sha256: String(sequence).repeat(64).slice(0, 64),
    framePath: `/frames/${sequence}`,
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  };
}

function find(root: TestElement, predicate: (node: TestElement) => boolean): TestElement {
  if (predicate(root)) return root;
  for (const child of root.children) {
    try {
      return find(child, predicate);
    } catch {}
  }
  throw new Error('Element not found');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function connection(sessionId: string, closed: string[]): CloudDisplayConnection {
  return {
    capability: {
      kind: 'available',
      protocol: 'rauhwpx-frame-v1',
      sessionId,
      streamId: `stream-${sessionId}`,
      width: 1280,
      height: 800,
      maxFrameBytes: 524288,
      maxFps: 12,
      inputProtocol: 'rauhwpx-input-v1',
      maxInputEventsPerSecond: 60,
    },
    async sendInput() {},
    async close() { closed.push(sessionId); },
  };
}

test('cloud workspace opens only while visible, replaces sessions, and suppresses stale callbacks', async () => {
  const doc = new TestDocument();
  const opened: string[] = [];
  const closed: string[] = [];
  const listeners = new Map<string, (event: CloudDisplayEvent) => void>();
  const pending = new Map<string, ReturnType<typeof deferred<CloudDisplayConnection>>>();
  const display = {
    openDisplay(sessionId: string, listener: (event: CloudDisplayEvent) => void) {
      opened.push(sessionId);
      listeners.set(sessionId, listener);
      const result = deferred<CloudDisplayConnection>();
      pending.set(sessionId, result);
      return result.promise;
    },
  } as Pick<CloudController, 'openDisplay'>;
  const workspace = createCloudWorkspace({
    display,
    doc: doc as unknown as Document,
    objectUrls: { create: () => 'blob:unused', revoke: () => {} },
    decodeFrame: async () => ({ width: 1280, height: 800 }),
  });

  workspace.setContext({ visible: false, session: running() });
  assert.deepEqual(opened, []);
  workspace.setContext({ visible: true, session: running() });
  assert.deepEqual(opened, ['session-cloud-view-01']);
  pending.get('session-cloud-view-01')!.resolve(connection('session-cloud-view-01', closed));
  await Promise.resolve();

  workspace.setContext({ visible: true, session: running('session-cloud-view-02') });
  assert.deepEqual(opened, ['session-cloud-view-01', 'session-cloud-view-02']);
  assert.deepEqual(closed, ['session-cloud-view-01']);
  listeners.get('session-cloud-view-01')!(frame('session-cloud-view-01'));
  assert.equal(workspace.getState().kind, 'connecting');

  pending.get('session-cloud-view-02')!.resolve(connection('session-cloud-view-02', closed));
  await Promise.resolve();
  listeners.get('session-cloud-view-02')!(frame('session-cloud-view-02'));
  await Promise.resolve();
  assert.equal(workspace.getState().kind, 'live');
  workspace.setContext({ visible: false, session: running('session-cloud-view-02') });
  assert.deepEqual(closed, ['session-cloud-view-01', 'session-cloud-view-02']);
  listeners.get('session-cloud-view-02')!({
    kind: 'connection',
    state: 'failed',
    sessionId: 'session-cloud-view-02',
    streamId: 'stream-session-cloud-view-02',
    retryable: false,
    code: 'DISPLAY_UNAVAILABLE',
    message: 'late',
  });
  assert.equal(workspace.getState().kind, 'live');
});

test('cloud workspace maps pointer, wheel, shortcuts, and text into ordered remote input', async () => {
  const doc = new TestDocument();
  const inputs: unknown[] = [];
  const workspace = createCloudWorkspace({
    display: {
      async openDisplay(sessionId: string) {
        const opened = connection(sessionId, []);
        opened.sendInput = async (event) => { inputs.push(event); };
        return opened;
      },
    } as Pick<CloudController, 'openDisplay'>,
    doc: doc as unknown as Document,
    objectUrls: { create: () => 'blob:input', revoke: () => {} },
    decodeFrame: async () => ({ width: 1280, height: 800 }),
  });
  const root = workspace.root as unknown as TestElement;
  const canvas = find(root, (node) => node.className === 'cloud-workspace-canvas');
  const sink = find(root, (node) => node.className === 'cloud-workspace-input');
  canvas.bounds = { left: 100, top: 50, width: 640, height: 400 };
  workspace.setContext({ visible: true, session: running() });
  await flushMicrotasks();
  const pointer = (extra: Record<string, unknown> = {}) => ({
    clientX: 420, clientY: 250, button: 0, pointerId: 1,
    preventDefault() {},
    ...extra,
  });
  canvas.dispatch('pointerdown', pointer());
  canvas.dispatch('pointerup', pointer());
  canvas.dispatch('wheel', pointer({ deltaX: 3.4, deltaY: -8.6 }));
  sink.dispatch('keydown', {
    key: 'Control', ctrlKey: true, metaKey: false, altKey: false,
    isComposing: false, repeat: false, preventDefault() {},
  });
  sink.dispatch('keyup', { key: 'Control', preventDefault() {} });
  Object.assign(sink, { value: 'ㅎ' });
  sink.dispatch('input', { isComposing: true });
  Object.assign(sink, { value: '한글' });
  sink.dispatch('input', { isComposing: false });
  await flushMicrotasks();
  assert.deepEqual(inputs, [
    { kind: 'pointer', action: 'down', x: 640, y: 400, button: 'left' },
    { kind: 'pointer', action: 'up', x: 640, y: 400, button: 'left' },
    { kind: 'wheel', x: 640, y: 400, deltaX: 3, deltaY: -9 },
    { kind: 'key', action: 'down', key: 'Control' },
    { kind: 'key', action: 'up', key: 'Control' },
    { kind: 'text', text: '한글' },
  ]);
  workspace.dispose();
});

test('cloud workspace retains its committed frame while hidden and revokes it on session change', async () => {
  const doc = new TestDocument();
  const listeners: Array<(event: CloudDisplayEvent) => void> = [];
  const closed: string[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const display = {
    async openDisplay(sessionId: string, listener: (event: CloudDisplayEvent) => void) {
      listeners.push(listener);
      return connection(sessionId, closed);
    },
  } as Pick<CloudController, 'openDisplay'>;
  const workspace = createCloudWorkspace({
    display,
    doc: doc as unknown as Document,
    objectUrls: {
      create() {
        const url = `blob:frame-${created.length + 1}`;
        created.push(url);
        return url;
      },
      revoke: (url) => revoked.push(url),
    },
    decodeFrame: async () => ({ width: 1280, height: 800 }),
  });
  const root = workspace.root as unknown as TestElement;
  const image = find(root, (node) => node.className === 'cloud-workspace-image');

  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();
  listeners[0]!(frame(undefined, 1));
  await Promise.resolve();
  assert.equal(image.src, 'blob:frame-1');
  assert.deepEqual(revoked, []);
  workspace.setContext({ visible: false, session: running() });
  assert.equal(image.src, 'blob:frame-1');
  assert.deepEqual(revoked, []);

  workspace.setContext({ visible: true, session: running() });
  assert.equal(image.src, 'blob:frame-1', 'same-session re-entry must show the retained frame immediately');
  await Promise.resolve();
  workspace.setContext({ visible: true, session: running('session-cloud-view-02') });
  assert.equal(image.src, '');
  assert.deepEqual(revoked, ['blob:frame-1']);
  await Promise.resolve();
  listeners[2]!(frame('session-cloud-view-02', 2));
  await Promise.resolve();
  assert.equal(image.src, 'blob:frame-2');
  assert.deepEqual(revoked, ['blob:frame-1']);
  workspace.dispose();
  workspace.dispose();
  assert.deepEqual(revoked, ['blob:frame-1', 'blob:frame-2']);
  assert.equal(image.src, '');
});

test('cloud workspace hide cancels active and pending decodes without replacing its retained frame', async () => {
  const doc = new TestDocument();
  const listeners: Array<(event: CloudDisplayEvent) => void> = [];
  const decodes = new Map<string, ReturnType<typeof deferred<{ width: number; height: number }>>>();
  const revoked: string[] = [];
  let sequence = 0;
  const workspace = createCloudWorkspace({
    display: {
      async openDisplay(sessionId: string, listener: (event: CloudDisplayEvent) => void) {
        listeners.push(listener);
        return connection(sessionId, []);
      },
    } as Pick<CloudController, 'openDisplay'>,
    doc: doc as unknown as Document,
    objectUrls: {
      create: () => `blob:hide-${++sequence}`,
      revoke: (url) => revoked.push(url),
    },
    decodeFrame: (url) => {
      const value = deferred<{ width: number; height: number }>();
      decodes.set(url, value);
      return value.promise;
    },
  });
  const image = find(workspace.root as unknown as TestElement, (node) => node.className === 'cloud-workspace-image');
  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();

  listeners[0]!(frame(undefined, 1));
  decodes.get('blob:hide-1')!.resolve({ width: 1280, height: 800 });
  await flushMicrotasks();
  assert.equal(image.src, 'blob:hide-1');

  listeners[0]!(frame(undefined, 2));
  listeners[0]!(frame(undefined, 3));
  workspace.setContext({ visible: false, session: running() });
  assert.equal(image.src, 'blob:hide-1');
  assert.deepEqual(revoked, ['blob:hide-2', 'blob:hide-3']);

  decodes.get('blob:hide-2')!.resolve({ width: 1280, height: 800 });
  await flushMicrotasks();
  assert.equal(image.src, 'blob:hide-1');
  assert.deepEqual(revoked, ['blob:hide-2', 'blob:hide-3']);

  workspace.setContext({ visible: true, session: running() });
  assert.equal(image.src, 'blob:hide-1');
  workspace.dispose();
  assert.deepEqual(revoked, ['blob:hide-2', 'blob:hide-3', 'blob:hide-1']);
});

test('cloud workspace preserves local zoom and scroll, closes terminal sessions, and isolates display failure', async () => {
  const doc = new TestDocument();
  let listener: ((event: CloudDisplayEvent) => void) | null = null;
  const closed: string[] = [];
  const display = {
    async openDisplay(sessionId: string, nextListener: (event: CloudDisplayEvent) => void) {
      listener = nextListener;
      return connection(sessionId, closed);
    },
  } as Pick<CloudController, 'openDisplay'>;
  const workspace = createCloudWorkspace({
    display,
    doc: doc as unknown as Document,
    objectUrls: { create: () => 'blob:frame', revoke: () => {} },
    decodeFrame: async () => ({ width: 1280, height: 800 }),
  });
  const root = workspace.root as unknown as TestElement;
  const viewport = find(root, (node) => node.className === 'cloud-workspace-viewport');
  const zoomIn = find(root, (node) => node.dataset.cloudZoom === 'in');

  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();
  listener!(frame());
  await Promise.resolve();
  zoomIn.click();
  viewport.scrollLeft = 84;
  viewport.scrollTop = 37;
  workspace.setContext({ visible: false, session: running() });
  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();
  assert.equal(root.dataset.zoom, '1.25');
  assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], [84, 37]);

  workspace.setContext({
    visible: true,
    session: {
      ...baseSession,
      kind: 'failed',
      code: 'FAILED',
      message: 'conversation failed',
      retryable: false,
    },
  });
  assert.equal(workspace.getState().kind, 'ended');
  assert.equal(closed.length, 2);

  const unrelatedState = { chat: 'still-live', document: 'unchanged' };
  const failingWorkspace = createCloudWorkspace({
    display: {
      async openDisplay() { throw new Error('display only'); },
    } as Pick<CloudController, 'openDisplay'>,
    doc: doc as unknown as Document,
    objectUrls: { create: () => 'blob:none', revoke: () => {} },
    decodeFrame: async () => ({ width: 1280, height: 800 }),
  });
  failingWorkspace.setContext({ visible: true, session: running('session-failure') });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(failingWorkspace.getState().kind, 'unavailable');
  assert.deepEqual(unrelatedState, { chat: 'still-live', document: 'unchanged' });
});

test('cloud workspace demands display only while running and reopens after lifecycle and connection failures', async () => {
  const doc = new TestDocument();
  const opened: string[] = [];
  const closed: string[] = [];
  const listeners: Array<(event: CloudDisplayEvent) => void> = [];
  let rejectFirst = true;
  const workspace = createCloudWorkspace({
    display: {
      async openDisplay(sessionId: string, listener: (event: CloudDisplayEvent) => void) {
        opened.push(sessionId);
        listeners.push(listener);
        if (rejectFirst) {
          rejectFirst = false;
          throw new Error('opening failed');
        }
        return connection(sessionId, closed);
      },
    } as Pick<CloudController, 'openDisplay'>,
    doc: doc as unknown as Document,
    objectUrls: { create: () => 'blob:frame', revoke: () => {} },
    decodeFrame: async () => ({ width: 1280, height: 800 }),
  });

  workspace.setContext({ visible: true, session: queued() });
  assert.deepEqual(opened, []);
  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(workspace.getState().kind, 'unavailable');
  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();
  assert.deepEqual(opened, [baseSession.sessionId, baseSession.sessionId]);

  workspace.setContext({ visible: true, session: suspended() });
  assert.deepEqual(closed, [baseSession.sessionId]);
  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();
  assert.equal(opened.length, 3);
  listeners[2]!({
    kind: 'connection',
    state: 'failed',
    sessionId: baseSession.sessionId,
    streamId: `stream-${baseSession.sessionId}`,
    retryable: false,
    code: 'DISPLAY_FAILED',
    message: 'terminal display failure',
  });
  assert.equal(workspace.getState().kind, 'unavailable');
  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();
  assert.equal(opened.length, 4);
});

test('cloud workspace decodes one frame at a time and A/B/C commits only C', async () => {
  const doc = new TestDocument();
  let listener: ((event: CloudDisplayEvent) => void) | null = null;
  const decodes = new Map<string, ReturnType<typeof deferred<{ width: number; height: number }>>>();
  const revoked: string[] = [];
  const decodeCalls: string[] = [];
  const commits: number[] = [];
  let urlSequence = 0;
  let concurrentDecodes = 0;
  let maxConcurrentDecodes = 0;
  const workspace = createCloudWorkspace({
    display: {
      async openDisplay(sessionId: string, next: (event: CloudDisplayEvent) => void) {
        listener = next;
        return connection(sessionId, []);
      },
    } as Pick<CloudController, 'openDisplay'>,
    doc: doc as unknown as Document,
    objectUrls: {
      create: () => `blob:candidate-${++urlSequence}`,
      revoke: (url) => revoked.push(url),
    },
    decodeFrame: (url) => {
      decodeCalls.push(url);
      concurrentDecodes += 1;
      maxConcurrentDecodes = Math.max(maxConcurrentDecodes, concurrentDecodes);
      const value = deferred<{ width: number; height: number }>();
      decodes.set(url, value);
      return value.promise.finally(() => { concurrentDecodes -= 1; });
    },
  });
  const image = find(workspace.root as unknown as TestElement, (node) => node.className === 'cloud-workspace-image');
  workspace.subscribe((state) => {
    if (state.kind === 'live') commits.push(state.frame.sequence);
  });

  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();
  listener!(frame(undefined, 1));
  listener!(frame(undefined, 2));
  listener!(frame(undefined, 3));
  assert.deepEqual(decodeCalls, ['blob:candidate-1']);
  assert.deepEqual(revoked, ['blob:candidate-2']);
  assert.equal(maxConcurrentDecodes, 1);

  decodes.get('blob:candidate-1')!.resolve({ width: 1280, height: 800 });
  await flushMicrotasks();
  assert.equal(image.src, '');
  assert.deepEqual(decodeCalls, ['blob:candidate-1', 'blob:candidate-3']);
  assert.deepEqual(revoked, ['blob:candidate-2', 'blob:candidate-1']);
  assert.equal(maxConcurrentDecodes, 1);

  decodes.get('blob:candidate-3')!.resolve({ width: 1280, height: 800 });
  await flushMicrotasks();
  assert.equal(image.src, 'blob:candidate-3');
  assert.deepEqual(commits, [3]);
  assert.deepEqual(revoked, ['blob:candidate-2', 'blob:candidate-1']);
  workspace.dispose();
  assert.deepEqual(revoked, ['blob:candidate-2', 'blob:candidate-1', 'blob:candidate-3']);
});

test('cloud workspace proceeds from a failed decode to the latest pending frame', async () => {
  const doc = new TestDocument();
  let listener: ((event: CloudDisplayEvent) => void) | null = null;
  const decodes = new Map<string, ReturnType<typeof deferred<{ width: number; height: number }>>>();
  const revoked: string[] = [];
  const decodeCalls: string[] = [];
  let sequence = 0;
  const workspace = createCloudWorkspace({
    display: {
      async openDisplay(sessionId: string, next: (event: CloudDisplayEvent) => void) {
        listener = next;
        return connection(sessionId, []);
      },
    } as Pick<CloudController, 'openDisplay'>,
    doc: doc as unknown as Document,
    objectUrls: {
      create: () => `blob:failure-${++sequence}`,
      revoke: (url) => revoked.push(url),
    },
    decodeFrame: (url) => {
      decodeCalls.push(url);
      const value = deferred<{ width: number; height: number }>();
      decodes.set(url, value);
      return value.promise;
    },
  });
  const image = find(workspace.root as unknown as TestElement, (node) => node.className === 'cloud-workspace-image');
  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();

  listener!(frame(undefined, 1));
  decodes.get('blob:failure-1')!.resolve({ width: 1280, height: 800 });
  await flushMicrotasks();
  assert.equal(image.src, 'blob:failure-1');

  listener!(frame(undefined, 2));
  listener!(frame(undefined, 3));
  assert.deepEqual(decodeCalls, ['blob:failure-1', 'blob:failure-2']);
  decodes.get('blob:failure-2')!.reject(new Error('bad jpeg'));
  await flushMicrotasks();
  assert.equal(image.src, 'blob:failure-1');
  assert.equal(workspace.getState().kind, 'live');
  assert.deepEqual(decodeCalls, ['blob:failure-1', 'blob:failure-2', 'blob:failure-3']);

  decodes.get('blob:failure-3')!.resolve({ width: 1280, height: 800 });
  await flushMicrotasks();
  assert.equal(image.src, 'blob:failure-3');
  assert.deepEqual(revoked, ['blob:failure-2', 'blob:failure-1']);
  workspace.dispose();
  assert.deepEqual(revoked, ['blob:failure-2', 'blob:failure-1', 'blob:failure-3']);
});

test('cloud workspace session switch and dispose revoke queued URLs once despite late decodes', async () => {
  const doc = new TestDocument();
  const listeners = new Map<string, (event: CloudDisplayEvent) => void>();
  const decodes = new Map<string, ReturnType<typeof deferred<{ width: number; height: number }>>>();
  const revoked: string[] = [];
  let sequence = 0;
  const workspace = createCloudWorkspace({
    display: {
      async openDisplay(sessionId: string, listener: (event: CloudDisplayEvent) => void) {
        listeners.set(sessionId, listener);
        return connection(sessionId, []);
      },
    } as Pick<CloudController, 'openDisplay'>,
    doc: doc as unknown as Document,
    objectUrls: {
      create: () => `blob:switch-${++sequence}`,
      revoke: (url) => revoked.push(url),
    },
    decodeFrame: (url) => {
      const value = deferred<{ width: number; height: number }>();
      decodes.set(url, value);
      return value.promise;
    },
  });
  const image = find(workspace.root as unknown as TestElement, (node) => node.className === 'cloud-workspace-image');
  workspace.setContext({ visible: true, session: running('session-a') });
  await Promise.resolve();
  listeners.get('session-a')!(frame('session-a', 1));
  listeners.get('session-a')!(frame('session-a', 2));

  workspace.setContext({ visible: true, session: running('session-b') });
  await Promise.resolve();
  assert.deepEqual(revoked, ['blob:switch-1', 'blob:switch-2']);
  listeners.get('session-b')!(frame('session-b', 3));
  assert.equal(decodes.has('blob:switch-3'), false);

  decodes.get('blob:switch-1')!.resolve({ width: 1280, height: 800 });
  await flushMicrotasks();
  assert.equal(decodes.has('blob:switch-3'), true);
  workspace.dispose();
  assert.deepEqual(revoked, ['blob:switch-1', 'blob:switch-2', 'blob:switch-3']);
  decodes.get('blob:switch-3')!.resolve({ width: 1280, height: 800 });
  await flushMicrotasks();
  assert.equal(image.src, '');
  assert.deepEqual(revoked, ['blob:switch-1', 'blob:switch-2', 'blob:switch-3']);
});

test('cloud workspace keeps a good same-session frame when the next decode fails', async () => {
  const doc = new TestDocument();
  let listener: ((event: CloudDisplayEvent) => void) | null = null;
  const revoked: string[] = [];
  let sequence = 0;
  const workspace = createCloudWorkspace({
    display: {
      async openDisplay(sessionId: string, next: (event: CloudDisplayEvent) => void) {
        listener = next;
        return connection(sessionId, []);
      },
    } as Pick<CloudController, 'openDisplay'>,
    doc: doc as unknown as Document,
    objectUrls: {
      create: () => `blob:decode-${++sequence}`,
      revoke: (url) => revoked.push(url),
    },
    decodeFrame: async (url) => {
      if (url === 'blob:decode-2') throw new Error('bad jpeg');
      return { width: 1280, height: 800 };
    },
  });
  const image = find(workspace.root as unknown as TestElement, (node) => node.className === 'cloud-workspace-image');
  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();
  listener!(frame(undefined, 1));
  await Promise.resolve();
  assert.equal(image.src, 'blob:decode-1');
  listener!(frame(undefined, 2));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(image.src, 'blob:decode-1');
  assert.equal(workspace.getState().kind, 'stalled');
  assert.deepEqual(revoked, ['blob:decode-2']);
  workspace.dispose();
  assert.deepEqual(revoked, ['blob:decode-2', 'blob:decode-1']);
});

test('cloud workspace keeps the last good frame when decoded dimensions mismatch signed metadata', async () => {
  const doc = new TestDocument();
  let listener: ((event: CloudDisplayEvent) => void) | null = null;
  const revoked: string[] = [];
  let sequence = 0;
  const workspace = createCloudWorkspace({
    display: {
      async openDisplay(sessionId: string, next: (event: CloudDisplayEvent) => void) {
        listener = next;
        return connection(sessionId, []);
      },
    } as Pick<CloudController, 'openDisplay'>,
    doc: doc as unknown as Document,
    objectUrls: {
      create: () => `blob:geometry-${++sequence}`,
      revoke: (url) => revoked.push(url),
    },
    decodeFrame: async (url) => url === 'blob:geometry-2'
      ? { width: 640, height: 480 }
      : { width: 1280, height: 800 },
  });
  const image = find(workspace.root as unknown as TestElement, (node) => node.className === 'cloud-workspace-image');
  workspace.setContext({ visible: true, session: running() });
  await Promise.resolve();
  listener!(frame(undefined, 1));
  await Promise.resolve();
  assert.equal(image.src, 'blob:geometry-1');
  listener!(frame(undefined, 2));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(image.src, 'blob:geometry-1');
  assert.equal(workspace.getState().kind, 'stalled');
  assert.deepEqual(revoked, ['blob:geometry-2']);
  workspace.dispose();
});

test('cloud workspace preserves unconfirmed composed text for deliberate recovery', async () => {
  const workspace = createCloudWorkspace({
    display: {
      async openDisplay(sessionId: string) {
        const opened = connection(sessionId, []);
        opened.sendInput = async () => { throw Object.assign(new Error('receipt lost'), { code: 'DISPLAY_INPUT_UNCONFIRMED' }); };
        return opened;
      },
    } as Pick<CloudController, 'openDisplay'>,
    doc: new TestDocument() as unknown as Document,
    objectUrls: { create: () => 'blob:input', revoke: () => {} },
    decodeFrame: async () => ({ width: 1280, height: 800 }),
  });
  const root = workspace.root as unknown as TestElement;
  workspace.setContext({ visible: true, session: running() });
  await flushMicrotasks();
  const sink = find(root, (node) => node.className === 'cloud-workspace-input');
  Object.assign(sink, { value: '한글 입력' });
  sink.dispatch('input', { isComposing: false });
  await flushMicrotasks();
  const recovered = find(root, (node) => node.getAttribute('aria-label')?.startsWith('전달 여부') === true) as unknown as HTMLTextAreaElement;
  assert.equal(recovered.hidden, false);
  assert.equal(recovered.value, '한글 입력');
  assert.equal(recovered.readOnly, true);
  workspace.dispose();
});
