import { WasmBridge } from '@/core/wasm-bridge';
import { EventBus } from '@/core/event-bus';
import type { PageInfo } from '@/core/types';
import { VirtualScroll } from './virtual-scroll';
import { CanvasPool } from './canvas-pool';
import { PageRenderer, type PageRenderContext, type PageRenderResult } from './page-renderer';
import { ViewportManager } from './viewport-manager';
import { CoordinateSystem } from './coordinate-system';
import type { CanvasKitRenderDiagnostics } from './canvaskit-renderer';
import { clampRenderScale, type RenderBackend } from './render-backend';
import {
  RendererSession,
  type RendererSessionDiagnostics,
  type RendererSessionSelection,
} from './renderer-session';
import { applyGridOverlayBox, createGridClipCornerOverlay, createGridOverlay } from './grid-overlay';
import { getGridViewSettings } from './grid-settings';
import {
  calculateAnchoredScroll,
  CENTER_ZOOM_ANCHOR,
  normalizeZoomAnchor,
  type ZoomAnchor,
  type ZoomPageBox,
} from './zoom-anchor.ts';
import {
  resolveActivePage,
  type ActivePageSnapshot,
} from './active-page.ts';
import { SubsecondRevisionWatcher } from '@/core/subsecond-runtime';
import {
  headerFooterApplyToLabel,
  parseHeaderFooterModeChanged,
  type HeaderFooterModeState,
} from '@/engine/header-footer-mode.ts';
import {
  drawHeaderFooterGuideCorners,
  headerFooterClipPath,
  resolveHeaderFooterBadgeMetrics,
  resolveHeaderFooterBandBox,
} from './header-footer-edit-overlay.ts';

const TEXT_EDIT_STATIC_LAYER_VERIFY_DELAY_MS = 800;
const AUTO_RENDERER_RESELECTION_DELAY_MS = 300;

type DeferredPrefetchTask =
  | { kind: 'idle'; id: number }
  | { kind: 'timeout'; id: number };

type IdleCallbackWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

export class CanvasView {
  private virtualScroll: VirtualScroll;
  private canvasPool: CanvasPool;
  private pageRenderer: PageRenderer;
  private viewportManager: ViewportManager;
  private coordinateSystem: CoordinateSystem;
  private subsecondRevisionWatcher: SubsecondRevisionWatcher;

  private scrollContent: HTMLElement;
  private pages: PageInfo[] = [];
  private currentVisiblePages: number[] = [];
  private editingPageIndex: number | null = null;
  private activePageSnapshot: ActivePageSnapshot | null = null;
  private headerFooterEditState: HeaderFooterModeState | null = null;
  private gridOverlaysByPage = new Map<number, HTMLElement[]>();
  private unsubscribers: (() => void)[] = [];
  private pendingTextEditRefreshes = new Map<number, PageRenderContext>();
  private textEditRefreshRafId: number | null = null;
  private textEditStaticLayerVerifyTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingPrefetchPages = new Set<number>();
  private deferredPrefetchTask: DeferredPrefetchTask | null = null;
  private rendererSelectionEpoch = 0;
  private rendererFallbackScheduled = false;
  private activeRendererDecisionKey: string | null = null;
  private autoRendererReselectionTimer: ReturnType<typeof setTimeout> | null = null;
  private mutationRefreshRafId: number | null = null;
  private documentLoadPrepared = false;
  private layoutViewportSize = { width: 0, height: 0 };
  private disposed = false;

  constructor(
    private container: HTMLElement,
    private wasm: WasmBridge,
    private eventBus: EventBus,
    private rendererSession: RendererSession,
  ) {
    this.virtualScroll = new VirtualScroll();
    this.canvasPool = new CanvasPool();
    this.pageRenderer = new PageRenderer(wasm);
    this.viewportManager = new ViewportManager(eventBus);
    this.coordinateSystem = new CoordinateSystem(this.virtualScroll);
    this.subsecondRevisionWatcher = new SubsecondRevisionWatcher(
      wasm,
      () => eventBus.emit('document-view-changed', 'subsecond-renderer'),
    );
    this.subsecondRevisionWatcher.start();

    this.scrollContent = container.querySelector('#scroll-content')!;
    this.viewportManager.attachTo(container);

    this.unsubscribers.push(
      eventBus.on('viewport-scroll', () => {
        if (!this.viewportManager.isZoomAnimating()) this.updateVisiblePages();
      }),
      eventBus.on('viewport-resize', () => this.onViewportResize()),
      eventBus.on('viewport-inset-changed', () => this.recenterHorizontally()),
      eventBus.on('zoom-changed', (zoom, anchor) => {
        this.onZoomChanged(
          zoom as number,
          normalizeZoomAnchor(anchor as Partial<ZoomAnchor> | undefined),
        );
      }),
      eventBus.on('headerFooterModeChanged', (payload) => {
        this.handleHeaderFooterModeChanged(payload);
      }),
      eventBus.on('document-page-invalidated', (payload) => {
        // 같은 프레임에 전체 재렌더가 이미 예약돼 있으면 단일 페이지 갱신은 그 안에 흡수된다.
        if (this.mutationRefreshRafId !== null) return;
        void this.refreshInvalidatedPageForMutation(payload);
      }),
      eventBus.on('document-changed', () => this.scheduleMutationRefresh()),
      eventBus.on('document-view-changed', (source) => {
        if (source === 'subsecond-renderer') {
          this.refreshPages();
          return;
        }
        void this.refreshPagesForRevision();
      }),
      eventBus.on('grid-view-changed', () => this.refreshGridOverlays()),
      eventBus.on('cursor-rect-updated', (payload) => {
        const pageIndex = this.pageIndexFromPayload(payload);
        if (pageIndex !== null) this.setEditingPageIndex(pageIndex);
      }),
      eventBus.on('editing-page-changed', (payload) => {
        this.setEditingPageIndex(this.pageIndexFromPayload(payload));
      }),
      eventBus.on('picture-object-selection-changed', (selected) => {
        if (selected === false) this.setEditingPageIndex(null);
      }),
      eventBus.on('table-object-selection-changed', (selected) => {
        if (selected === false) this.setEditingPageIndex(null);
      }),
    );
  }

