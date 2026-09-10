import assert from 'node:assert/strict';
import { promises as realFs } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CloudHandoffStore, sha256Hex, writeVerifiedRecoveryFile } from '../desktop/cloud-handoff.mjs';
import { recoverReplacedFile, replaceFile, __test as replaceTest } from '../desktop/fs-replace.mjs';
import { createSecretVault } from '../desktop/secret-vault.mjs';

function errorWithCode(code) {
  return Object.assign(new Error(code), { code });
}

function rmFileOnly(filePath, options) {
  if (options?.recursive) throw new Error(`recursive rm is forbidden for ${filePath}`);
  return realFs.rm(filePath, options);
}

function memoryFs(entries, hooks = {}) {
  const files = new Map(entries);
  const fileStat = (filePath) => {
    if (!files.has(filePath)) throw errorWithCode('ENOENT');
    return { isFile: () => true, isDirectory: () => false };
  };
  return {
    files,
    async lstat(filePath) { return fileStat(filePath); },
    async stat(filePath) { return fileStat(filePath); },
    async rename(from, to) {
      await hooks.rename?.(from, to);
      if (!files.has(from)) throw errorWithCode('ENOENT');
      if (files.has(to)) throw errorWithCode('EEXIST');
      files.set(to, files.get(from));
      files.delete(from);
    },
    async rm(filePath) {
      await hooks.rm?.(filePath);
      files.delete(filePath);
    },
  };
}

test('concurrent startup readers wait for the same durable handoff load', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-handoff-load-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'handoffs.json');

  const writer = new CloudHandoffStore({ filePath });
  const created = await writer.create({
    sessionId: 'desktop-session',
    threadId: 'thread-1',
    documentId: 'document-1',
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    provider: 'codex',
    limits: { maxTurns: 100 },
  });

  const reader = new CloudHandoffStore({ filePath });
  const loading = reader.load();
  const getting = reader.get(created.id);
  const listing = reader.list();
  const [, found, records] = await Promise.all([loading, getting, listing]);

  assert.equal(found?.id, created.id);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, created.id);
});

test('handoff persistence survives every write under win32 replace semantics', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-handoff-win32-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'handoffs.json');

  const store = new CloudHandoffStore({ filePath, platform: 'win32' });
  const created = await store.create({
    sessionId: 'desktop-session',
    documentId: 'document-1',
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    provider: 'codex',
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');

  const reloaded = new CloudHandoffStore({ filePath, platform: 'win32' });
  const [record] = await reloaded.list();
  assert.equal(record.state, 'committing');
});

test('verified recovery files replace existing targets under win32 semantics', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-recovery-win32-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'takeover.hwpx');
  const bytes = Buffer.from('recovered document');
  await writeVerifiedRecoveryFile({ filePath, bytes, expectedDigest: sha256Hex(bytes), platform: 'win32' });
  await writeVerifiedRecoveryFile({ filePath, bytes, expectedDigest: sha256Hex(bytes), platform: 'win32' });

  const { readFile, readdir } = await import('node:fs/promises');
  assert.equal((await readFile(filePath)).toString(), 'recovered document');
  assert.deepEqual(await readdir(directory), ['takeover.hwpx']);
});

test('win32 replacement commits even when old-backup cleanup stays locked', async () => {
  const target = 'state.json';
  const temp = 'state.json.tmp';
  const previous = replaceTest.backupPath(target);
  let cleanupLocked = true;
  const fsImpl = memoryFs([[target, 'old'], [temp, 'new']], {
    rm(filePath) {
      if (cleanupLocked && filePath === previous) throw errorWithCode('EPERM');
    },
  });
  const options = { fsImpl, sleep: async () => {} };

  await replaceFile(temp, target, 'win32', options);
  assert.equal(fsImpl.files.get(target), 'new');
  assert.equal(fsImpl.files.get(previous), 'old');

  cleanupLocked = false;
  await recoverReplacedFile(target, 'win32', options);
  assert.equal(fsImpl.files.get(target), 'new');
  assert.equal(fsImpl.files.has(previous), false);
});

test('win32 replacement preserves a deterministic backup after rollback failure', async () => {
  const target = 'state.json';
  const temp = 'state.json.tmp';
  const previous = replaceTest.backupPath(target);
  let commitLocked = true;
  let rollbackLocked = true;
  const fsImpl = memoryFs([[target, 'old'], [temp, 'new']], {
    rename(from, to) {
      if (commitLocked && from === temp && to === target) throw errorWithCode('EPERM');
      if (rollbackLocked && from === previous && to === target) throw errorWithCode('EPERM');
    },
  });
  const options = { fsImpl, sleep: async () => {} };

  await assert.rejects(
    replaceFile(temp, target, 'win32', options),
    (error) => error.code === 'FILE_REPLACE_ROLLBACK_FAILED'
      && error.backupPath === previous
      && error.tempPath === temp,
  );
  assert.equal(fsImpl.files.has(target), false);
  assert.equal(fsImpl.files.get(previous), 'old');
  assert.equal(fsImpl.files.get(temp), 'new');

  commitLocked = false;
  rollbackLocked = false;
  await recoverReplacedFile(target, 'win32', options);
  assert.equal(fsImpl.files.get(target), 'old');
  assert.equal(fsImpl.files.has(previous), false);
});

