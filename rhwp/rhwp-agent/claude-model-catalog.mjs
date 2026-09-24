import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const CACHE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 12_000;

/** Ask the managed Claude CLI for the models available to this account. */
export async function discoverClaudeModels({
  bin, env = process.env, cwd = process.cwd(), queryModels = query, timeoutMs = TIMEOUT_MS,
} = {}) {
  const stream = queryModels({
    // An empty input stream opens the SDK control channel without sending a prompt.
    prompt: (async function* () {})(),
    options: {
      cwd, env, settingSources: [], tools: [],
      ...(bin && path.isAbsolute(bin) ? { pathToClaudeCodeExecutable: bin } : {}),
    },
  });
  let timeout;
  try {
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Claude model discovery timed out')), timeoutMs);
    });
    return await Promise.race([stream.supportedModels(), deadline]);
  } finally {
    clearTimeout(timeout);
    stream.close();
  }
}

export function normalizeClaudeModels(models) {
  const seen = new Set();
  const catalog = [];
  for (const entry of [...models].sort((a, b) =>
    Number(a?.value === 'default') - Number(b?.value === 'default'))) {
    if (typeof entry?.value !== 'string' || !entry.value) continue;
    // A full value with a context suffix is a distinct option from its base model.
    const id = entry.value.startsWith('claude-') ? entry.value : entry.resolvedModel ?? entry.value;
    if (!id.startsWith('claude-') || seen.has(id)) continue;
    seen.add(id);
    catalog.push({
      id,
      label: typeof entry.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName : id,
      ...(typeof entry.description === 'string' && entry.description.trim()
        ? { description: entry.description.trim() } : {}),
      ...(Array.isArray(entry.supportedEffortLevels)
        ? { supportedEfforts: entry.supportedEffortLevels.filter((value) =>
          ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) } : {}),
    });
  }
  return catalog;
}

export function createClaudeModelCatalog({ discover = discoverClaudeModels, now = Date.now } = {}) {
  const cache = new Map();
  return async function claudeModelCatalog(options = {}, { refresh = false } = {}) {
    const key = `${options.bin ?? ''}\0${options.env?.CLAUDE_CONFIG_DIR ?? ''}`;
    let entry = cache.get(key);
    if (refresh || !entry || entry.expiresAt <= now()) {
      const pending = Promise.resolve().then(() => discover(options)).then((models) => {
        const catalog = normalizeClaudeModels(models);
        if (!catalog.length) throw new Error('Claude returned an empty model catalog');
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
