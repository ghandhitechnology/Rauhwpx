import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claudeCredentialExpiry,
  claudeKeychainService,
  parseClaudeOAuthCredential,
  readClaudeCredentialFile,
  readClaudeKeychainCredential,
  readClaudeOAuthCredential,
} from '../claude-credentials.mjs';

const credential = (token, expiresAt = 1_789_000_000_000) =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-refresh`, expiresAt } });

test('the Keychain service name mirrors the CLI namespacing rule', () => {
  assert.equal(claudeKeychainService({ configDir: '/Users/tester/.claude', hasConfigDir: false }), 'Claude Code-credentials');
  const suffix = createHash('sha256').update(path.resolve('/custom/claude')).digest('hex').slice(0, 8);
  assert.equal(
    claudeKeychainService({ configDir: '/custom/claude', hasConfigDir: true }),
    `Claude Code-credentials-${suffix}`,
  );
});

test('only a credential carrying an access token counts as a login', () => {
  assert.equal(parseClaudeOAuthCredential(''), null);
  assert.equal(parseClaudeOAuthCredential('not json'), null);
  assert.equal(parseClaudeOAuthCredential('[]'), null);
  assert.equal(parseClaudeOAuthCredential('{}'), null);
  assert.equal(parseClaudeOAuthCredential('{"claudeAiOauth":{}}'), null);
  assert.equal(parseClaudeOAuthCredential('{"claudeAiOauth":{"accessToken":""}}'), null);
  // A locked-down Keychain item can legitimately read back as an empty object.
  assert.deepEqual(
    parseClaudeOAuthCredential(credential('token')),
    { claudeAiOauth: { accessToken: 'token', refreshToken: 'token-refresh', expiresAt: 1_789_000_000_000 } },
  );
});

test('a missing expiry is reported as zero so freshness never inverts', () => {
  assert.equal(claudeCredentialExpiry(null), 0);
  assert.equal(claudeCredentialExpiry({}), 0);
  assert.equal(claudeCredentialExpiry({ claudeAiOauth: { expiresAt: 'nonsense' } }), 0);
  assert.equal(claudeCredentialExpiry({ claudeAiOauth: { expiresAt: 1_700_000_000_000 } }), 1_700_000_000_000);
});

test('the profile file is preferred over the Keychain item', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rhwp-claude-creds-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await writeFile(path.join(home, '.claude', '.credentials.json'), credential('file-token', Date.now() + 3_600_000));
  let keychainReads = 0;

  const resolved = await readClaudeOAuthCredential({
    homeDir: home,
    env: {},
    platform: 'darwin',
    readKeychainImpl: async () => {
      keychainReads += 1;
      return { claudeAiOauth: { accessToken: 'keychain-token' } };
    },
  });

  assert.equal(resolved.source, 'file');
  assert.equal(JSON.parse(resolved.text).claudeAiOauth.accessToken, 'file-token');
  assert.equal(keychainReads, 0, 'the Keychain is not consulted when the file is present');
});

test('an expired macOS fallback file yields to a live Keychain credential', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rhwp-claude-creds-expired-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await writeFile(path.join(home, '.claude', '.credentials.json'), credential('expired-file', Date.now() - 1));

  const resolved = await readClaudeOAuthCredential({
    homeDir: home,
    env: {},
    platform: 'darwin',
    readKeychainImpl: async () => ({ claudeAiOauth: { accessToken: 'live-keychain', expiresAt: Date.now() + 3_600_000 } }),
  });

  assert.equal(resolved.source, 'keychain');
  assert.equal(JSON.parse(resolved.text).claudeAiOauth.accessToken, 'live-keychain');
});

test('a Keychain-only profile resolves to the Keychain credential', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rhwp-claude-creds-kc-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const seen = [];

  const resolved = await readClaudeOAuthCredential({
    homeDir: home,
    env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
    platform: 'darwin',
    readKeychainImpl: async (options) => {
      seen.push(options);
      return { claudeAiOauth: { accessToken: 'keychain-token' } };
    },
  });

  assert.equal(resolved.source, 'keychain');
  assert.equal(JSON.parse(resolved.text).claudeAiOauth.accessToken, 'keychain-token');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].configDir, path.resolve('/custom/claude'));
  assert.equal(seen[0].hasConfigDir, true);
});

test('a profile with no login resolves to nothing', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rhwp-claude-creds-none-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  assert.equal(await readClaudeOAuthCredential({
    homeDir: home,
    env: {},
    platform: 'darwin',
    readKeychainImpl: async () => null,
  }), null);
});

test('non-macOS platforms never read the Keychain', async () => {
  let calls = 0;
  const result = await readClaudeKeychainCredential({
    configDir: '/home/tester/.claude',
    platform: 'linux',
    exec: async () => {
      calls += 1;
      return { stdout: credential('token') };
    },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test('the Keychain reader rejects empty output and surfaces parsed JSON', async () => {
  assert.equal(await readClaudeKeychainCredential({
    configDir: '/home/tester/.claude',
    platform: 'darwin',
    exec: async () => ({ stdout: '' }),
  }), null);
  assert.deepEqual(await readClaudeKeychainCredential({
    configDir: '/home/tester/.claude',
    platform: 'darwin',
    exec: async () => ({ stdout: credential('keychain-token') }),
  }), { claudeAiOauth: { accessToken: 'keychain-token', refreshToken: 'keychain-token-refresh', expiresAt: 1_789_000_000_000 } });
});

test('the credential file reader refuses symlinks and oversized payloads', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rhwp-claude-creds-unsafe-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const real = path.join(home, 'real.json');
  await writeFile(real, credential('token'));
  const link = path.join(home, 'link.json');
  await symlink(real, link);
  assert.equal(await readClaudeCredentialFile(link), null);

  assert.equal(await readClaudeCredentialFile(path.join(home, 'absent.json')), null);
  assert.equal(await readClaudeCredentialFile(real, { maxBytes: 8 }), null, 'a smaller window rejects a larger credential');
  assert.notEqual(await readClaudeCredentialFile(real), null);
});
