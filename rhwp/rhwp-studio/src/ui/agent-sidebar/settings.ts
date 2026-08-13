/**
 * 설정 탭 — 사이드바의 한 페이지(스킬 페이지와 같은 무대 전환을 탄다).
 *
 * 네 묶음을 한 스크롤에 세운다:
 *  1. 연결 — 허브 소켓과 로컬 CLI(claude/codex) 상태, 재연결·세션 재시작
 *  2. 기본 설정 — 다음 대화부터 쓸 프로바이더·모델·강도·권한
 *  3. 글쓰기 보정 — 문체 보정 상태와 재보정 진입
 *  4. 사용량 — CLIProxyAPI 연결, 요금제별 5시간·주간 한도, 오늘 누적, 모델별 내역
 *
 * 페이지 전환(열기/닫기)은 index.ts 가 클래스로 관리하고, 이 모듈은
 * 자기 DOM 과 데이터 갱신만 맡는다.
 */
import './settings.css';

import {
  effortsForAgent,
  labelForModel,
  modelsForAgent,
  resolveEffortForAgent,
  resolveModelForAgent,
} from '../../agent/models.ts';
import { loadAgentPrefs, saveAgentPrefs, type AgentPrefs } from '../../agent/agent-prefs.ts';
import { createIcon } from './icons.ts';
import { formatRelativeTime, formatResetAt, formatShortDate, formatTokens } from './usage-format.ts';
import type { AgentBridge } from '../../agent/bridge.ts';
import type {
  AgentName,
  PermissionProfile,
  ProviderStatusMap,
  ProviderUsage,
  SidebarEvent,
  CliproxyStatus,
  UsageSummary,
  UsageWindow,
  WritingStyleStatus,
} from '../../agent/types.ts';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';

const AGENTS: readonly AgentName[] = ['claude', 'codex'];

const AGENT_LABEL: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex' };

const PROVIDER_ICON_SRC: Record<AgentName, string> = {
  claude: '/icons/provider-claude.png',
  codex: '/icons/provider-codex.png',
};

const CONN_LABEL: Record<ConnectionState, string> = {
  connected: '연결됨',
  connecting: '연결 중',
  disconnected: '끊김',
  replaced: '다른 탭에서 사용 중',
};

const PERMISSION_OPTIONS: ReadonlyArray<{ id: PermissionProfile; label: string }> = [
  { id: 'safe', label: '안전 — 프로젝트 안에서만' },
  { id: 'unrestricted', label: '전체 접근 — 노트북 전체' },
];

/** 요금제 목록은 프로바이더마다 다르다 (허브의 한도 계산 기준). */
const USAGE_PLANS: Record<AgentName, ReadonlyArray<{ id: string; label: string }>> = {
  claude: [
    { id: 'pro', label: 'Pro' },
    { id: 'max5x', label: 'Max 5x' },
    { id: 'max20x', label: 'Max 20x' },
    { id: 'api', label: 'API' },
  ],
  codex: [
    { id: 'plus', label: 'Plus' },
    { id: 'pro', label: 'Pro' },
    { id: 'api', label: 'API' },
  ],
};

const DEFAULT_PLAN: Record<AgentName, string> = { claude: 'pro', codex: 'plus' };

const UNRESTRICTED_DEFAULT_WARNING =
  '전체 접근을 기본값으로 두면 새 대화가 열릴 때부터 에이전트의 명령과 파일 도구가 노트북 전체에 닿습니다. 계속할까요?';

/** 미터가 경고 색으로 넘어가는 소진율. */
const METER_WARN_PERCENT = 80;

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

