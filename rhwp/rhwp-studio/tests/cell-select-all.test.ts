import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workDir = mkdtempSync(path.join(tmpdir(), 'rhwp-cell-select-all-'));
const driverPath = path.join(workDir, 'driver.mjs');

writeFileSync(driverPath, `
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const srcRoot = ${JSON.stringify(pathToFileURL(path.join(studioRoot, 'src') + path.sep).href)};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) return nextResolve(srcRoot + specifier.slice(2) + '.ts', context);
    if (/^\\.{1,2}\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const { CursorState } = await import(srcRoot + 'engine/cursor.ts');
const rect = { pageIndex: 0, x: 0, y: 0, height: 10 };

function select(initial, wasm) {
  const cursor = new CursorState(wasm);
  cursor.moveToHit({ ...initial, cursorRect: rect });
  const selected = cursor.selectAllInCurrentCell();
  return { selected, selection: cursor.getSelection(), calls: wasm.calls };
}

function pathWasm(count, lastLength) {
  const calls = [];
  return {
    calls,
    getCellParagraphCountByPath(sec, ppi, json) {
      calls.push(['countByPath', sec, ppi, JSON.parse(json)]);
      return count;
    },
    getCellParagraphLengthByPath(sec, ppi, json) {
      calls.push(['lengthByPath', sec, ppi, JSON.parse(json)]);
      return lastLength;
    },
    getCursorRectByPath() { return rect; },
  };
}

function flatWasm(count, lastLength) {
  const calls = [];
  return {
    calls,
    getCellParagraphCount(...args) { calls.push(['count', ...args]); return count; },
    getCellParagraphLength(...args) { calls.push(['length', ...args]); return lastLength; },
    getCursorRectInCell() { return rect; },
  };
}

const nested = select({
  sectionIndex: 1, paragraphIndex: 1, charOffset: 4,
  parentParaIndex: 9, controlIndex: 2, cellIndex: 3, cellParaIndex: 5,
  cellPath: [
    { controlIndex: 2, cellIndex: 3, cellParaIndex: 5 },
    { controlIndex: 7, cellIndex: 8, cellParaIndex: 1 },
  ],
}, pathWasm(3, 12));

const depthOne = select({
  sectionIndex: 0, paragraphIndex: 1, charOffset: 2,
  parentParaIndex: 4, controlIndex: 6, cellIndex: 2, cellParaIndex: 1,
  cellPath: [{ controlIndex: 6, cellIndex: 2, cellParaIndex: 1 }],
}, pathWasm(2, 9));

const flat = select({
  sectionIndex: 0, paragraphIndex: 1, charOffset: 2,
  parentParaIndex: 4, controlIndex: 6, cellIndex: 2, cellParaIndex: 1,
}, flatWasm(2, 7));

const outsideWasm = flatWasm(2, 7);
const outsideCursor = new CursorState(outsideWasm);
outsideCursor.moveToHit({ sectionIndex: 0, paragraphIndex: 2, charOffset: 3, cursorRect: rect });
const outside = { selected: outsideCursor.selectAllInCurrentCell(), calls: outsideWasm.calls };

process.stdout.write('###' + JSON.stringify({ nested, depthOne, flat, outside }) + '###');
`);

const transformHooks = pathToFileURL(path.join(studioRoot, 'tests', 'support', 'ts-transform-hooks.mjs')).href;
const run = spawnSync(
  process.execPath,
  ['--no-warnings', '--import', transformHooks, driverPath],
  { cwd: studioRoot, encoding: 'utf8' },
);
rmSync(workDir, { recursive: true, force: true });

assert.equal(run.status, 0, `CursorState behavior driver failed:\n${run.stdout}\n${run.stderr}`);
const captured = /###([\s\S]*)###/.exec(run.stdout);
assert.ok(captured, `CursorState behavior result missing:\n${run.stdout}\n${run.stderr}`);
const observed = JSON.parse(captured[1]);

test('nested cell select-all spans the innermost cell and preserves outer flat coordinates', () => {
  assert.equal(observed.nested.selected, true);
  const { anchor, focus } = observed.nested.selection;
  assert.deepEqual(
    [anchor.paragraphIndex, anchor.charOffset, focus.paragraphIndex, focus.charOffset],
    [0, 0, 2, 12],
  );
  assert.deepEqual([anchor.controlIndex, anchor.cellIndex, anchor.cellParaIndex], [2, 3, 5]);
  assert.deepEqual([focus.controlIndex, focus.cellIndex, focus.cellParaIndex], [2, 3, 5]);
  assert.equal(anchor.cellPath.at(-1).cellParaIndex, 0);
  assert.equal(focus.cellPath.at(-1).cellParaIndex, 2);
  assert.equal(observed.nested.calls[1][3].at(-1).cellParaIndex, 2);
});

test('depth-one path and flat cell select-all use the matching paragraph APIs', () => {
  assert.equal(observed.depthOne.selected, true);
  assert.deepEqual(
    [observed.depthOne.selection.anchor.cellParaIndex, observed.depthOne.selection.focus.cellParaIndex],
    [0, 1],
  );
  assert.deepEqual(observed.depthOne.calls.map((call) => call[0]), ['countByPath', 'lengthByPath']);

  assert.equal(observed.flat.selected, true);
  assert.deepEqual(
    [observed.flat.selection.anchor.cellParaIndex, observed.flat.selection.focus.cellParaIndex],
    [0, 1],
  );
  assert.deepEqual(observed.flat.calls.map((call) => call[0]), ['count', 'length']);
});

test('select-all leaves the document-wide path untouched outside cells', () => {
  assert.equal(observed.outside.selected, false);
  assert.deepEqual(observed.outside.calls, []);
});
