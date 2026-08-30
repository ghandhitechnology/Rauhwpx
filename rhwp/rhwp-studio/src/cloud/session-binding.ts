import type { PortableCloudTimelineV1 } from './timeline.ts';
import type { CloudSessionState } from './types.ts';
import type { CloudWorkspaceBinding } from './workspace.ts';

export function cloudBoundaryOperation(raw: unknown): {
  sessionId: string;
  operationId: string;
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const host = raw as Record<string, unknown>;
  if (typeof host.sessionId !== 'string' || !host.sessionId) return null;
  if (!host.event || typeof host.event !== 'object' || Array.isArray(host.event)) return null;
  const event = host.event as Record<string, unknown>;
  if (event.type !== 'boundary.committed'
    || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null;
  const operationId = (event.payload as Record<string, unknown>).operationId;
  return typeof operationId === 'string' && operationId
    ? { sessionId: host.sessionId, operationId }
    : null;
}

export function cloudTimelineBinding(
  session: CloudSessionState,
  timeline: PortableCloudTimelineV1 | null,
): CloudWorkspaceBinding | null {
  if (session.kind === 'idle' || !timeline || timeline.thread.id !== session.threadId) return null;
  return {
    sessionId: session.sessionId,
    threadId: session.threadId,
    documentId: session.documentId,
  };
}

export function cloudEventMatchesBinding(
  binding: CloudWorkspaceBinding | null,
  sessionId: string,
  threadId: string,
): binding is CloudWorkspaceBinding {
  return binding?.sessionId === sessionId && binding.threadId === threadId;
}

export function createSessionSelectionFence() {
  let generation = 0;
  return {
    begin() {
      const selectedGeneration = ++generation;
      return () => selectedGeneration === generation;
    },
    invalidate() {
      generation += 1;
    },
  };
}

export async function runCloudSessionSelection<T>({
  acquire,
  begin,
  select,
  refresh,
  mount,
  rollback,
}: {
  acquire(): { release(): void };
  begin(): () => boolean;
  select(): void;
  refresh(): Promise<T>;
  mount(value: T): boolean;
  rollback(): void | Promise<void>;
}): Promise<boolean> {
  const lock = acquire();
  const isCurrent = begin();
  select();
  let rolledBack = false;
  const rollbackCurrent = async () => {
    if (!rolledBack && isCurrent()) {
      rolledBack = true;
      await rollback();
    }
  };
  try {
    const value = await refresh();
    if (!isCurrent()) return false;
    const mounted = mount(value);
    if (!mounted) await rollbackCurrent();
    return mounted;
  } catch (error) {
    await rollbackCurrent();
    throw error;
  } finally {
    lock.release();
  }
}
