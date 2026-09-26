import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { DocumentPosition, CharProperties, CharShapeRun } from '../core/types.ts';
import { replacementCharShapes } from './replacement-format.ts';
import { PreparedSnapshotCommand } from '../engine/prepared-snapshot-command.ts';
import type {
  AgentName, CellAddr, CharFormatProps, DocPoint, DocRange, EngineBatchSpan,
  ObjectAnchor, ObjectOp, ParagraphCaptureRef, PendingAppliedAt, PendingChangeSet,
  PendingDrop, PendingDropCause, PendingEditsChangeEvent, PendingOp,
} from './types.ts';
import { AgentToolError, objectOverlayKind, sameCell } from './types.ts';
import type { OverlayOp, PendingOverlayRenderer } from './pending-overlay.ts';
import type { AgentTextInsertedEvent } from './agent-edit-follow.ts';

export interface PendingEditDeps {
  wasm: WasmBridge;
  eventBus: EventBus;
  inputHandler: InputHandler;
  canvasView: CanvasView;
  overlay: PendingOverlayRenderer;
}

/**
 * 엔진 배치 전후 한 구역의 문단 지문 목록을 비교해 바뀐 구간을 찾는다. 앞뒤로 같은
 * 문단을 걷어 내고 남은 가운데를 바뀐 구간으로 본다 — 적용 후 좌표 span, 그리고 그
 * 뒤 문단이 움직인 양(from 은 적용 전 좌표). 바뀐 문단이 없으면 둘 다 null.
 */
export function diffParagraphDigests(
  before: ReadonlyArray<string | null>, after: ReadonlyArray<string | null>,
): { span: { paraStart: number; paraEnd: number } | null; shift: { from: number; delta: number } | null } {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const beforeEnd = before.length - tail - 1;
  const afterEnd = after.length - tail - 1;
  if (beforeEnd < head && afterEnd < head) return { span: null, shift: null };
  const delta = after.length - before.length;
  // 문단만 지운 배치는 바뀐 구간이 비므로 지워진 자리의 문단 하나를 표시한다
  const last = Math.max(after.length - 1, 0);
  const span = afterEnd >= head
    ? { paraStart: head, paraEnd: afterEnd }
    : { paraStart: Math.min(head, last), paraEnd: Math.min(head, last) };
  return { span, shift: delta === 0 ? null : { from: beforeEnd + 1, delta } };
}

/** shiftPointAfterInsert 의 삽입 서술자 */
interface InsertShift {
  paraIdx: number; charOffset: number; addedParas: number;
  endParaIdx: number; endCharOffset: number; textLen: number;
}

/**
 * 삽입 이후 좌표 이동. 경계 규칙은 그 점이 범위의 어느 끝인지에 따라 다르다:
 *
 * - 끝(end) 경계 — strictly-after: 삽입 지점과 정확히 같은 끝은 움직이지 않는다
 *   (범위 끝에 덧붙인 텍스트가 기존 범위에 삼켜지지 않도록).
 * - 시작(start) 경계 — at-or-after (`isStartBoundary`): 삽입 지점과 정확히 같은
 *   시작은 삽입 길이만큼 밀린다. 그 자리에 삽입된 텍스트는 물리적으로 범위의
 *   기존 텍스트를 뒤로 밀므로, 시작이 제자리에 남으면 범위가 새 텍스트를 삼킨다
 *   (삭제/교체 범위의 시작점에 새 텍스트를 넣으면 되돌림이 새 텍스트까지 지우는 문제).
 */
export function shiftPointAfterInsert(
  p: DocPoint, ins: InsertShift, isStartBoundary = false,
): DocPoint {
  if (p.paraIdx < ins.paraIdx) return { paraIdx: p.paraIdx, charOffset: p.charOffset };
  if (p.paraIdx === ins.paraIdx) {
    const staysBefore = isStartBoundary
      ? p.charOffset < ins.charOffset
      : p.charOffset <= ins.charOffset;
    if (staysBefore) return { paraIdx: p.paraIdx, charOffset: p.charOffset };
    if (ins.addedParas === 0) return { paraIdx: p.paraIdx, charOffset: p.charOffset + ins.textLen };
    return { paraIdx: ins.endParaIdx, charOffset: ins.endCharOffset + (p.charOffset - ins.charOffset) };
  }
  return { paraIdx: p.paraIdx + ins.addedParas, charOffset: p.charOffset };
}

/**
 * 본문 문단 분할/병합 뒤 컨트롤 주소 재배치. 엔진은 분할 지점 뒤의 개체를 새 문단으로
 * 옮기고(인덱스 0부터 재번호), 병합 시 뒤 문단의 개체를 앞 문단 끝에 이어 붙인다.
 * 반환: 범위 밖 문단이면 undefined(문단 이동만 적용), 사라진 컨트롤이면 null.
 */
export type ControlRemap = (paraIdx: number, controlIdx: number) =>
  { paraIdx: number; controlIdx: number } | null | undefined;

/**
 * 변이 전후 문단별 컨트롤 수로 재배치 함수를 만든다. 텍스트 변이는 컨트롤 순서를
 * 바꾸지 않으므로, 전후 총수가 같으면 범위 전체를 평탄화한 순번이 그대로 보존된다.
 * 병합에서 가운데 문단이 통째로 지워지면 그 문단의 컨트롤만 사라진다.
 */
export function controlRemapFromCounts(
  firstPara: number, before: number[], after: number[],
): ControlRemap | undefined {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const lastBefore = firstPara + before.length - 1;
  const locate = (flat: number): { paraIdx: number; controlIdx: number } => {
    let rest = flat;
    for (let i = 0; i < after.length; i++) {
      if (rest < after[i] || i === after.length - 1) return { paraIdx: firstPara + i, controlIdx: rest };
      rest -= after[i];
    }
    return { paraIdx: firstPara, controlIdx: flat };
  };
  let removedMid = false;
  if (sum(before) !== sum(after)) {
    // 병합: 가운데 문단의 컨트롤만 사라지고 첫/끝 문단의 컨트롤은 이어 붙는다
    if (after.length !== 1 || before.length < 3
      || after[0] !== before[0] + before[before.length - 1]) return undefined;
    removedMid = true;
  }
  return (paraIdx, controlIdx) => {
    if (paraIdx < firstPara || paraIdx > lastBefore) return undefined;
    const rel = paraIdx - firstPara;
    if (removedMid && rel > 0 && rel < before.length - 1) return null;
    let flat = controlIdx;
    for (let i = 0; i < rel; i++) {
      if (removedMid && i > 0) continue;
      flat += before[i];
    }
    return locate(flat);
  };
}

/** 삭제 이후 좌표 이동 — 범위 내부는 삭제 시작점으로 clamp */
export function shiftPointAfterDelete(p: DocPoint, del: DocRange): DocPoint {
  if (p.paraIdx < del.startParaIdx
    || (p.paraIdx === del.startParaIdx && p.charOffset <= del.startCharOffset)) {
    return { paraIdx: p.paraIdx, charOffset: p.charOffset };
  }
  if (p.paraIdx === del.endParaIdx && p.charOffset >= del.endCharOffset) {
    return { paraIdx: del.startParaIdx, charOffset: del.startCharOffset + (p.charOffset - del.endCharOffset) };
  }
  if (p.paraIdx > del.endParaIdx) {
    return { paraIdx: p.paraIdx - (del.endParaIdx - del.startParaIdx), charOffset: p.charOffset };
  }
  return { paraIdx: del.startParaIdx, charOffset: del.startCharOffset };
}

const CHAR_FORMAT_KEYS = [
  'bold', 'italic', 'underline', 'strikethrough', 'fontSize', 'textColor', 'ratios', 'spacings',
] as const;

const DROP_CAUSE_LABELS: Record<PendingDropCause, string> = {
  'text-changed': 'text changed',
  'field-changed': 'field changed',
  'table-changed': 'table changed',
  'paragraph-changed': 'paragraph changed',
  'object-changed': 'object changed or missing',
  'revert-failed': 'edited after staging',
};

/**
 * 에이전트에게 알릴 한 줄 보고 — 편집이 사용자 몫으로 문서에 남았거나 통째로 버려졌을 때.
 * 승인에서 undo 항목만 빠진 경우와 승인 실패는 편집이 그대로 반영됐으므로 알리지 않는다.
 */
export function editReportNote(e: PendingEditsChangeEvent): string | null {
  if (e.type !== 'invalidated' || e.reason === 'approval failed') return null;
  const left = e.leftInDocument === true && e.drops && e.drops.length > 0
    ? `${e.drops.slice(0, 6).map((drop) => `${drop.summary} (${DROP_CAUSE_LABELS[drop.cause]})`).join('; ')}${e.drops.length > 6 ? '; …' : ''}`
    : '';
  if (e.droppedOpIds) {
    return left ? `Rejected staged edits were rolled back, but these stay in the document: ${left}.` : null;
  }
  return `Your staged edits were discarded (${e.reason})${left ? `; these could not be rolled back and stay in the document: ${left}` : ''}. Re-read the document before editing it again.`;
}

/** 드리프트 이벤트의 한 줄 이유 — 실제 원인별 개수를 적는다 ("text drift" 일괄 표기 대신). */
export function describeDrops(drops: readonly PendingDrop[], leftInDocument: boolean): string {
  const counts = new Map<PendingDropCause, number>();
  for (const drop of drops) counts.set(drop.cause, (counts.get(drop.cause) ?? 0) + 1);
  const causes = [...counts].map(([cause, n]) => `${DROP_CAUSE_LABELS[cause]}${n > 1 ? ` ×${n}` : ''}`).join(', ');
  const ops = `${drops.length} op${drops.length === 1 ? '' : 's'}`;
  return leftInDocument ? `${ops} left in the document: ${causes}` : `${ops} outside the undo step: ${causes}`;
}

/**
 * [Task #2337-review 와 동일 원칙] wasm 텍스트 API 의 charOffset/count 는 Rust char
 * (Unicode scalar) 단위다. JS String.length(UTF-16 code unit)를 쓰면 😀 같은 astral
 * 문자에서 오프셋이 어긋나 삽입/삭제/검증이 모두 깨진다 → 코드포인트 수로 계산한다.
 */
function comparePoints(a: DocPoint, b: DocPoint): number {
  return a.paraIdx - b.paraIdx || a.charOffset - b.charOffset;
}

/** 두 범위가 글자 하나 이상 겹치는가 (경계만 맞닿는 것은 제외). */
function rangesOverlap(a: DocRange, b: DocRange): boolean {
  const aStart = { paraIdx: a.startParaIdx, charOffset: a.startCharOffset };
  const aEnd = { paraIdx: a.endParaIdx, charOffset: a.endCharOffset };
  const bStart = { paraIdx: b.startParaIdx, charOffset: b.startCharOffset };
  const bEnd = { paraIdx: b.endParaIdx, charOffset: b.endCharOffset };
  return comparePoints(aStart, bEnd) < 0 && comparePoints(bStart, aEnd) < 0;
}

function scalarLen(s: string): number {
  return [...s].length;
}

/** 머리말/꼬리말 텍스트의 {n}/{total} 플레이스홀더를 엔진 필드 문자로 치환한다 */
function hfFieldMarkers(s: string): string {
  return s.replaceAll('{n}', '\u{0015}').replaceAll('{total}', '\u{0016}');
}

type TableTargetOp = Extract<ObjectOp, { tableParaIdx: number }>;

/** 기존 표를 (tableParaIdx, controlIdx) 로 가리키는 객체 op 인가 */
function isTableTargetOp(obj: ObjectOp): obj is TableTargetOp {
  return 'tableParaIdx' in obj;
}

/**
 * 에이전트 대기 편집(pending edit) 관리자.
 *
 * Pending 단계의 변이는 의도적으로 히스토리를 우회한다(WasmBridge 직접 호출) —
 * undo 항목은 approve() 시 미리보기 상태를 그대로 채택하는 snapshot 하나로 생성된다.
 *
 * Phase-1 규칙(untracked drift): pending 중 사용자 편집은 허용되지만 주소로 관측하지
 * 않는다 — pending 범위는 이 관리자 자신이 수행한 변이에 대해서만 이동한다. 사용자
 * 편집 후 오버레이가 어긋날 수 있으며, approve/reject 는 텍스트 검증으로 드리프트된
 * op 을 건너뛰어 문서 손상을 막는다.
 */
export class PendingEditManager {
  private sets: PendingChangeSet[] = [];
  private open: PendingChangeSet | null = null;
  private listeners = new Set<(e: PendingEditsChangeEvent) => void>();
  private unsubs: Array<() => void> = [];
  private counter = 0;
  /** op 등록 순번 — 같은/다른 set 을 가로지르는 적용 순서 판별용 */
  private opSeq = 0;
  private lastDigest: string | null;
  /**
   * 사용자(비-에이전트) 문서 변이 카운터. replace op 의 스냅샷은 문서 전체 클론이라
   * 복원하면 스냅샷 이후의 모든 변이를 지운다 — pending 중 사용자 편집은 주소로
   * 관측하지 않으므로(untracked drift), 이 카운터가 스냅샷 시점과 달라졌으면
   * 전체 복원 대신 범위-국소 역연산 폴백으로만 되돌린다.
   */
  private userEditSeq = 0;
  /** A settled set may change state captured by another set's document snapshot. */
  private settledSetSeq = 0;
  /** 매니저 자신의 변이(approve/reject/무효화) 중 카운터 증가 억제 — 재진입 가드 */
  private selfMutating = 0;
  /**
   * 벌크 구간 깊이. 0 보다 크면 항목마다의 권위 조판·문서 이벤트·오버레이 동기화를
   * 플래그로만 모아 두고, 구간이 닫힐 때 한 번씩만 수행한다 — replace_all 처럼
   * op 이 수십 개 쌓이는 경로에서 항목 수만큼 전체 재조판·전체 재렌더가 도는 것을 막는다.
   */
  private bulkDepth = 0;
  private bulkLayoutDirty = false;
  private bulkDocEventsReason: string | null = null;
  private bulkOverlayDirty = false;
  private bulkOpsChanged = false;
  private bulkTextInserted: Array<{ opId: string; event: AgentTextInsertedEvent }> = [];
  /**
   * runAtomicBatch 구간 표시. 배치의 외부 스냅샷이 롤백을 전담하므로, 구간 안의
   * replaceText 는 per-op 스냅샷(문서 전체 클론)을 만들지 않는다 — op 이 N 개인
   * 배치가 문서 클론을 N+1 번 하던 것을 1 번으로 줄인다.
   */
  private inAtomicBatch = false;
  private templateLocked = false;
  // 파라미터 프로퍼티 대신 명시적 할당 (node --test strip-only 모드 호환).
  private deps: PendingEditDeps;

  constructor(deps: PendingEditDeps) {
    this.deps = deps;
    this.lastDigest = deps.wasm.documentDigest;
    this.unsubs.push(deps.eventBus.on('document-mutated', (reason) => {
      // 매니저 자신의 변이는 'agent-*' 이유로 발행되지만, approve 가 부르는
      // InputHandler 경로는 'input-handler-edit' 로 재진입하므로 플래그로도 막는다.
      if (this.selfMutating > 0) return;
      if (typeof reason === 'string' && reason.startsWith('agent-')) return;
      this.userEditSeq++;
    }));
    this.unsubs.push(deps.eventBus.on('history-jumped', () => {
      // undo/redo 후에는 대기 편집을 유지할 수 없다. 다만 그냥 버리면(R3 위반)
      // 이미 적용된 에이전트 삽입/서식이 승인 절차 없이 문서에 영구히 남으므로,
      // 텍스트 검증을 통과한 op 만 best-effort 로 되돌린 뒤 전부 해제한다.
      if (this.sets.length > 0) this.revertAllAndDiscard('undo/redo');
    }));
    this.unsubs.push(deps.eventBus.on('document-dirty-changed', () => {
      const digest = this.deps.wasm.documentDigest;
      if (digest === this.lastDigest) return;
      // 문서 로드 자체는 dirty 전이를 만들지 않는다(로드 직후 항상 clean 이라
      // markClean 이 no-op). 따라서 매니저 생성 시점에는 문서가 없어(null)
      // 첫 에이전트 쓰기의 dirty false→true 전이에서 비로소 로드된 문서의
      // digest 를 관측한다 — 이 null → blake3:… 전이는 "교체"가 아니라 초기
      // 동기화이므로 폐기하면 첫 쓰기의 op 이 스스로 버려진다. pending op 은
      // 항상 현재 로드된 문서에 대해 기록되므로(쓰기 자체가 첫 dirty 전이를
      // 일으켜 그 시점 digest 를 채택한다), lastDigest === null 이면 아직
      // 고아 op 이 존재할 수 없다. 진짜 교체/언로드(blake3:A → blake3:B 또는
      // → null)는 기존처럼 전부 폐기한다.
      const hadDocument = this.lastDigest !== null;
      this.lastDigest = digest;
      if (hadDocument && this.sets.length > 0) this.discardAll('document loaded');
    }));
  }

  beginTurn(agent: AgentName): void {
    if (this.open) this.finalizeOpenSet();
    const set: PendingChangeSet = {
      id: this.nextId('cs'), agent, status: 'open', ops: [], createdAt: Date.now(),
    };
    this.sets.push(set);
    this.open = set;
    this.emitChange({ type: 'ops-changed' });
  }

  /**
   * 턴 종료 시 열린 set 을 닫는다. 성공하지 못한 종료(오류·중단·재연결)도
   * 편집을 되돌리지 않고 검토 대기로 남긴다 — 되돌림은 사용자의 reject() 뿐이다.
   */
  endTurn(outcome: 'review' | 'commit' = 'review', opts: { turnStopped?: boolean } = {}): void {
    if (!this.open) return;
    const set = this.open;
    if (opts.turnStopped) set.turnStopped = true;
    this.finalizeOpenSet();
    if (set.ops.length === 0) return;
    if (outcome === 'commit' && !this.approve(set.id)) this.reject(set.id);
  }

