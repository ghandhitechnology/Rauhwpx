import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProviderManager } from '../src/provider-manager.mjs';
import { ProviderCliManager } from '../src/provider-cli.mjs';
import {
  PROVIDER_KEY_ENV,
  encodeProviderSession,
  parseProviderCredentialBody,
  parseProviderSession,
  sandboxCredentialVariables,
  writeProviderAuthFiles,
} from '../src/provider-credentials.mjs';

const PROVIDERS = ['claude', 'codex', 'grok', 'pi', 'cursor'];

function fakeVersion() {
  const child = new EventEmitter();
  child.stdout = { on(event, callback) { if (event === 'data') queueMicrotask(() => callback('1.0.0\n')); } };
  child.stderr = { on() {} };
  child.kill = () => {};
  queueMicrotask(() => child.emit('close', 0));
  return child;
}

test('sandbox variables attach each key to its own provider', () => {
  const variables = sandboxCredentialVariables([
    { provider: 'codex', apiKey: 'sk-proj-codex', files: [] },
    { provider: 'claude', apiKey: 'sk-ant-claude', files: [] },
  ]);
  assert.equal(variables.RAUHWpx_PROVIDER_KEY_CODEX, 'sk-proj-codex');
  assert.equal(variables.RAUHWpx_PROVIDER_KEY_CLAUDE, 'sk-ant-claude');
  assert.equal(variables.RAUHWpx_PROVIDER_KEY_GROK, undefined);
  assert.equal(variables.RAUHWpx_PROVIDER_SESSION, undefined);
});

test('credential body requires a key or an auth file', () => {
  for (const provider of PROVIDERS) {
    assert.throws(() => parseProviderCredentialBody(provider, {}), { code: 'PROVIDER_KEY_REQUIRED' });
  }
  assert.deepEqual(
    parseProviderCredentialBody('pi', { apiKey: ' sk-or-key ' }),
    { provider: 'pi', apiKey: 'sk-or-key', files: [] },
  );
  assert.throws(
    () => parseProviderCredentialBody('codex', { files: [{ path: '../etc/passwd', content: 'x' }] }),
    { code: 'INVALID_CREDENTIAL' },
  );
});

test('a provider session round-trips every auth file the probe accepts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-provider-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    claude: [
      { path: '.claude.json', content: '{"oauth":"claude"}' },
      { path: '.claude/.credentials.json', content: '{"token":"claude"}' },
    ],
    codex: [{ path: '.codex/auth.json', content: '{"token":"codex"}' }],
    grok: [{ path: '.grok/auth.json', content: '{"token":"grok"}' }],
    cursor: [{ path: '.cursor/cli-config.json', content: '{"token":"cursor"}' }],
  };
  const encoded = encodeProviderSession(Object.entries(files).map(([provider, list]) => ({
    provider,
    files: list,
  })));
  const session = parseProviderSession(encoded);
  assert.equal(session.providers.length, 4);
  for (const item of session.providers) {
    writeProviderAuthFiles(root, item.provider, item.files);
  }
  assert.equal(
    await fs.readFile(path.join(root, 'codex', '.codex', 'auth.json'), 'utf8'),
    '{"token":"codex"}',
  );
  assert.equal(
    await fs.readFile(path.join(root, 'claude', '.claude', '.credentials.json'), 'utf8'),
    '{"token":"claude"}',
  );
});

test('seed writes vault keys and auth files then marks the provider authenticated', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-provider-seed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = {
    values: new Map(),
    list() {
      return [...this.values.entries()].map(([key]) => {
        const [provider] = key.split('\0');
        return { provider };
      });
    },
    set(provider, name, value) { this.values.set(`${provider}\0${name}`, value); },
    get(provider, name) { return this.values.get(`${provider}\0${name}`) ?? null; },
  };
  const statuses = new Map();
  const sessionStore = {
    setProviderStatus(provider, status) {
      const next = { provider, ...status };
      statuses.set(provider, next);
      return next;
    },
  };
  const providerManager = new ProviderManager(sessionStore, {
    providerAuthDirectory: path.join(root, 'provider-auth'),
    vault,
    spawnProcess: () => fakeVersion(),
  });
  const cli = new ProviderCliManager({
    providerAuthDirectory: path.join(root, 'provider-auth'),
    providerCliDirectory: path.join(root, 'cli'),
  }, providerManager, vault);

  const keySeed = await cli.seed('pi', { apiKey: 'sk-or-pi' });
  assert.equal(keySeed.authenticated, true);
  assert.equal(vault.get('pi', 'OPENROUTER_API_KEY'), 'sk-or-pi');

  const fileSeed = await cli.seed('codex', {
    files: [{ path: '.codex/auth.json', content: '{"token":"codex"}' }],
  });
  assert.equal(fileSeed.authenticated, true);
  assert.equal(
    await fs.readFile(path.join(root, 'provider-auth', 'codex', '.codex', 'auth.json'), 'utf8'),
    '{"token":"codex"}',
  );
  assert.equal(PROVIDER_KEY_ENV.pi, 'RAUHWpx_PROVIDER_KEY_PI');
});
