import assert from 'node:assert/strict';
import { promises as realFs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFileMergeStore } from '../merge-artifacts.mjs';
import { createFileStore } from '../store.mjs';

function installWin32RenameSemantics(fsPromises) {
  const original = fsPromises.rename.bind(fsPromises);
  fsPromises.rename = async (from, to) => {
    try {
      await fsPromises.lstat(to);
    } catch (error) {
      if (error?.code === 'ENOENT') return original(from, to);
      throw error;
    }
    const failure = new Error(`EPERM: win32 cannot rename over ${to}`);
    failure.code = 'EPERM';
    throw failure;
  };
  return () => {
    fsPromises.rename = original;
  };
}

async function leftoverNames(directory) {
  return (await realFs.readdir(directory)).filter((name) => (
    name.includes('.tmp') || name.includes('previous-write')
  )).sort();
}

test('file store overwrites an existing snapshot under win32 rename semantics', async (t) => {
  const restoreRename = installWin32RenameSemantics(realFs);
  t.after(restoreRename);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rau-credits-win32-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'credits.json');
  let synced = 0;
  const store = createFileStore(filePath, {
    platform: 'win32',
    syncDirectoryImpl: async () => {
      synced += 1;
    },
  });

  await store.save({ users: { first: { createdAt: 1 } }, sessions: {} });
  await store.save({ users: { second: { createdAt: 2 } }, sessions: {} });

  assert.deepEqual(await store.load(), { users: { second: { createdAt: 2 } }, sessions: {} });
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).users.second.createdAt, 2);
  assert.equal(synced, 2);
  assert.deepEqual(await leftoverNames(directory), []);
});

test('file merge store overwrites existing metadata under win32 rename semantics', async (t) => {
  const restoreRename = installWin32RenameSemantics(realFs);
  t.after(restoreRename);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rau-credits-win32-merge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileMergeStore(directory, { platform: 'win32' });
  const first = {
    id: 'merge_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    size: 1,
    chunkCount: 1,
    expiresAt: Date.now() + 60_000,
  };
  const second = {
    id: 'merge_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    size: 2,
    chunkCount: 1,
    expiresAt: Date.now() + 60_000,
  };

  await store.transaction('account', async (repo) => {
    await repo.put(first);
  });
  await store.transaction('account', async (repo) => {
    await repo.put(second);
  });

  const records = await store.transaction('account', async (repo) => repo.list());
  assert.equal(records.length, 2);
  assert.equal(records.find((item) => item.id === second.id)?.size, 2);
  const accountDirs = await realFs.readdir(directory);
  assert.equal(accountDirs.length, 1);
  assert.deepEqual(await leftoverNames(path.join(directory, accountDirs[0])), []);
});
