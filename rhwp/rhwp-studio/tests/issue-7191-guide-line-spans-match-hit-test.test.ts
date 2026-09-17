import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coalesceSpans,
  computeBorderSpans,
  mergeBorderCoords,
} from '../src/engine/table-border-lines.ts';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const round = (v: number) => Math.round(v * 10) / 10;

interface SpanCell { x: number; y: number; w: number; h: number }

function borderLines(cells: SpanCell[]) {
  const rowYs = new Set<number>();
  const colXs = new Set<number>();
  for (const c of cells) {
    rowYs.add(round(c.y));
    rowYs.add(round(c.y + c.h));
    colXs.add(round(c.x));
    colXs.add(round(c.x + c.w));
  }
  const rows = mergeBorderCoords(rowYs);
  const cols = mergeBorderCoords(colXs);
  const { rowSpans, colSpans } = computeBorderSpans(cells, rows.indexByCoord, cols.indexByCoord, round);
  return {
    rowLines: rows.positions.map((y, i) => ({ y, spans: rowSpans.get(i) ?? [], index: i })),
    colLines: cols.positions.map((x, i) => ({ x, spans: colSpans.get(i) ?? [], index: i })),
    colIndexByX: cols.indexByCoord,
  };
}

const cell = (x: number, y: number, w: number, h: number): SpanCell => ({ x, y, w, h });

function mergedShape(): SpanCell[] {
  return [
    cell(0, 0, 200, 50),
    cell(0, 50, 100, 50),
    cell(100, 50, 100, 50),
    cell(0, 100, 100, 50),
    cell(100, 100, 100, 50),
  ];
}

test('부분 경계는 자기 구간만 그린다 — 표 전체 높이를 긋지 않는다', () => {
  const { colLines, colIndexByX } = borderLines(mergedShape());
  const index = colIndexByX.get(100);
  assert.notEqual(index, undefined, 'x=100 경계가 있어야 한다');

  const line = colLines.find((l) => l.index === index)!;
  assert.deepEqual(
    line.spans,
    [{ start: 50, end: 150 }],
    'x=100 은 y=50..150 에만 있는 경계 — 표 꼭대기 y=0 부터 긋지 않는다',
  );
});

test('경계가 없는 구간은 어떤 span 에도 덮이지 않는다', () => {
  const { colLines, colIndexByX } = borderLines(mergedShape());
  const line = colLines.find((l) => l.index === colIndexByX.get(100))!;

  const covered = line.spans.some((s) => s.start <= 25 && 25 <= s.end);
  assert.equal(covered, false, 'y=25 는 x=100 경계가 없는 구간 — 그리면 안 된다');
});

test('끊긴 경계는 토막마다 따로 남는다', () => {
  const { colLines, colIndexByX } = borderLines([
    cell(0, 0, 100, 50),
    cell(100, 0, 100, 50),
    cell(0, 50, 200, 100),
    cell(0, 150, 100, 50),
    cell(100, 150, 100, 50),
  ]);
  const line = colLines.find((l) => l.index === colIndexByX.get(100))!;

  assert.deepEqual(
    line.spans,
    [{ start: 0, end: 50 }, { start: 150, end: 200 }],
    '가운데 병합 구간을 건너뛴 두 토막이어야 한다',
  );
});

test('격자 표에서는 경계가 표 전체를 가로지른다 — 회귀 방지', () => {
  const { colLines, rowLines } = borderLines([
    cell(0, 0, 100, 50), cell(100, 0, 100, 50),
    cell(0, 50, 100, 50), cell(100, 50, 100, 50),
  ]);

  for (const line of colLines) {
    assert.deepEqual(line.spans, [{ start: 0, end: 100 }], `x=${line.x} 은 표 전체를 지난다`);
  }
  for (const line of rowLines) {
    assert.deepEqual(line.spans, [{ start: 0, end: 200 }], `y=${line.y} 는 표 전체를 지난다`);
  }
});

test('그룹 대표와의 거리로만 경계를 묶는다', () => {
  const chained = mergeBorderCoords([0, 0.9, 1.8, 2.7]);
  assert.deepEqual(chained.positions, [0, 1.8]);
  assert.equal(chained.indexByCoord.get(0.9), 0);
  assert.equal(chained.indexByCoord.get(2.7), 1);
});

test('맞닿은 칸 변은 잇고 벌어진 것은 끊는다', () => {
  assert.deepEqual(
    coalesceSpans([{ start: 0, end: 50 }, { start: 50, end: 100 }]),
    [{ start: 0, end: 100 }],
    '변을 공유하면 한 구간',
  );
  assert.deepEqual(
    coalesceSpans([{ start: 0, end: 50 }, { start: 50.4, end: 100 }]),
    [{ start: 0, end: 100 }],
    '반올림 오차(0.5px 이내)는 잇는다',
  );
  assert.deepEqual(
    coalesceSpans([{ start: 0, end: 50 }, { start: 60, end: 100 }]),
    [{ start: 0, end: 50 }, { start: 60, end: 100 }],
    '실제로 벌어진 구간은 끊는다',
  );
  assert.deepEqual(
    coalesceSpans([{ start: 60, end: 100 }, { start: 0, end: 50 }]),
    [{ start: 0, end: 50 }, { start: 60, end: 100 }],
    '입력 순서와 무관하다',
  );
});

test('그리는 쪽은 표 전체 범위가 아니라 구간을 쓴다', () => {
  const renderer = readFileSync(join(rootDir, 'src/engine/table-resize-renderer.ts'), 'utf8');
  const start = renderer.indexOf('  showMarker(');
  assert.notEqual(start, -1, 'showMarker 를 찾지 못했다');
  const body = renderer.slice(start, renderer.indexOf('\n  /**', start + 1));

  assert.match(body, /line\.spans/, 'showMarker 는 경계 구간으로 그려야 한다');
  assert.doesNotMatch(
    body,
    /xStart|xEnd|yStart|yEnd/,
    '표 전체 범위는 적중 판정과 다른 출처다 — 두 번째 진실원을 남기지 않는다',
  );
});
