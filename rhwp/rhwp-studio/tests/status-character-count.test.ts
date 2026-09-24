import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusCharacterCounter, countWrittenCharacters, type StatusCountDocument, type StatusCountInput } from '../src/ui/status-character-count.ts';

test('counts Korean syllable blocks and emoji clusters, excluding spaces and control markers', () => {
  assert.equal(countWrittenCharacters('한글 한 👩‍💻\n'), 4);
  assert.equal(countWrittenCharacters('\u0002\uFFFC\u200B'), 0);
});

test('uses model total and updates selection or current-cell numerator without rescanning total', () => {
  let total = 8;
  let totalReads = 0;
  const body = '한글 test';
  const cells = ['표 안', '둘'];
  const wasm = {
    getDocumentCharacterCount: () => { totalReads++; return total; },
    getBodyRangeCharacterCount: (_ss: number, _sp: number, from: number, _es: number, _ep: number, to: number) =>
      countWrittenCharacters(Array.from(body).slice(from, to).join('')),
    getContainerCharacterCountByPath: (_sec: number, _para: number, json: string) => {
      const path = JSON.parse(json) as Array<{ cellIndex: number }>;
      return countWrittenCharacters(cells[path.at(-1)!.cellIndex]);
    },
    getContainerRangeCharacterCountByPath: (_sec: number, _para: number, json: string, _sp: number, from: number, _ep: number, to: number) => {
      const path = JSON.parse(json) as Array<{ cellIndex: number }>;
      return countWrittenCharacters(Array.from(cells[path.at(-1)!.cellIndex]).slice(from, to).join(''));
    },
    getTableDimensions: () => ({ cellCount: 2 }),
    getCellInfo: (_sec: number, _para: number, _control: number, cell: number) => ({ row: 0, col: cell }),
  } as unknown as StatusCountDocument;
  const position = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  let selection: ReturnType<StatusCountInput['getSelection']> = null;
  let cellSelection = false;
  const excludedCells = new Set<string>();
  const input: StatusCountInput = {
    getCursorPosition: () => position,
    getSelection: () => selection,
    isInCellSelectionMode: () => cellSelection,
    getSelectedCellRange: () => cellSelection ? { startRow: 0, startCol: 0, endRow: 0, endCol: 1 } : null,
    getCellTableContext: () => ({ sec: 0, ppi: 0, ci: 0 }),
    getExcludedCells: () => excludedCells,
  };
  const counter = new StatusCharacterCounter();
  assert.deepEqual(counter.read(wasm, input), { current: 8, total: 8, scope: 'document' });

  selection = { start: { ...position, charOffset: 0 }, end: { ...position, charOffset: 2 } };
  assert.deepEqual(counter.read(wasm, input), { current: 2, total: 8, scope: 'selection' });
  input.getAuxiliaryTextSelection = () => '주석 두 글';
  assert.deepEqual(counter.read(wasm, input), { current: 4, total: 8, scope: 'selection' });
  input.getAuxiliaryTextSelection = () => null;
  selection = null;
  Object.assign(position, { parentParaIndex: 0, controlIndex: 0, cellIndex: 0, cellParaIndex: 0 });
  assert.deepEqual(counter.read(wasm, input), { current: 2, total: 8, scope: 'cell' });
  selection = { start: { ...position, charOffset: 0 }, end: { ...position, charOffset: 1 } };
  assert.deepEqual(counter.read(wasm, input), { current: 1, total: 8, scope: 'selection' });
  selection = null;
  cellSelection = true;
  assert.deepEqual(counter.read(wasm, input), { current: 3, total: 8, scope: 'selection' });
  excludedCells.add('0,0');
  assert.deepEqual(counter.read(wasm, input), { current: 1, total: 8, scope: 'selection' });
  assert.equal(totalReads, 1);

  total = 9;
  counter.invalidate();
  assert.equal(counter.read(wasm, input).total, 9);
  assert.equal(totalReads, 2);
});
