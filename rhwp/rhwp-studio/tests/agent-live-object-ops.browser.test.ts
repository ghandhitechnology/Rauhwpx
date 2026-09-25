import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { EventBus } from '../src/core/event-bus.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { requireWasmPackage } from './browser-support.ts';
import type { ObjectOp, PendingEditsChangeEvent } from '../src/agent/types.ts';
import type { PreparedSnapshotCommand } from '../src/engine/prepared-snapshot-command.ts';

// 실제 엔진으로 객체 op 의 즉시 적용·문단 보관본 되돌림·개체 재배치를 검증한다 (browser suite).
requireWasmPackage(fileURLToPath(new URL('../../pkg/', import.meta.url)));
const { initSync, HwpDocument } = await import('../../pkg/rhwp.js');
initSync({ module: readFileSync(new URL('../../pkg/rhwp_bg.wasm', import.meta.url)) });
type Document = InstanceType<typeof HwpDocument>;

/** WasmBridge 가 JSON 문자열을 풀어 주는 메서드만 흉내 낸다 — 나머지는 엔진을 그대로 부른다. */
function manager(document: Document) {
  const commands: PreparedSnapshotCommand[] = [];
  const parsed = new Set([
    'deleteRange', 'getCharPropertiesAt', 'getParaPropertiesAt', 'getTableDimensions',
    'getControlTextPositions', 'insertTableRow', 'deleteTableRow', 'deleteTableControl', 'mergeTableCells',
  ]);
  const bridge = new Proxy(document, {
    get(target, key) {
      if (key === 'documentDigest') return 'live-object-fixture';
      if (key === 'pageCount') return document.pageCount();
      if (key === 'createTableEx') return (options: unknown) => JSON.parse(document.createTableEx(JSON.stringify(options)));
      if (key === 'setCellProperties') {
        return (sec: number, para: number, ctrl: number, cell: number, props: unknown) =>
          JSON.parse(document.setCellProperties(sec, para, ctrl, cell, JSON.stringify(props)));
      }
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        return parsed.has(String(key)) && typeof result === 'string' ? JSON.parse(result) : result;
      };
    },
  });
  const events: PendingEditsChangeEvent[] = [];
  const pending = new PendingEditManager({
    wasm: bridge as never,
    eventBus: new EventBus(),
    inputHandler: {
      getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
      executeOperation: (operation: { kind: string; command: PreparedSnapshotCommand }) => {
        assert.equal(operation.kind, 'record');
        commands.push(operation.command);
      },
    } as never,
    canvasView: {} as never,
    overlay: { setOps() {}, clear() {} } as never,
  });
  pending.onChange((event) => events.push(event));
  return { pending, commands, bridge, events };
}

/** "ABCD[표]EFGH" — 빈 문서 첫 문단(구역/단 정의 컨트롤 2개 뒤)에 글자처럼 취급하는 표 */
function tableDocument(): { document: Document; table: { paraIdx: number; controlIdx: number } } {
  const document = HwpDocument.createEmpty();
  document.insertText(0, 0, 0, 'ABCDEFGH');
  const table = JSON.parse(document.createTableEx(JSON.stringify({
    sectionIdx: 0, paraIdx: 0, charOffset: 4, rowCount: 3, colCount: 2, treatAsChar: true,
  })));
  document.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, 'cell');
  return { document, table };
}

function pages(document: Document): string[] {
  return Array.from({ length: document.pageCount() }, (_, page) => document.renderPageSvg(page));
}