  /** 문서 로드 후 호출 — 페이지 정보 수집 및 가상 스크롤 초기화 */
  async loadDocument(): Promise<void> {
    if (this.disposed) return;
    if (!this.documentLoadPrepared) this.prepareDocumentLoad();
    const epoch = this.rendererSelectionEpoch;
    this.documentLoadPrepared = false;
    if (this.disposed) return;
    const selection = await this.rendererSession.resolve(this.wasm);
    if (
      this.disposed
      || epoch !== this.rendererSelectionEpoch
      || !this.rendererSession.isCurrent(selection)
    ) return;
    this.applyRendererSelection(selection);

    const pageCount = this.wasm.pageCount;
    this.pages = this.collectPageInfo(pageCount);

    if (this.pages.length === 0) {
      console.error('[CanvasView] 로드된 페이지가 없습니다');
      return;
    }

    // 모바일: 문서 로드 시 폭 맞춤 줌 자동 적용
    if (window.innerWidth < 1024 && this.pages.length > 0) {
      const containerWidth = this.container.clientWidth - 20;
      const pageWidth = this.pages[0].width;
      if (pageWidth > 0 && containerWidth > 0) {
        const fitZoom = containerWidth / pageWidth;
        this.viewportManager.setZoom(Math.max(0.1, Math.min(fitZoom, 4.0)));
      }
    }

    this.recalcLayout();
    this.viewportManager.setScrollLeft(
      this.virtualScroll.getCenteredScrollLeft(this.layoutViewportSize.width),
    );

    this.container.scrollTop = 0;
    this.updateVisiblePages();
    // 초기 replay가 예약한 document fallback을 load 완료 전에 확정한다.
    await Promise.resolve();

    console.log(`[CanvasView] ${this.pages.length}/${pageCount}페이지 로드, 총 높이: ${this.virtualScroll.getTotalHeight()}px`);
  }

  private collectPageInfo(pageCount: number): PageInfo[] {
    try {
      const pages = this.wasm.getAllPageInfo();
      if (pages.length === pageCount) return pages;
      console.warn(`[CanvasView] 전체 페이지 정보 개수 불일치: ${pages.length}/${pageCount}`);
    } catch (error) {
      console.warn('[CanvasView] 전체 페이지 정보 조회 실패, 개별 조회로 대체:', error);
    }

    const pages: PageInfo[] = [];
    for (let page = 0; page < pageCount; page++) {
      try {
        pages.push(this.wasm.getPageInfo(page));
      } catch (error) {
        console.error(`[CanvasView] 페이지 ${page} 정보 조회 실패:`, error);
      }
    }
    return pages;
  }

  /** WASM 문서 교체 직후 호출하여 이전 문서의 renderer와 canvas를 동기적으로 분리한다. */
  prepareDocumentLoad(): void {
    if (this.disposed) return;
    this.rendererSelectionEpoch += 1;
    this.documentLoadPrepared = true;
    this.cancelAutoRendererReselection();
    this.rendererFallbackScheduled = false;
    this.rendererSession.beginDocument(this.wasm.documentDigest);
    this.activeRendererDecisionKey = null;
    this.reset();
  }

  resetRendererDiagnostics(): void {
    this.pageRenderer.releaseAllPageDiagnostics();
  }

  /**
   * 문서 변이 재렌더를 프레임당 한 번으로 합친다. 에이전트 편집처럼 document-changed
   * 가 짧은 간격으로 몰리면(툴 호출 버스트/벌크 교체) 이벤트마다 전체 재렌더를 돌지
   * 않고, 다음 rAF 에서 최신 문서 상태로 한 번만 갱신한다.
   */
  private scheduleMutationRefresh(): void {
    if (this.disposed || this.mutationRefreshRafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      void this.refreshPagesForMutation();
      return;
    }
    this.mutationRefreshRafId = requestAnimationFrame(() => {
      this.mutationRefreshRafId = null;
      void this.refreshPagesForMutation();
    });
  }

  private cancelScheduledMutationRefresh(): void {
    if (this.mutationRefreshRafId === null) return;
    cancelAnimationFrame(this.mutationRefreshRafId);
    this.mutationRefreshRafId = null;
  }

  private async refreshPagesForRevision(): Promise<void> {
    const selected = await this.selectNextDocumentRevision(false);
    if (!selected) return;
    this.refreshPages();
  }

  /**
   * 현재 mutation revision의 페이지 배치를 갱신한다. 선택이 유효할 때만
   * `document-layout-refreshed`를 보내 쪽/단 나누기 캐럿 reveal의 완료 경계가 된다.
   */
  private async refreshPagesForMutation(): Promise<void> {
    const selected = await this.selectMutationRevision();
    if (!selected || !this.rendererSession.isCurrent(selected.selection)) return;
    this.refreshPages();
    // InputHandler의 mutation 직후 caret 갱신보다 VirtualScroll 재계산이 늦다.
    // 새 page offset을 소비할 수 있는 완료 경계를 별도 이벤트로 알린다.
    // zoom/resize의 page-layout-changed와 분리한다 — 그쪽을 reveal에 쓰면
    // 배율 변경마다 스크롤이 따라간다.
    this.eventBus.emit('document-layout-refreshed', { source: 'mutation' });
  }

  private async refreshInvalidatedPageForMutation(payload: unknown): Promise<void> {
    const selected = await this.selectMutationRevision();
    if (!selected || !this.rendererSession.isCurrent(selected.selection)) return;
    if (selected.backendChanged) {
      this.refreshPages();
      return;
    }
    this.refreshInvalidatedPage(payload);
  }

  private async selectMutationRevision(): Promise<{
    selection: RendererSessionSelection;
    backendChanged: boolean;
  } | null> {
    if (this.disposed) return null;
    const pinned = this.rendererSession.pinAutoMutationRevision();
    if (!pinned) return this.selectNextDocumentRevision();

    this.rendererSelectionEpoch += 1;
    const selected = {
      selection: pinned,
      backendChanged: this.applyRendererSelection(pinned),
    };
    this.scheduleAutoRendererReselection();
    return selected;
  }

  private scheduleAutoRendererReselection(): void {
    this.cancelAutoRendererReselection();
    this.autoRendererReselectionTimer = setTimeout(() => {
      this.autoRendererReselectionTimer = null;
      void this.selectNextDocumentRevision().then((selected) => {
        if (!selected || this.disposed) return;
        if (selected.backendChanged) this.refreshPages();
      });
    }, AUTO_RENDERER_RESELECTION_DELAY_MS);
  }

  private cancelAutoRendererReselection(): void {
    if (this.autoRendererReselectionTimer === null) return;
    clearTimeout(this.autoRendererReselectionTimer);
    this.autoRendererReselectionTimer = null;
  }

  private async selectNextDocumentRevision(resetResources = true): Promise<{
    selection: RendererSessionSelection;
    backendChanged: boolean;
  } | null> {
    if (this.disposed) return null;
    const epoch = ++this.rendererSelectionEpoch;
    this.rendererSession.invalidateDocument({ resetResources });
    await Promise.resolve();
    if (this.disposed || epoch !== this.rendererSelectionEpoch) return null;

    const selection = await this.rendererSession.resolve(this.wasm);
    if (
      this.disposed
      || epoch !== this.rendererSelectionEpoch
      || !this.rendererSession.isCurrent(selection)
    ) return null;
    return {
      selection,
      backendChanged: this.applyRendererSelection(selection),
    };
  }

