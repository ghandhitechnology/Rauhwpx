import type { ProviderQuota, RemoteBalance } from './types.ts';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function window(value: unknown): ProviderQuota['session'] {
  const src = object(value);
  const percent = number(src['percent']);
  return {
    percent: percent === null ? null : Math.min(100, Math.max(0, percent)),
    resetsAt: number(src['resetsAt']),
  };
}

/** 알 수 없는 잔액과 사용량은 0으로 바꾸지 않는다. */
export function readProviderQuota(value: unknown): ProviderQuota {
  const src = object(value);
  const credits = object(src['resetCredits']);
  const count = number(credits['availableCount']);
  return {
    status: src['status'] === 'ok' || src['status'] === 'error' ? src['status'] : 'unavailable',
    session: window(src['session']),
    week: window(src['week']),
    updatedAt: number(src['updatedAt']),
    error: typeof src['error'] === 'string' ? src['error'] : null,
    accountKey: typeof src['accountKey'] === 'string' ? src['accountKey'] : null,
    planType: typeof src['planType'] === 'string' ? src['planType'] : null,
    resetCredits: count !== null && Number.isSafeInteger(count) && count >= 0
      ? { availableCount: count, nextExpiresAt: number(credits['nextExpiresAt']) } : null,
  };
}

/** 원격 잔액이 없거나 잘못된 경우 0달러로 표시하지 않는다. */
export function readRemoteBalance(value: unknown): RemoteBalance {
  const src = object(value);
  return {
    status: src['status'] === 'ok' || src['status'] === 'error' ? src['status'] : 'unavailable',
    ...(Array.isArray(src['windows']) ? { windows: src['windows'].flatMap((value) => {
      const entry = object(value);
      const remaining = number(entry['remainingPercent']);
      return typeof entry['label'] === 'string' && remaining !== null
        ? [{ label: entry['label'], remainingPercent: Math.min(100, Math.max(0, remaining)), resetsAt: number(entry['resetsAt']) }] : [];
    }) } : {}),
    balanceUsd: number(src['balanceUsd']),
    totalCreditsUsd: number(src['totalCreditsUsd']),
    totalUsageUsd: number(src['totalUsageUsd']),
    updatedAt: number(src['updatedAt']),
    source: typeof src['source'] === 'string' ? src['source'] : null,
    error: typeof src['error'] === 'string' ? src['error'] : null,
  };
}
