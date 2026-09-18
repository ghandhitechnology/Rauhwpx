import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as nodeModule from 'node:module';

// [Task #825] 머리말/꼬리말 그림의 이동/리사이즈/회전 Undo·Redo 회귀 테스트.
//
// 라이브 드래그(getObjectProperties/setObjectProperties)는 headerFooter marker 로
// setHeaderFooterPictureProperties 를 쓰는데, Undo 커맨드(MovePictureCommand /
// MoveShapeCommand / ResizeObjectCommand)는 marker 를 받지 못해 본문 좌표계의
// setPictureProperties 로 떨어졌다. 머리말 내부 문단 인덱스는 본문 문단 목록과 다른
// 인덱스 공간이라 Ctrl+Z 가 (a) throw → CommandHistory.undo 가 항목을 버려 영구 undo
// 불가, 또는 (b) 같은 인덱스의 엉뚱한 본문 그림을 되돌리는 문제가 있었다.
//
// undo-drag-command-behaviour.test.ts 와 동일한 이유로(cursor.ts 의 TS 파라미터
// 프로퍼티 → 기본 strip-only 러너로 import 불가) support/ts-transform-hooks.mjs 를
// --import 로 등록한 자식 프로세스에서 실제 클래스를 로드해 mock WasmBridge 로 검증한다.

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, 'support', 'headerfooter-object-ops.runner.mjs');
const transformHooks = pathToFileURL(join(here, 'support', 'ts-transform-hooks.mjs')).href;

function registerHooksSupported(): boolean {
  return typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function';
}

test('머리말/꼬리말 개체 Undo/Redo 라우팅 (자식 프로세스 로드)', (t) => {
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
  assert.match(res.stdout, /HEADERFOOTER_OBJECT_OPS_OK/, '행위 검증 성공 마커가 있어야 함');
});

// 커맨드 생성부에서 marker 를 흘리면 위 행위 테스트가 통과해도 실사용은 여전히 깨진다.
// (드래그 종료 핸들러가 headerFooter 를 넘기지 않으면 커맨드는 본문 경로로 되돌아간다.)
test('개체 드래그/키보드 종료 핸들러가 headerFooter marker 를 커맨드로 전달한다', () => {
  const src = readFileSync(join(here, '..', 'src', 'engine', 'input-handler-picture.ts'), 'utf8');

  // ResizeObjectCommand 타깃 리터럴 4곳: Shift+방향키 / 다중 리사이즈 / 단일 리사이즈 / 회전
  const hfPassCount = (src.match(/headerFooter: (?:r|state\.ref)\.headerFooter/g) ?? []).length;
  assert.ok(hfPassCount >= 4,
    `ResizeObjectCommand 타깃에 headerFooter 를 넣는 지점이 4곳 이상이어야 함 (현재 ${hfPassCount})`);

  // 이동 커맨드(MovePictureCommand/MoveShapeCommand)는 cellPath 다음 인자로 넘긴다.
  assert.match(src, /r\.cellPath,\s*\n\s*r\.headerFooter,/,
    'finishPictureMoveDrag 가 cellPath 뒤에 headerFooter 를 넘겨야 함');
});
