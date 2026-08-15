import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLAUDE_PLANS,
  CODEX_PLANS,
  PI_PLANS,
  createUsageStore,
  defaultUsageRoot,
  weightedTokensOf,
} from '../usage-store.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-usage-'));
}

function clock(start = Date.UTC(2026, 0, 15, 12, 0, 0)) {
  const state = { value: start };
  return {
    now: () => state.value,
    advance(ms) { state.value += ms; },
    set(ms) { state.value = ms; },
  };
}

test('RHWP_USAGE_DIR overrides the per-platform app data root', () => {
  assert.equal(defaultUsageRoot({ RHWP_USAGE_DIR: '/tmp/usage-here' }), path.resolve('/tmp/usage-here'));
  assert.equal(
    defaultUsageRoot({}, 'darwin', '/Users/tester'),
    '/Users/tester/Library/Application Support/rhwp/usage',
  );
  assert.equal(
    defaultUsageRoot({ APPDATA: 'C:\\data' }, 'win32', 'C:\\Users\\t'),
    path.join('C:\\data', 'rhwp', 'usage'),
  );
  assert.equal(
    defaultUsageRoot({}, 'linux', '/home/t'),
    '/home/t/.local/share/rhwp/usage',
  );
});

test('weighted tokens discount cache reads by ten', () => {
  assert.equal(
    weightedTokensOf({ inputTokens: 100, outputTokens: 50, cacheCreationTokens: 20, cacheReadTokens: 1000 }),
    100 + 50 + 20 + 100,
  );
  assert.equal(weightedTokensOf({ inputTokens: -5, outputTokens: NaN, cacheReadTokens: '30' }), 3);
});

