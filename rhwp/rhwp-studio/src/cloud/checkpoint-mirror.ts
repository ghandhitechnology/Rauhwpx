import type { CloudCheckpointPayload } from './types.ts';

export function createCheckpointMirror({
  download,
  apply,
  retryBaseMs = 250,
  retryMaxMs = 10_000,
}: {
  download(sessionId: string, operationId?: string): Promise<CloudCheckpointPayload>;
  apply(checkpoint: CloudCheckpointPayload): void | Promise<void>;
  retryBaseMs?: number;
  retryMaxMs?: number;
}) {
  type PendingOperation = {
    sessionId: string;
    operationId: string;
    generation: number;
    attempts: number;
    running: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
  };

  const completed = new Map<string, Set<string>>();
  const revisions = new Map<string, number>();
  const pending = new Map<string, PendingOperation>();
  const chains = new Map<string, Promise<void>>();
  let generation = 0;
  let disposed = false;

  const keyFor = (sessionId: string, operationId: string) => JSON.stringify([sessionId, operationId]);
  const isCompleted = (sessionId: string, operationId: string) => (
    operationId !== 'reconnect' && completed.get(sessionId)?.has(operationId) === true
  );
  const complete = (operation: PendingOperation) => {
    if (operation.operationId !== 'reconnect') {
      const operations = completed.get(operation.sessionId) ?? new Set<string>();
      operations.add(operation.operationId);
      completed.set(operation.sessionId, operations);
    }
    const key = keyFor(operation.sessionId, operation.operationId);
    if (pending.get(key) === operation) pending.delete(key);
    operation.resolve();
  };
  const cancel = (operation: PendingOperation, reason: string) => {
    if (operation.timer) clearTimeout(operation.timer);
    operation.timer = null;
    operation.reject(new DOMException(reason, 'AbortError'));
  };

  const enqueue = (operation: PendingOperation): void => {
    if (operation.running || operation.generation !== generation || disposed) return;
    if (operation.timer) clearTimeout(operation.timer);
    operation.timer = null;
    operation.running = true;
    const previous = chains.get(operation.sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (operation.generation !== generation || disposed) return;
      if (isCompleted(operation.sessionId, operation.operationId)) {
        complete(operation);
        return;
      }
      const checkpoint = await download(
        operation.sessionId,
        operation.operationId === 'reconnect' ? undefined : operation.operationId,
      );
      if (operation.generation !== generation || disposed) return;
      if (checkpoint.revision > (revisions.get(operation.sessionId) ?? -1)) {
        await apply(checkpoint);
        if (operation.generation !== generation || disposed) return;
        revisions.set(operation.sessionId, checkpoint.revision);
      }
      complete(operation);
    });
    chains.set(operation.sessionId, next);
    void next.then(() => {
      operation.running = false;
      if (operation.generation !== generation || disposed) return;
      if (!pending.has(keyFor(operation.sessionId, operation.operationId))) return;
      operation.attempts += 1;
      const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(operation.attempts - 1, 8)));
      operation.timer = setTimeout(() => enqueue(operation), delay);
    }, () => {
      operation.running = false;
      if (operation.generation !== generation || disposed) return;
      operation.attempts += 1;
      const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(operation.attempts - 1, 8)));
      operation.timer = setTimeout(() => enqueue(operation), delay);
    }).finally(() => {
      if (chains.get(operation.sessionId) === next) chains.delete(operation.sessionId);
    });
  };

  const mirror = (sessionId: string, operationId: string): Promise<void> => {
    if (disposed) return Promise.reject(new DOMException('Checkpoint mirror was disposed', 'AbortError'));
    if (isCompleted(sessionId, operationId)) return Promise.resolve();
    const key = keyFor(sessionId, operationId);
    const existing = pending.get(key);
    if (existing) {
      if (existing.timer) enqueue(existing);
      return existing.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const operation: PendingOperation = {
      sessionId,
      operationId,
      generation,
      attempts: 0,
      running: false,
      timer: null,
      promise,
      resolve,
      reject,
    };
    pending.set(key, operation);
    enqueue(operation);
    return promise;
  };

  const reset = (reason: string) => {
    generation += 1;
    for (const operation of pending.values()) cancel(operation, reason);
    completed.clear();
    revisions.clear();
    pending.clear();
    chains.clear();
  };

  return {
    mirror,
    hasPending: (sessionId: string) => [...pending.values()].some((entry) => entry.sessionId === sessionId),
    hasRevision: (sessionId: string) => revisions.has(sessionId),
    reset() {
      reset('Checkpoint mirror was reset');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      reset('Checkpoint mirror was disposed');
    },
  };
}
