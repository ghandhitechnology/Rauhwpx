/**
 * 최근 열람 문서 저장소.
 *
 * 파일 메뉴 "최근 문서" 목록의 영속 저장을 담당한다. 문서 바이트는 보관하지
 * 않는다. `FileSystemFileHandle`이 있는 열기는 핸들과 메타(파일명/형식/시각)를
 * 저장해 라이브 파일을 재연다. 드롭/`input[type=file]`/URL 로드처럼 핸들이 없는
 * 열기도 메타-only로 기록하며, 이 항목은 선택 시 파일을 다시 고르게 한다.
 *
 * 동일 문서 판정은 `isSameEntry`가 권위다. 양쪽 핸들을 비교할 수 없는 열기
 * (드롭/`input[type=file]`/URL 등)만 원본 바이트 digest로 폴백한다. 파일명은
 * 표시용 메타일 뿐 identity로 사용하지 않는다.
 *
 * 자동 백업(`rhwpStudioAutosave`)·비교 이력(`rhwpStudioDocHistory`)과 섞지 않기
 * 위해 별도 IndexedDB(`rhwpStudioRecent`)를 사용한다. IndexedDB를 쓸 수 없는
 * 테스트/제한 환경에서는 메모리 저장소로 폴백한다.
 */

import type { FileSystemFileHandleLike } from '@/command/file-system-access';

const DB_NAME = 'rhwpStudioRecent';
const DB_VER = 2;
const STORE = 'recent';
const MAX_RECENT = 8;

export interface RecentDoc {
  /** 최근 문서 레코드 ID (메뉴 항목/삭제 key). */
  id: string;
  /** 파일명이나 저장 경로가 바뀌어도 유지되는 논리 문서 ID. */
  documentId: string;
  /** 열 때 읽은 원본 바이트의 digest (`algorithm:hex`). */
  sourceDigest: string;
  /** 파일명 (경로 아님 — 브라우저 제약) */
  fileName: string;
  /** 원본 형식 ('hwp' | 'hwpx' | 'hml' 등) */
  sourceFormat: string;
  /** 마지막으로 연 시각 (epoch ms) */
  openedAt: number;
  /**
   * 재열기용 파일 핸들. File System Access 로 연 경우에만 존재한다.
   * 드롭/`input[type=file]`/URL 로드 등 핸들이 없는 경로는 메타-only 로 기록되며
   * (`handle` 미존재), 이 경우 자동 재열기는 불가하고 목록/이력 표시에만 쓰인다.
   */
  handle?: FileSystemFileHandleLike;
}

/** addRecentDoc 입력 (id/openedAt는 내부 생성) */
export interface RecentDocInput {
  /** 이미 활성화된 논리 문서를 갱신할 때 전달한다(예: 저장 경로 변경). */
  documentId?: string | null;
  /** 열 때 읽은 원본 바이트의 digest (`algorithm:hex`). */
  sourceDigest: string;
  fileName: string;
  sourceFormat: string;
  /**
   * 재열기용 핸들. 없으면(null/undefined) 메타-only 로 기록한다 — 파일명/형식/시각만
   * 남기며 자동 재열기는 불가하다. 핸들이 있으면 라이브 파일 재열기가 가능하다.
   */
  handle?: FileSystemFileHandleLike | null;
}

