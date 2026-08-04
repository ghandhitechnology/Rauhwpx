/**
 * 에이전트 차트 렌더링 모듈.
 *
 * insert_chart MCP 툴이 사용하는 3단계 파이프라인:
 *   validateChartSpec → computeChartLayout(순수 계산) → renderChartToCanvas(그리기)
 *
 * computeChartLayout 은 DOM/캔버스 없이 좌표·기하만 계산하므로 node --test 로
 * 단위 테스트가 가능하다. renderChartPng 는 브라우저 전용(OffscreenCanvas) 경로.
 */

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie' | 'scatter';
  title?: string;
  series: Array<{ name: string; values: number[] }>;
  categories?: string[];
  xLabel?: string;
  yLabel?: string;
}

/** 시각적으로 구분이 잘 되는 인쇄 친화적 8색 팔레트 */
const PALETTE = [
  '#3B6FBF', '#D97757', '#4C9A73', '#B0619A',
  '#C9A227', '#5B8BA8', '#8A66A8', '#6B7280',
] as const;

const MAX_SERIES = 12;
const MAX_POINTS = 100;

/**
 * 차트 스펙 검증. 문제가 있으면 영문 메시지의 Error 를 던진다
 * (에이전트 CLI 쪽으로 그대로 전달되는 메시지).
 */
