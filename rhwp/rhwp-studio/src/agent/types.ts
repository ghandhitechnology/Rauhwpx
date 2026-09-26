/**
 * Agent bridge shared types (Pair-Editing Phase 1).
 *
 * Normative shapes shared by the studio bridge (bridge.ts / tool-executor.ts /
 * revision.ts), the pending-edit manager (pending-edits.ts / pending-overlay.ts)
 * and the sidebar UI (ui/agent-sidebar/). Wire shapes mirror the rhwp-agent hub
 * protocol v5.
 */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { DocumentDirtyState } from '../core/document-dirty-state.ts';
import type { CellPathEntry, CharShapeRun } from '../core/types.ts';
import type { CatalogAgent, ModelCatalogEntry } from './models.ts';

export const AGENT_PROTOCOL_VERSION = 5;

export type AgentName = 'claude' | 'codex' | 'pi' | 'grok' | 'cursor' | 'opencode' | 'rau';

/** 활성 턴에서 파생되는 사용자 편집 잠금 상태. */
export interface AgentEditingLease {
  active: boolean;
  agent: AgentName;
  waitingForUser?: boolean;
}
export type PermissionProfile = 'safe' | 'unrestricted';
/** Codex Fast 서비스 티어. 다른 프로바이더는 항상 standard. */
export type ServiceTier = 'standard' | 'fast';
export type WritingStyleLanguage = 'ko' | 'en';
export type WritingStyleProgressState =
  | 'queued'
  | 'reading'
  | 'extracting'
  | 'preparing'
  | 'analyzing'
  | 'synthesizing'
  | 'saving';
export type AgentWorkflow = 'direct' | 'plan' | 'question';
export type AgentPhase = 'direct' | 'planning' | 'questioning' | 'awaiting-approval' | 'switching' | 'implementing';

export type UserQuestionMode = 'single' | 'multiple';

export interface UserQuestionOption {
  id: string;
  label: string;
  description: string;
}

export interface UserQuestion {
  id: string;
  header: string;
  question: string;
  mode: UserQuestionMode;
  options: UserQuestionOption[];
  allowOther: boolean;
}

export interface UserQuestionAnswer {
  selectedOptionIds: string[];
  otherText?: string;
}

export type UserQuestionOutcome =
  | { status: 'answered'; answers: Record<string, UserQuestionAnswer> }
  | { status: 'cancelled'; reason: 'user-stop' }
  | { status: 'expired'; reason: 'provider-disconnected' | 'hub-restarted' | 'request-invalidated' };

export interface UserQuestionInteraction {
  interactionId: string;
  providerRequestId: string;
  threadId: string;
  turnId: string;
  agent: AgentName;
  source: 'native' | 'mcp';
  createdAt: string;
  updatedAt: string;
  questions: UserQuestion[];
}

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

/** Rauhwpx가 별도 보관하고 이 앱의 채팅에만 주입하는 AGENTS.md. */
export interface AgentInstructionsStatus {
  fileName: 'AGENTS.md';
  content: string;
  revision: number;
  updatedAt: string | null;
  maxChars: number;
  scope: 'rauhwpx-app';
}

/** 에이전트가 제안했지만 사용자가 아직 승인하지 않은 앱 지시 변경안. */
export interface AgentInstructionsDraft {
  id: string;
  content: string;
  expectedRevision: number;
  reason: string | null;
  requestedBy: string;
  createdAt: string;
  expiresAt: string;
  /** Studio만 받는 단기·일회용 승인 capability. */
  confirmationToken: string;
}

export interface StructuredPlanStep {
  id?: string;
  title: string;
  details: string;
  target?: string;
  preview?: string;
  files?: string[];
}

export interface PlanSource {
  title: string;
  url?: string;
  fileId?: string;
  chunkId?: string;
  note?: string;
}

export interface PlanExecution {
  status: 'running' | 'awaiting-review' | 'completed' | 'blocked' | 'interrupted';
  steps: Array<{
    stepId: string;
    status: 'pending' | 'in-progress' | 'completed' | 'blocked';
    note?: string;
  }>;
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
  revision?: number;
  previousPlanId?: string;
  changeSummary?: string;
  documentRevision?: number;
  sources?: PlanSource[];
  execution?: PlanExecution;
}

export interface AgentWorkflowState {
  workflow: AgentWorkflow;
  phase: AgentPhase;
  /** null means the server did not provide a usable capability epoch. */
  capabilityEpoch: number | null;
  latestPlan: StructuredPlan | null;
}

export function isAgentWorkflow(value: unknown): value is AgentWorkflow {
  return value === 'direct' || value === 'plan' || value === 'question';
}

