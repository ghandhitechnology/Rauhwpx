import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudDashboardSessions, cloudUsageSeries, readCloudUsage, recordCloudUsage } from '../src/cloud/usage-history.ts';
import type { CloudSnapshot } from '../src/cloud/types.ts';

function fixture(id = 'one'): CloudSnapshot {
  return {
    account: { signedIn: true, account: { id, email: 'test@example.invalid' },
      updatedAt: '2026-09-05T03:00:00Z', raucloud: { kind: 'available' },
      quota: { usedMs: 600_000, remainingMs: 3_000_000, dailyLimitMs: 3_600_000,
        resetAt: '2026-09-05T15:00:00Z', timeZone: 'Asia/Seoul' } },
    sessions: [], session: { kind: 'idle' },
  } as CloudSnapshot;
}
function memory() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

test('quota observations are account scoped, deduplicated and reject older totals', () => {
  const store = memory();
  const snapshot = fixture();
  recordCloudUsage(snapshot, store);
  recordCloudUsage(snapshot, store);
  assert.equal(readCloudUsage(snapshot.account, store)[0].usedMs, 600_000);
  snapshot.account!.updatedAt = '2026-09-05T02:00:00Z';
  snapshot.account!.quota!.usedMs = 60_000;
  recordCloudUsage(snapshot, store);
  assert.equal(readCloudUsage(snapshot.account, store)[0].usedMs, 600_000);
  assert.deepEqual(readCloudUsage(fixture('two').account, store), []);
  snapshot.account!.signedIn = false;
  assert.deepEqual(readCloudUsage(snapshot.account, store), []);
});

test('billing days follow reset timezone, while unobserved chart days stay missing', () => {
  const store = memory();
  const snapshot = fixture();
  recordCloudUsage(snapshot, store);
  const days = readCloudUsage(snapshot.account, store);
  assert.equal(days[0].date, '2026-09-05');
  const series = cloudUsageSeries(days, 7, new Date('2026-09-05T16:00:00Z'), 'Asia/Seoul');
  assert.equal(series.at(-1)?.date, '2026-09-06');
  assert.equal(series.at(-1)?.sample, null);
  assert.equal(series.at(-2)?.sample?.usedMs, 600_000);
  assert.equal(series.filter((point) => point.sample).length, 1);
});

test('corrupt or blocked storage and invalid server values do not break cloud work', () => {
  const broken = { getItem: () => '{bad', setItem: () => { throw new Error('blocked'); } };
  const snapshot = fixture();
  assert.deepEqual(readCloudUsage(snapshot.account, broken), []);
  assert.doesNotThrow(() => recordCloudUsage(snapshot, broken));
  const store = memory();
  snapshot.account!.quota!.usedMs = NaN;
  recordCloudUsage(snapshot, store);
  assert.deepEqual(readCloudUsage(snapshot.account, store), []);
});

test('history retains only 31 days and accepts newer corrected totals', () => {
  const store = memory();
  const snapshot = fixture();
  for (let i = 0; i < 40; i++) {
    snapshot.account!.quota!.resetAt = new Date(Date.UTC(2026, 7, i + 2)).toISOString();
    snapshot.account!.updatedAt = new Date(Date.UTC(2026, 7, i + 1, 12)).toISOString();
    recordCloudUsage(snapshot, store);
  }
  assert.equal(readCloudUsage(snapshot.account, store).length, 31);
  snapshot.account!.updatedAt = new Date(Date.parse(snapshot.account!.updatedAt) + 1000).toISOString();
  snapshot.account!.quota!.usedMs = 200;
  recordCloudUsage(snapshot, store);
  assert.equal(readCloudUsage(snapshot.account, store).at(-1)?.usedMs, 200);
});

test('dashboard sessions include every provider and deduplicate the current session', () => {
  const snapshot = fixture();
  const session = { kind: 'running', sessionId: 'a', threadId: 'chat', selection: { agent: 'claude' } };
  snapshot.sessions = [session, { ...session, sessionId: 'b', selection: { agent: 'codex' } }, { ...session, sessionId: 'c', threadId: 'unknown', selection: undefined }] as CloudSnapshot['sessions'];
  snapshot.session = snapshot.sessions[0];
  const result = cloudDashboardSessions(snapshot);
  assert.deepEqual(result.map((entry) => entry.sessionId), ['a', 'b', 'c']);
  assert.deepEqual(result.map((entry) => entry.selection?.agent), ['claude', 'codex', undefined]);
});
