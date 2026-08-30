import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OAUTH_STAGING_STALE_AFTER_MS,
  OAUTH_STAGING_OWNER_FILE,
  OAUTH_STAGING_OWNER_MAX_BYTES,
  cleanupStaleOAuthCredentialStaging,
  prepareStagedOAuthCredential,
} from '../oauth-credential-transaction.mjs';

async function fixture(t, initial, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-oauth-credential-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, 'profile', '.cursor', 'cli-config.json');
  if (initial !== undefined) {
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, JSON.stringify(initial));
  }
  const transaction = await prepareStagedOAuthCredential({
    sourceFile,
    stagingParent: path.join(root, 'managed-staging'),
    platform: 'win32',
    ...overrides,
  });
  return { root, sourceFile, transaction };
}

test('absent source stays absent until commit publication and can roll back to absent', async (t) => {
  const { sourceFile, transaction } = await fixture(t, undefined);
  assert.equal(transaction.initialState, 'absent');
  assert.equal(existsSync(sourceFile), false);
  await fs.writeFile(transaction.credentialFile, '{"token":"new"}');
  await transaction.publish();
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"new"}');
  await transaction.rollback();
  assert.equal(existsSync(sourceFile), false);
  assert.equal(existsSync(transaction.homeDir), false);
});

test('existing source is seeded privately, published, and restored on precommit failure', async (t) => {
  const { sourceFile, transaction } = await fixture(t, { token: 'old' });
  assert.equal(transaction.initialState, 'file');
  assert.deepEqual(JSON.parse(await fs.readFile(transaction.credentialFile, 'utf8')), { token: 'old' });
  assert.deepEqual(JSON.parse(await fs.readFile(sourceFile, 'utf8')), { token: 'old' });
  await fs.writeFile(transaction.credentialFile, '{"token":"new"}');
  await transaction.publish();
  assert.deepEqual(JSON.parse(await fs.readFile(sourceFile, 'utf8')), { token: 'new' });
  await transaction.rollback();
  assert.deepEqual(JSON.parse(await fs.readFile(sourceFile, 'utf8')), { token: 'old' });
});

test('filesystems without hard links publish and roll back an existing credential safely', async (t) => {
  const hardLinksUnsupported = async () => {
    throw Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' });
  };
  const { sourceFile, transaction } = await fixture(t, { token: 'old' }, {
    linkImpl: hardLinksUnsupported,
  });
  await fs.writeFile(transaction.credentialFile, '{"token":"new"}');
  await transaction.publish();
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"new"}');
  await transaction.rollback();
  assert.deepEqual(JSON.parse(await fs.readFile(sourceFile, 'utf8')), { token: 'old' });
  assert.deepEqual(
    (await fs.readdir(path.dirname(sourceFile))).filter((name) => name.includes('.oauth-')),
    [],
  );
});

test('filesystems without hard links publish and roll back an absent credential safely', async (t) => {
  const hardLinksUnsupported = async () => {
    throw Object.assign(new Error('hard links unavailable'), { code: 'EPERM' });
  };
  const { sourceFile, transaction } = await fixture(t, undefined, {
    linkImpl: hardLinksUnsupported,
  });
  await fs.writeFile(transaction.credentialFile, '{"token":"new"}');
  await transaction.publish();
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"new"}');
  await transaction.rollback();
  assert.equal(existsSync(sourceFile), false);
  assert.deepEqual(
    (await fs.readdir(path.dirname(sourceFile))).filter((name) => name.includes('.oauth-')),
    [],
  );
});

test('publication capability failure is proven before an existing credential is moved', async (t) => {
  const unavailable = async () => {
    throw Object.assign(new Error('primitive unavailable'), { code: 'ENOTSUP' });
  };
  const { sourceFile, transaction } = await fixture(t, { token: 'old' }, {
    linkImpl: unavailable,
    copyFileImpl: unavailable,
  });
  await fs.writeFile(transaction.credentialFile, '{"token":"new"}');
  await assert.rejects(transaction.publish());
  assert.deepEqual(JSON.parse(await fs.readFile(sourceFile, 'utf8')), { token: 'old' });
  assert.deepEqual(
    (await fs.readdir(path.dirname(sourceFile))).filter((name) => name.endsWith('.held')),
    [],
  );
  await transaction.rollback();
});

test('a hard-link capability change falls back to exclusive copy after source verification', async (t) => {
  let linkCalls = 0;
  const linkOnce = async (from, to) => {
    linkCalls += 1;
    if (linkCalls === 1) return fs.link(from, to);
    throw Object.assign(new Error('hard links became unavailable'), { code: 'ENOTSUP' });
  };
  const { sourceFile, transaction } = await fixture(t, { token: 'old' }, {
    linkImpl: linkOnce,
  });
  await fs.writeFile(transaction.credentialFile, '{"token":"new"}');
  await transaction.publish();
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"new"}');
  await transaction.rollback();
  assert.deepEqual(JSON.parse(await fs.readFile(sourceFile, 'utf8')), { token: 'old' });
});

test('concurrently created absent credential wins and is never overwritten', async (t) => {
  const { sourceFile, transaction } = await fixture(t, undefined);
  await fs.writeFile(transaction.credentialFile, '{"token":"staged"}');
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, '{"token":"concurrent"}');
  await assert.rejects(transaction.publish(), { code: 'AGENT_AUTH_CREDENTIAL_CONFLICT' });
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"concurrent"}');
  await transaction.rollback();
});

