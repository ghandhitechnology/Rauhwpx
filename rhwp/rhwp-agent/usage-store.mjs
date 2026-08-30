import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EVENTS_FILE = 'events.jsonl';
const PLANS_FILE = 'plans.json';

/** 캐시 읽기는 과금 비중이 낮다 — 가중 토큰 계산에서 1/10 로 센다. */
const CACHE_READ_WEIGHT = 0.1;
/** 8일치만 보관한다: 주간(7일) 창을 계산할 만큼만 남기고 잘라낸다. */
const RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_USAGE_LOG_BYTES = 32 * 1024 * 1024;
export const MAX_USAGE_EVENTS = 50_000;
const MAX_PLANS_BYTES = 64 * 1024;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** 요금제별 토큰 예산 — 공식 수치가 공개되지 않아 모두 추정치다. */
export const CLAUDE_PLANS = {
  pro: { session5h: 2_500_000, week: 25_000_000 },
  max5x: { session5h: 12_500_000, week: 125_000_000 },
  max20x: { session5h: 50_000_000, week: 500_000_000 },
  api: { session5h: null, week: null },
};

/** 요금제별 토큰 예산 — 공식 수치가 공개되지 않아 모두 추정치다. */
export const CODEX_PLANS = {
  plus: { session5h: 2_500_000, week: 25_000_000 },
  pro: { session5h: 25_000_000, week: 250_000_000 },
  api: { session5h: null, week: null },
};

/** pi 는 OpenRouter 종량제뿐이다 — 토큰 한도 대신 잔액(usage.openrouter)을 본다. */
export const PI_PLANS = {
  api: { session5h: null, week: null },
};

/** rau 는 체험 OpenRouter 키 — 한도는 호스티드 $5 잔액이다. */
export const RAU_PLANS = {
  api: { session5h: null, week: null },
};

/** grok/cursor 는 공개된 요금제 예산 정보가 없다 — 종량제 한 칸만 둔다. */
export const GROK_PLANS = {
  api: { session5h: null, week: null },
};

export const CURSOR_PLANS = {
  api: { session5h: null, week: null },
};

export const AGENTS = /** @type {const} */ (['claude', 'codex', 'pi', 'grok', 'cursor', 'rau']);
export const DEFAULT_PLANS = { claude: 'pro', codex: 'plus', pi: 'api', grok: 'api', cursor: 'api', rau: 'api' };
export const PLAN_TABLES = {
  claude: CLAUDE_PLANS,
  codex: CODEX_PLANS,
  pi: PI_PLANS,
  grok: GROK_PLANS,
  cursor: CURSOR_PLANS,
  rau: RAU_PLANS,
};

export function defaultUsageRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (env.RHWP_USAGE_DIR) return platformPath.resolve(env.RHWP_USAGE_DIR);
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'Application Support', 'rhwp', 'usage');
  if (platform === 'win32') {
    return platformPath.join(env.APPDATA || platformPath.join(home, 'AppData', 'Roaming'), 'rhwp', 'usage');
  }
  return platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share'), 'rhwp', 'usage');
}

function toCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function normalizeAgent(agent) {
  return AGENTS.includes(agent) ? agent : null;
}

/** USD 비용. 음수/NaN 은 0 으로 보고 6자리에서 자른다(부동소수 찌꺼기 방지). */
function toCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1e6) / 1e6;
}

export function weightedTokensOf({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }) {
  return toCount(inputTokens)
    + toCount(outputTokens)
    + toCount(cacheCreationTokens)
    + Math.round(toCount(cacheReadTokens) * CACHE_READ_WEIGHT);
}

function emptyWindow() {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    weightedTokens: 0,
    costUsd: 0,
    percent: null,
  };
}

function addToWindow(window, event) {
  window.turns += 1;
  window.inputTokens += event.inputTokens;
  window.outputTokens += event.outputTokens;
  window.cacheReadTokens += event.cacheReadTokens;
  window.cacheCreationTokens += event.cacheCreationTokens;
  window.weightedTokens += event.weightedTokens;
  window.costUsd = toCost(window.costUsd + event.costUsd);
}

function percentOf(weightedTokens, limit) {
  if (!Number.isFinite(limit) || limit === null || limit <= 0) return null;
  return Math.round((weightedTokens / limit) * 1000) / 10;
}

