import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSecretVault, handleSecretRequest } from '../../../desktop/secret-vault.mjs';
import {
  recoverInterruptedFileReplacement,
  removeFileAndReplacementBackup,
  replaceFileAtomically,
  retryLockedOperation,
} from '../harness-update.mjs';
import { bundledNpmLaunch } from '../npm-runtime.mjs';
import { terminateProcessTree } from '../process-tree.mjs';
import { createIpcSecretStore } from '../secret-store.mjs';
import { setupFailureMessage, shouldUseNpmNetworkPath } from '../setup-errors.mjs';

test('the bundled npm launcher uses the current Node-compatible executable', () => {
  const launch = bundledNpmLaunch({ nodeCommand: 'Rauhwpx.exe' });
  assert.equal(launch.command, 'Rauhwpx.exe');
  assert.match(launch.leadingArgs[0], /npm[/\\]bin[/\\]npm-cli\.js$/);
});

test('Windows process cleanup never retargets a reusable PID after its first tree command', async () => {
  const calls = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4312,
    exitCode: null,
    signalCode: null,
    kill: () => assert.fail('taskkill should handle Windows cleanup'),
  });
  let escalate;
  terminateProcessTree(child, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    spawnProcess(command, argv, options) {
      calls.push({ command, argv, options });
      return new EventEmitter();
    },
    setTimer(callback) {
      escalate = callback;
      return { unref() {} };
    },
  });
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(calls[0].argv, ['/PID', '4312', '/T', '/F']);
  escalate();
  assert.equal(calls.length, 1);
  assert.ok(calls.every(({ options }) => options.shell === false && options.windowsHide === true));
});

test('Windows file locks are retried and then reported with a stable error code', async () => {
  let attempts = 0;
  const result = await retryLockedOperation(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return 'ok';
  }, { platform: 'win32', delays: [0, 0] });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);

  await assert.rejects(
    () => retryLockedOperation(
      async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
      { platform: 'win32', delays: [0] },
    ),
    (error) => error.code === 'HARNESS_FILES_LOCKED',
  );
});

test('Windows file replacement refuses to move a directory target aside', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-file-replace-dir-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'state.json');
  const temp = path.join(root, 'state.tmp');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'inside.txt'), 'keep');
  await fs.writeFile(temp, 'new');

  await assert.rejects(
    replaceFileAtomically(temp, target, { platform: 'win32' }),
    { code: 'EISDIR' },
  );
  assert.equal(await fs.readFile(path.join(target, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(fs.access(`${target}.previous-write`), { code: 'ENOENT' });
});

test('Windows replacement recovery does not publish over a restored directory backup', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-file-replace-dir-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'state.json');
  const temp = path.join(root, 'state.tmp');
  const previous = `${target}.previous-write`;
  await fs.mkdir(previous);
  await fs.writeFile(path.join(previous, 'inside.txt'), 'keep');
  await fs.writeFile(temp, 'new');

  await assert.rejects(
    replaceFileAtomically(temp, target, { platform: 'win32' }),
    { code: 'EISDIR' },
  );
  assert.equal(await fs.readFile(path.join(target, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(fs.access(previous), { code: 'ENOENT' });
  assert.equal(await fs.readFile(temp, 'utf8'), 'new');
});

test('a stale Windows backup cleanup cannot turn a committed replacement into failure', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-file-replace-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'state.json');
  const temp = path.join(root, 'state.tmp');
  const previous = `${target}.previous-write`;
  await fs.writeFile(target, 'old');
  await fs.writeFile(temp, 'new');
  let previousRemovals = 0;
  const fsApi = {
    access: (...args) => fs.access(...args),
    rename: (...args) => fs.rename(...args),
    async rm(filePath, options) {
      if (filePath === previous && ++previousRemovals === 2) {
        throw Object.assign(new Error('backup still locked'), { code: 'EIO' });
      }
      return fs.rm(filePath, options);
    },
  };

  await replaceFileAtomically(temp, target, { platform: 'win32', fsApi });

  assert.equal(await fs.readFile(target, 'utf8'), 'new');
  assert.equal(await fs.readFile(previous, 'utf8'), 'old');
});

test('Windows replacement recovery restores a backup left at the rename gap', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-file-replace-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'state.json');
  const previous = `${target}.previous-write`;
  await fs.writeFile(previous, 'recover me');

  assert.equal(
    await recoverInterruptedFileReplacement(target, { platform: 'win32' }),
    true,
  );
  assert.equal(await fs.readFile(target, 'utf8'), 'recover me');
  await assert.rejects(fs.access(previous), { code: 'ENOENT' });
});

