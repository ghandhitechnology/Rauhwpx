import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [suite, ...options] = process.argv.slice(2);
if (!['unit', 'browser'].includes(suite)) {
  throw new Error('Usage: node scripts/run-tests.mjs <unit|browser> [node test options]');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const browser = suite === 'browser';
const files = readdirSync(new URL('../tests/', import.meta.url))
  .filter((name) => name.endsWith('.test.ts') && name.endsWith('.browser.test.ts') === browser)
  .sort()
  .map((name) => `tests/${name}`);
if (!browser) {
  files.push(...readdirSync(new URL('../../npm/editor/tests/', import.meta.url))
    .filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `../npm/editor/tests/${name}`));
}
if (!files.length) throw new Error(`No ${suite} tests found`);
const result = spawnSync(process.execPath, ['--test', ...options, ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
