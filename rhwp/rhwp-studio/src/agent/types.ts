/**
 * Agent bridge shared types (Pair-Editing Phase 1).
 *
 * Normative shapes shared by the studio bridge (bridge.ts / tool-executor.ts /
 * revision.ts), the pending-edit manager (pending-edits.ts / pending-overlay.ts)
 * and the sidebar UI (ui/agent-sidebar/). Wire shapes mirror the rhwp-agent hub
 * protocol v3.
 */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { DocumentDirtyState } from '../core/document-dirty-state.ts';

export const AGENT_PROTOCOL_VERSION = 3;

export type AgentName = 'claude' | 'codex' | 'pi' | 'grok' | 'cursor';
export type PermissionProfile = 'safe' | 'unrestricted';
export type WritingStyleLanguage = 'ko' | 'en';
export type WritingStyleProgressState =
  | 'queued'
  | 'reading'
  | 'extracting'
  | 'preparing'
  | 'analyzing'
  | 'synthesizing'
  | 'saving';
export type AgentWorkflow = 'direct' | 'plan';
export type AgentPhase = 'direct' | 'planning' | 'awaiting-approval' | 'switching' | 'implementing';

/** 에이전트 참고자료의 수명 범위. 파일 본문은 허브가 보관하며 브라우저에는 메타데이터만 둔다. */
export type ReferenceScope = 'chat' | 'document' | 'global';
export type ReferenceFileStatus = 'uploading' | 'extracting' | 'indexing' | 'ready' | 'error';

export interface ReferenceFile {
  id: string;
  scope: ReferenceScope;
  scopeId: string;
  name: string;
  mimeType: string;
  size: number;
  status: ReferenceFileStatus;
  createdAt: string;
  sha256?: string;
  chunkCount?: number;
  error?: string;
  kind: 'document' | 'image';
}

export interface StagedReference {
  id: string;
  scope: 'chat';
  scopeId: string;
  name: string;
  mimeType: string;
  size: number;
  status: 'ready';
  createdAt: string;
  expiresAt: string;
}

export interface MessageReferenceStatus {
  stageId: string;
  status: 'processing' | 'ready' | 'error';
  file?: ReferenceFile;
  error?: string;
}

export interface ReferenceSearchHit {
  referenceId: string;
  name: string;
  scope: ReferenceScope;
  scopeId: string;
  score: number;
  snippet: string;
  chunkIndex?: number;
  chunkId?: string;
  page?: number | null;
}

export interface ReferenceScopeContext {
  threadId: string;
  documentId: string | null;
  documentName?: string | null;
}

export interface DocumentTemplate {
  id: string;
  name: string;
  originalName: string;
  format: 'hwp' | 'hwpx';
  size: number;
  pageCount: number;
  sectionCount: number;
  contentHash: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateCatalog {
  revision: number;
  templates: DocumentTemplate[];
}

export interface StructuredPlanStep {
  title: string;
  details: string;
  files?: string[];
}

/** Server-authored plan. Its epoch is descriptive; capabilityEpoch is the write authority. */
export interface StructuredPlan {
  planId: string;
  title: string;
  goal: string;
  summary: string;
  assumptions: string[];
  decisions: string[];
  steps: StructuredPlanStep[];
  files: string[];
  validation: string[];
  risks: string[];
  exclusions: string[];
  createdAt: string;
  epoch: number;
}

export interface AgentWorkflowState {
  workflow: AgentWorkflow;
  phase: AgentPhase;
  /** null means the server did not provide a usable capability epoch. */
  capabilityEpoch: number | null;
  latestPlan: StructuredPlan | null;
}

export function isAgentWorkflow(value: unknown): value is AgentWorkflow {
  return value === 'direct' || value === 'plan';
}

export function isAgentPhase(value: unknown): value is AgentPhase {
  return value === 'direct'
    || value === 'planning'
    || value === 'awaiting-approval'
    || value === 'switching'
    || value === 'implementing';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isStructuredPlan(value: unknown): value is StructuredPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  return typeof plan['planId'] === 'string'
    && typeof plan['title'] === 'string'
    && typeof plan['goal'] === 'string'
    && typeof plan['summary'] === 'string'
    && isStringArray(plan['assumptions'])
    && isStringArray(plan['decisions'])
    && Array.isArray(plan['steps'])
    && plan['steps'].every((step) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
      const item = step as Record<string, unknown>;
      return typeof item['title'] === 'string'
        && typeof item['details'] === 'string'
        && (item['files'] === undefined || isStringArray(item['files']));
    })
    && isStringArray(plan['files'])
    && isStringArray(plan['validation'])
    && isStringArray(plan['risks'])
    && isStringArray(plan['exclusions'])
    && typeof plan['createdAt'] === 'string'
    && typeof plan['epoch'] === 'number'
    && Number.isSafeInteger(plan['epoch'])
    && plan['epoch'] >= 0;
}

