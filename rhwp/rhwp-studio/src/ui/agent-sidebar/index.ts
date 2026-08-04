/**
 * AI 에이전트 사이드바 (ag- 접두어).
 *
 * AgentBridge 의 SidebarEvent 스트림을 렌더링하고, 대기 중인 에이전트
 * 편집(change-set)의 승인/거절 UI 를 제공한다. 패널은 body 에 고정
 * 마운트하되, 펼침 시 body.ag-sidebar-open 으로 #editor-area 를 밀어
 * 눈금자·용지가 가려지지 않고 남은 폭 기준으로 다시 가운데 정렬되게 한다.
 */
import './agent-sidebar.css';

import type { EventBus } from '../../core/event-bus.ts';
import type { AgentBridge } from '../../agent/bridge.ts';
import type {
  AgentName,
  AgentStreamEvent,
  PendingChangeSet,
  PendingEditsChangeEvent,
  PendingOp,
  SidebarEvent,
} from '../../agent/types.ts';
import {
  defaultModelForAgent,
  effortsForAgent,
  labelForEffort,
  labelForModel,
  modelsForAgent,
  resolveEffortForAgent,
  resolveModelForAgent,
} from '../../agent/models.ts';
import {
  createEmptyThread,
  fallbackTitle,
  getThread,
  listThreads,
  setThreadTitle,
  upsertThread,
  type ChatThread,
} from '../../agent/threads.ts';
import { createChevron, createColumnIcon } from '../chevron.ts';

export interface AgentSidebarDeps {
  bridge: AgentBridge;
  /** inset 전환 후 용지 가운데 정렬을 요청할 때 사용 */
  eventBus?: EventBus;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';

const AGENT_LABEL: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex' };

const PROVIDER_ICON_SRC: Record<AgentName, string> = {
  claude: '/icons/provider-claude.png',
  codex: '/icons/provider-codex.png',
};

const SIDEBAR_WIDTH_KEY = 'rhwp-agent-sidebar-width';
const SIDEBAR_WIDTH_DEFAULT = 360;
const SIDEBAR_WIDTH_MIN = 280;

function maxSidebarWidth(viewportWidth = window.innerWidth): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.floor(viewportWidth * 0.5));
}

function clampSidebarWidth(width: number, viewportWidth = window.innerWidth): number {
  return Math.min(maxSidebarWidth(viewportWidth), Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

function readStoredSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!raw) return SIDEBAR_WIDTH_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? clampSidebarWidth(n) : SIDEBAR_WIDTH_DEFAULT;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function persistSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    /* ignore quota / private mode */
  }
}

