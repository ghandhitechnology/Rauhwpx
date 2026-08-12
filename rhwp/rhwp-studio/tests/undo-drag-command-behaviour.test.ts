import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as nodeModule from 'node:module';

// [Task #2759] command.ts 커맨드 클래스의 execute/undo 행위 테스트.
//
// 이 저장소는 cursor.ts:85 의 TS 파라미터 프로퍼티 때문에 기본 test 러너(strip-only)로
// 엔진 클래스를 import 하지 못한다(tests/undo-menu-object-ops.test.ts 헤더 참고). 그래서
// support/ts-transform-hooks.mjs 를 --import 로 등록한 자식 프로세스로 러너를 spawn 해
// (Node 26 에서 --experimental-transform-types 제거) 실제 클래스를 로드하고
// mock WasmBridge 로 MoveLineEndpointCommand·ResizeObjectCommand(회전) 을 검증한다.
//
// 자식이 요구하는 module.registerHooks 가 없는 구버전 Node 에서는 skip 한다
// (부모는 strip-only 로 동작하므로 CI 를 깨지 않는다). 지원 런타임에서는
// 진짜 행위 red→green 게이트로 동작한다.

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, 'support', 'drag-command-behaviour.runner.mjs');
const transformHooks = pathToFileURL(join(here, 'support', 'ts-transform-hooks.mjs')).href;

function registerHooksSupported(): boolean {
  return typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function';
}

test('커맨드 클래스 execute/undo 행위 (자식 프로세스 로드)', (t) => {
  if (!registerHooksSupported()) {
    t.skip('현재 Node 가 module.registerHooks 미지원 — 행위 테스트 skip');
    return;
  }
  const res = spawnSync(
    process.execPath,
    ['--no-warnings', '--import', transformHooks, runner],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0,
    `러너가 비정상 종료했습니다.\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`);
  assert.match(res.stdout, /DRAG_COMMAND_BEHAVIOUR_OK/, '행위 검증 성공 마커가 있어야 함');
});