export interface WritingStyleStatus {
  active: boolean;
  language: WritingStyleLanguage;
  updatedAt: string | null;
  sourceCount: number;
  pageEstimate: number;
  summary: string;
  additionalInstruction: string;
  /** 최근 캘리브레이션 프로바이더. 구형 허브에서는 빠질 수 있다. */
  agent?: AgentName;
  /** 최근 캘리브레이션 모델. 구형 허브에서는 빠질 수 있다. */
  model?: string;
  /** 누적 원고 메타데이터. 구형 허브는 개수만 제공한다. */
  sources?: WritingStyleSource[];
  sourceDocuments?: WritingStyleSource[];
  savedSourceCount?: number;
}

export interface WritingStyleSource {
  id?: string;
  name: string;
  type?: string;
  size?: number;
  addedAt?: string;
}

export interface WritingStyleProgress {
  state: WritingStyleProgressState;
  phase?: string;
  /** 사용자에게 보여도 되는 짧은 작업 이름. 내부 추론문은 포함하지 않는다. */
  activity?: string;
  /** 파일명·묶음 수 같은 안전한 작업 세부 정보. */
  detail?: string;
  /** 전체량을 서버가 실제로 아는 작업에서만 제공한다. */
  completed?: number;
  total?: number;
  agent?: AgentName;
  model?: string;
  startedAt?: string;
  elapsedMs?: number;
}

export interface WritingStyleCatalogModel {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string | null;
}

export interface WritingStyleCatalogProvider {
  id: AgentName;
  name: string;
  available: boolean;
  error: string | null;
  models: WritingStyleCatalogModel[];
}

export interface WritingStyleCatalog {
  providers: WritingStyleCatalogProvider[];
  defaultSelection: { agent: AgentName; model: string; effort?: string | null } | null;
}

export interface WritingStyleUpload {
  name: string;
  type: string;
  size: number;
  content: string;
}

/* ── 프로바이더 상태 · 사용량 (프로토콜 v2 추가분) ──────────
   허브가 로컬 CLI(claude/codex)의 설치 여부를 프로브해 provider-status 로,
   턴마다 기록한 토큰 사용량을 usage-report 로 보낸다. CLIProxyAPI 가 연결되어
   있으면 5시간·주간 percent 는 공식 요금제 값이다. 두 메시지는 요청
   응답으로도 오고(requestId), 연결 직후·턴 종료 후 밀어주기도 한다. */

/** 로컬 CLI 한 벌의 실행 가능 여부. */
export interface ProviderHealth {
  available: boolean;
  version: string | null;
  error: string | null;
  /** epoch ms */
  checkedAt: number;
}

export type ProviderStatusMap = Record<AgentName, ProviderHealth>;

export type AgentAuthMethod = 'oauth' | 'api-key';

export interface AgentSetupStatus {
  agent: AgentName;
  /** App-managed or already present on PATH. */
  available: boolean;
  /** Available and authenticated/configured for use. */
  connected: boolean;
  installed: boolean;
  installing: boolean;
  version: string | null;
  authenticated: boolean;
  authMethod: AgentAuthMethod | null;
  keyTail: string | null;
  authenticating: boolean;
  setupComplete: boolean;
  latestVersion: string | null;
  updateRequired: boolean;
  error: string | null;
  /**
   * CLI 가 직접 알려 주는 모델 목록 — 지금은 cursor 만 보낸다
   * (`cursor-agent --list-models`). 로그인 전이거나 조회에 실패하면 빈 배열.
   */
  models?: readonly string[];
}

export type AgentSetupStatusMap = Record<AgentName, AgentSetupStatus>;

export interface AgentSetupAuthStart {
  agent: AgentName;
  authUrl: string | null;
}

/** 요금제 — 한도 계산의 기준이 되므로 프로바이더별로 값이 다르다. */
export type ClaudeUsagePlan = 'pro' | 'max5x' | 'max20x' | 'api';
export type CodexUsagePlan = 'plus' | 'pro' | 'api';
/** pi · grok · cursor 는 사용량 기반 API 한 가지뿐이다. */
export type ApiOnlyUsagePlan = 'api';
export type UsagePlan = ClaudeUsagePlan | CodexUsagePlan | ApiOnlyUsagePlan;

