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
import type { CellPathLike, ControlLayoutItem, CursorRect, DocumentPosition } from '../core/types.ts';
import type { AgentBridge } from './bridge.ts';
import { selectedTablesInRange } from '../engine/selected-tables.ts';
import { cellChain } from '../engine/table-selection-rects.ts';
import {
  buildInlineElementSelection,
  buildInlineSelection,
  bindInlineSelectionIdentity,
  extractCellSelectionText,
  extractSelectionText,
  type InlinePromptItem,
  type InlinePromptSelection,
  type InlinePromptSendResponse,
  type InlinePromptSubmission,
} from './inline-prompt-context.ts';

export interface InlinePromptDeps {
  wasm: WasmBridge;
  eventBus: EventBus;
  inputHandler: InputHandler;
  canvasView: CanvasView;
  bridge: AgentBridge;
  /** 사이드바로 전달 — 말풍선 기록과 실제 전송을 맡는다. */
  submit: (submission: InlinePromptSubmission) => InlinePromptSendResponse;
}

/** 선택이 잠깐 흔들릴 때 칩이 따라다니지 않도록 잦아든 뒤에만 검사한다. */
const CHECK_DEBOUNCE_MS = 200;
const BOX_WIDTH_PX = 340;
const CHIP_WIDTH_ESTIMATE_PX = 96;
const EDGE_MARGIN_PX = 8;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 사이드바가 완전히 숨겨진 동안은 선택→에이전트 칩을 띄우지 않는다. */
export function isAgentSidebarVisible(
  body: { classList: { contains(name: string): boolean } } = document.body,
): boolean {
  return body.classList.contains('ag-sidebar-open');
}

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

interface ObjectSelectionRef {
  sec: number;
  ppi: number;
  ci: number;
  type: string;
  cellIdx?: number;
  cellParaIdx?: number;
  innerControlIdx?: number;
  logicalOffset?: number;
  outerTableControlIdx?: number;
  cellPath?: CellPathLike;
  noteRef?: unknown;
  memoRef?: unknown;
  headerFooter?: { kind: 'header' | 'footer'; outerParaIdx: number; outerControlIdx: number };
}

type SelectionSource =
  | { kind: 'text'; start: DocumentPosition; end: DocumentPosition }
  | { kind: 'cell-text'; start: DocumentPosition; end: DocumentPosition }
  | { kind: 'objects'; refs: ObjectSelectionRef[] }
  | {
      kind: 'table';
      ref: { sec: number; ppi: number; ci: number; cellPath?: CellPathLike };
      range?: { startRow: number; startCol: number; endRow: number; endCol: number };
    };

class InlinePromptController {
  private readonly deps: InlinePromptDeps;
  private readonly layer: HTMLDivElement;
  private readonly chip: HTMLButtonElement;
  private readonly box: HTMLDivElement;
  private readonly selectionSummary: HTMLDivElement;
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
  private sending = false;
  private captureId = 0;
  private captureError = '';
  private sendAbort: AbortController | null = null;
  private previewUrls: string[] = [];

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

