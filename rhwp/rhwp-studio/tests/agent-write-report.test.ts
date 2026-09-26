/**
 * 쓰기 결과 보고(after / render) — 변경 영역 자르기·쌓기 계획, 쪽 이동 판정, 그리고
 * executor 가 스테이징 쓰기와 apply_edits 결과에 붙이는 after 블록.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDER_MAX_PIXELS,
  movedParagraphRuns,
  movedRunWarnings,
  planCropRegions,
  planStack,
  type PageFrame,
} from '../src/agent/write-report.ts';
import { addTable, expectErr, makeEnv } from './agent-test-env.ts';

const A4: PageFrame = { width: 794, height: 1123, bodyLeft: 113, bodyRight: 681 };

test('planCropRegions: 가까운 변경은 묶고 본문 폭으로 넓히며 쪽 순서로 돌려준다', () => {
  const regions = planCropRegions([
    { pageIndex: 1, x: 200, y: 400, width: 50, height: 16 },
    { pageIndex: 0, x: 300, y: 100, width: 40, height: 16 },
    { pageIndex: 0, x: 120, y: 130, width: 500, height: 16 }, // 첫 줄과 붙어 있다 → 한 영역
    { pageIndex: 0, x: 150, y: 700, width: 30, height: 16 }, // 멀리 떨어짐 → 따로
  ], () => A4);
  assert.deepEqual(regions.map((r) => [r.pageIndex, r.y, r.height]), [
    [0, 88, 70],
    [0, 688, 40],
    [1, 388, 40],
  ]);
  for (const r of regions) {
    assert.equal(r.x, A4.bodyLeft - 12);
    assert.equal(r.width, A4.bodyRight - A4.bodyLeft + 24);
  }
});

test('planCropRegions: 폭 0 캐럿 rect 도 한 줄 영역이 되고 쪽 밖으로 넘치지 않는다', () => {
  const [r] = planCropRegions([{ pageIndex: 2, x: 400, y: 2, width: 0, height: 16 }], () => A4);
  assert.deepEqual(r, { pageIndex: 2, x: 101, y: 0, width: 592, height: 30 });
  assert.deepEqual(planCropRegions([{ pageIndex: 0, x: 0, y: 0, width: 5, height: 0 }], () => A4), []);
});

test('planStack: 1.25배에서 시작해 픽셀 예산 안으로 줄이고, 넘치면 뒤 영역을 뺀다', () => {
  const line = { pageIndex: 0, x: 0, y: 0, width: 600, height: 60 };
  const small = planStack([line, { ...line, pageIndex: 1 }]);
  assert.equal(small.scale, 1.25);
  assert.equal(small.omitted, 0);
  assert.equal(small.widthPx, 750);
  assert.equal(small.heightPx, 150 + 6);

  const page = { pageIndex: 0, x: 0, y: 0, width: 794, height: 1123 };
  const one = planStack([page]);
  assert.ok(one.scale < 1.25 && one.scale >= 0.8);
  assert.ok(one.widthPx * one.heightPx <= RENDER_MAX_PIXELS * 1.01);

  const many = planStack([page, { ...page, pageIndex: 1 }, { ...page, pageIndex: 2 }]);
  assert.ok(many.omitted >= 1, '세 쪽 전체는 한 장에 못 싣는다');
  assert.ok(many.scale >= 0.8);
  assert.ok(many.widthPx * many.heightPx <= RENDER_MAX_PIXELS * 1.01);

  const tall = planStack([{ pageIndex: 0, x: 0, y: 0, width: 794, height: 4000 }]);
  assert.equal(tall.clipped, true);
  assert.ok(tall.widthPx * tall.heightPx <= RENDER_MAX_PIXELS * 1.01);
});

test('movedParagraphRuns: 편집 밖에서 쪽이 바뀐 문단만 편집 후 좌표로 보고한다', () => {
  // 쪽당 2문단 — 편집 전 5문단 [0,1][2,3][4], p1 끝에 문단 하나 추가 후 6문단 [0,1][2,3][4,5]
  const before = [{ sec: 0, para: 0 }, { sec: 0, para: 2 }, { sec: 0, para: 4 }];
  const after = [{ sec: 0, para: 0 }, { sec: 0, para: 2 }, { sec: 0, para: 4 }];
  const runs = movedParagraphRuns(before, after, [6], new Map([[0, { lo: 1, hi: 2, delta: 1 }]]));
  // 편집 전 c(p2)·d(p3) 가 쪽 1 → 편집 후 c(p3) 쪽 1, d(p4) 쪽 2
  assert.deepEqual(runs, [{ sectionIdx: 0, fromPara: 4, toPara: 4, fromPage: 1, toPage: 2 }]);
  assert.deepEqual(movedRunWarnings(runs), ['s0 p4 moved from page 1 to 2']);
  // 구역 전체가 바뀐 편집은 문단 대응을 믿을 수 없어 보고하지 않는다
  assert.deepEqual(movedParagraphRuns(before, after, [6], new Map([[0, 'all' as const]])), []);
});

test('movedRunWarnings: 앞 두 구간만 적고 나머지는 문단 수로 줄인다', () => {
  const runs = [0, 1, 2, 3].map((i) => ({ sectionIdx: 0, fromPara: i * 10, toPara: i * 10 + 1, fromPage: i, toPage: i + 1 }));
  assert.deepEqual(movedRunWarnings(runs), [
    's0 p0-1 moved from page 0 to 1',
    's0 p10-11 moved from page 1 to 2',
    '4 more paragraph(s) after the edit changed page',
  ]);
});

/** 쪽당 2문단 조판을 흉내 내는 가짜 wasm 확장 */
function paginate(perPage: number) {
  return (wasm: Record<string, unknown>, body: string[]) => {
    Object.defineProperty(wasm, 'pageCount', { get: () => Math.ceil(body.length / perPage), configurable: true });
    wasm['getPositionOfPage'] = (p: number) => ({ ok: true, sec: 0, para: p * perPage });
    wasm['getCursorRect'] = (_s: number, p: number) => ({ pageIndex: Math.floor(p / perPage), x: 120, y: 80 + (p % perPage) * 20, height: 16 });
  };
}

