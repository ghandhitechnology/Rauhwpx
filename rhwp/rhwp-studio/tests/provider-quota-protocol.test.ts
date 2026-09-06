import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderQuota, readRemoteBalance } from '../src/agent/provider-quota-protocol.ts';

test('missing and malformed quota data remains unknown rather than full or empty', () => {
  for (const input of [null, undefined, [], 'invalid', {
    session: { percent: null }, week: { percent: '80' }, resetCredits: { availableCount: null },
  }]) {
    const result = readProviderQuota(input);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.session.percent, null);
    assert.equal(result.week.percent, null);
    assert.equal(result.resetCredits, null);
  }
});

test('zero quotas and zero reset balances survive normalization', () => {
  const result = readProviderQuota({
    status: 'ok', session: { percent: 0, resetsAt: 1234 }, week: { percent: 1 },
    accountKey: 'opaque-account', resetCredits: { availableCount: 0, nextExpiresAt: null },
  });
  assert.deepEqual(result.session, { percent: 0, resetsAt: 1234 });
  assert.equal(result.week.percent, 1);
  assert.deepEqual(result.resetCredits, { availableCount: 0, nextExpiresAt: null });
  assert.equal(result.accountKey, 'opaque-account');
});

test('clamps meters and rejects non-finite or fractional reset balances', () => {
  const result = readProviderQuota({ session: { percent: 120 }, week: { percent: -5 } });
  assert.equal(result.session.percent, 100);
  assert.equal(result.week.percent, 0);
  for (const count of [NaN, Infinity, -1, 1.5, '2']) {
    assert.equal(readProviderQuota({ resetCredits: { availableCount: count } }).resetCredits, null);
  }
});

test('preserves stale usage and its error state without serializing unknown fields', () => {
  const result = readProviderQuota({
    status: 'error', session: { percent: 81 }, updatedAt: 1234,
    error: '새로고침에 실패했어요.', accessToken: 'must-not-pass-through',
  });
  assert.equal(result.status, 'error');
  assert.equal(result.session.percent, 81);
  assert.equal(result.updatedAt, 1234);
  assert.equal('accessToken' in result, false);
});

test('remote balances preserve real zero and unknown amounts separately', () => {
  for (const balanceUsd of [null, undefined, NaN, Infinity, '15']) {
    assert.equal(readRemoteBalance({ balanceUsd }).balanceUsd, null);
  }
  const result = readRemoteBalance({ status: 'ok', balanceUsd: 0, totalCreditsUsd: 20, totalUsageUsd: 20 });
  assert.equal(result.balanceUsd, 0);
  assert.equal(result.totalCreditsUsd, 20);
  assert.equal(readRemoteBalance({ status: 'error', balanceUsd: 5 }).status, 'error');
});

test('remote usage windows reject malformed values without inventing money', () => {
  const result = readRemoteBalance({ status: 'ok', windows: [
    { label: '주간 한도', remainingPercent: 80, resetsAt: 1234 },
    { label: 'bad', remainingPercent: null }, { remainingPercent: 20 },
  ], token: 'secret' });
  assert.equal(result.balanceUsd, null);
  assert.deepEqual(result.windows, [{ label: '주간 한도', remainingPercent: 80, resetsAt: 1234 }]);
  assert.equal('token' in result, false);
});
