import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  captureCloudOriginSha256,
  checkpointMatchesActiveDocument,
  persistCheckpointToBrowserOrigin,
} from '../src/cloud/checkpoint-origin.ts';
import { parseCloudCheckpoint } from '../src/cloud/desktop-cloud.ts';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const checkpointOrigin = readFileSync(new URL('../src/cloud/checkpoint-origin.ts', import.meta.url), 'utf8');

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} source range must exist`);
  return main.slice(start, end);
}

test('explicit cloud publication writes verified origin state without replacing editor authority', () => {
  const persistence = sourceBetween(
    'async function publishCloudCheckpoint',
    '\n/** 렌더러 초기화 후에 생성되는 에이전트 브리지',
  );
  assert.match(persistence, /browserOriginSyncDigest/);
  assert.match(persistence, /setBrowserOriginSyncDigest/);
  assert.match(persistence, /persistCheckpointToBrowserOrigin/);
  assert.match(checkpointOrigin, /handle\.createWritable/);
  assert.match(persistence, /checkpoint\.publication/);
  assert.doesNotMatch(persistence, /inputHandler\?\.deactivate/);
  assert.doesNotMatch(persistence, /wasm\.loadDocument/);
  assert.doesNotMatch(persistence, /canvasView\.loadDocument/);
  assert.doesNotMatch(persistence, /initializeDocument/);
  assert.doesNotMatch(persistence, /setCloudDocumentLease/);
  assert.doesNotMatch(persistence, /open-document-bytes/);
  assert.match(sidebar, /onCheckpointPublished: \(checkpoint\) => deps\.publishCloudCheckpoint\?\.\(checkpoint\)/);
});

test('takeover and explicit result replacement retain their editor authority paths', () => {
  const result = sourceBetween('function applyCloudResult', '\nasync function applyCloudTakeover');
  const takeover = sourceBetween('async function applyCloudTakeover', '\nasync function publishCloudCheckpoint');
  assert.match(result, /open-document-bytes/);
  assert.match(result, /resolution\.action !== 'replace'/);
  assert.match(takeover, /open-document-bytes/);
  assert.match(sidebar, /onTakeover:[\s\S]*applyCloudTakeover[\s\S]*applyCloudTimeline/);
  assert.match(sidebar, /onTakeoverSettled:[\s\S]*workspace\.select\('local'\)[\s\S]*startCurrentBridgeChat\(true\)/);
});

test('same-digest checkpoint writes still require the exact active editor document', () => {
  const checkpoint = { originOnThisDevice: true, documentId: 'document-b' };
  assert.equal(checkpointMatchesActiveDocument(checkpoint, 'document-a'), false);
  assert.equal(checkpointMatchesActiveDocument({ ...checkpoint, documentId: 'document-a' }, 'document-a'), true);
  assert.equal(checkpointMatchesActiveDocument({ ...checkpoint, documentId: null }, 'document-a'), false);
});

test('desktop checkpoint boundary requires an explicit valid document identity and kind', () => {
  const checkpoint = {
    sessionId: 'session-a',
    documentId: 'document-a',
    kind: 'turn',
    fileName: 'document.hwpx',
    bytes: new Uint8Array([1, 2, 3]),
    byteLength: 3,
    sha256: 'a'.repeat(64),
    revision: 2,
    turn: 1,
    operationId: 'operation-a',
  };
  assert.equal(parseCloudCheckpoint(checkpoint)?.documentId, 'document-a');
  assert.equal(parseCloudCheckpoint({ ...checkpoint, documentId: null })?.documentId, null);
  assert.equal(parseCloudCheckpoint({ ...checkpoint, documentId: undefined }), null);
  assert.equal(parseCloudCheckpoint({ ...checkpoint, documentId: ' document-a ' }), null);
  assert.equal(parseCloudCheckpoint({ ...checkpoint, kind: 'unknown' }), null);
});

test('browser origin persistence distinguishes stable archive-only outcomes from write failures', async () => {
  const digest = async (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const bytes = new TextEncoder().encode('new');
  assert.equal(await persistCheckpointToBrowserOrigin({
    handle: null, bytes, sha256: 'new', expectedSha256: 'old', digest,
  }), 'archive-only');

  let stored = new TextEncoder().encode('old');
  const handle = {
    queryPermission: async () => 'granted' as PermissionState,
    getFile: async () => ({ arrayBuffer: async () => stored.buffer.slice(0) as ArrayBuffer }),
    createWritable: async () => ({
      write: async (blob: Blob) => { stored = new Uint8Array(await blob.arrayBuffer()); },
      close: async () => {},
      abort: async () => {},
    }),
  };
  assert.equal(await persistCheckpointToBrowserOrigin({
    handle, bytes, sha256: 'new', expectedSha256: 'old', digest,
  }), 'written');
  assert.equal(new TextDecoder().decode(stored), 'new');

  stored = new TextEncoder().encode('external');
  assert.equal(await persistCheckpointToBrowserOrigin({
    handle, bytes, sha256: 'new', expectedSha256: 'old', digest,
  }), 'conflict');

  const failingHandle = {
    ...handle,
    createWritable: async () => ({
      write: async () => { throw new Error('disk unavailable'); },
      close: async () => {},
      abort: async () => {},
    }),
  };
  stored = new TextEncoder().encode('old');
  await assert.rejects(persistCheckpointToBrowserOrigin({
    handle: failingHandle, bytes, sha256: 'new', expectedSha256: 'old', digest,
  }), /disk unavailable/);
});


test('dirty handoff captures only an unchanged saved origin and never authorizes changed or unreadable files', async () => {
  const saved = new Uint8Array([1, 2, 3]);
  let disk = saved;
  let reads = 0;
  let digests = 0;
  const sourceDigest = (bytes: Uint8Array) => `source:${[...bytes].join(',')}`;
  const options = {
    handle: { getFile: async () => { reads += 1; return { arrayBuffer: async () => disk.slice().buffer }; } },
    loadedDigest: sourceDigest(saved),
    sourceDigest,
    digest: async () => { digests += 1; return 'saved-origin-sha256'; },
  };
  assert.equal(await captureCloudOriginSha256(options), 'saved-origin-sha256');
  disk = new Uint8Array([4, 5, 6]);
  assert.equal(await captureCloudOriginSha256(options), null);
  assert.equal(digests, 1, 'changed disk bytes must not establish a new trusted baseline');
  assert.equal(await captureCloudOriginSha256({ ...options, loadedDigest: null }), null);
  assert.equal(await captureCloudOriginSha256({ ...options, handle: { getFile: async () => { throw new Error('moved'); } } }), null);
  const previousReads = reads;
  assert.equal(await captureCloudOriginSha256({ ...options, handle: null }), undefined);
  assert.equal(reads, previousReads);
});