/** 한 창(세션 5시간 / 오늘 / 주간)의 누적치. percent 는 한도가 없으면 null. */
export interface UsageWindow {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  weightedTokens: number;
  /** 0–100 (초과 가능, 소수 첫째 자리). 한도가 없으면 null. */
  percent: number | null;
  /** epoch ms — CLIProxyAPI 가 알려 준 창 리셋 시각. */
  resetsAt?: number | null;
}

/** 5시간·주간 막대의 출처. cliproxy 는 공식 요금제 %, estimate 는 로컬 추정치. */
export type UsageSource = 'estimate' | 'cliproxy';

export interface CliproxyWindow {
  percent: number | null;
  resetsAt: number | null;
}

export interface CliproxyAccount {
  agent: AgentName;
  name: string;
  email: string | null;
  planType: string | null;
  session: CliproxyWindow;
  week: CliproxyWindow;
  error: string | null;
}

export interface CliproxyStatus {
  configured: boolean;
  connected: boolean;
  url: string | null;
  error: string | null;
  checkedAt: number | null;
  accounts: CliproxyAccount[];
}

export interface UsageModelBreakdown {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  weightedTokens: number;
  /** USD — pi(OpenRouter) 모델만 온다. */
  costUsd?: number;
}

export interface ProviderUsage {
  session: UsageWindow;
  day: UsageWindow;
  week: UsageWindow;
  byModel: Record<string, UsageModelBreakdown>;
  limit: { session5h: number | null; week: number | null };
  /** epoch ms — 마지막으로 사용량이 기록된 시각. */
  updatedAt: number | null;
  source?: UsageSource;
}

export interface UsageSummary {
  plans: Record<AgentName, string>;
  providers: Record<AgentName, ProviderUsage>;
  cliproxy?: CliproxyStatus;
  /** pi(OpenRouter) 가 설정돼 있을 때만 온다. */
  openrouter?: OpenRouterCredits;
}

/** pi 사용자가 OpenRouter 카탈로그에서 고른 모델 하나 (최대 3개). */
export interface PiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  supportsImages: boolean;
  efforts: string[];
  defaultEffort: string;
  contextLength: number;
  pricing: { prompt: number; completion: number };
}

/** OpenRouter 라이브 카탈로그 항목 — 모델 선택 UI 의 검색 결과. */
export interface PiCatalogModel {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  pricing: { prompt: number; completion: number };
  reasoning: boolean;
  supportsImages: boolean;
}

/** pi 하네스(설치 · 키 · 모델) 설정 상태. */
export interface PiStatus {
  installed: boolean;
  installing: boolean;
  version: string | null;
  keyConfigured: boolean;
  keyTail: string | null;
  models: PiModelConfig[];
  defaultModelId: string | null;
  setupComplete: boolean;
  latestVersion: string | null;
  updateRequired: boolean;
  error: string | null;
}

/** OpenRouter 잔액 — pi 사용량 카드에 표시. */
export interface OpenRouterCredits {
  balanceUsd: number;
  totalCreditsUsd: number;
  totalUsageUsd: number;
  /** epoch ms */
  checkedAt: number | null;
  error: string | null;
}

export type CheckpointTitleChange = 'added' | 'removed' | 'modified';
export type CheckpointTitleProvider = 'pi' | 'codex' | 'grok' | 'claude';

export interface CheckpointTitleSummaryItem {
  change: CheckpointTitleChange;
  objectType: string;
  heading?: string;
  snippet?: string;
}

export interface CheckpointTitleSummary {
  totals: {
    added: number;
    removed: number;
    modified: number;
  };
  items: CheckpointTitleSummaryItem[];
}

export interface CheckpointTitleRequest {
  commitId: string;
  titleRevision: number;
  appLanguage: string;
  summary: CheckpointTitleSummary;
}

export interface CheckpointTitleResult {
  commitId: string;
  titleRevision: number;
  title: string;
  provider: CheckpointTitleProvider;
  model: string;
}

export function isClaudeUsagePlan(value: unknown): value is ClaudeUsagePlan {
  return value === 'pro' || value === 'max5x' || value === 'max20x' || value === 'api';
}

export function isCodexUsagePlan(value: unknown): value is CodexUsagePlan {
  return value === 'plus' || value === 'pro' || value === 'api';
}

export function isApiOnlyUsagePlan(value: unknown): value is ApiOnlyUsagePlan {
  return value === 'api';
}

/** 프로바이더마다 허용 요금제가 다르다 — 표로 갈라 새 프로바이더가 조용히 섞이지 않게 한다. */
const USAGE_PLAN_GUARDS: Record<AgentName, (value: unknown) => boolean> = {
  claude: isClaudeUsagePlan,
  codex: isCodexUsagePlan,
  pi: isApiOnlyUsagePlan,
  grok: isApiOnlyUsagePlan,
  cursor: isApiOnlyUsagePlan,
};

