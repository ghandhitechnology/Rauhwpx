/**
 * 사용량 표기 — 설정 탭의 미터/표가 쓰는 순수 함수들.
 *
 * settings.ts 는 CSS 를 가져오므로 Node 테스트에서 불러올 수 없다. 계기판
 * 숫자 규칙은 여기 따로 두고 직접 검증한다.
 */

/** 1.2M / 340K / 980 — 자리 수가 늘어도 폭이 흔들리지 않는 짧은 표기. */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** 방금 / n분 전 / n시간 전 / n일 전. */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** Compact English age for provider usage cards. */
export function formatUsageAge(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** n분 후 리셋 / n시간 후 리셋 — 공식 창이 언제 열리는지. */
export function formatResetAt(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const diff = timestamp - now;
  if (diff <= 0) return '곧 리셋';
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `${minutes}분 후 리셋`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}시간 후 리셋`;
  return `${Math.floor(hours / 24)}일 후 리셋`;
}

/** Compact English reset time for provider usage meters. */
export function formatUsageReset(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const diff = timestamp - now;
  if (diff <= 0) return 'Resets soon';
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Resets in ${hours}h`;
  return `Resets in ${Math.floor(hours / 24)}d`;
}

/** YYYY.MM.DD — 보정 시각처럼 날짜만 필요한 자리. */
export function formatShortDate(iso: string | null): string {
  if (!iso) return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return `${when.getFullYear()}.${month}.${day}`;
}
