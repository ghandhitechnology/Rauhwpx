import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BlobStore } from '../src/blob-store.mjs';
import { openDatabase } from '../src/database.mjs';
import {
  PROVIDER_AUTH,
  applyProviderAuth,
  parseProviderAuth,
  resolveAuthFile,
} from '../src/provider-auth.mjs';
import { ProviderManager } from '../src/provider-manager.mjs';
import { PROVIDERS } from '../src/protocol.mjs';
import { SecretVault } from '../src/secret-vault.mjs';
import { SessionStore } from '../src/session-store.mjs';

const AUTH_BUNDLES = Object.freeze({
  claude: {
    secrets: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    files: { '.claude/.credentials.json': '{"oauth":"claude"}' },
  },
  codex: {
    secrets: { OPENAI_API_KEY: 'sk-proj-test' },
    files: { '.codex/auth.json': '{"tokens":{"access":"codex"}}' },
  },
  pi: {
    secrets: { OPENROUTER_API_KEY: 'sk-or-v1-test' },
    files: {},
  },
  grok: {
    secrets: { XAI_API_KEY: 'xai-test' },
    files: { '.grok/auth.json': '{"token":"grok"}' },
  },
  cursor: {
    secrets: { CURSOR_API_KEY: 'cur-test' },
    files: { '.cursor/cli-config.json': '{"auth":"cursor"}' },
  },
});

function versionProcess(command) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  queueMicrotask(() => {
    child.stdout.end(`${command} 1.0.0\n`);
    child.stderr.end();
    child.emit('close', 0);
  });
  return child;
}

async function vaultFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-provider-auth-'));
  const database = openDatabase(path.join(root, 'cloud.sqlite3'));
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    vault: new SecretVault(database, { dataDirectory: root }),
    authDirectory: path.join(root, 'provider-auth'),
    sessions: new SessionStore(database, new BlobStore(database, { root: path.join(root, 'objects') })),
  };
}

test('every provider auth catalog entry has a vault secret and allow-listed files', () => {
  assert.deepEqual(Object.keys(PROVIDER_AUTH), [...PROVIDERS]);
  for (const provider of PROVIDERS) {
    const spec = PROVIDER_AUTH[provider];
    assert.match(spec.secretName, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(Array.isArray(spec.files));
    for (const filename of spec.files) resolveAuthFile('/tmp/auth', filename);
  }
});

test('parseProviderAuth rejects unknown secrets, files, and empty imports', () => {
  assert.throws(() => parseProviderAuth('codex', {}), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseProviderAuth('codex', { secrets: { ANTHROPIC_API_KEY: 'x' } }), { code: 'INVALID_CREDENTIAL' });
  assert.throws(() => parseProviderAuth('codex', { files: { '../auth.json': '{}' } }), { code: 'INVALID_CREDENTIAL' });
  assert.throws(() => parseProviderAuth('nope', { secrets: { OPENAI_API_KEY: 'x' } }), { code: 'INVALID_PROVIDER' });
});

test('applying auth writes vault secrets and allow-listed files for every provider', async (t) => {
  const { vault, authDirectory } = await vaultFixture(t);
  for (const provider of PROVIDERS) {
    const imported = await applyProviderAuth(provider, parseProviderAuth(provider, AUTH_BUNDLES[provider]), {
      vault,
      authDirectory,
    });
    assert.equal(imported.provider, provider);
    assert.deepEqual(imported.importedSecrets, Object.keys(AUTH_BUNDLES[provider].secrets));
    assert.deepEqual(imported.importedFiles, Object.keys(AUTH_BUNDLES[provider].files));
    assert.equal(vault.get(provider, PROVIDER_AUTH[provider].secretName), AUTH_BUNDLES[provider].secrets[PROVIDER_AUTH[provider].secretName]);
    for (const [relative, content] of Object.entries(AUTH_BUNDLES[provider].files)) {
      assert.equal(await fs.readFile(path.join(authDirectory, provider, relative), 'utf8'), content);
    }
  }
});

test('ProviderManager treats imported files and vault secrets as authenticated', async (t) => {
  const { vault, authDirectory, sessions } = await vaultFixture(t);
  const manager = new ProviderManager(sessions, {
    providerAuthDirectory: authDirectory,
    vault,
    spawnProcess: (command, args) => {
      assert.deepEqual(args, ['--version']);
      return versionProcess(command);
    },
  });
  await applyProviderAuth('codex', parseProviderAuth('codex', AUTH_BUNDLES.codex), { vault, authDirectory });
  const withFiles = await manager.probe('codex');
  assert.equal(withFiles.available, true);
  assert.equal(withFiles.authenticated, true);
  assert.equal(withFiles.authRequired, false);

  await applyProviderAuth('pi', parseProviderAuth('pi', AUTH_BUNDLES.pi), { vault, authDirectory });
  const emptyRoot = path.join(authDirectory, 'empty');
  const emptyManager = new ProviderManager(sessions, {
    providerAuthDirectory: emptyRoot,
    vault,
    spawnProcess: (command) => versionProcess(command),
  });
  const withVaultOnly = await emptyManager.probe('pi');
  assert.equal(existsSync(path.join(emptyRoot, 'pi')), false);
  assert.equal(withVaultOnly.authenticated, true);
});

test('ProviderManager probes only selected providers and never overlaps CLI startup', async (t) => {
  const { vault, authDirectory, sessions } = await vaultFixture(t);
  let active = 0;
  let maximumActive = 0;
  const commands = [];
  const manager = new ProviderManager(sessions, {
    providerAuthDirectory: authDirectory,
    vault,
    spawnProcess: (command) => {
      commands.push(command);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const child = versionProcess(command);
      child.on('close', () => { active -= 1; });
      return child;
    },
  });

  await manager.probeAll(['codex', 'pi']);
  assert.deepEqual(commands, ['codex', 'pi']);
  assert.equal(maximumActive, 1);
});
