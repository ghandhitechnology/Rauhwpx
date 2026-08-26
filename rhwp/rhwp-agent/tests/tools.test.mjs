// MCP 도구 정의 계약 테스트 — tools.mjs 만 임포트한다
// (mcp-stdio.mjs 를 임포트하면 stdio 서버가 뜨므로 절대 임포트하지 않는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TOOL_CATEGORIES,
  TOOL_CLASSIFICATIONS,
  TOOL_DEFINITIONS,
  IMPLEMENTATION_PLAN_SHAPE,
  OFFSET_CAVEAT,
  filterToolDefinitions,
  toToolContent,
  toolAnnotations,
} from '../tools.mjs';

const byName = new Map(TOOL_DEFINITIONS.map((d) => [d.name, d]));

test('도구는 정확히 75개, 이름 중복 없음', () => {
  assert.equal(TOOL_DEFINITIONS.length, 75);
  assert.equal(byName.size, TOOL_DEFINITIONS.length, 'duplicate tool names');
});

test('모든 도구가 허용된 카테고리로 명시 분류된다', () => {
  assert.equal(Object.keys(TOOL_CLASSIFICATIONS).length, TOOL_DEFINITIONS.length);
  for (const definition of TOOL_DEFINITIONS) {
    assert.ok(TOOL_CATEGORIES.includes(definition.category), `${definition.name}: invalid category`);
    assert.equal(TOOL_CLASSIFICATIONS[definition.name], definition.category);
  }
});

test('document-write annotations stay non-destructive so safe mode can edit', () => {
  assert.deepEqual(toolAnnotations('document-read'), {
    readOnlyHint: true, destructiveHint: false, openWorldHint: false,
  });
  assert.deepEqual(toolAnnotations('document-write'), {
    readOnlyHint: false, destructiveHint: false, openWorldHint: false,
  });
  assert.deepEqual(toolAnnotations('download-write'), {
    readOnlyHint: false, destructiveHint: true, openWorldHint: true,
  });
  assert.deepEqual(toolAnnotations('artifact-write'), {
    readOnlyHint: false, destructiveHint: false, openWorldHint: false,
  });
  const mcpStdio = readFileSync(fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url)), 'utf8');
  assert.match(mcpStdio, /annotations: toolAnnotations\(def\.category\)/);
  assert.doesNotMatch(mcpStdio, /destructiveHint:\s*true/);
});

test('도구 프로필은 direct 호환성과 planning/implementing 가시성을 지킨다', () => {
  const direct = new Set(filterToolDefinitions('direct').map((definition) => definition.name));
  assert.equal(direct.size, 65);
  assert.ok(direct.has('read_agent_instructions'));
  assert.ok(direct.has('update_agent_instructions'));
  assert.ok(direct.has('materialize_document_snapshot'));
  assert.ok(direct.has('publish_artifact'));
  assert.ok(direct.has('apply_edits'));
  assert.ok(direct.has('insert_text'));
  assert.ok(direct.has('get_engine_edit_capabilities'));
  assert.ok(direct.has('apply_engine_edits'));
  assert.ok(direct.has('prepare_engine_edit_session'));
  assert.ok(direct.has('replace_all'));
  assert.ok(direct.has('insert_footnote'));
  assert.ok(direct.has('set_bookmark'));
  assert.ok(direct.has('get_outline'));
  assert.ok(direct.has('get_table_properties'));
  assert.ok(direct.has('search_reference_files'));
  assert.ok(direct.has('template_get_structure'));
  assert.ok(direct.has('template_insert_block'));
  assert.ok(!direct.has('download_file'));
  assert.ok(!direct.has('present_implementation_plan'));
  assert.ok(direct.has('delegate_copy_layout'));
  assert.ok(direct.has('register_copy_layout_template'));
  assert.ok(!direct.has('complete_copy_layout_job'));
  assert.match(byName.get('delegate_copy_layout')?.description ?? '', /do not call wait_agent\/list_agents or poll/);
  assert.match(byName.get('delegate_copy_layout')?.description ?? '', /hub will start a new owning-chat turn/);

  const planning = new Set(filterToolDefinitions('planning').map((definition) => definition.name));
  assert.ok(planning.has('get_structure'));
  assert.ok(planning.has('download_file'));
  assert.ok(planning.has('browserbase_act'));
  assert.ok(planning.has('present_implementation_plan'));
  assert.ok(planning.has('read_reference_chunk'));
  assert.ok(planning.has('read_reference_image'));
  assert.ok(planning.has('read_agent_instructions'));
  assert.ok(!planning.has('update_agent_instructions'));
  assert.ok(!planning.has('insert_text'));

  const implementing = new Set(filterToolDefinitions('implementing').map((definition) => definition.name));
  assert.equal(implementing.size, TOOL_DEFINITIONS.length - 3);
  assert.ok(implementing.has('insert_text'));
  assert.ok(implementing.has('download_file'));
  assert.ok(implementing.has('browserbase_act'));
  assert.ok(!implementing.has('present_implementation_plan'));

  const worker = filterToolDefinitions('copy-layout-worker').map((definition) => definition.name);
  assert.deepEqual(worker, [
    'read_product_skill',
    'get_document_info',
    'materialize_document_snapshot',
    'render_page',
    'publish_artifact',
    'update_copy_layout_job',
    'complete_copy_layout_job',
  ]);
});

