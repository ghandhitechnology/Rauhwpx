/**
 * 쓰기 결과 보고(after)의 순수 계산 — 변경 영역 자르기 계획, 쌓은 이미지의 배율,
 * 쪽을 옮겨 간 문단 판정. wasm/캔버스 없이 동작해 단위 테스트가 직접 검증한다.
 * 좌표는 모두 쪽 기준 px(96dpi, 배율 1)이다.
 */
import type { SelectionRect } from '../core/types.ts';

/** after.paragraphs 상한 — 문단 8개 × 200자 */
export const AFTER_MAX_PARAGRAPHS = 8;
export const AFTER_TEXT_CHARS = 200;
/** 편집 지점이 이보다 뒤면 문단 앞 대신 편집 지점 조금 앞부터 보여 준다 */
export const AFTER_WINDOW_LEAD = 40;
/** after.pages 상한 — 넘치면 morePages 로 개수만 알린다 */
export const AFTER_MAX_PAGES = 12;
/** 쪽 이동 보고 상한 — 나머지는 개수만 */
export const AFTER_MAX_MOVED_RUNS = 2;
/** 이보다 긴 문서는 쪽 시작 지도를 뜨지 않는다 (쪽마다 wasm 호출 한 번) */
export const PAGE_START_SCAN_LIMIT = 600;

export const RENDER_BASE_SCALE = 1.25;
export const RENDER_MAX_PIXELS = 1_150_000;
export const RENDER_MIN_SCALE = 0.8;
/** 쌓은 영역 사이 구분 띠 높이 (출력 px) */
export const RENDER_STACK_GAP_PX = 6;
/** 'page' 모드에서 쌓는 최대 쪽 수 */
export const RENDER_MAX_PAGES = 2;
const CROP_PAD_PX = 12;
/** 같은 쪽의 두 변경 사이가 이보다 가까우면 한 영역으로 묶는다 (~2줄) */
const CROP_CLUSTER_GAP_PX = 48;

export interface PageFrame { width: number; height: number; bodyLeft: number; bodyRight: number }
export interface CropRegion { pageIndex: number; x: number; y: number; width: number; height: number }

/**
 * 변경 사각형 → 쪽별 자르기 영역. 같은 쪽에서 가까운 사각형은 묶고, 가로는 본문 폭
 * 전체(줄 맥락)로 넓힌 뒤 여백을 더한다. 결과는 쪽 → 위에서 아래 순서다.
 */
