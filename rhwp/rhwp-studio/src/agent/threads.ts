import {
  IDB_OPERATION_TIMEOUT_MS,
  openIndexedDatabase,
  withTimeout,
} from '../core/idb-open.ts';
import { isAgentWorkflow, isStructuredPlan } from './types.ts';
import type { AgentName, AgentWorkflow, StructuredPlan } from './types.ts';

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
  messageId?: string;
  attachments?: ThreadAttachment[];
}

export type ThreadMessage =
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
  workflow: AgentWorkflow;
  /** 이 채팅이 속한 문서(파일 이름). null = 문서 없이 시작한 채팅. */
  docKey: string | null;
  /** 서버의 문서별 참고자료 범위에 쓰는 안정적인 논리 문서 ID. */
  documentId: string | null;
  /** Historical display data only. Phase/approval/capability authority is never persisted. */
  latestPlan?: StructuredPlan;
  /** Plan snapshots referenced by clickable chat presentations. */
  plans?: StructuredPlan[];
  messages: ThreadMessage[];
}

export interface ThreadDraft {
  agent: AgentName;
  model: string;
  effort: string;
  workflow?: AgentWorkflow;
  docKey?: string | null;
  documentId?: string | null;
}

type StoredChatThread = Omit<ChatThread, 'workflow' | 'latestPlan' | 'plans' | 'docKey' | 'documentId'> & {
  workflow?: unknown;
  latestPlan?: unknown;
  plans?: unknown;
  docKey?: unknown;
  documentId?: unknown;
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
    && (t.agent === 'claude' || t.agent === 'codex')
    && typeof t.model === 'string'
    && typeof t.effort === 'string'
    && Array.isArray(t.messages)
  );
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
    ...rest
  } = thread;
  return {
    ...rest,
    messages: rest.messages.flatMap((raw): ThreadMessage[] => {
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
      const agent: AgentName | undefined = message.agent === 'claude' || message.agent === 'codex' || message.agent === 'pi'
        ? message.agent
        : undefined;
      const metadata = {
        ...(agent ? { agent } : {}),
        ...(typeof message.messageId === 'string' ? { messageId: message.messageId } : {}),
        ...(attachments?.length ? { attachments } : {}),
      };
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
    }),
    workflow: isAgentWorkflow(thread.workflow) ? thread.workflow : 'direct',
    docKey: typeof storedDocKey === 'string' && storedDocKey ? storedDocKey : null,
    documentId: typeof storedDocumentId === 'string' && storedDocumentId ? storedDocumentId : null,
    ...(latestPlan ? { latestPlan } : {}),
    ...(plans.length ? { plans } : {}),
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

async function runWithDb<T>(operation: (db: IDBDatabase) => Promise<T>) {
  const db = await openDb();
  if (!db) throw new Error(`${DB_NAME} unavailable`);
  try {
    return await withTimeout(operation(db), IDB_OPERATION_TIMEOUT_MS, DB_NAME);
  } finally {
    db.close();
  }
}

function transactionDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
  const first = messages.find((m) => m.role === 'user' && m.text.trim());
  if (!first) return '새 채팅';
  const text = first.text.trim().replace(/\s+/g, ' ');
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
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
    workflow: draft.workflow ?? 'direct',
    docKey: draft.docKey ?? null,
    documentId: draft.documentId ?? null,
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

/**
 * 문서별 채팅 묶음 — 그룹 순서는 가장 최근에 움직인 채팅 기준이고,
 * 그룹 안도 최신순이다(listThreads 정렬을 그대로 물려받는다).
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
  return [...groups.entries()].map(([key, threads]) => ({
    documentId: meta.get(key)?.documentId ?? null,
    docKey: meta.get(key)?.docKey ?? null,
    threads,
  }));
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
