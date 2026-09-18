/**
 * 다시 연결 / 서버 다시 만들기의 남은 시간 추정.
 *
 * 두 작업은 IPC 왕복이라 중간 진행률을 보고하지 않는다. 그래서 이 기기에서
 * 마지막으로 성공한 시간을 기억해 두고 다음 추정에 섞는다.
 */

export type LinkProgressKind = 'reconnecting' | 'recreating';

/** 진행 막대가 도달할 수 있는 최대치. 작업이 끝나기 전에 100%가 되면 안 된다. */
export const LINK_PROGRESS_CAP = 0.96;

/** 추정 시간이 흐르면 곡선이 천장의 약 86%에 닿도록 감쇠 상수를 정한다. */
const TAU_DIVISOR = 2.3;

const MIN_ESTIMATE_MS = 4_000;
const MAX_ESTIMATE_MS = 300_000;
const SMOOTHING = 0.4;
const STORAGE_KEY = 'rhwp.cloud.link-estimate.v1';

/** 관측된 시간이 아직 없을 때의 기본 추정. 서버 재생성은 샌드박스 할당까지 포함한다. */
const SEED_MS: Record<LinkProgressKind, number> = {
  reconnecting: 9_000,
  recreating: 75_000,
};

export function linkProgressRatio(elapsedMs: number, estimateMs: number): number {
  const elapsed = Math.max(0, elapsedMs);
  const tau = Math.max(1, estimateMs) / TAU_DIVISOR;
  return LINK_PROGRESS_CAP * (1 - Math.exp(-elapsed / tau));
}

export function formatLinkEta(remainingMs: number): string {
  if (remainingMs <= 0) return '마무리 중';
  if (remainingMs < 60_000) return `약 ${Math.ceil(remainingMs / 1000)}초 남음`;
  const seconds = Math.ceil(remainingMs / 5000) * 5;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes < 10 && rest > 0 ? `약 ${minutes}분 ${rest}초 남음` : `약 ${minutes}분 남음`;
}

export function linkEstimateMs(kind: LinkProgressKind): number {
  const stored = readStored()[kind];
  const value = typeof stored === 'number' && Number.isFinite(stored) ? stored : SEED_MS[kind];
  return clamp(value);
}

export function rememberLinkDuration(kind: LinkProgressKind, elapsedMs: number): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  const blended = Math.round(linkEstimateMs(kind) * (1 - SMOOTHING) + clamp(elapsedMs) * SMOOTHING);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ ...readStored(), [kind]: blended }));
  } catch { /* 저장이 막혀도 시드 추정으로 계속 동작한다. */ }
}

function clamp(ms: number): number {
  return Math.min(MAX_ESTIMATE_MS, Math.max(MIN_ESTIMATE_MS, ms));
}

function readStored(): Partial<Record<LinkProgressKind, number>> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed as Partial<Record<LinkProgressKind, number>> : {};
  } catch { return {}; }
}
