import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectProviderSession,
  decodeProviderSession,
  encodeProviderSession,
  listLocalSessionProviders,
  writeProviderSession,
} from '../src/provider-session.mjs';

async function homeFixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-provider-session-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('collect reads regular session files and skips symlinks or oversized ones', async (t) => {
  const home = await homeFixture(t);
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"oauth"}');
  await writeFile(path.join(home, 'elsewhere.json'), '{"claude":true}');
  await symlink(path.join(home, 'elsewhere.json'), path.join(home, '.claude.json'));
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  await writeFile(path.join(home, '.cursor', 'cli-config.json'), 'x'.repeat(20 * 1024));

  assert.deepEqual(collectProviderSession('codex', { home, env: {} }), {
    provider: 'codex',
    files: [{ path: '.codex/auth.json', text: '{"token":"oauth"}' }],
  });
  assert.equal(collectProviderSession('claude', { home, env: {} }), null);
  assert.equal(collectProviderSession('cursor', { home, env: {} }), null);
  assert.equal(collectProviderSession('pi', { home, env: {} }), null);
  assert.deepEqual(listLocalSessionProviders({ home, env: {} }), ['codex']);
});

test('collect honors CODEX_HOME and GROK_HOME', async (t) => {
  const home = await homeFixture(t);
  const codexHome = path.join(home, 'custom-codex');
  const grokHome = path.join(home, 'custom-grok');
  await mkdir(codexHome, { recursive: true });
  await mkdir(grokHome, { recursive: true });
  await writeFile(path.join(codexHome, 'auth.json'), '{"codex":true}');
  await writeFile(path.join(grokHome, 'auth.json'), '{"grok":true}');

  assert.deepEqual(collectProviderSession('codex', { home, env: { CODEX_HOME: codexHome } }), {
    provider: 'codex',
    files: [{ path: '.codex/auth.json', text: '{"codex":true}' }],
  });
  assert.deepEqual(collectProviderSession('grok', { home, env: { GROK_HOME: grokHome } }), {
    provider: 'grok',
    files: [{ path: '.grok/auth.json', text: '{"grok":true}' }],
  });
});

test('encode, decode, and write keep only the allowlisted destination files', async (t) => {
  const home = await homeFixture(t);
  const session = {
    provider: 'claude',
    files: [
      { path: '.claude/.credentials.json', text: '{"ok":true}' },
      { path: '.ssh/id_rsa', text: 'secret' },
      { path: '.claude.json', text: '{"extra":true}' },
    ],
  };
  const encoded = encodeProviderSession(session);
  const decoded = decodeProviderSession(encoded);
  assert.deepEqual(decoded, {
    provider: 'claude',
    files: [
      { path: '.claude/.credentials.json', text: '{"ok":true}' },
      { path: '.claude.json', text: '{"extra":true}' },
    ],
  });
  const authHome = path.join(home, 'provider-auth', 'claude');
  assert.equal(writeProviderSession(authHome, decoded), true);
  assert.equal(
    await readFile(path.join(authHome, '.claude', '.credentials.json'), 'utf8'),
    '{"ok":true}',
  );
  assert.equal(await readFile(path.join(authHome, '.claude.json'), 'utf8'), '{"extra":true}');
  await assert.rejects(() => readFile(path.join(authHome, '.ssh', 'id_rsa')));
  assert.equal(decodeProviderSession('not-base64'), null);
});
