import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MergeWorkerClient } from '../src/merge/worker-client.ts';
import type { MergeWorkerRequest, MergeWorkerResponse } from '../src/merge/worker-protocol.ts';

const mergeWorkerSource = readFileSync(new URL('../src/merge/merge.worker.ts', import.meta.url), 'utf8');

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for observable state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeWorker {
  listeners = new Set<(event: MessageEvent<MergeWorkerResponse>) => void>();
  errorListeners = new Set<(event: ErrorEvent) => void>();
  messageErrorListeners = new Set<(event: MessageEvent<unknown>) => void>();
  terminated = false;
  request: MergeWorkerRequest | null = null;

  postMessage(request: MergeWorkerRequest): void { this.request = request; }
  addEventListener(type: 'message', listener: (event: MessageEvent<MergeWorkerResponse>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: string, listener: ((event: MessageEvent<MergeWorkerResponse>) => void) | ((event: ErrorEvent) => void)): void {
    if (type === 'message') this.listeners.add(listener as (event: MessageEvent<MergeWorkerResponse>) => void);
    else if (type === 'error') this.errorListeners.add(listener as (event: ErrorEvent) => void);
    else this.messageErrorListeners.add(listener as (event: MessageEvent<unknown>) => void);
  }
  removeEventListener(type: 'message', listener: (event: MessageEvent<MergeWorkerResponse>) => void): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: string, listener: ((event: MessageEvent<MergeWorkerResponse>) => void) | ((event: ErrorEvent) => void)): void {
    if (type === 'message') this.listeners.delete(listener as (event: MessageEvent<MergeWorkerResponse>) => void);
    else if (type === 'error') this.errorListeners.delete(listener as (event: ErrorEvent) => void);
    else this.messageErrorListeners.delete(listener as (event: MessageEvent<unknown>) => void);
  }
  terminate(): void { this.terminated = true; }
  emit(message: MergeWorkerResponse): void {
    for (const listener of this.listeners) listener({ data: message } as MessageEvent<MergeWorkerResponse>);
  }
  emitError(message: string): void {
    for (const listener of this.errorListeners) listener({ message } as ErrorEvent);
  }
  emitMessageError(): void {
    for (const listener of this.messageErrorListeners) listener({ data: null } as MessageEvent<unknown>);
  }
}

