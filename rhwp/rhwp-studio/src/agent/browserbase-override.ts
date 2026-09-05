/**
 * 설정 탭에서 입력한 Browserbase 자격 증명의 탭 수명 보관소.
 *
 * sessionStorage 에 두므로 새로고침은 견디고 탭을 닫으면 사라진다 — "앱을 쓰는 동안만"
 * 환경 변수를 덮는다는 약속과 같은 수명이다. 허브도 디스크에 남기지 않는다.
 */
import type { BrowserbaseOverride } from './types.ts';

export const BROWSERBASE_OVERRIDE_STORAGE_KEY = 'rhwp-agent-browserbase-override';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function cleanField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 입력 칸 값 → 허브로 보낼 덮어쓰기. 키가 비면 null. */
export function buildBrowserbaseOverride(input: {
  apiKey: string;
  projectId?: string;
  geminiApiKey?: string;
}): BrowserbaseOverride | null {
  const apiKey = cleanField(input.apiKey);
  if (!apiKey) return null;
  const projectId = cleanField(input.projectId);
  const geminiApiKey = cleanField(input.geminiApiKey);
  return {
    apiKey,
    ...(projectId ? { projectId } : {}),
    ...(geminiApiKey ? { geminiApiKey } : {}),
  };
}

export function loadBrowserbaseOverride(store: StorageLike | null = defaultStore()): BrowserbaseOverride | null {
  if (!store) return null;
  try {
    const raw = store.getItem(BROWSERBASE_OVERRIDE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const apiKey = cleanField(record['apiKey']);
    if (!apiKey) return null;
    return buildBrowserbaseOverride({
      apiKey,
      projectId: typeof record['projectId'] === 'string' ? record['projectId'] : undefined,
      geminiApiKey: typeof record['geminiApiKey'] === 'string' ? record['geminiApiKey'] : undefined,
    });
  } catch {
    return null;
  }
}

export function saveBrowserbaseOverride(
  override: BrowserbaseOverride,
  store: StorageLike | null = defaultStore(),
): void {
  if (!store) return;
  try {
    store.setItem(BROWSERBASE_OVERRIDE_STORAGE_KEY, JSON.stringify(override));
  } catch {
    // 저장 공간이 막혀 있어도 허브 쪽 덮어쓰기는 이미 살아 있다.
  }
}

export function clearBrowserbaseOverride(store: StorageLike | null = defaultStore()): void {
  if (!store) return;
  try {
    store.removeItem(BROWSERBASE_OVERRIDE_STORAGE_KEY);
  } catch {
    // 무시 — 탭이 닫히면 어차피 사라진다.
  }
}
