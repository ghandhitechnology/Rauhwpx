import {
  openIndexedDatabase,
  requestResult,
  transactionDone,
  withDatabase,
} from '../core/idb-open.ts';
import { isAgentWorkflow, isStructuredPlan } from './types.ts';
import type {
  AgentName,
  AgentWorkflow,
  ProductSkillIcon,
  ServiceTier,
  StructuredPlan,
  UserQuestion,
  UserQuestionAnswer,
  UserQuestionInteraction,
  UserQuestionOutcome,
} from './types.ts';

const STORAGE_KEY = 'rhwp-agent-threads';
const NOTIFY_KEY = 'rhwp-agent-threads-notify';
const DB_NAME = 'rhwpAgentThreads';
const DB_VERSION = 1;
const THREADS_STORE = 'threads';
const CHANNEL_NAME = 'rhwp-agent-threads';
const MAX_THREADS = 40;
const MAX_MESSAGES_PER_THREAD = 200;

interface ThreadMessageBase {
  text: string;
  agent?: AgentName;
  /** 사용자가 명시적으로 호출한 product skill. 본문과 분리해 chip으로 표시한다. */
  skillName?: string;
  /** 호출 당시 선택된 아이콘. 이후 skill 설정이 바뀌어도 기록 모양을 유지한다. */
  skillIcon?: ProductSkillIcon;
  messageId?: string;
  attachments?: ThreadAttachment[];
  /** 인라인 프롬프트로 보낸 메시지에 붙는 문서 선택 컨텍스트 (표시용). */
  selection?: { label: string; excerpt: string };
}

export interface PendingUserQuestionDraftSnapshot {
  interaction: UserQuestionInteraction;
  selectedOptionIdsByQuestionId: Record<string, string[]>;
  otherTextByQuestionId: Record<string, string>;
  activeQuestionIndex: number;
  updatedAt: number;
}

export interface UserQuestionHistoryMessage extends ThreadMessageBase {
  readonly role: 'assistant';
  readonly kind: 'user-question';
  readonly interaction: UserQuestionInteraction;
  readonly outcome: UserQuestionOutcome;
}

export interface ThreadProviderHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

export type ThreadMessage =
  | UserQuestionHistoryMessage
  | (ThreadMessageBase & {
      role: 'assistant';
      kind: 'plan';
      /** Structured plan opened by this presentation message. */
      planId: string;
      /** The plan has left the approval surface and started execution. */
      planState?: 'executed';
    })
  | (ThreadMessageBase & {
      role: 'user' | 'assistant' | 'system';
      /** Concise in-turn milestone, rendered separately from the final answer. */
      kind?: 'progress';
      planId?: never;
    });

export interface ThreadAttachment {
  stageId: string;
  fileId?: string;
  name: string;
  mimeType: string;
  size: number;
  status: 'processing' | 'ready' | 'error' | 'deleted';
  error?: string;
}

export interface ChatThread {
  id: string;
  title: string;
  /** Luna 제목 요청을 이미 보냈는지 */
  titleRequested: boolean;
  /** 사용자가 직접 붙인 이름 — 이후 자동 제목이 덮어쓰지 않는다 */
  titlePinned?: boolean;
  createdAt: number;
  updatedAt: number;
  agent: AgentName;
  model: string;
  effort: string;
  /** Codex Fast 서비스 티어. 레거시 채팅과 다른 프로바이더는 standard. */
  serviceTier: ServiceTier;
  workflow: AgentWorkflow;
  /** 이 채팅이 속한 문서(파일 이름). null = 문서 없이 시작한 채팅. */
  docKey: string | null;
  /** 서버의 문서별 참고자료 범위에 쓰는 안정적인 논리 문서 ID. */
  documentId: string | null;
  /** 이 채팅에 고정된 기기 템플릿. 원본은 채팅에 내장하지 않는다. */
  activeTemplateId: string | null;
  /** Historical display data only. Phase/approval/capability authority is never persisted. */
  latestPlan?: StructuredPlan;
  /** Plan snapshots referenced by clickable chat presentations. */
  plans?: StructuredPlan[];
  /** Draft state only. Provider authority remains in the live hub session. */
  pendingUserQuestion?: PendingUserQuestionDraftSnapshot;
  messages: ThreadMessage[];
}

export interface ThreadDraft {
  agent: AgentName;
  model: string;
  effort: string;
  serviceTier?: ServiceTier;
  workflow?: AgentWorkflow;
  docKey?: string | null;
  documentId?: string | null;
  activeTemplateId?: string | null;
}

function normalizedDocumentName(value: string | null): string | null {
  const normalized = value?.trim().normalize('NFC').toLocaleLowerCase() ?? '';
  return normalized || null;
}

