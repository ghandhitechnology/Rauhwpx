import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSecretVault, handleSecretRequest } from '../../../desktop/secret-vault.mjs';
import { retryLockedOperation } from '../harness-update.mjs';
import { bundledNpmLaunch } from '../npm-runtime.mjs';
import { terminateProcessTree } from '../process-tree.mjs';
import { createIpcSecretStore } from '../secret-store.mjs';
import { setupFailureMessage, shouldUseNpmNetworkPath } from '../setup-errors.mjs';

test('the bundled npm launcher uses the current Node-compatible executable', () => {
  const launch = bundledNpmLaunch({ nodeCommand: 'Rauhwpx.exe' });
  assert.equal(launch.command, 'Rauhwpx.exe');
  assert.match(launch.leadingArgs[0], /npm[/\\]bin[/\\]npm-cli\.js$/);
});

test('Windows process cleanup gracefully terminates then force-kills the descendant tree', async () => {
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
    spawnProcess(command, argv, options) {
      calls.push({ command, argv, options });
      return new EventEmitter();
    },
    setTimer(callback) {
      escalate = callback;
      return { unref() {} };
    },
  });
  assert.deepEqual(calls[0].argv, ['/PID', '4312', '/T']);
  escalate();
  assert.deepEqual(calls[1].argv, ['/PID', '4312', '/T', '/F']);
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
