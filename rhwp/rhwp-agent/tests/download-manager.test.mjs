import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DownloadManager, isPathInside, sanitizeFilename } from '../download-manager.mjs';

test('download filenames are leaf-only and traversal-safe', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..\\..\\evil?.png'), 'evil_.png');
  assert.equal(sanitizeFilename('..'), 'download');
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
