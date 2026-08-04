/**
 * 차트 렌더링 모듈의 순수 부분(validateChartSpec, computeChartLayout) 테스트.
 * 캔버스/DOM 을 쓰지 않는 레이아웃 계산만 검증한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChartSpec, computeChartLayout } from '../src/agent/chart-render.ts';
import type { ChartSpec, ChartLayout } from '../src/agent/chart-render.ts';

const EPS = 1e-6;

function inPlot(layout: ChartLayout, x: number, y: number): boolean {
  const p = layout.plot;
  return x >= p.x - EPS && x <= p.x + p.w + EPS && y >= p.y - EPS && y <= p.y + p.h + EPS;
}

const barSpec: ChartSpec = {
  type: 'bar',
  title: '분기별 매출',
  series: [
    { name: '서울', values: [10, 25, 18] },
    { name: '부산', values: [7, 12, 30] },
  ],
  categories: ['1분기', '2분기', '3분기'],
};

test('막대 차트: 막대 수 = 계열 수 × 카테고리 수이고 모두 플롯 영역 안에 있다', () => {
  const layout = computeChartLayout(barSpec, 640, 400);
  assert.equal(layout.bars.length, 2 * 3);
  for (const b of layout.bars) {
    assert.ok(b.w > 0, '막대 폭은 양수');
    assert.ok(b.h >= 0, '막대 높이는 음수가 아님');
    assert.ok(inPlot(layout, b.x, b.y), '막대 좌상단이 플롯 안');
    assert.ok(inPlot(layout, b.x + b.w, b.y + b.h), '막대 우하단이 플롯 안');
  }
});

test('다중 계열 막대: 어떤 두 막대도 가로로 겹치지 않는다', () => {
  const layout = computeChartLayout(barSpec, 640, 400);
  const bars = layout.bars;
  for (let i = 0; i < bars.length; i++) {
    for (let j = i + 1; j < bars.length; j++) {
      const a = bars[i];
      const b = bars[j];
      const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      assert.ok(overlap <= EPS, `막대 ${i}/${j} 가 ${overlap}px 겹침`);
    }
  }
});

test('막대 차트: y축 눈금에 0 이 포함된다', () => {
  const layout = computeChartLayout(barSpec, 640, 400);
  assert.ok(layout.yTicks.some((t) => t.value === 0), 'y 눈금에 0 존재');
  assert.notEqual(layout.zeroY, undefined, 'zeroY 계산됨');
});

test('꺾은선 차트: 폴리라인 개수와 점 개수가 스펙과 일치한다', () => {
  const spec: ChartSpec = {
    type: 'line',
    series: [
      { name: 'A', values: [3, -2, 5, 1] },
      { name: 'B', values: [0, 4, -1, 2] },
    ],
  };
  const layout = computeChartLayout(spec, 600, 360);
  assert.equal(layout.lines.length, 2);
  for (const line of layout.lines) {
    assert.equal(line.points.length, 4);
    for (const p of line.points) assert.ok(inPlot(layout, p.x, p.y), '점이 플롯 안');
  }
});

test('꺾은선 차트: 음수 값이 있으면 y 눈금 범위가 음수까지 내려간다', () => {
  const spec: ChartSpec = {
    type: 'line',
    series: [{ name: 'A', values: [-8, 3, 12] }],
  };
  const layout = computeChartLayout(spec, 600, 360);
  assert.ok(layout.yTicks[0].value <= -8, '첫 눈금이 최솟값 이하');
  assert.ok(layout.yTicks[layout.yTicks.length - 1].value >= 12, '끝 눈금이 최댓값 이상');
});

test('y축 눈금: 단조 증가하며 데이터 범위 전체를 덮는다', () => {
  const layout = computeChartLayout(barSpec, 640, 400);
  const ticks = layout.yTicks;
  assert.ok(ticks.length >= 2);
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i].value > ticks[i - 1].value, '값이 단조 증가');
    assert.ok(ticks[i].pos < ticks[i - 1].pos, '픽셀 y 는 위로 갈수록 작아짐');
  }
  assert.ok(ticks[0].value <= 0, '최소 눈금 <= 데이터 최솟값(0 포함)');
  assert.ok(ticks[ticks.length - 1].value >= 30, '최대 눈금 >= 데이터 최댓값');
});

test('원형 차트: 슬라이스 각도 합이 2π 이고 값에 비례한다', () => {
  const spec: ChartSpec = {
    type: 'pie',
    series: [{ name: '비중', values: [1, 2, 3] }],
    categories: ['가', '나', '다'],
  };
  const layout = computeChartLayout(spec, 480, 360);
  assert.equal(layout.slices.length, 3);
  const spans = layout.slices.map((s) => s.endAngle - s.startAngle);
  const total = spans.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - Math.PI * 2) < 1e-9, '각도 합 = 2π');
  assert.ok(Math.abs(spans[0] - (Math.PI * 2) / 6) < 1e-9, '값 1 → 1/6');
  assert.ok(Math.abs(spans[1] - (Math.PI * 2) * (2 / 6)) < 1e-9, '값 2 → 2/6');
  assert.ok(Math.abs(spans[2] - (Math.PI * 2) * (3 / 6)) < 1e-9, '값 3 → 3/6');
  // 인접 슬라이스는 이어져 있어야 한다
  for (let i = 1; i < layout.slices.length; i++) {
    assert.ok(Math.abs(layout.slices[i].startAngle - layout.slices[i - 1].endAngle) < 1e-9);
  }
});

test('산점도: 모든 점이 플롯 영역 안에 있고 개수는 값 쌍 수와 같다', () => {
  const spec: ChartSpec = {
    type: 'scatter',
    series: [
      { name: 'P', values: [-3, 5, 0, -2, 7, 9] },
      { name: 'Q', values: [1, 1, 2, 4] },
    ],
  };
  const layout = computeChartLayout(spec, 600, 400);
  assert.equal(layout.points.length, 3 + 2);
  for (const p of layout.points) assert.ok(inPlot(layout, p.x, p.y), '점이 플롯 안');
  // x 눈금도 음수 x 값(-3)을 덮어야 한다
  assert.ok(layout.xTicks[0].value <= -3);
  assert.ok(layout.xTicks[layout.xTicks.length - 1].value >= 7);
});

test('검증: 빈 series 는 오류', () => {
  assert.throws(
    () => validateChartSpec({ type: 'bar', series: [] }),
    /at least one series/,
  );
});

test('검증: 빈 values 를 가진 계열은 오류', () => {
  assert.throws(
    () => validateChartSpec({ type: 'line', series: [{ name: 'A', values: [] }] }),
    /has no values/,
  );
});

test('검증: 파이 차트에 계열이 둘 이상이면 오류', () => {
  assert.throws(
    () => validateChartSpec({
      type: 'pie',
      series: [{ name: 'A', values: [1] }, { name: 'B', values: [2] }],
    }),
    /exactly one series/,
  );
});

test('검증: 막대/꺾은선 계열 길이 불일치는 오류', () => {
  assert.throws(
    () => validateChartSpec({
      type: 'bar',
      series: [{ name: 'A', values: [1, 2, 3] }, { name: 'B', values: [1, 2] }],
    }),
    /same length/,
  );
});

test('검증: 산점도 values 가 홀수 길이면 오류', () => {
  assert.throws(
    () => validateChartSpec({ type: 'scatter', series: [{ name: 'A', values: [1, 2, 3] }] }),
    /even number of values/,
  );
});

test('검증: NaN/Infinity 값은 오류', () => {
  assert.throws(
    () => validateChartSpec({ type: 'line', series: [{ name: 'A', values: [1, NaN] }] }),
    /non-finite/,
  );
  assert.throws(
    () => validateChartSpec({ type: 'bar', series: [{ name: 'A', values: [Infinity] }] }),
    /non-finite/,
  );
});

test('검증: 계열 12개 초과는 오류', () => {
  const series = Array.from({ length: 13 }, (_, i) => ({ name: `S${i}`, values: [1] }));
  assert.throws(() => validateChartSpec({ type: 'line', series }), /too many series/);
});

test('검증: 계열당 100 포인트 초과는 오류', () => {
  const values = Array.from({ length: 101 }, (_, i) => i);
  assert.throws(
    () => validateChartSpec({ type: 'line', series: [{ name: 'A', values }] }),
    /too many points/,
  );
});
