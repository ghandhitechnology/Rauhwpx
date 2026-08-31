import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FETCH_TRANSFER_CHUNK_BYTES,
  FETCH_TRANSFER_IDLE_TTL_MS,
  FETCH_TRANSFER_MAX_ACTIVE,
  FetchTransferError,
  FetchTransferStore,
  encodeJsonNumberChunk,
} from './fetch-transfer-store.js';

assert.equal(FETCH_TRANSFER_CHUNK_BYTES, 256 * 1024);
assert.equal(FETCH_TRANSFER_IDLE_TTL_MS, 30 * 1000);
assert.equal(FETCH_TRANSFER_MAX_ACTIVE, 2);

const owner = {
  url: 'chrome-extension://test/viewer.html?url=https%3A%2F%2Fexample.com%2Fa.hwp',
  tab: { id: 7 },
  frameId: 0,
  documentId: 'viewer-document-a',
};
const otherDocument = { ...owner, documentId: 'viewer-document-b' };
let id = 0;
const createId = () => `transfer-${String(++id).padStart(4, '0')}`;

// Chrome serializes only bounded chunks as JSON-compatible number arrays.
const source = new Uint8Array(FETCH_TRANSFER_CHUNK_BYTES * 2 + 7);
for (let index = 0; index < source.length; index += 1) source[index] = index % 251;
const store = new FetchTransferStore({ createId, encodeChunk: encodeJsonNumberChunk });
const reservation = store.reserve(owner);
const metadata = store.commit(reservation.transferId, owner, source);
assert.deepEqual(metadata, {
  transferId: reservation.transferId,
  byteLength: source.byteLength,
  chunkBytes: FETCH_TRANSFER_CHUNK_BYTES,
  chunkCount: 3,
});

const rebuilt = new Uint8Array(source.byteLength);
for (let index = 0; index < metadata.chunkCount; index += 1) {
  const chunk = store.readChunk(reservation.transferId, index, owner);
  assert.ok(Array.isArray(chunk.data));
  assert.ok(chunk.data.length <= FETCH_TRANSFER_CHUNK_BYTES);
  rebuilt.set(chunk.data, chunk.offset);
  assert.equal(chunk.done, index === metadata.chunkCount - 1);
}
assert.deepEqual(rebuilt, source);
assert.equal(store.close(reservation.transferId, owner), true);
assert.equal(store.activeCount, 0);

// A tab/document identity mismatch cannot read or close another viewer's bytes.
const isolated = store.reserve(owner);
store.commit(isolated.transferId, owner, new Uint8Array([1, 2, 3, 4]));
assert.throws(
  () => store.readChunk(isolated.transferId, 0, otherDocument),
  (error) => error instanceof FetchTransferError && error.code === 'sender-mismatch',
);
assert.throws(
  () => store.close(isolated.transferId, otherDocument),
  (error) => error instanceof FetchTransferError && error.code === 'sender-mismatch',
);
assert.equal(store.readChunk(isolated.transferId, 0, owner).byteLength, 4);
store.close(isolated.transferId, owner);

// Out-of-order probes are rejected without advancing or exposing another chunk.
const ordered = store.reserve(owner);
store.commit(ordered.transferId, owner, new Uint8Array([1, 2, 3, 4, 5]));
assert.throws(
  () => store.readChunk(ordered.transferId, 1, owner),
  (error) => error instanceof FetchTransferError && error.code === 'chunk-order',
);
assert.equal(store.readChunk(ordered.transferId, 0, owner).index, 0);
store.close(ordered.transferId, owner);

// Reservations count against a small cap even before a fetch has completed.
const capped = new FetchTransferStore({ createId, maxActive: 2 });
const capA = capped.reserve(owner);
const capB = capped.reserve({ ...owner, documentId: 'viewer-document-c' });
assert.throws(
  () => capped.reserve({ ...owner, documentId: 'viewer-document-d' }),
  (error) => error instanceof FetchTransferError && error.code === 'transfer-capacity',
);
capped.close(capA.transferId, owner);
capped.close(capB.transferId, { ...owner, documentId: 'viewer-document-c' });

// Expiry releases the retained slot and aborts an unfinished fetch reservation.
let clock = 10;
let expired = 0;
const expiring = new FetchTransferStore({
  createId,
  now: () => clock,
  idleTtlMs: 5,
  startTtlMs: 5,
  setTimer: () => ({ unref() {} }),
  clearTimer: () => {},
});
expiring.reserve(owner, { onExpire: () => { expired += 1; } });
clock += 6;
assert.equal(expiring.activeCount, 0);
assert.equal(expired, 1);

const routerSource = readFileSync(new URL('./message-router.js', import.meta.url), 'utf8');
assert.match(routerSource, /'fetch-file-start'/);
assert.match(routerSource, /'fetch-file-chunk'/);
assert.match(routerSource, /'fetch-file-close'/);
assert.doesNotMatch(routerSource, /Array\.from\(bytes\)/);
assert.doesNotMatch(routerSource, /'fetch-file'\s*:/);

console.log('Chrome bounded fetch-transfer tests passed');