  private applyRendererSelection(selection: RendererSessionSelection): boolean {
    const decisionChanged = this.activeRendererDecisionKey !== selection.diagnostics.decisionKey;
    const changed = this.pageRenderer.configure(
      selection.backend,
      selection.diagnostics.renderProfile,
      selection.canvaskitRenderer,
      selection.backend === 'canvas2d'
        && (
          selection.diagnostics.fallbackReason === 'canvaskitResourcePreparationFailed'
          || selection.diagnostics.fallbackReason === 'canvaskitRuntimeFailed'
        ),
    );
    if (decisionChanged && !changed) this.pageRenderer.invalidateDocumentRevision();
    this.activeRendererDecisionKey = selection.diagnostics.decisionKey;
    this.eventBus.emit('renderer-selection-changed', selection.diagnostics);
    return changed;
  }

  /** DEV baseline이 pool 소유권을 바꾸지 않고 현재 페이지를 즉시 다시 그린다. */
  rerenderPageForDiagnostics(pageIdx: number): boolean {
    const canvas = this.canvasPool.getCanvas(pageIdx);
    return canvas ? this.renderCanvas(pageIdx, canvas) : false;
  }

  /** 레이아웃을 재계산한다 (줌/리사이즈 공통) */
  private recalcLayout(): void {
    const zoom = this.viewportManager.getZoom();
    const viewport = this.viewportManager.getViewportSize();
    // 쪽 이동/맞쪽 배치는 아직 이식하지 않아 세로는 항상 vertical 이다.
    // viewport.height 는 가로 줄 레이아웃 슬롯을 채워 둔다.
    this.virtualScroll.setPageDimensions(
      this.pages,
      zoom,
      viewport.width,
      undefined,
      'vertical',
      viewport.height,
    );
    this.scrollContent.style.height = `${this.virtualScroll.getTotalHeight()}px`;
    this.scrollContent.style.width = `${this.virtualScroll.getTotalWidth()}px`;
    this.layoutViewportSize = viewport;

    // 그리드 모드 CSS 클래스 토글
    this.scrollContent.classList.toggle('grid-mode', this.virtualScroll.isGridMode());

    // 가상 스크롤 페이지 배치가 확정된 뒤에만 화면 좌표가 유효하다 — 문서 변이
    // 직후(비동기 refresh 이전)에 그린 오버레이가 여기서 재배치된다.
    this.eventBus.emit('page-layout-changed');
  }

  /** 스크롤/리사이즈 시 보이는 페이지를 갱신한다 */
  private updateVisiblePages(): void {
    const scrollY = this.viewportManager.getScrollY();
    const scrollX = this.viewportManager.getScrollX();
    const { width: vpWidth, height: vpHeight } = this.viewportManager.getViewportSize();

    const pageWindow = this.virtualScroll.getPageWindow(scrollY, vpHeight, scrollX, vpWidth);
    const prefetchPages = pageWindow.prefetch;
    const visiblePages = pageWindow.visible;
    const visibleSet = new Set(visiblePages);

    // 벗어난 페이지 해제
    const prefetchSet = new Set(prefetchPages);
    for (const pageIdx of this.canvasPool.activePages) {
      if (!prefetchSet.has(pageIdx)) {
        this.releaseRenderedPage(pageIdx);
      }
    }

    // 현재 보이는 페이지는 즉시 렌더한다. 인접 페이지는 스크롤 입력 뒤에 처리한다.
    for (const pageIdx of visiblePages) {
      this.pendingPrefetchPages.delete(pageIdx);
      if (!this.canvasPool.has(pageIdx)) {
        this.renderPage(pageIdx);
      }
    }
    this.schedulePrefetchPages(prefetchPages.filter((pageIdx) => !visibleSet.has(pageIdx)));

    this.currentVisiblePages = visiblePages;
    this.updateActivePageSnapshot();
    this.renderHeaderFooterEditOverlays();
  }

  private pageIndexFromPayload(payload: unknown): number | null {
    const value = typeof payload === 'object' && payload !== null && 'pageIndex' in payload
      ? (payload as { pageIndex?: unknown }).pageIndex
      : payload;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    return value;
  }

  private setEditingPageIndex(pageIndex: number | null): void {
    if (this.editingPageIndex === pageIndex) return;
    this.editingPageIndex = pageIndex;
    this.updateActivePageSnapshot();
    // 눈금자는 순수 스크롤의 viewport fallback이 아니라 마지막 편집 focus를 따른다.
    // current-page-changed와 렌더 가시성은 위 active snapshot 계약을 계속 사용한다.
    this.eventBus.emit('focused-page-changed', pageIndex);
  }

  /** 캐럿·개체 선택과 스크롤이 공유하는 활성 페이지 판정·발행 관문. */
  private updateActivePageSnapshot(): void {
    const viewport = this.viewportManager.getViewportSize();
    const viewportCenterX = this.viewportManager.getScrollX() + viewport.width / 2;
    const viewportCenterY = this.viewportManager.getScrollY() + viewport.height / 2;
    const viewportPageIndex = this.currentVisiblePages.length > 0
      ? this.virtualScroll.getPageAtPoint(viewportCenterX, viewportCenterY)
      : null;
    const next = resolveActivePage({
      pageCount: this.virtualScroll.pageCount,
      visiblePages: this.currentVisiblePages,
      editingPageIndex: this.editingPageIndex,
      viewportPageIndex,
    });
    const snapshotChanged = !(
      next?.pageIndex === this.activePageSnapshot?.pageIndex
      && next?.source === this.activePageSnapshot?.source
    );

    this.activePageSnapshot = next;
    if (snapshotChanged) this.eventBus.emit('active-page-changed', next);
    // 전체 쪽 수·구역 쪽번호가 pagination으로 바뀔 수 있으므로 snapshot이 같아도
    // 기존 상태 표시줄 이벤트는 매 visible-page 갱신마다 유지한다.
    if (next) {
      this.eventBus.emit(
        'current-page-changed',
        next.pageIndex,
        this.virtualScroll.pageCount,
      );
    }
  }

  /** HF 타겟을 구역 첫 페이지에 가상 투영하고 실제 적용 쪽을 함께 표시한다. */
  private handleHeaderFooterModeChanged(payload: unknown): void {
    const state = parseHeaderFooterModeChanged(payload);
    if (state === 'none') {
      this.headerFooterEditState = null;
      this.removeHeaderFooterEditOverlays();
      return;
    }

    this.headerFooterEditState = state;
    if (!this.currentVisiblePages.includes(state.previewPage)) {
      const pageTop = this.virtualScroll.getPageOffset(state.previewPage);
      this.viewportManager.setScrollTop(Math.max(0, pageTop - this.virtualScroll.gap));
      this.updateVisiblePages();
      return;
    }
    this.renderHeaderFooterEditOverlays();
  }

