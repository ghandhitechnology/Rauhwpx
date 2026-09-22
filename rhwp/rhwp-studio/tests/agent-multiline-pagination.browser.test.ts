import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { EventBus } from '../src/core/event-bus.ts';
import { withBodyTextPaginationBatch } from '../src/core/pagination-batch.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { requireWasmPackage } from './browser-support.ts';
import type { CellAddr } from '../src/agent/types.ts';
import type { PreparedSnapshotCommand } from '../src/engine/prepared-snapshot-command.ts';

// These engine integration tests run with the browser suite, which builds WASM first.
requireWasmPackage(fileURLToPath(new URL('../../pkg/', import.meta.url)));
const { initSync, HwpDocument } = await import('../../pkg/rhwp.js');
initSync({ module: readFileSync(new URL('../../pkg/rhwp_bg.wasm', import.meta.url)) });
type Document = InstanceType<typeof HwpDocument>;

function manager(document: Document, batched: boolean) {
  let batches = 0;
  const commands: PreparedSnapshotCommand[] = [];
  const rawBatchDocument = {
    canBatchBodyText: (section: number) => document.canBatchBodyText(section),
    beginBatch: () => { batches++; return document.beginBatch(); },
    endBatch: () => document.endBatch(),
  };
  const parsed = new Set(['deleteRange', 'deleteRangeInCell', 'getCharPropertiesAt', 'getParaPropertiesAt']);
  const bridge = new Proxy(document, {
    get(target, key) {
      if (key === 'documentDigest') return 'multiline-fixture';
      if (key === 'pageCount') return document.pageCount();
      if (key === 'withBodyTextPaginationBatch') return batched
        ? (section: number, edit: () => unknown) => withBodyTextPaginationBatch(rawBatchDocument, section, edit)
        : undefined;
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        return parsed.has(String(key)) && typeof result === 'string' ? JSON.parse(result) : result;
      };
    },
  });
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
  return { pending, batches: () => batches, commands, bridge };
}

function assertSameDocument(baseline: Document, batched: Document) {
  assert.deepEqual(batched.exportHwp(), baseline.exportHwp(), 'serialized text, formatting, and layout must match');
  assert.equal(batched.pageCount(), baseline.pageCount());
  for (let page = 0; page < baseline.pageCount(); page++) {
    assert.equal(batched.renderPageSvg(page), baseline.renderPageSvg(page), `page ${page} rendering differs`);
  }
}

for (const fixture of [
  { name: 'single-column business document', path: '../../samples/hwpx/business_overview.hwpx', paragraph: -1, lines: 32, batches: 1 },
  { name: 'multicolumn exam', path: '../../samples/exam_eng.hwp', paragraph: 5, lines: 8, batches: 0 },
  { name: 'unequal column transition', path: './fixtures/agent-unequal-columns.hwpx', paragraph: 5, lines: 32, batches: 0 },
]) {
  test(`multiline agent insertion preserves unbatched bytes and page rendering for ${fixture.name}`, () => {
    const bytes = readFileSync(new URL(fixture.path, import.meta.url));
    const baseline = new HwpDocument(bytes);
    const batched = new HwpDocument(bytes);
    try {
      const text = Array.from({ length: fixture.lines }, (_, i) =>
        `Test ${i}: a paragraph added during an agent editing batch with enough text to wrap into several narrow column lines before moving into the wider column.`,
      ).join('\n');
      for (const [document, enabled] of [[baseline, false], [batched, true]] as const) {
        const { pending, batches } = manager(document, enabled);
        const paraIdx = fixture.paragraph < 0 ? document.getParagraphCount(0) - 1 : fixture.paragraph;
        pending.insertText('claude', {
          sectionIdx: 0, paraIdx, charOffset: document.getParagraphLength(0, paraIdx),
        }, text);
        assert.equal(batches(), enabled ? fixture.batches : 0);
      }
      assertSameDocument(baseline, batched);
    } finally {
      baseline.free();
      batched.free();
    }
  });
}

test('multiline cell insertion keeps the original pagination and reject behavior', () => {
  const baseline = HwpDocument.createEmpty();
  const batched = HwpDocument.createEmpty();
  const pendingSets: Array<{ pending: PendingEditManager; id: string }> = [];
  try {
    for (const [document, enabled] of [[baseline, false], [batched, true]] as const) {
      const created = JSON.parse(document.createTable(0, 0, 0, 2, 2));
      const cell: CellAddr = { paraIdx: created.paraIdx, controlIdx: 0, cellIdx: 0 };
      const { pending, batches } = manager(document, enabled);
      const result = pending.insertText('claude', {
        sectionIdx: 0, paraIdx: 0, charOffset: 0, cell,
      }, 'first\n😀 second\nthird');
      assert.equal(batches(), 0);
      pendingSets.push({ pending, id: result.changeSetId });
    }
    assertSameDocument(baseline, batched);
    for (const { pending, id } of pendingSets) pending.reject(id);
    assertSameDocument(baseline, batched);
  } finally {
    baseline.free();
    batched.free();
  }
});


test('batched body preview, approval, undo, and redo match unbatched snapshot history', () => {
  const bytes = readFileSync(new URL('../../samples/hwpx/business_overview.hwpx', import.meta.url));
  const baseline = new HwpDocument(bytes);
  const batched = new HwpDocument(bytes);
  try {
    const histories = [[baseline, false], [batched, true]].map(([document, enabled]) => {
      const doc = document as Document;
      const history = manager(doc, enabled as boolean);
      const paraIdx = doc.getParagraphCount(0) - 1;
      const result = history.pending.insertText('claude', {
        sectionIdx: 0, paraIdx, charOffset: doc.getParagraphLength(0, paraIdx),
      }, 'first line\n😀 second line\nthird line');
      return { ...history, id: result.changeSetId };
    });
    assertSameDocument(baseline, batched);
    for (const history of histories) assert.equal(history.pending.approve(history.id), true);
    assertSameDocument(baseline, batched);
    for (const history of histories) {
      assert.equal(history.commands.length, 1);
      history.commands[0].undo(history.bridge as never);
    }
    assertSameDocument(baseline, batched);
    for (const history of histories) history.commands[0].execute(history.bridge as never);
    assertSameDocument(baseline, batched);
  } finally {
    baseline.free();
    batched.free();
  }
});