/** 안정 ID가 기준이다. 파일명은 ID 도입 전에 만들어진 레거시 채팅을 잇는 다리다. */
export function threadMatchesDocument(
  thread: Pick<ChatThread, 'documentId' | 'docKey'>,
  documentId: string | null,
  docKey: string | null,
): boolean {
  if (thread.documentId) return Boolean(documentId && thread.documentId === documentId);
  const threadName = normalizedDocumentName(thread.docKey);
  const activeName = normalizedDocumentName(docKey);
  if (threadName && activeName) return threadName === activeName;
  return !thread.documentId && !documentId && threadName === null && activeName === null;
}

export function explorerGroupIsCurrent(
  group: Pick<ChatThread, 'documentId' | 'docKey'>,
  documentId: string | null,
  docKey: string | null,
  groups: readonly Pick<ChatThread, 'documentId' | 'docKey'>[],
): boolean {
  if (group.documentId) return Boolean(documentId && group.documentId === documentId);
  if (threadMatchesDocument(group, documentId, docKey)) return true;
  if (groups.some((item) => threadMatchesDocument(item, documentId, docKey))) return false;
  const groupName = normalizedDocumentName(group.docKey);
  const activeName = normalizedDocumentName(docKey);
  if (!groupName || !activeName || groupName !== activeName) return false;
  return groups.filter((item) => normalizedDocumentName(item.docKey) === activeName).length === 1;
}

type StoredChatThread = Omit<ChatThread, 'workflow' | 'latestPlan' | 'plans' | 'docKey' | 'documentId' | 'activeTemplateId' | 'pendingUserQuestion'> & {
  workflow?: unknown;
  latestPlan?: unknown;
  plans?: unknown;
  docKey?: unknown;
  documentId?: unknown;
  activeTemplateId?: unknown;
  pendingUserQuestion?: unknown;
};

type ThreadPersistenceChange =
  | { type: 'upsert'; thread: ChatThread }
  | { type: 'remove'; id: string }
  | { type: 'reload' };

type ThreadPersistenceMessage = ThreadPersistenceChange & {
  source: string;
  nonce: string;
};

const cache = new Map<string, ChatThread>();
const deletedBeforeHydration = new Set<string>();
const listeners = new Set<() => void>();
const sourceId = createPersistenceId();
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;
let mutationQueue = Promise.resolve();
let channel: BroadcastChannel | null = null;

