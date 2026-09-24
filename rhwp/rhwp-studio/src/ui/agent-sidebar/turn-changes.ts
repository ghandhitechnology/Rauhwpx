import type { PendingChangeSet, PendingEditsChangeEvent } from '../../agent/types.ts';

export interface CapturedTurn {
  set: PendingChangeSet;
  documentId: string | null;
  applied: boolean;
  undoEntry: object | null;
}

/** 승인 이벤트가 원본 set을 제거해도 해당 턴의 되돌리기 항목을 추적한다. */
export class TurnChanges {
  private readonly turns = new Map<string, CapturedTurn>();

  get(threadId: string, documentId: string | null): CapturedTurn | undefined {
    const turn = this.turns.get(threadId);
    return turn?.documentId === documentId ? turn : undefined;
  }

  capture(event: PendingEditsChangeEvent, sets: readonly PendingChangeSet[], threadId: string,
    documentId: string | null, undoEntry: object | null): void {
    if (event.type === 'set-finalized') {
      const set = sets.find((item) => item.id === event.changeSetId);
      if (set) this.turns.set(threadId, { set: structuredClone(set), documentId, applied: false, undoEntry: null });
      return;
    }
    for (const [owner, turn] of this.turns) {
      if (event.type === 'approved' && turn.set.id === event.changeSetId) {
        turn.applied = true;
        turn.undoEntry = undoEntry;
      } else if (event.type === 'rejected' && turn.set.id === event.changeSetId) {
        this.turns.delete(owner);
      } else if (event.type === 'invalidated') {
        if (event.reason.startsWith('text drift')) {
          if (event.changeSetId && turn.set.id !== event.changeSetId) continue;
          // 오래된 허브가 ID 없이 무효화하면 잘못된 적용 내역을 남기지 않는다.
          if (!event.droppedOpIds) { this.turns.delete(owner); continue; }
          const dropped = new Set(event.droppedOpIds);
          turn.set.ops = turn.set.ops.filter((op) => !dropped.has(op.id));
          if (!turn.set.ops.length) this.turns.delete(owner);
        } else if (!turn.applied) this.turns.delete(owner);
      }
    }
  }

  begin(threadId: string): void { this.turns.delete(threadId); }

  clear(): void { this.turns.clear(); }
}
