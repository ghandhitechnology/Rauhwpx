/**
 * Electron 데스크톱 셸이 preload 로 노출하는 허브 제어.
 *
 * 브라우저(PWA)에서는 no-op 이다. 데스크톱에서는 허브가 죽어 있으면
 * 메인 프로세스가 healthz 를 보고 다시 띄운다.
 */

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

export function isDesktopApp(win?: DesktopHost): boolean {
  if (typeof desktopHost(win)?.rhwpDesktop?.ensureAgentHub === 'function') return true;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Electron/i.test(ua);
}

export async function ensureDesktopAgentHub(win?: DesktopHost): Promise<boolean> {
  const ensure = desktopHost(win)?.rhwpDesktop?.ensureAgentHub;
  if (typeof ensure !== 'function') return false;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const result = await ensure();
      if (result && typeof result === 'object') return result.ready !== false;
      return Boolean(result);
    } catch (error) {
      console.warn('[rhwp-desktop] 허브 기동 요청 실패:', error);
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