  private renderHeaderFooterEditOverlays(force = false): void {
    const state = this.headerFooterEditState;
    if (!state || this.pages.length === 0) {
      this.removeHeaderFooterEditOverlays();
      return;
    }

    const desiredPages = new Set<number>();
    for (const pageIdx of this.canvasPool.activePages) {
      const page = this.pages[pageIdx];
      if (!page) continue;
      const isPreview = pageIdx === state.previewPage;
      let isAppliedPage = false;
      try {
        const target = this.wasm.getHeaderFooterEditTarget(pageIdx, state.mode === 'header');
        isAppliedPage = target.sectionIndex === state.sectionIdx && target.applyTo === state.applyTo;
      } catch {
        // 현재 렌더된 HF가 없는 쪽은 연관 표시 대상에서 뺀다.
      }
      if (!isPreview && !isAppliedPage) continue;
      desiredPages.add(pageIdx);

      const zoom = this.viewportManager.getZoom();
      const overlayKey = [
        state.mode,
        state.sectionIdx,
        state.applyTo,
        isPreview ? 'representative' : 'related',
        zoom,
      ].join(':');
      const selector = `[data-rhwp-hf-edit-page="${pageIdx}"]`;
      const existing = this.scrollContent.querySelector<HTMLElement>(selector);
      if (!force && existing?.dataset.hfOverlayKey === overlayKey) {
        this.applyPageBox(existing, pageIdx);
        continue;
      }
      existing?.remove();

      const layer = document.createElement('div');
      layer.className = `hf-edit-surface-layer ${isPreview ? 'is-representative' : 'is-related'}`;
      layer.dataset.rhwpHfEditPage = String(pageIdx);
      layer.dataset.hfApplyTo = String(state.applyTo);
      layer.dataset.hfMode = state.mode;
      layer.dataset.hfOverlayKey = overlayKey;
      layer.setAttribute('aria-hidden', 'true');
      layer.style.width = `${page.width * zoom}px`;
      layer.style.height = `${page.height * zoom}px`;
      this.applyPageBox(layer, pageIdx);

      const band = resolveHeaderFooterBandBox(page, state.mode === 'header');
      const rawDpr = window.devicePixelRatio || 1;
      const renderScale = clampRenderScale(page, zoom * rawDpr);
      const dpr = renderScale / (zoom > 0 ? zoom : 1);
      if (isPreview) {
        const previewCanvas = document.createElement('canvas');
        previewCanvas.className = 'hf-edit-preview-canvas';
        try {
          this.wasm.renderHeaderFooterEditPreviewToCanvas(
            pageIdx,
            state.sectionIdx,
            state.mode === 'header',
            state.applyTo,
            previewCanvas,
            renderScale,
          );
          previewCanvas.style.width = `${previewCanvas.width / dpr}px`;
          previewCanvas.style.height = `${previewCanvas.height / dpr}px`;
          previewCanvas.style.clipPath = headerFooterClipPath(page, band, zoom);
          layer.appendChild(previewCanvas);
        } catch (error) {
          console.error('[CanvasView] HF 대표 편집 preview 렌더링 실패:', error);
        }
      }

      const guideCanvas = document.createElement('canvas');
      guideCanvas.className = 'hf-edit-guide-canvas';
      guideCanvas.width = Math.max(1, Math.round(page.width * renderScale));
      guideCanvas.height = Math.max(1, Math.round(page.height * renderScale));
      guideCanvas.style.width = `${guideCanvas.width / dpr}px`;
      guideCanvas.style.height = `${guideCanvas.height / dpr}px`;
      drawHeaderFooterGuideCorners(band, guideCanvas, renderScale, zoom);
      layer.appendChild(guideCanvas);

      const region = document.createElement('div');
      region.className = `hf-edit-region ${isPreview ? 'is-representative' : 'is-related'}`;
      region.style.left = `${band.x * zoom}px`;
      region.style.top = `${band.y * zoom}px`;
      region.style.width = `${band.width * zoom}px`;
      region.style.height = `${band.height * zoom}px`;
      layer.appendChild(region);

      if (isPreview) {
        const kind = state.mode === 'header' ? '머리말' : '꼬리말';
        const badgeMetrics = resolveHeaderFooterBadgeMetrics(zoom);
        const badge = document.createElement('span');
        badge.className = 'hf-edit-badge';
        badge.textContent = `${kind}(${headerFooterApplyToLabel(state.applyTo)})`;
        badge.style.left = `${band.x * zoom}px`;
        badge.style.top = `${band.y * zoom}px`;
        badge.style.fontSize = `${badgeMetrics.fontSizePx}px`;
        badge.style.setProperty('--hf-edit-badge-gap', `${badgeMetrics.gapPx}px`);
        layer.appendChild(badge);
      }

      this.scrollContent.appendChild(layer);
    }
    this.scrollContent.querySelectorAll<HTMLElement>('[data-rhwp-hf-edit-page]')
      .forEach((element) => {
        const pageIdx = Number(element.dataset.rhwpHfEditPage);
        if (!desiredPages.has(pageIdx)) element.remove();
      });
  }

  private removeHeaderFooterEditOverlays(): void {
    this.scrollContent.querySelectorAll('[data-rhwp-hf-edit-page]').forEach((element) => element.remove());
  }

  /** 스크롤 중에는 다음 페이지의 선렌더를 idle time으로 미룬다. */
  private schedulePrefetchPages(pageIndices: readonly number[]): void {
    const candidateSet = new Set(pageIndices);
    for (const pageIdx of this.pendingPrefetchPages) {
      if (!candidateSet.has(pageIdx)) this.pendingPrefetchPages.delete(pageIdx);
    }
    for (const pageIdx of pageIndices) {
      if (!this.canvasPool.has(pageIdx)) this.pendingPrefetchPages.add(pageIdx);
    }
    if (this.pendingPrefetchPages.size === 0 || this.deferredPrefetchTask !== null) return;

    const run = () => {
      this.deferredPrefetchTask = null;
      const pages = Array.from(this.pendingPrefetchPages);
      this.pendingPrefetchPages.clear();
      for (const pageIdx of pages) {
        if (!this.canvasPool.has(pageIdx)) this.renderPage(pageIdx);
      }
    };
    const idleWindow = window as IdleCallbackWindow;
    if (typeof idleWindow.requestIdleCallback === 'function') {
      this.deferredPrefetchTask = {
        kind: 'idle',
        id: idleWindow.requestIdleCallback(run, { timeout: 1000 }),
      };
      return;
    }
    this.deferredPrefetchTask = {
      kind: 'timeout',
      id: window.setTimeout(run, 250),
    };
  }

  private cancelPendingPrefetch(): void {
    const task = this.deferredPrefetchTask;
    this.deferredPrefetchTask = null;
    this.pendingPrefetchPages.clear();
    if (!task) return;

    if (task.kind === 'idle') {
      (window as IdleCallbackWindow).cancelIdleCallback?.(task.id);
    } else {
      clearTimeout(task.id);
    }
  }