test('summary aggregates rolling windows, weights and percents', async () => {
  const rootDir = await tmpRoot();
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now }).init();

  const empty = store.summary();
  assert.deepEqual(empty.plans, { claude: 'pro', codex: 'plus', pi: 'api' });
  assert.equal(empty.providers.claude.updatedAt, null);
  assert.equal(empty.providers.claude.session.turns, 0);
  assert.equal(empty.providers.claude.session.percent, 0);
  assert.deepEqual(empty.providers.claude.limit, CLAUDE_PLANS.pro);
  assert.deepEqual(empty.providers.codex.limit, CODEX_PLANS.plus);
  assert.deepEqual(empty.providers.claude.byModel, {});

  // 6일 전: 주간 창에만 들어간다.
  time.advance(-6 * DAY);
  store.record({ agent: 'claude', model: 'opus', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheCreationTokens: 100 });
  // 10시간 전: 하루/주간 창.
  time.advance(6 * DAY - 10 * HOUR);
  store.record({ agent: 'claude', model: 'sonnet', inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 });
  // 지금: 모든 창.
  time.advance(10 * HOUR);
  const latest = store.record({ agent: 'claude', model: 'sonnet', inputTokens: 50, outputTokens: 25, cacheReadTokens: 500, cacheCreationTokens: 5 });
  store.record({ agent: 'codex', model: 'gpt-5.6-sol', inputTokens: 10, outputTokens: 20, cacheReadTokens: 100, cacheCreationTokens: 0 });

  const claude = store.summary().providers.claude;
  assert.equal(claude.updatedAt, latest.ts);
  assert.deepEqual(
    [claude.session.turns, claude.day.turns, claude.week.turns],
    [1, 2, 3],
  );
  assert.equal(claude.session.weightedTokens, 50 + 25 + 5 + 50);
  assert.equal(claude.day.weightedTokens, 300 + 130);
  assert.equal(claude.week.weightedTokens, 300 + 130 + (1000 + 500 + 100 + 1000));
  assert.equal(claude.session.inputTokens, 50);
  assert.equal(claude.session.cacheReadTokens, 500);
  assert.equal(claude.session.cacheCreationTokens, 5);
  assert.equal(claude.day.percent, null, 'day never carries a percent');
  assert.equal(
    claude.session.percent,
    Math.round((130 / CLAUDE_PLANS.pro.session5h) * 1000) / 10,
  );
  assert.equal(
    claude.week.percent,
    Math.round((claude.week.weightedTokens / CLAUDE_PLANS.pro.week) * 1000) / 10,
  );
  assert.deepEqual(Object.keys(claude.byModel).sort(), ['opus', 'sonnet']);
  assert.deepEqual(claude.byModel.sonnet, {
    turns: 2, inputTokens: 250, outputTokens: 125, weightedTokens: 430, costUsd: 0,
  });

  const codex = store.summary().providers.codex;
  assert.equal(codex.session.turns, 1);
  assert.equal(codex.session.weightedTokens, 10 + 20 + 10);

  await store.flush();
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('api plans report no limit and no percent', async () => {
  const rootDir = await tmpRoot();
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now }).init();
  store.record({ agent: 'claude', model: 'opus', inputTokens: 5_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

  const usage = await store.setPlan('claude', 'api');
  assert.deepEqual(usage.providers.claude.limit, { session5h: null, week: null });
  assert.equal(usage.providers.claude.session.percent, null);
  assert.equal(usage.providers.claude.week.percent, null);

  await store.flush();
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('plans are validated, persisted and reloaded', async () => {
  const rootDir = await tmpRoot();
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now }).init();

  await assert.rejects(() => store.setPlan('claude', 'max100x'), (error) => {
    assert.equal(error.code, 'INVALID_PLAN');
    return true;
  });
  await assert.rejects(() => store.setPlan('gemini', 'pro'), (error) => {
    assert.equal(error.code, 'INVALID_PLAN');
    return true;
  });
  // plus 는 Codex 전용 요금제다 — Claude 에는 쓸 수 없다.
  await assert.rejects(() => store.setPlan('claude', 'plus'), /지원하지 않는 요금제/);

  const usage = await store.setPlan('claude', 'max20x');
  assert.equal(usage.plans.claude, 'max20x');
  await store.setPlan('codex', 'pro');

  const saved = JSON.parse(await fs.readFile(path.join(rootDir, 'plans.json'), 'utf8'));
  assert.deepEqual(saved, { claude: 'max20x', codex: 'pro', pi: 'api' });
  const stat = await fs.stat(path.join(rootDir, 'plans.json'));
  assert.equal(stat.mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);

  const reloaded = await createUsageStore({ rootDir, now: time.now }).init();
  assert.deepEqual(reloaded.plans(), { claude: 'max20x', codex: 'pro', pi: 'api' });
  assert.deepEqual(reloaded.summary().providers.claude.limit, CLAUDE_PLANS.max20x);

  await store.flush();
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('events replay from the jsonl log in a new store', async () => {
  const rootDir = await tmpRoot();
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now }).init();
  store.record({ agent: 'claude', model: 'opus', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 });
  time.advance(HOUR);
  store.record({ agent: 'codex', model: 'gpt-5.6-sol', inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 });
  await store.flush();

  const lines = (await fs.readFile(path.join(rootDir, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).agent, 'claude');

  const reloaded = await createUsageStore({ rootDir, now: time.now }).init();
  const usage = reloaded.summary();
  assert.equal(usage.providers.claude.session.weightedTokens, 110);
  assert.equal(usage.providers.codex.session.weightedTokens, 10);
  assert.equal(usage.providers.claude.byModel.opus.turns, 1);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('load prunes events older than eight days and rewrites the log', async () => {
  const rootDir = await tmpRoot();
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now }).init();
  store.record({ agent: 'claude', model: 'opus', inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  await store.flush();
  await fs.appendFile(path.join(rootDir, 'events.jsonl'), 'not json at all\n');

  // 9일 뒤에 다시 열면 오래된 이벤트와 깨진 줄이 함께 정리된다.
  time.advance(9 * DAY);
  const reloaded = await createUsageStore({ rootDir, now: time.now }).init();
  assert.equal(reloaded.summary().providers.claude.week.turns, 0);
  assert.equal((await fs.readFile(path.join(rootDir, 'events.jsonl'), 'utf8')).trim(), '');

  reloaded.record({ agent: 'claude', model: 'opus', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });
  await reloaded.flush();
  const again = await createUsageStore({ rootDir, now: time.now }).init();
  assert.equal(again.summary().providers.claude.week.turns, 1);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('pi records OpenRouter cost alongside tokens and replays it', async () => {
  const rootDir = await tmpRoot();
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now }).init();

  store.record({ agent: 'pi', model: 'deepseek/deepseek-chat-v3.1', inputTokens: 1000, outputTokens: 200, costUsd: 0.0125 });
  time.advance(HOUR);
  store.record({ agent: 'pi', model: 'deepseek/deepseek-chat-v3.1', inputTokens: 500, outputTokens: 100, costUsd: 0.005 });
  // 비용이 없는 프로바이더는 0 으로 남는다.
  store.record({ agent: 'claude', model: 'opus', inputTokens: 10, outputTokens: 10 });

  const usage = store.summary();
  assert.deepEqual(usage.providers.pi.limit, PI_PLANS.api);
  assert.equal(usage.providers.pi.session.percent, null);
  assert.equal(usage.providers.pi.week.percent, null);
  assert.equal(usage.providers.pi.session.costUsd, 0.0175);
  assert.equal(usage.providers.pi.day.costUsd, 0.0175);
  assert.deepEqual(usage.providers.pi.byModel['deepseek/deepseek-chat-v3.1'], {
    turns: 2, inputTokens: 1500, outputTokens: 300, weightedTokens: 1800, costUsd: 0.0175,
  });
  assert.equal(usage.providers.claude.session.costUsd, 0);

  await store.flush();
  const reloaded = await createUsageStore({ rootDir, now: time.now }).init();
  assert.equal(reloaded.summary().providers.pi.week.costUsd, 0.0175);

  await fs.rm(rootDir, { recursive: true, force: true });
});

test('api is the only pi plan', async () => {
  const rootDir = await tmpRoot();
  const store = await createUsageStore({ rootDir, now: clock().now }).init();

  await assert.rejects(() => store.setPlan('pi', 'pro'), (error) => error.code === 'INVALID_PLAN');
  const usage = await store.setPlan('pi', 'api');
  assert.equal(usage.plans.pi, 'api');

  await store.flush();
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('record ignores unknown agents and normalizes missing fields', async () => {
  const rootDir = await tmpRoot();
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now }).init();

  assert.equal(store.record({ agent: 'gemini', model: 'x', inputTokens: 10 }), null);
  const event = store.record({ agent: 'codex', inputTokens: 10 });
  assert.equal(event.model, 'unknown');
  assert.equal(event.outputTokens, 0);
  assert.equal(event.weightedTokens, 10);
  assert.equal(store.summary().providers.codex.byModel.unknown.turns, 1);

  await store.flush();
  await fs.rm(rootDir, { recursive: true, force: true });
});