test('app-only AGENTS.md tools separate reads from bounded revision-checked writes', () => {
  const read = byName.get('read_agent_instructions');
  const update = byName.get('update_agent_instructions');
  assert.equal(read?.category, 'instruction-read');
  assert.equal(update?.category, 'instruction-write');
  assert.deepEqual(Object.keys(read?.shape ?? {}), []);
  assert.ok(update?.shape.content.safeParse('keep answers concise').success);
  assert.ok(!update?.shape.content.safeParse('x'.repeat(30_001)).success);
  assert.ok(update?.shape.expectedRevision.safeParse(1).success);
  assert.ok(!update?.shape.expectedRevision.safeParse(0).success);
  assert.match(update?.description ?? '', /one-off task details/);
  assert.match(update?.description ?? '', /not persisted until the user explicitly confirms/);
  assert.match(update?.description ?? '', /Settings > 지시/);
  assert.match(read?.description ?? '', /outside this app/);
});

test('template tools separate read-only inspection from pending document writes', () => {
  for (const name of [
    'template_get_structure', 'template_get_text_range', 'template_get_para_format',
    'template_get_char_format', 'template_list_styles', 'template_get_page_layout', 'template_render_page',
  ]) assert.equal(byName.get(name)?.category, 'template-read');
  for (const name of ['template_apply_section_layout', 'template_apply_paragraph_format', 'template_insert_block']) {
    assert.equal(byName.get(name)?.category, 'document-write');
  }
});

test('present_implementation_plan 스키마가 완전한 구조를 강제한다', () => {
  const definition = byName.get('present_implementation_plan');
  assert.deepEqual(Object.keys(definition.shape), [
    'goal', 'title', 'summary', 'assumptions', 'decisions', 'steps',
    'files', 'validation', 'risks', 'exclusions',
  ]);
  assert.equal(definition.shape, IMPLEMENTATION_PLAN_SHAPE);
  const valid = {
    goal: 'Ship planning',
    title: 'Planning workflow',
    summary: 'Add an authoritative state machine.',
    assumptions: [],
    decisions: ['Hub owns state because one authority prevents drift'],
    steps: [{ title: 'Add state', details: 'Implement transitions.', files: ['server.mjs'] }],
    files: ['server.mjs'],
    validation: ['Run npm test'],
    risks: ['Stale calls are rejected with capability epochs'],
    exclusions: ['Provider backend implementation'],
  };
  for (const [key, schema] of Object.entries(IMPLEMENTATION_PLAN_SHAPE)) {
    assert.ok(schema.safeParse(valid[key]).success, `schema rejected ${key}`);
  }
  assert.ok(!IMPLEMENTATION_PLAN_SHAPE.steps.safeParse([]).success);
});

test('핵심 시맨틱 쓰기 도구 5개가 모두 있다', () => {
  for (const name of ['apply_list', 'list_numberings', 'get_para_format', 'get_char_format', 'verify_changes']) {
    assert.ok(byName.has(name), `missing tool: ${name}`);
  }
});