    this.selectionSummary = document.createElement('div');
    this.selectionSummary.className = 'ag-inline-selection-summary';
    this.selectionSummary.setAttribute('aria-label', '선택한 문서 요소');

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
    this.box.append(this.selectionSummary, this.input, actions);
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
    this.chip.addEventListener('click', () => { void this.openBox(); });

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
        void this.send();
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(this.input.scrollHeight, 96)}px`;
      this.setError('');
    });
    this.sendBtn.addEventListener('click', () => { void this.send(); });
    this.permissionBtn.addEventListener('click', () => this.togglePermission());
  }

  private bindDocumentEvents(): void {
    const { eventBus, bridge } = this.deps;
    for (const name of [
      'cursor-format-changed',
      'cursor-rect-updated',
      'picture-object-selection-changed',
      'table-object-selection-changed',
      // 셀 블록은 캐럿 없이 키보드(Shift+방향키·F5·모두 선택)로도 바뀐다.
      'cell-selection-changed',
    ]) {
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
    this.unsubs.push(eventBus.on('agent-sidebar-visibility-changed', () => {
      if (!isAgentSidebarVisible()) this.hideAll();
      else this.scheduleCheck();
    }));
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
    if (!isAgentSidebarVisible()) {
      if (this.state !== 'hidden') this.hideAll();
      return;
    }
    if (this.state === 'open' || this.pointerActive) return;
    const source = this.currentSelection();
    if (!source) {
      if (this.state === 'chip') this.hideAll();
      return;
    }
    const anchor = this.probeAnchor(source);
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

  /** 현재 편집기 선택을 주소가 유지되는 한 가지 표현으로 읽는다. */
  private currentSelection(): SelectionSource | null {
    const { inputHandler } = this.deps;
    if (inputHandler.isInPictureObjectSelection()) {
      const refs = inputHandler.getSelectedPictureRefs() as ObjectSelectionRef[];
      if (refs.length > 0) return { kind: 'objects', refs: refs.map((ref) => ({ ...ref })) };
    }
    if (inputHandler.isInTableObjectSelection()) {
      const ref = inputHandler.getSelectedTableRef();
      if (ref) return { kind: 'table', ref: { ...ref, cellPath: ref.cellPath ? [...ref.cellPath] : undefined } };
    }
    if (inputHandler.isInCellSelectionMode()) {
      const ref = inputHandler.getCellTableContext();
      const range = inputHandler.getSelectedCellRange();
      if (ref && range) {
        return {
          kind: 'table',
          ref: { ...ref, cellPath: ref.cellPath ? [...ref.cellPath] : undefined },
          range: { ...range },
        };
      }
    }
    let sel: { start: DocumentPosition; end: DocumentPosition } | null;
    try {
      sel = inputHandler.getSelection();
    } catch {
      return null;
    }
    if (!sel) return null;
    const inCell = sel.start.parentParaIndex !== undefined || sel.end.parentParaIndex !== undefined;
    if (inCell) {
      const sameContainer = sel.start.sectionIndex === sel.end.sectionIndex
        && sel.start.parentParaIndex === sel.end.parentParaIndex
        && sel.start.controlIndex === sel.end.controlIndex
        && sel.start.cellIndex === sel.end.cellIndex
        && ((!sel.start.cellPath?.length && !sel.end.cellPath?.length)
          || this.sameCellPath(sel.start.cellPath, sel.end.cellPath, { ignoreLastParagraph: true }));
      if (!sameContainer) return null;
      const zeroWidth = (sel.start.cellParaIndex ?? sel.start.paragraphIndex) === (sel.end.cellParaIndex ?? sel.end.paragraphIndex)
        && sel.start.charOffset === sel.end.charOffset;
      return zeroWidth ? null : { kind: 'cell-text', ...sel };
    }
    const zeroWidth = sel.start.sectionIndex === sel.end.sectionIndex
      && sel.start.paragraphIndex === sel.end.paragraphIndex
      && sel.start.charOffset === sel.end.charOffset;
    return zeroWidth ? null : { kind: 'text', ...sel };
  }

  private probeAnchor(source: SelectionSource): CursorRect | null {
    try {
      if (source.kind === 'text') {
        const end = source.end;
        // 문단 끝의 블록 표는 논리 길이 다음 칸이 선택 끝이다. 캐럿 사각형은
        // 표의 첫 쪽에 있으므로 칩은 마지막 쪽 표 선택 영역에 맞춘다.
        if (end.charOffset > this.deps.wasm.getParagraphLength(end.sectionIndex, end.paragraphIndex)) {
          const lastTable = selectedTablesInRange(this.deps.wasm, source.start, end).at(-1);
          if (lastTable && lastTable.sec === end.sectionIndex && lastTable.ppi === end.paragraphIndex) {
            const tableAnchor = this.tableAnchor(lastTable);
            if (tableAnchor) return tableAnchor;
          }
        }
        const rect = this.deps.wasm.getCursorRect(end.sectionIndex, end.paragraphIndex, end.charOffset);
        return rect && rect.pageIndex !== undefined ? rect : null;
      }
      if (source.kind === 'cell-text') {
        const end = source.end;
        const path = end.cellPath;
        const endChain = cellChain(end);
        const endPara = end.cellParaIndex ?? end.paragraphIndex;
        const logicalLength = path?.length
          ? this.deps.wasm.getCellParagraphLengthByPath(
              end.sectionIndex, end.parentParaIndex!, JSON.stringify(path),
            )
          : this.deps.wasm.getCellParagraphLength(
              end.sectionIndex, end.parentParaIndex!, end.controlIndex!, end.cellIndex!, endPara,
            );
        if (end.charOffset > logicalLength) {
          const lastTable = selectedTablesInRange(this.deps.wasm, source.start, end).at(-1);
          const hostPath = lastTable?.cellPath?.slice(0, -1);
          if (lastTable && hostPath?.length === endChain.length
            && hostPath.every((entry, index) => entry.controlIndex === endChain[index].controlIndex
              && entry.cellIndex === endChain[index].cellIndex
              && entry.cellParaIndex === endChain[index].cellParaIndex)) {
            const tableAnchor = this.tableAnchor(lastTable);
            if (tableAnchor) return tableAnchor;
          }
        }
        const rect = path?.length
          ? this.deps.wasm.getCursorRectByPath(
              end.sectionIndex,
              end.parentParaIndex!,
              JSON.stringify(path),
              end.charOffset,
            )
          : this.deps.wasm.getCursorRectInCell(
              end.sectionIndex,
              end.parentParaIndex!,
              end.controlIndex!,
              end.cellIndex!,
              end.cellParaIndex ?? end.paragraphIndex,
              end.charOffset,
            );
        return rect && rect.pageIndex !== undefined ? rect : null;
      }
      if (source.kind === 'objects') {
        const found = source.refs.map((ref) => this.findObjectLayout(ref)).filter((entry) => entry !== null);
        if (found.length === 0) return null;
        const last = found[found.length - 1]!;
        return { pageIndex: last.pageIndex, x: last.item.x + last.item.w, y: last.item.y, height: last.item.h };
      }
      return this.tableAnchor(source.ref, source.range);
    } catch {
      return null;
    }
  }

  private tableAnchor(
    ref: { sec: number; ppi: number; ci: number; cellPath?: CellPathLike },
    range?: { startRow: number; startCol: number; endRow: number; endCol: number },
  ): CursorRect | null {
    try {
      const boxes = this.tableBoxes(ref, range);
      if (boxes.length === 0) return null;
      // 표 선택의 끝은 마지막 쪽 선택 영역의 오른쪽 아래다. 칩을 그 오른쪽 끝에 맞춰
      // 선택 바로 아래에 둔다 — 셀 오른쪽 바깥에 붙이면 넓은 표에서 쪽 밖으로 나간다.
      const lastPage = boxes[boxes.length - 1]!.pageIndex;
      const onLastPage = boxes.filter((box) => box.pageIndex === lastPage);
      const left = Math.min(...onLastPage.map((box) => box.x));
      const right = Math.max(...onLastPage.map((box) => box.x + box.w));
      const bottom = Math.max(...onLastPage.map((box) => box.y + box.h));
      const zoom = this.deps.canvasView.getViewportManager().getZoom();
      const chipWidth = (CHIP_WIDTH_ESTIMATE_PX + 6) / zoom;
      return { pageIndex: lastPage, x: Math.max(left, right - chipWidth), y: bottom, height: 0 };
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

  private async openBox(): Promise<void> {
    if (!isAgentSidebarVisible()) {
      this.hideAll();
      return;
    }
    if (this.state !== 'chip') return;
    const captureId = ++this.captureId;
    const source = this.currentSelection();
    if (!source) {
      this.hideAll();
      return;
    }
    this.state = 'open';
    this.captureError = '';
    this.chip.disabled = true;
    this.chip.setAttribute('aria-busy', 'true');
    const identity = this.deps.bridge.getDocumentSelectionIdentity();
    const captured = await this.captureSelection(source);
    if (captureId !== this.captureId) return;
    const currentIdentity = this.deps.bridge.getDocumentSelectionIdentity();
    if (identity.documentId !== currentIdentity.documentId || identity.revision !== currentIdentity.revision) {
      this.hideAll();
      return;
    }
    if (!captured) {
      this.captured = null;
      this.selectionSummary.replaceChildren();
      this.chip.hidden = true;
      this.chip.disabled = false;
      this.chip.removeAttribute('aria-busy');
      this.box.hidden = false;
      this.setError(this.captureError || '선택한 내용을 캡처하지 못했습니다. 다시 시도해 주세요.');
      this.refreshControls();
      this.reposition();
      return;
    }
    this.captured = bindInlineSelectionIdentity(captured, identity);
    this.renderSelectionSummary();
    this.chip.disabled = false;
    this.chip.removeAttribute('aria-busy');
    this.chip.hidden = true;
    this.chip.disabled = false;
    this.chip.removeAttribute('aria-busy');
    this.box.hidden = false;
    this.setError('');
    this.refreshControls();
    this.reposition();
    this.input.focus();
  }

  private async captureSelection(source: SelectionSource): Promise<InlinePromptSelection | null> {
    const { wasm } = this.deps;
    try {
      if (source.kind === 'objects') return await this.captureObjects(source.refs);
      if (source.kind === 'table') {
        const item = this.captureTable(source.ref, source.range);
        return item ? buildInlineElementSelection([item]) : null;
      }
      const tables = selectedTablesInRange(wasm, source.start, source.end)
        .map(ref => this.captureTable(ref))
        .filter((item): item is Extract<InlinePromptItem, { kind: 'table' }> => item !== null);
      if (source.kind === 'cell-text') {
        const text = this.captureCellText(source.start, source.end);
        return text && tables.length ? buildInlineElementSelection([...text.items, ...tables]) : text;
      }
      const extracted = extractSelectionText(source.start, source.end, {
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
      const textSelection = buildInlineSelection(extracted);
      const embedded = this.findEmbeddedBodyObjects(source.start, source.end).filter(ref => ref.type !== 'table');
      if (embedded.length === 0 && tables.length === 0) return textSelection;
      const items: InlinePromptItem[] = [...textSelection.items, ...tables];
      const attachments: File[] = [];
      for (const ref of embedded) {
        const captured = await this.captureObjects([ref]);
        if (!captured) return null;
        items.push(...captured.items);
        attachments.push(...(captured.attachments ?? []));
      }
      return buildInlineElementSelection(items, attachments);
    } catch {
      return null;
    }
  }

  private findEmbeddedBodyObjects(start: DocumentPosition, end: DocumentPosition): ObjectSelectionRef[] {
    const layouts = new Map<string, ControlLayoutItem>();
    for (let page = 0; page < this.deps.wasm.pageCount; page++) {
      let controls: ControlLayoutItem[];
      try { controls = this.deps.wasm.getPageControlLayout(page).controls; } catch { continue; }
      for (const item of controls) {
        if (item.secIdx === undefined || item.paraIdx === undefined || item.controlIdx === undefined) continue;
        if (item.cellPath?.length || item.noteRef || item.memoRef || item.headerFooter) continue;
        layouts.set(`${item.secIdx}:${item.paraIdx}:${item.controlIdx}`, item);
      }
    }
    const refs: ObjectSelectionRef[] = [];
    const seen = new Set<string>();
    for (let sec = start.sectionIndex; sec <= end.sectionIndex; sec++) {
      const firstPara = sec === start.sectionIndex ? start.paragraphIndex : 0;
      const lastPara = sec === end.sectionIndex ? end.paragraphIndex : this.deps.wasm.getParagraphCount(sec) - 1;
      for (let para = firstPara; para <= lastPara; para++) {
        let positions: number[];
        try { positions = this.deps.wasm.getControlTextPositions(sec, para); } catch { continue; }
        const from = sec === start.sectionIndex && para === start.paragraphIndex ? start.charOffset : 0;
        const to = sec === end.sectionIndex && para === end.paragraphIndex ? end.charOffset : Number.POSITIVE_INFINITY;
        positions.forEach((logicalOffset, ci) => {
          if (logicalOffset < from || logicalOffset >= to) return;
          const key = `${sec}:${para}:${ci}`;
          if (seen.has(key)) return;
          const item = layouts.get(key);
          if (!item || !['image', 'shape', 'equation', 'group', 'line', 'ole', 'table'].includes(item.type)) return;
          seen.add(key);
          refs.push({ sec, ppi: para, ci, type: item.type, logicalOffset });
        });
      }
    }
    return refs.sort((a, b) => a.sec - b.sec || a.ppi - b.ppi || (a.logicalOffset ?? 0) - (b.logicalOffset ?? 0));
  }

  private captureCellText(start: DocumentPosition, end: DocumentPosition): InlinePromptSelection | null {
    const { wasm } = this.deps;
    const parentPara = start.parentParaIndex;
    const controlIdx = start.controlIndex;
    const cellIdx = start.cellIndex;
    if (parentPara === undefined || controlIdx === undefined || cellIdx === undefined) return null;
    const firstPara = start.cellParaIndex ?? start.paragraphIndex;
    const lastPara = end.cellParaIndex ?? end.paragraphIndex;
    const path = start.cellPath?.length ? start.cellPath : undefined;
    const paraPath = (para: number) => path?.map((entry, index) => index === path.length - 1
      ? { ...entry, cellParaIndex: para }
      : entry);
    // 에이전트 도구는 텍스트 오프셋을 받는다. 캐럿 좌표(인라인 개체 = 1칸)를 그대로 넘기면
    // 수식이 있는 셀 문단에서 편집 범위가 개체 수만큼 밀린다.
    const toTextOffset = (para: number, logical: number): number => {
      const currentPath = paraPath(para);
      try {
        return currentPath
          ? wasm.logicalToTextOffsetInCellByPath(
              start.sectionIndex, parentPara, JSON.stringify(currentPath), logical,
            )
          : wasm.logicalToTextOffsetInCell(
              start.sectionIndex, parentPara, controlIdx, cellIdx, para, logical,
            );
      } catch {
        return logical; // 구버전 wasm 호환 — 변환 실패 시 원값 유지
      }
    };
    const extractedText = extractCellSelectionText(
      firstPara,
      lastPara,
      start.charOffset,
      end.charOffset,
      {
        paragraphLength: (para) => {
          const currentPath = paraPath(para);
          return currentPath
            ? wasm.getCellParagraphLengthByPath(start.sectionIndex, parentPara, JSON.stringify(currentPath))
            : wasm.getCellParagraphLength(start.sectionIndex, parentPara, controlIdx, cellIdx, para);
        },
        text: (para, from, count) => {
          const currentPath = paraPath(para);
          return currentPath
            ? wasm.getTextInCellByPath(start.sectionIndex, parentPara, JSON.stringify(currentPath), from, count)
            : wasm.getTextInCell(start.sectionIndex, parentPara, controlIdx, cellIdx, para, from, count);
        },
        toTextOffset,
      },
    );
    const extracted = {
      start: {
        sectionIdx: start.sectionIndex,
        paraIdx: firstPara,
        charOffset: toTextOffset(firstPara, start.charOffset),
      },
      end: {
        sectionIdx: end.sectionIndex,
        paraIdx: lastPara,
        charOffset: toTextOffset(lastPara, end.charOffset),
      },
      text: extractedText.text,
      truncated: extractedText.truncated,
    };
    return buildInlineElementSelection([{
      kind: 'text',
      selection: extracted,
      address: {
        sectionIdx: start.sectionIndex,
        paraIdx: parentPara,
        controlIdx,
        cellPath: path ? [...path] : undefined,
        cellIdx,
        cellParaIdx: firstPara,
        endCellParaIdx: lastPara,
      },
      offsetConvention: 'text',
    }]);
  }

  /**
   * 두 셀 경로가 같은 셀을 가리키는지 본다. 선택 양 끝처럼 같은 셀 안의 다른 문단을
   * 가리키는 경로는 마지막 entry 의 cellParaIndex 만 다르므로 ignoreLastParagraph 로 비교한다.
   */
  private sameCellPath(a: unknown, b: unknown, options: { ignoreLastParagraph?: boolean } = {}): boolean {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => {
      const other = b[index] as Record<string, unknown> | undefined;
      const current = entry as Record<string, unknown>;
      const skipParagraph = options.ignoreLastParagraph && index === a.length - 1;
      return (current['controlIndex'] ?? current['controlIdx']) === (other?.['controlIndex'] ?? other?.['controlIdx'])
        && (current['cellIndex'] ?? current['cellIdx']) === (other?.['cellIndex'] ?? other?.['cellIdx'])
        && (skipParagraph
          || (current['cellParaIndex'] ?? current['cellParaIdx']) === (other?.['cellParaIndex'] ?? other?.['cellParaIdx']));
    });
  }

  private findObjectLayout(ref: ObjectSelectionRef): { pageIndex: number; item: ControlLayoutItem } | null {
    for (let pageIndex = 0; pageIndex < this.deps.wasm.pageCount; pageIndex++) {
      let controls: ControlLayoutItem[];
      try { controls = this.deps.wasm.getPageControlLayout(pageIndex).controls; } catch { continue; }
      for (const item of controls) {
        if (item.type !== ref.type || item.secIdx !== ref.sec || item.paraIdx !== ref.ppi || item.controlIdx !== ref.ci) continue;
        const layout = item as ControlLayoutItem & { innerControlIdx?: number };
        if (ref.cellPath?.length && !this.sameCellPath(item.cellPath, ref.cellPath)) continue;
        if (!ref.cellPath?.length && item.cellPath?.length) continue;
        if (ref.cellIdx !== undefined && item.cellIdx !== ref.cellIdx) continue;
        if (ref.cellParaIdx !== undefined && item.cellParaIdx !== ref.cellParaIdx) continue;
        if (ref.innerControlIdx !== undefined && layout.innerControlIdx !== ref.innerControlIdx) continue;
        return { pageIndex, item };
      }
    }
    return null;
  }

  private tableBoxes(
    ref: { sec: number; ppi: number; ci: number; cellPath?: CellPathLike },
    range?: { startRow: number; startCol: number; endRow: number; endCol: number },
  ): Array<{
    pageIndex: number; x: number; y: number; w: number; h: number;
  }> {
    const { wasm } = this.deps;
    if (ref.cellPath?.length || range) {
      const cellBoxes = ref.cellPath?.length
        ? wasm.getTableCellBboxesByPath(ref.sec, ref.ppi, JSON.stringify(ref.cellPath))
        : wasm.getTableCellBboxes(ref.sec, ref.ppi, ref.ci);
      return cellBoxes.filter((box) => !range || !(
        box.row + box.rowSpan - 1 < range.startRow
        || box.row > range.endRow
        || box.col + box.colSpan - 1 < range.startCol
        || box.col > range.endCol
      )).map((box) => ({
        pageIndex: box.pageIndex, x: box.x, y: box.y, w: box.w, h: box.h,
      })).sort((a, b) => a.pageIndex - b.pageIndex || a.y - b.y || a.x - b.x);
    }
    const first = wasm.getTableBBox(ref.sec, ref.ppi, ref.ci);
    const boxes = [{ pageIndex: first.pageIndex, x: first.x, y: first.y, w: first.width, h: first.height }];
    for (let page = first.pageIndex + 1; page < wasm.pageCount; page++) {
      try {
        const box = wasm.getTableBBoxAtPage(ref.sec, ref.ppi, ref.ci, page);
        boxes.push({ pageIndex: box.pageIndex, x: box.x, y: box.y, w: box.width, h: box.height });
      } catch { break; }
    }
    return boxes;
  }

  private captureTable(
    ref: { sec: number; ppi: number; ci: number; cellPath?: CellPathLike },
    selectedRange?: { startRow: number; startCol: number; endRow: number; endCol: number },
  ): Extract<InlinePromptItem, { kind: 'table' }> | null {
    const { wasm } = this.deps;
    const path = ref.cellPath?.length ? ref.cellPath : undefined;
    const dims = path
      ? wasm.getTableDimensionsByPath(ref.sec, ref.ppi, JSON.stringify(path))
      : wasm.getTableDimensions(ref.sec, ref.ppi, ref.ci);
    const bboxes = path
      ? wasm.getTableCellBboxesByPath(ref.sec, ref.ppi, JSON.stringify(path))
      : wasm.getTableCellBboxes(ref.sec, ref.ppi, ref.ci);
    const cells: Extract<InlinePromptItem, { kind: 'table' }>['cells'] = [];
    const seenCells = new Set<number>();
    let remaining = 4000;
    let truncated = false;
    for (const box of bboxes) {
      const inside = !selectedRange || !(
        box.row + box.rowSpan - 1 < selectedRange.startRow
        || box.row > selectedRange.endRow
        || box.col + box.colSpan - 1 < selectedRange.startCol
        || box.col > selectedRange.endCol
      );
      if (!inside || seenCells.has(box.cellIdx)) continue;
      seenCells.add(box.cellIdx);
      let text = '';
      if (remaining > 0) {
        const paragraphs: string[] = [];
        if (path) {
          const cellPath = path.map((entry, index) => index === path.length - 1
            ? { ...entry, cellIndex: box.cellIdx, cellParaIndex: 0 }
            : { ...entry });
          const paraCount = wasm.getCellParagraphCountByPath(ref.sec, ref.ppi, JSON.stringify(cellPath));
          for (let para = 0; para < paraCount && remaining > 0; para++) {
            const paraPath = cellPath.map((entry, index) => index === cellPath.length - 1
              ? { ...entry, cellParaIndex: para }
              : entry);
            const json = JSON.stringify(paraPath);
            const length = wasm.getCellParagraphLengthByPath(ref.sec, ref.ppi, json);
            const count = Math.min(length, remaining);
            paragraphs.push(count > 0 ? wasm.getTextInCellByPath(ref.sec, ref.ppi, json, 0, count) : '');
            remaining -= count;
            if (count < length) truncated = true;
          }
        } else {
          const paraCount = wasm.getCellParagraphCount(ref.sec, ref.ppi, ref.ci, box.cellIdx);
          for (let para = 0; para < paraCount && remaining > 0; para++) {
            const length = wasm.getCellParagraphLength(ref.sec, ref.ppi, ref.ci, box.cellIdx, para);
            const count = Math.min(length, remaining);
            paragraphs.push(count > 0 ? wasm.getTextInCell(ref.sec, ref.ppi, ref.ci, box.cellIdx, para, 0, count) : '');
            remaining -= count;
            if (count < length) truncated = true;
          }
        }
        text = paragraphs.join('\n');
      } else {
        truncated = true;
      }
      cells.push({ row: box.row, col: box.col, rowSpan: box.rowSpan, colSpan: box.colSpan, text });
    }
    return {
      kind: 'table',
      address: { sectionIdx: ref.sec, paraIdx: ref.ppi, controlIdx: ref.ci, cellPath: path ? [...path] : undefined },
      rowCount: dims.rowCount,
      colCount: dims.colCount,
      cells,
      selectedRange,
      formatting: (() => {
        if (path) return undefined;
        try {
          const props = wasm.getTableProperties(ref.sec, ref.ppi, ref.ci);
          return {
            tableWidth: props.tableWidth,
            tableHeight: props.tableHeight,
            cellSpacing: props.cellSpacing,
            borderFillId: props.borderFillId,
            fillType: props.fillType,
            fillColor: props.fillColor,
            textWrap: props.textWrap,
          };
        } catch { return undefined; }
      })(),
      truncated,
    };
  }

  private async captureObjects(refs: ObjectSelectionRef[]): Promise<InlinePromptSelection | null> {
    const items: InlinePromptItem[] = [];
    const attachments: File[] = [];
    for (const [index, ref] of refs.slice(0, 10).entries()) {
      const address = {
        sectionIdx: ref.sec,
        paraIdx: ref.ppi,
        controlIdx: ref.ci,
        cellPath: ref.cellPath?.length ? [...ref.cellPath] : undefined,
        cellIdx: ref.cellIdx,
        cellParaIdx: ref.cellParaIdx,
        innerControlIdx: ref.innerControlIdx,
        logicalOffset: ref.logicalOffset,
      };
      if (ref.type === 'equation') {
        let props;
        try {
          props = ref.noteRef
            ? this.deps.wasm.getNoteEquationProperties(ref.noteRef as Parameters<WasmBridge['getNoteEquationProperties']>[0])
            : ref.cellPath?.length && ref.innerControlIdx !== undefined
              ? this.deps.wasm.getEquationPropertiesByPath(
                  ref.sec, ref.ppi, ref.cellPath, ref.innerControlIdx,
                )
              : this.deps.wasm.getEquationProperties(
                  ref.sec, ref.ppi, ref.ci, ref.cellIdx, ref.cellParaIdx, ref.innerControlIdx,
                );
        } catch { props = null; }
        let attachmentName: string | undefined;
        const found = this.findObjectLayout(ref);
        if (found) {
          const name = `selected-equation-${index + 1}.png`;
          const file = await this.renderObjectCrop(found.pageIndex, found.item, name);
          if (file) {
            attachmentName = name;
            attachments.push(file);
          }
        }
        items.push({
          kind: 'equation',
          address,
          script: props?.script ?? '',
          fontName: props?.fontName,
          fontSize: props?.fontSize,
          description: props?.description,
          attachmentName,
        });
        continue;
      }
      let description: string | undefined;
      let width: number | undefined;
      let height: number | undefined;
      let details: Record<string, unknown> | undefined;
      if (ref.type === 'image') {
        try {
          const props = ref.cellPath?.length
            ? this.deps.wasm.getCellPicturePropertiesByPath(ref.sec, ref.ppi, ref.cellPath, ref.innerControlIdx ?? ref.ci)
            : this.deps.wasm.getPictureProperties(ref.sec, ref.ppi, ref.ci);
          description = props.description || undefined;
          width = props.width;
          height = props.height;
          details = {
            originalWidth: props.originalWidth,
            originalHeight: props.originalHeight,
            cropLeft: props.cropLeft,
            cropTop: props.cropTop,
            cropRight: props.cropRight,
            cropBottom: props.cropBottom,
            rotationAngle: props.rotationAngle,
            horzFlip: props.horzFlip,
            vertFlip: props.vertFlip,
          };
        } catch { /* layout 크기로 보완한다 */ }
      }
      const found = this.findObjectLayout(ref);
      let attachmentName: string | undefined;
      if (!found) {
        this.captureError = '선택한 개체를 화면에서 찾지 못했습니다. 다시 선택해 주세요.';
        return null;
      }
      width ??= found.item.w;
      height ??= found.item.h;
      const name = `selected-${ref.type}-${index + 1}.png`;
      const file = await this.renderObjectCrop(found.pageIndex, found.item, name);
      if (!file) {
        this.captureError = '선택한 개체의 미리보기를 만들지 못했습니다. 다시 시도해 주세요.';
        return null;
      }
      attachmentName = name;
      attachments.push(file);
      items.push({
        kind: 'object', objectType: ref.type, address, description, width, height, details,
        attachmentName,
      });
    }
    return items.length > 0 ? buildInlineElementSelection(items, attachments) : null;
  }

  private async renderObjectCrop(
    pageIndex: number,
    item: Pick<ControlLayoutItem, 'x' | 'y' | 'w' | 'h'>,
    name: string,
  ): Promise<File | null> {
    try {
      const scale = 2;
      const source = document.createElement('canvas');
      this.deps.wasm.renderPageToCanvas(pageIndex, source, scale);
      const padding = 4 * scale;
      const sx = Math.max(0, Math.floor(item.x * scale - padding));
      const sy = Math.max(0, Math.floor(item.y * scale - padding));
      const sw = Math.max(1, Math.min(source.width - sx, Math.ceil(item.w * scale + padding * 2)));
      const sh = Math.max(1, Math.min(source.height - sy, Math.ceil(item.h * scale + padding * 2)));
      const crop = document.createElement('canvas');
      crop.width = sw;
      crop.height = sh;
      crop.getContext('2d')?.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await new Promise<Blob | null>((resolve) => crop.toBlob(resolve, 'image/png'));
      return blob ? new File([blob], name, { type: 'image/png' }) : null;
    } catch {
      return null;
    }
  }

  private async send(): Promise<void> {
    if (this.state !== 'open' || !this.captured || this.sending) return;
    const prompt = this.input.value.trim();
    if (!prompt) return;
    const identity = this.deps.bridge.getDocumentSelectionIdentity();
    if (identity.documentId !== this.captured.documentId || identity.revision !== this.captured.revision) {
      this.setError('문서가 바뀌었습니다. 대상을 다시 선택해 주세요.');
      return;
    }
    this.sending = true;
    const abort = new AbortController();
    this.sendAbort = abort;
    this.refreshControls();
    let result;
    try {
      result = await this.deps.submit({ prompt, selection: this.captured, signal: abort.signal });
    } catch (caught) {
      result = { ok: false as const, reason: caught instanceof Error ? caught.message : '선택 자료를 보내지 못했습니다' };
    }
    if (this.sendAbort !== abort) return;
    this.sendAbort = null;
    this.sending = false;
    this.refreshControls();
    if (!result.ok) {
      this.setError(result.reason);
      return;
    }
    this.input.value = '';
    this.input.style.height = 'auto';
    this.hideAll();
  }

  private renderSelectionSummary(): void {
    this.releasePreviewUrls();
    this.selectionSummary.replaceChildren();
    if (!this.captured) return;
    const label = (item: InlinePromptItem): string => {
      if (item.kind === 'text') return '텍스트';
      if (item.kind === 'table') {
        const scope = item.selectedRange
          ? `${item.selectedRange.startRow + 1}–${item.selectedRange.endRow + 1}행, ${item.selectedRange.startCol + 1}–${item.selectedRange.endCol + 1}열`
          : '전체';
        return `표 ${item.rowCount}×${item.colCount} · ${scope}`;
      }
      if (item.kind === 'equation') return item.script ? `수식 · ${item.script}` : '수식';
      return ({ image: '이미지', shape: '도형', line: '선', group: '묶음', ole: 'OLE' } as Record<string, string>)[item.objectType]
        ?? item.objectType;
    };
    this.captured.items.forEach((item, index) => {
      const chip = document.createElement('span');
      chip.className = 'ag-inline-selection-item';
      const attachmentName = item.kind === 'equation' || item.kind === 'object' ? item.attachmentName : undefined;
      const attachment = attachmentName
        ? this.captured?.attachments?.find((file) => file.name === attachmentName)
        : undefined;
      if (attachment?.type.startsWith('image/')) {
        const preview = document.createElement('img');
        const url = URL.createObjectURL(attachment);
        this.previewUrls.push(url);
        preview.src = url;
        preview.alt = '';
        chip.appendChild(preview);
      }
      const text = document.createElement('span');
      text.className = 'ag-inline-selection-item-label';
      text.textContent = label(item);
      text.title = text.textContent;
      chip.appendChild(text);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `${label(item)} 선택 제외`);
      remove.textContent = '×';
      remove.addEventListener('click', () => this.removeCapturedItem(index));
      chip.appendChild(remove);
      this.selectionSummary.appendChild(chip);
    });
  }

  private removeCapturedItem(index: number): void {
    if (!this.captured || this.sending) return;
    const items = this.captured.items.filter((_, itemIndex) => itemIndex !== index);
    if (items.length === 0) {
      this.hideAll();
      return;
    }
    const attachmentNames = new Set(items.flatMap((item) => {
      if (item.kind === 'equation' || item.kind === 'object') return item.attachmentName ? [item.attachmentName] : [];
      return [];
    }));
    const attachments = (this.captured.attachments ?? []).filter((file) => attachmentNames.has(file.name));
    const identity = {
      documentId: this.captured.documentId ?? null,
      revision: this.captured.revision ?? this.deps.bridge.getDocumentSelectionIdentity().revision,
    };
    this.captured = bindInlineSelectionIdentity(buildInlineElementSelection(items, attachments), identity);
    this.renderSelectionSummary();
  }

  private releasePreviewUrls(): void {
    for (const url of this.previewUrls.splice(0)) URL.revokeObjectURL(url);
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
    this.sendBtn.disabled = !connected || this.sending || !this.captured;
    this.sendBtn.title = connected ? (this.sending ? '선택 자료를 보내는 중입니다' : '') : '에이전트 허브에 연결되어 있지 않습니다';
  }

  private setError(text: string): void {
    this.errorLabel.textContent = text;
  }

  private hideAll(): void {
    this.captureId++;
    this.sendAbort?.abort();
    this.sendAbort = null;
    this.sending = false;
    this.state = 'hidden';
    this.anchor = null;
    this.captured = null;
    this.captureError = '';
    this.releasePreviewUrls();
    this.selectionSummary.replaceChildren();
    this.input.value = '';
    this.input.style.height = 'auto';
    this.chip.hidden = true;
    this.box.hidden = true;
    this.setError('');
  }

  dispose(): void {
    this.sendAbort?.abort();
    this.releasePreviewUrls();
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
