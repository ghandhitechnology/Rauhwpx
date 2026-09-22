import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as nodeModule from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, 'support', 'mixed-char-format-recovery.runner.mjs');
const transformHooks = pathToFileURL(join(here, 'support', 'ts-transform-hooks.mjs')).href;

function registerHooksSupported(): boolean {
  return typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function';
}

test('#6814 command/history/UI 오류 회귀 — WASM 산출물 없이 필수 실행', (t) => {
  if (!registerHooksSupported()) {
    t.skip('현재 Node 가 module.registerHooks 미지원 — 행위 테스트 skip');
    return;
  }
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--import', transformHooks, runner],
    { encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  assert.match(result.stdout, /CHAR_FORMAT_RECOVERY_OK/);
});