test('full engine edit tools expose a bounded autonomous batch contract', () => {
  const catalog = byName.get('get_engine_edit_capabilities');
  const apply = byName.get('apply_engine_edits');
  const prepare = byName.get('prepare_engine_edit_session');
  assert.equal(catalog.category, 'document-read');
  assert.equal(apply.category, 'document-write');
  assert.equal(prepare.category, 'document-write');
  assert.ok(apply.shape.operations.safeParse([{ method: 'setPageDef', args: [0, {}] }]).success);
  assert.ok(!apply.shape.operations.safeParse([]).success);
  assert.ok(!apply.shape.operations.safeParse(Array.from({ length: 33 }, () => ({ method: 'x', args: [] }))).success);
  assert.match(apply.description, /one atomic/i);
  assert.match(apply.description, /every other method returned by get_engine_edit_capabilities/i);
  assert.match(prepare.description, /capability kind is "session"/i);
});

test('reference tools are read-only and carry bounded schemas', () => {
  for (const name of ['list_reference_files', 'search_reference_files', 'read_reference_chunk', 'read_reference_image']) {
    assert.equal(byName.get(name)?.category, 'reference-read');
  }
  assert.ok(byName.get('search_reference_files').shape.maxResults.safeParse(20).success);
  assert.ok(!byName.get('search_reference_files').shape.maxResults.safeParse(21).success);
  assert.ok(byName.get('read_reference_chunk').shape.maxChars.safeParse(20_000).success);
  assert.ok(!byName.get('read_reference_chunk').shape.chunkId.safeParse('../secret').success);
});

test('document snapshots are a read-only, argument-free current-document export', () => {
  const snapshot = byName.get('materialize_document_snapshot');
  assert.equal(snapshot?.category, 'document-read');
  assert.deepEqual(Object.keys(snapshot?.shape ?? {}), []);
  assert.match(snapshot?.description ?? '', /does not require the user to save/i);
});

test('generated artifacts are publishable in direct and implementing modes, but not planning', () => {
  assert.equal(byName.get('publish_artifact')?.category, 'artifact-write');
  assert.ok(filterToolDefinitions('direct').some((definition) => definition.name === 'publish_artifact'));
  assert.ok(filterToolDefinitions('implementing').some((definition) => definition.name === 'publish_artifact'));
  assert.ok(!filterToolDefinitions('planning').some((definition) => definition.name === 'publish_artifact'));
});

test('copy-layout completion schema makes privacy and readability hard gates', () => {
  const definition = byName.get('complete_copy_layout_job');
  const valid = {
    jobId: '00000000-0000-4000-8000-000000000000',
    outcome: 'succeeded',
    sourceDocumentId: 'document-1',
    sourceDigest: 'digest-1',
    artifactId: 'artifact_1234567890',
    quality: 'best_effort',
    summary: '안전한 후보가 준비됐지만 페이지 수가 다릅니다.',
    warnings: ['페이지 수가 2쪽에서 3쪽으로 달라졌습니다.'],
    counts: {
      keptText: 10, removedText: 2, replacedText: 1, resetControls: 1,
      clearedMarks: 1, keptMedia: 1, removedMedia: 2, iterations: 3,
    },
    preview: {
      representativePages: [0, 1, 2], sourcePageCount: 2, outputPageCount: 3,
      outputSectionCount: 1, renderCompared: true, geometryMatch: false,
      safetyVerified: true, readabilityVerified: true, stoppedReason: 'bounded-no-improvement',
    },
  };
  assert.doesNotThrow(() => definition.validate(valid));
  assert.throws(() => definition.validate({
    ...valid,
    preview: { ...valid.preview, safetyVerified: false },
  }), /safety and readability verification/);
  assert.throws(() => definition.validate({
    ...valid,
    preview: { ...valid.preview, stoppedReason: 'hard-failure' },
  }), /cannot use hard-failure/);
  assert.throws(() => definition.validate({
    ...valid,
    preview: { ...valid.preview, renderCompared: false },
  }), /representative render comparison/);
  assert.throws(() => definition.validate({
    ...valid,
    warnings: [],
  }), /fidelity mismatches require/);
  assert.throws(() => definition.validate({
    ...valid,
    quality: 'verified',
  }), /bounded-no-improvement completion must use best_effort/);
  assert.throws(() => definition.validate({
    ...valid,
    outcome: 'failed',
  }), /must not publish/);
});