function parseEventLine(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const agent = normalizeAgent(raw?.agent);
  const ts = Number(raw?.ts);
  if (!agent || !Number.isFinite(ts)) return null;
  const event = {
    ts,
    agent,
    model: typeof raw.model === 'string' && raw.model ? raw.model : 'unknown',
    inputTokens: toCount(raw.inputTokens),
    outputTokens: toCount(raw.outputTokens),
    cacheReadTokens: toCount(raw.cacheReadTokens),
    cacheCreationTokens: toCount(raw.cacheCreationTokens),
    costUsd: toCost(raw.costUsd),
    weightedTokens: 0,
  };
  event.weightedTokens = Number.isFinite(Number(raw.weightedTokens)) && Number(raw.weightedTokens) > 0
    ? Math.round(Number(raw.weightedTokens))
    : weightedTokensOf(event);
  return event;
}

async function readSmallFile(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      const error = new Error(`${path.basename(file)} exceeds its ${maxBytes}-byte read limit`);
      error.code = 'USAGE_FILE_TOO_LARGE';
      throw error;
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readEventTail(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const start = stat.size - length;
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let body = bytes.subarray(0, offset);
    if (start > 0) {
      const newline = body.indexOf(0x0a);
      body = newline === -1 ? Buffer.alloc(0) : body.subarray(newline + 1);
    }
    return { text: body.toString('utf8'), truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

/**
 * 프로바이더 토큰 사용량을 append-only JSONL 로 남기고 롤링 윈도우로 집계한다.
 *
 * @param {{ rootDir?: string, now?: () => number, maxEvents?: number,
 *           retentionMs?: number, pruneIntervalMs?: number, maxLogBytes?: number }} [opts]
 */
export function createUsageStore({
  rootDir = defaultUsageRoot(),
  now = Date.now,
  maxEvents = MAX_USAGE_EVENTS,
  retentionMs = RETENTION_MS,
  pruneIntervalMs = PRUNE_INTERVAL_MS,
  maxLogBytes = MAX_USAGE_LOG_BYTES,
} = {}) {
  maxEvents = Number.isSafeInteger(maxEvents) && maxEvents > 0
    ? Math.min(maxEvents, MAX_USAGE_EVENTS)
    : MAX_USAGE_EVENTS;
  maxLogBytes = Number.isSafeInteger(maxLogBytes) && maxLogBytes > 0
    ? Math.min(maxLogBytes, MAX_USAGE_LOG_BYTES)
    : MAX_USAGE_LOG_BYTES;
  const eventsPath = path.join(rootDir, EVENTS_FILE);
  const plansPath = path.join(rootDir, PLANS_FILE);
  /** @type {Array<{ ts: number, agent: 'claude'|'codex'|'pi'|'grok'|'cursor'|'rau', model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, costUsd: number, weightedTokens: number }>} */
  let events = [];
  let plans = { ...DEFAULT_PLANS };
  /** 파일 쓰기는 직렬화한다 — 같은 줄에 두 이벤트가 섞이지 않도록. */
  let writeChain = Promise.resolve();
  let lastPrunedAt = now();

  async function writeAtomic(file, text) {
    const temp = `${file}.tmp-${process.pid}-${now()}`;
    await fs.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, file);
  }

  function serialize(event) {
    return `${JSON.stringify(event)}\n`;
  }

  async function rewriteEvents(snapshot = events) {
    await writeAtomic(eventsPath, snapshot.map(serialize).join(''));
  }

  function pruneEvents(current) {
    const retained = events.filter((event) => current - event.ts <= retentionMs);
    events = retained.length > maxEvents ? retained.slice(-maxEvents) : retained;
    lastPrunedAt = current;
  }

  function validPlan(agent, plan) {
    const table = PLAN_TABLES[agent];
    return Boolean(table && typeof plan === 'string' && Object.hasOwn(table, plan));
  }

  function limitsFor(agent) {
    const table = PLAN_TABLES[agent];
    const limit = table[plans[agent]] ?? table[DEFAULT_PLANS[agent]];
    return { session5h: limit.session5h ?? null, week: limit.week ?? null };
  }

  function providerUsage(agent) {
    const current = now();
    const limit = limitsFor(agent);
    const session = emptyWindow();
    const day = emptyWindow();
    const week = emptyWindow();
    /** @type {Record<string, { turns: number, inputTokens: number, outputTokens: number, weightedTokens: number, costUsd: number }>} */
    const byModel = {};
    let updatedAt = null;
    for (const event of events) {
      if (event.agent !== agent) continue;
      const age = current - event.ts;
      if (updatedAt === null || event.ts > updatedAt) updatedAt = event.ts;
      if (age <= SESSION_WINDOW_MS) addToWindow(session, event);
      if (age <= DAY_WINDOW_MS) addToWindow(day, event);
      if (age > WEEK_WINDOW_MS) continue;
      addToWindow(week, event);
      // 모델별 내역은 주간 창(7일) 기준이다 — 한도 표시와 같은 범위를 쓴다.
      const entry = byModel[event.model] ?? (byModel[event.model] = {
        turns: 0, inputTokens: 0, outputTokens: 0, weightedTokens: 0, costUsd: 0,
      });
      entry.turns += 1;
      entry.inputTokens += event.inputTokens;
      entry.outputTokens += event.outputTokens;
      entry.weightedTokens += event.weightedTokens;
      entry.costUsd = toCost(entry.costUsd + event.costUsd);
    }
    session.percent = percentOf(session.weightedTokens, limit.session5h);
    week.percent = percentOf(week.weightedTokens, limit.week);
    return { session, day, week, byModel, limit, updatedAt };
  }

  return {
    rootDir,
    eventsPath,
    plansPath,

    async init() {
      await fs.mkdir(rootDir, { recursive: true });
      try {
        const raw = JSON.parse(await readSmallFile(plansPath, MAX_PLANS_BYTES));
        for (const agent of AGENTS) {
          if (validPlan(agent, raw?.[agent])) plans[agent] = raw[agent];
        }
      } catch {
        // 요금제 파일이 없거나 깨졌으면 기본값으로 시작한다.
      }
      try {
        const loaded = await readEventTail(eventsPath, maxLogBytes);
        const text = loaded.text;
        const parsed = [];
        let dropped = loaded.truncated ? 1 : 0;
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const event = parseEventLine(line);
          if (!event || now() - event.ts > retentionMs) {
            dropped += 1;
            continue;
          }
          parsed.push(event);
        }
        parsed.sort((a, b) => a.ts - b.ts);
        if (parsed.length > maxEvents) {
          dropped += parsed.length - maxEvents;
          events = parsed.slice(-maxEvents);
        } else {
          events = parsed;
        }
        lastPrunedAt = now();
        if (dropped > 0) await rewriteEvents();
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        events = [];
      }
      return this;
    },

    /**
     * 한 턴의 사용량을 기록한다. 파일 append 는 fire-and-forget 이지만 순서는 보장된다.
     * @returns {object|null} 기록된 이벤트, 입력이 유효하지 않으면 null
     */
    record({
      agent, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd,
    } = {}) {
      const normalizedAgent = normalizeAgent(agent);
      if (!normalizedAgent) return null;
      const event = {
        ts: now(),
        agent: normalizedAgent,
        model: typeof model === 'string' && model.trim() ? model.trim() : 'unknown',
        inputTokens: toCount(inputTokens),
        outputTokens: toCount(outputTokens),
        cacheReadTokens: toCount(cacheReadTokens),
        cacheCreationTokens: toCount(cacheCreationTokens),
        // pi · rau 는 OpenRouter 청구액을 그대로 들고 온다 — 다른 프로바이더는 0 이다.
        costUsd: toCost(costUsd),
        weightedTokens: 0,
      };
      event.weightedTokens = weightedTokensOf(event);
      events.push(event);
      const shouldPrune = events.length > maxEvents || event.ts - lastPrunedAt >= pruneIntervalMs;
      let persist;
      if (shouldPrune) {
        pruneEvents(event.ts);
        const snapshot = [...events];
        persist = () => rewriteEvents(snapshot);
      } else {
        persist = () => fs.appendFile(eventsPath, serialize(event), { encoding: 'utf8', mode: 0o600 });
      }
      writeChain = writeChain
        .then(persist)
        .catch((error) => {
          process.stderr.write(`[usage-store] append 실패: ${error?.message ?? error}\n`);
        });
      return event;
    },

    /** 진행 중인 파일 쓰기가 끝날 때까지 기다린다 (테스트/종료용). */
    flush() {
      return writeChain;
    },

    plans() {
      return { ...plans };
    },

    /**
     * @param {'claude'|'codex'|'pi'|'grok'|'cursor'|'rau'} agent
     * @param {string} plan
     */
    async setPlan(agent, plan) {
      const normalizedAgent = normalizeAgent(agent);
      if (!normalizedAgent || !validPlan(normalizedAgent, plan)) {
        const error = new Error(`지원하지 않는 요금제입니다: ${String(agent)}/${String(plan)}`);
        error.code = 'INVALID_PLAN';
        throw error;
      }
      plans = { ...plans, [normalizedAgent]: plan };
      await writeAtomic(plansPath, `${JSON.stringify(plans, null, 2)}\n`);
      return this.summary();
    },

    summary() {
      return {
        plans: { ...plans },
        providers: Object.fromEntries(AGENTS.map((agent) => [agent, providerUsage(agent)])),
      };
    },
  };
}
