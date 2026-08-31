import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ResponseBodyTooLargeError,
  cancelResponseBody,
  readResponseBytesBounded,
  readResponseJsonBounded,
} from '../response-bounds.mjs';

test('early response rejection explicitly cancels an unread body', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { status: 503 });

  await cancelResponseBody(response, new Error('rejected before read'));
  assert.equal(cancelled, true);
});

test('declared oversized bodies are cancelled before the stream is read', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(Buffer.alloc(1));
    },
    cancel() { cancelled = true; },
  });
  const response = new Response(body, { headers: { 'content-length': '65' } });

  await assert.rejects(
    readResponseBytesBounded(response, { maxBytes: 64, label: 'fixture' }),
    (error) => error instanceof ResponseBodyTooLargeError && error.maxBytes === 64,
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 1, 'the body is rejected from metadata rather than consumed');
});

test('chunked bodies are cancelled as soon as observed bytes cross the limit', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.alloc(40, 1));
      controller.enqueue(Buffer.alloc(40, 2));
    },
    cancel() { cancelled = true; },
  });

  await assert.rejects(
    readResponseBytesBounded(new Response(body), { maxBytes: 64 }),
    { code: 'RESPONSE_BODY_TOO_LARGE' },
  );
  assert.equal(cancelled, true);
});

test('bounded JSON parsing supports small injected response doubles', async () => {
  const parsed = await readResponseJsonBounded({
    text: async () => '{"ok":true}',
  }, { maxBytes: 64 });
  assert.deepEqual(parsed, { ok: true });

  await assert.rejects(
    readResponseJsonBounded({ text: async () => 'x'.repeat(65) }, { maxBytes: 64 }),
    { code: 'RESPONSE_BODY_TOO_LARGE' },
  );
});
