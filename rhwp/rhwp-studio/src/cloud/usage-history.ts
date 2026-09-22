import type { AccountSnapshot, CloudSnapshot } from './types.ts';

export interface CloudUsageDay {
  date: string;
  usedMs: number;
  limitMs: number;
  observedAt: string;
}

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;
const PREFIX = 'rhwp-cloud-usage-v1:';
const DAY_MS = 86_400_000;

function storage(): HistoryStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function cloudUsageDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-');
}

export function readCloudUsage(account: AccountSnapshot | null | undefined, store = storage()): CloudUsageDay[] {
  if (!account?.signedIn || !account.account || !store) return [];
  try {
    const value: unknown = JSON.parse(store.getItem(PREFIX + encodeURIComponent(account.account.id)) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((day): day is CloudUsageDay => day && typeof day === 'object'
      && typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
      && Number.isFinite(day.usedMs) && day.usedMs >= 0
      && Number.isFinite(day.limitMs) && day.limitMs > 0
      && typeof day.observedAt === 'string' && Number.isFinite(Date.parse(day.observedAt)))
      .sort((a, b) => a.date.localeCompare(b.date)).slice(-31);
  } catch { return []; }
}

/** Save broker totals, never accumulate repeated snapshots or estimate billing. */
export function recordCloudUsage(snapshot: CloudSnapshot, store = storage()): void {
  const account = snapshot.account;
  const quota = account?.quota;
  if (!store || !account?.signedIn || !account.account || !quota
    || !Number.isFinite(quota.usedMs) || quota.usedMs < 0
    || !Number.isFinite(quota.dailyLimitMs) || quota.dailyLimitMs <= 0
    || !Number.isFinite(Date.parse(account.updatedAt))) return;
  try {
    // The reset boundary owns the billing day, even if a cached snapshot is stale.
    const date = cloudUsageDate(new Date(Date.parse(quota.resetAt) - 1), quota.timeZone);
    const days = readCloudUsage(account, store);
    const previous = days.find((day) => day.date === date);
    if (previous && Date.parse(previous.observedAt) >= Date.parse(account.updatedAt)) return;
    const next: CloudUsageDay = { date, usedMs: quota.usedMs, limitMs: quota.dailyLimitMs, observedAt: account.updatedAt };
    const updated = [...days.filter((day) => day.date !== date), next]
      .sort((a, b) => a.date.localeCompare(b.date)).slice(-31);
    store.setItem(PREFIX + encodeURIComponent(account.account.id), JSON.stringify(updated));
  } catch { /* Unavailable storage must never interrupt Cloud work. */ }
}

/** Missing days stay null; a day without observations is not zero usage. */
export function cloudUsageSeries(days: CloudUsageDay[], count: 7 | 30, now: Date, timeZone: string) {
  const today = cloudUsageDate(now, timeZone);
  const end = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end - (count - index - 1) * DAY_MS).toISOString().slice(0, 10);
    return { date, sample: days.find((day) => day.date === date) ?? null };
  });
}

export function cloudDashboardSessions(snapshot: CloudSnapshot) {
  const sessions = new Map(snapshot.sessions.map((session) => [session.sessionId, session]));
  if (snapshot.session.kind !== 'idle') sessions.set(snapshot.session.sessionId, snapshot.session);
  return [...sessions.values()];
}
