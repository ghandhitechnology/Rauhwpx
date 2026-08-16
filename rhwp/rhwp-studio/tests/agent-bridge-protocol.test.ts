import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import {
  AgentToolExecutor,
  DOCUMENT_WRITE_TOOLS,
  isDocumentWriteTool,
} from '../src/agent/tool-executor.ts';
import { AgentToolError } from '../src/agent/types.ts';

function microtask(): Promise<void> {
  return Promise.resolve();
}

test('RevisionTracker: 1에서 시작, 이벤트당 동기 bump', () => {
  const bus = new EventBus();
  const tracker = new RevisionTracker(bus);
  assert.equal(tracker.revision, 1);
  bus.emit('document-mutated', 'test');
  assert.equal(tracker.revision, 2);
  tracker.dispose();
});

test('RevisionTracker: 같은 틱의 동반 이벤트는 dedupe', async () => {
  const bus = new EventBus();
  const tracker = new RevisionTracker(bus);
  bus.emit('document-mutated', 'agent-pending-edit');
  bus.emit('document-changed');
  bus.emit('document-dirty-changed');
  assert.equal(tracker.revision, 2);
  await microtask();
  bus.emit('document-changed');
  assert.equal(tracker.revision, 3);
  tracker.dispose();
});

test('RevisionTracker: dispose 후에는 bump하지 않음', () => {
  const bus = new EventBus();
  const tracker = new RevisionTracker(bus);
  tracker.dispose();
  bus.emit('document-mutated');
  assert.equal(tracker.revision, 1);
});

// ─── AgentToolExecutor (stub deps) ──────────────────────────

function makeExecutor(paragraphs: string[][] = [['hello world', 'second para']]) {
  const bus = new EventBus();
  const revision = new RevisionTracker(bus);
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const wasm = {
    getSectionCount: () => paragraphs.length,
    getParagraphCount: (sec: number) => paragraphs[sec].length,
    getParagraphLength: (sec: number, para: number) => paragraphs[sec][para].length,
    getTextRange: (sec: number, para: number, off: number, count: number) =>
      paragraphs[sec][para].slice(off, off + count),
    get pageCount() { return 3; },
    getSourceFormat: () => 'hwp',
    get documentDigest() { return 'blake3:test'; },
    getFieldList: () => [],
    renderPageSvg: (_page: number) => '<svg/>',
  };
  const pending = {
    insertText: (agent: string, addr: { sectionIdx: number; paraIdx: number; charOffset: number }, text: string) => {
      calls.push({ method: 'insertText', args: [agent, addr, text] });
      bus.emit('document-mutated', 'agent-pending-edit');
      bus.emit('document-changed');
      return {
        changeSetId: 'cs-1',
        insertedRange: {
          sectionIdx: addr.sectionIdx,
          startParaIdx: addr.paraIdx,
          startCharOffset: addr.charOffset,
          endParaIdx: addr.paraIdx,
          endCharOffset: addr.charOffset + text.length,
        },
      };
    },
    markDelete: (agent: string, range: unknown) => {
      calls.push({ method: 'markDelete', args: [agent, range] });
      return { changeSetId: 'cs-1', markedText: 'marked' };
    },
    replaceText: (range: { sectionIdx: number; startParaIdx: number; startCharOffset: number }, text: string, agent: string) => {
      calls.push({ method: 'replaceText', args: [range, text, agent] });
      bus.emit('document-mutated', 'agent-pending-edit');
      bus.emit('document-changed');
      return {
        changeSetId: 'cs-1',
        deletedText: 'marked',
        insertedRange: {
          sectionIdx: range.sectionIdx,
          startParaIdx: range.startParaIdx,
          startCharOffset: range.startCharOffset,
          endParaIdx: range.startParaIdx,
          endCharOffset: range.startCharOffset + text.length,
        },
      };
    },
    applyCharFormat: (agent: string, range: unknown, format: unknown) => {
      calls.push({ method: 'applyCharFormat', args: [agent, range, format] });
      bus.emit('document-mutated', 'agent-pending-edit');
      return { changeSetId: 'cs-1' };
    },
    setFieldValue: (agent: string, name: string, value: string) => {
      calls.push({ method: 'setFieldValue', args: [agent, name, value] });
      bus.emit('document-mutated', 'agent-pending-edit');
      return { changeSetId: 'cs-1', fieldId: 7, oldValue: 'old', newValue: value };
    },
    hasPendingStructureOp: () => false,
  };
  const inputHandler = {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
  };
  const documentState = { isDirty: () => false };
  const executor = new AgentToolExecutor({
    wasm: wasm as any,
    inputHandler: inputHandler as any,
    documentState: documentState as any,
    revision,
    pending: pending as any,
  });
  return { executor, calls, bus, revision };
}

