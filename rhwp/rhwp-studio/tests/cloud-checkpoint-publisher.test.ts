import assert from 'node:assert/strict';
import test from 'node:test';
import { createCheckpointPublisher } from '../src/cloud/checkpoint-publisher.ts';
import { cloudPublicationOperation } from '../src/cloud/session-binding.ts';
import type { CloudCheckpointPayload } from '../src/cloud/types.ts';
import { AgentToolExecutor, type AgentToolExecutorDeps } from '../src/agent/tool-executor.ts';

const checkpoint: CloudCheckpointPayload = {
  sessionId: 'session-a', documentId: 'document-a', kind: 'turn', fileName: 'document.hwpx',
  bytes: new Uint8Array([1]), byteLength: 1, sha256: 'a'.repeat(64), revision: 2, turn: 1, operationId: 'turn-a',
};

test('the agent publication tool requires a Cloud runtime and document-write authority', async () => {
  let cloudRuntime = false;
  const executor = new AgentToolExecutor({
    wasm: { getSectionCount: () => 1 }, revision: { revision: 7 },
    pending: { hasTemplateMutation: () => false }, canPublishCloudDocument: () => cloudRuntime,
  } as unknown as AgentToolExecutorDeps);
  await assert.rejects(executor.execute('publish_cloud_document', {}), { code: 'CLOUD_RUNTIME_REQUIRED' });
  cloudRuntime = true;
  await assert.rejects(executor.execute('publish_cloud_document', {}, 'codex', {
    workflow: 'question', permissionProfile: 'unrestricted',
  }), { code: 'QUESTION_MODE_READ_ONLY' });
  await assert.rejects(executor.execute('publish_cloud_document', {}, 'codex', {
    workflow: 'direct', permissionProfile: 'safe',
  }), { code: 'SAFE_MODE_PUBLISH' });
  assert.deepEqual(await executor.execute('publish_cloud_document', {}, 'codex', {
    workflow: 'direct', permissionProfile: 'unrestricted',
  }), { revision: 7, requested: true, publishAfterSuccessfulTurn: true });
});

test('ordinary turn and tool events cannot request an origin overwrite', () => {
  const event = { sessionId: 'session-a', event: { type: 'boundary.committed', payload: { operationId: 'turn-a' } } };
  assert.equal(cloudPublicationOperation(event), null);
  assert.equal(cloudPublicationOperation({ ...event, event: { ...event.event, type: 'agent.event' } }), null);
  assert.deepEqual(cloudPublicationOperation({ ...event, event: { ...event.event, type: 'document.publish_requested' } }), {
    sessionId: 'session-a', operationId: 'turn-a',
  });
});

test('failed explicit publication does not retry or block the next user request', async () => {
  let writes = 0;
  const publisher = createCheckpointPublisher({
    publish: async () => checkpoint,
    apply: async () => {
      writes += 1;
      if (writes === 1) throw new Error('write denied');
    },
  });
  await assert.rejects(publisher.publish('session-a'), /write denied/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writes, 1);
  await publisher.publish('session-a');
  assert.equal(writes, 2);
  publisher.dispose();
});

test('replayed agent publication requests coalesce and do not repeatedly apply a checkpoint', async () => {
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const publisher = createCheckpointPublisher({
    publish: async () => { await release.promise; return checkpoint; },
    apply: async () => { writes += 1; },
  });
  const first = publisher.publish('session-a', 'turn-a');
  assert.equal(publisher.publish('session-a', 'turn-a'), first);
  release.resolve();
  await first;
  await publisher.publish('session-a', 'turn-a');
  assert.equal(writes, 1);
  publisher.dispose();
});

test('switching servers invalidates a publication before it can reach the local document', async () => {
  const download = Promise.withResolvers<CloudCheckpointPayload>();
  const started = Promise.withResolvers<void>();
  let writes = 0;
  const publisher = createCheckpointPublisher({
    publish: async () => { started.resolve(); return download.promise; },
    apply: async () => { writes += 1; },
  });
  const operation = publisher.publish('session-a', 'turn-a');
  await started.promise;
  publisher.reset();
  download.resolve(checkpoint);
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(writes, 0);
  publisher.dispose();
});
