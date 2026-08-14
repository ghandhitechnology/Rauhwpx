/**
 * 설정 탭 — 사이드바의 한 페이지(스킬 페이지와 같은 무대 전환을 탄다).
 *
 * 다섯 묶음을 한 스크롤에 세운다:
 *  1. 연결 — 허브 소켓과 로컬 CLI(claude/codex/pi) 상태, 재연결·세션 재시작
 *  2. Pi 연결 — 설치 → 키 → 모델 고르기 → 요약으로 이어지는 한 장짜리 마법사
 *  3. 기본 설정 — 다음 대화부터 쓸 프로바이더·모델·강도·권한
 *  4. 글쓰기 보정 — 문체 보정 상태와 재보정 진입
 *  5. 사용량 — CLIProxyAPI 연결, 요금제별 5시간·주간 한도, 오늘 누적, 모델별 내역
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
  PiCatalogModel,
  PiStatus,
  ProviderStatusMap,
  ProviderUsage,
  SidebarEvent,
  CliproxyStatus,
  UsageSummary,
  UsageWindow,
  WritingStyleStatus,
} from '../../agent/types.ts';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';

/** 요금제 셀렉트를 갖는 프로바이더 — pi 는 대신 OpenRouter 잔액을 보여준다. */
type PlanAgent = Exclude<AgentName, 'pi'>;

const AGENTS: readonly AgentName[] = ['claude', 'codex', 'pi'];

const PLAN_AGENTS: readonly PlanAgent[] = ['claude', 'codex'];

const AGENT_LABEL: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };

/** 단색 로고는 마스크로 그린다 — currentColor 를 타고 테마에 맞는다. */
const MASK_ICON_AGENTS: readonly AgentName[] = ['codex', 'pi'];