export function validateChartSpec(spec: ChartSpec): void {
  if (!Array.isArray(spec.series) || spec.series.length === 0) {
    throw new Error('chart spec must contain at least one series');
  }
  if (spec.series.length > MAX_SERIES) {
    throw new Error(`too many series: ${spec.series.length} (max ${MAX_SERIES})`);
  }
  for (let i = 0; i < spec.series.length; i++) {
    const s = spec.series[i];
    if (!Array.isArray(s.values) || s.values.length === 0) {
      throw new Error(`series ${i} ("${s?.name ?? ''}") has no values`);
    }
    if (s.values.length > MAX_POINTS) {
      throw new Error(`series ${i} has too many points: ${s.values.length} (max ${MAX_POINTS})`);
    }
    for (const v of s.values) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`series ${i} contains a non-finite value: ${String(v)}`);
      }
    }
  }
  if (spec.type === 'pie') {
    if (spec.series.length > 1) {
      throw new Error('pie chart supports exactly one series');
    }
    for (const v of spec.series[0].values) {
      if (v < 0) throw new Error('pie chart values must be non-negative');
    }
  }
  if (spec.type === 'bar' || spec.type === 'line') {
    const n = spec.series[0].values.length;
    for (let i = 1; i < spec.series.length; i++) {
      if (spec.series[i].values.length !== n) {
        throw new Error(
          `all series must have the same length for ${spec.type} charts `
          + `(series 0 has ${n}, series ${i} has ${spec.series[i].values.length})`,
        );
      }
    }
    if (spec.categories && spec.categories.length !== n) {
      throw new Error(
        `categories length (${spec.categories.length}) must match values length (${n})`,
      );
    }
  }
  if (spec.type === 'scatter') {
    for (let i = 0; i < spec.series.length; i++) {
      if (spec.series[i].values.length % 2 !== 0) {
        throw new Error(
          `scatter series ${i} must have an even number of values ([x0,y0,x1,y1,...])`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 레이아웃 자료구조 (순수 데이터 — 렌더러는 이것만 보고 그린다)
// ---------------------------------------------------------------------------

export interface AxisTick {
  value: number;
  /** 픽셀 위치 (x축이면 x 좌표, y축이면 y 좌표) */
  pos: number;
  label: string;
}

export interface GridLine { x1: number; y1: number; x2: number; y2: number; }

export interface BarRect {
  x: number; y: number; w: number; h: number;
  color: string;
  seriesIdx: number;
}

export interface LinePolyline {
  points: Array<{ x: number; y: number }>;
  color: string;
  seriesIdx: number;
}

export interface PieSlice {
  /** 라디안, -π/2(12시 방향)에서 시작해 시계 방향으로 증가 */
  startAngle: number;
  endAngle: number;
  color: string;
  labelPos: { x: number; y: number };
  /** 슬라이스 위에 표시할 텍스트(백분율) */
  label: string;
}

export interface ScatterPoint { x: number; y: number; color: string; seriesIdx: number; }

export interface LegendEntry { label: string; color: string; x: number; y: number; }

export interface TextAnchor { text: string; x: number; y: number; }

export interface ChartLayout {
  type: ChartSpec['type'];
  width: number;
  height: number;
  /** 데이터가 그려지는 영역 (축 안쪽) */
  plot: { x: number; y: number; w: number; h: number };
  title?: TextAnchor;
  xLabel?: TextAnchor;
  /** 렌더러가 -90도 회전해 그리는 y축 제목 */
  yLabel?: TextAnchor;
  xTicks: AxisTick[];
  yTicks: AxisTick[];
  gridLines: GridLine[];
  /** 값 0 의 y 픽셀 위치 (0 이 y 범위 안에 있을 때만) */
  zeroY?: number;
  seriesColors: string[];
  bars: BarRect[];
  lines: LinePolyline[];
  slices: PieSlice[];
  points: ScatterPoint[];
  legend: LegendEntry[];
  pieCenter?: { x: number; y: number; r: number };
}

// ---------------------------------------------------------------------------
// 눈금 계산 (1/2/5 스텝의 "nice" 눈금)
// ---------------------------------------------------------------------------

/** Graphics Gems 방식: range 를 1/2/5×10^n 으로 반올림 */
function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nice: number;
  if (round) nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * Math.pow(10, exp);
}

interface NiceScale { min: number; max: number; step: number; ticks: number[]; }

/** [min,max] 를 덮는 nice 눈금열 계산. min===max 도 안전하게 처리 */
function niceScale(min: number, max: number, maxTicks: number = 6): NiceScale {
  if (min === max) {
    if (min === 0) max = 1;
    else if (min > 0) min = 0;
    else max = 0;
  }
  const step = niceNum(niceNum(max - min, false) / (maxTicks - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const count = Math.round((niceMax - niceMin) / step);
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) {
    // 누적 오차를 피하기 위해 인덱스 기반으로 계산 후 소수점 노이즈 제거
    ticks.push(Number((niceMin + i * step).toFixed(10)));
  }
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

/** 눈금 라벨 문자열 (step 의 자릿수만큼 소수 표시) */
function formatTick(v: number, step: number): string {
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const s = v.toFixed(Math.min(dec, 6));
  return s === '-0' ? '0' : s;
}

/** 캔버스 없이 쓰는 대략적 텍스트 폭 추정 (한글 등 전각 문자는 넓게) */
function estimateTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0)! > 0x2e80 ? 12 : 7;
  return w;
}

// ---------------------------------------------------------------------------
// 레이아웃 계산 (순수 함수)
// ---------------------------------------------------------------------------

/**
 * 차트 스펙 + 캔버스 크기 → 그릴 것 전부를 담은 레이아웃.
 * DOM/캔버스를 전혀 사용하지 않으므로 그대로 단위 테스트할 수 있다.
 */
export function computeChartLayout(spec: ChartSpec, widthPx: number, heightPx: number): ChartLayout {
  validateChartSpec(spec);

  const seriesColors = spec.series.map((_, i) => PALETTE[i % PALETTE.length]);

  // 범례 항목: 파이는 카테고리별, 나머지는 계열별
  const legendLabels: string[] = spec.type === 'pie'
    ? spec.series[0].values.map((_, i) => spec.categories?.[i] ?? `항목 ${i + 1}`)
    : spec.series.map((s, i) => s.name || `계열 ${i + 1}`);
  const legendColors = legendLabels.map((_, i) => PALETTE[i % PALETTE.length]);
  const legendW = Math.min(
    160,
    Math.max(70, 16 + Math.max(...legendLabels.map(estimateTextWidth)) + 12),
  );

  // y축 스케일 (파이 제외). 막대는 항상 0 을 포함, 선/산점도는 음수 범위 그대로.
  let yScale: NiceScale | null = null;
  let xScale: NiceScale | null = null; // 산점도 전용
  if (spec.type === 'bar' || spec.type === 'line') {
    const all = spec.series.flatMap((s) => s.values);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (spec.type === 'bar') { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    yScale = niceScale(lo, hi);
  } else if (spec.type === 'scatter') {
    const xs = spec.series.flatMap((s) => s.values.filter((_, i) => i % 2 === 0));
    const ys = spec.series.flatMap((s) => s.values.filter((_, i) => i % 2 === 1));
    xScale = niceScale(Math.min(...xs), Math.max(...xs));
    yScale = niceScale(Math.min(...ys), Math.max(...ys));
  }

  // 마진: y축 라벨 폭·제목·x축 제목·범례를 반영해 플롯 영역을 잡는다
  const top = spec.title ? 44 : 18;
  const bottom = spec.type === 'pie' ? 14 : 34 + (spec.xLabel ? 18 : 0);
  let left = 14;
  if (yScale) {
    const labelW = Math.max(...yScale.ticks.map((t) => estimateTextWidth(formatTick(t, yScale!.step))));
    left = Math.max(40, labelW + 14) + (spec.yLabel ? 18 : 0);
  }
  const right = 14 + legendW;
  const plot = {
    x: left,
    y: top,
    w: Math.max(10, widthPx - left - right),
    h: Math.max(10, heightPx - top - bottom),
  };

  const layout: ChartLayout = {
    type: spec.type,
    width: widthPx,
    height: heightPx,
    plot,
    xTicks: [],
    yTicks: [],
    gridLines: [],
    seriesColors,
    bars: [],
    lines: [],
    slices: [],
    points: [],
    legend: legendLabels.map((label, i) => ({
      label,
      color: legendColors[i],
      x: plot.x + plot.w + 12,
      y: plot.y + 8 + i * 18,
    })),
  };

  if (spec.title) layout.title = { text: spec.title, x: widthPx / 2, y: 26 };
  if (spec.xLabel && spec.type !== 'pie') {
    layout.xLabel = { text: spec.xLabel, x: plot.x + plot.w / 2, y: heightPx - 8 };
  }
  if (spec.yLabel && spec.type !== 'pie') {
    layout.yLabel = { text: spec.yLabel, x: 14, y: plot.y + plot.h / 2 };
  }

  // 값 → 픽셀 변환
  const vToY = (v: number): number =>
    plot.y + (plot.h * (yScale!.max - v)) / (yScale!.max - yScale!.min);
  const vToX = (v: number): number =>
    plot.x + (plot.w * (v - xScale!.min)) / (xScale!.max - xScale!.min);

  // y축 눈금 + 수평 그리드
  if (yScale) {
    for (const t of yScale.ticks) {
      const y = vToY(t);
      layout.yTicks.push({ value: t, pos: y, label: formatTick(t, yScale.step) });
      layout.gridLines.push({ x1: plot.x, y1: y, x2: plot.x + plot.w, y2: y });
    }
    if (yScale.min <= 0 && yScale.max >= 0) layout.zeroY = vToY(0);
  }

  if (spec.type === 'bar' || spec.type === 'line') {
    const n = spec.series[0].values.length;
    const slotW = plot.w / n;
    // 카테고리 라벨은 겹치지 않도록 최대 ~10개만 표시
    const labelEvery = Math.max(1, Math.ceil(n / 10));
    for (let i = 0; i < n; i++) {
      layout.xTicks.push({
        value: i,
        pos: plot.x + (i + 0.5) * slotW,
        label: i % labelEvery === 0 ? (spec.categories?.[i] ?? String(i + 1)) : '',
      });
    }

    if (spec.type === 'bar') {
      // 그룹 막대: 카테고리 슬롯의 72% 를 그룹이 차지, 계열 수만큼 균등 분할
      const groupW = slotW * 0.72;
      const barW = groupW / spec.series.length;
      const zero = vToY(0);
      for (let i = 0; i < n; i++) {
        const groupX = plot.x + i * slotW + (slotW - groupW) / 2;
        for (let k = 0; k < spec.series.length; k++) {
          const y = vToY(spec.series[k].values[i]);
          layout.bars.push({
            x: groupX + k * barW,
            y: Math.min(zero, y),
            w: barW,
            h: Math.abs(zero - y),
            color: seriesColors[k],
            seriesIdx: k,
          });
        }
      }
    } else {
      for (let k = 0; k < spec.series.length; k++) {
        layout.lines.push({
          points: spec.series[k].values.map((v, i) => ({
            x: plot.x + (i + 0.5) * slotW,
            y: vToY(v),
          })),
          color: seriesColors[k],
          seriesIdx: k,
        });
      }
    }
  } else if (spec.type === 'scatter') {
    for (const t of xScale!.ticks) {
      const x = vToX(t);
      layout.xTicks.push({ value: t, pos: x, label: formatTick(t, xScale!.step) });
      layout.gridLines.push({ x1: x, y1: plot.y, x2: x, y2: plot.y + plot.h });
    }
    for (let k = 0; k < spec.series.length; k++) {
      const vals = spec.series[k].values;
      for (let i = 0; i + 1 < vals.length; i += 2) {
        layout.points.push({
          x: vToX(vals[i]),
          y: vToY(vals[i + 1]),
          color: seriesColors[k],
          seriesIdx: k,
        });
      }
    }
  } else {
    // 파이: 플롯 영역 중앙의 원, 12시 방향에서 시계 방향으로
    const cx = plot.x + plot.w / 2;
    const cy = plot.y + plot.h / 2;
    const r = Math.max(10, Math.min(plot.w, plot.h) / 2 - 10);
    layout.pieCenter = { x: cx, y: cy, r };
    const values = spec.series[0].values;
    const total = values.reduce((a, b) => a + b, 0);
    let angle = -Math.PI / 2;
    for (let i = 0; i < values.length; i++) {
      // total 이 0 이면 모든 슬라이스를 균등 분할해 빈 차트를 피한다
      const frac = total > 0 ? values[i] / total : 1 / values.length;
      const end = angle + frac * Math.PI * 2;
      const mid = (angle + end) / 2;
      layout.slices.push({
        startAngle: angle,
        endAngle: end,
        color: PALETTE[i % PALETTE.length],
        labelPos: { x: cx + Math.cos(mid) * r * 0.62, y: cy + Math.sin(mid) * r * 0.62 },
        label: `${(frac * 100).toFixed(0)}%`,
      });
      angle = end;
    }
  }

  return layout;
}

// ---------------------------------------------------------------------------
// 캔버스 렌더링
// ---------------------------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** 레이아웃을 캔버스에 그린다. 좌표·기하는 전부 layout 에서 온다. */
export function renderChartToCanvas(ctx: Ctx2D, layout: ChartLayout): void {
  const { plot } = layout;

  // 배경
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, layout.width, layout.height);

  // 그리드
  ctx.strokeStyle = '#E5E7EB';
  ctx.lineWidth = 1;
  for (const g of layout.gridLines) {
    ctx.beginPath();
    ctx.moveTo(g.x1, g.y1);
    ctx.lineTo(g.x2, g.y2);
    ctx.stroke();
  }

  // 축 (파이는 축 없음)
  if (layout.type !== 'pie') {
    ctx.strokeStyle = '#9CA3AF';
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y);
    ctx.lineTo(plot.x, plot.y + plot.h);
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
    ctx.stroke();
    // 0 기준선 (음수 값이 있을 때 시각적 기준)
    if (layout.zeroY !== undefined) {
      ctx.strokeStyle = '#6B7280';
      ctx.beginPath();
      ctx.moveTo(plot.x, layout.zeroY);
      ctx.lineTo(plot.x + plot.w, layout.zeroY);
      ctx.stroke();
    }
  }

  // 눈금 라벨
  ctx.fillStyle = '#374151';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of layout.yTicks) ctx.fillText(t.label, plot.x - 6, t.pos);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of layout.xTicks) {
    if (t.label) ctx.fillText(t.label, t.pos, plot.y + plot.h + 6);
  }

  // 막대
  for (const b of layout.bars) {
    ctx.fillStyle = b.color;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }

  // 꺾은선 (+ 데이터 점)
  for (const line of layout.lines) {
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    line.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.fillStyle = line.color;
    for (const p of line.points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 파이 슬라이스 + 백분율 라벨
  if (layout.pieCenter) {
    const { x: cx, y: cy, r } = layout.pieCenter;
    for (const s of layout.slices) {
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, s.startAngle, s.endAngle);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of layout.slices) {
      if (s.endAngle - s.startAngle > 0.15) ctx.fillText(s.label, s.labelPos.x, s.labelPos.y);
    }
  }

  // 산점도
  for (const p of layout.points) {
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 범례
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const e of layout.legend) {
    ctx.fillStyle = e.color;
    ctx.fillRect(e.x, e.y - 5, 10, 10);
    ctx.fillStyle = '#374151';
    ctx.fillText(e.label, e.x + 15, e.y);
  }

  // 제목 / 축 제목
  ctx.fillStyle = '#111827';
  if (layout.title) {
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(layout.title.text, layout.title.x, layout.title.y);
  }
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#374151';
  if (layout.xLabel) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(layout.xLabel.text, layout.xLabel.x, layout.xLabel.y);
  }
  if (layout.yLabel) {
    ctx.save();
    ctx.translate(layout.yLabel.x, layout.yLabel.y);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(layout.yLabel.text, 0, 0);
    ctx.restore();
  }
}

/**
 * 차트 스펙 → PNG 바이트. 브라우저 전용(OffscreenCanvas 필요).
 * devicePixelRatio 2 로 렌더링해 문서 삽입 시에도 선명하게 보이도록 한다.
 */
export async function renderChartPng(
  spec: ChartSpec,
  widthPx: number,
  heightPx: number,
): Promise<Uint8Array> {
  validateChartSpec(spec);
  const layout = computeChartLayout(spec, widthPx, heightPx);
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas unavailable');
  }
  const scale = 2;
  const canvas = new OffscreenCanvas(widthPx * scale, heightPx * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('failed to acquire 2d canvas context');
  ctx.scale(scale, scale);
  renderChartToCanvas(ctx, layout);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}