export function isUsagePlanForAgent(agent: AgentName, value: unknown): boolean {
  return USAGE_PLAN_GUARDS[agent](value);
}

export interface ProductSkillFile {
  path: string;
  size?: number;
  encoding?: 'utf8' | 'base64';
  content?: string;
}

export type ProductSkillIcon = 'pencil' | 'bot' | 'system';

export interface ProductSkill {
  name: string;
  description: string;
  /** Optional for compatibility with skills created before icon selection. */
  icon?: ProductSkillIcon;
  origin: 'bundled' | 'user';
  enabled: boolean;
  required?: boolean;
  invalid?: boolean;
  hasScripts: boolean;
  hasAssets: boolean;
  fileCount: number;
  files: ProductSkillFile[];
}

export interface SkillCatalog {
  revision: number;
  skills: ProductSkill[];
}

export class AgentToolError extends Error {
  // 파라미터 프로퍼티 대신 명시적 할당 (node --test strip-only 모드 호환).
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AgentToolError';
  }
}

/** 서브에이전트/워크플로 task 이벤트가 싣는 사용량 요약. */
export interface AgentTaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** 워크플로 phase (Workflow 스크립트의 phase() 호출). */
export interface AgentTaskPhase {
  index: number;
  title: string;
}

/** 워크플로 멤버 에이전트 스냅샷 (task-progress 의 members). */
export interface AgentTaskMember {
  index: number;
  label: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  phaseIndex?: number;
  model?: string;
  tokens?: number;
  toolCalls?: number;
  activity?: string;
}

/**
 * 하위 CLI(claude/codex) JSONL을 허브가 정규화한 단일 이벤트 스트림 (§1.5).
 * parentTaskId: 서브에이전트/워크플로가 낸 이벤트를 스폰한 task 에 귀속시키는
 * 선택 필드 — 있으면 그 task 카드로, 모르는 id 면 루트 활동 그룹으로 그린다.
 */
export type AgentStreamEvent =
  | { type: 'turn-start'; agent: AgentName }
  | { type: 'session-info'; agent: AgentName; sessionId: string; model?: string; mcpStatus?: string }
  | { type: 'text-delta'; agent: AgentName; text: string; parentTaskId?: string }
  | { type: 'tool-call'; agent: AgentName; callId: string; tool: string; argsJson: string; parentTaskId?: string }
  | { type: 'tool-result'; agent: AgentName; callId: string; ok: boolean; resultPreview: string; parentTaskId?: string }
  | { type: 'task-start'; agent: AgentName; taskId: string; callId?: string; title: string; role?: string; taskKind: 'agent' | 'workflow'; workflowName?: string; /** Owning turn may end while this real process keeps running. */ background?: boolean }
  | { type: 'task-progress'; agent: AgentName; taskId: string; activity?: string; lastTool?: string; usage?: AgentTaskUsage; phases?: AgentTaskPhase[]; members?: AgentTaskMember[]; /** Current task-level phase when there is no child member row. */ phaseIndex?: number }
  | { type: 'task-end'; agent: AgentName; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary?: string; usage?: AgentTaskUsage }
  | { type: 'turn-end'; agent: AgentName; stopReason?: string; errorMessage?: string }
  | { type: 'error'; agent: AgentName; message: string };

