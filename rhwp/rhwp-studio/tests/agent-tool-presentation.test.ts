import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRESENTED_TOOL_NAMES,
  baseToolName,
  parseResultPreview,
  presentToolCall,
  presentToolResult,
  summarizeActivity,
} from '../src/ui/agent-sidebar/tool-presentation.ts';

// 허브 도구 목록 + 병렬로 들어오는 도구 — 새 도구가 표시 규칙 없이 원래 이름으로 새지 않게 막는다.
const { TOOL_DEFINITIONS } = await import('../../rhwp-agent/tools.mjs') as { TOOL_DEFINITIONS: Array<{ name: string }> };

test('허브의 모든 도구와 새 개체 도구에 표시 규칙이 있다', () => {
  const presented = new Set(PRESENTED_TOOL_NAMES);
  const missing = [...TOOL_DEFINITIONS.map((tool) => tool.name), 'edit_object', 'insert_shape']
    .filter((name) => !presented.has(name));
  assert.deepEqual(missing, []);
  for (const name of PRESENTED_TOOL_NAMES) {
    const view = presentToolCall(`mcp__rhwp__${name}`, '{}');
    assert.equal(view.known, true, name);
    assert.ok(view.label && !/[a-z]_[a-z]/.test(view.label), `${name} 은 우리말 동작 이름을 가진다: ${view.label}`);
  }
});

test('접두어를 떼고 인자에서 한 줄 요약을 만든다', () => {
  assert.equal(baseToolName('mcp__rhwp__insert_text'), 'insert_text');
  assert.equal(baseToolName('rhwp__find_text'), 'find_text');
  assert.equal(baseToolName('rhwp_find_text'), 'find_text');
  const insert = presentToolCall('mcp__rhwp__insert_text', JSON.stringify({
    anchor: { text: '사업 개요', position: 'after' }, text: '새 문단',
  }));
  assert.equal(insert.label, '텍스트 삽입');
  assert.equal(insert.summary, '“사업 개요” 뒤 · “새 문단”');
  const replace = presentToolCall('replace_range', JSON.stringify({
    sectionIdx: 1, startParaIdx: 2, startCharOffset: 0, endParaIdx: 4, endCharOffset: 3, text: '',
  }));
  assert.equal(replace.summary, '2구역 3–5문단 → 빈 텍스트');
  assert.equal(presentToolCall('render_page', '{"pageIndex":1}').summary, '2쪽');
  assert.equal(presentToolCall('edit_table', '{"op":"insert_row","paraIdx":4,"rowIdx":2}').label, '행 추가');
  assert.equal(presentToolCall('set_table_props', '{"paraIdx":4,"tableProps":{"repeatHeader":true}}').summary, '5문단 표 · 제목 행 반복');
  assert.equal(presentToolCall('insert_shape', '{"shape":"textBox","widthMm":60,"heightMm":20}').label, '글상자 삽입');
  assert.equal(presentToolCall('edit_object', '{"paraIdx":3,"controlIdx":0,"xMm":20,"yMm":30}').label, '개체 이동');
});

test('apply_edits 와 read_batch 는 항목 수와 항목별 목록을 보인다', () => {
  const edits = presentToolCall('apply_edits', JSON.stringify({
    expectedRevision: 3,
    edits: [
      { tool: 'replace_range', args: { anchor: { text: '가' }, text: '나' } },
      { tool: 'replace_range', args: { anchor: { text: '다' }, text: '라' } },
      { tool: 'apply_char_format', args: { anchor: { text: '마' }, bold: true } },
    ],
  }));
  assert.equal(edits.label, '3곳 편집');
  assert.equal(edits.category, 'edit');
  assert.equal(edits.summary, '텍스트 바꾸기 2 · 글자 서식');
  assert.deepEqual(edits.items.map((item) => item.summary), ['“가” → “나”', '“다” → “라”', '“마” · 굵게']);

  const reads = presentToolCall('read_batch', JSON.stringify({
    reads: [{ tool: 'get_structure' }, { tool: 'find_text', args: { query: '일정' } }],
  }));
  assert.equal(reads.label, '2개 읽기');
  assert.deepEqual(reads.items.map((item) => item.label), ['문서 구조 읽기', '텍스트 찾기']);
});