export function isAgentPhase(value: unknown): value is AgentPhase {
  return value === 'direct'
    || value === 'planning'
    || value === 'questioning'
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
        && ['id', 'target', 'preview'].every((key) => item[key] === undefined || typeof item[key] === 'string')
        && (item['files'] === undefined || isStringArray(item['files']));
    })
    && isStringArray(plan['files'])
    && isStringArray(plan['validation'])
    && isStringArray(plan['risks'])
    && isStringArray(plan['exclusions'])
    && typeof plan['createdAt'] === 'string'
    && typeof plan['epoch'] === 'number'
    && Number.isSafeInteger(plan['epoch'])
    && plan['epoch'] >= 0
    && ['previousPlanId', 'changeSummary'].every((key) => plan[key] === undefined || typeof plan[key] === 'string')
    && (plan['revision'] === undefined || (Number.isSafeInteger(plan['revision']) && Number(plan['revision']) > 0))
    && (plan['documentRevision'] === undefined || (Number.isSafeInteger(plan['documentRevision']) && Number(plan['documentRevision']) >= 0))
    && (plan['sources'] === undefined || (Array.isArray(plan['sources']) && plan['sources'].every((source: unknown) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
      const item = source as Record<string, unknown>;
      return typeof item['title'] === 'string'
        && ['url', 'fileId', 'chunkId', 'note'].every((key) => item[key] === undefined || typeof item[key] === 'string');
    })))
    && (plan['execution'] === undefined || isPlanExecution(plan['execution'], plan['steps'] as StructuredPlanStep[]));
}

function isPlanExecution(value: unknown, steps: StructuredPlanStep[]): value is PlanExecution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const execution = value as Record<string, unknown>;
  const ids = new Set(steps.map((step, index) => step.id ?? `step-${index + 1}`));
  if (typeof execution['status'] !== 'string'
    || !['running', 'awaiting-review', 'completed', 'blocked', 'interrupted'].includes(execution['status'])
    || !Array.isArray(execution['steps']) || execution['steps'].length !== steps.length) return false;
  return execution['steps'].every((step: unknown) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
    const item = step as Record<string, unknown>;
    if (typeof item['stepId'] !== 'string' || !ids.delete(item['stepId'])) return false;
    return typeof item['status'] === 'string'
      && ['pending', 'in-progress', 'completed', 'blocked'].includes(item['status'])
      && (item['note'] === undefined || typeof item['note'] === 'string');
  });
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
   허브가 로컬 CLI의 설치 여부를 프로브해 provider-status 로,
   턴마다 기록한 토큰 사용량을 usage-report 로 보낸다. limits에는 로컬 CLI의
   로그인 계정에서 읽은 5시간·주간 한도가 담긴다. 두 메시지는 요청
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
  terminalAuthSupported?: boolean;
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
  /** 로그인한 계정 이메일 — hosted account login may provide it. */
  account?: string | null;
  authenticating: boolean;
  /** Whether this Studio session owns the provider's current authentication run. */
  authOwnedByThisSession?: boolean;
  /** Present only for the owning Studio session. */
  authRunId?: string;
  authPhase?: string;
  authUrl?: string;
  pairingCode?: string;
  authExpiresAt?: string;
  setupComplete: boolean;
  exhausted?: boolean;
  latestVersion: string | null;
  updateRequired: boolean;
  error: string | null;
  models?: readonly string[];
}

export type AgentSetupStatusMap = Record<AgentName, AgentSetupStatus>;

export interface AgentSetupAuthStart {
  agent: AgentName;
  authRunId: string;
  authUrl: string | null;
  pairingCode?: string | null;
  expiresAt?: string | null;
}

export type AccountSessionState = 'signed-out' | 'signed-in' | 'pending' | 'unknown';

export interface AccountIdentity {
  email: string | null;
}

/** Generic Rauhwpx account identity. It never contains the account bearer. */
export interface AccountSessionStatus {
  state: AccountSessionState;
  signedIn: boolean;
  account: AccountIdentity | null;
  updatedAt: string;
  authenticating: boolean;
  authOwnedByThisSession?: boolean;
  authRunId?: string;
  authPhase?: string;
  authUrl?: string;
  pairingCode?: string;
  expiresAt?: string;
  error?: string;
}

export interface AccountLoginStart {
  authRunId: string;
  authUrl: string | null;
  pairingCode: string | null;
  expiresAt: string | null;
}

/** 요금제 — 한도 계산의 기준이 되므로 프로바이더별로 값이 다르다. */
export type ClaudeUsagePlan = 'pro' | 'max5x' | 'max20x' | 'api';
export type CodexUsagePlan = 'plus' | 'pro' | 'api';
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

