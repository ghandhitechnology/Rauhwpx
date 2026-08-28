import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PROVIDER_AUTH_FILES, PROVIDER_KEY_ENV } from '../cloud/src/provider-credentials.mjs';
import { DESKTOP_PROVIDER_AUTH as TRANSFER_PROVIDER_AUTH } from '../desktop/cloud-provider-auth.mjs';
import {
  PROVIDER_AUTH_FILES as DESKTOP_AUTH_FILES,
  PROVIDER_API_KEY_ENV,
  PROVIDER_KEY_ENV as DESKTOP_KEY_ENV,
  PROVIDER_SECRET_IDS,
  collectProviderAuth,
  hasProviderAuth,
  requireProviderAuth,
  sandboxCredentialVariables,
} from '../desktop/provider-auth.mjs';

test('desktop and cloud keep the same provider auth contract', () => {
  assert.deepEqual(DESKTOP_AUTH_FILES, PROVIDER_AUTH_FILES);
  assert.deepEqual(DESKTOP_KEY_ENV, PROVIDER_KEY_ENV);
  for (const [provider, envName] of Object.entries(PROVIDER_API_KEY_ENV)) {
    assert.equal(envName, TRANSFER_PROVIDER_AUTH[provider].envName);
  }
});

function memoryVault(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: async (key) => values.get(key) ?? null,
  };
}

test('collectProviderAuth reads only the selected provider secret', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-provider-auth-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"codex"}');
  const vault = memoryVault({
    [PROVIDER_SECRET_IDS.codex]: 'sk-proj-codex',
    [PROVIDER_SECRET_IDS.claude]: 'sk-ant-claude',
  });
  const codex = await collectProviderAuth('codex', { vault, homeDir: home, cliRoot: path.join(home, 'cli') });
  assert.equal(codex.apiKey, 'sk-proj-codex');
  assert.deepEqual(codex.files, [{ path: '.codex/auth.json', content: '{"token":"codex"}' }]);
  const claude = await collectProviderAuth('claude', { vault, homeDir: home, cliRoot: path.join(home, 'cli') });
  assert.equal(claude.apiKey, 'sk-ant-claude');
  assert.deepEqual(claude.files, []);
  const variables = sandboxCredentialVariables(codex);
  assert.equal(variables.RAUHWpx_PROVIDER_KEY_CODEX, 'sk-proj-codex');
  assert.equal(variables.RAUHWpx_PROVIDER_KEY_CLAUDE, undefined);
});

test('collectProviderAuth maps only the selected provider environment key', async () => {
  const auth = await collectProviderAuth('codex', {
    vault: memoryVault(),
    homeDir: '/missing-provider-home',
    cliRoot: '/missing-provider-cli',
    env: {
      [PROVIDER_API_KEY_ENV.codex]: '  sk-proj-from-env  ',
      [PROVIDER_API_KEY_ENV.claude]: 'sk-ant-must-not-leak',
    },
  });
  assert.deepEqual(auth, {
    provider: 'codex',
    apiKey: 'sk-proj-from-env',
    files: [],
  });
});

test('every provider can supply a cloud seed payload', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-provider-all-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cliRoot = path.join(home, 'cli');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude.json'), '{"oauth":"claude"}');
  await fs.writeFile(path.join(home, '.claude', '.credentials.json'), '{"token":"claude"}');
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"codex"}');
  await fs.mkdir(path.join(home, '.grok'), { recursive: true });
  await fs.writeFile(path.join(home, '.grok', 'auth.json'), '{"token":"grok"}');
  await fs.mkdir(path.join(cliRoot, 'cursor-home', '.cursor'), { recursive: true });
  await fs.writeFile(path.join(cliRoot, 'cursor-home', '.cursor', 'cli-config.json'), '{"token":"cursor"}');
  const vault = memoryVault({ [PROVIDER_SECRET_IDS.pi]: 'sk-or-pi' });

  const expected = {
    claude: ['.claude.json', '.claude/.credentials.json'],
    codex: ['.codex/auth.json'],
    grok: ['.grok/auth.json'],
    cursor: ['.cursor/cli-config.json'],
    pi: [],
  };
  for (const [provider, paths] of Object.entries(expected)) {
    const auth = await collectProviderAuth(provider, { vault, homeDir: home, cliRoot });
    assert.equal(auth.provider, provider);
    assert.deepEqual(auth.files.map((file) => file.path), paths);
    if (provider === 'pi') {
      assert.equal(auth.apiKey, 'sk-or-pi');
      assert.equal(hasProviderAuth(auth), true);
    } else {
      assert.equal(auth.apiKey, null);
      assert.equal(hasProviderAuth(auth), true);
    }
  }
  await assert.rejects(
    async () => requireProviderAuth(await collectProviderAuth('codex', {
      vault: memoryVault(),
      homeDir: path.join(home, 'empty'),
      cliRoot: path.join(home, 'empty-cli'),
    })),
    { code: 'PROVIDER_KEY_REQUIRED' },
  );
});
