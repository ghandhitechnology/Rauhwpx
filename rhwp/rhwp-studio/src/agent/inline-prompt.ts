/**
 * 인라인 프롬프트 — 문서에서 텍스트를 선택하면 선택 끝에 작은 칩이 뜨고,
 * 칩을 누르면 그 자리에서 에이전트에게 지시할 수 있는 입력 상자가 열린다.
 * 보낸 지시는 선택 범위 컨텍스트와 함께 에이전트 사이드바 채팅으로 들어간다.
 */
import './inline-prompt.css';
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { CursorRect, DocumentPosition } from '../core/types.ts';
import type { AgentBridge } from './bridge.ts';
import {
  buildInlineSelection,
  extractSelectionText,
  type InlinePromptSelection,
  type InlinePromptSendResult,
  type InlinePromptSubmission,
} from './inline-prompt-context.ts';

export interface InlinePromptDeps {
  wasm: WasmBridge;
  eventBus: EventBus;
  inputHandler: InputHandler;
  canvasView: CanvasView;
  bridge: AgentBridge;
  /** 사이드바로 전달 — 말풍선 기록과 실제 전송을 맡는다. */
  submit: (submission: InlinePromptSubmission) => InlinePromptSendResult;
}

/** 선택이 잠깐 흔들릴 때 칩이 따라다니지 않도록 잦아든 뒤에만 검사한다. */
const CHECK_DEBOUNCE_MS = 200;
const BOX_WIDTH_PX = 340;
const CHIP_WIDTH_ESTIMATE_PX = 96;
const EDGE_MARGIN_PX = 8;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 12 그리드, currentColor, 1.25 스트로크 — 프로젝트 아이콘 규약의 스파크. */
function createSparkGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M6 1.5 7.2 4.8 10.5 6 7.2 7.2 6 10.5 4.8 7.2 1.5 6 4.8 4.8Z');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

interface ProjectedAnchor {
  left: number;
  top: number;
  height: number;
  contentWidth: number;
}

class InlinePromptController {
  private readonly deps: InlinePromptDeps;
  private readonly layer: HTMLDivElement;
  private readonly chip: HTMLButtonElement;
  private readonly box: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly permissionBtn: HTMLButtonElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly errorLabel: HTMLSpanElement;
  private readonly unsubs: Array<() => void> = [];

  private state: 'hidden' | 'chip' | 'open' = 'hidden';
  private checkTimer: number | null = null;
  private pointerActive = false;
  /** 화면 배치 기준 앵커 (선택 끝 캐럿, 문서 단위). */
  private anchor: CursorRect | null = null;
  /** 상자를 연 시점에 굳힌 선택 컨텍스트. */
  private captured: InlinePromptSelection | null = null;

  constructor(deps: InlinePromptDeps) {
    this.deps = deps;

    this.layer = document.createElement('div');
    this.layer.className = 'ag-inline-layer';

    this.chip = document.createElement('button');
    this.chip.type = 'button';
    this.chip.className = 'ag-inline-chip';
    this.chip.setAttribute('aria-label', '선택 영역을 에이전트에게 지시');
    this.chip.append(createSparkGlyph(), Object.assign(document.createElement('span'), { textContent: '에이전트' }));
    this.chip.hidden = true;

    this.box = document.createElement('div');
    this.box.className = 'ag-inline-box';
    this.box.setAttribute('role', 'dialog');
    this.box.setAttribute('aria-label', '선택 영역 인라인 지시');
    this.box.hidden = true;

    this.input = document.createElement('textarea');
    this.input.className = 'ag-inline-input';
    this.input.rows = 1;
    this.input.placeholder = '선택한 부분에 대해 지시하거나 질문하세요';

    const actions = document.createElement('div');
    actions.className = 'ag-inline-actions';
    this.permissionBtn = document.createElement('button');
    this.permissionBtn.type = 'button';
    this.permissionBtn.className = 'ag-inline-permission';
    this.errorLabel = document.createElement('span');
    this.errorLabel.className = 'ag-inline-error';
    this.sendBtn = document.createElement('button');
    this.sendBtn.type = 'button';
    this.sendBtn.className = 'ag-inline-send';
    this.sendBtn.textContent = '보내기';
    actions.append(this.permissionBtn, this.errorLabel, this.sendBtn);
    this.box.append(this.input, actions);
    this.layer.append(this.chip, this.box);

    this.bindUiEvents();
    this.bindDocumentEvents();
    this.refreshControls();
  }

  private bindUiEvents(): void {
    // 다운 계열/클릭 이벤트가 엔진의 캔버스 핸들러로 새어 들어가 커서가
    // 움직이지 않도록 막는다. up 계열은 드래그 종료 감지가 있어 막지 않는다.
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu'] as const) {
      this.layer.addEventListener(type, (e) => e.stopPropagation());
    }
    // 칩은 포커스를 뺏지 않아야 문서 선택이 살아 있는 채로 열린다.
    this.chip.addEventListener('pointerdown', (e) => e.preventDefault());
    this.chip.addEventListener('mousedown', (e) => e.preventDefault());
    this.chip.addEventListener('click', () => this.openBox());

