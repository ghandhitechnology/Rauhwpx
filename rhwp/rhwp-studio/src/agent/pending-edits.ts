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
 * 삽입 이후 좌표 이동 — strictly-after 규칙: 삽입 지점과 정확히 같은 경계는 움직이지
 * 않는다 (replace_range 의 삭제 마크 끝이 삽입 텍스트를 삼키지 않도록).
 */
export function shiftPointAfterInsert(p: DocPoint, ins: InsertShift): DocPoint {
  if (p.paraIdx < ins.paraIdx) return { paraIdx: p.paraIdx, charOffset: p.charOffset };
  if (p.paraIdx === ins.paraIdx) {
    if (p.charOffset <= ins.charOffset) return { paraIdx: p.paraIdx, charOffset: p.charOffset };
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
  private lastDigest: string | null;
  // 파라미터 프로퍼티 대신 명시적 할당 (node --test strip-only 모드 호환).
  private deps: PendingEditDeps;

  constructor(deps: PendingEditDeps) {
    this.deps = deps;
    this.lastDigest = deps.wasm.documentDigest;
    this.unsubs.push(deps.eventBus.on('history-jumped', () => {
      // undo/redo 후에는 대기 편집을 유지할 수 없다. 다만 그냥 버리면(R3 위반)
      // 이미 적용된 에이전트 삽입/서식이 승인 절차 없이 문서에 영구히 남으므로,
      // 텍스트 검증을 통과한 op 만 best-effort 로 되돌린 뒤 전부 해제한다.
      if (this.sets.length > 0) this.revertAllAndDiscard('undo/redo');
    }));
    this.unsubs.push(deps.eventBus.on('document-dirty-changed', () => {
      const digest = this.deps.wasm.documentDigest;
      if (digest === this.lastDigest) return;
      this.lastDigest = digest;
      if (this.sets.length > 0) this.discardAll('document loaded');
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

  endTurn(): void {
    if (!this.open) return;
    this.finalizeOpenSet();
  }

  insertText(
    agent: AgentName,
    addr: { sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr },
    text: string,
  ): { changeSetId: string; insertedRange: DocRange } {
    if (text.length === 0) throw new AgentToolError('INVALID_ARGS', 'text must not be empty');
    const { range, addedParas } = this.performInsert(addr.sectionIdx, addr.paraIdx, addr.charOffset, text, addr.cell);
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = { kind: 'insert', id: this.nextId('op'), agent, range, text };
    set.ops.push(op);
    this.shiftAllAfterInsert(range.sectionIdx, {
      paraIdx: addr.paraIdx, charOffset: addr.charOffset, addedParas,
      endParaIdx: range.endParaIdx, endCharOffset: range.endCharOffset, textLen: text.length,
    }, op, addr.cell);
    this.emitDocEvents('agent-pending-edit');
    this.syncOverlay();
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id, insertedRange: { ...range } };
  }

  markDelete(agent: AgentName, range: DocRange): { changeSetId: string; markedText: string } {
    if (range.endParaIdx < range.startParaIdx
      || (range.endParaIdx === range.startParaIdx && range.endCharOffset <= range.startCharOffset)) {
      throw new AgentToolError('INVALID_ARGS', 'delete range is empty or reversed');
    }
    // 문서 변이 없음(revision 불변): 텍스트만 캡처하고 마크만 기록한다.
    const text = this.captureRangeText(range);
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = { kind: 'delete', id: this.nextId('op'), agent, range: { ...range }, text };
    set.ops.push(op);
    this.syncOverlay();
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id, markedText: text.slice(0, 300) };
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
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = {
      kind: 'format', id: this.nextId('op'), agent, range: { ...range }, format: { ...format }, inverse,
    };
    set.ops.push(op);
    this.emitDocEvents('agent-pending-edit');
    this.syncOverlay();
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id };
  }

  setFieldValue(agent: AgentName, name: string, value: string):
      { changeSetId: string; fieldId: number; oldValue: string; newValue: string } {
    const parsed = this.deps.wasm.setFieldValueByName(name, value);
    if (parsed?.ok !== true) {
      throw new AgentToolError('RPC_ERROR', `setFieldValueByName('${name}') failed`);
    }
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = {
      kind: 'field', id: this.nextId('op'), agent, name,
      oldValue: parsed.oldValue, newValue: parsed.newValue,
    };
    set.ops.push(op);
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
    const op: PendingOp = { kind: 'object', id: this.nextId('op'), agent, obj };
    set.ops.push(op);
    if (isObjectOpApplied(obj)) this.emitDocEvents('agent-pending-edit');
    this.syncOverlay();
    this.emitChange({ type: 'ops-changed' });
    return { changeSetId: set.id, obj };
  }

  /** executor 가드: 해당 표에 파괴적 마크(delete_row/col, merge)가 걸려 있는가 */
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

  getChangeSets(): ReadonlyArray<PendingChangeSet> {
    return this.sets;
  }

  hasPending(): boolean {
    return this.sets.some((s) => s.ops.length > 0);
  }

  /** approve — 적용된 미리보기는 재생성하지 않고 그대로 단일 undo 항목으로 채택한다. */
  approve(changeSetId: string): void {
    const set = this.sets.find((s) => s.id === changeSetId);
    if (!set) return;
    if (set === this.open) this.open = null;
    const skipped = this.dropDriftedOps(set);

    if (set.ops.length === 0) {
      this.removeSet(set);
      this.syncOverlay();
      if (skipped > 0) this.emitChange({ type: 'invalidated', reason: `text drift (${skipped} ops skipped)` });
      this.emitChange({ type: 'approved', changeSetId });
      return;
    }

    const wasm = this.deps.wasm;
    const cursor = this.deps.inputHandler.getCursorPosition();
    const previewState = this.capturePendingState();
    let previewId: number | null = null;
    let beforeId: number | null = null;
    let command: PreparedSnapshotCommand | null = null;

    try {
      // preview + before + after 세 id가 잠시 공존한다. 오래된 history snapshot을
      // 선제 정리해 WASM 저장소의 무통보 축출을 막는다.
      this.deps.inputHandler.prepareSnapshotCapacity?.(3);
      // before 캡처를 위해 잠시 되돌리되, 즉시 원본 스냅샷을 복원한다. 텍스트를
      // 삭제 후 재삽입하지 않으므로 줄/문단/혼합 글자 서식이 미리보기와 동일하다.
      previewId = wasm.saveSnapshot();
      this.revertAppliedOps(set);
      beforeId = wasm.saveSnapshot();
      wasm.restoreSnapshot(previewId);
      this.restorePendingState(previewState);

      command = new PreparedSnapshotCommand(
        'agentApplyChangeSet', cursor, cursor, beforeId,
        () => this.applyApprovalOnlyOps(set),
      );
      beforeId = null; // command가 소유권을 인수했다.
      command.execute(wasm);
      wasm.discardSnapshot(previewId);
      previewId = null;
      this.deps.inputHandler.executeOperation({
        kind: 'record',
        command,
        meta: { refresh: 'full' },
      });
    } catch (err) {
      if (previewId !== null) {
        try { wasm.restoreSnapshot(previewId); } catch { /* best effort */ }
        wasm.discardSnapshot(previewId);
      }
      if (beforeId !== null) wasm.discardSnapshot(beforeId);
      command?.discard(wasm);
      this.restorePendingState(previewState);
      set.status = 'awaiting-review';
      this.emitDocEvents('agent-pending-edit');
      this.syncOverlay();
      console.warn('[pending-edits] approve snapshot capture failed', err);
      this.emitChange({ type: 'invalidated', reason: 'approval failed' });
      return;
    }

    this.removeSet(set);
    this.syncOverlay();
    if (skipped > 0) this.emitChange({ type: 'invalidated', reason: `text drift (${skipped} ops skipped)` });
    this.emitChange({ type: 'approved', changeSetId });
  }

  /** reject — 적용된 op 을 되돌리고 삭제 마크를 해제한다. 히스토리 항목 없음. */
  reject(changeSetId: string): void {
    const set = this.sets.find((s) => s.id === changeSetId);
    if (!set) return;
    if (set === this.open) this.open = null;
    const skipped = this.dropDriftedOps(set);
    this.revertAppliedOps(set);
    this.emitDocEvents('agent-reject');
    this.removeSet(set);
    this.syncOverlay();
    if (skipped > 0) this.emitChange({ type: 'invalidated', reason: `text drift (${skipped} ops skipped)` });
    this.emitChange({ type: 'rejected', changeSetId });
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
  }

  // ─── 내부 ────────────────────────────────────────────

  private nextId(prefix: string): string {
    return `${prefix}-${Date.now()}-${++this.counter}`;
  }

  private ensureOpenSet(agent: AgentName): PendingChangeSet {
    // turn-start 를 놓친 write 도 수용: 해당 에이전트의 set 을 자동으로 연다.
    if (this.open && this.open.agent === agent) return this.open;
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
    this.sets = [];
    this.open = null;
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
      this.dropDriftedOps(set);
      if (set.ops.some((op) => op.kind !== 'delete')) reverted = true;
      this.revertAppliedOps(set);
    }
    this.sets = [];
    this.open = null;
    this.deps.overlay.clear();
    if (reverted) this.emitDocEvents('agent-invalidate');
    this.emitChange({ type: 'invalidated', reason });
  }

  private emitChange(e: PendingEditsChangeEvent): void {
    for (const cb of this.listeners) {
      try { cb(e); } catch (err) { console.warn('[pending-edits] onChange listener failed', err); }
    }
  }

  private emitDocEvents(reason: string): void {
    this.deps.eventBus.emit('document-mutated', reason);
    this.deps.eventBus.emit('document-changed');
  }

  private syncOverlay(): void {
    const ops: OverlayOp[] = [];
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind === 'field') continue;
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
        ops.push({ kind: op.kind, agent: op.agent, range: op.range });
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
        return { sort: 'table', sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx };
      case 'tableStructureMarked': {
        const base = { sort: 'cells' as const, sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx };
        if (obj.op === 'delete_row') return { ...base, rowIdx: obj.rowIdx };
        if (obj.op === 'delete_col') return { ...base, colIdx: obj.colIdx };
        return { ...base, rect: { startRow: obj.startRow!, startCol: obj.startCol!, endRow: obj.endRow!, endCol: obj.endCol! } };
      }
      case 'setCellProps':
        return { sort: 'cells', sectionIdx: obj.sectionIdx, paraIdx: obj.tableParaIdx, controlIdx: obj.controlIdx, cellIdx: obj.cellIdx };
      case 'paraFormat':
      case 'applyStyle':
        return { sort: 'para', sectionIdx: obj.sectionIdx, paraIdx: obj.paraIdx, cell: obj.cell };
      default:
        return null;
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
                  obj.sectionIdx, res.paraIdx, res.controlIdx, c, 0, 0, firstLine.length,
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
        } else {
          wasm.mergeTableCells(
            obj.sectionIdx, obj.tableParaIdx, obj.controlIdx,
            obj.startRow!, obj.startCol!, obj.endRow!, obj.endCol!,
          );
        }
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

  /** 같은 표에 pending 구조 op(행/열 삽입·삭제·병합)이 있는가 */
  private hasStructuralSibling(sectionIdx: number, anchor: ObjectAnchor): boolean {
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op.kind !== 'object') continue;
        const o = op.obj;
        if ((o.type === 'tableStructure' || o.type === 'tableStructureMarked')
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
        if (op.kind === 'insert' || op.kind === 'delete' || op.kind === 'format') {
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
          || o.type === 'setCellProps' || o.type === 'setTableProps') {
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
            || o.type === 'setCellProps' || o.type === 'setTableProps')
            && o.sectionIdx === sectionIdx && o.tableParaIdx === paraIdx && hit(o.controlIdx)) {
            o.controlIdx += delta;
          } else if ((o.type === 'paraFormat' || o.type === 'applyStyle' || o.type === 'insertEquation')
            && o.cell && o.sectionIdx === sectionIdx
            && o.cell.paraIdx === paraIdx && hit(o.cell.controlIdx)) {
            o.cell = { ...o.cell, controlIdx: o.cell.controlIdx + delta };
          }
          continue;
        }
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
      this.parseOk(wasm.insertTextInCell(sec, anchor.paraIdx, anchor.controlIdx, cellIdx, 0, 0, lines[0]), 'insertTextInCell');
      off = lines[0].length;
    }
    for (let i = 1; i < lines.length; i++) {
      this.parseOk(wasm.splitParagraphInCell(sec, anchor.paraIdx, anchor.controlIdx, cellIdx, para, off), 'splitParagraphInCell');
      para += 1;
      off = 0;
      if (lines[i].length > 0) {
        this.parseOk(wasm.insertTextInCell(sec, anchor.paraIdx, anchor.controlIdx, cellIdx, para, 0, lines[i]), 'insertTextInCell');
        off = lines[i].length;
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
      off = obj.text.length;
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
    const insertLine = (p: number, o: number, line: string) => {
      if (cell) {
        this.parseOk(
          wasm.insertTextInCell(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, p, o, line),
          'insertTextInCell',
        );
      } else {
        this.parseOk(wasm.insertText(sec, p, o, line), 'insertText');
      }
    };
    const splitPara = (p: number, o: number) => {
      if (cell) {
        this.parseOk(
          wasm.splitParagraphInCell(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, p, o),
          'splitParagraphInCell',
        );
      } else {
        this.parseOk(wasm.splitParagraph(sec, p, o), 'splitParagraph');
      }
    };
    try {
      if (lines[0].length > 0) {
        insertLine(para, off, lines[0]);
        curOff = off + lines[0].length;
      }
      for (let i = 1; i < lines.length; i++) {
        splitPara(curPara, curOff);
        curPara += 1;
        curOff = 0;
        if (lines[i].length > 0) {
          insertLine(curPara, 0, lines[i]);
          curOff = lines[i].length;
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

  /** approve/reject 검증: 저장된 텍스트가 아직 그 자리에 있는가 (멀티 문단은 첫 줄만 — 근사) */
  private verifyOpText(op: Extract<PendingOp, { kind: 'insert' | 'delete' }>): boolean {
    const r = op.range;
    try {
      const paraCount = this.containerParaCount(r.sectionIdx, r.cell);
      if (r.startParaIdx >= paraCount || r.endParaIdx >= paraCount) return false;
      if (r.startParaIdx === r.endParaIdx) {
        const len = this.containerParaLen(r.sectionIdx, r.startParaIdx, r.cell);
        if (r.endCharOffset > len || r.startCharOffset > r.endCharOffset) return false;
        return this.containerText(
          r.sectionIdx, r.startParaIdx, r.startCharOffset, r.endCharOffset - r.startCharOffset, r.cell,
        ) === op.text;
      }
      const firstLine = op.text.split('\n')[0];
      const len = this.containerParaLen(r.sectionIdx, r.startParaIdx, r.cell);
      if (r.startCharOffset + firstLine.length > len) return false;
      if (firstLine.length === 0) return true;
      return this.containerText(r.sectionIdx, r.startParaIdx, r.startCharOffset, firstLine.length, r.cell) === firstLine;
    } catch {
      return false;
    }
  }

  /** 드리프트된 insert/delete/object op 을 set 에서 제거하고 개수를 반환 */
  private dropDriftedOps(set: PendingChangeSet): number {
    const kept: PendingOp[] = [];
    let skipped = 0;
    for (const op of set.ops) {
      if ((op.kind === 'insert' || op.kind === 'delete') && !this.verifyOpText(op)) {
        skipped += 1;
        continue;
      }
      if (op.kind === 'object' && !this.verifyObjectOp(op.obj)) {
        skipped += 1;
        continue;
      }
      kept.push(op);
    }
    set.ops = kept;
    return skipped;
  }

  /** 적용된 op 을 역순으로 raw wasm 으로 되돌린다 (이벤트 없음). */
  private revertAppliedOps(set: PendingChangeSet): Set<string> {
    const wasm = this.deps.wasm;
    const failed = new Set<string>();
    for (let i = set.ops.length - 1; i >= 0; i--) {
      const op = set.ops[i];
      try {
        if (op.kind === 'insert') {
          const r = { ...op.range };
          const res = this.deleteRangeRaw(r);
          if (res?.ok !== true) continue;
          // 자신 포함 모든 pending 경계를 문서의 임시 before 상태에 맞춘다.
          this.shiftAllAfterDelete(r);
        } else if (op.kind === 'format') {
          this.applyFormatRaw(op.range, op.inverse);
        } else if (op.kind === 'field') {
          wasm.setFieldValueByName(op.name, op.oldValue);
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

  /** 삭제·스타일 적용 등 승인 시점까지 mark-only 였던 연산만 현재 미리보기 위에 적용한다. */
  private applyApprovalOnlyOps(set: PendingChangeSet): DocumentPosition {
    const wasm = this.deps.wasm;
    let last: { sectionIdx: number; paraIdx: number; charOffset: number } | null = null;
    const bodyPos = (r: DocRange, paraIdx: number, charOffset: number) =>
      r.cell
        ? { sectionIdx: r.sectionIdx, paraIdx: r.cell.paraIdx, charOffset: 0 }
        : { sectionIdx: r.sectionIdx, paraIdx, charOffset };

    for (const op of set.ops) {
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
      case 'tableStructure': case 'tableStructureMarked': case 'setCellProps': case 'setTableProps':
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
      case 'tableStructure': case 'tableStructureMarked': case 'setCellProps': case 'setTableProps': {
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
            }
          } else {
            obj.cell = { ...obj.cell, paraIdx: shiftBody(obj.cell.paraIdx, 0).paraIdx };
          }
        } else if (!insCell) {
          const p = shiftBody(obj.paraIdx, obj.charOffset);
          obj.paraIdx = p.paraIdx; obj.charOffset = p.charOffset;
        }
        return;
      }
      default:
        return; // pageLayout / headerFooter 는 문단 좌표가 없다
    }
  }

  private shiftAllAfterInsert(sectionIdx: number, ins: InsertShift, exclude?: PendingOp, cell?: CellAddr): void {
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op === exclude || op.kind === 'field') continue;
        if (op.kind === 'object') {
          this.shiftObjectOp(op.obj, sectionIdx, (p) => shiftPointAfterInsert(p, ins), cell);
          continue;
        }
        if (op.range.sectionIdx !== sectionIdx) continue;
        if (sameCell(op.range.cell, cell)) {
          this.shiftRange(op.range, (p) => shiftPointAfterInsert(p, ins));
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
        if (op === exclude || op.kind === 'field') continue;
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
}
