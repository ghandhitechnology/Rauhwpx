/**
 * 고정 문서(dev 전용) — vite-plugin-pinned-document.mjs 의 클라이언트 쪽.
 *
 * 개발 서버가 들고 있는 작업본을 시작 시 불러오고, 편집이 멈추면 HWP로 내보내
 * 서버 작업본에 되돌려 쓴다. 새로고침하거나 다른 기기에서 열어도 같은 문서가 이어진다.
 */
import type { EventBus } from '@/core/event-bus';

const ROUTE = '/__pinned/document';
const SAVE_DELAY_MS = 800;

export function isPinnedDocumentEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_RHWP_PINNED_DOC === '1';
}

export interface PinnedDocumentHost {
  eventBus: EventBus;
  loadBytes(data: Uint8Array, fileName: string): Promise<void>;
  exportBytes(): Uint8Array;
  /** 서버 작업본에 반영된 뒤 호출한다. 저장 사이에 편집이 없었을 때만 불린다. */
  markSaved(): void;
}

export async function startPinnedDocument(host: PinnedDocumentHost): Promise<void> {
  const response = await fetch(ROUTE, { cache: 'no-store' });
  if (!response.ok) throw new Error(`고정 문서 로드 실패 (HTTP ${response.status})`);
  const fileName = decodeURIComponent(response.headers.get('X-Pinned-Name') ?? 'pinned.hwp');
  await host.loadBytes(new Uint8Array(await response.arrayBuffer()), fileName);

  let generation = 0;
  let savedGeneration = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;

  const save = async (): Promise<void> => {
    timer = null;
    if (saving) await saving;
    if (generation === savedGeneration) return;
    const target = generation;
    saving = (async () => {
      const bytes = host.exportBytes();
      const put = await fetch(ROUTE, { method: 'PUT', body: bytes as BodyInit });
      if (!put.ok) throw new Error(`HTTP ${put.status}`);
      savedGeneration = target;
      if (generation === target) host.markSaved();
    })()
      .catch((error) => console.warn('[pinned] 작업본 저장 실패:', error))
      .finally(() => { saving = null; });
    await saving;
  };

  const schedule = (): void => {
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DELAY_MS);
  };
  host.eventBus.on('document-mutated', schedule);
  host.eventBus.on('document-changed', schedule);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) {
      clearTimeout(timer);
      void save();
    }
  });
}