export interface ProviderQuota {
  status: 'ok' | 'unavailable' | 'error';
  session: CliproxyWindow;
  week: CliproxyWindow;
  updatedAt: number | null;
  error: string | null;
  accountKey: string | null;
  planType: string | null;
  resetCredits: { availableCount: number; nextExpiresAt: number | null } | null;
}

export type CodexResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
export interface CodexResetResult {
  outcome: CodexResetOutcome;
  usage: UsageSummary;
}

export interface RemoteBalance {
  windows?: Array<{ label: string; remainingPercent: number; resetsAt: number | null }>;
  status: 'ok' | 'unavailable' | 'error';
  balanceUsd: number | null;
  totalCreditsUsd: number | null;
  totalUsageUsd: number | null;
  updatedAt: number | null;
  source: string | null;
  error: string | null;
}

export interface UsageSummary {
  plans: Record<AgentName, string>;
  providers: Record<AgentName, ProviderUsage>;
  cliproxy?: CliproxyStatus;
  limits?: { claude: ProviderQuota; codex: ProviderQuota };
  balances?: Partial<Record<'openrouter' | 'grok' | 'opencode', RemoteBalance>>;
  /** pi(OpenRouter) 가 설정돼 있을 때만 온다. */
  openrouter?: OpenRouterCredits;
  /** Legacy account balance retained for migration reads only. */
  rau?: OpenRouterCredits;
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
  /** Rau 체험 잔액이 0 일 때 true — 목록에는 남고 전송만 막는다. */
  exhausted?: boolean;
  latestVersion: string | null;
  updateRequired: boolean;
  error: string | null;
}

/** 자격 증명 한 필드의 출처 — 앱에서 입력했는지, 허브 환경 변수에서 왔는지. */
export type BrowserbaseCredentialSource = 'studio' | 'env' | null;

/** 허브가 보는 Browserbase 설정 상태. 키 본문은 오지 않고 끝 네 글자만 온다. */
export interface BrowserbaseStatus {
  configured: boolean;
  /** 아직 비어 있는 환경 변수 이름들. */
  missing: string[];
  keySource: BrowserbaseCredentialSource;
  keyTail: string | null;
  projectId: string | null;
  projectSource: BrowserbaseCredentialSource;
  geminiSource: BrowserbaseCredentialSource;
  /** 지금 떠 있는 원격 브라우저 — main 과 서브에이전트 id. */
  browsers: Array<{ id: string; connected: boolean }>;
}

/** 설정 탭에서 입력해 허브로 보내는 Browserbase 덮어쓰기 — 앱을 쓰는 동안만 산다. */
export interface BrowserbaseOverride {
  apiKey: string;
  projectId?: string;
  geminiApiKey?: string;
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
export type CheckpointTitleProvider = 'pi' | 'codex' | 'claude';

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
  opencode: isApiOnlyUsagePlan,
  rau: isApiOnlyUsagePlan,
};

export function isUsagePlanForAgent(agent: AgentName, value: unknown): boolean {
  return USAGE_PLAN_GUARDS[agent](value);
}

export type ProductSkillIcon =
  | 'pencil' | 'bot' | 'system'
  | 'sparkles' | 'book' | 'target' | 'chart' | 'lightbulb'
  | 'calendar' | 'code' | 'check' | 'heart' | 'bolt' | 'shield';

export type SkillHarnessId = 'claude' | 'codex' | 'cursor' | 'pi';

interface CatalogSkillFields {
  name: string;
  description: string;
}

export type CatalogRow =
  | (CatalogSkillFields & {
      kind: 'sealed';
      enabled: true;
      origin: 'sealed';
      digest: null;
      icon: ProductSkillIcon | null;
    })
  | (CatalogSkillFields & {
      kind: 'skill';
      enabled: boolean;
      origin: 'bundled' | 'user';
      digest: string;
      icon: ProductSkillIcon | null;
      editable?: boolean;
    })
  | (CatalogSkillFields & {
      kind: 'broken';
      enabled: false;
      origin: 'user';
      digest: string;
      icon: null;
    });

export interface SkillCatalog {
  rows: CatalogRow[];
}

export interface SkillEditorDocument { name: string; body: string; digest: string; }

export interface HarnessSkillRow {
  harness: SkillHarnessId;
  name: string;
  description: string;
}

export type SkillCommitChange =
  | { action: 'create'; name: string; description: string; body: string; base?: string; icon?: ProductSkillIcon }
  | { action: 'write'; name: string; path: string; content: string; encoding?: 'utf8' | 'base64'; base: string }
  | { action: 'body'; name: string; body: string; base: string }
  | { action: 'icon'; name: string; icon: ProductSkillIcon; base: string }
  | { action: 'enable'; name: string; enabled: boolean }
  | { action: 'delete'; name: string; base: string }
  | { action: 'import'; harness: SkillHarnessId; name: string; mode: 'adopt' | 'replace'; base?: string }
  | { action: 'restore'; name: string };