const PROVIDER_ICON_SRC: Partial<Record<AgentName, string>> = {
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
  downloading: '내려받는 중…',
  installing: '설치하는 중…',
  configuring: '설정하는 중…',
  done: '',
};

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
  if (MASK_ICON_AGENTS.includes(agent)) {
    const mark = el('span', 'ag-provider-icon ag-provider-icon-mask');
    mark.dataset.agent = agent;
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
  const img = document.createElement('img');
  img.className = 'ag-provider-icon';
  img.dataset.agent = agent;
  img.src = PROVIDER_ICON_SRC[agent] ?? '';
  img.alt = '';
  img.draggable = false;
  img.setAttribute('aria-hidden', 'true');
  return img;
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

  // ── 2. Pi 연결 ────────────────────────────────────────
  // 한 장의 카드가 설치 → 키 → 모델 → 요약으로 모습을 바꾼다.
  const piSection = createSection('Pi 연결');
  const piCard = el('div', 'ag-pi-card');
  const piHead = el('div', 'ag-pi-head');
  const piHeadName = el('span', 'ag-settings-row-name');
  piHeadName.append(providerIcon('pi'), document.createTextNode('Pi'));
  const piHeadDetail = el('span', 'ag-settings-row-detail', '확인 중…');
  piHead.append(piHeadName, piHeadDetail);
  const piMessageLine = el('p', 'ag-settings-cliproxy-error');
  piMessageLine.hidden = true;

  // 1단계 — 설치
  const piInstallStep = el('div', 'ag-pi-step');
  const piInstallNote = el('p', 'ag-settings-note', 'OpenRouter 모델로 문서를 고치는 Pi 에이전트예요.');
  const piInstallBtn = el('button', 'ag-settings-primary ag-pi-logo-btn');
  piInstallBtn.type = 'button';
  piInstallBtn.append(providerIcon('pi'), el('span', '', 'Pi 연결'));
  const piProgressLine = el('p', 'ag-settings-note');
  piProgressLine.hidden = true;
  piInstallStep.append(piInstallNote, piInstallBtn, piProgressLine);

  // 2단계 — OpenRouter 키
  const piKeyStep = el('div', 'ag-pi-step');
  const piKeyNote = el('p', 'ag-settings-note', 'openrouter.ai/keys 에서 만든 키를 넣어 주세요.');
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
  piKeyStep.append(piKeyNote, piKeyInput.field, piKeyActions);

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
  const piRekey = el('button', 'ag-settings-btn', '키 교체');
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
  piSection.body.appendChild(piCard);

  const piSteps: ReadonlyArray<[PiStep, HTMLElement]> = [
    ['install', piInstallStep],
    ['key', piKeyStep],
    ['catalog', piCatalogStep],
    ['naming', piNamingStep],
    ['summary', piSummaryStep],
  ];

  piInstallBtn.addEventListener('click', () => void runPiInstall());
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

  // ── 3. 기본 설정 ──────────────────────────────────────
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
    const agent: AgentName = value === 'codex' || value === 'pi' ? value : 'claude';
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

  // ── 4. 글쓰기 보정 ────────────────────────────────────
  const calibration = createSection('글쓰기 보정');
  const calibrationStatus = el('p', 'ag-settings-status', '아직 보정되지 않았어요');
  const calibrationSummary = el('p', 'ag-settings-note');
  calibrationSummary.hidden = true;
  const calibrationBtn = el('button', 'ag-settings-primary', '보정 시작');
  calibrationBtn.type = 'button';
  calibrationBtn.addEventListener('click', () => openCalibration());
  calibration.body.append(calibrationStatus, calibrationSummary, calibrationBtn);

  // ── 5. 사용량 ─────────────────────────────────────────
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

  // pi 는 요금제가 없다 — 대신 OpenRouter 잔액과 누적 토큰을 보여준다.
  const piUsageBlock = el('div', 'ag-settings-usage-block');
  piUsageBlock.dataset.agent = 'pi';
  const piUsageHead = el('div', 'ag-settings-usage-head');
  const piUsageName = el('span', 'ag-settings-row-name');
  piUsageName.append(providerIcon('pi'), document.createTextNode(AGENT_LABEL.pi));
  const piUsageCredits = el('span', 'ag-settings-row-detail');
  piUsageHead.append(piUsageName, piUsageCredits);
  const piUsageDay = el('div', 'ag-settings-usage-day');
  const piUsageWeek = el('div', 'ag-settings-usage-day');
  const piUsageModels = el('div', 'ag-settings-usage-models');
  const piUsageUpdated = el('div', 'ag-settings-usage-updated');
  piUsageBlock.append(piUsageHead, piUsageDay, piUsageWeek, piUsageModels, piUsageUpdated);
  usageSection.body.appendChild(piUsageBlock);

  body.append(
    connection.root,
    piSection.root,
    defaults.root,
    calibration.root,
    usageSection.root,
  );

  // ── 상태 → DOM ────────────────────────────────────────

  function commitPrefs(partial: Partial<AgentPrefs>): void {
    prefs = saveAgentPrefs(partial);
    syncPrefsInputs();
    applyDefaults(prefs);
  }

  /** 설정이 끝나기 전의 pi 는 기본 제공자 후보에서 빠진다. */
  function selectableAgents(): readonly AgentName[] {
    return AGENTS.filter((agent) => agent !== 'pi' || piStatus?.setupComplete === true);
  }

  function syncPrefsInputs(): void {
    fillSelect(
      agentField.select,
      selectableAgents().map((agent) => ({ id: agent, label: AGENT_LABEL[agent] })),
    );
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
      // 비용은 pi(OpenRouter) 모델에만 붙는다.
      if (typeof stats.costUsd === 'number' && stats.costUsd > 0) {
        row.append(el('span', 'ag-settings-model-cost', formatUsd(stats.costUsd)));
      }
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

  /** pi 사용량 — 요금제 대신 잔액, 미터 대신 오늘·주간 누적. */
  function renderPiUsage(): void {
    piUsageBlock.hidden = piStatus?.setupComplete !== true;
    if (piUsageBlock.hidden) return;
    const credits = usage?.openrouter ?? null;
    piUsageCredits.textContent = credits
      ? (credits.error ?? `잔액 ${formatUsd(credits.balanceUsd)} / 충전 ${formatUsd(credits.totalCreditsUsd)}`)
      : '잔액 확인 중…';
    const providerUsage = usage?.providers?.pi ?? null;
    piUsageDay.textContent = providerUsage
      ? `오늘 · ${formatTokens(providerUsage.day.weightedTokens)} 토큰 · ${providerUsage.day.turns}턴`
      : '오늘 · 기록 없음';
    piUsageWeek.textContent = providerUsage
      ? `주간 · ${formatTokens(providerUsage.week.weightedTokens)} 토큰 · ${providerUsage.week.turns}턴`
      : '주간 · 기록 없음';
    piUsageModels.replaceChildren(...buildModelRows(providerUsage, 'pi'));
    piUsageUpdated.textContent = providerUsage?.updatedAt
      ? `${formatRelativeTime(providerUsage.updatedAt)} 기록`
      : '';
  }

  function renderUsage(): void {
    renderCliproxy();
    renderPiUsage();
    for (const agent of PLAN_AGENTS) {
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
      piCatalogNote.textContent = `${matches.length}개 중 ${visible.length}개 · 검색으로 좁혀 보세요`;
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

  async function runPiInstall(): Promise<void> {
    if (piBusy) return;
    piBusy = true;
    piMessage = '';
    piProgress = PI_PROGRESS_LABEL['downloading'] ?? '';
    renderPi();
    const status = await bridge.installPi();
    if (disposed) return;
    piBusy = false;
    piProgress = '';
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
  renderPi();

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
      renderPi();
      void refreshProviders(false);
      void refreshUsage();
      void refreshPiStatus();
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
          renderPi();
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
        case 'pi-status':
          piStatus = ev.status;
          renderPi();
          syncPrefsInputs();
          renderUsage();
          break;
        case 'pi-setup-progress':
          piProgress = PI_PROGRESS_LABEL[ev.state] ?? '';
          renderPi();
          break;
        case 'pi-catalog':
          piCatalog = ev.models;
          renderPi();
          break;
        case 'pi-error':
          piMessage = ev.message;
          renderPi();
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
