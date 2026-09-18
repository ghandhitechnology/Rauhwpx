import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  EXTENSION_FETCH_CHUNK_MAX_BYTES,
  readExtensionDocumentBytes,
  type ExtensionMessageRuntime,
} from '../src/core/extension-file-transfer.ts';

type Message = Record<string, unknown>;

function chunkRuntime(
  source: Uint8Array,
  format: 'number-array' | 'array-buffer',
  mutate?: (response: Message, message: Message) => Message,
): ExtensionMessageRuntime & { calls: Message[] } {
  const transferId = 'transfer-test-0001';
  const chunkBytes = 4;
  const calls: Message[] = [];
  return {
    calls,
    async sendMessage(message) {
      calls.push(message);
      if (message.type === 'fetch-file-start') {
        return {
          transferId,
          byteLength: source.byteLength,
          chunkBytes,
          chunkCount: Math.ceil(source.byteLength / chunkBytes),
        };
      }
      if (message.type === 'fetch-file-chunk') {
        const index = message.index as number;
        const offset = index * chunkBytes;
        const view = source.subarray(offset, Math.min(offset + chunkBytes, source.byteLength));
        const response: Message = {
          transferId,
          index,
          offset,
          byteLength: view.byteLength,
          done: offset + view.byteLength === source.byteLength,
          data: format === 'number-array' ? Array.from(view) : view.slice().buffer,
        };
        return mutate ? mutate(response, message) : response;
      }
      if (message.type === 'fetch-file-close') return { ok: true };
      throw new Error(`Unexpected message: ${String(message.type)}`);
    },
    getURL() { return 'chrome-extension://test/'; },
  };
}

test('reassembles bounded Chrome number-array chunks and always closes', async () => {
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const runtime = chunkRuntime(source, 'number-array');
  assert.deepEqual(await readExtensionDocumentBytes(runtime, 'blob:local-document', 20), source);
  assert.deepEqual(runtime.calls.map((call) => call.type), [
    'fetch-file-start',
    'fetch-file-chunk',
    'fetch-file-chunk',
    'fetch-file-chunk',
    'fetch-file-close',
  ]);
});

test('reassembles exact Firefox ArrayBuffer chunks', async () => {
  const source = new Uint8Array([9, 8, 7, 6, 5, 4, 3]);
  const runtime = chunkRuntime(source, 'array-buffer');
  assert.deepEqual(await readExtensionDocumentBytes(runtime, 'blob:local-document', 20), source);
  assert.equal(runtime.calls.at(-1)?.type, 'fetch-file-close');
});

test('rejects oversized start metadata before requesting chunks and still closes', async () => {
  const calls: Message[] = [];
  const runtime: ExtensionMessageRuntime = {
    async sendMessage(message) {
      calls.push(message);
      if (message.type === 'fetch-file-start') {
        return {
          transferId: 'transfer-test-0002',
          byteLength: 21,
          chunkBytes: 4,
          chunkCount: 6,
        };
      }
      return { ok: true };
    },
  };
  await assert.rejects(
    () => readExtensionDocumentBytes(runtime, 'blob:local-document', 20),
    /exceeds 20 bytes/,
  );
  assert.deepEqual(calls.map((call) => call.type), ['fetch-file-start', 'fetch-file-close']);
});

test('closes a transfer id even when a malformed start also reports an error', async () => {
  const calls: Message[] = [];
  const runtime: ExtensionMessageRuntime = {
    async sendMessage(message) {
      calls.push(message);
      if (message.type === 'fetch-file-start') {
        return { transferId: 'transfer-test-err1', error: 'start failed' };
      }
      return { ok: true };
    },
  };
  await assert.rejects(
    () => readExtensionDocumentBytes(runtime, 'blob:local-document', 20),
    /start failed/,
  );
  assert.deepEqual(calls.map((call) => call.type), ['fetch-file-start', 'fetch-file-close']);
});

