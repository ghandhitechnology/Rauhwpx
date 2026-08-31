import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthRunRegistry } from '../auth-run-registry.mjs';

test('one authentication run per provider is owned by its initiating session', () => {
  const registry = new AuthRunRegistry();
  const run = registry.begin({
    agent: 'rau', ownerSessionId: 'window-a', requestId: 'request-a', method: 'oauth',
  });

  assert.throws(
    () => registry.begin({ agent: 'rau', ownerSessionId: 'window-b', method: 'oauth' }),
    { code: 'AGENT_AUTH_BUSY' },
  );
  assert.equal(registry.requireOwned({
    agent: 'rau', runId: run.runId, ownerSessionId: 'window-a',
  }), run);
  assert.throws(
    () => registry.requireOwned({ agent: 'rau', runId: run.runId, ownerSessionId: 'window-b' }),
    { code: 'AGENT_AUTH_NOT_OWNER' },
  );
});

test('owner reconnect can recover replayable authentication UI', () => {
  const registry = new AuthRunRegistry();
  const run = registry.begin({
    agent: 'rau', ownerSessionId: 'window-a', method: 'oauth',
    replayableUi: { authUrl: 'https://example.test/login' },
  });
  registry.update(run, { phase: 'authorizing', replayableUi: { pairingCode: 'ABCD-EFGH-IJKL' } });

  const [snapshot] = registry.forSession('window-a');
  assert.deepEqual(snapshot, {
    authRunId: run.runId,
    agent: 'rau',
    method: 'oauth',
    phase: 'authorizing',
    createdAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
    authUrl: 'https://example.test/login',
    pairingCode: 'ABCD-EFGH-IJKL',
  });
  assert.equal(typeof snapshot.createdAt, 'string');
  assert.equal(typeof snapshot.expiresAt, 'string');
  assert.deepEqual(registry.forSession('window-b'), []);
});

test('closing an owner session revokes its runs and calls cancellation', () => {
  const reasons = [];
  const registry = new AuthRunRegistry();
  registry.begin({
    agent: 'rau', ownerSessionId: 'window-a', method: 'oauth', cancel: (reason) => reasons.push(reason),
  });
  registry.begin({ agent: 'pi', ownerSessionId: 'window-b', method: 'oauth' });

  assert.equal(registry.cancelForSession('window-a').length, 1);
  assert.deepEqual(reasons, ['owner-session-closed']);
  assert.equal(registry.get('rau'), null);
  assert.ok(registry.get('pi'));
});

test('expired runs are cancelled and no longer block a provider', () => {
  let clock = 1_000;
  const reasons = [];
  const registry = new AuthRunRegistry({ now: () => clock, ttlMs: 50 });
  registry.begin({
    agent: 'rau', ownerSessionId: 'window-a', method: 'oauth', cancel: (reason) => reasons.push(reason),
  });
  clock += 51;

  assert.equal(registry.get('rau'), null);
  assert.deepEqual(reasons, ['expired']);
  assert.doesNotThrow(() => registry.begin({ agent: 'rau', ownerSessionId: 'window-b', method: 'oauth' }));
});

test('an authentication run expires without a later registry call', () => {
  let callback;
  let unrefCalled = false;
  let cleared = false;
  const timer = { unref() { unrefCalled = true; } };
  const reasons = [];
  const registry = new AuthRunRegistry({
    now: () => 1_000,
    ttlMs: 50,
    setTimer(next, delay) {
      assert.equal(delay, 50);
      callback = next;
      return timer;
    },
    clearTimer(value) {
      assert.equal(value, timer);
      cleared = true;
    },
  });
  const run = registry.begin({
    agent: 'rau',
    ownerSessionId: 'window-a',
    method: 'oauth',
    cancel: (reason) => reasons.push(reason),
  });

  assert.equal(unrefCalled, true);
  callback();
  assert.deepEqual(reasons, ['expired']);
  assert.equal(registry.runs.size, 0);
  assert.equal(registry.finish(run), false);
  assert.equal(cleared, false, 'a fired timer does not need clearing');
});

test('finishing an authentication run clears its expiry timer', () => {
  const timer = { unref() {} };
  const cleared = [];
  const registry = new AuthRunRegistry({
    setTimer: () => timer,
    clearTimer: (value) => cleared.push(value),
  });
  const run = registry.begin({ agent: 'pi', ownerSessionId: 'window-a', method: 'oauth' });

  assert.equal(registry.finish(run), true);
  assert.deepEqual(cleared, [timer]);
});
