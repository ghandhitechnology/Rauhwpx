import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runResultAuthorityTransition,
  runTakeoverAuthorityTransition,
} from '../src/cloud/authority-transition.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('takeover stays locked through prepare, load, complete, and one local restart', async () => {
  const prepare = deferred<boolean>();
  const load = deferred<string>();
  const complete = deferred<void>();
  const events: string[] = [];
  let editable = true;
  let pending = null;
  const operation = runTakeoverAuthorityTransition({
    acquire: () => {
      editable = false;
      events.push('lock');
      return { release: () => {
        assert.equal(editable, false);
        editable = true;
        events.push('release');
      } };
    },
    prepare: () => prepare.promise,
    request: async () => {
      assert.equal(editable, false);
      events.push('request');
      return 'checkpoint';
    },
    apply: async () => {
      assert.equal(editable, false);
      events.push('load');
      return load.promise;
    },
    complete: async () => {
      assert.equal(editable, false);
      events.push('complete');
      return complete.promise;
    },
    refresh: async () => events.push('refresh'),
    settle: (binding, completed) => {
      assert.equal(editable, false);
      events.push(`restart:${binding}:${completed}`);
    },
    pending,
    onPendingChange: (next) => { pending = next; },
    context: () => ({ profileEpoch: 1, serverIdentity: 'server-a' }),
  });
  assert.deepEqual(events, ['lock']);
  prepare.resolve(true);
  await Promise.resolve();
  assert.deepEqual(events, ['lock', 'request']);
  await Promise.resolve();
  assert.deepEqual(events, ['lock', 'request', 'load']);
  load.resolve('document-new');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['lock', 'request', 'load', 'complete']);
  complete.resolve();
  assert.equal(await operation, true);
  assert.deepEqual(events, [
    'lock',
    'request',
    'load',
    'complete',
    'restart:document-new:true',
    'release',
  ]);
  assert.equal(editable, true);
});

test('takeover apply failure retains one lock and retries through complete exactly once', async () => {
  const events: string[] = [];
  let pending = null;
  let applyAttempts = 0;
  let completions = 0;
  const options = () => ({
    acquire: () => {
      events.push('lock');
      return { release: () => events.push('release') };
    },
    prepare: async () => true,
    request: async () => 'checkpoint',
    apply: async () => {
      applyAttempts += 1;
      events.push('load');
      if (applyAttempts === 1) throw new Error('load failed');
      return 'document-new';
    },
    complete: async () => {
      completions += 1;
      events.push('complete');
    },
    refresh: async () => events.push('refresh'),
    settle: (binding, completed) => events.push(`settle:${binding}:${completed}`),
    pending,
    onPendingChange: (next: typeof pending) => { pending = next; },
    context: () => ({ profileEpoch: 1, serverIdentity: 'server-a' }),
  });
  await assert.rejects(runTakeoverAuthorityTransition(options()), /load failed/);
  assert.deepEqual(events, [
    'lock',
    'load',
    'refresh',
    'settle:null:false',
  ]);
  assert.ok(pending);

  assert.equal(await runTakeoverAuthorityTransition(options()), true);
  assert.equal(applyAttempts, 2);
  assert.equal(completions, 1);
  assert.equal(events.filter((event) => event === 'lock').length, 1);
  assert.equal(events.filter((event) => event === 'release').length, 1);
  assert.equal(pending, null);
});

test('result replacement remains locked through load while non-replace avoids a transition', async () => {
  const load = deferred<string>();
  const events: string[] = [];
  let pending = null;
  const replaced = runResultAuthorityTransition({
    replace: true,
    acquire: () => {
      events.push('lock');
      return { release: () => events.push('release') };
    },
    resolve: async () => {
      events.push('resolve');
      return 'bytes';
    },
    apply: async () => {
      events.push('load');
      return load.promise;
    },
    refresh: async () => events.push('refresh'),
    pending,
    onPendingChange: (next) => { pending = next; },
    context: () => ({ profileEpoch: 1, serverIdentity: 'server-a' }),
  });
  await Promise.resolve();
  assert.deepEqual(events, ['lock', 'resolve', 'load']);
  load.resolve('binding');
  assert.equal(await replaced, 'binding');
  assert.deepEqual(events, ['lock', 'resolve', 'load', 'release']);

  const kept = await runResultAuthorityTransition({
    replace: false,
    acquire: () => {
      events.push('unexpected-lock');
      return { release() {} };
    },
    resolve: async () => 'kept',
    apply: async (value) => value,
    refresh: async () => {},
    onPendingChange: () => {},
    context: () => ({ profileEpoch: 1, serverIdentity: 'server-a' }),
  });
  assert.equal(kept, 'kept');
  assert.equal(events.includes('unexpected-lock'), false);
});

test('resolved result replacement retries cached bytes without resolving twice', async () => {
  const events: string[] = [];
  let pending = null;
  let resolveCalls = 0;
  let applyCalls = 0;
  const options = () => ({
    replace: true,
    acquire: () => ({ release: () => events.push('release') }),
    resolve: async () => {
      resolveCalls += 1;
      return 'resolved-bytes';
    },
    apply: async (resolution: string) => {
      applyCalls += 1;
      assert.equal(resolution, 'resolved-bytes');
      if (applyCalls === 1) throw new Error('renderer failed');
      return 'binding';
    },
    refresh: async () => events.push('refresh'),
    pending,
    onPendingChange: (next: typeof pending) => { pending = next; },
    context: () => ({ profileEpoch: 1, serverIdentity: 'server-a' }),
  });

  await assert.rejects(runResultAuthorityTransition(options()), /renderer failed/);
  assert.ok(pending);
  assert.deepEqual(events, ['refresh']);
  assert.equal(await runResultAuthorityTransition(options()), 'binding');
  assert.equal(resolveCalls, 1);
  assert.equal(applyCalls, 2);
  assert.deepEqual(events, ['refresh', 'release']);
});

