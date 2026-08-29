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
  AgentPhase,
  AgentStreamEvent,
  AgentWorkflow,
  AgentWorkflowState,
  DocRange,
  PermissionProfile,
  ServiceTier,
  PendingChangeSet,
  PendingEditsChangeEvent,
  PendingOp,
  SidebarEvent,
  StructuredPlan,
  SkillCatalog,
  UsageSummary,
  ProductSkill,
  ProductSkillIcon,
  DocumentTemplate,
  TemplateCatalog,
} from '../../agent/types.ts';
import {
  defaultModelForAgent,
  effortsForAgent,
  labelForEffort,
  labelForModel,
  modelGroupsForAgent,
  modelSupportsImages,
  resolveEffortForAgent,
  resolveModelForAgent,
  resolveServiceTier,
  agentSupportsFast,
} from '../../agent/models.ts';
import { loadAgentPrefs, type AgentPrefs } from '../../agent/agent-prefs.ts';
import { userSettings } from '../../core/user-settings.ts';
import { renderChatMarkdown } from './chat-markdown.ts';
import { appendMarkdown, planToMarkdown } from './plan-markdown.ts';
import {
  createEmptyThread,
  fallbackTitle,
  getThread,
  explorerGroupIsCurrent,
  forgetDocumentThreads,
  listThreadsByDocument,
  recordDocumentOpened,
  removeThread,
  renameThread,
  setThreadTitle,
  subscribeThreadChanges,
  threadMatchesDocument,
  upsertThread,
  type ChatThread,
  type DocumentThreadGroup,
  type ThreadMessage,
  type ThreadAttachment,
  type ThreadTaskRecord,
  type ThreadToolRecord,
} from '../../agent/threads.ts';
import {
  clearChatStatus,
  getChatStatus,
  markChatFinished,
  markChatNeedsInput,
  markChatWorking,
  subscribeChatStatus,
  type ChatRunStatus,
} from '../../agent/chat-status.ts';
import { createChevron, createColumnIcon } from '../chevron.ts';
import { showActionMenu } from '../action-menu.ts';
import { createHieumGlyph, createIcon, createStopIcon, OP_ICON } from './icons.ts';
import { AGENT_LABEL, createProviderIcon, PROVIDER_ORDER } from './providers.ts';
import { createEffortSlider } from './effort-slider.ts';
import { createSubagentFleet, isSpawnToolName } from './subagent-fleet.ts';
import { createSettingsPanel } from './settings.ts';
import type { EditorSettingsRuntime, SettingsDestination } from './settings-contract.ts';
import { createWritingStyleCalibration } from './writing-style-calibration.ts';
import { maybeStartInitialSetup, type InitialSetupUi } from '../initial-setup/initial-setup.ts';
import { summarizePendingDiffs } from './pending-diff-summary.ts';
import { createReferenceLibrary } from './reference-library.ts';
import { createCloudController, type CloudController } from '../../cloud/desktop-cloud.ts';
import { exportCloudTimeline, importCloudTimeline, type PortableCloudTimelineV1 } from '../../cloud/timeline.ts';
import { collectUsedCloudReferenceIds } from '../../cloud/references.ts';
import type {
  CloudDocumentPayload,
  CloudDownloadResult,
  CloudResultResolution,
  CloudSessionScope,
  CloudTakeoverPayload,
  CloudTransferReference,
} from '../../cloud/types.ts';
import { createCloudAgentUi } from './cloud-ui.ts';
import {
  createVersionManagerPage,
  type VersionManagerController,
} from './version-manager.ts';
import {
  isDesktopApp,
  openPublishedDocumentInNewWindow,
  parsePublishedDocumentLink,
} from '../../desktop-integration.ts';
import { showToast } from '../toast.ts';
import { fuzzyTemplateScore } from './template-fuzzy.ts';
import {
  defaultSkillIconForName,
  requestTextForSkillInvocation,
  skillGlyphForIcon,
  skillGlyphForSkill,
  withSkillIconFrontmatter,
} from './skill-presentation.ts';
import type {
  InlinePromptSendResult,
  InlinePromptSubmission,
} from '../../agent/inline-prompt-context.ts';
import './sidebar-button-modern.css';

export interface AgentSidebarDeps {
  bridge: AgentBridge;
  /** inset 전환 후 용지 가운데 정렬을 요청할 때 사용 */
  eventBus?: EventBus;
  editorSettingsRuntime?: EditorSettingsRuntime;
  /** 헤더에 표시할 현재 문서와 선택 상태. */
  getDocumentContext?: () => {
    documentId?: string | null;
    documentName: string | null;
    selectionLabel: string | null;
  };
  /** 라이브러리 문서 그룹에서 "이동"을 골랐을 때. */
  moveToLibraryDocument?: (target: {
    documentId: string | null;
    fileName: string | null;
  }) => void;
  cloudController?: CloudController;
  prepareCloudTransfer?: () => Promise<CloudDocumentPayload | null>;
  setCloudDocumentLease?: (cloudOwned: boolean, sessionId: string | null) => void;
  applyCloudResult?: (result: CloudDownloadResult, resolution: CloudResultResolution) => void | Promise<void>;
  prepareCloudTakeover?: () => Promise<boolean>;
  applyCloudTakeover?: (takeover: CloudTakeoverPayload) => Promise<{
    documentId: string;
    fileName: string;
  } | null>;
  /** 현재 문서의 로컬 커밋과 브랜치를 관리한다. */
  versionController?: VersionManagerController;
  /** 기존 RHWP 문서 이력 대화상자를 연다. */
  openClassicVersionControl?: () => void;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';

interface TurnActivityState {
  root: HTMLElement;
  label: HTMLElement;
  content: HTMLElement;
  startedAt: number;
  toolCount: number;
  failedToolCount: number;
  activeTools: Map<string, string>;
  acceptingTools: boolean;
  settled: boolean;
}

interface ToolRowState {
  status: HTMLElement;
  result: HTMLPreElement;
  scroller: HTMLElement;
  elapsed: HTMLElement;
  startedAt: number;
  activity: TurnActivityState;
}

type ThreadActivityMessage = Extract<ThreadMessage, { kind: 'activity' }>;
type ThreadTasksMessage = Extract<ThreadMessage, { kind: 'tasks' }>;

interface ActivityTranscriptState {
  message: ThreadActivityMessage;
  acceptingTools: boolean;
}

const SIDEBAR_WIDTH_KEY = 'rhwp-agent-sidebar-width-v3';
const SIDEBAR_WIDTH_DEFAULT = 480;
/* 레이아웃 전·측정 실패 시 바닥. 실제 최솟값은 입력기 하단 한 줄의
   묶인 폭으로 매 프레임 다시 잰다. */
const SIDEBAR_WIDTH_MIN_FALLBACK = 280;
const SIDEBAR_PACKED_BUFFER_PX = 8;
const SIDEBAR_MOTION_DURATION_MS = 320;
/* 전체 화면 전환도 사이드바·용지와 같은 320ms 축을 쓴다(모션 계약).
   타이머는 전이가 끝날 때까지의 여유분을 포함한다. */
const FS_MOTION_SETTLE_MS = SIDEBAR_MOTION_DURATION_MS + 60;
/* The sidebar handoff briefly staggers its chrome after the fullscreen shell
   has folded away. Keep the class alive through the last control's entrance. */
const FS_RETURN_SETTLE_MS = 300;

const CLIPBOARD_IMAGE_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue;
    const source = item.getAsFile();
    if (!source) continue;
    const type = (item.type || source.type).toLowerCase();
    const extension = CLIPBOARD_IMAGE_EXTENSION[type];
    if (!extension) continue;
    const suppliedName = source.name.trim();
    const suppliedExtension = suppliedName.split('.').pop()?.toLowerCase();
    const hasMatchingExtension = extension === 'jpg'
      ? suppliedExtension === 'jpg' || suppliedExtension === 'jpeg'
      : suppliedExtension === extension;
    const name = hasMatchingExtension
      ? suppliedName
      : `붙여넣은 이미지 ${stamp}${files.length ? `-${files.length + 1}` : ''}.${extension}`;
    files.push(new File([source], name, { type, lastModified: Date.now() }));
  }
  return files;
}

function transferHasFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types).includes('Files'));
}

function maxSidebarWidth(minWidth: number, viewportWidth = window.innerWidth): number {
  return Math.max(minWidth, Math.floor(viewportWidth * 0.5));
}

function clampSidebarWidth(
  width: number,
  minWidth: number,
  viewportWidth = window.innerWidth,
): number {
  return Math.min(
    maxSidebarWidth(minWidth, viewportWidth),
    Math.max(minWidth, Math.round(width)),
  );
}

function readStoredSidebarWidth(minWidth = SIDEBAR_WIDTH_MIN_FALLBACK): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!raw) return SIDEBAR_WIDTH_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? clampSidebarWidth(n, minWidth) : SIDEBAR_WIDTH_DEFAULT;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function horizontalChrome(el: HTMLElement, props: string[]): number {
  const style = getComputedStyle(el);
  return props.reduce((sum, prop) => sum + (Number.parseFloat(style.getPropertyValue(prop)) || 0), 0);
}

function persistSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    /* ignore quota / private mode */
  }
}

const THREADS_RAIL_KEY = 'rhwp-agent-threads-rail-collapsed';
const ENVIRONMENT_PANEL_OPEN_KEY = 'rhwp-agent-environment-panel-open';

