/**
 * 편집 저널 — 병렬 서브에이전트의 stale expectedRevision 쓰기를 자동 리베이스한다.
 *
 * 원리: 실행기가 자신이 수행한 텍스트 쓰기의 (섹션, 문단 범위, 문단 수 변화)를
 * revision 단위로 기록한다. 뒤늦게 도착한 쓰기의 expectedRevision 이 뒤처져 있어도,
 * 그 사이의 모든 bump 가 저널에 정밀 기록돼 있고 대상 문단 범위와 겹치지 않으면
 * 좌표만 이동시켜 통과시킨다. 기록되지 않은 bump(사용자 편집, 비정밀 도구,
 * autosave 등)가 하나라도 끼면 리베이스를 포기한다 — 실패는 언제나 안전한 쪽
 * (REVISION_MISMATCH → 재조회)으로 떨어진다.
 *
 * 셀 내부 편집은 표 컨트롤이 놓인 본문 문단 하나를 건드린 것으로 취급한다.
 * 같은 표를 두 에이전트가 나눠 편집하는 경우는 의도적으로 충돌시킨다.
 */

export interface EditJournalEntry {
  sectionIdx: number;
  /** 이 편집이 건드린 본문 문단 범위 (포함). */
  paraStart: number;
  paraEnd: number;
  /** 이 편집으로 paraEnd 뒤 문단들의 인덱스가 움직인 양. */
  paraDelta: number;
}

export type RebaseFailure = 'gap' | 'overlap';

export interface RebaseResult {
  ok: boolean;
  /** ok=true 일 때 대상 문단 인덱스에 더할 이동량. */
  shift: number;
  /** ok=false 일 때의 사유 — 오류 메시지 문구 선택용. */
  reason?: RebaseFailure;
}

/** 저널 보존 한도 — 초과분은 오래된 revision 부터 버린다 (그 너머는 gap 처리). */
const MAX_ENTRIES = 512;

export class EditJournal {
  /** key: bump 직후의 revision 값. */
  private entries = new Map<number, EditJournalEntry>();

  /**
   * (revBefore, revAfter] 구간의 모든 bump 를 같은 편집에 귀속시킨다.
   * 한 스테이징 쓰기가 동반 이벤트로 두 번 bump 해도 전부 정밀 기록으로 남는다.
   */
  record(revBefore: number, revAfter: number, entry: EditJournalEntry): void {
    for (let rev = revBefore + 1; rev <= revAfter; rev++) {
      this.entries.set(rev, entry);
    }
    if (this.entries.size > MAX_ENTRIES) {
      const excess = this.entries.size - MAX_ENTRIES;
      const keys = [...this.entries.keys()].sort((a, b) => a - b);
      for (let i = 0; i < excess; i++) this.entries.delete(keys[i]);
    }
  }

  /**
   * expectedRevision 시점의 좌표 [paraStart, paraEnd] 를 currentRevision 좌표계로
   * 리베이스한다. 대상 범위는 각 저널 엔트리를 rev 순서로 통과하며 점진 이동한다
   * — 엔트리 좌표는 그 엔트리가 적용되던 시점의 좌표계이므로 이 순서가 맞다.
   */
  rebase(
    expectedRevision: number,
    currentRevision: number,
    sectionIdx: number,
    paraStart: number,
    paraEnd: number,
  ): RebaseResult {
    let a = paraStart;
    let b = paraEnd;
    let shift = 0;
    for (let rev = expectedRevision + 1; rev <= currentRevision; rev++) {
      const entry = this.entries.get(rev);
      if (!entry) return { ok: false, shift: 0, reason: 'gap' };
      if (entry.sectionIdx !== sectionIdx) continue;
      if (entry.paraStart <= b && entry.paraEnd >= a) {
        return { ok: false, shift: 0, reason: 'overlap' };
      }
      if (entry.paraEnd < a) {
        a += entry.paraDelta;
        b += entry.paraDelta;
        shift += entry.paraDelta;
      }
    }
    return { ok: true, shift };
  }

  clear(): void {
    this.entries.clear();
  }
}
