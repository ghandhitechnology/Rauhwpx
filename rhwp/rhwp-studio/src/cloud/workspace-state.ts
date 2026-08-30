import type { CloudSnapshot } from './types.ts';

export type WorkspaceBinding =
  | { kind: 'local' }
  | { kind: 'cloud'; sessionId: string; generation: number };

export interface WorkspaceSelectionReceipt {
  binding: Extract<WorkspaceBinding, { kind: 'cloud' }>;
}

export interface WorkspaceCommit {
  binding: Extract<WorkspaceBinding, { kind: 'cloud' }>;
  snapshot: CloudSnapshot;
}

interface PendingWorkspaceSelection {
  receipt: WorkspaceSelectionReceipt;
  latestSelected: CloudSnapshot | null;
}

export function snapshotForSelectedSession(
  latestGlobal: CloudSnapshot,
  latestSelected: CloudSnapshot,
  sessionId: string,
): CloudSnapshot | null {
  if (latestSelected.session.kind === 'idle' || latestSelected.session.sessionId !== sessionId) return null;
  const session = latestGlobal.sessions.find((item) => item.sessionId === sessionId);
  if (!session) return null;
  const timeline = latestSelected.timeline?.thread.id === session.threadId
    ? latestSelected.timeline
    : null;
  const takeover = latestSelected.takeover?.timeline.thread.id === session.threadId
    ? latestSelected.takeover
    : null;
  const { takeover: _unscopedTakeover, ...global } = latestGlobal;
  return {
    ...global,
    session,
    queuedMessages: latestSelected.queuedMessages,
    timeline,
    ...(takeover ? { takeover } : {}),
  };
}

export class CloudWorkspaceState {
  private generation = 0;
  private binding: WorkspaceBinding = { kind: 'local' };
  private pending: PendingWorkspaceSelection | null = null;

  getBinding(): WorkspaceBinding {
    return this.binding;
  }

  selectLocal(): WorkspaceBinding {
    this.generation += 1;
    this.pending = null;
    this.binding = { kind: 'local' };
    return this.binding;
  }

  beginCloud(sessionId: string): WorkspaceSelectionReceipt {
    this.generation += 1;
    const receipt = {
      binding: { kind: 'cloud', sessionId, generation: this.generation },
    } satisfies WorkspaceSelectionReceipt;
    this.pending = { receipt, latestSelected: null };
    return receipt;
  }

  observeSnapshot(next: CloudSnapshot): boolean {
    if (!this.pending) return false;
    if (next.session.kind !== 'idle'
      && next.session.sessionId === this.pending.receipt.binding.sessionId
      && (!this.pending.latestSelected || next.revision >= this.pending.latestSelected.revision)) {
      this.pending.latestSelected = next;
    }
    return true;
  }

  commit(receipt: WorkspaceSelectionReceipt, latestGlobal: CloudSnapshot): WorkspaceCommit | null {
    if (!this.matchesPending(receipt) || !this.pending?.latestSelected) return null;
    const snapshot = snapshotForSelectedSession(
      latestGlobal,
      this.pending.latestSelected,
      receipt.binding.sessionId,
    );
    if (!snapshot) return null;
    this.binding = receipt.binding;
    this.pending = null;
    return { binding: receipt.binding, snapshot };
  }

  cancel(receipt: WorkspaceSelectionReceipt): boolean {
    if (!this.matchesPending(receipt)) return false;
    this.pending = null;
    return true;
  }

  matchesPending(receipt: WorkspaceSelectionReceipt): boolean {
    return this.pending?.receipt.binding.sessionId === receipt.binding.sessionId
      && this.pending.receipt.binding.generation === receipt.binding.generation;
  }

  isTransitioning(): boolean {
    return this.pending !== null;
  }

  matches(binding: WorkspaceBinding): boolean {
    if (binding.kind === 'local') return this.binding.kind === 'local';
    return this.binding.kind === 'cloud'
      && this.binding.sessionId === binding.sessionId
      && this.binding.generation === binding.generation;
  }
}
