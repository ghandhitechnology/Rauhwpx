/** 설정 허브의 탐색과 AI·연결 목적지를 소유한다. 편집 설정은 전용 모듈이 맡는다. */
import './settings.css';

import {
  effortsForAgent,
  labelForModel,
  modelGroupsForAgent,
  resolveEffortForAgent,
  resolveModelForAgent,
  type AgentModelGroup,
} from '../../agent/models.ts';
import {
  loadAgentPrefs,
  normalizeAgentPrefs,
  trySaveAgentPrefs,
  type AgentPrefs,
} from '../../agent/agent-prefs.ts';
import { createIcon } from './icons.ts';
import { createEditingSettings } from './settings-editing.ts';
import { userSettings } from '../../core/user-settings.ts';
import {
  isSettingsDestination,
  type DirtyExitChoice,
  type EditorSettingsRuntime,
  type SettingsDestination,
} from './settings-contract.ts';
import {
  formatUniqueInstallCount,
  loadUniqueInstallSnapshot,
  uniqueInstallPublicUrl,
} from '../../unique-installs.ts';
import { AGENT_LABEL, createProviderIcon, PROVIDER_ORDER } from './providers.ts';
import {
  formatResetAt,
  formatShortDate,
  formatTokens,
  formatUsageAge,
  formatUsageReset,
} from './usage-format.ts';
import type { AgentBridge } from '../../agent/bridge.ts';
import type { EventBus } from '../../core/event-bus.ts';
import type {
  AgentName,
  AgentInstructionsDraft,
  AgentInstructionsStatus,
  AgentAuthMethod,
  AgentSetupStatusMap,
  PermissionProfile,
  PiCatalogModel,
  PiStatus,
  ProviderStatusMap,
  ProviderUsage,
  SidebarEvent,
  CliproxyStatus,
  UsageSummary,
  UsageWindow,
  WritingStyleStatus,
  DocumentTemplate,
} from '../../agent/types.ts';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';
type RauAuthFeedback = 'idle' | 'success';

/**
 * 요금제 셀렉트를 갖는 프로바이더 — 구독 한도가 있는 둘뿐이다.
 * pi 는 OpenRouter 잔액을, grok · cursor 는 API 사용량만 쓴다.
 */
type PlanAgent = 'claude' | 'codex';

const PLAN_AGENTS: readonly PlanAgent[] = ['claude', 'codex'];

/** 요금제도 잔액도 없는 프로바이더 — 기록된 토큰만 보여준다. */
const API_USAGE_AGENTS: readonly AgentName[] = ['grok', 'cursor'];

/** 설치 안내 — cursor 는 npm 이 아니라 공식 설치 스크립트로 받는다. */
const SETUP_INSTALL_NOTE: Record<AgentName, string> = {
  rau: '브라우저로 로그인하면 $5 체험 크레딧이 바로 연결됩니다.',
  claude: 'Claude CLI와 실행에 필요한 패키지를 앱 전용 폴더에 설치합니다.',
  codex: 'Codex CLI와 실행에 필요한 패키지를 앱 전용 폴더에 설치합니다.',
  pi: 'Pi 실행에 필요한 패키지를 앱 전용 폴더에 설치합니다.',
  grok: 'Grok CLI와 실행에 필요한 패키지를 앱 전용 폴더에 설치합니다.',
  cursor: 'Cursor CLI를 공식 설치 스크립트로 앱 전용 폴더에 설치합니다.',
};

/** API 키 입력칸 힌트 — 키 접두사가 있는 프로바이더만 형태를 보여준다. */
const API_KEY_PLACEHOLDER: Record<AgentName, string> = {
  rau: '',
  claude: 'sk-ant-…',
  codex: 'sk-proj-…',
  pi: 'sk-or-…',
  grok: 'xai-…',
  cursor: 'API 키',
};

const CONN_LABEL: Record<ConnectionState, string> = {
  connected: '연결됨',
  connecting: '연결 중',
  disconnected: '끊김',
  replaced: '다른 탭에서 사용 중',
};

const PERMISSION_OPTIONS: ReadonlyArray<{ id: PermissionProfile; label: string }> = [
  { id: 'safe', label: '안전 — 편집은 검토 후 승인, 파일은 프로젝트 안에서만' },
  { id: 'unrestricted', label: '전체 접근 — 자유 편집, 노트북 전체' },
];

