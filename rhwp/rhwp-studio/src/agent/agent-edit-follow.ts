import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { AgentName, CellAddr, DocRange } from './types.ts';
import { computeExactTextDiff, pointAtNewScalarOffset } from './exact-text-diff.ts';

/** insertText/replaceText 가 emit 하는 이벤트 페이로드. range 는 op.range 의
 * 라이브 참조다 — 이후 op 들의 좌표 shift 가 그대로 반영된다. */
export interface AgentTextInsertedEvent {
  agent: AgentName;
  range: DocRange;
  text: string;
  /** 교체 원문. 있으면 원문과 같은 접두는 건너뛰고 추가분의 시작으로 이동한다. */
  oldText?: string;
}

/** 새 페이지 배치를 기다리는 대상은 이 시간이 지나면 버린다. */
const MAX_TARGET_AGE_MS = 2000;

/** 새 문자열에서 추가·교체된 첫 글자의 스칼라 오프셋. 삭제만 있으면 null. */
function firstAddedOffset(text: string, oldText?: string): number | null {
  if (oldText === undefined) return text.length > 0 ? 0 : null;
  const hunk = computeExactTextDiff(oldText, text).hunks.find((h) => h.newEnd > h.newStart);
  return hunk ? hunk.newStart : null;
}

function cellPathAt(cell: CellAddr, paraIdx: number): string {
  const path = cell.path ?? [];
  return JSON.stringify(path.map((entry, index) => index === path.length - 1
    ? { ...entry, cellParaIndex: paraIdx }
    : entry));
}

/**
 * 에이전트 편집 위치 따라가기.
 *
 * 편집은 문서에 즉시 커밋·렌더된다. 배치의 마지막 텍스트 편집이 화면 밖이면
 * 조판이 끝난 뒤 그 위치로 한 번에 스크롤한다. 새로 생긴 페이지가 가상 스크롤에
 * 아직 없으면 다음 mutation 조판 완료(document-layout-refreshed)에서 다시 시도한다.
 */
export class AgentEditFollow {
  private target: { event: AgentTextInsertedEvent; at: number } | null = null;
  private scheduled = false;
  private unsubs: Array<() => void> = [];
  private deps: { canvasView: CanvasView; wasm: WasmBridge; eventBus: EventBus };

  constructor(deps: { canvasView: CanvasView; wasm: WasmBridge; eventBus: EventBus }) {
    this.deps = deps;
    this.unsubs.push(
      deps.eventBus.on('agent-text-inserted', (payload) => {
        this.target = { event: payload as AgentTextInsertedEvent, at: performance.now() };
        if (this.scheduled) return;
        this.scheduled = true;
        // 배치의 모든 동기 편집·조판이 끝난 뒤 한 번만 위치를 구한다.
        queueMicrotask(() => {
          this.scheduled = false;
          this.flush();
        });
      }),
      deps.eventBus.on('document-layout-refreshed', () => this.flush()),
    );
  }

  /** 대기 중인 이동을 버린다 (approve/reject/무효화/문서 교체). */
  cancel(): void {
    this.target = null;
  }

  dispose(): void {
    for (const un of this.unsubs) un();
    this.unsubs = [];
    this.cancel();
  }

  private flush(): void {
    const target = this.target;
    if (!target) return;
    const { range, text, oldText } = target.event;
    const offset = firstAddedOffset(text, oldText);
    let pos: { top: number; height: number } | 'unplaced' | null = null;
    if (offset !== null) {
      try {
        pos = this.editPosition(range, pointAtNewScalarOffset(range, text, offset));
      } catch {
        // 주소 드리프트(사용자 편집/승인 경합) — 이동을 생략한다.
      }
    }
    // 새 페이지가 아직 배치 전이면 다음 조판 완료에서 재시도한다.
    if (pos === 'unplaced' && performance.now() - target.at <= MAX_TARGET_AGE_MS) return;
    this.target = null;
    if (!pos || pos === 'unplaced') return;
    const vm = this.deps.canvasView.getViewportManager();
    const { height: viewHeight } = vm.getViewportSize();
    const scrollY = vm.getScrollY();
    if (pos.top < scrollY || pos.top + pos.height > scrollY + viewHeight) {
      vm.setScrollTop(Math.max(0, pos.top - viewHeight * 0.4));
    }
  }

  /** 편집 지점의 스크롤 좌표. 주소가 무효면 throw 한다. */
  private editPosition(
    r: DocRange,
    point: { paraIdx: number; charOffset: number },
  ): { top: number; height: number } | 'unplaced' {
    const cell = r.cell;
    const rect = cell?.path
      ? this.deps.wasm.getCursorRectByPath(
        r.sectionIdx, cell.paraIdx, cellPathAt(cell, point.paraIdx), point.charOffset,
      )
      : cell
      ? this.deps.wasm.getCursorRectInCell(
        r.sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, point.paraIdx, point.charOffset,
      )
      : this.deps.wasm.getCursorRect(r.sectionIdx, point.paraIdx, point.charOffset);
    const vs = this.deps.canvasView.getVirtualScroll();
    if (rect.pageIndex >= vs.pageCount) return 'unplaced';
    const zoom = this.deps.canvasView.getViewportManager().getZoom();
    return {
      top: vs.getPageOffset(rect.pageIndex) + rect.y * zoom,
      height: rect.height * zoom,
    };
  }
}