test('rejects malformed order, size, and payload responses and closes each transfer', async () => {
  const cases: Array<(response: Message) => Message> = [
    (response) => ({ ...response, index: 1 }),
    (response) => ({ ...response, offset: 1 }),
    (response) => ({ ...response, byteLength: 3 }),
    (response) => ({ ...response, done: true }),
    (response) => ({ ...response, data: [1, 2, 3, 999] }),
    (response) => ({ ...response, data: new ArrayBuffer(3) }),
  ];
  for (const mutate of cases) {
    let mutated = false;
    const runtime = chunkRuntime(new Uint8Array([1, 2, 3, 4, 5]), 'number-array', (response) => {
      if (mutated) return response;
      mutated = true;
      return mutate(response);
    });
    await assert.rejects(
      () => readExtensionDocumentBytes(runtime, 'blob:local-document', 20),
      /malformed|out of order/,
    );
    assert.equal(runtime.calls.at(-1)?.type, 'fetch-file-close');
  }
});

test('rejects an advertised chunk above the 256 KiB wire bound before allocation', async () => {
  const calls: Message[] = [];
  const runtime: ExtensionMessageRuntime = {
    async sendMessage(message) {
      calls.push(message);
      if (message.type === 'fetch-file-start') {
        return {
          transferId: 'transfer-test-0003',
          byteLength: 1,
          chunkBytes: EXTENSION_FETCH_CHUNK_MAX_BYTES + 1,
          chunkCount: 1,
        };
      }
      return { ok: true };
    },
  };
  await assert.rejects(
    () => readExtensionDocumentBytes(runtime, 'blob:local-document'),
    /chunk size is malformed/,
  );
  assert.deepEqual(calls.map((call) => call.type), ['fetch-file-start', 'fetch-file-close']);
});

test('keeps Safari on its bounded ArrayBuffer transport', async () => {
  const calls: Message[] = [];
  const source = new Uint8Array([4, 3, 2, 1]);
  const runtime: ExtensionMessageRuntime = {
    getURL() { return 'safari-web-extension://test/'; },
    async sendMessage(message) {
      calls.push(message);
      return { data: source.slice().buffer };
    },
  };
  assert.deepEqual(await readExtensionDocumentBytes(runtime, 'file:///local/a.hwp', 20), source);
  assert.deepEqual(calls.map((call) => call.type), ['fetch-file']);
});

test('fails closed for every remote URL before extension messaging', async () => {
  const calls: Message[] = [];
  const runtime: ExtensionMessageRuntime = {
    async sendMessage(message) { calls.push(message); return {}; },
  };
  for (const url of [
    'https://example.com/a.hwp',
    'http://93.184.216.34/a.hwp',
    'https://example.com/redirect.hwp',
    ' \t\nhttps://example.com/canonicalized.hwp',
  ]) {
    await assert.rejects(
      () => readExtensionDocumentBytes(runtime, url),
      { code: 'REMOTE_PROXY_UNAVAILABLE', requirement: 'SERVER_FETCH_REQUIRED' },
    );
  }
  assert.deepEqual(calls, []);
});

test('source contract forbids whole-file number-array conversion', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const chromeRouter = readFileSync(
    new URL('../../rhwp-chrome/sw/message-router.js', import.meta.url),
    'utf8',
  );
  const firefoxRouter = readFileSync(
    new URL('../../rhwp-firefox/sw/message-router.js', import.meta.url),
    'utf8',
  );
  const safariBackground = readFileSync(
    new URL('../../rhwp-safari/src/background.js', import.meta.url),
    'utf8',
  );

  assert.match(main, /throw new ExtensionRemoteProxyUnavailableError\(\)/);
  assert.match(main, /validatedRemoteUrl = validateRemoteDocumentUrl\(fileUrl\)/);
  assert.match(main, /hasExtensionRuntime && validatedRemoteUrl/);
  assert.match(main, /fetch\(validatedRemoteUrl\?\.href \?\? fileUrl\)/);
  assert.doesNotMatch(main, /readExtensionDocumentBytes\(/);
  assert.doesNotMatch(main, /new Uint8Array\(result\.data\)/);
  assert.doesNotMatch(chromeRouter, /Array\.from\(bytes\)/);
  assert.doesNotMatch(firefoxRouter, /Array\.from\(bytes\)/);
  assert.match(safariBackground, /code: 'REMOTE_PROXY_UNAVAILABLE'/);
  assert.match(safariBackground, /requirement: 'SERVER_FETCH_REQUIRED'/);
});