test('결과 줄은 실행기 결과에서 숫자·쪽·경고·그림을 고른다', () => {
  const argsJson = JSON.stringify({ edits: [{ tool: 'insert_text', args: {} }, { tool: 'delete_range', args: {} }] });
  const outcome = presentToolResult({
    tool: 'apply_edits', argsJson, ok: true, preview: '',
    result: {
      applied: 2,
      results: [{ tool: 'insert_text' }, { tool: 'delete_range' }],
      after: { pages: [1, 2], pageCount: { before: 3, after: 4 }, warnings: [{ kind: 'overflowsBody', message: '표가 본문을 넘칩니다' }] },
      image: { data: 'AAAA', mimeType: 'image/png' },
    },
  });
  assert.equal(outcome.text, '2개 편집 적용 · 2–3쪽 · 3→4쪽 · 경고 1');
  assert.deepEqual(outcome.notices, ['표가 본문을 넘칩니다']);
  assert.equal(outcome.image, 'data:image/png;base64,AAAA');
  assert.equal(outcome.items?.length, 2);

  const failed = presentToolResult({
    tool: 'apply_edits', argsJson, ok: false, preview: '',
    error: { code: 'INVALID_ARGS', message: 'edits[1] (delete_range) failed — the whole batch was rolled back' },
  });
  assert.equal(failed.text, '인자 오류 · 2번째 항목');
  assert.deepEqual(failed.items, [{ ok: true, text: '되돌림' }, { ok: false, text: '인자 오류' }]);

  assert.equal(presentToolResult({
    tool: 'edit_object', argsJson: '{"xMm":10}', ok: true, preview: '', result: { kind: 'picture' },
  }).label, '그림 이동');
});

test('프로바이더 미리보기에서도 결과와 오류를 읽고, 모르는 도구는 조용히 넘어간다', () => {
  const claude = JSON.stringify([{ type: 'text', text: JSON.stringify({ revision: 4, replacedCount: 5 }) }]);
  assert.equal(presentToolResult({ tool: 'mcp__rhwp__replace_all', argsJson: '{}', ok: true, preview: claude }).text, '5곳 바꿈');
  const codex = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ matches: [] }) }] });
  assert.equal(presentToolResult({ tool: 'find_text', argsJson: '{}', ok: true, preview: codex }).text, '찾지 못함');

  const error = presentToolResult({
    tool: 'insert_text', argsJson: '{}', ok: false,
    preview: JSON.stringify([{ type: 'text', text: 'REVISION_MISMATCH: expectedRevision 3 is stale' }]),
  });
  assert.equal(error.text, '문서 버전 불일치');
  assert.equal(error.detail, 'expectedRevision 3 is stale');

  // 그림이 앞선 잘린 미리보기 — 그림이 있었다는 사실만 남는다.
  const truncated = `[{"type":"image","data":"${'A'.repeat(1990)}…`;
  assert.equal(parseResultPreview(truncated).hasImage, true);
  assert.equal(presentToolResult({ tool: 'render_page', argsJson: '{}', ok: true, preview: truncated }).text, '그림');

  const bash = presentToolCall('Bash', '{"command":"ls -la"}');
  assert.equal(bash.known, false);
  assert.equal(bash.label, '명령 실행');
  assert.equal(bash.summary, 'ls -la');
  const odd = presentToolCall('some_future_tool', 'not json');
  assert.equal(odd.label, 'some_future_tool');
  assert.equal(odd.summary, '');
  assert.deepEqual(presentToolResult({ tool: 'some_future_tool', argsJson: '{}', ok: true, preview: 'done' }),
    { ok: true, text: '', notices: [] });
});

test('활동 제목은 턴을 편집·읽기 횟수로 요약한다', () => {
  assert.equal(summarizeActivity([]), '도구 호출');
  assert.equal(summarizeActivity([{ tool: 'mcp__rhwp__get_structure', argsJson: '{}' }]), '문서 구조 읽기');
  assert.equal(summarizeActivity([
    { tool: 'apply_edits', argsJson: '{}' },
    { tool: 'insert_text', argsJson: '{}', failed: true },
    { tool: 'get_structure', argsJson: '{}' },
    { tool: 'find_text', argsJson: '{}' },
    { tool: 'render_page', argsJson: '{}' },
    { tool: 'Bash', argsJson: '{}' },
  ]), '편집 2번 · 읽기 2번 · 확인 1번 · 도구 1번 · 오류 1');
});
