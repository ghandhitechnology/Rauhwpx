import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLAUDE_PLANS,
  CODEX_PLANS,
  CURSOR_PLANS,
  GROK_PLANS,
  MAX_USAGE_MODEL_CHARS,
  MAX_USAGE_MODELS,
  MAX_USAGE_TOKEN_COUNT,
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
    path.win32.join('C:\\data', 'rhwp', 'usage'),
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
  assert.deepEqual(empty.plans, { claude: 'pro', codex: 'plus', pi: 'api', grok: 'api', cursor: 'api', rau: 'api' });
  assert.equal(empty.providers.claude.updatedAt, null);
  assert.equal(empty.providers.claude.session.turns, 0);
  assert.equal(empty.providers.claude.session.percent, 0);
  assert.deepEqual(empty.providers.claude.limit, CLAUDE_PLANS.pro);
  assert.deepEqual(empty.providers.codex.limit, CODEX_PLANS.plus);
  assert.equal(Object.getPrototypeOf(empty.providers.claude.byModel), null);
  assert.deepEqual(Object.keys(empty.providers.claude.byModel), []);

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
  assert.deepEqual(saved, { claude: 'max20x', codex: 'pro', pi: 'api', grok: 'api', cursor: 'api', rau: 'api' });
  const stat = await fs.stat(path.join(rootDir, 'plans.json'));
  assert.equal(stat.mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);

  const reloaded = await createUsageStore({ rootDir, now: time.now }).init();
  assert.deepEqual(reloaded.plans(), { claude: 'max20x', codex: 'pro', pi: 'api', grok: 'api', cursor: 'api', rau: 'api' });
  assert.deepEqual(reloaded.summary().providers.claude.limit, CLAUDE_PLANS.max20x);

  await store.flush();
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('Windows plan replacement serializes concurrent writes and leaves no staging files', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now, platform: 'win32' }).init();

  // A constant clock used to make both calls reuse the old timestamp-derived
  // staging name. Unique staging files plus the shared queue must retain both
  // updates even when Windows cannot rename over an existing destination.
  await Promise.all([
    store.setPlan('claude', 'max20x'),
    store.setPlan('codex', 'pro'),
  ]);
  await store.flush();

  const saved = JSON.parse(await fs.readFile(path.join(rootDir, 'plans.json'), 'utf8'));
  assert.equal(saved.claude, 'max20x');
  assert.equal(saved.codex, 'pro');
  assert.deepEqual(
    (await fs.readdir(rootDir)).filter((name) => name.includes('.tmp-') || name.endsWith('.previous-write')),
    [],
  );
});

test('Windows startup recovers usage plans and events left at the replacement gap', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now, platform: 'win32' }).init();
  await store.setPlan('claude', 'max20x');
  store.record({
    agent: 'claude', model: 'opus', inputTokens: 100, outputTokens: 10,
    cacheReadTokens: 0, cacheCreationTokens: 0,
  });
  await store.flush();
  for (const name of ['plans.json', 'events.jsonl']) {
    await fs.rename(path.join(rootDir, name), path.join(rootDir, `${name}.previous-write`));
  }

  const recovered = await createUsageStore({ rootDir, now: time.now, platform: 'win32' }).init();
  assert.equal(recovered.plans().claude, 'max20x');
  assert.equal(recovered.summary().providers.claude.week.turns, 1);
  recovered.record({
    agent: 'claude', model: 'sonnet', inputTokens: 20, outputTokens: 5,
    cacheReadTokens: 0, cacheCreationTokens: 0,
  });
  await recovered.flush();

  const reloaded = await createUsageStore({ rootDir, now: time.now, platform: 'win32' }).init();
  assert.equal(reloaded.summary().providers.claude.week.turns, 2);
});

test('a failed plan replacement does not publish an in-memory-only selection', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  // Force the Windows two-step replace on every host so a directory target
  // cannot be moved aside and then treated as a successful publish.
  const store = await createUsageStore({ rootDir, platform: 'win32' }).init();

  // A directory cannot be atomically replaced by the plans file. The failed
  // durable write must leave both the visible selection and staging area clean.
  await fs.mkdir(path.join(rootDir, 'plans.json'));
  await assert.rejects(() => store.setPlan('claude', 'max20x'), { code: 'EISDIR' });
  assert.equal(store.plans().claude, 'pro');
  assert.deepEqual(
    (await fs.readdir(rootDir)).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('startup ignores a symlinked plans file', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const outside = path.join(rootDir, 'outside-plans.json');
  const plansPath = path.join(rootDir, 'plans.json');
  await fs.writeFile(outside, JSON.stringify({ claude: 'max20x' }));
  try {
    await fs.symlink(outside, plansPath);
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error?.code)) {
      t.skip('This Windows host does not permit unprivileged symlink creation');
      return;
    }
    throw error;
  }

  const store = await createUsageStore({ rootDir }).init();
  assert.equal(store.plans().claude, 'pro');
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

test('extreme weighted usage is stable across flush and replay', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now }).init();
  const event = store.record({
    agent: 'codex',
    model: 'bounded-extreme',
    inputTokens: Number.MAX_VALUE,
    outputTokens: Number.MAX_VALUE,
    cacheReadTokens: Number.MAX_VALUE,
    cacheCreationTokens: Number.MAX_VALUE,
  });
  const expected = (MAX_USAGE_TOKEN_COUNT * 3) + (MAX_USAGE_TOKEN_COUNT / 10);
  assert.equal(event.weightedTokens, expected);
  assert.equal(store.summary().providers.codex.week.weightedTokens, expected);
  await store.flush();

  const reloaded = await createUsageStore({ rootDir, now: time.now }).init();
  assert.equal(reloaded.summary().providers.codex.week.weightedTokens, expected);
});