test('concurrently changed existing credential wins and is never overwritten', async (t) => {
  const { sourceFile, transaction } = await fixture(t, { token: 'old' });
  await fs.writeFile(transaction.credentialFile, '{"token":"staged"}');
  await fs.writeFile(sourceFile, '{"token":"concurrent"}');
  await assert.rejects(transaction.publish(), { code: 'AGENT_AUTH_CREDENTIAL_CONFLICT' });
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"concurrent"}');
  await transaction.rollback();
});

test('cancellation before publication removes staged credentials without touching source', async (t) => {
  const { sourceFile, transaction } = await fixture(t, { token: 'old' });
  await fs.writeFile(transaction.credentialFile, '{"token":"cancelled"}');
  await transaction.rollback();
  assert.deepEqual(JSON.parse(await fs.readFile(sourceFile, 'utf8')), { token: 'old' });
  assert.equal(existsSync(transaction.homeDir), false);
});

test('invalid staged JSON never copies credential bytes into the error chain', async (t) => {
  const { sourceFile, transaction } = await fixture(t, { token: 'host-old' });
  await fs.writeFile(transaction.credentialFile, '{"token":"oauth-secret-value", broken');
  await assert.rejects(transaction.publish(), (error) => {
    assert.equal(error.code, 'AGENT_AUTH_CREDENTIAL_INVALID');
    assert.doesNotMatch(String(error.message), /oauth-secret-value/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(JSON.parse(await fs.readFile(sourceFile, 'utf8')), { token: 'host-old' });
  await transaction.rollback();
});

test('commit keeps the CAS-published credential and deletes the isolated profile', async (t) => {
  const { sourceFile, transaction } = await fixture(t, undefined);
  await fs.writeFile(transaction.credentialFile, '{"token":"committed"}');
  await transaction.publish();
  await transaction.cleanup();
  transaction.markCommitted();
  await transaction.rollback();
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"committed"}');
  assert.equal(existsSync(transaction.homeDir), false);
});

test('rollback refuses to overwrite a credential changed after publication', async (t) => {
  const { sourceFile, transaction } = await fixture(t, { token: 'old' });
  await fs.writeFile(transaction.credentialFile, '{"token":"published"}');
  await transaction.publish();
  await fs.writeFile(sourceFile, '{"token":"newer-login"}');
  await assert.rejects(transaction.rollback(), { code: 'AGENT_AUTH_CREDENTIAL_CONFLICT' });
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '{"token":"newer-login"}');
  await transaction.cleanup();
});

test('restart cleanup removes only expired OAuth profiles whose owner is dead', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-oauth-staging-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = 1_900_000_000_000;
  const staleCreatedAt = now - OAUTH_STAGING_STALE_AFTER_MS - 1;
  const freshCreatedAt = now - OAUTH_STAGING_STALE_AFTER_MS + 1;
  const staleDead = `run-${staleCreatedAt}-111-dead`;
  const staleLive = `run-${staleCreatedAt}-222-live`;
  const staleSameBoot = `run-${staleCreatedAt}-444-same-boot`;
  const staleUnmarked = `run-${staleCreatedAt}-555-unmarked`;
  const freshDead = `run-${freshCreatedAt}-333-fresh`;
  const unrelated = 'do-not-touch';
  for (const name of [staleDead, staleLive, staleSameBoot, staleUnmarked, freshDead, unrelated]) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'cli-config.json'), '{"token":"private"}');
  }
  const writeOwner = (name, ownerPid, observedUptimeSeconds) => fs.writeFile(
    path.join(root, name, OAUTH_STAGING_OWNER_FILE),
    JSON.stringify({ version: 1, createdAt: staleCreatedAt, ownerPid, observedUptimeSeconds }),
  );
  await writeOwner(staleDead, 111, 5_000);
  await writeOwner(staleLive, 222, 5_000);
  await writeOwner(staleSameBoot, 444, 50);

  const removed = await cleanupStaleOAuthCredentialStaging(root, {
    now: () => now,
    isProcessAlive: (pid) => pid === 222,
    uptimeSeconds: () => 100,
  });

  assert.equal(removed, 1);
  assert.equal(existsSync(path.join(root, staleDead)), false);
  assert.equal(existsSync(path.join(root, staleLive)), true);
  assert.equal(existsSync(path.join(root, staleSameBoot)), true);
  assert.equal(existsSync(path.join(root, staleUnmarked)), true);
  assert.equal(existsSync(path.join(root, staleUnmarked, OAUTH_STAGING_OWNER_FILE)), true);
  assert.equal(existsSync(path.join(root, freshDead)), true);
  assert.equal(existsSync(path.join(root, unrelated)), true);
});

test('restart cleanup retains stale profiles with oversized or non-file owner metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-oauth-owner-bounds-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = 1_900_000_000_000;
  const createdAt = now - OAUTH_STAGING_STALE_AFTER_MS - 1;
  const oversized = `run-${createdAt}-701-oversized`;
  const nonFile = `run-${createdAt}-702-non-file`;
  for (const name of [oversized, nonFile]) await fs.mkdir(path.join(root, name));
  await fs.writeFile(
    path.join(root, oversized, OAUTH_STAGING_OWNER_FILE),
    Buffer.alloc(OAUTH_STAGING_OWNER_MAX_BYTES + 1, 0x20),
  );
  await fs.mkdir(path.join(root, nonFile, OAUTH_STAGING_OWNER_FILE));

  const removed = await cleanupStaleOAuthCredentialStaging(root, {
    now: () => now,
    isProcessAlive: () => false,
    uptimeSeconds: () => 1,
  });

  assert.equal(removed, 0);
  assert.equal(existsSync(path.join(root, oversized)), true);
  assert.equal(existsSync(path.join(root, nonFile)), true);
});