export type SkillCommitOutcome =
  | { ok: true; name: string; digest: string; unchanged: boolean; notice: string | null }
  | { ok: false; code: string; message: string; digest: string | null };

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
  | { type: 'turn-start'; agent: AgentName; turnId?: string }
  | { type: 'session-info'; agent: AgentName; sessionId: string; model?: string; mcpStatus?: string }
  | { type: 'text-delta'; agent: AgentName; text: string; parentTaskId?: string }
  | { type: 'tool-call'; agent: AgentName; callId: string; tool: string; argsJson: string; parentTaskId?: string }
  | { type: 'tool-result'; agent: AgentName; callId: string; ok: boolean; resultPreview: string; parentTaskId?: string }
  | { type: 'task-start'; agent: AgentName; taskId: string; callId?: string; title: string; role?: string; taskKind: 'agent' | 'workflow'; workflowName?: string; /** Owning turn may end while this real process keeps running. */ background?: boolean }
  | { type: 'task-progress'; agent: AgentName; taskId: string; activity?: string; lastTool?: string; usage?: AgentTaskUsage; phases?: AgentTaskPhase[]; members?: AgentTaskMember[]; /** Current task-level phase when there is no child member row. */ phaseIndex?: number }
  | { type: 'task-end'; agent: AgentName; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary?: string; usage?: AgentTaskUsage }
  | { type: 'turn-end'; agent: AgentName; stopReason?: string; errorMessage?: string; turnId?: string }
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
      serviceTier?: ServiceTier;
      threadId?: string;
      documentId?: string | null;
      documentName?: string | null;
      workflow: AgentWorkflow;
      phase: AgentPhase;
      capabilityEpoch: number | null;
      latestPlan: StructuredPlan | null;
    }
  | { type: 'chat-stopped' }
  | { type: 'user-question-requested'; interaction: UserQuestionInteraction; replayed?: boolean }
  | { type: 'user-question-resolved'; interactionId: string; outcome: UserQuestionOutcome }
  | { type: 'user-question-answer-result'; interactionId: string; responseId: string; ok: boolean; code?: string; message?: string }
  | { type: 'reference-status'; messageId: string; attachments: MessageReferenceStatus[] }
  | { type: 'templates-catalog'; catalog: TemplateCatalog; change?: { type: 'added' | 'renamed' | 'replaced' | 'deleted'; template: DocumentTemplate } }
  | { type: 'agent-instructions'; status: AgentInstructionsStatus; changedBy: string }
  | { type: 'agent-instructions-draft'; draft: AgentInstructionsDraft }
  | { type: 'agent-instructions-draft-cleared'; draftId: string; outcome: 'confirmed' | 'rejected' | 'expired' | 'replaced' | 'stale' }
  | { type: 'agent-instructions-error'; code: string; message: string; status?: AgentInstructionsStatus }
  | { type: 'chat-template-changed'; template: DocumentTemplate | null; reason?: string }
  | { type: 'permission-changed'; permissionProfile: PermissionProfile }
  | { type: 'service-tier-changed'; serviceTier: ServiceTier }
  | ({ type: 'workflow-changed' } & AgentWorkflowState)
  | ({ type: 'plan-ready'; plan: StructuredPlan } & AgentWorkflowState)
  | ({ type: 'plan-approved'; planId: string } & AgentWorkflowState)
  | ({ type: 'plan-invalidated'; planId: string | null; reason?: string } & AgentWorkflowState)
  | ({ type: 'implementation-started'; planId: string } & AgentWorkflowState)
  | ({ type: 'plan-progress'; planId: string } & AgentWorkflowState)
  | { type: 'planning-document-saved'; revision: number }
  | { type: 'skills-catalog'; catalog: SkillCatalog }
  | { type: 'harness-list-result'; requestId: string; rows: HarnessSkillRow[] }
  | { type: 'skill-commit-result'; requestId: string; outcome: SkillCommitOutcome }
  | { type: 'skills-error'; requestId: string; code: string; message: string }
  | { type: 'writing-style-status'; requestId: string; status: WritingStyleStatus }
  | ({ type: 'writing-style-progress'; requestId: string } & WritingStyleProgress)
  | { type: 'writing-style-result'; requestId: string; status: WritingStyleStatus }
  | { type: 'writing-style-error'; requestId: string; code: string; message: string }
  | { type: 'writing-style-catalog'; requestId: string; catalog: WritingStyleCatalog }
  | { type: 'provider-status'; providers: ProviderStatusMap }
  | { type: 'model-catalog'; agent: CatalogAgent; requestId: string; models: ModelCatalogEntry[] }
  | { type: 'model-catalog-error'; agent: CatalogAgent; requestId: string; code: string; message: string }
  | { type: 'agent-setup-status'; statuses: AgentSetupStatusMap }
  | {
      type: 'agent-setup-progress';
      agent: AgentName;
      authRunId?: string;
      state: 'installing' | 'authorizing' | 'done';
      phase?: 'preparing' | 'resolving' | 'downloading' | 'installing' | 'configuring' | 'verifying' | 'done';
      percent?: number;
      detail?: string;
      authUrl?: string;
      /** Device authentication code for CLI login flows. */
      userCode?: string;
      /** Short code that identifies the hosted account login session. */
      pairingCode?: string;
      expiresAt?: string;
      activity?: boolean;
      receivedBytes?: number;
      totalBytes?: number;
    }
  | { type: 'agent-setup-terminal'; agent: AgentName; authRunId: string; data?: string; ready?: boolean; reset?: boolean }
  | { type: 'agent-setup-error'; agent: AgentName | null; authRunId?: string; code: string; message: string }
  | { type: 'account-status'; status: AccountSessionStatus }
  | {
      type: 'account-login-progress';
      authRunId?: string;
      state: 'authorizing';
      authUrl?: string;
      pairingCode?: string;
      expiresAt?: string;
      replayed?: boolean;
    }
  | { type: 'account-error'; authRunId?: string; code: string; message: string }
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
  | { type: 'browserbase-status'; status: BrowserbaseStatus }
  | { type: 'browserbase-error'; requestId: string; code: string; message: string }
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
  canPublishCloudDocument?: () => boolean;
}

