import assert from 'node:assert/strict';
import { existsSync, promises as fs, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  credentialConflictPath,
  ensureCredentialRetentionRootSync,
  flushCredentialMirrorSync,
  hasPendingCredentialCopybackSync,
  hasPendingLaunchCleanupSync,
  LAUNCH_CLEANUP_RETENTION_FILE,
  MAX_CREDENTIAL_JOURNAL_BYTES,
  MAX_CREDENTIAL_MIRROR_BYTES,
  prepareCredentialMirrorSync,
  recoverCredentialMirrorsSync,
  retainLaunchRootForProcessCleanupSync,
} from '../credential-mirror.mjs';

function deniedSymlink() {
  const error = new Error('Windows symlink privilege is unavailable');
  error.code = 'EPERM';
  throw error;
}

test('Windows credential copies journal and copy refreshed bytes back', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-mirror-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const target = path.join(root, 'isolated', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, '{"refresh":"old"}');

  const handle = prepareCredentialMirrorSync(source, target, {
    platform: 'win32',
    pid: 111,
    now: () => 1_000,
    symlink: deniedSymlink,
  });
  assert.equal(handle.mode, 'copy');
  assert.equal(existsSync(handle.journalPath), true);
  assert.equal(await fs.readFile(target, 'utf8'), '{"refresh":"old"}');

  await fs.writeFile(target, '{"refresh":"new"}');
  assert.deepEqual(flushCredentialMirrorSync(handle, { platform: 'win32' }), {
    copied: true,
    conflict: false,
  });
  assert.equal(await fs.readFile(source, 'utf8'), '{"refresh":"new"}');
  assert.equal(existsSync(handle.journalPath), false);
});

test('copyback does not overwrite a credential changed by another login', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-conflict-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const target = path.join(root, 'isolated', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'initial');
  const handle = prepareCredentialMirrorSync(source, target, {
    platform: 'win32', pid: 222, now: () => 2_000, symlink: deniedSymlink,
  });

  await fs.writeFile(source, 'new-login');
  await fs.writeFile(target, 'isolated-refresh');
  const conflictPath = credentialConflictPath(source);
  assert.deepEqual(flushCredentialMirrorSync(handle, { platform: 'win32' }), {
    copied: false,
    conflict: true,
    conflictPath,
  });
  assert.equal(await fs.readFile(source, 'utf8'), 'new-login');
  assert.equal(await fs.readFile(conflictPath, 'utf8'), 'isolated-refresh');
  assert.equal((await fs.stat(conflictPath)).mode & 0o777, 0o600);
  assert.equal(existsSync(handle.journalPath), false);
  assert.equal(existsSync(target), false);
});

test('concurrent mirrors preserve one bounded conflict and release both launch markers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-concurrent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const firstLaunch = path.join(root, 'first-launch');
  const secondLaunch = path.join(root, 'second-launch');
  const firstTarget = path.join(firstLaunch, 'home', 'auth.json');
  const secondTarget = path.join(secondLaunch, 'home', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(firstLaunch, { recursive: true });
  await fs.mkdir(secondLaunch, { recursive: true });
  await fs.writeFile(source, 'initial');
  await fs.writeFile(path.join(firstLaunch, '.rauhwpx-owner.json'), '{}');
  await fs.writeFile(path.join(secondLaunch, '.rauhwpx-owner.json'), '{}');

  const first = prepareCredentialMirrorSync(source, firstTarget, {
    platform: 'win32', pid: 2_222, symlink: deniedSymlink,
  });
  const second = prepareCredentialMirrorSync(source, secondTarget, {
    platform: 'win32', pid: 2_222, symlink: deniedSymlink,
  });
  await fs.writeFile(firstTarget, 'first-refresh');
  await fs.writeFile(secondTarget, 'second-refresh');

  assert.deepEqual(flushCredentialMirrorSync(first, { platform: 'win32' }), {
    copied: true,
    conflict: false,
  });
  const conflictPath = credentialConflictPath(source);
  assert.deepEqual(flushCredentialMirrorSync(second, { platform: 'win32' }), {
    copied: false,
    conflict: true,
    conflictPath,
  });
  assert.equal(await fs.readFile(source, 'utf8'), 'first-refresh');
  assert.equal(await fs.readFile(conflictPath, 'utf8'), 'second-refresh');
  assert.equal((await fs.stat(conflictPath)).size <= MAX_CREDENTIAL_MIRROR_BYTES, true);
  assert.equal(existsSync(first.retentionMarker), false);
  assert.equal(existsSync(second.retentionMarker), false);
  assert.equal(existsSync(first.journalPath), false);
  assert.equal(existsSync(second.journalPath), false);
  assert.equal(existsSync(firstTarget), true, 'successful copy target remains for its caller to remove');
  assert.equal(existsSync(secondTarget), false, 'terminal conflict target is removed after preservation');
});

