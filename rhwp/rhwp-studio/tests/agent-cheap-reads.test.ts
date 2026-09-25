/**
 * 저렴한 읽기 (P2.3) — read_batch 묶음 읽기와 get_structure 의 range/sinceRevision
 * 증분 읽기 계약을 executor → 실제 PendingEditManager → 가짜 wasm 통합 경로로 검증한다.
 * 허브 측 스키마/프로필/정의 크기는 rhwp-agent/tests/tools.test.mjs 가 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { expectErr, makeEnv } from './agent-test-env.ts';

type BatchResult = { tool: string | null; error?: { code: string; message: string } } & Record<string, unknown>;

const resultsOf = (r: Record<string, unknown>): BatchResult[] => r['results'] as BatchResult[];
const mcpText = (r: Record<string, unknown>): string =>
  ((r['mcpContent'] as Array<{ text: string }> | undefined)?.[0]?.text) ?? '';

// ─── read_batch ─────────────────────────────────────────

test('read_batch: 여러 읽기를 한 호출에 돌리고 최상위 revision 하나만 실린다', async () => {
  const h = makeEnv(['첫째 문단', '둘째 문단']);
  const r = await h.call('read_batch', {
    reads: [
      { tool: 'get_structure' },
      { tool: 'get_text_range', args: { sectionIdx: 0, paraIdx: 1 } },
      { tool: 'get_fields' },
    ],
  });
  assert.equal(r['revision'], h.revision.revision);
  const results = resultsOf(r);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((i) => i['tool']), ['get_structure', 'get_text_range', 'get_fields']);
  // mcpContent 텍스트 블록은 항목의 text 필드로 풀린다 — 중첩 JSON 에 image 블록이
  // 섞이는 결과를 막기 위해 render_page/materialize_document_snapshot 은 허용 목록 밖이다.
  assert.match(String(results[0]['text']), /s0 p0 \(5\) 첫째 문단/);
  assert.equal(results[0]['revision'], undefined, '항목별 revision 은 싣지 않는다');
  assert.equal(results[0]['mcpContent'], undefined);
  assert.equal(results[1]['text'], '둘째 문단');
  assert.equal(results[1]['paraLength'], 5);
  assert.deepEqual(results[2]['fields'], []);
});

test('read_batch: 한 항목의 실패가 나머지를 멈추지 않고 항목 오류로 보고된다', async () => {
  const h = makeEnv(['본문']);
  const r = await h.call('read_batch', {
    reads: [
      { tool: 'get_text_range', args: { sectionIdx: 0, paraIdx: 99 } }, // 범위 밖
      { tool: 'get_document_info' },                                    // 그래도 성공
      { tool: 'nonsense_tool' },                                        // 목록 밖 이름
      'not-an-object' as unknown as Record<string, never>,              // 잘못된 항목 자체
    ],
  });
  const results = resultsOf(r);
  assert.equal(results.length, 4);
  assert.equal(results[0]['error']?.code, 'INVALID_ARGS');
  assert.match(results[0]['error']?.message ?? '', /paraIdx 99 out of range/);
  assert.equal(results[1]['error'], undefined);
  assert.equal(results[1]['sourceFormat'], 'hwpx');
  assert.equal(results[2]['error']?.code, 'INVALID_ARGS');
  assert.match(results[2]['error']?.message ?? '', /read item tool must be one of/);
  assert.equal(results[3]['tool'], null);
  assert.equal(results[3]['error']?.code, 'INVALID_ARGS');
  assert.equal(r['revision'], h.revision.revision);
});

test('read_batch: 쓰기 도구·배치 도구·바이너리 읽기는 항목 오류로 거절된다', async () => {
  const h = makeEnv(['본문']);
  const r = await h.call('read_batch', {
    reads: [
      { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x' } },
      { tool: 'apply_edits', args: { edits: [] } },
      { tool: 'read_batch', args: { reads: [] } },
      { tool: 'render_page', args: { pageIndex: 0 } },
      { tool: 'materialize_document_snapshot' },
      { tool: 'template_get_structure' },
    ],
  });
  for (const item of resultsOf(r)) {
    assert.equal(item['error']?.code, 'INVALID_ARGS', `${item['tool']}: 허용 목록 밖인데 통과함`);
  }
  assert.equal(h.body[0], '본문', '거절된 항목이 문서를 바꾸면 안 된다');
});

test('read_batch: reads 는 1-16개 배열이어야 한다', async () => {
  const h = makeEnv(['본문']);
  for (const reads of [[], Array.from({ length: 17 }, () => ({ tool: 'get_fields' })), 'x', undefined]) {
    const e = await expectErr(h.call('read_batch', { reads }), 'INVALID_ARGS');
    assert.match(e.message, /1\.\.16/);
  }
});

// ─── get_structure range ────────────────────────────────

test('get_structure range: 지정 본문 문단 범위만 읽고 머리 줄에 범위를 실는다', async () => {
  const h = makeEnv(['영', '하나', '둘', '셋']);
  const r = await h.call('get_structure', { range: { sectionIdx: 0, fromPara: 1, toPara: 2 } });
  const text = mcpText(r);
  assert.match(text, /range s0 p1-p2/);
  assert.match(text, /s0 p1 \(2\) 하나/);
  assert.match(text, /s0 p2 \(1\) 둘/);
  assert.ok(!text.includes('s0 p0 ') && !text.includes('s0 p3 '), '범위 밖 문단은 싣지 않는다');
});

test('get_structure range: json 도 같은 범위만 싣고 range 를 에코한다', async () => {
  const h = makeEnv(['영', '하나', '둘']);
  const r = await h.call('get_structure', { format: 'json', range: { sectionIdx: 0, fromPara: 2, toPara: 2 } });
  assert.deepEqual(r['range'], { sectionIdx: 0, fromPara: 2, toPara: 2 });
  const sections = r['sections'] as Array<{ sectionIdx: number; paragraphCount: number; paragraphs: Array<{ paraIdx: number }> }>;
  assert.equal(sections[0].paragraphCount, 3, 'paragraphCount 는 섹션 전체 기준을 유지한다');
  assert.deepEqual(sections[0].paragraphs.map((p) => p.paraIdx), [2]);
});

test('get_structure range: 경계·순서 위반은 INVALID_ARGS', async () => {
  const h = makeEnv(['본문', '둘']);
  await expectErr(h.call('get_structure', { range: { sectionIdx: 0, fromPara: 0, toPara: 5 } }), 'INVALID_ARGS');
  await expectErr(h.call('get_structure', { range: { sectionIdx: 0, fromPara: 1, toPara: 0 } }), 'INVALID_ARGS');
  await expectErr(h.call('get_structure', { range: { sectionIdx: 3, fromPara: 0, toPara: 0 } }), 'INVALID_ARGS');
});

// ─── get_structure sinceRevision ───────────────────────

test('get_structure sinceRevision: 바뀐 문단과 누적 이동 경계만 돌려준다', async () => {
  const h = makeEnv(['앞', '중간', '뒤']);
  const base = (await h.call('get_structure'))['revision'] as number;
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 1, text: 'x\ny' });

  const r = await h.call('get_structure', { sinceRevision: base });
  assert.equal(r['revision'], h.revision.revision);
  assert.equal(r['sinceRevision'], base);
  const text = mcpText(r);
  assert.match(text, /changes since revision/);
  assert.match(text, /s0 changed p0-p1 \(was p0\):/);   // 삽입이 문단을 나눈 범위 (현재 좌표)
  assert.match(text, /s0 p0 \(2\) 앞x/);
  assert.match(text, /s0 p1 \(1\) y/);
  assert.match(text, /s0 shift p1\+ → \+1/);          // 저장된 p>=1 은 +1 이동
  assert.ok(!text.includes('중간') && !text.includes('뒤'), '안 바뀐 문단 텍스트는 싣지 않는다');
});

test('get_structure sinceRevision: 삭제는 was 범위와 음수 이동을 보고한다', async () => {
  const h = makeEnv(['a0', 'a1', 'a2', 'a3']);
  const base = (await h.call('get_structure'))['revision'] as number;
  await h.call('delete_range', {
    sectionIdx: 0, startParaIdx: 1, startCharOffset: 0, endParaIdx: 2, endCharOffset: 2,
  });
  const r = await h.call('get_structure', { sinceRevision: base, format: 'json' });
  const changes = r['changes'] as Array<{ paraStart: number; paraEnd: number; wasRanges: number[][] }>;
  assert.equal(changes.length, 1);
  assert.deepEqual({ s: changes[0].paraStart, e: changes[0].paraEnd, was: changes[0].wasRanges },
    { s: 1, e: 1, was: [[1, 2]] });
  const shifts = r['indexShifts'] as Array<{ sectionIdx: number; at: number; delta: number }>;
  assert.deepEqual(shifts, [{ sectionIdx: 0, at: 3, delta: -1 }]);
});

test('get_structure sinceRevision: since == 현재 revision 이면 변경 없음으로 돌아온다', async () => {
  const h = makeEnv(['본문']);
  const base = (await h.call('get_structure'))['revision'] as number;
  const r = await h.call('get_structure', { sinceRevision: base });
  assert.match(mcpText(r), /no recorded paragraph changes/);
  await expectErr(h.call('get_structure', { sinceRevision: base + 1 }), 'INVALID_ARGS');
  await expectErr(h.call('get_structure', { sinceRevision: -1 }), 'INVALID_ARGS');
});

test('get_structure sinceRevision: 저널이 덮지 못하는 구간이면 FULL_REFRESH_REQUIRED', async () => {
  const h = makeEnv(['본문']);
  const base = (await h.call('get_structure'))['revision'] as number;
  // 저널 없는 bump — 사용자 편집 등 기록 밖 변이를 흉내낸다.
  h.bus.emit('document-mutated', 'user-edit');
  const e = await expectErr(h.call('get_structure', { sinceRevision: base }), 'FULL_REFRESH_REQUIRED');
  assert.match(e.message, /Re-read with get_structure without sinceRevision/);
  // 로드 시점(0)도 저널이 시작되기 전이라 gap 이다.
  await expectErr(h.call('get_structure', { sinceRevision: 0 }), 'FULL_REFRESH_REQUIRED');
});

test('apply_edits: 한 revision bump 에 묶인 항목들이 저널에 각각 귀속된다', async () => {
  const h = makeEnv(['aa', 'bb', 'cc', 'dd']);
  const base = (await h.call('get_structure'))['revision'] as number;
  const r = await h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', args: { sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 2, text: 'AA' } },
      { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: 1, charOffset: 0, text: 'x\ny' } },
    ],
  });
  assert.equal(r['revision'], base + 1, '배치는 revision 을 한 번만 올린다');

  const delta = await h.call('get_structure', { sinceRevision: base });
  const text = mcpText(delta);
  // 두 항목 모두 그 revision 의 델타에 들어와야 한다 — 중간 revision 이 없어
  // 버퍼 없이 개별 record 하면 (b,b] 빈 구간에 버려져 둘 다 사라진다 (회귀).
  // 인접 변경 구간은 하나로 합쳐진다: p0 교체 + p1 분할 → 현재 p0-p2.
  assert.match(text, /s0 changed p0-p2 \(was p0-p1\):/);
  assert.match(text, /s0 p0 \(2\) AA/);
  assert.match(text, /s0 p2 \(3\) ybb/);
  assert.match(text, /s0 shift p2\+ → \+1/);
});

test('get_structure sinceRevision + range: 범위와 겹치는 변경만 싣는다', async () => {
  const h = makeEnv(['p0', 'p1', 'p2', 'p3']);
  const base = (await h.call('get_structure'))['revision'] as number;
  await h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', args: { sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 2, text: 'X0' } },
      { tool: 'replace_range', args: { sectionIdx: 0, startParaIdx: 3, startCharOffset: 0, endParaIdx: 3, endCharOffset: 2, text: 'X3' } },
    ],
  });
  const r = await h.call('get_structure', { sinceRevision: base, range: { sectionIdx: 0, fromPara: 2, toPara: 3 } });
  const text = mcpText(r);
  assert.match(text, /s0 changed p3 \(was p3\):/);
  assert.match(text, /s0 p3 \(2\) X3/);
  assert.ok(!/changed p0/.test(text), 'range 밖 변경은 싣지 않는다');
});

test('read_batch 안의 get_structure 도 sinceRevision 델타를 돌려준다', async () => {
  const h = makeEnv(['하나', '둘']);
  const base = (await h.call('get_structure'))['revision'] as number;
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 1, text: '!' });
  const r = await h.call('read_batch', { reads: [{ tool: 'get_structure', args: { sinceRevision: base } }] });
  const item = resultsOf(r)[0];
  assert.equal(item['error'], undefined);
  assert.match(String(item['text']), /changes since revision/);
});
