import assert from 'node:assert/strict';
import test from 'node:test';

import { MergeWorkerClient } from '../src/merge/worker-client.ts';
import type { MergeWorkerRequest, MergeWorkerResponse } from '../src/merge/worker-protocol.ts';

class FakeWorker {
  listeners = new Set<(event: MessageEvent<MergeWorkerResponse>) => void>();
  terminated = false;
  request: MergeWorkerRequest | null = null;

  postMessage(request: MergeWorkerRequest): void { this.request = request; }
  addEventListener(_type: 'message', listener: (event: MessageEvent<MergeWorkerResponse>) => void): void { this.listeners.add(listener); }
  removeEventListener(_type: 'message', listener: (event: MessageEvent<MergeWorkerResponse>) => void): void { this.listeners.delete(listener); }
  terminate(): void { this.terminated = true; }
  emit(message: MergeWorkerResponse): void {
    for (const listener of this.listeners) listener({ data: message } as MessageEvent<MergeWorkerResponse>);
  }
}

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
  const manifests = { base: { entries: ['b'] }, current: { entries: ['c'] }, incoming: { entries: ['i'] } };
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