export interface AgentBridgeOptions {
  /** Browser/dev override. Electron always uses the preload session context. */
  url?: string;
  token?: string;
  referenceToken?: string;
  templateToken?: string;
  launchId?: string;
  sessionId?: string;
}

export interface DocPoint {
  paraIdx: number;
  charOffset: number;
}

/**
 * 표 셀 주소. path 는 중첩 표 셀의 최외곽 표부터 대상 셀까지의 경로다.
 * paraIdx = 표 컨트롤을 담은 본문 문단, cellIdx = flat 셀 인덱스.
 */
export interface CellAddr {
  paraIdx: number;
  controlIdx: number;
  cellIdx: number;
  path?: CellPathEntry[];
}

export function sameCell(a: CellAddr | undefined, b: CellAddr | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.paraIdx !== b.paraIdx || a.controlIdx !== b.controlIdx || a.cellIdx !== b.cellIdx) return false;
  if (!a.path || !b.path) return !a.path && !b.path;
  return a.path.length === b.path.length && a.path.every((entry, index) =>
    entry.controlIndex === b.path![index].controlIndex
    && entry.cellIndex === b.path![index].cellIndex
    && (index === a.path!.length - 1 || entry.cellParaIndex === b.path![index].cellParaIndex));
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
  /** 장평 % — 7개 언어 슬롯 (한/영/한자/일/외/기/사) */
  ratios?: number[];
  /** 자간 % — 7개 언어 슬롯 */
  spacings?: number[];
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
 * 모든 객체 연산은 도구 호출 시점에 엔진에 적용된다 (미리보기 = 승인 결과).
 * 되돌림 수단은 연산마다 정해진다:
 * - 문단 보관본(captureParagraph): 표 생성·구조·속성, 표 삭제, 스타일, 기존 머리말/꼬리말,
 *   그림/도형 편집·삭제, 도형 삽입 — 한 본문 문단 안에서 끝나는 변경을 그 문단째로 되돌린다.
 * - 문서 스냅샷: 그림/수식 삽입, 개체 앞뒤 순서, 엔진 배치(apply_engine_edits) (문단 보관을 지원하지 않는 WASM 에서는 위 연산도)
 * - 역연산: 문단 서식, 쪽 설정, 새 머리말/꼬리말, 각주, 책갈피 (보관본이 거부될 때의 폴백 포함)
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
      /** 존재하면 paraIdx/charOffset 은 셀 내부 좌표, anchor.controlIdx 는 셀 문단 내 그림 인덱스 */
      cell?: CellAddr;
      bytes: Uint8Array; extension: string;
      widthHu: number; heightHu: number;
      naturalWidthPx: number; naturalHeightPx: number;
      description: string;
      /** 같은 오프셋에 이미 있는 인라인 개체 뒤에 넣는다 (기본은 앞) */
      afterObjects?: boolean;
      /** 떠 있는 배치 — 삽입 직후 setPictureProperties 로 적용하는 속성 */
      floating?: Record<string, unknown>;
      anchor?: ObjectAnchor;
    }
  | {
      type: 'insertEquation';
      sectionIdx: number; paraIdx: number; charOffset: number;
      /** 존재하면 paraIdx 는 이 셀 내부 문단 인덱스, anchor.controlIdx 는 셀 문단 내 수식 인덱스 */
      cell?: CellAddr;
      script: string; fontSizeHu: number; colorRef: number;
      previewSvg?: string;
      anchor?: ObjectAnchor;
    }
  | {
      /** 행/열 삽입·삭제, 셀 병합·나눔 */
      type: 'tableStructure';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      op: TableStructureOpName;
      /** insert_row/insert_col 기준 인덱스와 방향 */
      index?: number; after?: boolean;
      /** insert 역연산용 삽입 결과 인덱스 (after ? index+1 : index) */
      insertedIndex?: number;
      rowIdx?: number; colIdx?: number;
      startRow?: number; startCol?: number; endRow?: number; endCol?: number;
      splitRows?: number; splitCols?: number;
      /** 적용 직후 크기 — 드리프트 프로브 (같은 표의 나중 구조 op 이 갱신) */
      dims?: { rowCount: number; colCount: number };
      /** delete_row/delete_col: 삭제 전에 보관한 대상의 텍스트 (오버레이 팝오버·diff) */
      removedText?: string;
    }
  | {
      /** 표 전체 삭제 — 문단 보관본으로 되돌린다 */
      type: 'deleteTable';
      sectionIdx: number;
      tableParaIdx: number;
      controlIdx: number;
      /** 삭제 직전 크기 (요약용) */
      dims: { rowCount: number; colCount: number };
      /** 삭제 전에 보관한 표 텍스트 (오버레이 팝오버·diff) */
      removedText?: string;
      /** 삭제된 컨트롤의 문단 내 텍스트 오프셋 — 삭제 후 표는 없으므로 마커 위치로 쓴다 */
      removedOffset?: number;
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
      /** 열 폭 절대 지정 — wasm.setTableColumnWidths */
      type: 'setColumnWidths';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      /** HWPUNIT 열 폭 — 길이는 호출 시점 열 수와 같다 */
      widthsHu: number[];
      dims: { rowCount: number; colCount: number };
    }
  | {
      /** 본문 폭 맞춤(축소 전용) — wasm.fitTableToPage */
      type: 'fitToPage';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      dims: { rowCount: number; colCount: number };
    }
  | {
      /** 셀 범위 테두리/배경 — wasm.setCellZoneProperties */
      type: 'setZoneProps';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      range: { startRow: number; startCol: number; endRow: number; endCol: number };
      props: Record<string, unknown>;
      dims: { rowCount: number; colCount: number };
    }
  | {
      /** 계산식 결과 입력 — wasm.evaluateTableFormulaEx(writeResult) */
      type: 'applyFormula';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      row: number; col: number;
      formula: string;
      format?: { decimalPlaces?: number; thousandsSeparator?: boolean; prefix?: string; suffix?: string };
      /** 오버레이 대상 셀 (호출 시점 해석) */
      cellIdx?: number;
      dims: { rowCount: number; colCount: number };
    }
  | {
      /** 표 캡션 글 — wasm.setTableCaptionText */
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
      /** 시작 쪽 번호 등 구역 설정 — setSectionDef 로 적용/되돌림 */
      sectionDef?: { next: Record<string, unknown>; prev: Record<string, unknown> };
    }
  | {
      type: 'headerFooter';
      sectionIdx: number; isHeader: boolean; applyTo: number;
      /** HF 전체를 대체하는 문단들 (줄바꿈 없는 문단별 텍스트) */
      lines: string[];
      /** 마지막에 붙는 쪽번호 문단 — template 의 {n} 은 \u{0015} 필드로 치환된다 */
      pageNumber?: { template: string; align: 'left' | 'center' | 'right' };
      /** false = 이 op 이 HF 를 생성했다 (reject 시 삭제) */
      existedBefore: boolean;
      /** 기존 HF 수정: HF 컨트롤을 품은 본문 문단 (문단 보관 대상) */
      hostParaIdx?: number;
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
      /**
       * 그림/도형의 배치·크기·자르기·앞뒤 순서 변경 (edit_object). 문단 보관본으로 되돌리고,
       * 앞뒤 순서는 다른 문단의 개체와 맞바꿀 수 있어 문서 스냅샷으로 되돌린다.
       */
      type: 'editObject';
      kind: 'picture' | 'shape';
      sectionIdx: number;
      /** 개체를 품은 문단 — cell 이 있으면 셀 문단, controlIdx 는 셀 문단 안 인덱스 */
      paraIdx: number;
      controlIdx: number;
      cell?: CellAddr;
      /** set{Picture,Shape}Properties 에 넘기는 엔진 속성 (HWPUNIT) */
      props: Record<string, unknown>;
      /** 역연산용 적용 전 값 (props 와 같은 키) */
      prevProps: Record<string, unknown>;
      zOrder?: 'front' | 'back' | 'forward' | 'backward';
      /** 적용 직후 크기 — 드리프트 판별자 */
      applied?: { width: number; height: number };
    }
  | {
      /** 그림/도형 삭제 — 문단 보관본으로 되돌린다 */
      type: 'deleteObject';
      kind: 'picture' | 'shape';
      sectionIdx: number;
      paraIdx: number;
      controlIdx: number;
      cell?: CellAddr;
      /** 삭제된 컨트롤의 문단 내 텍스트 오프셋 — 오버레이 앵커 위치 */
      removedOffset?: number;
      /** 개체 설명 (오버레이 팝오버·diff) */
      removedText?: string;
    }
  | {
      /** 도형 삽입 (insert_shape) — 본문 문단에만 놓는다 */
      type: 'insertShape';
      shape: 'line' | 'rectangle' | 'ellipse' | 'textBox';
      sectionIdx: number; paraIdx: number; charOffset: number;
      /** createShapeControl 인자 */
      create: Record<string, unknown>;
      /** 생성 직후 setShapeProperties 로 적용하는 배치·선·채우기 */
      props: Record<string, unknown>;
      anchor?: ObjectAnchor;
      /** 적용 직후 크기 — 드리프트 판별자 */
      applied?: { width: number; height: number };
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
    }
  | {
      /**
       * apply_engine_edits 한 배치 — 역연산이 없어 배치 직전 문서 스냅샷으로만 되돌린다.
       * sectionIdx 는 요약·쪽 표시용 대표 구역이다.
       */
      type: 'engineBatch';
      sectionIdx: number;
      methods: string[];
      /** 배치가 바꾼 본문 문단 구간 (적용 후 좌표, 포함) — 비면 구역 전체 쪽을 표시한다 */
      touched: EngineBatchSpan[];
      /**
       * 바뀐 구간 뒤 문단의 이동 — 등록 시 다른 op 좌표를 from(적용 전 좌표) 이상부터
       * delta 만큼 밀었고, 스냅샷 복원 뒤 거꾸로 되민다.
       */
      shifts: Array<{ sectionIdx: number; from: number; delta: number }>;
    };

