import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
    writeFileSync(binPath, `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`);
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
