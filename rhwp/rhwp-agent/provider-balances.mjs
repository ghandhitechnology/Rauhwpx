import { readUtf8FileBounded } from './bounded-file.mjs';
import { createHash } from 'node:crypto';

const empty = (error = null) => ({ status: 'unavailable', balanceUsd: null, totalCreditsUsd: null, totalUsageUsd: null, updatedAt: null, source: null, error });
const number = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
const cents = (value) => value && typeof value === 'object' ? number(value.val ?? 0) === null ? null : number(value.val ?? 0) / 100 : null;
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const window = (label, percent, reset) => { const used = number(percent); return used === null ? null : { label, remainingPercent: Math.max(0, Math.min(100, 100 - used)), resetsAt: timestamp(reset) }; };
async function readAuth(path) {
  if (!path) return {};
  try {
    const data = JSON.parse(await readUtf8FileBounded(path, { maxBytes: 1024 * 1024, label: 'Provider auth' }));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

// Provider-owned remote billing only. OpenCode's public key API exposes Go
// windows, but its Zen credit wallet currently requires a console session.
export function createProviderBalancesClient({ getGrokAuthPath = () => null, getOpenCodeAuthPath = () => null, getProviderEnv = () => ({}), fetchImpl = fetch, now = Date.now, timeoutMs = 15000 } = {}) {
  const values = { grok: empty(), opencode: empty() };
  const identities = {};
  const checked = {};
  const pending = {};
  let generation = 0;
  const fingerprint = (auth) => createHash('sha256').update(JSON.stringify(auth)).digest('hex');
  async function credentials(provider) {
    const env = await getProviderEnv(provider) ?? {};
    if (provider === 'grok') {
      // Match the Grok runtime: an API key takes precedence over saved OAuth.
      if (typeof env.XAI_API_KEY === 'string' && env.XAI_API_KEY.trim()) {
        return env.XAI_MANAGEMENT_API_KEY && env.XAI_TEAM_ID
          ? { kind: 'xai-management', key: env.XAI_MANAGEMENT_API_KEY, team: env.XAI_TEAM_ID }
          : { kind: 'grok-api-unavailable' };
      }
      const auth = await readAuth(await getGrokAuthPath());
      const entries = Object.entries(auth).filter(([scope, entry]) => {
        if (!entry || typeof entry.key !== 'string' || !entry.key.trim() || typeof entry.user_id !== 'string' || entry.auth_mode === 'api_key') return false;
        try { const issuer = new URL(entry.oidc_issuer || scope); return issuer.protocol === 'https:' && (issuer.hostname === 'auth.x.ai' || issuer.hostname === 'accounts.x.ai'); } catch { return false; }
      }).map(([, entry]) => entry);
      const entry = entries.find((entry) => !entry.expires_at || (timestamp(entry.expires_at) ?? 0) > now());
      if (entry) return { kind: 'grok-cli', key: entry.key, user: entry.user_id };
      if (env.XAI_MANAGEMENT_API_KEY && env.XAI_TEAM_ID) return { kind: 'xai-management', key: env.XAI_MANAGEMENT_API_KEY, team: env.XAI_TEAM_ID };
      return entries.length ? { kind: 'grok-expired' } : null;
    }
    const auth = await readAuth(await getOpenCodeAuthPath());
    const entry = auth['opencode-go'] ?? auth.opencode;
    const key = env.OPENCODE_API_KEY || (entry?.type === 'api' ? entry.key : null);
    return typeof key === 'string' && key.trim() ? { kind: 'opencode-go', key } : null;
  }
  async function request(url, headers) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); });
    try { return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw Object.assign(new Error(response.status === 401 ? '인증이 만료되었어요. 다시 연결해 주세요.' : response.status === 403 ? '이 계정에서 잔액 정보를 조회할 수 없어요.' : '사용량을 조회하지 못했어요. 다시 시도해 주세요.'), { status: response.status });
      if (Number(response.headers?.get?.('content-length')) > 1024 * 1024) throw new Error('사용량 응답을 읽을 수 없어요.');
      let text = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader(); let size = 0; const decoder = new TextDecoder();
        try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw new Error('사용량 응답을 읽을 수 없어요.'); } text += decoder.decode(item.value, { stream: true }); } text += decoder.decode(); } finally { reader.releaseLock(); }
      } else { text = await response.text(); if (text.length > 1024 * 1024) throw new Error('사용량 응답을 읽을 수 없어요.'); }
      return JSON.parse(text);
    })()]); } finally { clearTimeout(timer); }
  }
  async function refreshOne(provider, force) {
    const epoch = generation;
    const auth = await credentials(provider);
    if (epoch !== generation) return;
    const identity = fingerprint(auth);
    if (identities[provider] !== identity) { identities[provider] = identity; values[provider] = empty(); checked[provider] = null; }
    if (!auth) { values[provider] = empty(provider === 'grok' ? 'Grok 로그인 또는 xAI 관리 키가 필요해요.' : 'OpenCode Go API 키를 연결해 주세요.'); return; }
    if (auth.kind === 'grok-api-unavailable') { values[provider] = empty('API 잔액 조회에는 xAI 관리 키와 팀 ID가 필요해요.'); return; }
    if (auth.kind === 'grok-expired') { values[provider] = empty('Grok 로그인이 만료되었어요. 연결 설정에서 다시 로그인해 주세요.'); return; }
    if (pending[provider]?.identity === identity) return pending[provider].promise;
    if (!force && checked[provider] !== null && checked[provider] !== undefined && now() - checked[provider] < 60000) return;
    async function stillCurrent() {
      if (epoch !== generation || identities[provider] !== identity) return false;
      const current = fingerprint(await credentials(provider));
      if (epoch !== generation || identities[provider] !== identity) return false;
      if (current !== identity) { identities[provider] = current; values[provider] = empty(); checked[provider] = null; return false; }
      return true;
    }
    const promise = (async () => {
      try {
        const headers = { Authorization: `Bearer ${auth.key}`, Accept: 'application/json' };
        let result = { ...empty(), status: 'ok', updatedAt: now(), source: { 'grok-cli': 'Grok 크레딧', 'xai-management': 'xAI API 크레딧', 'opencode-go': 'OpenCode Go' }[auth.kind] };
        if (auth.kind === 'grok-cli') {
          const data = await request('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { ...headers, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-userid': auth.user, 'x-grok-client-version': '1.0.13' });
          const config = data.config;
          if (!config || typeof config !== 'object') throw new Error('invalid');
          result.balanceUsd = cents(config.prepaidBalance);
          const limit = cents(config.monthlyLimit), used = cents(config.used);
          const percent = config.creditUsagePercent ?? (limit > 0 && used !== null ? used / limit * 100 : null);
          const label = config.currentPeriod?.type?.includes('WEEKLY') ? '주간 한도' : config.currentPeriod?.type?.includes('MONTHLY') || config.monthlyLimit ? '월간 한도' : '사용 한도';
          result.windows = [window(label, percent, config.currentPeriod?.end ?? config.billingPeriodEnd)].filter(Boolean);
          if (result.balanceUsd === null && !result.windows.length) result = { ...result, status: 'unavailable', error: '계정에서 잔액과 한도 정보를 제공하지 않아요.' };
        } else if (auth.kind === 'xai-management') {
          const data = await request(`https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(auth.team)}/prepaid/balance`, headers);
          const balance = cents(data.total);
          if (balance === null) throw new Error('invalid');
          // Management ledger credits are negative amounts (unlike Grok CLI).
          result.balanceUsd = -balance;
        } else {
          const data = await request('https://opencode.ai/zen/go/v1/usage', headers);
          if (!data.usage || typeof data.usage !== 'object') throw new Error('invalid');
          result.windows = [['rolling', '5시간'], ['weekly', '주간 한도'], ['monthly', '월간 한도']].map(([key, label]) => window(label, data.usage[key]?.percent, data.usage[key]?.resetsAt)).filter(Boolean);
          if (!result.windows.length) throw new Error('invalid');
        }
        if (await stillCurrent()) values[provider] = result;
      } catch (error) {
        if (!(await stillCurrent())) return;
        if (provider === 'opencode' && error?.status === 403) { values[provider] = empty('OpenCode Go 구독이 필요해요. Zen 잔액은 웹 콘솔에서 확인해 주세요.'); return; }
        values[provider] = { ...values[provider], status: 'error', error: ['인증이 만료되었어요. 다시 연결해 주세요.', '이 계정에서 잔액 정보를 조회할 수 없어요.', '사용량을 조회하지 못했어요. 다시 시도해 주세요.', '사용량 응답을 읽을 수 없어요.'].includes(error?.message) ? error.message : '사용량을 조회하지 못했어요. 다시 시도해 주세요.' };
      } finally { if (epoch === generation && identities[provider] === identity) checked[provider] = now(); }
    })();
    pending[provider] = { identity, promise };
    try { await promise; } finally { if (pending[provider]?.promise === promise) delete pending[provider]; }
  }
  return { invalidate: () => { generation++; for (const provider of ['grok', 'opencode']) { delete identities[provider]; delete checked[provider]; delete pending[provider]; values[provider] = empty(); } }, snapshot: () => structuredClone(values), refresh: async (force = false) => { await Promise.all(['grok', 'opencode'].map((provider) => refreshOne(provider, force))); return structuredClone(values); } };
}
