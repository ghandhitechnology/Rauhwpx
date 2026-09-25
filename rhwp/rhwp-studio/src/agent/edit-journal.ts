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

/**
 * diff() 한 섹션의 결과 — get_structure(sinceRevision) 가 그대로 렌더한다.
 * changes 의 paraStart/paraEnd 는 현재 좌표계, wasRanges 와 indexShifts 의
 * 인덱스는 from-시점(expectedRevision) 좌표계다.
 */
export interface JournalDelta {
  sectionIdx: number;
  /**
   * 현재 좌표계의 변경 문단 구간 (포함, 정렬·인접 병합됨).
   * wasRanges = 이 구간에 흡수된 from-시점 문단 범위들 (포함) — 비어 있으면
   * 구간 전체가 from 이후에 새로 생긴 문단들이다. 저장된 인덱스가 이 범위에
   * 들어가면 시프트로 복원할 수 없다 — 새로 읽어야 한다.
   */
  changes: Array<{ paraStart: number; paraEnd: number; wasRanges: Array<[number, number]> }>;
  /**
   * from-시점 인덱스의 누적 이동 경계 — wasRanges 밖의 저장 인덱스 p 는
   * p + delta(마지막 at <= p 항목) 가 된다. delta 는 누적값이고 0 도 있다
   * (앞 구간의 이동을 되돌리는 리셋 경계).
   */
  indexShifts: Array<{ at: number; delta: number }>;
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
  /**
   * key: bump 직후의 revision 값, value: 그 bump 에 귀속된 편집들 (기록 순서).
   * apply_edits 처럼 한 bump 에 여러 편집이 묶이면 항목 순서대로 이어 붙인다.
   */
  private entries = new Map<number, EditJournalEntry[]>();

  /**
   * (revBefore, revAfter] 구간의 모든 bump 를 같은 편집에 귀속시킨다.
   * 한 스테이징 쓰기가 동반 이벤트로 두 번 bump 해도 전부 정밀 기록으로 남는다.
   */
  record(revBefore: number, revAfter: number, entry: EditJournalEntry): void {
    for (let rev = revBefore + 1; rev <= revAfter; rev++) {
      const list = this.entries.get(rev);
      if (list) list.push(entry);
      else this.entries.set(rev, [entry]);
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
    // 다중 bump 귀속 — 한 기록이 (revBefore, revAfter] 의 여러 rev 에 걸쳐
    // 실려 있으면 첫 등장만 반영한다 (객체 identity 로 판별).
    const seen = new Set<EditJournalEntry>();
    for (let rev = expectedRevision + 1; rev <= currentRevision; rev++) {
      const list = this.entries.get(rev);
      if (!list) return { ok: false, shift: 0, reason: 'gap' };
      for (const entry of list) {
        if (seen.has(entry)) continue;
        seen.add(entry);
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
    }
    return { ok: true, shift };
  }

  /**
   * (expected, current] 구간의 모든 bump 가 정밀 기록됐는지만 본다. 앵커 쓰기는
   * 좌표를 실행 시점 매치에서 얻으므로 리베이스 대신 이 검사만 거치면 된다 —
   * 사이에 낀 변경이 전부 이 실행기의 쓰기라면(=gap 없음) stale revision 도 안전하다.
   */
  covers(expectedRevision: number, currentRevision: number): boolean {
    for (let rev = expectedRevision + 1; rev <= currentRevision; rev++) {
      if (!this.entries.has(rev)) return false;
    }
    return true;
  }

  /**
   * (expectedRevision, currentRevision] 구간의 저널을 섹션별 델타로 조립한다 —
   * get_structure(sinceRevision) 의 재료. 커버리지 밖이면 null 을 돌려준다
   * (호출자가 FULL_REFRESH_REQUIRED 로 번역한다).
   *
   * paragraphCount(sectionIdx) 는 "현재" 본문 문단 수를 돌려주는 콜백 —
   * from-시점 문단 수는 여기에 엔트리 paraDelta 의 순합을 되돌려 얻는다.
   */
  diff(
    expectedRevision: number,
    currentRevision: number,
    paragraphCount: (sectionIdx: number) => number,
  ): Map<number, JournalDelta> | null {
    if (!this.covers(expectedRevision, currentRevision)) return null;
    const perSection = new Map<number, EditJournalEntry[]>();
    const seen = new Set<EditJournalEntry>();
    for (let rev = expectedRevision + 1; rev <= currentRevision; rev++) {
      const list = this.entries.get(rev)!;
      for (const entry of list) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        const arr = perSection.get(entry.sectionIdx);
        if (arr) arr.push(entry);
        else perSection.set(entry.sectionIdx, [entry]);
      }
    }
    const out = new Map<number, JournalDelta>();
    for (const sectionIdx of [...perSection.keys()].sort((a, b) => a - b)) {
      out.set(sectionIdx, this.diffSection(sectionIdx, perSection.get(sectionIdx)!, paragraphCount(sectionIdx)));
    }
    return out;
  }

