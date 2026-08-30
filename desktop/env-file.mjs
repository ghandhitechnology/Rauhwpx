import { existsSync } from 'node:fs';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

const ESCAPES = Object.freeze({ n: '\n', r: '\r', t: '\t' });

function unquote(value) {
  if (value.length < 2) return value;
  const quote = value[0];
  if (quote !== value.at(-1) || (quote !== '"' && quote !== "'")) return value;
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner.replace(/\\(.)/g, (match, char) => ESCAPES[char] ?? char);
}

/** Parses `.env` text into [key, value] entries. Supports comments, `export `, and quoted values. */
export function parseEnvFile(text) {
  const entries = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) continue;
    entries.push([key, unquote(withoutExport.slice(separator + 1).trim())]);
  }
  return entries;
}

/**
 * Applies entries to the target environment object. Keys already present in the
 * environment win (explicit env is never overridden); duplicate keys inside the
 * file follow dotenv semantics where the last line wins.
 */
export function loadEnvFileInto(environment, entries) {
  const applied = new Set();
  for (const [key, value] of entries) {
    if (key in environment && !applied.has(key)) continue;
    environment[key] = value;
    applied.add(key);
  }
  return applied.size;
}

/** Returns the first candidate path that exists, or null. */
export function selectEnvFile(candidates, existsImpl = existsSync) {
  for (const candidate of candidates) {
    if (candidate && existsImpl(candidate)) return candidate;
  }
  return null;
}

export const __test = { unquote };
