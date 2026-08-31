import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ALIVE_PI_FIXTURE_SOURCE, writeFakeCliBin } from './fake-cli-bin.mjs';

test('fake CLI fixtures stay valid JS and never embed cmd caret-arrow node -e', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-fake-cli-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { binPath, fixturePath } = writeFakeCliBin(root, 'pi', ALIVE_PI_FIXTURE_SOURCE);
  const fixture = readFileSync(fixturePath, 'utf8');
  const wrapper = readFileSync(binPath, 'utf8');

  assert.equal(fixture.includes('=^>'), false);
  assert.equal(wrapper.includes('node -e'), false);
  assert.match(wrapper, process.platform === 'win32' ? /\.cmd|%\*/ : /exec /);
  const checked = spawn(process.execPath, ['--check', fixturePath], { stdio: 'ignore' });
  const checkCode = await new Promise((resolve) => checked.once('exit', resolve));
  assert.equal(checkCode, 0);

  const child = spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, stdout);
  assert.match(stdout.trim(), /^0\.0\.0-test$/);
});
