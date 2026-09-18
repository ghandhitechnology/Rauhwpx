import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingRequestRegistry } from '../src/agent/pending-requests.ts';

// ─── 요청/응답 짝 맞추기 (실제 모듈) ────────────────────────

test('허브 응답이 오면 그 값으로 안착한다', async () => {
  const registry = new PendingRequestRegistry();
  const pending = registry.create<{ ok: boolean }>('usage-1', 10_000);
  assert.equal(registry.size, 1);
  assert.equal(registry.settle('usage-1', { ok: true }), true);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(registry.size, 0);
});

test('응답이 없으면 타임아웃에 null 로 안착한다 (던지지 않는다)', async () => {
  const registry = new PendingRequestRegistry();
  assert.equal(await registry.create('usage-2', 10), null);
  assert.equal(registry.size, 0);
});

test('모르는 requestId 는 무시된다 (늦게 온 응답이 다른 대기를 깨우지 않는다)', async () => {
  const registry = new PendingRequestRegistry();
  const pending = registry.create<string>('usage-3', 10_000);
  assert.equal(registry.settle('usage-999', 'stray'), false);
  registry.settle('usage-3', 'mine');
  assert.equal(await pending, 'mine');
});

test('usage-error 처럼 값 없이 닫으면 null 이 온다', async () => {
  const registry = new PendingRequestRegistry();
  const pending = registry.create<string>('usage-4', 10_000);
  registry.settle('usage-4', null);
  assert.equal(await pending, null);
});

test('연결이 끊기면 대기 중인 모든 요청이 null 로 닫힌다', async () => {
  const registry = new PendingRequestRegistry();
  const a = registry.create('usage-5', 10_000);
  const b = registry.create('provider-status-1', 10_000);
  registry.cancelAll();
  assert.deepEqual(await Promise.all([a, b]), [null, null]);
  assert.equal(registry.size, 0);
});

// ─── 브리지 배선 (소스 계약) ────────────────────────────────
