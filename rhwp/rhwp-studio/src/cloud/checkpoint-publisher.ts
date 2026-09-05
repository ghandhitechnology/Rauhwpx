import type { CloudCheckpointPayload } from './types.ts';

/** Explicit publications run once per request; a failed write never starts a retry loop. */
export function createCheckpointPublisher({
  publish,
  apply,
}: {
  publish(sessionId: string, operationId?: string): Promise<CloudCheckpointPayload>;
  apply(checkpoint: CloudCheckpointPayload): void | Promise<void>;
}) {
  const pending = new Map<string, Promise<void>>();
  const completed = new Set<string>();
  const chains = new Map<string, Promise<void>>();
  let generation = 0;
  let disposed = false;
  const keyFor = (sessionId: string, operationId?: string) => JSON.stringify([sessionId, operationId ?? null]);
  const assertCurrent = (expected: number) => {
    if (disposed || generation !== expected) throw new DOMException('Cloud publication was replaced', 'AbortError');
  };
  return {
    publish(sessionId: string, operationId?: string): Promise<void> {
      if (disposed) return Promise.reject(new DOMException('Cloud publisher was disposed', 'AbortError'));
      const key = keyFor(sessionId, operationId);
      if (operationId && completed.has(key)) return Promise.resolve();
      const existing = pending.get(key);
      if (existing) return existing;
      const expected = generation;
      const previous = chains.get(sessionId) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        assertCurrent(expected);
        if (operationId && completed.has(key)) return;
        const checkpoint = await publish(sessionId, operationId);
        assertCurrent(expected);
        await apply(checkpoint);
        assertCurrent(expected);
        completed.add(keyFor(sessionId, checkpoint.operationId));
      }).finally(() => {
        if (pending.get(key) === operation) pending.delete(key);
        if (chains.get(sessionId) === operation) chains.delete(sessionId);
      });
      pending.set(key, operation);
      chains.set(sessionId, operation);
      return operation;
    },
    reset() {
      generation += 1;
      pending.clear();
      completed.clear();
      chains.clear();
    },
    dispose() {
      disposed = true;
      this.reset();
    },
  };
}