const memory = new Map<string, RecentDoc>();

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function createRecentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `recent_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function createDocumentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `document_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function openDb(): Promise<IDBDatabase | null> {
  if (!idbAvailable()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onerror = () => resolve(null);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      } else if (event.oldVersion < 2) {
        // v1 rows have no digest/documentId. A filename-derived migration would recreate
        // the identity collision this schema is designed to remove, so discard only the
        // ephemeral recent list and rebuild it as documents are opened.
        req.transaction?.objectStore(STORE).clear();
      }
    };
  });
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  const db = await openDb();
  if (!db) return fallback();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function getAllRows(db: IDBDatabase): Promise<RecentDoc[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as RecentDoc[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

function putRow(db: IDBDatabase, row: RecentDoc): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteRow(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 동일 파일 판정 — 핸들 비교가 불가능할 때만 원본 digest로 폴백한다. */
async function isSameFile(a: RecentDocInput, existing: RecentDoc): Promise<boolean> {
  if (a.documentId && a.documentId === existing.documentId) return true;

  const ha = a.handle;
  const hb = existing.handle;
  if (ha && hb && typeof ha.isSameEntry === 'function') {
    try {
      return await ha.isSameEntry(hb);
    } catch {
      // 권한/브라우저 제약으로 비교 자체가 불가능하면 digest로 폴백한다.
    }
  }
  return a.sourceDigest === existing.sourceDigest;
}

/** 최신순(openedAt 내림차순)으로 정렬해 상한까지 자른다. */
function sortAndTrim(rows: RecentDoc[]): RecentDoc[] {
  return rows.sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_RECENT);
}

/**
 * 최근 문서를 추가하고 실제 저장한 레코드를 반환한다. 핸들이 있으면 라이브 재열기용으로 함께 저장하고, 없으면
 * 메타-only(파일명/형식/시각)로 기록한다 — 드롭/`input`/URL 등 핸들 없는 열기도
 * 목록에 남긴다. 동일 파일이 이미 있으면 레코드/논리 문서 ID를 재사용해 최신화하고,
 * 최대 {@link MAX_RECENT}개를 유지한다.
 * 핸들이 structured clone 불가(DataCloneError 등)한 환경이면 핸들을 떼고 메타-only
 * 로 재시도한다 — 기록 자체는 남긴다.
 */
export async function addRecentDoc(input: RecentDocInput): Promise<RecentDoc> {
  if (!input.sourceDigest) {
    throw new Error('sourceDigest is required for recent document identity');
  }

  return withDb(
    async (db) => {
      const rows = await getAllRows(db);
      const matches: RecentDoc[] = [];
      for (const row of [...rows].sort((a, b) => b.openedAt - a.openedAt)) {
        if (await isSameFile(input, row)) matches.push(row);
      }

      const previous = matches[0];
      const entry: RecentDoc = {
        id: previous?.id ?? createRecentId(),
        documentId: input.documentId ?? previous?.documentId ?? createDocumentId(),
        sourceDigest: input.sourceDigest,
        fileName: input.fileName,
        sourceFormat: input.sourceFormat,
        openedAt: Date.now(),
        ...(input.handle || previous?.handle ? { handle: input.handle ?? previous?.handle } : {}),
      };

      let stored = entry;
      try {
        await putRow(db, entry);
      } catch {
        // 핸들 직렬화 불가 환경 — 핸들을 떼고 메타-only 로 재시도(기록은 유지).
        const { handle: _drop, ...metaOnly } = entry;
        await putRow(db, metaOnly);
        stored = metaOnly;
      }
      for (const duplicate of matches.slice(1)) {
        if (duplicate.id !== stored.id) await deleteRow(db, duplicate.id);
      }
      const after = sortAndTrim(await getAllRows(db));
      const keep = new Set(after.map((r) => r.id));
      for (const row of await getAllRows(db)) {
        if (!keep.has(row.id)) await deleteRow(db, row.id);
      }
      return stored;
    },
    async () => {
      const rows = [...memory.values()].sort((a, b) => b.openedAt - a.openedAt);
      const matches: RecentDoc[] = [];
      for (const row of rows) {
        if (await isSameFile(input, row)) matches.push(row);
      }
      const previous = matches[0];
      const entry: RecentDoc = {
        id: previous?.id ?? createRecentId(),
        documentId: input.documentId ?? previous?.documentId ?? createDocumentId(),
        sourceDigest: input.sourceDigest,
        fileName: input.fileName,
        sourceFormat: input.sourceFormat,
        openedAt: Date.now(),
        ...(input.handle || previous?.handle ? { handle: input.handle ?? previous?.handle } : {}),
      };
      for (const [id, row] of memory) {
        if (id !== entry.id && await isSameFile(input, row)) memory.delete(id);
      }
      memory.set(entry.id, entry);
      const keep = new Set(sortAndTrim([...memory.values()]).map((r) => r.id));
      for (const id of [...memory.keys()]) {
        if (!keep.has(id)) memory.delete(id);
      }
      return entry;
    },
  );
}

/** 최근 문서 목록(최신순). */
export async function listRecentDocs(): Promise<RecentDoc[]> {
  return withDb(
    async (db) => sortAndTrim(await getAllRows(db)),
    async () => sortAndTrim([...memory.values()]),
  );
}

/** 특정 최근 문서를 제거한다. */
export async function removeRecentDoc(id: string): Promise<void> {
  memory.delete(id);
  await withDb(
    async (db) => deleteRow(db, id),
    async () => {},
  );
}

/** 최근 문서 목록 전체 삭제. */
export async function clearRecentDocs(): Promise<void> {
  memory.clear();
  await withDb(
    async (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
    async () => {},
  );
}
