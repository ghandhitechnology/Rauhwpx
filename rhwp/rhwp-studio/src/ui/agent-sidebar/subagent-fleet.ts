/**
 * 서브에이전트 · 워크플로 편대 카드.
 *
 * 허브가 정규화한 task-start / task-progress / task-end 를 대화 흐름 안의 카드
 * 하나로 그린다. 한 턴에서 태어난 서브에이전트는 한 카드에 모이고, 워크플로는
 * 단계 레일과 멤버 행을 가진 자기 카드를 갖는다.
 *
 * 설계 규칙
 * - 행 높이는 3줄 그리드로 고정한다. 스트리밍 중에 글자가 바뀌어도 다른 행이
 *   밀리지 않아야 열 개짜리 편대도 흔들리지 않는다.
 * - 진행 중 표현은 한 가지다. 점은 돌지 않고, 끝났을 때 시제만 바뀐다.
 * - 값을 모르면 자리를 숨기지 않고 — 로 채워 폭을 지킨다.
 * - 카드는 살아 있는 동안 열려 있고, 끝나도 스스로 접히지 않는다.
 *
 * DOM 은 전부 주입받은 doc 으로 만든다 (테스트에서 가짜 문서로 갈아 끼운다).
 */
import type {
  AgentName,
  AgentStreamEvent,
  AgentTaskMember,
  AgentTaskPhase,
  AgentTaskUsage,
} from '../../agent/types.ts';
import { createChevron } from '../chevron.ts';
import { createIcon } from './icons.ts';
import { formatTokens } from './usage-format.ts';

/** 편대를 띄우는 도구 — 카드가 그 스폰을 대신 나타내므로 도구 행은 접는다. */
const SPAWN_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Workflow']);

export function isSpawnToolName(tool: string): boolean {
  return SPAWN_TOOL_NAMES.has(tool);
}

type TaskState = 'running' | 'completed' | 'failed' | 'stopped';
type DotTone = 'run' | 'ok' | 'err' | 'idle';

const STATE_TONE: Record<TaskState, DotTone> = {
  running: 'run',
  completed: 'ok',
  failed: 'err',
  stopped: 'idle',
};

const STATE_TEXT: Record<TaskState, string> = {
  running: '작업 중',
  completed: '완료',
  failed: '실패',
  stopped: '중단됨',
};

const MEMBER_STATE: Record<AgentTaskMember['state'], TaskState> = {
  pending: 'running',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
};