export interface EngineBatchSpan {
  sectionIdx: number;
  paraStart: number;
  paraEnd: number;
}

export type TableStructureOpName =
  | 'insert_row' | 'insert_col' | 'delete_row' | 'delete_col' | 'merge_cells' | 'split_cell';

/**
 * 객체 op 의 오버레이 분류 — 편집이 실제로 한 일을 말한다:
 * - insert: 새로 생긴 것 (표·그림·수식·주석·책갈피·새 행/열·새 머리말/꼬리말)
 * - modify: 속성·스타일·너비·계산식·캡션·머리말/꼬리말 내용·쪽 설정 변경
 * - remove: 지워진 것 (행·열·표·책갈피)
 */
export function objectOverlayKind(obj: ObjectOp): 'insert' | 'modify' | 'remove' {
  switch (obj.type) {
    case 'deleteTable':
    case 'deleteObject':
      return 'remove';
    case 'tableStructure':
      return obj.op === 'delete_row' || obj.op === 'delete_col' ? 'remove'
        : obj.op === 'merge_cells' || obj.op === 'split_cell' ? 'modify'
        : 'insert';
    case 'createTable':
    case 'insertImage':
    case 'insertEquation':
    case 'insertNote':
    case 'insertShape':
      return 'insert';
    case 'headerFooter':
      return obj.existedBefore ? 'modify' : 'insert';
    case 'bookmark':
      return obj.op === 'delete' ? 'remove' : obj.op === 'rename' ? 'modify' : 'insert';
    default:
      return 'modify';
  }
}

