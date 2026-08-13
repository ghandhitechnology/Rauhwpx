/**
 * IndexedDB 연결/작업이 무응답일 때 호출부를 붙잡지 않기 위한 제한.
 * Electron+PWA SW 할당량 정리나 FileSystemFileHandle 직렬화가 멈추면
 * open/put 이 onsuccess 없이 남는 경우가 있다.
 */
export const IDB_OPEN_TIMEOUT_MS = 1_500;
export const IDB_OPERATION_TIMEOUT_MS = 2_500;

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface OpenIndexedDatabaseOptions {
  timeoutMs?: number;
  indexedDB?: IDBFactory;
}

/** 차단·무응답이면 null. 호출 쪽이 메모리 폴백을 쓴다. */
export function openIndexedDatabase(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase, event: IDBVersionChangeEvent) => void,
  options: OpenIndexedDatabaseOptions = {},
): Promise<IDBDatabase | null> {
  const factory = options.indexedDB
    ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  if (!factory) return Promise.resolve(null);
  const timeoutMs = options.timeoutMs ?? IDB_OPEN_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        try {
          db?.close();
        } catch {
          /* noop */
        }
        return;
      }
      settled = true;
      resolve(db);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const req = factory.open(name, version);
      req.onerror = () => {
        clearTimeout(timer);
        finish(null);
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        finish(req.result);
      };
      req.onblocked = () => {
        // 다른 연결이 닫히면 onsuccess가 올 수 있으므로 타임아웃까지 기다린다.
      };
      req.onupgradeneeded = (event) => {
        upgrade(req.result, event);
      };
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}