    this.box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideAll();
        this.deps.inputHandler.focus(); // 편집으로 바로 이어가도록 포커스 반환
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(this.input.scrollHeight, 96)}px`;
      this.setError('');
    });
    this.sendBtn.addEventListener('click', () => this.send());
    this.permissionBtn.addEventListener('click', () => this.togglePermission());
  }

  private bindDocumentEvents(): void {
    const { eventBus, bridge } = this.deps;
    for (const name of ['cursor-format-changed', 'cursor-rect-updated']) {
      this.unsubs.push(eventBus.on(name, () => this.scheduleCheck()));
    }
    // 문서 내용이 바뀌면 칩의 좌표 근거가 사라진다. 열린 상자는 컨텍스트를
    // 이미 굳혔으므로 그대로 둔다.
    for (const name of ['document-changed', 'document-page-invalidated']) {
      this.unsubs.push(eventBus.on(name, () => {
        if (this.state === 'chip') this.hideAll();
      }));
    }
    this.unsubs.push(eventBus.on('document-view-changed', () => this.hideAll()));
    for (const name of ['zoom-changed', 'viewport-resize', 'viewport-inset-changed', 'page-layout-changed']) {
      this.unsubs.push(eventBus.on(name, () => this.reposition()));
    }
    this.unsubs.push(bridge.onEvent((e) => {
      if (e.type === 'connection' || e.type === 'permission-changed') this.refreshControls();
    }));

    document.addEventListener('pointerdown', this.onGlobalPointerDown, true);
    document.addEventListener('pointerup', this.onGlobalPointerUp, true);
    this.unsubs.push(() => {
      document.removeEventListener('pointerdown', this.onGlobalPointerDown, true);
      document.removeEventListener('pointerup', this.onGlobalPointerUp, true);
    });
  }

  private readonly onGlobalPointerDown = (e: PointerEvent): void => {
    if (this.layer.contains(e.target as Node)) return;
    this.pointerActive = true;
    this.hideAll();
  };

  private readonly onGlobalPointerUp = (): void => {
    this.pointerActive = false;
    this.scheduleCheck();
  };

  private scheduleCheck(): void {
    if (this.checkTimer !== null) window.clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => {
      this.checkTimer = null;
      this.check();
    }, CHECK_DEBOUNCE_MS);
  }

  /** 현재 선택을 보고 칩을 보이거나 감춘다. 열린 상자는 건드리지 않는다. */
  private check(): void {
    if (this.state === 'open' || this.pointerActive) return;
    const sel = this.currentBodySelection();
    if (!sel) {
      if (this.state === 'chip') this.hideAll();
      return;
    }
    const anchor = this.probeAnchor(sel.end);
    if (!anchor) {
      if (this.state === 'chip') this.hideAll();
      return;
    }
    this.anchor = anchor;
    this.state = 'chip';
    this.chip.hidden = false;
    this.box.hidden = true;
    this.reposition();
  }

  /** 본문 텍스트 선택만 지원한다 — 표 셀/각주 내부 선택은 칩을 띄우지 않는다. */
  private currentBodySelection(): { start: DocumentPosition; end: DocumentPosition } | null {
    let sel: { start: DocumentPosition; end: DocumentPosition } | null;
    try {
      sel = this.deps.inputHandler.getSelection();
    } catch {
      return null;
    }
    if (!sel) return null;
    if (sel.start.parentParaIndex !== undefined || sel.end.parentParaIndex !== undefined) return null;
    const zeroWidth = sel.start.sectionIndex === sel.end.sectionIndex
      && sel.start.paragraphIndex === sel.end.paragraphIndex
      && sel.start.charOffset === sel.end.charOffset;
    return zeroWidth ? null : sel;
  }

  private probeAnchor(end: DocumentPosition): CursorRect | null {
    try {
      const rect = this.deps.wasm.getCursorRect(end.sectionIndex, end.paragraphIndex, end.charOffset);
      return rect && rect.pageIndex !== undefined ? rect : null;
    } catch {
      return null;
    }
  }

  private project(anchor: CursorRect): ProjectedAnchor | null {
    const scrollContent = document.getElementById('scroll-content');
    if (!scrollContent) return null;
    const vs = this.deps.canvasView.getVirtualScroll();
    if (anchor.pageIndex >= vs.pageCount) return null;
    const zoom = this.deps.canvasView.getViewportManager().getZoom();
    const contentWidth = scrollContent.clientWidth;
    const pl = vs.getPageLeft(anchor.pageIndex);
    const pageLeft = pl >= 0 ? pl : (contentWidth - vs.getPageWidth(anchor.pageIndex)) / 2;
    return {
      left: pageLeft + anchor.x * zoom,
      top: vs.getPageOffset(anchor.pageIndex) + anchor.y * zoom,
      height: anchor.height * zoom,
      contentWidth,
    };
  }

  /** 확대·리사이즈 등 화면 사영만 바뀌었을 때 저장된 앵커로 다시 배치한다. */
  private reposition(): void {
    if (this.state === 'hidden' || !this.anchor) return;
    const scrollContent = document.getElementById('scroll-content');
    if (!scrollContent) return;
    if (this.layer.parentElement !== scrollContent) scrollContent.appendChild(this.layer);
    const pos = this.project(this.anchor);
    if (!pos) {
      this.hideAll();
      return;
    }
    const below = pos.top + pos.height + 6;
    if (this.state === 'chip') {
      const left = Math.min(Math.max(pos.left + 6, EDGE_MARGIN_PX), pos.contentWidth - CHIP_WIDTH_ESTIMATE_PX - EDGE_MARGIN_PX);
      this.chip.style.left = `${left.toFixed(2)}px`;
      this.chip.style.top = `${below.toFixed(2)}px`;
    } else {
      const left = Math.min(Math.max(pos.left, EDGE_MARGIN_PX), pos.contentWidth - BOX_WIDTH_PX - EDGE_MARGIN_PX);
      this.box.style.left = `${left.toFixed(2)}px`;
      this.box.style.top = `${(below + 2).toFixed(2)}px`;
    }
  }

  private openBox(): void {
    if (this.state !== 'chip') return;
    const sel = this.currentBodySelection();
    if (!sel) {
      this.hideAll();
      return;
    }
    const captured = this.captureSelection(sel);
    if (!captured) {
      this.hideAll();
      return;
    }
    this.captured = captured;
    this.state = 'open';
    this.chip.hidden = true;
    this.box.hidden = false;
    this.setError('');
    this.refreshControls();
    this.reposition();
    this.input.focus();
  }

  private captureSelection(
    sel: { start: DocumentPosition; end: DocumentPosition },
  ): InlinePromptSelection | null {
    const { wasm } = this.deps;
    try {
      const extracted = extractSelectionText(sel.start, sel.end, {
        paragraphCount: (sec) => wasm.getParagraphCount(sec),
        paragraphLength: (sec, para) => wasm.getParagraphLength(sec, para),
        text: (sec, para, from, count) => wasm.getTextRange(sec, para, from, count),
        toTextOffset: (sec, para, logical) => {
          try {
            return wasm.logicalToTextOffset(sec, para, logical);
          } catch {
            return logical; // 구버전 wasm 호환 — 변환 실패 시 원값 유지
          }
        },
      });
      return buildInlineSelection(extracted);
    } catch {
      return null;
    }
  }

  private send(): void {
    if (this.state !== 'open' || !this.captured) return;
    const prompt = this.input.value.trim();
    if (!prompt) return;
    const result = this.deps.submit({ prompt, selection: this.captured });
    if (!result.ok) {
      this.setError(result.reason);
      return;
    }
    this.input.value = '';
    this.input.style.height = 'auto';
    this.hideAll();
  }

  private togglePermission(): void {
    const { bridge } = this.deps;
    if (bridge.getPermissionProfile() === 'safe') {
      const confirmed = window.confirm('전체 접근을 켜면 에이전트가 승인 없이 문서를 편집하고, 명령과 파일 도구가 노트북 전체에 접근할 수 있습니다. 이 채팅에서 계속 허용할까요?');
      if (!confirmed) return;
      bridge.setPermissionProfile('unrestricted');
    } else {
      bridge.setPermissionProfile('safe');
    }
  }

  private refreshControls(): void {
    const { bridge } = this.deps;
    const unrestricted = bridge.getPermissionProfile() === 'unrestricted';
    this.permissionBtn.textContent = unrestricted ? '전체' : '안전';
    this.permissionBtn.classList.toggle('ag-inline-unrestricted', unrestricted);
    this.permissionBtn.title = unrestricted
      ? '에이전트 권한: 전체 접근. 클릭하여 안전 모드로 전환'
      : '에이전트 권한: 안전. 문서 편집은 턴이 끝나면 검토 후 반영됩니다';
    const connected = bridge.getConnectionState() === 'connected';
    this.sendBtn.disabled = !connected;
    this.sendBtn.title = connected ? '' : '에이전트 허브에 연결되어 있지 않습니다';
  }

  private setError(text: string): void {
    this.errorLabel.textContent = text;
  }

  private hideAll(): void {
    this.state = 'hidden';
    this.anchor = null;
    this.captured = null;
    this.chip.hidden = true;
    this.box.hidden = true;
    this.setError('');
  }

  dispose(): void {
    if (this.checkTimer !== null) window.clearTimeout(this.checkTimer);
    for (const un of this.unsubs) un();
    this.unsubs.length = 0;
    this.layer.remove();
  }
}

export function initInlinePrompt(deps: InlinePromptDeps): { dispose(): void } {
  const controller = new InlinePromptController(deps);
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__inlinePrompt = controller;
  }
  return { dispose: () => controller.dispose() };
}