test('rejected WASM initialization clears cached readiness for a retry', () => {
  assert.match(mergeWorkerSource, /wasmReady = initializing\.catch\(\(error\) => \{\s*wasmReady = null;\s*throw error;/);
});

test('worker client forwards analysis and progress', async () => {
  const worker = new FakeWorker();
  const progress: string[] = [];
  const client = new MergeWorkerClient(() => worker);
  const pending = client.analyze({}, { value: 1 }, { value: 2 }, {
    onProgress: (event) => progress.push(event.phase),
  });
  assert.equal(worker.request?.operation, 'analyze');
  worker.emit({ id: worker.request!.id, type: 'progress', operation: 'analyze', phase: 'merging' });
  worker.emit({
    id: worker.request!.id,
    type: 'analysis',
    value: { analysisVersion: 1, result: {}, conflicts: [], automaticOperationCount: 2 },
  });
  assert.equal((await pending).automaticOperationCount, 2);
  assert.deepEqual(progress.slice(0, 2), ['queued', 'merging']);
  client.dispose();
});

test('analysis soft budget returns an explicit conservative conflict and restarts worker', async () => {
  const workers: FakeWorker[] = [];
  const client = new MergeWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const analysis = await client.analyze({}, { value: 'current' }, { value: 'incoming' }, { softBudgetMs: 5 });
  assert.equal(analysis.conflicts[0].reason, 'budget-exceeded');
  assert.deepEqual(analysis.result, { value: 'current' });
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  client.dispose();
});

test('virtual-base budget fallback forces the following analysis into an explicit conflict', async () => {
  const client = new MergeWorkerClient(() => new FakeWorker());
  const base = await client.synthesizeVirtualBase([{ left: 1 }, { right: 2 }], { softBudgetMs: 5 });
  const analysis = await client.analyze(base, { left: 2 }, { right: 3 });
  assert.equal(analysis.conflicts.length, 1);
  assert.equal(analysis.conflicts[0].reason, 'budget-exceeded');
  client.dispose();
});

test('worker client supports document-byte analysis without detaching caller buffers', async () => {
  const worker = new FakeWorker();
  const client = new MergeWorkerClient(() => worker);
  const base = new Uint8Array([1]);
  const current = new Uint8Array([2]);
  const incoming = new Uint8Array([3]);
  const pending = client.analyzeDocument(base, current, incoming);
  assert.equal(worker.request?.operation, 'analyze-document');
  if (worker.request?.operation !== 'analyze-document') throw new Error('wrong worker operation');
  assert.deepEqual(worker.request.current, current);
  worker.emit({
    id: worker.request.id,
    type: 'analysis',
    value: { analysisVersion: 2, result: {}, conflicts: [], automaticOperationCount: 1 },
  });
  assert.equal((await pending).analysisVersion, 2);
  assert.equal(current.byteLength, 1);
  client.dispose();
});

test('document materialization returns exported bytes and reload validation metadata', async () => {
  const worker = new FakeWorker();
  const client = new MergeWorkerClient(() => worker);
  const pending = client.materializeDocument(
    new Uint8Array([1]),
    new Uint8Array([2]),
    new Uint8Array([3]),
    { conflict: { kind: 'incoming' } },
  );
  assert.equal(worker.request?.operation, 'materialize-document');
  worker.emit({
    id: worker.request!.id,
    type: 'materialized-document',
    bytes: new Uint8Array([0x50, 0x4b, 3, 4]),
    validation: {
      valid: true,
      errors: [],
      checks: { parsed: true, exported: true, reloaded: true, structurallyValid: true, format: 'hwpx' },
    },
  });
  const output = await pending;
  assert.deepEqual([...output.bytes], [0x50, 0x4b, 3, 4]);
  assert.equal(output.validation.checks?.reloaded, true);
  assert.equal(output.validation.checks?.format, 'hwpx');
  client.dispose();
});

test('aborting synchronous WASM work restarts the dedicated worker', async () => {
  const workers: FakeWorker[] = [];
  const client = new MergeWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const abort = new AbortController();
  const pending = client.materializeDocument(
    new Uint8Array([1]),
    new Uint8Array([2]),
    new Uint8Array([3]),
    {},
    { signal: abort.signal },
  );
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  client.dispose();
});

test('document virtual-base synthesis forwards format and preserves input buffers', async () => {
  const worker = new FakeWorker();
  const client = new MergeWorkerClient(() => worker);
  const bases = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const pending = client.synthesizeVirtualBaseDocument(bases, 'hwpx');
  assert.equal(worker.request?.operation, 'synthesize-virtual-base-document');
  if (worker.request?.operation !== 'synthesize-virtual-base-document') throw new Error('wrong worker operation');
  assert.equal(worker.request.currentFormat, 'hwpx');
  worker.emit({ id: worker.request.id, type: 'virtual-base-document', bytes: new Uint8Array([5, 6]) });
  assert.deepEqual([...(await pending)], [5, 6]);
  assert.deepEqual(bases.map((bytes) => bytes.byteLength), [2, 2]);
  client.dispose();
});

test('document analysis and materialization forward optional identity manifests', async () => {
  const worker = new FakeWorker();
  const client = new MergeWorkerClient(() => worker);
  const entry = (identity: string) => ({
    identity,
    kind: 'paragraph' as const,
    path: ['sections', '0', 'paragraphs', '0'],
    propertyHash: 'blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as const,
  });
  const manifests = {
    base: { entries: [entry('b')] },
    current: { entries: [entry('c')] },
    incoming: { entries: [entry('i')] },
  };
  const analysisPending = client.analyzeDocument(
    new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), { manifests },
  );
  assert.equal(worker.request?.operation, 'analyze-document');
  if (worker.request?.operation !== 'analyze-document') throw new Error('wrong operation');
  assert.deepEqual(worker.request.manifests, manifests);
  worker.emit({
    id: worker.request.id,
    type: 'analysis',
    value: { analysisVersion: 1, result: {}, conflicts: [], automaticOperationCount: 0 },
  });
  await analysisPending;

  const materializePending = client.materializeDocument(
    new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), {}, { manifests },
  );
  assert.equal(worker.request?.operation, 'materialize-document');
  if (worker.request?.operation !== 'materialize-document') throw new Error('wrong operation');
  assert.deepEqual(worker.request.manifests, manifests);
  worker.emit({
    id: worker.request.id,
    type: 'materialized-document',
    bytes: new Uint8Array([4]),
    validation: { valid: true, errors: [] },
  });
  await materializePending;
  client.dispose();
});

