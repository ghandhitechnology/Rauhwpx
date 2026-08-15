import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export function bundledNpmLaunch({ nodeCommand = process.execPath, npmCommand = null } = {}) {
  if (npmCommand) return { command: npmCommand, leadingArgs: [] };
  const packageJson = require.resolve('npm/package.json');
  return {
    command: nodeCommand,
    leadingArgs: [path.join(path.dirname(packageJson), 'bin', 'npm-cli.js')],
  };
}