/** 문단 보관본 — 적용 직전 본문 문단과, 적용 직후 그 문단의 내용 지문 */
export interface ParagraphCaptureRef {
  id: number;
  /** 적용 직후 지문 — 되돌리기 전 사용자 수정 판별용 (null = 지문 미지원) */
  digest: string | null;
}

/**
 * 대기 편집이 반영되지 못한 이유. 사이드바 무효화 메시지와 에이전트 보고에 쓴다.
 * - text-changed: 텍스트 op 자리에 기대한 글자가 없다 (사용자 수정)
 * - field-changed / table-changed / paragraph-changed / object-changed: 대상이 바뀌거나 사라졌다
 * - revert-failed: 되돌리기 직전 확인에 실패해 문서에 그대로 남았다
 */
export type PendingDropCause =
  | 'text-changed' | 'field-changed' | 'table-changed' | 'paragraph-changed'
  | 'object-changed' | 'revert-failed';

export interface PendingDrop {
  opId: string;
  cause: PendingDropCause;
  /** describeChangeSet 과 같은 한 줄 요약 */
  summary: string;
}

/**
 * 텍스트 op 이 적용된 직후의 범위와 카운터. 나중에 적용된 op 들이 모두 정확히
 * 되돌려지면 문서는 이 op 의 적용 직후 상태로 돌아오므로, 나중 op 이 겹쳐 덮어쓴
 * (그래서 live range 가 무너진) op 도 이 범위로 정확히 되돌릴 수 있다.
 */