/** claude-opus-4-5-20260514 → opus-4-5. 행 폭을 먹지 않는 짧은 모델 이름. */
export function compactModelLabel(model: string | null | undefined): string {
  const raw = (model ?? '').trim();
  if (!raw) return '';
  return raw
    .replace(/^[a-z0-9_-]+\//, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

/** 12초 / 3분 04초 — 분이 붙으면 초를 두 자리로 고정해 폭이 흔들리지 않는다. */
export function formatFleetClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}초`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (seconds === 0) return `${minutes}분`;
  return `${minutes}분 ${String(seconds).padStart(2, '0')}초`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 스트리밍 텍스트의 꼬리에서 한 줄짜리 근황을 뽑는다. */
function tailSnippet(buffer: string): string {
  const lines = buffer.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) return truncate(line, 120);
  }
  return '';
}

interface RowRefs {
  root: HTMLElement;
  /** task 행에만 있다 — 도구 기록이 생기기 전까지 비활성. */
  toggle: HTMLButtonElement | null;
  dot: HTMLElement;
  title: HTMLElement;
  role: HTMLElement;
  aside: HTMLElement;
  activity: HTMLElement;
  metrics: HTMLElement;
  status: HTMLElement;
  detail: HTMLElement | null;
}

interface DetailToolRow {
  status: HTMLElement;
  result: HTMLElement;
  elapsed: HTMLElement;
  startedAt: number;
}

interface MemberEntry {
  index: number;
  row: RowRefs;
  state: TaskState;
  tokens: number | null;
  toolCalls: number | null;
  phaseIndex: number | null;
}

interface PhaseRefs {
  root: HTMLElement;
  mark: HTMLElement;
  title: HTMLElement;
  dots: HTMLElement;
}

interface TaskEntry {
  taskId: string;
  kind: 'agent' | 'workflow';
  agent: AgentName;
  card: CardEntry;
  row: RowRefs;
  state: TaskState;
  startedAt: number;
  endedAt: number | null;
  title: string;
  usage: AgentTaskUsage;
  model: string | null;
  activity: string;
  summary: string;
  textTail: string;
  toolCount: number;
  detailToolRows: Map<string, DetailToolRow>;
  phases: AgentTaskPhase[];
  phasePills: Map<number, PhaseRefs>;
  members: Map<number, MemberEntry>;
  workflowName: string;
}

interface CardEntry {
  kind: 'batch' | 'workflow';
  root: HTMLElement;
  label: HTMLElement;
  dot: HTMLElement;
  sum: HTMLElement;
  clock: HTMLElement;
  rail: HTMLElement;
  rows: HTMLElement;
  tasks: TaskEntry[];
  startedAt: number;
  endedAt: number | null;
  ticker: number | null;
}

export interface SubagentFleetDeps {
  /** 요소를 만들 문서. */
  doc: Document;
  /** 카드를 대화 흐름(.ag-messages)에 도구 활동 그룹과 같은 방식으로 끼워 넣는다. */
  mountCard(card: HTMLElement): void;
  /**
   * 모델을 알려주지 않는 서브에이전트의 표기 기본값 — 그 프로바이더가 지금
   * 쓰는 모델. 사이드바 선택이 실행 중인 프로바이더와 다르면 null 을 돌려
   * 남의 모델 이름을 적지 않는다. 워크플로 멤버는 자기 모델을 싣고 온다.
   */
  sessionModel?(agent: AgentName): string | null;
}

export interface SubagentFleetView {
  /** 새 턴 — 다음 서브에이전트 묶음은 새 카드에 담는다. */
  beginTurn(): void;
  taskStart(evt: Extract<AgentStreamEvent, { type: 'task-start' }>): void;
  taskProgress(evt: Extract<AgentStreamEvent, { type: 'task-progress' }>): void;
  taskEnd(evt: Extract<AgentStreamEvent, { type: 'task-end' }>): void;
  /** 해당 task 행으로 흡수했으면 true — false 면 호출부가 기존 경로로 처리한다. */
  routeToolCall(evt: Extract<AgentStreamEvent, { type: 'tool-call' }>): boolean;
  routeToolResult(evt: Extract<AgentStreamEvent, { type: 'tool-result' }>): boolean;
  routeTextDelta(evt: Extract<AgentStreamEvent, { type: 'text-delta' }>): boolean;
  /** 턴이 끝났다 — 아직 안 끝난 행을 중단됨으로 확정하고 타이머를 멈춘다. */
  sweep(): void;
  /** 대화를 갈아 끼웠다 — 카드 참조와 타이머를 모두 버린다. */
  reset(): void;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function createSubagentFleet(deps: SubagentFleetDeps): SubagentFleetView {
  const { doc } = deps;
  const tasks = new Map<string, TaskEntry>();
  const cards = new Set<CardEntry>();
  let batchCard: CardEntry | null = null;

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }

  function setTone(dot: HTMLElement, tone: DotTone): void {
    dot.className = `ag-fleet-dot ag-${tone}`;
  }

  /* ── 타이머 ────────────────────────────────────────────
     1초마다 참조에 textContent 만 쓴다. 다른 노드는 건드리지 않는다. */

  function startTicker(card: CardEntry): void {
    if (card.ticker !== null) return;
    if (typeof globalThis.setInterval !== 'function') return;
    const handle = globalThis.setInterval(() => tick(card), 1000) as unknown as number;
    // Node 타이머일 때만 존재한다 — 브라우저 number 에는 없다.
    (handle as unknown as { unref?: () => void })?.unref?.();
    card.ticker = handle;
  }

  function stopTicker(card: CardEntry): void {
    if (card.ticker === null) return;
    globalThis.clearInterval(card.ticker as unknown as ReturnType<typeof setInterval>);
    card.ticker = null;
  }

  function tick(card: CardEntry): void {
    const at = nowMs();
    if (card.endedAt === null) setText(card.clock, formatFleetClock(at - card.startedAt));
    for (const task of card.tasks) {
      if (task.state === 'running') {
        setText(task.row.aside, formatFleetClock(at - task.startedAt));
      }
    }
  }

  /* ── 행 ────────────────────────────────────────────────
     3줄 고정 그리드. 1행 점·이름·역할·오른쪽 값, 2행 근황, 3행 계기. */

  function createRow(variant: 'task' | 'member'): RowRefs {
    const root = el('div', `ag-fleet-row ag-fleet-${variant}`);
    const dot = el('span', 'ag-fleet-dot ag-run');
    dot.setAttribute('aria-hidden', 'true');
    const name = el('span', 'ag-fleet-name');
    const title = el('span', 'ag-fleet-title');
    const role = el('span', 'ag-fleet-role');
    role.hidden = true;
    name.append(title, role);
    const aside = el('span', 'ag-fleet-aside');
    const status = el('span', 'ag-fleet-sr', STATE_TEXT.running);
    const activity = el('span', 'ag-fleet-activity');
    const metrics = el('span', 'ag-fleet-metrics');

    if (variant === 'member') {
      const head = el('div', 'ag-fleet-head');
      head.append(dot, name, aside, status, activity, metrics);
      root.appendChild(head);
      return {
        root, toggle: null, dot, title, role, aside, activity, metrics, status, detail: null,
      };
    }

    // 드릴인 — 도구 기록이 하나라도 생긴 뒤에야 열 수 있다.
    const toggle = el('button', 'ag-fleet-head');
    toggle.type = 'button';
    toggle.disabled = true;
    toggle.setAttribute('aria-expanded', 'false');
    const detail = el('div', 'ag-fleet-detail');
    detail.hidden = true;
    toggle.append(dot, name, aside, createChevron('ag-fleet-row-chevron'), status, activity, metrics);
    root.append(toggle, detail);
    toggle.addEventListener('click', () => {
      if (toggle.disabled) return;
      detail.hidden = !detail.hidden;
      root.classList.toggle('ag-open', !detail.hidden);
      toggle.setAttribute('aria-expanded', detail.hidden ? 'false' : 'true');
    });

    return { root, toggle, dot, title, role, aside, activity, metrics, status, detail };
  }

  function applyRowState(row: RowRefs, state: TaskState): void {
    row.root.classList.remove('ag-live', 'ag-done', 'ag-err', 'ag-stopped');
    row.root.classList.add(
      state === 'running' ? 'ag-live'
        : state === 'completed' ? 'ag-done'
          : state === 'failed' ? 'ag-err' : 'ag-stopped',
    );
    setTone(row.dot, STATE_TONE[state]);
    setText(row.status, STATE_TEXT[state]);
  }

  /** 제목과 뜻이 같은 역할 칩은 같은 말을 두 번 하는 것이라 감춘다. */
  function applyRole(row: RowRefs, title: string, role: string): void {
    const label = role.trim();
    if (!label || label.toLowerCase() === title.trim().toLowerCase()) {
      row.role.hidden = true;
      setText(row.role, '');
      return;
    }
    row.role.hidden = false;
    setText(row.role, label);
  }

  function setActivity(row: RowRefs, text: string): void {
    setText(row.activity, truncate(text, 140));
  }

  function renderMetrics(
    row: RowRefs,
    model: string | null,
    tokens: number | null,
    toolCalls: number | null,
  ): void {
    const parts = [
      compactModelLabel(model) || '—',
      tokens === null ? '— tok' : `${formatTokens(tokens)} tok`,
      `${toolCalls ?? 0} 도구`,
    ];
    setText(row.metrics, parts.join(' · '));
  }

  /* ── 카드 ──────────────────────────────────────────── */

  function createCard(kind: 'batch' | 'workflow', agent: AgentName): CardEntry {
    const root = el('div', `ag-fleet ag-${agent} ag-live`);
    const toggle = el('button', 'ag-fleet-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    const dot = el('span', 'ag-fleet-dot ag-run');
    dot.setAttribute('aria-hidden', 'true');
    const label = el('span', 'ag-fleet-label');
    label.setAttribute('aria-live', 'polite');
    const meter = el('span', 'ag-fleet-meter');
    const sum = el('span', 'ag-fleet-sum', 'Σ —');
    const clock = el('span', 'ag-fleet-clock', '0초');
    meter.append(sum, clock);
    const chevron = createChevron('ag-fleet-chevron');
    toggle.append(dot, label, meter, chevron);

    const collapse = el('div', 'ag-fleet-collapse');
    const body = el('div', 'ag-fleet-body');
    const rail = el('div', 'ag-fleet-rail');
    rail.hidden = true;
    const rows = el('div', 'ag-fleet-rows');
    body.append(rail, rows);
    collapse.appendChild(body);
    root.append(toggle, collapse);

    toggle.addEventListener('click', () => {
      const collapsed = root.classList.toggle('ag-collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });

    const card: CardEntry = {
      kind,
      root,
      label,
      dot,
      sum,
      clock,
      rail,
      rows,
      tasks: [],
      startedAt: nowMs(),
      endedAt: null,
      ticker: null,
    };
    cards.add(card);
    deps.mountCard(root);
    startTicker(card);
    return card;
  }

  /** 워크플로 카드에서만 멤버 실패가 카드 요약에 섞인다. */
  function errorCount(card: CardEntry): number {
    let count = 0;
    for (const task of card.tasks) {
      if (task.state === 'failed') count += 1;
      for (const member of task.members.values()) {
        if (member.state === 'failed') count += 1;
      }
    }
    return count;
  }

  function stoppedCount(card: CardEntry): number {
    let count = 0;
    for (const task of card.tasks) if (task.state === 'stopped') count += 1;
    return count;
  }

  function liveCount(card: CardEntry): number {
    let count = 0;
    for (const task of card.tasks) if (task.state === 'running') count += 1;
    return count;
  }

  /**
   * 카드 Σ 에 넣을 task 한 벌의 토큰. 멤버가 있으면 멤버 합, 없으면 task 자신의
   * 사용량 — 코디네이터와 멤버를 겹쳐 세지 않는다. 행 자신의 계기는 언제나
   * task.usage 만 쓴다(renderTaskRow).
   */
  function taskTokens(task: TaskEntry): number | null {
    if (task.members.size > 0) {
      let sum = 0;
      let known = false;
      for (const member of task.members.values()) {
        if (member.tokens !== null) {
          sum += member.tokens;
          known = true;
        }
      }
      if (known) return sum;
    }
    return task.usage.totalTokens ?? null;
  }

  /** 진행 중인 단계 = 아직 도는 멤버 중 가장 앞선 단계. 없으면 마지막으로 손댄 단계. */
  function currentPhaseIndex(task: TaskEntry): number | null {
    if (task.phases.length === 0) return null;
    let running: number | null = null;
    let touched: number | null = null;
    for (const member of task.members.values()) {
      if (member.phaseIndex === null) continue;
      if (member.state === 'running') {
        running = running === null ? member.phaseIndex : Math.min(running, member.phaseIndex);
      }
      touched = touched === null ? member.phaseIndex : Math.max(touched, member.phaseIndex);
    }
    if (running !== null) return running;
    if (touched !== null) return touched;
    return task.phases[0]?.index ?? null;
  }

  function cardLabelText(card: CardEntry): string {
    const live = liveCount(card) > 0;
    const errors = errorCount(card);
    const stopped = stoppedCount(card);
    const tail = live ? '작업 중'
      : errors > 0 ? `${errors} 오류`
        : stopped > 0 ? '중단됨' : '완료';

    if (card.kind === 'workflow') {
      const task = card.tasks[0];
      if (!task) return `워크플로 · ${tail}`;
      const name = task.workflowName || task.title;
      if (!live) return `워크플로 · ${name} · ${tail}`;
      const phaseIdx = currentPhaseIndex(task);
      const phase = phaseIdx === null
        ? null
        : task.phases.find((item) => item.index === phaseIdx) ?? null;
      if (phase) {
        const order = task.phases.findIndex((item) => item.index === phase.index) + 1;
        const title = phase.title.trim();
        const step = `${order}/${task.phases.length}`;
        return `워크플로 · ${name} · ${title ? `${step} ${title}` : step}`;
      }
      return `워크플로 · ${name} · ${tail}`;
    }
    return `서브에이전트 ${card.tasks.length} · ${tail}`;
  }

  function refreshCard(card: CardEntry): void {
    const live = liveCount(card) > 0;
    const errors = errorCount(card);
    const stopped = stoppedCount(card);

    setText(card.label, cardLabelText(card));
    // 하나라도 돌고 있으면 카드는 작업 중이다. 실패는 정착한 다음에만 요약을 가져간다.
    const tone: DotTone = live ? 'run' : errors > 0 ? 'err' : stopped > 0 ? 'idle' : 'ok';
    setTone(card.dot, tone);
    card.root.classList.remove('ag-live', 'ag-done', 'ag-err', 'ag-stopped');
    card.root.classList.add(
      live ? 'ag-live' : errors > 0 ? 'ag-err' : stopped > 0 ? 'ag-stopped' : 'ag-done',
    );

    let sum = 0;
    let known = false;
    for (const task of card.tasks) {
      const tokens = taskTokens(task);
      if (tokens !== null) {
        sum += tokens;
        known = true;
      }
    }
    setText(card.sum, known ? `Σ ${formatTokens(sum)}` : 'Σ —');

    if (live) {
      card.endedAt = null;
      startTicker(card);
    } else if (card.endedAt === null) {
      card.endedAt = nowMs();
      setText(card.clock, formatFleetClock(card.endedAt - card.startedAt));
      stopTicker(card);
    }
  }

  /* ── 단계 레일 · 멤버 ──────────────────────────────── */

  function syncPhases(task: TaskEntry, phases: AgentTaskPhase[]): void {
    task.phases = phases;
    const rail = task.card.rail;
    if (phases.length === 0) {
      rail.hidden = true;
      return;
    }
    rail.hidden = false;
    for (const phase of phases) {
      const pill = task.phasePills.get(phase.index);
      if (pill) {
        setText(pill.title, phase.title);
        continue;
      }
      const root = el('span', 'ag-fleet-phase ag-idle');
      root.setAttribute('role', 'listitem');
      const mark = el('span', 'ag-fleet-phase-mark');
      mark.setAttribute('aria-hidden', 'true');
      const title = el('span', 'ag-fleet-phase-title', phase.title);
      const dots = el('span', 'ag-fleet-phase-dots');
      dots.setAttribute('aria-hidden', 'true');
      root.append(mark, title, dots);
      rail.appendChild(root);
      task.phasePills.set(phase.index, { root, mark, title, dots });
    }
    refreshPhases(task);
  }

  function refreshPhases(task: TaskEntry): void {
    if (task.phases.length === 0) return;
    const current = currentPhaseIndex(task);
    const settled = task.state !== 'running';
    for (const phase of task.phases) {
      const pill = task.phasePills.get(phase.index);
      if (!pill) continue;
      const seated = [...task.members.values()].filter((m) => m.phaseIndex === phase.index);
      const passed = current !== null && phase.index < current;
      const done = passed || (settled && current !== null && phase.index <= current);
      const live = !settled && current !== null && phase.index === current;
      pill.root.className = `ag-fleet-phase ${done ? 'ag-done' : live ? 'ag-live' : 'ag-idle'}`;
      pill.mark.replaceChildren(...(done ? [createIcon('check')] : []));
      pill.dots.replaceChildren(
        ...seated.map((member) => el('i', `ag-fleet-mini ag-${STATE_TONE[member.state]}`)),
      );
    }
  }

  /** 멤버는 index 로 자리를 잡는다 — 갱신이 행을 새로 만들거나 순서를 바꾸지 않는다. */
  function syncMembers(task: TaskEntry, members: AgentTaskMember[]): void {
    for (const incoming of members) {
      let entry = task.members.get(incoming.index);
      if (!entry) {
        const row = createRow('member');
        task.card.rows.appendChild(row.root);
        entry = {
          index: incoming.index,
          row,
          state: 'running',
          tokens: null,
          toolCalls: null,
          phaseIndex: null,
        };
        task.members.set(incoming.index, entry);
      }
      const row = entry.row;
      // 이미 끝난 워크플로에 늦게 도착한 갱신이 멤버를 되살리지 않게 한다.
      const next = MEMBER_STATE[incoming.state];
      entry.state = task.state !== 'running' && next === 'running' ? entry.state : next;
      entry.tokens = incoming.tokens ?? entry.tokens;
      entry.toolCalls = incoming.toolCalls ?? entry.toolCalls;
      entry.phaseIndex = incoming.phaseIndex ?? entry.phaseIndex;
      setText(row.title, incoming.label);
      applyRowState(row, entry.state);
      if (incoming.activity) setActivity(row, incoming.activity);
      const phase = entry.phaseIndex === null
        ? null
        : task.phases.find((item) => item.index === entry.phaseIndex) ?? null;
      setText(row.aside, phase?.title ?? '');
      renderMetrics(row, incoming.model ?? null, entry.tokens, entry.toolCalls);
    }
    refreshPhases(task);
  }

  /* ── 행 안쪽 도구 기록 ──────────────────────────────── */

  function enableDetail(task: TaskEntry): void {
    const toggle = task.row.toggle;
    if (!toggle || !toggle.disabled) return;
    toggle.disabled = false;
    task.row.root.classList.add('ag-has-detail');
  }

  function addDetailToolRow(
    task: TaskEntry,
    evt: Extract<AgentStreamEvent, { type: 'tool-call' }>,
  ): void {
    const detail = task.row.detail;
    if (!detail) return;
    enableDetail(task);

    const row = el('div', `ag-tool-row ag-${evt.agent}`);
    const head = el('button', 'ag-tool-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    const status = el('span', 'ag-tool-status ag-spin');
    const name = el('span', 'ag-tool-name', evt.tool);
    const summary = el('span', 'ag-tool-summary', truncate(evt.argsJson, 56));
    const elapsed = el('span', 'ag-tool-elapsed');
    const chevron = createChevron('ag-tool-chevron');
    head.append(status, name, summary, elapsed, chevron);

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
    detail.appendChild(row);
    task.detailToolRows.set(evt.callId, {
      status,
      result,
      elapsed,
      startedAt: nowMs(),
    });
  }

  function resolveDetailToolRow(
    task: TaskEntry,
    evt: Extract<AgentStreamEvent, { type: 'tool-result' }>,
  ): void {
    const entry = task.detailToolRows.get(evt.callId);
    if (!entry) return;
    task.detailToolRows.delete(evt.callId);
    entry.status.classList.remove('ag-spin');
    entry.status.classList.add(evt.ok ? 'ag-ok' : 'ag-err');
    entry.status.replaceChildren(createIcon(evt.ok ? 'check' : 'close'));
    const ms = nowMs() - entry.startedAt;
    entry.elapsed.textContent = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
    entry.result.textContent = evt.resultPreview;
  }

  function sweepDetailToolRows(task: TaskEntry): void {
    for (const [, entry] of task.detailToolRows) {
      entry.status.classList.remove('ag-spin');
      entry.status.classList.add('ag-err');
      entry.status.replaceChildren(createIcon('close'));
      if (!entry.elapsed.textContent) entry.elapsed.textContent = '중단';
      if (!entry.result.textContent) entry.result.textContent = '(결과 없이 종료됨)';
    }
    task.detailToolRows.clear();
  }

  /* ── task 수명주기 ─────────────────────────────────── */

  function renderTaskRow(task: TaskEntry): void {
    setText(task.row.title, task.title);
    applyRowState(task.row, task.state);
    // 행은 자기 몫만 말한다 — 멤버 합은 카드 머리의 Σ 가 맡는다.
    renderMetrics(
      task.row,
      task.model ?? deps.sessionModel?.(task.agent) ?? null,
      task.usage.totalTokens ?? null,
      Math.max(task.toolCount, task.usage.toolUses ?? 0),
    );
    if (task.activity) setActivity(task.row, task.activity);
    if (task.state === 'running') {
      setText(task.row.aside, formatFleetClock(nowMs() - task.startedAt));
    } else if (task.endedAt !== null) {
      setText(task.row.aside, formatFleetClock(task.endedAt - task.startedAt));
    }
  }

  function settleTask(task: TaskEntry, state: TaskState): void {
    if (task.state !== 'running') return;
    task.state = state;
    task.endedAt = nowMs();
    sweepDetailToolRows(task);
    for (const member of task.members.values()) {
      if (member.state === 'running') {
        member.state = state === 'completed' ? 'completed' : 'stopped';
        applyRowState(member.row, member.state);
      }
    }
    refreshPhases(task);
    renderTaskRow(task);
    refreshCard(task.card);
  }

  function taskStart(evt: Extract<AgentStreamEvent, { type: 'task-start' }>): void {
    if (tasks.has(evt.taskId)) return;
    const card = evt.taskKind === 'workflow'
      ? createCard('workflow', evt.agent)
      : batchCard ?? createCard('batch', evt.agent);
    if (evt.taskKind === 'agent') batchCard = card;

    const row = createRow('task');
    card.rows.appendChild(row.root);
    const task: TaskEntry = {
      taskId: evt.taskId,
      kind: evt.taskKind,
      agent: evt.agent,
      card,
      row,
      state: 'running',
      startedAt: nowMs(),
      endedAt: null,
      title: evt.title.trim() || (evt.taskKind === 'workflow' ? '워크플로' : '서브에이전트'),
      usage: {},
      model: null,
      activity: '',
      summary: '',
      textTail: '',
      toolCount: 0,
      detailToolRows: new Map(),
      phases: [],
      phasePills: new Map(),
      members: new Map(),
      workflowName: evt.workflowName?.trim() ?? '',
    };
    card.tasks.push(task);
    tasks.set(task.taskId, task);
    // 워크플로 이름은 카드 머리가 이미 말한다 — 행에서는 되풀이하지 않는다.
    applyRole(row, task.title, evt.taskKind === 'workflow' ? '' : evt.role ?? '');
    renderTaskRow(task);
    refreshCard(card);
  }

  function taskProgress(evt: Extract<AgentStreamEvent, { type: 'task-progress' }>): void {
    const task = tasks.get(evt.taskId);
    if (!task) return;
    if (evt.usage) {
      if (evt.usage.totalTokens !== undefined) task.usage.totalTokens = evt.usage.totalTokens;
      if (evt.usage.toolUses !== undefined) task.usage.toolUses = evt.usage.toolUses;
      if (evt.usage.durationMs !== undefined) task.usage.durationMs = evt.usage.durationMs;
    }
    if (evt.lastTool) task.activity = `▸ ${evt.lastTool}`;
    else if (evt.activity) task.activity = evt.activity;
    if (evt.phases) syncPhases(task, evt.phases);
    if (evt.members) syncMembers(task, evt.members);
    renderTaskRow(task);
    refreshCard(task.card);
  }

  function taskEnd(evt: Extract<AgentStreamEvent, { type: 'task-end' }>): void {
    const task = tasks.get(evt.taskId);
    if (!task) return;
    // task-end 는 두 번 온다 (상태만 먼저, 요약·사용량이 나중에). 빈 자리만 채우고
    // 이미 끝난 행을 되살리지 않는다.
    if (evt.usage) {
      const merge = (key: keyof AgentTaskUsage): void => {
        const next = evt.usage?.[key];
        if (next === undefined) return;
        const prev = task.usage[key];
        if (prev === undefined || next > prev) task.usage[key] = next;
      };
      merge('totalTokens');
      merge('toolUses');
      merge('durationMs');
    }
    if (evt.summary && !task.summary) {
      task.summary = truncate(evt.summary, 140);
      task.activity = task.summary;
    }
    if (task.state === 'running') {
      settleTask(
        task,
        evt.status === 'completed' ? 'completed' : evt.status === 'failed' ? 'failed' : 'stopped',
      );
    } else {
      renderTaskRow(task);
      refreshCard(task.card);
    }
  }

  function routeToolCall(evt: Extract<AgentStreamEvent, { type: 'tool-call' }>): boolean {
    const task = evt.parentTaskId ? tasks.get(evt.parentTaskId) : undefined;
    if (!task) return false;
    task.toolCount += 1;
    task.activity = `▸ ${evt.tool}`;
    addDetailToolRow(task, evt);
    renderTaskRow(task);
    refreshCard(task.card);
    return true;
  }

  function routeToolResult(evt: Extract<AgentStreamEvent, { type: 'tool-result' }>): boolean {
    const task = evt.parentTaskId ? tasks.get(evt.parentTaskId) : undefined;
    if (!task) return false;
    resolveDetailToolRow(task, evt);
    return true;
  }

  function routeTextDelta(evt: Extract<AgentStreamEvent, { type: 'text-delta' }>): boolean {
    const task = evt.parentTaskId ? tasks.get(evt.parentTaskId) : undefined;
    if (!task) return false;
    if (task.state !== 'running') return true;
    task.textTail = (task.textTail + evt.text).slice(-600);
    const snippet = tailSnippet(task.textTail);
    if (snippet) {
      task.activity = snippet;
      setActivity(task.row, snippet);
    }
    return true;
  }

  return {
    beginTurn(): void {
      batchCard = null;
    },
    taskStart,
    taskProgress,
    taskEnd,
    routeToolCall,
    routeToolResult,
    routeTextDelta,
    sweep(): void {
      for (const task of tasks.values()) {
        if (task.state === 'running') settleTask(task, 'stopped');
      }
      for (const card of cards) {
        refreshCard(card);
        stopTicker(card);
      }
      batchCard = null;
    },
    reset(): void {
      for (const card of cards) stopTicker(card);
      cards.clear();
      tasks.clear();
      batchCard = null;
    },
  };
}
