import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 중첩 표 셀 문단 커맨드의 "축 일치" 가드 — 두 축 모두.
//
// (축 1) 인덱스 축: hit-test 는 flat 필드(controlIndex/cellIndex/cellParaIndex)를
//   cellPath[0], 즉 **최외곽** 엔트리에서 채운다(cursor_rect.rs 의 `outer = &ctx.path[0]`).
//   따라서 중첩 셀에서 pos.cellParaIndex 는 바깥 셀의 문단 인덱스이고, 안쪽 셀의 값은
//   cellPath[last].cellParaIndex 다. 셀 문단 커맨드가 ...ByPath API 를 부르면서 인덱스만
//   flat 에서 가져오면, 올바른 셀의 **엉뚱한 문단**을 병합/분할한다.
//
// (축 2) API 축: 뮤테이션이 ...ByPath 로 분기하면 길이 조회도 ...ByPath 여야 한다.
//   flat getCellParagraphLength 는 "외부 표 기준" 레거시 좌표를 쓴다(core/types.ts).
//
//   중첩 표 안쪽 셀의 2번째 문단에서 Enter → Ctrl+Z
//   기대: 방금 분할한 문단이 다시 합쳐짐
//   실제(축 1 어긋남): 바깥 축 인덱스로 계산돼 무관한 두 문단이 합쳐짐
//
// 기준 선례: cursor.ts:399, input-handler-text.ts:307 의 useCellPath 분기.
// 행위 증명(중첩 표 왕복)은 브라우저 왕복(PR 검증).

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const commandSrc = readFileSync(join(rootDir, 'src/engine/command.ts'), 'utf8');

/** `export class NAME ...` 부터 다음 `export class` 전까지 클래스 본문을 추출. */
function classBlock(name: string): string {
  const start = commandSrc.indexOf(`export class ${name}`);
  assert.notEqual(start, -1, `${name} 클래스 not found`);
  const rel = commandSrc.slice(start + 1).indexOf('\nexport class ');
  return rel === -1 ? commandSrc.slice(start) : commandSrc.slice(start, start + 1 + rel);
}

const CELL_PARA_COMMANDS = [
  'SplitParagraphInCellCommand',
  'MergeParagraphInCellCommand',
  'MergeNextParagraphInCellCommand',
];

test('셀 문단 인덱스는 단일 헬퍼로 cellPath 축에서 읽는다', () => {
  assert.match(commandSrc, /function cellParaIndexOf\s*\(/,
    '인덱스 축 유도가 여러 곳에 복제되면 한쪽만 고쳐지는 회귀가 재발한다');

  // 헬퍼는 마지막(가장 안쪽) 엔트리를 봐야 한다.
  assert.match(commandSrc, /path!\[path!\.length - 1\]\.cellParaIndex/,
    'cellPath 의 마지막 엔트리가 안쪽 셀의 문단 인덱스다');
});

test('셀 문단 커맨드가 flat cellParaIndex 를 직접 쓰지 않는다', () => {
  for (const name of CELL_PARA_COMMANDS) {
    const block = classBlock(name);
    assert.doesNotMatch(block, /const cpi = pos\.cellParaIndex!/,
      `${name}: 중첩 셀에서 pos.cellParaIndex 는 바깥 셀 값이라 ...ByPath 인덱스로 쓸 수 없다`);
    assert.match(block, /const cpi = cellParaIndexOf\(pos\)/,
      `${name}: 인덱스 축을 헬퍼로 통일해야 함`);
  }
});

test('중첩 셀 병합은 길이 조회도 ByPath 축으로 읽는다', () => {
  const block = classBlock('MergeParagraphInCellCommand');
  const executeBlock = block.slice(
    block.indexOf('execute(wasm: WasmBridge): DocumentPosition {'),
    block.indexOf('undo(wasm: WasmBridge): DocumentPosition {'),
  );

  assert.match(executeBlock, /getCellLogicalLengthByPath\s*\(/,
    '분할과 캐럿 복원에는 안쪽 셀의 논리 길이를 써야 함');
  assert.match(executeBlock, /cellParagraphPosition\(pos, cpi - 1, 0\)/,
    '길이 조회는 병합 전 문단 경로를 써야 함');
  assert.doesNotMatch(executeBlock, /getCellParagraphLength/,
    '텍스트 길이는 인라인 수식 개수를 누락한다');
});

// 실제 명령에 서로 다른 텍스트/논리 길이를 주어 캐럿과 역연산을 함께 확인한다.
await import('./support/ts-transform-hooks.mjs');
const { registerHooks } = await import('node:module');
const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { MergeParagraphCommand, MergeParagraphInCellCommand } = await import('../src/engine/command.ts');
resolver.deregister();

test('본문 수식 뒤 병합 캐럿과 undo 분할은 같은 논리 경계를 쓴다', () => {
  const splits: unknown[][] = [];
  const wasm = {
    getParagraphLength: () => 3,
    getLogicalLength: () => 5,
    mergeParagraph: () => '{}',
    splitParagraph: (...args: unknown[]) => splits.push(args),
  };
  const command = new MergeParagraphCommand({ sectionIndex: 0, paragraphIndex: 1, charOffset: 0 });
  assert.equal(command.execute(wasm as any).charOffset, 5);
  command.undo(wasm as any);
  assert.equal(splits[0][2], 5);
});

for (const nested of [false, true]) {
  test(`${nested ? '중첩' : '일반'} 셀 수식 뒤 병합은 개체를 빠뜨리지 않고 복원한다`, () => {
    const path = [
      ...(nested ? [{ controlIndex: 2, cellIndex: 4, cellParaIndex: 7 }] : []),
      { controlIndex: 1, cellIndex: 3, cellParaIndex: 1 },
    ];
    const pos = { sectionIndex: 0, parentParaIndex: 5, paragraphIndex: 1, charOffset: 0,
      controlIndex: path[0].controlIndex, cellIndex: path[0].cellIndex,
      cellParaIndex: path[0].cellParaIndex, cellPath: path };
    let splitOffset: number | undefined;
    const wasm = {
      getCellParagraphLength: () => 3,
      getCellParagraphLengthByPath: () => 3,
      getCellLogicalLengthByPath: (_sec: number, _para: number, json: string) => {
        assert.equal(JSON.parse(json).at(-1).cellParaIndex, 0);
        return 5;
      },
      mergeParagraphInCell: () => '{}',
      mergeParagraphInCellByPath: () => '{}',
      splitParagraphInCell: (...args: any[]) => { splitOffset = args[5]; },
      splitParagraphInCellByPath: (...args: any[]) => { splitOffset = args[3]; },
    };
    const command = new MergeParagraphInCellCommand(pos);
    assert.equal(command.execute(wasm as any).charOffset, 5);
    assert.deepEqual(command.undo(wasm as any), pos);
    assert.equal(splitOffset, 5);
  });
}