export function planCropRegions(
  rects: readonly SelectionRect[],
  frameOf: (pageIndex: number) => PageFrame | null,
  pad = CROP_PAD_PX,
): CropRegion[] {
  const byPage = new Map<number, SelectionRect[]>();
  for (const r of rects) {
    if (![r.pageIndex, r.x, r.y, r.width, r.height].every(Number.isFinite)) continue;
    if (r.pageIndex < 0 || r.height <= 0 || r.width < 0) continue;
    const list = byPage.get(r.pageIndex);
    if (list) list.push(r);
    else byPage.set(r.pageIndex, [r]);
  }
  const regions: CropRegion[] = [];
  for (const pageIndex of [...byPage.keys()].sort((a, b) => a - b)) {
    const list = byPage.get(pageIndex)!.sort((a, b) => a.y - b.y);
    const frame = frameOf(pageIndex);
    const clusters: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
    for (const r of list) {
      const last = clusters[clusters.length - 1];
      if (last && r.y <= last.y1 + CROP_CLUSTER_GAP_PX) {
        last.x0 = Math.min(last.x0, r.x);
        last.x1 = Math.max(last.x1, r.x + r.width);
        last.y1 = Math.max(last.y1, r.y + r.height);
      } else {
        clusters.push({ x0: r.x, x1: r.x + r.width, y0: r.y, y1: r.y + r.height });
      }
    }
    const pageRegions: CropRegion[] = [];
    for (const c of clusters) {
      let x0 = c.x0 - pad;
      let x1 = c.x1 + pad;
      let y0 = c.y0 - pad;
      let y1 = c.y1 + pad;
      if (frame) {
        x0 = Math.max(0, Math.min(x0, frame.bodyLeft - pad));
        x1 = Math.min(frame.width, Math.max(x1, frame.bodyRight + pad));
        y0 = Math.max(0, y0);
        y1 = Math.min(frame.height, y1);
      } else {
        x0 = Math.max(0, x0);
        y0 = Math.max(0, y0);
      }
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      const prev = pageRegions[pageRegions.length - 1];
      if (prev && y0 <= prev.y + prev.height) {
        // 여백을 더한 뒤 겹치면 하나로 합친다
        const px1 = Math.max(prev.x + prev.width, x1);
        const py1 = Math.max(prev.y + prev.height, y1);
        prev.x = Math.min(prev.x, x0);
        prev.width = px1 - prev.x;
        prev.height = py1 - prev.y;
        continue;
      }
      pageRegions.push({ pageIndex, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    }
    regions.push(...pageRegions);
  }
  return regions;
}

export interface StackPlan {
  scale: number;
  regions: CropRegion[];
  /** 픽셀 예산을 넘어 싣지 못한 영역 수 */
  omitted: number;
  /** 첫 영역 하나도 예산을 넘어 아래를 잘랐다 */
  clipped: boolean;
  widthPx: number;
  heightPx: number;
}

/** n 개 영역을 쌓은 이미지가 maxPixels 안에 드는 가장 큰 배율 (base 이하) */
function fitScale(maxW: number, sumH: number, n: number, base: number, maxPixels: number, gap: number): number {
  // (maxW·s)·(sumH·s + gap·(n-1)) = maxPixels 의 양의 근
  const a = maxW * sumH;
  const b = maxW * gap * (n - 1);
  const s = (-b + Math.sqrt(b * b + 4 * a * maxPixels)) / (2 * a);
  return Math.min(base, s);
}

/**
 * 영역을 위에서 아래로 쌓을 계획 — 배율은 base(1.25) 에서 시작해 픽셀 예산에 맞춰
 * 줄이되 minScale 아래로는 내리지 않는다. 그 대신 뒤쪽 영역을 빼고(omitted), 첫
 * 영역마저 크면 아래를 자른다(clipped).
 */
export function planStack(
  input: readonly CropRegion[],
  opts: { base?: number; maxPixels?: number; minScale?: number; gap?: number } = {},
): StackPlan {
  const base = opts.base ?? RENDER_BASE_SCALE;
  const maxPixels = opts.maxPixels ?? RENDER_MAX_PIXELS;
  const minScale = opts.minScale ?? RENDER_MIN_SCALE;
  const gap = opts.gap ?? RENDER_STACK_GAP_PX;
  const regions: CropRegion[] = [];
  let scale = base;
  let clipped = false;
  let maxW = 0;
  let sumH = 0;
  for (const region of input) {
    const nextW = Math.max(maxW, region.width);
    const nextH = sumH + region.height;
    const s = fitScale(nextW, nextH, regions.length + 1, base, maxPixels, gap);
    if (s < minScale) {
      if (regions.length > 0) break;
      // 첫 영역도 예산을 넘는다 — minScale 로 두고 위쪽부터 들어가는 만큼만 싣는다
      const height = Math.max(1, Math.floor(maxPixels / (region.width * minScale * minScale)));
      regions.push({ ...region, height: Math.min(region.height, height) });
      maxW = region.width;
      sumH = regions[0].height;
      scale = Math.min(base, Math.sqrt(maxPixels / (maxW * sumH)));
      clipped = true;
      break;
    }
    regions.push({ ...region });
    maxW = nextW;
    sumH = nextH;
    scale = s;
  }
  const n = regions.length;
  return {
    scale,
    regions,
    omitted: input.length - n,
    clipped,
    widthPx: Math.ceil(maxW * scale),
    heightPx: n === 0 ? 0 : Math.ceil(sumH * scale + gap * (n - 1)),
  };
}

export interface PageStart { sec: number; para: number }
/** 구역별 편집 범위 — 편집 후 본문 문단 [lo, hi], 문단 수 변화 delta. 'all' = 구역 전체 */
export type SectionEdit = { lo: number; hi: number; delta: number } | 'all';
export interface MovedRun { sectionIdx: number; fromPara: number; toPara: number; fromPage: number; toPage: number }

function compareStart(a: PageStart, sec: number, para: number): number {
  return a.sec !== sec ? a.sec - sec : a.para - para;
}

/** (sec, para) 가 있는 쪽 — 시작이 그 문단 이하인 마지막 쪽. 쪽 시작 목록은 문서 순서다. */
export function pageOfParagraph(starts: readonly PageStart[], sec: number, para: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareStart(starts[mid], sec, para) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * 편집 전후 쪽 시작 지도를 비교해 편집 범위 밖에서 쪽이 바뀐 문단 구간을 찾는다.
 * 편집 전 시작 문단은 구역 delta 로 편집 후 좌표에 옮기고(편집 범위 안이면 lo 로
 * 붙인다), 편집된 문단과 'all' 구역은 보고하지 않는다. 쪽 번호는 0 기반이다.
 */
export function movedParagraphRuns(
  before: readonly PageStart[],
  after: readonly PageStart[],
  paraCounts: readonly number[],
  edits: ReadonlyMap<number, SectionEdit>,
): MovedRun[] {
  const mapped = before.map((st): PageStart => {
    const e = edits.get(st.sec);
    if (!e || e === 'all') return st;
    if (st.para < e.lo) return st;
    if (st.para > e.hi - e.delta) return { sec: st.sec, para: st.para + e.delta };
    return { sec: st.sec, para: e.lo };
  });
  const runs: MovedRun[] = [];
  for (let sec = 0; sec < paraCounts.length; sec++) {
    const e = edits.get(sec);
    if (e === 'all') continue;
    for (let para = 0; para < paraCounts[sec]; para++) {
      if (e && para >= e.lo && para <= e.hi) continue;
      const fromPage = pageOfParagraph(mapped, sec, para);
      const toPage = pageOfParagraph(after, sec, para);
      if (fromPage === toPage || fromPage < 0 || toPage < 0) continue;
      const last = runs[runs.length - 1];
      if (last && last.sectionIdx === sec && last.toPara === para - 1
        && last.fromPage === fromPage && last.toPage === toPage) {
        last.toPara = para;
      } else {
        runs.push({ sectionIdx: sec, fromPara: para, toPara: para, fromPage, toPage });
      }
    }
  }
  return runs;
}

/** 쪽 이동 구간 → 경고 문장 (앞 몇 개만, 나머지는 개수) */
export function movedRunWarnings(runs: readonly MovedRun[], limit = AFTER_MAX_MOVED_RUNS): string[] {
  const out = runs.slice(0, limit).map((r) => {
    const paras = r.fromPara === r.toPara ? `p${r.fromPara}` : `p${r.fromPara}-${r.toPara}`;
    return `s${r.sectionIdx} ${paras} moved from page ${r.fromPage} to ${r.toPage}`;
  });
  if (runs.length > limit) {
    const rest = runs.slice(limit).reduce((sum, r) => sum + (r.toPara - r.fromPara + 1), 0);
    out.push(`${rest} more paragraph(s) after the edit changed page`);
  }
  return out;
}
