import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCliSetupManager } from '../cli-setup-manager.mjs';

const credential = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'oauth-access-token',
    refreshToken: 'oauth-refresh-token',
    expiresAt: Date.now() + 3_600_000,
  },
});

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write() {} };
  kill() { queueMicrotask(() => this.emit('close', 1)); }
}

test('Claude OAuth publishes a usable login and reports it on macOS-shaped profiles', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-claude-login-mac-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const manager = createCliSetupManager({
    rootDir,
    homeDir: rootDir,
    platform: 'darwin',
    baseEnv: { PATH: '/usr/bin' },
    spawnProcess: (_command, _argv, options) => {
      assert.equal(options.env.HOME, rootDir);
      assert.notEqual(options.env.CLAUDE_CONFIG_DIR, path.join(rootDir, '.claude'));
      assert.equal(options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
      const proc = new FakeProcess();
      queueMicrotask(async () => {
        await mkdir(options.env.CLAUDE_CONFIG_DIR, { recursive: true });
        await writeFile(path.join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), credential);
        proc.emit('close', 0);
      });
      return proc;
    },
  });
  await manager.init();
  await manager.authenticate('claude', 'oauth');
  assert.equal((await manager.status('claude')).authMethod, 'oauth');
  assert.match(await readFile(path.join(rootDir, '.claude', '.credentials.json'), 'utf8'), /oauth-access-token/);
});

test('Claude OAuth redirects the Windows profile and secure storage locations', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-claude-login-win-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const stagedHome = path.join(rootDir, 'staged-home');
  const stagedConfig = path.join(stagedHome, '.claude');
  const transaction = {
    homeDir: stagedHome,
    configDir: stagedConfig,
    credentialFile: path.join(stagedConfig, '.credentials.json'),
    async publish() {},
    async rollback() {},
    async cleanup() {},
    markCommitted() {},
  };
  let loginEnv;
  const manager = createCliSetupManager({
    rootDir,
    homeDir: rootDir,
    platform: 'win32',
    baseEnv: { PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\tester' },
    prepareOAuthCredential: async () => transaction,
    spawnProcess: (_command, _argv, options) => {
      loginEnv = options.env;
      const proc = new FakeProcess();
      queueMicrotask(async () => {
        await mkdir(stagedConfig, { recursive: true });
        await writeFile(transaction.credentialFile, credential);
        proc.emit('close', 0);
      });
      return proc;
    },
  });
  await manager.init();
  await manager.authenticate('claude', 'oauth');
  assert.equal(loginEnv.HOME, stagedHome);
  assert.equal(loginEnv.USERPROFILE, stagedHome);
  assert.equal(loginEnv.CLAUDE_CONFIG_DIR, stagedConfig);
  assert.equal(loginEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR, stagedConfig);
});

test('Claude terminal login exposes PTY output and accepts the pasted code', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-claude-login-terminal-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const stagedHome = path.join(rootDir, 'staged-home');
  const stagedConfig = path.join(stagedHome, '.claude');
  const transaction = {
    homeDir: stagedHome,
    configDir: stagedConfig,
    credentialFile: path.join(stagedConfig, '.credentials.json'),
    async publish() {},
    async rollback() {},
    async cleanup() {},
    markCommitted() {},
  };
  let terminalSpec;
  let input = '';
  const manager = createCliSetupManager({
    rootDir,
    prepareOAuthCredential: async () => transaction,
    createTerminal: (spec) => {
      terminalSpec = spec;
      return {
        done: (async () => {
          await mkdir(stagedConfig, { recursive: true });
          await writeFile(transaction.credentialFile, credential);
          return { code: 0 };
        })(),
        snapshot: () => 'Paste code here if prompted',
        write: (value) => { input += value; },
        resize() {},
        cancel: async () => true,
      };
    },
  });
  await manager.init();
  const running = manager.authenticate('claude', 'oauth', undefined, undefined, { terminal: true });
  await new Promise((resolve) => setImmediate(resolve));
  manager.submitAuthCode('claude', 'browser-code');
  await running;
  assert.deepEqual(terminalSpec.argv, ['auth', 'login']);
  assert.equal(input, 'browser-code\n');
});
