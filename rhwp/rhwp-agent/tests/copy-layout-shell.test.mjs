import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  COPY_LAYOUT_HELPER_BASENAME,
  copyLayoutShellAllowPrefixes,
  copyLayoutShellCommandAllowed,
} from '../copy-layout-shell.mjs';
import { scopedBashAllowRules } from '../agents/grok.mjs';

const helperPath = '/private/job/copy_layout.py';
const bundledHelper = fileURLToPath(
  new URL('../skills/copy-layout/scripts/copy_layout.py', import.meta.url),
);
const blankHwpx = fileURLToPath(new URL('../../saved/blank_hwpx.hwpx', import.meta.url));

test('copy-layout shell prefixes pin the job helper instead of python3*', () => {
  const prefixes = copyLayoutShellAllowPrefixes(helperPath);
  assert.deepEqual(prefixes, [
    'python3 /private/job/copy_layout.py',
    'python3 "/private/job/copy_layout.py"',
    'python /private/job/copy_layout.py',
    'python "/private/job/copy_layout.py"',
  ]);
  assert.equal(path.basename(helperPath), COPY_LAYOUT_HELPER_BASENAME);
  assert.throws(
    () => copyLayoutShellAllowPrefixes('/private/job/other.py'),
    /copy_layout\.py/,
  );
  const rules = scopedBashAllowRules(prefixes);
  assert.ok(rules.includes('Bash(python3 /private/job/copy_layout.py)'));
  assert.ok(rules.includes('Bash(python3 /private/job/copy_layout.py *)'));
  assert.equal(rules.includes('Bash(python3*)'), false);
  assert.equal(rules.includes('Bash(python*)'), false);
});

test('helper invocations pass and inline or foreign python is rejected', () => {
  assert.equal(
    copyLayoutShellCommandAllowed(`python3 ${helperPath} --inspect-text /private/job/snap.hwpx`, helperPath),
    true,
  );
  assert.equal(
    copyLayoutShellCommandAllowed(`python3 "${helperPath}" --text-plan /private/job/plan.json -o /private/job/out.hwpx`, helperPath),
    true,
  );
  assert.equal(copyLayoutShellCommandAllowed(`python3 ${helperPath}`, helperPath), true);
  assert.equal(copyLayoutShellCommandAllowed('python3 -c "print(1)"', helperPath), false);
  assert.equal(copyLayoutShellCommandAllowed('python3 -m http.server', helperPath), false);
  assert.equal(copyLayoutShellCommandAllowed('python3 /tmp/evil.py', helperPath), false);
  assert.equal(copyLayoutShellCommandAllowed(`python3 ${helperPath}evil --inspect-text x`, helperPath), false);
  assert.equal(copyLayoutShellCommandAllowed('python3 scripts/copy_layout.py --inspect-text snap.hwpx', helperPath), false);
});

test('bundled helper still inspects a real hwpx through the pinned command shape', (t) => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const probe = spawnSync(python, ['-S', '-c', 'import sys'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') {
    t.skip('Python is unavailable');
    return;
  }
  const command = `${python} ${bundledHelper} --inspect-text ${blankHwpx}`;
  assert.equal(copyLayoutShellCommandAllowed(command, bundledHelper), true);
  assert.equal(copyLayoutShellCommandAllowed(`${python} -c "print(1)"`, bundledHelper), false);
  const result = spawnSync(python, ['-S', bundledHelper, '--inspect-text', blankHwpx], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.source_sha256, 'string');
  assert.ok(report.source_sha256.length > 0);
});
