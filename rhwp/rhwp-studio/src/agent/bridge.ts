/**
 * 스튜디오 ↔ rhwp-agent 허브 WebSocket 브리지.
 *
 * renderer session에 배정된 허브의 /studio 엔드포인트에 role=studio로 접속해:
 *  - 허브의 tool-request를 AgentToolExecutor로 실행하고 tool-response로 응답
 *  - agent-event 스트림을 사이드바용 SidebarEvent로 중계
 *  - turn-start/turn-end로 PendingEditManager의 change-set 수명주기를 구동
 * 접속이 끊기면 250ms → 500ms → 1s → 2s → 5s 백오프로 무한 재시도한다.
 * 연결 시도가 멈추면 제한 시간 후 소켓을 접고, 데스크톱에서는 허브 프로세스도
 * 다시 띄운다. 포커스·온라인 복구 시에도 즉시 붙는다.
 */
import {
  ensureDesktopAgentHub,
  getNativeFileSourcePath,
  httpHubUrl,
  resolveRendererSessionContext,
  websocketHubUrl,
  type RendererSessionContext,
} from '../desktop-integration.ts';
import { RevisionTracker } from './revision.ts';
import { AgentToolExecutor } from './tool-executor.ts';
import { PendingEditManager } from './pending-edits.ts';
import { PendingOverlayRenderer } from './pending-overlay.ts';
import { PendingRequestRegistry } from './pending-requests.ts';
import { AgentTypewriterReveal } from './typewriter-reveal.ts';
import { deriveAgentEditingLease, planModeAllowsUserEditing } from './editing-lease.ts';
import {
  setCursorModels as setCursorModelRegistry,
  setOpenCodeModels as setOpenCodeModelRegistry,
  setPiModels as setPiModelRegistry,
} from './models.ts';
import {
  AGENT_PROTOCOL_VERSION,
  AgentToolError,
  isAgentPhase,
  isAgentWorkflow,
  isStructuredPlan,
} from './types.ts';
import {
  ERROR_RESPONSE_MAX_BYTES,
  STRUCTURED_RESPONSE_MAX_BYTES,
  TEMPLATE_DOCUMENT_MAX_BYTES,
  cancelResponseBody,
  readResponseBytesWithLimit,
} from '../core/document-input-limits.ts';
import type {
  AgentBridgeDeps,
  AgentBridgeOptions,
  AgentInstructionsDraft,
  AgentInstructionsStatus,
  AgentEditingLease,
  AgentName,
  AgentAuthMethod,
  AccountLoginStart,
  AccountSessionStatus,
  AgentSetupAuthStart,
  AgentSetupStatus,
  AgentSetupStatusMap,
  CheckpointTitleRequest,
  CheckpointTitleResult,
  AgentPhase,
  AgentWorkflow,
  AgentWorkflowState,
  OpenRouterCredits,
  PermissionProfile,
  ServiceTier,
  PiCatalogModel,
  PiModelConfig,
  PiStatus,
  ProductSkillFile,
  ProviderHealth,
  ProviderStatusMap,
  ProviderUsage,
  ReferenceFile,
  ReferenceScope,
  ReferenceScopeContext,
  ReferenceSearchHit,
  StagedReference,
  MessageReferenceStatus,
  StructuredPlan,
  UsageModelBreakdown,
  UsageSource,
  UsageSummary,
  UsageWindow,
  CliproxyAccount,
  CliproxyStatus,
  WritingStyleLanguage,
  WritingStyleCatalog,
  WritingStyleCatalogModel,
  WritingStyleCatalogProvider,
  WritingStyleProgress,
  WritingStyleProgressState,
  WritingStyleStatus,
  WritingStyleUpload,
  DocumentTemplate,
  TemplateCatalog,
  AgentStreamEvent,
  SidebarEvent,
  UserQuestionAnswer,
  UserQuestionInteraction,
  UserQuestionOutcome,
} from './types.ts';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function providerTurnEndMatches(
  activeTurnId: string | null,
  eventTurnId: string | null,
): boolean {
  // A reconnect can replay the terminal event before its welcome snapshot, so
  // an event is safe when Studio has no active turn identity. Once a newer
  // identified turn is active, only its exact ID may settle it; a legacy
  // no-ID event fails closed in that state.
  return activeTurnId === null || eventTurnId === activeTurnId;
}

export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

/** Frontend consumers only need the pending-edit review surface. */
export type SidebarBridge = Omit<AgentBridge, 'pendingEdits'> & {
  readonly pendingEdits: Pick<PendingEditManager, 'getChangeSets' | 'onChange' | 'approve' | 'reject'>;
};

export interface AgentBridge {
  readonly pendingEdits: PendingEditManager;
  getConnectionState(): 'connecting' | 'connected' | 'disconnected' | 'replaced';
  getActiveAgent(): AgentName | null;
  isTurnRunning(): boolean;
  getPendingUserQuestion(): UserQuestionInteraction | null;
  getEditingLease(): AgentEditingLease;
  onEditingLeaseChange(cb: (lease: AgentEditingLease) => void): () => void;
  getPermissionProfile(): PermissionProfile;
  getServiceTier(): ServiceTier;
  getWorkflowState(): AgentWorkflowState;
  /** 다른 탭이 연결을 차지한 상태에서 현재 탭이 스튜디오 연결을 다시 가져온다. */
  takeOverConnection(): void;
  /** 예약된 백오프를 취소하고 허브를 띄운 뒤 즉시 다시 연결한다. 이미 연결돼 있으면 무시. 연결 중이어도 소켓을 접고 다시 붙는다. */
  reconnectNow(): Promise<void>;
  /** 로컬 CLI 설치 상태. refresh=true 면 허브가 새로 프로브한다. */
  requestProviderStatus(refresh?: boolean): Promise<ProviderStatusMap | null>;
  requestAgentSetupStatus(refresh?: boolean): Promise<AgentSetupStatusMap | null>;
  requestAccountStatus(): Promise<AccountSessionStatus | null>;
  loginAccount(): Promise<AccountLoginStart | null>;
  submitAccountAuthCode(authRunId: string, code: string): void;
  cancelAccountLogin(authRunId: string): void;
  logoutAccount(): Promise<AccountSessionStatus | null>;
  installAgent(agent: AgentName): Promise<AgentSetupStatusMap | null>;
  authenticateAgent(agent: AgentName, method: AgentAuthMethod, key?: string): Promise<AgentSetupAuthStart | null>;
  /** 브라우저 로그인 뒤 받은 인증 코드를 진행 중인 CLI 로그인에 전달한다. */
  submitAgentAuthCode(agent: AgentName, authRunId: string, code: string): void;
  cancelAgentSetup(agent: AgentName, authRunId: string): void;
  /** 이 기기의 Rau 키만 지운다. 호스티드 $5 키는 서버에 남는다. */
  disconnectAgent(agent: AgentName): Promise<AgentSetupStatusMap | null>;
  /** 누적 사용량 요약. 응답이 없으면 null. */
  requestUsage(refresh?: boolean): Promise<UsageSummary | null>;
  /** 요금제를 바꾸고 갱신된 요약을 돌려받는다. */
  setUsagePlan(agent: AgentName, plan: string): Promise<UsageSummary | null>;
  /** CLIProxyAPI 관리 API 에 연결해 공식 요금제 사용량을 받는다. */
  connectCliproxy(url: string, key: string): Promise<UsageSummary | null>;
  /** 저장된 CLIProxyAPI 연결을 끊는다. */
  disconnectCliproxy(): Promise<UsageSummary | null>;
  /** pi 하네스(설치 · 키 · 모델) 설정 상태. */
  requestPiStatus(): Promise<PiStatus | null>;
  /** pi coding agent 설치. 진행 상황은 pi-setup-progress 이벤트로 온다. */
  installPi(): Promise<PiStatus | null>;
  /** OpenRouter API 키를 검증하고 저장한다. */
  setPiKey(key: string): Promise<PiStatus | null>;
  /** 라이브 OpenRouter 모델 카탈로그. */
  requestPiCatalog(refresh?: boolean): Promise<PiCatalogModel[] | null>;
  /** 사용자가 고른 최대 3개 pi 모델(표시 이름 포함)을 저장한다. */
  setPiModels(
    models: Array<{ id: string; name: string; defaultEffort?: string }>,
  ): Promise<PiStatus | null>;
  startChat(agent: AgentName, model?: string, effort?: string, force?: boolean, permissionProfile?: PermissionProfile, workflow?: AgentWorkflow, threadId?: string, documentId?: string | null, documentName?: string | null, history?: ChatHistoryEntry[]): void;
  /** 허브 세션을 폐기하고 새 채팅을 시작할 수 있게 한다. */
  stopChat(): void;
  /** gpt-5.6-luna 로 스레드 제목 생성 요청. */
  requestTitle(threadId: string, preview: string): string;
  /** 커밋 메시지는 부수 정보다. 오프라인, 실패, 타임아웃이면 null. */
  requestCheckpointTitle(input: CheckpointTitleRequest): Promise<CheckpointTitleResult | null>;
  sendUserMessage(text: string, skillName?: string, stagedReferenceIds?: string[]): Promise<string | null>;
  listTemplates(): Promise<TemplateCatalog>;
  addTemplate(file: File, name?: string): Promise<DocumentTemplate>;
  renameTemplate(id: string, name: string): Promise<DocumentTemplate>;
  replaceTemplate(id: string, file: File): Promise<DocumentTemplate>;
  deleteTemplate(id: string): Promise<void>;
  setActiveTemplate(id: string | null): void;
  getActiveTemplate(): DocumentTemplate | null;
  /** 읽기 전용 템플릿 미리보기 창이 실제로 열렸음을 허브에 확인한다. */
  stageReference(scopeId: string, file: File): Promise<StagedReference>;
  discardStagedReference(scopeId: string, stageId: string): Promise<void>;
  /** 참고자료 원본은 HTTP로 스트리밍하고, 브라우저에는 메타데이터만 돌려준다. */
  uploadReference(scope: ReferenceScope, scopeId: string, file: File): Promise<ReferenceFile>;
  listReferences(scope: ReferenceScope, scopeId: string): Promise<ReferenceFile[]>;
  downloadReference(file: Pick<ReferenceFile, 'id' | 'scope' | 'scopeId'>): Promise<Uint8Array>;
  searchReferences(query: string, scope: ReferenceScope, scopeId: string, limit?: number): Promise<ReferenceSearchHit[]>;
  deleteReference(file: Pick<ReferenceFile, 'id' | 'scope' | 'scopeId'>): Promise<void>;
  setWorkflow(workflow: AgentWorkflow): void;
  approvePlan(planId: string): boolean;
  requestPlanChanges(planId: string, feedback?: string): boolean;
  setPermissionProfile(profile: PermissionProfile): void;
  setServiceTier(tier: ServiceTier): void;
  listSkills(): void;
  readSkill(name: string): string;
  validateSkill(skill: { name: string; files: ProductSkillFile[] }): string;
  saveSkill(skill: { name: string; files: ProductSkillFile[] }): string;
  setSkillEnabled(name: string, enabled: boolean): string;
  deleteSkill(name: string): string;
  generateSkillDraft(input: { goal: string; triggerExamples?: string; nonTriggerExamples?: string; resourceNotes?: string; existingSkill?: string }): string;
  requestWritingStyleStatus(): string;
  requestAgentInstructions(): Promise<AgentInstructionsStatus | null>;
  saveAgentInstructions(content: string, expectedRevision: number): Promise<AgentInstructionsStatus | null>;
  confirmAgentInstructionsDraft(draft: AgentInstructionsDraft): Promise<AgentInstructionsStatus | null>;
  rejectAgentInstructionsDraft(draft: AgentInstructionsDraft): Promise<boolean>;
  requestWritingStyleCatalog(refresh?: boolean): Promise<WritingStyleCatalog | null>;
  calibrateWritingStyle(input: {
    language: WritingStyleLanguage;
    files: WritingStyleUpload[];
    agent: AgentName;
    model: string;
    append: boolean;
  }): string;
  setWritingStyleInstruction(instruction: string): string;
  /** 현재 막힌 프로바이더 요청에 답한다. 재연결 재시도에도 같은 응답 ID를 쓴다. */
  answerUserQuestion(interactionId: string, answers: Record<string, UserQuestionAnswer>): string;
  interrupt(): void;
  interruptIfIdle(): boolean;
  onEvent(cb: (e: SidebarEvent) => void): () => void;
  dispose(): void;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';

/** 허브가 다른 스튜디오 탭에게 자리를 내주며 보내는 close code (server.mjs와 동일 값). */
const CLOSE_CODE_REPLACED = 4000;

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 5000];
/** localhost 핸드셰이크가 이보다 길면 소켓을 접고 다음 백오프로 넘긴다. */
const CONNECT_TIMEOUT_MS = 4000;

/** 요청/응답 대기 상한 — 넘기면 null 로 안착한다(던지지 않는다). */
const REQUEST_TIMEOUT_MS = 10_000;

/** 페이지 새로고침 뒤에도 같은 허브 세션의 질문 취소를 이어 가는 탭별 저장 키. */
const QUESTION_CANCELLATION_STORAGE_PREFIX = 'rhwp-agent-question-cancellation:';

/** 재연결 사이에 붙잡아 둘 tool-response 개수와 보관 기한(허브의 도구 타임아웃과 맞춘다). */
const TOOL_RESPONSE_BUFFER_LIMIT = 32;
const TOOL_RESPONSE_BUFFER_TTL_MS = 30_000;

/**
 * 소켓이 잠깐 닫힌 사이에 계산이 끝난 tool-response 를 담아 두었다가
 * 재연결 직후 오래된 것부터 다시 보낸다. 허브는 이미 타임아웃된 id 를 받으면
 * 로그만 남기고 무시하므로 늦은 응답을 흘려도 안전하다.
 */
export class ToolResponseBuffer {
  private entries: Array<{ frame: unknown; expiresAt: number }> = [];
  private readonly limit: number;
  private readonly ttlMs: number;

  constructor(limit = TOOL_RESPONSE_BUFFER_LIMIT, ttlMs = TOOL_RESPONSE_BUFFER_TTL_MS) {
    this.limit = limit;
    this.ttlMs = ttlMs;
  }

  get size(): number {
    return this.entries.length;
  }

