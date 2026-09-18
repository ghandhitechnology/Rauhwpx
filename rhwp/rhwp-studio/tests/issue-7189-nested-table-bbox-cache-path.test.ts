import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Bbox { pageIndex: number; tag: string }

async function cacheModule() {
  return await import('../src/engine/table-bbox-cache.ts');
}

function host(outer: Bbox[], inner: Bbox[]) {
  const calls: string[] = [];
  return {
    calls,
    wasm: {
      getTableCellBboxes(sec: number, ppi: number, ci: number, pageHint?: number): Bbox[] {
        calls.push(`flat:${sec}:${ppi}:${ci}:${pageHint}`);
        return outer;
      },
      getTableCellBboxesByPath(sec: number, ppi: number, pathJson: string): Bbox[] {
        calls.push(`path:${sec}:${ppi}:${pathJson}`);
        return inner;
      },
    },
    cachedTableRef: null as any,
    cachedCellBboxes: null as Bbox[] | null,
    tableBboxFetchFailures: new Set<string>(),
  };
}

const OUTER: Bbox[] = [{ pageIndex: 0, tag: 'outer' }];
const INNER: Bbox[] = [{ pageIndex: 0, tag: 'inner' }];

const outerRef = { sec: 0, ppi: 2, ci: 0 };
const nestedRef = {
  sec: 0,
  ppi: 2,
  ci: 0,
  path: [
    { controlIndex: 0, cellIndex: 0, cellParaIndex: 9 },
    { controlIndex: 0, cellIndex: 3, cellParaIndex: 0 },
  ],
};

test('깊이 2 경로는 경로 API 로 bbox 를 얻는다', async () => {
  const { ensureTableCellBboxCache } = await cacheModule();
  const h = host(OUTER, INNER);

  const got = ensureTableCellBboxCache(h as any, nestedRef, 0);

  assert.deepEqual(got, INNER, '중첩 표에서는 안쪽 표의 bbox 가 나와야 한다');
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].startsWith('path:'), `경로 API 를 불러야 한다 (실제 ${h.calls[0]})`);
});

test('경로가 없으면 평면 질의를 쓴다', async () => {
  const { ensureTableCellBboxCache } = await cacheModule();
  const h = host(OUTER, INNER);

  const got = ensureTableCellBboxCache(h as any, outerRef, 0);

  assert.deepEqual(got, OUTER);
  assert.ok(h.calls[0].startsWith('flat:'), `평면 질의여야 한다 (실제 ${h.calls[0]})`);
});

test('깊이 1 경로는 최외곽 표 — 평면 질의를 쓰고 캐시를 쪼개지 않는다', async () => {
  const { ensureTableCellBboxCache, tableIdentity } = await cacheModule();
  const depthOne = { ...outerRef, path: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] };
  const h = host(OUTER, INNER);

  ensureTableCellBboxCache(h as any, depthOne, 0);
  assert.ok(h.calls[0].startsWith('flat:'), '깊이 1 은 평면 질의다');

  assert.equal(
    tableIdentity(depthOne as any),
    tableIdentity(outerRef as any),
    '깊이 1 과 경로 없음은 같은 표 — 신원이 갈리면 같은 표를 두 번 조회한다',
  );

  ensureTableCellBboxCache(h as any, outerRef, 0);
  assert.equal(h.calls.length, 1, '같은 표를 다시 조회하면 안 된다');
});

test('같은 쪽의 바깥 표와 안쪽 표가 서로의 캐시를 덮어쓰지 않는다', async () => {
  const { ensureTableCellBboxCache } = await cacheModule();
  const h = host(OUTER, INNER);

  assert.deepEqual(ensureTableCellBboxCache(h as any, outerRef, 0), OUTER);
  assert.deepEqual(ensureTableCellBboxCache(h as any, nestedRef, 0), INNER);
  assert.deepEqual(
    ensureTableCellBboxCache(h as any, outerRef, 0),
    OUTER,
    '안쪽 표를 거친 뒤에도 바깥 표는 바깥 bbox 를 받아야 한다',
  );
});

test('실패 메모도 표마다 따로 남는다', async () => {
  const { ensureTableCellBboxCache } = await cacheModule();
  const h = host([], []);

  assert.equal(ensureTableCellBboxCache(h as any, outerRef, 0), null);
  assert.equal(h.tableBboxFetchFailures.size, 1);

  assert.equal(ensureTableCellBboxCache(h as any, nestedRef, 0), null);
  assert.equal(
    h.tableBboxFetchFailures.size,
    2,
    '바깥 표의 실패가 안쪽 표의 조회까지 막으면 안 된다',
  );
});

test('로컬 resize 이력 키는 tableIdentity 를 쓴다', () => {
  const table = readFileSync(
    join(dirname(dirname(fileURLToPath(import.meta.url))), 'src/engine/input-handler-table.ts'),
    'utf8',
  );
  assert.match(
    table,
    /function localResizeSegmentKey\([\s\S]*?tableIdentity\(tableRef\)/,
    '바깥 표와 안쪽 표가 같은 sec/ppi/ci 이력이 되면 안 된다',
  );
  assert.match(
    table,
    /function hasLocalResizeHistory\([\s\S]*?tableIdentity\(tableRef\)/,
    '이력 조회도 같은 신원을 써야 한다',
  );
});
