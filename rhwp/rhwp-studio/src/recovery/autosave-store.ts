/**
 * 미저장 문서 복구용 자동 백업 저장소.
 *
 * 문서 비교 이력(`rhwpStudioDocHistory`)과 섞지 않기 위해 별도 IndexedDB를 사용한다.
 * IndexedDB를 사용할 수 없는 테스트/제한 환경에서는 메모리 저장소로 폴백한다.
 */

import {
  openIndexedDatabase,
  requestResult,
  transactionDone,
  withDatabase,
} from '../core/idb-open.ts';

const DB_NAME = 'rhwpStudioAutosave';
const DB_VER = 2;
const DRAFTS = 'drafts';
const SESSIONS = 'sessions';
const MAX_DRAFTS = 12;
export const AUTOSAVE_SESSION_STALE_MS = 20_000;

export interface AutosaveOwner {
  launchId: string;
  sessionId: string;
}

export interface AutosaveDraft {
  id: string;
  fileName: string;
  sourceFormat: string;
  savedAt: number;
  byteLength: number;
  data: Uint8Array;
  dirtyReason?: string;
  ownerLaunchId?: string;
  ownerSessionId?: string;
  ownerHeartbeatAt?: number;
}

export interface AutosaveSessionHeartbeat extends AutosaveOwner {
  heartbeatAt: number;
}

export interface RecoverableAutosaveOptions {
  now?: number;
  staleAfterMs?: number;
}

type DraftRow = Omit<AutosaveDraft, 'data'> & { data?: ArrayBuffer };

const memory = new Map<string, AutosaveDraft>();
const memorySessions = new Map<string, AutosaveSessionHeartbeat>();

function cloneBytes(bytes: Uint8Array) {
  return new Uint8Array(bytes);
}

function bytesToArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function cloneDraft(draft: AutosaveDraft): AutosaveDraft {
  return { ...draft, data: cloneBytes(draft.data) };
}

function rowToDraft(row: DraftRow): AutosaveDraft {
  return {
    ...row,
    byteLength: row.byteLength,
    data: new Uint8Array(row.data ?? new ArrayBuffer(0)),
  };
}

function draftToRow(draft: AutosaveDraft): DraftRow {
  return {
    ...draft,
    byteLength: draft.data.byteLength,
    data: bytesToArrayBuffer(draft.data),
  };
}