function createProviderIcon(agent: AgentName): HTMLElement {
  if (agent === 'codex') {
    // 단색 로고 — currentColor 마스크로 라이트/다크에 맞춤
    const mark = el('span', 'ag-provider-icon ag-provider-icon-mask');
    mark.dataset.agent = agent;
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
  const img = document.createElement('img');
  img.className = 'ag-provider-icon';
  img.dataset.agent = agent;
  img.src = PROVIDER_ICON_SRC[agent];
  img.alt = '';
  img.draggable = false;
  img.setAttribute('aria-hidden', 'true');
  return img;
}

const CONN_LABEL: Record<ConnectionState, string> = {
  connected: '연결됨',
  connecting: '연결 중…',
  disconnected: '연결 끊김',
  replaced: '다른 탭에서 사용 중',
};

/** 리뷰 카드에 개별 표시할 최대 op 수 (초과분은 "외 N건"으로 축약). */
const MAX_REVIEW_OP_LINES = 6;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function opGlyph(op: PendingOp): string {
  switch (op.kind) {
    case 'insert': return '+';
    case 'delete': return '−';
    case 'format': return '✎';
    case 'field': return '⚑';
    case 'object': return '▣';
  }
}

const OBJECT_OP_LABELS: Record<string, string> = {
  createTable: '표 만들기',
  insertImage: '그림 삽입',
  insertEquation: '수식 삽입',
  tableStructure: '표 구조 변경',
  tableStructureMarked: '표 구조 변경(승인 시 적용)',
  setCellProps: '셀 속성(승인 시 적용)',
  setTableProps: '표 속성(승인 시 적용)',
  paraFormat: '문단 서식',
  applyStyle: '스타일 적용(승인 시 적용)',
  pageLayout: '쪽 설정',
  headerFooter: '머리말/꼬리말',
};

function opPreview(op: PendingOp): string {
  switch (op.kind) {
    case 'insert':
    case 'delete':
      return op.text.replace(/\n/g, '⏎');
    case 'format':
      return JSON.stringify(op.format);
    case 'field':
      return `${op.name} → ${op.newValue}`;
    case 'object': {
      const label = OBJECT_OP_LABELS[op.obj.type] ?? op.obj.type;
      if (op.obj.type === 'createTable') return `${label} ${op.obj.rows}×${op.obj.cols}`;
      if (op.obj.type === 'insertEquation') return `${label} ${op.obj.script.slice(0, 40)}`;
      if (op.obj.type === 'tableStructure' || op.obj.type === 'tableStructureMarked') {
        return `${label}: ${op.obj.op}`;
      }
      return label;
    }
  }
}

export function initAgentSidebar(deps: AgentSidebarDeps): { root: HTMLElement; dispose(): void } {
  const { bridge, eventBus } = deps;

  let selectedAgent: AgentName = bridge.getActiveAgent() ?? 'claude';
  let selectedModel = defaultModelForAgent(selectedAgent);
  let selectedEffort = resolveEffortForAgent(selectedAgent, null, selectedModel);
  let connState: ConnectionState = bridge.getConnectionState();
  let turnRunning = bridge.isTurnRunning();
  /** 현재 스트리밍 중인 assistant 텍스트 (tool-call 이후에는 새로 연다). */
  let streamBubble: HTMLElement | null = null;
  const toolRows = new Map<
    string,
    { status: HTMLElement; result: HTMLPreElement; scroller: HTMLElement }
  >();
  let turnActivity: {
    root: HTMLElement;
    toggle: HTMLButtonElement;
    label: HTMLElement;
    content: HTMLElement;
    startedAt: number;
    toolCount: number;
    failedToolCount: number;
  } | null = null;
  let followConversation = true;
  let conversationScrollRaf: number | null = null;
  let insetRecenterRaf: number | null = null;
  let currentThread = createEmptyThread({
    agent: selectedAgent,
    model: selectedModel,
    effort: selectedEffort,
  });
  let assistantBuffer = '';
  let threadsPanelOpen = false;

  // ── DOM 구성 ──────────────────────────────────────────
  const root = document.createElement('aside');
  root.id = 'agent-sidebar';
  root.className = 'ag-root';
  root.dataset.agent = selectedAgent;

  const collapseTab = el('button', 'ag-collapse-tab');
  collapseTab.type = 'button';
  collapseTab.setAttribute('aria-label', '에이전트 사이드바 접기/펼치기');
  collapseTab.setAttribute('aria-expanded', 'true');
  collapseTab.appendChild(createChevron());

  const resizeHandle = el('div', 'ag-resize-handle');
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-label', '사이드바 너비 조절');
  resizeHandle.setAttribute('aria-orientation', 'vertical');
  resizeHandle.title = '드래그하여 너비 조절';
  resizeHandle.tabIndex = 0;

  let sidebarWidth = readStoredSidebarWidth();

  function applySidebarWidth(width: number, opts?: { persist?: boolean; recenter?: boolean }): number {
    sidebarWidth = clampSidebarWidth(width);
    document.documentElement.style.setProperty('--ag-sidebar-width', `${sidebarWidth}px`);
    resizeHandle.setAttribute('aria-valuenow', String(sidebarWidth));
    resizeHandle.setAttribute('aria-valuemin', String(SIDEBAR_WIDTH_MIN));
    resizeHandle.setAttribute('aria-valuemax', String(maxSidebarWidth()));
    if (opts?.persist) persistSidebarWidth(sidebarWidth);
    if (opts?.recenter !== false) notifyInsetChanged();
    return sidebarWidth;
  }

  function notifyInsetChanged(): void {
    eventBus?.emit('viewport-inset-changed');
  }

  function clearInsetRecenterLoop(): void {
    if (insetRecenterRaf !== null) {
      cancelAnimationFrame(insetRecenterRaf);
      insetRecenterRaf = null;
    }
    document.body.classList.remove('ag-sidebar-animating');
  }

  /** inset 애니메이션 동안 매 프레임 용지 좌표·스크롤을 다시 맞춘다. */
  function startInsetRecenterLoop(): void {
    if (!eventBus) return;
    clearInsetRecenterLoop();
    document.body.classList.add('ag-sidebar-animating');

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      notifyInsetChanged();
      document.body.classList.remove('ag-sidebar-animating');
      return;
    }

    const startedAt = performance.now();
    const durationMs = 280;
    const tick = (now: number) => {
      notifyInsetChanged();
      if (now - startedAt < durationMs) {
        insetRecenterRaf = requestAnimationFrame(tick);
        return;
      }
      insetRecenterRaf = null;
      document.body.classList.remove('ag-sidebar-animating');
      notifyInsetChanged();
    };
    insetRecenterRaf = requestAnimationFrame(tick);
  }

  function setCollapsed(collapsed: boolean, opts?: { recenter?: boolean }): void {
    root.classList.toggle('ag-collapsed', collapsed);
    document.body.classList.toggle('ag-sidebar-open', !collapsed);
    collapseTab.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (opts?.recenter !== false) startInsetRecenterLoop();
  }

  applySidebarWidth(sidebarWidth, { persist: false, recenter: false });

  const RESIZE_DRAG_THRESHOLD_PX = 4;
  let resizing = false;
  let resizeArmed = false;
  let resizeFromCollapseTab = false;
  let resizeStartX = 0;
  let resizeStartWidth = sidebarWidth;
  let resizeWasCollapsed = false;

  function detachResizeWindowListeners(): void {
    window.removeEventListener('pointermove', onResizePointerMove, true);
    window.removeEventListener('pointerup', endSidebarResize, true);
    window.removeEventListener('pointercancel', endSidebarResize, true);
  }

  function beginSidebarResize(startX: number): void {
    resizing = true;
    resizeArmed = false;
    resizeStartX = startX;
    resizeStartWidth = sidebarWidth;
    resizeWasCollapsed = root.classList.contains('ag-collapsed');
    if (resizeWasCollapsed) {
      // 접힌 상태에서 드래그하면 먼저 펼친 뒤 폭을 조절한다.
      setCollapsed(false, { recenter: false });
    }
    setProviderMenuOpen(false);
    setLlmMenuOpen(false);
    setEffortMenuOpen(false);
    document.body.classList.add('ag-sidebar-resizing', 'ag-sidebar-animating');
    window.addEventListener('pointermove', onResizePointerMove, true);
    window.addEventListener('pointerup', endSidebarResize, true);
    window.addEventListener('pointercancel', endSidebarResize, true);
  }

  function onResizePointerMove(e: PointerEvent): void {
    if (!resizing) return;
    e.preventDefault();
    const dx = resizeStartX - e.clientX;
    if (!resizeArmed) {
      if (Math.abs(e.clientX - resizeStartX) < RESIZE_DRAG_THRESHOLD_PX) return;
      resizeArmed = true;
    }
    // 왼쪽 가장자리를 왼쪽으로 끌면 폭이 커진다.
    applySidebarWidth(resizeStartWidth + dx, { persist: false, recenter: true });
  }

  function endSidebarResize(): void {
    if (!resizing) return;
    const didDrag = resizeArmed;
    const fromTab = resizeFromCollapseTab;
    resizing = false;
    resizeArmed = false;
    resizeFromCollapseTab = false;
    document.body.classList.remove('ag-sidebar-resizing', 'ag-sidebar-animating');
    detachResizeWindowListeners();
    if (didDrag) {
      applySidebarWidth(sidebarWidth, { persist: true, recenter: true });
      return;
    }
    // 접기 탭에서 클릭만 한 경우(드래그 없음) → 접기/펼치기
    if (fromTab) {
      if (resizeWasCollapsed) {
        // begin 에서 이미 펼쳤으므로 그대로 두고 가운데 정렬만.
        startInsetRecenterLoop();
      } else {
        setCollapsed(true);
      }
      return;
    }
    applySidebarWidth(sidebarWidth, { persist: true, recenter: true });
  }

  function onResizeHandlePointerDown(e: PointerEvent): void {
    if (root.classList.contains('ag-collapsed')) return;
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    resizeFromCollapseTab = false;
    beginSidebarResize(e.clientX);
    resizeArmed = true;
  }

  function onCollapseTabPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    resizeFromCollapseTab = true;
    beginSidebarResize(e.clientX);
  }

  // click 은 pointer 로 처리하므로 기본 click 토글은 막는다.
  collapseTab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  collapseTab.addEventListener('pointerdown', onCollapseTabPointerDown);
  collapseTab.style.cursor = 'col-resize';
  collapseTab.title = '드래그하여 너비 조절 · 클릭하여 접기/펼치기';

  resizeHandle.addEventListener('pointerdown', onResizeHandlePointerDown);
  resizeHandle.addEventListener('keydown', (e) => {
    if (root.classList.contains('ag-collapsed')) return;
    const step = e.shiftKey ? 32 : 16;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      applySidebarWidth(sidebarWidth + step, { persist: true, recenter: true });
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      applySidebarWidth(sidebarWidth - step, { persist: true, recenter: true });
    } else if (e.key === 'Home') {
      e.preventDefault();
      applySidebarWidth(SIDEBAR_WIDTH_MIN, { persist: true, recenter: true });
    } else if (e.key === 'End') {
      e.preventDefault();
      applySidebarWidth(maxSidebarWidth(), { persist: true, recenter: true });
    }
  });

  const agentOrder = ['claude', 'codex'] as const;

  const header = el('header', 'ag-header');
  const selectors = el('div', 'ag-selectors');

  // ── 프로바이더 피커 (Claude / Codex) ─────────────────
  const providerWrap = el('div', 'ag-model ag-provider');
  const providerTrigger = el('button', 'ag-model-trigger');
  providerTrigger.type = 'button';
  providerTrigger.setAttribute('aria-haspopup', 'menu');
  providerTrigger.setAttribute('aria-expanded', 'false');
  providerTrigger.setAttribute('aria-label', '프로바이더 선택');
  let providerIcon = createProviderIcon(selectedAgent);
  const providerName = el('span', 'ag-model-name', AGENT_LABEL[selectedAgent]);
  const providerCaret = createChevron('ag-model-caret');
  providerTrigger.append(providerIcon, providerName, providerCaret);

  const providerMenu = el('div', 'ag-model-menu');
  providerMenu.setAttribute('role', 'menu');
  providerMenu.setAttribute('aria-hidden', 'true');
  const providerItems = new Map<AgentName, HTMLButtonElement>();

  function closeAllMenus(): void {
    setProviderMenuOpen(false);
    setLlmMenuOpen(false);
    setEffortMenuOpen(false);
  }

  function setProviderMenuOpen(open: boolean): void {
    providerTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    providerMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
    providerWrap.classList.toggle('ag-model-open', open);
  }

  function selectAgent(agent: AgentName): void {
    if (turnRunning) return;
    closeAllMenus();
    setSelectedAgent(agent);
    selectedModel = resolveModelForAgent(agent, selectedModel);
    selectedEffort = resolveEffortForAgent(agent, selectedEffort, selectedModel);
    rebuildLlmMenu();
    rebuildEffortMenu();
    bridge.startChat(agent, selectedModel, selectedEffort);
    providerTrigger.focus();
  }

  for (const agent of agentOrder) {
    const item = el('button', 'ag-model-item ag-provider-item');
    item.type = 'button';
    item.dataset.agent = agent;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', 'false');
    item.append(createProviderIcon(agent), document.createTextNode(AGENT_LABEL[agent]));
    item.addEventListener('click', () => selectAgent(agent));
    providerItems.set(agent, item);
    providerMenu.appendChild(item);
  }

  providerTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (turnRunning) return;
    const next = !providerWrap.classList.contains('ag-model-open');
    setLlmMenuOpen(false);
    setEffortMenuOpen(false);
    setProviderMenuOpen(next);
  });
  providerTrigger.addEventListener('keydown', (e) => {
    if (turnRunning) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setLlmMenuOpen(false);
      setEffortMenuOpen(false);
      setProviderMenuOpen(true);
      providerItems.get(selectedAgent)?.focus();
    } else if (e.key === 'Escape') {
      setProviderMenuOpen(false);
    }
  });
  providerMenu.addEventListener('keydown', (e) => {
    const items = agentOrder.map((name) => providerItems.get(name)!);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setProviderMenuOpen(false);
      providerTrigger.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(Math.max(current, 0) + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(Math.max(current, 0) - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  });

  providerWrap.append(providerTrigger, providerMenu);

  // ── 모델 피커 (프로바이더에 따라 옵션 교체) ──────────
  const llmWrap = el('div', 'ag-model ag-llm');
  const llmTrigger = el('button', 'ag-model-trigger ag-llm-trigger');
  llmTrigger.type = 'button';
  llmTrigger.setAttribute('aria-haspopup', 'menu');
  llmTrigger.setAttribute('aria-expanded', 'false');
  llmTrigger.setAttribute('aria-label', '모델 선택');
  const llmName = el('span', 'ag-llm-name', labelForModel(selectedAgent, selectedModel));
  const llmCaret = createChevron('ag-model-caret');
  llmTrigger.append(llmName, llmCaret);

  const llmMenu = el('div', 'ag-model-menu ag-llm-menu');
  llmMenu.setAttribute('role', 'menu');
  llmMenu.setAttribute('aria-hidden', 'true');
  let llmItems = new Map<string, HTMLButtonElement>();

  function setLlmMenuOpen(open: boolean): void {
    llmTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    llmMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
    llmWrap.classList.toggle('ag-model-open', open);
  }

  function selectModel(modelId: string): void {
    if (turnRunning) return;
    setLlmMenuOpen(false);
    selectedModel = resolveModelForAgent(selectedAgent, modelId);
    selectedEffort = resolveEffortForAgent(selectedAgent, selectedEffort, selectedModel);
    llmName.textContent = labelForModel(selectedAgent, selectedModel);
    for (const [id, item] of llmItems) {
      const active = id === selectedModel;
      item.classList.toggle('ag-active', active);
      item.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    rebuildEffortMenu();
    bridge.startChat(selectedAgent, selectedModel, selectedEffort);
    llmTrigger.focus();
  }

  function rebuildLlmMenu(): void {
    llmMenu.replaceChildren();
    llmItems = new Map();
    for (const opt of modelsForAgent(selectedAgent)) {
      const item = el('button', 'ag-model-item ag-llm-item', opt.label);
      item.type = 'button';
      item.dataset.model = opt.id;
      item.setAttribute('role', 'menuitemradio');
      const active = opt.id === selectedModel;
      item.setAttribute('aria-checked', active ? 'true' : 'false');
      item.classList.toggle('ag-active', active);
      item.addEventListener('click', () => selectModel(opt.id));
      llmItems.set(opt.id, item);
      llmMenu.appendChild(item);
    }
    llmName.textContent = labelForModel(selectedAgent, selectedModel);
  }

  llmTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (turnRunning) return;
    const next = !llmWrap.classList.contains('ag-model-open');
    setProviderMenuOpen(false);
    setEffortMenuOpen(false);
    setLlmMenuOpen(next);
  });
  llmTrigger.addEventListener('keydown', (e) => {
    if (turnRunning) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setProviderMenuOpen(false);
      setEffortMenuOpen(false);
      setLlmMenuOpen(true);
      llmItems.get(selectedModel)?.focus();
    } else if (e.key === 'Escape') {
      setLlmMenuOpen(false);
    }
  });
  llmMenu.addEventListener('keydown', (e) => {
    const ids = [...llmItems.keys()];
    const items = ids.map((id) => llmItems.get(id)!);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setLlmMenuOpen(false);
      llmTrigger.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(Math.max(current, 0) + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(Math.max(current, 0) - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  });

  rebuildLlmMenu();
  llmWrap.append(llmTrigger, llmMenu);

  // ── Effort 피커 (프로바이더/모델이 지원하는 수준) ────
  const effortWrap = el('div', 'ag-model ag-effort');
  const effortTrigger = el('button', 'ag-model-trigger ag-effort-trigger');
  effortTrigger.type = 'button';
  effortTrigger.setAttribute('aria-haspopup', 'menu');
  effortTrigger.setAttribute('aria-expanded', 'false');
  effortTrigger.setAttribute('aria-label', '추론 강도 선택');
  const effortName = el(
    'span',
    'ag-effort-name',
    labelForEffort(selectedAgent, selectedEffort, selectedModel),
  );
  const effortCaret = createChevron('ag-model-caret');
  effortTrigger.append(effortName, effortCaret);

  const effortMenu = el('div', 'ag-model-menu ag-effort-menu');
  effortMenu.setAttribute('role', 'menu');
  effortMenu.setAttribute('aria-hidden', 'true');
  let effortItems = new Map<string, HTMLButtonElement>();

  function setEffortMenuOpen(open: boolean): void {
    effortTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    effortMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
    effortWrap.classList.toggle('ag-model-open', open);
  }

  function selectEffort(effortId: string): void {
    if (turnRunning) return;
    setEffortMenuOpen(false);
    selectedEffort = resolveEffortForAgent(selectedAgent, effortId, selectedModel);
    effortName.textContent = labelForEffort(selectedAgent, selectedEffort, selectedModel);
    for (const [id, item] of effortItems) {
      const active = id === selectedEffort;
      item.classList.toggle('ag-active', active);
      item.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    bridge.startChat(selectedAgent, selectedModel, selectedEffort);
    effortTrigger.focus();
  }

  function rebuildEffortMenu(): void {
    effortMenu.replaceChildren();
    effortItems = new Map();
    for (const opt of effortsForAgent(selectedAgent, selectedModel)) {
      const item = el('button', 'ag-model-item ag-effort-item', opt.label);
      item.type = 'button';
      item.dataset.effort = opt.id;
      item.setAttribute('role', 'menuitemradio');
      const active = opt.id === selectedEffort;
      item.setAttribute('aria-checked', active ? 'true' : 'false');
      item.classList.toggle('ag-active', active);
      item.addEventListener('click', () => selectEffort(opt.id));
      effortItems.set(opt.id, item);
      effortMenu.appendChild(item);
    }
    effortName.textContent = labelForEffort(selectedAgent, selectedEffort, selectedModel);
  }

  effortTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (turnRunning) return;
    const next = !effortWrap.classList.contains('ag-model-open');
    setProviderMenuOpen(false);
    setLlmMenuOpen(false);
    setEffortMenuOpen(next);
  });
  effortTrigger.addEventListener('keydown', (e) => {
    if (turnRunning) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setProviderMenuOpen(false);
      setLlmMenuOpen(false);
      setEffortMenuOpen(true);
      effortItems.get(selectedEffort)?.focus();
    } else if (e.key === 'Escape') {
      setEffortMenuOpen(false);
    }
  });
  effortMenu.addEventListener('keydown', (e) => {
    const ids = [...effortItems.keys()];
    const items = ids.map((id) => effortItems.get(id)!);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setEffortMenuOpen(false);
      effortTrigger.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(Math.max(current, 0) + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(Math.max(current, 0) - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  });

  rebuildEffortMenu();
  effortWrap.append(effortTrigger, effortMenu);

  const onDocPointerDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!providerWrap.contains(t)) setProviderMenuOpen(false);
    if (!llmWrap.contains(t)) setLlmMenuOpen(false);
    if (!effortWrap.contains(t)) setEffortMenuOpen(false);
  };
  document.addEventListener('pointerdown', onDocPointerDown);

  const threadsBtn = el('button', 'ag-threads-btn');
  threadsBtn.type = 'button';
  threadsBtn.setAttribute('aria-label', '채팅 목록');
  threadsBtn.setAttribute('aria-expanded', 'false');
  threadsBtn.setAttribute('aria-controls', 'ag-threads-panel');
  threadsBtn.title = '채팅 목록';
  threadsBtn.appendChild(createColumnIcon());

  const conn = el('span', 'ag-conn');
  selectors.append(providerWrap, llmWrap, effortWrap, threadsBtn);
  header.append(selectors, conn);

  const stage = el('div', 'ag-stage');

  const chatPage = el('div', 'ag-chat-page');
  chatPage.setAttribute('aria-hidden', 'false');
  const messages = el('div', 'ag-messages');
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-live', 'polite');
  const onMessagesScroll = (): void => {
    followConversation = isConversationNearBottom();
  };
  messages.addEventListener('scroll', onMessagesScroll, { passive: true });
  const messagesMutationObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(() => {
        if (followConversation) scrollConversationToEnd();
      })
    : null;
  messagesMutationObserver?.observe(messages, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  const review = el('div', 'ag-review');
  const composer = el('form', 'ag-composer');
  const input = el('textarea', 'ag-input');
  input.placeholder = '딸깍해보자..';
  input.rows = 1;
  input.setAttribute('aria-label', '에이전트 메시지 입력');
  const send = el('button', 'ag-send', '보내기');
  send.type = 'submit';
  composer.append(input, send);
  // 헤더(모델 피커)까지 채팅 페이지에 포함해 목록 전환 시 함께 사라지게 한다.
  chatPage.append(header, messages, review, composer);

  const threadsPage = el('div', 'ag-threads-page');
  threadsPage.id = 'ag-threads-panel';
  threadsPage.setAttribute('role', 'region');
  threadsPage.setAttribute('aria-label', '채팅 목록');
  threadsPage.setAttribute('aria-hidden', 'true');
  const threadsHeader = el('div', 'ag-threads-header');
  const threadsTitle = el('span', 'ag-threads-title', '채팅');
  const threadsClose = el('button', 'ag-threads-btn ag-threads-close');
  threadsClose.type = 'button';
  threadsClose.setAttribute('aria-label', '채팅으로 돌아가기');
  threadsClose.title = '채팅으로 돌아가기';
  threadsClose.appendChild(createColumnIcon());
  threadsHeader.append(threadsTitle, threadsClose);
  const threadsNew = el('button', 'ag-threads-new', '새 채팅');
  threadsNew.type = 'button';
  const threadsList = el('ul', 'ag-threads-list');
  threadsPage.append(threadsHeader, threadsNew, threadsList);

  stage.append(chatPage, threadsPage);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (turnRunning) {
      bridge.interrupt();
      return;
    }
    const text = input.value.trim();
    if (!text || connState !== 'connected') return;
    if (threadsPanelOpen) setThreadsPanelOpen(false);
    recordUserMessage(text);
    followConversation = true;
    withAutoScroll(() => messages.appendChild(el('div', 'ag-msg ag-msg-user', text)));
    bridge.sendUserMessage(text);
    input.value = '';
    input.style.height = 'auto';
  });

  // resizeHandle 을 마지막에 두어 왼쪽 가장자리 히트 테스트를 확실히 가져간다.
  root.append(collapseTab, stage, resizeHandle);
  document.body.appendChild(root);
  setCollapsed(false, { recenter: false });

  // ── 배치: #editor-area ↔ #status-bar 사이에 맞춘다 ────
  function measure(): void {
    const top = document.getElementById('editor-area')?.getBoundingClientRect().top ?? 96;
    const statusTop =
      document.getElementById('status-bar')?.getBoundingClientRect().top ?? window.innerHeight;
    root.style.top = `${Math.max(0, top)}px`;
    root.style.bottom = `${Math.max(0, window.innerHeight - statusTop)}px`;
    // 창이 줄면 최대 50% 제한에 맞춰 폭을 다시 클램프한다.
    const clamped = clampSidebarWidth(sidebarWidth);
    if (clamped !== sidebarWidth) {
      applySidebarWidth(clamped, { persist: true, recenter: true });
    }
  }
  window.addEventListener('resize', measure);
  measure();

  // ── 스레드(채팅 목록) ─────────────────────────────────
  function persistCurrentThread(): void {
    currentThread.agent = selectedAgent;
    currentThread.model = selectedModel;
    currentThread.effort = selectedEffort;
    if (currentThread.messages.length === 0) return;
    if (!currentThread.title || currentThread.title === '새 채팅') {
      currentThread.title = fallbackTitle(currentThread.messages);
    }
    upsertThread(currentThread);
  }

  function recordUserMessage(text: string): void {
    currentThread.messages.push({ role: 'user', text });
    currentThread.updatedAt = Date.now();
    persistCurrentThread();
    maybeRequestTitle();
  }

  function flushAssistantBuffer(opts?: { persist?: boolean }): void {
    const text = assistantBuffer.trim();
    assistantBuffer = '';
    if (!text) return;
    if (opts?.persist === false) return;
    currentThread.messages.push({
      role: 'assistant',
      text,
      agent: selectedAgent,
    });
    persistCurrentThread();
    maybeRequestTitle();
  }

  function maybeRequestTitle(): void {
    if (currentThread.titleRequested) return;
    if (!currentThread.messages.some((m) => m.role === 'user')) return;
    currentThread.titleRequested = true;
    persistCurrentThread();
    const preview = currentThread.messages
      .slice(0, 6)
      .map((m) => `${m.role === 'user' ? '사용자' : '어시스턴트'}: ${m.text}`)
      .join('\n')
      .slice(0, 800);
    bridge.requestTitle(currentThread.id, preview);
  }

  function renderMessagesFromThread(thread: ChatThread): void {
    messages.replaceChildren();
    streamBubble = null;
    turnActivity = null;
    followConversation = true;
    assistantBuffer = '';
    toolRows.clear();
    for (const msg of thread.messages) {
      if (msg.role === 'user') {
        messages.appendChild(el('div', 'ag-msg ag-msg-user', msg.text));
      } else if (msg.role === 'assistant') {
        const agent = msg.agent ?? thread.agent;
        messages.appendChild(el('div', `ag-msg ag-msg-assistant ag-${agent}`, msg.text));
      } else {
        messages.appendChild(el('div', 'ag-msg ag-msg-system', msg.text));
      }
    }
    messages.scrollTop = messages.scrollHeight;
  }

  function clearChatUi(): void {
    messages.replaceChildren();
    streamBubble = null;
    turnActivity = null;
    followConversation = true;
    assistantBuffer = '';
    sweepUnresolvedToolRows();
  }

  function applyThreadMeta(thread: ChatThread): void {
    selectedModel = resolveModelForAgent(thread.agent, thread.model);
    selectedEffort = resolveEffortForAgent(thread.agent, thread.effort, selectedModel);
    setSelectedAgent(thread.agent);
    rebuildLlmMenu();
    rebuildEffortMenu();
  }

  function formatThreadMeta(thread: ChatThread): string {
    const when = new Date(thread.updatedAt);
    const hh = String(when.getHours()).padStart(2, '0');
    const mm = String(when.getMinutes()).padStart(2, '0');
    const day = `${when.getMonth() + 1}/${when.getDate()}`;
    return `${AGENT_LABEL[thread.agent]} · ${day} ${hh}:${mm}`;
  }

  function rebuildThreadsList(): void {
    threadsList.replaceChildren();
    const items = listThreads();
    if (items.length === 0) {
      const empty = el('li', 'ag-threads-empty', '이전 채팅이 없습니다');
      threadsList.appendChild(empty);
      return;
    }
    for (const thread of items) {
      const li = document.createElement('li');
      const btn = el('button', 'ag-threads-item');
      btn.type = 'button';
      if (thread.id === currentThread.id) btn.classList.add('ag-active');
      btn.appendChild(el('span', 'ag-threads-item-title', thread.title || '새 채팅'));
      btn.appendChild(el('span', 'ag-threads-item-meta', formatThreadMeta(thread)));
      btn.addEventListener('click', () => openThread(thread.id));
      li.appendChild(btn);
      threadsList.appendChild(li);
    }
  }

  function setThreadsPanelOpen(open: boolean): void {
    threadsPanelOpen = open;
    root.classList.toggle('ag-threads-open', open);
    threadsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    threadsPage.setAttribute('aria-hidden', open ? 'false' : 'true');
    chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
    if (open) {
      closeAllMenus();
      rebuildThreadsList();
      threadsNew.focus();
    }
  }

  function startNewChat(): void {
    if (turnRunning) bridge.interrupt();
    flushAssistantBuffer();
    persistCurrentThread();
    clearChatUi();
    currentThread = createEmptyThread({
      agent: selectedAgent,
      model: selectedModel,
      effort: selectedEffort,
    });
    bridge.stopChat();
    bridge.startChat(selectedAgent, selectedModel, selectedEffort, true);
    setThreadsPanelOpen(false);
    input.focus();
  }

  function openThread(id: string): void {
    if (id === currentThread.id) {
      setThreadsPanelOpen(false);
      return;
    }
    if (turnRunning) bridge.interrupt();
    flushAssistantBuffer();
    persistCurrentThread();
    const loaded = getThread(id);
    if (!loaded) return;
    currentThread = {
      ...loaded,
      messages: loaded.messages.map((m) => ({ ...m })),
      titleRequested: Boolean(loaded.titleRequested),
    };
    applyThreadMeta(currentThread);
    renderMessagesFromThread(currentThread);
    bridge.stopChat();
    bridge.startChat(selectedAgent, selectedModel, selectedEffort, true);
    setThreadsPanelOpen(false);
    input.focus();
  }

  threadsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setThreadsPanelOpen(true);
  });
  threadsClose.addEventListener('click', (e) => {
    e.stopPropagation();
    setThreadsPanelOpen(false);
    threadsBtn.focus();
  });
  threadsNew.addEventListener('click', () => startNewChat());
  threadsPage.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setThreadsPanelOpen(false);
      threadsBtn.focus();
    }
  });

  // ── 상태 반영 헬퍼 ────────────────────────────────────
  function setSelectedAgent(agent: AgentName): void {
    selectedAgent = agent;
    root.dataset.agent = agent;
    providerName.textContent = AGENT_LABEL[agent];
    const nextIcon = createProviderIcon(agent);
    providerIcon.replaceWith(nextIcon);
    providerIcon = nextIcon;
    for (const [name, item] of providerItems) {
      const active = name === agent;
      item.classList.toggle('ag-active', active);
      item.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  }

  function setConnection(state: ConnectionState): void {
    connState = state;
    conn.className = `ag-conn ag-conn-${state}`;
    conn.textContent = CONN_LABEL[state];
    updateComposer();
  }

  function setTurnRunning(running: boolean): void {
    turnRunning = running;
    updateComposer();
  }

  function updateComposer(): void {
    input.disabled = connState !== 'connected';
    send.disabled = connState !== 'connected';
    send.textContent = turnRunning ? '중지' : '보내기';
    send.classList.toggle('ag-stop', turnRunning);
    providerTrigger.disabled = turnRunning;
    llmTrigger.disabled = turnRunning;
    effortTrigger.disabled = turnRunning;
    if (turnRunning) closeAllMenus();
  }

  function isConversationNearBottom(): boolean {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 56;
  }

  function scrollConversationToEnd(): void {
    followConversation = true;
    if (conversationScrollRaf !== null) return;
    conversationScrollRaf = window.requestAnimationFrame(() => {
      conversationScrollRaf = null;
      messages.scrollTop = messages.scrollHeight;
    });
  }

  /** 새 출력은 따라가되, 사용자가 위로 스크롤하면 현재 위치를 존중한다. */
  function withAutoScroll(mutate: () => void): void {
    const shouldFollow = followConversation || isConversationNearBottom();
    mutate();
    if (shouldFollow) scrollConversationToEnd();
  }

  /** 실행 중인 도구 내역은 높이를 늘리지 않고 항상 최신 단계를 보여준다. */
  function scrollActivityToLatest(content: HTMLElement): void {
    window.requestAnimationFrame(() => {
      content.scrollTop = content.scrollHeight;
    });
  }

  function systemMessage(text: string): void {
    withAutoScroll(() => messages.appendChild(el('div', 'ag-msg ag-msg-system', text)));
  }

  function openAssistantBubble(agent: AgentName): HTMLElement {
    const bubble = el('div', `ag-msg ag-msg-assistant ag-${agent}`);
    withAutoScroll(() => messages.appendChild(bubble));
    streamBubble = bubble;
    return bubble;
  }

  function animateActivityLabel(
    activity: NonNullable<typeof turnActivity>,
    text: string,
  ): void {
    if (activity.label.textContent === text) return;
    activity.label.textContent = text;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const animation of activity.label.getAnimations()) animation.cancel();
    activity.label.animate(
      [
        { opacity: 0.35, transform: 'translateY(3px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      {
        duration: 200,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    );
  }

  function formatActivityDuration(startedAt: number): string {
    const totalSeconds = Math.max(1, Math.round((performance.now() - startedAt) / 1000));
    if (totalSeconds < 60) return `${totalSeconds}초`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
  }

  function ensureTurnActivity(
    agent: AgentName,
    anchor?: HTMLElement | null,
  ): NonNullable<typeof turnActivity> {
    if (turnActivity) return turnActivity;

    const activity = el('div', `ag-activity ag-${agent} ag-activity-running`);
    const toggle = el('button', 'ag-activity-toggle') as HTMLButtonElement;
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    const label = el('span', 'ag-activity-label', '작업 중…');
    const chevron = createChevron('ag-activity-chevron');
    toggle.append(label, chevron);

    const collapse = el('div', 'ag-activity-collapse');
    const content = el('div', 'ag-activity-content');
    content.tabIndex = 0;
    content.setAttribute('aria-label', '실시간 도구 실행 내역');
    collapse.appendChild(content);
    activity.append(toggle, collapse);

    toggle.addEventListener('click', () => {
      const collapsed = activity.classList.toggle('ag-activity-collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      content.tabIndex = collapsed ? -1 : 0;
      if (!collapsed) {
        scrollActivityToLatest(content);
        if (followConversation) scrollConversationToEnd();
      }
    });

    if (anchor?.parentElement === messages) {
      messages.insertBefore(activity, anchor);
    } else {
      withAutoScroll(() => messages.appendChild(activity));
    }

    turnActivity = {
      root: activity,
      toggle,
      label,
      content,
      startedAt: performance.now(),
      toolCount: 0,
      failedToolCount: 0,
    };
    return turnActivity;
  }

  /** 도구 호출 앞의 진행 설명을 activity 안으로 옮겨 최종 답변과 분리한다. */
  function compactStreamIntoActivity(agent: AgentName): void {
    const bubble = streamBubble;
    if (!bubble) return;
    if (!(bubble.textContent ?? '').trim()) {
      bubble.remove();
      streamBubble = null;
      return;
    }
    const activity = ensureTurnActivity(agent, bubble);
    bubble.className = 'ag-activity-note';
    withAutoScroll(() => activity.content.appendChild(bubble));
    scrollActivityToLatest(activity.content);
    streamBubble = null;
  }

  function completeTurnActivity(): void {
    const activity = turnActivity;
    if (!activity) return;
    const count = activity.toolCount;
    const duration = formatActivityDuration(activity.startedAt);
    if (activity.failedToolCount > 0) {
      animateActivityLabel(
        activity,
        `작업 종료 · ${activity.failedToolCount}개 오류 · ${duration}`,
      );
      activity.root.classList.add('ag-activity-error');
    } else {
      animateActivityLabel(activity, `작업 완료 · ${count}단계 · ${duration}`);
      activity.root.classList.add('ag-activity-complete');
    }
    activity.root.classList.remove('ag-activity-running');
    // 답변이 먼저 자리 잡은 뒤 작업 내역이 접혀 레이아웃 점프가 덜 느껴지게 한다.
    window.setTimeout(() => {
      withAutoScroll(() => {
        activity.root.classList.add('ag-activity-collapsed');
        activity.toggle.setAttribute('aria-expanded', 'false');
        activity.content.tabIndex = -1;
      });
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120);
    turnActivity = null;
  }

  function appendCheckDocumentMessage(agent: AgentName): void {
    const text = '작업을 마쳤습니다. 문서를 확인해 보세요.';
    const message = openAssistantBubble(agent);
    message.textContent = text;
    message.classList.add('ag-msg-enter');
    assistantBuffer = text;
    flushAssistantBuffer();
    streamBubble = null;
  }

  function addToolRow(evt: Extract<AgentStreamEvent, { type: 'tool-call' }>): void {
    const activity = ensureTurnActivity(evt.agent);
    activity.toolCount += 1;
    animateActivityLabel(activity, `작업 중 · ${activity.toolCount}단계`);

    const row = el('div', `ag-tool-row ag-${evt.agent}`);
    const head = el('button', 'ag-tool-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    const status = el('span', 'ag-tool-status ag-spin');
    const name = el('span', 'ag-tool-name', evt.tool);
    const summary = el('span', 'ag-tool-summary', truncate(evt.argsJson, 60));
    const chevron = createChevron('ag-tool-chevron');
    head.append(status, name, summary, chevron);

    const body = el('div', 'ag-tool-body');
    body.hidden = true;
    const args = el('pre', 'ag-tool-args', prettyJson(evt.argsJson));
    const result = el('pre', 'ag-tool-result');
    body.append(args, result);

    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      row.classList.toggle('ag-tool-open', !body.hidden);
      head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    });

    row.append(head, body);
    withAutoScroll(() => activity.content.appendChild(row));
    scrollActivityToLatest(activity.content);
    toolRows.set(evt.callId, { status, result, scroller: activity.content });
    // 다음 text-delta 는 activity 아래의 최종 답변 후보로 연다.
    streamBubble = null;
  }

  function resolveToolRow(evt: Extract<AgentStreamEvent, { type: 'tool-result' }>): void {
    const entry = toolRows.get(evt.callId);
    if (!entry) return;
    toolRows.delete(evt.callId);
    entry.status.classList.remove('ag-spin');
    entry.status.classList.add(evt.ok ? 'ag-ok' : 'ag-err');
    entry.status.textContent = evt.ok ? '✓' : '✕';
    entry.result.textContent = evt.resultPreview;
    scrollActivityToLatest(entry.scroller);
    if (!evt.ok && turnActivity) turnActivity.failedToolCount += 1;
  }

  /**
   * turn 종료(인터럽트/프로세스 종료 포함) 시 결과가 도착하지 않은 tool row 를
   * 정리한다 — 스피너가 영원히 돌거나 Map 엔트리가 새는 것을 막는다.
   */
  function sweepUnresolvedToolRows(): void {
    const unresolvedCount = toolRows.size;
    for (const entry of toolRows.values()) {
      entry.status.classList.remove('ag-spin');
      entry.status.classList.add('ag-err');
      entry.status.textContent = '✕';
      if (!entry.result.textContent) entry.result.textContent = '(결과 없이 종료됨)';
    }
    toolRows.clear();
    if (turnActivity && unresolvedCount > 0) {
      turnActivity.failedToolCount += unresolvedCount;
    }
  }

  function handleAgentEvent(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'turn-start':
        setTurnRunning(true);
        followConversation = true;
        scrollConversationToEnd();
        assistantBuffer = '';
        streamBubble = null;
        turnActivity = null;
        break;
      case 'text-delta': {
        const bubble = streamBubble ?? openAssistantBubble(event.agent);
        assistantBuffer += event.text;
        withAutoScroll(() => {
          if (!bubble.classList.contains('ag-msg-enter')) {
            bubble.classList.add('ag-msg-enter');
          }
          bubble.textContent = (bubble.textContent ?? '') + event.text;
        });
        break;
      }
      case 'tool-call':
        // 도구 전 설명은 이전 채팅 복원 시 별도 답변으로 남기지 않는다.
        flushAssistantBuffer({ persist: false });
        compactStreamIntoActivity(event.agent);
        addToolRow(event);
        break;
      case 'tool-result':
        resolveToolRow(event);
        break;
      case 'session-info':
        if (event.mcpStatus !== undefined && event.mcpStatus !== 'connected') {
          systemMessage(`MCP 서버 연결 실패: ${event.mcpStatus}`);
        }
        break;
      case 'turn-end': {
        const finalBubble =
          streamBubble?.parentElement === messages
          && Boolean((streamBubble.textContent ?? '').trim());
        setTurnRunning(false);
        flushAssistantBuffer();
        sweepUnresolvedToolRows();
        if (event.errorMessage) systemMessage(event.errorMessage);
        const completed =
          event.stopReason !== 'interrupted'
          && event.stopReason !== 'failed'
          && event.stopReason !== 'exited'
          && !event.errorMessage
          && (turnActivity?.failedToolCount ?? 0) === 0;
        if (turnActivity && !finalBubble && completed) {
          appendCheckDocumentMessage(event.agent);
        }
        completeTurnActivity();
        streamBubble = null;
        break;
      }
      case 'error':
        systemMessage(event.message);
        break;
    }
  }

  function handleSidebarEvent(e: SidebarEvent): void {
    switch (e.type) {
      case 'connection':
        setConnection(e.state);
        // 재연결 시 진행 상태를 브리지와 다시 동기화한다.
        setTurnRunning(bridge.isTurnRunning());
        break;
      case 'chat-started':
        if (e.agent !== selectedAgent) {
          selectedModel = defaultModelForAgent(e.agent);
          selectedEffort = resolveEffortForAgent(e.agent, null, selectedModel);
        }
        setSelectedAgent(e.agent);
        selectedModel = resolveModelForAgent(selectedAgent, e.model ?? selectedModel);
        selectedEffort = resolveEffortForAgent(
          selectedAgent,
          e.effort ?? selectedEffort,
          selectedModel,
        );
        currentThread.agent = selectedAgent;
        currentThread.model = selectedModel;
        currentThread.effort = selectedEffort;
        rebuildLlmMenu();
        rebuildEffortMenu();
        updateComposer();
        break;
      case 'chat-stopped':
        setTurnRunning(false);
        streamBubble = null;
        break;
      case 'title-result': {
        if (e.threadId !== currentThread.id && !getThread(e.threadId)) break;
        const title = e.title?.trim() || null;
        if (title) {
          setThreadTitle(e.threadId, title);
          if (e.threadId === currentThread.id) {
            currentThread.title = title;
          }
        } else if (e.threadId === currentThread.id) {
          currentThread.title = fallbackTitle(currentThread.messages);
          persistCurrentThread();
        } else {
          const t = getThread(e.threadId);
          if (t) setThreadTitle(e.threadId, fallbackTitle(t.messages));
        }
        if (threadsPanelOpen) rebuildThreadsList();
        break;
      }
      case 'agent':
        handleAgentEvent(e.event);
        break;
      case 'hub-error':
        systemMessage(`오류 (${e.code}): ${e.message}`);
        setTurnRunning(bridge.isTurnRunning());
        break;
    }
  }

  // ── 리뷰 카드 (change-set 승인/거절) ──────────────────
  function buildReviewCard(set: PendingChangeSet): HTMLElement {
    const card = el('div', `ag-review-card ag-${set.agent}`);
    const summary = el('div', 'ag-review-summary');

    if (set.status === 'open') {
      card.classList.add('ag-review-open');
      summary.appendChild(
        el('div', 'ag-review-title', `${AGENT_LABEL[set.agent]} 편집 진행 중…`),
      );
      card.appendChild(summary);
      return card;
    }

    summary.appendChild(
      el('div', 'ag-review-title', `${AGENT_LABEL[set.agent]} 편집 ${set.ops.length}건 대기 중`),
    );
    for (const op of set.ops.slice(0, MAX_REVIEW_OP_LINES)) {
      const line = el('div', 'ag-review-op');
      line.appendChild(el('span', `ag-op-glyph ag-op-${op.kind}`, opGlyph(op)));
      line.appendChild(el('span', 'ag-op-text', truncate(opPreview(op), 40)));
      summary.appendChild(line);
    }
    if (set.ops.length > MAX_REVIEW_OP_LINES) {
      summary.appendChild(
        el('div', 'ag-review-more', `외 ${set.ops.length - MAX_REVIEW_OP_LINES}건`),
      );
    }
    card.appendChild(summary);

    const actions = el('div', 'ag-review-actions');
    const approve = el('button', 'ag-approve', '승인');
    approve.type = 'button';
    approve.addEventListener('click', () => {
      approve.disabled = true;
      try {
        bridge.pendingEdits.approve(set.id);
      } catch (err) {
        approve.disabled = false;
        systemMessage(`승인 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const reject = el('button', 'ag-reject', '거절');
    reject.type = 'button';
    reject.addEventListener('click', () => {
      reject.disabled = true;
      try {
        bridge.pendingEdits.reject(set.id);
      } catch (err) {
        reject.disabled = false;
        systemMessage(`거절 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    actions.append(approve, reject);
    card.appendChild(actions);
    return card;
  }

  function rebuildReview(): void {
    review.replaceChildren();
    for (const set of bridge.pendingEdits.getChangeSets()) {
      review.appendChild(buildReviewCard(set));
    }
  }

  // ── 구독 ──────────────────────────────────────────────
  const unsubBridge = bridge.onEvent(handleSidebarEvent);
  const unsubPending = bridge.pendingEdits.onChange((e: PendingEditsChangeEvent) => {
    if (e.type === 'invalidated') {
      systemMessage(`대기 중인 에이전트 편집이 해제되었습니다 (${e.reason})`);
    }
    rebuildReview();
  });

  // 초기 상태 반영
  setSelectedAgent(selectedAgent);
  setConnection(connState);
  setTurnRunning(turnRunning);
  rebuildReview();

  return {
    root,
    dispose(): void {
      unsubBridge();
      unsubPending();
      messagesMutationObserver?.disconnect();
      messages.removeEventListener('scroll', onMessagesScroll);
      if (conversationScrollRaf !== null) {
        window.cancelAnimationFrame(conversationScrollRaf);
        conversationScrollRaf = null;
      }
      window.removeEventListener('resize', measure);
      document.removeEventListener('pointerdown', onDocPointerDown);
      endSidebarResize();
      clearInsetRecenterLoop();
      document.body.classList.remove('ag-sidebar-open', 'ag-sidebar-resizing');
      sweepUnresolvedToolRows();
      root.remove();
    },
  };
}