export type SidebarEvent =
  | {
      type: 'connection';
      state: 'connecting' | 'connected' | 'disconnected' | 'replaced';
      /** 지금까지 실패한 연결 시도 수 (0 = 첫 시도가 진행 중). */
      attempt?: number;
      /** 다음 자동 재시도까지 남은 시간 — 재시도가 예약된 'disconnected' 에만 온다. */
      retryInMs?: number;
    }
  | {
      type: 'chat-started';
      agent: AgentName;
      sessionId: string | null;
      model?: string;
      effort?: string;
      permissionProfile?: PermissionProfile;
      threadId?: string;
      documentId?: string | null;
      documentName?: string | null;
      workflow: AgentWorkflow;
      phase: AgentPhase;
      capabilityEpoch: number | null;
      latestPlan: StructuredPlan | null;
    }
  | { type: 'chat-stopped' }
  | { type: 'reference-status'; messageId: string; attachments: MessageReferenceStatus[] }
  | { type: 'templates-catalog'; catalog: TemplateCatalog; change?: { type: 'added' | 'renamed' | 'replaced' | 'deleted'; template: DocumentTemplate } }
  | { type: 'chat-template-changed'; template: DocumentTemplate | null; reason?: string }
  | { type: 'permission-changed'; permissionProfile: PermissionProfile }
  | ({ type: 'workflow-changed' } & AgentWorkflowState)
  | ({ type: 'plan-ready'; plan: StructuredPlan } & AgentWorkflowState)
  | ({ type: 'plan-approved'; planId: string } & AgentWorkflowState)
  | ({ type: 'plan-invalidated'; planId: string | null; reason?: string } & AgentWorkflowState)
  | ({ type: 'implementation-started'; planId: string } & AgentWorkflowState)
  | { type: 'skills-catalog'; catalog: SkillCatalog }
  | { type: 'skill-detail'; requestId: string; revision: number; skill: ProductSkill }
  | { type: 'skill-saved'; requestId: string; revision: number; skill: ProductSkill }
  | { type: 'skill-validated'; requestId: string; result: { valid: boolean; name: string; warnings: string[]; hasScripts: boolean; hasAssets: boolean; fileCount: number } }
  | { type: 'skill-deleted'; requestId: string; name: string; recoverable: boolean }
  | { type: 'skill-draft-progress'; requestId: string; state: 'generating' }
  | { type: 'skill-draft-result'; requestId: string; draft: { name: string; files: Array<{ path: string; content: string }> } }
  | { type: 'skills-error'; requestId: string; code: string; message: string }
  | { type: 'writing-style-status'; requestId: string; status: WritingStyleStatus }
  | ({ type: 'writing-style-progress'; requestId: string } & WritingStyleProgress)
  | { type: 'writing-style-result'; requestId: string; status: WritingStyleStatus }
  | { type: 'writing-style-error'; requestId: string; code: string; message: string }
  | { type: 'writing-style-catalog'; requestId: string; catalog: WritingStyleCatalog }
  | { type: 'provider-status'; providers: ProviderStatusMap }
  | { type: 'agent-setup-status'; statuses: AgentSetupStatusMap }
  | {
      type: 'agent-setup-progress';
      agent: AgentName;
      state: 'installing' | 'authorizing' | 'done';
      phase?: 'preparing' | 'resolving' | 'downloading' | 'installing' | 'configuring' | 'verifying' | 'done';
      percent?: number;
      detail?: string;
      authUrl?: string;
      /** 기기 인증 코드 — 브라우저에서 확인시켜야 하는 CLI(codex · grok)에만 온다. */
      userCode?: string;
      activity?: boolean;
      receivedBytes?: number;
      totalBytes?: number;
    }
  | { type: 'agent-setup-error'; agent: AgentName | null; code: string; message: string }
  | { type: 'usage-report'; usage: UsageSummary }
  | { type: 'pi-status'; status: PiStatus }
  | {
      type: 'pi-setup-progress';
      requestId: string;
      state: 'preparing' | 'downloading' | 'installing' | 'configuring' | 'verifying' | 'done';
      /** 전체 설치 흐름의 0–100 단계 가중 진행률. */
      percent?: number;
      detail?: string;
      /** 내려받은 바이트 — 있으면 결정적 진행률을 그릴 수 있다. */
      receivedBytes?: number;
      /** 전체 바이트 — 서버가 크기를 알려주지 않으면 빠진다. */
      totalBytes?: number;
      /** 숫자 없는 "일이 진행 중" 신호 — 움직이는 막대를 깨우는 용도. */
      activity?: boolean;
    }
  | { type: 'pi-catalog'; requestId: string; models: PiCatalogModel[] }
  | { type: 'pi-error'; requestId: string; code: string; message: string }
  | {
      type: 'title-result';
      requestId: string;
      threadId: string;
      title: string | null;
    }
  | { type: 'agent'; event: AgentStreamEvent }
  | { type: 'hub-error'; code: string; message: string };

export interface AgentBridgeDeps {
  wasm: WasmBridge;
  eventBus: EventBus;
  inputHandler: InputHandler;
  canvasView: CanvasView;
  documentState: DocumentDirtyState;
  isReadOnly?: () => boolean;
}

export interface AgentBridgeOptions {
  /** Browser/dev override. Electron always uses the preload session context. */
  url?: string;
  token?: string;
  launchId?: string;
  sessionId?: string;
}

export interface DocPoint {
  paraIdx: number;
  charOffset: number;
}

/**
 * 표 셀 주소 (최상위 표만 — 중첩 표는 Phase-1 범위 밖).
 * paraIdx = 표 컨트롤을 담은 본문 문단, cellIdx = flat 셀 인덱스.
 */
export interface CellAddr {
  paraIdx: number;
  controlIdx: number;
  cellIdx: number;
}