test('Windows deletion removes recovery state first and fails closed when it is locked', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-file-delete-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'state.json');
  const previous = `${target}.previous-write`;
  await fs.writeFile(target, 'current');
  await fs.writeFile(previous, 'stale');

  await assert.rejects(
    removeFileAndReplacementBackup(target, {
      platform: 'win32',
      delays: [],
      fsApi: {
        async rm(filePath, options) {
          if (filePath === previous) {
            throw Object.assign(new Error('backup locked'), { code: 'EACCES' });
          }
          return fs.rm(filePath, options);
        },
      },
    }),
    { code: 'HARNESS_FILES_LOCKED' },
  );
  assert.equal(await fs.readFile(target, 'utf8'), 'current');

  await removeFileAndReplacementBackup(target, { platform: 'win32' });
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  await assert.rejects(fs.access(previous), { code: 'ENOENT' });
});

test('setup errors give Windows-specific proxy, certificate, lock and path guidance', () => {
  assert.match(setupFailureMessage({ code: 'EPERM' }, '', ''), /사용 중/);
  assert.match(setupFailureMessage({ code: 'ENAMETOOLONG' }, '', ''), /C:\\rhwp/);
  assert.match(setupFailureMessage(null, 'SELF_SIGNED_CERT_IN_CHAIN', ''), /NODE_EXTRA_CA_CERTS/);
  assert.match(setupFailureMessage({ code: 'ECONNRESET' }, '', ''), /HTTPS_PROXY/);
  assert.equal(shouldUseNpmNetworkPath({ HTTPS_PROXY: 'http://proxy' }), true);
  assert.equal(shouldUseNpmNetworkPath({ NODE_EXTRA_CA_CERTS: 'C:\\corp.pem' }), true);
});

test('the desktop vault persists ciphertext and serves IPC requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-vault-'));
  const filePath = path.join(root, 'secrets.json');
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return Buffer.from(`protected:${value}`); },
    async decryptStringAsync(value) {
      return { shouldReEncrypt: false, result: value.toString().replace(/^protected:/, '') };
    },
  };
  const vault = createSecretVault({ filePath, safeStorage, platform: 'win32' });
  const response = await handleSecretRequest(vault, {
    type: 'rhwp-secret-request', id: '1', operation: 'set', key: 'rhwp.test', value: 'sk-secret',
  });
  assert.equal(response.ok, true);
  await vault.set('rhwp.test', 'sk-secret-rotated');
  assert.equal(await vault.get('rhwp.test'), 'sk-secret-rotated');
  assert.doesNotMatch(await fs.readFile(filePath, 'utf8'), /sk-secret-rotated/);
  await fs.rm(root, { recursive: true, force: true });
});

test('a failed Windows backup cleanup cannot roll the vault cache back', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-vault-cleanup-'));
  const filePath = path.join(root, 'secrets.json');
  const previous = `${filePath}.previous-write`;
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return Buffer.from(`protected:${value}`); },
    async decryptStringAsync(value) {
      return { shouldReEncrypt: false, result: value.toString().replace(/^protected:/, '') };
    },
  };
  let removeCalls = 0;
  const vault = createSecretVault({
    filePath,
    safeStorage,
    platform: 'win32',
    fileOperations: {
      async rm(...args) {
        removeCalls += 1;
        if (removeCalls === 3) throw Object.assign(new Error('cleanup failed'), { code: 'EIO' });
        return fs.rm(...args);
      },
    },
  });

  await vault.set('rhwp.first', 'one');
  await vault.set('rhwp.second', 'two');
  assert.equal((await fs.stat(previous)).isFile(), true);
  await vault.set('rhwp.third', 'three');

  const reloaded = createSecretVault({ filePath, safeStorage, platform: 'win32' });
  assert.equal(await reloaded.get('rhwp.first'), 'one');
  assert.equal(await reloaded.get('rhwp.second'), 'two');
  assert.equal(await reloaded.get('rhwp.third'), 'three');
  await fs.rm(root, { recursive: true, force: true });
});

test('a locked stale Windows vault backup does not invalidate the committed primary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-vault-stale-lock-'));
  const filePath = path.join(root, 'secrets.json');
  const previous = `${filePath}.previous-write`;
  const encoded = Buffer.from('protected:committed-secret').toString('base64');
  const body = JSON.stringify({ version: 1, secrets: { 'rhwp.test': encoded } });
  await fs.writeFile(filePath, body);
  await fs.writeFile(previous, body);
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return Buffer.from(`protected:${value}`); },
    async decryptStringAsync(value) {
      return { shouldReEncrypt: false, result: value.toString().replace(/^protected:/, '') };
    },
  };
  const vault = createSecretVault({
    filePath,
    safeStorage,
    platform: 'win32',
    fileOperations: {
      async rm(target, options) {
        if (target === previous) throw Object.assign(new Error('backup locked'), { code: 'EACCES' });
        return fs.rm(target, options);
      },
    },
  });

  assert.equal(await vault.get('rhwp.test'), 'committed-secret');
  assert.equal((await fs.stat(previous)).isFile(), true);
  await fs.rm(root, { recursive: true, force: true });
});