  /**
   * 한 섹션의 엔트리 열(기록 순서)을 델타로 합성한다.
   *
   * 추적하는 상태는 두 가지다:
   * - segs: from-시점 인덱스 경계 {at, delta} 의 정렬 목록. from 문단 o 의
   *   현재(진행 시점) 좌표는 o + Σdelta(at<=o). 삭제된 문단의 "위치"는 계산상
   *   좌표일 뿐이지만, 생존 문단의 좌표는 정확하다 — 건드린 from 범위는
   *   wasRanges 로 따로 보고하므로 약간의 과잉 포함은 안전하다.
   * - regions: 현재 좌표계의 변경 구간 + 그 구간에 흡수된 from-시점 범위들.
   */
  private diffSection(sectionIdx: number, entries: EditJournalEntry[], currentCount: number): JournalDelta {
    const netDelta = entries.reduce((sum, e) => sum + e.paraDelta, 0);
    const oldCount = Math.max(0, currentCount - netDelta);
    const segs: Array<{ at: number; delta: number }> = [];
    interface Region { start: number; end: number; olds: Array<[number, number]> }
    const regions: Region[] = [];

    for (const e of entries) {
      const s = e.paraStart;
      const e2 = e.paraEnd;
      const d = e.paraDelta;
      // 엔트리 좌표는 적용 시점 좌표계다 — from 문단 o 의 적용 시점 위치를
      // 누적 경계로 환산해, 건드린 from 범위 [os..oe] 와 구간 뒤 첫 문단
      // (이동 경계 after) 를 한 번의 스캔으로 얻는다.
      let os = -1;
      let oe = -1;
      let after = -1;
      let cum = 0;
      let si = 0;
      for (let o = 0; o < oldCount; o++) {
        while (si < segs.length && segs[si].at <= o) { cum += segs[si].delta; si++; }
        const pos = o + cum;
        if (pos >= s && pos <= e2) {
          if (os < 0) os = o;
          oe = o;
        } else if (pos > e2 && after < 0) {
          after = o;
        }
      }
      if (d !== 0 && after >= 0) {
        const idx = segs.findIndex((g) => g.at >= after);
        if (idx >= 0 && segs[idx].at === after) segs[idx].delta += d;
        else segs.splice(idx < 0 ? segs.length : idx, 0, { at: after, delta: d });
      }
      // 변경 구간 갱신 — 이 엔트리와 겹치는 기존 구간은 새 구간에 흡수하고,
      // 구간 뒤의 구간은 시프트한다.
      const olds: Array<[number, number]> = os >= 0 ? [[os, oe]] : [];
      let lo = s;
      let hi = Math.max(s, e2 + d);
      for (let i = regions.length - 1; i >= 0; i--) {
        const r = regions[i];
        if (r.end < s) continue;
        if (r.start > e2) {
          r.start += d;
          r.end += d;
          continue;
        }
        // 겹침 (r.start <= e2 && r.end >= s) — 새 구간으로 흡수한다.
        lo = Math.min(lo, r.start);
        if (r.end > e2) hi = Math.max(hi, r.end + d);
        olds.push(...r.olds);
        regions.splice(i, 1);
      }
      regions.push({ start: lo, end: hi, olds });
      regions.sort((a, b) => a.start - b.start);
      for (let i = regions.length - 1; i > 0; i--) {
        const prev = regions[i - 1];
        const cur = regions[i];
        if (cur.start <= prev.end + 1) {
          prev.end = Math.max(prev.end, cur.end);
          prev.olds.push(...cur.olds);
          regions.splice(i, 1);
        }
      }
    }

    // from-시점 이동 경계 → 누적 시프트 (0 도 그대로 싣는다 — 리셋 경계다)
    let cumShift = 0;
    const indexShifts: JournalDelta['indexShifts'] = [];
    for (const seg of segs) {
      cumShift += seg.delta;
      indexShifts.push({ at: seg.at, delta: cumShift });
    }
    const changes = regions.map((r) => ({
      paraStart: r.start,
      paraEnd: r.end,
      wasRanges: mergeRanges(r.olds),
    }));
    return { sectionIdx, changes, indexShifts };
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 포함 범위 목록을 정렬·병합한다 (겹침과 인접 모두 합친다). */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}
