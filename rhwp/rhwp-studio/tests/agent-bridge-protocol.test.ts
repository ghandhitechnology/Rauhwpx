import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('RevisionTracker: 저장(dirty→false)은 bump하지 않고, dirty→true는 bump한다', async () => {
  const bus = new EventBus();
  const tracker = new RevisionTracker(bus);
  for (const reason of ['save', 'save-as', 'host-save']) {
    bus.emit('document-dirty-changed', { dirty: false, reason });
    assert.equal(tracker.revision, 1, `${reason} 는 bump 하지 않는다`);
    await microtask();
  }
  bus.emit('document-dirty-changed', { dirty: true, reason: 'edit' });
  assert.equal(tracker.revision, 2);
  tracker.dispose();
});

test('RevisionTracker: 문서 로드/교체(dirty→false, 저장 아님)는 반드시 bump한다', async () => {
  // 로드 경로는 document-mutated/changed 를 발행하지 않는다 — 이 전이가 유일한
  // 신호이므로 놓치면 이전 문서의 expectedRevision 이 새 문서에 통과한다.
  const bus = new EventBus();
  const tracker = new RevisionTracker(bus);
  bus.emit('document-dirty-changed', { dirty: false, reason: 'document-initialized' });
  assert.equal(tracker.revision, 2);
  await microtask();
  // 이유가 없는 미지의 false 전이도 안전하게 bump 한다
  bus.emit('document-dirty-changed', { dirty: false });
  assert.equal(tracker.revision, 3);
  tracker.dispose();
});

