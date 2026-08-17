import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { DocumentPosition, CharProperties } from '../core/types.ts';
import { PreparedSnapshotCommand } from '../engine/prepared-snapshot-command.ts';
import type {
  AgentName, CellAddr, CharFormatProps, DocPoint, DocRange,
  ObjectAnchor, ObjectOp, PendingChangeSet, PendingEditsChangeEvent, PendingOp,
} from './types.ts';
import { AgentToolError, isDestructiveTableMark, isObjectOpApplied, sameCell } from './types.ts';
import type { OverlayOp, PendingOverlayRenderer } from './pending-overlay.ts';

export interface PendingEditDeps {
  wasm: WasmBridge;
  eventBus: EventBus;
  inputHandler: InputHandler;
  canvasView: CanvasView;
  overlay: PendingOverlayRenderer;
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
 *   (범위 끝에 덧붙인 텍스트가 기존 마크/범위에 삼켜지지 않도록).
 * - 시작(start) 경계 — at-or-after (`isStartBoundary`): 삽입 지점과 정확히 같은
 *   시작은 삽입 길이만큼 밀린다. 그 자리에 삽입된 텍스트는 물리적으로 범위의
 *   기존 텍스트를 뒤로 밀므로, 시작이 제자리에 남으면 범위가 새 텍스트를 삼킨다
 *   (삭제 마크 시작점에 재작성 텍스트를 삽입하면 승인 시 새 텍스트까지 지워지는 버그).
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

const CHAR_FORMAT_KEYS = ['bold', 'italic', 'underline', 'strikethrough', 'fontSize', 'textColor'] as const;

/**
 * [Task #2337-review 와 동일 원칙] wasm 텍스트 API 의 charOffset/count 는 Rust char
 * (Unicode scalar) 단위다. JS String.length(UTF-16 code unit)를 쓰면 😀 같은 astral
 * 문자에서 오프셋이 어긋나 삽입/삭제/검증이 모두 깨진다 → 코드포인트 수로 계산한다.
 */
function scalarLen(s: string): number {
  return [...s].length;
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
  /** withMarkedOpsApplied 로 mark-only op 이 현재 적용 중인 set id (재진입 가드) */
  private speculativeSets = new Set<string>();
  private lastDigest: string | null;
  /**
   * 사용자(비-에이전트) 문서 변이 카운터. replace op 의 스냅샷은 문서 전체 클론이라
   * 복원하면 스냅샷 이후의 모든 변이를 지운다 — pending 중 사용자 편집은 주소로
   * 관측하지 않으므로(untracked drift), 이 카운터가 스냅샷 시점과 달라졌으면
   * 전체 복원 대신 범위-국소 역연산 폴백으로만 되돌린다.
   */
  private userEditSeq = 0;
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

  endTurn(outcome: 'review' | 'commit' | 'reject' = 'review'): void {
    if (!this.open) return;
    const set = this.open;
    this.finalizeOpenSet();
    if (set.ops.length === 0) return;
    if (outcome === 'commit') {
      if (!this.approve(set.id)) this.reject(set.id);
    } else if (outcome === 'reject') this.reject(set.id);
  }

  insertText(
    agent: AgentName,
    addr: { sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr },
    text: string,
  ): { changeSetId: string; insertedRange: DocRange } {
    if (text.length === 0) throw new AgentToolError('INVALID_ARGS', 'text must not be empty');
    const { range, addedParas } = this.performInsert(addr.sectionIdx, addr.paraIdx, addr.charOffset, text, addr.cell);
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = { kind: 'insert', id: this.nextId('op'), agent: set.agent, range, text };
    this.pushOp(set, op);
    this.shiftAllAfterInsert(range.sectionIdx, {
      paraIdx: addr.paraIdx, charOffset: addr.charOffset, addedParas,
      endParaIdx: range.endParaIdx, endCharOffset: range.endCharOffset, textLen: scalarLen(text),
    }, op, addr.cell);
    this.reconcilePreviewLayout();
    this.emitDocEvents('agent-pending-edit');
    this.syncOverlay();
    // 타자기 공개용 — op.range 라이브 참조를 넘겨 이후 shift 가 반영되게 한다.
    this.deps.eventBus.emit('agent-text-inserted', { agent: op.agent, range: op.range, text });
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id, insertedRange: { ...range } };
  }

  /**
   * [legacy] 마크 전용 삭제 — 도구 경로는 더 이상 쓰지 않는다(delete_range 는
   * replaceText(range, '') 로 즉시 적용된다). 마크가 원문을 레이아웃에 남겨
   * 편집이 많은 턴에서 미리보기 쪽나눔이 최종본과 크게 어긋났기 때문이다.
   */
  markDelete(agent: AgentName, range: DocRange): { changeSetId: string; markedText: string } {
    if (range.endParaIdx < range.startParaIdx
      || (range.endParaIdx === range.startParaIdx && range.endCharOffset <= range.startCharOffset)) {
      throw new AgentToolError('INVALID_ARGS', 'delete range is empty or reversed');
    }
    // 문서 변이 없음(revision 불변): 텍스트만 캡처하고 마크만 기록한다.
    const text = this.captureRangeText(range);
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = { kind: 'delete', id: this.nextId('op'), agent: set.agent, range: { ...range }, text };
    this.pushOp(set, op);
    this.syncOverlay();
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id, markedText: text.slice(0, 300) };
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
    let charShapeId: number | null = null;
    try {
      const props = range.cell
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
        const props = range.cell
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
    this.deps.inputHandler.prepareSnapshotCapacity?.(1);
    const snapshotId = wasm.saveSnapshot();
    this.deps.inputHandler.retainExternalSnapshot?.();
    let deleteShifted = false;
    try {
      const res = this.deleteRangeRaw(range);
      if (res?.ok !== true) throw new AgentToolError('RPC_ERROR', 'replaceText: deleteRange failed');
      this.shiftAllAfterDelete(range);
      deleteShifted = true;
      const start: DocPoint = { paraIdx: range.startParaIdx, charOffset: range.startCharOffset };
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
      if (charShapeId !== null && text.length > 0) this.applyCharShapeToRange(ins.range, charShapeId);
      const set = this.ensureOpenSet(agent);
      if (!retainSnapshot) {
        // 벌크 경로: 에러 롤백용 스냅샷은 성공 즉시 반환한다 — 되돌림은 역연산 폴백.
        wasm.discardSnapshot(snapshotId);
        this.deps.inputHandler.releaseExternalSnapshot?.();
      }
      const op: PendingOp = {
        kind: 'replace', id: this.nextId('op'), agent: set.agent,
        range: ins.range, text, deletedText, charShapeId, paraShapeIds,
        snapshotId: retainSnapshot ? snapshotId : null,
        userEditSeqAtSnapshot: this.userEditSeq,
      };
      this.pushOp(set, op);
      if (text.length > 0) {
        this.shiftAllAfterInsert(range.sectionIdx, this.insertShiftFor(start, text), op, range.cell);
      }
      this.reconcilePreviewLayout();
      this.emitDocEvents('agent-pending-edit');
      this.syncOverlay();
      if (text.length > 0) {
        this.deps.eventBus.emit('agent-text-inserted', { agent: op.agent, range: op.range, text });
      }
      this.emitChange({ type: 'ops-changed' });
      return { changeSetId: set.id, insertedRange: { ...ins.range }, deletedText };
    } catch (err) {
      // 부분 적용 롤백 — 스냅샷으로 변이 전 상태를 그대로 복원한다.
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
    const props: CharProperties = cell
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
   * 객체 연산 등록. applied-now 유형은 즉시 적용(reject 시 역연산),
   * mark-only 유형은 approve 시 실행된다.
   */
  addObjectOp(agent: AgentName, obj: ObjectOp): { changeSetId: string; obj: ObjectOp } {
    if (isObjectOpApplied(obj)) {
      this.applyObjectOp(obj);
    }
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = { kind: 'object', id: this.nextId('op'), agent: set.agent, obj };
    this.pushOp(set, op);
    if (isObjectOpApplied(obj)) {
      this.reconcilePreviewLayout();
      this.emitDocEvents('agent-pending-edit');
    }
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
   * executor 가드: 삽입 지점이 pending 삭제 마크 범위의 **내부**(경계 제외)에
   * 있으면 그 마크의 요약을 반환한다. 마크 내부에 삽입된 텍스트는 승인 시 마크와
   * 함께 삭제되므로, 명확한 에러로 막아 에이전트의 작업 유실을 예방한다.
   */
  findDeleteMarkContaining(
    sectionIdx: number, paraIdx: number, charOffset: number, cell?: CellAddr,
  ): { range: DocRange; text: string } | null {
    const after = (aPara: number, aOff: number, bPara: number, bOff: number): boolean =>
      aPara > bPara || (aPara === bPara && aOff > bOff);
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind !== 'delete') continue;
        const r = op.range;
        if (r.sectionIdx !== sectionIdx || !sameCell(r.cell, cell)) continue;
        if (after(paraIdx, charOffset, r.startParaIdx, r.startCharOffset)
          && after(r.endParaIdx, r.endCharOffset, paraIdx, charOffset)) {
          return { range: { ...r }, text: op.text };
        }
      }
    }
    return null;
  }