function openDb() {
  return openIndexedDatabase(DB_NAME, DB_VER, (db) => {
    if (!db.objectStoreNames.contains(DRAFTS)) {
      db.createObjectStore(DRAFTS, { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains(SESSIONS)) {
      db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
    }
  });
}

function withDb<T>(fn: (db: IDBDatabase) => Promise<T>, fallback: () => Promise<T>) {
  return withDatabase(openDb, DB_NAME, fn, fallback);
}

function activeSessionIds(
  sessions: AutosaveSessionHeartbeat[],
  now: number,
  staleAfterMs = AUTOSAVE_SESSION_STALE_MS,
) {
  const cutoff = now - staleAfterMs;
  return new Set(
    sessions
      .filter((session) => Number.isFinite(session.heartbeatAt) && session.heartbeatAt >= cutoff)
      .map((session) => session.sessionId),
  );
}

function draftIsActive(
  draft: Pick<AutosaveDraft, 'ownerSessionId' | 'ownerHeartbeatAt'>,
  active: ReadonlySet<string>,
  now: number,
  staleAfterMs = AUTOSAVE_SESSION_STALE_MS,
) {
  if (!draft.ownerSessionId) return false;
  if (active.has(draft.ownerSessionId)) return true;
  return typeof draft.ownerHeartbeatAt === 'number'
    && draft.ownerHeartbeatAt >= now - staleAfterMs;
}

function trimDraftRows(
  drafts: Array<Pick<AutosaveDraft, 'id' | 'savedAt' | 'ownerSessionId' | 'ownerHeartbeatAt'>>,
  sessions: AutosaveSessionHeartbeat[],
  now: number,
) {
  const excess = drafts.length - MAX_DRAFTS;
  if (excess <= 0) return [];
  const active = activeSessionIds(sessions, now);
  return drafts
    .filter((draft) => !draftIsActive(draft, active, now))
    .sort((a, b) => a.savedAt - b.savedAt)
    .slice(0, excess)
    .map((draft) => draft.id);
}

function trimMemoryDrafts(now: number) {
  const remove = trimDraftRows(
    [...memory.values()],
    [...memorySessions.values()],
    now,
  );
  for (const id of remove) memory.delete(id);
}

export function createAutosaveDraftId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `draft_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function saveAutosaveDraft(draft: AutosaveDraft): Promise<void> {
  const normalized = cloneDraft({
    ...draft,
    byteLength: draft.data.byteLength,
  });
  const now = Date.now();

  await withDb(
    async (db) => {
      const tx = db.transaction([DRAFTS, SESSIONS], 'readwrite');
      const draftsStore = tx.objectStore(DRAFTS);
      draftsStore.put(draftToRow(normalized));
      const [drafts, sessions] = await Promise.all([
        requestResult(draftsStore.getAll() as IDBRequest<DraftRow[]>),
        requestResult(tx.objectStore(SESSIONS).getAll() as IDBRequest<AutosaveSessionHeartbeat[]>),
      ]);
      for (const id of trimDraftRows(drafts, sessions, now)) draftsStore.delete(id);
      await transactionDone(tx);
    },
    async () => {
      memory.set(normalized.id, normalized);
      trimMemoryDrafts(now);
    },
  );
}

export async function getAutosaveDraft(id: string): Promise<AutosaveDraft | null> {
  const mem = memory.get(id);
  if (mem) return cloneDraft(mem);

  return withDb(
    async (db) => {
      const tx = db.transaction(DRAFTS, 'readonly');
      const row = await requestResult(tx.objectStore(DRAFTS).get(id) as IDBRequest<DraftRow | undefined>);
      await transactionDone(tx);
      return row ? rowToDraft(row) : null;
    },
    async () => null,
  );
}

export async function listAutosaveDrafts(): Promise<AutosaveDraft[]> {
  return withDb(
    async (db) => {
      const tx = db.transaction(DRAFTS, 'readonly');
      const rows = await requestResult(tx.objectStore(DRAFTS).getAll() as IDBRequest<DraftRow[]>);
      await transactionDone(tx);
      return rows.map(rowToDraft).sort((a, b) => b.savedAt - a.savedAt);
    },
    async () => [...memory.values()].map(cloneDraft).sort((a, b) => b.savedAt - a.savedAt),
  );
}

async function listAutosaveSessions() {
  return withDb(
    async (db) => {
      const tx = db.transaction(SESSIONS, 'readonly');
      const rows = await requestResult(
        tx.objectStore(SESSIONS).getAll() as IDBRequest<AutosaveSessionHeartbeat[]>,
      );
      await transactionDone(tx);
      return rows;
    },
    async () => [...memorySessions.values()].map((session) => ({ ...session })),
  );
}

/** 현재 살아 있는 다른 window의 draft를 복구 후보에서 제외한다. */
export async function listRecoverableAutosaveDrafts(options: RecoverableAutosaveOptions = {}) {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? AUTOSAVE_SESSION_STALE_MS;
  const [drafts, sessions] = await Promise.all([listAutosaveDrafts(), listAutosaveSessions()]);
  const active = activeSessionIds(sessions, now, staleAfterMs);
  return drafts.filter((draft) => !draftIsActive(draft, active, now, staleAfterMs));
}

export async function touchAutosaveSession(owner: AutosaveOwner, heartbeatAt = Date.now()) {
  const heartbeat: AutosaveSessionHeartbeat = {
    launchId: owner.launchId,
    sessionId: owner.sessionId,
    heartbeatAt,
  };
  memorySessions.set(owner.sessionId, heartbeat);
  await withDb(
    async (db) => {
      const tx = db.transaction(SESSIONS, 'readwrite');
      tx.objectStore(SESSIONS).put(heartbeat);
      await transactionDone(tx);
    },
    async () => {},
  );
}

export async function releaseAutosaveSession(sessionId: string) {
  memorySessions.delete(sessionId);
  await withDb(
    async (db) => {
      const tx = db.transaction(SESSIONS, 'readwrite');
      tx.objectStore(SESSIONS).delete(sessionId);
      await transactionDone(tx);
    },
    async () => {},
  );
}

export async function deleteAutosaveDraft(id: string): Promise<void> {
  memory.delete(id);
  await withDb(
    async (db) => {
      const tx = db.transaction(DRAFTS, 'readwrite');
      tx.objectStore(DRAFTS).delete(id);
      await transactionDone(tx);
    },
    async () => {},
  );
}

/** 복구 가능한(죽은 이전 세션 소유) draft만 지운다. */
export async function clearRecoverableAutosaveDrafts(options: RecoverableAutosaveOptions = {}) {
  const drafts = await listRecoverableAutosaveDrafts(options);
  await Promise.all(drafts.map((draft) => deleteAutosaveDraft(draft.id)));
}

/** 명시적인 전체 초기화 API. 일반 복구 UI는 clearRecoverableAutosaveDrafts를 사용한다. */
export async function clearAutosaveDrafts(): Promise<void> {
  memory.clear();
  await withDb(
    async (db) => {
      const tx = db.transaction(DRAFTS, 'readwrite');
      tx.objectStore(DRAFTS).clear();
      await transactionDone(tx);
    },
    async () => {},
  );
}
