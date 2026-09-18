import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LINK_PROGRESS_CAP,
  formatLinkEta,
  linkEstimateMs,
  linkProgressRatio,
  rememberLinkDuration,
} from '../src/ui/agent-sidebar/cloud-link-estimate.ts';

test('the link progress bar stays unfinished while the estimate runs out', () => {
  const estimate = 30_000;
  assert.equal(linkProgressRatio(0, estimate), 0);
  const atEstimate = linkProgressRatio(estimate, estimate);
  assert.ok(atEstimate > 0.8 && atEstimate < LINK_PROGRESS_CAP,
    `estimate expiry must leave the bar visibly unfinished, got ${atEstimate}`);
  for (const elapsed of [1_000, 15_000, 30_000, 60_000, 300_000, 3_600_000]) {
    const ratio = linkProgressRatio(elapsed, estimate);
    assert.ok(ratio > 0 && ratio < 1, `ratio out of range at ${elapsed}ms: ${ratio}`);
    assert.ok(ratio <= LINK_PROGRESS_CAP, `ratio passed the cap at ${elapsed}ms: ${ratio}`);
  }
  const early = linkProgressRatio(estimate / 2, estimate) - linkProgressRatio(0, estimate);
  const middle = linkProgressRatio(estimate, estimate) - linkProgressRatio(estimate / 2, estimate);
  const late = linkProgressRatio(estimate * 2, estimate) - linkProgressRatio(estimate, estimate);
  assert.ok(early > middle && middle > late, 'the bar must decelerate as it approaches the cap');
});

test('the link eta counts down in readable steps', () => {
  assert.equal(formatLinkEta(9_400), '약 10초 남음');
  assert.equal(formatLinkEta(59_000), '약 59초 남음');
  assert.equal(formatLinkEta(60_000), '약 1분 남음');
  assert.equal(formatLinkEta(92_000), '약 1분 35초 남음');
  assert.equal(formatLinkEta(600_000), '약 10분 남음');
  assert.equal(formatLinkEta(0), '마무리 중');
  assert.equal(formatLinkEta(-4_000), '마무리 중');
});

test('remembered durations refine the estimate without leaving the sane range', () => {
  const store = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } },
  });
  try {
    assert.equal(linkEstimateMs('reconnecting'), 9_000);
    rememberLinkDuration('reconnecting', 20_000);
    assert.equal(linkEstimateMs('reconnecting'), Math.round(9_000 * 0.6 + 20_000 * 0.4));
    assert.equal(linkEstimateMs('recreating'), 75_000, 'each kind keeps its own estimate');
    rememberLinkDuration('recreating', 4);
    assert.equal(linkEstimateMs('recreating'), 46_600, 'too-fast runs pull the estimate down without distorting other kinds');
    rememberLinkDuration('reconnecting', Number.NaN);
    assert.equal(linkEstimateMs('reconnecting'), Math.round(9_000 * 0.6 + 20_000 * 0.4), 'invalid durations are ignored');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