test('the Windows vault recovers a validated previous-write after an interrupted replace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-vault-recover-'));
  const filePath = path.join(root, 'secrets.json');
  const previous = `${filePath}.previous-write`;
  const encoded = Buffer.from('protected:recovered-secret').toString('base64');
  await fs.writeFile(previous, JSON.stringify({
    version: 1,
    secrets: { 'rhwp.test': encoded },
  }));
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return Buffer.from(`protected:${value}`); },
    async decryptStringAsync(value) {
      return { shouldReEncrypt: false, result: value.toString().replace(/^protected:/, '') };
    },
  };

  const vault = createSecretVault({ filePath, safeStorage, platform: 'win32' });
  assert.equal(await vault.get('rhwp.test'), 'recovered-secret');
  assert.equal((await fs.stat(filePath)).isFile(), true);
  await assert.rejects(fs.access(previous), { code: 'ENOENT' });
  await fs.rm(root, { recursive: true, force: true });
});

test('vault reset is serialized after an in-flight read and re-encryption', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-vault-reset-race-'));
  const filePath = path.join(root, 'secrets.json');
  const encoded = Buffer.from('protected:old-secret').toString('base64');
  await fs.writeFile(filePath, JSON.stringify({
    version: 1,
    secrets: { 'rhwp.test': encoded },
  }));
  let releaseDecrypt;
  let markDecryptStarted;
  const decryptStarted = new Promise((resolve) => { markDecryptStarted = resolve; });
  const decryptGate = new Promise((resolve) => { releaseDecrypt = resolve; });
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return Buffer.from(`protected:new:${value}`); },
    async decryptStringAsync(value) {
      markDecryptStarted();
      await decryptGate;
      return {
        shouldReEncrypt: true,
        result: value.toString().replace(/^protected:/, ''),
      };
    },
  };
  const vault = createSecretVault({ filePath, safeStorage, platform: 'win32' });

  const reading = vault.get('rhwp.test');
  await decryptStarted;
  const resetting = vault.reset();
  releaseDecrypt();
  assert.equal(await reading, 'old-secret');
  await resetting;
  assert.equal(await vault.get('rhwp.test'), null);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('secrets.json.reset-')), true);
  await fs.rm(root, { recursive: true, force: true });
});

test('a corrupt desktop vault fails closed until an explicit quarantining reset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-vault-corrupt-'));
  const filePath = path.join(root, 'secrets.json');
  await fs.writeFile(filePath, '{not-json');
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return Buffer.from(`protected:${value}`); },
    async decryptStringAsync(value) {
      return { shouldReEncrypt: false, result: value.toString().replace(/^protected:/, '') };
    },
  };
  const vault = createSecretVault({ filePath, safeStorage, platform: 'win32' });

  await assert.rejects(() => vault.get('rhwp.test'), { code: 'SECRET_VAULT_CORRUPT' });
  await assert.rejects(() => vault.set('rhwp.test', 'must-not-overwrite'), { code: 'SECRET_VAULT_CORRUPT' });
  assert.equal(await fs.readFile(filePath, 'utf8'), '{not-json');

  await vault.reset();
  await vault.set('rhwp.test', 'fresh-secret');
  assert.equal(await vault.get('rhwp.test'), 'fresh-secret');
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('secrets.json.reset-')), true);
  await fs.rm(root, { recursive: true, force: true });
});

test('the desktop vault rejects oversized files and plaintext secrets before allocation or encryption', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-vault-limits-'));
  const filePath = path.join(root, 'secrets.json');
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync() { assert.fail('oversized plaintext must not be encrypted'); },
    async decryptStringAsync() { assert.fail('oversized vault must not be decrypted'); },
  };
  const vault = createSecretVault({ filePath, safeStorage, platform: 'win32' });
  await assert.rejects(
    () => vault.set('rhwp.test', 'x'.repeat((64 * 1024) + 1)),
    /64 KiB/,
  );

  await fs.writeFile(filePath, 'x');
  await fs.truncate(filePath, (8 * 1024 * 1024) + 1);
  const oversizedVault = createSecretVault({ filePath, safeStorage, platform: 'win32' });
  await assert.rejects(() => oversizedVault.get('rhwp.test'), { code: 'SECRET_VAULT_CORRUPT' });
  await fs.rm(root, { recursive: true, force: true });
});

test('the hub secret client correlates IPC responses without writing locally', async () => {
  const processRef = new EventEmitter();
  processRef.env = { RHWP_SECRET_BROKER: 'ipc' };
  processRef.send = (message, callback) => {
    callback?.(null);
    queueMicrotask(() => processRef.emit('message', {
      type: 'rhwp-secret-response', id: message.id, ok: true, value: message.value ?? 'stored',
    }));
  };
  const store = createIpcSecretStore({ processRef });
  assert.equal(await store.set('rhwp.test', 'secret'), 'secret');
  assert.equal(await store.get('rhwp.test'), 'stored');
});
