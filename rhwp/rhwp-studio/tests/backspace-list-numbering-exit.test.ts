import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 번호/글머리표 문단 시작에서 Backspace 는 이전 문단과 병합하는 대신 번호를 해제해
// 일반 문단으로 되돌린다 (한/글·Word 공통 관례). 이 가드는 그 행위 계약을 고정한다:
//   A. charOffset 0 + headType Number → clearParaNumbering, 병합 없음
//   B. charOffset 0 + headType None   → 기존 병합 그대로
//   C. charOffset > 0 + headType Number → 일반 한 글자 삭제 (번호 유지)
//   D. 셀 내부 charOffset 0 + headType Bullet → clearParaNumbering (셀 분기에도 적용)
//
// 하네스는 tests/nested-cell-backspace-merge.test.ts 와 동일: 실제 input-handler-text.ts 를
// 자식 프로세스에서 TS 변환 로더로 import 해 executeOperation/메서드 호출을 캡처한다.

const studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workDir = mkdtempSync(path.join(tmpdir(), 'rhwp-backspace-numbering-'));

const stubPath = path.join(workDir, 'confirm-dialog-stub.mjs');
writeFileSync(stubPath, 'export function showConfirm() { return Promise.resolve(false); }\n');

const driverPath = path.join(workDir, 'driver.mjs');
writeFileSync(driverPath, `
import { registerHooks } from 'node:module';

const srcRoot = ${JSON.stringify(pathToFileURL(path.join(studioRoot, 'src') + path.sep).href)};
const stubUrl = ${JSON.stringify(pathToFileURL(stubPath).href)};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/ui/confirm-dialog') return { url: stubUrl, shortCircuit: true };
    if (specifier.startsWith('@/')) return nextResolve(srcRoot + specifier.slice(2) + '.ts', context);
    if (/^\\.{1,2}\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const mod = await import(srcRoot + 'engine/input-handler-text.ts');

function makeHost(headType) {
  const ops = [];
  const calls = [];
  return {
    ops,
    calls,
    host: {
      cursor: { isInHeaderFooter: () => false },
      wasm: { getFieldInfoAt() { throw new Error('no field'); } },
      getParaProperties: () => ({ headType }),
      clearParaNumbering() { calls.push('clearParaNumbering'); },
      executeOperation(op) { ops.push(op.command?.type ?? op.operationType); },
    },
  };
}

function bodyPos(charOffset) {
  return { sectionIndex: 0, paragraphIndex: 1, charOffset };
}
function cellPos(charOffset) {
  return {
    sectionIndex: 0, paragraphIndex: 1, charOffset,
    parentParaIndex: 3, controlIndex: 0, cellIndex: 0, cellParaIndex: 1,
    cellPath: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 1 }],
  };
}

const result = {};

// A. 본문 번호 문단 시작 → 번호 해제만, 병합 없음.
{
  const h = makeHost('Number');
  mod.handleBackspace.call(h.host, bodyPos(0), false);
  result.numberedStart = { ops: h.ops, calls: h.calls };
}

// B. 일반 문단 시작 → 기존 병합 유지.
{
  const h = makeHost('None');
  mod.handleBackspace.call(h.host, bodyPos(0), false);
  result.plainStart = { ops: h.ops, calls: h.calls };
}

// C. 번호 문단 중간 → 일반 삭제, 번호 유지.
{
  const h = makeHost('Number');
  mod.handleBackspace.call(h.host, bodyPos(3), false);
  result.numberedMiddle = { ops: h.ops, calls: h.calls };
}

// D. 셀 내부 글머리표 문단 시작 → 번호 해제.
{
  const h = makeHost('Bullet');
  mod.handleBackspace.call(h.host, cellPos(0), true);
  result.cellBulletStart = { ops: h.ops, calls: h.calls };
}

process.stdout.write('###' + JSON.stringify(result) + '###');
`);

const transformHooks = pathToFileURL(path.join(studioRoot, 'tests', 'support', 'ts-transform-hooks.mjs')).href;
const run = spawnSync(
  process.execPath,
  ['--no-warnings', '--import', transformHooks, driverPath],
  { cwd: studioRoot, encoding: 'utf8' },
);

rmSync(workDir, { recursive: true, force: true });

assert.equal(run.status, 0, `handleBackspace 드라이버 실행 실패:\n${run.stdout}\n${run.stderr}`);
const captured = /###([\s\S]*)###/.exec(run.stdout);
assert.ok(captured, `드라이버 출력에서 결과 JSON 을 찾지 못함:\n${run.stdout}\n${run.stderr}`);
const observed = JSON.parse(captured[1]) as Record<string, { ops: string[]; calls: string[] }>;

test('번호 문단 시작 Backspace 는 병합 대신 번호를 해제한다', () => {
  assert.deepEqual(observed.numberedStart.calls, ['clearParaNumbering']);
  assert.deepEqual(observed.numberedStart.ops, [], '번호 해제 시 병합/삭제 커맨드가 실행되면 안 된다');
});

test('일반 문단 시작 Backspace 는 기존처럼 이전 문단과 병합한다', () => {
  assert.deepEqual(observed.plainStart.calls, []);
  assert.deepEqual(observed.plainStart.ops, ['mergeParagraph']);
});

test('번호 문단 중간 Backspace 는 글자만 지우고 번호를 유지한다', () => {
  assert.deepEqual(observed.numberedMiddle.calls, []);
  assert.deepEqual(observed.numberedMiddle.ops, ['deleteText']);
});

test('셀 내부 글머리표 문단 시작 Backspace 도 번호를 해제한다', () => {
  assert.deepEqual(observed.cellBulletStart.calls, ['clearParaNumbering']);
  assert.deepEqual(observed.cellBulletStart.ops, []);
});
