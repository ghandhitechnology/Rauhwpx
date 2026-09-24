import spawn from 'cross-spawn';
import { CodexJsonRpcConnection } from './agents/codex-app-server.mjs';
import { applyManagedCliLaunch } from './npm-cli-launch.mjs';
import { isolatedProcessEnv, processTreeSpawnOptions } from './process-tree.mjs';

const LINEUPS = new Set(['astra', 'sol', 'luna', 'terra']);
const FALLBACK_MODELS = {
  astra: 'gpt-6-astra',
  sol: 'gpt-6-sol',
  luna: 'gpt-6-luna',
  terra: 'gpt-5.6-terra',
};
const CACHE_MS = 5 * 60 * 1000;
const FAILURE_CACHE_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 4_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function codexLineup(model) {
  if (LINEUPS.has(model)) return model;
  const match = /^gpt-\d+(?:\.\d+)*-(astra|sol|luna|terra)$/.exec(model ?? '');
  return match?.[1] ?? null;
}

function modelVersion(id, lineup) {
  const match = /^gpt-(\d+(?:\.\d+)*)-(astra|sol|luna|terra)$/.exec(id ?? '');
  if (!match || match[2] !== lineup) return null;
  return match[1].split('.').map(Number);
}

function compareVersions(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function latestCodexModel(models, lineup) {
  if (!LINEUPS.has(lineup)) return null;
  let best = null;
  let bestVersion = null;
  for (const entry of models) {
    if (entry?.hidden === true) continue;
    const id = entry?.model ?? entry?.id;
    const version = modelVersion(id, lineup);
    if (version && (!bestVersion || compareVersions(version, bestVersion) > 0)) {
      best = id;
      bestVersion = version;
    }
  }
  return best;
}

/** Read the account's visible models from the same managed CLI used for chat. */
export async function discoverCodexModels({
  bin = 'codex', env = process.env, isolatedHome, codexHome, cwd = process.cwd(),
  spawnProcess = spawn, platform = process.platform, nodeCommand = process.execPath,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const probeEnv = {
    ...isolatedProcessEnv({ isolatedHome }, env),
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
  };
  for (const key of [
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
    'BROWSERBASE_API_KEY', 'RHWP_CLIPROXY_KEY',
  ]) delete probeEnv[key];
  const launched = applyManagedCliLaunch(bin, ['-s', 'read-only', '-a', 'never', 'app-server', '--stdio'], {
    platform, nodeCommand, env: probeEnv,
  });
  const child = spawnProcess(launched.command, launched.argv, {
    ...processTreeSpawnOptions(platform),
    cwd, env: launched.env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const connection = new CodexJsonRpcConnection(child, { onFrame: () => {}, onClosed: () => {} });
  child.stdin.on('error', () => {});
  let timeout;
  try {
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Codex model discovery timed out')), timeoutMs);
    });
    return await Promise.race([deadline, (async () => {
      await connection.request('initialize', {
        clientInfo: { name: 'rhwp_model_catalog', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      }, { timeoutMs: REQUEST_TIMEOUT_MS });
      connection.notify('initialized');
      const models = [];
      const cursors = new Set();
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await connection.request('model/list', {
          includeHidden: false,
          limit: PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        }, { timeoutMs: REQUEST_TIMEOUT_MS });
        if (!Array.isArray(result?.data)) throw new Error('Invalid Codex model catalog');
        models.push(...result.data);
        cursor = result.nextCursor ?? null;
        if (!cursor) return models;
        if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('Invalid Codex model cursor');
        cursors.add(cursor);
      }
      throw new Error('Codex model catalog exceeded page limit');
    })()]);
  } finally {
    clearTimeout(timeout);
    const cleaned = await connection.close(new Error('Codex model discovery finished'), {
      terminate: true, graceMs: 500,
    });
    if (!cleaned) throw new Error('Codex model discovery process cleanup failed');
  }
}

export function normalizeCodexModels(models) {
  const seen = new Set();
  const catalog = [];
  for (const entry of models) {
    const id = entry?.model ?? entry?.id;
    if (entry?.hidden === true || typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    catalog.push({
      id,
      label: typeof entry.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName : id,
      ...(typeof entry.description === 'string' && entry.description.trim()
        ? { description: entry.description.trim() } : {}),
      ...(Array.isArray(entry.supportedReasoningEfforts)
        ? { supportedEfforts: entry.supportedReasoningEfforts
          .map((effort) => effort?.reasoningEffort)
          .filter((effort) => CODEX_EFFORTS.has(effort)) } : {}),
    });
  }
  return catalog;
}

export function createCodexModelCatalog({ discover = discoverCodexModels, now = Date.now } = {}) {
  const cache = new Map();
  return async function codexModelCatalog(options = {}, { refresh = false } = {}) {
    const key = `${options.bin ?? 'codex'}\0${options.codexHome ?? ''}`;
    let entry = cache.get(key);
    if (refresh || !entry || entry.expiresAt <= now()) {
      const pending = Promise.resolve().then(() => discover(options)).then((models) => {
        const catalog = normalizeCodexModels(models);
        if (!catalog.length) throw new Error('Codex returned an empty model catalog');
        return catalog;
      });
      entry = { pending, expiresAt: Number.POSITIVE_INFINITY };
      cache.set(key, entry);
      pending.then(
        (models) => { if (cache.get(key) === entry) cache.set(key, { models, expiresAt: now() + CACHE_MS }); },
        () => { if (cache.get(key) === entry) cache.delete(key); },
      );
    }
    return entry.pending ?? entry.models;
  };
}

export function createCodexModelResolver({ discover = discoverCodexModels, now = Date.now } = {}) {
  const cache = new Map();
  return async function resolveCodexModel(lineup, options = {}) {
    if (!LINEUPS.has(lineup)) throw new Error(`Unknown Codex lineup: ${String(lineup)}`);
    const key = `${options.bin ?? 'codex'}\0${options.codexHome ?? ''}`;
    let cached = cache.get(key);
    if (!cached || cached.expiresAt <= now()) {
      const pending = Promise.resolve().then(() => discover(options)).then(
        (models) => ({ models, failed: false, expiresAt: now() + CACHE_MS }),
        () => ({ models: null, failed: true, expiresAt: now() + FAILURE_CACHE_MS }),
      );
      cached = { pending, expiresAt: Number.POSITIVE_INFINITY };
      cache.set(key, cached);
      pending.then((result) => { if (cache.get(key) === cached) cache.set(key, result); });
    }
    const result = cached.pending ? await cached.pending : cached;
    if (result.failed) return FALLBACK_MODELS[lineup];
    const model = latestCodexModel(result.models, lineup);
    if (!model) {
      throw Object.assign(new Error(`No available Codex model for the ${lineup} lineup`), {
        code: 'MODEL_UNAVAILABLE',
      });
    }
    return model;
  };
}