function readStoredThreadsRailCollapsed(): boolean {
  try {
    return localStorage.getItem(THREADS_RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

function persistThreadsRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(THREADS_RAIL_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore quota / private mode */
  }
}

function readStoredEnvironmentPanelOpen(): boolean {
  try {
    return localStorage.getItem(ENVIRONMENT_PANEL_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function persistEnvironmentPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(ENVIRONMENT_PANEL_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* ignore quota / private mode */
  }
}

/* 전체 화면의 대화 목록과 변경 사항 drawer 폭. */
const RAIL_WIDTH_KEY = 'rhwp-agent-rail-width';
const RAIL_WIDTH_DEFAULT = 264;
const RAIL_WIDTH_MIN = 200;
const REVIEW_WIDTH_KEY = 'rhwp-agent-review-width';
const REVIEW_WIDTH_DEFAULT = 480;
const REVIEW_WIDTH_MIN = 320;

function maxRailWidth(viewportWidth = window.innerWidth): number {
  return Math.max(RAIL_WIDTH_MIN, Math.floor(viewportWidth * 0.3));
}

function clampRailWidth(width: number, viewportWidth = window.innerWidth): number {
  return Math.min(maxRailWidth(viewportWidth), Math.max(RAIL_WIDTH_MIN, Math.round(width)));
}

function maxReviewWidth(viewportWidth = window.innerWidth): number {
  return Math.max(REVIEW_WIDTH_MIN, Math.floor(viewportWidth * 0.45));
}

function clampReviewWidth(width: number, viewportWidth = window.innerWidth): number {
  return Math.min(maxReviewWidth(viewportWidth), Math.max(REVIEW_WIDTH_MIN, Math.round(width)));
}

function defaultReviewWidth(): number {
  return clampReviewWidth(REVIEW_WIDTH_DEFAULT);
}

function readStoredRailWidth(): number {
  try {
    const raw = localStorage.getItem(RAIL_WIDTH_KEY);
    if (!raw) return clampRailWidth(RAIL_WIDTH_DEFAULT);
    const n = Number(raw);
    return Number.isFinite(n) ? clampRailWidth(n) : clampRailWidth(RAIL_WIDTH_DEFAULT);
  } catch {
    return clampRailWidth(RAIL_WIDTH_DEFAULT);
  }
}

function persistRailWidth(width: number): void {
  try {
    localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    /* ignore quota / private mode */
  }
}

function readStoredReviewWidth(): number {
  try {
    const raw = localStorage.getItem(REVIEW_WIDTH_KEY);
    if (!raw) return defaultReviewWidth();
    const n = Number(raw);
    return Number.isFinite(n) ? clampReviewWidth(n) : defaultReviewWidth();
  } catch {
    return defaultReviewWidth();
  }
}

function persistReviewWidth(width: number): void {
  try {
    localStorage.setItem(REVIEW_WIDTH_KEY, String(width));
  } catch {
    /* ignore quota / private mode */
  }
}

const CONN_LABEL: Record<ConnectionState, string> = {
  connected: '연결됨',
  connecting: '연결 중…',
  disconnected: '연결 끊김',
  replaced: '다른 탭에서 사용 중',
};

/** 리뷰 카드에 개별 표시할 최대 op 수 (초과분은 "외 N건"으로 축약). */
const MAX_REVIEW_OP_LINES = 6;

/* ── 작업 방식 (Direct / Plan / Question) ─────────────────
   계약은 `agent/types.ts`(AgentWorkflow · AgentPhase · StructuredPlan ·
   AgentWorkflowState)와 `agent/bridge.ts`(getWorkflowState · setWorkflow ·
   approvePlan · requestPlanChanges)에 있다. 사이드바는 그 상태를 그리고,
   승인/수정 요청 두 동작만 되돌려 보낸다. */

/** 지속 표시용 단계 라벨. direct 는 배지를 띄우지 않는다(소음). */
const PLANNING_PHASE_LABEL: Record<AgentPhase, string> = {
  direct: '바로 실행',
  planning: '구상 중',
  questioning: '질문 중',
  'awaiting-approval': '승인 대기',
  switching: '전환 중',
  implementing: '실행 중',
};

/**
 * 계획 모드를 처음 켤 때 한 번만 띄우는 원격 브라우저 전체 제어 경고.
 * 개별 동작마다 다시 묻지 않으므로, 여기서 범위를 명확히 말해야 한다.
 */
const BROWSERBASE_FULL_CONTROL_WARNING =
  '계획 모드는 원격 브라우저(Browserbase)를 전체 제어합니다. '
  + '에이전트가 동작마다 다시 묻지 않고 페이지를 열고, 양식을 제출하고, '
  + '로그인된 계정의 설정을 바꿀 수 있습니다. '
  + '내려받는 파일은 이 채팅 전용 다운로드 폴더에만 저장됩니다. '
  + '이 채팅에서 계획 모드를 켤까요?';

const BROWSERBASE_ENABLED_NOTICE =
  '계획 모드를 켰습니다. 원격 브라우저는 동작마다 확인을 묻지 않고 전체 제어로 실행되며, '
  + '양식 제출·계정 설정 변경까지 할 수 있습니다. 내려받는 파일은 이 채팅 전용 다운로드 폴더에만 저장됩니다.';

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

const OBJECT_OP_LABELS: Record<string, string> = {
  createTable: '표 만들기',
  insertImage: '그림 삽입',
  insertEquation: '수식 삽입',
  tableStructure: '표 구조 변경',
  tableStructureMarked: '표 구조 변경(승인 시 적용)',
  deleteTable: '표 삭제(승인 시 적용)',
  setCellProps: '셀 속성(승인 시 적용)',
  setTableProps: '표 속성(승인 시 적용)',
  setColumnWidths: '열 폭 설정(승인 시 적용)',
  fitToPage: '쪽 폭 맞춤(승인 시 적용)',
  setZoneProps: '셀 범위 테두리/배경(승인 시 적용)',
  applyFormula: '계산식 결과 입력(승인 시 적용)',
  setCaption: '캡션 설정(승인 시 적용)',
  paraFormat: '문단 서식',
  applyStyle: '스타일 적용(승인 시 적용)',
  pageLayout: '쪽 설정',
  headerFooter: '머리말/꼬리말',
  insertNote: '각주/미주 삽입',
  setNoteText: '각주/미주 수정',
  bookmark: '책갈피',
};

function opPreview(op: PendingOp): string {
  switch (op.kind) {
    case 'insert':
    case 'delete':
      return op.text.replace(/\n/g, '⏎');
    case 'replace':
      // 빈 새 텍스트 = 즉시 적용된 삭제
      if (op.text.length === 0) return op.deletedText.replace(/\n/g, '⏎');
      return `${op.deletedText.replace(/\n/g, '⏎')} → ${op.text.replace(/\n/g, '⏎')}`;
    case 'format':
      return JSON.stringify(op.format);
    case 'field':
      return `${op.name} → ${op.newValue}`;
    case 'template':
      return `${op.label} · template r${op.templateRevision}`;
    case 'object': {
      const label = OBJECT_OP_LABELS[op.obj.type] ?? op.obj.type;
      if (op.obj.type === 'createTable') return `${label} ${op.obj.rows}×${op.obj.cols}`;
      if (op.obj.type === 'insertEquation') return `${label} ${op.obj.script.slice(0, 40)}`;
      if (op.obj.type === 'tableStructure' || op.obj.type === 'tableStructureMarked') {
        return `${label}: ${op.obj.op}`;
      }
      if (op.obj.type === 'insertNote') {
        return `${op.obj.noteKind === 'endnote' ? '미주' : '각주'} 삽입: ${op.obj.text.slice(0, 40)}`;
      }
      if (op.obj.type === 'setNoteText') return `${label}: ${op.obj.text.slice(0, 40)}`;
      if (op.obj.type === 'bookmark') {
        const opName = op.obj.op === 'add' ? '추가' : op.obj.op === 'delete' ? '삭제' : '이름 변경';
        return `${label} ${opName}${op.obj.name ? `: ${op.obj.name}` : ''}`;
      }
      return label;
    }
  }
}

/**
 * op 좌표 readout — `§1 ¶42 c0–18`. 편집이 어디에 걸리는지 카드가 스스로
 * 말하게 한다(본문 좌표계, 0-based). 셀 안이면 셀 인덱스를 앞에 붙인다.
 */
function opAddress(range: DocRange): string {
  const section = `§${range.sectionIdx + 1}`;
  const cell = range.cell ? ` ▦${range.cell.cellIdx}` : '';
  const sameParagraph = range.startParaIdx === range.endParaIdx;
  const para = sameParagraph
    ? `¶${range.startParaIdx}`
    : `¶${range.startParaIdx}–${range.endParaIdx}`;
  const chars = sameParagraph
    ? ` c${range.startCharOffset}–${range.endCharOffset}`
    : ` c${range.startCharOffset}→${range.endCharOffset}`;
  return `${section}${cell} ${para}${chars}`;
}

/** 부호 열(−/+)을 가진 diff 한 줄. 부호는 장식이 아니라 정렬 기준이다. */
function buildDiffLine(kind: 'add' | 'del' | 'ctx', text: string): HTMLElement {
  const line = el('div', `ag-diff-line ag-diff-${kind}`);
  const sign = el('span', 'ag-diff-sign', kind === 'add' ? '+' : kind === 'del' ? '−' : '·');
  sign.setAttribute('aria-hidden', 'true');
  line.append(sign, el('span', 'ag-diff-text', truncate(text.replace(/\n/g, '⏎'), 120)));
  return line;
}

/**
 * 손그림 버튼용 displacement 필터 정의. CSS 의 filter: url(#ag-sketch-line)
 * 참조는 문서 안의 실제 정의를 필요로 하므로 사이드바 루트에 한 번 심는다.
 * display:none 으로 숨기면 Safari 가 참조를 무시하므로 0 크기로만 둔다
 * (.ag-sketch-defs).
 */
function createSketchFilterDefs(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('ag-sketch-defs');
  svg.setAttribute('aria-hidden', 'true');
  const filter = document.createElementNS(NS, 'filter');
  filter.setAttribute('id', 'ag-sketch-line');
  const turbulence = document.createElementNS(NS, 'feTurbulence');
  turbulence.setAttribute('type', 'fractalNoise');
  turbulence.setAttribute('baseFrequency', '0.04');
  turbulence.setAttribute('numOctaves', '2');
  turbulence.setAttribute('seed', '7');
  turbulence.setAttribute('result', 'noise');
  const displacement = document.createElementNS(NS, 'feDisplacementMap');
  displacement.setAttribute('in', 'SourceGraphic');
  displacement.setAttribute('in2', 'noise');
  displacement.setAttribute('scale', '3');
  filter.append(turbulence, displacement);
  svg.appendChild(filter);
  return svg;
}

export function initAgentSidebar(deps: AgentSidebarDeps): {
  root: HTMLElement;
  openVersions(): void;
  sendInlinePrompt(submission: InlinePromptSubmission): InlinePromptSendResult;
  awaitPendingCloudTransferForClose(): Promise<void>;
  dispose(): void;
} {
  const {
    bridge,
    eventBus,
    editorSettingsRuntime,
    getDocumentContext,
    moveToLibraryDocument,
    versionController,
    openClassicVersionControl,
  } = deps;
  const cloudController = deps.cloudController ?? createCloudController();

  // 개인 기본값(설정 탭에서 저장) — 새 대화가 이 조합으로 열린다.
  let agentPrefs: AgentPrefs = loadAgentPrefs();
  let selectedAgent: AgentName = bridge.getActiveAgent() ?? agentPrefs.defaultAgent;
  let selectedModel = resolveModelForAgent(selectedAgent, agentPrefs.defaultModel);
  let selectedEffort = resolveEffortForAgent(selectedAgent, agentPrefs.defaultEffort, selectedModel);
  let selectedServiceTier: ServiceTier = resolveServiceTier(selectedAgent, null);
  let connState: ConnectionState = bridge.getConnectionState();
  /** 지금까지 실패한 연결 시도 수 · 다음 자동 재시도 시각 (배너 카운트다운). */
  let connAttempt = 0;
  let connRetryAt: number | null = null;
  let connCountdownTimer: number | null = null;
  let turnRunning = bridge.isTurnRunning();
  let mergeResolverLocked = false;
  /** 지금 노란 불이 붙어 있는 스레드 — 턴이 끝나면 초록 점으로 넘긴다. */
  let runStatusThreadId: string | null = null;
  let workflowTransitionPending = false;
  let cloudTransferPending = false;
  let cloudTransferIntent: CloudSessionScope | null = null;
  let cloudTransferIntentPromise: Promise<void> | null = null;
  let cloudTransferCloseWaiter: {
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
  } | null = null;
  /** chat-started 후 입력기를 여는 건 마지막으로 요청한 스레드뿐이다. */
  let chatStartPendingThreadId: string | null = null;
  /** 계획 모드로 들어갈 때 안전 권한이면 전환 완료 후 전체 접근을 기본 적용한다. */
  let planPermissionDefaultPending = false;
  /** 현재 스트리밍 중인 assistant 텍스트 (tool-call 이후에는 새로 연다). */
  let streamBubble: HTMLElement | null = null;
  const toolRows = new Map<string, ToolRowState>();
  let turnActivity: TurnActivityState | null = null;
  let turnToolCount = 0;
  let turnFailedToolCount = 0;
  let activityTranscript: ActivityTranscriptState | null = null;
  const activityTranscripts = new Map<string, ActivityTranscriptState>();
  const transcriptTools = new Map<string, { tool: ThreadToolRecord; activity: ActivityTranscriptState; startedAt: number }>();
  let tasksTranscript: ThreadTasksMessage | null = null;
  const transcriptTasks = new Map<string, ThreadTaskRecord>();
  const taskToolRecords = new Map<string, { tool: ThreadToolRecord; task: ThreadTaskRecord; startedAt: number }>();
  const taskTextBuffers = new Map<string, string>();
  let turnPresentedPlan = false;
  let planCardPending = false;
  let followConversation = true;
  let conversationScrollRaf: number | null = null;
  let conversationScrollLock = false;
  let conversationScrollUnlock: number | null = null;
  let replyPending = false;
  /** 편대 카드가 대신 나타내는 스폰 도구 호출 — 결과 행도 함께 접는다. */
  const suppressedSpawnCalls = new Set<string>();
  /**
   * 서브에이전트·워크플로 카드. 턴이 도는 동안 입력기 위 도크 팝업이 서브에이전트
   * 작업을 보는 자리이고, 턴이 끝나면 태어날 때 예약한 슬롯으로 접혀 정착한다.
   */
  const fleetView = createSubagentFleet({
    doc: document,
    sessionModel: (agent) => (agent === selectedAgent ? selectedModel : null),
    // 카드가 태어난 자리를 흐름에 예약한다. 도구 활동 그룹과 같은 자리로 끼워
    // 넣어 흐름 순서를 지키고, 이 뒤의 도구 호출은 새 그룹으로 연다.
    mountSlot(slot) {
      flushAssistantBuffer({ kind: 'progress' });
      const milestone = compactStreamIntoActivity(selectedAgent);
      // 방금 닫는 도구 활동 그룹이 있으면 그 옆자리에 선다 — 정착한 기록이 바로 위
      // 도구 기록과 같은 들여쓰기로 줄을 맞춘다 (이정표 안의 그룹은 17px 들여쓴다).
      const neighbor = turnActivity?.root ?? null;
      closeCurrentActivityGroup();
      withAutoScroll(() => {
        if (milestone) milestone.appendChild(slot);
        else if (neighbor?.parentElement) neighbor.parentElement.appendChild(slot);
        else appendConversation(slot);
      });
      streamBubble = null;
    },
    // 팝업이 열리면 펼쳐 둔 도구 활동 그룹을 접는다 — 같은 모양의 살아 있는
    // 기록이 둘 펼쳐져 있지 않게 한다 (반대 방향은 그룹 토글이 맡는다).
    onPopupToggle(open) {
      if (open) collapseTurnActivity();
    },
  });
  let insetRecenterRaf: number | null = null;
  let resizeMoveRaf: number | null = null;
  let resizeMoveX = 0;
  // ── 문서별 채팅 격리 ──────────────────────────────────
  // 채팅은 만들어질 때의 문서(docKey)에 묶인다. 문서가 바뀌면 새 채팅을
  // 자동으로 시작하고, 다른 문서의 채팅은 읽기 전용으로만 열린다.
  let currentDocKey: string | null = getDocumentContext?.().documentName ?? null;
  let currentDocumentId: string | null = getDocumentContext?.().documentId ?? null;
  /** 읽기 전용으로 열람 중인 다른 문서 채팅의 문서 라벨 (null = 정상 모드). */
  let readOnlyDocLabel: string | null = null;
  /** 문서 그룹 접힘/펼침 — 사용자가 손댄 그룹만 기억한다(키: documentId ?? docKey ?? ''). */
  const docGroupToggles = new Map<string, boolean>();
  let currentThread = createEmptyThread({
    agent: selectedAgent,
    model: selectedModel,
    effort: selectedEffort,
    serviceTier: selectedServiceTier,
    docKey: currentDocKey,
    documentId: currentDocumentId,
  });
  let assistantBuffer = '';
  let assistantRenderFrame: number | null = null;
  let pendingAssistantBubble: HTMLElement | null = null;
  const assistantBubbleSources = new WeakMap<HTMLElement, string>();
  let attachmentsSending = false;
  let threadsPanelOpen = false;
  let skillsPanelOpen = false;
  let settingsPanelOpen = false;
  let versionsPanelOpen = false;
  let deferredVersionsOpenTimer: number | null = null;
  /** 에이전트 집중 모드 — 스레드 레일과 대화 무대로 문서를 덮는다. */
  let fullscreen = false;
  let threadsRailCollapsed = readStoredThreadsRailCollapsed();
  let environmentPanelOpen = readStoredEnvironmentPanelOpen();
  // 검토 drawer는 focus mode에 들어갈 때마다 닫힌 상태로 시작하며,
  // 환경 패널의 `변경 사항` 행을 눌렀을 때만 열린다.
  let reviewColCollapsed = true;
  let planColCollapsed = true;
  let planMinimized = false;
  /** 기록에서 연 계획은 표시 전용이며 현재 계획 workflow 상태를 절대 나타내지 않는다. */
  let activePlanHistorical = false;
  let pendingReviewOpCount = 0;
  let railWidth = readStoredRailWidth();
  let reviewWidth = readStoredReviewWidth();
  // 살아 있는 세션의 권한이 우선이고, 새로 시작하는 경우에만 기본값을 쓴다.
  let permissionProfile: PermissionProfile = bridge.getActiveAgent() !== null
    ? bridge.getPermissionProfile()
    : agentPrefs.defaultPermissionProfile;
  let skillCatalog: SkillCatalog = { revision: 0, skills: [] };
  /** textarea와 분리되어 렌더되는 현재 product-skill 호출. */
  let activeComposerSkill: ProductSkill | null = null;
  let templateCatalog: TemplateCatalog = { revision: 0, templates: [] };
  let activeTemplate: DocumentTemplate | null = null;
  let skillDraftFiles: Array<{ path: string; content: string; encoding: 'utf8' | 'base64' }> = [];
  let selectedSkillIcon: ProductSkillIcon = 'system';
  let selectedSkillFile = 'SKILL.md';
  let editingSkill: ProductSkill | null = null;
  let skillValidationReady = false;
  let skillDraftRevision = 0;
  let configHideTimer: number | null = null;
  let configPanelOpen = false;
  const skillValidationRequests = new Map<string, number>();
  let activeSkillDraftRequestId: string | null = null;
  const skillRequestActions = new Map<string, 'edit' | 'duplicate'>();

  // ── 계획 모드 상태 ────────────────────────────────────
  const initialWorkflowState: AgentWorkflowState = bridge.getWorkflowState();
  let chatWorkflow: AgentWorkflow = initialWorkflowState.workflow;
  let planningPhase: AgentPhase = initialWorkflowState.phase;
  let activePlan: StructuredPlan | null = planningPhase === 'implementing'
    ? null
    : initialWorkflowState.latestPlan;
  /** 서버가 현재 살아 있다고 말한 계획만 승인할 수 있다(기록 복원본은 읽기 전용). */
  let planApprovable = activePlan !== null && planningPhase === 'awaiting-approval';
  /** 이 채팅에서 원격 브라우저 전체 제어 경고를 이미 받았는가. */
  let browserbaseAcknowledged = chatWorkflow === 'plan' || chatWorkflow === 'question';
  /** 계획 모드 전환이 서버에서 확인된 뒤에만 활성화 안내를 표시한다. */
  let browserbaseNoticePending = false;
  let planHistory: StructuredPlan[] = initialWorkflowState.latestPlan ? [initialWorkflowState.latestPlan] : [];
  /** 채팅별 계획 기록/모드 — 목록에서 되돌아왔을 때 표시를 복원한다. */
  const planArchives = new Map<string, StructuredPlan[]>();
  const threadWorkflows = new Map<string, AgentWorkflow>();

  function startCurrentBridgeChat(force = false): void {
    // 새 채팅·스레드 전환(force)만 입력기를 잠근다. 모델/추론 강도만 바꿀 때는
    // 같은 대화를 다시 열 뿐이라 입력칸·피커가 비활성으로 깜빡이지 않게 둔다.
    bridge.setServiceTier(selectedServiceTier);
    if (force) chatStartPendingThreadId = currentThread.id;
    const history = currentThread.messages.flatMap((message) => (
      (message.role === 'user' || (message.role === 'assistant' && message.kind === undefined))
        && (message.text.trim() || (message.role === 'user' && message.skillName))
        ? [{
            role: message.role,
            text: message.role === 'user' && message.skillName
              ? `/${message.skillName}${message.text.trim() ? ` ${message.text}` : ''}`
              : message.text,
          }]
        : []
    ));
    bridge.startChat(selectedAgent, selectedModel, selectedEffort, force, permissionProfile, chatWorkflow,
      currentThread.id, currentThread.documentId, currentThread.docKey, history);
    if (force) updateComposer();
  }

  // ── DOM 구성 ──────────────────────────────────────────
  const root = document.createElement('aside');
  root.id = 'agent-sidebar';
  root.className = 'ag-root';
  root.dataset.agent = selectedAgent;
  root.appendChild(createSketchFilterDefs());

  const collapseTab = el('button', 'ag-collapse-tab');
  collapseTab.type = 'button';
  collapseTab.setAttribute('aria-label', '에이전트 사이드바 숨기기');
  collapseTab.setAttribute('aria-expanded', 'true');
  collapseTab.title = '에이전트 사이드바 숨기기';
  const rauIcon = el('span', 'ag-rau-icon');
  rauIcon.setAttribute('aria-hidden', 'true');
  collapseTab.appendChild(rauIcon);

  const resizeHandle = el('div', 'ag-resize-handle');
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-label', '사이드바 너비 조절');
  resizeHandle.setAttribute('aria-orientation', 'vertical');
  resizeHandle.title = '드래그하여 너비 조절';
  resizeHandle.tabIndex = 0;

  let sidebarWidthMin = SIDEBAR_WIDTH_MIN_FALLBACK;
  let sidebarWidth = readStoredSidebarWidth(sidebarWidthMin);

  function applySidebarWidth(width: number, opts?: { persist?: boolean; recenter?: boolean }): number {
    sidebarWidth = clampSidebarWidth(width, sidebarWidthMin);
    document.documentElement.style.setProperty('--ag-sidebar-width', `${sidebarWidth}px`);
    resizeHandle.setAttribute('aria-valuenow', String(sidebarWidth));
    resizeHandle.setAttribute('aria-valuemin', String(sidebarWidthMin));
    resizeHandle.setAttribute('aria-valuemax', String(maxSidebarWidth(sidebarWidthMin)));
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
    const durationMs = SIDEBAR_MOTION_DURATION_MS;
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
    const label = collapsed ? '에이전트 사이드바 펼치기' : '에이전트 사이드바 숨기기';
    collapseTab.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    collapseTab.setAttribute('aria-label', label);
    collapseTab.title = label;
    eventBus?.emit('agent-sidebar-visibility-changed', { open: !collapsed });
    if (opts?.recenter !== false) startInsetRecenterLoop();
  }

  applySidebarWidth(sidebarWidth, { persist: false, recenter: false });

  const RESIZE_DRAG_THRESHOLD_PX = 4;
  let resizing = false;
  let resizeArmed = false;
  let resizeStartX = 0;
  let resizeStartWidth = sidebarWidth;

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
    setConfigPanelOpen(false);
    document.body.classList.add('ag-sidebar-resizing', 'ag-sidebar-animating');
    window.addEventListener('pointermove', onResizePointerMove, true);
    window.addEventListener('pointerup', endSidebarResize, true);
    window.addEventListener('pointercancel', endSidebarResize, true);
  }

  function applyResizeMove(): void {
    resizeMoveRaf = null;
    if (!resizing || !resizeArmed) return;
    applySidebarWidth(resizeStartWidth + (resizeStartX - resizeMoveX), {
      persist: false,
      recenter: false,
    });
  }

  function onResizePointerMove(e: PointerEvent): void {
    if (!resizing) return;
    e.preventDefault();
    resizeMoveX = e.clientX;
    if (!resizeArmed) {
      if (Math.abs(resizeMoveX - resizeStartX) < RESIZE_DRAG_THRESHOLD_PX) return;
      resizeArmed = true;
    }
    // pointermove 는 프레임보다 잦다. 폭·용지 정렬은 한 프레임에 한 번만 한다.
    if (resizeMoveRaf !== null) return;
    resizeMoveRaf = requestAnimationFrame(applyResizeMove);
  }

  function endSidebarResize(): void {
    if (!resizing) return;
    if (resizeMoveRaf !== null) {
      cancelAnimationFrame(resizeMoveRaf);
      applyResizeMove();
    }
    resizing = false;
    resizeArmed = false;
    document.body.classList.remove('ag-sidebar-resizing', 'ag-sidebar-animating');
    detachResizeWindowListeners();
    applySidebarWidth(sidebarWidth, { persist: true, recenter: true });
  }

  function onResizeHandlePointerDown(e: PointerEvent): void {
    if (root.classList.contains('ag-collapsed')) return;
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    beginSidebarResize(e.clientX);
    resizeArmed = true;
  }

  collapseTab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (fullscreen) return;
    setCollapsed(!root.classList.contains('ag-collapsed'));
  });

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
      applySidebarWidth(sidebarWidthMin, { persist: true, recenter: true });
    } else if (e.key === 'End') {
      e.preventDefault();
      applySidebarWidth(maxSidebarWidth(sidebarWidthMin), { persist: true, recenter: true });
    }
  });

  /* pi · rau 는 설정이 끝나야 입력기 메뉴에 선다 (설정 탭에는 늘 있다). */
  let piSetupComplete = false;
  let rauSetupComplete = false;
  let lastUsage: UsageSummary | null = null;

  const header = el('header', 'ag-header');
  const selectors = el('div', 'ag-selectors');

  // ── 프로바이더 피커 (Claude / Codex / Pi / Grok / Cursor) ──
  const providerWrap = el('div', 'ag-model ag-provider');
  const providerTrigger = el('button', 'ag-model-trigger');
  providerTrigger.type = 'button';
  providerTrigger.setAttribute('aria-expanded', 'false');
  providerTrigger.setAttribute('aria-controls', 'ag-config-panel');
  providerTrigger.setAttribute('aria-label', '프로바이더 선택');
  let providerIcon = createProviderIcon(selectedAgent);
  const providerName = el('span', 'ag-model-name', AGENT_LABEL[selectedAgent]);
  providerTrigger.append(providerIcon, providerName);

  const providerMenu = el('div', 'ag-model-menu');
  providerMenu.setAttribute('role', 'menu');
  providerMenu.setAttribute('aria-hidden', 'true');
  const providerItems = new Map<AgentName, HTMLButtonElement>();

  function selectAgent(agent: AgentName): void {
    if (isControlLocked()) return;
    setSelectedAgent(agent);
    selectedModel = resolveModelForAgent(agent, selectedModel);
    selectedEffort = resolveEffortForAgent(agent, selectedEffort, selectedModel);
    selectedServiceTier = resolveServiceTier(agent, selectedServiceTier);
    rebuildLlmMenu();
    rebuildEffortMenu();
    updateWorkspaceAgentContext();
    startCurrentBridgeChat();
    refreshSidebarWidthMin();
    providerTrigger.focus();
  }

  for (const agent of PROVIDER_ORDER) {
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

  /** 메뉴에 실제로 서 있는 항목만 (숨은 pi 는 건너뛴다). */
  function visibleProviderItems(): HTMLButtonElement[] {
    return PROVIDER_ORDER
      .map((name) => providerItems.get(name))
      .filter((item): item is HTMLButtonElement => !!item && !item.hidden);
  }

  function syncProviderMenu(): void {
    const pi = providerItems.get('pi');
    if (pi) pi.hidden = !piSetupComplete && selectedAgent !== 'pi';
    const rau = providerItems.get('rau');
    if (rau) rau.hidden = !rauSetupComplete && selectedAgent !== 'rau';
  }

  function rauCreditsEmpty(): boolean {
    const credits = lastUsage?.rau;
    return rauSetupComplete && credits != null && credits.balanceUsd <= 0 && !credits.error;
  }

  syncProviderMenu();

  providerTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isControlLocked()) return;
    setConfigPanelOpen(!configPanelOpen);
  });
  providerTrigger.addEventListener('keydown', (e) => {
    if (isControlLocked()) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setConfigPanelOpen(true);
      providerItems.get(selectedAgent)?.focus();
    } else if (e.key === 'Escape') {
      setConfigPanelOpen(false);
    }
  });
  providerMenu.addEventListener('keydown', (e) => {
    const items = visibleProviderItems();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setConfigPanelOpen(false);
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

  providerWrap.append(providerTrigger);

  // ── 모델 피커 (프로바이더에 따라 옵션 교체) ──────────
  const llmWrap = el('div', 'ag-model ag-llm');
  const llmTrigger = el('button', 'ag-model-trigger ag-llm-trigger');
  llmTrigger.type = 'button';
  llmTrigger.setAttribute('aria-expanded', 'false');
  llmTrigger.setAttribute('aria-controls', 'ag-config-panel');
  llmTrigger.setAttribute('aria-label', '모델 선택');
  const llmName = el('span', 'ag-llm-name', labelForModel(selectedAgent, selectedModel));
  llmTrigger.append(llmName);

  const llmMenu = el('div', 'ag-model-menu ag-llm-menu');
  llmMenu.setAttribute('role', 'menu');
  llmMenu.setAttribute('aria-hidden', 'true');
  let llmItems = new Map<string, HTMLButtonElement>();

  function selectModel(modelId: string): void {
    if (isControlLocked()) return;
    selectedModel = resolveModelForAgent(selectedAgent, modelId);
    selectedEffort = resolveEffortForAgent(selectedAgent, selectedEffort, selectedModel);
    llmName.textContent = labelForModel(selectedAgent, selectedModel);
    for (const [id, item] of llmItems) {
      const active = id === selectedModel;
      item.classList.toggle('ag-active', active);
      item.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    rebuildEffortMenu();
    updateWorkspaceAgentContext();
    startCurrentBridgeChat();
    refreshSidebarWidthMin();
    llmTrigger.focus();
  }

  function rebuildLlmMenu(): void {
    llmMenu.replaceChildren();
    llmItems = new Map();
    for (const group of modelGroupsForAgent(selectedAgent)) {
      // cursor 의 과금 풀 구분 — 구독 사용량 차감 모델과 API 과금 모델을 가른다.
      if (group.label) llmMenu.appendChild(el('span', 'ag-llm-group-label', group.label));
      for (const opt of group.options) {
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
    }
    llmName.textContent = labelForModel(selectedAgent, selectedModel);
  }

  llmTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isControlLocked()) return;
    setConfigPanelOpen(!configPanelOpen);
  });
  llmTrigger.addEventListener('keydown', (e) => {
    if (isControlLocked()) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setConfigPanelOpen(true);
      llmItems.get(selectedModel)?.focus();
    } else if (e.key === 'Escape') {
      setConfigPanelOpen(false);
    }
  });
  llmMenu.addEventListener('keydown', (e) => {
    const ids = [...llmItems.keys()];
    const items = ids.map((id) => llmItems.get(id)!);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setConfigPanelOpen(false);
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
  llmWrap.append(llmTrigger);

  // ── Effort 피커 (프로바이더/모델이 지원하는 수준) ────
  const effortWrap = el('div', 'ag-model ag-effort');
  const effortTrigger = el('button', 'ag-model-trigger ag-effort-trigger');
  effortTrigger.type = 'button';
  effortTrigger.setAttribute('aria-expanded', 'false');
  effortTrigger.setAttribute('aria-controls', 'ag-config-panel');
  effortTrigger.setAttribute('aria-label', '추론 강도 선택');
  const effortName = el(
    'span',
    'ag-effort-name',
    labelForEffort(selectedAgent, selectedEffort, selectedModel),
  );
  const summaryCaret = createChevron('ag-summary-caret');
  effortTrigger.append(effortName, summaryCaret);

  // 설정 패널의 '추론' 묶음 — 슬라이더는 이 안에 들어가므로 강도 옵션이 없는
  // 프로바이더(cursor)에서는 트리거뿐 아니라 이 묶음도 함께 접어야 빈 칸이 남지 않는다.
  const effortGroup = el('div', 'ag-config-group');
  const effortSlider = createEffortSlider({
    ariaLabel: '추론 강도',
    onChange: (effortId) => selectEffort(effortId),
    // 드래그 중 지나가는 눈금을 요약 라벨에 미리 비춘다.
    onPreview: (effortId) => {
      effortName.textContent = labelForEffort(selectedAgent, effortId, selectedModel);
    },
  });
  effortGroup.append(el('span', 'ag-config-label', '추론'), effortSlider.root);

  function selectEffort(effortId: string): void {
    if (isControlLocked()) return;
    selectedEffort = resolveEffortForAgent(selectedAgent, effortId, selectedModel);
    effortName.textContent = labelForEffort(selectedAgent, selectedEffort, selectedModel);
    effortSlider.setValue(selectedEffort);
    startCurrentBridgeChat();
    updateWorkspaceAgentContext();
    refreshSidebarWidthMin();
  }

  function rebuildEffortMenu(): void {
    const options = effortsForAgent(selectedAgent, selectedModel);
    // 추론 강도를 받지 않는 모델(pi 의 비추론 모델, cursor 전체)에서는
    // 트리거와 설정 패널의 '추론' 묶음을 함께 접는다.
    const noEfforts = options.length === 0;
    effortWrap.hidden = noEfforts;
    effortGroup.hidden = noEfforts;
    // 카탈로그는 강함 → 약함 — 슬라이더는 왼쪽이 약함이라 뒤집어 깐다.
    effortSlider.setOptions([...options].reverse(), selectedEffort);
    effortName.textContent = labelForEffort(selectedAgent, selectedEffort, selectedModel);
  }

  effortTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isControlLocked()) return;
    setConfigPanelOpen(!configPanelOpen);
  });
  effortTrigger.addEventListener('keydown', (e) => {
    if (isControlLocked()) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setConfigPanelOpen(true);
      effortSlider.root.focus();
    } else if (e.key === 'Escape') {
      setConfigPanelOpen(false);
    }
  });
  effortSlider.root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setConfigPanelOpen(false);
      effortTrigger.focus();
    }
  });

  rebuildEffortMenu();
  effortWrap.append(effortTrigger);

  const threadsBtn = el('button', 'ag-threads-btn');
  threadsBtn.type = 'button';
  threadsBtn.setAttribute('aria-label', '채팅 목록');
  threadsBtn.setAttribute('aria-expanded', 'false');
  threadsBtn.setAttribute('aria-controls', 'ag-threads-panel');
  threadsBtn.title = '채팅 목록';
  threadsBtn.appendChild(createColumnIcon());

  const permissionBtn = el('button', 'ag-permission-btn');
  permissionBtn.type = 'button';
  permissionBtn.setAttribute('aria-label', '에이전트 권한 설정');

  const skillsBtn = el('button', 'ag-skills-btn', '스킬');
  skillsBtn.type = 'button';
  skillsBtn.setAttribute('aria-label', '스킬 라이브러리');
  skillsBtn.setAttribute('aria-expanded', 'false');
  skillsBtn.setAttribute('aria-controls', 'ag-skills-panel');

  const conn = el('span', 'ag-conn');
  conn.setAttribute('role', 'status');
  conn.setAttribute('aria-live', 'polite');

  const takeoverBtn = el('button', 'ag-takeover-btn', '이 탭에서 연결');
  takeoverBtn.type = 'button';
  takeoverBtn.hidden = true;
  takeoverBtn.addEventListener('click', () => bridge.takeOverConnection());

  const documentContext = el('div', 'ag-document-context');
  const documentName = el('span', 'ag-document-name', '문서 없음');
  const selectionContext = el('span', 'ag-selection-context', '선택 없음');
  documentContext.append(documentName, selectionContext);

  const headerActions = el('div', 'ag-header-actions');
  threadsBtn.classList.add('ag-header-icon-btn');

  // 콘솔 펼치기 — 사이드바 폭에서는 diff 를 읽을 수 없어 전체 화면으로 넘긴다.
  const fullscreenBtn = el('button', 'ag-header-icon-btn ag-fullscreen-btn');
  fullscreenBtn.type = 'button';
  fullscreenBtn.setAttribute('aria-pressed', 'false');
  let fullscreenIcon = createIcon('expand');
  fullscreenBtn.appendChild(fullscreenIcon);
  fullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setFullscreen(!fullscreen);
  });

  // 설정 — 연결/기본값/사용량이 사는 페이지. 헤더 아이콘 한 자리만 쓴다.
  const settingsBtn = el('button', 'ag-header-icon-btn ag-settings-btn');
  settingsBtn.type = 'button';
  settingsBtn.setAttribute('aria-label', '설정');
  settingsBtn.setAttribute('aria-expanded', 'false');
  settingsBtn.setAttribute('aria-controls', 'ag-settings-panel');
  settingsBtn.title = '설정';
  settingsBtn.appendChild(createIcon('gear'));
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    requestSettingsOpen();
  });

  const versionsBtn = el('button', 'ag-header-icon-btn ag-versions-btn');
  versionsBtn.type = 'button';
  versionsBtn.setAttribute('aria-label', '버전');
  versionsBtn.setAttribute('aria-expanded', 'false');
  versionsBtn.setAttribute('aria-controls', 'ag-versions-panel');
  versionsBtn.title = '버전';
  versionsBtn.appendChild(createIcon('changes'));
  versionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openConfiguredVersionControl();
  });

  // pane 액션은 문서 맥락 주변의 고정된 헤더 위치를 유지한다.
  headerActions.append(versionsBtn, settingsBtn, threadsBtn);

  selectors.append(providerWrap, llmWrap, effortWrap);
  const modelSummary = el('div', 'ag-model-summary');

  const configPanel = el('div', 'ag-config-panel');
  configPanel.id = 'ag-config-panel';
  configPanel.hidden = true;
  configPanel.setAttribute('role', 'group');
  configPanel.setAttribute('aria-label', '에이전트 설정');
  configPanel.setAttribute('aria-hidden', 'true');
  const configPanelInner = el('div', 'ag-config-panel-inner');
  const providerGroup = el('div', 'ag-config-group');
  providerGroup.append(el('span', 'ag-config-label', '에이전트'), providerMenu);
  const llmGroup = el('div', 'ag-config-group');
  llmGroup.append(el('span', 'ag-config-label', '모델'), llmMenu);
  configPanelInner.append(providerGroup, llmGroup, effortGroup);
  configPanel.append(configPanelInner);

  const contextRow = el('div', 'ag-context-row');
  contextRow.append(documentContext);

  const connectionRow = el('div', 'ag-connection-row');
  connectionRow.append(conn, takeoverBtn);
  modelSummary.append(fullscreenBtn, contextRow, headerActions);
  header.append(modelSummary, connectionRow);

  function updateDocumentContext(): void {
    const context = getDocumentContext?.();
    const currentDocumentName = context?.documentName || '문서 없음';
    documentName.textContent = currentDocumentName;
    documentName.title = context?.documentName || '';
    selectionContext.textContent = context?.selectionLabel || '선택 없음';
    workspaceDocumentName.textContent = currentDocumentName;
    workspaceDocumentName.title = context?.documentName || '';
    workspaceSelectionContext.textContent = context?.selectionLabel || '선택 없음';
    updateEnvironmentFilename(currentDocumentName);
    const nextKey = context?.documentName ?? null;
    const nextDocumentId = context?.documentId ?? null;
    if (nextKey !== currentDocKey || nextDocumentId !== currentDocumentId) {
      handleDocumentSwitch(nextKey, nextDocumentId);
    }
  }

  /** 스레드 목록이 지금 화면에 있는가 — 사이드바에선 패널일 때만,
      전체 화면에선 레일이 접혀 있지 않으면 항상 보인다. */
  function threadsListVisible(): boolean {
    return threadsPanelOpen || (fullscreen && !threadsRailCollapsed);
  }

  /**
   * 문서가 바뀌면 현재 채팅을 끝내고 새 문서용 채팅을 연다. 메시지가
   * 있는 채팅은 원래 문서 그룹에 남고, 빈 채팅은 저장되지 않은 채 사라진다.
   */
  function handleDocumentSwitch(nextKey: string | null, nextDocumentId: string | null): void {
    // 문서를 연 순간만 그룹 순서가 움직인다 — 옛 채팅 열람은 순서를 건드리지 않는다.
    recordDocumentOpened(nextDocumentId, nextKey);
    const sameIdentity = Boolean(
      nextDocumentId && currentDocumentId && nextDocumentId === currentDocumentId,
    );
    if (sameIdentity) {
      // 첫 저장으로 파일명만 바뀐 경우 — 현재 문서의 채팅만 새 이름을 따른다.
      const activeThreadMatchesDocument = readOnlyDocLabel === null
        && threadMatchesDocument(currentThread, currentDocumentId, currentDocKey);
      currentDocKey = nextKey;
      currentDocumentId = nextDocumentId;
      if (activeThreadMatchesDocument) {
        currentThread.docKey = nextKey;
        currentThread.documentId = nextDocumentId;
        persistCurrentThread();
      }
      referenceLibrary.contextChanged();
      rebuildThreadsList();
      cloudUi.refreshScope();
      return;
    }
    currentDocKey = nextKey;
    currentDocumentId = nextDocumentId;
    startNewChat({ silent: true });
    rebuildThreadsList();
  }

  function setConfigPanelOpen(open: boolean): void {
    configPanelOpen = open;
    if (configHideTimer !== null) {
      window.clearTimeout(configHideTimer);
      configHideTimer = null;
    }
    if (open) {
      configPanel.hidden = false;
      // Ensure the collapsed grid is painted before expanding it.
      void configPanel.offsetHeight;
      configPanel.classList.add('ag-open');
    } else {
      configPanel.classList.remove('ag-open');
      configHideTimer = window.setTimeout(() => {
        if (!configPanelOpen) configPanel.hidden = true;
        configHideTimer = null;
      }, 240);
    }
    configPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    composerMeta.classList.toggle('ag-expanded', open);
    for (const trigger of [providerTrigger, llmTrigger, effortTrigger]) {
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    for (const menu of [providerMenu, llmMenu]) {
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
  }

  const onDocPointerDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!composer.contains(t)) setConfigPanelOpen(false);
  };
  document.addEventListener('pointerdown', onDocPointerDown);

  /* Esc 로 전체 화면을 접는다. 설정 패널이 열려 있으면 그쪽이 먼저
     닫히고, 입력 중 IME 조합은 가로채지 않는다. */
  const onDocKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !fullscreen) return;
    if (e.isComposing) return;
    if (configPanelOpen) {
      setConfigPanelOpen(false);
      e.preventDefault();
      return;
    }
    if (root.classList.contains('ag-detail-drawer-open')) {
      if (root.classList.contains('ag-plan-drawer-open')) setPlanColCollapsed(true);
      else setReviewColCollapsed(true);
      environmentToggle.focus();
      e.preventDefault();
      return;
    }
    setFullscreen(false);
    e.preventDefault();
  };
  document.addEventListener('keydown', onDocKeyDown);

  const stage = el('div', 'ag-stage');

  /* 집중 모드는 사이드바를 늘린 화면이 아니라 독립된 작업 공간이다.
     이 bar는 viewport 전체를 가로지르며 pane 토글, 문서 맥락,
     대화 제목, 실행 맥락과 종료 동작을 한 축에 고정한다. */
  const workspaceBar = el('header', 'ag-workspace-bar');
  const workspaceLeading = el('div', 'ag-workspace-leading');
  const workspaceThreadsBtn = el('button', 'ag-workspace-icon-btn ag-workspace-threads-btn');
  workspaceThreadsBtn.type = 'button';
  workspaceThreadsBtn.setAttribute('aria-controls', 'ag-threads-panel');
  workspaceThreadsBtn.setAttribute('aria-expanded', 'true');
  workspaceThreadsBtn.setAttribute('aria-label', '대화 목록 접기');
  workspaceThreadsBtn.title = '대화 목록 접기';
  workspaceThreadsBtn.appendChild(createColumnIcon());
  const workspaceSettingsBack = el('button', 'ag-workspace-icon-btn ag-workspace-settings-back');
  workspaceSettingsBack.type = 'button';
  workspaceSettingsBack.setAttribute('aria-label', '대화로 돌아가기');
  workspaceSettingsBack.title = '대화로 돌아가기';
  workspaceSettingsBack.appendChild(createIcon('close'));

  const workspaceDocumentContext = el('div', 'ag-workspace-document-context');
  const workspaceDocumentName = el('span', 'ag-workspace-document-name', '문서 없음');
  const workspaceSelectionContext = el('span', 'ag-workspace-selection-context', '선택 없음');
  workspaceDocumentContext.append(workspaceDocumentName, workspaceSelectionContext);
  workspaceLeading.append(workspaceSettingsBack, workspaceThreadsBtn, workspaceDocumentContext);

  const workspaceTitle = el('div', 'ag-workspace-title', '대화');

  const workspaceTrailing = el('div', 'ag-workspace-trailing');
  const workspaceAgentContext = el(
    'span',
    'ag-workspace-agent-context',
    `${AGENT_LABEL[selectedAgent]} · ${labelForModel(selectedAgent, selectedModel)}`,
  );
  const environmentWrap = el('div', 'ag-environment-wrap');
  const environmentToggle = el('button', 'ag-workspace-icon-btn ag-environment-toggle');
  environmentToggle.type = 'button';
  environmentToggle.setAttribute('aria-controls', 'ag-environment-panel');
  environmentToggle.appendChild(createIcon('environment'));

  const environmentPanel = el('section', 'ag-environment-panel');
  environmentPanel.id = 'ag-environment-panel';
  environmentPanel.setAttribute('aria-labelledby', 'ag-environment-title');
  const environmentTitle = el('h2', 'ag-environment-title', '환경');
  environmentTitle.id = 'ag-environment-title';

  const environmentFileRow = el('div', 'ag-environment-file-row');
  environmentFileRow.tabIndex = 0;
  environmentFileRow.appendChild(createIcon('document'));
  const environmentFilenameViewport = el('span', 'ag-environment-filename-viewport');
  const environmentFilenameTrack = el('span', 'ag-environment-filename-track', '문서 없음');
  environmentFilenameViewport.appendChild(environmentFilenameTrack);
  environmentFileRow.appendChild(environmentFilenameViewport);

  const environmentPlanSection = el('section', 'ag-environment-section ag-environment-plan-section');
  const environmentPlan = el('button', 'ag-environment-plan');
  environmentPlan.type = 'button';
  environmentPlan.setAttribute('aria-controls', 'ag-plan-column');
  environmentPlan.setAttribute('aria-expanded', 'false');
  environmentPlan.appendChild(createIcon('plan'));
  const environmentPlanCopy = el('span', 'ag-environment-plan-copy');
  const environmentPlanLabel = el('span', 'ag-environment-plan-label', '계획');
  const environmentPlanTitle = el('span', 'ag-environment-plan-title', '계획 없음');
  environmentPlanCopy.append(environmentPlanLabel, environmentPlanTitle);
  const environmentPlanStatus = el('span', 'ag-environment-plan-status');
  const environmentPlanChevron = createChevron('ag-environment-plan-chevron');
  environmentPlan.append(environmentPlanCopy, environmentPlanStatus, environmentPlanChevron);
  environmentPlanSection.appendChild(environmentPlan);

  const environmentChangesSection = el('section', 'ag-environment-section ag-environment-changes-section');
  const environmentChanges = el('button', 'ag-environment-changes');
  environmentChanges.type = 'button';
  environmentChanges.setAttribute('aria-controls', 'ag-review-column');
  environmentChanges.setAttribute('aria-expanded', 'false');
  environmentChanges.appendChild(createIcon('changes'));
  const environmentChangesLabel = el('span', 'ag-environment-changes-label', '변경 사항');
  const environmentDiffSummary = el('span', 'ag-environment-diff-summary');
  const environmentAdditions = el('span', 'ag-environment-additions');
  const environmentDeletions = el('span', 'ag-environment-deletions');
  const environmentDiffNeutral = el('span', 'ag-environment-diff-neutral', '변경 없음');
  const environmentChangesChevron = createChevron('ag-environment-changes-chevron');
  environmentDiffSummary.append(environmentAdditions, environmentDeletions, environmentDiffNeutral);
  environmentChanges.append(environmentChangesLabel, environmentDiffSummary, environmentChangesChevron);
  environmentChangesSection.appendChild(environmentChanges);

  // TODO: 파일 첨부나 대화 브랜치 기능이 생기면 해당 source/branch 상태를 이 환경 패널에 표시한다.
  environmentPanel.append(
    environmentTitle,
    environmentFileRow,
    environmentPlanSection,
    environmentChangesSection,
  );
  environmentWrap.append(environmentToggle, environmentPanel);

  const workspaceExitBtn = el('button', 'ag-workspace-exit-btn');
  workspaceExitBtn.type = 'button';
  workspaceExitBtn.setAttribute('aria-label', '문서 편집기로 돌아가기');
  workspaceExitBtn.title = '문서 편집기로 돌아가기 (Esc)';
  workspaceExitBtn.append(createIcon('contract'), el('span', 'ag-workspace-exit-label', '편집기로 돌아가기'));
  const workspaceSettingsBtn = el('button', 'ag-workspace-icon-btn ag-workspace-settings-btn');
  workspaceSettingsBtn.type = 'button';
  workspaceSettingsBtn.setAttribute('aria-label', '설정');
  workspaceSettingsBtn.setAttribute('aria-controls', 'ag-settings-panel');
  workspaceSettingsBtn.setAttribute('aria-expanded', 'false');
  workspaceSettingsBtn.title = '설정';
  workspaceSettingsBtn.appendChild(createIcon('gear'));
  workspaceTrailing.append(workspaceAgentContext, environmentWrap, workspaceSettingsBtn, workspaceExitBtn);
  workspaceBar.append(workspaceLeading, workspaceTitle, workspaceTrailing);

  const cloudUi = createCloudAgentUi({
    controller: cloudController,
    onRequestTransfer: () => requestCloudTransfer(),
    onCancelPendingTransfer: () => cancelPendingCloudTransfer(),
    getScope: () => ({ threadId: currentThread.id, documentId: currentThread.documentId }),
    onCloseSettings: () => setSettingsPanelOpen(false),
    onLeaseChange: (cloudOwned, sessionId) => {
      deps.setCloudDocumentLease?.(cloudOwned, sessionId);
      queueMicrotask(() => updateComposer());
    },
    onTimeline: (timeline) => applyCloudTimeline(timeline),
    onResultResolved: (result, resolution) => {
      if (result.timeline) applyCloudTimeline(result.timeline);
      void deps.applyCloudResult?.(result, resolution);
    },
    onBeforeTakeover: () => deps.prepareCloudTakeover?.() ?? Promise.resolve(true),
    onTakeover: async (takeover) => {
      const binding = await deps.applyCloudTakeover?.(takeover) ?? null;
      applyCloudTimeline(takeover.timeline, binding);
    },
    onError: (message) => {
      systemMessage(message);
      showToast({ message, durationMs: 5000 });
    },
  });
  headerActions.insertBefore(cloudUi.sidebarButton, versionsBtn);
  workspaceTrailing.insertBefore(cloudUi.workspaceButton, environmentWrap);

  const applyHancomGitVisibility = (enabled: boolean): void => {
    versionsBtn.hidden = !enabled;
    environmentWrap.hidden = !enabled;
    if (!enabled && versionsPanelOpen) closeVersionsPage();
    if (!enabled && environmentPanelOpen) setEnvironmentPanelOpen(false);
  };
  applyHancomGitVisibility(userSettings.getUseHancomGit());
  const unsubscribeHancomGitVisibility = userSettings.subscribeUseHancomGit(applyHancomGitVisibility);

  async function collectCloudReferences(): Promise<CloudTransferReference[]> {
    const usedIds = collectUsedCloudReferenceIds(currentThread);
    if (usedIds.length === 0) return [];
    if (connState !== 'connected') {
      throw new Error('참고자료를 확인하려면 로컬 에이전트 연결이 필요합니다. 연결한 뒤 다시 시도하세요.');
    }
    const targets = [
      { scope: 'chat' as const, scopeId: currentThread.id },
      ...(currentThread.documentId
        ? [{ scope: 'document' as const, scopeId: currentThread.documentId }]
        : []),
      { scope: 'global' as const, scopeId: 'global' },
    ];
    const catalogs = await Promise.all(targets.map(async (target) => {
      try {
        return { target, files: await bridge.listReferences(target.scope, target.scopeId) };
      } catch (error) {
        const label = target.scope === 'chat' ? '현재 채팅' : target.scope === 'document' ? '현재 문서' : '전역';
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} 참고자료 목록을 확인하지 못해 전송을 중단했습니다: ${detail}`);
      }
    }));
    const catalogById = new Map<string, (typeof catalogs)[number]['files'][number]>();
    for (const item of catalogs) {
      for (const file of item.files) if (!catalogById.has(file.id)) catalogById.set(file.id, file);
    }
    const references: CloudTransferReference[] = [];
    for (const id of usedIds) {
      const file = catalogById.get(id);
      if (!file) throw new Error(`${id} 참고자료를 찾지 못해 전송을 중단했습니다.`);
      if (file.status !== 'ready') {
        throw new Error(`${file.name} 참고자료가 준비되지 않아 전송을 중단했습니다.`);
      }
      const descriptor = {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        scope: file.scope,
        scopeId: file.scopeId,
      };
      const bytes = await cloudController.readReference(descriptor);
      if (bytes.byteLength !== file.size) {
        throw new Error(`${file.name} 참고자료 크기가 달라 전송을 중단했습니다.`);
      }
      references.push({ ...descriptor, bytes });
    }
    return references;
  }

  function applyCloudTimeline(
    timeline: PortableCloudTimelineV1,
    binding: { documentId: string; fileName: string } | null = null,
  ): void {
    const local = binding
      ? {
          id: getThread(timeline.thread.id)?.id ?? timeline.thread.id,
          docKey: binding.fileName,
          documentId: binding.documentId,
        }
      : timeline.thread.id === currentThread.id
        ? currentThread
        : getThread(timeline.thread.id)
          ?? (timeline.thread.documentId === currentThread.documentId ? currentThread : null);
    if (!local) return;
    const imported = importCloudTimeline(timeline, local);
    if (!imported) return;
    upsertThread(imported);
    if (!binding && imported.id !== currentThread.id) return;
    currentThread = imported;
    applyThreadMeta(currentThread);
    renderMessagesFromThread(currentThread);
    updateComposer();
  }

  async function transferCurrentSession(): Promise<void> {
    const document = await deps.prepareCloudTransfer?.();
    if (!document) throw new Error('문서 저장이 완료되지 않아 클라우드 전송을 시작하지 않았습니다.');
    flushAssistantBuffer();
    persistCurrentThread();
    const references = await collectCloudReferences();
    await cloudController.transfer({
      threadId: currentThread.id,
      documentId: currentThread.documentId,
      documentName: document.fileName,
      agent: selectedAgent,
      model: selectedModel,
      effort: selectedEffort,
      workflow: chatWorkflow,
      permissionProfile: 'unrestricted',
      timeline: exportCloudTimeline(currentThread),
      document,
      references,
      limits: {
        maxDurationMs: 8 * 60 * 60 * 1000,
        maxTurns: 100,
      },
    });
    bridge.stopChat();
    updateComposer();
  }

  function ensureCloudTransferIntent(): Promise<void> {
    if (cloudTransferIntentPromise) return cloudTransferIntentPromise;
    const intent = { threadId: currentThread.id, documentId: currentThread.documentId };
    cloudTransferIntent = intent;
    cloudTransferIntentPromise = cloudController.setTransferIntent({ ...intent, pending: true }).then(() => {});
    return cloudTransferIntentPromise;
  }

  async function clearCloudTransferIntent(): Promise<void> {
    const intent = cloudTransferIntent;
    cloudTransferIntent = null;
    cloudTransferIntentPromise = null;
    if (intent) await cloudController.setTransferIntent({ ...intent, pending: false });
  }

  function failPendingCloudTransfer(error: unknown): void {
    const waiter = cloudTransferCloseWaiter;
    cloudTransferPending = false;
    cloudUi.setWaitingForLocalTurn(false);
    waiter?.reject(error);
    if (cloudTransferCloseWaiter === waiter) cloudTransferCloseWaiter = null;
    const message = error instanceof Error ? error.message : String(error);
    systemMessage(`클라우드 전송 실패: ${message}`);
    showToast({ message: `클라우드 전송 실패: ${message}`, durationMs: 5000 });
  }

  function cancelPendingCloudTransfer(): void {
    if (!cloudTransferPending) return;
    cloudTransferPending = false;
    cloudUi.setWaitingForLocalTurn(false);
    const cancellation = new Error('클라우드 전송 예약을 취소했습니다.');
    void clearCloudTransferIntent().then(
      () => failPendingCloudTransfer(cancellation),
      (error) => failPendingCloudTransfer(error),
    );
  }

  function ensureCloudTransferCloseWaiter() {
    if (cloudTransferCloseWaiter) return cloudTransferCloseWaiter;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    // A click may fail without a close request awaiting it. Keep that rejection handled;
    // callers of awaitPendingCloudTransferForClose still receive the original promise.
    void promise.catch(() => {});
    cloudTransferCloseWaiter = { promise, resolve, reject };
    return cloudTransferCloseWaiter;
  }

  function startCloudTransfer(): void {
    cloudTransferPending = false;
    cloudUi.setWaitingForLocalTurn(false);
    const waiter = ensureCloudTransferCloseWaiter();
    void (async () => {
      let failure: unknown = null;
      try {
        await ensureCloudTransferIntent();
        await transferCurrentSession();
      } catch (error) {
        failure = error;
      }
      try {
        await clearCloudTransferIntent();
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    })().then(
      () => waiter.resolve(),
      (error) => failPendingCloudTransfer(error),
    ).finally(() => {
      if (cloudTransferCloseWaiter === waiter) cloudTransferCloseWaiter = null;
    });
  }

  function requestCloudTransfer(): void {
    if (!deps.prepareCloudTransfer) {
      systemMessage('이 데스크톱 빌드는 문서를 클라우드로 전송할 수 없습니다.');
      return;
    }
    if (!currentDocumentId || !getDocumentContext?.().documentName) {
      systemMessage('먼저 클라우드에서 작업할 문서를 여세요.');
      return;
    }
    if (turnRunning) {
      cloudTransferPending = true;
      ensureCloudTransferCloseWaiter();
      cloudUi.setWaitingForLocalTurn(true);
      void ensureCloudTransferIntent().catch((error) => {
        void clearCloudTransferIntent().then(
          () => failPendingCloudTransfer(error),
          (clearError) => failPendingCloudTransfer(clearError),
        );
      });
      return;
    }
    startCloudTransfer();
  }

  function refreshEnvironmentFilenameMarquee(): void {
    if (!fullscreen || !environmentPanelOpen) return;
    const distance = Math.max(0, environmentFilenameTrack.scrollWidth - environmentFilenameViewport.clientWidth);
    environmentFileRow.classList.toggle('ag-filename-overflow', distance > 1);
    environmentFileRow.style.setProperty('--ag-filename-distance', `${Math.ceil(distance)}px`);
    environmentFileRow.style.setProperty('--ag-filename-duration', `${Math.max(4.8, distance / 26 + 2.4).toFixed(1)}s`);
  }

  function updateEnvironmentFilename(name: string): void {
    environmentFilenameTrack.textContent = name;
    environmentFileRow.title = name === '문서 없음' ? '' : name;
    environmentFileRow.setAttribute('aria-label', `현재 문서: ${name}`);
    window.requestAnimationFrame(refreshEnvironmentFilenameMarquee);
  }

  function applyEnvironmentPanelState(): void {
    environmentPanel.classList.toggle('ag-open', environmentPanelOpen);
    environmentPanel.setAttribute('aria-hidden', environmentPanelOpen ? 'false' : 'true');
    environmentPanel.inert = !environmentPanelOpen;
    environmentToggle.classList.toggle('ag-active', environmentPanelOpen);
    root.classList.toggle('ag-environment-open', fullscreen && environmentPanelOpen);
    environmentToggle.setAttribute('aria-expanded', environmentPanelOpen ? 'true' : 'false');
    environmentToggle.setAttribute('aria-label', environmentPanelOpen ? '환경 패널 닫기' : '환경 패널 열기');
    environmentToggle.title = environmentPanelOpen ? '환경 패널 닫기' : '환경 패널 열기';
    if (environmentPanelOpen) window.requestAnimationFrame(refreshEnvironmentFilenameMarquee);
  }

  function setEnvironmentPanelOpen(open: boolean): void {
    environmentPanelOpen = open;
    persistEnvironmentPanelOpen(open);
    applyEnvironmentPanelState();
  }

  function updateWorkspaceAgentContext(): void {
    workspaceAgentContext.textContent =
      `${AGENT_LABEL[selectedAgent]} · ${labelForModel(selectedAgent, selectedModel)}`;
  }

  workspaceThreadsBtn.addEventListener('click', () => {
    setThreadsRailCollapsed(!threadsRailCollapsed);
  });
  workspaceSettingsBack.addEventListener('click', () => void requestSettingsClose(workspaceSettingsBtn));
  workspaceSettingsBtn.addEventListener('click', () => {
    if (settingsPanelOpen) return;
    requestSettingsOpen();
  });
  environmentToggle.addEventListener('click', () => {
    setEnvironmentPanelOpen(!environmentPanelOpen);
  });
  environmentFileRow.addEventListener('pointerenter', refreshEnvironmentFilenameMarquee);
  environmentFileRow.addEventListener('focus', refreshEnvironmentFilenameMarquee);
  environmentChanges.addEventListener('click', () => {
    setReviewColCollapsed(false);
    setEnvironmentPanelOpen(false);
    // drawer 가 열리는 도중의 focus 가 조상 스크롤을 밀어 판 전체를
    // 옮기지 않도록 스크롤 없이 초점만 옮긴다.
    window.requestAnimationFrame(() => reviewColumnClose.focus({ preventScroll: true }));
  });
  environmentPlan.addEventListener('click', () => {
    if (!activePlan) return;
    setPlanColCollapsed(false);
    setEnvironmentPanelOpen(false);
    window.requestAnimationFrame(() => planColumnClose.focus({ preventScroll: true }));
  });
  workspaceExitBtn.addEventListener('click', () => {
    if (settingsPanelOpen) {
      void requestSettingsClose(workspaceExitBtn, () => setFullscreen(false));
      return;
    }
    setFullscreen(false);
  });
  applyEnvironmentPanelState();

  const chatPage = el('div', 'ag-chat-page');
  chatPage.id = 'ag-chat-page';
  chatPage.setAttribute('aria-hidden', 'false');

  /* 허브 연결이 끊겼을 때만 나타나는 줄. 첫 연결 시도(attempt 0)에는
     아무 말도 하지 않는다 — 시작할 때마다 경고처럼 보이면 안 된다. */
  const connBanner = el('div', 'ag-conn-banner');
  connBanner.hidden = true;
  connBanner.setAttribute('role', 'status');
  connBanner.setAttribute('aria-live', 'polite');
  const connBannerText = el('span', 'ag-conn-banner-text');
  const connBannerRetry = el('button', 'ag-conn-banner-retry', '지금 다시 연결');
  connBannerRetry.type = 'button';
  connBannerRetry.addEventListener('click', () => {
    connBannerText.textContent = '연결하는 중…';
    void bridge.reconnectNow();
  });
  const managedHub = isDesktopApp() || Boolean((import.meta as any).env?.DEV);
  const connBannerHint = el(
    'span',
    'ag-conn-banner-hint',
    managedHub
      ? '잠시만 기다리면 다시 붙어요.'
      : '저장소 루트에서 npm start 를 한 번 실행하세요. 터미널을 닫아도 허브는 유지됩니다.',
  );
  connBannerHint.hidden = true;
  connBanner.append(connBannerText, connBannerRetry, connBannerHint);

  const messages = el('div', 'ag-messages');
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-live', 'polite');
  const messagesEnd = el('div', 'ag-messages-end');
  messagesEnd.setAttribute('aria-hidden', 'true');
  const turnPending = el('div', 'ag-turn-pending');
  turnPending.hidden = true;
  turnPending.setAttribute('role', 'status');
  turnPending.setAttribute('aria-live', 'polite');
  const turnPendingLabel = el('span', 'ag-turn-pending-label');
  turnPending.append(createHieumGlyph(), turnPendingLabel);
  messages.append(turnPending, messagesEnd);
  const onMessagesScroll = (): void => {
    if (conversationScrollLock) return;
    followConversation = isConversationFollowingTurn();
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
  const messagesResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        syncConversationSpacer();
        if (followConversation) scrollConversationToEnd();
      })
    : null;
  messagesResizeObserver?.observe(messages);
  const review = el('div', 'ag-review');
  review.tabIndex = 0;
  review.setAttribute('aria-label', '변경 사항 검토');
  const planSurface = el('section', 'ag-plan-surface');
  planSurface.setAttribute('aria-label', '실행 계획');
  const planCardSlot = el('div', 'ag-plan-card-slot');
  const planRestore = el('button', 'ag-plan-restore');
  planRestore.type = 'button';
  planRestore.setAttribute('aria-label', '계획 펼치기');
  planRestore.title = '계획 펼치기';
  planRestore.setAttribute('aria-hidden', 'true');
  planRestore.inert = true;
  const planOrbit = el('span', 'ag-plan-orbit');
  planOrbit.setAttribute('aria-hidden', 'true');
  const planHistoryIcon = createIcon('changes', 'ag-plan-history-icon');
  planHistoryIcon.setAttribute('aria-hidden', 'true');
  planRestore.appendChild(planOrbit);
  planRestore.addEventListener('click', () => setPlanMinimized(false));
  planSurface.append(planCardSlot);
  let initialSetup: InitialSetupUi | null = null;
  const writingStyleCalibration = createWritingStyleCalibration(bridge, {
    onDismiss: (result) => initialSetup?.notifyCalibrationClosed(result.completed),
  });
  const composerUtilities = el('div', 'ag-composer-utilities');
  composerUtilities.setAttribute('aria-label', '채팅 도구');

  /** 계획 단계 배지 — 계획 모드에서만 보이는 작고 읽기 전용인 상태 표시다. */
  const phaseBadge = el('span', 'ag-phase-badge');
  phaseBadge.setAttribute('role', 'status');
  phaseBadge.setAttribute('aria-live', 'polite');
  phaseBadge.hidden = true;

  const composerUtilityActions = el('div', 'ag-composer-utility-actions');
  composerUtilityActions.append(phaseBadge, permissionBtn, skillsBtn);
  composerUtilities.append(composerUtilityActions);
  const composer = el('form', 'ag-composer');
  // 진행 상태는 계획/변경 surface와 별개인 입력기 overlay다. 이 행은 문서
  // 흐름의 높이를 차지하지 않으며, 왼쪽 작업 상태와 오른쪽 계획 복원 버튼이
  // 서로의 자리를 침범하지 않도록 하나의 semantic cluster로 묶는다.
  const composerOverlay = el('div', 'ag-composer-overlay');
  composerOverlay.setAttribute('aria-label', '현재 작업 상태');
  composerOverlay.append(planRestore);
  const composerMeta = el('div', 'ag-composer-meta');
  composerMeta.setAttribute('aria-label', '에이전트 및 채팅 설정');
  composerMeta.append(selectors, composerUtilities);
  const slashMenu = el('div', 'ag-slash-menu');
  slashMenu.id = 'ag-slash-menu';
  slashMenu.hidden = true;
  slashMenu.setAttribute('role', 'listbox');
  slashMenu.setAttribute('aria-label', '슬래시 명령과 스킬');
  const input = el('textarea', 'ag-input');
  input.placeholder = '문서 작업을 입력하세요';
  input.rows = 1;
  input.setAttribute('aria-label', '에이전트 메시지 입력');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', slashMenu.id);
  input.setAttribute('aria-expanded', 'false');
  // 보내기 버튼은 입력 필드 '안'에 산다. 라벨은 아이콘이 대신하고
  // 이름은 aria-label/title 로 남긴다.
  const send = el('button', 'ag-send');
  send.type = 'submit';
  send.append(createIcon('send'));
  send.setAttribute('aria-label', '보내기');
  send.title = '보내기';

  // 프롬프트 캐럿: 이 필드가 명령을 받는 자리라는 표시. 순수 장식이라 aria 에서 숨긴다.
  const caret = el('span', 'ag-caret', '>');
  caret.setAttribute('aria-hidden', 'true');
  // 실제로 존재하는 단축키만 노출한다 — 전송은 Enter, 줄바꿈은 Shift+Enter.
  const sendHint = el('span', 'ag-kbd', '⏎');
  sendHint.setAttribute('aria-hidden', 'true');

  const composerField = el('div', 'ag-composer-field');
  const composerSkill = el('span', 'ag-skill-token ag-composer-skill');
  composerSkill.hidden = true;
  const composerSkillIcon = el('span', 'ag-skill-token-icon');
  const composerSkillName = el('span', 'ag-skill-token-name');
  const composerSkillClear = el('button', 'ag-skill-token-clear');
  composerSkillClear.type = 'button';
  composerSkillClear.setAttribute('aria-label', '스킬 호출 해제');
  composerSkillClear.appendChild(createIcon('close'));
  composerSkill.append(composerSkillIcon, composerSkillName, composerSkillClear);
  composerField.append(caret, composerSkill, input, sendHint, send);
  const templateChip = el('div', 'ag-template-chip');
  templateChip.hidden = true;
  const templateChipName = el('span', 'ag-template-chip-name');
  const templateChipClear = el('button', 'ag-template-chip-clear');
  templateChipClear.type = 'button';
  templateChipClear.setAttribute('aria-label', '활성 템플릿 해제');
  templateChipClear.appendChild(createIcon('close'));
  templateChip.append(el('span', 'ag-template-chip-label', '템플릿'), templateChipName, templateChipClear);
  composer.append(composerOverlay, slashMenu, templateChip, composerField, composerMeta, configPanel);
  composer.insertBefore(cloudUi.queueStrip, composerField);
  // 편대 도크는 입력기 위에 뜨는 오버레이라서 입력기의 자식으로 붙는다 —
  // 사이드바·전체 화면 어디로 옮겨져도 입력기를 따라간다.
  composer.appendChild(fleetView.root);
  // 도크가 차지하는 높이를 입력기에 알려 계획 복원 버튼(overlay)이 겹치지 않게 한다.
  const dockResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      composer.style.setProperty('--ag-fleet-dock-h', height > 0 ? `${Math.ceil(height) + 6}px` : '0px');
    })
    : null;
  dockResizeObserver?.observe(fleetView.root);
  // 사이드바에서는 변경 검토와 계획을 분리한다. 계획은 입력기 바로 위에
  // 머물러 접었을 때 작은 진행 표시로 이어지고, 변경 검토는 가려지지 않는다.
  chatPage.append(header, connBanner, messages, review, planSurface, composer);

  /** 입력기 하단 한 줄이 겹치지 않고 붙는 폭을 재서 사이드바 최솟값으로 쓴다.
   *  펼쳐진 사이드바의 현재 폭이 아니라 max-content(말줄임 바닥)로 잰다.
   *  space-between 으로 벌어진 빈 칸이 최솟값에 섞이면 전자 앱에서 600px
   *  근처로 다시 잠긴다. */
  function measureComposerMetaFloor(): number {
    root.classList.add('ag-measuring-min');
    const prevWidth = composerMeta.style.width;
    composerMeta.style.width = 'max-content';
    const packed = composerMeta.getBoundingClientRect().width;
    composerMeta.style.width = prevWidth;
    root.classList.remove('ag-measuring-min');
    return packed;
  }

  function refreshSidebarWidthMin(): number {
    if (!composer.isConnected) return sidebarWidthMin;
    const packed = measureComposerMetaFloor();
    if (packed <= 0) return sidebarWidthMin;
    const chrome = horizontalChrome(composer, [
      'margin-left',
      'margin-right',
      'padding-left',
      'padding-right',
      'border-left-width',
      'border-right-width',
    ]) + horizontalChrome(root, ['border-left-width']);
    const nextMin = Math.min(
      SIDEBAR_WIDTH_DEFAULT,
      Math.max(
        SIDEBAR_WIDTH_MIN_FALLBACK,
        Math.ceil(packed + chrome + SIDEBAR_PACKED_BUFFER_PX),
      ),
    );
    if (nextMin === sidebarWidthMin) {
      resizeHandle.setAttribute('aria-valuemin', String(sidebarWidthMin));
      return sidebarWidthMin;
    }
    sidebarWidthMin = nextMin;
    applySidebarWidth(sidebarWidth, { persist: true, recenter: true });
    return sidebarWidthMin;
  }

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
  // 스크롤하면 hover 카드가 행에서 떨어져 남는다 — 바로 걷어낸다.
  threadsList.addEventListener('scroll', () => hideThreadPopover(), { passive: true });
  threadsPage.append(threadsHeader, threadsNew, threadsList);

  const skillsPage = el('div', 'ag-skills-page');
  skillsPage.id = 'ag-skills-panel';
  skillsPage.setAttribute('role', 'region');
  skillsPage.setAttribute('aria-label', '스킬 라이브러리');
  skillsPage.setAttribute('aria-hidden', 'true');
  const skillsHeader = el('div', 'ag-threads-header');
  const skillsTitle = el('span', 'ag-threads-title', '스킬');
  const skillsClose = el('button', 'ag-threads-btn ag-threads-close');
  skillsClose.type = 'button';
  skillsClose.setAttribute('aria-label', '채팅으로 돌아가기');
  skillsClose.appendChild(createColumnIcon());
  skillsHeader.append(skillsTitle, skillsClose);
  const skillsToolbar = el('div', 'ag-skills-toolbar');
  const skillsSearch = el('input', 'ag-skills-search') as HTMLInputElement;
  skillsSearch.type = 'search';
  skillsSearch.placeholder = '스킬 검색';
  skillsSearch.setAttribute('aria-label', '스킬 검색');
  const skillsNew = el('button', 'ag-skills-new', '새 스킬');
  skillsNew.type = 'button';
  skillsToolbar.append(skillsSearch, skillsNew);
  const skillsStatus = el('div', 'ag-skills-status');
  skillsStatus.setAttribute('role', 'status');
  skillsStatus.setAttribute('aria-live', 'polite');
  const skillsList = el('div', 'ag-skills-list');

  const skillEditor = el('section', 'ag-skill-editor');
  skillEditor.hidden = true;
  const skillEditorHeader = el('div', 'ag-skill-editor-header');
  const skillEditorTitle = el('h3', 'ag-skill-editor-title', '스킬 만들기');
  const skillEditorBack = el('button', 'ag-skill-editor-back', '목록');
  skillEditorBack.type = 'button';
  skillEditorHeader.append(skillEditorTitle, skillEditorBack);
  const skillIconPicker = el('fieldset', 'ag-skill-icon-picker') as HTMLFieldSetElement;
  const skillIconLabel = el('span', 'ag-skill-icon-label', '아이콘');
  skillIconLabel.id = 'ag-skill-icon-label';
  skillIconPicker.setAttribute('aria-labelledby', skillIconLabel.id);
  const skillIconOptions = el('div', 'ag-skill-icon-options');
  const skillIconInputs = new Map<ProductSkillIcon, HTMLInputElement>();
  for (const [value, label] of [
    ['pencil', '연필'],
    ['bot', '봇'],
    ['system', '시스템'],
  ] as const) {
    const option = el('label', 'ag-skill-icon-option') as HTMLLabelElement;
    option.title = label;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'ag-skill-icon';
    radio.value = value;
    radio.setAttribute('aria-label', `${label} 아이콘`);
    const glyph = el('span', 'ag-skill-icon-option-glyph');
    glyph.appendChild(createIcon(skillGlyphForIcon(value)));
    option.append(radio, glyph);
    skillIconInputs.set(value, radio);
    skillIconOptions.appendChild(option);
  }
  skillIconPicker.append(skillIconLabel, skillIconOptions);
  const skillGoal = el('textarea', 'ag-skill-field') as HTMLTextAreaElement;
  skillGoal.rows = 3;
  skillGoal.placeholder = '이 스킬이 반복해서 해결할 일을 설명하세요.';
  skillGoal.setAttribute('aria-label', '스킬 목표');
  const skillTriggers = el('textarea', 'ag-skill-field') as HTMLTextAreaElement;
  skillTriggers.rows = 2;
  skillTriggers.placeholder = '언제 실행해야 하나요? 예시 요청을 적으세요.';
  skillTriggers.setAttribute('aria-label', '실행 예시');
  const skillNonTriggers = el('textarea', 'ag-skill-field') as HTMLTextAreaElement;
  skillNonTriggers.rows = 2;
  skillNonTriggers.placeholder = '실행하면 안 되는 비슷한 요청이 있나요?';
  skillNonTriggers.setAttribute('aria-label', '비실행 예시');
  const skillResources = el('input', 'ag-skill-upload') as HTMLInputElement;
  skillResources.id = 'ag-skill-upload';
  skillResources.type = 'file';
  skillResources.multiple = true;
  skillResources.setAttribute('aria-label', '스킬 참고자료와 자산 추가');
  const skillResourceRow = el('div', 'ag-skill-upload-row');
  const skillResourceKind = el('select', 'ag-skill-upload-kind') as HTMLSelectElement;
  skillResourceKind.setAttribute('aria-label', '추가할 파일 종류');
  for (const [value, label] of [['references', '참고자료'], ['scripts', '스크립트'], ['assets', '자산']] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    skillResourceKind.appendChild(option);
  }
  const skillResourceLabel = el('label', 'ag-skill-upload-label', '파일 추가') as HTMLLabelElement;
  skillResourceLabel.htmlFor = skillResources.id;
  const skillResourceStatus = el('span', 'ag-skill-upload-status', '선택된 파일 없음');
  skillResourceRow.append(skillResourceKind, skillResourceLabel, skillResourceStatus, skillResources);
  const skillGenerate = el('button', 'ag-skill-generate', 'AI로 초안 만들기');
  skillGenerate.type = 'button';
  const skillName = el('input', 'ag-skill-name') as HTMLInputElement;
  skillName.placeholder = 'skill-name';
  skillName.setAttribute('aria-label', '스킬 이름');
  const skillFiles = el('div', 'ag-skill-files');
  const skillFileEditor = el('textarea', 'ag-skill-file-editor') as HTMLTextAreaElement;
  skillFileEditor.spellcheck = false;
  skillFileEditor.setAttribute('aria-label', '선택한 스킬 파일 내용');
  const skillWarning = el('div', 'ag-skill-warning');
  const skillEditorActions = el('div', 'ag-skill-editor-actions');
  const skillSave = el('button', 'ag-skill-save', '검증하기');
  skillSave.type = 'button';
  skillEditorActions.append(skillGenerate, skillSave);
  skillEditor.append(skillEditorHeader, skillIconPicker, skillGoal, skillTriggers, skillNonTriggers, skillResourceRow, skillName, skillFiles, skillFileEditor, skillWarning, skillEditorActions);
  skillsPage.append(skillsHeader, skillsToolbar, skillsStatus, skillsList, skillEditor);

  const referenceLibrary = createReferenceLibrary({
    bridge,
    getContext: () => ({
      threadId: currentThread.id,
      documentId: currentDocumentId,
      documentName: getDocumentContext?.().documentName ?? currentDocKey,
    }),
    onOpenChange(open) {
      if (open && settingsPanelOpen && settingsPanel.isDirty()) {
        referenceLibrary.setOpen(false);
        void requestSettingsClose(undefined, () => referenceLibrary.setOpen(true));
        return;
      }
      root.classList.toggle('ag-references-open', open);
      if (open) {
        setConfigPanelOpen(false);
        threadsPanelOpen = false;
        skillsPanelOpen = false;
        closeSettingsPage();
        closeVersionsPage();
        root.classList.remove('ag-threads-open', 'ag-skills-open');
        threadsBtn.setAttribute('aria-expanded', 'false');
        skillsBtn.setAttribute('aria-expanded', 'false');
        skillsPage.setAttribute('aria-hidden', 'true');
        skillsPage.inert = true;
        threadsPage.inert = true;
      } else if (fullscreen) {
        threadsPage.inert = threadsRailCollapsed;
        applyThreadsRailState();
      } else {
        threadsPage.inert = true;
      }
      chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
      chatPage.inert = open;
    },
    onDraftStateChange() {
      updateComposer();
    },
    onFileDeleted(fileId) {
      let changed = false;
      for (const message of currentThread.messages) {
        for (const attachment of message.attachments ?? []) {
          if (attachment.fileId !== fileId) continue;
          attachment.status = 'deleted';
          changed = true;
        }
      }
      if (changed) {
        persistCurrentThread();
        renderMessagesFromThread(currentThread);
      }
    },
  });
  composerUtilityActions.insertBefore(referenceLibrary.trigger, permissionBtn);
  composerField.insertBefore(referenceLibrary.quickAddButton, sendHint);
  composer.insertBefore(referenceLibrary.quickUploads, composerField);

  let attachmentDragDepth = 0;
  const canStageComposerAttachments = (): boolean =>
    connState === 'connected'
    && readOnlyDocLabel === null
    && !cloudUi.isCloudConversation()
    && chatStartPendingThreadId === null
    && !attachmentsSending
    && !referenceLibrary.isOpen();
  const clearAttachmentDrag = (): void => {
    attachmentDragDepth = 0;
    root.classList.remove('ag-attachment-dragging');
  };
  const onAttachmentDragEnter = (event: DragEvent): void => {
    if (!transferHasFiles(event.dataTransfer) || !canStageComposerAttachments()) return;
    event.preventDefault();
    event.stopPropagation();
    attachmentDragDepth += 1;
    root.classList.add('ag-attachment-dragging');
  };
  const onAttachmentDragOver = (event: DragEvent): void => {
    if (!transferHasFiles(event.dataTransfer) || !canStageComposerAttachments()) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    root.classList.add('ag-attachment-dragging');
  };
  const onAttachmentDragLeave = (event: DragEvent): void => {
    if (!root.classList.contains('ag-attachment-dragging')) return;
    event.preventDefault();
    event.stopPropagation();
    attachmentDragDepth = Math.max(0, attachmentDragDepth - 1);
    if (attachmentDragDepth === 0) root.classList.remove('ag-attachment-dragging');
  };
  const onAttachmentDrop = (event: DragEvent): void => {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const files = [...(event.dataTransfer?.files ?? [])];
    clearAttachmentDrag();
    if (canStageComposerAttachments() && files.length > 0) referenceLibrary.stageDraftFiles(files);
  };
  const onAttachmentPaste = (event: ClipboardEvent): void => {
    if (!canStageComposerAttachments()) return;
    const images = clipboardImageFiles(event.clipboardData);
    if (images.length === 0) return;
    event.preventDefault();
    referenceLibrary.stageDraftFiles(images);
  };
  root.addEventListener('dragenter', onAttachmentDragEnter);
  root.addEventListener('dragover', onAttachmentDragOver);
  root.addEventListener('dragleave', onAttachmentDragLeave);
  root.addEventListener('drop', onAttachmentDrop);
  input.addEventListener('paste', onAttachmentPaste);

  /* 집중 모드의 변경 사항 drawer. 대화 위의 오른쪽 가장자리에서 열리고,
     사이드바로 돌아가면 .ag-review 노드는 기존 inline 자리로 되돌아간다. */
  const reviewColumn = el('aside', 'ag-review-column');
  reviewColumn.id = 'ag-review-column';
  reviewColumn.setAttribute('aria-labelledby', 'ag-review-column-title');
  const reviewColumnHead = el('div', 'ag-review-column-head');
  const reviewColumnClose = el('button', 'ag-header-icon-btn ag-review-column-close');
  reviewColumnClose.type = 'button';
  reviewColumnClose.setAttribute('aria-label', '검토 닫기');
  reviewColumnClose.title = '검토 닫기';
  reviewColumnClose.appendChild(createIcon('close'));
  reviewColumnClose.addEventListener('click', () => {
    setReviewColCollapsed(true);
    environmentToggle.focus();
  });
  const reviewColumnHeading = el('div', 'ag-review-column-heading');
  const reviewColumnTitle = el('span', 'ag-review-column-title', '변경 사항');
  reviewColumnTitle.id = 'ag-review-column-title';
  const reviewColumnMeta = el('span', 'ag-review-column-meta', '대기 중인 변경 없음');
  reviewColumnHeading.append(reviewColumnTitle, reviewColumnMeta);
  reviewColumnHead.append(reviewColumnHeading, reviewColumnClose);
  reviewColumn.appendChild(reviewColumnHead);

  const planColumn = el('aside', 'ag-plan-column');
  planColumn.id = 'ag-plan-column';
  planColumn.setAttribute('aria-labelledby', 'ag-plan-column-title');
  const planColumnHead = el('div', 'ag-plan-column-head');
  const planColumnHeading = el('div', 'ag-plan-column-heading');
  const planColumnTitle = el('span', 'ag-plan-column-title', '계획');
  planColumnTitle.id = 'ag-plan-column-title';
  const planColumnMeta = el('span', 'ag-plan-column-meta', '활성 계획 없음');
  planColumnHeading.append(planColumnTitle, planColumnMeta);
  const planColumnClose = el('button', 'ag-header-icon-btn ag-plan-column-close');
  planColumnClose.type = 'button';
  planColumnClose.setAttribute('aria-label', '계획 닫기');
  planColumnClose.title = '계획 닫기';
  planColumnClose.appendChild(createIcon('close'));
  planColumnClose.addEventListener('click', () => {
    setPlanColCollapsed(true);
    environmentToggle.focus();
  });
  planColumnHead.append(planColumnHeading, planColumnClose);
  planColumn.appendChild(planColumnHead);

  /* 레일과 변경 사항 drawer의 경계 폭 조절 손잡이. */
  const railResize = el('div', 'ag-rail-resize');
  railResize.setAttribute('role', 'separator');
  railResize.setAttribute('aria-orientation', 'vertical');
  railResize.setAttribute('aria-label', '채팅 목록 너비 조절');
  railResize.title = '드래그하여 너비 조절';
  railResize.tabIndex = 0;

  /* 설정 페이지 — 자기 DOM 은 settings.ts 가 짓고, 페이지 전환만
     여기서 관리한다(스킬 페이지와 같은 계약). */
  const settingsPanel = createSettingsPanel({
    bridge,
    eventBus,
    editorRuntime: editorSettingsRuntime ?? {
      preview: () => undefined,
      committed: () => undefined,
    },
    getSelection: () => ({
      agent: selectedAgent,
      model: selectedModel,
      effort: selectedEffort,
      permission: permissionProfile,
    }),
    applyDefaults: (prefs) => applyAgentPrefs(prefs),
    openCalibration: () => writingStyleCalibration.open(),
    reconnectSession: () => restartAgentSession(),
    cloudSettings: cloudUi.settingsElement,
    refreshCloudSettings: () => cloudUi.openSettings(),
  });
  const settingsPage = settingsPanel.element;
  initialSetup = maybeStartInitialSetup({
    openAgentSetup: (agent) => settingsPanel.openAgentSetup(agent),
    beginAgentConnect: (agent) => settingsPanel.beginAgentConnect(agent),
    openCalibration: (options) => writingStyleCalibration.open(options),
  });
  settingsPage.addEventListener('ag-settings-close-request', () => {
    void requestSettingsClose(fullscreen ? workspaceSettingsBtn : settingsBtn);
  });
  settingsPage.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    void requestSettingsClose(fullscreen ? workspaceSettingsBtn : settingsBtn);
  });

  const versionManagerPage = versionController
    ? createVersionManagerPage(versionController)
    : null;
  const versionsPage = versionManagerPage?.element ?? el('section', 'ag-versions-page');
  if (!versionManagerPage) {
    versionsPage.id = 'ag-versions-panel';
    versionsPage.setAttribute('aria-hidden', 'true');
    versionsPage.inert = true;
  }
  versionsPage.addEventListener('ag-versions-close', () => {
    setVersionsPanelOpen(false);
    versionsBtn.focus();
  });

  const reviewResize = el('div', 'ag-review-resize');
  reviewResize.setAttribute('role', 'separator');
  reviewResize.setAttribute('aria-orientation', 'vertical');
  reviewResize.setAttribute('aria-label', '검토 칸 너비 조절');
  reviewResize.title = '드래그하여 너비 조절';
  reviewResize.tabIndex = 0;

  stage.append(
    workspaceBar,
    chatPage,
    threadsPage,
    skillsPage,
    referenceLibrary.page,
    settingsPage,
    versionsPage,
    reviewColumn,
    planColumn,
    railResize,
    reviewResize,
  );
  stage.appendChild(cloudUi.statusPanel);

  function applyRailWidth(width: number, opts?: { persist?: boolean }): void {
    railWidth = clampRailWidth(width);
    root.style.setProperty('--ag-rail-w', `${railWidth}px`);
    railResize.setAttribute('aria-valuenow', String(railWidth));
    railResize.setAttribute('aria-valuemin', String(RAIL_WIDTH_MIN));
    railResize.setAttribute('aria-valuemax', String(maxRailWidth()));
    if (opts?.persist) persistRailWidth(railWidth);
  }

  function applyReviewWidth(width: number, opts?: { persist?: boolean }): void {
    reviewWidth = clampReviewWidth(width);
    root.style.setProperty('--ag-review-w', `${reviewWidth}px`);
    reviewResize.setAttribute('aria-valuenow', String(reviewWidth));
    reviewResize.setAttribute('aria-valuemin', String(REVIEW_WIDTH_MIN));
    reviewResize.setAttribute('aria-valuemax', String(maxReviewWidth()));
    if (opts?.persist) persistReviewWidth(reviewWidth);
  }

  /* 두 손잡이는 같은 드래그 문법을 쓴다 — 포인터를 캡처해 무대
     좌표계로 환산하고, 놓을 때만 저장한다. */
  let columnResizing: 'rail' | 'review' | null = null;
  let columnResizePointerId: number | null = null;

  function columnHandle(kind: 'rail' | 'review'): HTMLElement {
    return kind === 'rail' ? railResize : reviewResize;
  }

  function detachColumnResizeWindowListeners(): void {
    window.removeEventListener('pointermove', onColumnResizePointerMove, true);
    window.removeEventListener('pointerup', endColumnResize, true);
    window.removeEventListener('pointercancel', endColumnResize, true);
    window.removeEventListener('blur', onColumnResizeWindowBlur);
  }

  function onColumnResizeWindowBlur(): void {
    endColumnResize();
  }

  function beginColumnResize(kind: 'rail' | 'review', e: PointerEvent): void {
    if (!fullscreen) return;
    // 이미 한 손가락이 끌고 있으면 두 번째 손가락은 무시한다.
    if (columnResizing) return;
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    columnResizing = kind;
    columnResizePointerId = e.pointerId;
    try {
      columnHandle(kind).setPointerCapture(e.pointerId);
    } catch {
      /* 캡처를 못 얻어도 pointermove 는 손잡이 위에서 계속 온다 */
    }
    root.classList.add('ag-col-resizing');
    document.body.classList.add('ag-col-resizing');
    // The divider moves with the grid, so pointer events must continue even
    // after the cursor leaves its narrow hit target or pointer capture fails.
    window.addEventListener('pointermove', onColumnResizePointerMove, true);
    window.addEventListener('pointerup', endColumnResize, true);
    window.addEventListener('pointercancel', endColumnResize, true);
    window.addEventListener('blur', onColumnResizeWindowBlur);
  }

  function onColumnResizePointerMove(e: PointerEvent): void {
    if (!columnResizing) return;
    // 드래그를 시작한 포인터가 아니면 흘려보낸다.
    if (e.pointerId !== columnResizePointerId) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    if (columnResizing === 'rail') applyRailWidth(e.clientX - rect.left);
    else applyReviewWidth(rect.right - e.clientX);
  }

  function endColumnResize(e?: PointerEvent): void {
    if (!columnResizing) {
      detachColumnResizeWindowListeners();
      root.classList.remove('ag-col-resizing');
      document.body.classList.remove('ag-col-resizing');
      return;
    }
    // 다른 손가락이 뗀 것이라면 진행 중인 드래그를 끝내지 않는다.
    if (e && e.pointerId !== columnResizePointerId) return;
    const kind = columnResizing;
    const pointerId = e?.pointerId ?? columnResizePointerId;
    columnResizing = null;
    columnResizePointerId = null;
    detachColumnResizeWindowListeners();
    root.classList.remove('ag-col-resizing');
    document.body.classList.remove('ag-col-resizing');
    const handle = columnHandle(kind);
    try {
      if (pointerId !== null && handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
    } catch {
      /* the pointer may already be gone after a window blur */
    }
    if (kind === 'rail') applyRailWidth(railWidth, { persist: true });
    else applyReviewWidth(reviewWidth, { persist: true });
  }

  function onColumnResizeKeyDown(kind: 'rail' | 'review', e: KeyboardEvent): void {
    if (!fullscreen) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    // 손잡이가 눌린 방향으로 움직인다 — 검토 칸은 왼쪽 모서리라 반대다.
    const delta = e.key === 'ArrowRight' ? 16 : -16;
    if (kind === 'rail') applyRailWidth(railWidth + delta, { persist: true });
    else applyReviewWidth(reviewWidth - delta, { persist: true });
  }

  for (const kind of ['rail', 'review'] as const) {
    const handle = columnHandle(kind);
    handle.addEventListener('pointerdown', (e) => beginColumnResize(kind, e));
    handle.addEventListener('keydown', (e) => onColumnResizeKeyDown(kind, e));
  }

  /**
   * 전체 화면은 대화 목록 + 대화가 기본인 agent-focus 무대다.
   * 변경 사항은 환경 패널에서만 여는 오른쪽 drawer다.
   */
  /* 스레드 레일 접기 — 전체 화면에서만 뜻이 있다. 헤더의 목록
     버튼이 토글이고, 접힘 여부는 사이드바 폭처럼 세션 간 유지된다. */
  function applyThreadsRailState(): void {
    root.classList.toggle('ag-rail-collapsed', fullscreen && threadsRailCollapsed);
    if (!fullscreen) return;
    threadsBtn.setAttribute('aria-expanded', threadsRailCollapsed ? 'false' : 'true');
    threadsBtn.title = threadsRailCollapsed ? '채팅 목록 열기' : '채팅 목록 접기';
    threadsBtn.setAttribute('aria-label', threadsBtn.title);
    threadsPage.setAttribute('aria-hidden', threadsRailCollapsed ? 'true' : 'false');
    workspaceThreadsBtn.setAttribute('aria-expanded', threadsRailCollapsed ? 'false' : 'true');
    workspaceThreadsBtn.title = threadsRailCollapsed ? '대화 목록 열기' : '대화 목록 접기';
    workspaceThreadsBtn.setAttribute('aria-label', workspaceThreadsBtn.title);
  }

  function setThreadsRailCollapsed(collapsed: boolean): void {
    threadsRailCollapsed = collapsed;
    persistThreadsRailCollapsed(collapsed);
    applyThreadsRailState();
    // 접혀 있는 동안 문서가 바뀌었을 수 있다 — 다시 펼칠 때 새로 그린다.
    if (fullscreen && !collapsed) rebuildThreadsList();
  }

  /* 검토 drawer는 대화를 가리거나 composer를 옮기지 않는다. */
  function applyReviewColState(): void {
    // 나가는 애니메이션 중에도 전체 화면 DOM은 아직 유효하다.
    const focusLayoutActive = fullscreen || root.classList.contains('ag-fullscreen');
    const planActive = focusLayoutActive && !planColCollapsed && activePlan !== null;
    const changesActive = focusLayoutActive && !reviewColCollapsed && !planActive;
    const detailActive = changesActive || planActive;
    root.classList.toggle('ag-review-collapsed', focusLayoutActive && !changesActive);
    root.classList.toggle('ag-plan-collapsed', focusLayoutActive && !planActive);
    root.classList.toggle('ag-review-drawer-open', changesActive);
    root.classList.toggle('ag-plan-drawer-open', planActive);
    root.classList.toggle('ag-detail-drawer-open', detailActive);
    environmentChanges.classList.toggle('ag-active', changesActive);
    environmentChanges.setAttribute('aria-expanded', changesActive ? 'true' : 'false');
    environmentPlan.classList.toggle('ag-active', planActive);
    environmentPlan.setAttribute('aria-expanded', planActive ? 'true' : 'false');
    reviewColumn.setAttribute('aria-hidden', changesActive ? 'false' : 'true');
    reviewColumn.inert = !changesActive;
    planColumn.setAttribute('aria-hidden', planActive ? 'false' : 'true');
    planColumn.inert = !planActive;
    reviewResize.setAttribute('aria-hidden', detailActive ? 'false' : 'true');
    reviewResize.tabIndex = detailActive ? 0 : -1;
    reviewResize.inert = !detailActive;
    if (focusLayoutActive) {
      chatPage.setAttribute('aria-hidden', 'false');
      if (composer.parentElement !== chatPage) chatPage.appendChild(composer);
    }
    applyPlanMinimizedState();
  }

  function setReviewColCollapsed(collapsed: boolean): void {
    reviewColCollapsed = collapsed;
    if (!collapsed) planColCollapsed = true;
    applyReviewColState();
  }

  function setPlanColCollapsed(collapsed: boolean): void {
    planColCollapsed = collapsed;
    if (!collapsed) reviewColCollapsed = true;
    applyReviewColState();
  }

  function syncComposerOverlay(): void {
    const hasPlanRestore = !fullscreen && planMinimized && activePlan !== null;
    composerOverlay.classList.remove('ag-has-activity');
    composerOverlay.classList.toggle('ag-has-plan-restore', hasPlanRestore);
  }

  function applyPlanMinimizedState(): void {
    const compact = !fullscreen && planMinimized && activePlan !== null;
    planSurface.classList.toggle('ag-plan-minimized', compact);
    planCardSlot.setAttribute('aria-hidden', compact ? 'true' : 'false');
    planCardSlot.inert = compact;
    planRestore.replaceChildren(activePlanHistorical ? planHistoryIcon : planOrbit);
    const restoreLabel = activePlanHistorical ? '계획 기록 펼치기' : '계획 펼치기';
    planRestore.setAttribute('aria-label', restoreLabel);
    planRestore.title = restoreLabel;
    planRestore.setAttribute('aria-hidden', compact ? 'false' : 'true');
    planRestore.inert = !compact;
    syncComposerOverlay();
  }

  function setPlanMinimized(minimized: boolean): void {
    planMinimized = minimized;
    applyPlanMinimizedState();
    if (!minimized) {
      window.requestAnimationFrame(() => {
        planCardSlot.querySelector<HTMLElement>('.ag-plan-card')?.focus({ preventScroll: true });
      });
    }
  }

  function updateReviewControl(changeSets: readonly PendingChangeSet[]): void {
    const diff = summarizePendingDiffs(changeSets);
    pendingReviewOpCount = diff.opCount;
    const hasPending = pendingReviewOpCount > 0;
    reviewColumnTitle.textContent = '변경 사항';
    reviewColumnMeta.textContent = hasPending
      ? `${pendingReviewOpCount}개 변경 검토 대기`
      : '대기 중인 변경 없음';
    const hasTextDiff = diff.additions > 0 || diff.deletions > 0;
    environmentAdditions.hidden = diff.additions === 0;
    environmentAdditions.textContent = `+${diff.additions.toLocaleString('ko-KR')}`;
    environmentDeletions.hidden = diff.deletions === 0;
    environmentDeletions.textContent = `−${diff.deletions.toLocaleString('ko-KR')}`;
    environmentDiffNeutral.hidden = hasTextDiff;
    environmentDiffNeutral.textContent = hasPending
      ? `${diff.nonTextChanges || pendingReviewOpCount}개 변경`
      : '변경 없음';
    environmentChanges.setAttribute(
      'aria-label',
      hasPending
        ? `변경 사항 열기, 추가 ${diff.additions}자, 삭제 ${diff.deletions}자, 기타 ${diff.nonTextChanges}개`
        : '변경 사항 열기, 대기 중인 변경 없음',
    );
    const hasPlan = activePlan !== null && chatWorkflow === 'plan';
    environmentPlan.disabled = !hasPlan;
    environmentPlanTitle.textContent = activePlan?.title || '계획 없음';
    environmentPlanStatus.textContent = hasPlan ? PLANNING_PHASE_LABEL[planningPhase] : '';
    environmentPlan.setAttribute(
      'aria-label',
      hasPlan
        ? `계획 열기, ${activePlan?.title || '제목 없는 계획'}, ${PLANNING_PHASE_LABEL[planningPhase]}`
        : '계획 없음',
    );
    planColumnMeta.textContent = hasPlan ? PLANNING_PHASE_LABEL[planningPhase] : '활성 계획 없음';
    applyReviewColState();
  }

  /* 전체 화면 전환. 새 화면을 짓지 않고 무대의 배치만 바꾼다.
     스레드·대화는 안정적인 shell로 남고 검토는 오른쪽 drawer로 옮긴다.
     DOM을 재생성하지 않으므로 스레드·모델·승인 상태가 모두 이어진다.

     전환은 clip-path 로 연다: 콘솔이 사이드바 자리에서 자라나고,
     돌아갈 때는 그 자리로 접힌다. 내용물은 한 번만 배치하고 보이는
     영역만 옮기므로 레이아웃 비용은 한 번뿐이다. 용지(#editor-area)는
     같은 320ms 축으로 함께 움직인다 — 패널과 용지가 따로 놀지 않는다. */
  let fsMotionTimer: number | null = null;
  let fsReturnTimer: number | null = null;

  function cancelFsMotionTimers(): void {
    if (fsMotionTimer !== null) {
      window.clearTimeout(fsMotionTimer);
      fsMotionTimer = null;
    }
    if (fsReturnTimer !== null) {
      window.clearTimeout(fsReturnTimer);
      fsReturnTimer = null;
    }
  }

  function setFsClipVars(top: number, bottom: number, left: number): void {
    root.style.setProperty('--ag-fs-clip-top', `${Math.max(0, top)}px`);
    root.style.setProperty('--ag-fs-clip-bottom', `${Math.max(0, bottom)}px`);
    root.style.setProperty('--ag-fs-clip-left', `${Math.max(0, left)}px`);
  }

  /** 돌아갈 사이드바 자리. measure() 와 같은 기준이라 접힘 끝에서
      clip 영역과 사이드바 상자가 정확히 포개져 교체가 보이지 않는다. */
  function setFsClipVarsToSidebar(): void {
    const top = document.getElementById('editor-area')?.getBoundingClientRect().top ?? 96;
    const statusTop =
      document.getElementById('status-bar')?.getBoundingClientRect().top ?? window.innerHeight;
    const width = Math.min(sidebarWidth, window.innerWidth);
    setFsClipVars(top, window.innerHeight - statusTop, window.innerWidth - width);
  }

  /** 전체 화면 무대를 걷고 사이드바 배치로 되돌린다. */
  function restoreSidebarLayout(): void {
    endColumnResize();
    applyThreadsRailState();
    applyReviewColState();
    threadsBtn.setAttribute('aria-expanded', 'false');
    threadsBtn.title = '채팅 목록';
    threadsBtn.setAttribute('aria-label', '채팅 목록');
    reviewColumn.setAttribute('aria-hidden', 'true');
    planColumn.setAttribute('aria-hidden', 'true');
    threadsPage.setAttribute('aria-hidden', 'true');
    chatPage.setAttribute('aria-hidden', 'false');
    // 변경 검토·계획·입력기는 다시 사이드바의 분리된 inline 흐름으로 돌아간다.
    chatPage.append(review, planSurface, composer);
    applyPlanMinimizedState();
  }

  function setFullscreen(on: boolean): void {
    if (fullscreen === on) return;
    if (on && settingsPanelOpen && settingsPanel.isDirty()) {
      void requestSettingsClose(undefined, () => setFullscreen(true));
      return;
    }
    fullscreen = on;
    hideThreadPopover();
    cancelFsMotionTimers();

    const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // clip 이 자라나는 출발점 — 배치가 바뀌기 전에 잰다. 접히던
    // 도중 되돌아가는 경우에는 현재 clip 값에서 이어가므로 잴 필요가 없다.
    const enterRect =
      on && animate && !root.classList.contains('ag-fs-to')
        ? root.getBoundingClientRect()
        : null;

    // 돌아갈 때는 접힘이 끝난 뒤에 클래스를 걷는다 — 접히는 동안
    // 전체 화면 배치(기하·workspace·숨겨진 손잡이)가 유지되어야 한다.
    if (on || !animate) root.classList.toggle('ag-fullscreen', on);
    document.body.classList.toggle('ag-fullscreen-open', on);
    applyEnvironmentPanelState();
    fullscreenBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    fullscreenBtn.setAttribute('aria-label', on ? '사이드바로 돌아가기' : '에이전트 집중 모드');
    fullscreenBtn.title = on ? '사이드바로 돌아가기 (Esc)' : '에이전트 집중 모드';
    const nextIcon = createIcon(on ? 'contract' : 'expand');
    fullscreenIcon.replaceWith(nextIcon);
    fullscreenIcon = nextIcon;

    if (on) {
      root.classList.remove('ag-fs-return', 'ag-fs-exiting');
      if (animate) {
        // 전환 자세는 배치 변경보다 먼저 세운다 — 첫 스타일 확정이
        // 접힌 자세(ag-fs-from)여야 clip 이 펼침 방향으로만 보간된다.
        if (enterRect) {
          setFsClipVars(enterRect.top, window.innerHeight - enterRect.bottom, enterRect.left);
        }
        root.classList.add('ag-fs-motion', 'ag-fs-entering');
        if (enterRect) root.classList.add('ag-fs-from');
        // 접히던 도중 되돌아가기 — clip 이 현재 값에서 그대로 펼쳐진다.
        else root.classList.remove('ag-fs-to');
      } else {
        root.classList.remove('ag-fs-motion', 'ag-fs-from', 'ag-fs-to');
      }

      // 접힌 상태에서 바로 펼칠 수 있어야 한다.
      setCollapsed(false, { recenter: false });
      // 페이지 전환 상태를 걷어내고 레일 + 대화 무대를 세운다.
      threadsPanelOpen = false;
      skillsPanelOpen = false;
      closeSettingsPage();
      closeVersionsPage();
      root.classList.remove('ag-threads-open', 'ag-skills-open');
      threadsBtn.setAttribute('aria-expanded', 'false');
      skillsBtn.setAttribute('aria-expanded', 'false');
      chatPage.setAttribute('aria-hidden', 'false');
      skillsPage.setAttribute('aria-hidden', 'true');
      threadsPage.setAttribute('aria-hidden', 'false');
      rebuildThreadsList();
      // 칸 폭은 클래스 규칙이 아니라 인라인 변수로 산다.
      applyRailWidth(railWidth, { persist: false });
      applyReviewWidth(reviewWidth, { persist: false });
      // 변경 사항과 계획은 각각의 환경 drawer에 둔다.
      reviewColumn.appendChild(review);
      planColumn.appendChild(planSurface);
      reviewColCollapsed = true;
      planColCollapsed = true;
      applyThreadsRailState();
      applyReviewColState();

      setConfigPanelOpen(false);
      // 인라인 top/bottom 을 모드에 맞게 다시 잰다.
      measure();
      window.requestAnimationFrame(refreshEnvironmentFilenameMarquee);
      // 문서가 가려지거나 다시 드러나므로 용지 정렬을 다시 잡는다.
      startInsetRecenterLoop();
      scrollConversationToEnd();

      if (!animate) return;
      // 접힌 자세를 확정한 뒤 펼침으로 넘긴다.
      void root.offsetHeight;
      if (enterRect) root.classList.remove('ag-fs-from');
      fsMotionTimer = window.setTimeout(() => {
        root.classList.remove('ag-fs-motion', 'ag-fs-entering', 'ag-fs-to');
        fsMotionTimer = null;
      }, FS_MOTION_SETTLE_MS);
      return;
    }

    if (!animate) {
      root.classList.remove('ag-fs-motion', 'ag-fs-from', 'ag-fs-to', 'ag-fs-entering', 'ag-fs-return');
      restoreSidebarLayout();
      setConfigPanelOpen(false);
      measure();
      startInsetRecenterLoop();
      scrollConversationToEnd();
      return;
    }

    // 접히는 동안 용지가 같은 시간축으로 제자리를 찾는다.
    startInsetRecenterLoop();
    setFsClipVarsToSidebar();
    root.classList.remove('ag-fs-entering', 'ag-fs-from', 'ag-fs-return');
    root.classList.add('ag-fs-motion', 'ag-fs-exiting', 'ag-fs-to');
    fsMotionTimer = window.setTimeout(() => {
      fsMotionTimer = null;
      root.classList.remove('ag-fullscreen', 'ag-fs-to', 'ag-fs-exiting');
      restoreSidebarLayout();
      setConfigPanelOpen(false);
      measure();
      scrollConversationToEnd();
      // 돌아온 사이드바는 스며들며 마무리.
      root.classList.add('ag-fs-return');
      fsReturnTimer = window.setTimeout(() => {
        root.classList.remove('ag-fs-motion', 'ag-fs-return');
        fsReturnTimer = null;
      }, FS_RETURN_SETTLE_MS);
    }, FS_MOTION_SETTLE_MS);
  }

  function updatePermissionButton(): void {
    const unrestricted = permissionProfile === 'unrestricted';
    permissionBtn.textContent = unrestricted ? '전체' : '안전';
    permissionBtn.setAttribute('aria-label', unrestricted ? '에이전트 권한: 전체 접근' : '에이전트 권한: 안전');
    permissionBtn.setAttribute('aria-pressed', unrestricted ? 'true' : 'false');
    permissionBtn.classList.toggle('ag-permission-unrestricted', unrestricted);
    permissionBtn.title = unrestricted
      ? '에이전트가 승인 없이 문서를 편집하고, 파일·명령이 노트북 전체에 접근할 수 있습니다. 클릭하여 안전 모드로 전환'
      : '문서 편집은 턴이 끝나면 검토 대기로 남아 승인 후 반영됩니다. 파일과 명령은 프로젝트 안에서만 사용합니다';
    refreshSidebarWidthMin();
  }

  permissionBtn.addEventListener('click', () => {
    if (isControlLocked()) return;
    if (permissionProfile === 'safe') {
      const confirmed = window.confirm('전체 접근을 켜면 에이전트가 승인 없이 문서를 편집하고, 명령과 파일 도구가 노트북 전체에 접근할 수 있습니다. 이 채팅에서 계속 허용할까요?');
      if (!confirmed) return;
      bridge.setPermissionProfile('unrestricted');
    } else {
      bridge.setPermissionProfile('safe');
    }
  });
  updatePermissionButton();

  /** 스킬·설정·목록 세 페이지는 서로를 닫는다 — 무대에는 하나만 선다. */
  function closeSettingsPage(): void {
    settingsPanelOpen = false;
    root.classList.remove('ag-settings-open');
    settingsBtn.setAttribute('aria-expanded', 'false');
    workspaceSettingsBtn.setAttribute('aria-expanded', 'false');
    workspaceSettingsBtn.classList.remove('ag-active');
    workspaceTitle.textContent = '대화';
    settingsPage.setAttribute('aria-hidden', 'true');
    settingsPanel.close();
  }

  async function requestSettingsClose(
    returnFocus?: HTMLElement,
    afterClose?: () => void,
  ): Promise<boolean> {
    if (!settingsPanelOpen) {
      afterClose?.();
      return true;
    }
    if (!await settingsPanel.requestClose()) return false;
    closeSettingsPage();
    chatPage.setAttribute('aria-hidden', 'false');
    root.classList.remove('ag-settings-open');
    returnFocus?.focus();
    afterClose?.();
    return true;
  }

  function closeVersionsPage(): void {
    versionsPanelOpen = false;
    root.classList.remove('ag-versions-open');
    versionsBtn.setAttribute('aria-expanded', 'false');
    versionsPage.setAttribute('aria-hidden', 'true');
    versionsPage.inert = true;
    chatPage.inert = false;
    versionManagerPage?.close();
  }

  function setSkillsPanelOpen(open: boolean): void {
    if (open && settingsPanelOpen && settingsPanel.isDirty()) {
      void requestSettingsClose(undefined, () => setSkillsPanelOpen(true));
      return;
    }
    if (open && referenceLibrary.isOpen()) referenceLibrary.setOpen(false);
    skillsPanelOpen = open;
    if (open) setConfigPanelOpen(false);
    threadsPanelOpen = false;
    closeSettingsPage();
    closeVersionsPage();
    root.classList.toggle('ag-skills-open', open);
    root.classList.remove('ag-threads-open');
    skillsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    skillsPage.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (fullscreen) {
      // 전체 화면에서 이 두 속성은 레일 접힘 상태를 뜻하므로 덮어쓰지 않는다.
      applyThreadsRailState();
    } else {
      threadsBtn.setAttribute('aria-expanded', 'false');
      threadsPage.setAttribute('aria-hidden', 'true');
    }
    chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
    if (!open) showSkillList();
    if (open) {
      bridge.listSkills();
      skillsSearch.focus();
    }
  }

  /** 설정 페이지 — setSkillsPanelOpen 과 같은 문법(무대 전환 + 상호 배제). */
  function setSettingsPanelOpen(open: boolean, destination?: SettingsDestination): void {
    if (!open && settingsPanelOpen && settingsPanel.isDirty()) {
      void requestSettingsClose(fullscreen ? workspaceSettingsBtn : settingsBtn);
      return;
    }
    if (open && referenceLibrary.isOpen()) referenceLibrary.setOpen(false);
    settingsPanelOpen = open;
    if (open) {
      setConfigPanelOpen(false);
      threadsPanelOpen = false;
      skillsPanelOpen = false;
      root.classList.remove('ag-threads-open', 'ag-skills-open');
      skillsBtn.setAttribute('aria-expanded', 'false');
      skillsPage.setAttribute('aria-hidden', 'true');
      closeVersionsPage();
    }
    root.classList.toggle('ag-settings-open', open);
    settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    workspaceSettingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    workspaceSettingsBtn.classList.toggle('ag-active', open);
    workspaceTitle.textContent = open ? '설정' : '대화';
    settingsPage.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (fullscreen) {
      // 전체 화면에서 목록 관련 aria 는 레일 접힘 상태를 뜻하므로 덮어쓰지 않는다.
      applyThreadsRailState();
    } else if (open) {
      threadsBtn.setAttribute('aria-expanded', 'false');
      threadsPage.setAttribute('aria-hidden', 'true');
    }
    chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
    if (open) {
      setCollapsed(false);
      settingsPanel.open(destination);
      settingsPage.querySelector<HTMLElement>('.ag-settings-nav-button.ag-active')?.focus();
    } else {
      settingsPanel.close();
    }
  }

  function requestSettingsOpen(destination?: SettingsDestination): void {
    if (eventBus) {
      eventBus.emit('settings:open', destination ? { destination } : undefined);
      return;
    }
    setCollapsed(false);
    setSettingsPanelOpen(true, destination);
  }

  function openConfiguredVersionControl(): void {
    if (!userSettings.getUseHancomGit() && openClassicVersionControl) {
      closeVersionsPage();
      openClassicVersionControl();
      return;
    }
    setVersionsPanelOpen(true);
  }

  function setVersionsPanelOpen(open: boolean): void {
    if (!versionController) return;
    if (open && settingsPanelOpen && settingsPanel.isDirty()) {
      void requestSettingsClose(undefined, () => setVersionsPanelOpen(true));
      return;
    }
    if (deferredVersionsOpenTimer !== null) {
      window.clearTimeout(deferredVersionsOpenTimer);
      deferredVersionsOpenTimer = null;
    }
    if (fullscreen) {
      setFullscreen(false);
      deferredVersionsOpenTimer = window.setTimeout(() => {
        deferredVersionsOpenTimer = null;
        setVersionsPanelOpen(open);
      }, FS_MOTION_SETTLE_MS);
      return;
    }
    if (open && referenceLibrary.isOpen()) referenceLibrary.setOpen(false);
    versionsPanelOpen = open;
    if (open) {
      setConfigPanelOpen(false);
      threadsPanelOpen = false;
      skillsPanelOpen = false;
      closeSettingsPage();
      root.classList.remove('ag-threads-open', 'ag-skills-open');
      threadsBtn.setAttribute('aria-expanded', 'false');
      skillsBtn.setAttribute('aria-expanded', 'false');
      threadsPage.setAttribute('aria-hidden', 'true');
      skillsPage.setAttribute('aria-hidden', 'true');
    }
    root.classList.toggle('ag-versions-open', open);
    versionsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    versionsPage.setAttribute('aria-hidden', open ? 'false' : 'true');
    versionsPage.inert = !open;
    chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
    chatPage.inert = open;
    if (open) versionManagerPage?.open();
    else versionManagerPage?.close();
  }

  function showSkillList(): void {
    activeSkillDraftRequestId = null;
    skillEditor.hidden = true;
    skillsToolbar.hidden = false;
    skillsList.hidden = false;
    editingSkill = null;
    skillDraftFiles = [];
    renderSkillsList();
  }

  function syncSkillIconPicker(icon: ProductSkillIcon, disabled = false): void {
    selectedSkillIcon = icon;
    skillIconPicker.disabled = disabled;
    for (const [value, input] of skillIconInputs) input.checked = value === icon;
  }

  function syncSelectedIconToSkillFile(): void {
    const file = skillDraftFiles.find((entry) => entry.path === 'SKILL.md');
    if (!file || file.encoding !== 'utf8') return;
    const next = withSkillIconFrontmatter(file.content, selectedSkillIcon);
    if (next === file.content) return;
    file.content = next;
    if (selectedSkillFile === 'SKILL.md') skillFileEditor.value = next;
  }

  function beginSkillCreate(): void {
    activeSkillDraftRequestId = null;
    setSkillsPanelOpen(true);
    skillsToolbar.hidden = true;
    skillsList.hidden = true;
    skillEditor.hidden = false;
    skillEditorTitle.textContent = '새 스킬';
    skillGoal.value = '';
    skillTriggers.value = '';
    skillNonTriggers.value = '';
    skillName.value = '';
    skillDraftFiles = [];
    editingSkill = null;
    skillName.disabled = false;
    skillSave.hidden = false;
    skillGenerate.hidden = false;
    skillGenerate.disabled = false;
    skillSave.disabled = false;
    skillValidationReady = false;
    skillSave.textContent = '검증하기';
    skillResources.disabled = false;
    syncSkillIconPicker('system');
    skillResourceStatus.textContent = '선택된 파일 없음';
    selectedSkillFile = 'SKILL.md';
    skillFileEditor.value = '';
    skillWarning.textContent = 'AI 초안은 저장되지 않습니다. 파일을 검토한 뒤 저장하세요.';
    renderSkillFiles();
    skillGoal.focus();
  }

  function commitSkillFileEditor(): void {
    const file = skillDraftFiles.find((entry) => entry.path === selectedSkillFile);
    if (file && file.encoding === 'utf8') file.content = skillFileEditor.value;
  }

  function invalidateSkillValidation(): void {
    skillDraftRevision++;
    skillValidationReady = false;
    skillSave.textContent = '검증하기';
  }

  function renderSkillFiles(): void {
    skillFiles.replaceChildren();
    for (const file of skillDraftFiles) {
      const button = el('button', 'ag-skill-file', file.path);
      button.type = 'button';
      button.classList.toggle('ag-active', file.path === selectedSkillFile);
      button.addEventListener('click', () => {
        commitSkillFileEditor();
        selectedSkillFile = file.path;
        renderSkillFiles();
      });
      skillFiles.appendChild(button);
    }
    const selected = skillDraftFiles.find((entry) => entry.path === selectedSkillFile) ?? skillDraftFiles[0];
    if (selected) {
      selectedSkillFile = selected.path;
      skillFileEditor.disabled = selected.encoding === 'base64' || editingSkill?.origin === 'bundled';
      skillFileEditor.value = selected.encoding === 'utf8' ? selected.content : '(바이너리 자산 — 직접 편집할 수 없음)';
    } else {
      skillFileEditor.disabled = true;
      skillFileEditor.value = '';
    }
    const hasScripts = skillDraftFiles.some((file) => file.path.startsWith('scripts/'));
    skillWarning.textContent = hasScripts
      ? '이 스킬에는 실행 가능한 스크립트가 있습니다. 저장 전에 모든 코드를 검토하세요.'
      : '스킬은 rhwp에서만 보이며 Claude/Codex의 전역 스킬 폴더에는 설치되지 않습니다.';
  }

  function applySkillDraft(
    name: string,
    files: Array<{ path: string; content: string; encoding?: 'utf8' | 'base64' }>,
    icon: ProductSkillIcon = selectedSkillIcon,
  ): void {
    invalidateSkillValidation();
    syncSkillIconPicker(icon, skillIconPicker.disabled);
    skillName.value = name;
    skillDraftFiles = files.map((file) => ({ path: file.path, content: file.content, encoding: file.encoding ?? 'utf8' }));
    syncSelectedIconToSkillFile();
    const resourceCount = skillDraftFiles.filter((file) => file.path !== 'SKILL.md').length;
    skillResourceStatus.textContent = resourceCount > 0 ? `${resourceCount}개 파일 추가됨` : '선택된 파일 없음';
    selectedSkillFile = skillDraftFiles.some((file) => file.path === 'SKILL.md') ? 'SKILL.md' : (skillDraftFiles[0]?.path ?? 'SKILL.md');
    renderSkillFiles();
  }

  function openSkill(skill: ProductSkill, action: 'edit' | 'duplicate' = 'edit'): void {
    setSkillsPanelOpen(true);
    activeSkillDraftRequestId = null;
    const requestId = bridge.readSkill(skill.name);
    skillRequestActions.set(requestId, action);
    skillsStatus.textContent = `${skill.name} 불러오는 중…`;
  }

  function renderSkillsList(): void {
    skillsList.replaceChildren();
    const query = skillsSearch.value.trim().toLowerCase();
    const visible = skillCatalog.skills.filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query));
    if (visible.length === 0) {
      skillsList.appendChild(el('div', 'ag-skills-empty', query ? '검색 결과가 없습니다' : '사용 가능한 스킬이 없습니다'));
      return;
    }
    for (const origin of ['bundled', 'user'] as const) {
      const group = visible.filter((skill) => skill.origin === origin);
      if (group.length === 0) continue;
      skillsList.appendChild(el('h3', 'ag-skills-group-title', origin === 'bundled' ? 'rhwp 기본 스킬' : '내 스킬'));
      for (const skill of group) {
        const item = el('article', 'ag-skill-item');
        if (!skill.enabled) item.classList.add('ag-skill-disabled');
        const copy = el('button', 'ag-skill-copy');
        copy.type = 'button';
        const copyIcon = el('span', 'ag-skill-kind-icon');
        copyIcon.appendChild(createIcon(skillGlyphForSkill(skill)));
        const copyText = el('span', 'ag-skill-copy-text');
        copyText.append(el('strong', 'ag-skill-item-name', `/${skill.name}`), el('span', 'ag-skill-item-description', skill.description));
        const badges = el('span', 'ag-skill-badges');
        if (skill.required) badges.appendChild(el('span', 'ag-skill-badge', '필수'));
        if (skill.hasScripts) badges.appendChild(el('span', 'ag-skill-badge ag-skill-badge-warn', '스크립트'));
        if (skill.hasAssets) badges.appendChild(el('span', 'ag-skill-badge', '자산'));
        copyText.appendChild(badges);
        copy.append(copyIcon, copyText);
        copy.addEventListener('click', () => openSkill(skill));
        const actions = el('div', 'ag-skill-item-actions');
        const toggle = el('button', 'ag-skill-toggle', skill.required ? '필수' : (skill.enabled ? '사용 중' : '꺼짐'));
        toggle.type = 'button';
        toggle.disabled = Boolean(skill.required);
        toggle.setAttribute('aria-pressed', skill.enabled ? 'true' : 'false');
        if (!skill.required) {
          toggle.addEventListener('click', () => bridge.setSkillEnabled(skill.name, !skill.enabled));
        }
        actions.appendChild(toggle);
        if (skill.origin === 'bundled') {
          const duplicate = el('button', 'ag-skill-secondary', '복제');
          duplicate.type = 'button';
          duplicate.addEventListener('click', () => openSkill(skill, 'duplicate'));
          actions.appendChild(duplicate);
        } else {
          const remove = el('button', 'ag-skill-secondary ag-skill-danger', '삭제');
          remove.type = 'button';
          remove.addEventListener('click', () => {
            if (window.confirm(`/${skill.name} 스킬을 휴지통으로 옮길까요?`)) bridge.deleteSkill(skill.name);
          });
          actions.appendChild(remove);
        }
        item.append(copy, actions);
        skillsList.appendChild(item);
      }
    }
  }

  skillsBtn.addEventListener('click', () => setSkillsPanelOpen(true));
  skillsClose.addEventListener('click', () => { setSkillsPanelOpen(false); skillsBtn.focus(); });
  skillsNew.addEventListener('click', beginSkillCreate);
  skillEditorBack.addEventListener('click', () => { showSkillList(); skillsSearch.focus(); });
  skillsSearch.addEventListener('input', renderSkillsList);
  skillFileEditor.addEventListener('input', () => { commitSkillFileEditor(); invalidateSkillValidation(); });
  skillName.addEventListener('input', invalidateSkillValidation);
  for (const [icon, radio] of skillIconInputs) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      commitSkillFileEditor();
      selectedSkillIcon = icon;
      syncSelectedIconToSkillFile();
      invalidateSkillValidation();
    });
  }
  skillGenerate.addEventListener('click', () => {
    const goal = skillGoal.value.trim();
    if (!goal) { skillsStatus.textContent = '먼저 스킬의 목표를 적어 주세요.'; skillGoal.focus(); return; }
    commitSkillFileEditor();
    syncSelectedIconToSkillFile();
    const existingSkill = skillDraftFiles.find((file) => file.path === 'SKILL.md')?.content;
    const requestId = bridge.generateSkillDraft({ goal, triggerExamples: skillTriggers.value.trim(), nonTriggerExamples: skillNonTriggers.value.trim(), resourceNotes: skillDraftFiles.length > 1 ? 'Preserve useful attached resources and reference them from SKILL.md.' : '', existingSkill });
    activeSkillDraftRequestId = requestId;
    skillGenerate.disabled = true;
    skillsStatus.textContent = `${AGENT_LABEL[selectedAgent]}가 스킬 초안을 만드는 중…`;
  });
  skillSave.addEventListener('click', () => {
    commitSkillFileEditor();
    syncSelectedIconToSkillFile();
    const name = skillName.value.trim();
    if (!name || !skillDraftFiles.some((file) => file.path === 'SKILL.md')) {
      skillsStatus.textContent = '스킬 이름과 SKILL.md가 필요합니다.';
      return;
    }
    if (!skillValidationReady) {
      skillSave.disabled = true;
      const requestId = bridge.validateSkill({ name, files: skillDraftFiles });
      skillValidationRequests.set(requestId, skillDraftRevision);
      skillsStatus.textContent = '스킬 구조와 파일을 검증하는 중…';
      return;
    }
    if (!window.confirm(`/${name} 스킬을 사용자 라이브러리에 저장할까요?`)) return;
    skillSave.disabled = true;
    bridge.saveSkill({ name, files: skillDraftFiles });
    skillsStatus.textContent = '저장하는 중…';
  });
  skillResources.addEventListener('change', () => {
    const files = [...(skillResources.files ?? [])];
    const kind = skillResourceKind.value as 'references' | 'scripts' | 'assets';
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result ?? '');
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-');
        const rel = `${kind}/${safeName}`;
        const textLike = kind === 'scripts' || file.type.startsWith('text/') || /\.(?:md|txt|json|ya?ml|toml|js|mjs|cjs|ts|py|sh|css|html|xml|csv)$/i.test(file.name);
        const comma = data.indexOf(',');
        skillDraftFiles = skillDraftFiles.filter((entry) => entry.path !== rel);
        skillDraftFiles.push({
          path: rel,
          content: textLike ? data : (comma >= 0 ? data.slice(comma + 1) : ''),
          encoding: textLike ? 'utf8' : 'base64',
        });
        invalidateSkillValidation();
        const resourceCount = skillDraftFiles.filter((entry) => entry.path !== 'SKILL.md').length;
        skillResourceStatus.textContent = `${resourceCount}개 파일 추가됨`;
        renderSkillFiles();
      };
      const textLike = kind === 'scripts' || file.type.startsWith('text/') || /\.(?:md|txt|json|ya?ml|toml|js|mjs|cjs|ts|py|sh|css|html|xml|csv)$/i.test(file.name);
      if (textLike) reader.readAsText(file);
      else reader.readAsDataURL(file);
    }
    skillResources.value = '';
  });

  function applyFastCommand(action: 'on' | 'off' | 'status' | 'toggle'): void {
    if (!agentSupportsFast(selectedAgent)) {
      systemMessage('Fast는 Codex에서만 사용할 수 있습니다.');
      return;
    }
    if (action === 'status') {
      systemMessage(selectedServiceTier === 'fast'
        ? 'Codex Fast가 켜져 있습니다. 다음 턴부터 우선 처리됩니다.'
        : 'Codex Fast가 꺼져 있습니다.');
      return;
    }
    if (isControlLocked()) {
      systemMessage('응답이 끝난 뒤에 Fast를 바꿀 수 있습니다.');
      return;
    }
    const next: ServiceTier = action === 'toggle'
      ? (selectedServiceTier === 'fast' ? 'standard' : 'fast')
      : (action === 'on' ? 'fast' : 'standard');
    if (next === selectedServiceTier) {
      systemMessage(next === 'fast'
        ? 'Codex Fast가 이미 켜져 있습니다.'
        : 'Codex Fast가 이미 꺼져 있습니다.');
      return;
    }
    selectedServiceTier = next;
    currentThread.serviceTier = next;
    persistCurrentThread();
    if (bridge.getActiveAgent() === 'codex') bridge.setServiceTier(next);
    systemMessage(next === 'fast'
      ? 'Codex Fast를 켰습니다. 다음 턴부터 우선 처리됩니다.'
      : 'Codex Fast를 껐습니다.');
  }

  type SlashOption = {
    value: string;
    label: string;
    detail: string;
    local?: 'skills' | 'create' | 'calibration' | 'settings' | 'templates' | 'fast';
    workflow?: AgentWorkflow;
    templateId?: string;
    skillName?: string;
    skillIcon?: ProductSkillIcon;
  };
  let slashOptions: SlashOption[] = [];
  let slashIndex = 0;

  function skillDisplayName(name: string): string {
    return name
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
      .join(' ');
  }

  function resizeComposerInput(): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  /** Product skill은 textarea 문자열이 아니라 독립된 토큰으로 유지한다. */
  function setComposerSkill(skill: ProductSkill | null, remainder?: string): void {
    activeComposerSkill = skill;
    composerSkill.hidden = skill === null;
    composerSkillName.textContent = skill ? skillDisplayName(skill.name) : '';
    composerSkillIcon.replaceChildren();
    if (skill) composerSkillIcon.appendChild(createIcon(skillGlyphForSkill(skill)));
    composerSkill.dataset.agent = skill ? selectedAgent : '';
    composerSkill.title = skill ? `/${skill.name} · ${skill.description}` : '';
    input.setAttribute('aria-label', skill ? `/${skill.name} 스킬 뒤의 메시지 입력` : '에이전트 메시지 입력');
    if (remainder !== undefined) input.value = remainder;
    resizeComposerInput();
    updateComposer();
  }

  composerSkillClear.addEventListener('click', () => {
    setComposerSkill(null);
    input.focus();
  });

  function setSlashMenuOpen(open: boolean): void {
    slashMenu.hidden = !open;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) input.removeAttribute('aria-activedescendant');
  }

  function renderActiveTemplate(): void {
    templateChip.hidden = activeTemplate === null;
    templateChipName.textContent = activeTemplate?.name ?? '';
    templateChip.title = activeTemplate ? `${activeTemplate.originalName} · r${activeTemplate.revision}` : '';
  }

  function selectTemplate(template: DocumentTemplate | null, sync = true): void {
    activeTemplate = template;
    currentThread.activeTemplateId = template?.id ?? null;
    renderActiveTemplate();
    if (sync) bridge.setActiveTemplate(template?.id ?? null);
    persistCurrentThread();
  }

  templateChipClear.addEventListener('click', () => {
    selectTemplate(null);
    input.focus();
  });

  function rebuildSlashMenu(): void {
    if (activeComposerSkill) {
      setSlashMenuOpen(false);
      return;
    }
    const templateMatch = input.value.match(/^\s*\/templates(?:\s+([\s\S]*))?$/i);
    if (templateMatch && !input.value.trimStart().startsWith('//')) {
      const query = templateMatch[1] ?? '';
      const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase().trim();
      const completeName = [...templateCatalog.templates]
        .sort((a, b) => b.name.length - a.name.length)
        .find((template) => normalizedQuery.startsWith(`${template.name.normalize('NFKC').toLocaleLowerCase()} `));
      if (completeName) {
        setSlashMenuOpen(false);
        return;
      }
      slashOptions = templateCatalog.templates
        .map((template) => ({ template, score: fuzzyTemplateScore(template.name, query) }))
        .filter((item): item is { template: DocumentTemplate; score: number } => item.score !== null)
        .sort((a, b) => b.score - a.score || a.template.name.localeCompare(b.template.name, 'ko'))
        .map(({ template }) => ({
          value: `/templates ${template.name}`,
          label: template.name,
          detail: `${template.format.toUpperCase()} · ${template.pageCount}쪽 · r${template.revision}`,
          templateId: template.id,
        }));
      slashIndex = Math.min(slashIndex, Math.max(0, slashOptions.length - 1));
      renderSlashRows();
      return;
    }
    const match = input.value.match(/^\s*\/([^\s/]*)$/);
    if (!match || input.value.trimStart().startsWith('//')) { setSlashMenuOpen(false); return; }
    const query = match[1].toLowerCase();
    const base: SlashOption[] = [
      { value: '/plan', label: '/plan', detail: '구상·조사 모드로 전환', workflow: 'plan' },
      { value: '/question', label: '/question', detail: '질문·조사 모드로 전환', workflow: 'question' },
      { value: '/build', label: '/build', detail: '바로 실행 모드로 전환', workflow: 'direct' },
      ...(agentSupportsFast(selectedAgent)
        ? [{
            value: '/fast',
            label: '/fast',
            detail: selectedServiceTier === 'fast' ? 'Codex Fast 끄기' : 'Codex Fast 켜기',
            local: 'fast' as const,
          }]
        : []),
      { value: '/calibration', label: '/calibration', detail: '말투를 맞출까요? 열기', local: 'calibration' },
      { value: '/settings', label: '/settings', detail: '설정 열기 (연결·기본값·사용량)', local: 'settings' },
      { value: '/templates', label: '/templates', detail: '문서 템플릿 선택', local: 'templates' },
      { value: '/skills', label: '/skills', detail: '스킬 라이브러리 열기', local: 'skills' },
      { value: '/skill-create', label: '/skill-create', detail: '새 스킬 만들기', local: 'create' },
      { value: '/skill-edit', label: '/skill-edit', detail: '사용자 스킬 편집' },
      { value: '/skill-delete', label: '/skill-delete', detail: '사용자 스킬 삭제' },
    ];
    const product = skillCatalog.skills
      .filter((skill) => skill.enabled && !skill.invalid)
      .map((skill) => ({
        value: `/${skill.name}`,
        label: `/${skill.name}`,
        detail: skill.description,
        skillName: skill.name,
        skillIcon: skill.icon,
      }));
    slashOptions = [...base, ...product].filter((option) => option.label.slice(1).toLowerCase().includes(query));
    slashIndex = Math.min(slashIndex, Math.max(0, slashOptions.length - 1));
    renderSlashRows();
  }

  function renderSlashRows(): void {
    slashMenu.replaceChildren();
    slashOptions.forEach((option, index) => {
      const row = el('button', 'ag-slash-option');
      row.id = `ag-slash-option-${index}`;
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === slashIndex ? 'true' : 'false');
      row.classList.toggle('ag-active', index === slashIndex);
      if (option.skillName) {
        row.classList.add('ag-skill-option');
        const icon = el('span', 'ag-slash-skill-icon');
        icon.appendChild(createIcon(skillGlyphForSkill({ name: option.skillName, icon: option.skillIcon })));
        row.append(icon, el('strong', 'ag-slash-name', option.label), el('span', 'ag-slash-detail', option.detail));
      } else {
        row.classList.add('ag-command-option');
        const icon = el('span', 'ag-slash-command-icon');
        icon.appendChild(createIcon('external'));
        row.append(icon, el('strong', 'ag-slash-name', option.label), el('span', 'ag-slash-detail', option.detail));
      }
      row.addEventListener('mousedown', (event) => { event.preventDefault(); chooseSlashOption(option); });
      slashMenu.appendChild(row);
    });
    const open = slashOptions.length > 0;
    setSlashMenuOpen(open);
    if (open) input.setAttribute('aria-activedescendant', `ag-slash-option-${slashIndex}`);
  }

  function chooseSlashOption(option: SlashOption): void {
    setSlashMenuOpen(false);
    if (option.skillName) {
      const skill = skillCatalog.skills.find((item) => item.name === option.skillName && item.enabled && !item.invalid);
      if (skill) setComposerSkill(skill, '');
      input.focus();
      return;
    }
    if (option.templateId) {
      const template = templateCatalog.templates.find((item) => item.id === option.templateId) ?? null;
      if (template) selectTemplate(template);
      input.value = '';
      input.focus();
      return;
    }
    if (option.workflow) {
      input.value = '';
      requestWorkflow(option.workflow);
      return;
    }
    if (option.local === 'calibration') { input.value = ''; writingStyleCalibration.open(); return; }
    if (option.local === 'settings') { input.value = ''; requestSettingsOpen(); return; }
    if (option.local === 'templates') {
      input.value = '/templates ';
      input.focus();
      rebuildSlashMenu();
      return;
    }
    if (option.local === 'skills') { input.value = ''; setSkillsPanelOpen(true); return; }
    if (option.local === 'create') { input.value = ''; beginSkillCreate(); return; }
    if (option.local === 'fast') { input.value = ''; applyFastCommand(selectedServiceTier === 'fast' ? 'off' : 'on'); return; }
    input.value = `${option.value} `;
    input.focus();
  }

  input.addEventListener('keydown', (e) => {
    if (!slashMenu.hidden && slashOptions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + slashOptions.length) % slashOptions.length;
        rebuildSlashMenu();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        chooseSlashOption(slashOptions[slashIndex]!);
        return;
      }
    }
    if (e.key === 'Backspace' && !input.value && activeComposerSkill) {
      e.preventDefault();
      setComposerSkill(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    if (!activeComposerSkill) {
      // 공백이 slash command를 끝내는 순간 skill을 토큰으로 승격하고,
      // 뒤 문장만 textarea에 남긴다. 이름 prefix가 겹치는 스킬도 안전하다.
      const typedInvocation = input.value.match(/^\s*\/([a-z0-9-]+)\s+([\s\S]*)$/);
      const typedSkill = typedInvocation
        ? skillCatalog.skills.find((skill) => skill.name === typedInvocation[1] && skill.enabled && !skill.invalid)
        : null;
      if (typedSkill && typedInvocation) {
        setComposerSkill(typedSkill, typedInvocation[2]);
        setSlashMenuOpen(false);
        return;
      }
    }
    resizeComposerInput();
    rebuildSlashMenu();
  });
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (readOnlyDocLabel !== null || mergeResolverLocked) return;
    if (cloudUi.isCloudConversation()) {
      if (!cloudUi.isRunning() || activeComposerSkill || referenceLibrary.hasDrafts()) return;
      const cloudText = input.value.trim();
      if (!cloudText) return;
      const messageId = globalThis.crypto?.randomUUID?.()
        ?? `cloud-message-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const userMessage = recordUserMessage(
        cloudText,
        [],
        undefined,
        undefined,
        undefined,
        'queued-cloud',
        messageId,
      );
      const userBubble = renderUserMessage(userMessage);
      appendConversation(userBubble);
      input.value = '';
      resizeComposerInput();
      scrollConversationToMessage(userBubble, { smooth: true });
      void cloudUi.queueMessage(cloudText, messageId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        userBubble.remove();
        input.value = cloudText;
        resizeComposerInput();
        systemMessage(`메시지를 대기열에 넣지 못했습니다: ${message}`);
      });
      return;
    }
    if (turnRunning) {
      bridge.interrupt();
      return;
    }
    if (planningPhase === 'switching' || chatStartPendingThreadId !== null || attachmentsSending || referenceLibrary.hasBlockingDrafts()) return;
    if (selectedAgent === 'rau' && !rauSetupComplete) {
      systemMessage('Rau 연결을 먼저 완료해 주세요.');
      return;
    }
    if (selectedAgent === 'rau' && rauCreditsEmpty()) {
      systemMessage('체험 크레딧이 다 됐어요. 다른 모델을 연결해 주세요.');
      return;
    }
    let text = input.value.trim();
    if ((!text && !activeComposerSkill && !referenceLibrary.hasDrafts()) || connState !== 'connected') return;
    if (referenceLibrary.hasImageDrafts() && !modelSupportsImages(selectedAgent, selectedModel)) {
      systemMessage(`현재 ${AGENT_LABEL[selectedAgent]} 모델은 이미지 입력을 지원하지 않습니다. 이미지 지원 모델로 바꾼 뒤 다시 보내 주세요.`);
      return;
    }
    if (!text && !activeComposerSkill) {
      text = referenceLibrary.allDraftsAreImages()
        ? '첨부한 이미지를 확인해 주세요.'
        : '첨부한 파일을 확인해 주세요.';
    }
    if (!activeComposerSkill && text.startsWith('//')) text = text.slice(1);
    const templateInvocation = activeComposerSkill ? null : text.match(/^\/templates(?:\s+([\s\S]*))?$/i);
    if (templateInvocation) {
      const tail = (templateInvocation[1] ?? '').trim();
      const match = [...templateCatalog.templates]
        .sort((a, b) => b.name.length - a.name.length)
        .find((template) => {
          const name = template.name.normalize('NFKC').toLocaleLowerCase();
          const value = tail.normalize('NFKC').toLocaleLowerCase();
          return value === name || value.startsWith(`${name} `);
        });
      if (!match) {
        input.value = tail ? `/templates ${tail}` : '/templates ';
        rebuildSlashMenu();
        return;
      }
      selectTemplate(match);
      text = tail.slice(match.name.length).trim();
      if (!text) {
        input.value = '';
        setSlashMenuOpen(false);
        input.focus();
        return;
      }
    }
    if (!activeComposerSkill) {
      const workflowInvocation = text.match(/^\/(plan|build|question)(?:\s+([\s\S]*))?$/i);
      if (workflowInvocation) {
        const rest = (workflowInvocation[2] ?? '').trim();
        const command = workflowInvocation[1].toLowerCase();
        const next = command === 'plan' ? 'plan' : command === 'question' ? 'question' : 'direct';
        input.value = '';
        setSlashMenuOpen(false);
        if (!requestWorkflow(next)) return;
        if (!rest) {
          input.focus();
          return;
        }
        text = rest;
      }
      const fastCommand = text.match(/^\/fast(?:\s+(on|off|status))?$/i);
      if (fastCommand) {
        input.value = '';
        setSlashMenuOpen(false);
        const arg = fastCommand[1]?.toLowerCase();
        applyFastCommand(arg === 'on' || arg === 'off' || arg === 'status' ? arg : 'toggle');
        return;
      }
      if (/^\/fast\b/i.test(text)) {
        input.value = '';
        setSlashMenuOpen(false);
        systemMessage('지원하지 않는 /fast 인자입니다. on, off, status를 쓰거나 /fast만 입력하세요.');
        return;
      }
      if (text === '/calibration') { input.value = ''; writingStyleCalibration.open(); return; }
      if (text === '/settings') { input.value = ''; requestSettingsOpen(); return; }
      if (text === '/skills') { input.value = ''; setSkillsPanelOpen(true); return; }
      if (text === '/skill-create') { input.value = ''; beginSkillCreate(); return; }
      const editCommand = text.match(/^\/skill-edit\s+([a-z0-9-]+)$/);
      if (editCommand) {
        const skill = skillCatalog.skills.find((item) => item.name === editCommand[1] && item.origin === 'user');
        if (skill) openSkill(skill); else systemMessage('편집할 사용자 스킬을 찾지 못했습니다.');
        input.value = '';
        return;
      }
      const deleteCommand = text.match(/^\/skill-delete\s+([a-z0-9-]+)$/);
      if (deleteCommand) {
        const skill = skillCatalog.skills.find((item) => item.name === deleteCommand[1] && item.origin === 'user');
        if (skill && window.confirm(`/${skill.name} 스킬을 휴지통으로 옮길까요?`)) bridge.deleteSkill(skill.name);
        else if (!skill) systemMessage('삭제할 사용자 스킬을 찾지 못했습니다.');
        input.value = '';
        return;
      }
    }
    let invokedSkill = activeComposerSkill;
    const invocation = activeComposerSkill ? null : text.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/);
    const matchedSkill = invocation
      ? skillCatalog.skills.find((skill) => skill.name === invocation[1] && skill.enabled && !skill.invalid)
      : undefined;
    if (invocation && matchedSkill) {
      invokedSkill = matchedSkill;
      text = invocation[2]?.trim() ?? '';
    }
    const skillNameForMessage = invokedSkill?.name;
    const skillIconForMessage = invokedSkill
      ? invokedSkill.icon ?? defaultSkillIconForName(invokedSkill.name)
      : undefined;
    if (threadsPanelOpen) setThreadsPanelOpen(false);
    if (skillsPanelOpen) setSkillsPanelOpen(false);
    if (settingsPanelOpen) setSettingsPanelOpen(false);
    const messageText = activeTemplate && !skillNameForMessage
        ? `/templates ${activeTemplate.name}${text ? ` ${text}` : ''}`
        : text;
    // 대화 기록은 skill block만 보이도록 빈 본문을 유지한다. 다만 wire
    // protocol은 비어 있지 않은 text를 요구하므로 명시적 slash 호출 자체를
    // 요청 본문으로 보낸다. 자연어 fallback을 UI나 기록에 숨겨 넣지 않는다.
    const requestText = requestTextForSkillInvocation(text, skillNameForMessage);
    // 승인 대기 중 입력은 언제나 계획 수정 의견이다. '네'/'승인' 같은
    // 텍스트로는 절대 승인되지 않는다 — 승인은 계획 카드의 버튼뿐.
    if (chatWorkflow === 'plan' && planningPhase === 'awaiting-approval') {
      setPlanningPhase('planning');
    }
    const staged = referenceLibrary.takeReadyDrafts();
    const messageAttachments: ThreadAttachment[] = staged.map((file) => ({
      stageId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      status: 'processing',
    }));
    const userMessage = recordUserMessage(messageText,
      messageAttachments,
      undefined,
      skillNameForMessage,
      skillIconForMessage,
    );
    const userBubble = renderUserMessage(userMessage);
    followConversation = true;
    replyPending = true;
    appendConversation(userBubble);
    updateTurnPending(selectedAgent);
    scrollConversationToMessage(userBubble, { smooth: true });
    const messageSent = bridge.sendUserMessage(requestText, skillNameForMessage, staged.map((file) => file.id));
    if (staged.length > 0) {
      attachmentsSending = true;
      updateComposer();
      void messageSent.then((messageId) => {
        if (!messageId) {
          attachmentsSending = false;
          updateComposer();
          return;
        }
        userMessage.messageId = messageId;
        persistCurrentThread();
      });
    } else {
      void messageSent;
    }
    input.value = '';
    setComposerSkill(null);
    setSlashMenuOpen(false);
    input.style.height = 'auto';
  });

  // resizeHandle 을 마지막에 두어 왼쪽 가장자리 히트 테스트를 확실히 가져간다.
  // 토글은 상단 아이콘 도구 모음의 오른쪽 끝에 둔다.
  root.append(stage, resizeHandle);
  document.body.appendChild(root);
  document.getElementById('icon-toolbar')?.appendChild(collapseTab);
  setCollapsed(false, { recenter: false });

  // ── 배치: #editor-area ↔ #status-bar 사이에 맞춘다 ────
  function measure(): void {
    root.classList.toggle('ag-workspace-compact', fullscreen && window.innerWidth <= 960);
    // 전체 화면은 도구 모음·상태바까지 덮는다 — 인라인 배치를 걷어낸다.
    // 접혀 돌아가는 동안(ag-fs-to)에도 전체 화면 기준을 유지한다.
    if (fullscreen || root.classList.contains('ag-fs-to')) {
      root.style.top = '0px';
      root.style.bottom = '0px';
      // 창이 줄면 두 칸의 비율 상한이 내려간다 — 다시 클램프한다.
      applyRailWidth(railWidth, { persist: false });
      applyReviewWidth(reviewWidth, { persist: false });
      return;
    }
    const top = document.getElementById('editor-area')?.getBoundingClientRect().top ?? 96;
    const statusTop =
      document.getElementById('status-bar')?.getBoundingClientRect().top ?? window.innerHeight;
    root.style.top = `${Math.max(0, top)}px`;
    root.style.bottom = `${Math.max(0, window.innerHeight - statusTop)}px`;
    refreshSidebarWidthMin();
    const clamped = clampSidebarWidth(sidebarWidth, sidebarWidthMin);
    if (clamped !== sidebarWidth) {
      applySidebarWidth(clamped, { persist: true, recenter: true });
    }
  }
  window.addEventListener('resize', measure);
  measure();
  void document.fonts?.ready?.then(() => refreshSidebarWidthMin());

  // ── 스레드(채팅 목록) ─────────────────────────────────
  function persistCurrentThread(): void {
    currentThread.agent = selectedAgent;
    currentThread.model = selectedModel;
    currentThread.effort = selectedEffort;
    currentThread.serviceTier = selectedServiceTier;
    currentThread.workflow = chatWorkflow;
    if (activePlan) currentThread.latestPlan = activePlan;
    else delete currentThread.latestPlan;
    if (planHistory.length > 0) currentThread.plans = [...planHistory];
    else delete currentThread.plans;
    if (currentThread.messages.length === 0) {
      removeThread(currentThread.id);
      return;
    }
    if (!currentThread.title || currentThread.title === '새 채팅') {
      currentThread.title = fallbackTitle(currentThread.messages);
    }
    upsertThread(currentThread);
  }

  function recordUserMessage(
    text: string,
    attachments: ThreadAttachment[] = [],
    selection?: { label: string; excerpt: string },
    skillName?: string,
    skillIcon?: ProductSkillIcon,
    delivery?: 'queued-cloud' | 'accepted-cloud',
    messageId?: string,
  ): ThreadMessage {
    const message: ThreadMessage = {
      role: 'user',
      text,
      agent: selectedAgent,
      ...(skillName ? { skillName } : {}),
      ...(skillName && skillIcon ? { skillIcon } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(selection ? { selection } : {}),
      ...(delivery ? { delivery } : {}),
      ...(messageId ? { messageId } : {}),
    };
    currentThread.messages.push(message);
    currentThread.updatedAt = Date.now();
    persistCurrentThread();
    maybeRequestTitle();
    return message;
  }

  function formatAttachmentBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderPlanMessage(message: Extract<ThreadMessage, { kind: 'plan' }>): HTMLElement {
    const button = el('button', 'ag-msg-plan-action');
    button.type = 'button';
    button.dataset.planId = message.planId ?? '';
    const executed = message.planState === 'executed';
    button.classList.toggle('ag-executed', executed);
    button.setAttribute(
      'aria-label',
      `${message.text || '계획'} ${executed ? '완료된 계획' : '계획'} 열기`,
    );

    const icon = el('span', 'ag-msg-plan-icon');
    icon.appendChild(createIcon('changes'));
    const copy = el('span', 'ag-msg-plan-copy');
    copy.append(
      el('span', 'ag-msg-plan-kicker', executed ? '실행 됨' : '계획'),
      el('span', 'ag-msg-plan-title', message.text || '제목 없는 계획'),
    );
    const action = el('span', 'ag-msg-plan-open', '계획 열기');
    action.appendChild(createChevron('ag-msg-plan-chevron'));
    button.append(icon, copy, action);
    button.addEventListener('click', () => openPresentedPlan(message.planId));
    return button;
  }

  function renderUserMessage(message: ThreadMessage): HTMLElement {
    const bubble = el('div', 'ag-msg ag-msg-user');
    if (message.skillName) {
      bubble.classList.add('ag-has-skill');
      const skill = el('span', 'ag-skill-token ag-msg-skill');
      skill.dataset.agent = message.agent ?? currentThread.agent;
      const icon = el('span', 'ag-skill-token-icon');
      icon.appendChild(createIcon(skillGlyphForSkill({ name: message.skillName, icon: message.skillIcon })));
      skill.append(icon, el('span', 'ag-skill-token-name', skillDisplayName(message.skillName)));
      skill.title = `/${message.skillName}`;
      skill.setAttribute('aria-label', `사용한 스킬: ${skillDisplayName(message.skillName)}`);
      bubble.appendChild(skill);
    }
    if (message.selection) {
      const quote = el('div', 'ag-msg-selection');
      quote.title = message.selection.excerpt;
      quote.append(
        el('span', 'ag-msg-selection-label', message.selection.label),
        el('span', 'ag-msg-selection-excerpt', message.selection.excerpt),
      );
      bubble.appendChild(quote);
    }
    if (message.text) bubble.appendChild(el('div', 'ag-msg-user-text', message.text));
    if (message.delivery) {
      bubble.appendChild(el(
        'span',
        `ag-msg-delivery ag-${message.delivery}`,
        message.delivery === 'accepted-cloud' ? '클라우드에 전달됨' : '다음 턴에 전달',
      ));
    }
    if (message.attachments?.length) {
      const row = el('div', 'ag-msg-attachments');
      for (const attachment of message.attachments) {
        const pill = el('button', `ag-msg-attachment ag-${attachment.status}`);
        pill.type = 'button';
        pill.disabled = attachment.status !== 'ready' || !attachment.fileId;
        pill.append(
          createIcon(attachment.mimeType.startsWith('image/') ? 'image' : 'document'),
          el('span', 'ag-msg-attachment-name', attachment.name),
          el('span', 'ag-msg-attachment-meta', attachment.status === 'processing'
            ? '처리 중'
            : attachment.status === 'error'
              ? '실패'
              : attachment.status === 'deleted'
                ? '삭제됨'
                : formatAttachmentBytes(attachment.size)),
        );
        pill.title = attachment.error || attachment.name;
        if (attachment.fileId && attachment.status === 'ready') {
          pill.addEventListener('click', () => { void referenceLibrary.openFile(attachment.fileId!); });
        }
        row.appendChild(pill);
      }
      bubble.appendChild(row);
    }
    return bubble;
  }

  function renderAssistantMessage(bubble: HTMLElement, text: string): void {
    assistantBubbleSources.set(bubble, text);
    renderChatMarkdown(bubble, text);
    const links = Array.from(bubble.querySelectorAll<HTMLAnchorElement>('a.ag-md-link'));
    for (const link of links) {
      const artifact = parsePublishedDocumentLink(link.href);
      if (!artifact) continue;
      const originalLabel = link.textContent?.trim() || '문서 열기';
      link.classList.add('ag-md-artifact-open');
      link.target = '';
      link.title = `${artifact.fileName} 새 창에서 열기`;
      link.setAttribute('aria-label', `${artifact.fileName} 새 창에서 열기`);
      const icon = el('span', 'ag-md-artifact-icon');
      icon.appendChild(createIcon('document'));
      const copy = el('span', 'ag-md-artifact-copy');
      copy.append(
        el('span', 'ag-md-artifact-name', artifact.fileName),
        el('span', 'ag-md-artifact-hint', originalLabel),
      );
      link.replaceChildren(icon, copy, el('span', 'ag-md-artifact-action', '열기'));
      link.addEventListener('click', (event) => {
        event.preventDefault();
        if (link.getAttribute('aria-busy') === 'true') return;
        link.setAttribute('aria-busy', 'true');
        link.classList.remove('ag-failed');
        void openPublishedDocumentInNewWindow(artifact, undefined, { readOnly: artifact.readOnly === true })
          .catch((error) => {
            link.classList.add('ag-failed');
            const message = error instanceof Error ? error.message : String(error);
            showToast({ message: `문서를 열지 못했습니다: ${message}`, durationMs: 5000 });
          })
          .finally(() => link.removeAttribute('aria-busy'));
      });

      const download = document.createElement('a');
      download.className = 'ag-md-artifact-download';
      download.href = artifact.downloadUrl;
      download.target = '_blank';
      download.rel = 'noopener noreferrer';
      download.download = artifact.fileName;
      download.textContent = '다운로드';
      download.title = `${artifact.fileName} 다운로드`;
      const card = el('span', 'ag-md-artifact-card');
      const parent = link.parentElement;
      if (parent) {
        parent.insertBefore(card, link);
        card.append(link, download);
      } else {
        link.insertAdjacentElement('afterend', download);
      }
    }
  }

  function flushPendingAssistantRender(): void {
    if (assistantRenderFrame !== null) {
      window.cancelAnimationFrame(assistantRenderFrame);
      assistantRenderFrame = null;
    }
    const bubble = pendingAssistantBubble;
    pendingAssistantBubble = null;
    if (!bubble) return;
    renderAssistantMessage(bubble, assistantBubbleSources.get(bubble) ?? '');
  }

  function scheduleAssistantRender(bubble: HTMLElement, text: string): void {
    assistantBubbleSources.set(bubble, text);
    pendingAssistantBubble = bubble;
    if (assistantRenderFrame !== null) return;
    assistantRenderFrame = window.requestAnimationFrame(() => {
      assistantRenderFrame = null;
      const pending = pendingAssistantBubble;
      pendingAssistantBubble = null;
      if (pending) renderAssistantMessage(pending, assistantBubbleSources.get(pending) ?? '');
    });
  }

  function cancelPendingAssistantRender(): void {
    if (assistantRenderFrame !== null) window.cancelAnimationFrame(assistantRenderFrame);
    assistantRenderFrame = null;
    pendingAssistantBubble = null;
  }

  function flushAssistantBuffer(opts?: { persist?: boolean; kind?: 'progress' }): void {
    const text = assistantBuffer;
    assistantBuffer = '';
    if (!text.trim()) return;
    if (opts?.persist === false) return;
    currentThread.messages.push({
      role: 'assistant',
      text,
      agent: selectedAgent,
      ...(opts?.kind ? { kind: opts.kind } : {}),
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
      .map((m) => {
        const text = m.role === 'user' && m.skillName
          ? `/${m.skillName}${m.text ? ` ${m.text}` : ''}`
          : m.text;
        return `${m.role === 'user' ? '사용자' : '어시스턴트'}: ${text}`;
      })
      .join('\n')
      .slice(0, 800);
    bridge.requestTitle(currentThread.id, preview);
  }

  function renderStoredTool(tool: ThreadToolRecord, agent: AgentName): HTMLElement {
    const row = el('div', `ag-tool-row ag-${agent}`);
    const head = el('button', 'ag-tool-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    const status = el('span', `ag-tool-status ${tool.status === 'completed' ? 'ag-ok' : 'ag-err'}`);
    status.appendChild(createIcon(tool.status === 'completed' ? 'check' : 'close'));
    const name = el('span', 'ag-tool-name', tool.tool);
    const summary = el('span', 'ag-tool-summary', truncate(tool.argsJson, 60));
    const elapsed = el('span', 'ag-tool-elapsed', tool.elapsedMs === null ? '' : `${tool.elapsedMs}ms`);
    head.append(status, name, summary, elapsed, createChevron('ag-tool-chevron'));
    const body = el('div', 'ag-tool-body');
    body.hidden = true;
    body.append(
      el('pre', 'ag-tool-args', prettyJson(tool.argsJson)),
      el('pre', 'ag-tool-result', tool.resultPreview),
    );
    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      row.classList.toggle('ag-tool-open', !body.hidden);
      head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    });
    row.append(head, body);
    return row;
  }

  function renderStoredActivity(message: ThreadActivityMessage, agent: AgentName): HTMLElement {
    const step = el('div', 'ag-progress-step ag-progress-step-tools-only');
    const activity = el('div', `ag-activity ag-${agent} ag-activity-collapsed ag-activity-${message.status}`);
    const toggle = el('button', 'ag-activity-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const failures = message.tools.filter((tool) => tool.status === 'failed').length;
    toggle.append(
      el('span', 'ag-activity-label', failures > 0
        ? `도구 호출 · ${failures}개 오류`
        : `도구 호출 · ${message.tools.length}개 완료`),
      createChevron('ag-activity-chevron'),
    );
    const collapse = el('div', 'ag-activity-collapse');
    const content = el('div', 'ag-activity-content');
    content.tabIndex = -1;
    for (const tool of message.tools) content.appendChild(renderStoredTool(tool, agent));
    collapse.appendChild(content);
    activity.append(toggle, collapse);
    toggle.addEventListener('click', () => {
      const collapsed = activity.classList.toggle('ag-activity-collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      content.tabIndex = collapsed ? -1 : 0;
    });
    step.appendChild(activity);
    return step;
  }

  function renderStoredTasks(message: ThreadTasksMessage, agent: AgentName): HTMLElement {
    const group = el('section', `ag-restored-task-group ag-${agent}`);
    const heading = el('button', 'ag-restored-task-heading');
    heading.type = 'button';
    heading.setAttribute('aria-expanded', 'false');
    const failed = message.tasks.filter((task) => task.status === 'failed').length;
    heading.append(
      createIcon(failed > 0 ? 'close' : 'check'),
      el('span', '', failed > 0
        ? `서브에이전트와 워크플로 · ${failed}개 오류`
        : `서브에이전트와 워크플로 · ${message.tasks.length}개`),
      createChevron('ag-restored-task-chevron'),
    );
    const body = el('div', 'ag-restored-task-body');
    body.hidden = true;
    for (const task of message.tasks) {
      const item = el('article', `ag-restored-task ag-${task.status}`);
      const title = task.workflowName || task.title;
      const meta = [
        task.status === 'completed' ? '완료' : task.status === 'failed' ? '실패' : '중단됨',
        task.totalTokens === null ? '' : `${task.totalTokens.toLocaleString()} tokens`,
      ].filter(Boolean).join(' · ');
      item.append(
        el('strong', 'ag-restored-task-title', title),
        el('span', 'ag-restored-task-meta', meta),
        el('p', 'ag-restored-task-summary', task.summary || task.activity || '기록된 요약 없음'),
      );
      if (task.tools.length > 0) {
        const tools = el('div', 'ag-restored-task-tools');
        for (const tool of task.tools) tools.appendChild(renderStoredTool(tool, agent));
        item.appendChild(tools);
      }
      body.appendChild(item);
    }
    heading.addEventListener('click', () => {
      body.hidden = !body.hidden;
      heading.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    });
    group.append(heading, body);
    return group;
  }

  function renderMessagesFromThread(thread: ChatThread): void {
    cancelPendingAssistantRender();
    resetConversation();
    streamBubble = null;
    turnActivity = null;
    followConversation = true;
    assistantBuffer = '';
    toolRows.clear();
    activityTranscript = null;
    activityTranscripts.clear();
    transcriptTools.clear();
    tasksTranscript = null;
    transcriptTasks.clear();
    taskToolRecords.clear();
    taskTextBuffers.clear();
    for (const msg of thread.messages) {
      if (msg.role === 'user') {
        appendConversation(renderUserMessage(msg));
      } else if (msg.role === 'assistant') {
        const agent = msg.agent ?? thread.agent;
        if (msg.kind === 'progress') {
          const step = el('div', 'ag-progress-step ag-progress-step-restored');
          const milestone = el('div', `ag-msg ag-progress-milestone ag-${agent}`);
          renderAssistantMessage(milestone, msg.text);
          step.appendChild(milestone);
          appendConversation(step);
        } else if (msg.kind === 'plan') {
          appendConversation(renderPlanMessage(msg));
        } else if (msg.kind === 'activity') {
          appendConversation(renderStoredActivity(msg, agent));
        } else if (msg.kind === 'tasks') {
          appendConversation(renderStoredTasks(msg, agent));
        } else {
          const bubble = el('div', `ag-msg ag-msg-assistant ag-${agent}`);
          renderAssistantMessage(bubble, msg.text);
          appendConversation(bubble);
        }
      } else {
        appendConversation(el('div', 'ag-msg ag-msg-system', msg.text));
      }
    }
    scrollConversationToEnd();
  }

  function clearChatUi(): void {
    cancelPendingAssistantRender();
    resetConversation();
    streamBubble = null;
    turnActivity = null;
    followConversation = true;
    assistantBuffer = '';
    sweepUnresolvedToolRows();
  }

  function applyThreadMeta(thread: ChatThread): void {
    selectedModel = resolveModelForAgent(thread.agent, thread.model);
    selectedEffort = resolveEffortForAgent(thread.agent, thread.effort, selectedModel);
    selectedServiceTier = resolveServiceTier(thread.agent, thread.serviceTier);
    setSelectedAgent(thread.agent);
    rebuildLlmMenu();
    rebuildEffortMenu();
    updateWorkspaceAgentContext();
    activeTemplate = templateCatalog.templates.find((template) => template.id === thread.activeTemplateId) ?? null;
    if (thread.activeTemplateId && templateCatalog.revision > 0 && !activeTemplate) {
      thread.activeTemplateId = null;
      upsertThread(thread);
    }
    renderActiveTemplate();
    bridge.setActiveTemplate(activeTemplate?.id ?? thread.activeTemplateId);
  }

  /** 목록 행의 계기 표시 — 에이전트 · 날짜 시각 · 메시지 수. 자릿수를 맞춘다. */
  function formatRelativeAge(ts: number): string {
    const diff = Date.now() - ts;
    const minute = 60_000;
    const hour = 3_600_000;
    const day = 86_400_000;
    if (diff < minute) return '방금';
    if (diff < hour) return `${Math.floor(diff / minute)}분 전`;
    if (diff < day) return `${Math.floor(diff / hour)}시간 전`;
    if (diff < day * 7) return `${Math.floor(diff / day)}일 전`;
    if (diff < day * 30) return `${Math.floor(diff / (day * 7))}주 전`;
    return `${Math.floor(diff / (day * 30))}개월 전`;
  }

  /* 전체 화면 레일 전용 hover 카드 — 행은 제목만 남기고 문서·에이전트·시각은
     여기서 보여준다. 사이드바 패널에서는 뜨지 않는다(fullscreen 게이트).
     행 사이를 훑을 때는 카드를 없앴다 다시 만들지 않고 내용만 갈아끼운 채
     위치를 CSS transition 으로 미끄러뜨린다. */
  let threadPopover: HTMLElement | null = null;
  let threadPopoverTimer: number | null = null;
  let threadPopoverHideTimer: number | null = null;
  /** 방금 펼친 그룹 — 이 그룹의 행만 한 번 계단식으로 들어온다. */
  let threadsCascadeKey: string | null = null;

  function clearThreadPopoverTimers(): void {
    if (threadPopoverTimer !== null) {
      window.clearTimeout(threadPopoverTimer);
      threadPopoverTimer = null;
    }
    if (threadPopoverHideTimer !== null) {
      window.clearTimeout(threadPopoverHideTimer);
      threadPopoverHideTimer = null;
    }
  }

  function hideThreadPopover(): void {
    clearThreadPopoverTimers();
    threadPopover?.remove();
    threadPopover = null;
  }

  /** 행을 떠날 때는 잠깐 기다린다 — 옆 행으로 옮겨 가는 중이면 카드가 살아남는다. */
  function scheduleHideThreadPopover(): void {
    clearThreadPopoverTimers();
    threadPopoverHideTimer = window.setTimeout(() => {
      threadPopoverHideTimer = null;
      hideThreadPopover();
    }, 120);
  }

  function scheduleThreadPopover(thread: ChatThread, row: HTMLElement): void {
    if (!fullscreen) return;
    clearThreadPopoverTimers();
    // 이미 떠 있으면 거의 즉시 옮겨 가고, 처음엔 잠깐 뜸을 들인다.
    const delay = threadPopover ? 60 : 320;
    threadPopoverTimer = window.setTimeout(() => {
      threadPopoverTimer = null;
      showThreadPopover(thread, row);
    }, delay);
  }

  function showThreadPopover(thread: ChatThread, row: HTMLElement): void {
    if (!fullscreen || !row.isConnected) return;
    const head = el('div', 'ag-thread-popover-head');
    head.append(
      el('span', 'ag-thread-popover-title', thread.title || '새 채팅'),
      el('span', 'ag-thread-popover-age', formatRelativeAge(thread.updatedAt)),
    );
    const docRow = el('div', 'ag-thread-popover-row');
    docRow.append(
      createIcon('document'),
      el('span', 'ag-thread-popover-text', docGroupLabel(thread.docKey)),
    );
    const agentRow = el('div', 'ag-thread-popover-row');
    agentRow.append(
      createProviderIcon(thread.agent),
      el(
        'span',
        'ag-thread-popover-text',
        `${AGENT_LABEL[thread.agent]} · ${labelForModel(thread.agent, thread.model)}`,
      ),
    );

    const fresh = threadPopover === null;
    const card = threadPopover ?? el('div', 'ag-thread-popover');
    card.replaceChildren(head, docRow, agentRow);
    if (fresh) {
      card.setAttribute('aria-hidden', 'true');
      root.appendChild(card);
      threadPopover = card;
    }

    const rect = row.getBoundingClientRect();
    const size = card.getBoundingClientRect();
    const left = Math.min(rect.right + 10, window.innerWidth - size.width - 8);
    const top = Math.max(8, Math.min(rect.top - 4, window.innerHeight - size.height - 8));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  /**
   * 이름 바꾸기 — 행 자리에서 바로 편집한다. Enter 확정 / Esc 취소 /
   * 포커스 이탈 시 확정. 확정된 이름은 고정되어 자동 제목이 덮지 않는다.
   */
  function beginThreadRename(thread: ChatThread, row: HTMLElement): void {
    const form = el('form', 'ag-thread-rename-form');
    const field = el('input', 'ag-thread-rename-input') as HTMLInputElement;
    field.type = 'text';
    field.value = thread.title || '';
    field.maxLength = 48;
    field.setAttribute('aria-label', '채팅 이름');
    form.appendChild(field);

    let settled = false;
    const commit = (): void => {
      if (settled) return;
      settled = true;
      const next = renameThread(thread.id, field.value);
      if (next && thread.id === currentThread.id) {
        currentThread.title = next.title;
        currentThread.titlePinned = true;
      }
      rebuildThreadsList();
    };
    const cancel = (): void => {
      if (settled) return;
      settled = true;
      rebuildThreadsList();
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      commit();
    });
    field.addEventListener('blur', commit);
    field.addEventListener('keydown', (e) => {
      // Esc 는 패널 전체를 닫는 핸들러가 위에 있다 — 여기서 멈춘다.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    });

    row.replaceChildren(form);
    field.focus();
    field.select();
  }

  function docGroupLabel(docKey: string | null): string {
    return docKey ?? '문서 없음';
  }

  /**
   * 문서 보관 — 문서 파일은 남기고 그 문서의 채팅 기록을 모두 지운다.
   * 지금 열려 있는 채팅이 그 문서 소속이면 먼저 새 채팅으로 빠져나온다.
   */
  function archiveDocumentGroup(group: DocumentThreadGroup): void {
    if (!window.confirm('문서는 보존되지만 채팅 기록은 모두 삭제됩니다. 진행하시겠어요?')) return;
    const currentInGroup = group.documentId
      ? currentThread.documentId === group.documentId
      : !currentThread.documentId && (currentThread.docKey ?? '') === (group.docKey ?? '');
    // startNewChat 이 현재 채팅을 저장하므로, 삭제는 빠져나온 뒤에 한다.
    if (currentInGroup) startNewChat({ silent: true });
    const removed = forgetDocumentThreads(group.documentId, group.docKey);
    for (const id of removed) {
      planArchives.delete(id);
      threadWorkflows.delete(id);
      clearChatStatus(id);
    }
    docGroupToggles.delete(group.documentId ?? group.docKey ?? '');
    rebuildThreadsList();
  }

  /** 실행 상태 점 — 노란 불(작업 중)·초록 점(완료)·빨간 점(승인 대기). */
  function buildStatusDot(status: ChatRunStatus, extraClass?: string): HTMLElement {
    const dot = el('span', `ag-thread-status ag-thread-status-${status}${extraClass ? ` ${extraClass}` : ''}`);
    dot.title = status === 'working' ? '작업 중' : status === 'needs-input' ? '승인 대기' : '완료';
    return dot;
  }

  function buildThreadRow(thread: ChatThread): HTMLElement {
    const li = el('li', 'ag-threads-row');
    if (thread.id === currentThread.id) li.classList.add('ag-current');

    const btn = el('button', 'ag-threads-item');
    btn.type = 'button';
    if (thread.id === currentThread.id) btn.classList.add('ag-active');
    // 상태 점은 제목 들여쓰기 여백에 겹쳐 앉는다 — 행 배치는 그대로다.
    const status = getChatStatus(thread.id);
    if (status) btn.appendChild(buildStatusDot(status, 'ag-row-status'));
    btn.appendChild(el('span', 'ag-threads-item-title', thread.title || '새 채팅'));
    // 두 번 누르기로는 열지 않는다 — 첫 클릭이 이미 대화를 열어버리므로
    // 이름 바꾸기는 연필 버튼 하나로만 들어간다.
    btn.addEventListener('click', () => openThread(thread.id));
    btn.addEventListener('mouseenter', () => scheduleThreadPopover(thread, li));
    btn.addEventListener('mouseleave', scheduleHideThreadPopover);

    const rename = el('button', 'ag-thread-rename');
    rename.type = 'button';
    rename.setAttribute('aria-label', `${thread.title || '새 채팅'} 이름 바꾸기`);
    rename.title = '이름 바꾸기';
    rename.appendChild(createIcon('format'));
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      beginThreadRename(thread, li);
    });

    li.append(btn, rename);
    return li;
  }

  /**
   * 문서별 그룹 목록 — 현재 문서 그룹이 맨 위에 펼쳐져 있고,
   * 다른 문서 그룹은 접힌 채로 최근 활동순으로 이어진다.
   * 그룹 이름 더블클릭·우클릭 → "이동"·"문서 보관" 메뉴.
   */
  function rebuildThreadsList(): void {
    hideThreadPopover();
    threadsList.replaceChildren();
    const groups = listThreadsByDocument();
    if (groups.length === 0) {
      threadsList.appendChild(el('li', 'ag-threads-empty', '이전 채팅이 없습니다'));
      return;
    }
    const currentIdx = groups.findIndex((group) => (
      explorerGroupIsCurrent(group, currentDocumentId, currentDocKey, groups)
    ));
    if (currentIdx > 0) groups.unshift(groups.splice(currentIdx, 1)[0]!);

    for (const group of groups) {
      const toggleKey = group.documentId ?? group.docKey ?? '';
      const isCurrentDoc = explorerGroupIsCurrent(group, currentDocumentId, currentDocKey, groups);
      const expanded = docGroupToggles.get(toggleKey) ?? isCurrentDoc;
      const canMove = Boolean(group.documentId || group.docKey);

      const groupLi = el('li', 'ag-threads-group');
      if (isCurrentDoc) groupLi.classList.add('ag-current-doc');
      const groupBtn = el('button', 'ag-threads-group-btn');
      groupBtn.type = 'button';
      groupBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (canMove) groupBtn.dataset.libraryDoc = 'true';
      if (canMove) groupBtn.setAttribute('aria-haspopup', 'menu');
      const paper = createIcon('document', 'ag-threads-group-icon');
      const name = el('span', 'ag-threads-group-name', docGroupLabel(group.docKey));
      name.title = docGroupLabel(group.docKey);
      groupBtn.append(paper, name);
      if (isCurrentDoc) groupBtn.append(el('span', 'ag-threads-group-badge', '현재'));
      // 접힌 그룹은 안쪽 행이 안 보이므로 상태를 그룹 줄로 끌어올린다.
      // 사용자를 기다리는 빨강이 먼저, 그다음 작업 중, 마지막이 완료다.
      if (!expanded) {
        const statuses = group.threads.map((thread) => getChatStatus(thread.id));
        const rollup = statuses.includes('needs-input')
          ? 'needs-input' as const
          : statuses.includes('working')
            ? 'working' as const
            : statuses.includes('finished') ? 'finished' as const : null;
        if (rollup) groupBtn.append(buildStatusDot(rollup, 'ag-group-status'));
      }
      const toggleGroup = (): void => {
        docGroupToggles.set(toggleKey, !expanded);
        // 펼칠 때만 행이 차례로 미끄러져 들어온다 — 접을 때는 즉시.
        threadsCascadeKey = expanded ? null : toggleKey;
        rebuildThreadsList();
      };
      const openGroupMenu = (x: number, y: number): void => {
        showActionMenu(x, y, [{
          label: '이동',
          disabled: isCurrentDoc,
          title: isCurrentDoc ? '이미 이 문서를 보고 있습니다' : '현재 문서를 저장하고 이 문서로 이동합니다',
          onSelect: () => {
            persistCurrentThread();
            moveToLibraryDocument?.({
              documentId: group.documentId,
              fileName: group.docKey,
            });
          },
        }, {
          label: '문서 보관',
          title: '이 문서의 채팅 기록을 모두 삭제합니다',
          onSelect: () => archiveDocumentGroup(group),
        }]);
      };
      if (canMove) {
        // 더블클릭 → 메뉴. 목록이 클릭마다 다시 그려져 dblclick 이벤트가
        // 원래 버튼에 닿지 못하므로, 접기/펼치기를 판정 시간만큼 미뤄 두고
        // 그 안에 두 번째 클릭이 오면 토글 대신 메뉴를 연다.
        let pendingToggle: number | null = null;
        groupBtn.addEventListener('click', (event) => {
          if (event.detail === 0) {
            // 키보드(Enter/Space) 활성화는 지연 없이 바로 토글한다.
            toggleGroup();
            return;
          }
          if (pendingToggle !== null) {
            clearTimeout(pendingToggle);
            pendingToggle = null;
            openGroupMenu(event.clientX, event.clientY);
            return;
          }
          pendingToggle = window.setTimeout(() => {
            pendingToggle = null;
            toggleGroup();
          }, 250);
        });
        groupBtn.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openGroupMenu(event.clientX, event.clientY);
        });
      } else {
        groupBtn.addEventListener('click', toggleGroup);
      }
      groupLi.appendChild(groupBtn);
      // 문서로 건너뛰기 — 연필과 같은 문법으로 오른쪽에 겹쳐 hover 에서 드러난다.
      // 지금 보고 있는 문서에는 필요 없으니 아예 만들지 않는다.
      if (canMove && !isCurrentDoc) {
        groupLi.classList.add('ag-has-jump');
        const jump = el('button', 'ag-doc-jump');
        jump.type = 'button';
        jump.setAttribute('aria-label', `${docGroupLabel(group.docKey)} 문서로 이동`);
        jump.title = '현재 문서를 저장하고 이 문서로 이동합니다';
        jump.appendChild(createIcon('external'));
        jump.addEventListener('click', (e) => {
          e.stopPropagation();
          persistCurrentThread();
          moveToLibraryDocument?.({
            documentId: group.documentId,
            fileName: group.docKey,
          });
        });
        groupLi.appendChild(jump);
      }
      threadsList.appendChild(groupLi);

      if (!expanded) continue;
      const cascade = threadsCascadeKey === toggleKey;
      group.threads.forEach((thread, i) => {
        const row = buildThreadRow(thread);
        if (!isCurrentDoc) row.classList.add('ag-foreign');
        if (cascade) {
          row.classList.add('ag-row-enter');
          row.style.animationDelay = `${Math.min(i, 8) * 22}ms`;
        }
        threadsList.appendChild(row);
      });
    }
    threadsCascadeKey = null;
  }

  function setThreadsPanelOpen(open: boolean): void {
    // 전체 화면에서 스레드는 넘겨 보는 페이지가 아니라 상시 레일이다.
    // 목록만 갱신하고 페이지 전환은 하지 않는다.
    if (fullscreen) {
      rebuildThreadsList();
      return;
    }
    if (open && settingsPanelOpen && settingsPanel.isDirty()) {
      void requestSettingsClose(undefined, () => setThreadsPanelOpen(true));
      return;
    }
    if (open && referenceLibrary.isOpen()) referenceLibrary.setOpen(false);
    threadsPanelOpen = open;
    if (open) setConfigPanelOpen(false);
    if (open) skillsPanelOpen = false;
    closeSettingsPage();
    closeVersionsPage();
    root.classList.toggle('ag-threads-open', open);
    root.classList.remove('ag-skills-open');
    threadsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    skillsBtn.setAttribute('aria-expanded', 'false');
    threadsPage.setAttribute('aria-hidden', open ? 'false' : 'true');
    skillsPage.setAttribute('aria-hidden', 'true');
    chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
    if (open) {
      rebuildThreadsList();
      threadsNew.focus();
    }
  }

  /** 저장된 기본값을 지금 선택으로 세운다 (새 대화 진입점에서만 부른다). */
  function applyDefaultSelection(): void {
    const nextAgent = agentPrefs.defaultAgent;
    const nextModel = resolveModelForAgent(nextAgent, agentPrefs.defaultModel);
    const nextEffort = resolveEffortForAgent(nextAgent, agentPrefs.defaultEffort, nextModel);
    selectedModel = nextModel;
    selectedEffort = nextEffort;
    selectedServiceTier = resolveServiceTier(nextAgent, null);
    setSelectedAgent(nextAgent);
    rebuildLlmMenu();
    rebuildEffortMenu();
    permissionProfile = agentPrefs.defaultPermissionProfile;
    updatePermissionButton();
  }

  /** 다른 문서의 채팅을 열람만 한다 — 입력 잠금은 updateComposer 가 관리한다. */
  function enterReadOnlyMode(docLabel: string): void {
    readOnlyDocLabel = docLabel;
    input.value = '';
    setComposerSkill(null);
    composer.classList.add('ag-readonly');
    const note = el('div', 'ag-msg ag-msg-system ag-readonly-note',
      `"${docLabel}" 문서의 채팅입니다. 그 문서를 연 뒤 이 채팅을 다시 선택하면 이어서 대화할 수 있습니다.`);
    appendConversation(note);
    scrollConversationToEnd();
    updateComposer();
  }

  function exitReadOnlyMode(): void {
    if (readOnlyDocLabel === null) return;
    readOnlyDocLabel = null;
    composer.classList.remove('ag-readonly');
    messages.querySelectorAll('.ag-readonly-note').forEach((n) => n.remove());
    updateComposer();
  }

  function startNewChat(opts?: { silent?: boolean }): void {
    if (cloudUi.isCloudConversation()) {
      systemMessage('클라우드 작업을 이어받거나 결과를 정리한 뒤 새 채팅을 시작하세요.');
      return;
    }
    setComposerSkill(null);
    if (turnRunning) bridge.interrupt();
    flushAssistantBuffer();
    const previousThreadId = currentThread.id;
    const previousThreadWasEmpty = currentThread.messages.length === 0;
    persistCurrentThread();
    clearChatUi();
    exitReadOnlyMode();
    // 새 대화는 개인 기본값으로 열린다 — 이전 대화의 임시 선택을 물려받지 않는다.
    applyDefaultSelection();
    const nextThread = createEmptyThread({
      agent: selectedAgent,
      model: selectedModel,
      effort: selectedEffort,
      serviceTier: selectedServiceTier,
      docKey: currentDocKey,
      documentId: currentDocumentId,
    });
    // 새 채팅은 언제나 '바로 실행'에서 시작하고, 원격 브라우저 경고도 다시 받는다.
    restorePlanningForThread(nextThread.id, nextThread);
    if (previousThreadWasEmpty) {
      planArchives.delete(previousThreadId);
      threadWorkflows.delete(previousThreadId);
    }
    currentThread = nextThread;
    cloudUi.refreshScope();
    selectTemplate(null);
    referenceLibrary.contextChanged();
    bridge.stopChat();
    startCurrentBridgeChat(true);
    if (opts?.silent) return;
    setThreadsPanelOpen(false);
    input.focus();
  }

  function openThread(id: string): void {
    // 채팅을 열어 보면 완료 점은 걷힌다. 다른 탭에서 아직 일하는 채팅의
    // 노란 불은 그 탭의 것이므로 여기서 지우지 않는다.
    if (getChatStatus(id) === 'finished') clearChatStatus(id);
    if (id === currentThread.id) {
      setThreadsPanelOpen(false);
      return;
    }
    if (cloudUi.isCloudConversation()) {
      systemMessage('클라우드 작업을 이어받거나 결과를 정리한 뒤 다른 채팅을 여세요.');
      return;
    }
    if (turnRunning) bridge.interrupt();
    flushAssistantBuffer();
    persistCurrentThread();
    const loaded = getThread(id);
    if (!loaded) return;
    setComposerSkill(null);
    threadWorkflows.set(id, loaded.workflow);
    planArchives.set(id, loaded.plans?.length
      ? loaded.plans
      : (loaded.latestPlan ? [loaded.latestPlan] : []));
    restorePlanningForThread(id, loaded);
    currentThread = {
      ...loaded,
      messages: loaded.messages.map((m) => ({ ...m })),
      titleRequested: Boolean(loaded.titleRequested),
    };
    cloudUi.refreshScope();
    referenceLibrary.contextChanged();
    bridge.stopChat();
    applyThreadMeta(currentThread);
    renderMessagesFromThread(currentThread);
    const matchesCurrentDocument = threadMatchesDocument(
      loaded,
      currentDocumentId,
      currentDocKey,
    );
    if (!matchesCurrentDocument) {
      // 다른 문서의 채팅 — 열람은 되지만 이어가지는 못한다.
      enterReadOnlyMode(docGroupLabel(loaded.docKey));
      setThreadsPanelOpen(false);
      return;
    }
    // 파일명만 있던 레거시 채팅은 여기서 안정 ID를 얻는다. ID로 맞은 채팅도
    // 그룹이 갈라지지 않게 "다른 이름으로 저장" 개명을 따라간다.
    currentThread.documentId = currentDocumentId ?? currentThread.documentId;
    currentThread.docKey = currentDocKey ?? currentThread.docKey;
    persistCurrentThread();
    exitReadOnlyMode();
    startCurrentBridgeChat(true);
    setThreadsPanelOpen(false);
    input.focus();
  }

  threadsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // 전체 화면에서는 페이지 전환이 아니라 레일 접기 토글이다.
    if (fullscreen) {
      setThreadsRailCollapsed(!threadsRailCollapsed);
      return;
    }
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
    const agentChanged = agent !== selectedAgent;
    selectedAgent = agent;
    root.dataset.agent = agent;
    providerName.textContent = AGENT_LABEL[agent];
    if (agentChanged) {
      const nextIcon = createProviderIcon(agent);
      providerIcon.replaceWith(nextIcon);
      providerIcon = nextIcon;
    }
    for (const [name, item] of providerItems) {
      const active = name === agent;
      item.classList.toggle('ag-active', active);
      item.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    syncProviderMenu();
    if (activeComposerSkill) composerSkill.dataset.agent = agent;
    updateWorkspaceAgentContext();
  }

  function setConnection(
    state: ConnectionState,
    meta?: { attempt?: number; retryInMs?: number },
  ): void {
    connState = state;
    if (typeof meta?.attempt === 'number') connAttempt = meta.attempt;
    if (state === 'connected') connAttempt = 0;
    connRetryAt = typeof meta?.retryInMs === 'number' ? Date.now() + meta.retryInMs : null;
    const visual = state === 'disconnected' ? 'connecting' : state;
    conn.className = `ag-conn ag-conn-${visual}`;
    conn.textContent = state === 'connected' || state === 'replaced'
      ? CONN_LABEL[state]
      : '연결 중…';
    takeoverBtn.hidden = state !== 'replaced';
    if (state === 'replaced') setConfigPanelOpen(false);
    renderConnBanner();
    referenceLibrary.setConnectionState(state);
    updateComposer();
  }

  function clearConnCountdown(): void {
    if (connCountdownTimer === null) return;
    window.clearInterval(connCountdownTimer);
    connCountdownTimer = null;
  }

  /** "n초 후 재시도" 를 1초마다 갱신한다. 남은 시간은 예약된 백오프에서 온다. */
  function paintConnCountdown(): void {
    const remainMs = connRetryAt === null ? null : Math.max(0, connRetryAt - Date.now());
    connBannerText.textContent = remainMs === null
      ? '에이전트에 연결하는 중이에요'
      : `에이전트에 연결하는 중이에요 · ${Math.ceil(remainMs / 1000)}초 후 다시 시도`;
  }

  function renderConnBanner(): void {
    // 연결돼 있거나 다른 탭이 쓰는 중이면(전용 takeover 버튼이 있다) 배너는 없다.
    if (connState === 'connected' || connState === 'replaced') {
      clearConnCountdown();
      connBanner.hidden = true;
      return;
    }
    if (connState === 'connecting') {
      clearConnCountdown();
      // 첫 시도가 진행 중일 때는 조용히 지나간다.
      if (connAttempt === 0) {
        connBanner.hidden = true;
        return;
      }
      connBanner.hidden = false;
      connBanner.classList.toggle('ag-conn-banner-wait', connAttempt < 4);
      connBannerText.textContent = `연결하는 중… (${connAttempt}번째 시도)`;
      connBannerRetry.hidden = false;
      connBannerHint.hidden = managedHub || connAttempt < 6;
      return;
    }
    connBanner.hidden = false;
    connBanner.classList.toggle('ag-conn-banner-wait', connAttempt < 4);
    connBannerRetry.hidden = false;
    connBannerHint.hidden = managedHub || connAttempt < 6;
    paintConnCountdown();
    clearConnCountdown();
    if (connRetryAt !== null) {
      connCountdownTimer = window.setInterval(paintConnCountdown, 1000);
    }
  }

  function setTurnRunning(running: boolean): void {
    turnRunning = running;
    if (!running) replyPending = false;
    updateTurnPending();
    updateComposer();
    rebuildReview();
  }

  /** 턴이 정상 종료 경로 없이 꺼졌을 때(중단·재연결·오류) 노란 불을 걷는다. */
  function dropRunStatusIfIdle(): void {
    if (turnRunning || runStatusThreadId === null) return;
    clearChatStatus(runStatusThreadId);
    runStatusThreadId = null;
  }

  /** 계획에 응답이 닿았다(승인·수정 요청·무효화) — 빨간 점을 걷는다. */
  function settlePlanAttention(): void {
    if (getChatStatus(currentThread.id) === 'needs-input') clearChatStatus(currentThread.id);
  }

  function updateComposer(): void {
    // 다른 문서의 채팅 열람 중에는 연결/작업 상태와 무관하게 잠긴다.
    const cloudConversation = cloudUi.isCloudConversation();
    if (mergeResolverLocked) {
      input.disabled = true;
      send.disabled = true;
      composerSkillClear.disabled = true;
      input.placeholder = '병합 검토 중에는 에이전트 작업을 시작할 수 없습니다';
    } else if (readOnlyDocLabel !== null) {
      input.disabled = true;
      send.disabled = true;
      composerSkillClear.disabled = true;
      input.placeholder = `"${readOnlyDocLabel}" 문서의 채팅 — 읽기 전용`;
    } else if (cloudConversation) {
      const acceptsQueuedMessage = cloudUi.isRunning();
      input.disabled = !acceptsQueuedMessage;
      send.disabled = !acceptsQueuedMessage;
      composerSkillClear.disabled = true;
      input.placeholder = acceptsQueuedMessage
        ? '다음 클라우드 턴에 전달할 메시지'
        : '클라우드 상태에서 이어받거나 결과를 확인하세요';
    } else if (selectedAgent === 'rau' && !rauSetupComplete) {
      input.disabled = true;
      send.disabled = true;
      composerSkillClear.disabled = true;
      input.placeholder = 'Rau 연결을 먼저 완료해 주세요.';
    } else if (selectedAgent === 'rau' && rauCreditsEmpty()) {
      input.disabled = connState !== 'connected';
      send.disabled = true;
      composerSkillClear.disabled = input.disabled;
      input.placeholder = '체험 크레딧이 다 됐어요. 다른 모델을 연결해 주세요.';
    } else {
      const chatStarting = chatStartPendingThreadId !== null;
      input.disabled = connState !== 'connected' || attachmentsSending || chatStarting;
      send.disabled = connState !== 'connected' || attachmentsSending || chatStarting || referenceLibrary.hasBlockingDrafts();
      composerSkillClear.disabled = input.disabled;
      input.placeholder = chatStarting
        ? '채팅을 여는 중…'
        : activeComposerSkill
          ? '추가 요청을 입력하세요 (선택)'
        : chatWorkflow === 'plan' && planningPhase === 'awaiting-approval'
          ? '계획에서 바꿀 부분을 알려주세요'
          : chatWorkflow === 'question'
            ? '질문을 입력하세요'
          : chatWorkflow === 'plan' && planningPhase === 'planning'
            ? '구상할 내용을 입력하세요'
            : '문서 작업을 입력하세요';
    }
    const sendLabel = turnRunning ? '중지' : '보내기';
    if (send.getAttribute('aria-label') !== sendLabel) {
      send.replaceChildren(turnRunning ? createStopIcon() : createIcon('send'));
      send.setAttribute('aria-label', sendLabel);
      send.title = sendLabel;
    }
    send.classList.toggle('ag-stop', turnRunning);
    // 실행 중에는 Enter 가 전송이 아니므로 힌트를 숨긴다.
    sendHint.hidden = turnRunning || attachmentsSending || chatStartPendingThreadId !== null
      || referenceLibrary.hasBlockingDrafts()
      || (!cloudUi.isRunning() && connState !== 'connected')
      || readOnlyDocLabel !== null
      || (cloudConversation && !cloudUi.isRunning());
    // 실행 중이거나 작업 방식/계획→실행 전환 중에는 모드·모델·권한을 잠근다.
    const controlsLocked = isControlLocked();
    providerTrigger.disabled = controlsLocked;
    llmTrigger.disabled = controlsLocked;
    effortTrigger.disabled = controlsLocked;
    effortSlider.setDisabled(controlsLocked);
    permissionBtn.disabled = controlsLocked || connState !== 'connected';
    // 턴 실행·첨부·모드 전환 중에는 설정 패널을 접는다. 모델/추론 강도를 바꾸는
    // 순간 채팅을 다시 여는 잠금(chatStartPending)은 패널을 유지한다 — 바깥을
    // 누르기 전까지는 그대로 두고 이어서 고를 수 있게.
    if (controlsLocked && chatStartPendingThreadId === null) setConfigPanelOpen(false);
    updateWorkflowControl();
  }

  function conversationTail(): HTMLElement {
    return !turnPending.hidden && turnPending.parentElement === messages
      ? turnPending
      : messagesEnd;
  }

  function appendConversation(node: HTMLElement): void {
    messages.insertBefore(node, conversationTail());
  }

  function resetConversation(): void {
    replyPending = false;
    turnPending.hidden = true;
    // 편대 카드는 도구 행처럼 휘발성이다 — 대화를 갈아 끼우면 타이머까지 버린다.
    suppressedSpawnCalls.clear();
    fleetView.reset();
    messages.replaceChildren(turnPending, messagesEnd);
  }

  function latestTurnAnchor(): HTMLElement | null {
    const last = messagesEnd.previousElementSibling;
    const content = last === turnPending ? turnPending.previousElementSibling : last;
    if (!(content instanceof HTMLElement)) return null;
    // Keep a newly sent prompt near the top, then follow the moving end of the
    // current agent output instead of remaining pinned to that prompt.
    return content.classList.contains('ag-msg-user') ? content : messagesEnd;
  }

  function conversationAnchorTop(node: HTMLElement): number {
    return node.getBoundingClientRect().top - messages.getBoundingClientRect().top + messages.scrollTop;
  }

  function conversationScrollTarget(node: HTMLElement): number {
    const target = Math.max(0, conversationAnchorTop(node) - conversationFocusOffset());
    return Math.min(target, Math.max(0, messages.scrollHeight - messages.clientHeight));
  }

  /** 새 턴이 뷰포트 위쪽에 머물고, 아래는 답변이 내려올 자리로 비운다. */
  function conversationFocusOffset(): number {
    return Math.round(messages.clientHeight * 0.14);
  }

  function syncConversationSpacer(): void {
    const viewport = messages.clientHeight;
    messagesEnd.style.minHeight = `${Math.max(0, Math.round(viewport * 0.58))}px`;
  }

  function isConversationFollowingTurn(): boolean {
    const anchor = latestTurnAnchor();
    if (!anchor) {
      return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 56;
    }
    return Math.abs(messages.scrollTop - conversationScrollTarget(anchor)) <= 64;
  }

  function lockConversationScroll(ms: number): void {
    conversationScrollLock = true;
    if (conversationScrollUnlock !== null) window.clearTimeout(conversationScrollUnlock);
    conversationScrollUnlock = window.setTimeout(() => {
      conversationScrollUnlock = null;
      conversationScrollLock = false;
    }, ms);
  }

  function scrollConversationToMessage(node: HTMLElement, opts?: { smooth?: boolean }): void {
    followConversation = true;
    syncConversationSpacer();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const smooth = opts?.smooth !== false && !reduce;
    if (conversationScrollRaf !== null) window.cancelAnimationFrame(conversationScrollRaf);
    conversationScrollRaf = window.requestAnimationFrame(() => {
      conversationScrollRaf = null;
      const target = conversationScrollTarget(node);
      if (Math.abs(messages.scrollTop - target) <= 2) return;
      lockConversationScroll(smooth ? 480 : 80);
      messages.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });
    });
  }

  function updateTurnPending(agent?: AgentName): void {
    const editAgent = bridge.pendingEdits.getChangeSets()
      .find((set) => set.status === 'open')?.agent ?? null;
    const waiting = (replyPending || turnRunning) && !streamBubble;
    const show = waiting || editAgent !== null;
    turnPending.hidden = !show;
    if (!show) return;
    const who = agent ?? editAgent ?? selectedAgent;
    turnPendingLabel.textContent = `${AGENT_LABEL[who]} 편집 중…`;
    messages.insertBefore(turnPending, messagesEnd);
  }

  function scrollConversationToEnd(): void {
    const anchor = latestTurnAnchor();
    if (anchor) {
      scrollConversationToMessage(anchor);
      return;
    }
    followConversation = true;
    syncConversationSpacer();
  }

  /** 새 출력은 따라가되, 사용자가 위로 스크롤하면 현재 위치를 존중한다. */
  function withAutoScroll(mutate: () => void): void {
    const shouldFollow = followConversation || isConversationFollowingTurn();
    mutate();
    if (shouldFollow) scrollConversationToEnd();
  }

  /** 실행 중인 도구 내역은 높이를 늘리지 않고 항상 최신 단계를 보여준다. */
  function scrollActivityToLatest(content: HTMLElement): void {
    window.requestAnimationFrame(() => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      content.scrollTo({
        top: content.scrollHeight,
        behavior: reduce ? 'auto' : 'smooth',
      });
    });
  }

  function systemMessage(text: string): void {
    currentThread.messages.push({ role: 'system', text, agent: selectedAgent });
    persistCurrentThread();
    withAutoScroll(() => appendConversation(el('div', 'ag-msg ag-msg-system', text)));
  }

  /** 현재 대화의 CLI 세션을 강제로 다시 띄운다 (설정 탭·스폰 실패 재시도 공용). */
  function restartAgentSession(): void {
    startCurrentBridgeChat(true);
  }

  /** 허브가 CLI 를 못 띄웠을 때 — 실패 메시지 아래에 재시도 한 줄을 놓는다. */
  function appendSpawnRetryAction(): void {
    const row = el('div', 'ag-msg ag-msg-system ag-hub-error-actions');
    const label = el('span', 'ag-hub-error-copy', `${AGENT_LABEL[selectedAgent]} CLI 를 시작하지 못했습니다.`);
    const retry = el('button', 'ag-hub-retry-btn', '다시 시도');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      retry.disabled = true;
      restartAgentSession();
      row.remove();
    });
    row.append(label, retry);
    withAutoScroll(() => appendConversation(row));
  }

  /** 설정 탭에서 저장된 기본값 — 새 대화부터 적용된다. */
  function applyAgentPrefs(prefs: AgentPrefs): void {
    agentPrefs = prefs;
  }

  function openAssistantBubble(agent: AgentName): HTMLElement {
    const bubble = el('div', `ag-msg ag-msg-assistant ag-${agent}`);
    streamBubble = bubble;
    updateTurnPending(agent);
    withAutoScroll(() => appendConversation(bubble));
    return bubble;
  }

  function animateActivityLabel(
    activity: TurnActivityState,
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

  /** 로그 행용 짧은 소요 시간 — 1초 미만은 ms, 그 위는 s. 폭이 흔들리지 않게 짧게. */
  function formatElapsed(startedAt: number): string {
    const ms = Math.max(0, performance.now() - startedAt);
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 60_000)}m`;
  }

  function formatActivityDuration(startedAt: number): string {
    const totalSeconds = Math.max(1, Math.round((performance.now() - startedAt) / 1000));
    if (totalSeconds < 60) return `${totalSeconds}초`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
  }

  function activeToolLabel(activity: TurnActivityState) {
    const active = [...activity.activeTools.values()];
    if (active.length === 1) return `도구 호출 · ${active[0]} 실행 중`;
    if (active.length > 1) return `도구 호출 · ${active[0]} 외 ${active.length - 1}개 실행 중`;
    return `도구 호출 · ${activity.toolCount}개 완료`;
  }

  function settleActivity(activity: TurnActivityState) {
    if (activity.settled || activity.acceptingTools || activity.activeTools.size > 0) return;
    activity.settled = true;
    const duration = formatActivityDuration(activity.startedAt);
    if (activity.failedToolCount > 0) {
      animateActivityLabel(activity, `도구 호출 · ${activity.failedToolCount}개 오류 · ${duration}`);
      activity.root.classList.add('ag-activity-error');
    } else {
      animateActivityLabel(activity, `도구 호출 · ${activity.toolCount}개 완료 · ${duration}`);
      activity.root.classList.add('ag-activity-complete');
    }
    activity.root.classList.remove('ag-activity-running');
  }

  function transcriptId(prefix: string): string {
    return globalThis.crypto?.randomUUID?.()
      ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function ensureActivityTranscript(agent: AgentName): ActivityTranscriptState {
    if (activityTranscript) return activityTranscript;
    const message: ThreadActivityMessage = {
      role: 'assistant',
      kind: 'activity',
      activityId: transcriptId('activity'),
      text: '도구 호출',
      agent,
      status: 'running',
      startedAt: Date.now(),
      completedAt: null,
      tools: [],
    };
    const state = { message, acceptingTools: true };
    currentThread.messages.push(message);
    activityTranscript = state;
    activityTranscripts.set(message.activityId, state);
    persistCurrentThread();
    return state;
  }

  function settleActivityTranscript(state: ActivityTranscriptState): void {
    if (state.acceptingTools || state.message.tools.some((tool) => tool.status === 'running')) return;
    state.message.completedAt = Date.now();
    state.message.status = state.message.tools.some((tool) => tool.status === 'failed')
      ? 'failed'
      : state.message.tools.some((tool) => tool.status === 'stopped')
        ? 'stopped'
        : 'completed';
    persistCurrentThread();
  }

  function closeActivityTranscript(): void {
    const state = activityTranscript;
    if (!state) return;
    state.acceptingTools = false;
    activityTranscript = null;
    settleActivityTranscript(state);
  }

  function recordActivityToolCall(event: Extract<AgentStreamEvent, { type: 'tool-call' }>): void {
    const state = ensureActivityTranscript(event.agent);
    const tool: ThreadToolRecord = {
      callId: event.callId,
      tool: event.tool,
      argsJson: event.argsJson,
      status: 'running',
      resultPreview: '',
      elapsedMs: null,
    };
    state.message.tools.push(tool);
    transcriptTools.set(event.callId, { tool, activity: state, startedAt: Date.now() });
    persistCurrentThread();
  }

  function recordActivityToolResult(event: Extract<AgentStreamEvent, { type: 'tool-result' }>): void {
    const entry = transcriptTools.get(event.callId);
    if (!entry) return;
    transcriptTools.delete(event.callId);
    entry.tool.status = event.ok ? 'completed' : 'failed';
    entry.tool.resultPreview = event.resultPreview;
    entry.tool.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
    settleActivityTranscript(entry.activity);
    persistCurrentThread();
  }

  function sweepActivityTranscripts(): void {
    const touched = new Set<ActivityTranscriptState>();
    for (const [, entry] of transcriptTools) {
      entry.tool.status = 'stopped';
      entry.tool.resultPreview ||= '(결과 없이 종료됨)';
      entry.tool.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
      touched.add(entry.activity);
    }
    transcriptTools.clear();
    for (const state of activityTranscripts.values()) state.acceptingTools = false;
    closeActivityTranscript();
    for (const state of touched) settleActivityTranscript(state);
    activityTranscripts.clear();
  }

  function ensureTasksTranscript(agent: AgentName): ThreadTasksMessage {
    if (tasksTranscript) return tasksTranscript;
    tasksTranscript = {
      role: 'assistant',
      kind: 'tasks',
      taskGroupId: transcriptId('tasks'),
      text: '서브에이전트와 워크플로',
      agent,
      status: 'running',
      tasks: [],
    };
    currentThread.messages.push(tasksTranscript);
    persistCurrentThread();
    return tasksTranscript;
  }

  function recordTaskStart(event: Extract<AgentStreamEvent, { type: 'task-start' }>): void {
    const group = ensureTasksTranscript(event.agent);
    const task: ThreadTaskRecord = {
      taskId: event.taskId,
      taskKind: event.taskKind,
      title: event.title,
      role: event.role ?? '',
      workflowName: event.workflowName ?? '',
      status: 'running',
      activity: '',
      summary: '',
      totalTokens: null,
      toolUses: null,
      durationMs: null,
      tools: [],
    };
    group.tasks.push(task);
    transcriptTasks.set(event.taskId, task);
    persistCurrentThread();
  }

  function recordTaskProgress(event: Extract<AgentStreamEvent, { type: 'task-progress' }>): void {
    const task = transcriptTasks.get(event.taskId);
    if (!task) return;
    if (event.lastTool) task.activity = `▸ ${event.lastTool}`;
    else if (event.activity) task.activity = event.activity;
    if (event.usage?.totalTokens !== undefined) task.totalTokens = event.usage.totalTokens;
    if (event.usage?.toolUses !== undefined) task.toolUses = event.usage.toolUses;
    if (event.usage?.durationMs !== undefined) task.durationMs = event.usage.durationMs;
    persistCurrentThread();
  }

  function recordTaskText(taskId: string, text: string): void {
    const task = transcriptTasks.get(taskId);
    if (!task) return;
    const buffer = `${taskTextBuffers.get(taskId) ?? ''}${text}`;
    taskTextBuffers.set(taskId, buffer.slice(-1000));
    task.activity = truncate(buffer, 140);
  }

  function recordTaskToolCall(event: Extract<AgentStreamEvent, { type: 'tool-call' }>): void {
    if (!event.parentTaskId) return;
    const task = transcriptTasks.get(event.parentTaskId);
    if (!task) return;
    const tool: ThreadToolRecord = {
      callId: event.callId,
      tool: event.tool,
      argsJson: event.argsJson,
      status: 'running',
      resultPreview: '',
      elapsedMs: null,
    };
    task.tools.push(tool);
    taskToolRecords.set(event.callId, { tool, task, startedAt: Date.now() });
    persistCurrentThread();
  }

  function recordTaskToolResult(event: Extract<AgentStreamEvent, { type: 'tool-result' }>): void {
    const entry = taskToolRecords.get(event.callId);
    if (!entry) return;
    taskToolRecords.delete(event.callId);
    entry.tool.status = event.ok ? 'completed' : 'failed';
    entry.tool.resultPreview = event.resultPreview;
    entry.tool.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
    persistCurrentThread();
  }

  function recordTaskEnd(event: Extract<AgentStreamEvent, { type: 'task-end' }>): void {
    const task = transcriptTasks.get(event.taskId);
    if (!task) return;
    task.status = event.status;
    if (event.summary) {
      task.summary = event.summary;
      task.activity = event.summary;
    }
    if (event.usage?.totalTokens !== undefined) task.totalTokens = event.usage.totalTokens;
    if (event.usage?.toolUses !== undefined) task.toolUses = event.usage.toolUses;
    if (event.usage?.durationMs !== undefined) task.durationMs = event.usage.durationMs;
    persistCurrentThread();
  }

  function sweepTasksTranscript(): void {
    if (!tasksTranscript) return;
    for (const task of tasksTranscript.tasks) {
      if (task.status === 'running') task.status = 'stopped';
      for (const tool of task.tools) {
        if (tool.status === 'running') {
          tool.status = 'stopped';
          tool.resultPreview ||= '(결과 없이 종료됨)';
        }
      }
    }
    tasksTranscript.status = tasksTranscript.tasks.some((task) => task.status === 'failed')
      ? 'failed'
      : tasksTranscript.tasks.some((task) => task.status === 'stopped')
        ? 'stopped'
        : 'completed';
    tasksTranscript = null;
    transcriptTasks.clear();
    taskToolRecords.clear();
    taskTextBuffers.clear();
    persistCurrentThread();
  }

  function closeCurrentActivityGroup() {
    const activity = turnActivity;
    if (!activity) return;
    activity.acceptingTools = false;
    turnActivity = null;
    closeActivityTranscript();
    settleActivity(activity);
  }

  /**
   * 펼쳐 둔 도구 활동 그룹을 접는다 — 편대 팝업이 열릴 때 불린다.
   *
   * 지금 열려 있는 그룹(turnActivity)만 보면 안 된다: 카드가 슬롯을 잡을 때
   * closeCurrentActivityGroup 이 참조를 놓아 버리므로, 방금 닫힌 그룹을 사용자가
   * 펼쳐 두면 팝업과 함께 둘이 펼쳐진 채 남는다. 그룹 토글도 어느 그룹이든
   * 팝업을 닫으므로 이쪽도 흐름 전체를 훑어 대칭을 맞춘다.
   */
  function collapseTurnActivity() {
    const expanded = messages.querySelectorAll<HTMLElement>(
      '.ag-activity:not(.ag-activity-collapsed)',
    );
    for (const activity of expanded) {
      activity.classList.add('ag-activity-collapsed');
      activity.querySelector('.ag-activity-toggle')?.setAttribute('aria-expanded', 'false');
      const content = activity.querySelector<HTMLElement>('.ag-activity-content');
      if (content) content.tabIndex = -1;
    }
  }

  function ensureTurnActivity(agent: AgentName, milestone?: HTMLElement | null) {
    if (turnActivity) return turnActivity;

    const activity = el('div', `ag-activity ag-${agent} ag-activity-running ag-activity-collapsed`);
    const toggle = el('button', 'ag-activity-toggle') as HTMLButtonElement;
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const label = el('span', 'ag-activity-label', '도구 호출');
    label.setAttribute('aria-live', 'polite');
    const chevron = createChevron('ag-activity-chevron');
    toggle.append(label, chevron);

    const collapse = el('div', 'ag-activity-collapse');
    const content = el('div', 'ag-activity-content');
    content.tabIndex = -1;
    content.setAttribute('aria-label', '도구 호출 내역');
    collapse.appendChild(content);
    activity.append(toggle, collapse);

    toggle.addEventListener('click', () => {
      const collapsed = activity.classList.toggle('ag-activity-collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      content.tabIndex = collapsed ? -1 : 0;
      if (!collapsed) {
        // 도구 기록을 펼치면 편대 팝업은 접는다 — 살아 있는 기록은 한 번에 하나만 펼친다.
        fleetView.closePopup();
        scrollActivityToLatest(content);
        if (followConversation) scrollConversationToEnd();
      }
    });

    if (milestone) {
      withAutoScroll(() => milestone.appendChild(activity));
    } else {
      const toolsOnly = el('div', 'ag-progress-step ag-progress-step-tools-only');
      toolsOnly.appendChild(activity);
      withAutoScroll(() => appendConversation(toolsOnly));
    }

    turnActivity = {
      root: activity,
      label,
      content,
      startedAt: performance.now(),
      toolCount: 0,
      failedToolCount: 0,
      activeTools: new Map(),
      acceptingTools: true,
      settled: false,
    };
    return turnActivity;
  }

  /** 도구 호출 앞의 진행 설명을 타임라인 이정표로 확정한다. */
  function compactStreamIntoActivity(agent: AgentName) {
    flushPendingAssistantRender();
    const bubble = streamBubble;
    if (!bubble) return null;
    if (!(assistantBubbleSources.get(bubble) ?? bubble.textContent ?? '').trim()) {
      bubble.remove();
      streamBubble = null;
      updateTurnPending(agent);
      return null;
    }
    const milestone = el('div', 'ag-progress-step');
    withAutoScroll(() => {
      messages.insertBefore(milestone, bubble);
      bubble.className = `ag-msg ag-progress-milestone ag-${agent}`;
      milestone.appendChild(bubble);
    });
    streamBubble = null;
    updateTurnPending(agent);
    return milestone;
  }

  function completeTurnActivity() {
    closeCurrentActivityGroup();
  }

  function appendCheckDocumentMessage(agent: AgentName): void {
    const text = '작업을 마쳤습니다. 문서를 확인해 보세요.';
    const message = openAssistantBubble(agent);
    renderAssistantMessage(message, text);
    message.classList.add('ag-msg-enter');
    assistantBuffer = text;
    flushAssistantBuffer();
    streamBubble = null;
  }

  function addToolRow(
    evt: Extract<AgentStreamEvent, { type: 'tool-call' }>,
    milestone?: HTMLElement | null,
  ): void {
    const activity = ensureTurnActivity(evt.agent, milestone);
    activity.toolCount += 1;
    activity.activeTools.set(evt.callId, evt.tool);
    turnToolCount += 1;
    animateActivityLabel(activity, activeToolLabel(activity));

    const row = el('div', `ag-tool-row ag-${evt.agent}`);
    const head = el('button', 'ag-tool-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    // 로그 행의 주소: 왼쪽 거터의 op 번호 → 상태 → 도구 이름 → 인자 → 소요 시간.
    const opId = el('span', 'ag-op-id', String(activity.toolCount).padStart(2, '0'));
    opId.setAttribute('aria-hidden', 'true');
    const status = el('span', 'ag-tool-status ag-spin');
    const name = el('span', 'ag-tool-name', evt.tool);
    const summary = el('span', 'ag-tool-summary', truncate(evt.argsJson, 60));
    const elapsed = el('span', 'ag-tool-elapsed');
    const chevron = createChevron('ag-tool-chevron');
    head.append(opId, status, name, summary, elapsed, chevron);

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
    toolRows.set(evt.callId, {
      status,
      result,
      scroller: activity.content,
      elapsed,
      startedAt: performance.now(),
      activity,
    });
    // 다음 text-delta 는 activity 아래의 최종 답변 후보로 연다.
    streamBubble = null;
  }

  function resolveToolRow(evt: Extract<AgentStreamEvent, { type: 'tool-result' }>): void {
    const entry = toolRows.get(evt.callId);
    if (!entry) return;
    toolRows.delete(evt.callId);
    entry.status.classList.remove('ag-spin');
    entry.status.classList.add(evt.ok ? 'ag-ok' : 'ag-err');
    entry.status.replaceChildren(createIcon(evt.ok ? 'check' : 'close'));
    entry.elapsed.textContent = formatElapsed(entry.startedAt);
    entry.result.textContent = evt.resultPreview;
    entry.activity.activeTools.delete(evt.callId);
    if (!evt.ok) {
      entry.activity.failedToolCount += 1;
      turnFailedToolCount += 1;
    }
    animateActivityLabel(entry.activity, activeToolLabel(entry.activity));
    settleActivity(entry.activity);
    scrollActivityToLatest(entry.scroller);
  }

  /**
   * turn 종료(인터럽트/프로세스 종료 포함) 시 결과가 도착하지 않은 tool row 를
   * 정리한다 — 스피너가 영원히 돌거나 Map 엔트리가 새는 것을 막는다.
   */
  function sweepUnresolvedToolRows(): void {
    const touchedActivities = new Set<TurnActivityState>();
    for (const [callId, entry] of toolRows) {
      entry.status.classList.remove('ag-spin');
      entry.status.classList.add('ag-err');
      entry.status.replaceChildren(createIcon('close'));
      if (!entry.elapsed.textContent) entry.elapsed.textContent = '중단';
      if (!entry.result.textContent) entry.result.textContent = '(결과 없이 종료됨)';
      entry.activity.activeTools.delete(callId);
      entry.activity.failedToolCount += 1;
      turnFailedToolCount += 1;
      touchedActivities.add(entry.activity);
    }
    toolRows.clear();
    for (const activity of touchedActivities) {
      animateActivityLabel(activity, activeToolLabel(activity));
      settleActivity(activity);
    }
  }

  function handleAgentEvent(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'turn-start':
        // 이전 턴이 비정상 종료돼 남긴 실행 상태를 먼저 닫는다.
        sweepUnresolvedToolRows();
        sweepActivityTranscripts();
        sweepTasksTranscript();
        completeTurnActivity();
        setTurnRunning(true);
        runStatusThreadId = currentThread.id;
        markChatWorking(runStatusThreadId);
        replyPending = true;
        followConversation = true;
        updateTurnPending(event.agent);
        scrollConversationToEnd();
        assistantBuffer = '';
        cancelPendingAssistantRender();
        streamBubble = null;
        turnActivity = null;
        turnToolCount = 0;
        turnFailedToolCount = 0;
        turnPresentedPlan = false;
        planCardPending = false;
        // 새 턴의 서브에이전트는 새 카드에 모인다.
        suppressedSpawnCalls.clear();
        fleetView.beginTurn();
        break;
      case 'text-delta': {
        // 서브에이전트가 낸 텍스트는 그 행의 근황일 뿐, 루트 답변 버퍼에 섞이지 않는다.
        if (event.parentTaskId) recordTaskText(event.parentTaskId, event.text);
        if (event.parentTaskId && fleetView.routeTextDelta(event)) break;
        if (!streamBubble && turnActivity) closeCurrentActivityGroup();
        const bubble = streamBubble ?? openAssistantBubble(event.agent);
        assistantBuffer += event.text;
        withAutoScroll(() => {
          if (!bubble.classList.contains('ag-msg-enter')) {
            bubble.classList.add('ag-msg-enter');
          }
          scheduleAssistantRender(bubble, assistantBuffer);
        });
        break;
      }
      case 'tool-call': {
        // 서브에이전트의 도구는 그 행의 드릴인으로 들어간다. 모르는 task 면 루트로 떨어진다.
        if (event.parentTaskId) recordTaskToolCall(event);
        if (event.parentTaskId && fleetView.routeToolCall(event)) break;
        // 스폰 자체는 편대 카드가 나타내므로 도구 행을 따로 그리지 않는다.
        if (!event.parentTaskId && isSpawnToolName(event.tool)) {
          suppressedSpawnCalls.add(event.callId);
          turnToolCount += 1;
          break;
        }
        if (event.tool === 'present_implementation_plan') {
          planCardPending = true;
          systemMessage('계획 카드를 만드는 중');
        }
        // 도구 전 설명은 최종 답변과 구분된 진행 이정표로 보관한다.
        flushAssistantBuffer({ kind: 'progress' });
        const milestone = compactStreamIntoActivity(event.agent);
        recordActivityToolCall(event);
        addToolRow(event, milestone);
        updateTurnPending(event.agent);
        break;
      }
      case 'tool-result':
        if (suppressedSpawnCalls.delete(event.callId)) {
          if (!event.ok) turnFailedToolCount += 1;
          break;
        }
        if (event.parentTaskId) recordTaskToolResult(event);
        if (event.parentTaskId && fleetView.routeToolResult(event)) break;
        recordActivityToolResult(event);
        resolveToolRow(event);
        break;
      case 'task-start':
        fleetView.taskStart(event);
        recordTaskStart(event);
        updateTurnPending(event.agent);
        break;
      case 'task-progress':
        fleetView.taskProgress(event);
        recordTaskProgress(event);
        break;
      case 'task-end':
        fleetView.taskEnd(event);
        recordTaskEnd(event);
        break;
      case 'session-info':
        if (event.mcpStatus !== undefined && event.mcpStatus !== 'connected') {
          systemMessage(`MCP 서버 연결 실패: ${event.mcpStatus}`);
        }
        break;
      case 'turn-end': {
        flushPendingAssistantRender();
        const finalBubble =
          streamBubble?.parentElement === messages
          && Boolean((assistantBubbleSources.get(streamBubble) ?? streamBubble.textContent ?? '').trim());
        setTurnRunning(false);
        if (runStatusThreadId !== null) {
          // 사용자가 멈춘 턴은 신호 없이 꺼진다. 계획이 승인을 기다리며 끝난
          // 턴은 빨간 점, 그 외에는 완료 점이 남는다.
          if (event.stopReason === 'interrupted') clearChatStatus(runStatusThreadId);
          else if (chatWorkflow === 'plan' && planningPhase === 'awaiting-approval' && planApprovable) {
            markChatNeedsInput(runStatusThreadId);
          } else markChatFinished(runStatusThreadId);
          runStatusThreadId = null;
        }
        flushAssistantBuffer();
        sweepUnresolvedToolRows();
        sweepActivityTranscripts();
        // 편대는 턴이 정착한 뒤 도착하지만, 남은 행은 여기서 중단됨으로 확정한다.
        suppressedSpawnCalls.clear();
        fleetView.sweep();
        sweepTasksTranscript();
        if (event.errorMessage) systemMessage(event.errorMessage);
        const completed =
          event.stopReason !== 'interrupted'
          && event.stopReason !== 'failed'
          && event.stopReason !== 'exited'
          && !event.errorMessage
          && turnFailedToolCount === 0;
        if (planCardPending && !turnPresentedPlan) {
          systemMessage('계획 카드가 도착하지 않았습니다');
        }
        planCardPending = false;
        const editingPhase = chatWorkflow === 'direct' || planningPhase === 'implementing';
        if (turnToolCount > 0 && !turnPresentedPlan && !finalBubble && completed && editingPhase) {
          appendCheckDocumentMessage(event.agent);
        }
        completeTurnActivity();
        streamBubble = null;
        if (cloudTransferPending) requestCloudTransfer();
        break;
      }
      case 'error':
        systemMessage(event.message);
        break;
    }
  }

  function handleSidebarEvent(e: SidebarEvent): void {
    writingStyleCalibration.handleEvent(e);
    // 설정 탭은 연결·프로바이더·사용량·문체 상태를 그대로 받아 그린다.
    settingsPanel.handleEvent(e);
    initialSetup?.handleEvent(e);
    if (handlePlanningSidebarEvent(e)) return;
    switch (e.type) {
      case 'connection':
        setConnection(e.state, { attempt: e.attempt, retryInMs: e.retryInMs });
        // 재연결 시 진행 상태를 브리지와 다시 동기화한다.
        setTurnRunning(bridge.isTurnRunning());
        dropRunStatusIfIdle();
        break;
      case 'chat-started':
        if (e.threadId && e.threadId !== currentThread.id) break;
        chatStartPendingThreadId = null;
        const prevAgent = selectedAgent;
        const prevModel = selectedModel;
        const prevEffort = selectedEffort;
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
        if (e.serviceTier === 'fast' || e.serviceTier === 'standard') {
          selectedServiceTier = resolveServiceTier(selectedAgent, e.serviceTier);
          currentThread.serviceTier = selectedServiceTier;
        }
        if (e.permissionProfile) {
          permissionProfile = e.permissionProfile;
          updatePermissionButton();
        }
        // 로컬에서 이미 맞춰 둔 선택(추론 강도 등)을 서버가 그대로 메아리치면
        // 메뉴를 다시 그리지 않는다 — 열린 설정 패널이 깜빡이지 않게.
        if (selectedAgent !== prevAgent || selectedModel !== prevModel) rebuildLlmMenu();
        if (selectedAgent !== prevAgent || selectedModel !== prevModel || selectedEffort !== prevEffort) {
          rebuildEffortMenu();
        }
        updateComposer();
        // 새 채팅(welcome)·재시작 시 작업 방식과 계획 단계를 서버와 다시 맞춘다.
        syncPlanningFromBridge();
        break;
      case 'permission-changed':
        permissionProfile = e.permissionProfile;
        updatePermissionButton();
        systemMessage(permissionProfile === 'unrestricted' ? '전체 접근을 켰습니다. 에이전트가 승인 없이 문서를 편집하고, 명령과 파일 도구가 노트북 전체에 접근할 수 있습니다. 이미 검토 대기 중인 변경은 그대로 남습니다.' : '안전 모드로 돌아왔습니다. 문서 편집은 턴이 끝나면 검토 대기로 남아 승인 후 반영되고, 파일과 명령은 프로젝트 범위로 제한됩니다.');
        break;
      case 'service-tier-changed':
        selectedServiceTier = resolveServiceTier(selectedAgent, e.serviceTier);
        currentThread.serviceTier = selectedServiceTier;
        persistCurrentThread();
        break;
      case 'reference-status': {
        const message = currentThread.messages.find((item) => item.messageId === e.messageId);
        if (!message?.attachments) break;
        for (const update of e.attachments) {
          const attachment = message.attachments.find((item) => item.stageId === update.stageId);
          if (!attachment) continue;
          attachment.status = update.status;
          if (update.file) {
            attachment.fileId = update.file.id;
            attachment.name = update.file.name;
            attachment.mimeType = update.file.mimeType;
            attachment.size = update.file.size;
          }
          if (update.error) attachment.error = update.error;
          else delete attachment.error;
        }
        attachmentsSending = message.attachments.some((item) => item.status === 'processing');
        persistCurrentThread();
        renderMessagesFromThread(currentThread);
        updateComposer();
        if (!attachmentsSending) void referenceLibrary.refresh();
        break;
      }
      case 'skills-catalog':
        skillCatalog = e.catalog;
        if (activeComposerSkill) {
          const refreshed = skillCatalog.skills.find((skill) => skill.name === activeComposerSkill?.name);
          if (!refreshed?.enabled || refreshed.invalid) setComposerSkill(null);
          else setComposerSkill(refreshed);
        }
        skillsStatus.textContent = `${skillCatalog.skills.length}개 스킬`;
        renderSkillsList();
        rebuildSlashMenu();
        break;
      case 'templates-catalog': {
        templateCatalog = e.catalog;
        const selected = currentThread.activeTemplateId
          ? templateCatalog.templates.find((template) => template.id === currentThread.activeTemplateId) ?? null
          : null;
        if (currentThread.activeTemplateId && !selected) {
          currentThread.activeTemplateId = null;
          activeTemplate = null;
          bridge.setActiveTemplate(null);
          if (e.change?.type === 'deleted') {
            systemMessage(`“${e.change.template.name}” 템플릿을 사용할 수 없어 이 채팅에서 해제했습니다.`);
          }
        } else {
          activeTemplate = selected;
        }
        renderActiveTemplate();
        rebuildSlashMenu();
        persistCurrentThread();
        break;
      }
      case 'chat-template-changed':
        activeTemplate = e.template;
        currentThread.activeTemplateId = e.template?.id ?? null;
        renderActiveTemplate();
        persistCurrentThread();
        if (e.reason === 'deleted') systemMessage('이 채팅에서 사용하던 템플릿이 삭제되어 해제했습니다.');
        break;
      case 'skill-detail': {
        const action = skillRequestActions.get(e.requestId) ?? 'edit';
        skillRequestActions.delete(e.requestId);
        editingSkill = action === 'duplicate' ? null : e.skill;
        skillsToolbar.hidden = true;
        skillsList.hidden = true;
        skillEditor.hidden = false;
        skillGenerate.disabled = false;
        skillSave.disabled = false;
        skillEditorTitle.textContent = action === 'duplicate' ? `/${e.skill.name} 복제` : `/${e.skill.name}`;
        skillGoal.value = action === 'duplicate' ? `${e.skill.name} 스킬을 내 용도에 맞게 복제` : e.skill.description;
        skillTriggers.value = '';
        skillNonTriggers.value = '';
        const nextName = action === 'duplicate' ? `${e.skill.name}-custom` : e.skill.name;
        const readOnly = e.skill.origin === 'bundled' && action !== 'duplicate';
        syncSkillIconPicker(e.skill.icon ?? defaultSkillIconForName(e.skill.name), readOnly);
        applySkillDraft(
          nextName,
          e.skill.files.map((file) => ({ path: file.path, content: file.content ?? '', encoding: file.encoding })),
          selectedSkillIcon,
        );
        skillName.disabled = readOnly;
        skillSave.hidden = readOnly;
        skillGenerate.hidden = readOnly;
        skillResources.disabled = readOnly;
        skillsStatus.textContent = readOnly ? '기본 스킬은 읽기 전용입니다. 복제하여 수정할 수 있습니다.' : '파일을 검토한 뒤 저장하세요.';
        skillEditorBack.focus();
        break;
      }
      case 'skill-draft-progress':
        if (e.requestId === activeSkillDraftRequestId) {
          skillsStatus.textContent = `${AGENT_LABEL[selectedAgent]}가 스킬 초안을 만드는 중…`;
        }
        break;
      case 'skill-draft-result':
        if (e.requestId !== activeSkillDraftRequestId) break;
        activeSkillDraftRequestId = null;
        skillGenerate.disabled = false;
        {
          const resources = skillDraftFiles.filter((file) => file.path !== 'SKILL.md');
          const generated = e.draft.files.map((file) => ({ ...file, encoding: 'utf8' as const }));
          const generatedPaths = new Set(generated.map((file) => file.path));
          applySkillDraft(
            e.draft.name,
            [...generated, ...resources.filter((file) => !generatedPaths.has(file.path))],
            selectedSkillIcon,
          );
        }
        skillsStatus.textContent = '초안이 준비되었습니다. 모든 파일을 검토한 뒤 저장하세요.';
        break;
      case 'skill-validated':
        if (skillValidationRequests.get(e.requestId) !== skillDraftRevision) {
          skillValidationRequests.delete(e.requestId);
          skillSave.disabled = false;
          skillsStatus.textContent = '검증 중 파일이 바뀌었습니다. 다시 검증하세요.';
          break;
        }
        skillValidationRequests.delete(e.requestId);
        skillSave.disabled = false;
        skillValidationReady = true;
        skillSave.textContent = '확인하고 저장';
        skillWarning.textContent = e.result.hasScripts
          ? '검증됨 · 실행 가능한 스크립트가 있습니다. 모든 코드를 검토한 뒤 저장하세요.'
          : `검증됨 · ${e.result.fileCount}개 파일 · 저장 전 최종 확인이 필요합니다.`;
        skillsStatus.textContent = '검증을 통과했습니다. 최종 확인 후 저장하세요.';
        break;
      case 'skill-saved':
        skillSave.disabled = false;
        skillsStatus.textContent = `/${e.skill.name} 스킬을 저장했습니다.`;
        showSkillList();
        skillsSearch.focus();
        bridge.listSkills();
        break;
      case 'skill-deleted':
        skillsStatus.textContent = `/${e.name} 스킬을 복구 가능한 휴지통으로 옮겼습니다.`;
        bridge.listSkills();
        break;
      case 'skills-error':
        if (e.code === 'SKILL_GENERATION_FAILED' && e.requestId !== activeSkillDraftRequestId) break;
        skillValidationRequests.delete(e.requestId);
        if (e.requestId === activeSkillDraftRequestId) {
          activeSkillDraftRequestId = null;
          skillGenerate.disabled = false;
        }
        skillSave.disabled = false;
        invalidateSkillValidation();
        skillsStatus.textContent = `오류: ${e.message}`;
        break;
      case 'pi-status':
        // 브리지가 모델 레지스트리를 먼저 갱신했다 — 라벨과 강도를 다시 읽는다.
        piSetupComplete = e.status.setupComplete;
        syncProviderMenu();
        if (selectedAgent === 'pi') {
          selectedModel = resolveModelForAgent('pi', selectedModel);
          selectedEffort = resolveEffortForAgent('pi', selectedEffort, selectedModel);
        }
        rebuildLlmMenu();
        rebuildEffortMenu();
        refreshSidebarWidthMin();
        break;
      case 'agent-setup-status':
        rauSetupComplete = e.statuses.rau?.setupComplete === true;
        if (!rauSetupComplete && lastUsage?.rau) {
          lastUsage = { ...lastUsage, rau: undefined };
        }
        syncProviderMenu();
        // 브리지가 cursor 모델 레지스트리를 먼저 갱신했다 — 목록과 선택값을 다시 읽는다.
        if (selectedAgent === 'cursor') {
          selectedModel = resolveModelForAgent('cursor', selectedModel);
          selectedEffort = resolveEffortForAgent('cursor', selectedEffort, selectedModel);
          rebuildLlmMenu();
          rebuildEffortMenu();
          refreshSidebarWidthMin();
        }
        updateComposer();
        break;
      case 'usage-report':
        lastUsage = e.usage;
        updateComposer();
        break;
      case 'writing-style-status':
      case 'writing-style-progress':
      case 'writing-style-result':
      case 'writing-style-error':
      case 'writing-style-catalog':
        break;
      // 프로바이더 상태·pi 설정 진행은 설정 탭이 이미 받아 그렸다.
      case 'provider-status':
      case 'pi-setup-progress':
      case 'pi-catalog':
      case 'pi-error':
        break;
      case 'chat-stopped':
        setTurnRunning(false);
        dropRunStatusIfIdle();
        flushPendingAssistantRender();
        flushAssistantBuffer();
        sweepUnresolvedToolRows();
        sweepActivityTranscripts();
        suppressedSpawnCalls.clear();
        fleetView.sweep();
        sweepTasksTranscript();
        completeTurnActivity();
        streamBubble = null;
        if (cloudTransferPending) requestCloudTransfer();
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
        if (threadsListVisible()) rebuildThreadsList();
        break;
      }
      case 'agent':
        handleAgentEvent(e.event);
        break;
      case 'hub-error':
        chatStartPendingThreadId = null;
        if (e.code === 'REFERENCE_COMMIT_FAILED' || e.code === 'INVALID_REFERENCE_MESSAGE') {
          attachmentsSending = false;
          for (const message of currentThread.messages) {
            for (const attachment of message.attachments ?? []) {
              if (attachment.status === 'processing') {
                attachment.status = 'error';
                attachment.error = e.message;
              }
            }
          }
          persistCurrentThread();
          renderMessagesFromThread(currentThread);
          updateComposer();
        }
        systemMessage(`오류 (${e.code}): ${e.message}`);
        if (e.code === 'AGENT_SPAWN_FAILED') appendSpawnRetryAction();
        workflowTransitionPending = false;
        planPermissionDefaultPending = false;
        syncPlanningFromBridge();
        setTurnRunning(bridge.isTurnRunning());
        dropRunStatusIfIdle();
        break;
    }
  }

  /**
   * 대기 편집 한 건 = 주소가 붙은 오퍼레이션. 머리줄이 좌표를 말하고
   * 아랫줄이 실제 -/+ diff 를 보여준다 — 요약 문장 대신 검토 가능한 형태.
   */
  function buildReviewOp(op: PendingOp): HTMLElement {
    const entry = el('div', `ag-review-op ag-review-op-${op.kind}`);
    const head = el('div', 'ag-op-head');
    // 빈 새 텍스트의 replace = 즉시 적용된 삭제 — 삭제로 표시한다
    const displayKind = op.kind === 'replace' && op.text.length === 0 ? 'delete' : op.kind;
    const glyph = el('span', `ag-op-glyph ag-op-${displayKind}`);
    glyph.appendChild(createIcon(OP_ICON[displayKind] ?? 'replace'));
    // 좌표가 있는 op 만 주소를 말한다. 필드/개체는 대상 이름이 곧 주소다.
    const addr = op.kind === 'field'
      ? op.name
      : op.kind === 'template'
        ? op.label
      : op.kind === 'object'
        ? (OBJECT_OP_LABELS[op.obj.type] ?? op.obj.type)
        : opAddress(op.range);
    head.append(glyph, el('span', 'ag-op-addr', addr));
    entry.appendChild(head);

    const diff = el('div', 'ag-op-diff');
    switch (op.kind) {
      case 'replace':
        diff.appendChild(buildDiffLine('del', op.deletedText));
        if (op.text.length > 0) diff.appendChild(buildDiffLine('add', op.text));
        break;
      case 'insert':
        diff.appendChild(buildDiffLine('add', op.text));
        break;
      case 'delete':
        diff.appendChild(buildDiffLine('del', op.text));
        break;
      case 'field':
        diff.append(buildDiffLine('del', op.oldValue), buildDiffLine('add', op.newValue));
        break;
      default:
        // 서식/개체는 텍스트 diff 가 없다 — 중립 줄로 내용만 보인다.
        diff.appendChild(buildDiffLine('ctx', opPreview(op)));
        break;
    }
    entry.appendChild(diff);
    return entry;
  }

  // ── 계획 모드 ────────────────────────────────────────

  /** 실행 중이거나 첨부를 커밋하거나 전환 중에는 모드·모델·권한을 바꿀 수 없다. */
  function isControlLocked(): boolean {
    if (mergeResolverLocked || cloudUi.isCloudConversation()) return true;
    return turnRunning || attachmentsSending || chatStartPendingThreadId !== null
      || workflowTransitionPending || planningPhase === 'switching';
  }

  function hasPendingDocumentEdits(): boolean {
    return bridge.pendingEdits.getChangeSets().length > 0;
  }

  function updateWorkflowControl(): void {
    const planActive = chatWorkflow === 'plan' || chatWorkflow === 'question';
    phaseBadge.hidden = !planActive || planningPhase === 'direct';
    phaseBadge.textContent = PLANNING_PHASE_LABEL[planningPhase];
    phaseBadge.dataset.phase = planningPhase;
    root.dataset.workflow = chatWorkflow;
    root.dataset.planningPhase = planningPhase;
    refreshSidebarWidthMin();
  }

  function setPlanningPhase(phase: AgentPhase): void {
    if (planningPhase === phase) return;
    planningPhase = phase;
    updateWorkflowControl();
    updateComposer();
    rebuildReview();
  }

  function applyWorkflow(workflow: AgentWorkflow): void {
    chatWorkflow = workflow;
    currentThread.workflow = workflow;
    threadWorkflows.set(currentThread.id, workflow);
    if (workflow === 'direct') {
      planningPhase = 'direct';
      planApprovable = false;
    } else if (workflow === 'question') {
      planningPhase = 'questioning';
      planApprovable = false;
    } else if (planningPhase === 'direct' || planningPhase === 'questioning') {
      planningPhase = 'planning';
    }
    updateWorkflowControl();
    updateComposer();
    rebuildReview();
  }

  /**
   * 모드 전환 요청. 계획 모드로 들어갈 때만 원격 브라우저 전체 제어를
   * 한 번 경고하고, 검토 대기 중인 문서 편집이 있으면 막는다.
   */
  function requestWorkflow(next: AgentWorkflow): boolean {
    const restartCompletedPlan = next === 'plan'
      && chatWorkflow === 'plan'
      && planningPhase === 'implementing';
    if (next === chatWorkflow && !restartCompletedPlan) {
      input.focus();
      return true;
    }
    if (isControlLocked() || connState !== 'connected') {
      systemMessage(
        turnRunning
          ? '실행 중에는 작업 방식을 바꿀 수 없습니다. 먼저 중지하세요.'
          : '전환 중에는 작업 방식을 바꿀 수 없습니다.',
      );
      updateWorkflowControl();
      return false;
    }
    if (next === 'plan' || next === 'question') {
      if (next === 'plan' && hasPendingDocumentEdits()) {
        systemMessage(
          '검토 대기 중인 문서 편집이 있습니다. 먼저 승인하거나 거절한 뒤 구상 모드로 전환하세요.',
        );
        updateWorkflowControl();
        return false;
      }
      if (!browserbaseAcknowledged) {
        if (!window.confirm(BROWSERBASE_FULL_CONTROL_WARNING)) {
          updateWorkflowControl();
          input.focus();
          return false;
        }
        browserbaseAcknowledged = true;
        browserbaseNoticePending = true;
      }
      planPermissionDefaultPending = permissionProfile === 'safe';
    } else {
      planPermissionDefaultPending = false;
    }
    workflowTransitionPending = true;
    applyWorkflow(next);
    bridge.setWorkflow(next);
    input.focus();
    return true;
  }

  function recordPlan(plan: StructuredPlan): void {
    planHistory = [...planHistory.filter((p) => p.planId !== plan.planId), plan];
    currentThread.latestPlan = plan;
    currentThread.plans = [...planHistory];
    planArchives.set(currentThread.id, planHistory);
    if (currentThread.messages.length > 0) persistCurrentThread();
  }

  function presentPlanInChat(plan: StructuredPlan): void {
    if (currentThread.messages.some((message) => message.kind === 'plan' && message.planId === plan.planId)) return;
    const message: Extract<ThreadMessage, { kind: 'plan' }> = {
      role: 'assistant',
      kind: 'plan',
      planId: plan.planId,
      text: plan.title || '제목 없는 계획',
      agent: selectedAgent,
    };
    currentThread.messages.push(message);
    currentThread.updatedAt = Date.now();
    persistCurrentThread();
    withAutoScroll(() => appendConversation(renderPlanMessage(message)));
  }

  function markPlanExecuted(planId: string): void {
    let presentation: Extract<ThreadMessage, { kind: 'plan' }> | null = null;
    for (const message of currentThread.messages) {
      if (message.kind !== 'plan' || message.planId !== planId) continue;
      message.planState = 'executed';
      presentation = message;
    }
    if (!presentation) return;

    const button = messages.querySelector<HTMLElement>(
      `.ag-msg-plan-action[data-plan-id="${CSS.escape(planId)}"]`,
    );
    button?.classList.add('ag-executed');
    button?.setAttribute('aria-label', `${presentation.text || '계획'} 완료된 계획 열기`);
    const kicker = button?.querySelector<HTMLElement>('.ag-msg-plan-kicker');
    if (kicker) kicker.textContent = '실행 됨';
  }

  function closePlanForExecution(planId: string): void {
    markPlanExecuted(planId);
    if (activePlan?.planId === planId) {
      activePlan = null;
      activePlanHistorical = false;
      planMinimized = false;
      planColCollapsed = true;
    }
    persistCurrentThread();
  }

  function openPresentedPlan(planId: string): void {
    const plan = planHistory.find((candidate) => candidate.planId === planId)
      ?? (currentThread.latestPlan?.planId === planId ? currentThread.latestPlan : null);
    if (!plan) return;

    const workflowState = bridge.getWorkflowState();
    activePlan = plan;
    planApprovable = workflowState.latestPlan?.planId === planId
      && workflowState.phase === 'awaiting-approval';
    activePlanHistorical = !planApprovable
      && (workflowState.latestPlan?.planId !== planId || workflowState.phase === 'implementing');
    rebuildReview();
    if (fullscreen) {
      setPlanColCollapsed(false);
      setEnvironmentPanelOpen(false);
    } else {
      setPlanMinimized(false);
    }
    window.requestAnimationFrame(() => {
      const card = planCardSlot.querySelector<HTMLElement>(`.ag-plan-card[data-plan-id="${CSS.escape(planId)}"]`);
      card?.scrollIntoView({ block: 'nearest' });
      card?.focus({ preventScroll: true });
    });
  }
  /**
   * 계획 문서 뷰어. 말풍선이 아니라 고정 리뷰 영역에 놓이는 문서다 —
   * 대화가 흘러가도 같은 자리에 남아 편집 모드 전환과 수정 요청을 받는다.
   * 표시는 Markdown 이지만 승인 대상은 언제나 구조화된 계획(planId)이다.
   */
  function buildPlanCard(plan: StructuredPlan): HTMLElement {
    const card = el('section', `ag-plan-card ag-plan-doc ag-${selectedAgent}`);
    card.setAttribute('role', 'article');
    const titleId = `ag-plan-title-${plan.planId}`;
    card.setAttribute('aria-labelledby', titleId);
    card.tabIndex = -1;
    card.dataset.planId = plan.planId;

    const head = el('header', 'ag-plan-head');
    const kickerRow = el('div', 'ag-plan-kicker-row');
    kickerRow.append(el('span', 'ag-plan-kicker', '실행 계획'));
    kickerRow.append(el(
      'span',
      'ag-plan-phase',
      activePlanHistorical ? '계획 기록' : PLANNING_PHASE_LABEL[planningPhase],
    ));
    const planIdReadout = el('span', 'ag-plan-id', plan.planId);
    planIdReadout.title = plan.planId;
    kickerRow.append(planIdReadout);
    const minimize = el('button', 'ag-plan-minimize');
    minimize.type = 'button';
    minimize.setAttribute('aria-label', '계획 최소화');
    minimize.title = '계획 최소화';
    minimize.appendChild(createIcon('minimize'));
    minimize.addEventListener('click', () => setPlanMinimized(true));
    kickerRow.append(minimize);
    head.appendChild(kickerRow);

    const title = el('h3', 'ag-plan-title', plan.title || '제목 없는 계획');
    title.id = titleId;
    head.appendChild(title);

    const goalText = (plan.goal || plan.summary || '').trim();
    if (goalText) head.appendChild(el('p', 'ag-plan-goal', goalText));
    card.appendChild(head);

    // 본문은 전부 펼친다 — 접기 없이 패널이 스크롤한다.
    const body = el('div', 'ag-plan-body');
    body.id = `ag-plan-body-${plan.planId}`;
    appendMarkdown(body, planToMarkdown(plan));
    card.appendChild(body);

    if (!activePlanHistorical) {
      const approvableNow = planApprovable
        && planningPhase === 'awaiting-approval'
        && !turnRunning;
      const footer = el('footer', 'ag-plan-footer');
      const actions = el('div', 'ag-review-actions ag-plan-actions');
      const approve = el('button', 'ag-approve ag-plan-approve', '편집 모드로 전환');
      approve.type = 'button';
      approve.disabled = !approvableNow;
      approve.addEventListener('click', () => approveActivePlan(plan.planId));
      const revise = el('button', 'ag-reject ag-plan-revise', '수정 요청');
      revise.type = 'button';
      revise.disabled = !planApprovable || planningPhase === 'switching' || turnRunning;
      revise.addEventListener('click', () => requestPlanRevision(plan.planId));
      actions.append(approve, revise);
      footer.appendChild(actions);

      let noteText = '';
      if (planningPhase === 'switching') {
        noteText = '승인했습니다. 실행 단계로 전환 중입니다…';
      } else if (planningPhase === 'implementing') {
        noteText = '실행 중입니다. 문서 편집은 기존처럼 검토 후 승인합니다.';
      } else if (!planApprovable) {
        noteText = '이전 계획입니다. 표시만 되고 승인할 수 없습니다.';
      }
      if (noteText) footer.appendChild(el('p', 'ag-plan-note', noteText));
      card.appendChild(footer);
    }
    return card;
  }

  function approveActivePlan(planId: string): void {
    if (!planApprovable || planningPhase !== 'awaiting-approval' || turnRunning) return;
    // 정확히 이 계획 id 로만 승인한다 — 오래된 카드가 다른 계획을 통과시키지 않는다.
    setPlanningPhase('switching');
    systemMessage('계획을 승인했습니다. 실행 단계로 전환 중입니다.');
    try {
      bridge.approvePlan(planId);
    } catch (err) {
      setPlanningPhase('awaiting-approval');
      systemMessage(`계획 승인 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function requestPlanRevision(planId: string): void {
    if (!planApprovable) return;
    try {
      bridge.requestPlanChanges(planId);
    } catch (err) {
      systemMessage(`수정 요청 실패: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    settlePlanAttention();
    setPlanningPhase('planning');
    systemMessage('수정 요청을 보냈습니다. 바꾸고 싶은 부분을 입력창에 적어 주세요.');
    updateComposer();
    input.focus();
  }

  /** 계획 관련 사이드바 이벤트. 처리했으면 true. */
  function handlePlanningSidebarEvent(e: SidebarEvent): boolean {
    switch (e.type) {
      case 'workflow-changed':
        workflowTransitionPending = false;
        applyWorkflow(e.workflow);
        setPlanningPhase(e.phase);
        if (e.workflow === 'plan' && planPermissionDefaultPending) {
          planPermissionDefaultPending = false;
          bridge.setPermissionProfile('unrestricted');
        } else if (e.workflow === 'direct') {
          planPermissionDefaultPending = false;
        }
        if ((e.workflow === 'plan' || e.workflow === 'question') && browserbaseNoticePending) {
          browserbaseNoticePending = false;
          systemMessage(BROWSERBASE_ENABLED_NOTICE);
        } else if (e.workflow === 'direct') {
          browserbaseNoticePending = false;
        }
        return true;
      case 'plan-ready':
        turnPresentedPlan = true;
        planCardPending = false;
        activePlan = e.plan;
        activePlanHistorical = false;
        planMinimized = false;
        planApprovable = true;
        recordPlan(e.plan);
        presentPlanInChat(e.plan);
        applyWorkflow(e.workflow);
        setPlanningPhase(e.phase);
        rebuildReview();
        // 전체 화면에서는 정리된 계획이 곧바로 옆 문서 패널로 열린다.
        if (fullscreen && planColCollapsed) setPlanColCollapsed(false);
        return true;
      case 'plan-approved':
        // 서버가 승인했다고 말한 계획이 지금 카드와 다르면 표시를 건드리지 않는다.
        if (activePlan && e.planId && e.planId !== activePlan.planId) return true;
        planApprovable = false;
        settlePlanAttention();
        setPlanningPhase(e.phase);
        return true;
      case 'implementation-started':
        planApprovable = false;
        settlePlanAttention();
        closePlanForExecution(e.planId || activePlan?.planId || '');
        setPlanningPhase(e.phase);
        rebuildReview();
        return true;
      case 'planning-document-saved':
        systemMessage('문서를 저장했습니다');
        return true;
      case 'plan-invalidated':
        planApprovable = false;
        settlePlanAttention();
        activePlanHistorical = activePlan !== null;
        setPlanningPhase(e.phase);
        if (e.reason !== 'document-saved') {
          systemMessage(
            e.reason
              ? `계획이 더 이상 유효하지 않습니다 (${e.reason}). 새 계획을 기다리세요.`
              : '계획이 더 이상 유효하지 않습니다. 새 계획을 기다리세요.',
          );
        }
        rebuildReview();
        return true;
      default:
        return false;
    }
  }

  /** 채팅 시작/재연결 시 브리지의 계획 상태와 다시 맞춘다. */
  function syncPlanningFromBridge(): void {
    const state = bridge.getWorkflowState();
    const samePlanId = (activePlan?.planId ?? null) === (state.latestPlan?.planId ?? null);
    const sameApproval = planApprovable === (state.latestPlan !== null && state.phase === 'awaiting-approval');
    if (chatWorkflow === state.workflow && planningPhase === state.phase && samePlanId && sameApproval) {
      return;
    }
    chatWorkflow = state.workflow;
    planningPhase = state.phase;
    planApprovable = false;
    activePlanHistorical = false;
    if (state.latestPlan) {
      recordPlan(state.latestPlan);
      if (state.phase === 'implementing') {
        closePlanForExecution(state.latestPlan.planId);
      } else {
        activePlan = state.latestPlan;
        planApprovable = state.phase === 'awaiting-approval';
      }
    }
    if (chatWorkflow === 'plan' || chatWorkflow === 'question') browserbaseAcknowledged = true;
    threadWorkflows.set(currentThread.id, chatWorkflow);
    updateWorkflowControl();
    updateComposer();
    rebuildReview();
  }

  /** 채팅 전환 — 모드·계획 기록은 표시용으로만 복원한다. */
  function restorePlanningForThread(threadId: string, thread?: ChatThread): void {
    planArchives.set(currentThread.id, planHistory);
    planHistory = planArchives.get(threadId) ?? [];
    const latestPlan = planHistory[planHistory.length - 1] ?? null;
    const latestPlanExecuted = latestPlan !== null
      && thread?.messages.some((message) => (
        message.kind === 'plan'
        && message.planId === latestPlan.planId
        && message.planState === 'executed'
      ));
    activePlan = latestPlanExecuted ? null : latestPlan;
    activePlanHistorical = false;
    planMinimized = false;
    planApprovable = false;
    chatWorkflow = threadWorkflows.get(threadId) ?? 'direct';
    planningPhase = chatWorkflow === 'plan'
      ? 'planning'
      : chatWorkflow === 'question'
        ? 'questioning'
        : 'direct';
    browserbaseAcknowledged = chatWorkflow === 'plan' || chatWorkflow === 'question';
    updateWorkflowControl();
    updateComposer();
    rebuildReview();
  }

  // ── 리뷰 카드 (change-set 승인/거절) ──────────────────
  function buildReviewCard(set: PendingChangeSet): HTMLElement {
    const editingLeaseActive = bridge.getEditingLease().active;
    const card = el('div', `ag-review-card ag-${set.agent}`);
    const summary = el('div', 'ag-review-summary');

    const title = el('div', 'ag-review-title');
    title.append(
      el('span', 'ag-review-title-text', `${AGENT_LABEL[set.agent]} 편집 대기`),
      el('span', 'ag-review-count', `${String(set.ops.length).padStart(2, '0')}건`),
    );
    summary.appendChild(title);
    for (const op of set.ops.slice(0, MAX_REVIEW_OP_LINES)) {
      summary.appendChild(buildReviewOp(op));
    }
    if (set.ops.length > MAX_REVIEW_OP_LINES) {
      summary.appendChild(
        el('div', 'ag-review-more', `외 ${set.ops.length - MAX_REVIEW_OP_LINES}건`),
      );
    }
    card.appendChild(summary);

    const actions = el('div', 'ag-review-actions');
    const approve = el('button', 'ag-approve ag-change-action');
    approve.type = 'button';
    approve.append(
      createIcon('check', 'ag-review-action-icon'),
      el('span', 'ag-review-action-label', '변경 수락'),
    );
    approve.disabled = editingLeaseActive;
    approve.addEventListener('click', () => {
      if (bridge.getEditingLease().active) return;
      approve.disabled = true;
      reject.disabled = true;
      try {
        bridge.pendingEdits.approve(set.id);
      } catch (err) {
        approve.disabled = false;
        reject.disabled = false;
        systemMessage(`승인 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const reject = el('button', 'ag-reject ag-change-action');
    reject.type = 'button';
    reject.append(
      createIcon('close', 'ag-review-action-icon'),
      el('span', 'ag-review-action-label', '변경 거절'),
    );
    reject.disabled = editingLeaseActive;
    reject.addEventListener('click', () => {
      if (bridge.getEditingLease().active) return;
      approve.disabled = true;
      reject.disabled = true;
      try {
        bridge.pendingEdits.reject(set.id);
      } catch (err) {
        approve.disabled = false;
        reject.disabled = false;
        systemMessage(`거절 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    actions.append(approve, reject);
    card.appendChild(actions);
    return card;
  }

  function updateComposerActivity(changeSets: readonly PendingChangeSet[]): void {
    const activeEdit = changeSets.find((set) => set.status === 'open');
    updateTurnPending(activeEdit?.agent);
  }

  function rebuildReview(): void {
    review.replaceChildren();
    planCardSlot.replaceChildren();
    // 계획과 문서 변경은 서로 다른 surface다. 긴 계획이 변경 목록을 밀어내지
    // 않고, 집중 모드의 환경 패널에서도 각각 독립적으로 열린다.
    const planShown = chatWorkflow === 'plan' && activePlan !== null;
    if (planShown && activePlan) {
      planCardSlot.appendChild(buildPlanCard(activePlan));
    }
    planSurface.hidden = !planShown;
    if (!planShown) {
      planMinimized = false;
      planColCollapsed = true;
    }
    const changeSets = bridge.pendingEdits.getChangeSets();
    const reviewSets = changeSets.filter((set) => set.status !== 'open');
    updateComposerActivity(changeSets);
    for (const set of reviewSets) {
      review.appendChild(buildReviewCard(set));
    }
    if (reviewSets.length === 0) {
      const empty = el('div', 'ag-review-empty');
      const emptyIcon = el('div', 'ag-review-empty-icon');
      emptyIcon.appendChild(createIcon('changes'));
      empty.append(
        emptyIcon,
        el('div', 'ag-review-empty-title', '변경 사항 없음'),
        el('div', 'ag-review-empty-copy', '에이전트가 문서를 수정하면 여기에서 원문과 변경 내용을 비교할 수 있습니다.'),
      );
      review.appendChild(empty);
    }
    applyPlanMinimizedState();
    updateReviewControl(changeSets);
  }

  // ── 구독 ──────────────────────────────────────────────
  const unsubBridge = bridge.onEvent(handleSidebarEvent);
  const unsubThreads = subscribeThreadChanges(() => {
    if (threadsListVisible()) rebuildThreadsList();
  });
  // 다른 탭의 채팅이 일을 시작하거나 끝내면 이 탭의 목록에도 불이 옮겨 붙는다.
  const unsubChatStatus = subscribeChatStatus(() => {
    if (threadsListVisible()) rebuildThreadsList();
  });
  void bridge.listTemplates().then((catalog) => {
    templateCatalog = catalog;
    activeTemplate = currentThread.activeTemplateId
      ? catalog.templates.find((template) => template.id === currentThread.activeTemplateId) ?? null
      : null;
    if (currentThread.activeTemplateId && !activeTemplate) {
      currentThread.activeTemplateId = null;
      bridge.setActiveTemplate(null);
      upsertThread(currentThread);
    }
    renderActiveTemplate();
    rebuildSlashMenu();
  }).catch(() => { /* WebSocket catalog event retries after reconnect. */ });
  const unsubPending = bridge.pendingEdits.onChange((e: PendingEditsChangeEvent) => {
    if (e.type === 'invalidated') {
      systemMessage(`대기 중인 에이전트 편집이 해제되었습니다 (${e.reason})`);
    }
    rebuildReview();
  });
  const unsubEditingLease = bridge.onEditingLeaseChange(() => rebuildReview());
  const contextUnsubs = eventBus
    ? [
        eventBus.on('document-context-changed', updateDocumentContext),
        eventBus.on('cursor-format-changed', updateDocumentContext),
        eventBus.on('picture-object-selection-changed', updateDocumentContext),
        eventBus.on('table-object-selection-changed', updateDocumentContext),
        eventBus.on('merge-resolver-lock-changed', (locked) => {
          mergeResolverLocked = locked === true;
          root.classList.toggle('ag-merge-resolver-locked', mergeResolverLocked);
          updateComposer();
        }),
        eventBus.on('versions:open', () => {
          setCollapsed(false);
          openConfiguredVersionControl();
        }),
        eventBus.on('settings:open', (payload) => {
          const requested = (payload as { destination?: unknown } | undefined)?.destination;
          const destination: SettingsDestination | undefined = requested === 'editing'
            || requested === 'ai'
            || requested === 'connections'
            ? requested
            : undefined;
          setCollapsed(false);
          setSettingsPanelOpen(true, destination);
        }),
      ]
    : [];

  // 초기 상태 반영
  setSelectedAgent(selectedAgent);
  setConnection(connState);
  setTurnRunning(turnRunning);
  updateWorkflowControl();
  updateDocumentContext();
  rebuildReview();

  /**
   * 인라인 프롬프트(문서 선택 위 입력 상자)에서 온 지시를 채팅으로 보낸다.
   * 말풍선에는 지시만 보이고, 에이전트에게는 선택 컨텍스트 블록을 함께 보낸다.
   */
  function sendInlinePrompt(submission: InlinePromptSubmission): InlinePromptSendResult {
    const prompt = submission.prompt.trim();
    if (!prompt) return { ok: false, reason: '지시를 입력해 주세요' };
    if (mergeResolverLocked) return { ok: false, reason: '병합 검토를 먼저 완료하거나 닫아 주세요' };
    if (readOnlyDocLabel !== null) return { ok: false, reason: '다른 문서의 채팅을 열람 중입니다' };
    if (cloudUi.isCloudConversation()) return { ok: false, reason: '클라우드 작업 중에는 사이드바에서 메시지를 대기열에 넣으세요' };
    if (connState !== 'connected') return { ok: false, reason: '에이전트 허브에 연결되어 있지 않습니다' };
    if (selectedAgent === 'rau' && !rauSetupComplete) {
      return { ok: false, reason: 'Rau 연결을 먼저 완료해 주세요' };
    }
    if (selectedAgent === 'rau' && rauCreditsEmpty()) {
      return { ok: false, reason: '체험 크레딧이 다 됐어요. 다른 모델을 연결해 주세요.' };
    }
    if (turnRunning) return { ok: false, reason: '에이전트가 응답 중입니다' };
    if (planningPhase === 'switching' || chatStartPendingThreadId !== null || attachmentsSending) {
      return { ok: false, reason: '잠시 후 다시 시도해 주세요' };
    }
    setCollapsed(false);
    if (threadsPanelOpen) setThreadsPanelOpen(false);
    if (skillsPanelOpen) setSkillsPanelOpen(false);
    if (settingsPanelOpen) setSettingsPanelOpen(false);
    if (versionsPanelOpen) setVersionsPanelOpen(false);
    // 승인 대기 중 입력은 계획 수정 의견으로 취급한다 (입력기와 같은 규칙).
    if (chatWorkflow === 'plan' && planningPhase === 'awaiting-approval') {
      setPlanningPhase('planning');
    }
    const userMessage = recordUserMessage(prompt, [], {
      label: submission.selection.label,
      excerpt: submission.selection.excerpt,
    });
    const userBubble = renderUserMessage(userMessage);
    followConversation = true;
    replyPending = true;
    appendConversation(userBubble);
    updateTurnPending(selectedAgent);
    scrollConversationToMessage(userBubble, { smooth: true });
    void bridge.sendUserMessage(`${submission.selection.contextBlock}\n\n${prompt}`);
    return { ok: true };
  }

  return {
    root,
    openVersions(): void {
      setCollapsed(false);
      openConfiguredVersionControl();
    },
    sendInlinePrompt,
    awaitPendingCloudTransferForClose() {
      return cloudTransferCloseWaiter?.promise ?? Promise.resolve();
    },
    dispose(): void {
      cloudTransferCloseWaiter?.reject(new Error('클라우드 전송을 기다리는 동안 사이드바가 닫혔습니다.'));
      cloudTransferCloseWaiter = null;
      unsubBridge();
      unsubThreads();
      unsubChatStatus();
      unsubPending();
      unsubEditingLease();
      unsubscribeHancomGitVisibility();
      contextUnsubs.forEach((unsub) => unsub());
      messagesMutationObserver?.disconnect();
      messagesResizeObserver?.disconnect();
      dockResizeObserver?.disconnect();
      messages.removeEventListener('scroll', onMessagesScroll);
      if (configHideTimer !== null) window.clearTimeout(configHideTimer);
      if (conversationScrollRaf !== null) {
        window.cancelAnimationFrame(conversationScrollRaf);
        conversationScrollRaf = null;
      }
      if (conversationScrollUnlock !== null) {
        window.clearTimeout(conversationScrollUnlock);
        conversationScrollUnlock = null;
      }
      if (deferredVersionsOpenTimer !== null) {
        window.clearTimeout(deferredVersionsOpenTimer);
        deferredVersionsOpenTimer = null;
      }
      window.removeEventListener('resize', measure);
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onDocKeyDown);
      cancelFsMotionTimers();
      endSidebarResize();
      endColumnResize();
      root.classList.remove('ag-col-resizing');
      clearInsetRecenterLoop();
      if (resizeMoveRaf !== null) {
        cancelAnimationFrame(resizeMoveRaf);
        resizeMoveRaf = null;
      }
      clearConnCountdown();
      writingStyleCalibration.dispose();
      settingsPanel.dispose();
      versionManagerPage?.dispose();
      versionController?.dispose?.();
      initialSetup?.dispose();
      clearAttachmentDrag();
      root.removeEventListener('dragenter', onAttachmentDragEnter);
      root.removeEventListener('dragover', onAttachmentDragOver);
      root.removeEventListener('dragleave', onAttachmentDragLeave);
      root.removeEventListener('drop', onAttachmentDrop);
      input.removeEventListener('paste', onAttachmentPaste);
      referenceLibrary.dispose();
      document.body.classList.remove(
        'ag-sidebar-open',
        'ag-sidebar-resizing',
        'ag-fullscreen-open',
        'ag-col-resizing',
      );
      sweepUnresolvedToolRows();
      collapseTab.remove();
      root.remove();
    },
  };
}