export function sameCell(a: CellAddr | undefined, b: CellAddr | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.paraIdx === b.paraIdx && a.controlIdx === b.controlIdx && a.cellIdx === b.cellIdx;
}

export interface DocRange {
  sectionIdx: number;
  /** 존재하면 startParaIdx/endParaIdx 는 이 셀 내부 문단 인덱스다 */
  cell?: CellAddr;
  startParaIdx: number;
  startCharOffset: number;
  endParaIdx: number;
  endCharOffset: number;
}

export interface CharFormatProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** pt*100 (HwpUnit) */
  fontSize?: number;
  /** '#RRGGBB' */
  textColor?: string;
  /** findOrCreateFontId 로 해석된 숫자 id (fontFamily 는 executor 에서 변환) */
  fontId?: number;
}

/**
 * pending 구조 op 요약 — executor 의 PENDING_DESTRUCTIVE_OP 가드가 쓴다.
 * flat cellIdx 는 행 우선(row-major)이라, 영향 행보다 앞선 행의 셀은 번호가 그대로다.
 * 그래서 행 단위 op 만 affectedRow 를 채우고 열/병합/표 삭제는 null 로 둔다.
 */
export interface PendingStructureOpInfo {
  /** 'insert_row' | 'delete_row' | 'insert_col' | ... | 'delete_table' */
  op: string;
  /** 행 단위 op 이 건드리는 행 인덱스. 행 단위가 아니면 null (= 표 전체 차단) */
  affectedRow: number | null;
}

/** 표 등 컨트롤 앵커 — replay 후 재바인딩된다 */
export interface ObjectAnchor {
  paraIdx: number;
  controlIdx: number;
  /** 앵커 문단 내 삽입 지점 (shiftPoint 통과용; 모르면 0) */
  charOffset: number;
}

/**
 * 객체 연산 (Pair-Editing Phase 2). 데이터 전용 — apply/revert/verify 는
 * pending-edits 의 switch 가 수행한다.
 *
 * 분류(설계 리뷰 확정):
 * - applied-now(즉시 적용, reject 시 역연산): createTable(treatAsChar 경로),
 *   insertImage, insertEquation, tableStructure(insert_row/col), paraFormat, pageLayout,
 *   headerFooter(신규 생성일 때)
 * - mark-only(approve 시 적용): tableStructure(delete_row/col/merge_cells/split_cell),
 *   deleteTable(표 전체 삭제), setCellProps, setTableProps, setColumnWidths, fitToPage,
 *   setZoneProps, applyFormula, setCaption, applyStyle, headerFooter(기존 HF 수정)
 */