test('usage model keys and numeric fields are bounded without touching Object.prototype', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await createUsageStore({ rootDir }).init();
  const longModel = `model-${'x'.repeat(MAX_USAGE_MODEL_CHARS * 2)}`;

  store.record({
    agent: 'codex',
    model: '__proto__',
    inputTokens: Number.MAX_VALUE,
    outputTokens: Infinity,
  });
  store.record({ agent: 'codex', model: longModel, outputTokens: Number.MAX_VALUE });
  await store.flush();

  const byModel = store.summary().providers.codex.byModel;
  assert.equal(Object.getPrototypeOf(byModel), null);
  assert.equal(Object.hasOwn(byModel, '__proto__'), true);
  assert.equal(byModel.__proto__.inputTokens, MAX_USAGE_TOKEN_COUNT);
  assert.equal(byModel.__proto__.outputTokens, 0);
  assert.equal(Object.prototype.turns, undefined);
  const boundedName = Object.keys(byModel).find((name) => name.startsWith('model-'));
  assert.equal(boundedName.length, MAX_USAGE_MODEL_CHARS);
  assert.equal(byModel[boundedName].outputTokens, MAX_USAGE_TOKEN_COUNT);
});

test('weekly model aggregation reserves one bounded overflow bucket', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await createUsageStore({ rootDir }).init();
  for (let index = 0; index < MAX_USAGE_MODELS + 20; index += 1) {
    store.record({ agent: 'codex', model: `model-${index}`, inputTokens: 1 });
  }

  const byModel = store.summary().providers.codex.byModel;
  assert.equal(Object.keys(byModel).length, MAX_USAGE_MODELS);
  assert.equal(Object.hasOwn(byModel, 'other'), true);
  assert.equal(byModel.other.turns, 21);
  await store.flush();
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

test('grok and cursor record turns under the api-only plan', async () => {
  const rootDir = await tmpRoot();
  const time = clock();
  const store = await createUsageStore({ rootDir, now: time.now }).init();

  store.record({ agent: 'grok', model: 'grok-4.6', inputTokens: 120, outputTokens: 40 });
  store.record({ agent: 'cursor', model: 'auto', inputTokens: 30, outputTokens: 10 });

  const usage = store.summary();
  assert.deepEqual(usage.providers.grok.limit, GROK_PLANS.api);
  assert.deepEqual(usage.providers.cursor.limit, CURSOR_PLANS.api);
  assert.equal(usage.providers.grok.session.percent, null);
  assert.equal(usage.providers.grok.session.weightedTokens, 160);
  assert.equal(usage.providers.cursor.byModel.auto.turns, 1);
  await assert.rejects(() => store.setPlan('grok', 'pro'), (error) => error.code === 'INVALID_PLAN');
  await assert.rejects(() => store.setPlan('cursor', 'plus'), (error) => error.code === 'INVALID_PLAN');

  await store.flush();
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

test('startup reads only a bounded log tail and rewrites the retained events', async () => {
  const rootDir = await tmpRoot();
  const time = clock();
  const writer = await createUsageStore({ rootDir, now: time.now }).init();
  for (let index = 0; index < 10; index += 1) {
    writer.record({ agent: 'codex', model: `m${index}`, inputTokens: 1 });
    time.advance(1);
  }
  await writer.flush();
  const logPath = path.join(rootDir, 'events.jsonl');
  const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
  const tailBytes = Buffer.byteLength(`${lines.slice(-3).join('\n')}\n`) + 8;

  const reopened = await createUsageStore({
    rootDir,
    now: time.now,
    maxLogBytes: tailBytes,
  }).init();
  assert.ok(reopened.summary().providers.codex.week.turns <= 3);
  assert.ok((await fs.readFile(logPath, 'utf8')).trim().split('\n').length <= 3);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('long-running recording compacts by count and age without a restart', async () => {
  const rootDir = await tmpRoot();
  const time = clock();
  const store = await createUsageStore({
    rootDir,
    now: time.now,
    maxEvents: 3,
    retentionMs: 1_000,
    pruneIntervalMs: 0,
  }).init();
  for (let index = 0; index < 5; index += 1) {
    store.record({ agent: 'claude', model: `m${index}`, inputTokens: 1 });
    time.advance(1);
  }
  assert.equal(store.summary().providers.claude.week.turns, 3);

  time.advance(2_000);
  store.record({ agent: 'claude', model: 'fresh', inputTokens: 1 });
  assert.equal(store.summary().providers.claude.week.turns, 1);
  await store.flush();
  assert.equal((await fs.readFile(path.join(rootDir, 'events.jsonl'), 'utf8')).trim().split('\n').length, 1);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('count compaction leaves headroom before the next full-log rewrite', async (t) => {
  const rootDir = await tmpRoot();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const time = clock();
  const store = await createUsageStore({
    rootDir,
    now: time.now,
    maxEvents: 10,
    pruneIntervalMs: HOUR,
  }).init();

  for (let index = 0; index < 11; index += 1) {
    store.record({ agent: 'codex', model: `m${index}`, inputTokens: 1 });
  }
  await store.flush();

  const lines = (await fs.readFile(path.join(rootDir, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 9);
  assert.equal(store.summary().providers.codex.week.turns, 9);
});
