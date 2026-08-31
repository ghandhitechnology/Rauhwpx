/**
 * 첫 실행 마법사 진행 상태.
 *
 * 설정 탭·문체 보정과 별개인 한 칸. 한 번 끝내거나 건너뛰면
 * 다음 실행부터는 뜨지 않는다. 미리보기는 `?initial-setup=1`.
 */
export const INITIAL_SETUP_STORAGE_KEY = 'rhwp-initial-setup';

export type InitialSetupStepState = 'pending' | 'configured' | 'skipped' | 'done';

export interface InitialSetupRecord {
  version: 1;
  completed: boolean;
  completedAt: string | null;
  providerStep: Exclude<InitialSetupStepState, 'done'>;
  calibrationStep: Exclude<InitialSetupStepState, 'configured'>;
}

export interface InitialSetupStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: InitialSetupStorage | null): InitialSetupStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function defaultInitialSetup(): InitialSetupRecord {
  return {
    version: 1,
    completed: false,
    completedAt: null,
    providerStep: 'pending',
    calibrationStep: 'pending',
  };
}

function asStep<T extends InitialSetupStepState>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeInitialSetup(raw: unknown): InitialSetupRecord {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    version: 1,
    completed: src['completed'] === true,
    completedAt: typeof src['completedAt'] === 'string' ? src['completedAt'] : null,
    providerStep: asStep(src['providerStep'], ['pending', 'configured', 'skipped'] as const, 'pending'),
    calibrationStep: asStep(src['calibrationStep'], ['pending', 'done', 'skipped'] as const, 'pending'),
  };
}

export function loadInitialSetup(storage?: InitialSetupStorage | null): InitialSetupRecord {
  const store = resolveStorage(storage);
  if (!store) return defaultInitialSetup();
  try {
    const raw = store.getItem(INITIAL_SETUP_STORAGE_KEY);
    if (!raw) return defaultInitialSetup();
    return normalizeInitialSetup(JSON.parse(raw));
  } catch {
    return defaultInitialSetup();
  }
}

export function saveInitialSetup(
  partial: Partial<InitialSetupRecord>,
  storage?: InitialSetupStorage | null,
): InitialSetupRecord {
  const store = resolveStorage(storage);
  const next = normalizeInitialSetup({ ...loadInitialSetup(store), ...partial });
  if (!store) return next;
  try {
    store.setItem(INITIAL_SETUP_STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[initial-setup] localStorage 저장 실패:', err);
  }
  return next;
}

export function completeInitialSetup(
  partial: Pick<InitialSetupRecord, 'providerStep' | 'calibrationStep'>,
  storage?: InitialSetupStorage | null,
  now = () => new Date().toISOString(),
): InitialSetupRecord {
  return saveInitialSetup({
    ...partial,
    completed: true,
    completedAt: now(),
  }, storage);
}

export function isInitialSetupComplete(storage?: InitialSetupStorage | null): boolean {
  return loadInitialSetup(storage).completed === true;
}

/** `?initial-setup=1` (또는 값 없는 플래그) 이면 끝난 뒤에도 다시 연다. */
export function shouldForceInitialSetup(search?: string): boolean {
  const raw = search ?? (typeof location !== 'undefined' ? location.search : '');
  try {
    const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    if (!params.has('initial-setup')) return false;
    const value = params.get('initial-setup');
    return value === null || value === '' || value === '1' || value === 'true';
  } catch {
    return false;
  }
}

/** `?rau-failure=1` 이면 로그인 실패 복구 화면을 바로 연다. */
export function shouldForceRauFailurePreview(search?: string): boolean {
  const raw = search ?? (typeof location !== 'undefined' ? location.search : '');
  try {
    const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    if (!params.has('rau-failure')) return false;
    const value = params.get('rau-failure');
    return value === null || value === '' || value === '1' || value === 'true';
  } catch {
    return false;
  }
}

/** 자동화된 브라우저·임베드 프레임에서는 편집 화면을 가리지 않는다. */
export function shouldSuppressInitialSetup(): boolean {
  try {
    if (typeof navigator !== 'undefined' && navigator.webdriver === true) return true;
  } catch {
    // 접근 불가면 아래 프레임 검사로 넘어간다.
  }
  try {
    return typeof window !== 'undefined' && window.parent !== window;
  } catch {
    return true;
  }
}

export function shouldShowInitialSetup(storage?: InitialSetupStorage | null, search?: string): boolean {
  if (shouldForceInitialSetup(search)) return true;
  if (shouldSuppressInitialSetup()) return false;
  return !isInitialSetupComplete(storage);
}
