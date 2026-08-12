import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PendingRequestRegistry } from '../src/agent/pending-requests.ts';

const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/agent/types.ts', import.meta.url), 'utf8');

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

test('브리지가 프로바이더 상태·사용량 요청 메시지를 보낸다', () => {
  assert.match(bridge, /type: 'provider-status-request'/);
  assert.match(bridge, /type: 'usage-request'/);
  assert.match(bridge, /type: 'usage-plan-set', agent, plan/);
  assert.match(bridge, /requestProviderStatus\(refresh = false\): Promise<ProviderStatusMap \| null>/);
  assert.match(bridge, /requestUsage\(\): Promise<UsageSummary \| null>/);
  assert.match(bridge, /setUsagePlan\(agent: AgentName, plan: string\): Promise<UsageSummary \| null>/);
});

test('오프라인이면 요청은 곧바로 null 로 안착한다', () => {
  assert.match(
    bridge,
    /if \(this\.state !== 'connected'\) return Promise\.resolve\(null\);/,
  );
  // 전송 실패도 같은 자리에서 닫는다.
  assert.match(bridge, /if \(!sent\) this\.requests\.settle\(requestId, null\);/);
  assert.match(bridge, /const REQUEST_TIMEOUT_MS = 10_000;/);
  assert.match(bridge, /this\.requests\.create<T>\(requestId, REQUEST_TIMEOUT_MS\)/);
});

test('허브 메시지는 대기 중인 요청을 풀고 사이드바 이벤트도 낸다', () => {
  assert.match(
    bridge,
    /case 'provider-status': \{[\s\S]*this\.requests\.settle\(msg\.requestId, providers\)[\s\S]*this\.emit\(\{ type: 'provider-status', providers \}\)/,
  );
  assert.match(
    bridge,
    /case 'usage-report': \{[\s\S]*this\.requests\.settle\(msg\.requestId, usage\)[\s\S]*this\.emit\(\{ type: 'usage-report', usage \}\)/,
  );
  // usage-error/provider-error 는 던지지 않고 null 로 닫는다.
  assert.match(bridge, /case 'usage-error':\s*case 'provider-error': \{[\s\S]*settle\(msg\.requestId, null\)/);
  assert.match(bridge, /this\.requests\.cancelAll\(\)/);
});

test('와이어 값은 항상 두 프로바이더가 있는 형태로 정규화된다', () => {
  assert.match(bridge, /function readProviderStatus\(value: unknown\): ProviderStatusMap/);
  assert.match(bridge, /function readUsageSummary\(value: unknown\): UsageSummary \| null/);
  assert.match(bridge, /cacheReadTokens: num\(src\['cacheReadTokens'\]\)/);
  assert.match(bridge, /session5h: nullableNum\(limit\['session5h'\]\)/);
});

test('사용량·프로바이더 타입과 SidebarEvent 항목이 types.ts 에 산다', () => {
  assert.match(types, /export interface ProviderHealth \{/);
  assert.match(types, /export type ProviderStatusMap = Record<AgentName, ProviderHealth>;/);
  assert.match(types, /export interface UsageWindow \{/);
  assert.match(types, /export interface ProviderUsage \{/);
  assert.match(types, /export interface UsageSummary \{/);
  assert.match(types, /export type ClaudeUsagePlan = 'pro' \| 'max5x' \| 'max20x' \| 'api';/);
  assert.match(types, /export type CodexUsagePlan = 'plus' \| 'pro' \| 'api';/);
  assert.match(types, /\| \{ type: 'provider-status'; providers: ProviderStatusMap \}/);
  assert.match(types, /\| \{ type: 'usage-report'; usage: UsageSummary \}/);
});