test('cell 파라미터를 받는 모든 도구에 조립 방법 안내가 있다', () => {
  const cellTools = TOOL_DEFINITIONS.filter((d) => d.shape && 'cell' in d.shape);
  assert.ok(cellTools.length >= 10, `expected >= 10 cell-taking tools, got ${cellTools.length}`);
  for (const d of cellTools) {
    const desc = d.shape.cell?._def?.description ?? '';
    assert.ok(desc.length > 0, `${d.name}: cell param has no description`);
    // get_structure 의 셀 항목에는 paraIdx/controlIdx 가 없으므로 테이블 항목 것과 조립해야 한다는 안내
    assert.match(desc, /paraIdx\/controlIdx/, `${d.name}: cell desc missing paraIdx/controlIdx assembly note`);
    assert.match(desc, /cellIdx/, `${d.name}: cell desc missing cellIdx`);
    assert.match(desc, /find_text/, `${d.name}: cell desc missing find_text verbatim note`);
  }
});

test('charOffset 계열 도구 전부에 OFFSET_CAVEAT 가 붙어 있다', () => {
  const expected = [
    'insert_text', 'delete_range', 'replace_range', 'apply_char_format',
    'create_table', 'insert_image', 'insert_equation', 'insert_chart',
  ];
  for (const name of expected) {
    const def = byName.get(name);
    assert.ok(def, `missing tool: ${name}`);
    assert.ok(def.description.includes(OFFSET_CAVEAT), `${name}: missing OFFSET_CAVEAT`);
  }
});

test('verify_changes 설명에 셀프체크 지시와 라이브 미리보기 안내가 있다', () => {
  const desc = byName.get('verify_changes').description;
  assert.match(desc, /self-check/i);
  // 삭제/교체는 라이브 미리보기에 즉시 반영 — 재삽입 금지 안내
  assert.match(desc, /live preview/);
  assert.match(desc, /do NOT re-insert/);
  assert.match(desc, /includeImage/);
  // 응답의 실제 모양(describeChangeSet)은 per-op kind + applied 불리언이다
  assert.match(desc, /applied flag/);
});

test('apply_list 설명에 진짜 목록/리터럴 금지/가나다 기본값/bulletChar 안내가 있다', () => {
  const desc = byName.get('apply_list').description;
  assert.match(desc, /REAL HWP list/);
  assert.match(desc, /never type literal/i);
  assert.match(desc, /hanging indent/i);
  assert.match(desc, /가,나,다/);
  assert.match(desc, /bulletChar/);
});

test('apply_list 스키마: format enum·level 기본값 0·범위', () => {
  const { shape, validate } = byName.get('apply_list');
  // format 은 optional enum — bulletChar 글머리표 목록에는 필요 없다
  const formats = shape.format._def.innerType._def.values;
  assert.deepEqual(formats, ['1.', '1)', '(1)', '①', 'a.', 'a)', 'A.', 'A)', 'I.', 'i.', 'i)', '가.', 'ㄱ.']);
  for (const key of ['expectedRevision', 'sectionIdx', 'startParaIdx', 'endParaIdx']) {
    assert.ok(key in shape, `apply_list missing ${key}`);
  }
  for (const key of ['format', 'level', 'startNumber', 'bulletChar']) {
    assert.ok(key in shape, `apply_list missing optional ${key}`);
  }
  // 번호 목록인데 format 이 없으면 즉시 실패, bulletChar 가 있으면 format 생략 가능
  assert.throws(() => validate({ }), /format/);
  assert.doesNotThrow(() => validate({ format: '1.' }));
  assert.doesNotThrow(() => validate({ bulletChar: '•' }));
});

test('get_char_format 설명에 서식 상속 규칙이 있다', () => {
  const desc = byName.get('get_char_format').description;
  assert.match(desc, /INHERITANCE RULE/);
  assert.match(desc, /character BEFORE the insertion point/);
  assert.match(desc, /replace_range/);
});