async function expectToolError(p: Promise<unknown>, code: string): Promise<AgentToolError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `AgentToolError 기대, 실제: ${e}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`${code} 오류를 기대했지만 성공함`);
}

test('executor: 알 수 없는 툴 → UNKNOWN_TOOL', async () => {
  const { executor } = makeExecutor();
  await expectToolError(executor.execute('bogus_tool', {}, 'claude'), 'UNKNOWN_TOOL');
});

test('executor: document-write helper covers every mutating tool', () => {
  assert.deepEqual([...DOCUMENT_WRITE_TOOLS].sort(), [
    'apply_char_format',
    'apply_list',
    'apply_para_format',
    'apply_style',
    'create_table',
    'delete_range',
    'delete_table',
    'edit_footnote',
    'edit_header_footer',
    'edit_table',
    'insert_chart',
    'insert_equation',
    'insert_footnote',
    'insert_image',
    'insert_page_break',
    'insert_text',
    'replace_all',
    'replace_range',
    'set_bookmark',
    'set_field_value',
    'set_page_layout',
  ]);
  assert.equal(isDocumentWriteTool('insert_text'), true);
  assert.equal(isDocumentWriteTool('get_structure'), false);
});

test('executor: planning and unknown phases reject every write before mutation', async () => {
  const { executor, calls } = makeExecutor();
  for (const tool of DOCUMENT_WRITE_TOOLS) {
    await expectToolError(executor.execute(tool, {}, 'claude', {
      workflow: 'plan',
      phase: 'planning',
      capabilityEpoch: 4,
      activePhase: 'planning',
      activeCapabilityEpoch: 4,
    }), 'PLAN_MODE_READ_ONLY');
  }
  await expectToolError(executor.execute('insert_text', {}, 'claude', {
    workflow: 'plan',
    phase: 'future-phase',
    capabilityEpoch: 4,
    activePhase: 'implementing',
    activeCapabilityEpoch: 4,
  }), 'PLAN_MODE_READ_ONLY');
  assert.deepEqual(calls, []);
});

test('executor: implementing requires the current capability epoch', async () => {
  const { executor, calls } = makeExecutor();
  await expectToolError(executor.execute('insert_text', {
    expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
  }, 'claude', {
    workflow: 'plan',
    phase: 'implementing',
    capabilityEpoch: 3,
    activePhase: 'implementing',
    activeCapabilityEpoch: 4,
  }), 'STALE_CAPABILITY_EPOCH');
  await expectToolError(executor.execute('insert_text', {
    expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
  }, 'claude', {
    workflow: 'plan',
    phase: 'implementing',
    activePhase: 'implementing',
    activeCapabilityEpoch: 4,
  }), 'STALE_CAPABILITY_EPOCH');
  assert.deepEqual(calls, []);
});

test('executor: planning reads and authorized implementation writes remain available', async () => {
  const { executor, calls } = makeExecutor();
  const structure = await executor.execute('get_structure', {}, 'claude', {
    workflow: 'plan',
    phase: 'planning',
    activePhase: 'planning',
  }) as { revision: number };
  assert.equal(structure.revision, 1);

  await executor.execute('insert_text', {
    expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
  }, 'claude', {
    workflow: 'plan',
    phase: 'implementing',
    capabilityEpoch: 8,
    activePhase: 'implementing',
    activeCapabilityEpoch: 8,
  });
  assert.equal(calls[0]?.method, 'insertText');
});

test('executor: get_structure가 revision/미리보기를 반환', async () => {
  const { executor } = makeExecutor([['hello world', 'second para']]);
  const r = (await executor.execute('get_structure', {}, 'claude')) as any;
  assert.equal(r.revision, 1);
  assert.equal(r.sectionCount, 1);
  assert.equal(r.pageCount, 3);
  assert.equal(r.truncated, false);
  assert.equal(r.sections[0].paragraphs[0].text, 'hello world');
});

test('executor: get_structure maxParagraphs로 잘림', async () => {
  const { executor } = makeExecutor([['a', 'b', 'c']]);
  const r = (await executor.execute('get_structure', { maxParagraphs: 2 }, 'claude')) as any;
  assert.equal(r.truncated, true);
  assert.equal(r.sections[0].paragraphs.length, 2);
});

test('executor: get_text_range는 count를 clamp', async () => {
  const { executor } = makeExecutor([['hello world']]);
  const r = (await executor.execute(
    'get_text_range',
    { sectionIdx: 0, paraIdx: 0, charOffset: 6, count: 999 },
    'claude',
  )) as any;
  assert.equal(r.text, 'world');
  assert.equal(r.paraLength, 11);
});

test('executor: 주소 범위 밖 → INVALID_ARGS', async () => {
  const { executor } = makeExecutor([['hello']]);
  await expectToolError(
    executor.execute('get_text_range', { sectionIdx: 0, paraIdx: 5 }, 'claude'),
    'INVALID_ARGS',
  );
  await expectToolError(
    executor.execute('get_text_range', { sectionIdx: 0, paraIdx: 0, charOffset: 6 }, 'claude'),
    'INVALID_ARGS',
  );
});

test('executor: find_text가 대소문자 무시 매치 + context 반환', async () => {
  const { executor } = makeExecutor([['Hello World', 'world war world']]);
  const r = (await executor.execute('find_text', { query: 'WORLD' }, 'claude')) as any;
  assert.equal(r.matches.length, 3);
  assert.deepEqual(
    r.matches.map((m: any) => [m.paraIdx, m.charOffset]),
    [[0, 6], [1, 0], [1, 10]],
  );
  assert.equal(r.truncated, false);
});

test('executor: write 툴은 expectedRevision 필수', async () => {
  const { executor } = makeExecutor();
  await expectToolError(
    executor.execute('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x' }, 'claude'),
    'INVALID_ARGS',
  );
});

test('executor: revision 불일치 → REVISION_MISMATCH (actionable 메시지)', async () => {
  const { executor } = makeExecutor();
  const err = await expectToolError(
    executor.execute('insert_text', { expectedRevision: 99, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x' }, 'claude'),
    'REVISION_MISMATCH',
  );
  assert.match(err.message, /revision 1/);
  assert.match(err.message, /expected 99/);
  assert.match(err.message, /get_structure/);
});

test('executor: insert_text는 pending에 위임하고 새 revision을 반환', async () => {
  const { executor, calls } = makeExecutor([['hello world']]);
  const r = (await executor.execute(
    'insert_text',
    { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 5, text: ' brave' },
    'codex',
  )) as any;
  assert.equal(calls[0].method, 'insertText');
  assert.equal(calls[0].args[0], 'codex');
  assert.equal(r.changeSetId, 'cs-1');
  assert.equal(r.revision, 2); // 뮤테이션 이벤트가 동기 bump → 응답은 새 revision
  assert.deepEqual(r.insertedRange, {
    startParaIdx: 0, startCharOffset: 5, endParaIdx: 0, endCharOffset: 11,
  });
  assert.equal(r.note, 'pending until user approves in the sidebar');
});

test('executor: delete_range 빈 범위 → INVALID_ARGS', async () => {
  const { executor } = makeExecutor([['hello world']]);
  await expectToolError(
    executor.execute('delete_range', {
      expectedRevision: 1, sectionIdx: 0,
      startParaIdx: 0, startCharOffset: 3, endParaIdx: 0, endCharOffset: 3,
    }, 'claude'),
    'INVALID_ARGS',
  );
});

test('executor: replace_range = 원자적 pending.replaceText 위임', async () => {
  const { executor, calls } = makeExecutor([['hello world']]);
  const r = (await executor.execute('replace_range', {
    expectedRevision: 1, sectionIdx: 0,
    startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 5, text: 'goodbye',
  }, 'claude')) as any;
  // markDelete + insertText 조합이 아니라 단일 원자적 op 이다
  assert.deepEqual(calls.map((c) => c.method), ['replaceText']);
  assert.deepEqual(calls[0].args[0], {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 5,
  });
  assert.equal(calls[0].args[1], 'goodbye');
  assert.equal(calls[0].args[2], 'claude');
  assert.equal(r.changeSetId, 'cs-1');
  assert.deepEqual(r.insertedRange, {
    startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 7,
  });
  assert.equal(r.revision, 2);
  assert.equal(typeof r.postEdit, 'string');
});

test('executor: apply_char_format은 서식 키 1개 이상 필요, fontSizePt → pt*100', async () => {
  const { executor, calls } = makeExecutor([['hello world']]);
  await expectToolError(
    executor.execute('apply_char_format', {
      expectedRevision: 1, sectionIdx: 0, paraIdx: 0, startOffset: 0, endOffset: 5,
    }, 'claude'),
    'INVALID_ARGS',
  );
  const r = (await executor.execute('apply_char_format', {
    expectedRevision: 1, sectionIdx: 0, paraIdx: 0, startOffset: 0, endOffset: 5,
    bold: true, fontSizePt: 12.5, textColor: '#FF0000',
  }, 'claude')) as any;
  assert.equal(r.applied, true);
  assert.deepEqual(calls[0].args[2], { bold: true, fontSize: 1250, textColor: '#FF0000' });
});

test('executor: apply_char_format 잘못된 textColor → INVALID_ARGS', async () => {
  const { executor } = makeExecutor([['hello world']]);
  await expectToolError(
    executor.execute('apply_char_format', {
      expectedRevision: 1, sectionIdx: 0, paraIdx: 0, startOffset: 0, endOffset: 5, textColor: 'red',
    }, 'claude'),
    'INVALID_ARGS',
  );
});

test('executor: set_field_value 응답 형태', async () => {
  const { executor } = makeExecutor();
  const r = (await executor.execute('set_field_value', {
    expectedRevision: 1, name: 'title', value: 'New Title',
  }, 'claude')) as any;
  assert.equal(r.fieldId, 7);
  assert.equal(r.oldValue, 'old');
  assert.equal(r.newValue, 'New Title');
  assert.equal(r.revision, 2);
});

test('executor: render_page 범위 검증 + RESULT_TOO_LARGE 대신 정상 SVG', async () => {
  const { executor } = makeExecutor();
  const r = (await executor.execute('render_page', { pageIndex: 0 }, 'claude')) as any;
  assert.equal(r.svg, '<svg/>');
  await expectToolError(executor.execute('render_page', { pageIndex: 3 }, 'claude'), 'INVALID_ARGS');
});

test('executor: wasm throw("문서가 로드되지 않았습니다") → DOC_NOT_LOADED', async () => {
  const bus = new EventBus();
  const revision = new RevisionTracker(bus);
  const throwingWasm = {
    getSectionCount: () => 1,
    getParagraphCount: () => { throw new Error('문서가 로드되지 않았습니다'); },
  };
  const ex = new AgentToolExecutor({
    wasm: throwingWasm as any,
    inputHandler: {} as any,
    documentState: {} as any,
    revision,
    pending: {} as any,
  });
  await expectToolError(ex.execute('get_text_range', { sectionIdx: 0, paraIdx: 0 }, 'claude'), 'DOC_NOT_LOADED');
});
