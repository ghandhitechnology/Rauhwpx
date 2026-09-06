import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import spawn from 'cross-spawn';
import { readUtf8FileBounded } from './bounded-file.mjs';
import { recoverInterruptedFileReplacement, replaceFileAtomically } from './harness-update.mjs';
import { cancelResponseBody, readResponseJsonBounded } from './response-bounds.mjs';

const MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT = 10_000;
const CODEX_API = 'https://chatgpt.com/backend-api/wham';
const OUTCOMES = { reset: 'reset', nothing_to_reset: 'nothingToReset', no_credit: 'noCredit', already_redeemed: 'alreadyRedeemed' };
const runFile = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const blankWindow = () => ({ percent: null, resetsAt: null });
const blankQuota = () => ({ status: 'unavailable', session: blankWindow(), week: blankWindow(), updatedAt: null, error: null, accountKey: null, planType: null, resetCredits: null });
const failure = (code, message) => Object.assign(new Error(message), { code });

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  const result = Number.isFinite(number) ? (number < 1e10 ? number * 1000 : number) : Date.parse(value);
  return Number.isFinite(result) && result > 0 && result < 8.64e15 ? result : null;
}

function windowQuota(value, camel = false) {
  const percent = camel ? value?.usedPercent : value?.utilization ?? value?.used_percent ?? value?.used_percentage;
  if (!Number.isFinite(percent)) return blankWindow();
  return { percent: Math.min(100, Math.max(0, percent)), resetsAt: timestamp(camel ? value.resetsAt : value.resets_at ?? value.reset_at) };
}

function codexWindows(primary, secondary, camel = false) {
  const result = { session: blankWindow(), week: blankWindow() };
  for (const [index, value] of [primary, secondary].entries()) {
    if (!value) continue;
    const minutes = camel ? value.windowDurationMins : value.limit_window_seconds / 60;
    const key = Math.abs(minutes - 10080) <= 1 ? 'week'
      : Math.abs(minutes - 300) <= 1 ? 'session' : index === 0 ? 'session' : 'week';
    if (result[key].percent === null) result[key] = windowQuota(value, camel);
  }
  return result;
}

function resetCredits(value) {
  if (!value || typeof value !== 'object') return null;
  const credits = Array.isArray(value.credits) ? value.credits.filter((credit) => credit?.status?.toLowerCase() === 'available') : null;
  const count = value.availableCount ?? value.available_count ?? credits?.length;
  if (!Number.isFinite(count) || count < 0) return null;
  const expirations = credits?.map((credit) => timestamp(credit.expiresAt ?? credit.expires_at)).filter((date) => date !== null) ?? [];
  return {
    availableCount: Math.floor(count),
    nextExpiresAt: timestamp(value.nextExpiresAt ?? value.next_expires_at) ?? (expirations.length ? Math.min(...expirations) : null),
  };
}

function tokenIdentity(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims.sub || null;
  } catch { return null; }
}

async function readJson(file) {
  try {
    return JSON.parse(await readUtf8FileBounded(file, { maxBytes: MAX_BYTES, label: 'Provider credentials' }));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('PROVIDER_CREDENTIALS_UNREADABLE', 'Provider credentials could not be read. Sign in again.');
  }
}

