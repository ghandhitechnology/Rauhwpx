import { isAgentWorkflow, isStructuredPlan } from './types.ts';
import type { AgentName, AgentWorkflow, StructuredPlan } from './types.ts';

const STORAGE_KEY = 'rhwp-agent-threads';
const MAX_THREADS = 40;
const MAX_MESSAGES_PER_THREAD = 200;

export interface ThreadMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  agent?: AgentName;
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

type StoredChatThread = Omit<ChatThread, 'workflow' | 'latestPlan' | 'docKey' | 'documentId'> & {
  workflow?: unknown;
  latestPlan?: unknown;
  docKey?: unknown;
  documentId?: unknown;
};

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function loadAll(): ChatThread[] {
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

function saveAll(threads: ChatThread[]): void {
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
  const {
    workflow: _storedWorkflow,
    latestPlan: _storedPlan,
    docKey: storedDocKey,
    documentId: storedDocumentId,
    ...rest
  } = thread;
  return {
    ...rest,
    workflow: isAgentWorkflow(thread.workflow) ? thread.workflow : 'direct',
    docKey: typeof storedDocKey === 'string' && storedDocKey ? storedDocKey : null,
    documentId: typeof storedDocumentId === 'string' && storedDocumentId ? storedDocumentId : null,
    ...(latestPlan ? { latestPlan } : {}),
  };
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
  docKey: string | null;
  threads: ChatThread[];
}

/**
 * 문서별 채팅 묶음 — 그룹 순서는 가장 최근에 움직인 채팅 기준이고,
 * 그룹 안도 최신순이다(listThreads 정렬을 그대로 물려받는다).
 */
export function listThreadsByDocument(): DocumentThreadGroup[] {
  const groups = new Map<string | null, ChatThread[]>();
  for (const thread of listThreads()) {
    const key = thread.docKey ?? null;
    const bucket = groups.get(key);
    if (bucket) bucket.push(thread);
    else groups.set(key, [thread]);
  }
  return [...groups.entries()].map(([docKey, threads]) => ({ docKey, threads }));
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
  const all = loadAll().filter((t) => t.id !== capped.id);
  all.unshift(capped);
  saveAll(all);
}

export function removeThread(id: string): void {
  saveAll(loadAll().filter((t) => t.id !== id));
}

/** 자동 제목(에이전트/폴백) — 사용자가 고정한 이름은 건드리지 않는다. */
export function setThreadTitle(id: string, title: string): ChatThread | null {
  const all = loadAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  if (all[idx]!.titlePinned) return all[idx]!;
  const cleaned = title.trim().replace(/^["'「『]|["'」』]$/g, '').trim();
  if (!cleaned) return all[idx]!;
  const next = { ...all[idx]!, title: cleaned.slice(0, 48), updatedAt: Date.now() };
  all[idx] = next;
  saveAll(all);
  return next;
}

/**
 * 사용자가 직접 이름을 바꾼다. 자동 제목과 달리 titlePinned 를 세워
 * 이후 에이전트 제목이 덮어쓰지 못하게 한다. 빈 이름은 무시한다.
 * updatedAt 은 건드리지 않는다 — 이름 바꾸기는 대화 활동이 아니라서
 * 목록 순서가 튀면 안 된다.
 */
export function renameThread(id: string, title: string): ChatThread | null {
  const all = loadAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const cleaned = title.trim().replace(/\s+/g, ' ');
  if (!cleaned) return all[idx]!;
  const next = { ...all[idx]!, title: cleaned.slice(0, 48), titlePinned: true };
  all[idx] = next;
  saveAll(all);
  return next;
}
