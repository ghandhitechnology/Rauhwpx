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

test('도구는 정확히 48개, 이름 중복 없음', () => {
  assert.equal(TOOL_DEFINITIONS.length, 48);
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
  const mcpStdio = readFileSync(fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url)), 'utf8');
  assert.match(mcpStdio, /annotations: toolAnnotations\(def\.category\)/);
  assert.doesNotMatch(mcpStdio, /destructiveHint:\s*true/);
});

test('도구 프로필은 direct 호환성과 planning/implementing 가시성을 지킨다', () => {
  const direct = new Set(filterToolDefinitions('direct').map((definition) => definition.name));
  assert.equal(direct.size, 40);
  assert.ok(direct.has('insert_text'));
  assert.ok(direct.has('replace_all'));
  assert.ok(direct.has('insert_footnote'));
  assert.ok(direct.has('set_bookmark'));
  assert.ok(direct.has('get_outline'));
  assert.ok(direct.has('search_reference_files'));
  assert.ok(!direct.has('download_file'));
  assert.ok(!direct.has('present_implementation_plan'));

  const planning = new Set(filterToolDefinitions('planning').map((definition) => definition.name));
  assert.ok(planning.has('get_structure'));
  assert.ok(planning.has('download_file'));
  assert.ok(planning.has('browserbase_act'));
  assert.ok(planning.has('present_implementation_plan'));
  assert.ok(planning.has('read_reference_chunk'));
  assert.ok(!planning.has('insert_text'));

  const implementing = new Set(filterToolDefinitions('implementing').map((definition) => definition.name));
  assert.equal(implementing.size, TOOL_DEFINITIONS.length - 1);
  assert.ok(implementing.has('insert_text'));
  assert.ok(implementing.has('download_file'));
  assert.ok(implementing.has('browserbase_act'));
  assert.ok(!implementing.has('present_implementation_plan'));
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

test('신규 도구 5개가 모두 있다', () => {
  for (const name of ['apply_list', 'list_numberings', 'get_para_format', 'get_char_format', 'verify_changes']) {
    assert.ok(byName.has(name), `missing tool: ${name}`);
  }
});

test('reference tools are read-only and carry bounded schemas', () => {
  for (const name of ['list_reference_files', 'search_reference_files', 'read_reference_chunk']) {
    assert.equal(byName.get(name)?.category, 'reference-read');
  }
  assert.ok(byName.get('search_reference_files').shape.maxResults.safeParse(20).success);
  assert.ok(!byName.get('search_reference_files').shape.maxResults.safeParse(21).success);
  assert.ok(byName.get('read_reference_chunk').shape.maxChars.safeParse(20_000).success);
  assert.ok(!byName.get('read_reference_chunk').shape.chunkId.safeParse('../secret').success);
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

test('verify_changes 설명에 셀프체크 지시와 취소선 안내가 있다', () => {
  const desc = byName.get('verify_changes').description;
  assert.match(desc, /self-check/i);
  assert.match(desc, /struck-through/);
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
  validate({ op: 'merge_cells', startRow: 0, startCol: 0, endRow: 1, endCol: 1 }); // 통과
  validate({ op: 'set_table_props', props: { repeatHeader: true } }); // 통과
});
