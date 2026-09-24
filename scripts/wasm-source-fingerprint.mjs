import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// These apps consume the engine; none is a Rust build input. Everything else,
// including new engine directories and embedded assets, invalidates the cache.
const consumers = new Set([
  'rau-credits', 'rhwp-agent', 'rhwp-chrome', 'rhwp-firefox',
  'rhwp-safari', 'rhwp-shared', 'rhwp-studio', 'rhwp-vscode',
]);
const tree = execFileSync('git', ['ls-tree', '-z', 'HEAD:rhwp'], { encoding: 'utf8' });
const digest = createHash('sha256');
for (const entry of tree.split('\0')) {
  if (entry && !consumers.has(entry.slice(entry.indexOf('\t') + 1))) {
    digest.update(entry + '\0');
  }
}
console.log(digest.digest('hex'));