export interface PendingAppliedAt {
  range: DocRange;
  userEditSeq: number;
  settledSetSeq: number;
  /** 나중 에이전트 삭제/교체가 이 op 의 텍스트 일부를 지웠다 (텍스트 검증 불가). */
  overwritten?: boolean;
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
      applied?: PendingAppliedAt;
      /**
       * 본문 문단을 나누는 삽입의 원래 문단 보관본 (digest = 삽입 직전 지문). 되돌린 뒤
       * 내용이 같으면 이것으로 바꿔 줄 배치까지 원래대로 돌린다 — 병합은 문단을 다시 흘린다.
       */
      paraCapture?: ParagraphCaptureRef | null;
      /** 전역 등록 순번 — 중첩 검증·스냅샷 되돌림 안전 판별용 (pending-edits 가 부여) */
      seq?: number;
    } // applied
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
      /** Original runs in scalar offsets relative to deletedText, including newlines. */
      charShapeRuns?: CharShapeRun[];
      /** 원본 문단별 paraShapeId (폴백 되돌림용, -1 = 캡처 실패) */
      paraShapeIds: number[];
      /** 변이 직전 스냅샷 — 되돌림 시 원본을 정확히 복원하는 소스 */
      snapshotId: number | null;
      /**
       * 스냅샷을 찍은 시점의 사용자(비-에이전트) 편집 카운터. 되돌림 시점 값과
       * 다르면 스냅샷 복원이 그 사용자 편집을 지우므로 역연산 폴백을 쓴다.
       */
      userEditSeqAtSnapshot?: number;
      /** A different set settled after this whole-document snapshot. */
      settledSetSeqAtSnapshot?: number;
      applied?: PendingAppliedAt;
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
      /** 적용 시점 범위 — 나중 에이전트 교체가 범위를 덮어써도 역순 되돌림 끝에 정확히 되돌린다 */
      applied?: PendingAppliedAt;
      seq?: number;
    } // applied
  | {
      kind: 'field'; id: string; agent: AgentName; name: string; oldValue: string; newValue: string;
      seq?: number;
    } // applied
  | { kind: 'object'; id: string; agent: AgentName; obj: ObjectOp; seq?: number;
      snapshotId?: number | null;
      /** 문단 보관본 — 있으면 문서 스냅샷보다 먼저 쓴다 */
      paraCapture?: ParagraphCaptureRef | null;
      userEditSeqAtSnapshot?: number;
      settledSetSeqAtSnapshot?: number }; // 항상 적용된 상태로 등록된다

export type ChangeSetStatus = 'open' | 'awaiting-review';

export interface PendingChangeSet {
  id: string;
  agent: AgentName;
  status: ChangeSetStatus;
  ops: PendingOp[];
  createdAt: number;
  /** 성공 없이 끝난 턴(중단·오류·재연결)의 set — 리뷰 카드가 중단 사실을 표시한다 */
  turnStopped?: boolean;
}

export type PendingEditsChangeEvent =
  | { type: 'ops-changed' }
  | { type: 'set-finalized'; changeSetId: string }
  | { type: 'approved'; changeSetId: string }
  | { type: 'rejected'; changeSetId: string }
  | {
      type: 'invalidated'; reason: string; changeSetId?: string;
      /** 있으면 set 의 일부만 빠졌다 — 나머지는 승인/거절대로 처리됐다 */
      droppedOpIds?: string[];
      drops?: PendingDrop[];
      /** 거절/무효화로 되돌리지 못해 문서에 남은 op 인가 (승인은 false — 전부 반영됨) */
      leftInDocument?: boolean;
    };
