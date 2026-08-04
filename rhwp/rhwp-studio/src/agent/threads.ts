import type { AgentName } from './types.ts';

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
  createdAt: number;
  updatedAt: number;
  agent: AgentName;
  model: string;
  effort: string;
  messages: ThreadMessage[];
}

export interface ThreadDraft {
  agent: AgentName;
  model: string;
  effort: string;
}

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
    return parsed.filter(isChatThread);
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

function isChatThread(v: unknown): v is ChatThread {
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
    messages: [],
  };
}

/** 메시지가 있는 스레드만 최신순으로. */
export function listThreads(): ChatThread[] {
  return loadAll()
    .filter((t) => t.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
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
  };
  const all = loadAll().filter((t) => t.id !== capped.id);
  all.unshift(capped);
  saveAll(all);
}

export function removeThread(id: string): void {
  saveAll(loadAll().filter((t) => t.id !== id));
}

export function setThreadTitle(id: string, title: string): ChatThread | null {
  const all = loadAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const cleaned = title.trim().replace(/^["'「『]|["'」』]$/g, '').trim();
  if (!cleaned) return all[idx]!;
  const next = { ...all[idx]!, title: cleaned.slice(0, 48), updatedAt: Date.now() };
  all[idx] = next;
  saveAll(all);
  return next;
}