test('win32 replacement removes its temp file after a successful rollback', async () => {
  const target = 'state.json';
  const temp = 'state.json.tmp';
  const previous = replaceTest.backupPath(target);
  const fsImpl = memoryFs([[target, 'old'], [temp, 'new']], {
    rename(from, to) {
      if (from === temp && to === target) throw errorWithCode('EPERM');
    },
  });

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    (error) => error.code === 'EPERM',
  );
  assert.equal(fsImpl.files.get(target), 'old');
  assert.equal(fsImpl.files.has(previous), false);
  assert.equal(fsImpl.files.has(temp), false);
});

test('win32 replacement removes its temp file when the original stays locked', async () => {
  const target = 'state.json';
  const temp = 'state.json.tmp';
  const previous = replaceTest.backupPath(target);
  const fsImpl = memoryFs([[target, 'old'], [temp, 'new']], {
    rename(from, to) {
      if (from === target && to === previous) throw errorWithCode('EPERM');
    },
  });

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    (error) => error.code === 'EPERM',
  );
  assert.equal(fsImpl.files.get(target), 'old');
  assert.equal(fsImpl.files.has(previous), false);
  assert.equal(fsImpl.files.has(temp), false);
});

test('win32 replacement refuses to move a directory target aside', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-dir-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'handoffs.json');
  const temp = path.join(directory, 'handoffs.tmp');
  await mkdir(target);
  await writeFile(path.join(target, 'inside.txt'), 'keep');
  await writeFile(temp, 'new');

  await assert.rejects(replaceFile(temp, target, 'win32'), { code: 'EISDIR' });
  assert.equal(await readFile(path.join(target, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(access(replaceTest.backupPath(target)), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement recovery does not publish over a restored directory backup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-dir-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'handoffs.json');
  const temp = path.join(directory, 'handoffs.tmp');
  const previous = replaceTest.backupPath(target);
  await mkdir(previous);
  await writeFile(path.join(previous, 'inside.txt'), 'keep');
  await writeFile(temp, 'new');

  await assert.rejects(replaceFile(temp, target, 'win32'), { code: 'EISDIR' });
  assert.equal(await readFile(path.join(target, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(access(previous), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement restores a directory that appears between lstat and rename', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-dir-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'handoffs.json');
  const temp = path.join(directory, 'handoffs.tmp');
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

test('win32 replacement leaves a raced directory stranded when restore fails', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-dir-stranded-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'handoffs.json');
  const temp = path.join(directory, 'handoffs.tmp');
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
    async rename(from, to) {
      if (from === previous && to === target) throw errorWithCode('EPERM');
      return realFs.rename(from, to);
    },
    rm: rmFileOnly,
  };

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    (error) => error.code === 'FILE_REPLACE_ROLLBACK_FAILED'
      && error.backupPath === previous
      && error.tempPath === temp,
  );
  assert.equal(await readFile(path.join(previous, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(access(target), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement restores the target when post-aside lstat fails', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-lstat-fail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'handoffs.json');
  const temp = path.join(directory, 'handoffs.tmp');
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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-lstat-rollback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'handoffs.json');
  const temp = path.join(directory, 'handoffs.tmp');
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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-dir-leftover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'handoffs.json');
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

test('handoff startup restores an interrupted win32 persistence backup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-handoff-recover-win32-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'handoffs.json');
  const writer = new CloudHandoffStore({ filePath, platform: 'win32' });
  const created = await writer.create({
    sessionId: 'desktop-session',
    documentId: 'document-1',
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    provider: 'codex',
    limits: { maxTurns: 100 },
  });
  await rename(filePath, replaceTest.backupPath(filePath));

  const recovered = new CloudHandoffStore({ filePath, platform: 'win32' });
  assert.equal((await recovered.get(created.id))?.id, created.id);
});

test('credential startup restores an interrupted win32 persistence backup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-vault-recover-win32-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'secrets.json');
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return Buffer.from(value); },
    async decryptStringAsync(value) { return { result: value.toString(), shouldReEncrypt: false }; },
  };
  const writer = createSecretVault({ filePath, safeStorage, platform: 'win32' });
  await writer.set('cloud-token', 'secret');
  await rename(filePath, `${filePath}.previous-write`);

  const recovered = createSecretVault({ filePath, safeStorage, platform: 'win32' });
  assert.equal(await recovered.get('cloud-token'), 'secret');
});

test('state-changing stream events preserve messages queued while the transition awaits storage', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-handoff-event-race-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  t.after(async () => { await store.flush(); await rm(directory, { recursive: true, force: true }); });
  const created = await store.create({
    sessionId: 'desktop-session', documentId: 'document-1', documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'), provider: 'codex', limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, 'queued');
  await store.patch(created.id, { queuedMessages: [{ id: 'first', state: 'queued' }] });
  let releaseTransition;
  let transitionBlocked;
  const blocked = new Promise((resolve) => { transitionBlocked = resolve; });
  const gate = new Promise((resolve) => { releaseTransition = resolve; });
  const load = store.load.bind(store);
  let loads = 0;
  store.load = async () => {
    await load();
    if (++loads === 2) { transitionBlocked(); await gate; }
  };
  const event = store.applyEvent(created.id, {
    sequence: 2, state: 'running',
    patch: (latest) => ({ queuedMessages: latest.queuedMessages.map((message) => (
      message.id === 'first' ? { ...message, state: 'accepted' } : message
    )) }),
  });
  await blocked;
  await store.patch(created.id, (latest) => ({ queuedMessages: [...latest.queuedMessages, { id: 'second', state: 'queued' }] }));
  releaseTransition();
  await event;
  const final = await store.get(created.id);
  assert.equal(final.state, 'running');
  assert.deepEqual(final.queuedMessages, [{ id: 'first', state: 'accepted' }, { id: 'second', state: 'queued' }]);
});
