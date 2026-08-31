import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginCloudReconnect,
  beginCloudRecreate,
  inferCloudLink,
  markCloudLinkFailed,
  markCloudLinkReady,
  READY_CLOUD_LINK,
  shouldAutoRecreate,
} from '../src/cloud/link.ts';
import type { CloudSnapshot } from '../src/cloud/types.ts';

function snapshot(overrides: Partial<CloudSnapshot> = {}): CloudSnapshot {
  return {
    revision: 1,
    profileEpoch: 1,
    available: true,
    profile: { kind: 'unconfigured' },
    server: { mode: null, preferredMode: null, providers: [], lifecycle: 'idle', message: null },
    lease: { owner: 'local' },
    session: { kind: 'idle' },
    sessions: [],
    queuedMessages: [],
    timeline: null,
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

test('inferCloudLink keeps an explicit snapshot link and otherwise reads profile.connection', () => {
  assert.deepEqual(inferCloudLink(snapshot()), READY_CLOUD_LINK);
  assert.deepEqual(inferCloudLink(snapshot({
    link: { kind: 'reconnecting', error: 'stream closed', attempt: 2, canRecreate: true },
  })), { kind: 'reconnecting', error: 'stream closed', attempt: 2, canRecreate: true });
  assert.deepEqual(inferCloudLink(snapshot({
    profile: {
      kind: 'configured',
      mode: 'app-hosted',
      name: 'Raucloud',
      sandbox: {
        providerId: 'raucloud',
        sandboxId: 'box-1',
        displayName: 'Raucloud',
        region: 'sjc',
        host: 'box.example.test',
        createdAt: '2026-08-31T00:00:00.000Z',
      },
      connection: 'error',
      serviceVersion: null,
      message: 'unreachable',
    },
  })), { kind: 'failed', error: 'unreachable', attempt: 0, canRecreate: true });
});

test('reconnect is idempotent and recreate starts only once', () => {
  const first = beginCloudReconnect(READY_CLOUD_LINK, true);
  assert.deepEqual(first, { kind: 'reconnecting', error: null, attempt: 1, canRecreate: true });
  assert.deepEqual(beginCloudReconnect(first, true), first);
  const recreate = beginCloudRecreate(first);
  assert.deepEqual(recreate, { kind: 'recreating', error: null, attempt: 2, canRecreate: true });
  assert.equal(beginCloudRecreate(recreate), recreate);
});

test('auto-recreate waits for two failed app-hosted heals', () => {
  const failedOnce = markCloudLinkFailed(
    { kind: 'reconnecting', error: null, attempt: 1, canRecreate: true },
    'stream closed',
    true,
  );
  assert.equal(shouldAutoRecreate(failedOnce), false);
  const failedTwice = markCloudLinkFailed(
    { kind: 'reconnecting', error: null, attempt: 2, canRecreate: true },
    'stream closed',
    true,
  );
  assert.equal(shouldAutoRecreate(failedTwice), true);
  assert.equal(shouldAutoRecreate(markCloudLinkFailed(failedTwice, 'stream closed', false)), false);
  assert.deepEqual(markCloudLinkReady(true), { kind: 'ready', error: null, attempt: 0, canRecreate: true });
});