  /** 렌더된 페이지 하나의 canvas/overlay/타이머를 모두 해제한다. */
  private releaseRenderedPage(pageIdx: number): void {
    this.cancelPendingTextEditRefresh(pageIdx);
    this.cancelTextEditStaticLayerVerification(pageIdx);
    this.pageRenderer.cancelReRender(pageIdx);
    this.pageRenderer.removePageLayers(this.scrollContent, pageIdx);
    this.pageRenderer.releasePageDiagnostics(pageIdx);
    this.scrollContent.querySelector(`[data-rhwp-hf-edit-page="${pageIdx}"]`)?.remove();
    this.removeGridOverlay(pageIdx);
    this.canvasPool.release(pageIdx);
  }

  /** 단일 페이지를 렌더링한다 */
  private renderPage(pageIdx: number): void {
    const canvas = this.canvasPool.acquire(pageIdx);
    if (!canvas.parentElement) {
      this.scrollContent.appendChild(canvas);
    }
    if (!this.renderCanvas(pageIdx, canvas)) {
      this.canvasPool.release(pageIdx);
    }
  }

  /** 기존 canvas를 유지한 채 페이지 내용을 다시 그린다. */
  private renderCanvas(
    pageIdx: number,
    canvas: HTMLCanvasElement,
    renderContext: PageRenderContext = {},
  ): boolean {
    const zoom = this.viewportManager.getZoom();
    const rawDpr = window.devicePixelRatio || 1;

    const pageInfo = this.pages[pageIdx];
    if (!pageInfo) {
      console.error(`[CanvasView] 페이지 ${pageIdx} 정보가 없습니다`);
      return false;
    }
    // iOS/WebKit과 GPU surface가 감당하기 어려운 물리 픽셀 수를 중앙 정책으로 제한한다.
    const renderScale = clampRenderScale(pageInfo, zoom * rawDpr);
    const dpr = renderScale / (zoom > 0 ? zoom : 1);

    // Canvas를 DOM에 추가하고 위치를 설정한다
    canvas.style.top = `${this.virtualScroll.getPageOffset(pageIdx)}px`;

    // 그리드 모드: 고정 left 좌표, 단일 열: CSS 중앙 정렬
    const pageLeft = this.virtualScroll.getPageLeft(pageIdx);
    if (pageLeft >= 0) {
      canvas.style.left = `${pageLeft}px`;
      canvas.style.transform = 'none';
    } else {
      canvas.style.left = '50%';
      canvas.style.transform = 'translateX(-50%)';
    }
    canvas.style.transformOrigin = '';

    // WASM이 Canvas 크기를 자동 설정한다 (물리 픽셀 = 페이지크기 × zoom × DPR)
    let renderResult: PageRenderResult = { needsTextEditStaticLayerVerification: false };
    let renderedCanvas = canvas;
    const rendererDecisionKey = this.activeRendererDecisionKey;
    try {
      renderResult = this.pageRenderer.renderPage(
        pageIdx,
        canvas,
        renderScale,
        zoom,
        dpr,
        renderContext,
        pageInfo,
      );
      if (renderResult.renderedCanvas && renderResult.renderedCanvas !== canvas) {
        renderedCanvas = renderResult.renderedCanvas;
        this.canvasPool.replace(pageIdx, canvas, renderedCanvas);
      }
      const canvaskitDiagnostics = this.pageRenderer.getBackend() === 'canvaskit'
        ? this.pageRenderer.getCanvasKitRenderDiagnostics(pageIdx)
        : null;
      if (
        canvaskitDiagnostics
        && !canvaskitDiagnostics.passesRuntimeReadinessGate
        && rendererDecisionKey
        && this.rendererSession.isAutoRequest()
      ) {
        const details = [
          `blockers=${canvaskitDiagnostics.readinessBlockers.join(',') || 'unknown'}`,
          canvaskitDiagnostics.lastRenderError
            ? `error=${canvaskitDiagnostics.lastRenderError}`
            : null,
          canvaskitDiagnostics.lastUnexpectedUnsupportedOps.length > 0
            ? `unexpectedOps=${canvaskitDiagnostics.lastUnexpectedUnsupportedOps.join(',')}`
            : null,
        ].filter((detail): detail is string => detail !== null).join('; ');
        this.pageRenderer.removePageLayers(this.scrollContent, pageIdx);
        this.removeGridOverlay(pageIdx);
        this.scheduleCanvasKitFallback(
          new Error(`CanvasKit runtime readiness gate failed (${details})`),
          rendererDecisionKey,
          'runtime',
        );
        return false;
      }
    } catch (e) {
      console.error(`[CanvasView] 페이지 ${pageIdx} 렌더링 실패:`, e);
      this.pageRenderer.removePageLayers(this.scrollContent, pageIdx);
      this.removeGridOverlay(pageIdx);
      if (this.pageRenderer.getBackend() === 'canvaskit' && rendererDecisionKey) {
        this.scheduleCanvasKitFallback(e, rendererDecisionKey, 'resource');
      }
      return false;
    }

    // CSS 표시 크기 = 물리 픽셀 / DPR (= 페이지크기 × zoom)
    renderedCanvas.style.width = `${renderedCanvas.width / dpr}px`;
    renderedCanvas.style.height = `${renderedCanvas.height / dpr}px`;
    renderedCanvas.style.transformOrigin = '';
    renderedCanvas.dataset.rhwpRenderedZoom = String(zoom);
    renderedCanvas.dataset.rhwpPageIndex = String(pageIdx);
    this.renderGridOverlay(pageIdx, renderedCanvas);
    if (renderResult.needsTextEditStaticLayerVerification) {
      this.scheduleTextEditStaticLayerVerification(pageIdx);
    } else if (renderContext.reason !== 'text-edit') {
      this.cancelTextEditStaticLayerVerification(pageIdx);
    }
    return true;
  }

  private scheduleCanvasKitFallback(
    error: unknown,
    expectedDecisionKey: string,
    kind: 'resource' | 'runtime',
  ): void {
    if (this.rendererFallbackScheduled) return;
    const selection = kind === 'resource'
      ? this.rendererSession.fallbackFromResourceFailure(error, expectedDecisionKey)
      : this.rendererSession.fallbackFromRuntimeFailure(error, expectedDecisionKey);
    if (!selection) return;
    this.rendererFallbackScheduled = true;
    queueMicrotask(() => {
      this.rendererFallbackScheduled = false;
      if (this.disposed || !this.rendererSession.isCurrent(selection)) return;
      this.applyRendererSelection(selection);
      this.cancelPendingTextEditRefresh();
      this.cancelTextEditStaticLayerVerification();
      this.releaseAllRenderedPages();
      this.pageRenderer.cancelAll();
      this.updateVisiblePages();
    });
  }

