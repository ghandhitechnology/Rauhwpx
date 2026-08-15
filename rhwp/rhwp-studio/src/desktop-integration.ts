/**
 * 로컬 에이전트 허브 기동.
 *
 * Electron 은 preload IPC 로 메인 프로세스가 허브를 띄운다.
 * Vite 개발 서버는 `/__rhwp/ensure-agent-hub` 가 같은 일을 한다.
 * 패키지된 PWA/브라우저는 Node 를 띄울 수 없어 no-op 이다.
 */

export const DEV_AGENT_HUB_ENSURE_PATH = '/__rhwp/ensure-agent-hub';

export interface RhwpDesktopApi {
  ensureAgentHub: () => Promise<{ started?: boolean; ready?: boolean } | boolean>;
  platform?: string;
  isFullScreen?: () => Promise<boolean>;
  onFullScreenChange?: (callback: (fullscreen: boolean) => void) => void;
}

export interface DesktopHost {
  rhwpDesktop?: RhwpDesktopApi;
  navigator?: {
    serviceWorker?: {
      getRegistrations: () => Promise<ReadonlyArray<{ unregister: () => Promise<boolean> }>>;
      addEventListener: (type: string, listener: () => void) => void;
    };
  };
}

let inflight: Promise<boolean> | null = null;

function desktopHost(win?: DesktopHost): DesktopHost | undefined {
  return win ?? (typeof globalThis !== 'undefined' ? (globalThis as DesktopHost) : undefined);
}

function isDevBuild(): boolean {
  return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
}

export function isDesktopApp(win?: DesktopHost): boolean {
  if (typeof desktopHost(win)?.rhwpDesktop?.ensureAgentHub === 'function') return true;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Electron/i.test(ua);
}

export async function requestDevAgentHub(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  if (typeof fetchImpl !== 'function') return false;
  try {
    const response = await fetchImpl(DEV_AGENT_HUB_ENSURE_PATH, { method: 'POST' });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ready === true;
  } catch (error) {
    console.warn('[rhwp-desktop] 개발 서버 허브 기동 실패:', error);
    return false;
  }
}

function readEnsureResult(result: { ready?: boolean } | boolean | undefined): boolean {
  if (result && typeof result === 'object') return result.ready !== false;
  return Boolean(result);
}

export async function ensureDesktopAgentHub(win?: DesktopHost): Promise<boolean> {
  if (inflight) return inflight;
  const ensure = desktopHost(win)?.rhwpDesktop?.ensureAgentHub;
  const run = (async () => {
    try {
      if (typeof ensure === 'function') return readEnsureResult(await ensure());
      if (isDevBuild()) return requestDevAgentHub();
      return false;
    } catch (error) {
      console.warn('[rhwp-desktop] 허브 기동 요청 실패:', error);
      return false;
    }
  })();
  inflight = run;
  void run.finally(() => {
    if (inflight === run) inflight = null;
  });
  return run;
}

/**
 * macOS Electron 창 크롬 연동.
 *
 * 셸이 titleBarStyle: 'hidden' 으로 뜨므로 메뉴바가 창 최상단을 차지한다.
 * `desktop-mac` 클래스로 신호등 버튼 자리(왼쪽 여백)와 드래그 영역을 켜고,
 * 전체 화면에서는 신호등이 사라지므로 `desktop-fullscreen` 으로 여백을 되돌린다.
 */
export function installDesktopWindowChrome(win?: DesktopHost): void {
  if (!isDesktopApp(win) || typeof document === 'undefined') return;
  const api = desktopHost(win)?.rhwpDesktop;
  const platform = api?.platform
    ?? (typeof navigator !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent)
      ? 'darwin'
      : '');
  if (platform !== 'darwin') return;
  const root = document.documentElement;
  root.classList.add('desktop-mac');
  const setFullscreen = (fullscreen: boolean) => {
    root.classList.toggle('desktop-fullscreen', fullscreen);
  };
  api?.onFullScreenChange?.(setFullscreen);
  void api?.isFullScreen?.().then(setFullscreen).catch(() => {
    /* IPC 미지원 셸에서는 기본(비전체화면) 상태 유지 */
  });
}

type ServiceWorkerLike = NonNullable<NonNullable<DesktopHost['navigator']>['serviceWorker']>;

function serviceWorkerContainer(win?: DesktopHost): ServiceWorkerLike | undefined {
  const host = desktopHost(win);
  return host?.navigator?.serviceWorker
    ?? (typeof navigator !== 'undefined'
      ? navigator.serviceWorker as unknown as ServiceWorkerLike
      : undefined);
}

/** Electron 셸에서는 PWA SW가 IndexedDB 할당량 정리로 최근문서/자동저장 open을 멈출 수 있다. */
export async function suppressDesktopServiceWorker(win?: DesktopHost): Promise<void> {
  if (!isDesktopApp(win)) return;
  const sw = serviceWorkerContainer(win);
  if (!sw?.getRegistrations) return;
  const unregisterAll = async () => {
    try {
      const regs = await sw.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    } catch {
      /* ignore */
    }
  };
  await unregisterAll();
  sw.addEventListener?.('controllerchange', () => {
    void unregisterAll();
  });
}

/** 브라우저 PWA만 등록하고, Electron 은 기존 SW를 끈다. */
export function installWebAppShell(win?: DesktopHost): void {
  if (isDesktopApp(win)) {
    void suppressDesktopServiceWorker(win);
    return;
  }
  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({ immediate: true });
    })
    .catch(() => {
      /* 테스트·개발 번들에는 virtual module이 없을 수 있다 */
    });
}