  push(frame: unknown, now = Date.now()): void {
    this.entries.push({ frame, expiresAt: now + this.ttlMs });
    // 한계를 넘으면 가장 오래된 것부터 버린다 — 오래 끊긴 세션이 메모리를 물지 않도록.
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  /** 만료되지 않은 프레임을 오래된 순으로 꺼내고 버퍼를 비운다. */
  drain(now = Date.now()): unknown[] {
    const alive = this.entries.filter((entry) => entry.expiresAt > now);
    this.entries = [];
    return alive.map((entry) => entry.frame);
  }

  clear(): void {
    this.entries = [];
  }
}

/** 페이지 로드마다 새로 발급하는 스튜디오 인스턴스 id — 허브가 "잠깐 끊김"과 "새로고침·다른 탭"을 구분한다. */
const STUDIO_INSTANCE_ID = globalThis.crypto?.randomUUID?.()
  ?? `studio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function isAgentName(v: unknown): v is AgentName {
  return v === 'claude' || v === 'codex' || v === 'pi' || v === 'grok'
    || v === 'cursor' || v === 'opencode' || v === 'rau';
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function readUserQuestionInteraction(value: unknown): UserQuestionInteraction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!isBoundedText(input['interactionId'], 256)
    || !isBoundedText(input['providerRequestId'], 256)
    || !isBoundedText(input['threadId'], 256)
    || !isBoundedText(input['turnId'], 256)
    || !isAgentName(input['agent'])
    || (input['source'] !== 'native' && input['source'] !== 'mcp')
    || typeof input['createdAt'] !== 'string'
    || typeof input['updatedAt'] !== 'string'
    || !Array.isArray(input['questions'])
    || input['questions'].length < 1
    || input['questions'].length > 4) return null;
  const questions = input['questions'].flatMap((raw): UserQuestionInteraction['questions'] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const question = raw as Record<string, unknown>;
    if (!isBoundedText(question['id'], 128)
      || !isBoundedText(question['header'], 12)
      || !isBoundedText(question['question'], 500)
      || (question['mode'] !== 'single' && question['mode'] !== 'multiple')
      || typeof question['allowOther'] !== 'boolean'
      || !Array.isArray(question['options'])
      || question['options'].length < 2
      || question['options'].length > 4) return [];
    const options = question['options'].flatMap((rawOption) => {
      if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) return [];
      const option = rawOption as Record<string, unknown>;
      return isBoundedText(option['id'], 128)
        && isBoundedText(option['label'], 80)
        && isBoundedText(option['description'], 240)
        ? [{ id: option['id'], label: option['label'], description: option['description'] }]
        : [];
    });
    if (options.length !== question['options'].length) return [];
    if (new Set(options.map((option) => option.id)).size !== options.length) return [];
    if (new Set(options.map((option) => option.label.toLocaleLowerCase())).size !== options.length) return [];
    return [{
      id: question['id'],
      header: question['header'],
      question: question['question'],
      mode: question['mode'],
      options,
      allowOther: question['allowOther'],
    }];
  });
  if (questions.length !== input['questions'].length) return null;
  if (new Set(questions.map((question) => question.id)).size !== questions.length) return null;
  return {
    interactionId: input['interactionId'],
    providerRequestId: input['providerRequestId'],
    threadId: input['threadId'],
    turnId: input['turnId'],
    agent: input['agent'],
    source: input['source'],
    createdAt: input['createdAt'],
    updatedAt: input['updatedAt'],
    questions,
  };
}

function readUserQuestionOutcome(
  value: unknown,
  interaction: UserQuestionInteraction | null = null,
): UserQuestionOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const outcome = value as Record<string, unknown>;
  if (outcome['status'] === 'cancelled' && outcome['reason'] === 'user-stop') {
    return { status: 'cancelled', reason: 'user-stop' };
  }
  if (outcome['status'] === 'expired'
    && (outcome['reason'] === 'provider-disconnected'
      || outcome['reason'] === 'hub-restarted'
      || outcome['reason'] === 'request-invalidated')) {
    return { status: 'expired', reason: outcome['reason'] };
  }
  if (outcome['status'] !== 'answered' || !outcome['answers'] || typeof outcome['answers'] !== 'object') return null;
  const answers: Record<string, UserQuestionAnswer> = {};
  for (const [questionId, raw] of Object.entries(outcome['answers'] as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const answer = raw as Record<string, unknown>;
    if (!Array.isArray(answer['selectedOptionIds']) || answer['selectedOptionIds'].some((id) => typeof id !== 'string')) return null;
    if (new Set(answer['selectedOptionIds']).size !== answer['selectedOptionIds'].length) return null;
    if (answer['otherText'] !== undefined
      && (typeof answer['otherText'] !== 'string' || answer['otherText'].length > 2_000)) return null;
    answers[questionId] = {
      selectedOptionIds: [...answer['selectedOptionIds']] as string[],
      ...(typeof answer['otherText'] === 'string' ? { otherText: answer['otherText'] } : {}),
    };
  }
  if (interaction) {
    const questionIds = new Set(interaction.questions.map((question) => question.id));
    if (Object.keys(answers).length !== questionIds.size
      || Object.keys(answers).some((questionId) => !questionIds.has(questionId))) return null;
    for (const question of interaction.questions) {
      const answer = answers[question.id];
      if (!answer) return null;
      const optionIds = new Set(question.options.map((option) => option.id));
      if (answer.selectedOptionIds.some((optionId) => !optionIds.has(optionId))) return null;
      const otherText = answer.otherText?.trim() ?? '';
      if (otherText && !question.allowOther) return null;
      const count = answer.selectedOptionIds.length + (otherText ? 1 : 0);
      if (count === 0 || (question.mode === 'single' && count !== 1)) return null;
    }
  }
  return { status: 'answered', answers };
}

function readDocumentTemplate(value: unknown): DocumentTemplate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item['id'] !== 'string' || typeof item['name'] !== 'string'
    || typeof item['originalName'] !== 'string'
    || (item['format'] !== 'hwp' && item['format'] !== 'hwpx')
    || !Number.isFinite(Number(item['size'])) || !Number.isFinite(Number(item['revision']))) return null;
  return {
    id: item['id'],
    name: item['name'],
    originalName: item['originalName'],
    format: item['format'],
    size: Number(item['size']),
    pageCount: Math.max(0, Number(item['pageCount']) || 0),
    sectionCount: Math.max(0, Number(item['sectionCount']) || 0),
    contentHash: String(item['contentHash'] ?? ''),
    revision: Number(item['revision']),
    createdAt: String(item['createdAt'] ?? ''),
    updatedAt: String(item['updatedAt'] ?? ''),
  };
}

function readAgentInstructionsStatus(value: unknown): AgentInstructionsStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const revision = Number(item['revision']);
  const maxChars = Number(item['maxChars']);
  if (item['fileName'] !== 'AGENTS.md' || item['scope'] !== 'rauhwpx-app'
    || typeof item['content'] !== 'string'
    || !Number.isSafeInteger(revision) || revision < 1
    || !Number.isSafeInteger(maxChars) || maxChars < 1) return null;
  return {
    fileName: 'AGENTS.md',
    scope: 'rauhwpx-app',
    content: item['content'],
    revision,
    updatedAt: typeof item['updatedAt'] === 'string' ? item['updatedAt'] : null,
    maxChars,
  };
}

function readAgentInstructionsDraft(value: unknown): AgentInstructionsDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const expectedRevision = Number(item['expectedRevision']);
  if (typeof item['id'] !== 'string' || !item['id']
    || typeof item['content'] !== 'string'
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || (item['reason'] !== null && typeof item['reason'] !== 'string')
    || typeof item['requestedBy'] !== 'string'
    || typeof item['createdAt'] !== 'string' || !Number.isFinite(Date.parse(item['createdAt']))
    || typeof item['expiresAt'] !== 'string' || !Number.isFinite(Date.parse(item['expiresAt']))
    || typeof item['confirmationToken'] !== 'string' || !item['confirmationToken']) return null;
  return {
    id: item['id'],
    content: item['content'],
    expectedRevision,
    reason: item['reason'] as string | null,
    requestedBy: item['requestedBy'],
    createdAt: item['createdAt'],
    expiresAt: item['expiresAt'],
    confirmationToken: item['confirmationToken'],
  };
}

function readTemplateCatalog(value: unknown): TemplateCatalog {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    revision: Math.max(0, Number(source['revision']) || 0),
    templates: Array.isArray(source['templates'])
      ? source['templates'].flatMap((item) => {
        const template = readDocumentTemplate(item);
        return template ? [template] : [];
      })
      : [],
  };
}

function readTemplateResponse(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return readDocumentTemplate((value as Record<string, unknown>)['template']);
}

function isWritingStyleProgressState(value: unknown): value is WritingStyleProgressState {
  return value === 'queued'
    || value === 'reading'
    || value === 'extracting'
    || value === 'preparing'
    || value === 'analyzing'
    || value === 'synthesizing'
    || value === 'saving';
}

function readWritingStyleStatus(value: unknown): WritingStyleStatus {
  const src = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawSources = Array.isArray(src['sources'])
    ? src['sources']
    : Array.isArray(src['sourceDocuments']) ? src['sourceDocuments'] : null;
  const sources = rawSources
    ? rawSources.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const source = raw as Record<string, unknown>;
      if (typeof source['name'] !== 'string' || !source['name']) return [];
      const size = Number(source['size']);
      return [{
        ...(typeof source['id'] === 'string' ? { id: source['id'] } : {}),
        name: source['name'],
        ...(typeof source['type'] === 'string' ? { type: source['type'] } : {}),
        ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
        ...(typeof source['addedAt'] === 'string' ? { addedAt: source['addedAt'] } : {}),
      }];
    })
    : undefined;
  const sourceCount = Number(src['sourceCount']);
  const pageEstimate = Number(src['pageEstimate']);
  return {
    active: src['active'] === true,
    language: src['language'] === 'en' ? 'en' : 'ko',
    updatedAt: typeof src['updatedAt'] === 'string' ? src['updatedAt'] : null,
    sourceCount: Number.isFinite(sourceCount) && sourceCount >= 0 ? sourceCount : 0,
    pageEstimate: Number.isFinite(pageEstimate) && pageEstimate >= 0 ? pageEstimate : 0,
    summary: typeof src['summary'] === 'string' ? src['summary'] : '',
    additionalInstruction: typeof src['additionalInstruction'] === 'string'
      ? src['additionalInstruction']
      : '',
    ...(isAgentName(src['agent']) ? { agent: src['agent'] } : {}),
    ...(typeof src['model'] === 'string' ? { model: src['model'] } : {}),
    ...(sources ? { sources } : {}),
    ...(sources ? { sourceDocuments: sources } : {}),
    ...(Number.isFinite(Number(src['savedSourceCount'])) && Number(src['savedSourceCount']) >= 0
      ? { savedSourceCount: Number(src['savedSourceCount']) }
      : {}),
  };
}

function readWritingStyleProgress(value: Record<string, unknown>): WritingStyleProgress | null {
  if (!isWritingStyleProgressState(value['state'])) return null;
  const completed = Number(value['completed']);
  const total = Number(value['total']);
  return {
    state: value['state'],
    ...(typeof value['phase'] === 'string' ? { phase: value['phase'] } : {}),
    ...(typeof value['activity'] === 'string' ? { activity: value['activity'] } : {}),
    ...(typeof value['detail'] === 'string' ? { detail: value['detail'] } : {}),
    ...(Number.isFinite(completed) && completed >= 0 ? { completed } : {}),
    ...(Number.isFinite(total) && total > 0 ? { total } : {}),
    ...(isAgentName(value['agent']) ? { agent: value['agent'] } : {}),
    ...(typeof value['model'] === 'string' ? { model: value['model'] } : {}),
    ...(typeof value['startedAt'] === 'string' ? { startedAt: value['startedAt'] } : {}),
    ...(Number.isFinite(Number(value['elapsedMs'])) && Number(value['elapsedMs']) >= 0
      ? { elapsedMs: Number(value['elapsedMs']) }
      : {}),
  };
}

function readWritingStyleCatalogModel(value: unknown): WritingStyleCatalogModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;
  if (typeof src['id'] !== 'string' || !src['id']) return null;
  return {
    id: src['id'],
    name: typeof src['name'] === 'string' && src['name'] ? src['name'] : src['id'],
    efforts: Array.isArray(src['efforts']) ? src['efforts'].filter((item): item is string => typeof item === 'string') : [],
    defaultEffort: typeof src['defaultEffort'] === 'string' ? src['defaultEffort'] : null,
  };
}

function readWritingStyleCatalogProvider(value: unknown): WritingStyleCatalogProvider | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;
  if (!isAgentName(src['id'])) return null;
  return {
    id: src['id'],
    name: typeof src['name'] === 'string' && src['name'] ? src['name'] : src['id'],
    available: src['available'] === true,
    error: typeof src['error'] === 'string' ? src['error'] : null,
    models: Array.isArray(src['models'])
      ? src['models'].map(readWritingStyleCatalogModel).filter((item): item is WritingStyleCatalogModel => item !== null)
      : [],
  };
}

function readWritingStyleCatalog(value: unknown): WritingStyleCatalog {
  const src = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const selection = src['defaultSelection'];
  const defaultSelection = selection && typeof selection === 'object' && !Array.isArray(selection)
    ? selection as Record<string, unknown>
    : null;
  return {
    providers: Array.isArray(src['providers'])
      ? src['providers'].map(readWritingStyleCatalogProvider).filter((item): item is WritingStyleCatalogProvider => item !== null)
      : [],
    defaultSelection: defaultSelection
      && isAgentName(defaultSelection['agent'])
      && typeof defaultSelection['model'] === 'string'
      ? {
        agent: defaultSelection['agent'],
        model: defaultSelection['model'],
        ...(typeof defaultSelection['effort'] === 'string' ? { effort: defaultSelection['effort'] } : {}),
      }
      : null,
  };
}

function isReferenceScope(value: unknown): value is ReferenceScope {
  return value === 'chat' || value === 'document' || value === 'global';
}

function referenceStatus(value: unknown): ReferenceFile['status'] {
  return value === 'uploading' || value === 'extracting' || value === 'indexing'
    || value === 'ready' || value === 'error'
    ? value
    : 'ready';
}

/** 백엔드의 전방 호환 필드 별칭을 받아 UI의 단일 메타데이터 형태로 좁힌다. */
export function normalizeReferenceFile(
  value: unknown,
  fallback?: { scope: ReferenceScope; scopeId: string },
): ReferenceFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = item.id ?? item.referenceId;
  const name = item.name ?? item.fileName ?? item.filename;
  const scope = isReferenceScope(item.scope) ? item.scope : fallback?.scope;
  const scopeId = typeof item.scopeId === 'string' ? item.scopeId : fallback?.scopeId;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || !scope || !scopeId) {
    return null;
  }
  const size = Number(item.size ?? item.byteLength ?? 0);
  const chunkCount = Number(item.chunkCount);
  return {
    id,
    name,
    scope,
    scopeId,
    mimeType: typeof (item.mimeType ?? item.contentType) === 'string'
      ? String(item.mimeType ?? item.contentType)
      : 'application/octet-stream',
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    status: referenceStatus(item.status ?? item.state),
    createdAt: typeof (item.createdAt ?? item.uploadedAt) === 'string'
      ? String(item.createdAt ?? item.uploadedAt)
      : new Date(0).toISOString(),
    ...(typeof item.sha256 === 'string' ? { sha256: item.sha256 } : {}),
    ...(Number.isSafeInteger(chunkCount) && chunkCount >= 0 ? { chunkCount } : {}),
    ...(typeof item.error === 'string' && item.error ? { error: item.error } : {}),
    kind: item.kind === 'image' ? 'image' : 'document',
  };
}

export function normalizeReferenceSearchHit(
  value: unknown,
  fallback?: { scope: ReferenceScope; scopeId: string },
): ReferenceSearchHit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const referenceId = item.referenceId ?? item.fileId ?? item.id;
  const name = item.name ?? item.fileName ?? item.filename;
  const scope = isReferenceScope(item.scope) ? item.scope : fallback?.scope;
  const scopeId = typeof item.scopeId === 'string' ? item.scopeId : fallback?.scopeId;
  if (typeof referenceId !== 'string' || typeof name !== 'string' || !scope || !scopeId) return null;
  const score = Number(item.score ?? 0);
  const chunkIndex = Number(item.chunkIndex);
  const page = Number(item.page);
  return {
    referenceId,
    name,
    scope,
    scopeId,
    score: Number.isFinite(score) ? score : 0,
    snippet: typeof (item.snippet ?? item.text) === 'string' ? String(item.snippet ?? item.text) : '',
    ...(Number.isSafeInteger(chunkIndex) && chunkIndex >= 0 ? { chunkIndex } : {}),
    ...(typeof item.chunkId === 'string' ? { chunkId: item.chunkId } : {}),
    ...(item.page === null ? { page: null } : Number.isSafeInteger(page) && page >= 0 ? { page } : {}),
  };
}

function readCapabilityEpoch(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readProviderHealth(value: unknown): ProviderHealth {
  const src = (value ?? {}) as Record<string, unknown>;
  return {
    available: src['available'] === true,
    version: typeof src['version'] === 'string' ? src['version'] : null,
    error: typeof src['error'] === 'string' ? src['error'] : null,
    checkedAt: num(src['checkedAt']),
  };
}

/** 허브가 보낸 provider-status 를 항상 모든 프로바이더가 있는 형태로 정규화한다. */
function readProviderStatus(value: unknown): ProviderStatusMap {
  const src = (value ?? {}) as Record<string, unknown>;
  return {
    rau: readProviderHealth(src['rau']),
    claude: readProviderHealth(src['claude']),
    codex: readProviderHealth(src['codex']),
    pi: readProviderHealth(src['pi']),
    grok: readProviderHealth(src['grok']),
    cursor: readProviderHealth(src['cursor']),
    opencode: readProviderHealth(src['opencode']),
  };
}

function readAgentSetupStatus(value: unknown, agent: AgentName): AgentSetupStatus {
  const src = (value ?? {}) as Record<string, unknown>;
  const authMethod = src['authMethod'] === 'oauth' || src['authMethod'] === 'api-key'
    ? src['authMethod']
    : null;
  return {
    agent,
    available: src['available'] === true,
    connected: src['connected'] === true,
    installed: src['installed'] === true,
    installing: src['installing'] === true,
    version: typeof src['version'] === 'string' ? src['version'] : null,
    authenticated: src['authenticated'] === true,
    authMethod,
    keyTail: typeof src['keyTail'] === 'string' ? src['keyTail'] : null,
    account: typeof src['account'] === 'string' ? src['account'] : null,
    authenticating: src['authenticating'] === true,
    authOwnedByThisSession: src['authOwnedByThisSession'] === true,
    ...(typeof src['authRunId'] === 'string' ? { authRunId: src['authRunId'] } : {}),
    ...(typeof src['authPhase'] === 'string' ? { authPhase: src['authPhase'] } : {}),
    ...(typeof src['authUrl'] === 'string' ? { authUrl: src['authUrl'] } : {}),
    ...(typeof src['pairingCode'] === 'string' ? { pairingCode: src['pairingCode'] } : {}),
    ...(typeof src['expiresAt'] === 'string' ? { authExpiresAt: src['expiresAt'] } : {}),
    setupComplete: src['setupComplete'] === true,
    ...(src['exhausted'] === true ? { exhausted: true } : {}),
    latestVersion: typeof src['latestVersion'] === 'string' ? src['latestVersion'] : null,
    updateRequired: src['updateRequired'] === true,
    error: typeof src['error'] === 'string' ? src['error'] : null,
    // Cursor와 OpenCode는 CLI가 알려 주는 모델 목록을 함께 싣는다.
    ...(isStringArray(src['models']) ? { models: src['models'] } : {}),
  };
}

function readAgentSetupStatuses(value: unknown): AgentSetupStatusMap {
  const src = (value ?? {}) as Record<string, unknown>;
  return {
    rau: readAgentSetupStatus(src['rau'], 'rau'),
    claude: readAgentSetupStatus(src['claude'], 'claude'),
    codex: readAgentSetupStatus(src['codex'], 'codex'),
    pi: readAgentSetupStatus(src['pi'], 'pi'),
    grok: readAgentSetupStatus(src['grok'], 'grok'),
    cursor: readAgentSetupStatus(src['cursor'], 'cursor'),
    opencode: readAgentSetupStatus(src['opencode'], 'opencode'),
  };
}

function readAccountSessionStatus(value: unknown): AccountSessionStatus {
  const src = (value ?? {}) as Record<string, unknown>;
  const rawAccount = src['account'];
  const account = rawAccount && typeof rawAccount === 'object' && !Array.isArray(rawAccount)
    ? rawAccount as Record<string, unknown>
    : null;
  const state = src['state'] === 'signed-in'
    || src['state'] === 'pending'
    || src['state'] === 'unknown'
    ? src['state']
    : 'signed-out';
  const signedIn = state === 'signed-in' && src['signedIn'] === true;
  return {
    state: signedIn ? 'signed-in' : state === 'signed-in' ? 'signed-out' : state,
    signedIn,
    account: signedIn
      ? { email: typeof account?.['email'] === 'string' ? account['email'] : null }
      : null,
    updatedAt: typeof src['updatedAt'] === 'string' ? src['updatedAt'] : new Date(0).toISOString(),
    authenticating: src['authenticating'] === true,
    authOwnedByThisSession: src['authOwnedByThisSession'] === true,
    ...(typeof src['authRunId'] === 'string' ? { authRunId: src['authRunId'] } : {}),
    ...(typeof src['authPhase'] === 'string' ? { authPhase: src['authPhase'] } : {}),
    ...(typeof src['authUrl'] === 'string' ? { authUrl: src['authUrl'] } : {}),
    ...(typeof src['pairingCode'] === 'string' ? { pairingCode: src['pairingCode'] } : {}),
    ...(typeof src['expiresAt'] === 'string' ? { expiresAt: src['expiresAt'] } : {}),
    ...(typeof src['error'] === 'string' ? { error: src['error'] } : {}),
  };
}

function readUsageWindow(value: unknown): UsageWindow {
  const src = (value ?? {}) as Record<string, unknown>;
  return {
    turns: num(src['turns']),
    inputTokens: num(src['inputTokens']),
    outputTokens: num(src['outputTokens']),
    cacheReadTokens: num(src['cacheReadTokens']),
    cacheCreationTokens: num(src['cacheCreationTokens']),
    weightedTokens: num(src['weightedTokens']),
    percent: nullableNum(src['percent']),
    resetsAt: nullableNum(src['resetsAt']),
  };
}

function readUsageSource(value: unknown): UsageSource {
  return value === 'cliproxy' ? 'cliproxy' : 'estimate';
}

function readCliproxyWindow(value: unknown): { percent: number | null; resetsAt: number | null } {
  const src = (value ?? {}) as Record<string, unknown>;
  return {
    percent: nullableNum(src['percent']),
    resetsAt: nullableNum(src['resetsAt']),
  };
}

function readCliproxyAccounts(value: unknown): CliproxyAccount[] {
  if (!Array.isArray(value)) return [];
  const out: CliproxyAccount[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const src = raw as Record<string, unknown>;
    const agent = src['agent'] === 'codex' ? 'codex' : src['agent'] === 'claude' ? 'claude' : null;
    if (!agent) continue;
    out.push({
      agent,
      name: typeof src['name'] === 'string' && src['name'] ? src['name'] : 'unknown',
      email: typeof src['email'] === 'string' ? src['email'] : null,
      planType: typeof src['planType'] === 'string' ? src['planType'] : null,
      session: readCliproxyWindow(src['session']),
      week: readCliproxyWindow(src['week']),
      error: typeof src['error'] === 'string' ? src['error'] : null,
    });
  }
  return out;
}

function readCliproxyStatus(value: unknown): CliproxyStatus {
  const src = (value ?? {}) as Record<string, unknown>;
  return {
    configured: src['configured'] === true,
    connected: src['connected'] === true,
    url: typeof src['url'] === 'string' && src['url'] ? src['url'] : null,
    error: typeof src['error'] === 'string' ? src['error'] : null,
    checkedAt: nullableNum(src['checkedAt']),
    accounts: readCliproxyAccounts(src['accounts']),
  };
}

const MAX_USAGE_MODEL_ENTRIES = 512;
const MAX_USAGE_MODEL_NAME_CHARS = 256;

function readUsageByModel(value: unknown): Record<string, UsageModelBreakdown> {
  const out = Object.create(null) as Record<string, UsageModelBreakdown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const source = value as Record<string, unknown>;
  let visited = 0;
  for (const model in source) {
    if (!Object.hasOwn(source, model)) continue;
    if (visited >= MAX_USAGE_MODEL_ENTRIES) break;
    visited += 1;
    const raw = source[model];
    if (!model || model.length > MAX_USAGE_MODEL_NAME_CHARS
      || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const src = (raw ?? {}) as Record<string, unknown>;
    const costUsd = nullableNum(src['costUsd']);
    out[model] = {
      turns: num(src['turns']),
      inputTokens: num(src['inputTokens']),
      outputTokens: num(src['outputTokens']),
      weightedTokens: num(src['weightedTokens']),
      ...(costUsd !== null ? { costUsd } : {}),
    };
  }
  return out;
}

function readProviderUsage(value: unknown): ProviderUsage {
  const src = (value ?? {}) as Record<string, unknown>;
  const limit = (src['limit'] ?? {}) as Record<string, unknown>;
  return {
    session: readUsageWindow(src['session']),
    day: readUsageWindow(src['day']),
    week: readUsageWindow(src['week']),
    byModel: readUsageByModel(src['byModel']),
    limit: {
      session5h: nullableNum(limit['session5h']),
      week: nullableNum(limit['week']),
    },
    updatedAt: nullableNum(src['updatedAt']),
    source: readUsageSource(src['source']),
  };
}

function readOpenRouterCredits(value: unknown): OpenRouterCredits | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const src = value as Record<string, unknown>;
  return {
    balanceUsd: num(src['balanceUsd']),
    totalCreditsUsd: num(src['totalCreditsUsd']),
    totalUsageUsd: num(src['totalUsageUsd']),
    checkedAt: nullableNum(src['checkedAt']),
    error: typeof src['error'] === 'string' ? src['error'] : null,
  };
}

function readUsageSummary(value: unknown): UsageSummary | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const plans = (src['plans'] ?? {}) as Record<string, unknown>;
  const providers = (src['providers'] ?? {}) as Record<string, unknown>;
  const openrouter = readOpenRouterCredits(src['openrouter']);
  const rau = readOpenRouterCredits(src['rau']);
  return {
    plans: {
      claude: typeof plans['claude'] === 'string' ? plans['claude'] : 'pro',
      codex: typeof plans['codex'] === 'string' ? plans['codex'] : 'plus',
      pi: typeof plans['pi'] === 'string' ? plans['pi'] : 'api',
      grok: typeof plans['grok'] === 'string' ? plans['grok'] : 'api',
      cursor: typeof plans['cursor'] === 'string' ? plans['cursor'] : 'api',
      opencode: typeof plans['opencode'] === 'string' ? plans['opencode'] : 'api',
      rau: typeof plans['rau'] === 'string' ? plans['rau'] : 'api',
    },
    providers: {
      claude: readProviderUsage(providers['claude']),
      codex: readProviderUsage(providers['codex']),
      pi: readProviderUsage(providers['pi']),
      grok: readProviderUsage(providers['grok']),
      cursor: readProviderUsage(providers['cursor']),
      opencode: readProviderUsage(providers['opencode']),
      rau: readProviderUsage(providers['rau']),
    },
    cliproxy: readCliproxyStatus(src['cliproxy']),
    ...(openrouter ? { openrouter } : {}),
    ...(rau ? { rau } : {}),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readPiPricing(value: unknown): { prompt: number; completion: number } {
  const src = (value ?? {}) as Record<string, unknown>;
  return { prompt: num(src['prompt']), completion: num(src['completion']) };
}

function readPiModelConfig(value: unknown): PiModelConfig | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const id = src['id'];
  const name = src['name'];
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return null;
  return {
    id,
    name,
    reasoning: src['reasoning'] === true,
    supportsImages: src['supportsImages'] === true,
    efforts: isStringArray(src['efforts']) ? src['efforts'] : [],
    defaultEffort: typeof src['defaultEffort'] === 'string' ? src['defaultEffort'] : '',
    contextLength: num(src['contextLength']),
    pricing: readPiPricing(src['pricing']),
  };
}

function readPiModels(value: unknown): PiModelConfig[] {
  if (!Array.isArray(value)) return [];
  const out: PiModelConfig[] = [];
  for (const raw of value) {
    const model = readPiModelConfig(raw);
    if (model) out.push(model);
  }
  return out;
}

function readPiStatus(value: unknown): PiStatus {
  const src = (value ?? {}) as Record<string, unknown>;
  return {
    installed: src['installed'] === true,
    installing: src['installing'] === true,
    version: typeof src['version'] === 'string' ? src['version'] : null,
    keyConfigured: src['keyConfigured'] === true,
    keyTail: typeof src['keyTail'] === 'string' ? src['keyTail'] : null,
    models: readPiModels(src['models']),
    defaultModelId: typeof src['defaultModelId'] === 'string' ? src['defaultModelId'] : null,
    setupComplete: src['setupComplete'] === true,
    ...(src['exhausted'] === true ? { exhausted: true } : {}),
    latestVersion: typeof src['latestVersion'] === 'string' ? src['latestVersion'] : null,
    updateRequired: src['updateRequired'] === true,
    error: typeof src['error'] === 'string' ? src['error'] : null,
  };
}

function readPiCatalogModel(value: unknown): PiCatalogModel | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const id = src['id'];
  const name = src['name'];
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return null;
  return {
    id,
    name,
    provider: typeof src['provider'] === 'string' && src['provider']
      ? src['provider']
      : (id.split('/')[0] ?? id),
    contextLength: num(src['contextLength']),
    pricing: readPiPricing(src['pricing']),
    reasoning: src['reasoning'] === true,
    supportsImages: src['supportsImages'] === true,
  };
}

function readPiCatalog(value: unknown): PiCatalogModel[] {
  if (!Array.isArray(value)) return [];
  const out: PiCatalogModel[] = [];
  for (const raw of value) {
    const model = readPiCatalogModel(raw);
    if (model) out.push(model);
  }
  return out;
}

function readCheckpointTitleResult(value: unknown): CheckpointTitleResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;
  const provider = src['provider'];
  const title = src['title'];
  const revision = src['titleRevision'];
  if (provider !== 'pi' && provider !== 'codex' && provider !== 'grok' && provider !== 'claude') return null;
  if (typeof src['commitId'] !== 'string' || !src['commitId']) return null;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null;
  if (typeof title !== 'string' || !title || title.trim() !== title
    || /[\r\n\u0000-\u001f\u007f]/.test(title) || [...title].length > 72) return null;
  if (typeof src['model'] !== 'string' || !src['model']) return null;
  return {
    commitId: src['commitId'],
    titleRevision: revision,
    title,
    provider,
    model: src['model'],
  };
}

function isPiSetupState(value: unknown): value is 'preparing' | 'downloading' | 'installing' | 'configuring' | 'verifying' | 'done' {
  return value === 'preparing' || value === 'downloading' || value === 'installing'
    || value === 'configuring' || value === 'verifying' || value === 'done';
}

export class AgentBridgeImpl implements AgentBridge {
  readonly pendingEdits: PendingEditManager;

  private revision: RevisionTracker;
  private overlay: PendingOverlayRenderer;
  private reveal: AgentTypewriterReveal;
  private revealUnsub: (() => void) | null = null;
  private executor: AgentToolExecutor;

  private url = '';
  private token = '';
  private referenceToken = '';
  private templateToken = '';
  private sessionId = '';
  private httpBaseUrl = '';
  private readonly options?: AgentBridgeOptions;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  /** 지금까지 실패한 연결 시도 수. 연결이 열리면 0 으로 돌아간다. */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private hubLaunch: Promise<boolean> | null = null;
  private reconnectSeq = 0;
  private requests = new PendingRequestRegistry();
  /** 끊긴 사이에 완료된 도구 결과 — 재연결 직후 다시 보낸다. */
  private toolResponses = new ToolResponseBuffer();
  /** 사용자 답변은 로컬에서 만료시키지 않고, 재연결 뒤에도 같은 응답 ID로 다시 보낸다. */
  private pendingQuestionAnswer: { interactionId: string; responseId: string; frame: unknown } | null = null;
  /** 질문 취소는 허브가 해소를 확인할 때까지 같은 상호작용 ID로 다시 보낸다. */
  private pendingQuestionCancellation: {
    interactionId: string;
    frame: { v: number; type: 'chat-interrupt' | 'chat-stop' };
  } | null = null;
  private pendingUserQuestionId: string | null = null;
  private pendingUserQuestion: UserQuestionInteraction | null = null;
  private pendingInterrupt = false;
  private disposed = false;

  private listeners = new Set<(e: SidebarEvent) => void>();
  private selectedAgent: AgentName = 'codex';
  private selectedModel: string | null = null;
  private selectedEffort: string | null = null;
  private permissionProfile: PermissionProfile = 'safe';
  private serviceTier: ServiceTier = 'standard';
  private workflow: AgentWorkflow = 'direct';
  private phase: AgentPhase = 'direct';
  private capabilityEpoch: number | null = null;
  private latestPlan: StructuredPlan | null = null;
  private activeAgent: AgentName | null = null;
  private turnRunning = false;
  /** Hub-issued identity for the one root provider turn allowed to mutate. */
  private activeProviderTurnId: string | null = null;
  private interruptedProviderTurnId: string | null = null;
  private editingAgent: AgentName = 'codex';
  private activeToolRequests = 0;
  private activeToolRequestControllers = new Map<number, {
    controller: AbortController;
    turnBound: boolean;
    providerTurnId: string | null;
    releaseEditingLease: () => void;
  }>();
  private editingLease: AgentEditingLease = { active: false, agent: 'codex' };
  private editingLeaseListeners = new Set<(lease: AgentEditingLease) => void>();
  /** 구상 중 사용자 편집이 있었고, 저장 알림을 아직 보내지 않았다. */
  private userEditedSincePlanningNotify = false;
  private documentNotifyUnsubs: Array<() => void> = [];
  /** /plan 전환이 허브(특히 Codex setExecutionMode) 왕복을 기다리는 동안. */
  private workflowSwitchPending = false;
  private workflowBeforeSwitch: { workflow: AgentWorkflow; phase: AgentPhase } | null = null;
  private turnHadError = false;
  private pendingTurnOpen = false;
  private chatStartSent = false;
  private pendingChatStart: {
    requestId: string;
    agent: AgentName;
    model?: string;
    effort?: string;
    permissionProfile?: PermissionProfile;
    serviceTier?: ServiceTier;
    workflow: AgentWorkflow;
    threadId: string;
    documentId: string | null;
    documentName: string | null;
    history: ChatHistoryEntry[];
    force?: boolean;
  } | null = null;
  private queuedMessages: Array<{
    text: string;
    skillName?: string;
    context: ReferenceScopeContext;
    messageId?: string;
    stagedReferenceIds?: string[];
    resolve(messageId: string | null): void;
  }> = [];
  private threadId = '';
  private documentId: string | null = null;
  private documentName: string | null = null;
  private chatHistory: ChatHistoryEntry[] = [];
  private titleRequestSeq = 0;
  private requestSeq = 0;
  private templateCatalog: TemplateCatalog = { revision: 0, templates: [] };
  private activeTemplate: DocumentTemplate | null = null;
  private activeTemplateId: string | null = null;

  constructor(deps: AgentBridgeDeps, opts?: AgentBridgeOptions) {
    this.revision = new RevisionTracker(deps.eventBus);
    this.overlay = new PendingOverlayRenderer({
      canvasView: deps.canvasView,
      wasm: deps.wasm,
      eventBus: deps.eventBus,
    });
    this.pendingEdits = new PendingEditManager({
      wasm: deps.wasm,
      eventBus: deps.eventBus,
      inputHandler: deps.inputHandler,
      canvasView: deps.canvasView,
      overlay: this.overlay,
    });
    this.reveal = new AgentTypewriterReveal({
      canvasView: deps.canvasView,
      wasm: deps.wasm,
      eventBus: deps.eventBus,
    });
    // 승인/거절/무효화 시 진행 중인 타자기 공개를 즉시 완료한다 — 커버가
    // 사라진 op 위에 남지 않도록.
    this.revealUnsub = this.pendingEdits.onChange((e) => {
      if (e.type === 'approved' || e.type === 'rejected' || e.type === 'invalidated') {
        this.reveal.finishAll();
      }
    });
    this.executor = new AgentToolExecutor({
      wasm: deps.wasm,
      inputHandler: deps.inputHandler,
      documentState: deps.documentState,
      revision: this.revision,
      pending: this.pendingEdits,
      loadTemplateBytes: (template) => this.downloadTemplateBytes(template),
      getDocumentSourcePath: () => getNativeFileSourcePath(deps.wasm.currentFileHandle),
      isReadOnly: deps.isReadOnly,
      canPublishCloudDocument: deps.canPublishCloudDocument,
    });

    this.options = opts;
    this.documentNotifyUnsubs.push(
      deps.eventBus.on('document-changed', () => this.markUserDocumentEdit()),
      deps.eventBus.on('document-mutated', () => this.markUserDocumentEdit()),
      deps.eventBus.on('document-saved', () => this.notifyPlanningDocumentSaved()),
    );
    window.addEventListener('focus', this.onResume);
    window.addEventListener('online', this.onResume);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.setState('connecting');
    void this.initializeConnection();
  }

  private async initializeConnection() {
    await this.requestHubLaunch();
    if (this.disposed || !(await this.refreshSessionContext())) return;
    this.connect();
  }

  private async refreshSessionContext() {
    const context = await resolveRendererSessionContext(undefined, {
      hubUrl: this.options?.url,
      hubToken: this.options?.token,
      referenceToken: this.options?.referenceToken,
      templateToken: this.options?.templateToken,
      launchId: this.options?.launchId,
      sessionId: this.options?.sessionId,
    });
    if (this.disposed) return false;
    if (!context) {
      this.setState('disconnected');
      return false;
    }
    try {
      this.applySessionContext(context);
      return true;
    } catch (error) {
      console.warn('[AgentBridge] 세션 구성 적용 실패:', error);
      this.setState('disconnected');
      return false;
    }
  }

  private applySessionContext(context: RendererSessionContext) {
    this.url = websocketHubUrl(context.hubUrl);
    this.httpBaseUrl = httpHubUrl(context.hubUrl);
    this.token = context.hubToken;
    this.referenceToken = context.referenceToken;
    this.templateToken = context.templateToken;
    if (this.sessionId !== context.sessionId) {
      this.sessionId = context.sessionId;
      this.restorePendingQuestionCancellation();
    }
  }

  private questionCancellationStorageKey(): string | null {
    return this.sessionId
      ? `${QUESTION_CANCELLATION_STORAGE_PREFIX}${encodeURIComponent(this.sessionId)}`
      : null;
  }

  private persistPendingQuestionCancellation(): void {
    const key = this.questionCancellationStorageKey();
    if (!key || !this.pendingQuestionCancellation) return;
    try {
      sessionStorage.setItem(key, JSON.stringify({
        interactionId: this.pendingQuestionCancellation.interactionId,
        type: this.pendingQuestionCancellation.frame.type,
      }));
    } catch (e) {
      console.warn('[AgentBridge] 질문 취소 상태 저장 실패:', e);
    }
  }

  private restorePendingQuestionCancellation(): void {
    const key = this.questionCancellationStorageKey();
    this.pendingQuestionCancellation = null;
    if (!key) return;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object') throw new Error('invalid cancellation state');
      const interactionId = Reflect.get(value, 'interactionId');
      const type = Reflect.get(value, 'type');
      if (typeof interactionId !== 'string' || !interactionId
        || (type !== 'chat-interrupt' && type !== 'chat-stop')) {
        throw new Error('invalid cancellation state');
      }
      this.pendingQuestionCancellation = {
        interactionId,
        frame: { v: AGENT_PROTOCOL_VERSION, type },
      };
    } catch (e) {
      try { sessionStorage.removeItem(key); } catch { /* 저장소 접근 불가 */ }
      console.warn('[AgentBridge] 질문 취소 상태 복원 실패:', e);
    }
  }

  private setPendingQuestionCancellation(
    interactionId: string,
    type: 'chat-interrupt' | 'chat-stop',
  ): void {
    this.pendingQuestionCancellation = {
      interactionId,
      frame: { v: AGENT_PROTOCOL_VERSION, type },
    };
    this.persistPendingQuestionCancellation();
  }

  private clearPendingQuestionCancellation(): void {
    this.pendingQuestionCancellation = null;
    const key = this.questionCancellationStorageKey();
    if (!key) return;
    try {
      sessionStorage.removeItem(key);
    } catch (e) {
      console.warn('[AgentBridge] 질문 취소 상태 삭제 실패:', e);
    }
  }

  /** 끊겼거나 다른 탭에 밀려난 뒤 창이 다시 살아나면 즉시 붙는다. */
  private onResume = (): void => {
    if (this.disposed || this.state === 'connected' || this.state === 'connecting') return;
    void this.reconnectNow();
  };

  private onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    this.onResume();
  };

  /** 데스크톱·Vite 가 있으면 허브를 확인하고, 죽어 있으면 다시 띄운 뒤 준비될 때까지 기다린다. */
  private requestHubLaunch(): Promise<boolean> {
    if (!this.hubLaunch) {
      this.hubLaunch = ensureDesktopAgentHub().finally(() => {
        this.hubLaunch = null;
      });
    }
    return this.hubLaunch;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer === null) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  /** 진행 중 소켓을 핸들러 없이 닫아, 닫힘 이벤트가 재시도를 이중으로 걸지 않게 한다. */
  private abortSocket(): void {
    this.abortActiveToolRequests();
    const ws = this.ws;
    this.ws = null;
    this.clearConnectTimer();
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // 이미 닫힌 소켓은 무시.
    }
  }

  /** 백오프와 멈춘 핸드셰이크를 접고 지금 붙는다. */
  private forceReconnect(): void {
    if (this.disposed) return;
    if (!this.url || !this.token || !this.sessionId) {
      void this.initializeConnection();
      return;
    }
    this.clearReconnectTimer();
    this.abortSocket();
    this.reconnectAttempt = 0;
    this.connect();
  }

  takeOverConnection(): void {
    this.forceReconnect();
  }

  async reconnectNow(): Promise<void> {
    if (this.disposed || this.state === 'connected') return;
    const seq = ++this.reconnectSeq;
    this.clearReconnectTimer();
    this.abortSocket();
    this.setState('connecting');
    await this.requestHubLaunch();
    if (this.disposed || seq !== this.reconnectSeq || this.getConnectionState() === 'connected') return;
    if (!await this.refreshSessionContext()) return;
    this.forceReconnect();
  }

  // ─── connection ───────────────────────────────────────────

  private connect(): void {
    if (this.disposed) return;
    this.abortSocket();
    const base = this.url.replace(/\/$/, '');
    const wsUrl = `${base}/studio?token=${encodeURIComponent(this.token)}&sessionId=${encodeURIComponent(this.sessionId)}`
      + `&instance=${encodeURIComponent(STUDIO_INSTANCE_ID)}`;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[AgentBridge] WebSocket 생성 실패:', e);
      this.reconnectAttempt++;
      this.setState('disconnected');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.disposed || this.ws !== ws || this.state !== 'connecting') return;
      try {
        ws.close();
      } catch {
        // onclose 가 뒤따른다.
      }
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.disposed || this.ws !== ws) return;
      this.clearConnectTimer();
      this.reconnectAttempt = 0;
      this.setState('connected');
      // 끊긴 사이에 끝난 도구 결과를 먼저 흘려보낸다 — 허브의 인플라이트 호출이
      // 30초 타임아웃까지 가지 않고 이 응답으로 마무리된다.
      this.flushToolResponses();
      this.flushPendingQuestionCancellation();
      if (!this.pendingQuestionCancellation
        && this.pendingInterrupt
        && this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-interrupt' })) {
        this.pendingInterrupt = false;
      }
      this.flushPendingQuestionAnswer();
      this.chatStartSent = false;
      this.sendPendingChatStart();
    };
    ws.onmessage = (ev) => {
      if (this.disposed || this.ws !== ws) return;
      this.handleFrame(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearConnectTimer();
      this.abortActiveToolRequests();
      if (this.disposed) return;
      // 응답을 기다리던 요청은 연결과 함께 사라진다 — null 로 닫아 UI 가 멈추지 않게.
      this.requests.cancelAll();
      if (ev.code === CLOSE_CODE_REPLACED) {
        // 다른 탭이 허브를 차지했다. 자동 재접속하면 서로 끝없이 밀어내므로
        // 이 탭이 다시 포커스를 받을 때까지 대기한다(마지막 활성 탭 우선).
        // 허브는 이미 이 탭의 인플라이트 호출을 실패시켰으니 버퍼도 비운다.
        this.toolResponses.clear();
        this.setState('replaced');
        return;
      }
      this.reconnectAttempt++;
      this.setState('disconnected');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose가 뒤따르므로 재접속은 거기서 처리한다.
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    void this.requestHubLaunch();
    const step = Math.min(
      Math.max(0, this.reconnectAttempt - 1),
      RECONNECT_DELAYS_MS.length - 1,
    );
    const delay = RECONNECT_DELAYS_MS[step]!;
    const seq = this.reconnectSeq;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectAfterHub(seq);
    }, delay);
    // 사이드바가 "n초 후 재시도" 를 셀 수 있도록 남은 시간을 함께 알린다.
    this.emitConnection(delay);
  }

  /** 허브가 뜰 때까지 기다린 다음 소켓을 연다. 그 사이 수동 재연결이 있으면 접는다. */
  private async connectAfterHub(seq: number): Promise<void> {
    await this.requestHubLaunch();
    if (this.disposed || seq !== this.reconnectSeq || this.state === 'connected') return;
    if (!await this.refreshSessionContext()) return;
    this.connect();
  }

  /** 재시도 계기(시도 횟수·남은 시간)를 실은 connection 이벤트. */
  private emitConnection(retryInMs?: number): void {
    this.emit({
      type: 'connection',
      state: this.state,
      attempt: this.reconnectAttempt,
      ...(retryInMs !== undefined ? { retryInMs } : {}),
    });
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitConnection();
  }

  private sendJson(obj: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch (e) {
        console.warn('[AgentBridge] 전송 실패:', e);
      }
    }
    return false;
  }

  private workflowState() {
    return {
      workflow: this.workflow,
      phase: this.phase,
      capabilityEpoch: this.capabilityEpoch,
      latestPlan: this.latestPlan,
    };
  }

  private resetWorkflowState(workflow: AgentWorkflow = 'direct') {
    this.workflow = workflow;
    this.phase = workflow === 'plan' ? 'planning' : workflow === 'question' ? 'questioning' : 'direct';
    this.capabilityEpoch = null;
    this.latestPlan = null;
    if (!planModeAllowsUserEditing(this.workflow, this.phase)) this.userEditedSincePlanningNotify = false;
    this.syncEditingLease();
  }

  private syncWorkflowState(
    source: Record<string, unknown>,
    fallbackWorkflow: AgentWorkflow,
    fallbackPhase: AgentPhase,
    preservePlan = false,
  ) {
    this.workflow = isAgentWorkflow(source['workflow']) ? source['workflow'] : fallbackWorkflow;
    this.phase = this.workflow === 'direct'
      ? 'direct'
      : (isAgentPhase(source['phase']) ? source['phase'] : fallbackPhase);
    this.capabilityEpoch = readCapabilityEpoch(source['capabilityEpoch']);
    const hasPlan = Object.prototype.hasOwnProperty.call(source, 'latestPlan')
      || Object.prototype.hasOwnProperty.call(source, 'plan');
    if (hasPlan) {
      const candidate = source['latestPlan'] ?? source['plan'];
      this.latestPlan = isStructuredPlan(candidate) ? candidate : null;
    } else if (!preservePlan) {
      this.latestPlan = null;
    }
    if (!planModeAllowsUserEditing(this.workflow, this.phase)) {
      this.userEditedSincePlanningNotify = false;
    }
    this.syncEditingLease();
  }

  private canStagePendingEdits() {
    return this.workflow === 'direct' || this.phase === 'implementing';
  }

  private beginPendingTurn(agent: AgentName) {
    if (this.pendingTurnOpen || !this.canStagePendingEdits()) return;
    this.executor.beginTurn();
    this.pendingEdits.beginTurn(agent);
    this.pendingTurnOpen = true;
  }

  private finishWorkflowSwitch(): void {
    this.workflowSwitchPending = false;
    this.workflowBeforeSwitch = null;
  }

  private revertWorkflowSwitch(): void {
    const previous = this.workflowBeforeSwitch;
    this.finishWorkflowSwitch();
    if (!previous) return;
    this.workflow = previous.workflow;
    this.phase = previous.phase;
    this.syncEditingLease();
  }

  private beginWorkflowSwitch(workflow: AgentWorkflow): void {
    const restartCompletedPlan = workflow === 'plan'
      && this.workflow === 'plan'
      && this.phase === 'implementing';
    if (this.workflow === workflow && !restartCompletedPlan) return;
    this.workflowBeforeSwitch = { workflow: this.workflow, phase: this.phase };
    this.workflowSwitchPending = true;
    this.resetWorkflowState(workflow);
  }

  private markUserDocumentEdit(): void {
    if (planModeAllowsUserEditing(this.workflow, this.phase)) {
      this.userEditedSincePlanningNotify = true;
    }
  }

  private notifyPlanningDocumentSaved(): void {
    if (!planModeAllowsUserEditing(this.workflow, this.phase)) return;
    if (!this.userEditedSincePlanningNotify) return;
    if (!this.activeAgent || this.state !== 'connected') return;
    this.userEditedSincePlanningNotify = false;
    const sent = this.sendJson({
      v: AGENT_PROTOCOL_VERSION,
      type: 'chat-document-saved',
      revision: this.revision.revision,
      ...(this.documentName ? { fileName: this.documentName } : {}),
    });
    if (!sent) {
      this.userEditedSincePlanningNotify = true;
      return;
    }
    this.emit({ type: 'planning-document-saved', revision: this.revision.revision });
  }

  private syncEditingLease(): void {
    const next = deriveAgentEditingLease({
      turnRunning: this.turnRunning,
      activeToolRequests: this.activeToolRequests,
      agent: this.editingAgent,
      workflow: this.workflow,
      phase: this.phase,
      waitingForUser: this.pendingUserQuestionId !== null,
    });
    if (next.active === this.editingLease.active
      && next.agent === this.editingLease.agent
      && next.waitingForUser === this.editingLease.waitingForUser) return;
    this.editingLease = next;
    for (const listener of this.editingLeaseListeners) {
      try { listener({ ...next }); } catch (error) {
        console.warn('[AgentBridge] 편집 잠금 리스너 오류:', error);
      }
    }
  }

  private abortActiveToolRequests(): void {
    for (const [id, request] of this.activeToolRequestControllers) {
      this.cancelActiveToolRequest(id, request);
    }
  }

  private abortProviderToolRequests(providerTurnId?: string): void {
    for (const [id, request] of this.activeToolRequestControllers) {
      if (!request.turnBound) continue;
      if (providerTurnId && request.providerTurnId !== providerTurnId) continue;
      this.cancelActiveToolRequest(id, request);
    }
  }

  private cancelActiveToolRequest(
    id: number,
    request: {
      controller: AbortController;
      releaseEditingLease: () => void;
    },
  ): void {
    if (this.activeToolRequestControllers.get(id) === request) {
      this.activeToolRequestControllers.delete(id);
    }
    request.controller.abort();
    request.releaseEditingLease();
  }

  /**
   * 성공한 턴의 편집 처리는 권한 프로필이 가른다:
   * 안전(safe) → 'review' (사용자 승인 대기), 전체(unrestricted) → 'commit' (자동 반영).
   */
  private successfulTurnOutcome(): 'review' | 'commit' {
    return this.permissionProfile === 'safe' ? 'review' : 'commit';
  }

  /**
   * 결과를 모르는 턴 종료(재연결 등)의 기본값: 안전 모드는 편집을 검토 대기로
   * 남겨 사용자가 결정하고, 전체 모드는 기존대로 롤백한다.
   */
  private endPendingTurn(
    outcome: 'commit' | 'reject' | 'review' =
      this.permissionProfile === 'safe' ? 'review' : 'reject',
  ) {
    if (!this.pendingTurnOpen) return;
    try {
      this.pendingEdits.endTurn(outcome);
    } finally {
      this.executor.endTurn();
      this.pendingTurnOpen = false;
    }
  }

  // ─── incoming frames ──────────────────────────────────────

  private handleFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn('[AgentBridge] 잘못된 JSON 프레임 무시');
      return;
    }
    if (msg === null || typeof msg !== 'object') return;
    if (msg.v !== AGENT_PROTOCOL_VERSION) {
      this.sendJson({
        v: AGENT_PROTOCOL_VERSION,
        type: 'protocol-error',
        code: 'UNSUPPORTED_VERSION',
        message: `Unsupported protocol version: ${msg.v}`,
        supportedVersions: [AGENT_PROTOCOL_VERSION],
      });
      return;
    }
    try {
      this.handleMessage(msg);
    } catch (e) {
      console.warn('[AgentBridge] 메시지 처리 오류:', e);
    }
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'welcome': {
        // A reconnect snapshot predates the start command replayed on socket open.
        if (this.pendingChatStart) return;
        const session = msg.session;
        const sessionThreadId = typeof session?.threadId === 'string' ? session.threadId : '';
        if (this.threadId && sessionThreadId !== this.threadId) {
          // pendingChatStart 는 자기 응답이 올 때까지 살아 있으므로,
          // 재연결 소켓은 이미 마지막으로 선택한 스레드를 다시 보낸 상태다.
          return;
        }
        const wasRunning = this.turnRunning;
        if (session && isAgentName(session.agent)) {
          this.selectedAgent = session.agent;
          this.activeAgent = session.agent;
          this.editingAgent = session.agent;
          if (typeof session.model === 'string') this.selectedModel = session.model;
          if (typeof session.effort === 'string' || session.effort === null) this.selectedEffort = session.effort;
          if (sessionThreadId) this.threadId = sessionThreadId;
          if (typeof session.documentId === 'string' || session.documentId === null) this.documentId = session.documentId;
          if (typeof session.documentName === 'string' || session.documentName === null) this.documentName = session.documentName;
          this.turnRunning = session.status === 'running';
          this.activeProviderTurnId = this.turnRunning && typeof session.turnId === 'string'
            ? session.turnId
            : null;
          this.permissionProfile = session.permissionProfile === 'unrestricted' ? 'unrestricted' : 'safe';
          this.serviceTier = session.serviceTier === 'fast' ? 'fast' : 'standard';
          this.activeTemplateId = typeof session.activeTemplateId === 'string' ? session.activeTemplateId : null;
          this.activeTemplate = this.activeTemplateId
            ? this.templateCatalog.templates.find((template) => template.id === this.activeTemplateId) ?? null
            : null;
          const previousQuestion = this.pendingUserQuestion;
          let pendingQuestion = readUserQuestionInteraction(session.pendingUserQuestion);
          if (this.pendingQuestionCancellation) {
            if (pendingQuestion?.interactionId === this.pendingQuestionCancellation.interactionId) {
              // 허브가 아직 취소를 처리하지 않았다. 질문은 다시 표시하지 않고 취소를 재전송한다.
              this.flushPendingQuestionCancellation();
              pendingQuestion = null;
            } else {
              // 허브 스냅샷에 대상 질문이 없거나 새 질문으로 바뀌었으면 취소가 확정된 것이다.
              this.clearPendingQuestionCancellation();
            }
          }
          if (previousQuestion && previousQuestion.interactionId !== pendingQuestion?.interactionId) {
            if (this.pendingQuestionAnswer?.interactionId === previousQuestion.interactionId) {
              this.pendingQuestionAnswer = null;
            }
            this.emit({
              type: 'user-question-resolved',
              interactionId: previousQuestion.interactionId,
              outcome: { status: 'expired', reason: 'request-invalidated' },
            });
          }
          this.pendingUserQuestion = pendingQuestion;
          this.pendingUserQuestionId = pendingQuestion?.interactionId ?? null;
          this.finishWorkflowSwitch();
          this.syncWorkflowState(session, this.workflow, this.phase);
          this.pendingChatStart = null;
          this.notifyPlanningDocumentSaved();
          this.emit({
            type: 'chat-started',
            agent: session.agent,
            sessionId: typeof session.sessionId === 'string' ? session.sessionId : null,
            ...(typeof session.model === 'string' ? { model: session.model } : {}),
            ...(typeof session.effort === 'string' ? { effort: session.effort } : {}),
            ...(sessionThreadId ? { threadId: sessionThreadId } : {}),
            ...(typeof session.documentId === 'string' || session.documentId === null ? { documentId: session.documentId } : {}),
            ...(typeof session.documentName === 'string' || session.documentName === null ? { documentName: session.documentName } : {}),
            permissionProfile: this.permissionProfile,
            serviceTier: this.serviceTier,
            ...this.workflowState(),
          });
          if (pendingQuestion) {
            this.syncEditingLease();
            this.emit({ type: 'user-question-requested', interaction: pendingQuestion, replayed: true });
          }
          if (this.turnRunning) {
            try {
              this.beginPendingTurn(session.agent);
            } catch (e) {
              console.warn('[AgentBridge] reconnect beginTurn 실패:', e);
            }
          } else if (this.pendingTurnOpen) {
            try {
              this.endPendingTurn();
            } catch (e) {
              console.warn('[AgentBridge] reconnect endTurn 실패:', e);
            }
          }
        } else {
          this.activeAgent = null;
          const droppedQuestion = this.pendingUserQuestion;
          this.pendingUserQuestion = null;
          this.pendingUserQuestionId = null;
          this.pendingQuestionAnswer = null;
          this.clearPendingQuestionCancellation();
          if (droppedQuestion) {
            this.emit({
              type: 'user-question-resolved',
              interactionId: droppedQuestion.interactionId,
              outcome: { status: 'expired', reason: 'hub-restarted' },
            });
          }
          this.activeTemplateId = null;
          this.activeTemplate = null;
          this.turnRunning = false;
          this.activeProviderTurnId = null;
          this.abortActiveToolRequests();
          if (this.pendingTurnOpen) {
            try {
              this.endPendingTurn();
            } catch (e) {
              console.warn('[AgentBridge] reconnect endTurn 실패:', e);
            }
          }
          if (this.workflow === 'plan' || this.workflow === 'question' || this.workflowSwitchPending) {
            this.finishWorkflowSwitch();
            this.syncEditingLease();
          } else {
            this.resetWorkflowState();
          }
        }
        this.syncEditingLease();
        this.emit({ type: 'workflow-changed', ...this.workflowState() });
        this.flushQueuedMessages();
        if (wasRunning && !this.turnRunning) {
          // 연결이 끊긴 사이에 끝난 턴 — 잃어버린 turn-end 를 합성해 UI 를 되돌린다.
          if (this.pendingTurnOpen) {
            try {
              this.endPendingTurn();
            } catch (e) {
              console.warn('[AgentBridge] endTurn 실패:', e);
            }
          }
          // setState 는 상태가 같으면 무시하므로 직접 emit 해 사이드바가
          // isTurnRunning() 으로 재동기화하도록 한다.
          this.emitConnection();
        }
        break;
      }
      case 'user-question-requested': {
        const interaction = readUserQuestionInteraction(msg.interaction);
        if (!interaction || (this.threadId && interaction.threadId !== this.threadId)) break;
        if (this.pendingQuestionCancellation?.interactionId === interaction.interactionId) {
          // 취소 프레임과 엇갈려 도착한 재생 요청은 UI에 되살리지 않는다.
          this.flushPendingQuestionCancellation();
          break;
        }
        if (this.pendingQuestionCancellation) this.clearPendingQuestionCancellation();
        this.pendingUserQuestionId = interaction.interactionId;
        this.pendingUserQuestion = interaction;
        this.syncEditingLease();
        this.emit({
          type: 'user-question-requested',
          interaction,
          ...(msg.replayed === true ? { replayed: true } : {}),
        });
        break;
      }
      case 'user-question-resolved': {
        const interactionId = typeof msg.interactionId === 'string' ? msg.interactionId : '';
        const outcome = readUserQuestionOutcome(
          msg.outcome,
          this.pendingUserQuestion?.interactionId === interactionId ? this.pendingUserQuestion : null,
        );
        if (!interactionId || !outcome) break;
        if (this.pendingQuestionAnswer?.interactionId === interactionId) this.pendingQuestionAnswer = null;
        if (this.pendingQuestionCancellation?.interactionId === interactionId) {
          this.clearPendingQuestionCancellation();
        }
        if (this.pendingUserQuestionId === interactionId) this.pendingUserQuestionId = null;
        if (this.pendingUserQuestion?.interactionId === interactionId) this.pendingUserQuestion = null;
        this.syncEditingLease();
        this.emit({ type: 'user-question-resolved', interactionId, outcome });
        break;
      }
      case 'user-question-answer-result': {
        const interactionId = typeof msg.interactionId === 'string' ? msg.interactionId : '';
        const responseId = typeof msg.responseId === 'string' ? msg.responseId : '';
        if (!interactionId || !responseId) break;
        if (this.pendingQuestionAnswer?.responseId === responseId) this.pendingQuestionAnswer = null;
        this.emit({
          type: 'user-question-answer-result',
          interactionId,
          responseId,
          ok: msg.ok === true,
          ...(typeof msg.code === 'string' ? { code: msg.code } : {}),
          ...(typeof msg.message === 'string' ? { message: msg.message } : {}),
        });
        break;
      }
      case 'chat-started': {
        if (typeof msg.requestId === 'string' && msg.requestId !== this.pendingChatStart?.requestId) break;
        // 스레드를 빠르게 오가면 이전 chat-start 응답이 뒤늦게 도착할 수 있다.
        // 마지막 startChat 이 고른 정체성을 절대 덮어쓰지 않는다.
        if (typeof msg.threadId === 'string' && this.threadId && msg.threadId !== this.threadId) break;
        const replacedSession = this.pendingChatStart !== null;
        this.pendingChatStart = null;
        this.chatStartSent = false;
        if (replacedSession) this.clearPendingQuestionCancellation();
        if (isAgentName(msg.agent)) {
          this.selectedAgent = msg.agent;
          this.activeAgent = msg.agent;
          this.editingAgent = msg.agent;
        }
        if (typeof msg.model === 'string' || msg.model === null) this.selectedModel = msg.model;
        if (typeof msg.effort === 'string' || msg.effort === null) this.selectedEffort = msg.effort;
        if (msg.permissionProfile === 'safe' || msg.permissionProfile === 'unrestricted') this.permissionProfile = msg.permissionProfile;
        if (msg.serviceTier === 'fast' || msg.serviceTier === 'standard') this.serviceTier = msg.serviceTier;
        if (typeof msg.threadId === 'string') this.threadId = msg.threadId;
        if (typeof msg.documentId === 'string' || msg.documentId === null) this.documentId = msg.documentId;
        if (typeof msg.documentName === 'string' || msg.documentName === null) this.documentName = msg.documentName;
        const fallbackWorkflow = this.workflow;
        const fallbackPhase = this.phase;
        this.finishWorkflowSwitch();
        this.syncWorkflowState(msg, fallbackWorkflow, fallbackPhase);
        this.emit({
          type: 'chat-started',
          agent: isAgentName(msg.agent) ? msg.agent : this.selectedAgent,
          sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
          ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
          ...(typeof msg.effort === 'string' ? { effort: msg.effort } : {}),
          ...(typeof msg.threadId === 'string' ? { threadId: msg.threadId } : {}),
          ...(typeof msg.documentId === 'string' || msg.documentId === null ? { documentId: msg.documentId } : {}),
          ...(typeof msg.documentName === 'string' || msg.documentName === null ? { documentName: msg.documentName } : {}),
          permissionProfile: this.permissionProfile,
          serviceTier: this.serviceTier,
          ...this.workflowState(),
        });
        this.flushQueuedMessages();
        this.notifyPlanningDocumentSaved();
        break;
      }
      case 'chat-permission-changed': {
        if (msg.permissionProfile === 'safe' || msg.permissionProfile === 'unrestricted') {
          this.permissionProfile = msg.permissionProfile;
          this.emit({ type: 'permission-changed', permissionProfile: this.permissionProfile });
        }
        break;
      }
      case 'chat-service-tier-changed': {
        if (msg.serviceTier === 'fast' || msg.serviceTier === 'standard') {
          this.serviceTier = msg.serviceTier;
          this.emit({ type: 'service-tier-changed', serviceTier: this.serviceTier });
        }
        break;
      }
      case 'chat-reference-status': {
        const attachments = Array.isArray(msg.attachments)
          ? msg.attachments.flatMap((raw: any): MessageReferenceStatus[] => {
            if (!raw || typeof raw.stageId !== 'string'
              || (raw.status !== 'processing' && raw.status !== 'ready' && raw.status !== 'error')) return [];
            const file = raw.file ? normalizeReferenceFile(raw.file) : null;
            return [{
              stageId: raw.stageId,
              status: raw.status,
              ...(file ? { file } : {}),
              ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
            }];
          })
          : [];
        this.emit({ type: 'reference-status', messageId: String(msg.messageId ?? ''), attachments });
        break;
      }
      case 'workflow-changed': {
        this.finishWorkflowSwitch();
        this.syncWorkflowState(msg, 'direct', 'planning');
        this.emit({ type: 'workflow-changed', ...this.workflowState() });
        this.flushQueuedMessages();
        this.notifyPlanningDocumentSaved();
        break;
      }
      case 'plan-ready': {
        if (!isStructuredPlan(msg.plan)) {
          this.emit({ type: 'hub-error', code: 'INVALID_PLAN', message: 'The hub sent an invalid structured plan.' });
          break;
        }
        this.syncWorkflowState(msg, 'plan', 'awaiting-approval');
        this.latestPlan = msg.plan;
        this.emit({ type: 'plan-ready', plan: msg.plan, ...this.workflowState() });
        break;
      }
      case 'plan-approved': {
        this.syncWorkflowState(msg, 'plan', 'switching', true);
        const planId = typeof msg.planId === 'string' ? msg.planId : (this.latestPlan?.planId ?? '');
        this.emit({ type: 'plan-approved', planId, ...this.workflowState() });
        break;
      }
      case 'plan-invalidated': {
        this.syncWorkflowState(msg, 'plan', 'planning', true);
        this.emit({
          type: 'plan-invalidated',
          planId: typeof msg.planId === 'string' ? msg.planId : (this.latestPlan?.planId ?? null),
          ...(typeof msg.reason === 'string' ? { reason: msg.reason } : {}),
          ...this.workflowState(),
        });
        break;
      }
      case 'implementation-started': {
        this.syncWorkflowState(msg, 'plan', 'implementing', true);
        const planId = typeof msg.planId === 'string' ? msg.planId : (this.latestPlan?.planId ?? '');
        this.emit({ type: 'implementation-started', planId, ...this.workflowState() });
        break;
      }
      case 'skills-catalog': {
        this.emit({ type: 'skills-catalog', catalog: { revision: Number(msg.revision ?? 0), skills: Array.isArray(msg.skills) ? msg.skills : [] } });
        break;
      }
      case 'templates-catalog': {
        this.templateCatalog = readTemplateCatalog(msg);
        if (this.activeTemplateId) this.activeTemplate = this.templateCatalog.templates.find((item) => item.id === this.activeTemplateId) ?? null;
        const changedTemplate = readDocumentTemplate(msg.change?.template);
        this.emit({
          type: 'templates-catalog',
          catalog: this.templateCatalog,
          ...(changedTemplate && ['added', 'renamed', 'replaced', 'deleted'].includes(msg.change?.type)
            ? { change: { type: msg.change.type, template: changedTemplate } }
            : {}),
        });
        break;
      }
      case 'agent-instructions': {
        const status = readAgentInstructionsStatus(msg.status);
        if (!status) break;
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, status);
        this.emit({
          type: 'agent-instructions',
          status,
          changedBy: typeof msg.changedBy === 'string' ? msg.changedBy : 'system',
        });
        break;
      }
      case 'agent-instructions-draft': {
        const draft = readAgentInstructionsDraft(msg.draft);
        if (draft) this.emit({ type: 'agent-instructions-draft', draft });
        break;
      }
      case 'agent-instructions-draft-cleared': {
        const outcome = msg.outcome === 'confirmed'
          || msg.outcome === 'rejected'
          || msg.outcome === 'expired'
          || msg.outcome === 'replaced'
          || msg.outcome === 'stale'
          ? msg.outcome
          : null;
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, outcome === 'rejected');
        if (typeof msg.draftId === 'string' && outcome) {
          this.emit({ type: 'agent-instructions-draft-cleared', draftId: msg.draftId, outcome });
        }
        break;
      }
      case 'agent-instructions-error': {
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, null);
        const status = readAgentInstructionsStatus(msg.status);
        this.emit({
          type: 'agent-instructions-error',
          code: typeof msg.code === 'string' ? msg.code : 'INSTRUCTIONS_ERROR',
          message: typeof msg.message === 'string' ? msg.message : 'AGENTS.md request failed',
          ...(status ? { status } : {}),
        });
        break;
      }
      case 'chat-template-changed': {
        this.activeTemplate = readDocumentTemplate(msg.template);
        this.activeTemplateId = this.activeTemplate?.id ?? null;
        this.emit({
          type: 'chat-template-changed',
          template: this.activeTemplate,
          ...(typeof msg.reason === 'string' ? { reason: msg.reason } : {}),
        });
        break;
      }
      case 'skill-detail':
        this.emit({ type: 'skill-detail', requestId: String(msg.requestId ?? ''), revision: Number(msg.revision ?? 0), skill: msg.skill });
        break;
      case 'skill-saved':
        this.emit({ type: 'skill-saved', requestId: String(msg.requestId ?? ''), revision: Number(msg.revision ?? 0), skill: msg.skill });
        break;
      case 'skill-validated':
        this.emit({ type: 'skill-validated', requestId: String(msg.requestId ?? ''), result: msg.result });
        break;
      case 'skill-deleted':
        this.emit({ type: 'skill-deleted', requestId: String(msg.requestId ?? ''), name: String(msg.name ?? ''), recoverable: Boolean(msg.recoverable) });
        break;
      case 'skill-draft-progress':
        this.emit({ type: 'skill-draft-progress', requestId: String(msg.requestId ?? ''), state: 'generating' });
        break;
      case 'skill-draft-result':
        this.emit({ type: 'skill-draft-result', requestId: String(msg.requestId ?? ''), draft: msg.draft });
        break;
      case 'skills-error':
        this.emit({ type: 'skills-error', requestId: String(msg.requestId ?? ''), code: String(msg.code ?? 'SKILLS_ERROR'), message: String(msg.message ?? 'Skill request failed') });
        break;
      case 'writing-style-status':
        this.emit({ type: 'writing-style-status', requestId: String(msg.requestId ?? ''), status: readWritingStyleStatus(msg.status) });
        break;
      case 'writing-style-progress': {
        const progress = readWritingStyleProgress(msg);
        if (progress) this.emit({ type: 'writing-style-progress', requestId: String(msg.requestId ?? ''), ...progress });
        break;
      }
      case 'writing-style-result':
        this.emit({ type: 'writing-style-result', requestId: String(msg.requestId ?? ''), status: readWritingStyleStatus(msg.status) });
        break;
      case 'writing-style-error':
        this.emit({ type: 'writing-style-error', requestId: String(msg.requestId ?? ''), code: String(msg.code ?? 'CALIBRATION_FAILED'), message: String(msg.message ?? 'Writing-style calibration failed') });
        break;
      case 'writing-style-catalog': {
        const catalog = readWritingStyleCatalog(msg);
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, catalog);
        this.emit({ type: 'writing-style-catalog', requestId: String(msg.requestId ?? ''), catalog });
        break;
      }
      case 'provider-status': {
        const providers = readProviderStatus(msg.providers);
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, providers);
        this.emit({ type: 'provider-status', providers });
        break;
      }
      case 'agent-setup-status': {
        const statuses = readAgentSetupStatuses(msg.statuses);
        // 동적 모델 레지스트리를 이벤트 발행 전에 갱신해, 리스너가 목록을
        // 즉시 최신 상태로 읽을 수 있게 한다.
        if (statuses.cursor.models) setCursorModelRegistry(statuses.cursor.models);
        if (statuses.opencode.models) setOpenCodeModelRegistry(statuses.opencode.models);
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, statuses);
        this.emit({ type: 'agent-setup-status', statuses });
        break;
      }
      case 'agent-setup-auth-started': {
        const agent = isAgentName(msg.agent) ? msg.agent : null;
        if (typeof msg.requestId === 'string') {
          this.requests.settle(msg.requestId, agent ? {
            agent,
            authRunId: typeof msg.authRunId === 'string' ? msg.authRunId : '',
            authUrl: typeof msg.authUrl === 'string' ? msg.authUrl : null,
            pairingCode: typeof msg.pairingCode === 'string' ? msg.pairingCode : null,
            expiresAt: typeof msg.expiresAt === 'string' ? msg.expiresAt : null,
          } satisfies AgentSetupAuthStart : null);
        }
        break;
      }
      case 'agent-setup-progress': {
        if (!isAgentName(msg.agent)) break;
        const state = msg.state === 'installing' || msg.state === 'authorizing' || msg.state === 'done'
          ? msg.state
          : null;
        if (!state) break;
        this.emit({
          type: 'agent-setup-progress',
          agent: msg.agent,
          ...(typeof msg.authRunId === 'string' ? { authRunId: msg.authRunId } : {}),
          state,
          ...(typeof msg.phase === 'string' ? { phase: msg.phase } : {}),
          ...(typeof msg.percent === 'number' && Number.isFinite(msg.percent)
            ? { percent: Math.min(100, Math.max(0, msg.percent)) }
            : {}),
          ...(typeof msg.detail === 'string' ? { detail: msg.detail } : {}),
          ...(typeof msg.authUrl === 'string' ? { authUrl: msg.authUrl } : {}),
          ...(typeof msg.userCode === 'string' ? { userCode: msg.userCode } : {}),
          ...(typeof msg.pairingCode === 'string' ? { pairingCode: msg.pairingCode } : {}),
          ...(typeof msg.expiresAt === 'string' ? { expiresAt: msg.expiresAt } : {}),
          ...(msg.activity === true ? { activity: true } : {}),
          ...(typeof msg.receivedBytes === 'number' ? { receivedBytes: msg.receivedBytes } : {}),
          ...(typeof msg.totalBytes === 'number' ? { totalBytes: msg.totalBytes } : {}),
        });
        break;
      }
      case 'agent-setup-error': {
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, null);
        this.emit({
          type: 'agent-setup-error',
          agent: isAgentName(msg.agent) ? msg.agent : null,
          ...(typeof msg.authRunId === 'string' ? { authRunId: msg.authRunId } : {}),
          code: typeof msg.code === 'string' ? msg.code : 'AGENT_SETUP_FAILED',
          message: typeof msg.message === 'string' ? msg.message : 'Agent setup failed',
        });
        break;
      }
      case 'account-status': {
        const status = readAccountSessionStatus(msg.status);
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, status);
        this.emit({ type: 'account-status', status });
        break;
      }
      case 'account-login-started': {
        if (typeof msg.requestId === 'string') {
          this.requests.settle(msg.requestId, {
            authRunId: typeof msg.authRunId === 'string' ? msg.authRunId : '',
            authUrl: typeof msg.authUrl === 'string' ? msg.authUrl : null,
            pairingCode: typeof msg.pairingCode === 'string' ? msg.pairingCode : null,
            expiresAt: typeof msg.expiresAt === 'string' ? msg.expiresAt : null,
          } satisfies AccountLoginStart);
        }
        break;
      }
      case 'account-login-progress': {
        this.emit({
          type: 'account-login-progress',
          ...(typeof msg.authRunId === 'string' ? { authRunId: msg.authRunId } : {}),
          state: 'authorizing',
          ...(typeof msg.authUrl === 'string' ? { authUrl: msg.authUrl } : {}),
          ...(typeof msg.pairingCode === 'string' ? { pairingCode: msg.pairingCode } : {}),
          ...(typeof msg.expiresAt === 'string' ? { expiresAt: msg.expiresAt } : {}),
          ...(msg.replayed === true ? { replayed: true } : {}),
        });
        break;
      }
      case 'account-error': {
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, null);
        this.emit({
          type: 'account-error',
          ...(typeof msg.authRunId === 'string' ? { authRunId: msg.authRunId } : {}),
          code: typeof msg.code === 'string' ? msg.code : 'ACCOUNT_SESSION_FAILED',
          message: typeof msg.message === 'string' ? msg.message : 'Account request failed',
        });
        break;
      }
      case 'usage-report': {
        const usage = readUsageSummary(msg.usage);
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, usage);
        if (usage) this.emit({ type: 'usage-report', usage });
        break;
      }
      case 'usage-error':
      case 'provider-error': {
        // 사용량·프로브는 부수 정보다 — 실패는 던지지 않고 "모름(null)" 으로 닫는다.
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, null);
        console.warn('[AgentBridge]', msg.type + ':', msg.code, msg.message);
        break;
      }
      case 'pi-status': {
        const status = readPiStatus(msg.status);
        // 모델 레지스트리를 이벤트 발행 전에 갱신해, 리스너가 modelsForAgent('pi')
        // 를 즉시 최신 상태로 읽을 수 있게 한다.
        setPiModelRegistry(status.models);
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, status);
        this.emit({ type: 'pi-status', status });
        break;
      }
      case 'pi-setup-progress': {
        if (!isPiSetupState(msg.state)) break;
        this.emit({
          type: 'pi-setup-progress',
          requestId: typeof msg.requestId === 'string' ? msg.requestId : '',
          state: msg.state,
          ...(typeof msg.percent === 'number' && Number.isFinite(msg.percent)
            ? { percent: Math.min(100, Math.max(0, msg.percent)) }
            : {}),
          ...(typeof msg.detail === 'string' ? { detail: msg.detail } : {}),
          ...(typeof msg.receivedBytes === 'number' && Number.isFinite(msg.receivedBytes)
            ? { receivedBytes: msg.receivedBytes }
            : {}),
          ...(typeof msg.totalBytes === 'number' && Number.isFinite(msg.totalBytes)
            ? { totalBytes: msg.totalBytes }
            : {}),
          ...(msg.activity === true ? { activity: true } : {}),
        });
        break;
      }
      case 'pi-catalog': {
        const models = readPiCatalog(msg.models);
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, models);
        this.emit({
          type: 'pi-catalog',
          requestId: typeof msg.requestId === 'string' ? msg.requestId : '',
          models,
        });
        break;
      }
      case 'pi-error': {
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, null);
        this.emit({
          type: 'pi-error',
          requestId: typeof msg.requestId === 'string' ? msg.requestId : '',
          code: typeof msg.code === 'string' ? msg.code : 'PI_ERROR',
          message: typeof msg.message === 'string' ? msg.message : 'Pi request failed',
        });
        break;
      }
      case 'chat-error': {
        if (typeof msg.requestId === 'string' && msg.requestId !== this.pendingChatStart?.requestId) break;
        if (this.pendingChatStart && msg.session && isAgentName(msg.session.agent)) {
          // Validation/busy rejection leaves the previous provider alive.
          for (const message of this.queuedMessages) message.resolve(null);
          this.queuedMessages = [];
          this.pendingChatStart = null;
          this.chatStartSent = false;
          this.handleMessage({ ...msg.session, type: 'chat-started' });
        }
        const chatStartFailed = this.pendingChatStart !== null;
        // 시작 실패 시 대기 중이던 메시지를 정리하지 않으면 sendUserMessage promise가
        // 영원히 미해결로 남아 컴포저가 잠기고, 다음 chat-started에 스테일 메시지가 흘러간다.
        // 구상 전환과 무관한 오류(AGENT_BUSY 등)로 낙관적 잠금 해제를 되돌리면
        // Codex 재시작 중에 문서가 다시 잠긴다.
        const errorCode = typeof msg.code === 'string' ? msg.code : 'RPC_ERROR';
        if (
          errorCode === 'BACKEND_SWITCH_FAILED'
          || errorCode === 'INVALID_WORKFLOW'
          || errorCode === 'WORKFLOW_ERROR'
        ) {
          this.revertWorkflowSwitch();
        }
        for (const message of this.queuedMessages) message.resolve(null);
        this.queuedMessages = [];
        if (chatStartFailed) {
          this.chatStartSent = false;
          // 허브는 교체 프로바이더를 시작하기 전에 이전 세션을 폐기한다. 요청한 시작값은
          // 재시도 설정으로 남기되 다음 메시지가 사라진 이전 에이전트로 향하지 않게 한다.
          if (this.pendingTurnOpen) {
            try {
              this.endPendingTurn();
            } catch (e) {
              console.warn('[AgentBridge] chat-error endTurn 실패:', e);
            }
          }
          const droppedQuestion = this.pendingUserQuestion;
          this.pendingUserQuestion = null;
          this.pendingUserQuestionId = null;
          this.pendingQuestionAnswer = null;
          this.clearPendingQuestionCancellation();
          if (droppedQuestion) {
            this.emit({
              type: 'user-question-resolved',
              interactionId: droppedQuestion.interactionId,
              outcome: { status: 'expired', reason: 'request-invalidated' },
            });
          }
          this.activeAgent = null;
          this.turnRunning = false;
          this.activeProviderTurnId = null;
          this.abortActiveToolRequests();
          this.syncEditingLease();
        } else {
          this.pendingChatStart = null;
        }
        this.emit({
          type: 'hub-error',
          code: typeof msg.code === 'string' ? msg.code : 'RPC_ERROR',
          message: typeof msg.message === 'string' ? msg.message : 'Unknown hub error',
        });
        break;
      }
      case 'title-result': {
        this.emit({
          type: 'title-result',
          requestId: typeof msg.requestId === 'string' ? msg.requestId : '',
          threadId: typeof msg.threadId === 'string' ? msg.threadId : '',
          title: typeof msg.title === 'string' ? msg.title : null,
        });
        break;
      }
      case 'checkpoint-title-result': {
        if (typeof msg.requestId === 'string') {
          this.requests.settle(msg.requestId, readCheckpointTitleResult(msg.result));
        }
        break;
      }
      case 'agent-event': {
        const event = msg.event as AgentStreamEvent | undefined;
        if (!event || typeof event.type !== 'string') break;
        this.handleAgentEvent(event);
        break;
      }
      case 'tool-request': {
        this.handleToolRequest(msg);
        break;
      }
      case 'tool-request-cancel': {
        if (typeof msg.id === 'number') {
          const request = this.activeToolRequestControllers.get(msg.id);
          if (request) this.cancelActiveToolRequest(msg.id, request);
        }
        break;
      }
      default:
        // 알 수 없는 타입은 무시 (전방 호환).
        break;
    }
  }

  private handleAgentEvent(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'turn-start':
        this.turnRunning = true;
        this.activeProviderTurnId = typeof event.turnId === 'string' ? event.turnId : null;
        this.editingAgent = event.agent;
        this.turnHadError = false;
        try {
          this.beginPendingTurn(event.agent);
        } catch (e) {
          console.warn('[AgentBridge] beginTurn 실패:', e);
        }
        break;
      case 'turn-end': {
        const eventTurnId = typeof event.turnId === 'string' ? event.turnId : null;
        if (!providerTurnEndMatches(this.activeProviderTurnId, eventTurnId)) return;
        this.turnRunning = false;
        this.activeProviderTurnId = null;
        this.abortProviderToolRequests(eventTurnId ?? undefined);
        const succeeded = !this.turnHadError
          && !event.errorMessage
          && (event.stopReason === 'end_turn'
            || event.stopReason === 'completed'
            || event.stopReason === 'success');
        this.turnHadError = false;
        if (this.pendingTurnOpen) {
          try {
            this.endPendingTurn(succeeded ? this.successfulTurnOutcome() : 'reject');
          } catch (e) {
            console.warn('[AgentBridge] endTurn 실패:', e);
          }
        }
        break;
      }
      case 'error':
        if (this.turnRunning) this.turnHadError = true;
        break;
      case 'session-info':
        this.activeAgent = event.agent;
        this.editingAgent = event.agent;
        break;
      default:
        break;
    }
    this.syncEditingLease();
    this.emit({ type: 'agent', event });
  }

  private handleToolRequest(msg: any): void {
    const id = msg.id;
    if (typeof id !== 'number') return;
    const turnBound = msg.turnBound !== false;
    const providerTurnId = typeof msg.providerTurnId === 'string'
      ? msg.providerTurnId
      : null;
    const belongsToActiveTurn = () => !turnBound || (
      providerTurnId !== null && providerTurnId === this.activeProviderTurnId
        && providerTurnId !== this.interruptedProviderTurnId
    );
    if (!belongsToActiveTurn()) {
      this.sendToolResponse({
        v: AGENT_PROTOCOL_VERSION,
        type: 'tool-response',
        id,
        ok: false,
        error: {
          code: 'NO_ACTIVE_TURN',
          message: 'The provider tool request no longer belongs to the active turn.',
        },
      });
      return;
    }
    const previous = this.activeToolRequestControllers.get(id);
    if (previous) this.cancelActiveToolRequest(id, previous);
    const controller = new AbortController();
    let editingLeaseHeld = true;
    const releaseEditingLease = () => {
      if (!editingLeaseHeld) return;
      editingLeaseHeld = false;
      this.activeToolRequests = Math.max(0, this.activeToolRequests - 1);
      this.syncEditingLease();
    };
    const request = { controller, turnBound, providerTurnId, releaseEditingLease };
    this.activeToolRequestControllers.set(id, request);
    const requestIsActive = () => !controller.signal.aborted && belongsToActiveTurn();
    const tool = typeof msg.tool === 'string' ? msg.tool : '';
    const args = msg.args;
    const agent: AgentName = isAgentName(msg.agent) ? msg.agent : (this.activeAgent ?? 'claude');
    this.editingAgent = agent;
    // 허브가 이미 구상 중이면 로컬 전환이 늦어도 도구 호출로 문서를 잠그지 않는다.
    if (
      isAgentWorkflow(msg.workflow)
      && isAgentPhase(msg.phase)
      && planModeAllowsUserEditing(msg.workflow, msg.phase)
    ) {
      this.workflow = msg.workflow;
      this.phase = msg.phase;
    }
    this.activeToolRequests += 1;
    this.syncEditingLease();
    void this.executor
      .execute(tool, args, agent, {
        workflow: this.workflow,
        phase: msg.phase,
        capabilityEpoch: msg.capabilityEpoch,
        activePhase: this.phase,
        activeCapabilityEpoch: this.capabilityEpoch,
        permissionProfile: this.permissionProfile,
        template: readDocumentTemplate(msg.template) ?? undefined,
        requestIsActive,
      })
      .then((result) => {
        if (!requestIsActive()) return;
        this.sendToolResponse({ v: AGENT_PROTOCOL_VERSION, type: 'tool-response', id, ok: true, result });
      })
      .catch((e: unknown) => {
        if (!requestIsActive()) return;
        const error =
          e instanceof AgentToolError
            ? { code: e.code, message: e.message }
            : { code: 'RPC_ERROR', message: e instanceof Error ? e.message : String(e) };
        this.sendToolResponse({ v: AGENT_PROTOCOL_VERSION, type: 'tool-response', id, ok: false, error });
      })
      .finally(() => {
        if (this.activeToolRequestControllers.get(id) === request) {
          this.activeToolRequestControllers.delete(id);
        }
        releaseEditingLease();
      });
  }

  /** 소켓이 닫혀 있으면 결과를 버리지 않고 재연결 때까지 붙잡아 둔다. */
  private sendToolResponse(frame: unknown): void {
    if (this.sendJson(frame)) return;
    this.toolResponses.push(frame);
  }

  private flushToolResponses(): void {
    const frames = this.toolResponses.drain();
    for (let i = 0; i < frames.length; i += 1) {
      if (this.sendJson(frames[i])) continue;
      // 다시 끊겼다 — 남은 프레임을 순서대로 되돌려 담고 다음 재연결을 기다린다.
      for (const rest of frames.slice(i)) this.toolResponses.push(rest);
      return;
    }
  }

  private flushPendingQuestionAnswer(): void {
    if (this.pendingQuestionAnswer) this.sendJson(this.pendingQuestionAnswer.frame);
  }

  private flushPendingQuestionCancellation(): void {
    if (this.pendingQuestionCancellation) this.sendJson(this.pendingQuestionCancellation.frame);
  }

  // ─── outgoing API ─────────────────────────────────────────

  getConnectionState(): ConnectionState {
    return this.state;
  }

  getActiveAgent(): AgentName | null {
    return this.activeAgent;
  }

  isTurnRunning(): boolean {
    return this.turnRunning;
  }

  getPendingUserQuestion(): UserQuestionInteraction | null {
    return this.pendingUserQuestion ? structuredClone(this.pendingUserQuestion) : null;
  }

  getEditingLease(): AgentEditingLease {
    return { ...this.editingLease };
  }

  onEditingLeaseChange(cb: (lease: AgentEditingLease) => void): () => void {
    this.editingLeaseListeners.add(cb);
    cb(this.getEditingLease());
    return () => this.editingLeaseListeners.delete(cb);
  }

  getPermissionProfile(): PermissionProfile {
    return this.permissionProfile;
  }

  getServiceTier(): ServiceTier {
    return this.serviceTier;
  }

  getWorkflowState() {
    return this.workflowState();
  }

  startChat(
    agent: AgentName,
    model?: string,
    effort?: string,
    force = false,
    permissionProfile: PermissionProfile = this.permissionProfile,
    workflow: AgentWorkflow = 'direct',
    threadId = this.threadId,
    documentId: string | null = this.documentId,
    documentName: string | null = this.documentName,
    history: ChatHistoryEntry[] = this.chatHistory,
  ): void {
    this.selectedAgent = agent;
    this.selectedModel = model || null;
    this.selectedEffort = effort || null;
    this.threadId = threadId;
    this.documentId = documentId;
    this.documentName = documentName;
    this.chatHistory = history.map((entry) => ({ ...entry }));
    // 워크플로와 권한은 서버 상태가 기준이다. 요청값은 chat-started가 확인할 때까지
    // 시작 대기에만 두어, 프로바이더 시작 실패 뒤 가상의 모드가 남지 않게 한다.
    this.pendingChatStart = {
      requestId: `chat-start-${++this.requestSeq}`,
      agent,
      model: this.selectedModel ?? undefined,
      effort: this.selectedEffort ?? undefined,
      permissionProfile,
      serviceTier: this.serviceTier,
      workflow,
      threadId,
      documentId,
      documentName,
      history: this.chatHistory,
      force,
    };
    this.chatStartSent = false;
    this.sendPendingChatStart();
  }

  stopChat(): void {
    const waitForAuthoritativeTurnEnd = this.state === 'connected' && this.turnRunning;
    for (const message of this.queuedMessages) message.resolve(null);
    this.queuedMessages = [];
    this.pendingChatStart = null;
    this.chatHistory = [];
    this.activeAgent = null;
    const pendingQuestion = this.pendingUserQuestion;
    if (pendingQuestion) {
      this.setPendingQuestionCancellation(pendingQuestion.interactionId, 'chat-stop');
      this.pendingQuestionAnswer = null;
      this.pendingUserQuestion = null;
      this.pendingUserQuestionId = null;
      this.emit({
        type: 'user-question-resolved',
        interactionId: pendingQuestion.interactionId,
        outcome: { status: 'cancelled', reason: 'user-stop' },
      });
    }
    if (!waitForAuthoritativeTurnEnd) {
      this.turnRunning = false;
      this.activeProviderTurnId = null;
      this.abortProviderToolRequests();
    }
    this.syncEditingLease();
    // 전체 접근은 현재 채팅 하나에만 적용하고 새 스레드나 다시 연 스레드의 기본값으로 삼지 않는다.
    this.permissionProfile = 'safe';
    this.serviceTier = 'standard';
    this.resetWorkflowState();
    if (this.state === 'connected') {
      this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-stop' });
    }
    this.pendingInterrupt = false;
    this.emit({ type: 'chat-stopped' });
  }

  requestTitle(threadId: string, preview: string): string {
    const requestId = `title-${++this.titleRequestSeq}`;
    if (this.state === 'connected') {
      this.sendJson({
        v: AGENT_PROTOCOL_VERSION,
        type: 'title-request',
        requestId,
        threadId,
        preview,
      });
    } else {
      // 오프라인이면 곧바로 폴백을 유도한다.
      queueMicrotask(() => {
        this.emit({ type: 'title-result', requestId, threadId, title: null });
      });
    }
    return requestId;
  }

  requestCheckpointTitle(input: CheckpointTitleRequest): Promise<CheckpointTitleResult | null> {
    return this.request<CheckpointTitleResult>(
      {
        type: 'checkpoint-title-request',
        commitId: input.commitId,
        titleRevision: input.titleRevision,
        appLanguage: input.appLanguage,
        summary: input.summary,
      },
      'checkpoint-title',
      45_000,
    );
  }

  sendUserMessage(text: string, skillName?: string, stagedReferenceIds: string[] = []): Promise<string | null> {
    const context = this.referenceContext();
    const messageId = stagedReferenceIds.length > 0 ? `message-${++this.requestSeq}` : undefined;
    return new Promise((resolve) => {
      const message = { text, skillName, context, messageId, stagedReferenceIds: [...stagedReferenceIds], resolve };
      if (this.pendingChatStart || this.workflowSwitchPending || this.activeAgent === null || this.queuedMessages.length > 0) {
        this.queuedMessages.push(message);
        if (this.activeAgent === null) {
          // 연결 중에도 시작 대기를 남겨 재접속이 첫 메시지를 다시 보낼 수 있게 한다.
          this.rememberPendingChatStart();
          if (!this.workflowSwitchPending) this.sendPendingChatStart();
        } else {
          this.flushQueuedMessages();
        }
        return;
      }
      this.dispatchUserMessage(message);
    });
  }

  private rememberPendingChatStart(): void {
    if (this.pendingChatStart) return;
    const context = this.referenceContext();
    this.pendingChatStart = {
      requestId: `chat-start-${++this.requestSeq}`,
      agent: this.selectedAgent,
      model: this.selectedModel ?? undefined,
      effort: this.selectedEffort ?? undefined,
      permissionProfile: this.permissionProfile,
      serviceTier: this.serviceTier,
      workflow: this.workflow,
      threadId: context.threadId,
      documentId: context.documentId,
      documentName: context.documentName ?? null,
      history: this.chatHistory,
    };
  }

  private sendPendingChatStart(): void {
    const pending = this.pendingChatStart;
    if (!pending || this.chatStartSent || this.state !== 'connected') return;
    this.chatStartSent = this.sendJson({
      v: AGENT_PROTOCOL_VERSION,
      type: 'chat-start',
      ...pending,
    });
  }

  private dispatchUserMessage(message: (typeof this.queuedMessages)[number]): void {
    const sent = this.sendJson({
      v: AGENT_PROTOCOL_VERSION,
      type: 'chat-user-message',
      text: message.text,
      threadId: message.context.threadId,
      documentId: message.context.documentId,
      activeTemplateId: this.activeTemplateId,
      ...(message.skillName ? { skillName: message.skillName } : {}),
      ...(message.messageId ? { messageId: message.messageId, stagedReferenceIds: message.stagedReferenceIds } : {}),
    });
    message.resolve(sent ? (message.messageId ?? null) : null);
  }

  private flushQueuedMessages(): void {
    if (this.workflowSwitchPending || this.pendingChatStart) return;
    if (this.queuedMessages.length === 0) return;
    if (this.state !== 'connected') {
      if (this.activeAgent === null) this.rememberPendingChatStart();
      return;
    }
    if (this.activeAgent === null) {
      this.rememberPendingChatStart();
      this.sendPendingChatStart();
      return;
    }
    const queued = this.queuedMessages;
    this.queuedMessages = [];
    for (const message of queued) this.dispatchUserMessage(message);
  }

  private referenceContext(): ReferenceScopeContext {
    return {
      threadId: this.threadId,
      documentId: this.documentId,
      documentName: this.documentName,
    };
  }

  private referenceUrl(pathname: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(pathname, `${this.httpBaseUrl}/`);
    url.searchParams.set('sessionId', this.sessionId);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async referenceFetch(pathname: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      const requestUrl = new URL(pathname, `${this.httpBaseUrl}/`);
      const capability = requestUrl.pathname === '/templates' || requestUrl.pathname.startsWith('/templates/')
        ? this.templateToken
        : this.referenceToken;
      response = await fetch(pathname, {
        ...init,
        headers: {
          Authorization: `Bearer ${capability}`,
          ...init?.headers,
        },
      });
    } catch (error) {
      throw new Error(`참고자료 서버에 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    const responseBytes = await readResponseBytesWithLimit(
      response,
      response.ok ? STRUCTURED_RESPONSE_MAX_BYTES : ERROR_RESPONSE_MAX_BYTES,
      response.ok ? '참고자료 응답' : '참고자료 오류 응답',
    );
    const responseText = new TextDecoder().decode(responseBytes);
    let payload: unknown = null;
    if (contentType.includes('application/json')) {
      try {
        payload = responseText.trim() ? JSON.parse(responseText) : null;
      } catch {
        payload = null;
      }
    } else {
      payload = responseText ? { message: responseText } : null;
    }
    if (!response.ok) {
      const body = payload && typeof payload === 'object' ? payload as any : null;
      const message = typeof body?.error?.message === 'string'
        ? body.error.message
        : typeof body?.message === 'string'
          ? body.message
          : `참고자료 요청이 실패했습니다 (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  private async inspectTemplateFile(file: File): Promise<{ format: 'hwp' | 'hwpx'; pageCount: number; sectionCount: number }> {
    if (file.size > 20 * 1024 * 1024) throw new Error('템플릿은 20 MB까지 추가할 수 있습니다.');
    const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
    if (extension !== 'hwp' && extension !== 'hwpx') throw new Error('HWP 또는 HWPX 파일만 템플릿으로 추가할 수 있습니다.');
    const { WasmBridge } = await import('../core/wasm-bridge.ts');
    const wasm = new WasmBridge();
    try {
      await wasm.initialize();
      const info = wasm.loadDocument(new Uint8Array(await file.arrayBuffer()), file.name);
      return { format: extension, pageCount: info.pageCount, sectionCount: info.sectionCount };
    } catch (error) {
      throw new Error(`템플릿 파일을 열 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      wasm.releaseDocument();
    }
  }

  private async uploadTemplate(pathname: string, method: 'POST' | 'PUT', file: File, name?: string): Promise<DocumentTemplate> {
    const info = await this.inspectTemplateFile(file);
    const defaultName = file.name.replace(/\.(?:hwp|hwpx)$/i, '');
    const payload = await this.referenceFetch(this.referenceUrl(pathname), {
      method,
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        'X-Template-Name': encodeURIComponent(name?.trim() || defaultName),
        'X-Template-Format': info.format,
        'X-Template-Page-Count': String(info.pageCount),
        'X-Template-Section-Count': String(info.sectionCount),
      },
      body: file,
    });
    const template = readTemplateResponse(payload);
    if (!template) throw new Error('템플릿 서버가 올바른 메타데이터를 반환하지 않았습니다.');
    return template;
  }

  async listTemplates(): Promise<TemplateCatalog> {
    const payload = await this.referenceFetch(this.referenceUrl('/templates'));
    this.templateCatalog = readTemplateCatalog(payload);
    return this.templateCatalog;
  }

  addTemplate(file: File, name?: string): Promise<DocumentTemplate> {
    return this.uploadTemplate('/templates', 'POST', file, name);
  }

  async renameTemplate(id: string, name: string): Promise<DocumentTemplate> {
    const payload = await this.referenceFetch(this.referenceUrl(`/templates/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const template = readTemplateResponse(payload);
    if (!template) throw new Error('템플릿 이름을 바꾸지 못했습니다.');
    return template;
  }

  replaceTemplate(id: string, file: File): Promise<DocumentTemplate> {
    const current = this.templateCatalog.templates.find((item) => item.id === id);
    return this.uploadTemplate(`/templates/${encodeURIComponent(id)}`, 'PUT', file, current?.name);
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.referenceFetch(this.referenceUrl(`/templates/${encodeURIComponent(id)}`), { method: 'DELETE' });
  }

  setActiveTemplate(id: string | null): void {
    this.activeTemplateId = id;
    this.activeTemplate = id ? (this.templateCatalog.templates.find((item) => item.id === id) ?? null) : null;
    if (this.activeAgent !== null) {
      this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-template-set', templateId: id });
    }
  }

  getActiveTemplate(): DocumentTemplate | null {
    return this.activeTemplate;
  }

  private async downloadTemplateBytes(template: DocumentTemplate): Promise<Uint8Array> {
    const response = await fetch(this.referenceUrl(`/templates/${encodeURIComponent(template.id)}/content`), {
      headers: { Authorization: `Bearer ${this.templateToken}` },
    });
    if (!response.ok) {
      await cancelResponseBody(response, `HTTP ${response.status}`);
      throw new AgentToolError('TEMPLATE_UNAVAILABLE', `Template ${template.name} is unavailable.`);
    }
    const revisionHeader = response.headers.get('x-template-revision');
    const revision = revisionHeader === null ? Number.NaN : Number(revisionHeader);
    if (!Number.isSafeInteger(revision)) {
      await cancelResponseBody(response, 'invalid-template-revision');
      throw new AgentToolError('TEMPLATE_UNAVAILABLE', `Template ${template.name} did not return a readable revision.`);
    }
    if (revision !== template.revision) {
      await cancelResponseBody(response, 'template-revision-mismatch');
      throw new AgentToolError('TEMPLATE_REVISION_MISMATCH', `Template revision ${revision} does not match ${template.revision}; inspect it again.`);
    }
    return readResponseBytesWithLimit(response, TEMPLATE_DOCUMENT_MAX_BYTES, '템플릿');
  }

  async uploadReference(scope: ReferenceScope, scopeId: string, file: File): Promise<ReferenceFile> {
    const payload = await this.referenceFetch(
      this.referenceUrl('/reference-files', { scope, scopeId }),
      {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          // Fetch 헤더는 ByteString 이므로 비 ASCII 파일명은 percent-encode 한다.
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      },
    );
    const source = payload && typeof payload === 'object'
      ? ((payload as any).file ?? (payload as any).reference ?? payload)
      : payload;
    const normalized = normalizeReferenceFile(source, { scope, scopeId });
    if (!normalized) throw new Error('참고자료 서버가 잘못된 파일 정보를 반환했습니다.');
    return normalized;
  }

  async stageReference(scopeId: string, file: File): Promise<StagedReference> {
    const payload = await this.referenceFetch(
      this.referenceUrl('/reference-staging', { scopeId }),
      {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      },
    );
    const source = payload && typeof payload === 'object' ? (payload as any).staged : null;
    if (!source || typeof source.id !== 'string' || typeof source.name !== 'string'
      || typeof source.scopeId !== 'string' || typeof source.expiresAt !== 'string') {
      throw new Error('참고자료 서버가 잘못된 임시 파일 정보를 반환했습니다.');
    }
    return {
      id: source.id,
      scope: 'chat',
      scopeId: source.scopeId,
      name: source.name,
      mimeType: typeof source.mimeType === 'string' ? source.mimeType : 'application/octet-stream',
      size: Number(source.size) || 0,
      status: 'ready',
      createdAt: String(source.createdAt ?? new Date(0).toISOString()),
      expiresAt: source.expiresAt,
    };
  }

  async discardStagedReference(scopeId: string, stageId: string): Promise<void> {
    await this.referenceFetch(
      this.referenceUrl(`/reference-staging/${encodeURIComponent(stageId)}`, { scopeId }),
      { method: 'DELETE' },
    );
  }

  async listReferences(scope: ReferenceScope, scopeId: string): Promise<ReferenceFile[]> {
    const payload = await this.referenceFetch(
      this.referenceUrl('/reference-files', { scope, scopeId }),
    );
    const source = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? ((payload as any).files ?? (payload as any).references ?? [])
        : [];
    return Array.isArray(source)
      ? source.map((item) => normalizeReferenceFile(item, { scope, scopeId })).filter((item): item is ReferenceFile => item !== null)
      : [];
  }

  async downloadReference(file: Pick<ReferenceFile, 'id' | 'scope' | 'scopeId'>): Promise<Uint8Array> {
    const response = await fetch(this.referenceUrl(`/reference-files/${encodeURIComponent(file.id)}`, {
      scope: file.scope,
      scopeId: file.scopeId,
    }), { headers: { Authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`참고자료 ${file.id}를 읽지 못했습니다.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const expected = response.headers.get('x-content-sha256') ?? '';
    if (!expected || expected !== await sha256Hex(bytes)) {
      throw new Error(`참고자료 ${file.id} 무결성 검증에 실패했습니다.`);
    }
    return bytes;
  }

  async searchReferences(
    query: string,
    scope: ReferenceScope,
    scopeId: string,
    limit = 20,
  ): Promise<ReferenceSearchHit[]> {
    const payload = await this.referenceFetch(
      this.referenceUrl('/reference-search', {
        scope,
        scopeId,
        q: query,
        maxResults: Math.max(1, Math.min(20, Math.round(limit))),
      }),
    );
    const source = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? ((payload as any).hits ?? (payload as any).results ?? [])
        : [];
    return Array.isArray(source)
      ? source.map((item) => normalizeReferenceSearchHit(item, { scope, scopeId })).filter((item): item is ReferenceSearchHit => item !== null)
      : [];
  }

  async deleteReference(file: Pick<ReferenceFile, 'id' | 'scope' | 'scopeId'>): Promise<void> {
    await this.referenceFetch(
      this.referenceUrl(`/reference-files/${encodeURIComponent(file.id)}`, {
        scope: file.scope,
        scopeId: file.scopeId,
      }),
      { method: 'DELETE' },
    );
  }

  setWorkflow(workflow: AgentWorkflow): void {
    // Codex 등 허브 전환은 프로세스 재시작을 기다리므로, 구상 모드 잠금 해제는
    // 로컬에서 즉시 적용한다. 메시지 전송은 workflow-changed 까지 미룬다.
    this.beginWorkflowSwitch(workflow);
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-workflow-set', workflow });
  }

  approvePlan(planId: string): boolean {
    return this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-plan-approve', planId });
  }

  requestPlanChanges(planId: string, feedback?: string): boolean {
    return this.sendJson({
      v: AGENT_PROTOCOL_VERSION,
      type: 'chat-plan-request-changes',
      planId,
      ...(feedback ? { feedback } : {}),
    });
  }

  setPermissionProfile(profile: PermissionProfile): void {
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-permission-set', permissionProfile: profile });
  }

  setServiceTier(tier: ServiceTier): void {
    this.serviceTier = tier === 'fast' ? 'fast' : 'standard';
    if (this.activeAgent === null) return;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-service-tier-set', serviceTier: this.serviceTier });
  }

  listSkills(): void {
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skills-list', requestId: `skills-${++this.requestSeq}` });
  }

  readSkill(name: string): string {
    const requestId = `skill-read-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-read', requestId, name });
    return requestId;
  }

  saveSkill(skill: { name: string; files: ProductSkillFile[] }): string {
    const requestId = `skill-save-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-save', requestId, skill });
    return requestId;
  }

  validateSkill(skill: { name: string; files: ProductSkillFile[] }): string {
    const requestId = `skill-validate-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-validate', requestId, skill });
    return requestId;
  }

  setSkillEnabled(name: string, enabled: boolean): string {
    const requestId = `skill-enable-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-enable', requestId, name, enabled });
    return requestId;
  }

  deleteSkill(name: string): string {
    const requestId = `skill-delete-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-delete', requestId, name });
    return requestId;
  }

  generateSkillDraft(input: { goal: string; triggerExamples?: string; nonTriggerExamples?: string; resourceNotes?: string; existingSkill?: string }): string {
    const requestId = `skill-draft-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-draft-request', requestId, agent: this.selectedAgent, model: this.selectedModel, ...input });
    return requestId;
  }

  requestWritingStyleStatus(): string {
    const requestId = `writing-style-status-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'writing-style-status-request', requestId });
    return requestId;
  }

  requestAgentInstructions(): Promise<AgentInstructionsStatus | null> {
    return this.request<AgentInstructionsStatus>(
      { type: 'agent-instructions-request' },
      'agent-instructions',
    );
  }

  saveAgentInstructions(
    content: string,
    expectedRevision: number,
  ): Promise<AgentInstructionsStatus | null> {
    return this.request<AgentInstructionsStatus>(
      { type: 'agent-instructions-save', content, expectedRevision },
      'agent-instructions-save',
    );
  }

  confirmAgentInstructionsDraft(
    draft: AgentInstructionsDraft,
  ): Promise<AgentInstructionsStatus | null> {
    return this.request<AgentInstructionsStatus>(
      {
        type: 'agent-instructions-draft-confirm',
        draftId: draft.id,
        confirmationToken: draft.confirmationToken,
      },
      'agent-instructions-confirm',
    );
  }

  rejectAgentInstructionsDraft(draft: AgentInstructionsDraft): Promise<boolean> {
    return this.request<boolean>(
      {
        type: 'agent-instructions-draft-reject',
        draftId: draft.id,
        confirmationToken: draft.confirmationToken,
      },
      'agent-instructions-reject',
    ).then((result) => result === true);
  }

  requestWritingStyleCatalog(refresh = false): Promise<WritingStyleCatalog | null> {
    return this.request<WritingStyleCatalog>(
      { type: 'writing-style-catalog-request', ...(refresh ? { refresh: true } : {}) },
      'writing-style-catalog',
    );
  }

  calibrateWritingStyle(input: {
    language: WritingStyleLanguage;
    files: WritingStyleUpload[];
    agent: AgentName;
    model: string;
    append: boolean;
  }): string {
    const requestId = `writing-style-calibration-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'writing-style-calibrate', requestId, ...input });
    return requestId;
  }

  setWritingStyleInstruction(instruction: string): string {
    const requestId = `writing-style-instruction-${++this.requestSeq}`;
    this.sendJson({
      v: AGENT_PROTOCOL_VERSION,
      type: 'writing-style-instruction-set',
      requestId,
      instruction,
    });
    return requestId;
  }

  answerUserQuestion(interactionId: string, answers: Record<string, UserQuestionAnswer>): string {
    const responseId = globalThis.crypto?.randomUUID?.()
      ?? `question-${Date.now().toString(36)}-${++this.requestSeq}`;
    const frame = {
      v: AGENT_PROTOCOL_VERSION,
      type: 'user-question-answer',
      interactionId,
      responseId,
      answers,
    };
    this.pendingQuestionAnswer = { interactionId, responseId, frame };
    this.sendJson(frame);
    return responseId;
  }

  interruptIfIdle(): boolean {
    if (!this.turnRunning || this.activeToolRequests > 0) return false;
    this.interrupt();
    return true;
  }

  interrupt(): void {
    // Fence requests already in transit before the hub acknowledges the stop.
    this.interruptedProviderTurnId = this.activeProviderTurnId;
    this.abortProviderToolRequests(this.activeProviderTurnId ?? undefined);
    const pendingQuestion = this.pendingUserQuestion;
    if (pendingQuestion) {
      this.setPendingQuestionCancellation(pendingQuestion.interactionId, 'chat-interrupt');
      this.pendingQuestionAnswer = null;
      this.pendingUserQuestion = null;
      this.pendingUserQuestionId = null;
      this.syncEditingLease();
      this.emit({
        type: 'user-question-resolved',
        interactionId: pendingQuestion.interactionId,
        outcome: { status: 'cancelled', reason: 'user-stop' },
      });
    }
    if (this.pendingQuestionCancellation) {
      this.pendingInterrupt = false;
      this.flushPendingQuestionCancellation();
    } else {
      this.pendingInterrupt = !this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-interrupt' });
    }
  }

  /**
   * 요청 하나를 대기표에 올리고 보낸다. 오프라인이거나 전송이 실패하면
   * 곧바로 null 로 안착한다 — 호출자는 언제나 값 또는 null 만 본다.
   */
  private request<T>(
    payload: Record<string, unknown> & { type: string },
    prefix: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T | null> {
    if (this.state !== 'connected') return Promise.resolve(null);
    const requestId = `${prefix}-${++this.requestSeq}`;
    const promise = this.requests.create<T>(requestId, timeoutMs);
    const sent = this.sendJson({ v: AGENT_PROTOCOL_VERSION, requestId, ...payload });
    if (!sent) this.requests.settle(requestId, null);
    return promise;
  }

  requestProviderStatus(refresh = false): Promise<ProviderStatusMap | null> {
    return this.request<ProviderStatusMap>(
      { type: 'provider-status-request', ...(refresh ? { refresh: true } : {}) },
      'provider-status',
    );
  }

  requestAgentSetupStatus(refresh = false): Promise<AgentSetupStatusMap | null> {
    return this.request<AgentSetupStatusMap>(
      { type: 'agent-setup-status-request', ...(refresh ? { refresh: true } : {}) },
      'agent-setup-status',
      30_000,
    );
  }

  requestAccountStatus(): Promise<AccountSessionStatus | null> {
    return this.request<AccountSessionStatus>(
      { type: 'account-status-request' },
      'account-status',
      30_000,
    );
  }

  loginAccount(): Promise<AccountLoginStart | null> {
    return this.request<AccountLoginStart>({ type: 'account-login' }, 'account-login', 30_000);
  }

  submitAccountAuthCode(authRunId: string, code: string): void {
    this.sendJson({
      v: AGENT_PROTOCOL_VERSION,
      type: 'account-auth-code',
      authRunId,
      code,
    });
  }

  cancelAccountLogin(authRunId: string): void {
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'account-login-cancel', authRunId });
  }

  logoutAccount(): Promise<AccountSessionStatus | null> {
    return this.request<AccountSessionStatus>({ type: 'account-logout' }, 'account-logout', 30_000);
  }

  installAgent(agent: AgentName): Promise<AgentSetupStatusMap | null> {
    return this.request<AgentSetupStatusMap>({ type: 'agent-setup-install', agent }, 'agent-setup-install', 10 * 60_000);
  }

  authenticateAgent(agent: AgentName, method: AgentAuthMethod, key?: string): Promise<AgentSetupAuthStart | null> {
    return this.request<AgentSetupAuthStart>(
      { type: 'agent-setup-auth', agent, method, ...(key ? { key } : {}) },
      'agent-setup-auth',
      30_000,
    );
  }

  submitAgentAuthCode(agent: AgentName, authRunId: string, code: string): void {
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'agent-setup-auth-code', agent, authRunId, code });
  }

  cancelAgentSetup(agent: AgentName, authRunId: string): void {
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'agent-setup-cancel', agent, authRunId });
  }

  disconnectAgent(agent: AgentName): Promise<AgentSetupStatusMap | null> {
    return this.request<AgentSetupStatusMap>({ type: 'agent-setup-disconnect', agent }, 'agent-setup-disconnect');
  }

  requestUsage(refresh = false): Promise<UsageSummary | null> {
    return this.request<UsageSummary>(
      { type: 'usage-request', ...(refresh ? { refresh: true } : {}) },
      'usage',
      refresh ? 20_000 : REQUEST_TIMEOUT_MS,
    );
  }

  setUsagePlan(agent: AgentName, plan: string): Promise<UsageSummary | null> {
    return this.request<UsageSummary>({ type: 'usage-plan-set', agent, plan }, 'usage-plan');
  }

  connectCliproxy(url: string, key: string): Promise<UsageSummary | null> {
    return this.request<UsageSummary>({ type: 'cliproxy-connect', url, key }, 'cliproxy-connect', 20_000);
  }

  disconnectCliproxy(): Promise<UsageSummary | null> {
    return this.request<UsageSummary>({ type: 'cliproxy-disconnect' }, 'cliproxy-disconnect');
  }

  requestPiStatus(): Promise<PiStatus | null> {
    return this.request<PiStatus>({ type: 'pi-status-request' }, 'pi-status');
  }

  installPi(): Promise<PiStatus | null> {
    return this.request<PiStatus>({ type: 'pi-install' }, 'pi-install', 180_000);
  }

  setPiKey(key: string): Promise<PiStatus | null> {
    return this.request<PiStatus>({ type: 'pi-set-key', key }, 'pi-set-key', 30_000);
  }

  requestPiCatalog(refresh = false): Promise<PiCatalogModel[] | null> {
    return this.request<PiCatalogModel[]>(
      { type: 'pi-catalog-request', ...(refresh ? { refresh: true } : {}) },
      'pi-catalog',
      30_000,
    );
  }

  setPiModels(
    models: Array<{ id: string; name: string; defaultEffort?: string }>,
  ): Promise<PiStatus | null> {
    return this.request<PiStatus>(
      {
        type: 'pi-set-models',
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          ...(m.defaultEffort ? { effortDefault: m.defaultEffort } : {}),
        })),
      },
      'pi-set-models',
      30_000,
    );
  }

  onEvent(cb: (e: SidebarEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(e: SidebarEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        console.warn('[AgentBridge] 이벤트 리스너 오류:', err);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.turnRunning = false;
    this.activeProviderTurnId = null;
    this.abortActiveToolRequests();
    this.activeToolRequests = 0;
    this.syncEditingLease();
    this.editingLeaseListeners.clear();
    window.removeEventListener('focus', this.onResume);
    window.removeEventListener('online', this.onResume);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.clearReconnectTimer();
    this.requests.cancelAll();
    this.toolResponses.clear();
    this.pendingQuestionAnswer = null;
    this.persistPendingQuestionCancellation();
    this.pendingUserQuestionId = null;
    this.pendingUserQuestion = null;
    this.pendingInterrupt = false;
    this.abortSocket();
    this.listeners.clear();
    this.revealUnsub?.();
    this.revealUnsub = null;
    for (const off of this.documentNotifyUnsubs) off();
    this.documentNotifyUnsubs = [];
    this.reveal.dispose();
    this.pendingEdits.dispose();
    this.overlay.dispose();
    this.revision.dispose();
    this.executor.dispose();
  }
}

export function initAgentBridge(deps: AgentBridgeDeps, opts?: AgentBridgeOptions): AgentBridge {
  return new AgentBridgeImpl(deps, opts);
}
