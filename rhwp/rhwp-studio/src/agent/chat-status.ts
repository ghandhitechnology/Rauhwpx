/**
 * 채팅별 실행 상태 공유 — 탭마다 독립적으로 돌아가는 채팅 세션의
 * "작업 중/완료" 신호만 localStorage 로 나눠 갖는다. 어떤 탭의 스레드
 * 목록에서든 지금 일하는 채팅(노란 불), 끝난 채팅(초록 점), 계획 승인을
 * 기다리는 채팅(빨간 점)이 보인다.
 *
 * 세션 자체에는 손대지 않는다. 여기 담기는 것은 표시용 신호뿐이라
 * 잃어버려도 대화에는 아무 영향이 없다.
 */

export type ChatRunStatus = 'working' | 'finished' | 'needs-input';

const STORAGE_KEY = 'rhwp-agent-chat-status';
const CHANNEL_NAME = 'rhwp-agent-chat-status';
/** 작업 신호는 심장박동이 이 시간 넘게 끊기면(탭 크래시 등) 무효다. */
const WORKING_STALE_MS = 25_000;
const HEARTBEAT_MS = 10_000;
/** 완료 점은 이 시간이 지나면 정리한다 — 옛 채팅까지 초록으로 남지 않게. */
const FINISHED_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 80;
/** 무효 전환(심장박동 끊김·TTL 만료)을 구독자에게 알리는 점검 주기. */
const SWEEP_MS = 5_000;

interface StatusEntry {
  status: ChatRunStatus;
  updatedAt: number;
}

const listeners = new Set<() => void>();
/** 이 탭이 직접 돌리는 작업 — 심장박동과 탭 종료 정리는 이 목록만 만진다. */
const ownedWorking = new Set<string>();
const memoryMap = new Map<string, StatusEntry>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let channel: BroadcastChannel | null = null;
let lastSnapshot = '';

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function isStatusEntry(v: unknown): v is StatusEntry {
  if (!v || typeof v !== 'object') return false;
  const entry = v as Record<string, unknown>;
  return (entry.status === 'working' || entry.status === 'finished' || entry.status === 'needs-input')
    && Number.isFinite(Number(entry.updatedAt));
}

function readMap(): Map<string, StatusEntry> {
  if (!canUseStorage()) return new Map(memoryMap);
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const map = new Map<string, StatusEntry>();
    for (const [id, entry] of Object.entries(parsed)) {
      if (isStatusEntry(entry)) map.set(id, entry);
    }
    return map;
  } catch {
    return new Map();
  }
}

function writeMap(map: Map<string, StatusEntry>): void {
  const trimmed = [...map.entries()]
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_ENTRIES);
  if (!canUseStorage()) {
    memoryMap.clear();
    for (const [id, entry] of trimmed) memoryMap.set(id, entry);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    /* 저장 실패는 표시 신호만 잃는다 */
  }
}

function liveStatus(entry: StatusEntry, now: number): ChatRunStatus | null {
  if (entry.status === 'working') {
    return now - entry.updatedAt <= WORKING_STALE_MS ? 'working' : null;
  }
  // 완료·승인 대기 점은 심장박동 없이 남고, TTL 로만 정리한다.
  return now - entry.updatedAt <= FINISHED_TTL_MS ? entry.status : null;
}

function currentSnapshot(): string {
  const now = Date.now();
  return [...readMap().entries()]
    .map(([id, entry]) => [id, liveStatus(entry, now)] as const)
    .filter(([, status]) => status !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, status]) => `${id}:${status}`)
    .join('|');
}

/** 실질 상태(id→상태)가 바뀌었을 때만 알린다 — 심장박동만으로는 조용하다. */
function emitIfChanged(): void {
  const snapshot = currentSnapshot();
  if (snapshot === lastSnapshot) return;
  lastSnapshot = snapshot;
  for (const listener of listeners) listener();
}

function notifyPeers(): void {
  channel?.postMessage({ key: STORAGE_KEY });
}

function mutate(fn: (map: Map<string, StatusEntry>) => void): void {
  const map = readMap();
  fn(map);
  writeMap(map);
  notifyPeers();
  emitIfChanged();
}

function syncHeartbeat(): void {
  if (ownedWorking.size === 0) {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    return;
  }
  if (heartbeatTimer !== null) return;
  heartbeatTimer = setInterval(() => {
    mutate((map) => {
      const now = Date.now();
      for (const id of ownedWorking) {
        const entry = map.get(id);
        if (entry?.status === 'working') map.set(id, { status: 'working', updatedAt: now });
      }
    });
  }, HEARTBEAT_MS);
  (heartbeatTimer as { unref?: () => void }).unref?.();
}

function syncSweep(): void {
  if (listeners.size === 0) {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    return;
  }
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(emitIfChanged, SWEEP_MS);
  (sweepTimer as { unref?: () => void }).unref?.();
}

if (typeof window !== 'undefined') {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', emitIfChanged);
  }
  // BroadcastChannel 이 없어도 다른 탭의 저장은 storage 이벤트로 도착한다.
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) emitIfChanged();
  });
  // 탭이 닫히면 이 탭의 작업 신호도 같이 꺼진다 — 죽은 노란 불을 남기지 않는다.
  window.addEventListener('pagehide', () => {
    if (ownedWorking.size === 0) return;
    mutate((map) => {
      for (const id of ownedWorking) {
        if (map.get(id)?.status === 'working') map.delete(id);
      }
    });
    ownedWorking.clear();
    syncHeartbeat();
  });
}

/** 턴 시작 — 이 채팅에 노란 불이 켜지고 심장박동이 시작된다. */
export function markChatWorking(threadId: string): void {
  ownedWorking.add(threadId);
  syncHeartbeat();
  mutate((map) => map.set(threadId, { status: 'working', updatedAt: Date.now() }));
}

/** 턴 완료 — 노란 불이 초록 점으로 바뀐다. 채팅을 열면 점이 걷힌다. */
export function markChatFinished(threadId: string): void {
  ownedWorking.delete(threadId);
  syncHeartbeat();
  mutate((map) => map.set(threadId, { status: 'finished', updatedAt: Date.now() }));
}

/** 사용자 응답 대기(계획 승인 또는 질문) — 빨간 점. 응답이 있어야 걷힌다. */
export function markChatNeedsInput(threadId: string): void {
  ownedWorking.delete(threadId);
  syncHeartbeat();
  mutate((map) => map.set(threadId, { status: 'needs-input', updatedAt: Date.now() }));
}

/** 중단·열람 — 신호를 지운다. */
export function clearChatStatus(threadId: string): void {
  ownedWorking.delete(threadId);
  syncHeartbeat();
  mutate((map) => map.delete(threadId));
}

export function getChatStatus(threadId: string): ChatRunStatus | null {
  const entry = readMap().get(threadId);
  return entry ? liveStatus(entry, Date.now()) : null;
}

export function subscribeChatStatus(listener: () => void): () => void {
  listeners.add(listener);
  lastSnapshot = currentSnapshot();
  syncSweep();
  return () => {
    listeners.delete(listener);
    syncSweep();
  };
}