  insertText(
    agent: AgentName,
    addr: { sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr },
    text: string,
  ): { changeSetId: string; insertedRange: DocRange } {
    if (text.length === 0) throw new AgentToolError('INVALID_ARGS', 'text must not be empty');
    const splits = text.includes('\n');
    const fixControls = splits
      ? this.trackControls(addr.sectionIdx, addr.paraIdx, addr.paraIdx, addr.cell)
      : undefined;
    // 본문 문단을 나누는 삽입은 원래 문단을 보관한다 — 되돌림 병합은 문단을 다시 흘려
    // 개체가 있는 문단의 줄 배치가 원래와 달라질 수 있다.
    let paraCapture: ParagraphCaptureRef | null = null;
    if (splits && !addr.cell) {
      const digest = this.paragraphDigest(addr.sectionIdx, addr.paraIdx);
      const id = digest === null ? null : this.captureParagraph(addr.sectionIdx, addr.paraIdx);
      if (id !== null) paraCapture = { id, digest };
    }
    let inserted: { range: DocRange; addedParas: number };
    try {
      inserted = this.performInsert(addr.sectionIdx, addr.paraIdx, addr.charOffset, text, addr.cell);
    } catch (error) {
      if (paraCapture) this.deps.wasm.discardParagraphCapture(paraCapture.id);
      throw error;
    }
    const { range, addedParas } = inserted;
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = {
      kind: 'insert', id: this.nextId('op'), agent: set.agent, range, text, applied: this.appliedAt(range),
      ...(paraCapture ? { paraCapture } : {}),
    };
    this.pushOp(set, op);
    this.shiftAllAfterInsert(range.sectionIdx, {
      paraIdx: addr.paraIdx, charOffset: addr.charOffset, addedParas,
      endParaIdx: range.endParaIdx, endCharOffset: range.endCharOffset, textLen: scalarLen(text),
    }, op, addr.cell);
    fixControls?.(range.endParaIdx);
    this.reconcilePreviewLayout();
    this.emitDocEvents('agent-pending-edit');
    this.syncOverlay();
    // 편집 위치 따라가기용 — op.range 라이브 참조를 넘겨 이후 shift 가 반영되게 한다.
    this.emitTextInserted({ agent: op.agent, range: op.range, text }, op.id);
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id, insertedRange: { ...range } };
  }

  /**
   * 원자적 교체 — 삭제 마크 + 끝 삽입 두 op 대신, 삭제+삽입을 하나의 op 로 즉시
   * 적용한다 (live preview). 삽입은 범위 시작점에서 일어나고 시작 지점의 글자 모양을
   * 삽입 텍스트에 입힌다. 되돌림은 변이 직전 스냅샷으로 원본 텍스트+서식을 정확히
   * 복원한다 (approve 의 미리보기 채택 설계와 동일하게 메타데이터 재구성을 피한다).
   */
  replaceText(
    range: DocRange,
    text: string,
    agent: AgentName,
    opts: {
      /**
       * false 면 되돌림용 스냅샷을 리뷰 창 동안 점유하지 않는다 (에러 롤백에만 쓰고
       * 즉시 해제). 되돌림은 역연산 폴백(원본 텍스트+서식 재삽입)으로 수행된다.
       * replace_all 처럼 op 이 수십 개 쌓이는 벌크 경로용 — op 당 스냅샷을 점유하면
       * WASM 스냅샷 예산(100)이 undo 히스토리를 밀어낸다.
       */
      retainSnapshot?: boolean;
    } = {},
  ): { changeSetId: string; insertedRange: DocRange; deletedText: string } {
    const retainSnapshot = opts.retainSnapshot !== false;
    if (range.endParaIdx < range.startParaIdx
      || (range.endParaIdx === range.startParaIdx && range.endCharOffset <= range.startCharOffset)) {
      throw new AgentToolError('INVALID_ARGS', 'replace range is empty or reversed');
    }
    const wasm = this.deps.wasm;
    // 원본 텍스트/서식 캡처 (captureRangeText 가 범위 검증을 겸한다)
    const deletedText = this.captureRangeText(range);
    if (deletedText === text) {
      return { changeSetId: this.ensureOpenSet(agent).id, insertedRange: { ...range }, deletedText };
    }
    const charShapeRuns = this.captureCharShapeRuns(range);
    let charShapeId: number | null = null;
    try {
      const props = range.cell?.path
        ? wasm.getCellCharPropertiesAtByPath(
          range.sectionIdx, range.cell.paraIdx, this.cellPathAt(range.cell, range.startParaIdx),
          range.startCharOffset,
        )
        : range.cell
        ? wasm.getCellCharPropertiesAt(
          range.sectionIdx, range.cell.paraIdx, range.cell.controlIdx, range.cell.cellIdx,
          range.startParaIdx, range.startCharOffset,
        )
        : wasm.getCharPropertiesAt(range.sectionIdx, range.startParaIdx, range.startCharOffset);
      if (typeof props.charShapeId === 'number') charShapeId = props.charShapeId;
    } catch { /* 서식 캡처는 best-effort */ }
    // 폴백 되돌림용 원본 문단별 paraShapeId (captureRangeText 와 같은 1줄=1문단 대응)
    const paraShapeIds: number[] = [];
    for (let p = range.startParaIdx; p <= range.endParaIdx; p++) {
      try {
        const props = range.cell?.path
          ? wasm.getCellParaPropertiesAtByPath(range.sectionIdx, range.cell.paraIdx, this.cellPathAt(range.cell, p))
          : range.cell
          ? wasm.getCellParaPropertiesAt(range.sectionIdx, range.cell.paraIdx, range.cell.controlIdx, range.cell.cellIdx, p)
          : wasm.getParaPropertiesAt(range.sectionIdx, p);
        paraShapeIds.push(typeof props.paraShapeId === 'number' ? props.paraShapeId : -1);
      } catch {
        paraShapeIds.push(-1);
      }
    }

    // 변이 직전 스냅샷 — 되돌림 시 원본(텍스트+서식)을 정확히 복원하는 소스.
    // 리뷰 창 내내 점유되므로 히스토리 예산에 자리를 만들고(prepare) 점유를
    // 등록한다(retain) — 등록하지 않으면 WASM 저장소가 우리가 아직 참조하는
    // 오래된 undo 스냅샷을 무통보 축출한다.
    // retainSnapshot=false(replace_all 벌크)이면서 runAtomicBatch 안이면 배치의
    // 외부 스냅샷이 에러 롤백을 전담하므로 클론 자체를 생략한다. retainSnapshot 이
    // true 면 배치 안에서도 클론을 유지한다 — reject/실패 턴 복원과 approve 의
    // undo 기준(before)이 역연산 폴백으로 서식을 잃지 않게 하기 위해서다.
    let snapshotId: number | null = null;
    if (retainSnapshot || !this.inAtomicBatch) {
      this.deps.inputHandler.prepareSnapshotCapacity?.(1);
      snapshotId = wasm.saveSnapshot();
      this.deps.inputHandler.retainExternalSnapshot?.();
    }
    let deleteShifted = false;
    try {
      const fixDeleted = range.endParaIdx > range.startParaIdx
        ? this.trackControls(range.sectionIdx, range.startParaIdx, range.endParaIdx, range.cell)
        : undefined;
      const res = this.deleteRangeRaw(range);
      if (res?.ok !== true) throw new AgentToolError('RPC_ERROR', 'replaceText: deleteRange failed');
      this.shiftAllAfterDelete(range);
      fixDeleted?.(range.startParaIdx);
      deleteShifted = true;
      const start: DocPoint = { paraIdx: range.startParaIdx, charOffset: range.startCharOffset };
      const fixInserted = text.includes('\n')
        ? this.trackControls(range.sectionIdx, start.paraIdx, start.paraIdx, range.cell)
        : undefined;
      const ins = text.length > 0
        ? this.performInsert(range.sectionIdx, start.paraIdx, start.charOffset, text, range.cell)
        : {
          range: {
            sectionIdx: range.sectionIdx, cell: range.cell,
            startParaIdx: start.paraIdx, startCharOffset: start.charOffset,
            endParaIdx: start.paraIdx, endCharOffset: start.charOffset,
          } as DocRange,
          addedParas: 0,
        };
      // 캡처한 글자 모양을 삽입 텍스트 전체에 적용 (범위 끝 서식 상속 방지)
      if (charShapeRuns && text.length > 0) {
        this.applyCharShapeRuns(ins.range, text, replacementCharShapes(deletedText, text, charShapeRuns));
      } else if (charShapeId !== null && text.length > 0) this.applyCharShapeToRange(ins.range, charShapeId);
      const set = this.ensureOpenSet(agent);
      if (!retainSnapshot && snapshotId !== null) {
        // 벌크 경로: 에러 롤백용 스냅샷은 성공 즉시 반환한다 — 되돌림은 역연산 폴백.
        wasm.discardSnapshot(snapshotId);
        this.deps.inputHandler.releaseExternalSnapshot?.();
      }
      const op: PendingOp = {
        kind: 'replace', id: this.nextId('op'), agent: set.agent,
        range: ins.range, text, deletedText, charShapeId, charShapeRuns, paraShapeIds,
        snapshotId: retainSnapshot ? snapshotId : null,
        userEditSeqAtSnapshot: this.userEditSeq,
        settledSetSeqAtSnapshot: this.settledSetSeq,
        applied: this.appliedAt(ins.range),
      };
      this.pushOp(set, op);
      if (text.length > 0) {
        this.shiftAllAfterInsert(range.sectionIdx, this.insertShiftFor(start, text), op, range.cell);
        fixInserted?.(ins.range.endParaIdx);
      }
      this.reconcilePreviewLayout();
      this.emitDocEvents('agent-pending-edit');
      this.syncOverlay();
      if (text.length > 0) {
        this.emitTextInserted({
          agent: op.agent, range: op.range, text, oldText: deletedText,
        }, op.id);
      }
      this.emitChange({ type: 'ops-changed' });
      return { changeSetId: set.id, insertedRange: { ...ins.range }, deletedText };
    } catch (err) {
      // 부분 적용 롤백 — 스냅샷으로 변이 전 상태를 그대로 복원한다.
      // (runAtomicBatch 안에서는 스냅샷이 없다 — 배치의 catch 가 문서와 pending
      // 상태를 통째로 되돌리므로 여기서는 그대로 던지기만 한다.)
      if (snapshotId !== null) {
        try { wasm.restoreSnapshot(snapshotId); } catch { /* best effort */ }
        wasm.discardSnapshot(snapshotId);
        this.deps.inputHandler.releaseExternalSnapshot?.();
        // 삭제 shift 는 이미 다른 op 들에 반영됐을 수 있다 — 원본이 다시 나타났으므로
        // 재삽입과 동치인 shift 로 되돌린다.
        if (deleteShifted) {
          this.shiftAllAfterInsert(
            range.sectionIdx,
            this.insertShiftFor({ paraIdx: range.startParaIdx, charOffset: range.startCharOffset }, deletedText),
            undefined, range.cell,
          );
        }
      }
      throw err;
    }
  }

  applyCharFormat(agent: AgentName, range: DocRange, format: CharFormatProps): { changeSetId: string } {
    const keys = CHAR_FORMAT_KEYS.filter((k) => format[k] !== undefined);
    if (keys.length === 0 && format.fontId === undefined) {
      throw new AgentToolError('INVALID_ARGS', 'at least one format property is required');
    }
    // 역서식은 시작 지점 단일 샘플 근사 — 혼합 서식 범위에서는 부정확할 수 있다 (Phase-1 한계).
    const cell = range.cell;
    const props: CharProperties = cell?.path
      ? this.deps.wasm.getCellCharPropertiesAtByPath(
        range.sectionIdx, cell.paraIdx, this.cellPathAt(cell, range.startParaIdx), range.startCharOffset,
      )
      : cell
      ? this.deps.wasm.getCellCharPropertiesAt(
        range.sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx,
        range.startParaIdx, range.startCharOffset,
      )
      : this.deps.wasm.getCharPropertiesAt(
        range.sectionIdx, range.startParaIdx, range.startCharOffset,
      );
    const inverse: CharFormatProps = {};
    for (const k of keys) {
      const prev = props[k];
      if (prev !== undefined) (inverse as Record<string, unknown>)[k] = prev;
      else if (typeof format[k] === 'boolean') (inverse as Record<string, unknown>)[k] = false;
    }
    // fontId 역서식: read 측은 이름(fontFamily)만 반환하므로 이름→id 재해석으로 캡처한다
    if (format.fontId !== undefined) {
      const prevFamily = (props as { fontFamily?: string }).fontFamily;
      if (typeof prevFamily === 'string' && prevFamily.length > 0) {
        try {
          const prevId = this.deps.wasm.findOrCreateFontId(prevFamily);
          if (prevId >= 0) inverse.fontId = prevId;
        } catch { /* 역서식은 best-effort */ }
      }
    }
    const raw = this.applyFormatRaw(range, format);
    this.parseOkLenient(raw, 'applyCharFormat');
    // 되돌림 전 드리프트 프로브용 범위 텍스트 (best-effort — 캡처 실패 시 프로브 생략)
    let rangeText: string | undefined;
    try {
      rangeText = this.captureRangeText(range);
    } catch { /* 프로브 없이 동작 (기존 동작과 동일) */ }
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = {
      kind: 'format', id: this.nextId('op'), agent: set.agent, range: { ...range }, format: { ...format }, inverse,
      text: rangeText,
      ...(rangeText !== undefined ? { applied: this.appliedAt(range) } : {}),
    };
    this.pushOp(set, op);
    this.reconcilePreviewLayout();
    this.emitDocEvents('agent-pending-edit');
    this.syncOverlay();
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id };
  }

  setFieldValue(agent: AgentName, name: string, value: string):
      { changeSetId: string; fieldId: number; oldValue: string; newValue: string } {
    const parsed = this.deps.wasm.setFieldValueByName(name, value);
    if (parsed?.ok !== true) {
      throw new AgentToolError('FIELD_NOT_FOUND',
        `field '${name}' not found or not settable — call get_fields first to list available field names`);
    }
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = {
      kind: 'field', id: this.nextId('op'), agent: set.agent, name,
      oldValue: parsed.oldValue, newValue: parsed.newValue,
    };
    this.pushOp(set, op);
    this.reconcilePreviewLayout();
    this.emitDocEvents('agent-pending-edit');
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id, fieldId: parsed.fieldId, oldValue: parsed.oldValue, newValue: parsed.newValue };
  }

  /**
   * 객체 연산 등록 — 모든 유형이 호출 시점에 엔진에 적용된다 (미리보기 = 승인 결과).
   * 적용 전에 되돌림 수단을 잡는다: 한 본문 문단 안에서 끝나는 변경은 그 문단의
   * 보관본, 그림/수식은 문서 스냅샷(보관을 지원하지 않는 WASM 이면 보관 대상도 스냅샷).
   * 엔진 실패는 이 호출에서 던지고 문서는 적용 전으로 돌아간다.
   */
  addObjectOp(agent: AgentName, obj: ObjectOp): { changeSetId: string; obj: ObjectOp } {
    const wasm = this.deps.wasm;
    this.resolveCaptureHost(obj);
    const host = this.captureHost(obj);
    let paraCapture: ParagraphCaptureRef | null = null;
    if (host !== null) {
      const id = this.captureParagraph(obj.sectionIdx, host);
      if (id !== null) paraCapture = { id, digest: null };
    }
    let snapshotId: number | null = null;
    // Deleting an inserted object cannot recover the host's saved line metrics.
    // Keep its original layout for reject and the approved change's undo entry.
    // 문단 보관을 못 잡은 보관 대상(구버전 WASM, HF 위치 조회 실패)도 스냅샷으로 되돌린다.
    // 앞뒤 순서는 다른 문단의 이웃 개체와 순번을 맞바꿀 수 있어 한 문단 보관으로는 부족하다.
    if (obj.type === 'insertImage' || obj.type === 'insertEquation'
      || (obj.type === 'editObject' && obj.zOrder !== undefined)
      || (paraCapture === null && this.revertsByParagraph(obj))) {
      this.deps.inputHandler.prepareSnapshotCapacity?.(1);
      snapshotId = wasm.saveSnapshot();
      this.deps.inputHandler.retainExternalSnapshot?.();
    }
    const dimsBefore = this.tableDims(obj);
    // 지워지는 행/열/표는 적용 후엔 읽을 수 없다 — 앵커 팝오버와 diff 에 쓸
    // 내용과 위치를 먼저 보관한다 (표시용, best-effort).
    if (obj.type === 'deleteTable'
      || (obj.type === 'tableStructure' && (obj.op === 'delete_row' || obj.op === 'delete_col'))) {
      try {
        obj.removedText = this.removedTargetText(obj);
        if (obj.type === 'deleteTable') {
          const positions = typeof wasm.getControlTextPositions === 'function'
            ? wasm.getControlTextPositions(obj.sectionIdx, obj.tableParaIdx)
            : undefined;
          obj.removedOffset = positions?.[obj.controlIdx] ?? 0;
        }
      } catch { /* 보관 실패 시 앵커만 놓는다 */ }
    }
    if (obj.type === 'deleteObject' && !obj.cell && typeof wasm.getControlTextPositions === 'function') {
      try {
        obj.removedOffset = wasm.getControlTextPositions(obj.sectionIdx, obj.paraIdx)[obj.controlIdx] ?? 0;
      } catch { /* 문단 앞에 앵커를 놓는다 */ }
    }
    try {
      this.applyObjectOp(obj);
    } catch (error) {
      try {
        if (snapshotId !== null) wasm.restoreSnapshot(snapshotId);
        else if (paraCapture && host !== null) wasm.restoreCapturedParagraph(paraCapture.id, obj.sectionIdx, host);
      } catch { /* best effort */ } finally {
        if (snapshotId !== null) {
          wasm.discardSnapshot(snapshotId);
          this.deps.inputHandler.releaseExternalSnapshot?.();
        }
        if (paraCapture) wasm.discardParagraphCapture(paraCapture.id);
      }
      this.reconcilePreviewLayout();
      throw error;
    }
    if (paraCapture) {
      const after = this.captureHost(obj);
      paraCapture.digest = after === null ? null : this.paragraphDigest(obj.sectionIdx, after);
    }
    this.adjustSiblingDims(obj, dimsBefore, this.tableDims(obj));
    if (obj.type === 'insertEquation') {
      try {
        const preview = JSON.parse(wasm.renderEquationPreview(obj.script, obj.fontSizeHu, obj.colorRef));
        if (typeof preview.svg === 'string') obj.previewSvg = preview.svg;
      } catch { /* The document preview remains available if a thumbnail cannot render. */ }
    }
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = { kind: 'object', id: this.nextId('op'), agent: set.agent, obj,
      snapshotId, paraCapture, userEditSeqAtSnapshot: this.userEditSeq,
      settledSetSeqAtSnapshot: this.settledSetSeq };
    this.pushOp(set, op);
    this.reconcilePreviewLayout();
    this.emitDocEvents('agent-pending-edit');
    this.syncOverlay();
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id, obj };
  }

  /** 템플릿 구조 전송을 전체 문서 스냅샷 기반 pending 연산으로 등록한다. */
  addTemplateMutation(
    agent: AgentName,
    label: string,
    templateRevision: number,
    operation: () => { warnings?: string[]; skippedFeatures?: string[]; affectedSections?: number[] } | void,
  ): { changeSetId: string; report: { warnings: string[]; skippedFeatures: string[]; affectedSections: number[] } } {
    if (this.sets.some((set) => set.ops.some((op) => op.kind !== 'template'))) {
      throw new AgentToolError(
        'TEMPLATE_PENDING_CONFLICT',
        'Review the existing document edits before applying a structural template transfer.',
      );
    }
    const wasm = this.deps.wasm;
    this.deps.inputHandler.prepareSnapshotCapacity?.(1);
    const snapshotId = wasm.saveSnapshot();
    this.deps.inputHandler.retainExternalSnapshot?.();
    let rawReport: { warnings?: string[]; skippedFeatures?: string[]; affectedSections?: number[] } | void;
    try {
      rawReport = operation();
    } catch (error) {
      try { wasm.restoreSnapshot(snapshotId); } catch { /* best effort */ }
      wasm.discardSnapshot(snapshotId);
      this.deps.inputHandler.releaseExternalSnapshot?.();
      throw error;
    }
    const report = {
      warnings: rawReport?.warnings?.filter((value): value is string => typeof value === 'string') ?? [],
      skippedFeatures: rawReport?.skippedFeatures?.filter((value): value is string => typeof value === 'string') ?? [],
      affectedSections: rawReport?.affectedSections?.filter((value): value is number => Number.isSafeInteger(value) && value >= 0) ?? [],
    };
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = {
      kind: 'template', id: this.nextId('op'), agent: set.agent, label,
      templateRevision, snapshotId, userEditSeqAtSnapshot: this.userEditSeq, report,
    };
    this.pushOp(set, op);
    this.reconcilePreviewLayout();
    this.emitDocEvents('agent-pending-template');
    this.syncTemplateLock();
    this.syncOverlay();
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id, report };
  }

  /**
   * apply_engine_edits 배치를 하나의 스냅샷 기반 객체 op 으로 등록한다. 배치 직전에 문서
   * 스냅샷을 잡고 run 으로 엔진 메서드를 바로 적용한다 (미리보기 = 승인 결과). 실패하면
   * 문서를 배치 전으로 되돌리고 던진다. 되돌림(reject)은 이 스냅샷 복원뿐이라, 그 뒤에
   * 사용자 편집이나 다른 set 의 확정이 있으면 되돌리지 않고 문서에 남겨 보고한다.
   * 배치 전후 문단 지문을 비교해 바뀐 구간을 표시하고, 그 뒤 문단을 가리키는 다른
   * pending op 좌표를 민다.
   */
  addEngineBatch<T>(agent: AgentName, methods: string[], run: () => T): { changeSetId: string; result: T; touched: EngineBatchSpan[] } {
    const wasm = this.deps.wasm;
    const digestsBefore = this.bodyDigests();
    this.deps.inputHandler.prepareSnapshotCapacity?.(1);
    const snapshotId = wasm.saveSnapshot();
    this.deps.inputHandler.retainExternalSnapshot?.();
    let result: T;
    try {
      result = run();
      if (wasm.getSectionCount() === 0) throw new AgentToolError('ENGINE_EDIT_FAILED', 'The batch removed every document section');
    } catch (error) {
      try { wasm.restoreSnapshot(snapshotId); } catch { /* best effort */ }
      wasm.discardSnapshot(snapshotId);
      this.deps.inputHandler.releaseExternalSnapshot?.();
      this.reconcilePreviewLayout();
      throw error;
    }
    const digestsAfter = this.bodyDigests();
    const touched: EngineBatchSpan[] = [];
    const shifts: Array<{ sectionIdx: number; from: number; delta: number }> = [];
    if (digestsBefore && digestsAfter) {
      for (let sectionIdx = 0; sectionIdx < digestsAfter.length; sectionIdx++) {
        const diff = diffParagraphDigests(digestsBefore[sectionIdx] ?? [], digestsAfter[sectionIdx]);
        if (diff.span) touched.push({ sectionIdx, ...diff.span });
        if (diff.shift) shifts.push({ sectionIdx, ...diff.shift });
      }
    }
    const obj: ObjectOp = {
      type: 'engineBatch', sectionIdx: touched[0]?.sectionIdx ?? 0, methods, touched, shifts,
    };
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = { kind: 'object', id: this.nextId('op'), agent: set.agent, obj,
      snapshotId, paraCapture: null, userEditSeqAtSnapshot: this.userEditSeq,
      settledSetSeqAtSnapshot: this.settledSetSeq };
    for (const shift of shifts) this.shiftAllParagraphs(shift.sectionIdx, shift.from, shift.delta, op);
    this.pushOp(set, op);
    this.reconcilePreviewLayout();
    this.emitDocEvents('agent-pending-edit');
    this.syncOverlay();
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id, result, touched: structuredClone(touched) };
  }

  /** 구역별 본문 문단 지문 — 지문을 지원하지 않는 WASM 이면 null */
  private bodyDigests(): Array<Array<string | null>> | null {
    const wasm = this.deps.wasm;
    if (typeof wasm.getParagraphContentDigest !== 'function') return null;
    const sections: Array<Array<string | null>> = [];
    for (let sectionIdx = 0; sectionIdx < wasm.getSectionCount(); sectionIdx++) {
      const digests: Array<string | null> = [];
      const count = wasm.getParagraphCount(sectionIdx);
      for (let paraIdx = 0; paraIdx < count; paraIdx++) digests.push(this.paragraphDigest(sectionIdx, paraIdx));
      sections.push(digests);
    }
    return sections;
  }

  /**
   * 원자적 벌크 교체 — 모든 항목이 성공해야 등록된다. 중간 실패 시 문서(스냅샷)와
   * pending 상태(op 좌표·추가 op·새 set)를 배치 이전으로 통째로 되돌리고 던진다 —
   * 부분 적용된 찾아-바꾸기 배치가 리뷰에 남는 것을 막는다 (replace_all 전용).
   * 항목은 호출자가 문서 좌표 역순으로 정렬해 넘긴다.
   */
  replaceTextBatch(
    items: Array<{ range: DocRange; text: string }>,
    agent: AgentName,
  ): { changeSetId: string } {
    if (items.length === 0) throw new AgentToolError('INVALID_ARGS', 'batch is empty');
    return this.runAtomicBatch(() => {
      let changeSetId = '';
      for (const item of items) {
        changeSetId = this.replaceText(item.range, item.text, agent, { retainSnapshot: false }).changeSetId;
      }
      return { changeSetId };
    });
  }

  /**
   * 원자적 스테이징 배치 — fn 안에서 등록되는 모든 pending 연산이 전부 성공해야
   * 남는다. 중간 실패 시 문서(스냅샷)와 pending 상태(op 좌표·추가 op·새 set)를
   * 배치 이전으로 통째로 되돌리고 다시 던진다. 구간 동안 조판·문서 이벤트·
   * 오버레이 동기화는 bulk 로 모여 종료 시 각 한 번씩만 수행된다. replace 계열의
   * per-op 보존 스냅샷은 유지된다(reject/undo 복원 충실도) — retainSnapshot:false
   * 를 명시한 replace_all 벌크만 클론을 생략하고 역연산 폴백으로 되돌린다.
   * apply_edits / replace_all / apply_list 같은 다중 op 툴 경로 전용.
   */
  runAtomicBatch<T>(fn: () => T): T {
    const wasm = this.deps.wasm;
    const pendingState = this.capturePendingState();
    const setIdsBefore = new Set(this.sets.map((s) => s.id));
    const openBefore = this.open;
    this.deps.inputHandler.prepareSnapshotCapacity?.(1);
    const snapId = wasm.saveSnapshot();
    this.deps.inputHandler.retainExternalSnapshot?.();
    const wasAtomic = this.inAtomicBatch;
    const textInsertedBefore = this.bulkTextInserted.length;
    this.inAtomicBatch = true;
    this.beginBulk();
    try {
      return fn();
    } catch (err) {
      this.bulkTextInserted.length = textInsertedBefore;
      try { wasm.restoreSnapshot(snapId); } catch { /* best effort */ }
      // 배치 중 추가된 op 이 보존 스냅샷을 점유했을 수 있다 — 롤백으로 op 이
      // 사라지기 전에 해제한다 (예산 누수 방지).
      const opIdsBefore = new Set(pendingState.flatMap((s) => s.ops.map((op) => op.id)));
      for (const set of this.sets) {
        this.discardOpSnapshots(set.ops.filter((op) => !opIdsBefore.has(op.id)));
      }
      // 배치가 만든 set 은 통째로 제거하고, 기존 set 들의 op 은 배치 이전 좌표로 복원한다.
      this.sets = this.sets.filter((s) => setIdsBefore.has(s.id));
      this.open = openBefore && setIdsBefore.has(openBefore.id) ? openBefore : null;
      this.restorePendingState(pendingState);
      this.emitDocEvents('agent-pending-edit');
      this.syncOverlay();
      this.emitChange({ type: 'ops-changed' });
      throw err;
    } finally {
      wasm.discardSnapshot(snapId);
      this.deps.inputHandler.releaseExternalSnapshot?.();
      this.inAtomicBatch = wasAtomic;
      this.endBulk();
    }
  }

  /** 벌크 구간 진입 — 이후의 조판/이벤트/오버레이 요청은 endBulk 까지 모인다. */
  private beginBulk(): void {
    this.bulkDepth++;
  }

  /** 벌크 구간 종료 — 모인 요청을 각 한 번씩, 항목별 호출과 같은 순서로 수행한다. */
  private endBulk(): void {
    if (--this.bulkDepth > 0) return;
    const layoutDirty = this.bulkLayoutDirty;
    const docEventsReason = this.bulkDocEventsReason;
    const overlayDirty = this.bulkOverlayDirty;
    const opsChanged = this.bulkOpsChanged;
    const textInserted = this.bulkTextInserted;
    this.bulkTextInserted = [];
    this.bulkLayoutDirty = false;
    this.bulkDocEventsReason = null;
    this.bulkOverlayDirty = false;
    this.bulkOpsChanged = false;
    if (layoutDirty) this.reconcilePreviewLayout();
    if (docEventsReason !== null) this.emitDocEvents(docEventsReason);
    if (overlayDirty) this.syncOverlay();
    if (textInserted.length > 0) {
      // 중첩 배치 롤백은 op을 클론으로 복원하므로 현재 op의 라이브 range를 찾는다.
      const opsById = new Map(this.sets.flatMap((set) => set.ops.map((op) => [op.id, op] as const)));
      for (const { opId, event } of textInserted) {
        const op = opsById.get(opId);
        if (op?.kind === 'insert' || op?.kind === 'replace') {
          this.emitTextInserted({ ...event, range: op.range }, opId);
        }
      }
    }
    if (opsChanged) this.emitChange({ type: 'ops-changed' });
  }

  /**
   * 검증 루프용 change-set 요약. changeSetId 생략 시 가장 최근 set 을 대상으로 한다.
   * summary 는 종류 + 짧은 텍스트 다이제스트(~80자) + 좌표 정보다.
   */
  describeChangeSet(changeSetId?: string): {
    changeSetId: string | null;
    status: string;
    agent: string;
    ops: Array<{ id: string; kind: string; summary: string }>;
  } {
    const set = changeSetId !== undefined
      ? this.sets.find((s) => s.id === changeSetId)
      : this.sets[this.sets.length - 1];
    if (!set) return { changeSetId: null, status: 'none', agent: '', ops: [] };
    return {
      changeSetId: set.id,
      status: set.status,
      agent: set.agent,
      ops: set.ops.map((op) => ({
        id: op.id,
        kind: op.kind === 'object' ? `object:${op.obj.type}`
          : op.kind === 'replace' && op.text.length === 0 ? 'delete'
          : op.kind,
        summary: this.summarizeOp(op),
      })),
    };
  }

  getChangeSets(): ReadonlyArray<PendingChangeSet> {
    return this.sets;
  }

  hasPending(): boolean {
    return this.sets.some((s) => s.ops.length > 0);
  }

  hasTemplateMutation(): boolean {
    return this.sets.some((set) => set.ops.some((op) => op.kind === 'template'));
  }

  /**
   * approve — 모든 op 은 이미 적용돼 있으므로 문서는 그대로 두고, 되돌린 before 상태를
   * 잠시 캡처해 단일 undo 항목으로 채택한다 ("이미 적용된 것을 유지").
   */
  approve(changeSetId: string): boolean {
    const set = this.sets.find((s) => s.id === changeSetId);
    if (!set) return false;
    // 되돌림이 시작되기 전에 사용자 편집 카운터를 한 번만 샘플링한다 —
    // revertAppliedOps 자체가 문서를 바꾸므로 중간에 읽으면 판정이 오염된다.
    const userEditSeqNow = this.userEditSeq;
    this.selfMutating++;
    try {
      return this.approveInner(set, changeSetId, userEditSeqNow);
    } finally {
      this.selfMutating--;
    }
  }

  private approveInner(set: PendingChangeSet, changeSetId: string, userEditSeqNow: number): boolean {
    if (set === this.open) this.open = null;
    // 승인 직전에도 현재 IR에서 권위 조판을 다시 만든다. 미리보기 캐시가 어긋난
    // 상태를 after snapshot으로 굳히거나, 승인 뒤에만 우연히 고쳐지는 일을 막는다.
    this.reconcilePreviewLayout();
    const { kept, dropped, causes, deferred } = this.partitionDriftedOps(set);

    if (kept.length === 0 && dropped.length === 0) {
      this.removeSet(set);
      this.syncOverlay();
      this.settledSetSeq++;
      this.emitChange({ type: 'approved', changeSetId });
      return true;
    }

    // kept 가 남았으면 kept 만 되돌려 before 를 캡처한다 (드리프트 미리보기는
    // 사용자 소유로 before 에 남긴다). 전부 드리프트됐으면 되돌릴 것이 없다 —
    // 드리프트 미리보기는 이미 사용자가 손댄 내용이라, 이를 지워 before 를 만들면
    // undo 가 사용자 글자까지 잘라낸다. 현재 상태를 before 로 잡아 undo 를 무해한
    // no-op 으로 만들고 히스토리 항목만 남긴다(미리보기 방치 방지).
    const keepPreviewsOf = kept.length > 0 ? dropped : [];

    const wasm = this.deps.wasm;
    const cursor = this.deps.inputHandler.getCursorPosition();
    const previewState = this.capturePendingState();
    let previewId: number | null = null;
    let beforeId: number | null = null;
    let failed = new Map<string, PendingDropCause>();
    // 히스토리 밖에서 점유 중인 id 수 (preview/before) — 예산 정합용
    let heldExternal = 0;
    const retainExternal = (): void => {
      heldExternal++;
      this.deps.inputHandler.retainExternalSnapshot?.();
    };
    const releaseExternal = (n = 1): void => {
      const count = Math.min(n, heldExternal);
      heldExternal -= count;
      for (let i = 0; i < count; i++) this.deps.inputHandler.releaseExternalSnapshot?.();
    };
    let command: PreparedSnapshotCommand | null = null;

    try {
      // preview + before + after 세 id가 잠시 공존한다. 오래된 history snapshot을
      // 선제 정리해 WASM 저장소의 무통보 축출을 막는다.
      this.deps.inputHandler.prepareSnapshotCapacity?.(3);
      // before 캡처를 위해 잠시 되돌리되, 즉시 원본 스냅샷을 복원한다. 텍스트를
      // 삭제 후 재삽입하지 않으므로 줄/문단/혼합 글자 서식이 미리보기와 동일하다.
      previewId = wasm.saveSnapshot();
      retainExternal();
      if (kept.length > 0) {
        failed = this.revertAppliedOps(kept, keepPreviewsOf, userEditSeqNow, deferred);
        beforeId = wasm.saveSnapshot();
        retainExternal();
        wasm.restoreSnapshot(previewId);
        this.restorePendingState(previewState);
      } else {
        // 전부 드리프트: 미리보기는 사용자 소유이므로 되돌리지 않는다.
        beforeId = wasm.saveSnapshot();
        retainExternal();
      }

      // 미리보기가 곧 승인 결과다 — 채택만 하고 문서에 더 적용할 것은 없다.
      command = new PreparedSnapshotCommand('agentApplyChangeSet', cursor, cursor, beforeId, () => cursor);
      beforeId = null; // command가 소유권을 인수했다.
      command.execute(wasm);
      this.settledSetSeq++;
      wasm.discardSnapshot(previewId);
      previewId = null;
      this.deps.inputHandler.executeOperation({
        kind: 'record',
        command,
        // 승인은 이미 보이는 미리보기를 채택하는 것 — 사용자가 보고 있는
        // 지점(에이전트 편집 위치)에서 caret 위치로 카메라를 되돌리지 않는다.
        meta: { origin: 'agent', refresh: 'full', scroll: 'preserve' },
      });
      // 히스토리가 command(before/after)를 세므로 외부 점유를 전부 반환한다.
      releaseExternal(heldExternal);
    } catch (err) {
      if (previewId !== null) {
        try { wasm.restoreSnapshot(previewId); } catch { /* best effort */ }
        wasm.discardSnapshot(previewId);
      }
      if (beforeId !== null) wasm.discardSnapshot(beforeId);
      command?.discard(wasm);
      releaseExternal(heldExternal);
      this.restorePendingState(previewState);
      this.discardOpSnapshots(dropped);
      set.status = 'awaiting-review';
      this.emitDocEvents('agent-pending-edit');
      this.syncOverlay();
      console.warn('[pending-edits] approve snapshot capture failed', err);
      this.emitChange({ type: 'invalidated', reason: 'approval failed' });
      return false;
    }

    const all = [...kept, ...dropped];
    this.discardOpSnapshots(all);
    this.removeSet(set);
    this.syncOverlay();
    // 승인은 모든 편집을 문서에 남긴다 — 빠진 op 은 이번 undo 항목에서만 제외된다.
    this.emitDrops(changeSetId, set, dropped, causes, failed, false);
    this.emitChange({ type: 'approved', changeSetId });
    return true;
  }

  /** reject — 적용된 op 을 되돌린다. 되돌리지 못한 op 은 문서에 남기고 보고한다. 히스토리 항목 없음. */
  reject(changeSetId: string): void {
    const set = this.sets.find((s) => s.id === changeSetId);
    if (!set) return;
    if (set === this.open) this.open = null;
    // approve 와 같은 이유로 되돌림 시작 전에 한 번만 샘플링한다.
    const userEditSeqNow = this.userEditSeq;
    this.selfMutating++;
    try {
      const { kept, dropped, causes, deferred } = this.partitionDriftedOps(set);
      const all = [...set.ops];
      set.ops = kept;
      const failed = this.revertAppliedOps(kept, dropped, userEditSeqNow, deferred);
      this.settledSetSeq++;
      this.reconcilePreviewLayout();
      this.emitDocEvents('agent-reject');
      this.discardOpSnapshots([...kept, ...dropped]);
      this.removeSet(set);
      this.syncOverlay();
      this.emitDrops(changeSetId, { ...set, ops: all }, dropped, causes, failed, true);
      this.emitChange({ type: 'rejected', changeSetId });
    } finally {
      this.selfMutating--;
    }
  }

  /**
   * 드리프트/되돌림 실패를 원인과 함께 알린다. leftInDocument=true 는 거절·무효화로
   * 되돌리지 못해 문서에 남았다는 뜻이고, false(승인)는 undo 항목에서만 빠졌다는 뜻이다.
   */
  private emitDrops(
    changeSetId: string, set: PendingChangeSet, dropped: PendingOp[],
    causes: Map<PendingOp, PendingDropCause>, failed: Map<string, PendingDropCause>, leftInDocument: boolean,
  ): void {
    const drops: PendingDrop[] = [];
    for (const op of set.ops) {
      const cause = causes.get(op) ?? failed.get(op.id);
      if (!cause) continue;
      if (!dropped.includes(op) && !failed.has(op.id)) continue;
      drops.push({ opId: op.id, cause, summary: this.summarizeOp(op) });
    }
    if (drops.length === 0) return;
    this.emitChange({
      type: 'invalidated',
      reason: describeDrops(drops, leftInDocument),
      changeSetId,
      droppedOpIds: drops.map((d) => d.opId),
      drops,
      leftInDocument,
    });
  }

  onChange(cb: (e: PendingEditsChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  dispose(): void {
    for (const un of this.unsubs) un();
    this.unsubs = [];
    this.listeners.clear();
    for (const set of this.sets) this.discardOpSnapshots(set.ops);
    this.sets = [];
    this.open = null;
    this.syncTemplateLock();
  }

  // ─── 내부 ────────────────────────────────────────────

  private nextId(prefix: string): string {
    return `${prefix}-${Date.now()}-${++this.counter}`;
  }

  private ensureOpenSet(agent: AgentName): PendingChangeSet {
    if (this.open) {
      // 허브 세션은 한 번에 하나뿐이다 — 턴이 열려 있으면 그 턴이 귀속의 기준이다.
      // 라벨이 어긋난다고 열린 턴을 닫고 다른 이름으로 새 set 을 열면, 리뷰 카드가
      // 실제로 돌고 있는 에이전트와 다른 이름을 내건다.
      if (this.open.agent !== agent) {
        console.warn(`[pending-edits] tool call labeled '${agent}' during '${this.open.agent}' turn — 열린 턴 기준으로 기록`);
      }
      return this.open;
    }
    // turn-start 를 놓친 write 도 수용: 해당 에이전트의 set 을 자동으로 연다.
    this.beginTurn(agent);
    return this.open!;
  }

  private finalizeOpenSet(): void {
    const set = this.open;
    this.open = null;
    if (!set) return;
    if (set.ops.length === 0) {
      this.sets = this.sets.filter((s) => s !== set);
      this.emitChange({ type: 'ops-changed' });
      return;
    }
    set.status = 'awaiting-review';
    this.syncOverlay();
    this.emitChange({ type: 'set-finalized', changeSetId: set.id });
  }

  private removeSet(set: PendingChangeSet): void {
    this.sets = this.sets.filter((s) => s !== set);
    if (this.open === set) this.open = null;
    this.syncTemplateLock();
  }

  private capturePendingState(): Array<{ id: string; ops: PendingOp[] }> {
    return this.sets.map((set) => ({ id: set.id, ops: structuredClone(set.ops) }));
  }

  private restorePendingState(state: Array<{ id: string; ops: PendingOp[] }>): void {
    for (const saved of state) {
      const set = this.sets.find((candidate) => candidate.id === saved.id);
      if (set) set.ops = saved.ops;
    }
  }

  private discardAll(reason: string): void {
    for (const set of this.sets) this.discardOpSnapshots(set.ops);
    this.sets = [];
    this.open = null;
    this.syncTemplateLock();
    this.deps.overlay.clear();
    this.emitChange({ type: 'invalidated', reason });
  }

  /**
   * undo/redo 무효화: 각 set 에 대해 드리프트 검증(verifyOpText)을 먼저 수행하고,
   * 아직 저장된 텍스트가 그 자리에 남아 있는 op 만 되돌린다. 스냅샷 undo 가 이미
   * 에이전트 삽입을 지운 경우 검증이 실패하므로 문서를 건드리지 않는다(손상 방지).
   * 히스토리 항목은 만들지 않는다 — undo 스택과 무관한 정리 동작이다.
   */
  private revertAllAndDiscard(reason: string): void {
    let reverted = false;
    const drops: PendingDrop[] = [];
    for (let i = this.sets.length - 1; i >= 0; i--) {
      const set = this.sets[i];
      const { kept, dropped, causes, deferred } = this.partitionDriftedOps(set);
      set.ops = kept;
      if (set.ops.length > 0) reverted = true;
      const failed = this.revertAppliedOps(kept, dropped, this.userEditSeq, deferred);
      for (const op of [...kept, ...dropped]) {
        const cause = causes.get(op) ?? failed.get(op.id);
        if (cause) drops.push({ opId: op.id, cause, summary: this.summarizeOp(op) });
      }
      this.discardOpSnapshots([...kept, ...dropped]);
    }
    if (reverted) this.reconcilePreviewLayout();
    this.sets = [];
    this.open = null;
    this.syncTemplateLock();
    this.deps.overlay.clear();
    if (reverted) this.emitDocEvents('agent-invalidate');
    this.emitChange({
      type: 'invalidated', reason,
      ...(drops.length > 0 ? { drops, leftInDocument: true } : {}),
    });
  }

  /** op 에 전역 등록 순번을 부여하고 set 에 추가한다 */
  private pushOp(set: PendingChangeSet, op: PendingOp): void {
    op.seq = ++this.opSeq;
    set.ops.push(op);
  }

  /** set 제거/폐기 시점에 pending op 들이 잡고 있는 wasm 스냅샷과 문단 보관본을 해제한다 */
  private discardOpSnapshots(ops: PendingOp[]): void {
    for (const op of ops) {
      if ((op.kind === 'object' || op.kind === 'insert') && op.paraCapture) {
        try { this.deps.wasm.discardParagraphCapture(op.paraCapture.id); } catch { /* best effort */ }
        op.paraCapture = null;
      }
      if ((op.kind !== 'replace' && op.kind !== 'template' && op.kind !== 'object') || op.snapshotId == null) continue;
      try { this.deps.wasm.discardSnapshot(op.snapshotId); } catch { /* best effort */ }
      op.snapshotId = null;
      this.deps.inputHandler.releaseExternalSnapshot?.();
    }
  }

  private syncTemplateLock(): void {
    const locked = this.hasTemplateMutation();
    if (locked === this.templateLocked) return;
    this.templateLocked = locked;
    this.deps.eventBus.emit('agent-template-lock-changed', locked);
  }

  private emitChange(e: PendingEditsChangeEvent): void {
    if (this.bulkDepth > 0 && e.type === 'ops-changed') {
      this.bulkOpsChanged = true;
      return;
    }
    for (const cb of this.listeners) {
      try { cb(e); } catch (err) { console.warn('[pending-edits] onChange listener failed', err); }
    }
  }

  private emitTextInserted(event: AgentTextInsertedEvent, opId: string): void {
    if (this.bulkDepth > 0) {
      this.bulkTextInserted.push({ opId, event });
      return;
    }
    this.deps.eventBus.emit('agent-text-inserted', event);
  }

  private emitDocEvents(reason: string): void {
    if (this.bulkDepth > 0) {
      this.bulkDocEventsReason = reason;
      return;
    }
    this.deps.eventBus.emit('document-mutated', reason);
    this.deps.eventBus.emit('document-changed');
  }

  /** 한 논리 에이전트 연산이 끝난 IR에서 증분 조판 상태를 권위 조판으로 교체한다. */
  private reconcilePreviewLayout(): void {
    if (this.bulkDepth > 0) {
      this.bulkLayoutDirty = true;
      return;
    }
    // 테스트 더블/이전 WASM 번들과도 호환되도록 호출 자체는 feature-detect 한다.
    // 현재 번들의 WasmBridge.refreshLayout은 실패를 로깅하고 안전하게 반환한다.
    this.deps.wasm.refreshLayout?.();
  }

  private syncOverlay(): void {
    if (this.bulkDepth > 0) {
      this.bulkOverlayDirty = true;
      return;
    }
    const ops: OverlayOp[] = [];
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind === 'field' || op.kind === 'template') continue;
        if (op.kind === 'object' && op.obj.type === 'engineBatch') {
          // 바뀐 문단 구간마다 수정 표시 — 문단 밖만 바꾼 배치는 대표 구역의 쪽 전체
          const refs: import('./pending-overlay.ts').ObjectOverlayRef[] = op.obj.touched.length > 0
            ? op.obj.touched.map((span) => ({
              sort: 'para' as const, sectionIdx: span.sectionIdx, paraIdx: span.paraStart, endParaIdx: span.paraEnd,
            }))
            : [{ sort: 'page', sectionIdx: op.obj.sectionIdx }];
          for (const objRef of refs) ops.push({ kind: 'modify', agent: op.agent, objRef });
          continue;
        }
        if (op.kind === 'object') {
          const ref = this.objectOverlayRef(op.obj);
          if (ref) {
            ops.push({
              kind: objectOverlayKind(op.obj),
              agent: op.agent,
              objRef: ref,
              removedText: 'removedText' in op.obj ? op.obj.removedText : undefined,
            });
          }
          continue;
        }
        if (op.kind === 'replace') {
          ops.push({
            kind: 'replace',
            id: op.id,
            agent: op.agent,
            range: op.range,
            oldText: op.deletedText,
            newText: op.text,
          });
        } else {
          ops.push({ kind: op.kind, agent: op.agent, range: op.range });
        }
      }
    }
    this.deps.overlay.setOps(ops);
  }

  /** 객체 op → overlay 좌표 해석 참조 (bookmark 처럼 시각 위치가 애매한 것은 null) */
  private objectOverlayRef(obj: ObjectOp): import('./pending-overlay.ts').ObjectOverlayRef | null {
    switch (obj.type) {
      case 'createTable':
        return obj.anchor
          ? { sort: 'table', sectionIdx: obj.sectionIdx, paraIdx: obj.anchor.paraIdx, controlIdx: obj.anchor.controlIdx }
          : null;
      case 'insertImage':
      case 'insertEquation': {
        const kind = obj.type === 'insertImage' ? 'image' : 'equation';
        if (obj.cell) {
          return obj.anchor ? {
            sort: 'agentObject', kind, sectionIdx: obj.sectionIdx,
            paraIdx: obj.cell.paraIdx, controlIdx: obj.cell.controlIdx,
            cellIdx: obj.cell.cellIdx, cellParaIdx: obj.paraIdx,
            innerControlIdx: obj.anchor.controlIdx,
            cellPath: obj.cell.path ? this.cellPathEntriesAt(obj.cell, obj.paraIdx) : undefined,
          } : null;
        }
        return obj.anchor
          ? { sort: 'agentObject', kind, sectionIdx: obj.sectionIdx, paraIdx: obj.anchor.paraIdx, controlIdx: obj.anchor.controlIdx }
          : null;
      }
      case 'deleteTable':
        // 표는 이미 없다 — 삭제 전에 보관한 문단 오프셋에 빨간 앵커를 놓는다.
        return {
          sort: 'removed', what: 'table', sectionIdx: obj.sectionIdx,
          paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx, offset: obj.removedOffset,
        };
      case 'deleteObject':
        return {
          sort: 'removed', what: 'object', sectionIdx: obj.sectionIdx,
          paraIdx: obj.cell ? obj.cell.paraIdx : obj.paraIdx,
          controlIdx: obj.cell ? obj.cell.controlIdx : obj.controlIdx, offset: obj.removedOffset,
        };
      case 'editObject': {
        const kind = obj.kind === 'picture' ? 'image' : 'shape';
        if (obj.cell) {
          return {
            sort: 'object', kind, sectionIdx: obj.sectionIdx,
            paraIdx: obj.cell.paraIdx, controlIdx: obj.cell.controlIdx,
            cellIdx: obj.cell.cellIdx, cellParaIdx: obj.paraIdx, innerControlIdx: obj.controlIdx,
            cellPath: obj.cell.path ? this.cellPathEntriesAt(obj.cell, obj.paraIdx) : undefined,
          };
        }
        return { sort: 'object', kind, sectionIdx: obj.sectionIdx, paraIdx: obj.paraIdx, controlIdx: obj.controlIdx };
      }
      case 'insertShape':
        return obj.anchor
          ? { sort: 'object', kind: 'shape', sectionIdx: obj.sectionIdx, paraIdx: obj.anchor.paraIdx, controlIdx: obj.anchor.controlIdx }
          : null;
      case 'setTableProps':
      case 'setColumnWidths':
      case 'fitToPage':
      case 'setCaption':
        return { sort: 'table', sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx };
      case 'setZoneProps':
        return {
          sort: 'cells', sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx,
          rect: obj.range,
        };
      case 'applyFormula':
        return obj.cellIdx !== undefined
          ? { sort: 'cells', sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx, cellIdx: obj.cellIdx }
          : {
            sort: 'cells', sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx,
            rect: { startRow: obj.row, startCol: obj.col, endRow: obj.row, endCol: obj.col },
          };
      case 'tableStructure': {
        // 적용 후 표 기준 — 지워진 행/열 자리는 앵커, 삽입된 행/열은 새 셀,
        // 병합/나눔은 결과 셀을 표시한다
        const base = { sort: 'cells' as const, sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx };
        if (obj.op === 'delete_row' || obj.op === 'delete_col') {
          return {
            sort: 'removed', what: obj.op === 'delete_row' ? 'row' : 'col',
            sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx,
            rowIdx: obj.rowIdx, colIdx: obj.colIdx,
          };
        }
        if (obj.op === 'insert_row') return { ...base, rowIdx: obj.insertedIndex ?? obj.index };
        if (obj.op === 'insert_col') return { ...base, colIdx: obj.insertedIndex ?? obj.index };
        if (obj.op === 'merge_cells') {
          return { ...base, rect: { startRow: obj.startRow!, startCol: obj.startCol!, endRow: obj.startRow!, endCol: obj.startCol! } };
        }
        return { ...base, rect: { startRow: obj.rowIdx!, startCol: obj.colIdx!, endRow: obj.rowIdx!, endCol: obj.colIdx! } };
      }
      case 'setCellProps':
        return { sort: 'cells', sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx, cellIdx: obj.cellIdx };
      case 'paraFormat':
      case 'applyStyle':
        return { sort: 'para', sectionIdx: obj.sectionIdx, paraIdx: obj.paraIdx, cell: obj.cell };
      case 'insertNote':
        // 마커가 놓인 본문 문단을 틴트 (각주 영역 자체 bbox API 는 없다)
        return obj.anchor
          ? { sort: 'para', sectionIdx: obj.sectionIdx, paraIdx: obj.anchor.paraIdx }
          : null;
      case 'setNoteText':
        return { sort: 'para', sectionIdx: obj.sectionIdx, paraIdx: obj.paraIdx };
      case 'headerFooter':
        return { sort: 'hf', sectionIdx: obj.sectionIdx, isHeader: obj.isHeader, applyTo: obj.applyTo };
      case 'pageLayout':
        return { sort: 'page', sectionIdx: obj.sectionIdx };
      default:
        return null;
    }
  }

  /** describeChangeSet 용 한 줄 요약: 종류 + 텍스트 다이제스트(~80자) + 좌표 */
  private summarizeOp(op: PendingOp): string {
    const digest = (s: string): string => {
      const oneLine = s.replace(/\n/g, '⏎');
      return [...oneLine].length > 80 ? [...oneLine].slice(0, 77).join('') + '…' : oneLine;
    };
    const coord = (r: DocRange): string => {
      const cell = r.cell ? ` cell(${r.cell.paraIdx}/${r.cell.controlIdx}/${r.cell.cellIdx})` : '';
      return `s${r.sectionIdx}${cell} p${r.startParaIdx}:${r.startCharOffset}-p${r.endParaIdx}:${r.endCharOffset}`;
    };
    switch (op.kind) {
      case 'insert':
        return `insert "${digest(op.text)}" @${coord(op.range)}`;
      case 'replace':
        // 빈 새 텍스트 = 즉시 적용된 삭제 (delete_range 경로)
        if (op.text.length === 0) return `delete "${digest(op.deletedText)}" @${coord(op.range)}`;
        return `replace "${digest(op.deletedText)}" → "${digest(op.text)}" @${coord(op.range)}`;
      case 'format':
        return `format ${JSON.stringify(op.format)} @${coord(op.range)}`;
      case 'field':
        return `field ${op.name}: "${digest(op.oldValue)}" → "${digest(op.newValue)}"`;
      case 'template':
        return `${op.label} (template revision ${op.templateRevision})`;
      case 'object': {
        const o = op.obj;
        const para = this.objectBodyParaIdx(o);
        const at = para === null ? `s${o.sectionIdx}` : `s${o.sectionIdx} p${para}`;
        const detail = o.type === 'tableStructure' ? `(${o.op})`
          : o.type === 'headerFooter' ? `(${o.isHeader ? 'header' : 'footer'})`
          : o.type === 'bookmark' ? `(${o.op})`
          : o.type === 'engineBatch' ? `(${digest(o.methods.join(','))})`
          : '';
        return `${o.type}${detail} @${at}`;
      }
    }
  }

  private parseOk(raw: string, label: string): { ok: true } & Record<string, unknown> {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new AgentToolError('RPC_ERROR', `${label} returned unparseable result`);
    }
    const obj = parsed as { ok?: unknown; error?: unknown } | null;
    if (obj?.ok !== true) {
      throw new AgentToolError('RPC_ERROR', `${label} failed: ${String(obj?.error ?? raw).slice(0, 200)}`);
    }
    return obj as { ok: true } & Record<string, unknown>;
  }

  /** applyCharFormat 처럼 반환 스키마가 보증되지 않는 호출용 — ok === false 만 실패로 본다 */
  private parseOkLenient(raw: string, label: string): void {
    try {
      const parsed = JSON.parse(raw) as { ok?: unknown; error?: unknown } | null;
      if (parsed && parsed.ok === false) {
        throw new AgentToolError('RPC_ERROR', `${label} failed: ${String(parsed.error ?? raw).slice(0, 200)}`);
      }
    } catch (e) {
      if (e instanceof AgentToolError) throw e;
      // JSON 이 아니면 성공으로 간주 (기존 호출부도 반환값을 사용하지 않는다)
    }
  }

  // ─── 컨테이너(본문/셀) 추상 접근자 ─────────────────────

  private cellPathAt(cell: CellAddr, para: number): string {
    return JSON.stringify(this.cellPathEntriesAt(cell, para));
  }

  private cellPathEntriesAt(cell: CellAddr, para: number): NonNullable<CellAddr['path']> {
    return cell.path!.map((entry, index) => index === cell.path!.length - 1
      ? { ...entry, cellParaIndex: para }
      : entry);
  }

  /** 셀 그림의 엔진 cellPath — 단일 셀 주소도 한 칸짜리 경로로 바꾼다 (마지막 cellParaIndex = 셀 문단) */
  private imageCellPath(obj: Extract<ObjectOp, { type: 'insertImage' }>): NonNullable<CellAddr['path']> {
    return this.objectCellPath(obj.cell!, obj.paraIdx);
  }

  private objectCellPath(cell: CellAddr, cellPara: number): NonNullable<CellAddr['path']> {
    return cell.path
      ? this.cellPathEntriesAt(cell, cellPara)
      : [{ controlIndex: cell.controlIdx, cellIndex: cell.cellIdx, cellParaIndex: cellPara }];
  }

  /** edit_object 대상 속성 읽기 — 셀 개체는 경로 API 로 읽는다 */
  private readObjectProps(
    obj: Extract<ObjectOp, { type: 'editObject' | 'deleteObject' }>,
  ): Record<string, unknown> {
    const wasm = this.deps.wasm;
    if (obj.cell) {
      const path = this.objectCellPath(obj.cell, obj.paraIdx);
      return (obj.kind === 'picture'
        ? wasm.getCellPicturePropertiesByPath(obj.sectionIdx, obj.cell.paraIdx, path, obj.controlIdx)
        : wasm.getCellShapePropertiesByPath(obj.sectionIdx, obj.cell.paraIdx, path, obj.controlIdx)) as unknown as Record<string, unknown>;
    }
    return (obj.kind === 'picture'
      ? wasm.getPictureProperties(obj.sectionIdx, obj.paraIdx, obj.controlIdx)
      : wasm.getShapeProperties(obj.sectionIdx, obj.paraIdx, obj.controlIdx)) as unknown as Record<string, unknown>;
  }

  /** edit_object 속성 쓰기 (적용·역연산 공용) */
  private writeObjectProps(
    obj: Extract<ObjectOp, { type: 'editObject' }>, props: Record<string, unknown>,
  ): void {
    const wasm = this.deps.wasm;
    let res: { ok: boolean } | undefined;
    if (obj.cell) {
      const path = this.objectCellPath(obj.cell, obj.paraIdx);
      res = obj.kind === 'picture'
        ? wasm.setCellPicturePropertiesByPath(obj.sectionIdx, obj.cell.paraIdx, path, obj.controlIdx, props)
        : wasm.setCellShapePropertiesByPath(obj.sectionIdx, obj.cell.paraIdx, path, obj.controlIdx, props);
    } else {
      res = obj.kind === 'picture'
        ? wasm.setPictureProperties(obj.sectionIdx, obj.paraIdx, obj.controlIdx, props)
        : wasm.setShapeProperties(obj.sectionIdx, obj.paraIdx, obj.controlIdx, props);
    }
    if (res?.ok === false) throw new AgentToolError('RPC_ERROR', `set ${obj.kind} properties failed`);
  }

  /** 적용 직후 크기 — editObject/insertShape 드리프트 판별자 */
  private objectSize(props: Record<string, unknown>): { width: number; height: number } | undefined {
    const width = props['width'];
    const height = props['height'];
    return typeof width === 'number' && typeof height === 'number' ? { width, height } : undefined;
  }

  /**
   * 그림 삽입 위치: 에이전트 charOffset(텍스트 기준) → 엔진 논리 오프셋(인라인 개체 = 1칸).
   * 기본은 같은 오프셋의 개체 앞, afterObjects 면 그 개체들 뒤 (= text+1 의 논리 위치 - 1).
   */
  private imageLogicalOffset(
    obj: Extract<ObjectOp, { type: 'insertImage' }>, path: NonNullable<CellAddr['path']> | null,
  ): number {
    const wasm = this.deps.wasm;
    const toLogical = (text: number): number => path
      ? wasm.textToLogicalOffsetInCellByPath(obj.sectionIdx, obj.cell!.paraIdx, JSON.stringify(path), text)
      : wasm.textToLogicalOffset(obj.sectionIdx, obj.paraIdx, text);
    try {
      return obj.afterObjects ? toLogical(obj.charOffset + 1) - 1 : toLogical(obj.charOffset);
    } catch {
      return obj.charOffset; // 변환 API 가 없는 구버전 wasm — 텍스트 오프셋 그대로
    }
  }

  private containerParaCount(sec: number, cell?: CellAddr): number {
    const wasm = this.deps.wasm;
    return cell?.path
      ? wasm.getCellParagraphCountByPath(sec, cell.paraIdx, this.cellPathAt(cell, 0))
      : cell
      ? wasm.getCellParagraphCount(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx)
      : wasm.getParagraphCount(sec);
  }

  private containerParaLen(sec: number, para: number, cell?: CellAddr): number {
    const wasm = this.deps.wasm;
    return cell?.path
      ? wasm.getCellParagraphLengthByPath(sec, cell.paraIdx, this.cellPathAt(cell, para))
      : cell
      ? wasm.getCellParagraphLength(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, para)
      : wasm.getParagraphLength(sec, para);
  }

  private containerText(sec: number, para: number, off: number, count: number, cell?: CellAddr): string {
    const wasm = this.deps.wasm;
    return cell?.path
      ? wasm.getTextInCellByPath(sec, cell.paraIdx, this.cellPathAt(cell, para), off, count)
      : cell
      ? wasm.getTextInCell(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, para, off, count)
      : wasm.getTextRange(sec, para, off, count);
  }

  private deleteRangeRaw(r: DocRange): { ok: boolean } {
    const wasm = this.deps.wasm;
    if (r.cell?.path) {
      const raw = wasm.deleteRangeInCellByPath(
        r.sectionIdx, r.cell.paraIdx, this.cellPathAt(r.cell, r.startParaIdx),
        r.startParaIdx, r.startCharOffset, r.endParaIdx, r.endCharOffset,
      );
      return this.parseOk(raw, 'deleteRangeInCellByPath') as { ok: boolean };
    }
    return r.cell
      ? wasm.deleteRangeInCell(
        r.sectionIdx, r.cell.paraIdx, r.cell.controlIdx, r.cell.cellIdx,
        r.startParaIdx, r.startCharOffset, r.endParaIdx, r.endCharOffset,
      )
      : wasm.deleteRange(r.sectionIdx, r.startParaIdx, r.startCharOffset, r.endParaIdx, r.endCharOffset);
  }

  private applyFormatRaw(range: DocRange, format: CharFormatProps): string {
    const wasm = this.deps.wasm;
    return range.cell?.path
      ? wasm.applyCharFormatInCellByPath(
        range.sectionIdx, range.cell.paraIdx, this.cellPathAt(range.cell, range.startParaIdx),
        range.startCharOffset, range.endCharOffset, JSON.stringify(format),
      )
      : range.cell
      ? wasm.applyCharFormatInCell(
        range.sectionIdx, range.cell.paraIdx, range.cell.controlIdx, range.cell.cellIdx,
        range.startParaIdx, range.startCharOffset, range.endCharOffset, JSON.stringify(format),
      )
      : wasm.applyCharFormat(
        range.sectionIdx, range.startParaIdx, range.startCharOffset, range.endCharOffset,
        JSON.stringify(format),
      );
  }

  // ─── 객체 연산 (Pair-Editing Phase 2) ─────────────────────

  /**
   * 객체 연산의 적용. 실패는 throw — 호출자(addObjectOp)가 되돌림 수단으로 복원한다.
   * 성공 시 앵커를 op 데이터에 기록한다.
   */
  private applyObjectOp(obj: ObjectOp): void {
    const wasm = this.deps.wasm;
    switch (obj.type) {
      case 'createTable': {
        // treatAsChar 경로 — 문단을 추가하지 않아 deleteTableControl 이 깨끗한 역연산이 된다
        // (설계 리뷰 blocker 해결: block-mode 는 이웃 문단 1~3개를 만들며 역연산이 없다).
        const res = wasm.createTableEx({
          sectionIdx: obj.sectionIdx, paraIdx: obj.paraIdx, charOffset: obj.charOffset,
          rowCount: obj.rows, colCount: obj.cols, treatAsChar: true,
          ...(obj.colWidthsHu ? { colWidths: obj.colWidthsHu } : {}),
        });
        if (!res.ok) throw new AgentToolError('RPC_ERROR', 'createTableEx failed');
        obj.anchor = { paraIdx: res.paraIdx, controlIdx: res.controlIdx, charOffset: obj.charOffset };
        obj.expectedRows = obj.rows;
        obj.expectedCols = obj.cols;
        if (obj.cells) {
          for (let r = 0; r < obj.cells.length; r++) {
            const row = obj.cells[r];
            for (let c = 0; c < row.length; c++) {
              if (row[c]) this.fillCellText(obj.sectionIdx, obj.anchor, r * obj.cols + c, row[c]);
            }
          }
        }
        if (obj.headerRow) {
          for (let c = 0; c < obj.cols; c++) {
            const props: Record<string, unknown> = { isHeader: true };
            if (obj.headerFill) {
              props['fillType'] = 'solid';
              props['fillColor'] = obj.headerFill;
            }
            wasm.setCellProperties(obj.sectionIdx, res.paraIdx, res.controlIdx, c, props);
            const text = obj.cells?.[0]?.[c] ?? '';
            if (obj.headerBold && text.length > 0) {
              const firstLine = text.split('\n')[0];
              if (firstLine.length > 0) {
                wasm.applyCharFormatInCell(
                  obj.sectionIdx, res.paraIdx, res.controlIdx, c, 0, 0, scalarLen(firstLine),
                  JSON.stringify({ bold: true }),
                );
              }
            }
          }
          wasm.setTableProperties(obj.sectionIdx, res.paraIdx, res.controlIdx, { repeatHeader: true });
        }
        // 셀 채우기까지 끝난 뒤에만 다른 op 의 컨트롤 인덱스를 민다 — 도중 실패는
        // 문단 보관본 복원으로 통째로 되돌아가므로 인덱스도 그대로여야 한다.
        this.shiftControlIdxRefs(obj.sectionIdx, res.paraIdx, res.controlIdx, 1, obj);
        return;
      }
      case 'insertImage': {
        const path = obj.cell ? this.imageCellPath(obj) : null;
        const hostPara = obj.cell ? obj.cell.paraIdx : obj.paraIdx;
        const res = wasm.insertPicture(
          obj.sectionIdx, hostPara, this.imageLogicalOffset(obj, path),
          path ? JSON.stringify(path) : '',
          obj.bytes, obj.widthHu, obj.heightHu,
          obj.naturalWidthPx, obj.naturalHeightPx, obj.extension, obj.description,
          undefined, undefined, 'inline',
        );
        if (!res.ok) throw new AgentToolError('RPC_ERROR', 'insertPicture failed');
        if (obj.floating) {
          let placed = false;
          try {
            placed = (path
              ? wasm.setCellPicturePropertiesByPath(obj.sectionIdx, hostPara, path, res.controlIdx, obj.floating)
              : wasm.setPictureProperties(obj.sectionIdx, res.paraIdx, res.controlIdx, obj.floating))?.ok === true;
          } finally {
            // 배치 실패 시 인라인 그림을 남기지 않는다
            if (!placed) {
              if (path) wasm.deleteCellPictureControlByPath(obj.sectionIdx, hostPara, path, res.controlIdx);
              else wasm.deletePictureControl(obj.sectionIdx, res.paraIdx, res.controlIdx);
            }
          }
          if (!placed) throw new AgentToolError('RPC_ERROR', 'setPictureProperties failed');
        }
        // 셀 폭 캡 등 엔진이 정한 실제 크기를 드리프트 판별자로 기록한다
        try {
          const props = path
            ? wasm.getCellPicturePropertiesByPath(obj.sectionIdx, hostPara, path, res.controlIdx)
            : wasm.getPictureProperties(obj.sectionIdx, res.paraIdx, res.controlIdx);
          if (typeof props?.width === 'number' && props.width > 0) obj.widthHu = props.width;
          if (typeof props?.height === 'number' && props.height > 0) obj.heightHu = props.height;
        } catch { /* 요청 크기 유지 */ }
        obj.anchor = { paraIdx: hostPara, controlIdx: res.controlIdx, charOffset: obj.charOffset };
        if (obj.cell) this.shiftCellObjectRefs(obj, res.controlIdx, 1);
        else this.shiftControlIdxRefs(obj.sectionIdx, res.paraIdx, res.controlIdx, 1, obj);
        return;
      }
      case 'insertEquation': {
        if (obj.cell) {
          const res = obj.cell.path
            ? wasm.insertEquationInCellByPath(
              obj.sectionIdx, obj.cell.paraIdx,
              this.cellPathEntriesAt(obj.cell, obj.paraIdx),
              obj.charOffset, obj.script, obj.fontSizeHu, obj.colorRef,
            )
            : wasm.insertEquationInCell(
              obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx,
              obj.paraIdx, obj.charOffset, obj.script, obj.fontSizeHu, obj.colorRef,
            );
          if (!res.ok) throw new AgentToolError('RPC_ERROR', 'insertEquationInCell failed');
          // anchor.paraIdx = 부모 문단, controlIdx = 셀 문단 내 수식 인덱스
          obj.anchor = { paraIdx: obj.cell.paraIdx, controlIdx: res.controlIdx, charOffset: obj.charOffset };
          // 같은 셀 문단의 다른 pending 셀 수식 인덱스 이동
          this.shiftCellObjectRefs(obj, res.controlIdx, 1);
          return;
        }
        const res = wasm.insertEquation(
          obj.sectionIdx, obj.paraIdx, obj.charOffset, obj.script, obj.fontSizeHu, obj.colorRef,
        );
        if (!res.ok) throw new AgentToolError('RPC_ERROR', 'insertEquation failed');
        obj.anchor = { paraIdx: res.paraIdx, controlIdx: res.controlIdx, charOffset: obj.charOffset };
        this.shiftControlIdxRefs(obj.sectionIdx, res.paraIdx, res.controlIdx, 1, obj);
        return;
      }
      case 'editObject': {
        if (Object.keys(obj.props).length > 0) this.writeObjectProps(obj, obj.props);
        if (obj.zOrder) {
          const res = wasm.changeObjectZOrder(obj.sectionIdx, obj.paraIdx, obj.controlIdx, obj.zOrder);
          if (res?.ok !== true) throw new AgentToolError('RPC_ERROR', 'changeObjectZOrder failed');
        }
        try {
          obj.applied = this.objectSize(this.readObjectProps(obj));
        } catch { /* 판별자 없이 존재만 확인한다 */ }
        return;
      }
      case 'deleteObject': {
        let res: { ok: boolean } | undefined;
        if (obj.cell) {
          if (obj.kind !== 'picture') throw new AgentToolError('INVALID_ARGS', 'shapes inside cells cannot be deleted');
          res = wasm.deleteCellPictureControlByPath(
            obj.sectionIdx, obj.cell.paraIdx, this.objectCellPath(obj.cell, obj.paraIdx), obj.controlIdx,
          );
        } else if (obj.kind === 'picture') {
          try {
            res = wasm.deletePictureControl(obj.sectionIdx, obj.paraIdx, obj.controlIdx);
          } catch {
            // 도형 컨트롤로 감싼 그림은 그림 삭제 API 가 거부한다 — 도형으로 지운다
            res = wasm.deleteShapeControl(obj.sectionIdx, obj.paraIdx, obj.controlIdx);
          }
        } else {
          res = wasm.deleteShapeControl(obj.sectionIdx, obj.paraIdx, obj.controlIdx);
        }
        if (res?.ok !== true) throw new AgentToolError('RPC_ERROR', `delete ${obj.kind} failed`);
        if (obj.cell) this.shiftCellObjectRefsAt(obj.cell, obj.paraIdx, obj.controlIdx, -1, obj);
        else this.shiftControlIdxRefs(obj.sectionIdx, obj.paraIdx, obj.controlIdx, -1, obj);
        return;
      }
      case 'insertShape': {
        const res = wasm.createShapeControl(obj.create);
        if (res?.ok !== true) throw new AgentToolError('RPC_ERROR', 'createShapeControl failed');
        let placed = false;
        try {
          placed = wasm.setShapeProperties(obj.sectionIdx, res.paraIdx, res.controlIdx, obj.props)?.ok === true;
        } finally {
          // 배치 실패 시 기본 배치의 도형을 남기지 않는다
          if (!placed) wasm.deleteShapeControl(obj.sectionIdx, res.paraIdx, res.controlIdx);
        }
        if (!placed) throw new AgentToolError('RPC_ERROR', 'setShapeProperties failed');
        obj.anchor = { paraIdx: res.paraIdx, controlIdx: res.controlIdx, charOffset: obj.charOffset };
        try {
          obj.applied = this.objectSize(
            wasm.getShapeProperties(obj.sectionIdx, res.paraIdx, res.controlIdx) as unknown as Record<string, unknown>,
          );
        } catch { /* 판별자 없이 존재만 확인한다 */ }
        this.shiftControlIdxRefs(obj.sectionIdx, res.paraIdx, res.controlIdx, 1, obj);
        return;
      }
      case 'tableStructure': {
        const { sectionIdx: sec, tableParaIdx: para, controlIdx: ctrl } = obj;
        let ok = false;
        switch (obj.op) {
          case 'insert_row':
          case 'insert_col': {
            const r = obj.op === 'insert_row'
              ? wasm.insertTableRow(sec, para, ctrl, obj.index!, obj.after!)
              : wasm.insertTableColumn(sec, para, ctrl, obj.index!, obj.after!);
            ok = r?.ok === true;
            if (ok) obj.insertedIndex = obj.after ? obj.index! + 1 : obj.index;
            break;
          }
          case 'delete_row':
            ok = wasm.deleteTableRow(sec, para, ctrl, obj.rowIdx!)?.ok === true;
            break;
          case 'delete_col':
            ok = wasm.deleteTableColumn(sec, para, ctrl, obj.colIdx!)?.ok === true;
            break;
          case 'merge_cells':
            ok = wasm.mergeTableCells(sec, para, ctrl, obj.startRow!, obj.startCol!, obj.endRow!, obj.endCol!)?.ok === true;
            break;
          case 'split_cell':
            ok = wasm.splitTableCellInto(
              sec, para, ctrl, obj.rowIdx!, obj.colIdx!, obj.splitRows!, obj.splitCols!, true, false,
            )?.ok === true;
            break;
        }
        if (!ok) throw new AgentToolError('RPC_ERROR', `${obj.op} failed`);
        const d = wasm.getTableDimensions(sec, para, ctrl);
        obj.dims = { rowCount: d.rowCount, colCount: d.colCount };
        return;
      }
      case 'deleteTable': {
        const ok = wasm.deleteTableControl(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx)?.ok === true;
        if (!ok) throw new AgentToolError('RPC_ERROR', 'delete_table failed');
        this.shiftControlIdxRefs(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, -1, obj);
        return;
      }
      case 'setCellProps':
        if (wasm.setCellProperties(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.cellIdx, obj.props)?.ok === false) {
          throw new AgentToolError('RPC_ERROR', 'set_cell_props failed');
        }
        return;
      case 'setTableProps':
        if (wasm.setTableProperties(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.props)?.ok === false) {
          throw new AgentToolError('RPC_ERROR', 'set_table_props failed');
        }
        return;
      case 'setColumnWidths': {
        const result = wasm.setTableColumnWidths(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.widthsHu);
        if (!result?.ok) throw new AgentToolError('RPC_ERROR', 'set_column_widths failed');
        return;
      }
      case 'fitToPage': {
        const result = wasm.fitTableToPage(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx);
        if (!result?.ok) throw new AgentToolError('RPC_ERROR', 'fit_to_page failed');
        return;
      }
      case 'setZoneProps': {
        const result = wasm.setCellZoneProperties(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.range, obj.props);
        if (result?.ok === false) throw new AgentToolError('RPC_ERROR', 'set_zone_borders failed');
        return;
      }
      case 'applyFormula': {
        const result = wasm.evaluateTableFormulaEx({
          sectionIdx: obj.sectionIdx,
          parentParaIdx: obj.tableParaIdx,
          controlIdx: obj.controlIdx,
          targetRow: obj.row,
          targetCol: obj.col,
          formula: obj.formula,
          writeResult: true,
          ...(obj.format?.decimalPlaces !== undefined ? { decimalPlaces: obj.format.decimalPlaces } : {}),
          ...(obj.format?.thousandsSeparator !== undefined ? { thousandsSeparator: obj.format.thousandsSeparator } : {}),
          ...(obj.format?.prefix !== undefined ? { prefix: obj.format.prefix } : {}),
          ...(obj.format?.suffix !== undefined ? { suffix: obj.format.suffix } : {}),
        });
        if (!result?.ok) throw new AgentToolError('RPC_ERROR', `apply_formula failed: ${obj.formula}`);
        return;
      }
      case 'setCaption': {
        const result = wasm.setTableCaptionText(
          obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.text, obj.withNumber,
        );
        if (!result?.ok) throw new AgentToolError('RPC_ERROR', 'set_caption failed');
        return;
      }
      case 'applyStyle': {
        const result = obj.cell
          ? wasm.applyCellStyle(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx, obj.styleId)
          : wasm.applyStyle(obj.sectionIdx, obj.paraIdx, obj.styleId);
        if (result?.ok === false) throw new AgentToolError('RPC_ERROR', 'apply_style failed');
        return;
      }
      case 'paraFormat': {
        // 역연산용 이전 para_shape_id 를 최초 적용 시에만 캡처 (replay 는 revert 후라 동일 상태)
        if (obj.prevParaShapeId < 0) {
          const props = obj.cell?.path
            ? wasm.getCellParaPropertiesAtByPath(obj.sectionIdx, obj.cell.paraIdx, this.cellPathAt(obj.cell, obj.paraIdx))
            : obj.cell
              ? wasm.getCellParaPropertiesAt(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx)
              : wasm.getParaPropertiesAt(obj.sectionIdx, obj.paraIdx);
          obj.prevParaShapeId = props.paraShapeId ?? -1;
        }
        const raw = obj.cell?.path
          ? wasm.applyParaFormatInCellByPath(obj.sectionIdx, obj.cell.paraIdx, this.cellPathAt(obj.cell, obj.paraIdx), obj.propsJson)
          : obj.cell
            ? wasm.applyParaFormatInCell(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx, obj.propsJson)
            : wasm.applyParaFormat(obj.sectionIdx, obj.paraIdx, obj.propsJson);
        this.parseOkLenient(raw, 'applyParaFormat');
        return;
      }
      case 'pageLayout': {
        if (obj.pageDef) {
          const r = wasm.setPageDef(obj.sectionIdx, obj.pageDef.next as never);
          if (r?.ok === false) throw new AgentToolError('RPC_ERROR', 'setPageDef failed');
        }
        if (obj.columns) {
          const c = obj.columns.next;
          wasm.setColumnDef(obj.sectionIdx, c.columnCount, c.columnType, c.sameWidth, c.spacing);
        }
        if (obj.sectionDef) {
          const r = wasm.setSectionDef(obj.sectionIdx, obj.sectionDef.next as never);
          if (r?.ok === false) throw new AgentToolError('RPC_ERROR', 'setSectionDef failed');
        }
        return;
      }
      case 'headerFooter': {
        // 기존 HF 는 내용을 통째로 교체하고(문단 보관본으로 되돌림), 없으면 새로 만든다
        if (obj.existedBefore) {
          this.writeHeaderFooterContent(obj);
          return;
        }
        this.parseOk(wasm.createHeaderFooter(obj.sectionIdx, obj.isHeader, obj.applyTo), 'createHeaderFooter');
        try {
          this.writeHeaderFooterContent(obj);
        } catch (error) {
          // 내용 쓰기 실패 시 만든 HF 를 남기지 않는다 — 등록되지 않은 op 라 역연산이 없다
          try { wasm.deleteHeaderFooter(obj.sectionIdx, obj.isHeader, obj.applyTo); } catch { /* best effort */ }
          throw error;
        }
        return;
      }
      case 'insertNote': {
        const res = obj.noteKind === 'endnote'
          ? wasm.insertEndnote(obj.sectionIdx, obj.paraIdx, obj.charOffset)
          : wasm.insertFootnote(obj.sectionIdx, obj.paraIdx, obj.charOffset);
        if (!res.ok) throw new AgentToolError('RPC_ERROR', `insert${obj.noteKind === 'endnote' ? 'Endnote' : 'Footnote'} failed`);
        obj.anchor = { paraIdx: res.paraIdx, controlIdx: res.controlIdx, charOffset: obj.charOffset };
        obj.number = obj.noteKind === 'endnote'
          ? (res as { endnoteNumber?: number }).endnoteNumber
          : (res as { footnoteNumber?: number }).footnoteNumber;
        this.shiftControlIdxRefs(obj.sectionIdx, res.paraIdx, res.controlIdx, 1, obj);
        if (obj.text.length > 0) {
          const t = wasm.insertTextInFootnote(obj.sectionIdx, res.paraIdx, res.controlIdx, 0, 0, obj.text);
          if (t?.ok !== true) {
            // 내용 삽입 실패 시 마커를 남기지 않는다 — 통째로 되돌리고 실패 보고
            try { wasm.deleteFootnote(obj.sectionIdx, res.paraIdx, res.controlIdx); } catch { /* best effort */ }
            this.shiftControlIdxRefs(obj.sectionIdx, res.paraIdx, res.controlIdx, -1, obj);
            obj.anchor = undefined;
            throw new AgentToolError('RPC_ERROR', 'insertTextInFootnote failed');
          }
        }
        // 엔진이 기본 내용(공백 등)을 덧붙일 수 있다 — 검증 기준을 실제 적용 결과로 잡는다
        try {
          const info = wasm.getFootnoteInfo(obj.sectionIdx, res.paraIdx, res.controlIdx);
          if (info?.ok === true) obj.appliedText = info.texts[0] ?? obj.text;
        } catch { /* 검증은 appliedText ?? text 폴백 */ }
        return;
      }
      case 'setNoteText': {
        const info = wasm.getFootnoteInfo(obj.sectionIdx, obj.paraIdx, obj.controlIdx);
        if (info?.ok !== true) throw new AgentToolError('NOTE_NOT_FOUND', 'footnote/endnote not found at that address — list_footnotes for valid addresses');
        if (info.paraCount !== 1) {
          throw new AgentToolError('NOTE_MULTIPARA',
            `this note has ${info.paraCount} paragraphs — edit_footnote only supports single-paragraph notes`);
        }
        // replay(approve 재적용) 시 이전 내용을 다시 캡처하지 않는다 — 최초 적용 값이 원본이다.
        if (obj.prevText === undefined) obj.prevText = info.texts[0] ?? '';
        const prevLen = [...(info.texts[0] ?? '')].length;
        if (prevLen > 0) {
          const d = wasm.deleteTextInFootnote(obj.sectionIdx, obj.paraIdx, obj.controlIdx, 0, 0, prevLen);
          if (d?.ok !== true) throw new AgentToolError('RPC_ERROR', 'deleteTextInFootnote failed');
        }
        if (obj.text.length > 0) {
          const t = wasm.insertTextInFootnote(obj.sectionIdx, obj.paraIdx, obj.controlIdx, 0, 0, obj.text);
          if (t?.ok !== true) throw new AgentToolError('RPC_ERROR', 'insertTextInFootnote failed');
        }
        return;
      }
      case 'bookmark': {
        if (obj.op === 'add') {
          const r = wasm.addBookmark(obj.sectionIdx, obj.paraIdx, obj.charOffset ?? 0, obj.name ?? '');
          if (r?.ok !== true) {
            throw new AgentToolError('BOOKMARK_FAILED', `addBookmark failed: ${String((r as { error?: string })?.error ?? 'unknown')}`);
          }
          // 역연산용 ctrlIdx 를 목록에서 찾는다 (같은 문단·이름 매칭)
          const added = wasm.getBookmarks().find(
            (b) => b.sec === obj.sectionIdx && b.para === obj.paraIdx && b.name === obj.name,
          );
          if (added) {
            obj.ctrlIdx = added.ctrlIdx;
            // 책갈피도 컨트롤이다 — 같은 문단의 뒤쪽 개체 번호가 하나씩 밀린다
            this.shiftControlIdxRefs(obj.sectionIdx, obj.paraIdx, added.ctrlIdx, 1, obj);
          }
          return;
        }
        const target = wasm.getBookmarks().find(
          (b) => b.sec === obj.sectionIdx && b.para === obj.paraIdx && b.ctrlIdx === obj.ctrlIdx,
        );
        if (!target) throw new AgentToolError('BOOKMARK_NOT_FOUND', 'bookmark not found — list_bookmarks for current addresses');
        if (obj.prev === undefined) {
          obj.prev = { name: target.name, para: target.para, charPos: target.charPos, ctrlIdx: target.ctrlIdx };
        }
        if (obj.op === 'delete') {
          const r = wasm.deleteBookmark(obj.sectionIdx, obj.paraIdx, obj.ctrlIdx!);
          if (r?.ok !== true) throw new AgentToolError('BOOKMARK_FAILED', 'deleteBookmark failed');
          this.shiftControlIdxRefs(obj.sectionIdx, obj.paraIdx, obj.ctrlIdx!, -1, obj);
        } else {
          const r = wasm.renameBookmark(obj.sectionIdx, obj.paraIdx, obj.ctrlIdx!, obj.name ?? '');
          if (r?.ok !== true) throw new AgentToolError('BOOKMARK_FAILED', 'renameBookmark failed');
        }
        return;
      }
      case 'engineBatch':
        throw new AgentToolError('INVALID_ARGS', 'engine batches are staged through addEngineBatch');
    }
  }

  /** 객체 연산의 역연산 (보관본/스냅샷을 쓸 수 없을 때의 폴백). 성공 여부 반환. */
  private revertObjectOp(obj: ObjectOp, seq?: number): boolean {
    const wasm = this.deps.wasm;
    try {
      switch (obj.type) {
        case 'createTable': {
          if (!obj.anchor) return false;
          const ok = wasm.deleteTableControl(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx)?.ok === true;
          if (ok) this.shiftControlIdxRefs(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx, -1, obj);
          return ok;
        }
        case 'insertImage': {
          if (!obj.anchor) return false;
          if (obj.cell) {
            const ok = wasm.deleteCellPictureControlByPath(
              obj.sectionIdx, obj.cell.paraIdx, this.imageCellPath(obj), obj.anchor.controlIdx,
            )?.ok === true;
            if (ok) this.shiftCellObjectRefs(obj, obj.anchor.controlIdx, -1);
            return ok;
          }
          const ok = wasm.deletePictureControl(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx)?.ok === true;
          if (ok) this.shiftControlIdxRefs(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx, -1, obj);
          return ok;
        }
        case 'insertEquation': {
          if (!obj.anchor) return false;
          if (obj.cell) {
            const ok = (obj.cell.path
              ? wasm.deleteEquationControlInCellByPath(
                obj.sectionIdx, obj.cell.paraIdx,
                this.cellPathEntriesAt(obj.cell, obj.paraIdx), obj.anchor.controlIdx,
              )
              : wasm.deleteEquationControlInCell(
                obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx,
                obj.paraIdx, obj.anchor.controlIdx,
              ))?.ok === true;
            if (ok) this.shiftCellObjectRefs(obj, obj.anchor.controlIdx, -1);
            return ok;
          }
          const ok = wasm.deleteEquationControl(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx)?.ok === true;
          if (ok) this.shiftControlIdxRefs(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx, -1, obj);
          return ok;
        }
        case 'editObject': {
          // 한 칸 앞/뒤는 반대 방향으로 되돌릴 수 있다 — 맨 앞/뒤는 스냅샷으로만 되돌린다
          if (obj.zOrder === 'front' || obj.zOrder === 'back') return false;
          if (obj.zOrder) {
            const back = obj.zOrder === 'forward' ? 'backward' : 'forward';
            if (wasm.changeObjectZOrder(obj.sectionIdx, obj.paraIdx, obj.controlIdx, back)?.ok !== true) return false;
          }
          if (Object.keys(obj.prevProps).length > 0) this.writeObjectProps(obj, obj.prevProps);
          return true;
        }
        case 'insertShape': {
          if (!obj.anchor) return false;
          const ok = wasm.deleteShapeControl(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx)?.ok === true;
          if (ok) this.shiftControlIdxRefs(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx, -1, obj);
          return ok;
        }
        case 'tableStructure': {
          // 행/열 삽입만 역연산이 있다 — 나머지 구조 op 는 문단 보관본으로만 되돌린다
          if ((obj.op !== 'insert_row' && obj.op !== 'insert_col') || obj.insertedIndex === undefined) return false;
          const r = obj.op === 'insert_row'
            ? wasm.deleteTableRow(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.insertedIndex)
            : wasm.deleteTableColumn(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.insertedIndex);
          if (r?.ok === true) {
            this.adjustExpectedDimsForTable(
              obj.sectionIdx, obj.tableParaIdx, obj.controlIdx,
              obj.op === 'insert_row' ? -1 : 0, obj.op === 'insert_col' ? -1 : 0, obj,
            );
            return true;
          }
          return false;
        }
        case 'paraFormat': {
          if (obj.prevParaShapeId < 0) return false;
          if (obj.cell?.path) {
            wasm.setCellParaShapeIdByPath(
              obj.sectionIdx, obj.cell.paraIdx, this.cellPathAt(obj.cell, obj.paraIdx), obj.prevParaShapeId,
            );
          } else if (obj.cell) {
            wasm.setCellParaShapeId(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx, obj.prevParaShapeId);
          } else {
            wasm.setParaShapeId(obj.sectionIdx, obj.paraIdx, obj.prevParaShapeId);
          }
          return true;
        }
        case 'pageLayout': {
          if (obj.pageDef) wasm.setPageDef(obj.sectionIdx, obj.pageDef.prev as never);
          if (obj.columns) {
            const c = obj.columns.prev;
            wasm.setColumnDef(obj.sectionIdx, c.columnCount, c.columnType, c.sameWidth, c.spacing);
          }
          if (obj.sectionDef) wasm.setSectionDef(obj.sectionIdx, obj.sectionDef.prev as never);
          return true;
        }
        case 'headerFooter': {
          // 새로 만든 HF 만 지워서 되돌린다 (기존 HF 교체는 문단 보관본 전용)
          if (obj.existedBefore) return false;
          wasm.deleteHeaderFooter(obj.sectionIdx, obj.isHeader, obj.applyTo);
          return true;
        }
        case 'insertNote': {
          if (!obj.anchor) return false;
          const ok = wasm.deleteFootnote(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx)?.ok === true;
          if (ok) this.shiftControlIdxRefs(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx, -1, obj);
          return ok;
        }
        case 'setNoteText': {
          if (obj.prevText === undefined) return false;
          const info = wasm.getFootnoteInfo(obj.sectionIdx, obj.paraIdx, obj.controlIdx);
          if (info?.ok !== true || info.paraCount !== 1) return false;
          const curLen = [...(info.texts[0] ?? '')].length;
          if (curLen > 0) {
            if (wasm.deleteTextInFootnote(obj.sectionIdx, obj.paraIdx, obj.controlIdx, 0, 0, curLen)?.ok !== true) return false;
          }
          if (obj.prevText.length > 0) {
            if (wasm.insertTextInFootnote(obj.sectionIdx, obj.paraIdx, obj.controlIdx, 0, 0, obj.prevText)?.ok !== true) return false;
          }
          return true;
        }
        case 'bookmark': {
          if (obj.op === 'add') {
            if (obj.ctrlIdx === undefined) return false;
            if (wasm.deleteBookmark(obj.sectionIdx, obj.paraIdx, obj.ctrlIdx)?.ok !== true) return false;
            this.shiftControlIdxRefs(obj.sectionIdx, obj.paraIdx, obj.ctrlIdx, -1, obj);
            return true;
          }
          if (!obj.prev) return false;
          if (obj.op === 'delete') {
            const prev = obj.prev;
            if (wasm.addBookmark(obj.sectionIdx, prev.para, prev.charPos, prev.name)?.ok !== true) return false;
            const restored = wasm.getBookmarks().find((b) => b.sec === obj.sectionIdx && b.name === prev.name);
            if (restored) this.shiftControlIdxRefs(obj.sectionIdx, restored.para, restored.ctrlIdx, 1, obj, seq);
            return true;
          }
          return wasm.renameBookmark(obj.sectionIdx, obj.paraIdx, obj.prev.ctrlIdx, obj.prev.name)?.ok === true;
        }
        default:
          return false; // 역연산이 없다 — 문단 보관본/스냅샷으로만 되돌린다
      }
    } catch (err) {
      console.warn('[pending-edits] object revert failed', obj.type, err);
      return false;
    }
  }

  // ─── 문단 보관본 (문단 단위 되돌림) ─────────────────────

  /** 적용 전에 보관 대상 문단을 확정한다 — 기존 머리말/꼬리말은 HF 컨트롤을 품은 문단 */
  private resolveCaptureHost(obj: ObjectOp): void {
    if (obj.type !== 'headerFooter' || !obj.existedBefore || obj.hostParaIdx !== undefined) return;
    try {
      const info = JSON.parse(this.deps.wasm.getHeaderFooter(obj.sectionIdx, obj.isHeader, obj.applyTo)) as { paraIndex?: unknown };
      if (typeof info?.paraIndex === 'number') obj.hostParaIdx = info.paraIndex;
    } catch { /* 보관 없이 스냅샷으로 되돌린다 */ }
  }

  /**
   * 문단 보관본으로 되돌릴 본문 문단 — 한 문단 안에서 끝나는 변경만 해당한다.
   * 표를 만들거나 고치는 op, 스타일, 기존 머리말/꼬리말 교체. (null = 보관 대상 아님)
   */
  private captureHost(obj: ObjectOp): number | null {
    switch (obj.type) {
      case 'createTable':
      case 'insertShape': return obj.anchor ? obj.anchor.paraIdx : obj.paraIdx;
      case 'applyStyle':
      case 'deleteObject': return obj.cell ? obj.cell.paraIdx : obj.paraIdx;
      case 'editObject': return obj.zOrder ? null : obj.cell ? obj.cell.paraIdx : obj.paraIdx;
      case 'headerFooter': return obj.existedBefore ? obj.hostParaIdx ?? null : null;
      default: return isTableTargetOp(obj) ? obj.tableParaIdx : null;
    }
  }

  /** 문단 보관본(없으면 스냅샷)으로 되돌리는 op 인가 — createTable 외에는 역연산이 없다 */
  private revertsByParagraph(obj: ObjectOp): boolean {
    return obj.type === 'createTable' || obj.type === 'applyStyle'
      || obj.type === 'insertShape' || obj.type === 'deleteObject'
      || (obj.type === 'editObject' && !obj.zOrder)
      || (obj.type === 'headerFooter' && obj.existedBefore)
      || isTableTargetOp(obj);
  }

  private captureParagraph(sectionIdx: number, paraIdx: number): number | null {
    const wasm = this.deps.wasm;
    if (typeof wasm.captureParagraph !== 'function') return null;
    try {
      return wasm.captureParagraph(sectionIdx, paraIdx);
    } catch (error) {
      console.warn('[pending-edits] paragraph capture failed; using a document snapshot', error);
      return null;
    }
  }

  private paragraphDigest(sectionIdx: number, paraIdx: number): string | null {
    const wasm = this.deps.wasm;
    if (typeof wasm.getParagraphContentDigest !== 'function') return null;
    try {
      return wasm.getParagraphContentDigest(sectionIdx, paraIdx);
    } catch {
      return null;
    }
  }

  /** 표 op 의 대상 표 크기 (표가 아니거나 없으면 null) */
  private tableDims(obj: ObjectOp): { rowCount: number; colCount: number } | null {
    if (!isTableTargetOp(obj) || obj.type === 'deleteTable') return null;
    try {
      const d = this.deps.wasm.getTableDimensions(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx);
      return { rowCount: d.rowCount, colCount: d.colCount };
    } catch {
      return null;
    }
  }

  /** 구조 op 가 표 크기를 바꿨으면 같은 표를 보는 다른 op 의 기대 크기를 맞춘다 (드리프트 오탐 방지) */
  private adjustSiblingDims(
    obj: ObjectOp,
    before: { rowCount: number; colCount: number } | null,
    after: { rowCount: number; colCount: number } | null,
  ): void {
    if (!before || !after || !isTableTargetOp(obj)) return;
    this.adjustExpectedDimsForTable(
      obj.sectionIdx, obj.tableParaIdx, obj.controlIdx,
      after.rowCount - before.rowCount, after.colCount - before.colCount, obj,
    );
  }

  /** 이 op 이 해당 본문 문단(또는 그 문단의 표/셀)을 바꾸는가 — 문단 보관본 복원 가부 판정용 */
  private opTouchesBodyPara(op: PendingOp, sectionIdx: number, paraIdx: number): boolean {
    switch (op.kind) {
      case 'template':
      case 'field':
        return true; // 위치를 모른다 — 보수적으로 겹친다고 본다
      case 'object': {
        const o = op.obj;
        if (o.type === 'pageLayout') return o.sectionIdx === sectionIdx; // 구역 전체를 다시 흘린다
        if (o.type === 'engineBatch') {
          // 문단 밖(스타일·쪽 설정 등)만 바꾼 배치는 위치를 모른다 — 보수적으로 겹친다고 본다
          return o.touched.length === 0 || o.touched.some((span) =>
            span.sectionIdx === sectionIdx && span.paraStart <= paraIdx && paraIdx <= span.paraEnd);
        }
        if (o.sectionIdx !== sectionIdx) return false;
        const host = this.captureHost(o) ?? this.objectBodyParaIdx(o);
        return host === paraIdx;
      }
      default: {
        const r = op.range;
        if (r.sectionIdx !== sectionIdx) return false;
        return r.cell ? r.cell.paraIdx === paraIdx : r.startParaIdx <= paraIdx && paraIdx <= r.endParaIdx;
      }
    }
  }

  /**
   * 문단 보관본으로 되돌려도 되는가. 보관본은 문단 전체를 덮으므로 (1) 그 문단을 바꾼
   * 나중 op 이 되돌림 대상 밖에 남아 있으면 안 되고, (2) 문단이 적용 직후 그대로(지문
   * 일치)여야 한다 — 사용자 편집을 지우거나, 주소 추적이 어긋나 엉뚱한 문단을 덮는 일을 막는다.
   */
  private canRestoreParagraph(
    op: Extract<PendingOp, { kind: 'object' }>, host: number,
    revertSet: PendingOp[], keepPreviewsOf: PendingOp[], userEditSeqNow: number,
  ): boolean {
    const sec = op.obj.sectionIdx;
    const isLaterOutside = (cand: PendingOp): boolean =>
      cand !== op && (cand.seq ?? 0) > (op.seq ?? 0) && !revertSet.includes(cand)
      && this.opTouchesBodyPara(cand, sec, host);
    for (const set of this.sets) {
      if (set.ops.some(isLaterOutside)) return false;
    }
    if (keepPreviewsOf.some(isLaterOutside)) return false;
    const digest = op.paraCapture?.digest ?? null;
    if (digest === null) {
      return op.userEditSeqAtSnapshot === userEditSeqNow && op.settledSetSeqAtSnapshot === this.settledSetSeq;
    }
    return this.paragraphDigest(sec, host) === digest;
  }

  /** 같은 셀 문단의 다른 pending 셀 수식 anchor 인덱스를 이동한다 */
  private shiftCellObjectRefs(
    acting: Extract<ObjectOp, { type: 'insertEquation' | 'insertImage' }>, atIdx: number, delta: 1 | -1,
  ): void {
    if (acting.cell) this.shiftCellObjectRefsAt(acting.cell, acting.paraIdx, atIdx, delta, acting);
  }

  /** 셀 문단 하나의 컨트롤 목록이 바뀌면 그 문단의 다른 pending 개체 인덱스를 민다 */
  private shiftCellObjectRefsAt(
    cell: CellAddr, cellPara: number, atIdx: number, delta: 1 | -1, exclude: ObjectOp, reinsertedAfterSeq?: number,
  ): void {
    const hit = (idx: number, op: PendingOp): boolean => {
      if (delta === -1) return idx > atIdx;
      if (idx !== atIdx) return idx > atIdx;
      return reinsertedAfterSeq === undefined || (op.seq ?? 0) > reinsertedAfterSeq;
    };
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind !== 'object' || op.obj === exclude) continue;
        const o = op.obj;
        if (!('cell' in o) || !o.cell || !sameCell(o.cell, cell) || !('paraIdx' in o) || o.paraIdx !== cellPara) continue;
        if ((o.type === 'insertEquation' || o.type === 'insertImage') && o.anchor && hit(o.anchor.controlIdx, op)) {
          o.anchor = { ...o.anchor, controlIdx: o.anchor.controlIdx + delta };
        } else if ((o.type === 'editObject' || o.type === 'deleteObject') && hit(o.controlIdx, op)) {
          o.controlIdx += delta;
        }
      }
    }
  }

  /** 같은 표에 pending 구조 op(행/열 삽입·삭제·병합·표 삭제)이 있는가 */
  private hasStructuralSibling(sectionIdx: number, anchor: ObjectAnchor): boolean {
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind !== 'object') continue;
        const o = op.obj;
        if ((o.type === 'tableStructure' || o.type === 'deleteTable')
          && o.sectionIdx === sectionIdx
          && o.tableParaIdx === anchor.paraIdx && o.controlIdx === anchor.controlIdx) {
          return true;
        }
      }
    }
    return false;
  }

  /** 이 표를 대상으로 한 에이전트 pending 셀 op 들이 만진 cellIdx 집합 */
  private agentTouchedCells(sectionIdx: number, anchor: ObjectAnchor): Set<number> {
    const touched = new Set<number>();
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind === 'insert' || op.kind === 'format' || op.kind === 'replace') {
          const c = op.range.cell;
          if (c && op.range.sectionIdx === sectionIdx
            && c.paraIdx === anchor.paraIdx && c.controlIdx === anchor.controlIdx) {
            touched.add(c.cellIdx);
          }
        } else if (op.kind === 'object' && op.obj.type === 'insertEquation' && op.obj.cell
          && op.obj.sectionIdx === sectionIdx
          && op.obj.cell.paraIdx === anchor.paraIdx && op.obj.cell.controlIdx === anchor.controlIdx) {
          touched.add(op.obj.cell.cellIdx);
        } else if (op.kind === 'object' && op.obj.type === 'applyFormula' && op.obj.cellIdx !== undefined
          && op.obj.sectionIdx === sectionIdx
          && op.obj.tableParaIdx === anchor.paraIdx && op.obj.controlIdx === anchor.controlIdx) {
          touched.add(op.obj.cellIdx);
        }
      }
    }
    return touched;
  }

  /**
   * 삭제될 표/행/열의 내용을 읽어 둔다 — 지워진 뒤에는 엔진에 물어볼 수 없다.
   * 행 안 셀은 ' | ', 행 사이는 줄바꿈으로 잇는다. 팝오버·diff 표시용이라
   * 큰 표는 일부만 읽는다.
   */
  private removedTargetText(
    obj: Extract<ObjectOp, { type: 'tableStructure' | 'deleteTable' }>,
  ): string {
    const wasm = this.deps.wasm;
    if (typeof wasm.getTableCellBboxes !== 'function') return '';
    const boxes = wasm.getTableCellBboxes(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx);
    const at = obj.type === 'tableStructure'
      ? ((obj.op === 'delete_row' ? obj.rowIdx : obj.colIdx) ?? -1)
      : -1;
    const picked = boxes
      .filter((c) => obj.type === 'deleteTable'
        || (obj.op === 'delete_row' ? c.row <= at && at < c.row + c.rowSpan
          : c.col <= at && at < c.col + c.colSpan))
      .sort((a, b) => a.row - b.row || a.col - b.col);
    const anchor = { paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx, charOffset: 0 };
    const rows = new Map<number, string[]>();
    let total = 0;
    for (const c of picked) {
      let text = '';
      try {
        text = this.cellFullText(obj.sectionIdx, anchor, c.cellIdx);
      } catch { /* 셀 하나의 실패는 건너뛴다 */ }
      const row = rows.get(c.row) ?? [];
      row.push(text);
      rows.set(c.row, row);
      total += text.length;
      if (total > 640) break;
    }
    return [...rows.values()].map((cells) => cells.join(' | ')).join('\n');
  }

  /** 셀 전체 텍스트(문단 \n 결합) — createTable 내용 지문용 */
  private cellFullText(sectionIdx: number, anchor: ObjectAnchor, cellIdx: number): string {
    const wasm = this.deps.wasm;
    const n = wasm.getCellParagraphCount(sectionIdx, anchor.paraIdx, anchor.controlIdx, cellIdx);
    const parts: string[] = [];
    for (let p = 0; p < n; p++) {
      const len = wasm.getCellParagraphLength(sectionIdx, anchor.paraIdx, anchor.controlIdx, cellIdx, p);
      parts.push(len > 0 ? wasm.getTextInCell(sectionIdx, anchor.paraIdx, anchor.controlIdx, cellIdx, p, 0, len) : '');
    }
    return parts.join('\n');
  }

  /** 드리프트 프로브: 객체 op 이 여전히 유효한가 (approve/reject 직전). 유효하면 null. */
  private objectDriftCause(obj: ObjectOp): PendingDropCause | null {
    const wasm = this.deps.wasm;
    const tableCause = (sec: number, para: number, ctrl: number, dims?: { rowCount: number; colCount: number }) => {
      const d = wasm.getTableDimensions(sec, para, ctrl);
      return !dims || (d.rowCount === dims.rowCount && d.colCount === dims.colCount) ? null : 'table-changed' as const;
    };
    try {
      switch (obj.type) {
        case 'createTable': {
          if (!obj.anchor) return 'table-changed';
          const d = wasm.getTableDimensions(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx);
          if (d.rowCount !== (obj.expectedRows ?? obj.rows) || d.colCount !== (obj.expectedCols ?? obj.cols)) {
            return 'table-changed';
          }
          // 내용 지문: 사용자가 pending 표 안에 입력했다면 revert 로 지우지 않고
          // op 을 드리프트로 폐기해 표(와 사용자 내용)를 남긴다 (리뷰 확정 결함 수정).
          // 단, 같은 pending 상태의 에이전트 셀 op 이 만진 셀은 지문에서 제외하고,
          // 구조 op(행/열 삽입 등)이 셀 배치를 바꿨다면 지문 검사를 건너뛴다 (크기 검사로 충분).
          if (obj.cells && !this.hasStructuralSibling(obj.sectionIdx, obj.anchor)) {
            const touched = this.agentTouchedCells(obj.sectionIdx, obj.anchor);
            for (let r = 0; r < obj.rows; r++) {
              for (let c = 0; c < obj.cols; c++) {
                const cellIdx = r * obj.cols + c;
                if (touched.has(cellIdx)) continue;
                const expected = obj.cells[r]?.[c] ?? '';
                if (this.cellFullText(obj.sectionIdx, obj.anchor, cellIdx) !== expected) return 'table-changed';
              }
            }
          }
          return null;
        }
        case 'insertImage': {
          if (!obj.anchor) return 'object-changed';
          // 존재만 보면 같은 자리의 사용자 그림을 지울 수 있다 — 크기 판별자 비교 (리뷰 확정 결함 수정)
          const p = obj.cell
            ? wasm.getCellPicturePropertiesByPath(
              obj.sectionIdx, obj.cell.paraIdx, this.imageCellPath(obj), obj.anchor.controlIdx,
            )
            : wasm.getPictureProperties(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx);
          if (p === null || typeof p !== 'object') return 'object-changed';
          const rec = p as unknown as { width?: number; height?: number; description?: string };
          if (typeof rec.width === 'number' && typeof rec.height === 'number') {
            if (rec.width !== obj.widthHu || rec.height !== obj.heightHu) return 'object-changed';
          }
          if (typeof rec.description === 'string' && obj.description && rec.description !== obj.description) {
            return 'object-changed';
          }
          return null;
        }
        case 'insertEquation': {
          if (!obj.anchor) return 'object-changed';
          let script: string | null | undefined;
          if (obj.cell) {
            if (obj.cell.path) {
              script = wasm.getEquationPropertiesByPath(
                obj.sectionIdx, obj.cell.paraIdx,
                this.cellPathEntriesAt(obj.cell, obj.paraIdx), obj.anchor.controlIdx,
              )?.script;
            } else {
              // 인덱스 지정 조회 (신규 wasm API; 구버전/스텁은 첫-수식 조회로 폴백)
              script = typeof wasm.getEquationScriptInCellAt === 'function'
                ? wasm.getEquationScriptInCellAt(
                  obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx,
                  obj.paraIdx, obj.anchor.controlIdx,
                )
                : null;
              if (script === null) {
                script = wasm.getEquationProperties(
                  obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx,
                )?.script;
              }
            }
          } else {
            script = wasm.getEquationProperties(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx)?.script;
          }
          return script === obj.script ? null : 'object-changed';
        }
        case 'editObject': {
          // 같은 자리에 같은 종류의 개체가 적용 직후 크기로 남아 있어야 한다 (사용자가 옮긴 크기·다른 개체 판별)
          const size = this.objectSize(this.readObjectProps(obj));
          return !obj.applied || (size && size.width === obj.applied.width && size.height === obj.applied.height)
            ? null : 'object-changed';
        }
        case 'deleteObject':
          // 개체는 이미 없다 — 되돌림 직전의 문단 지문이 사용자 수정을 가린다
          return (obj.cell ? obj.cell.paraIdx : obj.paraIdx) < wasm.getParagraphCount(obj.sectionIdx)
            ? null : 'paragraph-changed';
        case 'insertShape': {
          if (!obj.anchor) return 'object-changed';
          const size = this.objectSize(
            wasm.getShapeProperties(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx) as unknown as Record<string, unknown>,
          );
          return !obj.applied || (size && size.width === obj.applied.width && size.height === obj.applied.height)
            ? null : 'object-changed';
        }
        case 'tableStructure':
        case 'setCellProps':
        case 'setTableProps':
        case 'setColumnWidths':
        case 'fitToPage':
        case 'setZoneProps':
        case 'applyFormula':
        case 'setCaption':
          return tableCause(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.dims);
        case 'deleteTable':
          // 표는 이미 없다 — 되돌림 직전에 문단 지문으로 사용자 수정을 가린다
          return obj.tableParaIdx < wasm.getParagraphCount(obj.sectionIdx) ? null : 'paragraph-changed';
        case 'paraFormat':
        case 'applyStyle': {
          // containerParaCount 는 cell.path (중첩 셀) 까지 내려간다
          if (obj.paraIdx >= this.containerParaCount(obj.sectionIdx, obj.cell)) {
            return 'paragraph-changed';
          }
          // 텍스트 지문: 문단 삽입/삭제로 인덱스가 다른 문단을 가리키면 드리프트 (리뷰 확정 결함 수정)
          if (obj.textSample !== undefined && this.paraTextSample(obj) !== obj.textSample) return 'paragraph-changed';
          return null;
        }
        case 'pageLayout':
          return obj.sectionIdx < wasm.getSectionCount() ? null : 'object-changed';
        case 'headerFooter': {
          // 신규 생성이든 기존 수정이든 검증 시점에 HF 가 존재해야 한다 (리뷰 확정 결함 수정)
          const raw = JSON.parse(wasm.getHeaderFooter(obj.sectionIdx, obj.isHeader, obj.applyTo)) as { exists?: boolean };
          return raw?.exists === true ? null : 'object-changed';
        }
        case 'insertNote': {
          if (!obj.anchor) return 'object-changed';
          const info = wasm.getFootnoteInfo(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx);
          if (info?.ok !== true) return 'object-changed';
          // 내용 지문 — 사용자가 각주 내용을 손댔으면 드리프트로 남긴다.
          // 기준은 적용 직후 실제 텍스트(appliedText) — 엔진 기본 내용이 붙을 수 있다.
          return (info.texts[0] ?? '') === (obj.appliedText ?? obj.text) ? null : 'text-changed';
        }
        case 'setNoteText': {
          const info = wasm.getFootnoteInfo(obj.sectionIdx, obj.paraIdx, obj.controlIdx);
          if (info?.ok !== true || info.paraCount !== 1) return 'object-changed';
          return (info.texts[0] ?? '') === obj.text ? null : 'text-changed';
        }
        case 'engineBatch':
          // 스냅샷 되돌림의 사용자 편집·확정 가드가 대신 판정한다
          return null;
        case 'bookmark': {
          if (obj.op === 'add' || obj.op === 'rename') {
            return wasm.getBookmarks().some(
              (b) => b.sec === obj.sectionIdx && b.para === obj.paraIdx && b.name === obj.name,
            ) ? null : 'object-changed';
          }
          // delete: 대상이 다시 나타났으면(사용자 재추가 등) 드리프트
          return wasm.getBookmarks().some(
            (b) => b.sec === obj.sectionIdx && b.para === obj.paraIdx
              && obj.prev !== undefined && b.name === obj.prev.name && b.charPos === obj.prev.charPos,
          ) ? 'object-changed' : null;
        }
      }
    } catch {
      return obj.type === 'createTable' || obj.type === 'tableStructure' || obj.type === 'setCellProps'
        || obj.type === 'setTableProps' || obj.type === 'setColumnWidths' || obj.type === 'fitToPage'
        || obj.type === 'setZoneProps' || obj.type === 'applyFormula' || obj.type === 'setCaption'
        ? 'table-changed' : 'object-changed';
    }
  }

  /** paraFormat/applyStyle 대상 문단의 앞 24자 (드리프트 지문) */
  private paraTextSample(obj: Extract<ObjectOp, { type: 'paraFormat' | 'applyStyle' }>): string {
    const len = this.containerParaLen(obj.sectionIdx, obj.paraIdx, obj.cell);
    const n = Math.min(len, 24);
    return n === 0 ? '' : this.containerText(obj.sectionIdx, obj.paraIdx, 0, n, obj.cell);
  }

  /**
   * 같은 표를 참조하는 모든 pending op 의 기대 크기(dims/expectedRows·Cols)를
   * 구조 op 적용/되돌림에 맞춰 갱신한다. exclude 는 방금 자기 dims 를 새로
   * 스냅샷한 op (자기 자신은 이미 최신이다). — 리뷰 확정 결함 수정:
   * createTable 만 갱신하면 형제 op 들의 dims 스냅샷이 낡아 reject 시
   * 멀쩡한 op 이 드리프트로 오판·폐기된다.
   */
  private adjustExpectedDimsForTable(
    sectionIdx: number, tableParaIdx: number, controlIdx: number,
    dRows: number, dCols: number, exclude?: ObjectOp,
  ): void {
    if (dRows === 0 && dCols === 0) return;
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind !== 'object' || op.obj === exclude) continue;
        const o = op.obj;
        if (o.type === 'createTable') {
          if (o.sectionIdx === sectionIdx && o.anchor
            && o.anchor.paraIdx === tableParaIdx && o.anchor.controlIdx === controlIdx) {
            o.expectedRows = (o.expectedRows ?? o.rows) + dRows;
            o.expectedCols = (o.expectedCols ?? o.cols) + dCols;
          }
        } else if (isTableTargetOp(o) && o.type !== 'deleteTable') {
          if (o.sectionIdx === sectionIdx && o.tableParaIdx === tableParaIdx
            && o.controlIdx === controlIdx && o.dims) {
            o.dims = { rowCount: o.dims.rowCount + dRows, colCount: o.dims.colCount + dCols };
          }
        }
      }
    }
  }

  /**
   * 같은 문단의 컨트롤 목록에 컨트롤이 삽입/삭제되면(수식은 위치 기반 splice)
   * 그 문단을 참조하는 모든 pending 컨트롤 인덱스를 이동한다. — 리뷰 확정
   * 결함 수정: 인덱스를 안 움직이면 드리프트 프로브가 엉뚱한 컨트롤을 읽어
   * 멀쩡한 op 을 폐기하거나(개체 잔류) 사용자 개체를 지울 수 있다.
   */
  private shiftControlIdxRefs(
    sectionIdx: number, paraIdx: number, atIdx: number, delta: 1 | -1, exclude?: ObjectOp,
    reinsertedAfterSeq?: number,
  ): void {
    const hit = (idx: number, op: PendingOp): boolean => {
      if (delta === -1) return idx > atIdx;
      if (idx !== atIdx) return idx > atIdx;
      // 지워졌던 컨트롤이 되살아난 자리: 그 컨트롤을 가리키던 더 이른 op 은 그대로 둔다
      return reinsertedAfterSeq === undefined || (op.seq ?? 0) > reinsertedAfterSeq;
    };
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind === 'field') continue;
        if (op.kind === 'object') {
          const o = op.obj;
          if (o === exclude) continue;
          if ((o.type === 'createTable' || o.type === 'insertShape' || (o.type === 'insertImage' && !o.cell))
            && o.sectionIdx === sectionIdx && o.anchor
            && o.anchor.paraIdx === paraIdx && hit(o.anchor.controlIdx, op)) {
            o.anchor = { ...o.anchor, controlIdx: o.anchor.controlIdx + delta };
          } else if (o.type === 'insertEquation' && !o.cell
            && o.sectionIdx === sectionIdx && o.anchor
            && o.anchor.paraIdx === paraIdx && hit(o.anchor.controlIdx, op)) {
            o.anchor = { ...o.anchor, controlIdx: o.anchor.controlIdx + delta };
          } else if (isTableTargetOp(o)
            && o.sectionIdx === sectionIdx && o.tableParaIdx === paraIdx && hit(o.controlIdx, op)) {
            o.controlIdx += delta;
          } else if ((o.type === 'editObject' || o.type === 'deleteObject') && !o.cell
            && o.sectionIdx === sectionIdx && o.paraIdx === paraIdx && hit(o.controlIdx, op)) {
            o.controlIdx += delta;
          } else if ((o.type === 'paraFormat' || o.type === 'applyStyle' || o.type === 'insertEquation'
            || o.type === 'insertImage' || o.type === 'editObject' || o.type === 'deleteObject')
            && o.cell && o.sectionIdx === sectionIdx
            && o.cell.paraIdx === paraIdx && hit(o.cell.controlIdx, op)) {
            o.cell = this.shiftCellControl(o.cell, delta);
          } else if (o.type === 'insertNote'
            && o.sectionIdx === sectionIdx && o.anchor
            && o.anchor.paraIdx === paraIdx && hit(o.anchor.controlIdx, op)) {
            o.anchor = { ...o.anchor, controlIdx: o.anchor.controlIdx + delta };
          } else if (o.type === 'setNoteText'
            && o.sectionIdx === sectionIdx && o.paraIdx === paraIdx && hit(o.controlIdx, op)) {
            o.controlIdx += delta;
          } else if (o.type === 'bookmark'
            && o.sectionIdx === sectionIdx && o.paraIdx === paraIdx
            && o.ctrlIdx !== undefined && hit(o.ctrlIdx, op)) {
            o.ctrlIdx += delta;
          }
          continue;
        }
        if (op.kind === 'template') continue;
        const c = op.range.cell;
        if (c && op.range.sectionIdx === sectionIdx && c.paraIdx === paraIdx && hit(c.controlIdx, op)) {
          op.range.cell = this.shiftCellControl(c, delta);
        }
      }
    }
  }

  private shiftCellControl(cell: CellAddr, delta: 1 | -1): CellAddr {
    return {
      ...cell,
      controlIdx: cell.controlIdx + delta,
      ...(cell.path ? { path: cell.path.map((entry, index) => index === 0
        ? { ...entry, controlIndex: entry.controlIndex + delta }
        : entry) } : {}),
    };
  }

  /** 셀에 멀티라인 텍스트 채우기 (createTable cells[][] 전용 — 새 표라 셀 문단은 1개) */
  private fillCellText(sec: number, anchor: ObjectAnchor, cellIdx: number, text: string): void {
    const wasm = this.deps.wasm;
    const lines = text.split('\n');
    let para = 0;
    let off = 0;
    if (lines[0].length > 0) {
      // 오프셋은 스칼라 단위 — wasm 이 반환하는 charOffset 을 우선 쓴다
      const res = this.parseOk(wasm.insertTextInCell(sec, anchor.paraIdx, anchor.controlIdx, cellIdx, 0, 0, lines[0]), 'insertTextInCell');
      off = typeof res.charOffset === 'number' ? res.charOffset : scalarLen(lines[0]);
    }
    for (let i = 1; i < lines.length; i++) {
      this.parseOk(wasm.splitParagraphInCellLogical(sec, anchor.paraIdx, anchor.controlIdx, cellIdx, para, off), 'splitParagraphInCellLogical');
      para += 1;
      off = 0;
      if (lines[i].length > 0) {
        const res = this.parseOk(wasm.insertTextInCell(sec, anchor.paraIdx, anchor.controlIdx, cellIdx, para, 0, lines[i]), 'insertTextInCell');
        off = typeof res.charOffset === 'number' ? res.charOffset : scalarLen(lines[i]);
      }
    }
  }

  /**
   * HF 전체 내용을 한 번의 범위 치환으로 쓴다 — lines 의 각 항목이 한 문단이 되고,
   * pageNumber 가 있으면 그 템플릿이 마지막 문단으로 붙는다. `{n}`/`{total}` 은
   * 엔진 필드 문자(\u{0015}/\u{0016})로 치환해 텍스트로 넣는다 (insertTextAt 은
   * 제어 문자를 그대로 저장하고 렌더러가 쪽번호로 해석한다).
   */
  private writeHeaderFooterContent(
    obj: Extract<ObjectOp, { type: 'headerFooter' }>,
  ): void {
    const wasm = this.deps.wasm;
    const paras = obj.lines.map(hfFieldMarkers);
    if (obj.pageNumber) paras.push(hfFieldMarkers(obj.pageNumber.template));
    const first = JSON.parse(
      wasm.getHeaderFooterParaInfo(obj.sectionIdx, obj.isHeader, obj.applyTo, 0),
    ) as { paraCount?: number; charCount?: number };
    const paraCount = Math.max(1, first?.paraCount ?? 1);
    const lastLen = paraCount === 1
      ? (first?.charCount ?? 0)
      : ((JSON.parse(
        wasm.getHeaderFooterParaInfo(obj.sectionIdx, obj.isHeader, obj.applyTo, paraCount - 1),
      ) as { charCount?: number })?.charCount ?? 0);
    const res = wasm.replaceRangeInHeaderFooter(
      obj.sectionIdx, obj.isHeader, obj.applyTo, 0, 0, paraCount - 1, lastLen, paras.join('\n'),
    );
    if (res?.ok === false) throw new AgentToolError('RPC_ERROR', 'replaceRangeInHeaderFooter failed');
    if (obj.pageNumber) {
      try {
        wasm.applyParaFormatInHf(
          obj.sectionIdx, obj.isHeader, obj.applyTo, paras.length - 1,
          JSON.stringify({ alignment: obj.pageNumber.align }),
        );
      } catch { /* 정렬은 best-effort */ }
    }
  }

  /**
   * 텍스트 오프셋 → 편집 캐럿 좌표(인라인 개체 = 1칸). 앞선 인라인 개체만큼 보정하지
   * 않으면 개체가 있는 문단에서 엉뚱한 글자 앞이 잘린다. 같은 자리의 개체는 캐럿
   * 뒤에 남는다 — 텍스트는 개체 앞에 들어간다는 OFFSET_CAVEAT 규칙과 같다.
   */
  private caretOffset(sec: number, para: number, textOffset: number, cell?: CellAddr): number {
    const wasm = this.deps.wasm;
    try {
      if (cell) {
        return typeof wasm.textToLogicalOffsetInCellByPath === 'function'
          ? wasm.textToLogicalOffsetInCellByPath(sec, cell.paraIdx, this.charShapeCellPath(cell, para), textOffset)
          : textOffset;
      }
      return typeof wasm.textToLogicalOffset === 'function' ? wasm.textToLogicalOffset(sec, para, textOffset) : textOffset;
    } catch {
      return textOffset;
    }
  }

  /** §5.4 멀티라인 삽입 — 실패 시 부분 적용분을 best-effort 롤백한다 */
  private performInsert(sec: number, para: number, off: number, text: string, cell?: CellAddr):
      { range: DocRange; addedParas: number } {
    const wasm = this.deps.wasm;
    const lines = text.split('\n');
    let curPara = para;
    let curOff = off;
    // wasm 은 삽입 후 오프셋을 스칼라 단위로 반환한다 — JS .length(UTF-16) 대신
    // 반환값을 쓰면 astral 문자에서도 오프셋이 어긋나지 않는다.
    const insertLine = (p: number, o: number, line: string): number => {
      const res = cell?.path
        ? this.parseOk(
          wasm.insertTextInCellByPath(sec, cell.paraIdx, this.cellPathAt(cell, p), o, line),
          'insertTextInCellByPath',
        )
        : cell
        ? this.parseOk(
          wasm.insertTextInCell(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, p, o, line),
          'insertTextInCell',
        )
        : this.parseOk(wasm.insertText(sec, p, o, line), 'insertText');
      return typeof res.charOffset === 'number' ? res.charOffset : o + scalarLen(line);
    };
    // 에이전트의 `\n`은 한 논리 삽입 안의 줄 경계다. 논리 분할은 Enter 상속에서
    // 강제 쪽/단 나눔만 빼고 엔진이 처리하므로, 분할 뒤 교정 서식 호출이 없다.
    // 분할 API 는 편집 캐럿 좌표(인라인 개체 = 1칸)를 받으므로 텍스트 오프셋을 바꿔 넘긴다.
    const splitPara = (p: number, o: number) => {
      const at = this.caretOffset(sec, p, o, cell);
      if (cell?.path) {
        this.parseOk(
          wasm.splitParagraphInCellByPath(sec, cell.paraIdx, this.cellPathAt(cell, p), at),
          'splitParagraphInCellByPath',
        );
      } else if (cell) {
        this.parseOk(
          wasm.splitParagraphInCellLogical(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, p, at),
          'splitParagraphInCellLogical',
        );
      } else {
        this.parseOk(wasm.splitParagraphLogical(sec, p, at), 'splitParagraphLogical');
      }
    };
    const insertLines = () => {
      if (lines[0].length > 0) {
        curOff = insertLine(para, off, lines[0]);
      }
      for (let i = 1; i < lines.length; i++) {
        splitPara(curPara, curOff);
        curPara += 1;
        curOff = 0;
        if (lines[i].length > 0) {
          curOff = insertLine(curPara, 0, lines[i]);
        }
      }
    };
    try {
      // 각 줄의 insert/split은 IR 좌표만 사용한다. 실패 시 배치를 닫은 뒤 역연산한다.
      // 한 줄 삽입은 기존 단일 명령 페이지네이션을 그대로 사용한다.
      if (lines.length > 1 && !cell && wasm.withBodyTextPaginationBatch) {
        wasm.withBodyTextPaginationBatch(sec, insertLines);
      } else insertLines();
    } catch (e) {
      if (curPara !== para || curOff !== off) {
        try {
          this.deleteRangeRaw({
            sectionIdx: sec, cell, startParaIdx: para, startCharOffset: off,
            endParaIdx: curPara, endCharOffset: curOff,
          });
        } catch { /* best effort */ }
      }
      throw e;
    }
    const range: DocRange = {
      sectionIdx: sec, startParaIdx: para, startCharOffset: off,
      endParaIdx: curPara, endCharOffset: curOff,
    };
    if (cell) range.cell = cell;
    return { range, addedParas: lines.length - 1 };
  }

  private captureRangeText(range: DocRange): string {
    const sec = range.sectionIdx;
    const paraCount = this.containerParaCount(sec, range.cell);
    if (range.startParaIdx >= paraCount || range.endParaIdx >= paraCount) {
      throw new AgentToolError('INVALID_ARGS',
        `paragraph index out of bounds (container has ${paraCount} paragraphs)`);
    }
    const parts: string[] = [];
    for (let p = range.startParaIdx; p <= range.endParaIdx; p++) {
      const len = this.containerParaLen(sec, p, range.cell);
      const from = p === range.startParaIdx ? range.startCharOffset : 0;
      const to = p === range.endParaIdx ? range.endCharOffset : len;
      if (from > len || to > len) {
        throw new AgentToolError('INVALID_ARGS',
          `char offset out of bounds (paragraph ${p} has length ${len})`);
      }
      parts.push(to > from ? this.containerText(sec, p, from, to - from, range.cell) : '');
    }
    return parts.join('\n');
  }

  /** 범위 내 현재 텍스트를 읽는다 — 검증용 (읽기 실패/범위 이탈 시 null) */
  private readRangeText(range: DocRange): string | null {
    try {
      const sec = range.sectionIdx;
      const paraCount = this.containerParaCount(sec, range.cell);
      if (range.startParaIdx >= paraCount || range.endParaIdx >= paraCount) return null;
      const parts: string[] = [];
      for (let p = range.startParaIdx; p <= range.endParaIdx; p++) {
        const len = this.containerParaLen(sec, p, range.cell);
        const from = p === range.startParaIdx ? range.startCharOffset : 0;
        const to = p === range.endParaIdx ? range.endCharOffset : len;
        if (from > len || to > len || from > to) return null;
        parts.push(to > from ? this.containerText(sec, p, from, to - from, range.cell) : '');
      }
      return parts.join('\n');
    } catch {
      return null;
    }
  }

  /**
   * 이 op 이후 적용된 텍스트 op(insert/replace)이 이 범위 안에 중첩된 경우 그
   * 기여분을 반영한 기대 텍스트를 만든다 — 에이전트 자신의 나중 편집으로 범위가
   * 커진 것을 드리프트로 오판하지 않기 위함이다. 사용자 편집은 여기에 기록되지
   * 않으므로 여전히 불일치(=드리프트)로 잡힌다. reverted 는 이미 되돌린 op 이라 기여하지 않는다.
   */
  private expectedOpText(
    op: Extract<PendingOp, { kind: 'insert' | 'replace' | 'format' }>,
    base: string,
    reverted?: ReadonlySet<PendingOp>,
  ): string {
    interface Contrib { paraIdx: number; charOffset: number; ins: string; delLen: number; seq: number }
    const r = op.range;
    const contribs: Contrib[] = [];
    for (const set of this.sets) {
      for (const cand of set.ops) {
        if (cand === op || (cand.seq ?? 0) <= (op.seq ?? 0) || reverted?.has(cand)) continue;
        if (cand.kind !== 'insert' && cand.kind !== 'replace') continue;
        const cr = cand.range;
        if (cr.sectionIdx !== r.sectionIdx || !sameCell(cr.cell, r.cell)) continue;
        // 기여 시작점이 범위 남쪽이어야 한다 — 끝 경계의 삽입은 범위 밖이다
        const afterStart = cr.startParaIdx > r.startParaIdx
          || (cr.startParaIdx === r.startParaIdx && cr.startCharOffset >= r.startCharOffset);
        const withinEnd = cr.endParaIdx < r.endParaIdx
          || (cr.endParaIdx === r.endParaIdx && cr.endCharOffset <= r.endCharOffset);
        if (!afterStart || !withinEnd) continue;
        contribs.push({
          paraIdx: cr.startParaIdx, charOffset: cr.startCharOffset,
          ins: cand.text, delLen: cand.kind === 'replace' ? scalarLen(cand.deletedText) : 0,
          seq: cand.seq ?? 0,
        });
      }
    }
    if (contribs.length === 0) return base;
    // 문서 좌표 내림차순(같은 지점이면 등록 순)으로 splice 해야 앞쪽 오프셋이 안 밀린다
    contribs.sort((a, b) => b.paraIdx - a.paraIdx || b.charOffset - a.charOffset || a.seq - b.seq);
    let chars = [...base];
    for (const c of contribs) {
      const lines = chars.join('').split('\n');
      const relPara = c.paraIdx - r.startParaIdx;
      if (relPara < 0 || relPara >= lines.length) continue;
      let idx = 0;
      for (let i = 0; i < relPara; i++) idx += [...lines[i]].length + 1;
      idx += relPara === 0 ? c.charOffset - r.startCharOffset : c.charOffset;
      if (idx < 0 || idx > chars.length) continue;
      chars.splice(idx, c.delLen, ...[...c.ins]);
    }
    return chars.join('');
  }

  /**
   * approve/reject 검증: 기대 텍스트가 아직 그 자리에 있는가.
   * 멀티 문단 op 는 첫 줄이 아니라 전체 텍스트를 비교한다.
   */
  private verifyOpText(
    op: Extract<PendingOp, { kind: 'insert' | 'replace' | 'format' }>, reverted?: ReadonlySet<PendingOp>,
  ): boolean {
    // format 은 등록 시점 텍스트 지문이 없으면(캡처 실패) 검증을 건너뛴다 (기존 동작)
    if (op.kind === 'format' && op.text === undefined) return true;
    const base = op.kind === 'format' ? op.text! : op.text;
    const current = this.readRangeText(op.range);
    if (current === null) return false;
    return current === this.expectedOpText(op, base, reverted);
  }

  /** 필드 되돌림 전 드리프트 프로브: 현재 값이 여전히 newValue 인가 (사용자 수정 시 되돌리지 않음) */
  private verifyFieldOp(op: Extract<PendingOp, { kind: 'field' }>): boolean {
    try {
      const fields = this.deps.wasm.getFieldList();
      const found = fields.find((f) => f.name === op.name);
      if (!found) return false;
      return found.value === op.newValue;
    } catch {
      return false;
    }
  }

  /** op 이 아직 기록한 자리에 그대로 있는가 — 어긋났으면 그 원인 (없으면 null) */
  private driftCause(op: PendingOp, reverted?: ReadonlySet<PendingOp>): PendingDropCause | null {
    switch (op.kind) {
      case 'insert': case 'replace': case 'format':
        return this.verifyOpText(op, reverted) ? null : 'text-changed';
      case 'field':
        return this.verifyFieldOp(op) ? null : 'field-changed';
      case 'object':
        return this.objectDriftCause(op.obj);
      case 'template':
        return null;
    }
  }

  /**
   * 드리프트된 op 을 kept/dropped 로 분할한다 (set.ops 는 호출자가 갱신한다).
   * dropped 의 미리보기는 사용자가 건드린 것으로 간주해 문서에 남긴다.
   *
   * 같은 set 의 나중 op 이 문단 보관본으로 되돌릴 문단을 이 op 이 건드렸다면 검증을
   * 되돌림 시점으로 미룬다(deferred) — 보관본 복원이 그 문단을 이 op 의 적용 직후
   * 상태로 돌려놓은 뒤에야 제대로 판정할 수 있다 (예: 셀을 채운 뒤 표 삭제).
   */
  private partitionDriftedOps(set: PendingChangeSet): {
    kept: PendingOp[]; dropped: PendingOp[];
    causes: Map<PendingOp, PendingDropCause>; deferred: Set<PendingOp>;
  } {
    const kept: PendingOp[] = [];
    const dropped: PendingOp[] = [];
    const causes = new Map<PendingOp, PendingDropCause>();
    const deferred = new Set<PendingOp>();
    const captures = set.ops.flatMap((op) => {
      if (op.kind !== 'object' || !op.paraCapture) return [];
      const host = this.captureHost(op.obj);
      return host === null ? [] : [{ seq: op.seq ?? 0, sectionIdx: op.obj.sectionIdx, host }];
    });
    // 텍스트가 어긋났지만 그 사이 사용자 편집이 없었던 op — 나중 에이전트 op 이
    // 겹쳐 덮어쓴 것이다. 나중 op 이 모두 함께 되돌려지면 적용 직후 범위로 정확히
    // 되돌릴 수 있으므로 드리프트로 남기지 않는다.
    const overwritten = new Set<PendingOp>();
    // 같은 set 의 나중 엔진 배치는 문서 스냅샷으로 되돌아간다 — 그 앞 op 은 배치가
    // 바꿨을 수 있으므로 배치가 되돌아간 뒤에 판정한다.
    const lastBatchSeq = Math.max(0, ...set.ops.flatMap((op) =>
      op.kind === 'object' && op.obj.type === 'engineBatch' ? [op.seq ?? 0] : []));
    for (const op of set.ops) {
      if ((op.seq ?? 0) < lastBatchSeq
        || captures.some((c) => c.seq > (op.seq ?? 0) && this.opTouchesBodyPara(op, c.sectionIdx, c.host))) {
        deferred.add(op);
        kept.push(op);
        continue;
      }
      const cause = this.driftCause(op);
      if (cause === null) {
        // Template previews hold a full-document baseline while direct user and agent
        // writes are locked. Always keep them revertible; dropping one would strand
        // the structural preview in the document without approval or undo history.
        kept.push(op);
        continue;
      }
      if ((op.kind === 'insert' || op.kind === 'replace' || op.kind === 'format')
        && op.applied?.overwritten === true && this.appliedAtIsCurrent(op, this.userEditSeq)) {
        overwritten.add(op);
        kept.push(op);
        continue;
      }
      causes.set(op, cause);
      dropped.push(op);
    }
    // 덮어쓴 나중 op 이 남는다면(드리프트/다른 set) 정확한 되돌림이 불가능하다.
    for (let moved = true; moved;) {
      moved = false;
      for (const op of overwritten) {
        if (!this.hasLaterAppliedOpsOutside(op, kept, dropped)) continue;
        overwritten.delete(op);
        kept.splice(kept.indexOf(op), 1);
        causes.set(op, 'text-changed');
        dropped.push(op);
        moved = true;
      }
    }
    if (dropped.length > 1) dropped.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return { kept, dropped, causes, deferred };
  }

  private appliedAt(range: DocRange): PendingAppliedAt {
    return { range: structuredClone(range), userEditSeq: this.userEditSeq, settledSetSeq: this.settledSetSeq };
  }

  /** 적용 이후 사용자 편집도, 다른 set 의 확정도 없었는가. */
  private appliedAtIsCurrent(
    op: Extract<PendingOp, { kind: 'insert' | 'replace' | 'format' }>, userEditSeqNow: number,
  ): boolean {
    return op.applied !== undefined
      && op.applied.userEditSeq === userEditSeqNow
      && op.applied.settledSetSeq === this.settledSetSeq;
  }

  /**
   * 역순 되돌림 중 나중 op 이 모두 되돌려졌다면 문서는 이 op 의 적용 직후 상태다.
   * 그때 live range 대신 적용 직후 범위를 쓴다 — 나중 op 이 이 범위를 덮어써
   * live range 가 무너졌어도 정확히 되돌린다. 텍스트가 다르면 live range 를 유지한다.
   */
  private restoreAppliedRange(
    op: Extract<PendingOp, { kind: 'insert' | 'replace' | 'format' }>,
    revertSet: PendingOp[], keepPreviewsOf: PendingOp[], userEditSeqNow: number,
  ): void {
    const applied = op.applied;
    if (!applied || op.text === undefined || !this.appliedAtIsCurrent(op, userEditSeqNow)) return;
    if (this.hasLaterAppliedOpsOutside(op, revertSet, keepPreviewsOf)) return;
    if (this.readRangeText(applied.range) !== op.text) return;
    const range = op.range;
    range.sectionIdx = applied.range.sectionIdx;
    range.startParaIdx = applied.range.startParaIdx;
    range.startCharOffset = applied.range.startCharOffset;
    range.endParaIdx = applied.range.endParaIdx;
    range.endCharOffset = applied.range.endCharOffset;
    if (applied.range.cell) range.cell = structuredClone(applied.range.cell);
    else delete range.cell;
  }

  /**
   * 적용된 op 을 역순으로 raw wasm 으로 되돌린다 (이벤트 없음).
   * keepPreviewsOf = 되돌리지 않고 문서에 남길(드리프트) op — 스냅샷/문단 보관본
   * 복원이 이들의 미리보기를 지우지 않도록 안전 판별에 쓰인다.
   * userEditSeqNow = 되돌림 시작 시점의 사용자 편집 카운터 (호출자가 변이 전에
   * 한 번만 샘플링해 넘긴다). 스냅샷/보관본 복원 가부 판정에 쓰인다.
   * deferred = 검증을 되돌림 직전으로 미룬 op (partitionDriftedOps).
   * 반환: 되돌리지 못한 op id → 원인.
   */
  private revertAppliedOps(
    ops: PendingOp[], keepPreviewsOf: PendingOp[] = [], userEditSeqNow: number = this.userEditSeq,
    deferred?: ReadonlySet<PendingOp>,
  ): Map<string, PendingDropCause> {
    const wasm = this.deps.wasm;
    const failed = new Map<string, PendingDropCause>();
    // 이미 되돌린 나중 op — 미룬 검증에서 그 텍스트 기여를 기대값에 넣지 않는다
    const reverted = new Set<PendingOp>();
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (deferred?.has(op)) {
        // 나중 op 이 덮어쓴 범위는 그 op 들이 모두 되돌아간 지금 적용 시점 범위로 돌려 놓고 잰다
        if (op.kind === 'insert' || op.kind === 'replace' || op.kind === 'format') {
          this.restoreAppliedRange(op, ops, keepPreviewsOf, userEditSeqNow);
        }
        const cause = this.driftCause(op, reverted);
        if (cause !== null) {
          failed.set(op.id, cause);
          continue;
        }
      }
      try {
        if (op.kind === 'insert') {
          this.restoreAppliedRange(op, ops, keepPreviewsOf, userEditSeqNow);
          const r = { ...op.range };
          const fixControls = r.endParaIdx > r.startParaIdx
            ? this.trackControls(r.sectionIdx, r.startParaIdx, r.endParaIdx, r.cell)
            : undefined;
          const res = this.deleteRangeRaw(r);
          if (res?.ok !== true) {
            failed.set(op.id, 'revert-failed');
            continue;
          }
          // 자신 포함 모든 pending 경계를 문서의 임시 before 상태에 맞춘다.
          this.shiftAllAfterDelete(r);
          fixControls?.(r.startParaIdx);
          this.restoreSplitParagraph(op, r, ops, keepPreviewsOf);
        } else if (op.kind === 'replace') {
          this.revertReplaceOp(op, ops, keepPreviewsOf, userEditSeqNow);
        } else if (op.kind === 'format') {
          this.restoreAppliedRange(op, ops, keepPreviewsOf, userEditSeqNow);
          this.applyFormatRaw(op.range, op.inverse);
        } else if (op.kind === 'field') {
          wasm.setFieldValueByName(op.name, op.oldValue);
        } else if (op.kind === 'template') {
          if (op.snapshotId === null) throw new Error('template snapshot is unavailable');
          wasm.restoreSnapshot(op.snapshotId);
        } else if (!this.revertObject(op, ops, keepPreviewsOf, userEditSeqNow)) {
          failed.set(op.id, 'revert-failed');
          continue;
        }
        reverted.add(op);
      } catch (err) {
        console.warn('[pending-edits] revert failed for op', op.id, err);
        failed.set(op.id, 'revert-failed');
      }
    }
    return failed;
  }

  /**
   * 객체 op 되돌림: 문단 보관본 → 문서 스냅샷 → 역연산 순으로 시도한다.
   * 보관본/스냅샷은 문단(문서) 전체를 덮으므로 각각의 안전 조건을 먼저 확인한다.
   */
  private revertObject(
    op: Extract<PendingOp, { kind: 'object' }>, revertSet: PendingOp[],
    keepPreviewsOf: PendingOp[], userEditSeqNow: number,
  ): boolean {
    const wasm = this.deps.wasm;
    const obj = op.obj;
    const postDims = this.tableDims(obj);
    const host = op.paraCapture ? this.captureHost(obj) : null;
    if (op.paraCapture && host !== null
      && this.canRestoreParagraph(op, host, revertSet, keepPreviewsOf, userEditSeqNow)) {
      try {
        wasm.restoreCapturedParagraph(op.paraCapture.id, obj.sectionIdx, host);
        this.afterObjectRestored(op, postDims);
        return true;
      } catch (error) {
        console.warn('[pending-edits] paragraph restore failed; trying other inverses', error);
      }
    }
    if (op.snapshotId != null && op.userEditSeqAtSnapshot === userEditSeqNow
      && op.settledSetSeqAtSnapshot === this.settledSetSeq
      && !this.hasLaterAppliedOpsOutside(op, revertSet, keepPreviewsOf)) {
      try {
        wasm.restoreSnapshot(op.snapshotId);
        this.afterObjectRestored(op, postDims);
        return true;
      } catch (error) {
        console.warn('[pending-edits] object snapshot restore failed; falling back to inverse ops', error);
      }
    }
    return this.revertObjectOp(obj, op.seq);
  }

  /**
   * 문단을 나눈 삽입을 병합으로 되돌린 뒤, 내용이 삽입 전과 같으면 보관한 원래 문단으로
   * 바꿔 줄 배치(표·그림이 놓인 줄 높이 포함)까지 원래대로 돌린다. 그 문단을 바꾼 나중
   * op 이 되돌림 대상 밖에 남아 있으면 건드리지 않는다.
   */
  private restoreSplitParagraph(
    op: Extract<PendingOp, { kind: 'insert' }>, merged: DocRange,
    revertSet: PendingOp[], keepPreviewsOf: PendingOp[],
  ): void {
    const capture = op.paraCapture;
    if (!capture || merged.cell) return;
    const sec = merged.sectionIdx;
    const para = merged.startParaIdx;
    const isLaterOutside = (cand: PendingOp): boolean =>
      cand !== op && (cand.seq ?? 0) > (op.seq ?? 0) && !revertSet.includes(cand)
      && this.opTouchesBodyPara(cand, sec, para);
    if (this.sets.some((set) => set.ops.some(isLaterOutside)) || keepPreviewsOf.some(isLaterOutside)) return;
    if (this.paragraphDigest(sec, para) !== capture.digest) return;
    try {
      this.deps.wasm.restoreCapturedParagraph(capture.id, sec, para);
    } catch (error) {
      console.warn('[pending-edits] split paragraph restore failed; keeping the merged paragraph', error);
    }
  }

  /** 보관본/스냅샷으로 되돌린 뒤 다른 op 의 컨트롤 인덱스와 기대 표 크기를 맞춘다 */
  private afterObjectRestored(
    op: Extract<PendingOp, { kind: 'object' }>, postDims: { rowCount: number; colCount: number } | null,
  ): void {
    const obj = op.obj;
    switch (obj.type) {
      case 'createTable':
      case 'insertShape':
        if (obj.anchor) this.shiftControlIdxRefs(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx, -1, obj);
        return;
      case 'deleteObject':
        if (obj.cell) this.shiftCellObjectRefsAt(obj.cell, obj.paraIdx, obj.controlIdx, 1, obj, op.seq ?? 0);
        else this.shiftControlIdxRefs(obj.sectionIdx, obj.paraIdx, obj.controlIdx, 1, obj, op.seq ?? 0);
        return;
      case 'editObject':
        return;
      case 'engineBatch':
        // 스냅샷이 배치 전 문서로 돌아갔다 — 등록 때 민 다른 op 좌표를 거꾸로 되민다
        for (const s of [...obj.shifts].reverse()) this.shiftAllParagraphs(s.sectionIdx, s.from + s.delta, -s.delta, op);
        return;
      case 'insertImage':
      case 'insertEquation':
        if (!obj.anchor) return;
        if (obj.cell) this.shiftCellObjectRefs(obj, obj.anchor.controlIdx, -1);
        else this.shiftControlIdxRefs(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx, -1, obj);
        return;
      case 'deleteTable':
        this.shiftControlIdxRefs(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, 1, obj, op.seq ?? 0);
        return;
      default:
        this.adjustSiblingDims(obj, postDims, this.tableDims(obj));
    }
  }

  /**
   * replace op 되돌림. 기본은 변이 직전 스냅샷 복원(원본 텍스트+서식 정확히 복원).
   * 단, 스냅샷은 문서 전체 클론이라 복원하면 그 이후의 모든 변이가 사라진다.
   * 그러므로 (a) 이 op 이후 적용된 미리보기가 되돌림 대상 밖(다른 set, 드리프트
   * 잔류)에 남아 있거나, (b) 스냅샷 이후 사용자(비-에이전트) 편집이 한 번이라도
   * 있었으면 — pending 중 사용자 편집은 주소로 관측하지 않으므로 op 범위 밖의
   * 편집은 드리프트 검사로도 잡히지 않는다 — 범위-국소 역연산 폴백으로만 되돌린다.
   */
  private revertReplaceOp(
    op: Extract<PendingOp, { kind: 'replace' }>,
    revertSet: PendingOp[],
    keepPreviewsOf: PendingOp[],
    userEditSeqNow: number,
  ): void {
    const wasm = this.deps.wasm;
    this.restoreAppliedRange(op, revertSet, keepPreviewsOf, userEditSeqNow);
    const start: DocPoint = { paraIdx: op.range.startParaIdx, charOffset: op.range.startCharOffset };
    const reinsertShift = this.insertShiftFor(start, op.deletedText);
    const userEditedSinceSnapshot = (op.userEditSeqAtSnapshot ?? -1) !== userEditSeqNow;
    const sec = op.range.sectionIdx;
    if (op.snapshotId !== null && !userEditedSinceSnapshot
      && op.settledSetSeqAtSnapshot === this.settledSetSeq
      && !this.hasLaterAppliedOpsOutside(op, revertSet, keepPreviewsOf)) {
      try {
        // 스냅샷 복원 전후의 개체 배치를 한 번에 잰다 (삽입분 제거 + 원본 재삽입과 동치)
        const fixControls = this.trackControls(sec, op.range.startParaIdx, op.range.endParaIdx, op.range.cell);
        wasm.restoreSnapshot(op.snapshotId);
        // 문서가 "원본 복원" 상태로 바뀌었으므로 다른 op 들의 좌표를 맞춘다
        // (삽입분 제거 + 원본 재삽입과 동치).
        this.shiftAllAfterDelete(op.range, op);
        this.shiftAllAfterInsert(sec, reinsertShift, op, op.range.cell);
        fixControls?.(reinsertShift.endParaIdx);
        return;
      } catch (err) {
        console.warn('[pending-edits] replace snapshot restore failed; falling back to inverse ops', err);
      }
    }
    // 폴백: 삽입 텍스트를 지우고 원본 텍스트+캡처 서식을 다시 삽입한다
    const fixDeleted = op.range.endParaIdx > op.range.startParaIdx
      ? this.trackControls(sec, op.range.startParaIdx, op.range.endParaIdx, op.range.cell)
      : undefined;
    const res = this.deleteRangeRaw(op.range);
    if (res?.ok !== true) throw new AgentToolError('RPC_ERROR', 'replace revert: deleteRange failed');
    this.shiftAllAfterDelete(op.range, op);
    fixDeleted?.(op.range.startParaIdx);
    const fixInserted = op.deletedText.includes('\n')
      ? this.trackControls(sec, start.paraIdx, start.paraIdx, op.range.cell)
      : undefined;
    if (op.deletedText.length > 0) {
      const ins = this.performInsert(op.range.sectionIdx, start.paraIdx, start.charOffset, op.deletedText, op.range.cell);
      if (op.charShapeRuns) this.applyCharShapeRuns(ins.range, op.deletedText, op.charShapeRuns);
      else if (op.charShapeId !== null) this.applyCharShapeToRange(ins.range, op.charShapeId);
      // 원본 문단 서식 복원 (splitParagraph 는 시작 문단 모양을 물려주므로 줄별로 덮는다)
      for (let i = 0; i < op.paraShapeIds.length; i++) {
        const shapeId = op.paraShapeIds[i];
        if (shapeId < 0) continue;
        try {
          if (op.range.cell?.path) {
            wasm.setCellParaShapeIdByPath(
              op.range.sectionIdx, op.range.cell.paraIdx,
              this.cellPathAt(op.range.cell, start.paraIdx + i), shapeId,
            );
          } else if (op.range.cell) {
            wasm.setCellParaShapeId(
              op.range.sectionIdx, op.range.cell.paraIdx, op.range.cell.controlIdx, op.range.cell.cellIdx,
              start.paraIdx + i, shapeId,
            );
          } else {
            wasm.setParaShapeId(op.range.sectionIdx, start.paraIdx + i, shapeId);
          }
        } catch { /* best effort */ }
      }
    }
    this.shiftAllAfterInsert(sec, reinsertShift, op, op.range.cell);
    fixInserted?.(reinsertShift.endParaIdx);
  }

  /** 텍스트를 지점에 삽입했을 때의 shift 서술자 (스칼라 단위) */
  private insertShiftFor(start: DocPoint, text: string): InsertShift {
    const lines = text.split('\n');
    const addedParas = lines.length - 1;
    const lastLen = scalarLen(lines[lines.length - 1]);
    return {
      paraIdx: start.paraIdx,
      charOffset: start.charOffset,
      addedParas,
      endParaIdx: start.paraIdx + addedParas,
      endCharOffset: addedParas === 0 ? start.charOffset + lastLen : lastLen,
      textLen: scalarLen(text),
    };
  }

  /**
   * 이 op 이후(seq 가 더 큰) 적용된 미리보기가 되돌림 대상 밖에 남아 있는가 —
   * 있으면 스냅샷 복원이 그 미리보기까지 지우므로 폴백 해야 한다.
   */
  private hasLaterAppliedOpsOutside(
    op: PendingOp, revertSet: PendingOp[], keepPreviewsOf: PendingOp[],
  ): boolean {
    const isLaterApplied = (cand: PendingOp): boolean =>
      cand !== op && (cand.seq ?? 0) > (op.seq ?? 0) && !revertSet.includes(cand);
    for (const set of this.sets) {
      for (const cand of set.ops) {
        if (isLaterApplied(cand)) return true;
      }
    }
    for (const cand of keepPreviewsOf) {
      if (isLaterApplied(cand)) return true;
    }
    return false;
  }

  private captureCharShapeRuns(range: DocRange): CharShapeRun[] | undefined {
    const wasm = this.deps.wasm;
    // Older bridges and test doubles can only capture a single style.
    if (typeof wasm.getCharShapeRuns !== 'function'
      || typeof wasm.getCharShapeRunsInCellByPath !== 'function') return undefined;
    const runs: CharShapeRun[] = [];
    let offset = 0;
    for (let p = range.startParaIdx; p <= range.endParaIdx; p++) {
      const from = p === range.startParaIdx ? range.startCharOffset : 0;
      const to = p === range.endParaIdx ? range.endCharOffset : this.containerParaLen(range.sectionIdx, p, range.cell);
      const path = range.cell ? this.charShapeCellPath(range.cell, p) : '';
      const local = range.cell
        ? wasm.getCharShapeRunsInCellByPath(range.sectionIdx, range.cell.paraIdx, path, from, to)
        : wasm.getCharShapeRuns(range.sectionIdx, p, from, to);
      runs.push(...local.map(run => ({ ...run, startOffset: offset + run.startOffset - from, endOffset: offset + run.endOffset - from })));
      offset += to - from;
      if (p < range.endParaIdx) {
        const props = range.cell
          ? wasm.getCellCharPropertiesAtByPath(range.sectionIdx, range.cell.paraIdx, path, to)
          : wasm.getCharPropertiesAt(range.sectionIdx, p, to);
        if (typeof props.charShapeId !== 'number') throw new AgentToolError('RPC_ERROR', 'Missing paragraph character style');
        runs.push({ startOffset: offset, endOffset: offset + 1, charShapeId: props.charShapeId });
        offset++;
      }
    }
    return runs;
  }

  private charShapeCellPath(cell: CellAddr, para: number): string {
    return cell.path ? this.cellPathAt(cell, para) : JSON.stringify([
      { controlIndex: cell.controlIdx, cellIndex: cell.cellIdx, cellParaIndex: para },
    ]);
  }

  private applyCharShapeRuns(range: DocRange, text: string, runs: CharShapeRun[]): void {
    const wasm = this.deps.wasm;
    let offset = 0;
    for (const [i, line] of text.split('\n').entries()) {
      const length = scalarLen(line);
      const para = range.startParaIdx + i;
      const from = i === 0 ? range.startCharOffset : 0;
      if (length > 0) {
        const local = runs.filter(run => run.endOffset > offset && run.startOffset < offset + length)
          .map(run => ({
            startOffset: from + Math.max(run.startOffset, offset) - offset,
            endOffset: from + Math.min(run.endOffset, offset + length) - offset,
            charShapeId: run.charShapeId,
          }));
        const raw = range.cell
          ? wasm.setCharShapeRunsInCellByPath(range.sectionIdx, range.cell.paraIdx,
            this.charShapeCellPath(range.cell, para), from, from + length, local)
          : wasm.setCharShapeRuns(range.sectionIdx, para, from, from + length, local);
        this.parseOkLenient(raw, 'setCharShapeRuns');
      }
      offset += length + 1;
    }
  }

  /** 캡처한 글자 모양을 범위 전체에 적용한다 (멀티 문단은 문단별로 쪼갠다) */
  private applyCharShapeToRange(range: DocRange, charShapeId: number): void {
    const wasm = this.deps.wasm;
    for (let p = range.startParaIdx; p <= range.endParaIdx; p++) {
      const len = this.containerParaLen(range.sectionIdx, p, range.cell);
      const from = p === range.startParaIdx ? range.startCharOffset : 0;
      const to = p === range.endParaIdx ? range.endCharOffset : len;
      if (to <= from) continue;
      const raw = range.cell?.path
        ? wasm.setCharShapeIdInCellByPath(
          range.sectionIdx, range.cell.paraIdx, this.cellPathAt(range.cell, p),
          from, to, charShapeId,
        )
        : range.cell
        ? wasm.setCharShapeIdInCell(
          range.sectionIdx, range.cell.paraIdx, range.cell.controlIdx, range.cell.cellIdx,
          p, from, to, charShapeId,
        )
        : wasm.setCharShapeId(range.sectionIdx, p, from, to, charShapeId);
      this.parseOkLenient(raw, 'setCharShapeId');
    }
  }

  /** 객체 op 의 본문 기준 문단 인덱스 (요약/보관 대상 판별용 — 문단 좌표가 없으면 null) */
  private objectBodyParaIdx(obj: ObjectOp): number | null {
    switch (obj.type) {
      case 'createTable': case 'insertImage': case 'insertNote': case 'insertShape':
        return obj.anchor ? obj.anchor.paraIdx : obj.paraIdx;
      case 'insertEquation':
        return obj.cell ? obj.cell.paraIdx : (obj.anchor ? obj.anchor.paraIdx : obj.paraIdx);
      case 'editObject': case 'deleteObject':
        return obj.cell ? obj.cell.paraIdx : obj.paraIdx;
      case 'tableStructure': case 'deleteTable': case 'setCellProps': case 'setTableProps':
      case 'setColumnWidths': case 'fitToPage': case 'setZoneProps': case 'applyFormula': case 'setCaption':
        return obj.tableParaIdx;
      case 'paraFormat': case 'applyStyle':
        return obj.cell ? obj.cell.paraIdx : obj.paraIdx;
      case 'setNoteText': case 'bookmark':
        return obj.paraIdx;
      case 'headerFooter':
        return obj.hostParaIdx ?? null;
      case 'engineBatch':
        return obj.touched[0]?.paraStart ?? null;
      default:
        return null;
    }
  }

  /**
   * 본문 문단 좌표를 갖는 객체 op 필드들을 shift 함수에 통과시킨다. 개체 주소는 문단만
   * 텍스트 좌표 규칙으로 민다 — 문단 분할/병합으로 개체가 실제로 옮겨 간 자리는
   * trackControls 가 엔진 기준으로 다시 잡는다.
   */
  private shiftObjectOp(obj: ObjectOp, sectionIdx: number, shift: (p: DocPoint) => DocPoint, insCell?: CellAddr): void {
    if (obj.type === 'engineBatch') {
      // 표시용 구간만 민다 — 되돌림은 스냅샷이라 좌표가 필요 없다
      if (insCell) return;
      for (const span of obj.touched) {
        if (span.sectionIdx !== sectionIdx) continue;
        span.paraStart = shift({ paraIdx: span.paraStart, charOffset: 0 }).paraIdx;
        span.paraEnd = Math.max(span.paraStart, shift({ paraIdx: span.paraEnd, charOffset: 0 }).paraIdx);
      }
      return;
    }
    if (obj.sectionIdx !== sectionIdx) return;
    const shiftBody = (paraIdx: number, charOffset: number): DocPoint => shift({ paraIdx, charOffset });
    switch (obj.type) {
      case 'createTable': case 'insertImage': case 'insertEquation': case 'insertNote': case 'insertShape': {
        if (obj.type !== 'createTable' && obj.type !== 'insertNote' && obj.type !== 'insertShape' && obj.cell) {
          if (insCell) {
            // 같은 셀 내부 텍스트 변화만 셀 문단 좌표를 움직인다
            if (sameCell(obj.cell, insCell)) {
              const p = shift({ paraIdx: obj.paraIdx, charOffset: obj.charOffset });
              obj.paraIdx = p.paraIdx; obj.charOffset = p.charOffset;
            }
          } else {
            const host = shiftBody(obj.cell.paraIdx, 0).paraIdx;
            obj.cell = { ...obj.cell, paraIdx: host };
            if (obj.anchor) obj.anchor = { ...obj.anchor, paraIdx: host };
          }
          return;
        }
        if (insCell) return;
        const p = shiftBody(obj.paraIdx, obj.charOffset);
        obj.paraIdx = p.paraIdx; obj.charOffset = p.charOffset;
        if (obj.anchor) {
          const a = shiftBody(obj.anchor.paraIdx, obj.anchor.charOffset);
          obj.anchor = { ...obj.anchor, paraIdx: a.paraIdx, charOffset: a.charOffset };
        }
        return;
      }
      case 'paraFormat': case 'applyStyle': {
        if (obj.cell) {
          if (insCell) {
            // 같은 셀 내부의 텍스트 변화만 셀 문단 좌표를 움직인다
            if (sameCell(obj.cell, insCell)) {
              obj.paraIdx = shift({ paraIdx: obj.paraIdx, charOffset: obj.charOffset }).paraIdx;
              this.recaptureParaTextSample(obj);
            }
          } else {
            obj.cell = { ...obj.cell, paraIdx: shiftBody(obj.cell.paraIdx, 0).paraIdx };
          }
        } else if (!insCell) {
          const p = shiftBody(obj.paraIdx, obj.charOffset);
          obj.paraIdx = p.paraIdx; obj.charOffset = p.charOffset;
          // 같은 단계의 삽입/삭제가 이 문단 텍스트를 바꿨을 수 있다 — 지문을
          // 다시 캡처하지 않으면 되돌림 검증이 자신의 편집을 드리프트로 오판한다.
          this.recaptureParaTextSample(obj);
        }
        return;
      }
      case 'setNoteText':
        if (!insCell) obj.paraIdx = shiftBody(obj.paraIdx, 0).paraIdx;
        return;
      case 'editObject': case 'deleteObject': {
        // 개체의 글자 위치는 모른다 — 문단만 민다 (분할/병합은 trackControls 가 엔진 기준으로 다시 잡는다)
        if (obj.cell) {
          if (!insCell) obj.cell = { ...obj.cell, paraIdx: shiftBody(obj.cell.paraIdx, 0).paraIdx };
          else if (sameCell(obj.cell, insCell)) obj.paraIdx = shift({ paraIdx: obj.paraIdx, charOffset: 0 }).paraIdx;
          return;
        }
        if (insCell) return;
        const offset = obj.type === 'deleteObject' ? obj.removedOffset ?? 0 : 0;
        const p = shiftBody(obj.paraIdx, offset);
        obj.paraIdx = p.paraIdx;
        if (obj.type === 'deleteObject' && obj.removedOffset !== undefined) obj.removedOffset = p.charOffset;
        return;
      }
      case 'bookmark': {
        if (insCell) return;
        const p = shiftBody(obj.paraIdx, obj.charOffset ?? 0);
        obj.paraIdx = p.paraIdx;
        if (obj.charOffset !== undefined) obj.charOffset = p.charOffset;
        if (obj.prev) {
          const q = shiftBody(obj.prev.para, obj.prev.charPos);
          obj.prev = { ...obj.prev, para: q.paraIdx, charPos: q.charOffset };
        }
        return;
      }
      case 'headerFooter':
        // HF 컨트롤은 문단 분할에도 문단 시작에 남는다 — 문단 인덱스만 민다
        if (!insCell && obj.hostParaIdx !== undefined) obj.hostParaIdx = shiftBody(obj.hostParaIdx, 0).paraIdx;
        return;
      case 'pageLayout':
        return; // 문단 좌표가 없다
      default:
        if (!insCell) obj.tableParaIdx = shiftBody(obj.tableParaIdx, 0).paraIdx;
    }
  }

  /** shift 로 문단 좌표/내용이 바뀐 paraFormat/applyStyle op 의 텍스트 지문을 다시 캡처한다 */
  private recaptureParaTextSample(obj: Extract<ObjectOp, { type: 'paraFormat' | 'applyStyle' }>): void {
    if (obj.textSample === undefined) return;
    try {
      obj.textSample = this.paraTextSample(obj);
    } catch { /* 조회 실패 시 기존 지문 유지 */ }
  }

  private shiftAllAfterInsert(sectionIdx: number, ins: InsertShift, exclude?: PendingOp, cell?: CellAddr): void {
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op === exclude || op.kind === 'field' || op.kind === 'template') continue;
        if (op.kind === 'object') {
          this.shiftObjectOp(op.obj, sectionIdx, (p) => shiftPointAfterInsert(p, ins), cell);
          continue;
        }
        if (op.range.sectionIdx !== sectionIdx) continue;
        if (sameCell(op.range.cell, cell)) {
          this.shiftRangeAfterInsert(op.range, ins);
        } else if (!cell && op.range.cell && ins.addedParas > 0 && ins.paraIdx < op.range.cell.paraIdx) {
          // 본문 문단 추가가 표 앞에서 일어나면 셀 op 의 부모 문단 인덱스만 이동한다.
          op.range.cell = { ...op.range.cell, paraIdx: op.range.cell.paraIdx + ins.addedParas };
        }
      }
    }
  }

  /**
   * 엔진 배치가 바꾼 구간 뒤의 본문 문단(from 이상)을 가리키는 좌표를 delta 만큼 민다.
   * 적용 시점 범위(applied)는 배치 전 좌표 그대로 둔다 — 역순 되돌림에서 배치가 먼저
   * 스냅샷으로 되돌아간 뒤에 쓰인다.
   */
  private shiftAllParagraphs(sectionIdx: number, from: number, delta: number, exclude?: PendingOp): void {
    const shift = (p: DocPoint): DocPoint => (p.paraIdx >= from ? { paraIdx: p.paraIdx + delta, charOffset: p.charOffset } : p);
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op === exclude || op.kind === 'field' || op.kind === 'template') continue;
        if (op.kind === 'object') {
          this.shiftObjectOp(op.obj, sectionIdx, shift);
          continue;
        }
        if (op.range.sectionIdx !== sectionIdx) continue;
        if (op.range.cell) {
          if (op.range.cell.paraIdx >= from) op.range.cell = { ...op.range.cell, paraIdx: op.range.cell.paraIdx + delta };
        } else {
          this.shiftRange(op.range, shift);
        }
      }
    }
  }

  private shiftAllAfterDelete(del: DocRange, exclude?: PendingOp): void {
    const removedParas = del.cell ? 0 : del.endParaIdx - del.startParaIdx;
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op === exclude || op.kind === 'field' || op.kind === 'template') continue;
        if (op.kind === 'object') {
          this.shiftObjectOp(op.obj, del.sectionIdx, (p) => shiftPointAfterDelete(p, del), del.cell);
          continue;
        }
        if (op.range.sectionIdx !== del.sectionIdx) continue;
        if (sameCell(op.range.cell, del.cell)) {
          if ((op.kind === 'insert' || op.kind === 'replace' || op.kind === 'format')
            && op.applied && rangesOverlap(op.range, del)) {
            op.applied.overwritten = true;
          }
          this.shiftRange(op.range, (p) => shiftPointAfterDelete(p, del));
        } else if (!del.cell && op.range.cell && removedParas > 0 && del.endParaIdx < op.range.cell.paraIdx) {
          // 본문 문단 삭제가 표 앞에서 일어나면 셀 op 의 부모 문단 인덱스만 당긴다.
          op.range.cell = { ...op.range.cell, paraIdx: op.range.cell.paraIdx - removedParas };
        }
      }
    }
  }

  /**
   * 본문 문단 분할/병합 전후로 개체 주소를 엔진 기준으로 다시 잡는다. 엔진은 분할 지점
   * 뒤의 개체를 새 문단으로 옮겨 0부터 다시 번호 매기고, 병합 시 뒤 문단의 개체를 앞 문단
   * 끝에 잇는다 — 오프셋 비교로 문단만 옮기는 텍스트 shift 로는 알 수 없다.
   * 사용: const fix = this.trackControls(...); 변이 + shift; fix?.(변이 뒤 마지막 문단).
   * 셀 내부 변이이거나 그 문단들의 개체를 가리키는 op 이 없으면 undefined.
   */
  private trackControls(
    sectionIdx: number, from: number, to: number, cell?: CellAddr,
  ): ((afterEnd: number) => void) | undefined {
    const wasm = this.deps.wasm;
    if (cell || typeof wasm.getControlTextPositions !== 'function') return undefined;
    const refs = this.collectControlRefs(sectionIdx, from, to);
    if (refs.length === 0) return undefined;
    const positions = (para: number): number[] => wasm.getControlTextPositions(sectionIdx, para);
    const before: number[] = [];
    for (let p = from; p <= to; p++) before.push(positions(p).length);
    return (afterEnd) => {
      const after: number[][] = [];
      for (let p = from; p <= afterEnd; p++) after.push(positions(p));
      const remap = controlRemapFromCounts(from, before, after.map((xs) => xs.length));
      if (!remap) return;
      for (const ref of refs) {
        const mapped = remap(ref.paraIdx, ref.controlIdx);
        if (!mapped) continue; // 사라진 개체는 그대로 두어 검증에서 드리프트로 걸러진다
        ref.set(mapped.paraIdx, mapped.controlIdx, after[mapped.paraIdx - from]?.[mapped.controlIdx] ?? 0);
      }
    };
  }

  /** [from..to] 본문 문단의 개체(표·그림·수식·각주·책갈피)를 주소로 가리키는 필드들 */
  private collectControlRefs(sectionIdx: number, from: number, to: number): Array<{
    paraIdx: number; controlIdx: number;
    set: (paraIdx: number, controlIdx: number, textPos: number) => void;
  }> {
    const refs: Array<{
      paraIdx: number; controlIdx: number;
      set: (paraIdx: number, controlIdx: number, textPos: number) => void;
    }> = [];
    const inRange = (para: number): boolean => from <= para && para <= to;
    const cellRef = (get: () => CellAddr | undefined, put: (cell: CellAddr) => void): void => {
      const cell = get();
      if (!cell || !inRange(cell.paraIdx)) return;
      refs.push({
        paraIdx: cell.paraIdx, controlIdx: cell.controlIdx,
        set: (paraIdx, controlIdx) => {
          const cur = get()!;
          put({
            ...cur, paraIdx, controlIdx,
            ...(cur.path ? { path: cur.path.map((entry, index) => index === 0 ? { ...entry, controlIndex: controlIdx } : entry) } : {}),
          });
        },
      });
    };
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind === 'field' || op.kind === 'template') continue;
        if (op.kind !== 'object') {
          if (op.range.sectionIdx === sectionIdx) {
            const range = op.range;
            cellRef(() => range.cell, (cell) => { range.cell = cell; });
          }
          continue;
        }
        const o = op.obj;
        if (o.sectionIdx !== sectionIdx) continue;
        switch (o.type) {
          case 'createTable': case 'insertImage': case 'insertNote': case 'insertEquation': case 'insertShape':
            if (o.type === 'insertEquation' && o.cell) {
              cellRef(() => o.cell, (cell) => {
                o.cell = cell;
                if (o.anchor) o.anchor = { ...o.anchor, paraIdx: cell.paraIdx };
              });
            } else if (o.anchor && inRange(o.anchor.paraIdx)) {
              refs.push({
                paraIdx: o.anchor.paraIdx, controlIdx: o.anchor.controlIdx,
                set: (paraIdx, controlIdx, textPos) => { o.anchor = { paraIdx, controlIdx, charOffset: textPos }; },
              });
            }
            break;
          case 'paraFormat': case 'applyStyle':
            cellRef(() => o.cell, (cell) => { o.cell = cell; });
            break;
          case 'setNoteText':
            if (inRange(o.paraIdx)) {
              refs.push({
                paraIdx: o.paraIdx, controlIdx: o.controlIdx,
                set: (paraIdx, controlIdx) => { o.paraIdx = paraIdx; o.controlIdx = controlIdx; },
              });
            }
            break;
          case 'bookmark':
            if (o.ctrlIdx !== undefined && inRange(o.paraIdx)) {
              refs.push({
                paraIdx: o.paraIdx, controlIdx: o.ctrlIdx,
                set: (paraIdx, controlIdx, textPos) => {
                  o.paraIdx = paraIdx; o.ctrlIdx = controlIdx;
                  if (o.charOffset !== undefined) o.charOffset = textPos;
                },
              });
            }
            break;
          case 'editObject': case 'deleteObject':
            if (o.cell) {
              cellRef(() => o.cell, (cell) => { o.cell = cell; });
            } else if (inRange(o.paraIdx)) {
              refs.push({
                paraIdx: o.paraIdx, controlIdx: o.controlIdx,
                set: (paraIdx, controlIdx, textPos) => {
                  o.paraIdx = paraIdx; o.controlIdx = controlIdx;
                  if (o.type === 'deleteObject' && o.removedOffset !== undefined) o.removedOffset = textPos;
                },
              });
            }
            break;
          case 'pageLayout': case 'headerFooter': case 'engineBatch':
            break;
          default:
            if (inRange(o.tableParaIdx)) {
              refs.push({
                paraIdx: o.tableParaIdx, controlIdx: o.controlIdx,
                set: (paraIdx, controlIdx) => { o.tableParaIdx = paraIdx; o.controlIdx = controlIdx; },
              });
            }
        }
      }
    }
    return refs;
  }

  private shiftRange(range: DocRange, shift: (p: DocPoint) => DocPoint): void {
    const s = shift({ paraIdx: range.startParaIdx, charOffset: range.startCharOffset });
    const e = shift({ paraIdx: range.endParaIdx, charOffset: range.endCharOffset });
    range.startParaIdx = s.paraIdx;
    range.startCharOffset = s.charOffset;
    range.endParaIdx = e.paraIdx;
    range.endCharOffset = e.charOffset;
  }

  /** 삽입 shift 를 범위에 적용 — 시작은 at-or-after, 끝은 strictly-after 규칙 */
  private shiftRangeAfterInsert(range: DocRange, ins: InsertShift): void {
    // 빈 범위(시작==끝)는 한 점으로 움직인다 — 시작만 밀리면 범위가 뒤집힌다.
    const empty = range.startParaIdx === range.endParaIdx
      && range.startCharOffset === range.endCharOffset;
    const s = shiftPointAfterInsert(
      { paraIdx: range.startParaIdx, charOffset: range.startCharOffset }, ins, !empty,
    );
    const e = shiftPointAfterInsert(
      { paraIdx: range.endParaIdx, charOffset: range.endCharOffset }, ins,
    );
    range.startParaIdx = s.paraIdx;
    range.startCharOffset = s.charOffset;
    range.endParaIdx = e.paraIdx;
    range.endCharOffset = e.charOffset;
  }
}
