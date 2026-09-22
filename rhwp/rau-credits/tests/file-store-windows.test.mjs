import assert from 'node:assert/strict';
import { promises as realFs } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recoverReplacedFile, replaceFile, __test as replaceTest } from '../fs-replace.mjs';
import { createFileMergeStore } from '../merge-artifacts.mjs';
import { createFileStore } from '../store.mjs';

function errorWithCode(code) {
  return Object.assign(new Error(code), { code });
}

function rmFileOnly(filePath, options) {
  if (options?.recursive) throw new Error(`recursive rm is forbidden for ${filePath}`);
  return realFs.rm(filePath, options);
}

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

test('win32 replacement refuses a static directory target', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rau-credits-replace-dir-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'credits.json');
  const temp = path.join(directory, 'credits.tmp');
  await mkdir(target);
  await writeFile(path.join(target, 'inside.txt'), 'keep');
  await writeFile(temp, 'new');

  await assert.rejects(replaceFile(temp, target, 'win32'), { code: 'EISDIR' });
  assert.equal(await readFile(path.join(target, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(access(replaceTest.backupPath(target)), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement restores a directory that appears between lstat and rename', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rau-credits-replace-dir-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'metadata.json');
  const temp = path.join(directory, 'metadata.tmp');
  const previous = replaceTest.backupPath(target);
  await mkdir(target);
  await writeFile(path.join(target, 'inside.txt'), 'keep');
  await writeFile(temp, 'new');

  const fsImpl = {
    lstat(filePath) {
      if (filePath === target) return Promise.resolve({ isDirectory: () => false, isFile: () => true });
      return realFs.lstat(filePath);
    },
    stat: (...args) => realFs.stat(...args),
    rename: (...args) => realFs.rename(...args),
    rm: rmFileOnly,
  };

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    { code: 'EISDIR' },
  );
  assert.equal(await readFile(path.join(target, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(access(previous), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement restores the target when post-aside lstat fails', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rau-credits-replace-lstat-fail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'credits.json');
  const temp = path.join(directory, 'credits.tmp');
  const previous = replaceTest.backupPath(target);
  await writeFile(target, 'old');
  await writeFile(temp, 'new');
  let asideDone = false;
  const fsImpl = {
    async lstat(filePath) {
      if (asideDone && filePath === previous) throw errorWithCode('EIO');
      return realFs.lstat(filePath);
    },
    stat: (...args) => realFs.stat(...args),
    async rename(from, to) {
      const result = await realFs.rename(from, to);
      if (from === target && to === previous) asideDone = true;
      return result;
    },
    rm: rmFileOnly,
  };

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    { code: 'EIO' },
  );
  assert.equal(await readFile(target, 'utf8'), 'old');
  await assert.rejects(access(previous), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement reports rollback failure when post-aside lstat restore fails', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rau-credits-replace-lstat-rollback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'credits.json');
  const temp = path.join(directory, 'credits.tmp');
  const previous = replaceTest.backupPath(target);
  await writeFile(target, 'old');
  await writeFile(temp, 'new');
  let asideDone = false;
  const fsImpl = {
    async lstat(filePath) {
      if (asideDone && filePath === previous) throw errorWithCode('EIO');
      return realFs.lstat(filePath);
    },
    stat: (...args) => realFs.stat(...args),
    async rename(from, to) {
      if (asideDone && from === previous && to === target) throw errorWithCode('EPERM');
      const result = await realFs.rename(from, to);
      if (from === target && to === previous) asideDone = true;
      return result;
    },
    rm: rmFileOnly,
  };

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    (error) => error.code === 'FILE_REPLACE_ROLLBACK_FAILED'
      && error.backupPath === previous
      && error.tempPath === temp
      && error.errors[0].code === 'EIO'
      && error.errors[1].code === 'EPERM',
  );
  assert.equal(await readFile(previous, 'utf8'), 'old');
  await assert.rejects(access(target), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 recovery does not recursively delete a leftover directory backup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rau-credits-replace-dir-leftover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'credits.json');
  const previous = replaceTest.backupPath(target);
  await writeFile(target, 'new');
  await mkdir(previous);
  await writeFile(path.join(previous, 'inside.txt'), 'keep');

  const fsImpl = {
    lstat: (...args) => realFs.lstat(...args),
    stat: (...args) => realFs.stat(...args),
    rename: (...args) => realFs.rename(...args),
    rm: rmFileOnly,
  };

  assert.equal(await recoverReplacedFile(target, 'win32', { fsImpl, sleep: async () => {} }), false);
  assert.equal(await readFile(target, 'utf8'), 'new');
  assert.equal(await readFile(path.join(previous, 'inside.txt'), 'utf8'), 'keep');
});