export type ObjectOp =
  | {
      type: 'createTable';
      sectionIdx: number; paraIdx: number; charOffset: number;
      rows: number; cols: number;
      colWidthsHu?: number[];
      headerRow: boolean; headerBold: boolean; headerFill?: string;
      cells?: string[][];
      anchor?: ObjectAnchor;
      /** 드리프트 프로브 기준 크기 — 같은 pending 상태의 구조 op 이 적용/되돌려질 때 갱신 */
      expectedRows?: number;
      expectedCols?: number;
    }
  | {
      type: 'insertImage';
      sectionIdx: number; paraIdx: number; charOffset: number;
      bytes: Uint8Array; extension: string;
      widthHu: number; heightHu: number;
      naturalWidthPx: number; naturalHeightPx: number;
      description: string;
      anchor?: ObjectAnchor;
    }
  | {
      type: 'insertEquation';
      sectionIdx: number; paraIdx: number; charOffset: number;
      /** 존재하면 paraIdx 는 이 셀 내부 문단 인덱스, anchor.controlIdx 는 셀 문단 내 수식 인덱스 */
      cell?: CellAddr;
      script: string; fontSizeHu: number; colorRef: number;
      anchor?: ObjectAnchor;
    }
  | {
      type: 'tableStructure';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      op: 'insert_row' | 'insert_col';
      index: number; after: boolean;
      /** 적용 후 역연산용 삽입 결과 인덱스 (after ? index+1 : index) */
      insertedIndex?: number;
      /** 드리프트 프로브용 적용 직후 크기 */
      dims?: { rowCount: number; colCount: number };
    }
  | {
      type: 'tableStructureMarked';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      op: 'delete_row' | 'delete_col' | 'merge_cells' | 'split_cell';
      rowIdx?: number; colIdx?: number;
      startRow?: number; startCol?: number; endRow?: number; endCol?: number;
      splitRows?: number; splitCols?: number;
      /** 마크 시점 크기 — 드리프트 프로브 */
      dims: { rowCount: number; colCount: number };
    }
  | {
      /** 표 전체 삭제 — mark-only, 승인 시 wasm.deleteTableControl */
      type: 'deleteTable';
      sectionIdx: number;
      tableParaIdx: number;
      controlIdx: number;
      dims: { rowCount: number; colCount: number };
    }
  | {
      type: 'setCellProps';
      sectionIdx: number; tableParaIdx: number; controlIdx: number; cellIdx: number;
      props: Record<string, unknown>;
      dims: { rowCount: number; colCount: number };
    }
  | {
      type: 'setTableProps';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      props: Record<string, unknown>;
      dims: { rowCount: number; colCount: number };
    }
  | {
      /** 열 폭 절대 지정 — mark-only, 승인 시 wasm.setTableColumnWidths */
      type: 'setColumnWidths';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      /** HWPUNIT 열 폭 — 길이는 마크 시점 열 수와 같다 */
      widthsHu: number[];
      dims: { rowCount: number; colCount: number };
    }
  | {
      /** 본문 폭 맞춤(축소 전용) — mark-only, 승인 시 wasm.fitTableToPage */
      type: 'fitToPage';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      dims: { rowCount: number; colCount: number };
    }
  | {
      /** 셀 범위 테두리/배경 — mark-only, 승인 시 wasm.setCellZoneProperties */
      type: 'setZoneProps';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      range: { startRow: number; startCol: number; endRow: number; endCol: number };
      props: Record<string, unknown>;
      dims: { rowCount: number; colCount: number };
    }
  | {
      /** 계산식 결과 입력 — mark-only, 승인 시 wasm.evaluateTableFormulaEx(writeResult) */
      type: 'applyFormula';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      row: number; col: number;
      formula: string;
      format?: { decimalPlaces?: number; thousandsSeparator?: boolean; prefix?: string; suffix?: string };
      /** 오버레이 대상 셀 (마크 시점 해석) */
      cellIdx?: number;
      dims: { rowCount: number; colCount: number };
    }
  | {
      /** 표 캡션 글 — mark-only, 승인 시 wasm.setTableCaptionText */
      type: 'setCaption';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      text: string;
      withNumber: boolean;
      dims: { rowCount: number; colCount: number };
    }
  | {
      type: 'paraFormat';
      sectionIdx: number; paraIdx: number; cell?: CellAddr;
      propsJson: string;
      /** applied-now 역연산: 문단별 이전 para_shape_id */
      prevParaShapeId: number;
      charOffset: number;
      /** 드리프트 프로브용 문단 텍스트 지문 (등록 시점 앞 24자) */
      textSample?: string;
    }
  | {
      type: 'applyStyle';
      sectionIdx: number; paraIdx: number; cell?: CellAddr;
      styleId: number;
      charOffset: number;
      /** 드리프트 프로브용 문단 텍스트 지문 (등록 시점 앞 24자) */
      textSample?: string;
    }
  | {
      type: 'pageLayout';
      sectionIdx: number;
      pageDef?: { next: Record<string, unknown>; prev: Record<string, unknown> };
      columns?: {
        next: { columnCount: number; columnType: number; sameWidth: number; spacing: number };
        prev: { columnCount: number; columnType: number; sameWidth: number; spacing: number };
      };
    }
  | {
      type: 'headerFooter';
      sectionIdx: number; isHeader: boolean; applyTo: number;
      text: string;
      /** 'left'|'center'|'right' 위치의 쪽 번호 필드 추가 */
      pageNumber?: string;
      /** false = 이 op 이 HF 를 생성했다 (reject 시 삭제) */
      existedBefore: boolean;
    }
  | {
      type: 'insertNote';
      noteKind: 'footnote' | 'endnote';
      sectionIdx: number; paraIdx: number; charOffset: number;
      /** 각주/미주 내용 (단일 문단) */
      text: string;
      anchor?: ObjectAnchor;
      /** 적용 시 부여된 번호 (응답용) */
      number?: number;
      /**
       * 적용 직후 실제 각주 텍스트 — 엔진이 기본 내용(공백 등)을 덧붙일 수 있어
       * 드리프트 검증은 요청 텍스트가 아니라 이 값과 비교한다.
       */
      appliedText?: string;
    }
  | {
      type: 'setNoteText';
      sectionIdx: number; paraIdx: number; controlIdx: number;
      text: string;
      /** applied-now 역연산용 이전 내용 (적용 시 캡처) */
      prevText?: string;
    }
  | {
      type: 'bookmark';
      op: 'add' | 'delete' | 'rename';
      sectionIdx: number; paraIdx: number;
      /** add 전용 삽입 지점 */
      charOffset?: number;
      /** delete/rename 대상 컨트롤 (적용 시 add 도 채워진다) */
      ctrlIdx?: number;
      /** add/rename 의 새 이름 */
      name?: string;
      /** delete/rename 역연산용 이전 상태 (적용 시 캡처) */
      prev?: { name: string; para: number; charPos: number; ctrlIdx: number };
    };

