import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import spawn from 'cross-spawn';

import {
  ALIVE_PI_FIXTURE_SOURCE,
  writeFakeCliBin,
  writeWindowsCliLauncher,
} from './fake-cli-bin.mjs';

function collectProcess(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('fake CLI fixtures stay valid JS and never embed cmd caret-arrow node -e', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-fake-cli-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { binPath, fixturePath } = writeFakeCliBin(root, 'pi', ALIVE_PI_FIXTURE_SOURCE);
  const fixture = readFileSync(fixturePath, 'utf8');
  const wrapper = readFileSync(binPath, 'utf8');

  assert.equal(fixture.includes('=^>'), false);
  assert.equal(wrapper.includes('node -e'), false);
  assert.match(wrapper, process.platform === 'win32' ? /^#!/ : /exec /);
  const checked = nodeSpawn(process.execPath, ['--check', fixturePath], { stdio: 'ignore' });
  const checkCode = await new Promise((resolve) => checked.once('exit', resolve));
  assert.equal(checkCode, 0);

  const { code, stdout, stderr } = await collectProcess(
    spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  assert.equal(code, 0, stderr || stdout);
  assert.match(stdout.trim(), /^0\.0\.0-test$/);
});

test('Windows cmd launcher is a Node shebang shim that survives a cmd.exe-length argv', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-fake-cli-shebang-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixturePath = path.join(root, 'pi-fixture.cjs');
  const binPath = path.join(root, 'pi.cmd');
  writeFileSync(fixturePath, ALIVE_PI_FIXTURE_SOURCE);
  writeWindowsCliLauncher(binPath, fixturePath);

  const launcher = readFileSync(binPath, 'utf8');
  assert.match(launcher, /^#!/);
  assert.equal(launcher.includes('@echo off'), false);
  assert.equal(launcher.includes('%*'), false);

  const longArg = 'x'.repeat(9_000);
  const { code, stdout, stderr } = await collectProcess(
    nodeSpawn(process.execPath, [binPath, longArg, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  assert.equal(code, 0, stderr || stdout);
  assert.match(stdout.trim(), /^0\.0\.0-test$/);
});