/** 요금제 목록은 프로바이더마다 다르다 (허브의 한도 계산 기준). */
const USAGE_PLANS: Record<PlanAgent, ReadonlyArray<{ id: string; label: string }>> = {
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

const DEFAULT_PLAN: Record<PlanAgent, string> = { claude: 'pro', codex: 'plus' };

/** OpenRouter 가 받는 reasoning_effort 세 단계. */
const PI_EFFORT_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

/** 고를 수 있는 모델 수 상한 (허브도 같은 값으로 막는다). */
const PI_MODEL_MAX = 3;

/** 카탈로그는 수천 개다 — 한 번에 그리는 줄 수를 묶고 나머지는 검색으로 좁힌다. */
const PI_CATALOG_VISIBLE_MAX = 50;

const PI_PROGRESS_LABEL: Record<string, string> = {
  preparing: '준비하는 중…',
  downloading: '내려받는 중…',
  installing: '설치하는 중…',
  configuring: '설정하는 중…',
  verifying: '설치 확인 중…',
  done: '',
};

const INSTALL_PROGRESS_LABEL: Record<string, string> = {
  preparing: '준비하는 중…',
  resolving: '패키지 확인 중…',
  downloading: '내려받는 중…',
  installing: '설치하는 중…',
  configuring: '설정하는 중…',
  verifying: '설치 확인 중…',
  done: '설치 완료',
};

const INSTALL_PROGRESS_CEILING: Record<string, number> = {
  preparing: 18,
  resolving: 27,
  downloading: 58,
  installing: 86,
  configuring: 95,
  verifying: 99,
  done: 100,
};

const UNRESTRICTED_DEFAULT_WARNING =
  '전체 접근을 기본값으로 두면 새 대화가 열릴 때부터 에이전트가 승인 없이 문서를 편집하고, 명령과 파일 도구가 노트북 전체에 닿습니다. 계속할까요?';

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

/** OpenRouter 가격은 토큰당이라 100만 토큰 기준으로 바꿔 읽는다. */
function pricePerMillion(perToken: number): number {
  return Number.isFinite(perToken) ? perToken * 1_000_000 : 0;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** Provider usage cards use one compact token unit. */
function formatCompactTokens(value: number): string {
  return `${formatTokens(value).toLowerCase()} tok`;
}

function formatUsageWindow(label: string, window_: UsageWindow | null): string {
  if (!window_) return `${label} | No usage`;
  return `${label} | ${window_.turns}calls | ${formatCompactTokens(window_.weightedTokens)}`;
}

function formatUsageUpdated(timestamp: number | null | undefined): string {
  return timestamp ? `Updated ${formatUsageAge(timestamp)}` : '';
}

function createToggleRow(
  label: string,
  description?: string,
): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = el('label', 'ag-settings-control-row ag-settings-toggle-row');
  const copy = el('span', 'ag-settings-control-copy');
  copy.append(el('span', 'ag-settings-control-label', label));
  if (description) {
    copy.append(el('span', 'ag-settings-control-description', description));
  }
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'ag-settings-toggle-input';
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  const track = el('span', 'ag-settings-toggle-track');
  track.setAttribute('aria-hidden', 'true');
  root.append(copy, input, track);
  return { root, input };
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

/** 라벨 있는 그룹은 optgroup 으로 묶는다 — cursor 의 구독/API 과금 풀 구분. */
function fillSelectGrouped(
  select: HTMLSelectElement,
  groups: ReadonlyArray<AgentModelGroup>,
): void {
  const previous = select.value;
  select.replaceChildren();
  for (const group of groups) {
    let parent: HTMLSelectElement | HTMLOptGroupElement = select;
    if (group.label) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      select.appendChild(optgroup);
      parent = optgroup;
    }
    for (const option of group.options) {
      const node = document.createElement('option');
      node.value = option.id;
      node.textContent = option.label;
      parent.appendChild(node);
    }
  }
  const ids = groups.flatMap((group) => group.options.map((option) => option.id));
  if (ids.includes(previous)) select.value = previous;
}

/** pi 마법사의 네 단계 (+ 완료 요약). */
type PiStep = 'install' | 'key' | 'catalog' | 'naming' | 'summary';

/** 고르는 중인 모델 한 줄 — 저장 전까지만 산다. */
interface PiDraftModel {
  id: string;
  name: string;
  reasoning: boolean;
  effort: string;
}

export interface SettingsPanelDeps {
  bridge: AgentBridge;
  eventBus?: EventBus;
  editorRuntime: EditorSettingsRuntime;
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
  open(destination?: SettingsDestination): void;
  close(): void;
  requestClose(): Promise<boolean>;
  isDirty(): boolean;
  /** 첫 실행 마법사 카드에서도 같은 설치/로그인 모달을 연다. */
  openAgentSetup(agent: AgentName): void;
  /**
   * 모달을 연 뒤 허브 상태에 따라 설치 또는 대표 OAuth 를 바로 시작한다.
   * 이미 로그인된 프로바이더는 완료 화면만 보여 준다.
   */
  beginAgentConnect(agent: AgentName): void;
  handleEvent(ev: SidebarEvent): void;
  dispose(): void;
}

export function createSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const {
    bridge,
    eventBus,
    editorRuntime,
    getSelection,
    applyDefaults,
    openCalibration,
    reconnectSession,
  } = deps;

  let disposed = false;
  let prefs: AgentPrefs = loadAgentPrefs();
  let prefsBaseline: AgentPrefs = { ...prefs };
  let prefsDraft: AgentPrefs = { ...prefs };
  let connectionState: ConnectionState = bridge.getConnectionState();
  let providers: ProviderStatusMap | null = null;
  let usage: UsageSummary | null = null;
  let writingStyle: WritingStyleStatus | null = null;
  let agentInstructions: AgentInstructionsStatus | null = null;
  let pendingAgentInstructionsDraft: AgentInstructionsDraft | null = null;
  let instructionsDraftRevision = 0;
  let instructionsDirty = false;
  let instructionsBusy = false;
  let aiPrefsSaving = false;
  let instructionsProposalBusy = false;
  let instructionsMessage = '';
  let currentDestination: SettingsDestination = 'editing';
  let lastDestination: SettingsDestination = 'editing';
  try {
    const storedDestination = sessionStorage.getItem('rhwp-settings-destination');
    if (isSettingsDestination(storedDestination)) {
      currentDestination = storedDestination;
      lastDestination = storedDestination;
    }
  } catch {
    // 세션 저장소가 없어도 기본 목적지로 계속 진행한다.
  }
  let templates: DocumentTemplate[] = [];
  let templatesBusy = false;
  let templatesMessage = '';
  let setupStatuses: AgentSetupStatusMap | null = null;
  let setupAgent: AgentName | null = null;
  let setupBusy = false;
  let setupMessage = '';
  let setupReauth = false;
  let setupCodePending = false;
  /** 브라우저 로그인이 진행 중인 동안 카드에 직접 그릴 인증 주소와 기기 코드. */
  let setupOauthPending = false;
  let rauOauthFlowInProgress = false;
  let rauAuthFeedback: RauAuthFeedback = 'idle';
  let rauAuthFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let setupAuthUrl: string | null = null;
  let setupUserCode: string | null = null;
  let setupAuthRunId: string | null = null;
  let setupCopyResetTimer: ReturnType<typeof setTimeout> | null = null;
  let setupProgressPercent = 0;
  let setupProgressLabel = '';
  let setupProgressPhase = '';
  let setupProgressCreepTimer: ReturnType<typeof setInterval> | null = null;
  let setupProgressResetTimer: ReturnType<typeof setTimeout> | null = null;
  const openedAuthUrls = new Set<string>();

  // pi 마법사 상태 — 한 장의 카드가 단계를 갈아 끼운다.
  let piStatus: PiStatus | null = null;
  let piCatalog: PiCatalogModel[] = [];
  let piCatalogLoading = false;
  /** 한 번 실패한 목록을 렌더마다 다시 부르지 않게 막는다. */
  let piCatalogTried = false;
  /** 사용자가 되돌아간 단계 (없으면 상태에서 단계를 유도한다). */
  let piStepOverride: PiStep | null = null;
  let piBusy = false;
  let piMessage = '';
  let piProgress = '';
  let piProgressPercent = 0;
  let piProgressPhase = '';
  let piProgressCreepTimer: ReturnType<typeof setInterval> | null = null;
  /** 활동 신호가 끊기면 움직이는 막대를 멈추는 타이머. */
  let piActivityPause: ReturnType<typeof setTimeout> | null = null;
  let piDraft: PiDraftModel[] = [];
  /** 이름 칸이 지금 물고 있는 초안 — 같은 객체면 다시 세우지 않는다. */
  let piNamingRendered: readonly PiDraftModel[] = [];

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
    element.dispatchEvent(new CustomEvent('ag-settings-close-request', { bubbles: true }));
  });
  header.append(title, close);

  const layout = el('div', 'ag-settings-layout');
  const navigation = el('nav', 'ag-settings-nav');
  navigation.setAttribute('aria-label', '설정 범주');
  navigation.setAttribute('role', 'tablist');
  const body = el('div', 'ag-settings-body');
  const panes = new Map<SettingsDestination, HTMLElement>();
  const navButtons = new Map<SettingsDestination, HTMLButtonElement>();
  const destinations: ReadonlyArray<{ id: SettingsDestination; label: string }> = [
    { id: 'editing', label: '편집' },
    { id: 'ai', label: 'AI 설정' },
    { id: 'connections', label: 'AI 연결' },
    { id: 'product', label: '제품' },
  ];
  for (const destination of destinations) {
    const button = el('button', 'ag-settings-nav-button', destination.label);
    button.type = 'button';
    button.id = `ag-settings-tab-${destination.id}`;
    button.dataset.destination = destination.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `ag-settings-pane-${destination.id}`);
    const pane = el('section', 'ag-settings-pane');
    pane.id = `ag-settings-pane-${destination.id}`;
    pane.dataset.destination = destination.id;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', button.id);
    navigation.appendChild(button);
    panes.set(destination.id, pane);
    navButtons.set(destination.id, button);
  }
  layout.append(navigation, body);
  body.append(...panes.values());
  element.append(header, layout);

  let shellReady = false;
  const editingSettings = createEditingSettings({
    eventBus,
    runtime: editorRuntime,
    onDirtyChange: () => {
      if (shellReady) renderDestinationState();
    },
  });
  panes.get('editing')?.appendChild(editingSettings.element);

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
    { dot: HTMLElement; detail: HTMLElement; setup: HTMLButtonElement }
  >();
  const providerList = el('div', 'ag-settings-provider-list');
  for (const agent of PROVIDER_ORDER) {
    const row = el('div', 'ag-settings-row ag-settings-provider-row');
    row.dataset.agent = agent;
    const dot = el('span', 'ag-settings-dot');
    dot.setAttribute('aria-hidden', 'true');
    const text = el('div', 'ag-settings-row-text');
    const name = el('span', 'ag-settings-row-name');
    name.append(createProviderIcon(agent), document.createTextNode(AGENT_LABEL[agent]));
    const detail = el('span', 'ag-settings-row-detail', '확인 중…');
    text.append(name, detail);
    const setup = el('button', 'ag-settings-btn ag-provider-setup-btn', '설정');
    setup.type = 'button';
    setup.addEventListener('click', () => openAgentSetup(agent));
    row.append(dot, text, setup);
    providerList.appendChild(row);
    providerRows.set(agent, { dot, detail, setup });
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

  // ── Pi 모달 흐름 ──────────────────────────────────────
  // 설치 → 로그인 → 모델 → 요약으로 모습을 바꾸며, 설정 페이지에는 직접 붙지 않는다.
  const piCard = el('div', 'ag-pi-card');
  const piHead = el('div', 'ag-pi-head');
  const piHeadName = el('span', 'ag-settings-row-name');
  piHeadName.append(createProviderIcon('pi'), document.createTextNode('Pi'));
  const piHeadDetail = el('span', 'ag-settings-row-detail', '확인 중…');
  piHead.append(piHeadName, piHeadDetail);
  const piMessageLine = el('p', 'ag-settings-cliproxy-error');
  piMessageLine.hidden = true;

  // 1단계 — 설치
  const piInstallStep = el('div', 'ag-pi-step');
  const piInstallNote = el('p', 'ag-settings-note', 'OpenRouter 모델로 문서를 고치는 Pi 에이전트예요.');
  const piInstallBtn = el('button', 'ag-settings-primary ag-pi-logo-btn');
  piInstallBtn.type = 'button';
  piInstallBtn.append(createProviderIcon('pi'), el('span', '', 'Pi 연결'));
  const piProgressLine = el('p', 'ag-settings-note');
  piProgressLine.hidden = true;
  // 내려받기 진행 막대 — 크기를 알면 채움 폭, 모르면 신호가 올 때만 흐르는 줄무늬.
  const piProgressTrack = el('div', 'ag-settings-meter-track ag-pi-progress');
  const piProgressFill = el('div', 'ag-settings-meter-fill');
  piProgressTrack.appendChild(piProgressFill);
  piProgressTrack.hidden = true;
  piInstallStep.append(piInstallNote, piInstallBtn, piProgressTrack, piProgressLine);

  // 2단계 — OpenRouter 키
  const piKeyStep = el('div', 'ag-pi-step');
  const piKeyNote = el('p', 'ag-settings-note', 'OpenRouter 계정으로 로그인하거나 API 키를 직접 연결하세요.');
  const piOauth = el('button', 'ag-settings-primary ag-agent-auth-choice');
  piOauth.type = 'button';
  piOauth.append(el('strong', '', '브라우저로 로그인'), el('span', '', 'OpenRouter OAuth'));
  const piAuthDivider = el('div', 'ag-agent-auth-divider', '또는 API 키');
  const piKeyInput = createTextField('OpenRouter 키', {
    type: 'password',
    placeholder: 'sk-or-v1-…',
    autocomplete: 'new-password',
  });
  const piKeyActions = el('div', 'ag-settings-actions');
  const piKeySubmit = el('button', 'ag-settings-primary', '연결');
  piKeySubmit.type = 'button';
  const piKeyCancel = el('button', 'ag-settings-btn', '취소');
  piKeyCancel.type = 'button';
  piKeyActions.append(piKeySubmit, piKeyCancel);
  piKeyStep.append(piKeyNote, piOauth, piAuthDivider, piKeyInput.field, piKeyActions);

  // 3단계 — 카탈로그에서 모델 고르기
  const piCatalogStep = el('div', 'ag-pi-step');
  const piSearch = createTextField('모델 검색', { placeholder: '이름 · 제공자 · 모델 id' });
  const piChips = el('div', 'ag-pi-chips');
  const piList = el('div', 'ag-pi-catalog');
  const piCatalogNote = el('p', 'ag-settings-note');
  const piCatalogActions = el('div', 'ag-settings-actions');
  const piCatalogNext = el('button', 'ag-settings-primary', '다음');
  piCatalogNext.type = 'button';
  const piCatalogRefresh = el('button', 'ag-settings-btn', '목록 새로고침');
  piCatalogRefresh.type = 'button';
  const piCatalogCancel = el('button', 'ag-settings-btn', '취소');
  piCatalogCancel.type = 'button';
  piCatalogActions.append(piCatalogNext, piCatalogRefresh, piCatalogCancel);
  piCatalogStep.append(piSearch.field, piChips, piList, piCatalogNote, piCatalogActions);

  // 4단계 — 이름 짓기 + 기본 강도
  const piNamingStep = el('div', 'ag-pi-step');
  const piNamingNote = el('p', 'ag-settings-note', '사이드바에 보일 이름이에요.');
  const piNamingRows = el('div', 'ag-pi-naming');
  const piNamingActions = el('div', 'ag-settings-actions');
  const piNamingSave = el('button', 'ag-settings-primary', '저장');
  piNamingSave.type = 'button';
  const piNamingBack = el('button', 'ag-settings-btn', '뒤로');
  piNamingBack.type = 'button';
  piNamingActions.append(piNamingSave, piNamingBack);
  piNamingStep.append(piNamingNote, piNamingRows, piNamingActions);

  // 완료 — 요약
  const piSummaryStep = el('div', 'ag-pi-step');
  const piSummaryModels = el('div', 'ag-pi-summary-models');
  const piSummaryKey = el('p', 'ag-settings-note');
  const piSummaryActions = el('div', 'ag-settings-actions');
  const piRepick = el('button', 'ag-settings-btn', '모델 다시 고르기');
  piRepick.type = 'button';
  const piRekey = el('button', 'ag-settings-btn', '로그인 방식 변경');
  piRekey.type = 'button';
  piSummaryActions.append(piRepick, piRekey);
  piSummaryStep.append(piSummaryModels, piSummaryKey, piSummaryActions);

  piCard.append(
    piHead,
    piMessageLine,
    piInstallStep,
    piKeyStep,
    piCatalogStep,
    piNamingStep,
    piSummaryStep,
  );

  const piSteps: ReadonlyArray<[PiStep, HTMLElement]> = [
    ['install', piInstallStep],
    ['key', piKeyStep],
    ['catalog', piCatalogStep],
    ['naming', piNamingStep],
    ['summary', piSummaryStep],
  ];

  // 에이전트 설치/로그인은 설정 페이지를 떠나지 않는 모달 한 장에서 끝낸다.
  const setupOverlay = el('div', 'ag-agent-setup-overlay');
  setupOverlay.setAttribute('aria-hidden', 'true');
  const setupDialog = el('section', 'ag-agent-setup-dialog');
  setupDialog.setAttribute('role', 'dialog');
  setupDialog.setAttribute('aria-modal', 'true');
  setupDialog.setAttribute('aria-labelledby', 'ag-agent-setup-title');
  setupDialog.tabIndex = -1;
  const setupChrome = el('header', 'ag-agent-setup-chrome');
  const setupTitleWrap = el('div', 'ag-agent-setup-title-wrap');
  const setupEyebrow = el('span', 'ag-agent-setup-eyebrow', '에이전트 연결');
  const setupTitle = el('h2', 'ag-agent-setup-title');
  setupTitle.id = 'ag-agent-setup-title';
  setupTitleWrap.append(setupEyebrow, setupTitle);
  const setupClose = el('button', 'ag-agent-setup-close');
  setupClose.type = 'button';
  setupClose.setAttribute('aria-label', '설정 닫기');
  setupClose.appendChild(createIcon('close'));
  setupChrome.append(setupTitleWrap, setupClose);
  const setupBody = el('div', 'ag-agent-setup-body');
  const setupGeneric = el('div', 'ag-agent-setup-generic');
  const setupHero = el('div', 'ag-agent-setup-hero');
  const setupHeroIcon = el('div', 'ag-agent-setup-hero-icon');
  const setupHeroCopy = el('div', 'ag-agent-setup-hero-copy');
  const setupHeroTitle = el('strong', 'ag-agent-setup-hero-title');
  setupHeroCopy.append(setupHeroTitle);
  setupHero.append(setupHeroIcon, setupHeroCopy);
  const setupProgress = el('div', 'ag-agent-setup-progress');
  setupProgress.setAttribute('role', 'progressbar');
  setupProgress.setAttribute('aria-valuemin', '0');
  setupProgress.setAttribute('aria-valuemax', '100');
  const setupProgressFill = el('span', '');
  setupProgress.appendChild(setupProgressFill);
  setupProgress.hidden = true;
  const setupProgressLine = el('p', 'ag-agent-setup-progress-label');
  setupProgressLine.hidden = true;
  const setupError = el('p', 'ag-agent-setup-error');
  setupError.hidden = true;

  const setupInstallPane = el('div', 'ag-agent-setup-pane');
  const setupInstallNote = el('p', 'ag-agent-setup-copy');
  const setupInstall = el('button', 'ag-agent-setup-primary', '설치하고 계속');
  setupInstall.type = 'button';
  setupInstallPane.append(setupInstallNote, setupInstall);

  const setupAuthPane = el('div', 'ag-agent-setup-pane');
  const setupAuthHeading = el('h3', 'ag-agent-setup-section-title', '로그인 방법');
  const setupOauth = el('button', 'ag-agent-auth-card');
  setupOauth.type = 'button';
  setupOauth.append(el('strong', '', '브라우저로 로그인'), el('span', '', '구독 계정 또는 웹 계정 연결'));
  const setupApiToggle = el('button', 'ag-agent-auth-card');
  setupApiToggle.type = 'button';
  setupApiToggle.append(el('strong', '', 'API 키 입력'), el('span', '', '사용량 기반 API 결제'));
  const setupKeyBox = el('div', 'ag-agent-key-box');
  setupKeyBox.hidden = true;
  const setupKey = createTextField('API 키', { type: 'password', autocomplete: 'new-password' });
  const setupKeySubmit = el('button', 'ag-agent-setup-primary', '키 연결');
  setupKeySubmit.type = 'button';
  setupKeyBox.append(setupKey.field, setupKeySubmit);
  // 브라우저 로그인 상자 — 팝업이 막혀도 주소와 기기 코드를 카드 안에서 직접 준다.
  const setupLoginBox = el('div', 'ag-agent-login-box');
  setupLoginBox.hidden = true;
  const setupAuthUrlRow = el('div', 'ag-agent-login-url-row');
  setupAuthUrlRow.hidden = true;
  const setupAuthLink = el('a', 'ag-agent-login-url');
  setupAuthLink.target = '_blank';
  setupAuthLink.rel = 'noopener noreferrer';
  const setupAuthActions = el('div', 'ag-agent-login-actions');
  const setupAuthOpen = el('button', 'ag-settings-btn', '브라우저에서 열기');
  setupAuthOpen.type = 'button';
  const setupAuthCopy = el('button', 'ag-settings-btn', '주소 복사');
  setupAuthCopy.type = 'button';
  setupAuthActions.append(setupAuthOpen, setupAuthCopy);
  setupAuthUrlRow.append(setupAuthLink, setupAuthActions);
  const setupUserCodeRow = el('div', 'ag-agent-login-code');
  setupUserCodeRow.hidden = true;
  const setupUserCodeValue = el('strong', 'ag-agent-login-code-value');
  const setupUserCodeCopy = el('button', 'ag-settings-btn', '코드 복사');
  setupUserCodeCopy.type = 'button';
  const setupUserCodeCaption = el(
    'p',
    'ag-agent-login-caption',
    '브라우저에서 이 코드를 확인해 주세요.',
  );
  setupUserCodeRow.append(setupUserCodeValue, setupUserCodeCopy, setupUserCodeCaption);
  const setupLoginWait = el(
    'p',
    'ag-agent-login-wait',
    '브라우저에서 로그인을 마치면 자동으로 완료돼요.',
  );
  const setupLoginCancel = el('button', 'ag-settings-btn ag-agent-login-cancel', '로그인 취소');
  setupLoginCancel.type = 'button';
  setupLoginBox.append(setupAuthUrlRow, setupUserCodeRow, setupLoginWait, setupLoginCancel);
  const setupCodeBox = el('div', 'ag-agent-key-box');
  setupCodeBox.hidden = true;
  const setupCodeNote = el('p', 'ag-agent-setup-copy', '브라우저에서 로그인하면 인증 코드가 표시됩니다. 코드를 붙여넣어 주세요.');
  const setupCode = createTextField('인증 코드', { autocomplete: 'off' });
  const setupCodeSubmit = el('button', 'ag-agent-setup-primary', '코드 확인');
  setupCodeSubmit.type = 'button';
  setupCodeBox.append(setupCodeNote, setupCode.field, setupCodeSubmit);
  setupAuthPane.append(
    setupAuthHeading,
    setupOauth,
    setupApiToggle,
    setupKeyBox,
    setupLoginBox,
    setupCodeBox,
  );

  const setupRauAuthFeedback = el('div', 'ag-agent-setup-auth-feedback');
  setupRauAuthFeedback.hidden = true;
  setupRauAuthFeedback.setAttribute('role', 'status');
  setupRauAuthFeedback.setAttribute('aria-live', 'polite');
  const setupRauAuthFeedbackMark = el('span', 'ag-agent-setup-auth-feedback-mark', '✓');
  setupRauAuthFeedbackMark.setAttribute('aria-hidden', 'true');
  const setupRauAuthFeedbackCopy = el('div', 'ag-agent-setup-auth-feedback-copy');
  setupRauAuthFeedbackCopy.append(
    el('strong', '', '로그인이 완료되었습니다'),
    el('span', '', '계정을 확인하고 계속하세요.'),
  );
  setupRauAuthFeedback.append(setupRauAuthFeedbackMark, setupRauAuthFeedbackCopy);

  // Rau 전용 계정 카드 — 로그인한 계정과 체험 크레딧 잔량을 한 장에 보여 준다.
  const setupAccountPane = el('div', 'ag-agent-setup-account');
  setupAccountPane.hidden = true;
  const setupAccountTitle = el('h3', 'ag-agent-setup-section-title', '로그인된 계정');
  const setupAccountEmail = el('p', 'ag-agent-setup-account-email');
  const setupAccountRows = el('div', 'ag-agent-setup-account-rows');
  const setupAccountEmpty = el('p', 'ag-settings-note', '체험 크레딧을 다 썼어요. 다른 모델을 연결해 주세요.');
  setupAccountEmpty.hidden = true;
  setupAccountPane.append(setupAccountTitle, setupAccountEmail, setupAccountRows, setupAccountEmpty);

  const setupDonePane = el('div', 'ag-agent-setup-pane ag-agent-setup-done');
  const setupDoneMark = el('span', 'ag-agent-setup-done-mark', '✓');
  const setupDoneTitle = el('strong', '', '연결되었습니다');
  const setupDoneDetail = el('p', 'ag-agent-setup-copy');
  const setupDoneClose = el('button', 'ag-agent-setup-primary', '완료');
  setupDoneClose.type = 'button';
  const setupDoneChange = el('button', 'ag-settings-btn', '로그인 방식 변경');
  setupDoneChange.type = 'button';
  const setupDoneDisconnect = el('button', 'ag-settings-btn', '로그아웃');
  setupDoneDisconnect.type = 'button';
  setupDoneDisconnect.hidden = true;
  setupDonePane.append(setupDoneMark, setupDoneTitle, setupDoneDetail, setupDoneChange, setupDoneDisconnect, setupDoneClose);

  setupGeneric.append(
    setupHero,
    setupRauAuthFeedback,
    setupAccountPane,
    setupProgress,
    setupProgressLine,
    setupError,
    setupInstallPane,
    setupAuthPane,
    setupDonePane,
  );
  setupDialog.append(setupChrome, setupBody);
  setupOverlay.appendChild(setupDialog);

  setupInstall.addEventListener('click', () => void installSelectedAgent());
  setupOauth.addEventListener('click', () => void startSetupAuth('oauth'));
  setupApiToggle.addEventListener('click', () => {
    setupKeyBox.hidden = false;
    setupKey.input.focus();
  });
  setupKeySubmit.addEventListener('click', () => void startSetupAuth('api-key'));
  setupKey.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void startSetupAuth('api-key');
    }
  });
  // 직접 클릭 안에서 여는 창은 팝업 차단에 걸리지 않는다.
  setupAuthOpen.addEventListener('click', () => {
    if (!setupAuthUrl) return;
    openedAuthUrls.add(setupAuthUrl);
    window.open(setupAuthUrl, '_blank', 'noopener,noreferrer');
  });
  setupAuthCopy.addEventListener('click', () => {
    if (setupAuthUrl) void copySetupText(setupAuthUrl, setupAuthCopy, '주소 복사');
  });
  setupUserCodeCopy.addEventListener('click', () => {
    if (setupUserCode) void copySetupText(setupUserCode, setupUserCodeCopy, '코드 복사');
  });
  setupLoginCancel.addEventListener('click', () => {
    if (setupAgent && setupAuthRunId) bridge.cancelAgentSetup(setupAgent, setupAuthRunId);
    setupBusy = false;
    setupCodePending = false;
    resetRauAuthFeedback();
    clearSetupAuthPrompt();
    renderAgentSetup();
  });
  setupCodeSubmit.addEventListener('click', submitSetupAuthCode);
  setupCode.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSetupAuthCode();
    }
  });
  setupCode.input.addEventListener('input', () => {
    setupCodeSubmit.disabled = connectionState !== 'connected' || !setupCode.input.value.trim();
  });
  setupClose.addEventListener('click', closeAgentSetup);
  setupDoneClose.addEventListener('click', closeAgentSetup);
  setupDoneChange.addEventListener('click', () => {
    setupReauth = true;
    setupMessage = '';
    renderAgentSetup();
  });
  setupDoneDisconnect.addEventListener('click', () => {
    void disconnectRau();
  });
  setupOverlay.addEventListener('pointerdown', (event) => {
    if (event.target === setupOverlay) closeAgentSetup();
  });
  setupOverlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAgentSetup();
  });

  piInstallBtn.addEventListener('click', () => void runPiInstall());
  piOauth.addEventListener('click', () => void startSetupAuth('oauth'));
  piKeySubmit.addEventListener('click', () => void submitPiKey());
  piKeyInput.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitPiKey();
    }
  });
  piKeyCancel.addEventListener('click', () => {
    piKeyInput.input.value = '';
    piStepOverride = null;
    piMessage = '';
    renderPi();
  });
  piSearch.input.addEventListener('input', () => renderPiCatalogList());
  piCatalogRefresh.addEventListener('click', () => void loadPiCatalog(true));
  piCatalogNext.addEventListener('click', () => {
    if (piDraft.length === 0) return;
    piStepOverride = 'naming';
    piMessage = '';
    renderPi();
  });
  piCatalogCancel.addEventListener('click', () => {
    piStepOverride = null;
    piMessage = '';
    renderPi();
  });
  piNamingBack.addEventListener('click', () => {
    piStepOverride = 'catalog';
    renderPi();
  });
  piNamingSave.addEventListener('click', () => void savePiModels());
  piRepick.addEventListener('click', () => {
    piDraft = (piStatus?.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      effort: model.defaultEffort,
    }));
    piSearch.input.value = '';
    piStepOverride = 'catalog';
    piMessage = '';
    renderPi();
    void loadPiCatalog(false);
  });
  piRekey.addEventListener('click', () => {
    piKeyInput.input.value = '';
    piStepOverride = 'key';
    piMessage = '';
    renderPi();
    piKeyInput.input.focus();
  });

  // ── 2. 기본 설정 ──────────────────────────────────────
  const defaults = createSection('기본 설정');
  const agentField = createSelect('기본 제공자', selectableAgents().map(
    (agent) => ({ id: agent, label: AGENT_LABEL[agent] }),
  ));
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
    const value = agentField.select.value;
    const agent = PROVIDER_ORDER.find((name) => name === value) ?? 'claude';
    stagePrefs({ defaultAgent: agent });
  });
  modelField.select.addEventListener('change', () => {
    stagePrefs({ defaultModel: modelField.select.value });
  });
  effortField.select.addEventListener('change', () => {
    stagePrefs({ defaultEffort: effortField.select.value });
  });
  permissionField.select.addEventListener('change', () => {
    const next: PermissionProfile =
      permissionField.select.value === 'unrestricted' ? 'unrestricted' : 'safe';
    stagePrefs({ defaultPermissionProfile: next });
  });

  // ── 4. 지시 ──────────────────────────────────────────
  const instructionsSection = createSection('지시');
  const instructionsEditor = document.createElement('textarea');
  instructionsEditor.className = 'ag-settings-instructions-editor';
  instructionsEditor.rows = 11;
  instructionsEditor.spellcheck = false;
  instructionsEditor.placeholder = 'AGENTS.md를 불러오는 중…';
  instructionsEditor.setAttribute('aria-label', '앱 전용 AGENTS.md 지시');
  const instructionsStatus = el('p', 'ag-settings-instructions-status');
  instructionsStatus.hidden = true;
  const instructionsProposal = el('div', 'ag-settings-instructions-proposal');
  instructionsProposal.hidden = true;
  const instructionsProposalTitle = el('strong', 'ag-settings-instructions-proposal-title', '에이전트 변경안');
  const instructionsProposalMeta = el('p', 'ag-settings-note');
  const instructionsProposalReason = el('p', 'ag-settings-instructions-proposal-reason');
  const instructionsProposalPreview = el('pre', 'ag-settings-instructions-proposal-preview');
  const instructionsProposalActions = el('div', 'ag-settings-actions');
  const instructionsProposalConfirm = el('button', 'ag-settings-primary', '변경안 적용');
  instructionsProposalConfirm.type = 'button';
  const instructionsProposalReject = el('button', 'ag-settings-btn', '거절');
  instructionsProposalReject.type = 'button';
  instructionsProposalActions.append(instructionsProposalConfirm, instructionsProposalReject);
  instructionsProposal.append(
    instructionsProposalTitle,
    instructionsProposalMeta,
    instructionsProposalReason,
    instructionsProposalPreview,
    instructionsProposalActions,
  );
  const instructionsActions = el('div', 'ag-settings-actions');
  const instructionsReload = el('button', 'ag-settings-btn', '다시 불러오기');
  instructionsReload.type = 'button';
  instructionsActions.append(instructionsReload);
  const hancomGit = createToggleRow('한컴용 Git 사용하기 (beta)');
  hancomGit.input.checked = userSettings.getUseHancomGit();
  hancomGit.input.addEventListener('change', () => {
    userSettings.setUseHancomGit(hancomGit.input.checked);
  });
  const unsubscribeHancomGit = userSettings.subscribeUseHancomGit((enabled) => {
    hancomGit.input.checked = enabled;
  });
  instructionsSection.body.append(
    instructionsProposal,
    instructionsEditor,
    instructionsStatus,
    instructionsActions,
    hancomGit.root,
  );

  instructionsEditor.addEventListener('input', () => {
    instructionsDirty = instructionsEditor.value !== (agentInstructions?.content ?? '');
    instructionsMessage = '';
    renderAgentInstructions();
    renderDestinationState();
  });
  instructionsProposalConfirm.addEventListener('click', () => void confirmAgentInstructionsDraft());
  instructionsProposalReject.addEventListener('click', () => void rejectAgentInstructionsDraft());
  instructionsReload.addEventListener('click', () => {
    if (instructionsDirty && !window.confirm('작성 중인 지시 변경을 버리고 다시 불러올까요?')) return;
    instructionsDirty = false;
    instructionsMessage = '';
    void refreshAgentInstructions(true);
  });

  // ── 5. 글쓰기 보정 ────────────────────────────────────
  const calibration = createSection('글쓰기 보정');
  const calibrationStatus = el('p', 'ag-settings-status', '아직 보정되지 않았어요');
  const calibrationSummary = el('p', 'ag-settings-note');
  calibrationSummary.hidden = true;
  const calibrationBtn = el('button', 'ag-settings-primary', '보정 시작');
  calibrationBtn.type = 'button';
  calibrationBtn.addEventListener('click', () => openCalibration());
  calibration.body.append(calibrationStatus, calibrationSummary, calibrationBtn);

  // ── 6. 템플릿 ─────────────────────────────────────────
  const templatesSection = createSection('템플릿');
  const templatesNote = el('p', 'ag-settings-note', '채팅에서는 /templates로 선택하세요.');
  const templatesList = el('div', 'ag-template-list');
  const templatesStatus = el('p', 'ag-settings-cliproxy-error');
  templatesStatus.hidden = true;
  const addTemplateInput = document.createElement('input');
  addTemplateInput.type = 'file';
  addTemplateInput.accept = '.hwp,.hwpx';
  addTemplateInput.hidden = true;
  const replaceTemplateInput = document.createElement('input');
  replaceTemplateInput.type = 'file';
  replaceTemplateInput.accept = '.hwp,.hwpx';
  replaceTemplateInput.hidden = true;
  let replacingTemplateId: string | null = null;
  const addTemplateBtn = el('button', 'ag-settings-primary', '템플릿 추가');
  addTemplateBtn.type = 'button';
  addTemplateBtn.addEventListener('click', () => addTemplateInput.click());
  addTemplateInput.addEventListener('change', () => {
    const file = addTemplateInput.files?.[0];
    addTemplateInput.value = '';
    if (file) void promptToAddTemplate(file);
  });
  replaceTemplateInput.addEventListener('change', () => {
    const file = replaceTemplateInput.files?.[0];
    const id = replacingTemplateId;
    replaceTemplateInput.value = '';
    replacingTemplateId = null;
    if (file && id) void replaceTemplate(id, file);
  });
  templatesSection.body.append(templatesNote, templatesList, templatesStatus, addTemplateBtn, addTemplateInput, replaceTemplateInput);

  // Electron's native browser prompt is unreliable, so add and rename share
  // a small in-app naming dialog.
  const templateNameOverlay = el('div', 'ag-template-name-overlay');
  templateNameOverlay.setAttribute('aria-hidden', 'true');
  const templateNameDialog = document.createElement('form');
  templateNameDialog.className = 'ag-template-name-dialog';
  templateNameDialog.setAttribute('role', 'dialog');
  templateNameDialog.setAttribute('aria-modal', 'true');
  templateNameDialog.setAttribute('aria-labelledby', 'ag-template-name-title');
  const templateNameTitle = el('h2', 'ag-template-name-title');
  templateNameTitle.id = 'ag-template-name-title';
  const templateNameDescription = el('p', 'ag-settings-note');
  const templateNameInput = document.createElement('input');
  templateNameInput.className = 'ag-template-name-input';
  templateNameInput.type = 'text';
  templateNameInput.maxLength = 80;
  templateNameInput.required = true;
  templateNameInput.autocomplete = 'off';
  templateNameInput.setAttribute('aria-label', '템플릿 이름');
  const templateNameActions = el('div', 'ag-template-name-actions');
  const templateNameCancel = el('button', 'ag-settings-btn', '취소');
  templateNameCancel.type = 'button';
  const templateNameSave = el('button', 'ag-settings-primary', '저장');
  templateNameSave.type = 'submit';
  templateNameActions.append(templateNameCancel, templateNameSave);
  templateNameDialog.append(templateNameTitle, templateNameDescription, templateNameInput, templateNameActions);
  templateNameOverlay.appendChild(templateNameDialog);
  let resolveTemplateName: ((name: string | null) => void) | null = null;

  templateNameDialog.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = templateNameInput.value.trim();
    if (!name) {
      templateNameInput.setCustomValidity('템플릿 이름을 입력하세요.');
      templateNameInput.reportValidity();
      return;
    }
    finishTemplateName(name);
  });
  templateNameInput.addEventListener('input', () => templateNameInput.setCustomValidity(''));
  templateNameCancel.addEventListener('click', () => finishTemplateName(null));
  templateNameOverlay.addEventListener('pointerdown', (event) => {
    if (event.target === templateNameOverlay) finishTemplateName(null);
  });
  templateNameOverlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') finishTemplateName(null);
  });

  // ── 7. 사용량 ─────────────────────────────────────────
  const usageSection = createSection('사용량');

  // rau 를 섹션 맨 위에 둔다 — 체험 크레딧 상태가 첫눈에 보이는 자리다.
  const rauUsageBlock = el('div', 'ag-settings-usage-block');
  rauUsageBlock.dataset.agent = 'rau';
  const rauUsageHead = el('div', 'ag-settings-usage-head');
  const rauUsageName = el('span', 'ag-settings-row-name');
  rauUsageName.append(createProviderIcon('rau'), document.createTextNode(AGENT_LABEL.rau));
  const rauUsageCredits = el('span', 'ag-settings-row-detail');
  rauUsageHead.append(rauUsageName, rauUsageCredits);
  const rauUsageMeters = el('div', 'ag-settings-meters');
  const rauUsageEmpty = el('p', 'ag-settings-note', '체험 크레딧을 다 썼어요. 다른 모델을 연결해 주세요.');
  rauUsageEmpty.hidden = true;
  const rauUsageDay = el('div', 'ag-settings-usage-day');
  const rauUsageWeek = el('div', 'ag-settings-usage-day');
  const rauUsageModels = el('div', 'ag-settings-usage-models');
  const rauUsageUpdated = el('div', 'ag-settings-usage-updated');
  rauUsageBlock.append(rauUsageHead, rauUsageMeters, rauUsageEmpty, rauUsageDay, rauUsageWeek, rauUsageModels, rauUsageUpdated);
  usageSection.body.appendChild(rauUsageBlock);

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
    PlanAgent,
    {
      plan: HTMLSelectElement;
      meters: HTMLElement;
      day: HTMLElement;
      models: HTMLElement;
      updated: HTMLElement;
    }
  >();
  for (const agent of PLAN_AGENTS) {
    const block = el('div', 'ag-settings-usage-block');
    block.dataset.agent = agent;
    const head = el('div', 'ag-settings-usage-head');
    const name = el('span', 'ag-settings-row-name');
    name.append(createProviderIcon(agent), document.createTextNode(AGENT_LABEL[agent]));
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

  // pi 는 요금제가 없다 — 대신 OpenRouter 잔액과 누적 토큰을 보여준다.
  const piUsageBlock = el('div', 'ag-settings-usage-block');
  piUsageBlock.dataset.agent = 'pi';
  const piUsageHead = el('div', 'ag-settings-usage-head');
  const piUsageName = el('span', 'ag-settings-row-name');
  piUsageName.append(createProviderIcon('pi'), document.createTextNode(AGENT_LABEL.pi));
  const piUsageCredits = el('span', 'ag-settings-row-detail');
  piUsageHead.append(piUsageName, piUsageCredits);
  const piUsageDay = el('div', 'ag-settings-usage-day');
  const piUsageWeek = el('div', 'ag-settings-usage-day');
  const piUsageModels = el('div', 'ag-settings-usage-models');
  const piUsageUpdated = el('div', 'ag-settings-usage-updated');
  piUsageBlock.append(piUsageHead, piUsageDay, piUsageWeek, piUsageModels, piUsageUpdated);
  usageSection.body.appendChild(piUsageBlock);

  // grok · cursor 는 요금제도 잔액도 없다 — 허브가 기록한 세션 · 오늘 · 주간 토큰을 그대로 보여준다.
  const apiUsageBlocks = new Map<
    AgentName,
    {
      root: HTMLElement;
      session: HTMLElement;
      day: HTMLElement;
      week: HTMLElement;
      models: HTMLElement;
      updated: HTMLElement;
    }
  >();
  for (const agent of API_USAGE_AGENTS) {
    const block = el('div', 'ag-settings-usage-block');
    block.dataset.agent = agent;
    const head = el('div', 'ag-settings-usage-head');
    const name = el('span', 'ag-settings-row-name');
    name.append(createProviderIcon(agent), document.createTextNode(AGENT_LABEL[agent]));
    head.append(name);
    const session = el('div', 'ag-settings-usage-day');
    const day = el('div', 'ag-settings-usage-day');
    const week = el('div', 'ag-settings-usage-day');
    const models = el('div', 'ag-settings-usage-models');
    const updated = el('div', 'ag-settings-usage-updated');
    block.append(head, session, day, week, models, updated);
    usageSection.body.appendChild(block);
    apiUsageBlocks.set(agent, { root: block, session, day, week, models, updated });
  }
  usageSection.body.appendChild(cliproxyCard);

  const aiStatus = el('p', 'ag-settings-apply-status');
  aiStatus.hidden = true;
  aiStatus.setAttribute('role', 'status');
  const aiCancel = el('button', 'ag-settings-btn', '취소');
  aiCancel.type = 'button';
  const aiApply = el('button', 'ag-settings-primary', '적용');
  aiApply.type = 'button';
  const aiFooter = el('div', 'ag-settings-apply-footer');
  aiFooter.append(aiStatus, aiCancel, aiApply);
  const aiContent = el('div', 'ag-settings-destination-content');
  aiContent.append(calibration.root, instructionsSection.root, defaults.root, templatesSection.root, aiFooter);
  panes.get('ai')?.appendChild(aiContent);

  const connectionContent = el('div', 'ag-settings-destination-content');
  connectionContent.append(connection.root, usageSection.root);
  panes.get('connections')?.appendChild(connectionContent);

  const productSection = createSection('고유 설치');
  const productCount = el('p', 'ag-unique-install-count', '집계를 불러오는 중…');
  productCount.setAttribute('data-testid', 'unique-install-count');
  const productNote = el(
    'p',
    'ag-settings-note',
    '공식 macOS arm64·Windows x64 데스크톱 앱을 설치한 뒤 그 기기에서 처음 연 횟수입니다. 자동 업데이트와 GitHub 다운로드 수는 넣지 않습니다. 데스크톱 앱이 보낸 첫 실행 보고이며 기기 증명(attestation)은 아닙니다.',
  );
  const productPrivacy = el(
    'p',
    'ag-settings-note',
    '첫 실행 때 익명 설치 식별자, 앱 버전, OS, 아키텍처만 보냅니다. 이름, 이메일, 호스트 이름, 문서 경로는 보내지 않으며 IP는 신원으로 저장하지 않습니다. 전송에 실패해도 앱은 그대로 실행됩니다.',
  );
  const productUrl = el('p', 'ag-settings-note ag-unique-install-url', uniqueInstallPublicUrl());
  productSection.body.append(productCount, productNote, productPrivacy, productUrl);
  const productContent = el('div', 'ag-settings-destination-content');
  productContent.append(productSection.root);
  panes.get('product')?.appendChild(productContent);

  async function refreshUniqueInstalls(): Promise<void> {
    const snapshot = await loadUniqueInstallSnapshot();
    productUrl.textContent = uniqueInstallPublicUrl(snapshot);
    if (snapshot.uniqueInstalls == null) {
      productCount.textContent = snapshot.unavailable
        ? '집계를 불러오지 못했습니다'
        : '공개 주소에서 확인하세요';
      return;
    }
    productCount.textContent = formatUniqueInstallCount(snapshot.uniqueInstalls);
  }

  aiApply.addEventListener('click', () => void applyAiDraft());
  aiCancel.addEventListener('click', cancelAiDraft);
  for (const [destination, button] of navButtons) {
    button.addEventListener('click', () => void requestDestination(destination));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'
        && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const index = destinations.findIndex((item) => item.id === destination);
      const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const next = destinations[(index + delta + destinations.length) % destinations.length];
      if (next) void requestDestination(next.id);
    });
  }
  shellReady = true;

  setupKey.input.addEventListener('input', renderAgentSetup);

  // ── 상태 → DOM ────────────────────────────────────────

  function samePrefs(left: AgentPrefs, right: AgentPrefs): boolean {
    return left.defaultAgent === right.defaultAgent
      && left.defaultModel === right.defaultModel
      && left.defaultEffort === right.defaultEffort
      && left.defaultPermissionProfile === right.defaultPermissionProfile;
  }

  function isAiDirty(): boolean {
    return instructionsDirty || !samePrefs(prefsDraft, prefsBaseline);
  }

  function isCurrentDestinationDirty(): boolean {
    switch (currentDestination) {
      case 'editing':
        return editingSettings.isDirty();
      case 'ai':
        return isAiDirty();
      case 'connections':
      case 'product':
        return false;
      default: {
        const _exhaustive: never = currentDestination;
        return _exhaustive;
      }
    }
  }

  function renderDestinationState(): void {
    for (const destination of destinations) {
      const selected = destination.id === currentDestination;
      const button = navButtons.get(destination.id);
      const pane = panes.get(destination.id);
      button?.classList.toggle('ag-active', selected);
      button?.setAttribute('aria-selected', String(selected));
      button?.setAttribute('tabindex', selected ? '0' : '-1');
      if (pane) {
        pane.hidden = !selected;
        pane.inert = !selected;
      }
    }
    const dirty = isAiDirty();
    aiApply.disabled = !dirty || instructionsBusy || aiPrefsSaving;
    aiCancel.disabled = !dirty || instructionsBusy || aiPrefsSaving;
    agentField.select.disabled = aiPrefsSaving;
    modelField.select.disabled = aiPrefsSaving;
    effortField.select.disabled = aiPrefsSaving;
    permissionField.select.disabled = aiPrefsSaving;
  }

  function selectDestination(destination: SettingsDestination): void {
    currentDestination = destination;
    lastDestination = destination;
    try {
      sessionStorage.setItem('rhwp-settings-destination', destination);
    } catch {
      // 세션 저장소가 막혀도 설정 탐색은 계속 동작한다.
    }
    renderDestinationState();
    panes.get(destination)?.scrollTo({ top: 0 });
  }

  function stagePrefs(partial: Partial<AgentPrefs>): void {
    prefsDraft = normalizeAgentPrefs({ ...prefsDraft, ...partial });
    syncPrefsInputs();
    aiStatus.hidden = true;
    renderDestinationState();
  }

  function persistPrefs(
    nextPrefs: AgentPrefs,
    { preserveDraft = false }: { preserveDraft?: boolean } = {},
  ): ReturnType<typeof trySaveAgentPrefs> {
    const previousDraft = prefsDraft;
    const result = trySaveAgentPrefs(nextPrefs);
    if (result.ok) {
      prefs = result.value;
      prefsBaseline = { ...result.value };
      prefsDraft = preserveDraft
        ? {
          ...previousDraft,
          defaultAgent: result.value.defaultAgent,
          defaultModel: result.value.defaultModel,
        }
        : { ...result.value };
      applyDefaults(result.value);
    }
    return result;
  }

  async function applyAiDraft(): Promise<boolean> {
    const nextPrefs = normalizeAgentPrefs(prefsDraft);
    if (instructionsDirty) {
      const maxChars = agentInstructions?.maxChars ?? 30_000;
      if (!agentInstructions || instructionsEditor.value.length > maxChars) {
        instructionsMessage = 'AGENTS.md 내용을 확인한 뒤 다시 시도하세요.';
        renderAgentInstructions();
        return false;
      }
    }
    if (nextPrefs.defaultPermissionProfile === 'unrestricted'
      && prefsBaseline.defaultPermissionProfile !== 'unrestricted'
      && !window.confirm(UNRESTRICTED_DEFAULT_WARNING)) {
      aiStatus.textContent = '전체 접근 권한 적용을 취소했습니다.';
      aiStatus.hidden = false;
      return false;
    }
    if (instructionsDirty) {
      aiPrefsSaving = true;
      renderDestinationState();
      try {
        const savedInstructions = await saveAgentInstructions();
        if (!savedInstructions) return false;
      } finally {
        aiPrefsSaving = false;
        if (!disposed) renderDestinationState();
      }
    }
    if (!samePrefs(nextPrefs, prefsBaseline)) {
      const result = persistPrefs(nextPrefs);
      if (!result.ok) {
        prefsDraft = nextPrefs;
        aiStatus.textContent = `AI 기본값을 저장하지 못했습니다 · ${result.error}`;
        aiStatus.hidden = false;
        renderDestinationState();
        return false;
      }
    }
    aiStatus.textContent = 'AI 설정을 적용했습니다.';
    aiStatus.hidden = false;
    syncPrefsInputs();
    renderDestinationState();
    return true;
  }

  function cancelAiDraft(): void {
    prefsDraft = { ...prefsBaseline };
    if (agentInstructions) {
      instructionsEditor.value = agentInstructions.content;
      instructionsDraftRevision = agentInstructions.revision;
    }
    instructionsDirty = false;
    instructionsMessage = '';
    aiStatus.hidden = true;
    syncPrefsInputs();
    renderAgentInstructions();
    renderDestinationState();
  }

  function askDirtyExit(): Promise<DirtyExitChoice> {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const overlay = el('div', 'ag-settings-dirty-overlay');
    overlay.setAttribute('role', 'presentation');
    const dialog = el('div', 'ag-settings-dirty-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'ag-settings-dirty-title');
    dialog.setAttribute('aria-describedby', 'ag-settings-dirty-description');
    const dialogTitle = el('h2', 'ag-settings-dirty-title', '변경 사항을 적용할까요?');
    dialogTitle.id = 'ag-settings-dirty-title';
    const description = el(
      'p',
      'ag-settings-dirty-description',
      '적용하지 않은 설정이 있습니다. 이동하기 전에 처리해 주세요.',
    );
    description.id = 'ag-settings-dirty-description';
    const actions = el('div', 'ag-settings-dirty-actions');
    const applyButton = el('button', 'ag-settings-primary', '적용');
    applyButton.type = 'button';
    const discardButton = el('button', 'ag-settings-btn ag-settings-danger', '버리기');
    discardButton.type = 'button';
    const continueButton = el('button', 'ag-settings-btn', '계속 편집');
    continueButton.type = 'button';
    actions.append(applyButton, discardButton, continueButton);
    dialog.append(dialogTitle, description, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    return new Promise((resolve) => {
      const finish = (choice: DirtyExitChoice) => {
        overlay.remove();
        previousFocus?.focus();
        resolve(choice);
      };
      applyButton.addEventListener('click', () => finish('apply'));
      discardButton.addEventListener('click', () => finish('discard'));
      continueButton.addEventListener('click', () => finish('continue'));
      overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish('continue');
          return;
        }
        if (event.key !== 'Tab') return;
        const first = applyButton;
        const last = continueButton;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
      requestAnimationFrame(() => continueButton.focus());
    });
  }

  async function resolveDirtyExit(): Promise<boolean> {
    if (!isCurrentDestinationDirty()) return true;
    const choice = await askDirtyExit();
    if (choice === 'continue') return false;
    if (choice === 'discard') {
      switch (currentDestination) {
        case 'editing':
          editingSettings.cancel();
          return true;
        case 'ai':
          cancelAiDraft();
          return true;
        case 'connections':
        case 'product':
          return true;
        default: {
          const _exhaustive: never = currentDestination;
          return _exhaustive;
        }
      }
    }
    switch (currentDestination) {
      case 'editing':
        return editingSettings.apply();
      case 'ai':
        return applyAiDraft();
      case 'connections':
      case 'product':
        return true;
      default: {
        const _exhaustive: never = currentDestination;
        return _exhaustive;
      }
    }
  }

  async function requestDestination(destination: SettingsDestination): Promise<void> {
    if (destination === currentDestination) return;
    if (!await resolveDirtyExit()) return;
    selectDestination(destination);
    if (destination === 'product') void refreshUniqueInstalls();
    navButtons.get(destination)?.focus();
  }

  function templateSize(bytes: number): string {
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderTemplates(): void {
    templatesList.replaceChildren();
    if (templates.length === 0) {
      templatesList.appendChild(el('p', 'ag-settings-note', '추가된 템플릿이 없습니다.'));
    }
    for (const template of templates) {
      const row = el('div', 'ag-template-row');
      const text = el('div', 'ag-template-row-text');
      text.append(
        el('span', 'ag-settings-row-name', template.name),
        el('span', 'ag-settings-row-detail', `${template.format.toUpperCase()} · ${templateSize(template.size)} · ${template.pageCount}쪽 · r${template.revision}`),
      );
      const actions = el('div', 'ag-template-actions');
      const rename = el('button', 'ag-settings-btn', '이름 변경');
      rename.type = 'button';
      rename.addEventListener('click', () => {
        void requestTemplateName('템플릿 이름 변경', template.name, `현재 이름: ${template.name}`).then((name) => {
          if (name && name !== template.name) void renameTemplate(template.id, name);
        });
      });
      const replace = el('button', 'ag-settings-btn', '교체');
      replace.type = 'button';
      replace.addEventListener('click', () => {
        replacingTemplateId = template.id;
        replaceTemplateInput.click();
      });
      const remove = el('button', 'ag-settings-btn ag-template-delete', '삭제');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        if (window.confirm(`“${template.name}” 템플릿을 삭제할까요?`)) void deleteTemplate(template.id);
      });
      actions.append(rename, replace, remove);
      row.append(text, actions);
      templatesList.appendChild(row);
    }
    templatesStatus.textContent = templatesMessage;
    templatesStatus.hidden = !templatesMessage;
    addTemplateBtn.disabled = templatesBusy || connectionState !== 'connected';
    for (const button of templatesList.querySelectorAll('button')) (button as HTMLButtonElement).disabled = templatesBusy;
  }

  async function refreshTemplates(): Promise<void> {
    try {
      const catalog = await bridge.listTemplates();
      if (disposed) return;
      templates = catalog.templates;
      templatesMessage = '';
    } catch (error) {
      if (!disposed) templatesMessage = error instanceof Error ? error.message : String(error);
    }
    renderTemplates();
  }

  async function withTemplateMutation(operation: () => Promise<unknown>): Promise<void> {
    templatesBusy = true;
    templatesMessage = '';
    renderTemplates();
    try {
      await operation();
      await refreshTemplates();
    } catch (error) {
      templatesMessage = error instanceof Error ? error.message : String(error);
    } finally {
      templatesBusy = false;
      renderTemplates();
    }
  }

  function requestTemplateName(title: string, initialName: string, description: string): Promise<string | null> {
    finishTemplateName(null);
    templateNameTitle.textContent = title;
    templateNameDescription.textContent = description;
    templateNameInput.value = initialName;
    templateNameInput.setCustomValidity('');
    document.body.appendChild(templateNameOverlay);
    templateNameOverlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      templateNameOverlay.classList.add('ag-open');
      templateNameInput.focus();
      templateNameInput.select();
    });
    return new Promise((resolve) => {
      resolveTemplateName = resolve;
    });
  }

  function finishTemplateName(name: string | null): void {
    const resolve = resolveTemplateName;
    resolveTemplateName = null;
    templateNameOverlay.classList.remove('ag-open');
    templateNameOverlay.setAttribute('aria-hidden', 'true');
    templateNameOverlay.remove();
    resolve?.(name);
  }

  async function promptToAddTemplate(file: File): Promise<void> {
    const defaultName = file.name.replace(/\.(?:hwp|hwpx)$/i, '');
    const name = await requestTemplateName('템플릿 추가', defaultName, `선택한 파일: ${file.name}`);
    if (name) await addTemplate(file, name);
  }

  function addTemplate(file: File, name: string): Promise<void> {
    return withTemplateMutation(() => bridge.addTemplate(file, name));
  }

  function renameTemplate(id: string, name: string): Promise<void> {
    return withTemplateMutation(() => bridge.renameTemplate(id, name));
  }

  function replaceTemplate(id: string, file: File): Promise<void> {
    return withTemplateMutation(() => bridge.replaceTemplate(id, file));
  }

  function deleteTemplate(id: string): Promise<void> {
    return withTemplateMutation(() => bridge.deleteTemplate(id));
  }

  /** 설정이 끝나기 전의 pi · rau 는 기본 제공자 후보에서 빠진다. */
  function selectableAgents(): readonly AgentName[] {
    return PROVIDER_ORDER.filter((agent) => {
      if (agent === 'pi') return piStatus?.setupComplete === true;
      if (agent === 'rau') return setupStatuses?.rau?.setupComplete === true;
      return true;
    });
  }

  function syncPrefsInputs(): void {
    fillSelect(
      agentField.select,
      selectableAgents().map((agent) => ({ id: agent, label: AGENT_LABEL[agent] })),
    );
    agentField.select.value = prefsDraft.defaultAgent;
    fillSelectGrouped(modelField.select, modelGroupsForAgent(prefsDraft.defaultAgent));
    modelField.select.value = resolveModelForAgent(prefsDraft.defaultAgent, prefsDraft.defaultModel);
    const effortOptions = effortsForAgent(prefsDraft.defaultAgent, prefsDraft.defaultModel);
    // 추론 강도가 없는 프로바이더(cursor 등)에서는 줄 자체를 접는다.
    effortField.field.hidden = effortOptions.length === 0;
    fillSelect(effortField.select, [...effortOptions].reverse());
    effortField.select.value = resolveEffortForAgent(
      prefsDraft.defaultAgent,
      prefsDraft.defaultEffort,
      prefsDraft.defaultModel,
    );
    permissionField.select.value = prefsDraft.defaultPermissionProfile;
  }

  function renderCurrentSelection(): void {
    const current = getSelection();
    const permission = current.permission === 'unrestricted' ? '전체 접근' : '안전';
    currentLine.textContent =
      `현재 대화: ${AGENT_LABEL[current.agent]} / ${labelForModel(current.agent, current.model)} / ${permission}`;
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
    for (const agent of PROVIDER_ORDER) {
      const row = providerRows.get(agent);
      if (!row) continue;
      const setup = setupStatuses?.[agent];
      const health = providers?.[agent] ?? null;
      const detected = health?.available === true || setup?.available === true;
      const configured = setup?.connected === true || setup?.setupComplete === true;
      row.setup.textContent = (agent === 'rau' ? configured : detected || configured) ? '재설정' : '설정';
      row.detail.classList.toggle('ag-update-required', setup?.updateRequired === true);
      if (setup?.updateRequired) {
        row.detail.textContent = '업데이트 필요';
        continue;
      }
      if (!health) {
        row.dot.dataset.state = 'unknown';
        row.detail.textContent = connectionState === 'connected' ? '확인 중…' : '허브에 연결되면 확인해요';
        continue;
      }
      if (agent === 'rau' && !configured) {
        row.dot.dataset.state = 'disconnected';
        row.detail.textContent = detected ? '로그인 필요' : (health.error ?? '실행할 수 없어요');
        continue;
      }
      row.dot.dataset.state = health.available ? 'connected' : 'disconnected';
      row.detail.textContent = health.available
        ? (health.version ?? '설치됨')
        : (health.error ?? '실행할 수 없어요');
    }
  }

  function maybeOpenAuthUrl(url: string | null | undefined): void {
    if (!url || openedAuthUrls.has(url)) return;
    openedAuthUrls.add(url);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /** 진행 중인 로그인의 주소·코드를 지운다. */
  function clearSetupAuthPrompt(): void {
    setupOauthPending = false;
    setupAuthUrl = null;
    setupUserCode = null;
    setupAuthRunId = null;
    if (setupCopyResetTimer) {
      clearTimeout(setupCopyResetTimer);
      setupCopyResetTimer = null;
    }
    setupAuthCopy.textContent = '주소 복사';
    setupUserCodeCopy.textContent = '코드 복사';
  }

  function resetRauAuthFeedback(): void {
    if (rauAuthFeedbackTimer) {
      clearTimeout(rauAuthFeedbackTimer);
      rauAuthFeedbackTimer = null;
    }
    rauOauthFlowInProgress = false;
    rauAuthFeedback = 'idle';
  }

  function showRauAuthSuccess(): void {
    if (rauAuthFeedbackTimer) clearTimeout(rauAuthFeedbackTimer);
    rauOauthFlowInProgress = false;
    rauAuthFeedback = 'success';
    rauAuthFeedbackTimer = setTimeout(() => {
      rauAuthFeedbackTimer = null;
      rauAuthFeedback = 'idle';
      renderAgentSetup();
    }, 1800);
  }

  /**
   * 보안 컨텍스트(https·localhost)가 아니면 navigator.clipboard 자체가 없습니다.
   * 원격 http 주소로 스튜디오를 여는 경우가 있어, 임시 textarea 로 한 번 더
   * 시도하고 그것마저 막히면 실패를 버튼에 알립니다.
   */
  async function writeClipboardText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // 아래 폴백으로 넘어갑니다.
    }
    return copyTextByExecCommand(text);
  }

  function copyTextByExecCommand(text: string): boolean {
    const holder = document.createElement('textarea');
    holder.value = text;
    holder.setAttribute('readonly', '');
    holder.style.position = 'fixed';
    holder.style.top = '0';
    holder.style.left = '-9999px';
    holder.style.opacity = '0';
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(holder);
    let copied = false;
    try {
      holder.select();
      holder.setSelectionRange(0, text.length);
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    holder.remove();
    previous?.focus();
    return copied;
  }

  async function copySetupText(text: string, button: HTMLButtonElement, label: string): Promise<void> {
    const copied = await writeClipboardText(text);
    if (setupCopyResetTimer) clearTimeout(setupCopyResetTimer);
    setupAuthCopy.textContent = '주소 복사';
    setupUserCodeCopy.textContent = '코드 복사';
    button.textContent = copied ? '복사됨' : '복사 실패';
    setupCopyResetTimer = setTimeout(() => {
      setupCopyResetTimer = null;
      button.textContent = label;
    }, 1600);
  }

  function isAgentLoggedIn(agent: AgentName): boolean {
    if (agent === 'pi' && piStatus?.setupComplete === true) return true;
    const status = setupStatuses?.[agent];
    return status?.connected === true || status?.setupComplete === true || status?.authenticated === true;
  }

  function isAgentInstalled(agent: AgentName): boolean {
    const status = setupStatuses?.[agent];
    const health = providers?.[agent];
    return health?.available === true || status?.available === true || status?.installed === true;
  }

  async function continueAgentConnect(agent: AgentName): Promise<void> {
    await refreshSetupStatuses();
    if (agent === 'rau') {
      if (disposed || setupAgent !== agent) return;
      renderAgentSetup();
      if (connectionState !== 'connected') return;
      if (isAgentLoggedIn(agent)) return;
      await startSetupAuth('oauth');
      return;
    }
    if (agent === 'pi') {
      try {
        const next = await bridge.requestPiStatus();
        if (next) piStatus = next;
      } catch {
        // 설치 여부는 아래 상태로 판단한다.
      }
    }
    if (disposed || setupAgent !== agent) return;
    renderAgentSetup();
    if (connectionState !== 'connected') return;
    if (isAgentLoggedIn(agent)) return;
    if (isAgentInstalled(agent) || (agent === 'pi' && piStatus?.installed === true)) {
      setupReauth = true;
      await startSetupAuth('oauth');
      return;
    }
    await installSelectedAgent();
    if (disposed || setupAgent !== agent) return;
    if (isAgentLoggedIn(agent)) return;
    if (isAgentInstalled(agent) || (agent === 'pi' && piStatus?.installed === true)) {
      setupReauth = true;
      await startSetupAuth('oauth');
    }
  }

  function beginAgentConnect(agent: AgentName): void {
    openAgentSetup(agent);
    void continueAgentConnect(agent);
  }

  function openAgentSetup(agent: AgentName): void {
    setupAgent = agent;
    setupMessage = '';
    setupBusy = false;
    setupReauth = false;
    setupCodePending = false;
    resetRauAuthFeedback();
    clearSetupAuthPrompt();
    resetSetupInstallProgress();
    setupKey.input.value = '';
    setupKeyBox.hidden = true;
    setupCode.input.value = '';
    setupCodeBox.hidden = true;
    document.body.appendChild(setupOverlay);
    setupOverlay.setAttribute('aria-hidden', 'false');
    renderAgentSetup();
    requestAnimationFrame(() => {
      setupOverlay.classList.add('ag-open');
      setupDialog.focus();
    });
    void refreshSetupStatuses();
    if (agent === 'pi') void refreshPiStatus();
  }

  function closeAgentSetup(): void {
    if (!setupOverlay.isConnected) return;
    if (setupBusy && setupAgent && setupAuthRunId) {
      bridge.cancelAgentSetup(setupAgent, setupAuthRunId);
    }
    setupBusy = false;
    resetRauAuthFeedback();
    clearSetupAuthPrompt();
    setupOverlay.classList.remove('ag-open');
    setupOverlay.setAttribute('aria-hidden', 'true');
    resetSetupInstallProgress();
    window.setTimeout(() => setupOverlay.remove(), 180);
  }

  function resetSetupInstallProgress(): void {
    if (setupProgressResetTimer) {
      clearTimeout(setupProgressResetTimer);
      setupProgressResetTimer = null;
    }
    if (setupProgressCreepTimer) {
      clearInterval(setupProgressCreepTimer);
      setupProgressCreepTimer = null;
    }
    setupProgressPercent = 0;
    setupProgressLabel = '';
    setupProgressPhase = '';
    setupProgressFill.style.width = '0%';
    setupProgress.removeAttribute('aria-valuenow');
    setupProgress.removeAttribute('aria-valuetext');
  }

  function paintSetupInstallProgress(): void {
    setupProgressFill.style.width = `${setupProgressPercent.toFixed(2)}%`;
    setupProgress.setAttribute('aria-valuenow', String(Math.round(setupProgressPercent)));
    setupProgress.setAttribute('aria-valuetext', `${setupProgressLabel} ${Math.floor(setupProgressPercent)}%`);
    setupProgressLine.textContent = `${setupProgressLabel} · ${Math.floor(setupProgressPercent)}%`;
  }

  function ensureSetupProgressCreep(): void {
    if (setupProgressCreepTimer) return;
    setupProgressCreepTimer = setInterval(() => {
      const ceiling = INSTALL_PROGRESS_CEILING[setupProgressPhase] ?? setupProgressPercent;
      if (setupProgressPercent >= ceiling || setupProgressPercent >= 100) return;
      setupProgressPercent = Math.min(
        ceiling,
        setupProgressPercent + Math.max(0.08, (ceiling - setupProgressPercent) * 0.018),
      );
      paintSetupInstallProgress();
    }, 100);
  }

  function setSetupInstallProgress(percent: number, phase = 'installing'): void {
    if (setupProgressResetTimer) {
      clearTimeout(setupProgressResetTimer);
      setupProgressResetTimer = null;
    }
    setupProgressPercent = Math.max(setupProgressPercent, Math.min(100, Math.max(0, percent)));
    setupProgressPhase = phase;
    setupProgressLabel = INSTALL_PROGRESS_LABEL[phase] ?? INSTALL_PROGRESS_LABEL.installing;
    paintSetupInstallProgress();
    if (setupProgressPercent >= 100) {
      if (setupProgressCreepTimer) {
        clearInterval(setupProgressCreepTimer);
        setupProgressCreepTimer = null;
      }
      setupProgressResetTimer = setTimeout(() => {
        setupProgressResetTimer = null;
        setupProgressPercent = 0;
        setupProgressLabel = '';
        setupProgressFill.style.width = '0%';
        renderAgentSetup();
      }, 650);
    } else {
      ensureSetupProgressCreep();
    }
  }

  /**
   * 다시 그릴 때 방금 누른 버튼이 사라지면(로그인 취소·코드 확인 등) 포커스가
   * <body> 로 떨어지고, Esc 를 받는 덮개 밖이라 키보드로 카드를 닫을 수 없게
   * 됩니다. 포커스가 빠져나간 경우에만 카드로 되돌립니다.
   */
  function restoreSetupFocus(): void {
    if (!setupOverlay.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    setupDialog.focus();
  }

  function renderAgentSetup(): void {
    if (!setupAgent) return;
    const agent = setupAgent;
    setupTitle.textContent = `${AGENT_LABEL[agent]} 설정`;
    setupBody.replaceChildren(agent === 'pi' ? piCard : setupGeneric);
    if (agent === 'pi') {
      piBusy = setupBusy;
      if (setupMessage) piMessage = setupMessage;
      renderPi();
      restoreSetupFocus();
      return;
    }
    const status = setupStatuses?.[agent] ?? null;
    const detected = providers?.[agent]?.available === true;
    const available = detected || status?.available === true || status?.installed === true;
    // Rau 런타임 설치 여부는 로그인 상태가 아니다. 로그아웃 뒤 남은 바이너리 때문에
    // 연결된 화면으로 돌아가지 않도록 허브가 확인한 키 상태만 신뢰한다.
    const configured = status?.connected === true || status?.setupComplete === true;
    const connected = agent === 'rau' ? configured : detected || configured;
    setupHeroIcon.replaceChildren(createProviderIcon(agent));
    setupHeroTitle.textContent = AGENT_LABEL[agent];
    setupInstallNote.textContent = SETUP_INSTALL_NOTE[agent];
    setupKey.input.placeholder = API_KEY_PLACEHOLDER[agent];
    const oauthTitle = setupOauth.querySelector('strong');
    const oauthDetail = setupOauth.querySelector('span');
    if (agent === 'rau') {
      if (oauthTitle) oauthTitle.textContent = 'Rau로 시작';
      if (oauthDetail) oauthDetail.textContent = '브라우저 로그인 · $5 체험 크레딧';
      setupInstallPane.hidden = true;
      setupApiToggle.hidden = true;
      setupKeyBox.hidden = true;
      setupAuthPane.hidden = connected && !setupReauth;
    } else {
      if (oauthTitle) oauthTitle.textContent = '브라우저로 로그인';
      if (oauthDetail) oauthDetail.textContent = '구독 계정 또는 웹 계정 연결';
      setupApiToggle.hidden = false;
      setupInstallPane.hidden = available;
      setupAuthPane.hidden = !available || (connected && !setupReauth);
    }
    setupDonePane.hidden = !connected || setupReauth;
    setupDonePane.classList.toggle('ag-agent-setup-rau-actions', agent === 'rau' && connected && !setupReauth);
    setupDoneClose.textContent = agent === 'rau' && rauAuthFeedback === 'success' ? '계속' : '완료';
    setupDoneChange.hidden = agent === 'rau';
    setupDoneDisconnect.hidden = agent !== 'rau' || !connected || setupReauth;
    setupDoneDetail.textContent = status?.authMethod === 'api-key' && status.keyTail
      ? `API 키 ****${status.keyTail}`
      : status?.authenticated
        ? `${AGENT_LABEL[agent]} 웹 계정으로 로그인했습니다.`
        : `${AGENT_LABEL[agent]} CLI 연결이 확인되었습니다.`;
    setupRauAuthFeedback.hidden = agent !== 'rau' || rauAuthFeedback !== 'success';
    renderRauAccount();
    setupError.textContent = setupMessage;
    setupError.hidden = !setupMessage;
    setupProgress.hidden = setupProgressPercent <= 0;
    setupProgressLine.hidden = setupProgressPercent <= 0;
    setupProgressLine.textContent = setupProgressPercent > 0
      ? `${setupProgressLabel} · ${Math.floor(setupProgressPercent)}%`
      : '';
    setupInstall.disabled = setupBusy || connectionState !== 'connected';
    const authBusyElsewhere = status?.authenticating === true && status.authOwnedByThisSession !== true;
    setupOauth.disabled = setupBusy || authBusyElsewhere || connectionState !== 'connected';
    setupApiToggle.disabled = setupBusy || authBusyElsewhere || connectionState !== 'connected';
    setupKeySubmit.disabled = setupBusy || !setupKey.input.value.trim();
    renderSetupLoginBox();
    setupCodeBox.hidden = (agent !== 'claude' && agent !== 'rau') || !setupCodePending || !setupBusy;
    setupCodeNote.textContent = agent === 'rau'
      ? '브라우저에 표시된 12자리 반환 코드를 붙여넣어 주세요.'
      : '브라우저에서 로그인하면 인증 코드가 표시됩니다. 코드를 붙여넣어 주세요.';
    setupCodeSubmit.disabled = connectionState !== 'connected' || !setupCode.input.value.trim();
    restoreSetupFocus();
  }

  /** 브라우저 로그인이 도는 동안만 주소·코드 상자를 세운다. */
  function renderSetupLoginBox(): void {
    const authorizing = setupOauthPending && setupBusy;
    setupLoginBox.hidden = !authorizing;
    setupAuthUrlRow.hidden = !setupAuthUrl;
    if (setupAuthUrl) {
      setupAuthLink.href = setupAuthUrl;
      setupAuthLink.textContent = setupAuthUrl;
      setupAuthLink.title = setupAuthUrl;
    }
    setupUserCodeRow.hidden = !setupUserCode;
    if (setupUserCode) setupUserCodeValue.textContent = setupUserCode;
    setupUserCodeCaption.textContent = setupAgent === 'rau'
      ? '브라우저에 같은 연결 코드가 표시되는지 확인해 주세요.'
      : '브라우저에서 이 코드를 확인해 주세요.';
  }

  async function refreshSetupStatuses(): Promise<void> {
    const statuses = await bridge.requestAgentSetupStatus();
    if (disposed || !statuses) return;
    setupStatuses = statuses;
    renderProviders();
    renderAgentSetup();
    renderUsage();
  }

  async function installSelectedAgent(): Promise<void> {
    if (!setupAgent || setupBusy) return;
    if (setupAgent === 'pi') {
      await runPiInstall();
      return;
    }
    setupBusy = true;
    setupMessage = '';
    resetSetupInstallProgress();
    setSetupInstallProgress(8, 'preparing');
    renderAgentSetup();
    const statuses = await bridge.installAgent(setupAgent);
    if (disposed) return;
    setupBusy = false;
    if (statuses) setupStatuses = statuses;
    else if (!setupMessage) setupMessage = '설치를 완료하지 못했어요.';
    renderAgentSetup();
    renderProviders();
  }

  async function disconnectRau(): Promise<void> {
    if (setupBusy || connectionState !== 'connected') return;
    resetRauAuthFeedback();
    setupBusy = true;
    setupMessage = '';
    renderAgentSetup();
    const statuses = await bridge.disconnectAgent('rau');
    if (disposed) return;
    setupBusy = false;
    if (statuses) {
      setupStatuses = statuses;
      if (prefs.defaultAgent === 'rau' && statuses.rau?.setupComplete !== true) {
        const fallback = selectableAgents()[0] ?? 'claude';
        persistPrefs({
          ...prefs,
          defaultAgent: fallback,
          defaultModel: resolveModelForAgent(fallback, null),
        }, { preserveDraft: true });
      }
    } else if (!setupMessage) setupMessage = '이 기기 연결을 끊지 못했어요.';
    renderAgentSetup();
    renderProviders();
    renderUsage();
    syncPrefsInputs();
  }

  async function startSetupAuth(method: AgentAuthMethod): Promise<void> {
    if (!setupAgent || setupBusy) return;
    const keyInput = setupAgent === 'pi' ? piKeyInput.input : setupKey.input;
    const key = method === 'api-key' ? keyInput.value.trim() : '';
    if (method === 'api-key' && !key) return;
    resetRauAuthFeedback();
    rauOauthFlowInProgress = setupAgent === 'rau' && method === 'oauth';
    setupBusy = true;
    setupMessage = '';
    clearSetupAuthPrompt();
    setupOauthPending = method === 'oauth';
    resetSetupInstallProgress();
    if (setupAgent === 'pi') piMessage = '';
    renderAgentSetup();
    const started = await bridge.authenticateAgent(setupAgent, method, key || undefined);
    if (disposed) return;
    if (!started) {
      setupBusy = false;
      setupMessage = '로그인을 시작하지 못했어요.';
      resetRauAuthFeedback();
      clearSetupAuthPrompt();
      renderAgentSetup();
      return;
    }
    if (!started.authRunId) {
      setupBusy = false;
      setupMessage = '로그인 보안 정보를 받지 못했어요. 다시 시도해 주세요.';
      resetRauAuthFeedback();
      clearSetupAuthPrompt();
      renderAgentSetup();
      return;
    }
    setupAuthRunId = started.authRunId;
    keyInput.value = '';
    // pi 는 인증 주소를 시작 응답에만 실어 보낸다.
    if (method === 'oauth' && started.authUrl) setupAuthUrl = started.authUrl;
    if (method === 'oauth' && started.pairingCode) setupUserCode = started.pairingCode;
    if (method === 'oauth' && (setupAgent === 'claude' || setupAgent === 'rau')) {
      // claude 는 브라우저 로그인 뒤 표시되는 인증 코드를 CLI 에 넘겨야 로그인이 끝난다.
      setupCodePending = true;
      setupCode.input.value = '';
    }
    maybeOpenAuthUrl(started.authUrl);
    // 완료 상태는 agent-setup-status 이벤트로 온다. OAuth 동안 모달은 진행 상태를 유지한다.
    renderAgentSetup();
  }

  function submitSetupAuthCode(): void {
    const code = setupCode.input.value.trim();
    if (!code || !setupAuthRunId || (setupAgent !== 'claude' && setupAgent !== 'rau')
      || connectionState !== 'connected') return;
    bridge.submitAgentAuthCode(setupAgent, setupAuthRunId, code);
    setupCode.input.value = '';
    setupMessage = '';
    renderAgentSetup();
  }

  function renderWritingStyle(): void {
    if (writingStyle?.active) {
      const language = writingStyle.language === 'en' ? 'English' : '한국어';
      const date = formatShortDate(writingStyle.updatedAt);
      const parts = ['보정됨', language, `문서 ${writingStyle.sourceCount}개`];
      if (date) parts.push(date);
      calibrationStatus.textContent = parts.join(' / ');
      calibrationSummary.textContent = writingStyle.summary ?? '';
      calibrationSummary.hidden = !writingStyle.summary;
      calibrationBtn.textContent = '다시 보정';
      return;
    }
    calibrationStatus.textContent = '아직 보정되지 않았어요';
    calibrationSummary.hidden = true;
    calibrationBtn.textContent = '보정 시작';
  }

  /** 미터 행 DOM — 라벨·값·진행 막대. percent 가 null 이면 막대 없는 행이다. */
  function meterRow(label: string, value: string, percent: number | null): HTMLElement {
    const row = el('div', 'ag-settings-meter');
    const head = el('div', 'ag-settings-meter-head');
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

  function buildMeter(
    label: string,
    window_: UsageWindow | null,
    limit: number | null,
    actual: boolean,
  ): HTMLElement {
    const hasLimit = limit !== null && limit > 0;
    const percent = window_ && (actual || hasLimit)
      ? (window_.percent ?? (hasLimit ? (window_.weightedTokens / limit!) * 100 : null))
      : null;
    let value: string;
    if (!window_) value = 'No usage';
    else if (percent !== null && actual) {
      const reset = formatUsageReset(window_.resetsAt);
      value = reset ? `${percent.toFixed(1)}% | ${reset}` : `${percent.toFixed(1)}%`;
    } else if (percent !== null) {
      value = `${percent.toFixed(1)}% | ${formatCompactTokens(window_.weightedTokens)} / ${formatCompactTokens(limit!)}`;
    } else {
      value = `${window_.turns}calls | ${formatCompactTokens(window_.weightedTokens)}`;
    }
    return meterRow(label, value, percent);
  }

  function buildModelRows(providerUsage: ProviderUsage | null, agent: AgentName): HTMLElement[] {
    const entries = Object.entries(providerUsage?.byModel ?? {});
    if (entries.length === 0) return [];
    entries.sort((a, b) => b[1].weightedTokens - a[1].weightedTokens);
    const rows: HTMLElement[] = [el('div', 'ag-settings-usage-models-title', 'Models')];
    for (const [model, stats] of entries) {
      const row = el('div', 'ag-settings-model-row');
      const metrics = [
        `${stats.turns}calls`,
        formatCompactTokens(stats.weightedTokens),
        ...(typeof stats.costUsd === 'number' && stats.costUsd > 0 ? [formatUsd(stats.costUsd)] : []),
      ];
      row.append(
        el('span', 'ag-settings-model-name', labelForModel(agent, model)),
        el('span', 'ag-settings-model-tokens', metrics.join(' | ')),
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

  /** 체험 크레딧 미터 — 쓴 달러를 한도($5)에 대한 비율로 보여준다. */
  function rauCreditMeter(): HTMLElement | null {
    const percent = rauCreditPercent();
    const credits = usage?.rau ?? null;
    if (percent === null || !credits) return null;
    return meterRow(
      'Trial credits',
      `${percent.toFixed(1)}% | ${formatUsd(credits.balanceUsd)} / ${formatUsd(credits.totalCreditsUsd)} left`,
      percent,
    );
  }

  /** 쓴 비율(0–100). 크레딧을 못 읽었거나 한도가 없으면 null. */
  function rauCreditPercent(): number | null {
    const credits = usage?.rau ?? null;
    if (!credits || credits.error) return null;
    const limit = credits.totalCreditsUsd;
    if (!Number.isFinite(limit) || limit <= 0) return null;
    return Math.min(100, Math.max(0, (credits.totalUsageUsd / limit) * 100));
  }

  /**
   * Rau 계정 카드 — 로그인한 계정과 남은 체험 크레딧.
   * 키 정보는 사용자에게 노출하지 않는다.
   */
  function renderRauAccount(): void {
    const agent = setupAgent;
    const status = agent ? setupStatuses?.[agent] ?? null : null;
    const connected = status?.setupComplete === true || status?.connected === true;
    setupAccountPane.hidden = agent !== 'rau' || !connected || setupReauth;
    if (setupAccountPane.hidden) return;
    setupAccountEmail.textContent = status?.account ?? '계정 이메일을 확인할 수 없습니다';
    const credits = usage?.rau ?? null;
    const percent = rauCreditPercent();
    const rows: HTMLElement[] = [];
    if (percent !== null && credits) {
      const row = meterRow(
        '체험 크레딧',
        `${formatUsd(credits.balanceUsd)} 남음 / ${formatUsd(credits.totalCreditsUsd)}`,
        percent,
      );
      row.classList.add('ag-agent-setup-account-meter');
      rows.push(row);
    }
    setupAccountRows.replaceChildren(...rows);
    setupAccountEmpty.hidden = !(percent !== null && credits && credits.balanceUsd <= 0);
  }

  /** rau 사용량 — 크레딧 미터와 오늘·주간 누적. */
  function renderRauUsage(): void {
    const setup = setupStatuses?.rau;
    rauUsageBlock.hidden = setup?.setupComplete !== true && setup?.connected !== true;
    if (rauUsageBlock.hidden) return;
    const credits = usage?.rau ?? null;
    const meter = rauCreditMeter();
    rauUsageMeters.replaceChildren(...(meter ? [meter] : []));
    rauUsageCredits.textContent = meter
      ? ''
      : (credits?.error ?? (credits ? `${formatUsd(credits.balanceUsd)} / $5 left` : 'Checking balance…'));
    const empty = credits != null && credits.balanceUsd <= 0 && !credits.error;
    rauUsageEmpty.hidden = !empty;
    const providerUsage = usage?.providers?.rau ?? null;
    rauUsageDay.textContent = providerUsage
      ? formatUsageWindow('Today', providerUsage.day)
      : formatUsageWindow('Today', null);
    rauUsageWeek.textContent = providerUsage
      ? formatUsageWindow('Week', providerUsage.week)
      : formatUsageWindow('Week', null);
    rauUsageModels.replaceChildren(...buildModelRows(providerUsage, 'rau'));
    rauUsageUpdated.textContent = formatUsageUpdated(providerUsage?.updatedAt);
  }

  function renderPiUsage(): void {
    piUsageBlock.hidden = piStatus?.setupComplete !== true;
    if (piUsageBlock.hidden) return;
    const credits = usage?.openrouter ?? null;
    piUsageCredits.textContent = credits
      ? (credits.error ?? `Balance ${formatUsd(credits.balanceUsd)} | Added ${formatUsd(credits.totalCreditsUsd)}`)
      : 'Checking balance…';
    const providerUsage = usage?.providers?.pi ?? null;
    piUsageDay.textContent = providerUsage
      ? formatUsageWindow('Today', providerUsage.day)
      : formatUsageWindow('Today', null);
    piUsageWeek.textContent = providerUsage
      ? formatUsageWindow('Week', providerUsage.week)
      : formatUsageWindow('Week', null);
    piUsageModels.replaceChildren(...buildModelRows(providerUsage, 'pi'));
    piUsageUpdated.textContent = formatUsageUpdated(providerUsage?.updatedAt);
  }

  /** grok · cursor 사용량 — 한도가 없어 미터 대신 세션 · 오늘 · 주간 누적만 쓴다. */
  function renderApiUsage(): void {
    for (const agent of API_USAGE_AGENTS) {
      const ui = apiUsageBlocks.get(agent);
      if (!ui) continue;
      const providerUsage = usage?.providers?.[agent] ?? null;
      const turns = (providerUsage?.session.turns ?? 0)
        + (providerUsage?.day.turns ?? 0)
        + (providerUsage?.week.turns ?? 0);
      const setup = setupStatuses?.[agent] ?? null;
      // 설정을 마쳤거나 기록이 남아 있을 때만 자리를 차지한다.
      ui.root.hidden = turns === 0
        && setup?.setupComplete !== true
        && setup?.connected !== true;
      if (ui.root.hidden) continue;
      ui.session.textContent = providerUsage
        ? formatUsageWindow('Session', providerUsage.session)
        : formatUsageWindow('Session', null);
      ui.day.textContent = providerUsage
        ? formatUsageWindow('Today', providerUsage.day)
        : formatUsageWindow('Today', null);
      ui.week.textContent = providerUsage
        ? formatUsageWindow('Week', providerUsage.week)
        : formatUsageWindow('Week', null);
      ui.models.replaceChildren(...buildModelRows(providerUsage, agent));
      ui.updated.textContent = formatUsageUpdated(providerUsage?.updatedAt);
    }
  }

  function renderUsage(): void {
    renderCliproxy();
    renderRauUsage();
    renderRauAccount();
    renderPiUsage();
    renderApiUsage();
    for (const agent of PLAN_AGENTS) {
      const ui = usageBlocks.get(agent);
      if (!ui) continue;
      const providerUsage = usage?.providers?.[agent] ?? null;
      const actual = providerUsage?.source === 'cliproxy';
      const plan = usage?.plans?.[agent] ?? DEFAULT_PLAN[agent];
      if (USAGE_PLANS[agent].some((option) => option.id === plan)) ui.plan.value = plan;
      ui.plan.hidden = actual;
      ui.meters.replaceChildren(
        buildMeter('5h', providerUsage?.session ?? null, providerUsage?.limit.session5h ?? null, actual),
        buildMeter('Week', providerUsage?.week ?? null, providerUsage?.limit.week ?? null, actual),
      );
      const account = (usage?.cliproxy?.accounts ?? []).find((item) => item.agent === agent);
      const accountLine = actual && account
        ? [account.email ?? account.name, account.planType].filter(Boolean).join(' | ')
        : '';
      ui.day.textContent = providerUsage
        ? [
          formatUsageWindow('Today', providerUsage.day),
          accountLine,
        ].filter(Boolean).join(' | ')
        : formatUsageWindow('Today', null);
      ui.models.replaceChildren(...buildModelRows(providerUsage, agent));
      const stamp = formatUsageUpdated(providerUsage?.updatedAt);
      ui.updated.textContent = stamp
        ? `${stamp} | ${actual ? 'Actual' : 'Estimated'}`
        : (actual ? 'Actual' : 'Estimated');
    }
  }

  // ── pi 마법사 ─────────────────────────────────────────

  function piCurrentStep(): PiStep {
    if (piStepOverride) return piStepOverride;
    if (!piStatus?.installed) return 'install';
    if (!piStatus.keyConfigured) return 'key';
    if (piStatus.models.length === 0) return 'catalog';
    return 'summary';
  }

  function piHeadText(): string {
    if (piProgress) return piProgress;
    if (!piStatus) return connectionState === 'connected' ? '확인 중…' : '허브에 연결되면 확인해요';
    const version = piStatus.version ?? '설치됨';
    if (!piStatus.installed) return '설치되지 않았어요';
    if (!piStatus.keyConfigured) return `${version} · 키 필요`;
    if (piStatus.models.length === 0) return `${version} · 모델 필요`;
    return `${version} · 모델 ${piStatus.models.length}개`;
  }

  function piEffortLabel(effort: string): string {
    return PI_EFFORT_OPTIONS.find((option) => option.id === effort)?.label ?? effort;
  }

  function filterPiCatalog(query: string): PiCatalogModel[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return piCatalog;
    return piCatalog.filter((model) => {
      const hay = `${model.id} ${model.name} ${model.provider}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }

  function togglePiModel(model: PiCatalogModel): void {
    if (piDraft.some((draft) => draft.id === model.id)) {
      piDraft = piDraft.filter((draft) => draft.id !== model.id);
    } else if (piDraft.length >= PI_MODEL_MAX) {
      piMessage = `모델은 ${PI_MODEL_MAX}개까지 고를 수 있어요.`;
      renderPi();
      return;
    } else {
      piDraft = [
        ...piDraft,
        {
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          effort: model.reasoning ? 'medium' : '',
        },
      ];
    }
    piMessage = '';
    renderPi();
  }

  function buildPiCatalogRow(model: PiCatalogModel): HTMLElement {
    const row = el('button', 'ag-pi-model-row');
    row.type = 'button';
    const picked = piDraft.some((draft) => draft.id === model.id);
    row.classList.toggle('ag-active', picked);
    row.setAttribute('aria-pressed', picked ? 'true' : 'false');
    const main = el('div', 'ag-pi-model-main');
    main.append(
      el('span', 'ag-pi-model-name', model.name),
      el('span', 'ag-pi-model-id', model.id),
    );
    const meta = [
      `${formatTokens(model.contextLength)} 컨텍스트`,
      `입력 ${formatUsd(pricePerMillion(model.pricing.prompt))}`,
      `출력 ${formatUsd(pricePerMillion(model.pricing.completion))}`,
    ];
    if (model.reasoning) meta.push('추론');
    row.append(main, el('span', 'ag-pi-model-meta', meta.join(' · ')));
    row.addEventListener('click', () => togglePiModel(model));
    return row;
  }

  function renderPiChips(): void {
    piChips.replaceChildren();
    for (const draft of piDraft) {
      const chip = el('button', 'ag-pi-chip');
      chip.type = 'button';
      chip.title = draft.id;
      chip.setAttribute('aria-label', `${draft.name || draft.id} 빼기`);
      chip.append(
        el('span', 'ag-pi-chip-name', draft.name || draft.id),
        el('span', 'ag-pi-chip-x', '×'),
      );
      chip.addEventListener('click', () => {
        piDraft = piDraft.filter((item) => item.id !== draft.id);
        renderPi();
      });
      piChips.appendChild(chip);
    }
    piChips.hidden = piDraft.length === 0;
  }

  function renderPiCatalogList(): void {
    if (piCatalogLoading) {
      piList.replaceChildren(el('p', 'ag-settings-note', '목록을 불러오는 중…'));
      piCatalogNote.textContent = '';
      return;
    }
    const matches = filterPiCatalog(piSearch.input.value);
    const visible = matches.slice(0, PI_CATALOG_VISIBLE_MAX);
    piList.replaceChildren(...visible.map(buildPiCatalogRow));
    if (piCatalog.length === 0) {
      piCatalogNote.textContent = '목록을 불러오지 못했어요.';
    } else if (matches.length === 0) {
      piCatalogNote.textContent = '검색 결과가 없어요.';
    } else if (matches.length > visible.length) {
      piCatalogNote.textContent = `${matches.length}개 중 ${visible.length}개`;
    } else {
      piCatalogNote.textContent = `${matches.length}개 · 최대 ${PI_MODEL_MAX}개`;
    }
  }

  /** 이름 칸은 입력 중인 값을 지키려고 구성이 바뀔 때만 다시 세운다. */
  function renderPiNaming(): void {
    const same = piNamingRendered.length === piDraft.length
      && piNamingRendered.every((draft, index) => draft === piDraft[index]);
    if (same) return;
    piNamingRendered = piDraft;
    piNamingRows.replaceChildren();
    for (const draft of piDraft) {
      const row = el('div', 'ag-pi-naming-row');
      row.append(el('div', 'ag-pi-model-id', draft.id));
      const name = createTextField('이름', { placeholder: draft.id });
      name.input.value = draft.name;
      name.input.addEventListener('input', () => {
        draft.name = name.input.value;
      });
      row.append(name.field);
      if (draft.reasoning) {
        const effort = createSelect('기본 강도', PI_EFFORT_OPTIONS);
        effort.select.value = draft.effort || 'medium';
        effort.select.addEventListener('change', () => {
          draft.effort = effort.select.value;
        });
        row.append(effort.field);
      }
      piNamingRows.appendChild(row);
    }
  }

  function renderPiSummary(): void {
    const models = piStatus?.models ?? [];
    piSummaryModels.replaceChildren(
      ...models.map((model) => {
        const row = el('div', 'ag-settings-model-row');
        row.append(
          el('span', 'ag-settings-model-name', model.name),
          el('span', 'ag-pi-model-id', model.id),
        );
        if (model.reasoning && model.defaultEffort) {
          row.append(el('span', 'ag-settings-model-turns', piEffortLabel(model.defaultEffort)));
        }
        return row;
      }),
    );
    piSummaryKey.textContent = piStatus?.keyTail ? `키 ****${piStatus.keyTail}` : '';
  }

  function renderPi(): void {
    const step = piCurrentStep();
    for (const [id, node] of piSteps) node.hidden = id !== step;
    const online = connectionState === 'connected';
    piHeadDetail.textContent = piHeadText();
    piMessageLine.textContent = piMessage;
    piMessageLine.hidden = !piMessage;

    piInstallBtn.disabled = piBusy || !online;
    piProgressLine.textContent = piProgress;
    piProgressLine.hidden = !piProgress;

    piKeyNote.textContent = piStatus?.keyConfigured
      ? '새 키를 넣으면 이전 키는 지워져요.'
      : 'openrouter.ai/keys 에서 만든 키를 넣어 주세요.';
    piKeySubmit.disabled = piBusy || !online;
    piKeyCancel.hidden = piStepOverride !== 'key';

    if (step === 'catalog') {
      // 목록은 이 단계에 처음 들어올 때 한 번 부른다.
      if (!piCatalogTried && !piCatalogLoading && online) void loadPiCatalog(false);
      renderPiChips();
      renderPiCatalogList();
    }
    piCatalogNext.disabled = piBusy || piDraft.length === 0;
    piCatalogRefresh.disabled = piBusy || piCatalogLoading || !online;
    piCatalogCancel.hidden = (piStatus?.models.length ?? 0) === 0;

    if (step === 'naming') renderPiNaming();
    piNamingSave.disabled = piBusy || !online || piDraft.length === 0;

    if (step === 'summary') renderPiSummary();
    piRepick.disabled = piBusy || !online;
    piRekey.disabled = piBusy || !online;
  }

  function formatMb(bytes: number): string {
    return `${(bytes / 1048576).toFixed(1)}MB`;
  }

  /** 결정적 진행률 — 채움 폭을 퍼센트로 그린다. */
  function piBarDeterminate(percent: number): void {
    if (piActivityPause) {
      clearTimeout(piActivityPause);
      piActivityPause = null;
    }
    piProgressPercent = Math.max(piProgressPercent, Math.min(100, Math.max(0, percent)));
    piProgressTrack.hidden = false;
    piProgressTrack.classList.remove('ag-pi-progress-indeterminate', 'ag-pi-progress-paused');
    piProgressFill.style.width = `${piProgressPercent.toFixed(2)}%`;
    piProgressTrack.setAttribute('role', 'progressbar');
    piProgressTrack.setAttribute('aria-valuemin', '0');
    piProgressTrack.setAttribute('aria-valuemax', '100');
    piProgressTrack.setAttribute('aria-valuenow', String(Math.round(piProgressPercent)));
  }

  function setPiInstallProgress(percent: number, phase: string, creep = true): void {
    piProgressPhase = phase;
    piBarDeterminate(percent);
    if (!creep || percent >= 100) {
      if (piProgressCreepTimer) {
        clearInterval(piProgressCreepTimer);
        piProgressCreepTimer = null;
      }
      return;
    }
    if (piProgressCreepTimer) return;
    piProgressCreepTimer = setInterval(() => {
      const ceiling = INSTALL_PROGRESS_CEILING[piProgressPhase] ?? piProgressPercent;
      if (piProgressPercent >= ceiling || piProgressPercent >= 100) return;
      piProgressPercent = Math.min(
        ceiling,
        piProgressPercent + Math.max(0.08, (ceiling - piProgressPercent) * 0.018),
      );
      piBarDeterminate(piProgressPercent);
      const label = PI_PROGRESS_LABEL[piProgressPhase] ?? '';
      piProgress = `${label} · ${Math.floor(piProgressPercent)}%`;
      piProgressLine.textContent = piProgress;
    }, 100);
  }

  /** 크기를 모를 때 — 새 신호가 올 때만 흐르고, 잠잠해지면 멈추는 막대. */
  function piBarNudge(): void {
    piProgressTrack.hidden = false;
    piProgressTrack.classList.add('ag-pi-progress-indeterminate');
    piProgressTrack.classList.remove('ag-pi-progress-paused');
    piProgressFill.style.width = '';
    piProgressTrack.removeAttribute('aria-valuenow');
    if (piActivityPause) clearTimeout(piActivityPause);
    piActivityPause = setTimeout(() => {
      piProgressTrack.classList.add('ag-pi-progress-paused');
    }, 1200);
  }

  function piBarHide(): void {
    if (piActivityPause) {
      clearTimeout(piActivityPause);
      piActivityPause = null;
    }
    if (piProgressCreepTimer) {
      clearInterval(piProgressCreepTimer);
      piProgressCreepTimer = null;
    }
    piProgressPercent = 0;
    piProgressPhase = '';
    piProgressTrack.hidden = true;
    piProgressTrack.classList.remove('ag-pi-progress-indeterminate', 'ag-pi-progress-paused');
    piProgressFill.style.width = '0%';
    piProgressTrack.removeAttribute('aria-valuenow');
  }

  async function runPiInstall(): Promise<void> {
    if (piBusy) return;
    piBusy = true;
    piMessage = '';
    piProgress = `${PI_PROGRESS_LABEL.preparing} · 8%`;
    setPiInstallProgress(8, 'preparing');
    renderPi();
    const status = await bridge.installPi();
    if (disposed) return;
    piBusy = false;
    piProgress = '';
    piBarHide();
    if (status) {
      piStatus = status;
      piStepOverride = null;
    } else if (!piMessage) {
      piMessage = '설치하지 못했어요.';
    }
    renderPi();
    syncPrefsInputs();
    void refreshProviders(true);
  }

  async function submitPiKey(): Promise<void> {
    const key = piKeyInput.input.value.trim();
    if (!key || piBusy) return;
    piBusy = true;
    piMessage = '';
    renderPi();
    const status = await bridge.setPiKey(key);
    if (disposed) return;
    piBusy = false;
    piKeyInput.input.value = '';
    if (status) {
      piStatus = status;
      // 새 키로 목록을 다시 받아 본다.
      piCatalogTried = false;
      piStepOverride = status.models.length === 0 ? 'catalog' : null;
    } else if (!piMessage) {
      piMessage = '키를 확인하지 못했어요.';
    }
    renderPi();
    syncPrefsInputs();
  }

  async function loadPiCatalog(refresh: boolean): Promise<void> {
    if (piCatalogLoading) return;
    if (!refresh && piCatalog.length > 0) return;
    piCatalogTried = true;
    piCatalogLoading = true;
    renderPi();
    const models = await bridge.requestPiCatalog(refresh);
    if (disposed) return;
    piCatalogLoading = false;
    if (models) piCatalog = models;
    else if (!piMessage) piMessage = '모델 목록을 불러오지 못했어요.';
    renderPi();
  }

  async function savePiModels(): Promise<void> {
    if (piBusy || piDraft.length === 0) return;
    piBusy = true;
    piMessage = '';
    renderPi();
    const status = await bridge.setPiModels(
      piDraft.map((draft) => ({
        id: draft.id,
        name: draft.name.trim() || draft.id,
        ...(draft.reasoning && draft.effort ? { defaultEffort: draft.effort } : {}),
      })),
    );
    if (disposed) return;
    piBusy = false;
    if (status) {
      piStatus = status;
      piStepOverride = null;
    } else if (!piMessage) {
      piMessage = '모델을 저장하지 못했어요.';
    }
    renderPi();
    syncPrefsInputs();
    renderUsage();
  }

  async function refreshPiStatus(): Promise<void> {
    const status = await bridge.requestPiStatus();
    if (disposed) return;
    if (status) piStatus = status;
    renderPi();
    syncPrefsInputs();
    renderUsage();
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

  function acceptAgentInstructions(
    status: AgentInstructionsStatus,
    changedBy = 'system',
    force = false,
  ): void {
    const changedByAgent = changedBy.startsWith('agent:')
      || changedBy.startsWith('agent-confirmed:');
    const changedElsewhere = instructionsDirty
      && instructionsDraftRevision > 0
      && status.revision !== instructionsDraftRevision;
    agentInstructions = status;
    if (changedElsewhere && !force) {
      instructionsMessage = changedByAgent
        ? '에이전트가 지시를 변경했어요. 초안을 보존했으니 다시 불러와 비교하세요.'
        : '다른 창에서 지시가 변경됐어요. 초안을 보존했으니 다시 불러와 비교하세요.';
    } else {
      instructionsEditor.value = status.content;
      instructionsDraftRevision = status.revision;
      instructionsDirty = false;
      if (changedByAgent) instructionsMessage = '승인한 에이전트 변경안을 AGENTS.md에 적용했어요.';
    }
    renderAgentInstructions();
    if (shellReady) renderDestinationState();
  }

  function renderAgentInstructions(): void {
    const maxChars = agentInstructions?.maxChars ?? 30_000;
    instructionsEditor.maxLength = maxChars;
    instructionsEditor.disabled = instructionsBusy || !agentInstructions;
    instructionsReload.disabled = instructionsBusy || connectionState !== 'connected';
    instructionsStatus.textContent = instructionsMessage;
    instructionsStatus.hidden = !instructionsMessage;
    const proposal = pendingAgentInstructionsDraft;
    instructionsProposal.hidden = !proposal;
    if (proposal) {
      const expiresAt = Date.parse(proposal.expiresAt);
      const expired = !Number.isFinite(expiresAt) || expiresAt <= Date.now();
      const expiryLabel = Number.isFinite(expiresAt)
        ? formatResetAt(expiresAt).replace('리셋', '만료')
        : '만료 시간 오류';
      instructionsProposalMeta.textContent = `${proposal.requestedBy} 제안 · ${expiryLabel}`;
      instructionsProposalReason.textContent = proposal.reason
        ? `이유: ${proposal.reason}`
        : '승인 전에는 AGENTS.md에 저장되지 않습니다.';
      instructionsProposalPreview.textContent = proposal.content;
      instructionsProposalConfirm.disabled = instructionsProposalBusy
        || expired
        || connectionState !== 'connected';
      instructionsProposalReject.disabled = instructionsProposalBusy
        || connectionState !== 'connected';
    }
  }

  async function refreshAgentInstructions(force = false): Promise<void> {
    if (instructionsBusy) return;
    if (connectionState !== 'connected') {
      renderAgentInstructions();
      return;
    }
    instructionsBusy = true;
    renderAgentInstructions();
    const status = await bridge.requestAgentInstructions();
    if (disposed) return;
    instructionsBusy = false;
    if (status) acceptAgentInstructions(status, 'system', force);
    else {
      instructionsMessage = 'AGENTS.md를 불러오지 못했어요.';
      renderAgentInstructions();
    }
  }

  async function saveAgentInstructions(): Promise<boolean> {
    if (!instructionsDirty) return true;
    if (instructionsBusy || connectionState !== 'connected' || !agentInstructions) return false;
    instructionsBusy = true;
    instructionsMessage = '';
    renderAgentInstructions();
    const status = await bridge.saveAgentInstructions(
      instructionsEditor.value,
      instructionsDraftRevision,
    );
    if (disposed) return false;
    instructionsBusy = false;
    if (status) {
      acceptAgentInstructions(status, 'user', true);
      instructionsMessage = '저장했어요. 다음 턴부터 모든 Rauhwpx 채팅에 적용됩니다.';
    } else if (!instructionsMessage) {
      instructionsMessage = '저장하지 못했어요. 최신 지시를 다시 불러온 뒤 시도하세요.';
    }
    renderAgentInstructions();
    renderDestinationState();
    return Boolean(status);
  }

  async function confirmAgentInstructionsDraft(): Promise<void> {
    const draft = pendingAgentInstructionsDraft;
    if (!draft || instructionsProposalBusy || connectionState !== 'connected') return;
    if (instructionsDirty
      && !window.confirm('작성 중인 직접 편집 내용을 버리고 에이전트 변경안을 적용할까요?')) return;
    instructionsProposalBusy = true;
    instructionsMessage = '';
    renderAgentInstructions();
    const status = await bridge.confirmAgentInstructionsDraft(draft);
    if (disposed) return;
    instructionsProposalBusy = false;
    if (status) {
      pendingAgentInstructionsDraft = null;
      acceptAgentInstructions(status, `agent-confirmed:${draft.requestedBy}`, true);
      instructionsMessage = '에이전트 변경안을 적용했어요. 다음 턴부터 모든 Rauhwpx 채팅에 적용됩니다.';
    } else if (!instructionsMessage) {
      instructionsMessage = '변경안을 적용하지 못했어요. 최신 지시를 다시 불러오세요.';
    }
    renderAgentInstructions();
  }

  async function rejectAgentInstructionsDraft(): Promise<void> {
    const draft = pendingAgentInstructionsDraft;
    if (!draft || instructionsProposalBusy || connectionState !== 'connected') return;
    instructionsProposalBusy = true;
    instructionsMessage = '';
    renderAgentInstructions();
    const rejected = await bridge.rejectAgentInstructionsDraft(draft);
    if (disposed) return;
    instructionsProposalBusy = false;
    if (rejected) {
      pendingAgentInstructionsDraft = null;
      instructionsMessage = '에이전트 변경안을 거절했어요. AGENTS.md는 바뀌지 않았습니다.';
    } else if (!instructionsMessage) {
      instructionsMessage = '변경안을 거절하지 못했어요. 이미 만료되었을 수 있습니다.';
    }
    renderAgentInstructions();
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
  renderAgentInstructions();
  renderWritingStyle();
  renderTemplates();
  renderUsage();
  renderPi();
  renderDestinationState();

  return {
    element,
    open(destination?: SettingsDestination): void {
      if (!isAiDirty()) {
        prefs = loadAgentPrefs();
        prefsBaseline = { ...prefs };
        prefsDraft = { ...prefs };
      }
      connectionState = bridge.getConnectionState();
      editingSettings.open();
      if (destination) selectDestination(destination);
      else selectDestination(lastDestination);
      void refreshUniqueInstalls();
      syncPrefsInputs();
      renderCurrentSelection();
      renderConnection();
      renderProviders();
      renderAgentInstructions();
      renderWritingStyle();
      renderTemplates();
      renderPi();
      void refreshProviders(false);
      void refreshAgentInstructions(false);
      void refreshUsage();
      void refreshPiStatus();
      void refreshSetupStatuses();
      void refreshTemplates();
    },
    close(): void {
      if (editingSettings.isDirty()) editingSettings.cancel();
      if (isAiDirty()) cancelAiDraft();
      closeAgentSetup();
      finishTemplateName(null);
    },
    requestClose: resolveDirtyExit,
    isDirty(): boolean {
      return editingSettings.isDirty() || isAiDirty();
    },
    openAgentSetup,
    beginAgentConnect,
    handleEvent(ev: SidebarEvent): void {
      switch (ev.type) {
        case 'connection':
          connectionState = ev.state;
          renderConnection();
          renderProviders();
          renderCliproxy();
          renderPi();
          renderTemplates();
          renderAgentInstructions();
          if (ev.state === 'connected' && !agentInstructions) void refreshAgentInstructions(false);
          break;
        case 'agent-instructions':
          acceptAgentInstructions(ev.status, ev.changedBy);
          break;
        case 'agent-instructions-draft':
          pendingAgentInstructionsDraft = ev.draft;
          instructionsProposalBusy = false;
          instructionsMessage = '에이전트가 지시 변경안을 제안했어요. 내용을 확인한 뒤 적용하거나 거절하세요.';
          renderAgentInstructions();
          break;
        case 'agent-instructions-draft-cleared':
          if (pendingAgentInstructionsDraft?.id === ev.draftId) {
            pendingAgentInstructionsDraft = null;
            instructionsProposalBusy = false;
            if (ev.outcome === 'expired') instructionsMessage = '에이전트 변경안이 만료됐어요.';
            if (ev.outcome === 'replaced') instructionsMessage = '에이전트가 새 변경안으로 교체했어요.';
            if (ev.outcome === 'stale') instructionsMessage = '지시가 먼저 변경되어 에이전트 변경안이 만료됐어요.';
            renderAgentInstructions();
          }
          break;
        case 'agent-instructions-error':
          if (ev.status) agentInstructions = ev.status;
          instructionsBusy = false;
          instructionsProposalBusy = false;
          instructionsMessage = ev.message;
          renderAgentInstructions();
          break;
        case 'provider-status':
          providers = ev.providers;
          renderProviders();
          break;
        case 'agent-setup-status': {
          const rauOauthCompleted = setupAgent === 'rau'
            && rauOauthFlowInProgress
            && ev.statuses.rau?.setupComplete === true
            && setupOverlay.getAttribute('aria-hidden') === 'false';
          const rauWasIncomplete = setupStatuses !== null
            && setupStatuses.rau?.setupComplete !== true;
          setupStatuses = ev.statuses;
          const selectedStatus = setupAgent ? ev.statuses[setupAgent] : null;
          if (setupAgent && selectedStatus?.authOwnedByThisSession && selectedStatus.authRunId) {
            setupAuthRunId = selectedStatus.authRunId;
            setupBusy = true;
            setupOauthPending = Boolean(selectedStatus.authUrl || selectedStatus.pairingCode);
            setupAuthUrl = selectedStatus.authUrl ?? setupAuthUrl;
            setupUserCode = selectedStatus.pairingCode ?? setupUserCode;
            if (setupAgent === 'rau' || setupAgent === 'claude') setupCodePending = true;
          }
          if (rauWasIncomplete && ev.statuses.rau?.setupComplete === true) {
            persistPrefs({
              ...prefs,
              defaultAgent: 'rau',
              defaultModel: 'z-ai/glm-5.3-flash',
            }, { preserveDraft: true });
          }
          // 로그인·설치가 아직 진행 중이면 주기 방송이 카드 상태(주소·코드)를 지우지 않는다.
          const inFlight = setupAgent !== null && setupBusy
            && ((ev.statuses[setupAgent]?.authenticating === true
                && ev.statuses[setupAgent]?.authOwnedByThisSession === true)
              || ev.statuses[setupAgent]?.installing === true);
          if (!inFlight) {
            setupBusy = false;
            setupReauth = false;
            setupCodePending = false;
            clearSetupAuthPrompt();
          }
          if (rauOauthCompleted) showRauAuthSuccess();
          renderProviders();
          renderAgentSetup();
          // 설정을 마친 grok · cursor 는 기록이 없어도 사용량 칸을 연다.
          renderUsage();
          // cursor 동적 모델 목록이 도착하면 기본 모델 선택지도 다시 채운다.
          syncPrefsInputs();
          break;
        }
        case 'agent-setup-progress':
          if (setupAgent === ev.agent) {
            if (ev.authRunId && setupAuthRunId && ev.authRunId !== setupAuthRunId) break;
            if (ev.authRunId) setupAuthRunId = ev.authRunId;
            setupBusy = ev.state !== 'done';
            // API 키 검증 중에도 authorizing 이 온다 — 브라우저 로그인 근거가 있을 때만 상자를 연다.
            if (ev.state === 'authorizing' && (ev.authUrl || ev.userCode || ev.pairingCode)) setupOauthPending = true;
            if (ev.authUrl) setupAuthUrl = ev.authUrl;
            if (ev.userCode || ev.pairingCode) setupUserCode = ev.userCode ?? ev.pairingCode ?? null;
            if (ev.agent === 'rau' && ev.state === 'authorizing') setupCodePending = true;
            if (ev.state === 'done') clearSetupAuthPrompt();
            maybeOpenAuthUrl(ev.authUrl);
            if (typeof ev.percent === 'number') {
              setSetupInstallProgress(ev.percent, ev.phase ?? ev.state);
            }
            renderAgentSetup();
          }
          break;
        case 'agent-setup-error':
          if (!ev.agent || setupAgent === ev.agent) {
            if (ev.authRunId && setupAuthRunId && ev.authRunId !== setupAuthRunId) break;
            if (ev.code === 'DEVICE_PROOF_INVALID' && setupAgent === 'rau') {
              setupMessage = ev.message;
              setupBusy = true;
              setupCodePending = true;
              setupCode.input.value = '';
              renderAgentSetup();
              break;
            }
            setupBusy = false;
            setupCodePending = false;
            setupMessage = ev.message;
            resetRauAuthFeedback();
            clearSetupAuthPrompt();
            resetSetupInstallProgress();
            if (setupAgent === 'pi') piMessage = ev.message;
            renderAgentSetup();
          }
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
        case 'templates-catalog':
          templates = ev.catalog.templates;
          templatesMessage = '';
          renderTemplates();
          break;
        case 'pi-status':
          piStatus = ev.status;
          renderPi();
          syncPrefsInputs();
          renderUsage();
          break;
        case 'pi-setup-progress':
          piProgress = PI_PROGRESS_LABEL[ev.state] ?? '';
          if (ev.state === 'done') {
            setPiInstallProgress(100, 'done', false);
          } else if (typeof ev.percent === 'number') {
            setPiInstallProgress(ev.percent, ev.state, typeof ev.receivedBytes !== 'number');
            piProgress = `${piProgress} · ${Math.floor(ev.percent)}%`;
            if (typeof ev.receivedBytes === 'number') {
              const total = typeof ev.totalBytes === 'number' && ev.totalBytes > 0 ? ev.totalBytes : null;
              piProgress = total
                ? `${PI_PROGRESS_LABEL.downloading} · ${formatMb(ev.receivedBytes)} / ${formatMb(total)} · ${Math.floor(ev.percent)}%`
                : `${PI_PROGRESS_LABEL.downloading} · ${formatMb(ev.receivedBytes)} · ${Math.floor(ev.percent)}%`;
            }
          } else if (typeof ev.receivedBytes === 'number') {
            const total = typeof ev.totalBytes === 'number' && ev.totalBytes > 0 ? ev.totalBytes : null;
            if (total) {
              const percent = (ev.receivedBytes / total) * 100;
              piBarDeterminate(percent);
              piProgress = `${PI_PROGRESS_LABEL['downloading']} · ${formatMb(ev.receivedBytes)} / ${formatMb(total)} (${Math.floor(percent)}%)`;
            } else {
              piBarNudge();
              piProgress = `${PI_PROGRESS_LABEL['downloading']} · ${formatMb(ev.receivedBytes)}`;
            }
          } else {
            // 숫자 없는 단계 — 신호가 도착할 때만 막대가 흐른다.
            piBarNudge();
          }
          renderPi();
          break;
        case 'pi-catalog':
          piCatalog = ev.models;
          renderPi();
          break;
        case 'pi-error':
          piMessage = ev.message;
          if (setupAgent === 'pi') setupBusy = false;
          renderPi();
          break;
        default:
          break;
      }
    },
    dispose(): void {
      disposed = true;
      if (piActivityPause) {
        clearTimeout(piActivityPause);
        piActivityPause = null;
      }
      if (setupProgressResetTimer) {
        clearTimeout(setupProgressResetTimer);
        setupProgressResetTimer = null;
      }
      if (setupCopyResetTimer) {
        clearTimeout(setupCopyResetTimer);
        setupCopyResetTimer = null;
      }
      if (rauAuthFeedbackTimer) {
        clearTimeout(rauAuthFeedbackTimer);
        rauAuthFeedbackTimer = null;
      }
      if (setupProgressCreepTimer) clearInterval(setupProgressCreepTimer);
      if (piProgressCreepTimer) clearInterval(piProgressCreepTimer);
      unsubscribeHancomGit();
      editingSettings.dispose();
      element.remove();
      setupOverlay.remove();
      finishTemplateName(null);
    },
  };
}
