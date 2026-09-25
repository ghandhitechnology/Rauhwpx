import type { PendingChangeSet, PendingDropCause, PendingEditsChangeEvent } from '../../agent/types.ts';

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
        if (event.droppedOpIds) {
          // set 의 일부만 빠졌다 — 나머지는 승인/거절대로 처리됐다.
          if (event.changeSetId && turn.set.id !== event.changeSetId) continue;
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

const DROP_CAUSES: Record<PendingDropCause, string> = {
  'text-changed': '텍스트 변경',
  'field-changed': '필드 변경',
  'table-changed': '표 변경',
  'paragraph-changed': '문단 변경',
  'object-changed': '개체 변경',
  'revert-failed': '이후 수정',
};

/** 무효화 알림 문구 — 일부만 빠졌으면 실제 원인을, 통째로 해제됐으면 이유를 적는다. */
export function invalidatedMessage(e: Extract<PendingEditsChangeEvent, { type: 'invalidated' }>): string {
  if (!e.droppedOpIds) return `대기 중인 에이전트 편집이 해제되었습니다 (${e.reason})`;
  const causes = [...new Set((e.drops ?? []).map((drop) => DROP_CAUSES[drop.cause]))].join(', ') || e.reason;
  const count = e.droppedOpIds.length;
  return e.leftInDocument
    ? `에이전트 편집 ${count}개를 되돌리지 못해 문서에 남겼습니다 (${causes})`
    : `에이전트 편집 ${count}개가 실행 취소 항목에서 빠졌습니다 (${causes})`;
}
