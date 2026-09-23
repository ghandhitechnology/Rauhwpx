import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// [Task #2759] 드래그·클릭 문서 뮤테이션의 히스토리 라우팅 소스 가드.
//
// 회전 핸들 드래그·직선 끝점 드래그·클릭 z순서 변경이 executeOperation 를 경유해 undo 에
// 기록되는지 정적으로 핀한다. 뮤테이션 표면 원장(mutation-routing-guard)은 '표면 증가'만
// 잡고 '라우팅 누락'은 못 잡으므로(라우팅해도 wasm.X( 텍스트는 그대로 남음), 그리고
// undo-menu-object-ops 는 command/commands/insert.ts 만 보므로, 엔진 층 진입점은 이 가드가
// 담당한다. 행위 증명은 tests/undo-drag-command-behaviour.test.ts(커맨드 execute/undo)와
// tests/object-drag-record.test.ts(기록 결정 순수 로직)에 있다.

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pictureSrc = readFileSync(join(rootDir, 'src/engine/input-handler-picture.ts'), 'utf8');
const mouseSrc = readFileSync(join(rootDir, 'src/engine/input-handler-mouse.ts'), 'utf8');

/** name 으로 시작하는 함수 본문을 다음 최상위 'export function'/'function ' 전까지 잘라온다. */
function fnBody(src: string, header: string): string {
  const start = src.indexOf(header);
  assert.notEqual(start, -1, `${header} 를 찾지 못함`);
  const after = src.slice(start + header.length);
  const next = after.search(/\n(export )?function /);
  return after.slice(0, next === -1 ? 2000 : next);
}

// ── 결함 1: 회전 핸들 드래그 ───────────────────────────────────────────────
test('finishPictureRotateDrag 는 회전각 변경을 executeOperation record 로 기록한다', () => {
  const body = fnBody(pictureSrc, 'export function finishPictureRotateDrag');
  assert.match(body, /computeRotationRecord\(/, 'origAngle→finalAngle 기록 결정을 순수 함수로 위임');
  assert.match(body, /executeOperation\(/, 'executeOperation 경유(히스토리 기록)');
  assert.match(body, /kind:\s*'record'/, "kind:'record' 로 드래그 사후 기록");
  assert.match(body, /new ResizeObjectCommand\(/, 'rotationAngle before/after 를 ResizeObjectCommand 로');
});

// ── 결함 2: 직선 끝점 드래그 ───────────────────────────────────────────────
test('finishLineEndpointDrag 는 끝점 이동을 executeOperation record 로 기록한다', () => {
  const body = fnBody(mouseSrc, 'export function finishLineEndpointDrag');
  assert.match(body, /computeLineEndpointRecord\(/, 'before/after 끝점 기록 결정을 순수 함수로 위임');
  assert.match(body, /executeOperation\(/, 'executeOperation 경유');
  assert.match(body, /kind:\s*'record'/, "kind:'record' 로 드래그 사후 기록");
  assert.match(body, /new MoveLineEndpointCommand\(/, '끝점 좌표 역연산 커맨드로 기록');
});

test('onMouseUp 은 직선 끝점 종료를 finishLineEndpointDrag 로 위임한다(인라인 정리 금지)', () => {
  const wrapper = fnBody(mouseSrc, 'export function onMouseUp');
  assert.match(wrapper, /finishMouseUp\.call\(this,\s*e\)/,
    'onMouseUp 하이퍼링크 래퍼가 본문을 삼키지 않고 finishMouseUp 에 위임해야 함');
  const body = fnBody(mouseSrc, 'function finishMouseUp');
  assert.match(body, /if \(this\.isLineEndpointDragging\)\s*{\s*this\.finishLineEndpointDrag\(\);/,
    'finishMouseUp 은 상태 인라인 초기화가 아니라 finishLineEndpointDrag 로 위임해야 함(기록 경로 확보)');
});

// ── 결함 3: 클릭 z순서 변경 ────────────────────────────────────────────────
test('bringShapeToFront 는 z순서 변경을 executeOperation snapshot 으로 기록한다', () => {
  const body = fnBody(mouseSrc, 'function bringShapeToFront');
  // 미라우팅 회귀: this.wasm.changeObjectZOrder( 직접 호출이 남으면 히스토리 우회.
  assert.doesNotMatch(body, /this\.wasm\.changeObjectZOrder\s*\(/,
    'this.wasm.changeObjectZOrder 직접 호출 금지 — executeOperation 경유여야 함');
  assert.match(body, /executeOperation\(/, 'executeOperation 경유');
  assert.match(body, /kind:\s*'snapshot'/, "kind:'snapshot' 로 기록(메뉴 정렬 경로와 동형)");
  assert.match(body, /operationType:\s*'changeZOrder'/, 'changeZOrder 로 분류');
  assert.match(body, /wasm\.changeObjectZOrder\s*\(/, '뮤테이션 자체는 operation 콜백에 존재');
});

test('연결선 클릭은 z순서나 문서를 바꾸지 않고 선택만 한다', () => {
  const body = fnBody(mouseSrc, 'function selectLineObjectFromHit');
  assert.doesNotMatch(body, /bringShapeToFront\(/, '단순 클릭은 선을 맨 앞으로 옮기면 안 됨');
  assert.doesNotMatch(body, /executeOperation\(/, '단순 클릭은 Undo 항목을 만들면 안 됨');
  assert.match(body, /enterPictureObjectSelectionRef\(/, '선 객체 선택으로 진입');
});

test('본문 클릭은 연결선 hit를 표/글상자 hit-test보다 먼저 소비한다', () => {
  const body = fnBody(mouseSrc, 'export function onClick');
  const earlyLine = body.indexOf("earlyObjectHit?.type === 'line'");
  const wasmHit = body.indexOf('this.wasm.hitTest(pageIdx, pageX, pageY)');
  assert.notEqual(earlyLine, -1, 'early line 분기가 있어야 한다');
  assert.notEqual(wasmHit, -1, '본문 hitTest가 있어야 한다');
  assert.ok(earlyLine < wasmHit, '선 선택을 본문 컨테이너 hit보다 먼저 확정해야 한다');
  assert.match(body, /selectLineObjectFromHit\.call\(this, earlyObjectHit\)/);
});