test('disposing a failed result replacement releases its retained authority lock', async () => {
  let releases = 0;
  let pending = null;
  await assert.rejects(runResultAuthorityTransition({
    replace: true,
    acquire: () => ({ release: () => { releases += 1; } }),
    resolve: async () => 'resolved-bytes',
    apply: async () => { throw new Error('renderer failed'); },
    refresh: async () => {},
    pending,
    onPendingChange: (next) => { pending = next; },
    context: () => ({ profileEpoch: 1, serverIdentity: 'server-a' }),
  }), /renderer failed/);
  assert.ok(pending);
  pending.transition.release();
  pending = null;
  assert.equal(releases, 1);
});

test('profile changes during a deferred apply retain the lock and fence late settlement', async () => {
  const deferredApply = deferred<string>();
  let profile = { profileEpoch: 1, serverIdentity: 'server-a' };
  let releases = 0;
  let settles = 0;
  let pending = null;
  const operation = runTakeoverAuthorityTransition({
    acquire: () => ({ release: () => { releases += 1; } }),
    prepare: async () => true,
    request: async () => 'checkpoint-a',
    apply: () => deferredApply.promise,
    complete: async () => {},
    refresh: async () => {},
    settle: () => { settles += 1; },
    pending,
    onPendingChange: (next) => { pending = next; },
    context: () => profile,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  profile = { profileEpoch: 2, serverIdentity: 'server-b' };
  deferredApply.resolve('document-a');
  await assert.rejects(operation, { code: 'AUTHORITY_PROFILE_CHANGED' });
  assert.equal(releases, 0);
  assert.equal(settles, 0);
  assert.ok(pending);
});

test('same-identity repair is detected and restoring the origin server permits retry', async () => {
  let profile = { profileEpoch: 3, serverIdentity: 'server-a' };
  let pending = null;
  let applyCalls = 0;
  const options = () => ({
    acquire: () => ({ release() {} }),
    prepare: async () => true,
    request: async () => 'checkpoint-a',
    apply: async () => {
      applyCalls += 1;
      if (applyCalls === 1) throw new Error('renderer failed');
      return 'document-a';
    },
    complete: async () => {},
    refresh: async () => {},
    settle: async () => {},
    pending,
    onPendingChange: (next: typeof pending) => { pending = next; },
    context: () => profile,
  });
  await assert.rejects(runTakeoverAuthorityTransition(options()), /renderer failed/);
  profile = { profileEpoch: 4, serverIdentity: 'server-b' };
  await assert.rejects(runTakeoverAuthorityTransition(options()), { code: 'AUTHORITY_PROFILE_CHANGED' });
  assert.equal(applyCalls, 1);

  profile = { profileEpoch: 5, serverIdentity: 'server-a' };
  assert.equal(await runTakeoverAuthorityTransition(options()), true);
  assert.equal(applyCalls, 2);
});

test('result replacement cannot unlock or settle against another profile and reuses its resolution after restore', async () => {
  const deferredApply = deferred<string>();
  let profile = { profileEpoch: 8, serverIdentity: 'server-a' };
  let pending = null;
  let resolveCalls = 0;
  let applyCalls = 0;
  let releases = 0;
  const options = () => ({
    replace: true,
    acquire: () => ({ release: () => { releases += 1; } }),
    resolve: async () => {
      resolveCalls += 1;
      return 'resolved-a';
    },
    apply: async (resolution: string) => {
      assert.equal(resolution, 'resolved-a');
      applyCalls += 1;
      return applyCalls === 1 ? deferredApply.promise : 'document-a';
    },
    refresh: async () => {},
    pending,
    onPendingChange: (next: typeof pending) => { pending = next; },
    context: () => profile,
  });

  const first = runResultAuthorityTransition(options());
  await new Promise<void>((resolve) => setImmediate(resolve));
  profile = { profileEpoch: 9, serverIdentity: 'server-b' };
  deferredApply.resolve('late-document-a');
  await assert.rejects(first, { code: 'AUTHORITY_PROFILE_CHANGED' });
  assert.equal(releases, 0);
  assert.ok(pending);

  profile = { profileEpoch: 10, serverIdentity: 'server-a' };
  assert.equal(await runResultAuthorityTransition(options()), 'document-a');
  assert.equal(resolveCalls, 1);
  assert.equal(applyCalls, 2);
  assert.equal(releases, 1);
});

test('same-identity re-pair fences an in-flight completion before allowing an explicit retry', async () => {
  const deferredApply = deferred<string>();
  let profile = { profileEpoch: 20, serverIdentity: 'server-a' };
  let pending = null;
  let applyCalls = 0;
  const options = () => ({
    acquire: () => ({ release() {} }),
    prepare: async () => true,
    request: async () => 'checkpoint-a',
    apply: async () => {
      applyCalls += 1;
      return applyCalls === 1 ? deferredApply.promise : 'document-a';
    },
    complete: async () => {},
    refresh: async () => {},
    settle: async () => {},
    pending,
    onPendingChange: (next: typeof pending) => { pending = next; },
    context: () => profile,
  });
  const first = runTakeoverAuthorityTransition(options());
  await new Promise<void>((resolve) => setImmediate(resolve));
  profile = { profileEpoch: 21, serverIdentity: 'server-a' };
  deferredApply.resolve('late-document-a');
  await assert.rejects(first, { code: 'AUTHORITY_PROFILE_CHANGED' });
  assert.ok(pending);
  assert.equal(await runTakeoverAuthorityTransition(options()), true);
  assert.equal(applyCalls, 1);
});