test('render_page 에 format/scale 이 추가됐다', () => {
  const { shape } = byName.get('render_page');
  assert.ok('format' in shape && 'scale' in shape, 'render_page missing format/scale');
  // .default(x).optional() 형태라 undefined 는 그대로 통과하고, 기본값은 스키마 메타에 든다
  assert.equal(shape.format.parse(undefined), undefined);
  assert.equal(shape.format._def.innerType._def.defaultValue(), 'svg');
  assert.equal(shape.scale._def.innerType._def.defaultValue(), 2);
  assert.ok(shape.format.safeParse('png').success);
  assert.ok(!shape.format.safeParse('pdf').success);
  assert.ok(shape.scale.safeParse(0.5).success && shape.scale.safeParse(3).success);
  assert.ok(!shape.scale.safeParse(0.4).success && !shape.scale.safeParse(3.1).success);
});

test('apply_para_format 에 목록 속성(headType/numberingId/paraLevel/bulletChar)이 추가됐다', () => {
  const { shape } = byName.get('apply_para_format');
  for (const key of ['headType', 'numberingId', 'paraLevel', 'bulletChar']) {
    assert.ok(key in shape, `apply_para_format missing ${key}`);
  }
});

test('toToolContent: image 필드가 있으면 image 블록 + 나머지 JSON', () => {
  const blocks = toToolContent({ image: { data: 'aGVsbG8=', mimeType: 'image/png' }, revision: 7, pages: [2] });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  assert.equal(blocks[1].type, 'text');
  assert.deepEqual(JSON.parse(blocks[1].text), { revision: 7, pages: [2] });
});

test('toToolContent: image 가 없거나 모양이 이상하면 text 만', () => {
  const plain = toToolContent({ revision: 1 });
  assert.deepEqual(plain, [{ type: 'text', text: '{"revision":1}' }]);
  const malformed = toToolContent({ image: { data: 123 }, revision: 1 });
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].type, 'text');
});

test('toToolContent: proxied MCP content blocks stay intact', () => {
  const content = [{ type: 'text', text: '{"success":true}' }];
  assert.equal(toToolContent({ mcpContent: content }), content);
});

test('create_table: rows+cols 나 cells 둘 중 하나는 필수', () => {
  const { validate } = byName.get('create_table');
  assert.ok(validate, 'create_table has no validate hook');
  assert.throws(() => validate({}), (e) => e.code === 'INVALID_ARGS' && /rows\+cols/.test(e.message));
  assert.throws(() => validate({ rows: 3 }), (e) => e.code === 'INVALID_ARGS');
  validate({ rows: 3, cols: 2 }); // 통과
  validate({ cells: [['a', 'b'], ['c', 'd']] }); // 통과
});

test('delete_table: 스키마는 주소 네 값이 필수이고 document-write 다', () => {
  const def = byName.get('delete_table');
  assert.ok(def, 'missing tool: delete_table');
  assert.equal(def.category, 'document-write');
  assert.match(def.description, /get_structure tables\[\]/);
  assert.match(def.description, /PENDING_DESTRUCTIVE_OP/);
  assert.match(def.description, /mark-only/i);
  for (const key of ['expectedRevision', 'sectionIdx', 'paraIdx', 'controlIdx']) {
    assert.ok(key in def.shape, `delete_table missing ${key}`);
  }
  assert.ok(def.shape.sectionIdx.safeParse(0).success);
  assert.ok(!def.shape.sectionIdx.safeParse(-1).success);
  assert.ok(!def.shape.controlIdx.safeParse(undefined).success);
});