function createPersistenceId() {
  return globalThis.crypto?.randomUUID?.() ?? `threads-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function canUseStorage() {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function idbAvailable() {
  return typeof indexedDB !== 'undefined';
}

function readLegacyThreads() {
  if (!canUseStorage()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredChatThread).map(normalizeStoredThread);
  } catch {
    return [];
  }
}

function saveLegacyThreads(threads: ChatThread[]) {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(threads.slice(0, MAX_THREADS)));
  } catch (err) {
    console.warn('[threads] localStorage 저장 실패:', err);
  }
}

function isStoredChatThread(v: unknown): v is StoredChatThread {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === 'string'
    && typeof t.title === 'string'
    && typeof t.createdAt === 'number'
    && typeof t.updatedAt === 'number'
    && (t.agent === 'claude' || t.agent === 'codex' || t.agent === 'pi'
      || t.agent === 'grok' || t.agent === 'cursor' || t.agent === 'opencode' || t.agent === 'rau')
    && typeof t.model === 'string'
    && typeof t.effort === 'string'
    && Array.isArray(t.messages)
  );
}

function isAgentName(value: unknown): value is AgentName {
  return value === 'claude' || value === 'codex' || value === 'pi'
    || value === 'grok' || value === 'cursor' || value === 'opencode' || value === 'rau';
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeUserQuestion(value: unknown, questionIndex: number): UserQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = nonEmptyString(raw.id);
  const question = nonEmptyString(raw.question);
  if (!id || !question || !Array.isArray(raw.options)) return null;
  const optionIds = new Set<string>();
  const options = raw.options.flatMap((value): UserQuestion['options'] => {
    if (!value || typeof value !== 'object') return [];
    const option = value as Record<string, unknown>;
    const label = nonEmptyString(option.label);
    const optionId = nonEmptyString(option.id) ?? label;
    if (!optionId || !label || optionIds.has(optionId)) return [];
    optionIds.add(optionId);
    return [{
      id: optionId,
      label,
      description: typeof option.description === 'string' ? option.description : '',
    }];
  });
  if (options.length === 0) return null;
  return {
    id,
    header: nonEmptyString(raw.header) ?? `Question ${questionIndex + 1}`,
    question,
    mode: raw.mode === 'multiple' || raw.multiSelect === true ? 'multiple' : 'single',
    options,
    allowOther: raw.allowOther !== false,
  };
}

function normalizeUserQuestionInteraction(value: unknown): UserQuestionInteraction | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const interactionId = nonEmptyString(raw.interactionId);
  const providerRequestId = nonEmptyString(raw.providerRequestId);
  const threadId = nonEmptyString(raw.threadId);
  const turnId = nonEmptyString(raw.turnId);
  const createdAt = nonEmptyString(raw.createdAt);
  const updatedAt = nonEmptyString(raw.updatedAt) ?? createdAt;
  if (!interactionId || !providerRequestId || !threadId || !turnId || !createdAt || !updatedAt
    || !isAgentName(raw.agent) || (raw.source !== 'native' && raw.source !== 'mcp')
    || !Array.isArray(raw.questions)) return null;
  const questionIds = new Set<string>();
  const questions = raw.questions.flatMap((question, index): UserQuestion[] => {
    const normalized = normalizeUserQuestion(question, index);
    if (!normalized || questionIds.has(normalized.id)) return [];
    questionIds.add(normalized.id);
    return [normalized];
  });
  if (questions.length === 0) return null;
  return {
    interactionId,
    providerRequestId,
    threadId,
    turnId,
    agent: raw.agent,
    source: raw.source,
    createdAt,
    updatedAt,
    questions,
  };
}

function normalizeSelectedOptionIds(question: UserQuestion, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(value.filter((id): id is string => typeof id === 'string'));
  const normalized = question.options.filter((option) => selected.has(option.id)).map((option) => option.id);
  return question.mode === 'multiple' ? normalized : normalized.slice(0, 1);
}

function normalizeUserQuestionAnswer(
  question: UserQuestion,
  value: unknown,
): UserQuestionAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const selectedOptionIds = normalizeSelectedOptionIds(question, raw.selectedOptionIds);
  const otherText = question.allowOther && typeof raw.otherText === 'string'
    ? raw.otherText
    : '';
  if (selectedOptionIds.length === 0 && !otherText.trim()) return null;
  return {
    selectedOptionIds,
    ...(otherText.trim() ? { otherText } : {}),
  };
}

function normalizeUserQuestionOutcome(
  value: unknown,
  interaction: UserQuestionInteraction,
): UserQuestionOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.status === 'cancelled' && raw.reason === 'user-stop') {
    return { status: 'cancelled', reason: 'user-stop' };
  }
  if (raw.status === 'expired'
    && (raw.reason === 'provider-disconnected' || raw.reason === 'hub-restarted'
      || raw.reason === 'request-invalidated')) {
    return { status: 'expired', reason: raw.reason };
  }
  if (raw.status !== 'answered' || !raw.answers || typeof raw.answers !== 'object') return null;
  const rawAnswers = raw.answers as Record<string, unknown>;
  const answers: Record<string, UserQuestionAnswer> = {};
  for (const question of interaction.questions) {
    const answer = normalizeUserQuestionAnswer(question, rawAnswers[question.id]);
    if (!answer) return null;
    answers[question.id] = answer;
  }
  return { status: 'answered', answers };
}

function normalizePendingUserQuestionDraft(
  value: unknown,
  expectedThreadId: string,
  expectedAgent: AgentName,
): PendingUserQuestionDraftSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const interaction = normalizeUserQuestionInteraction(raw.interaction);
  if (!interaction || interaction.threadId !== expectedThreadId || interaction.agent !== expectedAgent) {
    return null;
  }
  const rawSelections = raw.selectedOptionIdsByQuestionId;
  const rawOtherText = raw.otherTextByQuestionId;
  const selectionRecord = rawSelections && typeof rawSelections === 'object'
    ? rawSelections as Record<string, unknown>
    : {};
  const otherTextRecord = rawOtherText && typeof rawOtherText === 'object'
    ? rawOtherText as Record<string, unknown>
    : {};
  const selectedOptionIdsByQuestionId: Record<string, string[]> = {};
  const otherTextByQuestionId: Record<string, string> = {};
  for (const question of interaction.questions) {
    const selected = normalizeSelectedOptionIds(question, selectionRecord[question.id]);
    if (selected.length > 0) selectedOptionIdsByQuestionId[question.id] = selected;
    if (question.allowOther && typeof otherTextRecord[question.id] === 'string') {
      otherTextByQuestionId[question.id] = otherTextRecord[question.id] as string;
    }
  }
  const requestedIndex = Number.isInteger(raw.activeQuestionIndex)
    ? Number(raw.activeQuestionIndex)
    : 0;
  return {
    interaction,
    selectedOptionIdsByQuestionId,
    otherTextByQuestionId,
    activeQuestionIndex: Math.max(0, Math.min(requestedIndex, interaction.questions.length - 1)),
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      && raw.updatedAt >= 0
      ? raw.updatedAt
      : Date.now(),
  };
}

function normalizeStoredThread(thread: StoredChatThread): ChatThread {
  const latestPlan = isStructuredPlan(thread.latestPlan) ? thread.latestPlan : undefined;
  const plans = Array.isArray(thread.plans) ? thread.plans.filter(isStructuredPlan) : [];
  const {
    workflow: _storedWorkflow,
    latestPlan: _storedPlan,
    plans: _storedPlans,
    docKey: storedDocKey,
    documentId: storedDocumentId,
    activeTemplateId: storedActiveTemplateId,
    pendingUserQuestion: storedPendingUserQuestion,
    ...rest
  } = thread;
  const messages = rest.messages.flatMap((raw): ThreadMessage[] => {
    if (!raw || typeof raw !== 'object') return [];
    const message = raw as unknown as Record<string, unknown>;
    if ((message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system')
      || typeof message.text !== 'string') return [];
    const attachments = Array.isArray(message.attachments)
      ? message.attachments.flatMap((item): ThreadAttachment[] => {
        if (!item || typeof item !== 'object') return [];
        const attachment = item as Record<string, unknown>;
        if (typeof attachment.stageId !== 'string' || typeof attachment.name !== 'string'
          || typeof attachment.mimeType !== 'string' || !Number.isFinite(Number(attachment.size))
          || (attachment.status !== 'processing' && attachment.status !== 'ready'
            && attachment.status !== 'error' && attachment.status !== 'deleted')) return [];
        return [{
          stageId: attachment.stageId,
          ...(typeof attachment.fileId === 'string' ? { fileId: attachment.fileId } : {}),
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: Math.max(0, Number(attachment.size)),
          status: attachment.status,
          ...(typeof attachment.error === 'string' ? { error: attachment.error } : {}),
        }];
      })
      : undefined;
    const agent: AgentName | undefined = isAgentName(message.agent) ? message.agent : undefined;
    const skillIcon: ProductSkillIcon | undefined = message.skillIcon === 'pencil'
      || message.skillIcon === 'bot' || message.skillIcon === 'system'
      ? message.skillIcon
      : undefined;
    const metadata = {
      ...(agent ? { agent } : {}),
      ...(typeof message.skillName === 'string' && /^[a-z0-9-]+$/.test(message.skillName)
        ? { skillName: message.skillName }
        : {}),
      ...(skillIcon ? { skillIcon } : {}),
      ...(typeof message.messageId === 'string' ? { messageId: message.messageId } : {}),
      ...(attachments?.length ? { attachments } : {}),
    };
    if (message.kind === 'user-question') {
      if (message.role !== 'assistant') return [];
      const interaction = normalizeUserQuestionInteraction(message.interaction);
      if (!interaction || interaction.threadId !== thread.id) return [];
      const outcome = normalizeUserQuestionOutcome(message.outcome, interaction);
      if (!outcome) return [];
      return [{
        role: 'assistant',
        text: message.text,
        kind: 'user-question',
        interaction,
        outcome,
        ...metadata,
        agent: interaction.agent,
      }];
    }
    if (message.kind === 'plan') {
      if (message.role !== 'assistant' || typeof message.planId !== 'string' || !message.planId) return [];
      return [{
        role: 'assistant',
        text: message.text,
        kind: 'plan',
        planId: message.planId,
        ...(message.planState === 'executed' ? { planState: 'executed' as const } : {}),
        ...metadata,
      }];
    }
    return [{
      role: message.role,
      text: message.text,
      ...(message.kind === 'progress' ? { kind: 'progress' as const } : {}),
      ...metadata,
    }];
  });
  const pendingUserQuestion = normalizePendingUserQuestionDraft(
    storedPendingUserQuestion,
    thread.id,
    thread.agent,
  );
  const pendingAlreadyArchived = pendingUserQuestion
    ? messages.some((message) => message.kind === 'user-question'
      && message.interaction.interactionId === pendingUserQuestion.interaction.interactionId)
    : false;
  return {
    ...rest,
    messages,
    workflow: isAgentWorkflow(thread.workflow) ? thread.workflow : 'direct',
    serviceTier: thread.serviceTier === 'fast' ? 'fast' : 'standard',
    docKey: typeof storedDocKey === 'string' && storedDocKey ? storedDocKey : null,
    documentId: typeof storedDocumentId === 'string' && storedDocumentId ? storedDocumentId : null,
    activeTemplateId: typeof storedActiveTemplateId === 'string' && storedActiveTemplateId ? storedActiveTemplateId : null,
    ...(latestPlan ? { latestPlan } : {}),
    ...(plans.length ? { plans } : {}),
    ...(pendingUserQuestion && !pendingAlreadyArchived ? { pendingUserQuestion } : {}),
  };
}

function cloneThread(thread: ChatThread) {
  return structuredClone(thread);
}

function openDb() {
  return openIndexedDatabase(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(THREADS_STORE)) {
      db.createObjectStore(THREADS_STORE, { keyPath: 'id' });
    }
  });
}

function runWithDb<T>(operation: (db: IDBDatabase) => Promise<T>) {
  return withDatabase(openDb, DB_NAME, operation, (error) =>
    Promise.reject(error ?? new Error(`${DB_NAME} unavailable`)));
}

function emitChanged() {
  for (const listener of listeners) listener();
}

function applyRemoteMessage(message: ThreadPersistenceMessage) {
  if (message.source === sourceId) return;
  if (message.type === 'upsert') {
    const current = cache.get(message.thread.id);
    if (!current || current.updatedAt <= message.thread.updatedAt) {
      cache.set(message.thread.id, cloneThread(message.thread));
      deletedBeforeHydration.delete(message.thread.id);
    }
  } else if (message.type === 'remove') {
    cache.delete(message.id);
    deletedBeforeHydration.add(message.id);
  } else {
    void hydrateFromIndexedDb(true);
  }
  emitChanged();
}

function parsePersistenceMessage(value: unknown): ThreadPersistenceMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Partial<ThreadPersistenceMessage>;
  if (typeof message.source !== 'string' || typeof message.nonce !== 'string') return null;
  if (message.type === 'upsert' && message.thread && isStoredChatThread(message.thread)) {
    return { ...message, thread: normalizeStoredThread(message.thread) } as ThreadPersistenceMessage;
  }
  if (message.type === 'remove' && typeof message.id === 'string') return message as ThreadPersistenceMessage;
  if (message.type === 'reload') return message as ThreadPersistenceMessage;
  return null;
}

function publish(message: ThreadPersistenceChange) {
  const payload = {
    ...message,
    source: sourceId,
    nonce: createPersistenceId(),
  } as ThreadPersistenceMessage;
  channel?.postMessage(payload);
  if (!channel && canUseStorage()) {
    try {
      localStorage.setItem(NOTIFY_KEY, JSON.stringify(payload));
    } catch {
      /* storage notification is best-effort */
    }
  }
  emitChanged();
}

async function hydrateFromIndexedDb(force = false) {
  if (!idbAvailable()) return;
  if (hydrationPromise && !force) return hydrationPromise;
  const run = (async () => {
    const legacy = readLegacyThreads();
    for (const thread of legacy) {
      const current = cache.get(thread.id);
      if (!current || current.updatedAt <= thread.updatedAt) cache.set(thread.id, thread);
    }

    try {
      const rows = await runWithDb(async (db) => {
        const tx = db.transaction(THREADS_STORE, legacy.length ? 'readwrite' : 'readonly');
        const store = tx.objectStore(THREADS_STORE);
        const existing = await requestResult(store.getAll() as IDBRequest<StoredChatThread[]>);
        const merged = new Map(
          existing.filter(isStoredChatThread).map((thread) => [thread.id, thread]),
        );
        for (const thread of legacy) {
          const current = merged.get(thread.id);
          if (!current || current.updatedAt < thread.updatedAt) {
            store.put(cloneThread(thread));
            merged.set(thread.id, thread);
          }
        }
        await transactionDone(tx);
        return [...merged.values()];
      });
      for (const row of rows) {
        if (!isStoredChatThread(row) || deletedBeforeHydration.has(row.id)) continue;
        const thread = normalizeStoredThread(row);
        const current = cache.get(thread.id);
        if (!current || current.updatedAt <= thread.updatedAt) cache.set(thread.id, thread);
      }
      if (legacy.length && canUseStorage()) localStorage.removeItem(STORAGE_KEY);
      hydrated = true;
      emitChanged();
    } catch (error) {
      console.warn('[threads] IndexedDB 초기화 실패, localStorage 폴백 유지:', error);
    }
  })();
  const pending = run.finally(() => {
    if (hydrationPromise === pending) hydrationPromise = null;
  });
  hydrationPromise = pending;
  return hydrationPromise;
}

function queueMutation(operation: () => Promise<string[]>, fallback: () => void) {
  mutationQueue = mutationQueue.then(async () => {
    try {
      await hydrateFromIndexedDb();
      const removed = await operation();
      for (const id of removed) {
        cache.delete(id);
        publish({ type: 'remove', id });
      }
    } catch (error) {
      fallback();
      console.warn('[threads] IndexedDB 저장 실패, localStorage 폴백:', error);
    }
  });
}

function trimCache() {
  const sorted = [...cache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const thread of sorted.slice(MAX_THREADS)) cache.delete(thread.id);
}

function persistUpsert(thread: ChatThread) {
  queueMutation(() => runWithDb(async (db) => {
    const tx = db.transaction(THREADS_STORE, 'readwrite');
    const store = tx.objectStore(THREADS_STORE);
    const existing = await requestResult(store.get(thread.id) as IDBRequest<StoredChatThread | undefined>);
    if (!existing || !isStoredChatThread(existing) || existing.updatedAt <= thread.updatedAt) {
      store.put(cloneThread(thread));
    }
    const rows = await requestResult(store.getAll() as IDBRequest<StoredChatThread[]>);
    const removed = rows
      .filter(isStoredChatThread)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(MAX_THREADS)
      .map((row) => row.id);
    for (const id of removed) store.delete(id);
    await transactionDone(tx);
    return removed;
  }), () => {
    const all = readLegacyThreads().filter((item) => item.id !== thread.id);
    all.unshift(thread);
    saveLegacyThreads(all);
  });
}

function persistRemove(id: string) {
  queueMutation(() => runWithDb(async (db) => {
    const tx = db.transaction(THREADS_STORE, 'readwrite');
    tx.objectStore(THREADS_STORE).delete(id);
    await transactionDone(tx);
    return [];
  }), () => {
    saveLegacyThreads(readLegacyThreads().filter((thread) => thread.id !== id));
  });
}

function loadAll() {
  if (!idbAvailable()) return readLegacyThreads();
  if (!hydrated) void hydrateFromIndexedDb();
  return [...cache.values()].map(cloneThread);
}

function saveFallbackMutation(threads: ChatThread[]) {
  saveLegacyThreads(threads);
  emitChanged();
}

if (idbAvailable()) {
  for (const thread of readLegacyThreads()) cache.set(thread.id, thread);
  if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = parsePersistenceMessage(event.data);
      if (message) applyRemoteMessage(message);
    });
  } else if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== NOTIFY_KEY || !event.newValue) return;
      try {
        const message = parsePersistenceMessage(JSON.parse(event.newValue));
        if (message) applyRemoteMessage(message);
      } catch {
        /* malformed cross-window notification */
      }
    });
  }
  void hydrateFromIndexedDb();
}

export function subscribeThreadChanges(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** IndexedDB hydration completion for startup coordination and focused tests. */
export async function waitForThreadsPersistence() {
  await hydrateFromIndexedDb();
  await mutationQueue;
}

export function createThreadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function fallbackTitle(messages: ThreadMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && (m.text.trim() || m.skillName));
  if (!first) return '새 채팅';
  const text = [first.skillName ? `/${first.skillName}` : '', first.text.trim()]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
}

export function createPendingUserQuestionDraftSnapshot(
  interaction: UserQuestionInteraction,
  updatedAt = Date.now(),
): PendingUserQuestionDraftSnapshot {
  return {
    interaction: structuredClone(interaction),
    selectedOptionIdsByQuestionId: {},
    otherTextByQuestionId: {},
    activeQuestionIndex: 0,
    updatedAt,
  };
}

export function pendingUserQuestionMatchesInteraction(
  pending: PendingUserQuestionDraftSnapshot,
  interaction: UserQuestionInteraction,
): boolean {
  return pending.interaction.interactionId === interaction.interactionId
    && pending.interaction.providerRequestId === interaction.providerRequestId
    && pending.interaction.threadId === interaction.threadId
    && pending.interaction.turnId === interaction.turnId
    && pending.interaction.agent === interaction.agent
    && pending.interaction.source === interaction.source;
}

function userQuestionHistoryText(
  interaction: UserQuestionInteraction,
  outcome: UserQuestionOutcome,
): string {
  const status = outcome.status === 'answered'
    ? '답변 완료'
    : outcome.status === 'cancelled'
      ? '사용자 중단'
      : '요청 만료';
  return `${interaction.questions.map((question) => question.question).join('\n')}\n${status}`;
}

export function createUserQuestionHistoryMessage(
  interaction: UserQuestionInteraction,
  outcome: UserQuestionOutcome,
): UserQuestionHistoryMessage {
  const interactionSnapshot = structuredClone(interaction);
  const outcomeSnapshot = structuredClone(outcome);
  return {
    role: 'assistant',
    kind: 'user-question',
    text: userQuestionHistoryText(interactionSnapshot, outcomeSnapshot),
    agent: interactionSnapshot.agent,
    interaction: interactionSnapshot,
    outcome: outcomeSnapshot,
  };
}

export function archivePendingUserQuestion(
  thread: ChatThread,
  interactionId: string,
  outcome: UserQuestionOutcome,
): UserQuestionHistoryMessage | null {
  const pending = thread.pendingUserQuestion;
  if (!pending || pending.interaction.interactionId !== interactionId) return null;
  const message = createUserQuestionHistoryMessage(pending.interaction, outcome);
  thread.messages.push(message);
  delete thread.pendingUserQuestion;
  return message;
}

export function expirePendingUserQuestion(
  thread: ChatThread,
  reason: Extract<UserQuestionOutcome, { status: 'expired' }>['reason'],
  interactionId = thread.pendingUserQuestion?.interaction.interactionId,
): UserQuestionHistoryMessage | null {
  if (!interactionId) return null;
  return archivePendingUserQuestion(thread, interactionId, { status: 'expired', reason });
}

export function clearPendingUserQuestion(
  thread: ChatThread,
  interactionId: string,
): PendingUserQuestionDraftSnapshot | null {
  const pending = thread.pendingUserQuestion;
  if (!pending || pending.interaction.interactionId !== interactionId) return null;
  delete thread.pendingUserQuestion;
  return pending;
}

function serializeUserQuestionHistoryMessage(
  message: UserQuestionHistoryMessage,
): ThreadProviderHistoryEntry[] {
  const request = {
    questions: message.interaction.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      mode: question.mode,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
      })),
      allowOther: question.allowOther,
    })),
  };
  const response = message.outcome.status === 'answered'
    ? {
        status: 'answered' as const,
        answers: message.interaction.questions.map((question) => {
          const answer = message.outcome.status === 'answered'
            ? message.outcome.answers[question.id]
            : undefined;
          const selected = new Set(answer?.selectedOptionIds ?? []);
          return {
            questionId: question.id,
            selectedOptions: question.options
              .filter((option) => selected.has(option.id))
              .map((option) => ({ id: option.id, label: option.label })),
            ...(answer?.otherText ? { otherText: answer.otherText } : {}),
          };
        }),
      }
    : { status: message.outcome.status, reason: message.outcome.reason };
  return [
    {
      role: 'assistant',
      text: `<user_question_request>\n${JSON.stringify(request)}\n</user_question_request>`,
    },
    {
      role: 'user',
      text: `<user_question_response>\n${JSON.stringify(response)}\n</user_question_response>`,
    },
  ];
}

export function serializeThreadMessagesForProviderHistory(
  messages: readonly ThreadMessage[],
): ThreadProviderHistoryEntry[] {
  return messages.flatMap((message): ThreadProviderHistoryEntry[] => {
    if (message.kind === 'user-question') {
      return serializeUserQuestionHistoryMessage(message);
    }
    if ((message.role !== 'user' && message.role !== 'assistant')
      || message.kind === 'progress'
      || (!message.text.trim() && !(message.role === 'user' && message.skillName))) return [];
    return [{
      role: message.role,
      text: message.role === 'user' && message.skillName
        ? `/${message.skillName}${message.text.trim() ? ` ${message.text}` : ''}`
        : message.text,
    }];
  });
}

export function createEmptyThread(draft: ThreadDraft): ChatThread {
  const now = Date.now();
  return {
    id: createThreadId(),
    title: '새 채팅',
    titleRequested: false,
    createdAt: now,
    updatedAt: now,
    agent: draft.agent,
    model: draft.model,
    effort: draft.effort,
    serviceTier: draft.serviceTier === 'fast' ? 'fast' : 'standard',
    workflow: draft.workflow ?? 'direct',
    docKey: draft.docKey ?? null,
    documentId: draft.documentId ?? null,
    activeTemplateId: draft.activeTemplateId ?? null,
    messages: [],
  };
}

/** 메시지가 있는 스레드만 최신순으로. */
export function listThreads(): ChatThread[] {
  return loadAll()
    .filter((t) => t.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface DocumentThreadGroup {
  /** 논리 문서 ID. 레거시 채팅은 파일명만 있어 null 일 수 있다. */
  documentId: string | null;
  docKey: string | null;
  threads: ChatThread[];
}

function documentGroupKey(thread: ChatThread): string {
  return thread.documentId ? `id:${thread.documentId}` : `name:${thread.docKey ?? ''}`;
}

/* 문서 그룹 순서는 '마지막으로 연 문서' 순이다 — 옛 채팅을 다시 열어도
   문서를 다시 열기 전에는 그룹 자리가 바뀌지 않는다. */
const DOC_ORDER_KEY = 'rhwp-agent-doc-order';
const DOC_ORDER_MAX = 200;

function readDocOrder(): string[] {
  if (!canUseStorage()) return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DOC_ORDER_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** 문서를 열 때마다 부른다 — 그 문서 그룹이 맨 위로 올라와 고정된다. */
export function recordDocumentOpened(documentId: string | null, docKey: string | null): void {
  // 파일명 키도 함께 적는다 — documentId 없이 저장된 레거시 그룹까지 따라온다.
  const keys = [
    ...(documentId ? [`id:${documentId}`] : []),
    ...(docKey ? [`name:${docKey}`] : []),
  ];
  if (keys.length === 0 || !canUseStorage()) return;
  const order = [...keys, ...readDocOrder().filter((k) => !keys.includes(k))];
  try {
    localStorage.setItem(DOC_ORDER_KEY, JSON.stringify(order.slice(0, DOC_ORDER_MAX)));
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * 문서별 채팅 묶음 — 그룹 순서는 문서를 마지막으로 연 순서(recordDocumentOpened)를
 * 따르고, 아직 기록이 없는 그룹은 가장 최근에 움직인 채팅 순서로 그 뒤에 이어진다.
 * 그룹 안은 최신순이다(listThreads 정렬을 그대로 물려받는다).
 * 같은 파일명이라도 documentId 가 다르면 다른 문서로 나눈다.
 */
export function listThreadsByDocument(): DocumentThreadGroup[] {
  const groups = new Map<string, ChatThread[]>();
  const meta = new Map<string, { documentId: string | null; docKey: string | null }>();
  for (const thread of listThreads()) {
    const key = documentGroupKey(thread);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(thread);
    } else {
      groups.set(key, [thread]);
      meta.set(key, { documentId: thread.documentId, docKey: thread.docKey });
    }
    const info = meta.get(key);
    if (info && !info.docKey && thread.docKey) info.docKey = thread.docKey;
  }
  const rank = new Map(readDocOrder().map((key, i) => [key, i] as const));
  const UNRANKED = Number.MAX_SAFE_INTEGER;
  const groupRank = (documentId: string | null, docKey: string | null): number => {
    const byId = documentId ? rank.get(`id:${documentId}`) : undefined;
    const byName = docKey ? rank.get(`name:${docKey}`) : undefined;
    return Math.min(byId ?? UNRANKED, byName ?? UNRANKED);
  };
  return [...groups.entries()]
    .map(([key, threads]) => ({
      documentId: meta.get(key)?.documentId ?? null,
      docKey: meta.get(key)?.docKey ?? null,
      threads,
    }))
    // 안정 정렬이라 기록 없는 그룹끼리는 최근 활동 순서를 그대로 지킨다.
    .sort((a, b) => groupRank(a.documentId, a.docKey) - groupRank(b.documentId, b.docKey));
}

export function getThread(id: string): ChatThread | null {
  return loadAll().find((t) => t.id === id) ?? null;
}

/** 메시지가 있을 때만 저장한다. 빈 스레드는 목록에 올리지 않는다. */
export function upsertThread(thread: ChatThread): void {
  if (thread.messages.length === 0) {
    removeThread(thread.id);
    return;
  }
  const capped: ChatThread = {
    ...thread,
    messages: thread.messages.slice(-MAX_MESSAGES_PER_THREAD),
    updatedAt: Date.now(),
    title: thread.title.trim() || fallbackTitle(thread.messages),
    titleRequested: Boolean(thread.titleRequested),
    workflow: isAgentWorkflow(thread.workflow) ? thread.workflow : 'direct',
    ...(isStructuredPlan(thread.latestPlan) ? { latestPlan: thread.latestPlan } : { latestPlan: undefined }),
  };

  if (!idbAvailable()) {
    const all = readLegacyThreads().filter((item) => item.id !== capped.id);
    all.unshift(capped);
    saveFallbackMutation(all);
    return;
  }

  cache.set(capped.id, cloneThread(capped));
  deletedBeforeHydration.delete(capped.id);
  trimCache();
  publish({ type: 'upsert', thread: cloneThread(capped) });
  persistUpsert(capped);
}

export function removeThread(id: string): void {
  if (!idbAvailable()) {
    saveFallbackMutation(readLegacyThreads().filter((thread) => thread.id !== id));
    return;
  }
  cache.delete(id);
  deletedBeforeHydration.add(id);
  publish({ type: 'remove', id });
  persistRemove(id);
}

/**
 * 문서 보관 — 문서 파일은 그대로 두고, 그 문서 그룹에 속한 채팅을 모두
 * 지운다. 문서 열람 순서 기록도 함께 지워 탐색기가 문서를 더는 기억하지
 * 않는다. 지운 채팅 ID 목록을 돌려준다.
 */
export function forgetDocumentThreads(documentId: string | null, docKey: string | null): string[] {
  // 그룹 소속 판정은 documentGroupKey 와 같은 규칙이다 — ID가 있으면 ID로,
  // 없으면 파일명으로만 묶인 레거시 채팅을 지운다.
  const removed = loadAll()
    .filter((thread) => (documentId
      ? thread.documentId === documentId
      : !thread.documentId && (thread.docKey ?? '') === (docKey ?? '')))
    .map((thread) => thread.id);
  for (const id of removed) removeThread(id);

  if (canUseStorage()) {
    const drop = new Set<string>();
    if (documentId) drop.add(`id:${documentId}`);
    // 같은 파일명을 쓰는 다른 그룹이 남아 있으면 이름 키는 그 그룹 몫으로 남긴다.
    if (docKey && !loadAll().some((thread) => thread.docKey === docKey)) drop.add(`name:${docKey}`);
    if (drop.size) {
      try {
        localStorage.setItem(DOC_ORDER_KEY, JSON.stringify(readDocOrder().filter((key) => !drop.has(key))));
      } catch {
        /* ignore quota / private mode */
      }
    }
  }
  return removed;
}

/** 자동 제목(에이전트/폴백) — 사용자가 고정한 이름은 건드리지 않는다. */
export function setThreadTitle(id: string, title: string): ChatThread | null {
  const current = getThread(id);
  if (!current || current.titlePinned) return current;
  const cleaned = title.trim().replace(/^["'「『]|["'」』]$/g, '').trim();
  if (!cleaned) return current;
  const next = { ...current, title: cleaned.slice(0, 48), updatedAt: Date.now() };
  upsertThread(next);
  return next;
}

/**
 * 사용자가 직접 이름을 바꾼다. 자동 제목과 달리 titlePinned 를 세워
 * 이후 에이전트 제목이 덮어쓰지 못하게 한다. 빈 이름은 무시한다.
 * updatedAt 은 건드리지 않는다 — 이름 바꾸기는 대화 활동이 아니라서
 * 목록 순서가 튀면 안 된다.
 */
export function renameThread(id: string, title: string): ChatThread | null {
  const current = getThread(id);
  if (!current) return null;
  const cleaned = title.trim().replace(/\s+/g, ' ');
  if (!cleaned) return current;
  const next = { ...current, title: cleaned.slice(0, 48), titlePinned: true };
  if (idbAvailable()) {
    cache.set(id, cloneThread(next));
    publish({ type: 'upsert', thread: cloneThread(next) });
    persistUpsert(next);
  } else {
    const all = readLegacyThreads();
    const index = all.findIndex((thread) => thread.id === id);
    if (index >= 0) {
      all[index] = next;
      saveFallbackMutation(all);
    }
  }
  return next;
}
