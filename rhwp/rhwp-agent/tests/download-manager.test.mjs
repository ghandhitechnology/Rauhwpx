import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  DownloadManager, isPathInside, isPublicAddress, sanitizeFilename,
} from '../download-manager.mjs';

test('download filenames are leaf-only and traversal-safe', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..\\..\\evil?.png'), 'evil_.png');
  assert.equal(sanitizeFilename('..'), 'download');
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFilename('lpt9'), '_lpt9');
  assert.equal(isPathInside('/tmp/chat', '/tmp/chat/file.txt'), true);
  assert.equal(isPathInside('/tmp/chat', '/tmp/escape.txt'), false);
});

test('downloads stay in a per-chat directory, checksum bytes, and never overwrite', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-download-test-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="server.txt"',
    });
    res.end('hello');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const manager = new DownloadManager({
    rootDir,
    maxBytes: 1_024,
    freeSpaceReserve: 0,
    fetchImpl: globalThis.fetch,
  });
  const url = `http://127.0.0.1:${address.port}/file`;
  const first = await manager.download({ sessionId: 'chat-a', url, filename: '../../chosen.txt' });
  const second = await manager.download({ sessionId: 'chat-a', url, filename: '../../chosen.txt' });
  const chatDirectory = manager.chatDirectory('chat-a');
  assert.equal(isPathInside(chatDirectory, first.path), true);
  assert.equal(isPathInside(chatDirectory, second.path), true);
  assert.notEqual(first.path, second.path);
  assert.equal(path.basename(first.path), 'chosen.txt');
  assert.equal(path.basename(second.path), 'chosen (1).txt');
  assert.equal(await fs.readFile(first.path, 'utf8'), 'hello');
  assert.equal(first.mime, 'text/plain');
  assert.equal(first.size, 5);
  assert.equal(first.source, url);
  assert.equal(first.checksum, 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('default downloads reject localhost before making a request', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-download-ssrf-test-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const manager = new DownloadManager({ rootDir, freeSpaceReserve: 0 });
  await assert.rejects(
    manager.download({ sessionId: 'chat-private', url: 'http://127.0.0.1/private' }),
    (error) => error.code === 'DOWNLOAD_ADDRESS_BLOCKED',
  );
});

test('SSRF filtering rejects IPv6 transition and reserved encodings of private destinations', () => {
  for (const address of [
    '::127.0.0.1',
    '0:0:0:0:0:ffff:7f00:1',
    '64:ff9b::127.0.0.1',
    '2002:7f00:1::',
    'fc00::1',
    'fec0::1',
    'fe80::1',
    '2001:db8::1',
  ]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('download storage rejects a symlinked agent directory', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-download-symlink-test-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-download-outside-'));
  t.after(() => Promise.all([
    fs.rm(rootDir, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  await fs.symlink(outside, path.join(rootDir, '.rhwp-agent'));
  const manager = new DownloadManager({
    rootDir,
    fetchImpl: async () => new Response('must not be fetched'),
  });
  await assert.rejects(
    manager.download({ sessionId: 'chat-symlink', url: 'https://example.test/file.txt' }),
    (error) => error.code === 'DOWNLOAD_PATH_UNSAFE',
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test('hub-private downloads ignore a provider-orchestrated parent swap', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-download-parent-swap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writableRoot = path.join(root, 'work');
  const storageRoot = path.join(root, 'hub-storage');
  const outside = path.join(root, 'outside');
  const providerAgentDir = path.join(writableRoot, '.rhwp-agent');
  await Promise.all([
    fs.mkdir(providerAgentDir, { recursive: true }),
    fs.mkdir(storageRoot),
    fs.mkdir(outside),
  ]);
  const manager = new DownloadManager({
    rootDir: storageRoot,
    writableRoot,
    freeSpaceReserve: 0,
    fetchImpl: async () => {
      await fs.rename(providerAgentDir, `${providerAgentDir}-old`);
      await fs.symlink(outside, providerAgentDir, process.platform === 'win32' ? 'junction' : 'dir');
      return new Response('private');
    },
  });

  const result = await manager.download({
    sessionId: 'chat-parent-swap',
    url: 'https://example.test/private.txt',
  });

  assert.equal(isPathInside(storageRoot, result.path), true);
  assert.equal(await fs.readFile(result.path, 'utf8'), 'private');
  assert.deepEqual(await fs.readdir(outside), []);
  assert.throws(
    () => new DownloadManager({ rootDir: writableRoot, writableRoot }),
    /must not overlap the provider-writable root/,
  );
});

test('oversized streaming downloads are removed', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-download-limit-test-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const response = new Response('too large', { headers: { 'content-type': 'text/plain' } });
  const manager = new DownloadManager({
    rootDir,
    maxBytes: 3,
    freeSpaceReserve: 0,
    fetchImpl: async () => response,
  });
  await assert.rejects(
    manager.download({ sessionId: 'chat-b', url: 'https://example.test/file.txt' }),
    (error) => error.code === 'DOWNLOAD_TOO_LARGE',
  );
  const files = await fs.readdir(manager.chatDirectory('chat-b'));
  assert.deepEqual(files, []);
});

test('per-chat file and aggregate quotas remain exact under concurrent downloads', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-download-quota-test-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const manager = new DownloadManager({
    rootDir,
    maxBytes: 10,
    maxFilesPerChat: 2,
    maxChatBytes: 5,
    freeSpaceReserve: 0,
    fetchImpl: async () => new Response('abc', { headers: { 'content-type': 'text/plain' } }),
  });

  const results = await Promise.allSettled([
    manager.download({ sessionId: 'chat-quota', url: 'https://example.test/a', filename: 'a.txt' }),
    manager.download({ sessionId: 'chat-quota', url: 'https://example.test/b', filename: 'b.txt' }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'DOWNLOAD_CHAT_QUOTA');
  assert.deepEqual(await fs.readdir(manager.chatDirectory('chat-quota')), ['a.txt']);

  const countManager = new DownloadManager({
    rootDir,
    maxBytes: 10,
    maxFilesPerChat: 1,
    maxChatBytes: 100,
    freeSpaceReserve: 0,
    fetchImpl: async () => new Response('x'),
  });
  await assert.rejects(
    countManager.download({ sessionId: 'chat-quota', url: 'https://example.test/c', filename: 'c.txt' }),
    (error) => error.code === 'DOWNLOAD_FILE_LIMIT',
  );
});

test('rejected responses cancel their bodies instead of leaking streams', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-download-body-cleanup-test-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  for (const scenario of [
    { status: 404, headers: {}, code: 'DOWNLOAD_HTTP_ERROR' },
    { status: 200, headers: { 'content-length': '9' }, code: 'DOWNLOAD_TOO_LARGE' },
    { status: 302, headers: {}, code: 'DOWNLOAD_REDIRECT_INVALID' },
  ]) {
    let cancellations = 0;
    const body = {
      cancel: async () => { cancellations += 1; },
      async *[Symbol.asyncIterator]() { yield Buffer.from('unread'); },
    };
    const manager = new DownloadManager({
      rootDir,
      maxBytes: 3,
      freeSpaceReserve: 0,
      fetchImpl: async () => ({
        status: scenario.status,
        ok: scenario.status >= 200 && scenario.status < 300,
        headers: new Headers(scenario.headers),
        body,
      }),
    });
    await assert.rejects(
      manager.download({
        sessionId: `chat-cleanup-${scenario.status}`,
        url: 'https://example.test/file',
      }),
      (error) => error.code === scenario.code,
    );
    assert.equal(cancellations, 1, `${scenario.code} should cancel its response body`);
  }
});