/** applied-now 인지 mark-only 인지 — 분류는 op 데이터에서 유도된다 */
export function isObjectOpApplied(obj: ObjectOp): boolean {
  switch (obj.type) {
    case 'createTable':
    case 'insertImage':
    case 'insertEquation':
    case 'tableStructure':
    case 'paraFormat':
    case 'pageLayout':
    case 'insertNote':
    case 'setNoteText':
    case 'bookmark':
      return true;
    case 'headerFooter':
      return !obj.existedBefore;
    default:
      return false;
  }
}

/** 이 객체 op 이 해당 표에 대한 파괴적 마크인가 (executor 가드용) */
export function isDestructiveTableMark(
  obj: ObjectOp, sectionIdx: number, tableParaIdx: number, controlIdx: number,
): boolean {
  return (obj.type === 'tableStructureMarked' || obj.type === 'deleteTable')
    && obj.sectionIdx === sectionIdx
    && obj.tableParaIdx === tableParaIdx
    && obj.controlIdx === controlIdx;
}

export type PendingOp =
  | {
      /** 템플릿 구조 전송 — 전체 문서 스냅샷으로 정확히 되돌리는 applied-now 연산 */
      kind: 'template';
      id: string;
      agent: AgentName;
      label: string;
      templateRevision: number;
      snapshotId: number | null;
      userEditSeqAtSnapshot: number;
      report: { warnings: string[]; skippedFeatures: string[]; affectedSections: number[] };
      seq?: number;
    }
  | {
      kind: 'insert'; id: string; agent: AgentName; range: DocRange; text: string;
      /** 전역 등록 순번 — 중첩 검증·스냅샷 되돌림 안전 판별용 (pending-edits 가 부여) */
      seq?: number;
    } // applied
  | {
      kind: 'delete'; id: string; agent: AgentName; range: DocRange; text: string;
      seq?: number;
    } // marked only
  | {
      /** 원자적 교체 — 삭제+삽입을 하나의 op 로 즉시 적용 (live preview) */
      kind: 'replace';
      id: string;
      agent: AgentName;
      /** 삽입된 새 텍스트가 차지하는 범위 (shift 로 추적된다) */
      range: DocRange;
      /** 새 텍스트 */
      text: string;
      /** 원본 텍스트 — 되돌림 복원/검증 기준 */
      deletedText: string;
      /** 원본 시작 지점 글자 모양 id (삽입 서식 + 폴백 되돌림용) */
      charShapeId: number | null;
      /** 원본 문단별 paraShapeId (폴백 되돌림용, -1 = 캡처 실패) */
      paraShapeIds: number[];
      /** 변이 직전 스냅샷 — 되돌림 시 원본을 정확히 복원하는 소스 */
      snapshotId: number | null;
      /**
       * 스냅샷을 찍은 시점의 사용자(비-에이전트) 편집 카운터. 되돌림 시점 값과
       * 다르면 스냅샷 복원이 그 사용자 편집을 지우므로 역연산 폴백을 쓴다.
       */
      userEditSeqAtSnapshot?: number;
      seq?: number;
    } // applied
  | {
      kind: 'format';
      id: string;
      agent: AgentName;
      range: DocRange;
      format: CharFormatProps;
      inverse: CharFormatProps;
      /** 되돌림 전 드리프트 프로브용 등록 시점 범위 텍스트 (캡처 실패 시 생략) */
      text?: string;
      seq?: number;
    } // applied
  | {
      kind: 'field'; id: string; agent: AgentName; name: string; oldValue: string; newValue: string;
      seq?: number;
    } // applied
  | { kind: 'object'; id: string; agent: AgentName; obj: ObjectOp; seq?: number }; // applied 여부는 isObjectOpApplied(obj)

export type ChangeSetStatus = 'open' | 'awaiting-review';

export interface PendingChangeSet {
  id: string;
  agent: AgentName;
  status: ChangeSetStatus;
  ops: PendingOp[];
  createdAt: number;
}

export type PendingEditsChangeEvent =
  | { type: 'ops-changed' }
  | { type: 'set-finalized'; changeSetId: string }
  | { type: 'approved'; changeSetId: string }
  | { type: 'rejected'; changeSetId: string }
  | { type: 'invalidated'; reason: string };