function providerIcon(agent: AgentName): HTMLElement {
  if (agent === 'codex') {
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

function createSection(title: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('section', 'ag-settings-section');
  const heading = el('h3', 'ag-settings-section-title', title);
  const body = el('div', 'ag-settings-section-body');
  root.append(heading, body);
  return { root, body };
}

function createTextField(
  label: string,
  opts: { type?: string; placeholder?: string; autocomplete?: HTMLInputElement['autocomplete'] } = {},
): { field: HTMLElement; input: HTMLInputElement } {
  const field = el('label', 'ag-settings-field');
  field.append(el('span', 'ag-settings-field-label', label));
  const input = document.createElement('input');
  input.className = 'ag-settings-input';
  input.type = opts.type ?? 'text';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.autocomplete = opts.autocomplete ?? 'off';
  input.spellcheck = false;
  field.append(input);
  return { field, input };
}

function createSelect(
  label: string,
  options: ReadonlyArray<{ id: string; label: string }>,
): { field: HTMLElement; select: HTMLSelectElement } {
  const field = el('label', 'ag-settings-field');
  field.append(el('span', 'ag-settings-field-label', label));
  const select = el('select', 'ag-settings-select') as HTMLSelectElement;
  fillSelect(select, options);
  field.append(select);
  return { field, select };
}

function fillSelect(
  select: HTMLSelectElement,
  options: ReadonlyArray<{ id: string; label: string }>,
): void {
  const previous = select.value;
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.id;
    node.textContent = option.label;
    select.appendChild(node);
  }
  if (options.some((option) => option.id === previous)) select.value = previous;
}

export interface SettingsPanelDeps {
  bridge: AgentBridge;
  /** 지금 대화가 쓰고 있는 조합 — 기본값과 다를 수 있다. */
  getSelection: () => {
    agent: AgentName;
    model: string;
    effort: string;
    permission: PermissionProfile;
  };
  /** 저장된 기본값을 사이드바에 알린다 (새 대화에 적용된다). */
  applyDefaults: (prefs: AgentPrefs) => void;
  openCalibration: () => void;
  /** 현재 대화의 CLI 세션을 다시 시작한다. */
  reconnectSession: () => void;
}

export interface SettingsPanel {
  element: HTMLElement;
  open(): void;
  close(): void;
  handleEvent(ev: SidebarEvent): void;
  dispose(): void;
}

export function createSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const { bridge, getSelection, applyDefaults, openCalibration, reconnectSession } = deps;

  let disposed = false;
  let prefs: AgentPrefs = loadAgentPrefs();
  let connectionState: ConnectionState = bridge.getConnectionState();
  let providers: ProviderStatusMap | null = null;
  let usage: UsageSummary | null = null;
  let writingStyle: WritingStyleStatus | null = null;

  // ── 페이지 골격 ────────────────────────────────────────
  const element = el('div', 'ag-settings-page');
  element.id = 'ag-settings-panel';
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', '설정');
  element.setAttribute('aria-hidden', 'true');

  const header = el('div', 'ag-threads-header');
  const title = el('span', 'ag-threads-title', '설정');
  const close = el('button', 'ag-threads-btn ag-threads-close ag-settings-close');
  close.type = 'button';
  close.setAttribute('aria-label', '채팅으로 돌아가기');
  close.title = '채팅으로 돌아가기';
  close.appendChild(createIcon('close'));
  close.addEventListener('click', () => {
    element.dispatchEvent(new CustomEvent('ag-settings-close', { bubbles: true }));
  });
  header.append(title, close);

  const body = el('div', 'ag-settings-body');
  element.append(header, body);

  // ── 1. 연결 ────────────────────────────────────────────
  const connection = createSection('연결');
  const hubRow = el('div', 'ag-settings-row ag-settings-hub-row');
  const hubDot = el('span', 'ag-settings-dot');
  hubDot.setAttribute('aria-hidden', 'true');
  const hubText = el('div', 'ag-settings-row-text');
  const hubName = el('span', 'ag-settings-row-name', '에이전트 허브');
  const hubLabel = el('span', 'ag-settings-row-detail', CONN_LABEL[connectionState]);
  hubText.append(hubName, hubLabel);
  const hubReconnect = el('button', 'ag-settings-btn', '다시 연결');
  hubReconnect.type = 'button';
  hubReconnect.addEventListener('click', () => {
    void bridge.reconnectNow();
    renderConnection();
  });
  hubRow.append(hubDot, hubText, hubReconnect);

  const providerRows = new Map<
    AgentName,
    { dot: HTMLElement; detail: HTMLElement }
  >();
  const providerList = el('div', 'ag-settings-provider-list');
  for (const agent of AGENTS) {
    const row = el('div', 'ag-settings-row ag-settings-provider-row');
    row.dataset.agent = agent;
    const dot = el('span', 'ag-settings-dot');
    dot.setAttribute('aria-hidden', 'true');
    const text = el('div', 'ag-settings-row-text');
    const name = el('span', 'ag-settings-row-name');
    name.append(providerIcon(agent), document.createTextNode(AGENT_LABEL[agent]));
    const detail = el('span', 'ag-settings-row-detail', '확인 중…');
    text.append(name, detail);
    row.append(dot, text);
    providerList.appendChild(row);
    providerRows.set(agent, { dot, detail });
  }

  const connectionActions = el('div', 'ag-settings-actions');
  const refreshBtn = el('button', 'ag-settings-btn');
  refreshBtn.type = 'button';
  refreshBtn.append(createIcon('refresh'), el('span', '', '상태 새로고침'));
  refreshBtn.addEventListener('click', () => void refreshProviders(true));
  const restartBtn = el('button', 'ag-settings-btn', '세션 다시 시작');
  restartBtn.type = 'button';
  restartBtn.addEventListener('click', () => {
    reconnectSession();
    void refreshProviders(true);
  });
  connectionActions.append(refreshBtn, restartBtn);
  connection.body.append(hubRow, providerList, connectionActions);

  // ── 2. 기본 설정 ──────────────────────────────────────
  const defaults = createSection('기본 설정');
  const agentField = createSelect(
    '기본 제공자',
    AGENTS.map((agent) => ({ id: agent, label: AGENT_LABEL[agent] })),
  );
  const modelField = createSelect('기본 모델', []);
  const effortField = createSelect('추론 강도', []);
  const permissionField = createSelect('권한 프로필', PERMISSION_OPTIONS);
  const defaultsNote = el('p', 'ag-settings-note', '새 대화부터 적용돼요.');
  const currentLine = el('p', 'ag-settings-current');
  defaults.body.append(
    agentField.field,
    modelField.field,
    effortField.field,
    permissionField.field,
    defaultsNote,
    currentLine,
  );

  agentField.select.addEventListener('change', () => {
    const agent = agentField.select.value === 'codex' ? 'codex' : 'claude';
    commitPrefs({ defaultAgent: agent });
  });
  modelField.select.addEventListener('change', () => {
    commitPrefs({ defaultModel: modelField.select.value });
  });
  effortField.select.addEventListener('change', () => {
    commitPrefs({ defaultEffort: effortField.select.value });
  });
  permissionField.select.addEventListener('change', () => {
    const next: PermissionProfile =
      permissionField.select.value === 'unrestricted' ? 'unrestricted' : 'safe';
    // 전체 접근을 기본값으로 굳히는 건 대화 하나보다 넓은 결정이다 — 한 번 묻는다.
    if (next === 'unrestricted' && !window.confirm(UNRESTRICTED_DEFAULT_WARNING)) {
      permissionField.select.value = prefs.defaultPermissionProfile;
      return;
    }
    commitPrefs({ defaultPermissionProfile: next });
  });

  // ── 3. 글쓰기 보정 ────────────────────────────────────
  const calibration = createSection('글쓰기 보정');
  const calibrationStatus = el('p', 'ag-settings-status', '아직 보정되지 않았어요');
  const calibrationSummary = el('p', 'ag-settings-note');
  calibrationSummary.hidden = true;
  const calibrationBtn = el('button', 'ag-settings-primary', '보정 시작');
  calibrationBtn.type = 'button';
  calibrationBtn.addEventListener('click', () => openCalibration());
  calibration.body.append(calibrationStatus, calibrationSummary, calibrationBtn);

  // ── 4. 사용량 ─────────────────────────────────────────
  const usageSection = createSection('사용량');
  const cliproxyCard = el('div', 'ag-settings-usage-block ag-settings-cliproxy');
  const cliproxyHead = el('div', 'ag-settings-usage-head');
  const cliproxyName = el('span', 'ag-settings-row-name');
  const cliproxyDot = el('span', 'ag-settings-dot');
  cliproxyDot.setAttribute('aria-hidden', 'true');
  cliproxyName.append(cliproxyDot, document.createTextNode('CLIProxyAPI'));
  const cliproxyState = el('span', 'ag-settings-row-detail', '연결 안 됨');
  cliproxyHead.append(cliproxyName, cliproxyState);
  const cliproxyNote = el(
    'p',
    'ag-settings-note',
    '연결하면 요금제의 실제 사용량을 보여줘요. 관리 키는 config.yaml 의 remote-management.secret-key 예요.',
  );
  const cliproxyUrl = createTextField('주소', {
    placeholder: 'http://127.0.0.1:8317',
    autocomplete: 'off',
  });
  cliproxyUrl.input.value = 'http://127.0.0.1:8317';
  const cliproxyKey = createTextField('관리 키', {
    type: 'password',
    placeholder: 'secret-key',
    autocomplete: 'new-password',
  });
  const cliproxyError = el('p', 'ag-settings-cliproxy-error');
  cliproxyError.hidden = true;
  const cliproxyActions = el('div', 'ag-settings-actions');
  const cliproxyConnect = el('button', 'ag-settings-primary', '연결');
  cliproxyConnect.type = 'button';
  const cliproxyRefresh = el('button', 'ag-settings-btn', '사용량 새로고침');
  cliproxyRefresh.type = 'button';
  const cliproxyDisconnect = el('button', 'ag-settings-btn', '끊기');
  cliproxyDisconnect.type = 'button';
  cliproxyActions.append(cliproxyConnect, cliproxyRefresh, cliproxyDisconnect);
  cliproxyCard.append(
    cliproxyHead,
    cliproxyNote,
    cliproxyUrl.field,
    cliproxyKey.field,
    cliproxyError,
    cliproxyActions,
  );
  usageSection.body.appendChild(cliproxyCard);

  cliproxyConnect.addEventListener('click', () => {
    void connectCliproxy();
  });
  cliproxyKey.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void connectCliproxy();
    }
  });
  cliproxyRefresh.addEventListener('click', () => {
    void refreshUsage(true);
  });
  cliproxyDisconnect.addEventListener('click', () => {
    void disconnectCliproxy();
  });

  const usageBlocks = new Map<
    AgentName,
    {
      plan: HTMLSelectElement;
      meters: HTMLElement;
      day: HTMLElement;
      models: HTMLElement;
      updated: HTMLElement;
    }
  >();
  for (const agent of AGENTS) {
    const block = el('div', 'ag-settings-usage-block');
    block.dataset.agent = agent;
    const head = el('div', 'ag-settings-usage-head');
    const name = el('span', 'ag-settings-row-name');
    name.append(providerIcon(agent), document.createTextNode(AGENT_LABEL[agent]));
    const plan = el('select', 'ag-settings-select ag-settings-plan-select') as HTMLSelectElement;
    plan.setAttribute('aria-label', `${AGENT_LABEL[agent]} 요금제`);
    fillSelect(plan, USAGE_PLANS[agent]);
    plan.value = DEFAULT_PLAN[agent];
    plan.addEventListener('change', () => {
      plan.disabled = true;
      void bridge.setUsagePlan(agent, plan.value).then((summary) => {
        plan.disabled = false;
        if (disposed) return;
        if (summary) {
          usage = summary;
          renderUsage();
        }
      });
    });
    head.append(name, plan);
    const meters = el('div', 'ag-settings-meters');
    const day = el('div', 'ag-settings-usage-day');
    const models = el('div', 'ag-settings-usage-models');
    const updated = el('div', 'ag-settings-usage-updated');
    block.append(head, meters, day, models, updated);
    usageSection.body.appendChild(block);
    usageBlocks.set(agent, { plan, meters, day, models, updated });
  }

  body.append(connection.root, defaults.root, calibration.root, usageSection.root);

  // ── 상태 → DOM ────────────────────────────────────────

  function commitPrefs(partial: Partial<AgentPrefs>): void {
    prefs = saveAgentPrefs(partial);
    syncPrefsInputs();
    applyDefaults(prefs);
  }

  function syncPrefsInputs(): void {
    agentField.select.value = prefs.defaultAgent;
    fillSelect(
      modelField.select,
      modelsForAgent(prefs.defaultAgent).map((model) => ({ id: model.id, label: model.label })),
    );
    modelField.select.value = resolveModelForAgent(prefs.defaultAgent, prefs.defaultModel);
    fillSelect(
      effortField.select,
      effortsForAgent(prefs.defaultAgent, prefs.defaultModel).map((effort) => ({
        id: effort.id,
        label: effort.label,
      })),
    );
    effortField.select.value = resolveEffortForAgent(
      prefs.defaultAgent,
      prefs.defaultEffort,
      prefs.defaultModel,
    );
    permissionField.select.value = prefs.defaultPermissionProfile;
  }

  function renderCurrentSelection(): void {
    const current = getSelection();
    const permission = current.permission === 'unrestricted' ? '전체 접근' : '안전';
    currentLine.textContent =
      `현재 대화: ${AGENT_LABEL[current.agent]} · ${labelForModel(current.agent, current.model)} · ${permission}`;
  }

  function renderConnection(): void {
    hubDot.dataset.state = connectionState;
    hubLabel.textContent = CONN_LABEL[connectionState];
    hubReconnect.disabled = connectionState === 'connected';
    const online = connectionState === 'connected';
    refreshBtn.disabled = !online;
    restartBtn.disabled = !online;
  }

  function renderProviders(): void {
    for (const agent of AGENTS) {
      const row = providerRows.get(agent);
      if (!row) continue;
      const health = providers?.[agent] ?? null;
      if (!health) {
        row.dot.dataset.state = 'unknown';
        row.detail.textContent = connectionState === 'connected' ? '확인 중…' : '허브에 연결되면 확인해요';
        continue;
      }
      row.dot.dataset.state = health.available ? 'connected' : 'disconnected';
      row.detail.textContent = health.available
        ? (health.version ?? '설치됨')
        : (health.error ?? '실행할 수 없어요');
    }
  }

  function renderWritingStyle(): void {
    if (writingStyle?.active) {
      const language = writingStyle.language === 'en' ? 'English' : '한국어';
      const date = formatShortDate(writingStyle.updatedAt);
      const parts = [`보정됨 · ${language}`, `문서 ${writingStyle.sourceCount}개`];
      if (date) parts.push(date);
      calibrationStatus.textContent = parts.join(' · ');
      calibrationSummary.textContent = writingStyle.summary ?? '';
      calibrationSummary.hidden = !writingStyle.summary;
      calibrationBtn.textContent = '다시 보정';
      return;
    }
    calibrationStatus.textContent = '아직 보정되지 않았어요';
    calibrationSummary.hidden = true;
    calibrationBtn.textContent = '보정 시작';
  }

  function buildMeter(
    label: string,
    window_: UsageWindow | null,
    limit: number | null,
    actual: boolean,
  ): HTMLElement {
    const row = el('div', 'ag-settings-meter');
    const head = el('div', 'ag-settings-meter-head');
    const hasLimit = limit !== null && limit > 0;
    const percent = window_ && (actual || hasLimit)
      ? (window_.percent ?? (hasLimit ? (window_.weightedTokens / limit!) * 100 : null))
      : null;
    let value: string;
    if (!window_) value = '기록 없음';
    else if (percent !== null && actual) {
      const reset = formatResetAt(window_.resetsAt);
      value = reset ? `${percent.toFixed(1)}% · ${reset}` : `${percent.toFixed(1)}%`;
    } else if (percent !== null) {
      value = `${percent.toFixed(1)}% · ${formatTokens(window_.weightedTokens)} / ${formatTokens(limit!)} 토큰`;
    } else {
      value = `${formatTokens(window_.weightedTokens)} 토큰 · ${window_.turns}턴`;
    }
    head.append(
      el('span', 'ag-settings-meter-label', label),
      el('span', 'ag-settings-meter-value', value),
    );
    row.appendChild(head);
    if (percent !== null) {
      if (percent >= METER_WARN_PERCENT) row.classList.add('ag-settings-meter-warn');
      const track = el('div', 'ag-settings-meter-track');
      const fill = el('div', 'ag-settings-meter-fill');
      // 100% 를 넘겨도 막대는 가득 찬 상태로 멈춘다.
      fill.style.width = `${Math.min(100, Math.max(0, percent)).toFixed(1)}%`;
      track.appendChild(fill);
      row.appendChild(track);
    }
    return row;
  }

  function buildModelRows(providerUsage: ProviderUsage | null, agent: AgentName): HTMLElement[] {
    const entries = Object.entries(providerUsage?.byModel ?? {});
    if (entries.length === 0) return [];
    entries.sort((a, b) => b[1].weightedTokens - a[1].weightedTokens);
    const rows: HTMLElement[] = [el('div', 'ag-settings-usage-models-title', '모델별')];
    for (const [model, stats] of entries) {
      const row = el('div', 'ag-settings-model-row');
      row.append(
        el('span', 'ag-settings-model-name', labelForModel(agent, model)),
        el('span', 'ag-settings-model-turns', `${stats.turns}턴`),
        el('span', 'ag-settings-model-tokens', `${formatTokens(stats.weightedTokens)} 토큰`),
      );
      rows.push(row);
    }
    return rows;
  }

  function cliproxyStatus(): CliproxyStatus | null {
    return usage?.cliproxy ?? null;
  }

  function renderCliproxy(): void {
    const status = cliproxyStatus();
    const configured = status?.configured === true;
    const connected = status?.connected === true;
    cliproxyDot.dataset.state = connected
      ? 'connected'
      : configured
        ? 'disconnected'
        : 'unknown';
    cliproxyState.textContent = connected
      ? (status?.url ?? '연결됨')
      : configured
        ? (status?.error ?? '연결 안 됨')
        : '연결 안 됨';
    cliproxyUrl.field.hidden = configured;
    cliproxyKey.field.hidden = configured;
    cliproxyConnect.hidden = configured;
    cliproxyRefresh.hidden = !configured;
    cliproxyDisconnect.hidden = !configured;
    cliproxyNote.textContent = configured
      ? (connected
        ? '공식 요금제 사용량이에요. 오늘·모델별 숫자는 이 앱에서 센 값이에요.'
        : '연결을 다시 확인하거나 관리 키를 다시 입력해 주세요.')
      : '연결하면 요금제의 실제 사용량을 보여줘요. 관리 키는 config.yaml 의 remote-management.secret-key 예요.';
    if (status?.url && !cliproxyUrl.input.value.trim()) cliproxyUrl.input.value = status.url;
    const message = status?.error ?? '';
    cliproxyError.textContent = message;
    cliproxyError.hidden = !message;
    cliproxyConnect.disabled = connectionState !== 'connected';
    cliproxyRefresh.disabled = connectionState !== 'connected';
    cliproxyDisconnect.disabled = connectionState !== 'connected';
  }

  function renderUsage(): void {
    renderCliproxy();
    for (const agent of AGENTS) {
      const ui = usageBlocks.get(agent);
      if (!ui) continue;
      const providerUsage = usage?.providers?.[agent] ?? null;
      const actual = providerUsage?.source === 'cliproxy';
      const plan = usage?.plans?.[agent] ?? DEFAULT_PLAN[agent];
      if (USAGE_PLANS[agent].some((option) => option.id === plan)) ui.plan.value = plan;
      ui.plan.hidden = actual;
      ui.meters.replaceChildren(
        buildMeter('5시간', providerUsage?.session ?? null, providerUsage?.limit.session5h ?? null, actual),
        buildMeter('주간', providerUsage?.week ?? null, providerUsage?.limit.week ?? null, actual),
      );
      const account = (usage?.cliproxy?.accounts ?? []).find((item) => item.agent === agent);
      const accountLine = actual && account
        ? [account.email ?? account.name, account.planType].filter(Boolean).join(' · ')
        : '';
      ui.day.textContent = providerUsage
        ? [
          `오늘 · ${formatTokens(providerUsage.day.weightedTokens)} 토큰 · ${providerUsage.day.turns}턴`,
          accountLine,
        ].filter(Boolean).join(' · ')
        : '오늘 · 기록 없음';
      ui.models.replaceChildren(...buildModelRows(providerUsage, agent));
      const stamp = providerUsage?.updatedAt
        ? `${formatRelativeTime(providerUsage.updatedAt)} 기록`
        : '';
      ui.updated.textContent = stamp
        ? `${stamp} · ${actual ? '실제' : '추정'}`
        : (actual ? '실제' : '추정');
    }
  }

  async function refreshProviders(refresh: boolean): Promise<void> {
    refreshBtn.disabled = true;
    const result = await bridge.requestProviderStatus(refresh);
    if (disposed) return;
    if (result) providers = result;
    renderConnection();
    renderProviders();
  }

  async function refreshUsage(refresh = false): Promise<void> {
    const result = await bridge.requestUsage(refresh);
    if (disposed) return;
    if (result) usage = result;
    renderUsage();
  }

  async function connectCliproxy(): Promise<void> {
    cliproxyConnect.disabled = true;
    cliproxyError.hidden = true;
    const result = await bridge.connectCliproxy(cliproxyUrl.input.value, cliproxyKey.input.value);
    if (disposed) return;
    cliproxyConnect.disabled = false;
    if (result) {
      usage = result;
      if (result.cliproxy?.connected) cliproxyKey.input.value = '';
      renderUsage();
      return;
    }
    cliproxyError.textContent = '연결하지 못했어요. 주소와 관리 키를 확인하세요.';
    cliproxyError.hidden = false;
  }

  async function disconnectCliproxy(): Promise<void> {
    cliproxyDisconnect.disabled = true;
    const result = await bridge.disconnectCliproxy();
    if (disposed) return;
    cliproxyDisconnect.disabled = false;
    if (result) usage = result;
    renderUsage();
  }

  syncPrefsInputs();
  renderCurrentSelection();
  renderConnection();
  renderProviders();
  renderWritingStyle();
  renderUsage();

  return {
    element,
    open(): void {
      prefs = loadAgentPrefs();
      connectionState = bridge.getConnectionState();
      syncPrefsInputs();
      renderCurrentSelection();
      renderConnection();
      renderProviders();
      renderWritingStyle();
      void refreshProviders(false);
      void refreshUsage();
    },
    close(): void {
      /* 닫을 때 정리할 타이머가 없다 — 상태는 이벤트로만 갱신된다. */
    },
    handleEvent(ev: SidebarEvent): void {
      switch (ev.type) {
        case 'connection':
          connectionState = ev.state;
          renderConnection();
          renderProviders();
          renderCliproxy();
          break;
        case 'provider-status':
          providers = ev.providers;
          renderProviders();
          break;
        case 'usage-report':
          usage = ev.usage;
          renderUsage();
          break;
        case 'writing-style-status':
        case 'writing-style-result':
          writingStyle = ev.status;
          renderWritingStyle();
          break;
        default:
          break;
      }
    },
    dispose(): void {
      disposed = true;
      element.remove();
    },
  };
}