test('document manifest export returns full structural entry seeds', async () => {
  const worker = new FakeWorker();
  const client = new MergeWorkerClient(() => worker);
  const bytes = new Uint8Array([0x50, 0x4b]);
  const pending = client.buildDocumentManifest(bytes);
  assert.equal(worker.request?.operation, 'build-manifest');
  if (worker.request?.operation !== 'build-manifest') throw new Error('wrong operation');
  assert.deepEqual(worker.request.bytes, bytes);
  worker.emit({
    id: worker.request.id,
    type: 'manifest',
    entries: [{
      kind: 'section',
      path: ['sections', '0'],
      propertyHash: 'blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      identityHint: 'section-0',
    }],
  });
  assert.deepEqual(await pending, [{
    kind: 'section',
    path: ['sections', '0'],
    propertyHash: 'blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    identityHint: 'section-0',
  }]);
  client.dispose();
});

test('worker errors reject every pending request, stop heartbeats, and restart cleanly', async () => {
  const workers: FakeWorker[] = [];
  const client = new MergeWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const progress: string[] = [];
  const first = client.materialize({ analysisVersion: 1, result: {}, conflicts: [], automaticOperationCount: 0 }, {}, {
    onProgress: ({ phase }) => progress.push(phase),
  });
  const second = client.buildDocumentManifest(new Uint8Array([1]), {
    onProgress: ({ phase }) => progress.push(phase),
  });
  workers[0].emitError('worker crashed');
  await assert.rejects(first, /worker crashed/);
  await assert.rejects(second, /worker crashed/);
  const progressAfterFailure = progress.length;
  await assert.rejects(
    waitFor(() => progress.length > progressAfterFailure, 150),
    /Timed out waiting for observable state/,
  );
  assert.equal(progress.length, progressAfterFailure);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].listeners.size + workers[0].errorListeners.size + workers[0].messageErrorListeners.size, 0);
  assert.equal(workers.length, 2);
  client.dispose();
});

test('worker message errors reject pending requests', async () => {
  const workers: FakeWorker[] = [];
  const client = new MergeWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const pending = client.buildDocumentManifest(new Uint8Array([1]));
  workers[0].emitMessageError();
  await assert.rejects(pending, /unreadable message/);
  assert.equal(workers.length, 2);
  client.dispose();
});

test('requests without a conservative fallback hard-timeout and restart the worker', async () => {
  const workers: FakeWorker[] = [];
  const client = new MergeWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  await assert.rejects(
    client.buildDocumentManifest(new Uint8Array([1]), { softBudgetMs: 5 }),
    /exceeded its time budget/,
  );
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  client.dispose();
});

test('dispose rejects pending and future requests and removes every worker listener', async () => {
  const worker = new FakeWorker();
  const client = new MergeWorkerClient(() => worker);
  const pending = client.buildDocumentManifest(new Uint8Array([1]));
  client.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(client.buildDocumentManifest(new Uint8Array([2])), { name: 'AbortError' });
  assert.equal(worker.listeners.size + worker.errorListeners.size + worker.messageErrorListeners.size, 0);
  assert.equal(worker.terminated, true);
});