test('structural table ops apply live; reject restores the exact pages and approve keeps them', () => {
  const { document, table } = tableDocument();
  try {
    const before = pages(document);
    const { pending, commands } = manager(document);
    const ops: ObjectOp[] = [
      { type: 'tableStructure', sectionIdx: 0, tableParaIdx: table.paraIdx, controlIdx: table.controlIdx, op: 'delete_row', rowIdx: 1 },
      { type: 'tableStructure', sectionIdx: 0, tableParaIdx: table.paraIdx, controlIdx: table.controlIdx, op: 'merge_cells', startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
      { type: 'deleteTable', sectionIdx: 0, tableParaIdx: table.paraIdx, controlIdx: table.controlIdx, dims: { rowCount: 2, colCount: 2 } },
    ];
    let changeSetId = '';
    for (const op of ops) changeSetId = pending.addObjectOp('claude', op).changeSetId;
    assert.throws(() => document.getTableDimensions(0, table.paraIdx, table.controlIdx), '표가 즉시 삭제된다');
    const preview = pages(document);

    pending.reject(changeSetId);
    assert.deepEqual(pages(document), before, 'reject 는 문단 보관본으로 원래 쪽을 그대로 되살린다');
    assert.equal(JSON.parse(document.getTableDimensions(0, table.paraIdx, table.controlIdx)).rowCount, 3);

    const again = manager(document);
    for (const op of structuredClone(ops)) changeSetId = again.pending.addObjectOp('claude', op).changeSetId;
    assert.deepEqual(pages(document), preview);
    assert.equal(again.pending.approve(changeSetId), true);
    assert.deepEqual(pages(document), preview, '승인은 미리보기를 그대로 채택한다');
    again.commands[0].undo(again.bridge as never);
    assert.deepEqual(pages(document), before, '승인 undo 는 적용 전 문서로 돌아간다');
    assert.equal(commands.length, 0);
  } finally {
    document.free();
  }
});

test('a line break before an inline table moves the table op to the new paragraph', () => {
  const { document, table } = tableDocument();
  try {
    const before = pages(document);
    const { pending } = manager(document);
    const cellOp: ObjectOp = {
      type: 'setCellProps', sectionIdx: 0, tableParaIdx: table.paraIdx, controlIdx: table.controlIdx,
      cellIdx: 0, props: { fillType: 'solid', fillColor: '#FFEEAA' }, dims: { rowCount: 3, colCount: 2 },
    };
    const { changeSetId } = pending.addObjectOp('claude', cellOp);
    pending.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 2 }, 'x\ny');
    assert.equal(document.getTextRange(0, 0, 0, 10), 'ABx');
    assert.equal(document.getTextRange(0, 1, 0, 10), 'yCDEFGH');
    const staged = pending.getChangeSets()[0].ops.find((op) => op.kind === 'object')!;
    const moved = (staged as { obj: Extract<ObjectOp, { type: 'setCellProps' }> }).obj;
    assert.deepEqual([moved.tableParaIdx, moved.controlIdx], [1, 0], '엔진이 옮긴 문단·컨트롤 번호를 따라간다');
    pending.reject(changeSetId);
    assert.deepEqual(pages(document), before);
  } finally {
    document.free();
  }
});

test('a multi-line insert after an inline object splits at the text offset, not before it', () => {
  const { document } = tableDocument();
  try {
    const { pending } = manager(document);
    const { changeSetId } = pending.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 6 }, 'x\ny');
    assert.equal(document.getTextRange(0, 0, 0, 10), 'ABCDEFx');
    assert.equal(document.getTextRange(0, 1, 0, 10), 'yGH');
    pending.reject(changeSetId);
    assert.equal(document.getTextRange(0, 0, 0, 10), 'ABCDEFGH');
  } finally {
    document.free();
  }
});

test('a user edit inside the captured paragraph blocks the paragraph restore', () => {
  const { document, table } = tableDocument();
  try {
    const { pending, events } = manager(document);
    const at = { sectionIdx: 0, tableParaIdx: table.paraIdx, controlIdx: table.controlIdx } as const;
    pending.addObjectOp('claude', { type: 'tableStructure', ...at, op: 'insert_row', index: 0, after: true });
    const { changeSetId } = pending.addObjectOp('claude', { type: 'tableStructure', ...at, op: 'delete_row', rowIdx: 2 });
    // 사용자가 같은 표의 셀에 입력한다 (에이전트 op 이 아니다)
    document.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, '!');
    pending.reject(changeSetId);
    // 행 삭제는 보관본 말고 되돌릴 수단이 없다 — 사용자 입력을 지우지 않도록 문서에 남기고 알린다.
    // 행 삽입은 역연산(삽입한 행 삭제)으로 되돌아간다.
    const drop = events.find((event) => event.type === 'invalidated');
    assert.ok(drop && drop.type === 'invalidated' && drop.leftInDocument === true);
    assert.deepEqual(drop.drops?.map((d) => d.cause), ['revert-failed']);
    assert.equal(JSON.parse(document.getTableDimensions(0, table.paraIdx, table.controlIdx)).rowCount, 2);
    assert.equal(document.getTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, 10), '!cell');
  } finally {
    document.free();
  }
});