test('logout during a mirror is terminal and preserves only the refreshed copy', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-logout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const launch = path.join(root, 'launch');
  const target = path.join(launch, 'home', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(launch, { recursive: true });
  await fs.writeFile(source, 'initial');
  await fs.writeFile(path.join(launch, '.rauhwpx-owner.json'), '{}');
  const handle = prepareCredentialMirrorSync(source, target, {
    platform: 'win32', pid: 2_223, symlink: deniedSymlink,
  });
  await fs.writeFile(target, 'refresh-after-logout');
  await fs.rm(source);

  const conflictPath = credentialConflictPath(source);
  assert.deepEqual(flushCredentialMirrorSync(handle, { platform: 'win32' }), {
    copied: false,
    conflict: true,
    conflictPath,
  });
  assert.equal(existsSync(source), false);
  assert.equal(await fs.readFile(conflictPath, 'utf8'), 'refresh-after-logout');
  assert.equal(existsSync(handle.retentionMarker), false);
  assert.equal(existsSync(handle.journalPath), false);
  assert.equal(existsSync(target), false);
});

test('a later process recovers a dead owner copyback journal', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-recover-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const target = path.join(root, 'old-launch', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'old');
  const handle = prepareCredentialMirrorSync(source, target, {
    platform: 'win32', pid: 333, now: () => 3_000, symlink: deniedSymlink,
  });
  await fs.writeFile(target, 'refreshed-before-crash');

  const results = recoverCredentialMirrorsSync(source, {
    platform: 'win32',
    currentPid: 444,
    isAlive: () => false,
  });
  assert.deepEqual(results, [{ copied: true, conflict: false }]);
  assert.equal(await fs.readFile(source, 'utf8'), 'refreshed-before-crash');
  assert.equal(existsSync(handle.journalPath), false);
});

test('a launch retention marker protects a pending crash recovery target', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-retain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const launch = path.join(root, 'launch');
  const target = path.join(launch, 'sessions', 'one', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(launch, { recursive: true });
  await fs.writeFile(source, 'old');
  await fs.writeFile(path.join(launch, '.rauhwpx-owner.json'), '{}');

  const handle = prepareCredentialMirrorSync(source, target, {
    platform: 'win32', pid: 555, now: () => 5_000, symlink: deniedSymlink,
  });
  assert.ok(handle.retentionMarker);
  assert.equal(existsSync(handle.retentionMarker), true);
  await fs.writeFile(target, 'new');
  flushCredentialMirrorSync(handle, { platform: 'win32' });
  assert.equal(existsSync(handle.retentionMarker), false);
});

test('a transient Windows source replacement failure retains the launch root until retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-eacces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const launch = path.join(root, 'launch');
  const target = path.join(launch, 'sessions', 'one', 'home', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'original');
  ensureCredentialRetentionRootSync(launch);

  const handle = prepareCredentialMirrorSync(source, target, {
    platform: 'win32', pid: 556, now: () => 5_001, symlink: deniedSymlink,
  });
  await fs.writeFile(target, 'refreshed');
  const result = flushCredentialMirrorSync(handle, {
    platform: 'win32',
    renameFile(from, to) {
      if (from === source && to === handle.previousPath) {
        throw Object.assign(new Error('credential source is locked'), { code: 'EACCES' });
      }
      renameSync(from, to);
    },
  });

  assert.deepEqual(result, {
    copied: false,
    conflict: false,
    pending: true,
    errorCode: 'EACCES',
    errorMessage: 'credential source is locked',
  });
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
  assert.equal(await fs.readFile(target, 'utf8'), 'refreshed');
  assert.equal(await fs.readFile(handle.nextPath, 'utf8'), 'refreshed');
  assert.equal(existsSync(handle.journalPath), true);
  assert.equal(existsSync(handle.retentionMarker), true);
  assert.equal(hasPendingCredentialCopybackSync(launch), true);

  // This is the same guard used by record, root, desktop, and Vite cleanup.
  if (!hasPendingCredentialCopybackSync(launch)) {
    await fs.rm(launch, { recursive: true, force: true });
  }
  assert.equal(existsSync(launch), true);
  assert.equal(await fs.readFile(target, 'utf8'), 'refreshed');

  assert.deepEqual(flushCredentialMirrorSync(handle, { platform: 'win32' }), {
    copied: true,
    conflict: false,
  });
  assert.equal(await fs.readFile(source, 'utf8'), 'refreshed');
  assert.equal(hasPendingCredentialCopybackSync(launch), false);
  if (!hasPendingCredentialCopybackSync(launch)) {
    await fs.rm(launch, { recursive: true, force: true });
  }
  assert.equal(existsSync(launch), false);
});

