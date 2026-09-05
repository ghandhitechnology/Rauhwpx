// Regression probes for docs/raucloud-reliability-audit.md.
// Run from the repository root. Assertions check the repaired behavior against the original reproductions.
// No external requests or real infrastructure changes occur.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.cwd();
const mod = (name) => import(pathToFileURL(path.join(root, name)));
const { openCloudDisplay } = await mod('desktop/cloud-display.mjs');
const { DisplayFrameStore } = await mod('cloud/src/display-frame-store.mjs');
const { runSession } = await mod('cloud/document-runtime/run.mjs');
const { TIMELINE_SCHEMA, TIMELINE_VERSION } = await mod('cloud/document-runtime/timeline.mjs');
const { createRaucloudBroker } = await mod('rhwp/rau-credits/cloud-broker.mjs');
const { createMemoryStore } = await mod('rhwp/rau-credits/store.mjs');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Exercise the real desktop input queue with an injected 100 ms request round trip.
const capability = { kind: 'available', sessionId: 'audit-session', streamId: 'audit-stream',
  protocol: 'rauhwpx-frame-v1', width: 1280, height: 800, maxFrameBytes: 524288,
  maxFps: 12, inputProtocol: 'rauhwpx-input-v1', maxInputEventsPerSecond: 60 };
let inFlight = 0, maxInFlight = 0;
const connection = await openCloudDisplay({
  displayCapability: async () => capability,
  setDisplayInterest: async () => {},
  readDisplayFrames: async (_session, _capability, _after, { signal }) => new Promise((resolve) => {
    if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
  }),
  sendDisplayInput: async () => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await delay(100);
    inFlight--;
  },
}, capability.sessionId, () => {});
const inputStart = performance.now();
await Promise.all(Array.from({ length: 20 }, () => connection.sendInput({ kind: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 10 })));
const elapsedMs = Math.round(performance.now() - inputStart);
await connection.close();
assert.equal(maxInFlight, 1);
assert.ok(elapsedMs < 1000);
console.log(JSON.stringify({ probe: 'coalesced-input', events: 20, simulatedRequestMs: 100, elapsedMs, maxInFlight }));

// A real broker and display store share a synthetic clock; only the provisioner is fake.
let now = Date.parse('2026-09-05T00:00:00Z');
const store = createMemoryStore();
const deleted = [];
const broker = createRaucloudBroker({ store, mutate: store.mutate,
  authenticateAccessToken: async () => 'audit-user', workerSecret: 'audit-secret', now: () => now,
  provisioner: {
    provision: async () => ({ remote: { serviceId: 'audit-service' }, receipt: {
      endpoint: 'https://audit.example.test', serverPublicKey: `ed25519:${'A'.repeat(59)}`,
      pairingCode: 'ABCD-EFGH-JKLM',
    } }),
    teardown: async (remote) => deleted.push(remote.serviceId),
  },
});
const created = await broker.createCloudRun('audit-access', {
  deviceId: 'audit-device', timezone: 'Asia/Seoul', idempotencyKey: 'audit-create',
});
for (let i = 0; i < 50; i++) {
  const state = await broker.getCloudStatus('audit-access');
  if (state.worker?.status === 'ready') break;
  await delay(1);
}
await broker.confirmCloudAllocation('audit-secret', created.run.id);
now += 1000;
await broker.completeCloudRun('audit-secret', created.run.id, { checkpointId: 'audit-boundary' });
// A lost completion response can replay without charging or extending idle time.
const warmUntil = (await broker.getCloudStatus('audit-access')).worker.warmUntil;
now += 1000;
await broker.completeCloudRun('audit-secret', created.run.id, { checkpointId: 'audit-boundary' });
assert.equal((await broker.getCloudStatus('audit-access')).worker.warmUntil, warmUntil);
const frames = new DisplayFrameStore({ now: () => now });
const stream = frames.openStream({ sessionId: 'audit-session', workerId: 'audit-worker', width: 1280, height: 800 });
let inputSequence = 0;
for (let i = 0; i < 180; i++) {
  now += 10000;
  frames.setInterest(stream.sessionId, stream.streamId, 'audit-device', 'audit-viewer', true);
  frames.sendInput(stream.sessionId, stream.streamId, 'audit-device', 'audit-viewer', ++inputSequence, { kind: 'text', text: 'editing' });
  await broker.touchCloudWorkspace('audit-secret', created.run.id);
  await broker.reconcileCloudUsage();
}
assert.deepEqual(deleted, []);
assert.equal(frames.snapshot().streams[0].viewers, 1);
frames.closeAll();
console.log(JSON.stringify({ probe: 'warm-expiry-during-editing', elapsedSeconds: 1800, acceptedInputs: inputSequence, renewedViewerEverySeconds: 10, deleted }));

now += 301000;
await broker.reconcileCloudUsage();
assert.deepEqual(deleted, ['audit-service'], 'idle teardown must still work after editing stops');

// Real runSession control flow with a fake document engine. Change the document after the turn checkpoint.
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'raucloud-audit-document-'));
try {
  const documentPath = path.join(workspace, 'document.hwp');
  const timelinePath = path.join(workspace, 'input-timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL');
  await fs.writeFile(timelinePath, JSON.stringify({ schema: TIMELINE_SCHEMA, version: TIMELINE_VERSION,
    exportedAt: '2026-09-05T00:00:00.000Z', thread: {
      id: 'audit-thread', title: 'Audit', titleRequested: false, createdAt: 1, updatedAt: 1,
      agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', workflow: 'direct',
      docKey: 'document.hwp', documentId: 'audit-document', activeTemplateId: null,
      messages: [{ role: 'user', text: 'Edit document' }],
    },
  }));
  let currentDocument = 'AGENT EDIT', exports = 0;
  const result = await runSession({ workspace, credentials: {}, manifest: {
    sessionId: 'audit-session', provider: 'codex', persistent: true, goal: 'Edit document',
    resources: [{ kind: 'document', name: 'document.hwp', filename: documentPath },
      { kind: 'timeline', name: 'timeline.json', filename: timelinePath }],
    limits: { maxDurationSeconds: 900, maxTurns: 10 },
  }, client: {
    event: async () => {}, beginTurn: async () => {},
    upload: async (filename) => { const bytes = await fs.readFile(filename); return { id: digest(bytes), size: bytes.length }; },
    commitBoundary: async (boundary) => boundary,
    completeTurn: async () => ({ status: 'running' }), control: async () => ({}),
    finishClaim: async () => { currentDocument = 'MANUAL EDIT AFTER TURN'; return { ready: true, messages: [] }; },
  }, createHarness: async () => ({
    start: async () => {}, close: async () => {},
    runTurn: async () => ({ stopReason: 'end_turn' }),
    exportDocument: async (_format, destination) => {
      exports++;
      await fs.writeFile(destination, currentDocument);
      return { sha256: digest(currentDocument), size: Buffer.byteLength(currentDocument) };
    },
  }) });
  const savedDocument = await fs.readFile(result.resultPath, 'utf8');
  assert.equal(savedDocument, 'MANUAL EDIT AFTER TURN');
  assert.equal(savedDocument, currentDocument);
  console.log(JSON.stringify({ probe: 'end-saves-manual-edit', exports, currentDocument, savedDocument }));
} finally { await fs.rm(workspace, { recursive: true, force: true }); }
