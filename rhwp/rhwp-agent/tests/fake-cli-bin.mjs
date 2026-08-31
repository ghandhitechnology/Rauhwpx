import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Write a Windows `.cmd` that cross-spawn will run as Node, not cmd.exe.
 *
 * Batch shims go through `cmd.exe /c`, which caps the command line at 8191
 * characters. Pi's `--append-system-prompt` brief is ~5k characters and
 * caret-escaping pushes that over the limit, so the fake provider never
 * starts. A shebang `.cmd` makes cross-spawn spawn `node.exe` with an argv
 * array, which is also the live PID Windows can taskkill.
 */
export function writeWindowsCliLauncher(binPath, fixturePath) {
  const interpreter = process.execPath.replace(/\\/g, '/');
  writeFileSync(
    binPath,
    `#!${interpreter}\nrequire(${JSON.stringify(fixturePath)});\n`,
    { mode: 0o755 },
  );
}

/**
 * Write a test CLI shim that Windows cmd.exe can actually execute.
 *
 * A `.cmd` file with `node -e "setInterval(() =^> {}, 1000)"` is a syntax
 * error: caret is not an escape inside cmd quotes, so Node receives `=^>`
 * and the fake provider dies before the hub can start live tree cleanup.
 * Always exec a real JS file with the current Node path instead.
 */
export function writeFakeCliBin(binDir, binName, fixtureSource) {
  mkdirSync(binDir, { recursive: true });
  const fixturePath = path.join(binDir, `${binName}-fixture.cjs`);
  const binPath = path.join(binDir, process.platform === 'win32' ? `${binName}.cmd` : binName);
  writeFileSync(fixturePath, fixtureSource);
  if (process.platform === 'win32') {
    writeWindowsCliLauncher(binPath, fixturePath);
  } else {
    writeFileSync(
      binPath,
      `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  return { binPath, fixturePath };
}

export const ALIVE_PI_FIXTURE_SOURCE = [
  "if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }",
  'setInterval(() => {}, 1000);',
].join('\n');