test('edit_table: op 별 필수 파라미터를 이름 붙여 즉시 실패', () => {
  const { validate } = byName.get('edit_table');
  assert.ok(validate, 'edit_table has no validate hook');
  assert.throws(() => validate({ op: 'insert_row' }), (e) => e.code === 'INVALID_ARGS' && /rowIdx/.test(e.message));
  assert.throws(() => validate({ op: 'insert_col' }), (e) => e.code === 'INVALID_ARGS' && /colIdx/.test(e.message));
  assert.throws(
    () => validate({ op: 'merge_cells', startRow: 0, startCol: 0 }),
    (e) => e.code === 'INVALID_ARGS' && /endRow/.test(e.message) && /endCol/.test(e.message)
  );
  assert.throws(() => validate({ op: 'set_cell_props', cellIdx: 0 }), (e) => e.code === 'INVALID_ARGS' && /props/.test(e.message));
  validate({ op: 'insert_row', rowIdx: 0 }); // 통과
  assert.throws(
    () => validate({ op: 'split_cell', rowIdx: 0, colIdx: 0, splitRows: 2 }),
    (e) => e.code === 'INVALID_ARGS' && /splitCols/.test(e.message),
  );
  validate({ op: 'merge_cells', startRow: 0, startCol: 0, endRow: 1, endCol: 1 }); // 통과
  validate({ op: 'split_cell', rowIdx: 0, colIdx: 0, splitRows: 1, splitCols: 2 }); // 통과
  validate({ op: 'set_table_props', props: { horizontalAlign: 'center' } }); // 통과
  assert.throws(
    () => validate({ op: 'set_column_widths' }),
    (e) => e.code === 'INVALID_ARGS' && /columnWidthsMm/.test(e.message),
  );
  assert.throws(
    () => validate({ op: 'set_zone_borders', startCell: { row: 0, col: 0 } }),
    (e) => e.code === 'INVALID_ARGS' && /endCell/.test(e.message),
  );
  assert.throws(
    () => validate({ op: 'apply_formula', row: 3, col: 1 }),
    (e) => e.code === 'INVALID_ARGS' && /formula/.test(e.message),
  );
  assert.throws(() => validate({ op: 'set_caption' }), (e) => e.code === 'INVALID_ARGS' && /text/.test(e.message));
  validate({ op: 'set_column_widths', columnWidthsMm: [30, 40] }); // 통과
  validate({ op: 'fit_to_page' }); // 통과 (추가 인자 없음)
  validate({ op: 'set_zone_borders', startCell: { row: 0, col: 0 }, endCell: { row: 2, col: 3 } }); // 통과
  validate({ op: 'apply_formula', row: 3, col: 1, formula: '=SUM(A1:A3)' }); // 통과
  validate({ op: 'set_caption', text: '분기별 매출' }); // 통과
});

test('get_table_layout: 표의 쪽별 배치와 넘침 여부를 읽는 읽기 전용 도구', () => {
  const layout = byName.get('get_table_layout');
  assert.ok(layout, 'missing tool: get_table_layout');
  assert.equal(layout.category, 'document-read');
  for (const key of ['sectionIdx', 'paraIdx', 'controlIdx']) {
    assert.ok(key in layout.shape, `get_table_layout missing ${key}`);
  }
  assert.ok(layout.shape.sectionIdx.safeParse(undefined).success, 'sectionIdx must be optional (default 0)');
  assert.ok(!layout.shape.paraIdx.safeParse(undefined).success);
  assert.match(layout.description, /overflowsBody/);
  assert.match(layout.description, /pageBreak/);

  const edit = byName.get('edit_table');
  const values = edit.shape.op._def.values;
  for (const op of ['set_column_widths', 'fit_to_page', 'set_zone_borders', 'apply_formula', 'set_caption']) {
    assert.ok(values.includes(op), `edit_table op enum missing ${op}`);
    assert.match(edit.description, new RegExp(op));
  }
});

test('get_table_properties reads optional cell state and edit_table documents object placement', () => {
  const read = byName.get('get_table_properties');
  assert.ok(read, 'missing tool: get_table_properties');
  assert.equal(read.category, 'document-read');
  for (const key of ['sectionIdx', 'paraIdx', 'controlIdx', 'cellIdx']) {
    assert.ok(key in read.shape, `get_table_properties missing ${key}`);
  }
  assert.match(read.description, /object placement/i);

  const edit = byName.get('edit_table');
  assert.match(edit.description, /EASY CENTERING/);
  assert.match(edit.description, /horizontalAlign/);
  assert.match(edit.description, /split_cell/);
  const values = edit.shape.op._def.values;
  assert.ok(values.includes('split_cell'));
});