test('uncertain process cleanup writes one bounded reboot-safe launch marker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-process-retain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const launchId = '2848f76b-9d57-4d81-8410-4023c59cb403';
  const launch = path.join(root, launchId);
  const marker = retainLaunchRootForProcessCleanupSync(launch, {
    launchId,
    observedAtMs: 10_000,
    observedUptimeSeconds: 5_000,
  });
  const original = await fs.readFile(marker, 'utf8');

  assert.equal(path.basename(marker), LAUNCH_CLEANUP_RETENTION_FILE);
  assert.equal((await fs.stat(marker)).mode & 0o777, 0o600);
  assert.equal(hasPendingLaunchCleanupSync(launch), true);
  retainLaunchRootForProcessCleanupSync(launch, {
    launchId,
    observedAtMs: 20_000,
    observedUptimeSeconds: 15_000,
  });
  assert.equal(await fs.readFile(marker, 'utf8'), original, 'the first uptime watermark is reused');
});

test('POSIX credentials remain direct symlinks and need no journal', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const target = path.join(root, 'isolated', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'shared');

  const handle = prepareCredentialMirrorSync(source, target, { platform: 'darwin' });
  assert.equal(handle.mode, 'link');
  await fs.writeFile(target, 'updated-through-link');
  assert.equal(await fs.readFile(source, 'utf8'), 'updated-through-link');
  assert.deepEqual(flushCredentialMirrorSync(handle), { copied: false, conflict: false });
});

test('Windows copy fallback rejects an oversized source before creating artifacts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-large-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'profile');
  const source = path.join(sourceDir, 'auth.json');
  const target = path.join(root, 'isolated', 'auth.json');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(source, Buffer.alloc(MAX_CREDENTIAL_MIRROR_BYTES + 1));

  assert.throws(
    () => prepareCredentialMirrorSync(source, target, {
      platform: 'win32', pid: 666, symlink: deniedSymlink,
    }),
    { code: 'CREDENTIAL_MIRROR_TOO_LARGE' },
  );
  assert.equal(existsSync(target), false);
  assert.deepEqual(await fs.readdir(sourceDir), ['auth.json']);
});

test('copyback rejects an oversized target but releases its cleanup marker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-large-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const target = path.join(root, 'isolated', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'original');
  const handle = prepareCredentialMirrorSync(source, target, {
    platform: 'win32', pid: 777, symlink: deniedSymlink,
  });
  await fs.writeFile(target, Buffer.alloc(MAX_CREDENTIAL_MIRROR_BYTES + 1));

  assert.throws(
    () => flushCredentialMirrorSync(handle, { platform: 'win32' }),
    { code: 'CREDENTIAL_MIRROR_TOO_LARGE' },
  );
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
  assert.equal(existsSync(handle.journalPath), false);
  assert.equal(existsSync(target), false);
});

test('an oversized current source becomes a terminal concurrent-login conflict', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-grown-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const target = path.join(root, 'isolated', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'original');
  const handle = prepareCredentialMirrorSync(source, target, {
    platform: 'win32', pid: 888, symlink: deniedSymlink,
  });
  await fs.writeFile(target, 'refreshed');
  await fs.writeFile(source, Buffer.alloc(MAX_CREDENTIAL_MIRROR_BYTES + 1));

  const conflictPath = credentialConflictPath(source);
  assert.deepEqual(flushCredentialMirrorSync(handle, { platform: 'win32' }), {
    copied: false,
    conflict: true,
    conflictPath,
  });
  assert.equal((await fs.stat(source)).size, MAX_CREDENTIAL_MIRROR_BYTES + 1);
  assert.equal(await fs.readFile(conflictPath, 'utf8'), 'refreshed');
  assert.equal(existsSync(handle.journalPath), false);
  assert.equal(existsSync(target), false);
});

test('recovery fails closed on an oversized journal', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-large-journal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const target = path.join(root, 'old-launch', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'original');
  const handle = prepareCredentialMirrorSync(source, target, {
    platform: 'win32', pid: 999, symlink: deniedSymlink,
  });
  await fs.writeFile(target, 'refreshed');
  await fs.writeFile(handle.journalPath, Buffer.alloc(MAX_CREDENTIAL_JOURNAL_BYTES + 1));

  assert.throws(
    () => recoverCredentialMirrorsSync(source, {
      platform: 'win32', currentPid: 1_000, isAlive: () => false,
    }),
    { code: 'CREDENTIAL_MIRROR_TOO_LARGE' },
  );
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
  assert.equal(existsSync(handle.journalPath), true);
});

test('interrupted replacement recovery rejects an oversized staged credential', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-credential-large-staged-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'profile', 'auth.json');
  const target = path.join(root, 'isolated', 'auth.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'original');
  const handle = prepareCredentialMirrorSync(source, target, {
    platform: 'win32', pid: 1_111, symlink: deniedSymlink,
  });
  await fs.rm(source);
  await fs.writeFile(handle.nextPath, Buffer.alloc(MAX_CREDENTIAL_MIRROR_BYTES + 1));

  assert.throws(
    () => flushCredentialMirrorSync(handle, { platform: 'win32' }),
    { code: 'CREDENTIAL_MIRROR_TOO_LARGE' },
  );
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(handle.nextPath), true);
  assert.equal(existsSync(handle.journalPath), true);
});