async function readKeychain(service) {
  try {
    const { stdout } = await runFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
      timeout: 3000, maxBuffer: MAX_BYTES, encoding: 'utf8', windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch { return null; }
}

/** One short-lived app-server; no thread or model request is created. */
export function readCodexRateLimits({ bin = 'codex', env = process.env, homeDir = os.homedir(), timeoutMs = REQUEST_TIMEOUT, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let done = false;
    let buffer = '';
    let total = 0;
    const timer = setTimeout(() => finish(failure('PROVIDER_TIMEOUT', 'Codex usage request timed out.')), timeoutMs);
    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child?.stdin?.end();
      child?.kill();
      if (child && child.exitCode === null) {
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        killTimer.unref();
        child.once('close', () => clearTimeout(killTimer));
      }
      if (error) reject(error); else resolve(result);
    }
    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    try {
      const codexEnv = { ...env };
      for (const key of [
        'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
        'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
        'OPENROUTER_API_KEY', 'CURSOR_API_KEY', 'BROWSERBASE_API_KEY', 'RHWP_CLIPROXY_KEY',
      ]) delete codexEnv[key];
      child = spawnProcess(bin, ['-s', 'read-only', '-a', 'never', 'app-server'], {
        env: codexEnv, cwd: homeDir, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
      child.on('error', () => finish(failure('CODEX_RPC_UNAVAILABLE', 'Codex usage service is unavailable.')));
      child.on('close', () => finish(failure('CODEX_RPC_UNAVAILABLE', 'Codex usage service stopped before responding.')));
      child.stdin.on('error', () => finish(failure('CODEX_RPC_UNAVAILABLE', 'Codex usage service is unavailable.')));
      child.stdout.on('data', (chunk) => {
        if (done) return;
        total += chunk.length;
        if (total > MAX_BYTES) return finish(failure('PROVIDER_INVALID_RESPONSE', 'Codex usage response was too large.'));
        buffer += chunk.toString();
        let newline;
        while (!done && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id !== 1 && message.id !== 2) continue;
          if (message.error) return finish(failure('CODEX_RPC_UNAVAILABLE', 'Codex could not read usage. Sign in again or refresh.'));
          if (message.id === 1) {
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/rateLimits/read', params: null });
          } else finish(null, message.result);
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'rhwp_usage', version: '1.0.0' } } });
    } catch { finish(failure('CODEX_RPC_UNAVAILABLE', 'Codex usage service is unavailable.')); }
  });
}

/**
 * Subscription usage comes directly from the active local CLI account. Dependencies
 * are injectable so tests never read a real login or redeem a real reset.
 */
