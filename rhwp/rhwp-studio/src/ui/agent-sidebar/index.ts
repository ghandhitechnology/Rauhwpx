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
import { createChevron } from '../chevron.ts';

export interface AgentSidebarDeps {
  bridge: AgentBridge;
  /** inset 전환 후 용지 가운데 정렬을 요청할 때 사용 */
  eventBus?: EventBus;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';

const AGENT_LABEL: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex' };

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
  }
}

function opPreview(op: PendingOp): string {
  switch (op.kind) {
    case 'insert':
    case 'delete':
      return op.text.replace(/\n/g, '⏎');
    case 'format':
      return JSON.stringify(op.format);
    case 'field':
      return `${op.name} → ${op.newValue}`;
  }
}

export function initAgentSidebar(deps: AgentSidebarDeps): { root: HTMLElement; dispose(): void } {
  const { bridge, eventBus } = deps;

  let selectedAgent: AgentName = bridge.getActiveAgent() ?? 'claude';
  let selectedModel = defaultModelForAgent(selectedAgent);
  let selectedEffort = resolveEffortForAgent(selectedAgent, null, selectedModel);
  let connState: ConnectionState = bridge.getConnectionState();
  let turnRunning = bridge.isTurnRunning();
  /** 현재 스트리밍 중인 assistant 말풍선 (tool-call 이후에는 새로 연다). */
  let streamBubble: HTMLElement | null = null;
  const toolRows = new Map<string, { status: HTMLElement; result: HTMLPreElement }>();
  let insetRecenterRaf: number | null = null;

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

  collapseTab.addEventListener('click', () => {
    setCollapsed(!root.classList.contains('ag-collapsed'));
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
  const providerDot = el('span', 'ag-model-dot');
  providerDot.setAttribute('aria-hidden', 'true');
  const providerName = el('span', 'ag-model-name', AGENT_LABEL[selectedAgent]);
  const providerCaret = createChevron('ag-model-caret');
  providerTrigger.append(providerDot, providerName, providerCaret);

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
    const item = el('button', 'ag-model-item', AGENT_LABEL[agent]);
    item.type = 'button';
    item.dataset.agent = agent;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', 'false');
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

  const conn = el('span', 'ag-conn');
  selectors.append(providerWrap, llmWrap, effortWrap);
  header.append(selectors, conn);

  const messages = el('div', 'ag-messages');
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-live', 'polite');

  const review = el('div', 'ag-review');

  const composer = el('form', 'ag-composer');
  const input = el('textarea', 'ag-input');
  input.placeholder = '문서에 대해 질문하거나 요청해 보세요…';
  input.rows = 1;
  input.setAttribute('aria-label', '에이전트 메시지 입력');
  const send = el('button', 'ag-send', '보내기');
  send.type = 'submit';
  composer.append(input, send);

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
    withAutoScroll(() => messages.appendChild(el('div', 'ag-msg ag-msg-user', text)));
    bridge.sendUserMessage(text);
    input.value = '';
    input.style.height = 'auto';
  });

  root.append(collapseTab, header, messages, review, composer);
  document.body.appendChild(root);
  setCollapsed(false, { recenter: false });

  // ── 배치: #editor-area ↔ #status-bar 사이에 맞춘다 ────
  function measure(): void {
    const top = document.getElementById('editor-area')?.getBoundingClientRect().top ?? 96;
    const statusTop =
      document.getElementById('status-bar')?.getBoundingClientRect().top ?? window.innerHeight;
    root.style.top = `${Math.max(0, top)}px`;
    root.style.bottom = `${Math.max(0, window.innerHeight - statusTop)}px`;
  }
  window.addEventListener('resize', measure);
  measure();

  // ── 상태 반영 헬퍼 ────────────────────────────────────
  function setSelectedAgent(agent: AgentName): void {
    selectedAgent = agent;
    root.dataset.agent = agent;
    providerName.textContent = AGENT_LABEL[agent];
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

  /** 사용자가 이미 하단 근처(≤40px)에 있을 때만 자동 스크롤한다. */
  function withAutoScroll(mutate: () => void): void {
    const nearBottom =
      messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 40;
    mutate();
    if (nearBottom) messages.scrollTop = messages.scrollHeight;
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

  function addToolRow(evt: Extract<AgentStreamEvent, { type: 'tool-call' }>): void {
    const row = el('div', `ag-tool-row ag-${evt.agent}`);
    const head = el('div', 'ag-tool-head');
    const status = el('span', 'ag-tool-status ag-spin');
    const name = el('span', 'ag-tool-name', evt.tool);
    const summary = el('span', 'ag-tool-summary', truncate(evt.argsJson, 60));
    const chevron = el('span', 'ag-tool-chevron', '▸');
    head.append(status, name, summary, chevron);

    const body = el('div', 'ag-tool-body');
    body.hidden = true;
    const args = el('pre', 'ag-tool-args', prettyJson(evt.argsJson));
    const result = el('pre', 'ag-tool-result');
    body.append(args, result);

    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      chevron.textContent = body.hidden ? '▸' : '▾';
    });

    row.append(head, body);
    withAutoScroll(() => messages.appendChild(row));
    toolRows.set(evt.callId, { status, result });
    // 다음 text-delta 는 tool row 아래의 새 말풍선에 이어 쓴다 (시간순 유지).
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
  }

  /**
   * turn 종료(인터럽트/프로세스 종료 포함) 시 결과가 도착하지 않은 tool row 를
   * 정리한다 — 스피너가 영원히 돌거나 Map 엔트리가 새는 것을 막는다.
   */
  function sweepUnresolvedToolRows(): void {
    for (const entry of toolRows.values()) {
      entry.status.classList.remove('ag-spin');
      entry.status.classList.add('ag-err');
      entry.status.textContent = '✕';
      if (!entry.result.textContent) entry.result.textContent = '(결과 없이 종료됨)';
    }
    toolRows.clear();
  }

  function handleAgentEvent(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'turn-start':
        setTurnRunning(true);
        openAssistantBubble(event.agent);
        break;
      case 'text-delta': {
        const bubble = streamBubble ?? openAssistantBubble(event.agent);
        withAutoScroll(() => {
          bubble.textContent = (bubble.textContent ?? '') + event.text;
        });
        break;
      }
      case 'tool-call':
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
      case 'turn-end':
        setTurnRunning(false);
        streamBubble = null;
        sweepUnresolvedToolRows();
        if (event.errorMessage) systemMessage(event.errorMessage);
        break;
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
        rebuildLlmMenu();
        rebuildEffortMenu();
        updateComposer();
        break;
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
      window.removeEventListener('resize', measure);
      document.removeEventListener('pointerdown', onDocPointerDown);
      clearInsetRecenterLoop();
      document.body.classList.remove('ag-sidebar-open');
      sweepUnresolvedToolRows();
      root.remove();
    },
  };
}