  /** 뷰포트 리사이즈 처리 */
  private onViewportResize(): void {
    // 접기/펼치기 전이 프레임은 inset rAF 루프가 맡는다. ResizeObserver 와
    // 겹치면 같은 프레임에 레이아웃을 두 번 탄다.
    if (
      document.body.classList.contains('ag-sidebar-animating')
      && !document.body.classList.contains('ag-sidebar-resizing')
    ) {
      return;
    }
    if (this.sidebarInsetIsMoving()) {
      this.recenterHorizontally();
      return;
    }
    const nextViewport = this.viewportManager.getViewportSize();
    if (this.pages.length === 0) {
      this.layoutViewportSize = nextViewport;
      this.updateVisiblePages();
      return;
    }

    const previousViewport = this.layoutViewportSize;
    const canPreserveCenter = previousViewport.width > 0 && previousViewport.height > 0;
    const scrollLeft = this.viewportManager.getScrollX();
    const scrollTop = this.viewportManager.getScrollY();
    // pan-space 가 viewport 폭 함수라서 폭이 바뀌면 pageLeft 도 함께 변한다.
    // 사이드바 inset 애니메이션 중이거나 이전에 가운데였으면 X 를 강제 재중앙 정렬한다.
    const forceCenterX = document.body.classList.contains('ag-sidebar-animating');
    const prevCenteredScrollLeft = canPreserveCenter
      ? this.virtualScroll.getCenteredScrollLeft(previousViewport.width)
      : 0;
    const wasHorizontallyCentered = canPreserveCenter
      && Math.abs(scrollLeft - prevCenteredScrollLeft) <= 2;
    const focusPage = canPreserveCenter
      ? this.virtualScroll.getPageAtPoint(
        scrollLeft + previousViewport.width / 2,
        scrollTop + previousViewport.height / 2,
      )
      : 0;
    const oldBox = canPreserveCenter
      ? this.getZoomPageBox(focusPage, previousViewport.width)
      : null;

    // 그리드 모드에서 열 수가 바뀔 수 있으므로 레이아웃 재계산
    const wasGrid = this.virtualScroll.isGridMode();
    this.recalcLayout();
    const isGrid = this.virtualScroll.isGridMode();

    if (oldBox) {
      const newBox = this.getZoomPageBox(focusPage, nextViewport.width);
      const nextScroll = calculateAnchoredScroll(
        oldBox,
        newBox,
        {
          width: previousViewport.width,
          height: previousViewport.height,
          scrollLeft,
          scrollTop,
        },
        CENTER_ZOOM_ANCHOR,
        nextViewport,
      );
      this.viewportManager.setScrollLeft(
        forceCenterX || wasHorizontallyCentered
          ? this.virtualScroll.getCenteredScrollLeft(nextViewport.width)
          : nextScroll.scrollLeft,
      );
      this.viewportManager.setScrollTop(nextScroll.scrollTop);
    } else {
      this.viewportManager.setScrollLeft(
        this.virtualScroll.getCenteredScrollLeft(nextViewport.width),
      );
    }

    // 이미 pool 에 있는 canvas 는 renderPage 를 다시 타지 않으므로
    // pageLeft 변경을 style.left 에 직접 반영해야 한다 (사이드바 close 시 핵심).
    this.repositionRenderedPages();

    if (wasGrid || isGrid) {
      // 그리드 관련 변경 시 전체 재렌더링
      this.cancelPendingTextEditRefresh();
      this.cancelTextEditStaticLayerVerification();
      this.releaseAllRenderedPages();
      this.pageRenderer.cancelAll();
    }
    this.updateVisiblePages();
  }

  /** 에이전트 사이드바 inset 전환 직후 용지를 남은 폭 기준으로 가운데 정렬한다. */
  recenterHorizontally(): void {
    if (this.pages.length === 0) return;
    this.viewportManager.syncViewportSize();
    this.recalcLayout();
    const { width } = this.viewportManager.getViewportSize();
    if (width <= 0) return;
    this.viewportManager.setScrollLeft(this.virtualScroll.getCenteredScrollLeft(width));
    this.repositionRenderedPages();
    // 드래그/전이 중에는 페이지 재렌더·프리페치를 미룬다.
    if (!this.sidebarInsetIsMoving()) this.updateVisiblePages();
  }

  private sidebarInsetIsMoving(): boolean {
    const { classList } = document.body;
    return classList.contains('ag-sidebar-resizing') || classList.contains('ag-sidebar-animating');
  }

  /**
   * 가상 스크롤 좌표가 바뀐 뒤, 이미 렌더된 페이지/오버레이의 DOM 위치를 갱신한다.
   * updateVisiblePages 는 pool hit 시 style.left 를 건드리지 않는다.
   */
  private repositionRenderedPages(): void {
    for (const pageIdx of this.canvasPool.activePages) {
      const canvas = this.canvasPool.getCanvas(pageIdx);
      if (canvas) this.applyPageBox(canvas, pageIdx);
    }
    this.forEachRenderedPageOverlay((element, pageIdx) => this.applyPageBox(element, pageIdx));
  }

  private forEachRenderedPageOverlay(
    callback: (element: HTMLElement, pageIdx: number) => void,
  ): void {
    this.scrollContent
      .querySelectorAll<HTMLElement>('[data-rhwp-overlay-page], [data-rhwp-grid-page], [data-rhwp-hf-edit-page]')
      .forEach((element) => {
        const rawPage = element.dataset.rhwpOverlayPage
          ?? element.dataset.rhwpGridPage
          ?? element.dataset.rhwpHfEditPage;
        const pageIdx = Number(rawPage);
        if (Number.isInteger(pageIdx) && this.canvasPool.has(pageIdx)) {
          callback(element, pageIdx);
        }
      });
  }

  private applyPageBox(element: HTMLElement, pageIdx: number): void {
    element.style.top = `${this.virtualScroll.getPageOffset(pageIdx)}px`;
    const pageLeft = this.virtualScroll.getPageLeft(pageIdx);
    const zoomPreview = element.style.transformOrigin === 'top left';
    if (pageLeft >= 0) {
      element.style.left = `${pageLeft}px`;
      if (!zoomPreview) {
        element.style.transform = 'none';
        element.style.transformOrigin = '';
      }
    } else {
      element.style.left = '50%';
      if (!zoomPreview) {
        element.style.transform = 'translateX(-50%)';
        element.style.transformOrigin = '';
      }
    }
  }

  private getZoomPageBox(pageIdx: number, viewportWidth: number): ZoomPageBox {
    const layoutWidth = Math.max(viewportWidth, this.virtualScroll.getTotalWidth());
    return {
      left: this.virtualScroll.getPageLeftResolved(pageIdx, layoutWidth),
      top: this.virtualScroll.getPageOffset(pageIdx),
      width: this.virtualScroll.getPageWidth(pageIdx),
      height: this.virtualScroll.getPageHeight(pageIdx),
    };
  }