export function createProviderLimitsClient({
  env = process.env,
  platform = process.platform,
  homeDir = platform === 'win32' && env.USERPROFILE ? env.USERPROFILE : os.homedir(),
  getProviderEnv = () => env,
  getAuthMethod = () => null,
  getCodexBin = () => 'codex',
  readCredentials = readJson,
  keychainRead = readKeychain,
  codexRpc = readCodexRateLimits,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheMs = 30_000,
  timeoutMs = REQUEST_TIMEOUT,
  resetLedgerPath = path.join(homeDir, '.rhwp-provider-resets.json'),
} = {}) {
  let state = { claude: blankQuota(), codex: blankQuota() };
  let refreshing = null;
  let lastAttempt = null;
  let generation = 0;
  let resetQueue = Promise.resolve();
  let ledger = null;
  const snapshot = () => structuredClone(state);

  async function credentials(provider) {
    const providerEnv = getProviderEnv(provider);
    const method = await getAuthMethod(provider);
    if (method === 'api-key') return null;
    if (provider === 'codex') {
      const homes = [...new Set([providerEnv.CODEX_HOME, path.join(homeDir, '.codex')].filter(Boolean).map((home) => path.resolve(home)))];
      for (const home of homes) {
        const raw = await readCredentials(path.join(home, 'auth.json'));
        if (!raw) continue;
        const token = raw.tokens?.access_token;
        if (raw.auth_mode === 'apikey' || typeof token !== 'string' || !token) return null;
        const accountId = typeof raw.tokens.account_id === 'string' ? raw.tokens.account_id : null;
        return { token, accountId, home, env: providerEnv, accountKey: hash(`codex:${accountId ?? ''}:${tokenIdentity(token) ?? (accountId ? '' : token)}`) };
      }
      return null;
    }
    const configDir = providerEnv.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
    let raw = null;
    if (providerEnv.CLAUDE_CODE_OAUTH_TOKEN) raw = { claudeAiOauth: { accessToken: providerEnv.CLAUDE_CODE_OAUTH_TOKEN } };
    if (!raw && platform === 'darwin') {
      if (providerEnv.CLAUDE_CONFIG_DIR) raw = await keychainRead(`Claude Code-credentials-${hash(path.resolve(configDir)).slice(0, 8)}`);
      else raw = await keychainRead('Claude Code-credentials');
    }
    raw ??= await readCredentials(path.join(configDir, '.credentials.json'));
    const oauth = raw?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== 'string' || !token) return null;
    return { token, accountKey: hash(`claude:${oauth.accountUuid ?? tokenIdentity(token) ?? token}`), planType: oauth.subscriptionType ?? null };
  }

  async function request(url, auth, init = {}) {
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { ...auth, ...init.headers } });
      if (!response.ok) {
        await cancelResponseBody(response);
        throw failure(response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH_REQUIRED' : 'PROVIDER_REQUEST_FAILED',
          response.status === 401 || response.status === 403 ? 'Sign in again to refresh usage.' : `Usage request failed (HTTP ${response.status}). Try refreshing.`);
      }
      return await readResponseJsonBounded(response, { maxBytes: MAX_BYTES, label: 'Provider usage' });
    } catch (error) {
      if (error.code === 'RESPONSE_BODY_TOO_LARGE') throw failure('PROVIDER_INVALID_RESPONSE', 'Provider usage response was too large.');
      if (error.code?.startsWith('PROVIDER_')) throw error;
      throw failure('PROVIDER_REQUEST_FAILED', 'Could not refresh provider usage. Try again.');
    }
  }

  const codexHeaders = (auth) => ({ Authorization: `Bearer ${auth.token}`, 'User-Agent': 'codex-cli', 'OpenAI-Beta': 'codex-1',
    ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}) });

  async function loadProvider(provider) {
    let auth;
    try {
      auth = await credentials(provider);
      if (!auth) return blankQuota();
      let result;
      if (provider === 'claude') {
        const readUsage = () => request('https://api.anthropic.com/api/oauth/usage', {
          Authorization: `Bearer ${auth.token}`, 'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01', 'User-Agent': 'claude-code/2.1.0',
        });
        let body;
        try { body = await readUsage(); } catch (error) {
          if (error.code !== 'PROVIDER_AUTH_REQUIRED') throw error;
          // An active Claude CLI can rotate its token between the keychain read
          // and the request. Re-read once without rotating its refresh token.
          const renewed = await credentials('claude');
          if (!renewed || renewed.token === auth.token) throw error;
          auth = renewed;
          body = await readUsage();
        }
        result = { session: windowQuota(body.five_hour), week: windowQuota(body.seven_day), planType: auth.planType, resetCredits: null };
      } else {
        let rpc = null;
        try { rpc = await codexRpc({ bin: getCodexBin(), env: { ...auth.env, CODEX_HOME: auth.home }, homeDir, timeoutMs }); } catch {}
        // app-server may refresh tokens or observe a login change. Pin HTTP
        // supplement and cache identity to the credentials actually on disk now.
        const afterRpc = await credentials('codex');
        if (!afterRpc || afterRpc.accountKey !== auth.accountKey) {
          auth = afterRpc;
          throw failure('PROVIDER_ACCOUNT_CHANGED', 'Provider account changed. Refresh usage again.');
        }
        auth = afterRpc;
        const windows = codexWindows(rpc?.rateLimits?.primary, rpc?.rateLimits?.secondary, true);
        result = { ...windows, planType: rpc?.rateLimits?.planType ?? null, resetCredits: resetCredits(rpc?.rateLimitResetCredits) };
        if (result.session.percent === null || result.week.percent === null) {
          try {
            const body = await request(`${CODEX_API}/usage`, codexHeaders(auth));
            const httpWindows = codexWindows(body.rate_limit?.primary_window, body.rate_limit?.secondary_window);
            for (const key of ['session', 'week']) if (result[key].percent === null) result[key] = httpWindows[key];
            result.planType = body.plan_type ?? result.planType;
            result.resetCredits = resetCredits(body.rate_limit_reset_credits) ?? result.resetCredits;
          } catch (error) { if (result.session.percent === null && result.week.percent === null) throw error; }
        }
        if (!result.resetCredits || (result.resetCredits.availableCount > 0 && result.resetCredits.nextExpiresAt === null)) {
          try { result.resetCredits = resetCredits(await request(`${CODEX_API}/rate-limit-reset-credits`, codexHeaders(auth))) ?? result.resetCredits; } catch {}
        }
      }
      if (result.session.percent === null && result.week.percent === null) throw failure('PROVIDER_INVALID_RESPONSE', 'This account does not report subscription usage limits.');
      const activeAuth = await credentials(provider);
      if (!activeAuth || activeAuth.accountKey !== auth.accountKey) {
        auth = activeAuth;
        throw failure('PROVIDER_ACCOUNT_CHANGED', 'Provider account changed. Refresh usage again.');
      }
      return { ...result, planType: typeof result.planType === 'string' ? result.planType.slice(0, 64) : null,
        status: 'ok', accountKey: auth.accountKey, updatedAt: now(), error: null };
    } catch (error) {
      const previous = auth && auth.accountKey === state[provider].accountKey ? state[provider] : blankQuota();
      return { ...previous, status: 'error', accountKey: auth?.accountKey ?? null,
        error: error.code?.startsWith('PROVIDER_') ? error.message : 'Could not refresh provider usage. Try again.' };
    }
  }

  function refresh(force = false) {
    if (refreshing) return refreshing;
    if (!force && lastAttempt !== null && now() - lastAttempt < cacheMs) return Promise.resolve(snapshot());
    lastAttempt = now();
    const currentGeneration = generation;
    const running = Promise.all([loadProvider('claude'), loadProvider('codex')]).then(([claude, codex]) => {
      if (currentGeneration === generation) state = { claude, codex };
      return snapshot();
    }).finally(() => { if (refreshing === running) refreshing = null; });
    refreshing = running;
    return refreshing;
  }

  function invalidate() {
    generation++;
    state = { claude: blankQuota(), codex: blankQuota() };
    lastAttempt = null;
    refreshing = null;
  }

  async function loadLedger() {
    if (ledger) return;
    if (!resetLedgerPath) { ledger = []; return; }
    try {
      await recoverInterruptedFileReplacement(resetLedgerPath, { platform });
      const parsed = JSON.parse(await readUtf8FileBounded(resetLedgerPath, { maxBytes: MAX_BYTES, label: 'Reset history' }));
      if (parsed.version !== 1 || !Array.isArray(parsed.attempts) || parsed.attempts.length > 1000
        || parsed.attempts.some((item) => !/^[a-f0-9]{64}$/.test(item.accountKey) || !/^[a-zA-Z0-9-]{16,128}$/.test(item.idempotencyKey)
          || (item.aliases !== undefined && (!Array.isArray(item.aliases) || item.aliases.length > 16 || item.aliases.some((key) => !/^[a-zA-Z0-9-]{16,128}$/.test(key))))
          || (item.outcome !== null && !Object.values(OUTCOMES).includes(item.outcome)))) throw new Error();
      const keys = new Set();
      const pendingAccounts = new Set();
      for (const attempt of parsed.attempts) {
        for (const key of [attempt.idempotencyKey, ...(attempt.aliases ?? [])]) {
          if (keys.has(key)) throw new Error();
          keys.add(key);
        }
        if (attempt.outcome === null) {
          if (pendingAccounts.has(attempt.accountKey)) throw new Error();
          pendingAccounts.add(attempt.accountKey);
        }
      }
      ledger = parsed.attempts;
    } catch (error) {
      if (error.code === 'ENOENT') ledger = [];
      else throw failure('PROVIDER_RESET_HISTORY_UNAVAILABLE', 'Reset history could not be read. Restart the app before trying again.');
    }
  }

  async function saveLedger() {
    if (!resetLedgerPath) return;
    const temporary = `${resetLedgerPath}.${randomUUID()}.tmp`;
    try {
      const body = JSON.stringify({ version: 1, attempts: ledger });
      if (Buffer.byteLength(body) > MAX_BYTES) throw new Error();
      await fs.mkdir(path.dirname(resetLedgerPath), { recursive: true, mode: 0o700 });
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      await replaceFileAtomically(temporary, resetLedgerPath, { platform });
    } catch {
      throw failure('PROVIDER_RESET_HISTORY_UNAVAILABLE', 'Reset history could not be saved. Try again.');
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  async function consume({ idempotencyKey, accountKey } = {}) {
    if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(idempotencyKey)
      || typeof accountKey !== 'string' || !/^[a-f0-9]{64}$/.test(accountKey)) throw failure('PROVIDER_RESET_INVALID', 'Refresh usage before using a banked reset.');
    const auth = await credentials('codex').catch(() => null);
    if (!auth || auth.accountKey !== accountKey || state.codex.accountKey !== accountKey) throw failure('PROVIDER_ACCOUNT_CHANGED', 'Codex account changed. Refresh usage before using a reset.');
    await loadLedger();
    let attempt = ledger.find((item) => item.idempotencyKey === idempotencyKey || item.aliases?.includes(idempotencyKey));
    if (attempt && attempt.accountKey !== accountKey) throw failure('PROVIDER_RESET_INVALID', 'This reset request belongs to another account.');
    if (attempt?.outcome) return { outcome: attempt.outcome, limits: snapshot() };
    const pending = ledger.find((item) => item.accountKey === accountKey && item.outcome === null);
    if (!attempt && pending) {
      // Recover after renderer storage loss by replaying the durable original
      // key. Remember the replacement key as an alias so its retry cannot spend
      // another credit after this recovery settles.
      if ((pending.aliases?.length ?? 0) >= 16) throw failure('PROVIDER_RESET_PENDING', 'A reset is still awaiting confirmation. Retry the original reset request.');
      attempt = pending;
      attempt.aliases = [...(attempt.aliases ?? []), idempotencyKey];
    }
    if (!attempt) {
      if (state.codex.status !== 'ok' || !state.codex.resetCredits || state.codex.resetCredits.availableCount < 1) throw failure('PROVIDER_RESET_UNAVAILABLE', 'Refresh usage to check available banked resets.');
      if (ledger.length >= 1000) throw failure('PROVIDER_RESET_HISTORY_UNAVAILABLE', 'Reset history is full.');
      attempt = { accountKey, idempotencyKey, outcome: null };
      ledger.push(attempt);
    }
    // Persist the key before any irreversible request. An ambiguous failure can
    // only be retried with this key, including after a hub restart.
    await saveLedger();
    const activeAuth = await credentials('codex');
    if (!activeAuth || activeAuth.accountKey !== accountKey) throw failure('PROVIDER_ACCOUNT_CHANGED', 'Codex account changed. Refresh usage before using a reset.');
    const response = await request(`${CODEX_API}/rate-limit-reset-credits/consume`, codexHeaders(activeAuth), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redeem_request_id: attempt.idempotencyKey }),
    });
    const outcome = typeof response?.code === 'string' && Object.hasOwn(OUTCOMES, response.code) ? OUTCOMES[response.code] : null;
    if (!outcome) throw failure('PROVIDER_RESET_PENDING', 'Reset confirmation was not recognized. Retry the same reset request.');
    attempt.outcome = outcome;
    await saveLedger();
    // A poll started before redemption must settle before the post-reset read.
    if (refreshing) await refreshing;
    return { outcome, limits: await refresh(true) };
  }

  function consumeCodexReset(input) {
    const running = resetQueue.then(() => consume(input)).catch((error) => {
      if (error.code?.startsWith('PROVIDER_')) throw error;
      throw failure('PROVIDER_RESET_FAILED', 'Could not confirm the reset. Try again.');
    });
    resetQueue = running.catch(() => {});
    return running;
  }
  return { snapshot, refresh, invalidate, consumeCodexReset };
}
