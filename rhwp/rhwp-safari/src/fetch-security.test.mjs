import assert from 'node:assert/strict';
import { after } from 'node:test';

await import('./fetch-security.js');

const {
  cancelResponseBody,
  FetchSecurityError,
  REMOTE_DOCUMENT_MAX_BYTES,
  REMOTE_THUMBNAIL_MAX_BYTES,
  readResponseBytesWithLimit,
  resolveDocumentMaxBytes,
} = globalThis.RHWPFetchSecurity;

after(() => {
  delete globalThis.RHWPFetchSecurity;
});

assert.equal(REMOTE_DOCUMENT_MAX_BYTES, 128 * 1024 * 1024);
assert.equal(REMOTE_THUMBNAIL_MAX_BYTES, 64 * 1024 * 1024);
assert.equal(resolveDocumentMaxBytes(20), 20 * 1024 * 1024);
assert.equal(resolveDocumentMaxBytes(1024), REMOTE_DOCUMENT_MAX_BYTES);
assert.equal(resolveDocumentMaxBytes(Number.MIN_VALUE), 1);
assert.equal(resolveDocumentMaxBytes('corrupt'), 20 * 1024 * 1024);

{
  let cancelReason = null;
  const response = new Response(new ReadableStream({
    cancel(reason) { cancelReason = reason; },
  }));
  await cancelResponseBody(response, 'response-discarded');
  assert.equal(cancelReason, 'response-discarded');
}

assert.deepEqual(
  await readResponseBytesWithLimit(new Response(new Uint8Array([1, 2, 3])), 3),
  new Uint8Array([1, 2, 3]),
);

{
  let pullCount = 0;
  let cancelReason = null;
  const body = new ReadableStream({
    pull(controller) {
      pullCount += 1;
      controller.enqueue(new Uint8Array([1]));
    },
    cancel(reason) {
      cancelReason = reason;
    },
  });
  const response = new Response(body, {
    headers: { 'content-length': '5' },
  });

  await assert.rejects(
    () => readResponseBytesWithLimit(response, 4),
    (error) => error instanceof FetchSecurityError && error.reason === 'response-too-large',
  );
  assert.equal(pullCount, 0, 'declared oversize must be rejected before reading');
  assert.equal(cancelReason, 'response-too-large');
}

{
  let cancelReason = null;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
    },
    cancel(reason) {
      cancelReason = reason;
    },
  });

  await assert.rejects(
    () => readResponseBytesWithLimit(new Response(body), 4),
    (error) => error instanceof FetchSecurityError && error.reason === 'response-too-large',
  );
  assert.equal(cancelReason, 'response-too-large');
}

await assert.rejects(
  () => readResponseBytesWithLimit(new Response(null), 4),
  (error) => error instanceof FetchSecurityError && error.reason === 'response-not-streamable',
);
