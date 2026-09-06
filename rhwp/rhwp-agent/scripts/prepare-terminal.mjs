import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// npm can extract the packaged macOS helper without its executable bit.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const relative of [`prebuilds/darwin-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
    const helper = path.join(root, relative);
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