test('insert_text 결과에 after 보고가 붙고 중복 postEdit 은 빠진다', async () => {
  const env = makeEnv(['첫 문단', '둘째 문단', '셋째', '넷째', '다섯째'], paginate(2));
  const r = await env.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 5, text: ' 추가\n새 문단' });
  const after = r['after'] as Record<string, unknown>;
  assert.deepEqual(after['paragraphs'], [
    { sectionIdx: 0, paraIdx: 1, text: '둘째 문단 추가' },
    { sectionIdx: 0, paraIdx: 2, text: '새 문단' },
  ]);
  assert.equal(after['pageCountBefore'], 3);
  assert.equal(after['pageCount'], 3);
  assert.deepEqual(after['pages'], [0, 1]);
  assert.deepEqual(after['warnings'], ['s0 p4 moved from page 1 to 2']);
  assert.equal('postEdit' in r, false);
});

test('긴 문단 뒤쪽 편집은 편집 지점 조금 앞부터 보여 준다', async () => {
  const env = makeEnv(['가'.repeat(400)], paginate(4));
  const r = await env.call('replace_range', {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 300, endParaIdx: 0, endCharOffset: 301, text: 'X',
  });
  const [p] = (r['after'] as { paragraphs: Array<Record<string, unknown>> }).paragraphs;
  assert.equal(p['from'], 260);
  assert.equal((p['text'] as string).length, 140);
  assert.equal((p['text'] as string).indexOf('X'), 40);
});

test('apply_edits 는 배치 전체에 after 하나를 붙인다', async () => {
  const env = makeEnv(['하나', '둘', '셋'], paginate(10));
  const r = await env.call('apply_edits', {
    edits: [
      { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: 0, charOffset: 2, text: '!' } },
      { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: 2, charOffset: 1, text: '?' } },
    ],
  });
  const after = r['after'] as Record<string, unknown>;
  assert.deepEqual((after['paragraphs'] as Array<{ text: string }>).map((p) => p.text), ['하나!', '셋?']);
  assert.equal('warnings' in after, false, '깨끗한 편집에는 warnings 가 없다');
  assert.equal((r['results'] as unknown[]).length, 2);
});

test('render 인자는 쓰기 전에 검사하고, 캔버스 없는 곳에서는 쓰기를 살린 채 renderError 만 남긴다', async () => {
  const env = makeEnv(['본문'], paginate(10));
  await expectErr(env.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x', render: 'full' }), 'INVALID_ARGS');
  assert.deepEqual(env.body, ['본문'], '잘못된 render 는 문서를 건드리지 않는다');
  const r = await env.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 2, text: '!', render: 'crop' });
  assert.deepEqual(env.body, ['본문!']);
  assert.match(String(r['renderError']), /render unavailable/);
  assert.equal('image' in r, false);
});

test('음수 주소는 스키마 대신 dispatch 입구가 거절한다 (apply_edits 항목 포함)', async () => {
  const env = makeEnv(['본문']);
  const e = await expectErr(env.call('insert_text', { sectionIdx: 0, paraIdx: -1, charOffset: 0, text: 'x' }), 'INVALID_ARGS');
  assert.match(e.message, /paraIdx must be >= 0/);
  const batch = await expectErr(env.call('apply_edits', {
    edits: [{ tool: 'delete_range', args: { sectionIdx: 0, startParaIdx: 0, startCharOffset: -2, endParaIdx: 0, endCharOffset: 1 } }],
  }), 'INVALID_ARGS');
  assert.match(batch.message, /startCharOffset must be >= 0/);
});

test('셀 편집 뒤 표가 본문 아래로 넘치면 after.warnings 가 고칠 방법과 함께 알린다', async () => {
  const env = makeEnv(['앞', '', '뒤'], (wasm, body) => {
    paginate(10)(wasm, body);
    wasm['getTableProperties'] = () => ({ pageBreak: 0, repeatHeader: false });
    wasm['getTableBBox'] = () => ({ pageIndex: 0, x: 100, y: 900, width: 500, height: 300 });
    wasm['getTableBBoxAtPage'] = () => { throw new Error('no fragment'); };
    wasm['getPageInfo'] = () => ({
      pageIndex: 0, width: 794, height: 1123, sectionIndex: 0,
      marginLeft: 113, marginRight: 113, marginTop: 75, marginBottom: 75, marginHeader: 0, marginFooter: 0,
    });
  });
  addTable(env, 1, [['가', '나']]);
  const r = await env.call('insert_text', {
    sectionIdx: 0, paraIdx: 0, charOffset: 1, text: '다', cell: { paraIdx: 1, controlIdx: 0, cellIdx: 0 },
  });
  const after = r['after'] as { warnings?: string[]; paragraphs: unknown[] };
  assert.deepEqual(after.paragraphs, [
    { sectionIdx: 0, paraIdx: 0, cell: { paraIdx: 1, controlIdx: 0, cellIdx: 0 }, text: '가다' },
  ]);
  assert.deepEqual(after.warnings, [
    'table s0 p1 c0 runs past the body bottom on page 0 and cannot split — set_table_props {pageBreak:"row"}',
  ]);
});