  /** 줌 변경 처리 */
  private onZoomChanged(zoom: number, anchor: ZoomAnchor): void {
    if (this.pages.length === 0) return;

    const scrollTop = this.viewportManager.getScrollY();
    const scrollLeft = this.viewportManager.getScrollX();
    const { width: vpWidth, height: vpHeight } = this.viewportManager.getViewportSize();
    const anchorDocumentX = scrollLeft + vpWidth * anchor.x;
    const anchorDocumentY = scrollTop + vpHeight * anchor.y;
    const focusPage = this.virtualScroll.getPageAtPoint(anchorDocumentX, anchorDocumentY);
    const oldBox = this.getZoomPageBox(focusPage, vpWidth);

    this.recalcLayout();

    const newBox = this.getZoomPageBox(focusPage, vpWidth);
    const nextScroll = calculateAnchoredScroll(
      oldBox,
      newBox,
      {
        width: vpWidth,
        height: vpHeight,
        scrollLeft,
        scrollTop,
      },
      anchor,
    );
    this.viewportManager.setScrollLeft(nextScroll.scrollLeft);
    this.viewportManager.setScrollTop(nextScroll.scrollTop);

    this.eventBus.emit('zoom-level-display', zoom);

    if (this.viewportManager.isZoomAnimating()) {
      this.cancelPendingTextEditRefresh();
      this.cancelTextEditStaticLayerVerification();
      this.cancelPendingPrefetch();
      this.updateRenderedPageZoomPreview();
      return;
    }

    // 모든 Canvas 재렌더링
    this.cancelPendingTextEditRefresh();
    this.cancelTextEditStaticLayerVerification();
    this.releaseAllRenderedPages();
    this.pageRenderer.cancelAll();
    this.updateVisiblePages();
  }

  private updateRenderedPageZoomPreview(): void {
    const zoom = this.viewportManager.getZoom();
    const scaleByPage = new Map<number, number>();
    for (const pageIdx of this.canvasPool.activePages) {
      const canvas = this.canvasPool.getCanvas(pageIdx);
      if (!canvas) continue;
      const renderedZoom = Number(canvas.dataset.rhwpRenderedZoom);
      const scale = Number.isFinite(renderedZoom) && renderedZoom > 0
        ? zoom / renderedZoom
        : 1;
      scaleByPage.set(pageIdx, scale);
      this.applyZoomPreviewBox(canvas, pageIdx, scale);
    }
    this.forEachRenderedPageOverlay((element, pageIdx) => {
      const scale = scaleByPage.get(pageIdx);
      if (scale !== undefined) this.applyZoomPreviewBox(element, pageIdx, scale);
    });
  }

  private applyZoomPreviewBox(element: HTMLElement, pageIdx: number, scale: number): void {
    element.style.top = `${this.virtualScroll.getPageOffset(pageIdx)}px`;
    const pageLeft = this.virtualScroll.getPageLeft(pageIdx);
    if (pageLeft >= 0) {
      element.style.left = `${pageLeft}px`;
      element.style.transform = `scale(${scale})`;
      element.style.transformOrigin = 'top left';
    } else {
      element.style.left = '50%';
      element.style.transform = `translateX(-50%) scale(${scale})`;
      element.style.transformOrigin = 'top center';
    }
  }

  /** 편집 후 보이는 페이지를 재렌더링한다 */
  refreshPages(): void {
    if (this.pages.length === 0) return;

    // 페이지 정보 재수집 (페이지 수/크기가 변경될 수 있음)
    const pageCount = this.wasm.pageCount;
    this.pages = this.collectPageInfo(pageCount);

    this.recalcLayout();

    this.cancelPendingTextEditRefresh();
    this.cancelTextEditStaticLayerVerification();
    this.pageRenderer.cancelAll();

    // 이전 문서 상태로 그려진 페이지들. canvas 를 버리지 않고 제자리에서 다시
    // 그린다 — DOM 교체로 인한 깜빡임과 이미지 재디코드 재렌더 사이클을 피한다.
    const stalePages = new Set(this.canvasPool.activePages);
    for (const pageIdx of stalePages) {
      if (pageIdx >= this.pages.length) {
        // 문서가 짧아져 사라진 페이지
        this.releaseRenderedPage(pageIdx);
        stalePages.delete(pageIdx);
      }
    }

    // 화면에 새로 들어온 페이지를 채우고, 범위를 벗어난 페이지를 해제한다.
    this.updateVisiblePages();

    const visibleSet = new Set(this.currentVisiblePages);
    for (const pageIdx of stalePages) {
      if (!this.canvasPool.has(pageIdx)) continue; // updateVisiblePages 가 이미 해제
      if (visibleSet.has(pageIdx)) {
        const canvas = this.canvasPool.getCanvas(pageIdx)!;
        if (!this.renderCanvas(pageIdx, canvas)) {
          this.canvasPool.release(pageIdx);
        }
      } else {
        // 화면 밖 선렌더 페이지는 지금 다시 그리지 않는다 — idle 프리페치가 다시 채운다.
        this.releaseRenderedPage(pageIdx);
      }
    }

    const scrollY = this.viewportManager.getScrollY();
    const { height: vpHeight } = this.viewportManager.getViewportSize();
    this.schedulePrefetchPages(
      this.virtualScroll
        .getPrefetchPages(scrollY, vpHeight)
        .filter((pageIdx) => !visibleSet.has(pageIdx)),
    );
  }

  /** 텍스트 입력처럼 좁은 변경은 page info 재수집 없이 해당 페이지 canvas만 다시 그린다. */
  private refreshInvalidatedPage(payload: unknown): void {
    if (this.pages.length === 0) return;

    const pageIndex =
      typeof payload === 'object' && payload !== null && 'pageIndex' in payload
        ? Number((payload as { pageIndex?: unknown }).pageIndex)
        : Number(payload);
    const reason =
      typeof payload === 'object' && payload !== null && 'reason' in payload
        ? (payload as { reason?: unknown }).reason
        : undefined;
    const renderContext: PageRenderContext =
      reason === 'text-edit'
        ? { reason: 'text-edit', allowStaticOverlayReuse: true }
        : { reason: 'unknown', allowStaticOverlayReuse: false };

    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
      this.cancelPendingTextEditRefresh();
      this.cancelTextEditStaticLayerVerification();
      this.refreshPages();
      return;
    }

    const pageCount = this.wasm.pageCount;
    if (pageCount !== this.pages.length || pageIndex >= pageCount) {
      this.cancelPendingTextEditRefresh();
      this.cancelTextEditStaticLayerVerification();
      this.refreshPages();
      return;
    }

    if (renderContext.reason === 'text-edit') {
      this.scheduleTextEditPageRefresh(pageIndex, renderContext);
      return;
    }

