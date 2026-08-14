import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CLIPROXY_FILE = 'cliproxy.json';
export const DEFAULT_CLIPROXY_URL = 'http://127.0.0.1:8317';

const FETCH_TIMEOUT_MS = 8_000;
const QUOTA_CACHE_MS = 60_000;
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const PROVIDER_AGENT = {
  claude: 'claude',
  anthropic: 'claude',
  codex: 'codex',
  openai: 'codex',
  chatgpt: 'codex',
};

export function emptyCliproxyStatus() {
  return {
    configured: false,
    connected: false,
    url: null,
    error: null,
    checkedAt: null,
    accounts: [],
  };
}

export function normalizeCliproxyUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    const error = new Error('CLIProxyAPI 주소가 필요해요');
    error.code = 'INVALID_CLIPROXY_URL';
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    const error = new Error('CLIProxyAPI 주소가 올바르지 않아요');
    error.code = 'INVALID_CLIPROXY_URL';
    throw error;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const error = new Error('CLIProxyAPI 주소는 http 또는 https 여야 해요');
    error.code = 'INVALID_CLIPROXY_URL';
    throw error;
  }
  if (parsed.username || parsed.password) {
    const error = new Error('주소에 인증 정보를 넣지 마세요. 관리 키는 따로 입력해요');
    error.code = 'INVALID_CLIPROXY_URL';
    throw error;
  }
  parsed.hash = '';
  parsed.search = '';
  let href = parsed.href;
  if (href.endsWith('/') && parsed.pathname === '/') href = href.slice(0, -1);
  while (href.endsWith('/')) href = href.slice(0, -1);
  return href;
}

export function cliproxyConfigFromEnv(env = process.env) {
  const url = typeof env.RHWP_CLIPROXY_URL === 'string' ? env.RHWP_CLIPROXY_URL.trim() : '';
  const key = typeof env.RHWP_CLIPROXY_KEY === 'string' ? env.RHWP_CLIPROXY_KEY.trim() : '';
  if (!url && !key) return null;
  return {
    url: url ? normalizeCliproxyUrl(url) : DEFAULT_CLIPROXY_URL,
    key,
    enabled: true,
    source: 'env',
  };
}

function readConfigObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.enabled === false) {
    return { url: DEFAULT_CLIPROXY_URL, key: '', enabled: false, source: 'file' };
  }
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!url || !key) return null;
  return {
    url: normalizeCliproxyUrl(url),
    key,
    enabled: raw.enabled !== false,
    source: 'file',
  };
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstValue(...candidates) {
  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mapProvider(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return PROVIDER_AGENT[key] ?? null;
}

function parsePercent(value) {
  const n = toFinite(value);
  if (n === null) return null;
  const percent = n >= 0 && n <= 1.5 ? n * 100 : n;
  return Math.round(Math.min(1000, Math.max(0, percent)) * 10) / 10;
}

function parseResetAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const n = toFinite(value);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function emptyWindow() {
  return { percent: null, resetsAt: null };
}

function windowFrom(source, ...percentKeys) {
  const obj = asObject(source);
  if (!obj) return emptyWindow();
  const percent = parsePercent(firstValue(...percentKeys.map((key) => obj[key])));
  const resetsAt = parseResetAt(firstValue(
    obj.resets_at, obj.resetsAt, obj.reset_at, obj.resetAt, obj.reset_after_seconds, obj.resetAfterSeconds,
  ));
  return { percent, resetsAt };
}

export function parseClaudeUsage(payload) {
  const body = asObject(payload) ?? {};
  const five = firstValue(body.five_hour, body.fiveHour, body.session);
  const week = firstValue(body.seven_day, body.sevenDay, body.week);
  return {
    session: windowFrom(five, 'utilization', 'used_percent', 'usedPercent', 'percent'),
    week: windowFrom(week, 'utilization', 'used_percent', 'usedPercent', 'percent'),
  };
}

function findCodexWindow(rateLimit, seconds) {
  const obj = asObject(rateLimit);
  if (!obj) return null;
  const primary = asObject(firstValue(obj.primary_window, obj.primaryWindow));
  const secondary = asObject(firstValue(obj.secondary_window, obj.secondaryWindow));
  for (const candidate of [primary, secondary]) {
    if (!candidate) continue;
    const duration = toFinite(firstValue(candidate.limit_window_seconds, candidate.limitWindowSeconds));
    if (duration === seconds) return candidate;
  }
  return seconds === 5 * 60 * 60 ? primary : secondary;
}

export function parseCodexUsage(payload) {
  const body = asObject(payload) ?? {};
  const rateLimit = asObject(firstValue(body.rate_limit, body.rateLimit));
  const five = findCodexWindow(rateLimit, 5 * 60 * 60);
  const week = findCodexWindow(rateLimit, 7 * 24 * 60 * 60);
  return {
    session: windowFrom(five, 'used_percent', 'usedPercent'),
    week: windowFrom(week, 'used_percent', 'usedPercent'),
    planType: asString(firstValue(body.plan_type, body.planType)),
  };
}

function parseApiCallBody(body) {
  if (asObject(body)) return body;
  if (typeof body === 'string' && body.trim()) {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

function accountIdFromAuth(entry) {
  const claims = asObject(firstValue(entry.id_token, entry.idToken));
  if (!claims) return null;
  const nested = asObject(claims['https://api.openai.com/auth']);
  return asString(firstValue(
    claims.chatgpt_account_id,
    claims.chatgptAccountId,
    nested?.chatgpt_account_id,
    nested?.chatgptAccountId,
  ));
}

function planTypeFromAuth(entry) {
  const claims = asObject(firstValue(entry.id_token, entry.idToken));
  return asString(firstValue(
    entry.plan_type,
    entry.planType,
    claims?.plan_type,
    claims?.planType,
    claims?.chatgpt_plan_type,
  ));
}

export function summarizeAuthFiles(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const accounts = [];
  for (const raw of files) {
    const entry = asObject(raw);
    if (!entry) continue;
    if (entry.disabled === true) continue;
    const agent = mapProvider(firstValue(entry.provider, entry.type));
    if (!agent) continue;
    accounts.push({
      agent,
      name: asString(firstValue(entry.name, entry.id, entry.email)) ?? 'unknown',
      email: asString(entry.email),
      authIndex: asString(firstValue(entry.auth_index, entry.authIndex)),
      accountId: accountIdFromAuth(entry),
      planType: planTypeFromAuth(entry),
    });
  }
  return accounts;
}

function pickAccount(accounts, agent) {
  const matches = accounts.filter((account) => account.agent === agent);
  return matches[0] ?? null;
}

function publicAccount(account) {
  if (!account) return null;
  return {
    agent: account.agent,
    name: account.name,
    email: account.email,
    planType: account.planType ?? null,
    session: account.session ?? emptyWindow(),
    week: account.week ?? emptyWindow(),
    error: account.error ?? null,
  };
}

export function applyCliproxyToSummary(summary, status) {
  const next = {
    plans: { ...(summary?.plans ?? { claude: 'pro', codex: 'plus' }) },
    providers: {
      // CLIProxyAPI 는 claude/codex 만 안다 — pi 등 나머지 프로바이더는 그대로 통과시킨다.
      ...(summary?.providers ?? {}),
      claude: { ...(summary?.providers?.claude ?? {}) },
      codex: { ...(summary?.providers?.codex ?? {}) },
    },
    cliproxy: status ?? emptyCliproxyStatus(),
  };
  for (const agent of ['claude', 'codex']) {
    const provider = next.providers[agent];
    if (!provider || typeof provider !== 'object') continue;
    const account = (status?.accounts ?? []).find((item) => (
      item.agent === agent && (item.session?.percent !== null || item.week?.percent !== null)
    ));
    if (!account || !status?.connected) {
      provider.source = 'estimate';
      continue;
    }
    provider.source = 'cliproxy';
    if (provider.session) {
      provider.session = { ...provider.session, percent: account.session.percent, resetsAt: account.session.resetsAt };
    }
    if (provider.week) {
      provider.week = { ...provider.week, percent: account.week.percent, resetsAt: account.week.resetsAt };
    }
    if (account.session?.percent !== null || account.week?.percent !== null) {
      provider.updatedAt = status.checkedAt ?? provider.updatedAt ?? null;
    }
  }
  return next;
}

function httpErrorMessage(status, bodyText) {
  if (status === 401 || status === 403) return '관리 키가 맞지 않아요';
  if (status === 404) return '관리 API가 꺼져 있어요. config.yaml 의 remote-management.secret-key 를 확인하세요';
  const trimmed = String(bodyText ?? '').trim().slice(0, 180);
  return trimmed || `CLIProxyAPI가 HTTP ${status} 를 돌려줬어요`;
}

/**
 * CLIProxyAPI 관리 API 로 공식 요금제 사용량(5시간·주간 %)을 가져온다.
 *
 * @param {{ rootDir: string, now?: () => number, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} opts
 */
export function createCliproxyClient({
  rootDir,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  if (!rootDir) throw new Error('cliproxy rootDir is required');
  const configPath = path.join(rootDir, CLIPROXY_FILE);
  /** @type {{ url: string, key: string, enabled: boolean, source: 'file'|'env' } | null} */
  let config = null;
  /** @type {{ status: ReturnType<typeof emptyCliproxyStatus>, fetchedAt: number } | null} */
  let cache = null;
  let writeChain = Promise.resolve();
  /** @type {Promise<ReturnType<typeof emptyCliproxyStatus>> | null} */
  let inFlight = null;

  async function writeAtomic(file, text) {
    const temp = `${file}.tmp-${process.pid}-${now()}`;
    await fs.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, file);
  }

  function persist(next) {
    writeChain = writeChain.then(async () => {
      await fs.mkdir(rootDir, { recursive: true });
      await writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
    });
    return writeChain;
  }

  async function request(configRef, method, pathname, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = { Accept: 'application/json' };
      if (configRef.key) headers.Authorization = `Bearer ${configRef.key}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetchImpl(`${configRef.url}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await response.text();
      let parsed = null;
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      return { ok: response.ok, status: response.status, parsed, text };
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = new Error('CLIProxyAPI 응답이 너무 느려요');
        timeout.code = 'CLIPROXY_TIMEOUT';
        throw timeout;
      }
      const failed = new Error('CLIProxyAPI에 닿지 못해요. 주소와 실행 상태를 확인하세요');
      failed.code = 'CLIPROXY_UNREACHABLE';
      throw failed;
    } finally {
      clearTimeout(timer);
    }
  }

  async function apiCall(configRef, payload) {
    const result = await request(configRef, 'POST', '/v0/management/api-call', payload);
    if (!result.ok) {
      const error = new Error(httpErrorMessage(result.status, result.text));
      error.code = 'CLIPROXY_HTTP';
      throw error;
    }
    const envelope = asObject(result.parsed) ?? {};
    const statusCode = toFinite(firstValue(envelope.status_code, envelope.statusCode)) ?? 0;
    const body = parseApiCallBody(envelope.body);
    if (statusCode && (statusCode < 200 || statusCode >= 300)) {
      const error = new Error(httpErrorMessage(statusCode, typeof envelope.body === 'string' ? envelope.body : ''));
      error.code = 'CLIPROXY_UPSTREAM';
      throw error;
    }
    if (!body) {
      const error = new Error('사용량 응답이 비어 있어요');
      error.code = 'CLIPROXY_UPSTREAM';
      throw error;
    }
    return body;
  }

  async function queryClaude(configRef, account) {
    if (!account.authIndex) {
      return { ...account, session: emptyWindow(), week: emptyWindow(), error: 'auth_index 가 없어요' };
    }
    try {
      const usage = parseClaudeUsage(await apiCall(configRef, {
        auth_index: account.authIndex,
        method: 'GET',
        url: CLAUDE_USAGE_URL,
        header: {
          Authorization: 'Bearer $TOKEN$',
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
      }));
      return { ...account, ...usage, error: null };
    } catch (error) {
      return { ...account, session: emptyWindow(), week: emptyWindow(), error: error?.message ?? String(error) };
    }
  }

  async function queryCodex(configRef, account) {
    if (!account.authIndex) {
      return { ...account, session: emptyWindow(), week: emptyWindow(), error: 'auth_index 가 없어요' };
    }
    if (!account.accountId) {
      return { ...account, session: emptyWindow(), week: emptyWindow(), error: 'ChatGPT 계정 id 가 없어요' };
    }
    try {
      const usage = parseCodexUsage(await apiCall(configRef, {
        auth_index: account.authIndex,
        method: 'GET',
        url: CODEX_USAGE_URL,
        header: {
          Authorization: 'Bearer $TOKEN$',
          'Content-Type': 'application/json',
          'User-Agent': 'codex_cli_rs/0.76.0',
          'Chatgpt-Account-Id': account.accountId,
        },
      }));
      return {
        ...account,
        session: usage.session,
        week: usage.week,
        planType: usage.planType ?? account.planType,
        error: null,
      };
    } catch (error) {
      return { ...account, session: emptyWindow(), week: emptyWindow(), error: error?.message ?? String(error) };
    }
  }

  async function fetchQuota(configRef) {
    const listed = await request(configRef, 'GET', '/v0/management/auth-files');
    if (!listed.ok) {
      const error = new Error(httpErrorMessage(listed.status, listed.text));
      error.code = listed.status === 401 || listed.status === 403 ? 'CLIPROXY_AUTH' : 'CLIPROXY_HTTP';
      throw error;
    }
    const discovered = summarizeAuthFiles(listed.parsed);
    const selected = ['claude', 'codex']
      .map((agent) => pickAccount(discovered, agent))
      .filter(Boolean);
    const queried = await Promise.all(selected.map((account) => (
      account.agent === 'claude' ? queryClaude(configRef, account) : queryCodex(configRef, account)
    )));
    return {
      configured: true,
      connected: true,
      url: configRef.url,
      error: queried.length === 0 ? 'Claude/Codex 계정이 없어요' : null,
      checkedAt: now(),
      accounts: queried.map(publicAccount),
    };
  }

  function disconnectedStatus(error = null) {
    return {
      ...emptyCliproxyStatus(),
      configured: Boolean(config?.enabled && config.key),
      url: config?.enabled ? config.url : null,
      error,
      checkedAt: now(),
    };
  }

  async function refreshLocked(force) {
    if (!config?.enabled || !config.key) {
      cache = { status: disconnectedStatus(), fetchedAt: now() };
      return cache.status;
    }
    if (!force && cache && cache.status.connected && now() - cache.fetchedAt < QUOTA_CACHE_MS) {
      return cache.status;
    }
    try {
      const status = await fetchQuota(config);
      cache = { status, fetchedAt: now() };
      return status;
    } catch (error) {
      const status = disconnectedStatus(error?.message ?? String(error));
      cache = { status, fetchedAt: now() };
      return status;
    }
  }

  return {
    configPath,

    async init() {
      await fs.mkdir(rootDir, { recursive: true });
      try {
        config = readConfigObject(JSON.parse(await fs.readFile(configPath, 'utf8')));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        config = null;
      }
      if (!config) {
        try {
          config = cliproxyConfigFromEnv(env);
        } catch (error) {
          cache = { status: disconnectedStatus(error?.message ?? String(error)), fetchedAt: now() };
          config = null;
        }
      }
      return this;
    },

    configured() {
      return Boolean(config?.enabled && config.key);
    },

    status() {
      if (cache) return cache.status;
      return disconnectedStatus();
    },

    async connect({ url, key } = {}) {
      const next = {
        url: normalizeCliproxyUrl(url || DEFAULT_CLIPROXY_URL),
        key: String(key ?? '').trim(),
        enabled: true,
        source: 'file',
      };
      if (!next.key) {
        const error = new Error('관리 키가 필요해요');
        error.code = 'INVALID_CLIPROXY_KEY';
        throw error;
      }
      const status = await fetchQuota(next);
      config = next;
      cache = { status, fetchedAt: now() };
      await persist({ url: next.url, key: next.key, enabled: true });
      return status;
    },

    async disconnect() {
      config = { url: DEFAULT_CLIPROXY_URL, key: '', enabled: false, source: 'file' };
      cache = { status: emptyCliproxyStatus(), fetchedAt: now() };
      await persist({ url: DEFAULT_CLIPROXY_URL, key: '', enabled: false });
      return cache.status;
    },

    refresh(force = false) {
      if (inFlight) return inFlight;
      inFlight = refreshLocked(force).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    applyToSummary(summary) {
      return applyCliproxyToSummary(summary, this.status());
    },
  };
}
