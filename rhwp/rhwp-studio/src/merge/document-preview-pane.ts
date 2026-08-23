import type { DiffAnchor } from '../compare/types.ts';
import { WasmBridge } from '../core/wasm-bridge.ts';
import type { MergeDocumentSource, MergePreviewRole } from './domain.ts';
import { mergeErrorMessage } from './merge-labels.ts';
import './document-preview-pane.css';

export interface DocumentPreviewPaneOptions {
  role: MergePreviewRole | 'comparison-left' | 'comparison-right';
  title: string;
  variant?: 'merge' | 'comparison';
  onPageChange?: (pageIndex: number, source: DocumentPreviewPane) => void;
}

/** Reusable, read-only document page preview used by merge and comparison surfaces. */
export class DocumentPreviewPane {
  readonly element: HTMLElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly statusEl: HTMLDivElement;
  private readonly canvasWrap: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly marker: HTMLDivElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageTotal: HTMLSpanElement;
  private readonly onPageChange?: DocumentPreviewPaneOptions['onPageChange'];
  private wasm: WasmBridge | null = null;
  private source: MergeDocumentSource | null = null;
  private loadingToken = 0;
  private pageIndex = 0;
  private anchor: DiffAnchor | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: DocumentPreviewPaneOptions) {
    this.onPageChange = options.onPageChange;
    this.element = document.createElement('section');
    this.element.className = `document-preview-pane ${options.variant === 'comparison'
      ? 'compare-document-preview'
      : 'merge-preview-pane'}`;
    this.element.dataset.role = options.role;
    this.element.setAttribute('aria-label', `${options.title} 문서 미리보기`);

    const header = document.createElement('header');
    header.className = 'merge-preview-head';
    this.titleEl = document.createElement('h3');
    this.titleEl.textContent = options.title;
    const navigation = document.createElement('div');
    navigation.className = 'merge-preview-page-navigation';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'merge-icon-button';
    previous.textContent = '‹';
    previous.setAttribute('aria-label', `${options.title} 이전 쪽`);
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'merge-icon-button';
    next.textContent = '›';
    next.setAttribute('aria-label', `${options.title} 다음 쪽`);
    this.pageInput = document.createElement('input');
    this.pageInput.type = 'number';
    this.pageInput.min = '1';
    this.pageInput.value = '1';
    this.pageInput.setAttribute('aria-label', `${options.title} 쪽 번호`);
    this.pageTotal = document.createElement('span');
    this.pageTotal.textContent = '/ –';
    navigation.append(previous, this.pageInput, this.pageTotal, next);
    header.append(this.titleEl, navigation);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'merge-preview-status';
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.textContent = '미리보기를 불러오지 않았습니다.';
    this.canvasWrap = document.createElement('div');
    this.canvasWrap.className = 'merge-preview-canvas-wrap';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'merge-preview-canvas';
    this.marker = document.createElement('div');
    this.marker.className = 'merge-preview-marker';
    this.marker.hidden = true;
    this.canvasWrap.append(this.canvas, this.marker);
    this.element.append(header, this.statusEl, this.canvasWrap);

    previous.addEventListener('click', () => this.setPage(this.pageIndex - 1));
    next.addEventListener('click', () => this.setPage(this.pageIndex + 1));
    this.pageInput.addEventListener('change', () => this.setPage(Number(this.pageInput.value) - 1));
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.render());
      this.resizeObserver.observe(this.canvasWrap);
    }
  }

  setTitle(title: string): void {
    this.titleEl.textContent = title;
    this.element.setAttribute('aria-label', `${title} 문서 미리보기`);
  }

  configureTabPanel(panelId: string, labelledBy: string): void {
    this.element.id = panelId;
    this.element.setAttribute('role', 'tabpanel');
    this.element.setAttribute('aria-labelledby', labelledBy);
    this.element.removeAttribute('aria-label');
    this.element.tabIndex = 0;
  }

  async load(source: MergeDocumentSource | null): Promise<void> {
    if (source && source === this.source && this.wasm) {
      this.render();
      return;
    }
    this.source = source;
    const token = ++this.loadingToken;
    if (!source) {
      this.statusEl.textContent = '충돌을 해결하면 결과 미리보기가 나타납니다.';
      this.clearCanvas();
      return;
    }
    this.statusEl.textContent = `${source.label ?? source.fileName} 미리보기를 불러오는 중입니다…`;
    try {
      this.wasm ??= new WasmBridge();
      await this.wasm.initialize();
      if (token !== this.loadingToken) return;
      this.wasm.loadDocument(source.bytes, source.fileName);
      this.wasm.refreshLayout();
      if (token !== this.loadingToken) return;
      this.pageIndex = Math.min(this.pageIndex, Math.max(0, this.wasm.pageCount - 1));
      this.pageTotal.textContent = `/ ${this.wasm.pageCount}`;
      this.render();
    } catch (error) {
      if (token !== this.loadingToken) return;
      this.statusEl.textContent = `미리보기 실패: ${mergeErrorMessage(error, '문서를 미리 볼 수 없습니다.')}`;
      this.clearCanvas();
    }
  }

  setPage(pageIndex: number, notify = true): void {
    const pageCount = this.wasm?.pageCount ?? 1;
    const next = Math.max(0, Math.min(Math.max(0, pageCount - 1), Math.floor(pageIndex || 0)));
    this.pageIndex = next;
    this.render();
    if (notify) this.onPageChange?.(next, this);
  }

  focus(
    anchor: DiffAnchor | null,
    fallbackPosition?: { section: number; paragraph: number },
  ): void {
    this.anchor = anchor;
    if (anchor) this.setPage(anchor.pageIndex);
    else if (fallbackPosition && this.wasm) {
      try {
        const rect = this.wasm.getCursorRect(fallbackPosition.section, fallbackPosition.paragraph, 0);
        this.setPage(rect.pageIndex);
        this.statusEl.textContent += ' / 관련 문단으로 이동함 (표시 위치 없음)';
      } catch {
        this.statusEl.textContent = '위치 정보가 없어 문서 미리보기만 표시합니다.';
        this.clearCanvas();
      }
    } else {
      this.statusEl.textContent = '위치 정보가 없어 문서 미리보기만 표시합니다.';
      this.clearCanvas();
    }
  }

  dispose(): void {
    ++this.loadingToken;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    try { this.wasm?.releaseDocument(); } catch { /* best-effort preview cleanup */ }
    this.wasm = null;
    this.source = null;
  }

  private render(): void {
    if (!this.wasm || !this.source || this.canvasWrap.clientWidth <= 0) return;
    try {
      const info = this.wasm.getPageInfo(this.pageIndex);
      const scale = Math.max(0.15, Math.min(1, (this.canvasWrap.clientWidth - 16) / Math.max(1, info.width)));
      this.canvas.width = Math.max(1, Math.floor(info.width * scale));
      this.canvas.height = Math.max(1, Math.floor(info.height * scale));
      this.wasm.renderPageToCanvasFiltered(this.pageIndex, this.canvas, scale, 'all');
      this.pageInput.value = String(this.pageIndex + 1);
      this.statusEl.textContent = `${this.source.label ?? this.source.fileName} / ${this.pageIndex + 1}쪽`;
      if (this.anchor?.pageIndex === this.pageIndex) {
        this.marker.hidden = false;
        this.marker.style.left = `${Math.floor(this.anchor.x * scale)}px`;
        this.marker.style.top = `${Math.floor(this.anchor.y * scale)}px`;
        this.marker.style.width = `${Math.max(12, Math.floor(this.anchor.width * scale))}px`;
        this.marker.style.height = `${Math.max(12, Math.floor(this.anchor.height * scale))}px`;
      } else {
        this.marker.hidden = true;
      }
    } catch (error) {
      this.statusEl.textContent = `미리보기 실패: ${mergeErrorMessage(error, '문서를 미리 볼 수 없습니다.')}`;
      this.clearCanvas();
    }
  }

  private clearCanvas(): void {
    this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.marker.hidden = true;
    this.pageTotal.textContent = '/ –';
  }
}