  /**
   * executor 가드: 범위가 pending 삭제 마크와 **겹치면** 그 마크의 요약을 반환한다
   * (경계 접촉은 겹침이 아니다). 마크와 겹치는 교체는 마크 텍스트를 부분 삭제해
   * 마크를 드리프트시키거나, 승인 시 교체 텍스트 일부까지 지우므로 사전에 막는다.
   */
  findDeleteMarkOverlapping(range: DocRange): { range: DocRange; text: string } | null {
    const atOrBefore = (aPara: number, aOff: number, bPara: number, bOff: number): boolean =>
      aPara < bPara || (aPara === bPara && aOff <= bOff);
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind !== 'delete') continue;
        const r = op.range;
        if (r.sectionIdx !== range.sectionIdx || !sameCell(r.cell, range.cell)) continue;
        const disjoint =
          atOrBefore(range.endParaIdx, range.endCharOffset, r.startParaIdx, r.startCharOffset)
          || atOrBefore(r.endParaIdx, r.endCharOffset, range.startParaIdx, range.startCharOffset);
        if (!disjoint) return { range: { ...r }, text: op.text };
      }
    }
    return null;
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
    const wasm = this.deps.wasm;
    const pendingState = this.capturePendingState();
    const setIdsBefore = new Set(this.sets.map((s) => s.id));
    const openBefore = this.open;
    this.deps.inputHandler.prepareSnapshotCapacity?.(1);
    const snapId = wasm.saveSnapshot();
    this.deps.inputHandler.retainExternalSnapshot?.();
    this.beginBulk();
    try {
      let changeSetId = '';
      for (const item of items) {
        changeSetId = this.replaceText(item.range, item.text, agent, { retainSnapshot: false }).changeSetId;
      }
      return { changeSetId };
    } catch (err) {
      try { wasm.restoreSnapshot(snapId); } catch { /* best effort */ }
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
    this.bulkLayoutDirty = false;
    this.bulkDocEventsReason = null;
    this.bulkOverlayDirty = false;
    this.bulkOpsChanged = false;
    if (layoutDirty) this.reconcilePreviewLayout();
    if (docEventsReason !== null) this.emitDocEvents(docEventsReason);
    if (overlayDirty) this.syncOverlay();
    if (opsChanged) this.emitChange({ type: 'ops-changed' });
  }

  /** executor 가드: 해당 표에 파괴적 마크(delete_row/col, merge, delete_table)가 걸려 있는가 */
  hasDestructiveTableMark(sectionIdx: number, tableParaIdx: number, controlIdx: number): boolean {
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind === 'object' && isDestructiveTableMark(op.obj, sectionIdx, tableParaIdx, controlIdx)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * executor 가드: 해당 표에 pending 구조 op(insert_row/col 적용됨 또는
   * delete/merge/delete_table 마크)이 하나라도 있으면 true — 구조 op 이 있으면
   * cellIdx 가 재번호 매겨지므로 승인 전 추가 표 편집을 막는 데 쓴다.
   */
  hasPendingStructureOp(sectionIdx: number, tableParaIdx: number, controlIdx: number): boolean {
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind !== 'object') continue;
        const o = op.obj;
        if ((o.type === 'tableStructure' || o.type === 'tableStructureMarked' || o.type === 'deleteTable')
          && o.sectionIdx === sectionIdx
          && o.tableParaIdx === tableParaIdx && o.controlIdx === controlIdx) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 검증 루프용 change-set 요약. changeSetId 생략 시 가장 최근 set 을 대상으로 한다.
   * summary 는 종류 + 짧은 텍스트 다이제스트(~80자) + 좌표 정보다.
   */
  describeChangeSet(changeSetId?: string): {
    changeSetId: string | null;
    status: string;
    agent: string;
    ops: Array<{ id: string; kind: string; applied: boolean; summary: string }>;
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
        applied: op.kind === 'delete' ? false
          : op.kind === 'object' ? isObjectOpApplied(op.obj)
          : true,
        summary: this.summarizeOp(op),
      })),
    };
  }

  /**
   * 검증 루프용: set 의 mark-only op(삭제 마크/표 구조 마크 등)을 임시로 적용한
   * 상태에서 fn() 을 실행하고, 반드시 원래 문서로 복원한다 (fn 이 throw 하든).
   * approve 경로와 같은 plumbing(applyApprovalOnlyOps)을 쓰되 스냅샷으로 되돌리므로
   * 문서에는 아무 흔적도 남지 않는다. 같은 set 에 대한 재진입은 fn 만 실행한다.
   */
  withMarkedOpsApplied<T>(changeSetId: string, fn: () => T): T {
    const set = this.sets.find((s) => s.id === changeSetId);
    if (!set) throw new AgentToolError('INVALID_ARGS', `unknown change set: ${changeSetId}`);
    // 재진입 — 이미 이 set 의 마크 op 이 적용된 상태이므로 그대로 실행한다.
    if (this.speculativeSets.has(changeSetId)) return fn();
    const wasm = this.deps.wasm;
    const pendingState = this.capturePendingState();
    this.speculativeSets.add(changeSetId);
    let snapId: number | null = null;
    try {
      this.deps.inputHandler.prepareSnapshotCapacity?.(1);
      snapId = wasm.saveSnapshot();
      this.deps.inputHandler.retainExternalSnapshot?.();
      this.applyApprovalOnlyOps(set.ops);
      this.reconcilePreviewLayout();
      this.emitDocEvents('agent-preview');
      return fn();
    } finally {
      this.speculativeSets.delete(changeSetId);
      if (snapId !== null) {
        try { wasm.restoreSnapshot(snapId); } catch { /* best effort */ }
        wasm.discardSnapshot(snapId);
        this.deps.inputHandler.releaseExternalSnapshot?.();
      }
      this.restorePendingState(pendingState);
      this.emitDocEvents('agent-preview');
    }
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

  /** approve — 적용된 미리보기는 재생성하지 않고 그대로 단일 undo 항목으로 채택한다. */
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
    const { kept, dropped } = this.partitionDriftedOps(set);
    const skipped = dropped.length;

    if (kept.length === 0 && dropped.length === 0) {
      this.removeSet(set);
      this.syncOverlay();
      this.emitChange({ type: 'approved', changeSetId });
      return true;
    }

    // kept 가 남았으면 kept 만 되돌려 before 를 캡처한다 (드리프트 미리보기는
    // 사용자 소유로 before 에 남긴다). 전부 드리프트됐으면 되돌릴 것이 없다 —
    // 드리프트 미리보기는 이미 사용자가 손댄 텍스트라, 이를 지워 before 를 만들면
    // undo 가 사용자 글자까지 잘라낸다. 현재 상태를 before 로 잡아 undo 를 무해한
    // no-op 으로 만들고 히스토리 항목만 남긴다(미리보기 방치 방지).
    const keepPreviewsOf = kept.length > 0 ? dropped : [];
    // all-drifted 경로에서는 set.ops 를 원본 그대로 유지한다
    // (승인 시점 연산은 kept 가 없으면 실행되지 않는다).
    if (kept.length > 0) set.ops = kept;

    const wasm = this.deps.wasm;
    const cursor = this.deps.inputHandler.getCursorPosition();
    const previewState = this.capturePendingState();
    let previewId: number | null = null;
    let beforeId: number | null = null;
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
        this.revertAppliedOps(kept, keepPreviewsOf, userEditSeqNow);
        beforeId = wasm.saveSnapshot();
        retainExternal();
        wasm.restoreSnapshot(previewId);
        this.restorePendingState(previewState);
      } else {
        // 전부 드리프트: 미리보기는 사용자 소유이므로 되돌리지 않는다.
        beforeId = wasm.saveSnapshot();
        retainExternal();
      }

      command = new PreparedSnapshotCommand(
        'agentApplyChangeSet', cursor, cursor, beforeId,
        // 되돌림 과정에서 op 좌표가 before 상태로 이동했으므로, 미리보기 좌표로
        // 복원된(restorePendingState) set.ops 의 클론을 대상으로 실행해야 한다.
        () => {
          const position = this.applyApprovalOnlyOps(kept.length > 0 ? set.ops : []);
          this.reconcilePreviewLayout();
          return position;
        },
      );
      beforeId = null; // command가 소유권을 인수했다.
      command.execute(wasm);
      wasm.discardSnapshot(previewId);
      previewId = null;
      this.deps.inputHandler.executeOperation({
        kind: 'record',
        command,
        // 승인은 이미 보이는 미리보기를 채택하는 것 — 사용자가 보고 있는
        // 지점(에이전트 편집 위치)에서 caret 위치로 카메라를 되돌리지 않는다.
        meta: { refresh: 'full', scroll: 'preserve' },
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
      this.discardReplaceSnapshots(dropped);
      set.status = 'awaiting-review';
      this.emitDocEvents('agent-pending-edit');
      this.syncOverlay();
      console.warn('[pending-edits] approve snapshot capture failed', err);
      this.emitChange({ type: 'invalidated', reason: 'approval failed' });
      return false;
    }

    this.discardReplaceSnapshots([...kept, ...dropped]);
    this.removeSet(set);
    this.syncOverlay();
    if (skipped > 0) this.emitChange({ type: 'invalidated', reason: `text drift (${skipped} ops skipped)` });
    this.emitChange({ type: 'approved', changeSetId });
    return true;
  }

  /** reject — 적용된 op 을 되돌리고 삭제 마크를 해제한다. 히스토리 항목 없음. */
  reject(changeSetId: string): void {
    const set = this.sets.find((s) => s.id === changeSetId);
    if (!set) return;
    if (set === this.open) this.open = null;
    // approve 와 같은 이유로 되돌림 시작 전에 한 번만 샘플링한다.
    const userEditSeqNow = this.userEditSeq;
    this.selfMutating++;
    try {
      const { kept, dropped } = this.partitionDriftedOps(set);
      const skipped = dropped.length;
      set.ops = kept;
      this.revertAppliedOps(kept, dropped, userEditSeqNow);
      this.reconcilePreviewLayout();
      this.emitDocEvents('agent-reject');
      this.discardReplaceSnapshots([...kept, ...dropped]);
      this.removeSet(set);
      this.syncOverlay();
      if (skipped > 0) this.emitChange({ type: 'invalidated', reason: `text drift (${skipped} ops skipped)` });
      this.emitChange({ type: 'rejected', changeSetId });
    } finally {
      this.selfMutating--;
    }
  }

  onChange(cb: (e: PendingEditsChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  dispose(): void {
    for (const un of this.unsubs) un();
    this.unsubs = [];
    this.listeners.clear();
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
    for (const set of this.sets) this.discardReplaceSnapshots(set.ops);
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
    for (let i = this.sets.length - 1; i >= 0; i--) {
      const set = this.sets[i];
      const { kept, dropped } = this.partitionDriftedOps(set);
      set.ops = kept;
      if (set.ops.some((op) => op.kind !== 'delete')) reverted = true;
      this.revertAppliedOps(kept, dropped);
      this.discardReplaceSnapshots([...kept, ...dropped]);
    }
    if (reverted) this.reconcilePreviewLayout();
    this.sets = [];
    this.open = null;
    this.syncTemplateLock();
    this.deps.overlay.clear();
    if (reverted) this.emitDocEvents('agent-invalidate');
    this.emitChange({ type: 'invalidated', reason });
  }

  /** op 에 전역 등록 순번을 부여하고 set 에 추가한다 */
  private pushOp(set: PendingChangeSet, op: PendingOp): void {
    op.seq = ++this.opSeq;
    set.ops.push(op);
  }

  /** set 제거/폐기 시점에 replace op 들이 잡고 있는 wasm 스냅샷을 해제한다 */
  private discardReplaceSnapshots(ops: PendingOp[]): void {
    for (const op of ops) {
      if ((op.kind !== 'replace' && op.kind !== 'template') || op.snapshotId === null) continue;
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
        if (op.kind === 'object') {
          const ref = this.objectOverlayRef(op.obj);
          if (ref) {
            ops.push({
              kind: isObjectOpApplied(op.obj) ? 'insert' : 'delete',
              agent: op.agent,
              objRef: ref,
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

  /** 객체 op → overlay 좌표 해석 참조 (pageLayout/headerFooter 는 사이드바 전용) */
  private objectOverlayRef(obj: ObjectOp): import('./pending-overlay.ts').ObjectOverlayRef | null {
    switch (obj.type) {
      case 'createTable':
        return obj.anchor
          ? { sort: 'table', sectionIdx: obj.sectionIdx, paraIdx: obj.anchor.paraIdx, controlIdx: obj.anchor.controlIdx }
          : null;
      case 'insertImage':
        return obj.anchor
          ? { sort: 'control', sectionIdx: obj.sectionIdx, paraIdx: obj.anchor.paraIdx, controlIdx: obj.anchor.controlIdx }
          : null;
      case 'insertEquation':
        if (obj.cell) {
          // 셀 수식: 셀 전체를 틴트 (셀 문단 내 컨트롤 bbox 는 별도 API 가 없다)
          return { sort: 'cells', sectionIdx: obj.sectionIdx, paraIdx: obj.cell.paraIdx, controlIdx: obj.cell.controlIdx, cellIdx: obj.cell.cellIdx };
        }
        return obj.anchor
          ? { sort: 'control', sectionIdx: obj.sectionIdx, paraIdx: obj.anchor.paraIdx, controlIdx: obj.anchor.controlIdx }
          : null;
      case 'tableStructure':
      case 'setTableProps':
      case 'deleteTable':
        return { sort: 'table', sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx };
      case 'tableStructureMarked': {
        const base = { sort: 'cells' as const, sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx };
        if (obj.op === 'delete_row') return { ...base, rowIdx: obj.rowIdx };
        if (obj.op === 'delete_col') return { ...base, colIdx: obj.colIdx };
        if (obj.op === 'split_cell') return { ...base, rect: { startRow: obj.rowIdx!, startCol: obj.colIdx!, endRow: obj.rowIdx!, endCol: obj.colIdx! } };
        return { ...base, rect: { startRow: obj.startRow!, startCol: obj.startCol!, endRow: obj.endRow!, endCol: obj.endCol! } };
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
      case 'delete':
        return `delete "${digest(op.text)}" @${coord(op.range)}`;
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
        const at = 'tableParaIdx' in o ? `s${o.sectionIdx} p${o.tableParaIdx}` : `s${o.sectionIdx}`;
        return `${o.type} @${at}`;
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

  private containerParaCount(sec: number, cell?: CellAddr): number {
    const wasm = this.deps.wasm;
    return cell
      ? wasm.getCellParagraphCount(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx)
      : wasm.getParagraphCount(sec);
  }

  private containerParaLen(sec: number, para: number, cell?: CellAddr): number {
    const wasm = this.deps.wasm;
    return cell
      ? wasm.getCellParagraphLength(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, para)
      : wasm.getParagraphLength(sec, para);
  }

  private containerText(sec: number, para: number, off: number, count: number, cell?: CellAddr): string {
    const wasm = this.deps.wasm;
    return cell
      ? wasm.getTextInCell(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, para, off, count)
      : wasm.getTextRange(sec, para, off, count);
  }

  private deleteRangeRaw(r: DocRange): { ok: boolean } {
    const wasm = this.deps.wasm;
    return r.cell
      ? wasm.deleteRangeInCell(
        r.sectionIdx, r.cell.paraIdx, r.cell.controlIdx, r.cell.cellIdx,
        r.startParaIdx, r.startCharOffset, r.endParaIdx, r.endCharOffset,
      )
      : wasm.deleteRange(r.sectionIdx, r.startParaIdx, r.startCharOffset, r.endParaIdx, r.endCharOffset);
  }

  private applyFormatRaw(range: DocRange, format: CharFormatProps): string {
    const wasm = this.deps.wasm;
    return range.cell
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
   * applied-now 객체 연산의 적용. 실패는 throw — 호출자(addObjectOp/replay)가 처리.
   * 성공 시 앵커를 op 데이터에 기록한다(replay 재바인딩 포함).
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
        this.shiftControlIdxRefs(obj.sectionIdx, res.paraIdx, res.controlIdx, 1, obj);
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
        return;
      }
      case 'insertImage': {
        const res = wasm.insertPicture(
          obj.sectionIdx, obj.paraIdx, obj.charOffset, '',
          obj.bytes, obj.widthHu, obj.heightHu,
          obj.naturalWidthPx, obj.naturalHeightPx, obj.extension, obj.description,
        );
        if (!res.ok) throw new AgentToolError('RPC_ERROR', 'insertPicture failed');
        obj.anchor = { paraIdx: res.paraIdx, controlIdx: res.controlIdx, charOffset: obj.charOffset };
        this.shiftControlIdxRefs(obj.sectionIdx, res.paraIdx, res.controlIdx, 1, obj);
        // 본문 삽입은 floating 으로 생성된다 → 즉시 inline 전환 (studio drop 경로와 동일)
        wasm.setPictureProperties(obj.sectionIdx, res.paraIdx, res.controlIdx, { treatAsChar: true });
        return;
      }
      case 'insertEquation': {
        if (obj.cell) {
          const res = wasm.insertEquationInCell(
            obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx,
            obj.paraIdx, obj.charOffset, obj.script, obj.fontSizeHu, obj.colorRef,
          );
          if (!res.ok) throw new AgentToolError('RPC_ERROR', 'insertEquationInCell failed');
          // anchor.paraIdx = 부모 문단, controlIdx = 셀 문단 내 수식 인덱스
          obj.anchor = { paraIdx: obj.cell.paraIdx, controlIdx: res.controlIdx, charOffset: obj.charOffset };
          // 같은 셀 문단의 다른 pending 셀 수식 인덱스 이동
          this.shiftCellEquationRefs(obj, res.controlIdx, 1);
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
      case 'tableStructure': {
        const r = obj.op === 'insert_row'
          ? wasm.insertTableRow(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.index, obj.after)
          : wasm.insertTableColumn(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.index, obj.after);
        if (!r.ok) throw new AgentToolError('RPC_ERROR', `${obj.op} failed`);
        obj.insertedIndex = obj.after ? obj.index + 1 : obj.index;
        obj.dims = { rowCount: r.rowCount, colCount: r.colCount };
        // 같은 표를 참조하는 모든 pending op 의 기대 크기를 갱신 (드리프트 오탐 방지)
        this.adjustExpectedDimsForTable(
          obj.sectionIdx, obj.tableParaIdx, obj.controlIdx,
          obj.op === 'insert_row' ? 1 : 0, obj.op === 'insert_col' ? 1 : 0, obj,
        );
        return;
      }
      case 'paraFormat': {
        // 역연산용 이전 para_shape_id 를 최초 적용 시에만 캡처 (replay 는 revert 후라 동일 상태)
        if (obj.prevParaShapeId < 0) {
          const props = obj.cell
            ? wasm.getCellParaPropertiesAt(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx)
            : wasm.getParaPropertiesAt(obj.sectionIdx, obj.paraIdx);
          obj.prevParaShapeId = props.paraShapeId ?? -1;
        }
        const raw = obj.cell
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
        return;
      }
      case 'headerFooter': {
        // applied-now 는 신규 생성 케이스만 (기존 HF 수정은 mark-only)
        this.parseOk(wasm.createHeaderFooter(obj.sectionIdx, obj.isHeader, obj.applyTo), 'createHeaderFooter');
        this.writeHeaderFooterContent(obj);
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
          if (added) obj.ctrlIdx = added.ctrlIdx;
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
        } else {
          const r = wasm.renameBookmark(obj.sectionIdx, obj.paraIdx, obj.ctrlIdx!, obj.name ?? '');
          if (r?.ok !== true) throw new AgentToolError('BOOKMARK_FAILED', 'renameBookmark failed');
        }
        return;
      }
      default:
        throw new AgentToolError('RPC_ERROR', `applyObjectOp: ${obj.type} is mark-only`);
    }
  }

  /** applied-now 객체 연산의 역연산. 성공 여부 반환 (실패 op 은 replay 에서 제외). */
  private revertObjectOp(obj: ObjectOp): boolean {
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
          const ok = wasm.deletePictureControl(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx)?.ok === true;
          if (ok) this.shiftControlIdxRefs(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx, -1, obj);
          return ok;
        }
        case 'insertEquation': {
          if (!obj.anchor) return false;
          if (obj.cell) {
            const ok = wasm.deleteEquationControlInCell(
              obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx,
              obj.paraIdx, obj.anchor.controlIdx,
            )?.ok === true;
            if (ok) this.shiftCellEquationRefs(obj, obj.anchor.controlIdx, -1);
            return ok;
          }
          const ok = wasm.deleteEquationControl(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx)?.ok === true;
          if (ok) this.shiftControlIdxRefs(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx, -1, obj);
          return ok;
        }
        case 'tableStructure': {
          if (obj.insertedIndex === undefined) return false;
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
          if (obj.cell) {
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
          return true;
        }
        case 'headerFooter': {
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
            return wasm.deleteBookmark(obj.sectionIdx, obj.paraIdx, obj.ctrlIdx)?.ok === true;
          }
          if (!obj.prev) return false;
          if (obj.op === 'delete') {
            return wasm.addBookmark(obj.sectionIdx, obj.prev.para, obj.prev.charPos, obj.prev.name)?.ok === true;
          }
          return wasm.renameBookmark(obj.sectionIdx, obj.paraIdx, obj.prev.ctrlIdx, obj.prev.name)?.ok === true;
        }
        default:
          return true; // mark-only 는 되돌릴 것이 없다
      }
    } catch (err) {
      console.warn('[pending-edits] object revert failed', obj.type, err);
      return false;
    }
  }

  /** mark-only 객체 연산의 실행 (approve replay 시점) */
  private executeMarkedObjectOp(obj: ObjectOp): void {
    const wasm = this.deps.wasm;
    switch (obj.type) {
      case 'tableStructureMarked': {
        if (obj.op === 'delete_row') {
          wasm.deleteTableRow(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.rowIdx!);
        } else if (obj.op === 'delete_col') {
          wasm.deleteTableColumn(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.colIdx!);
        } else if (obj.op === 'split_cell') {
          const result = wasm.splitTableCellInto(
            obj.sectionIdx, obj.tableParaIdx, obj.controlIdx,
            obj.rowIdx!, obj.colIdx!, obj.splitRows!, obj.splitCols!, true, false,
          );
          if (!result.ok) throw new AgentToolError('RPC_ERROR', 'split_cell failed');
        } else {
          wasm.mergeTableCells(
            obj.sectionIdx, obj.tableParaIdx, obj.controlIdx,
            obj.startRow!, obj.startCol!, obj.endRow!, obj.endCol!,
          );
        }
        return;
      }
      case 'deleteTable': {
        const ok = wasm.deleteTableControl(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx)?.ok === true;
        if (ok) this.shiftControlIdxRefs(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, -1, obj);
        return;
      }
      case 'setCellProps':
        wasm.setCellProperties(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.cellIdx, obj.props);
        return;
      case 'setTableProps':
        wasm.setTableProperties(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx, obj.props);
        return;
      case 'applyStyle':
        if (obj.cell) {
          wasm.applyCellStyle(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx, obj.styleId);
        } else {
          wasm.applyStyle(obj.sectionIdx, obj.paraIdx, obj.styleId);
        }
        return;
      case 'headerFooter': {
        // 기존 HF 수정: 문단 0 텍스트 교체 (필드/서식 보존은 Phase-2 한계, approve 시점에만 실행)
        this.writeHeaderFooterContent(obj, true);
        return;
      }
      default:
        console.warn('[pending-edits] executeMarkedObjectOp: unexpected applied-now op', obj.type);
    }
  }

  /** 같은 셀 문단의 다른 pending 셀 수식 anchor 인덱스를 이동한다 */
  private shiftCellEquationRefs(
    acting: Extract<ObjectOp, { type: 'insertEquation' }>, atIdx: number, delta: 1 | -1,
  ): void {
    if (!acting.cell) return;
    const hit = (idx: number): boolean => (delta === 1 ? idx >= atIdx : idx > atIdx);
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind !== 'object' || op.obj === acting || op.obj.type !== 'insertEquation') continue;
        const o = op.obj;
        if (o.cell && sameCell(o.cell, acting.cell) && o.paraIdx === acting.paraIdx
          && o.anchor && hit(o.anchor.controlIdx)) {
          o.anchor = { ...o.anchor, controlIdx: o.anchor.controlIdx + delta };
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
        if ((o.type === 'tableStructure' || o.type === 'tableStructureMarked' || o.type === 'deleteTable')
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
        if (op.kind === 'insert' || op.kind === 'delete' || op.kind === 'format' || op.kind === 'replace') {
          const c = op.range.cell;
          if (c && op.range.sectionIdx === sectionIdx
            && c.paraIdx === anchor.paraIdx && c.controlIdx === anchor.controlIdx) {
            touched.add(c.cellIdx);
          }
        } else if (op.kind === 'object' && op.obj.type === 'insertEquation' && op.obj.cell
          && op.obj.sectionIdx === sectionIdx
          && op.obj.cell.paraIdx === anchor.paraIdx && op.obj.cell.controlIdx === anchor.controlIdx) {
          touched.add(op.obj.cell.cellIdx);
        }
      }
    }
    return touched;
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

  /** 드리프트 프로브: 객체 op 이 여전히 유효한가 (approve/reject 직전) */
  private verifyObjectOp(obj: ObjectOp): boolean {
    const wasm = this.deps.wasm;
    try {
      switch (obj.type) {
        case 'createTable': {
          if (!obj.anchor) return false;
          const d = wasm.getTableDimensions(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx);
          if (d.rowCount !== (obj.expectedRows ?? obj.rows) || d.colCount !== (obj.expectedCols ?? obj.cols)) {
            return false;
          }
          // 내용 지문: 사용자가 pending 표 안에 입력했다면 revert 로 지우지 않고
          // op 을 드리프트로 폐기해 표(와 사용자 내용)를 남긴다 (리뷰 확정 결함 수정).
          // 단, 같은 pending 상태의 에이전트 셀 텍스트 op 이 만진 셀은 지문에서 제외하고,
          // 구조 op(행/열 삽입)이 셀 배치를 바꿨다면 지문 검사를 건너뛴다 (크기 검사로 충분).
          if (obj.cells && !this.hasStructuralSibling(obj.sectionIdx, obj.anchor)) {
            const touched = this.agentTouchedCells(obj.sectionIdx, obj.anchor);
            for (let r = 0; r < obj.rows; r++) {
              for (let c = 0; c < obj.cols; c++) {
                const cellIdx = r * obj.cols + c;
                if (touched.has(cellIdx)) continue;
                const expected = obj.cells[r]?.[c] ?? '';
                if (this.cellFullText(obj.sectionIdx, obj.anchor, cellIdx) !== expected) return false;
              }
            }
          }
          return true;
        }
        case 'insertImage': {
          if (!obj.anchor) return false;
          // 존재만 보면 같은 자리의 사용자 그림을 지울 수 있다 — 크기 판별자 비교 (리뷰 확정 결함 수정)
          const p = wasm.getPictureProperties(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx);
          if (p === null || typeof p !== 'object') return false;
          const rec = p as unknown as { width?: number; height?: number; description?: string };
          if (typeof rec.width === 'number' && typeof rec.height === 'number') {
            if (rec.width !== obj.widthHu || rec.height !== obj.heightHu) return false;
          }
          if (typeof rec.description === 'string' && obj.description && rec.description !== obj.description) {
            return false;
          }
          return true;
        }
        case 'insertEquation': {
          if (!obj.anchor) return false;
          if (obj.cell) {
            // 인덱스 지정 조회 (신규 wasm API; 구버전/스텁은 첫-수식 조회로 폴백)
            const script = typeof wasm.getEquationScriptInCellAt === 'function'
              ? wasm.getEquationScriptInCellAt(
                obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx,
                obj.paraIdx, obj.anchor.controlIdx,
              )
              : null;
            if (script !== null) return script === obj.script;
            const p = wasm.getEquationProperties(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx);
            return p?.script === obj.script;
          }
          const p = wasm.getEquationProperties(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx);
          return p?.script === obj.script;
        }
        case 'tableStructure': {
          if (!obj.dims) return false;
          const d = wasm.getTableDimensions(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx);
          return d.rowCount === obj.dims.rowCount && d.colCount === obj.dims.colCount;
        }
        case 'tableStructureMarked':
        case 'deleteTable':
        case 'setCellProps':
        case 'setTableProps': {
          const d = wasm.getTableDimensions(obj.sectionIdx, obj.tableParaIdx, obj.controlIdx);
          return d.rowCount === obj.dims.rowCount && d.colCount === obj.dims.colCount;
        }
        case 'paraFormat':
        case 'applyStyle': {
          if (obj.cell) {
            const n = wasm.getCellParagraphCount(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx);
            if (obj.paraIdx >= n) return false;
          } else if (obj.paraIdx >= wasm.getParagraphCount(obj.sectionIdx)) {
            return false;
          }
          // 텍스트 지문: 문단 삽입/삭제로 인덱스가 다른 문단을 가리키면 드리프트 (리뷰 확정 결함 수정)
          if (obj.textSample !== undefined) {
            const len = obj.cell
              ? wasm.getCellParagraphLength(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx)
              : wasm.getParagraphLength(obj.sectionIdx, obj.paraIdx);
            const n = Math.min(len, 24);
            const cur = n === 0 ? '' : (obj.cell
              ? wasm.getTextInCell(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx, 0, n)
              : wasm.getTextRange(obj.sectionIdx, obj.paraIdx, 0, n));
            if (cur !== obj.textSample) return false;
          }
          return true;
        }
        case 'pageLayout':
          return obj.sectionIdx < wasm.getSectionCount();
        case 'headerFooter': {
          // 신규 생성이든 기존 수정이든 검증 시점에 HF 가 존재해야 한다 (리뷰 확정 결함 수정)
          const raw = JSON.parse(wasm.getHeaderFooter(obj.sectionIdx, obj.isHeader, obj.applyTo)) as { exists?: boolean };
          return raw?.exists === true;
        }
        case 'insertNote': {
          if (!obj.anchor) return false;
          const info = wasm.getFootnoteInfo(obj.sectionIdx, obj.anchor.paraIdx, obj.anchor.controlIdx);
          if (info?.ok !== true) return false;
          // 내용 지문 — 사용자가 각주 내용을 손댔으면 드리프트로 남긴다.
          // 기준은 적용 직후 실제 텍스트(appliedText) — 엔진 기본 내용이 붙을 수 있다.
          return (info.texts[0] ?? '') === (obj.appliedText ?? obj.text);
        }
        case 'setNoteText': {
          const info = wasm.getFootnoteInfo(obj.sectionIdx, obj.paraIdx, obj.controlIdx);
          if (info?.ok !== true || info.paraCount !== 1) return false;
          return (info.texts[0] ?? '') === obj.text;
        }
        case 'bookmark': {
          if (obj.op === 'add' || obj.op === 'rename') {
            return wasm.getBookmarks().some(
              (b) => b.sec === obj.sectionIdx && b.para === obj.paraIdx && b.name === obj.name,
            );
          }
          // delete: 대상이 다시 나타났으면(사용자 재추가 등) 드리프트
          return !wasm.getBookmarks().some(
            (b) => b.sec === obj.sectionIdx && b.para === obj.paraIdx
              && obj.prev !== undefined && b.name === obj.prev.name && b.charPos === obj.prev.charPos,
          );
        }
        default:
          return false;
      }
    } catch {
      return false;
    }
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
        } else if (o.type === 'tableStructure' || o.type === 'tableStructureMarked'
          || o.type === 'deleteTable' || o.type === 'setCellProps' || o.type === 'setTableProps') {
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
  ): void {
    const hit = (idx: number): boolean => (delta === 1 ? idx >= atIdx : idx > atIdx);
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind === 'field') continue;
        if (op.kind === 'object') {
          const o = op.obj;
          if (o === exclude) continue;
          if ((o.type === 'createTable' || o.type === 'insertImage')
            && o.sectionIdx === sectionIdx && o.anchor
            && o.anchor.paraIdx === paraIdx && hit(o.anchor.controlIdx)) {
            o.anchor = { ...o.anchor, controlIdx: o.anchor.controlIdx + delta };
          } else if (o.type === 'insertEquation' && !o.cell
            && o.sectionIdx === sectionIdx && o.anchor
            && o.anchor.paraIdx === paraIdx && hit(o.anchor.controlIdx)) {
            o.anchor = { ...o.anchor, controlIdx: o.anchor.controlIdx + delta };
          } else if ((o.type === 'tableStructure' || o.type === 'tableStructureMarked'
            || o.type === 'deleteTable' || o.type === 'setCellProps' || o.type === 'setTableProps')
            && o.sectionIdx === sectionIdx && o.tableParaIdx === paraIdx && hit(o.controlIdx)) {
            o.controlIdx += delta;
          } else if ((o.type === 'paraFormat' || o.type === 'applyStyle' || o.type === 'insertEquation')
            && o.cell && o.sectionIdx === sectionIdx
            && o.cell.paraIdx === paraIdx && hit(o.cell.controlIdx)) {
            o.cell = { ...o.cell, controlIdx: o.cell.controlIdx + delta };
          } else if (o.type === 'insertNote'
            && o.sectionIdx === sectionIdx && o.anchor
            && o.anchor.paraIdx === paraIdx && hit(o.anchor.controlIdx)) {
            o.anchor = { ...o.anchor, controlIdx: o.anchor.controlIdx + delta };
          } else if (o.type === 'setNoteText'
            && o.sectionIdx === sectionIdx && o.paraIdx === paraIdx && hit(o.controlIdx)) {
            o.controlIdx += delta;
          } else if (o.type === 'bookmark'
            && o.sectionIdx === sectionIdx && o.paraIdx === paraIdx
            && o.ctrlIdx !== undefined && hit(o.ctrlIdx)) {
            o.ctrlIdx += delta;
          }
          continue;
        }
        if (op.kind === 'template') continue;
        const c = op.range.cell;
        if (c && op.range.sectionIdx === sectionIdx && c.paraIdx === paraIdx && hit(c.controlIdx)) {
          op.range.cell = { ...c, controlIdx: c.controlIdx + delta };
        }
      }
    }
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

  /** HF 문단 0 에 텍스트(+쪽번호 필드)를 쓴다. replace=true 면 기존 문단 0 텍스트를 지운다. */
  private writeHeaderFooterContent(
    obj: Extract<ObjectOp, { type: 'headerFooter' }>, replace = false,
  ): void {
    const wasm = this.deps.wasm;
    if (replace) {
      try {
        const info = JSON.parse(wasm.getHeaderFooterParaInfo(obj.sectionIdx, obj.isHeader, obj.applyTo, 0)) as { length?: number; charCount?: number };
        const len = info?.length ?? info?.charCount ?? 0;
        if (len > 0) wasm.deleteTextInHeaderFooter(obj.sectionIdx, obj.isHeader, obj.applyTo, 0, 0, len);
      } catch { /* 문단 정보 조회 실패 시 그냥 덧붙인다 */ }
    }
    let off = 0;
    if (obj.text.length > 0) {
      this.parseOkLenient(
        wasm.insertTextInHeaderFooter(obj.sectionIdx, obj.isHeader, obj.applyTo, 0, 0, obj.text),
        'insertTextInHeaderFooter',
      );
      off = scalarLen(obj.text); // 스칼라 단위 (astral 문자 대응)
    }
    if (obj.pageNumber) {
      wasm.insertFieldInHf(obj.sectionIdx, obj.isHeader, obj.applyTo, 0, off, 1); // 1 = 쪽 번호
      const align = obj.pageNumber === 'left' || obj.pageNumber === 'right' || obj.pageNumber === 'center'
        ? obj.pageNumber : 'center';
      try {
        wasm.applyParaFormatInHf(obj.sectionIdx, obj.isHeader, obj.applyTo, 0, JSON.stringify({ alignment: align }));
      } catch { /* 정렬은 best-effort */ }
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
      const res = cell
        ? this.parseOk(
          wasm.insertTextInCell(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, p, o, line),
          'insertTextInCell',
        )
        : this.parseOk(wasm.insertText(sec, p, o, line), 'insertText');
      return typeof res.charOffset === 'number' ? res.charOffset : o + scalarLen(line);
    };
    // 에이전트의 `\n`은 한 논리 삽입 안의 줄 경계다. 논리 분할은 Enter 상속에서
    // 강제 쪽/단 나눔만 빼고 엔진이 처리하므로, 분할 뒤 교정 서식 호출이 없다.
    const splitPara = (p: number, o: number) => {
      if (cell) {
        this.parseOk(
          wasm.splitParagraphInCellLogical(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, p, o),
          'splitParagraphInCellLogical',
        );
      } else {
        this.parseOk(wasm.splitParagraphLogical(sec, p, o), 'splitParagraphLogical');
      }
    };
    try {
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
   * 않으므로 여전히 불일치(=드리프트)로 잡힌다.
   */
  private expectedOpText(
    op: Extract<PendingOp, { kind: 'insert' | 'delete' | 'replace' | 'format' }>,
    base: string,
  ): string {
    interface Contrib { paraIdx: number; charOffset: number; ins: string; delLen: number; seq: number }
    const r = op.range;
    const contribs: Contrib[] = [];
    for (const set of this.sets) {
      for (const cand of set.ops) {
        if (cand === op || (cand.seq ?? 0) <= (op.seq ?? 0)) continue;
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
  private verifyOpText(op: Extract<PendingOp, { kind: 'insert' | 'delete' | 'replace' | 'format' }>): boolean {
    // format 은 등록 시점 텍스트 지문이 없으면(캡처 실패) 검증을 건너뛴다 (기존 동작)
    if (op.kind === 'format' && op.text === undefined) return true;
    const base = op.kind === 'format' ? op.text! : op.text;
    const current = this.readRangeText(op.range);
    if (current === null) return false;
    return current === this.expectedOpText(op, base);
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

  /**
   * 드리프트된 op 을 kept/dropped 로 분할한다 (set.ops 는 호출자가 갱신한다).
   * dropped 의 applied-now 미리보기는 사용자가 건드린 것으로 간주해 문서에 남긴다.
   */
  private partitionDriftedOps(set: PendingChangeSet): { kept: PendingOp[]; dropped: PendingOp[] } {
    const kept: PendingOp[] = [];
    const dropped: PendingOp[] = [];
    for (const op of set.ops) {
      if ((op.kind === 'insert' || op.kind === 'delete' || op.kind === 'replace' || op.kind === 'format')
        && !this.verifyOpText(op)) {
        dropped.push(op);
        continue;
      }
      if (op.kind === 'field' && !this.verifyFieldOp(op)) {
        dropped.push(op);
        continue;
      }
      if (op.kind === 'object' && !this.verifyObjectOp(op.obj)) {
        dropped.push(op);
        continue;
      }
      // Template previews hold a full-document baseline while direct user and agent
      // writes are locked. Always keep them revertible; dropping one would strand
      // the structural preview in the document without approval or undo history.
      kept.push(op);
    }
    return { kept, dropped };
  }

  /**
   * 적용된 op 을 역순으로 raw wasm 으로 되돌린다 (이벤트 없음).
   * keepPreviewsOf = 되돌리지 않고 문서에 남길(드리프트) op — replace 스냅샷
   * 복원이 이들의 미리보기를 지우지 않도록 안전 판별에 쓰인다.
   * userEditSeqNow = 되돌림 시작 시점의 사용자 편집 카운터 (호출자가 변이 전에
   * 한 번만 샘플링해 넘긴다). replace 의 전체 스냅샷 복원 가부 판정에 쓰인다.
   */
  private revertAppliedOps(
    ops: PendingOp[], keepPreviewsOf: PendingOp[] = [], userEditSeqNow: number = this.userEditSeq,
  ): Set<string> {
    const wasm = this.deps.wasm;
    const failed = new Set<string>();
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      try {
        if (op.kind === 'insert') {
          const r = { ...op.range };
          const res = this.deleteRangeRaw(r);
          if (res?.ok !== true) continue;
          // 자신 포함 모든 pending 경계를 문서의 임시 before 상태에 맞춘다.
          this.shiftAllAfterDelete(r);
        } else if (op.kind === 'replace') {
          this.revertReplaceOp(op, ops, keepPreviewsOf, userEditSeqNow);
        } else if (op.kind === 'format') {
          this.applyFormatRaw(op.range, op.inverse);
        } else if (op.kind === 'field') {
          wasm.setFieldValueByName(op.name, op.oldValue);
        } else if (op.kind === 'template') {
          if (op.snapshotId === null) throw new Error('template snapshot is unavailable');
          wasm.restoreSnapshot(op.snapshotId);
        } else if (op.kind === 'object' && isObjectOpApplied(op.obj)) {
          if (!this.revertObjectOp(op.obj)) failed.add(op.id);
        }
        // delete/mark-only 는 되돌릴 것이 없다
      } catch (err) {
        console.warn('[pending-edits] revert failed for op', op.id, err);
        if (op.kind === 'object') failed.add(op.id);
      }
    }
    return failed;
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
    const start: DocPoint = { paraIdx: op.range.startParaIdx, charOffset: op.range.startCharOffset };
    const reinsertShift = this.insertShiftFor(start, op.deletedText);
    const userEditedSinceSnapshot = (op.userEditSeqAtSnapshot ?? -1) !== userEditSeqNow;
    if (op.snapshotId !== null && !userEditedSinceSnapshot
      && !this.hasLaterAppliedOpsOutside(op, revertSet, keepPreviewsOf)) {
      try {
        wasm.restoreSnapshot(op.snapshotId);
        // 문서가 "원본 복원" 상태로 바뀌었으므로 다른 op 들의 좌표를 맞춘다
        // (삽입분 제거 + 원본 재삽입과 동치).
        this.shiftAllAfterDelete(op.range, op);
        this.shiftAllAfterInsert(op.range.sectionIdx, reinsertShift, op, op.range.cell);
        return;
      } catch (err) {
        console.warn('[pending-edits] replace snapshot restore failed; falling back to inverse ops', err);
      }
    }
    // 폴백: 삽입 텍스트를 지우고 원본 텍스트+캡처 서식을 다시 삽입한다
    const res = this.deleteRangeRaw(op.range);
    if (res?.ok !== true) throw new AgentToolError('RPC_ERROR', 'replace revert: deleteRange failed');
    this.shiftAllAfterDelete(op.range, op);
    if (op.deletedText.length > 0) {
      const ins = this.performInsert(op.range.sectionIdx, start.paraIdx, start.charOffset, op.deletedText, op.range.cell);
      if (op.charShapeId !== null) this.applyCharShapeToRange(ins.range, op.charShapeId);
      // 원본 문단 서식 복원 (splitParagraph 는 시작 문단 모양을 물려주므로 줄별로 덮는다)
      for (let i = 0; i < op.paraShapeIds.length; i++) {
        const shapeId = op.paraShapeIds[i];
        if (shapeId < 0) continue;
        try {
          if (op.range.cell) {
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
    this.shiftAllAfterInsert(op.range.sectionIdx, reinsertShift, op, op.range.cell);
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
   * 이 op 이후(seq 가 더 큰) 적용된 applied-now 미리보기가 되돌림 대상 밖에 남아
   * 있는가 — 있으면 replace 스냅샷 복원이 그 미리보기까지 지우므로 폴백 해야 한다.
   */
  private hasLaterAppliedOpsOutside(
    op: PendingOp, revertSet: PendingOp[], keepPreviewsOf: PendingOp[],
  ): boolean {
    const isLaterApplied = (cand: PendingOp): boolean => {
      if (cand === op || (cand.seq ?? 0) <= (op.seq ?? 0)) return false;
      if (revertSet.includes(cand)) return false;
      switch (cand.kind) {
        case 'insert': case 'replace': case 'format': case 'field': case 'template': return true;
        case 'object': return isObjectOpApplied(cand.obj);
        default: return false; // delete/mark-only 는 문서를 바꾸지 않는다
      }
    };
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

  /** 캡처한 글자 모양을 범위 전체에 적용한다 (멀티 문단은 문단별로 쪼갠다) */
  private applyCharShapeToRange(range: DocRange, charShapeId: number): void {
    const wasm = this.deps.wasm;
    for (let p = range.startParaIdx; p <= range.endParaIdx; p++) {
      const len = this.containerParaLen(range.sectionIdx, p, range.cell);
      const from = p === range.startParaIdx ? range.startCharOffset : 0;
      const to = p === range.endParaIdx ? range.endCharOffset : len;
      if (to <= from) continue;
      const raw = range.cell
        ? wasm.setCharShapeIdInCell(
          range.sectionIdx, range.cell.paraIdx, range.cell.controlIdx, range.cell.cellIdx,
          p, from, to, charShapeId,
        )
        : wasm.setCharShapeId(range.sectionIdx, p, from, to, charShapeId);
      this.parseOkLenient(raw, 'setCharShapeId');
    }
  }

  /** 삭제·스타일 적용 등 승인 시점까지 mark-only 였던 연산만 현재 미리보기 위에 적용한다. */
  private applyApprovalOnlyOps(ops: PendingOp[]): DocumentPosition {
    const wasm = this.deps.wasm;
    let last: { sectionIdx: number; paraIdx: number; charOffset: number } | null = null;
    const bodyPos = (r: DocRange, paraIdx: number, charOffset: number) =>
      r.cell
        ? { sectionIdx: r.sectionIdx, paraIdx: r.cell.paraIdx, charOffset: 0 }
        : { sectionIdx: r.sectionIdx, paraIdx, charOffset };

    for (const op of ops) {
      try {
        if (op.kind === 'delete') {
          const r: DocRange = {
            ...op.range,
            cell: op.range.cell ? { ...op.range.cell } : undefined,
          };
          const res = this.deleteRangeRaw(r);
          if (res?.ok === true) {
            this.shiftAllAfterDelete(r, op);
            op.range = {
              sectionIdx: r.sectionIdx,
              cell: r.cell,
              startParaIdx: r.startParaIdx,
              startCharOffset: r.startCharOffset,
              endParaIdx: r.startParaIdx,
              endCharOffset: r.startCharOffset,
            };
            last = bodyPos(r, r.startParaIdx, r.startCharOffset);
          }
        } else if (op.kind === 'object' && !isObjectOpApplied(op.obj)) {
          const obj = op.obj;
          this.executeMarkedObjectOp(obj);
          last = { sectionIdx: obj.sectionIdx, paraIdx: this.objectBodyParaIdx(obj), charOffset: 0 };
        }
      } catch (err) {
        console.warn('[pending-edits] approval-only op failed', op.id, err);
        throw err;
      }
    }

    if (!last) return this.deps.inputHandler.getCursorPosition();
    const paraCount = wasm.getParagraphCount(last.sectionIdx);
    const paraIdx = Math.max(0, Math.min(last.paraIdx, paraCount - 1));
    const len = wasm.getParagraphLength(last.sectionIdx, paraIdx);
    return { sectionIndex: last.sectionIdx, paragraphIndex: paraIdx, charOffset: Math.min(last.charOffset, len) };
  }

  /** 객체 op 의 본문 기준 문단 인덱스 (커서 근사/overlay 용) */
  private objectBodyParaIdx(obj: ObjectOp): number {
    switch (obj.type) {
      case 'createTable': case 'insertImage': case 'insertEquation':
        return ('anchor' in obj && obj.anchor) ? obj.anchor.paraIdx : obj.paraIdx;
      case 'tableStructure': case 'tableStructureMarked': case 'deleteTable':
      case 'setCellProps': case 'setTableProps':
        return obj.tableParaIdx;
      case 'paraFormat': case 'applyStyle':
        return obj.cell ? obj.cell.paraIdx : obj.paraIdx;
      default:
        return 0;
    }
  }

  /** 본문 문단 좌표를 갖는 객체 op 필드들을 shift 함수에 통과시킨다 */
  private shiftObjectOp(obj: ObjectOp, sectionIdx: number, shift: (p: DocPoint) => DocPoint, insCell?: CellAddr): void {
    const shiftBody = (paraIdx: number, charOffset: number): DocPoint => shift({ paraIdx, charOffset });
    switch (obj.type) {
      case 'createTable': case 'insertImage': case 'insertEquation': {
        if (obj.sectionIdx !== sectionIdx) return;
        if (obj.type === 'insertEquation' && obj.cell) {
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
      case 'tableStructure': case 'tableStructureMarked': case 'deleteTable':
      case 'setCellProps': case 'setTableProps': {
        if (obj.sectionIdx !== sectionIdx || insCell) return;
        obj.tableParaIdx = shiftBody(obj.tableParaIdx, 0).paraIdx;
        return;
      }
      case 'paraFormat': case 'applyStyle': {
        if (obj.sectionIdx !== sectionIdx) return;
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
      default:
        return; // pageLayout / headerFooter 는 문단 좌표가 없다
    }
  }

  /** shift 로 문단 좌표/내용이 바뀐 paraFormat/applyStyle op 의 텍스트 지문을 다시 캡처한다 */
  private recaptureParaTextSample(obj: Extract<ObjectOp, { type: 'paraFormat' | 'applyStyle' }>): void {
    if (obj.textSample === undefined) return;
    const wasm = this.deps.wasm;
    try {
      const len = obj.cell
        ? wasm.getCellParagraphLength(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx)
        : wasm.getParagraphLength(obj.sectionIdx, obj.paraIdx);
      const n = Math.min(len, 24);
      obj.textSample = n === 0 ? '' : (obj.cell
        ? wasm.getTextInCell(obj.sectionIdx, obj.cell.paraIdx, obj.cell.controlIdx, obj.cell.cellIdx, obj.paraIdx, 0, n)
        : wasm.getTextRange(obj.sectionIdx, obj.paraIdx, 0, n));
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
          this.shiftRange(op.range, (p) => shiftPointAfterDelete(p, del));
        } else if (!del.cell && op.range.cell && removedParas > 0 && del.endParaIdx < op.range.cell.paraIdx) {
          // 본문 문단 삭제가 표 앞에서 일어나면 셀 op 의 부모 문단 인덱스만 당긴다.
          op.range.cell = { ...op.range.cell, paraIdx: op.range.cell.paraIdx - removedParas };
        }
      }
    }
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