    this.cancelPendingTextEditRefresh(pageIndex);
    this.cancelTextEditStaticLayerVerification(pageIndex);
    this.refreshInvalidatedPageNow(pageIndex, renderContext);
  }

  private scheduleTextEditPageRefresh(pageIndex: number, renderContext: PageRenderContext): void {
    this.cancelTextEditStaticLayerVerification(pageIndex);
    this.pendingTextEditRefreshes.set(pageIndex, renderContext);
    if (this.textEditRefreshRafId !== null) return;

    this.textEditRefreshRafId = requestAnimationFrame(() => {
      this.textEditRefreshRafId = null;
      const pending = Array.from(this.pendingTextEditRefreshes.entries());
      this.pendingTextEditRefreshes.clear();
      for (const [pendingPageIndex, pendingContext] of pending) {
        this.refreshInvalidatedPageNow(pendingPageIndex, pendingContext);
      }
    });
  }

  private refreshInvalidatedPageNow(pageIndex: number, renderContext: PageRenderContext): void {
    if (this.pages.length === 0) return;

    const pageCount = this.wasm.pageCount;
    if (pageCount !== this.pages.length || pageIndex >= pageCount) {
      this.refreshPages();
      return;
    }

    const canvas = this.canvasPool.getCanvas(pageIndex);
    if (!canvas) {
      this.updateVisiblePages();
      return;
    }

    if (!this.renderCanvas(pageIndex, canvas, renderContext)) {
      this.canvasPool.release(pageIndex);
      this.updateVisiblePages();
      return;
    }
    this.renderHeaderFooterEditOverlays(true);
  }

  private cancelPendingTextEditRefresh(pageIndex?: number): void {
    if (typeof pageIndex === 'number') {
      this.pendingTextEditRefreshes.delete(pageIndex);
    } else {
      this.pendingTextEditRefreshes.clear();
    }
    if (this.pendingTextEditRefreshes.size > 0) return;
    if (this.textEditRefreshRafId !== null) {
      cancelAnimationFrame(this.textEditRefreshRafId);
      this.textEditRefreshRafId = null;
    }
  }

  private scheduleTextEditStaticLayerVerification(pageIndex: number): void {
    this.cancelTextEditStaticLayerVerification(pageIndex);
    const timer = setTimeout(() => {
      this.textEditStaticLayerVerifyTimers.delete(pageIndex);
      this.refreshInvalidatedPageNow(pageIndex, { reason: 'unknown', allowStaticOverlayReuse: false });
    }, TEXT_EDIT_STATIC_LAYER_VERIFY_DELAY_MS);
    this.textEditStaticLayerVerifyTimers.set(pageIndex, timer);
  }

  private cancelTextEditStaticLayerVerification(pageIndex?: number): void {
    if (typeof pageIndex === 'number') {
      const timer = this.textEditStaticLayerVerifyTimers.get(pageIndex);
      if (timer) clearTimeout(timer);
      this.textEditStaticLayerVerifyTimers.delete(pageIndex);
      return;
    }

    for (const timer of this.textEditStaticLayerVerifyTimers.values()) {
      clearTimeout(timer);
    }
    this.textEditStaticLayerVerifyTimers.clear();
  }

  /** 리소스를 정리한다 */
  private reset(): void {
    const hadActivePage = this.activePageSnapshot !== null;
    const hadFocusedPage = this.editingPageIndex !== null;
    this.cancelScheduledMutationRefresh();
    this.cancelPendingTextEditRefresh();
    this.cancelTextEditStaticLayerVerification();
    this.cancelPendingPrefetch();
    this.pageRenderer.cancelAll();
    this.releaseAllRenderedPages();
    this.currentVisiblePages = [];
    this.editingPageIndex = null;
    this.activePageSnapshot = null;
    if (hadActivePage) this.eventBus.emit('active-page-changed', null);
    if (hadFocusedPage) this.eventBus.emit('focused-page-changed', null);
    this.headerFooterEditState = null;
    this.pages = [];
    this.scrollContent.replaceChildren();
  }

  private releaseAllRenderedPages(): void {
    this.pageRenderer.resetImageRetryState();
    this.pageRenderer.removeAllPageLayers(this.scrollContent);
    this.removeHeaderFooterEditOverlays();
    this.removeAllGridOverlays();
    this.canvasPool.releaseAll();
  }

  private refreshGridOverlays(): void {
    this.removeAllGridOverlays();
    for (const pageIdx of this.canvasPool.activePages) {
      const canvas = this.canvasPool.getCanvas(pageIdx);
      if (canvas) this.renderGridOverlay(pageIdx, canvas);
    }
  }

  private renderGridOverlay(pageIdx: number, canvas: HTMLCanvasElement): void {
    this.removeGridOverlay(pageIdx);
    const settings = getGridViewSettings();
    if (!settings.visible) return;

    const pageInfo = this.pages[pageIdx];
    if (!pageInfo) return;

    const overlay = createGridOverlay(
      pageIdx,
      pageInfo,
      this.viewportManager.getZoom(),
      settings,
    );
    applyGridOverlayBox(overlay, canvas);
    this.scrollContent.appendChild(overlay);
    const elements = [overlay];

    const clipCorners = createGridClipCornerOverlay(
      pageIdx,
      pageInfo,
      this.viewportManager.getZoom(),
      settings,
    );
    if (clipCorners) {
      applyGridOverlayBox(clipCorners, canvas);
      this.scrollContent.appendChild(clipCorners);
      elements.push(clipCorners);
    }
    this.gridOverlaysByPage.set(pageIdx, elements);
  }

  private removeGridOverlay(pageIdx: number): void {
    for (const element of this.gridOverlaysByPage.get(pageIdx) ?? []) {
      element.remove();
    }
    this.gridOverlaysByPage.delete(pageIdx);
  }

  private removeAllGridOverlays(): void {
    for (const elements of this.gridOverlaysByPage.values()) {
      for (const element of elements) element.remove();
    }
    this.gridOverlaysByPage.clear();
  }

  /** 전체 정리 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subsecondRevisionWatcher.stop();
    this.rendererSelectionEpoch += 1;
    this.documentLoadPrepared = false;
    this.cancelAutoRendererReselection();
    this.reset();
    this.pageRenderer.dispose();
    this.rendererSession.dispose();
    this.viewportManager.detach();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  getVirtualScroll(): VirtualScroll {
    return this.virtualScroll;
  }

  getViewportManager(): ViewportManager {
    return this.viewportManager;
  }

  getRenderBackend(): RenderBackend {
    return this.pageRenderer.getBackend();
  }

  getRendererSessionDiagnostics(): RendererSessionDiagnostics | null {
    return this.rendererSession.diagnostics();
  }

  getCanvasKitRenderDiagnostics(pageIndex: number): CanvasKitRenderDiagnostics | null {
    return this.pageRenderer.getCanvasKitRenderDiagnostics(pageIndex);
  }

  getCurrentCanvasKitRenderDiagnostics(): CanvasKitRenderDiagnostics | null {
    return this.pageRenderer.getCurrentCanvasKitRenderDiagnostics();
  }

  getCoordinateSystem(): CoordinateSystem {
    return this.coordinateSystem;
  }
}
