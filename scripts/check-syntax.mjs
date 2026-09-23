#!/usr/bin/env node
// Cross-platform `node --check` over simple `<dir>/<prefix>*.mjs` patterns.
// npm runs scripts through cmd.exe on Windows, which never expands globs.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const files = [];
for (const pattern of process.argv.slice(2)) {
  const directory = path.dirname(pattern);
  const name = path.basename(pattern);
  if (!name.includes('*')) {
    files.push(pattern);
    continue;
  }
  const matcher = new RegExp(`^${name.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const matches = readdirSync(directory).filter((entry) => matcher.test(entry)).sort();
  if (matches.length === 0) {
    console.error(`check-syntax: no files match ${pattern}`);
    process.exit(1);
  }
  files.push(...matches.map((entry) => path.join(directory, entry)));
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