test('RevisionTracker: holdDuring 창 안의 이벤트는 bump하지 않는다', async () => {
  const bus = new EventBus();
  const tracker = new RevisionTracker(bus);
  tracker.holdDuring(() => {
    bus.emit('document-mutated', 'agent-preview');
    bus.emit('document-changed');
  });
  assert.equal(tracker.revision, 1);
  await microtask();
  // 창 밖에서는 정상 bump — 억제가 누적되지 않는다
  bus.emit('document-mutated', 'test');
  assert.equal(tracker.revision, 2);
  tracker.dispose();
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
    copySelection: () => '{"ok":true}',
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
    hasTemplateMutation: () => false,
    runAtomicBatch: <T,>(fn: () => T): T => {
      calls.push({ method: 'runAtomicBatch', args: [] });
      return fn();
    },
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
  return { executor, calls, bus, revision, wasm, pending };
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
    'apply_edits',
    'apply_engine_edits',
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
    'prepare_engine_edit_session',
    'replace_all',
    'replace_range',
    'set_bookmark',
    'set_field_value',
    'set_page_layout',
    'template_apply_paragraph_format',
    'template_apply_section_layout',
    'template_insert_block',
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

test('executor: raw and semantic write modes cannot mix in either order within one turn', async () => {
  const first = makeExecutor();
  first.executor.beginTurn();
  await first.executor.execute('prepare_engine_edit_session', {
    expectedRevision: 1,
    method: 'copySelection',
    args: [0, 0, 0, 0, 1],
  });
  await expectToolError(first.executor.execute('insert_text', {
    expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
  }), 'MIXED_ENGINE_WRITE_MODE');
  first.executor.endTurn();
  await first.executor.execute('insert_text', {
    expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
  });

  const second = makeExecutor();
  second.executor.beginTurn();
  await second.executor.execute('insert_text', {
    expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
  });
  await expectToolError(second.executor.execute('prepare_engine_edit_session', {
    expectedRevision: 2,
    method: 'copySelection',
    args: [0, 0, 0, 0, 1],
  }), 'MIXED_ENGINE_WRITE_MODE');
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

test('executor: structural template previews block ordinary document writes', async () => {
  const { executor, pending, calls } = makeExecutor();
  pending.hasTemplateMutation = () => true;
  await expectToolError(executor.execute('insert_text', {
    expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
  }, 'claude'), 'TEMPLATE_PENDING_CONFLICT');
  assert.deepEqual(calls, []);
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
  // 자기 유발 불일치는 재조회 없이 현재 revision 으로 바로 재시도할 수 있어야 한다
  assert.match(err.message, /expectedRevision=1/);
  assert.match(err.message, /get_text_range/);
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
  assert.equal(r.note, 'staged now as live preview; when the turn ends it is auto-committed (전체 접근) or held for the user’s review and approval (안전). A failed turn rolls it back');
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

test('executor: apply_edits 는 revision 검사 한 번으로 항목들을 원자 배치로 순차 적용한다', async () => {
  const { executor, calls } = makeExecutor([['hello world', 'second para']]);
  const r = (await executor.execute('apply_edits', {
    expectedRevision: 1,
    edits: [
      { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: 0, charOffset: 5, text: ' brave' } },
      {
        tool: 'replace_range',
        args: { sectionIdx: 0, startParaIdx: 1, startCharOffset: 0, endParaIdx: 1, endCharOffset: 6, text: 'third' },
      },
    ],
  }, 'claude')) as any;
  assert.deepEqual(calls.map((c) => c.method), ['runAtomicBatch', 'insertText', 'replaceText']);
  assert.equal(r.applied, 2);
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].tool, 'insert_text');
  assert.equal(r.results[1].tool, 'replace_range');
  // 항목별 revision/note 는 제거된다 — 최상위 값만 유효
  assert.equal(r.results[0].revision, undefined);
  assert.equal(r.results[0].note, undefined);
  assert.ok(Number.isInteger(r.revision) && r.revision > 1);
  assert.ok(r.results[0].insertedRange);
});

test('executor: apply_edits 허용 목록 밖 tool / 잘못된 edits → INVALID_ARGS', async () => {
  const { executor } = makeExecutor([['hello world']]);
  await expectToolError(
    executor.execute('apply_edits', {
      expectedRevision: 1,
      edits: [{ tool: 'apply_engine_edits', args: { operations: [] } }],
    }, 'claude'),
    'INVALID_ARGS',
  );
  await expectToolError(
    executor.execute('apply_edits', { expectedRevision: 1, edits: [] }, 'claude'),
    'INVALID_ARGS',
  );
});

test('executor: apply_edits 항목 실패는 실패 인덱스를 담아 배치 전체 에러가 된다', async () => {
  const { executor } = makeExecutor([['hello world']]);
  const err = await expectToolError(
    executor.execute('apply_edits', {
      expectedRevision: 1,
      edits: [
        { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'ok ' } },
        // 빈 범위 → INVALID_ARGS
        {
          tool: 'replace_range',
          args: { sectionIdx: 0, startParaIdx: 0, startCharOffset: 3, endParaIdx: 0, endCharOffset: 3, text: 'x' },
        },
      ],
    }, 'claude'),
    'INVALID_ARGS',
  );
  assert.match(err.message, /edits\[1\] \(replace_range\)/);
  assert.match(err.message, /rolled back/);
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

test('executor: get_table_properties reports DOC_NOT_LOADED before table lookup', async () => {
  const { executor, wasm } = makeExecutor();
  let tableLookupCalled = false;
  wasm.getSectionCount = () => 0;
  (wasm as any).getTableDimensions = () => { tableLookupCalled = true; throw new Error('unexpected'); };

  await expectToolError(executor.execute('get_table_properties', {
    sectionIdx: 0, paraIdx: 0, controlIdx: 0,
  }, 'claude'), 'DOC_NOT_LOADED');
  assert.equal(tableLookupCalled, false);
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

// ─── agent-setup-progress 프레임 (소스 계약) ────────────────

test('브리지: agent-setup-progress 의 userCode 를 그대로 사이드바로 넘긴다', () => {
  const bridgeSource = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
  const typesSource = readFileSync(new URL('../src/agent/types.ts', import.meta.url), 'utf8');
  assert.match(
    bridgeSource,
    /\.\.\.\(typeof msg\.userCode === 'string' \? \{ userCode: msg\.userCode \} : \{\}\)/,
  );
  // 문자열이 아닌 값은 아예 실리지 않는다 — 필드는 선택 사항으로 남는다.
  assert.match(typesSource, /type: 'agent-setup-progress';[\s\S]*userCode\?: string;/);
});
