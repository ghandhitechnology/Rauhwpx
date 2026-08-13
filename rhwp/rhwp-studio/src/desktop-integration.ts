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
}

export interface DesktopHost {
  rhwpDesktop?: RhwpDesktopApi;
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
