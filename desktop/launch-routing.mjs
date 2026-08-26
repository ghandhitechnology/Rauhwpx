import { extname, isAbsolute, resolve } from 'node:path';

export const DOCUMENT_EXTENSIONS = new Set(['.hwp', '.hwpx', '.hml', '.rhwpx']);

export function documentPathsFromArgv(argv, { cwd = process.cwd() } = {}) {
  const paths = [];
  const seen = new Set();
  for (const value of argv ?? []) {
    if (typeof value !== 'string' || value.startsWith('-')) continue;
    const candidate = value.replace(/^"|"$/g, '');
    if (!DOCUMENT_EXTENSIONS.has(extname(candidate).toLowerCase())) continue;
    const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    paths.push(absolute);
  }
  return paths;
}

export function launchRequest({ argv = [], openFiles = [], source = 'launch', cwd } = {}) {
  const routed = documentPathsFromArgv([...argv, ...openFiles], { cwd });
  return Object.freeze({ source, openFiles: Object.freeze(routed) });
}
