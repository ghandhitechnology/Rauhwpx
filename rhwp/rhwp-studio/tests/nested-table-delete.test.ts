import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// 대화상자는 열지 않고 실제 표 명령의 삭제 대상과 복귀 위치를 검사한다.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/ui/')) {
      const exports = ['TableCellPropsDialog', 'TableCreateDialog', 'CellSplitDialog',
        'CellBorderBgDialog', 'FormulaDialog', 'TableDeleteRowColumnDialog', 'TableInsertRowColumnDialog'];
      return { url: `data:text/javascript,${encodeURIComponent(exports.map(name =>
        `export class ${name} {}`).join('\n'))}`, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { tableCommands } = await import('../src/command/commands/table.ts');
hooks.deregister();
const command = tableCommands.find(command => command.id === 'table:delete')!;

const path = [
  { controlIndex: 2, cellIndex: 4, cellParaIndex: 7 },
  { controlIndex: 1, cellIndex: 3, cellParaIndex: 0 },
];
const position = {
  sectionIndex: 0, parentParaIndex: 5, paragraphIndex: 0, charOffset: 2,
  controlIndex: 2, cellIndex: 4, cellParaIndex: 7, cellPath: path,
};

function run(ref: { sec: number; ppi: number; ci: number; cellPath?: typeof path } | null) {
  const calls: unknown[][] = [];
  let result: typeof position;
  const wasm = {
    deleteTableControl: (...args: unknown[]) => calls.push(['body', ...args]),
    deleteCellTableControlByPath: (...args: unknown[]) => calls.push(['cell', ...args]),
  };
  const ih = {
    getSelectedTableRef: () => ref,
    getCursorPosition: () => position,
    executeOperation: ({ operation }: { operation: (wasm: unknown) => typeof position }) => {
      result = operation(wasm);
    },
  };
  command.execute({ getInputHandler: () => ih } as unknown as Parameters<typeof command.execute>[0]);
  return { calls, result: result! };
}

test('중첩 셀의 표 삭제는 바깥 표를 보존하고 부모 셀로 복귀한다', () => {
  const { calls, result } = run(null);
  assert.deepEqual(calls, [['cell', 0, 5, JSON.stringify(path.slice(0, -1)), 1]]);
  assert.deepEqual(result.cellPath, path.slice(0, -1));
  assert.equal(result.paragraphIndex, 7);
  assert.equal(result.charOffset, 0);
});

test('중첩 표 객체 선택도 같은 부모 경로로 삭제한다', () => {
  assert.deepEqual(run({ sec: 0, ppi: 5, ci: 1, cellPath: path }).calls,
    [['cell', 0, 5, JSON.stringify(path.slice(0, -1)), 1]]);
});

test('본문 표 객체 선택은 이전 중첩 캐럿 경로보다 우선한다', () => {
  assert.deepEqual(run({ sec: 1, ppi: 8, ci: 0 }).calls, [['body', 1, 8, 0]]);
});
