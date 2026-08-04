import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { DocumentPosition, CharProperties } from '../core/types.ts';
import type {
  AgentName, CharFormatProps, DocPoint, DocRange,
  PendingChangeSet, PendingEditsChangeEvent, PendingOp,
} from './types.ts';
import { AgentToolError } from './types.ts';
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
 * undo 항목은 approve() 시 snapshot operation 하나로만 생성된다.
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
    addr: { sectionIdx: number; paraIdx: number; charOffset: number },
    text: string,
  ): { changeSetId: string; insertedRange: DocRange } {
    if (text.length === 0) throw new AgentToolError('INVALID_ARGS', 'text must not be empty');
    const { range, addedParas } = this.performInsert(addr.sectionIdx, addr.paraIdx, addr.charOffset, text);
    const set = this.ensureOpenSet(agent);
    const op: PendingOp = { kind: 'insert', id: this.nextId('op'), agent, range, text };
    set.ops.push(op);
    this.shiftAllAfterInsert(range.sectionIdx, {
      paraIdx: addr.paraIdx, charOffset: addr.charOffset, addedParas,
      endParaIdx: range.endParaIdx, endCharOffset: range.endCharOffset, textLen: text.length,
    }, op);
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
    if (keys.length === 0) throw new AgentToolError('INVALID_ARGS', 'at least one format property is required');
    // 역서식은 시작 지점 단일 샘플 근사 — 혼합 서식 범위에서는 부정확할 수 있다 (Phase-1 한계).
    const props: CharProperties = this.deps.wasm.getCharPropertiesAt(
      range.sectionIdx, range.startParaIdx, range.startCharOffset,
    );
    const inverse: CharFormatProps = {};
    for (const k of keys) {
      const prev = props[k];
      if (prev !== undefined) (inverse as Record<string, unknown>)[k] = prev;
      else if (typeof format[k] === 'boolean') (inverse as Record<string, unknown>)[k] = false;
    }
    const raw = this.deps.wasm.applyCharFormat(
      range.sectionIdx, range.startParaIdx, range.startCharOffset, range.endCharOffset,
      JSON.stringify(format),
    );
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

  getChangeSets(): ReadonlyArray<PendingChangeSet> {
    return this.sets;
  }

  hasPending(): boolean {
    return this.sets.some((s) => s.ops.length > 0);
  }

  /**
   * approve — revert-then-replay 로 change-set 전체를 snapshot operation 하나
   * (= undo 한 번)로 커밋한다.
   */
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

    this.revertAppliedOps(set);

    let replayRan = false;
    this.deps.inputHandler.executeOperation({
      kind: 'snapshot',
      operationType: 'agentApplyChangeSet',
      operation: (wasm) => {
        replayRan = true;
        return this.replayOps(wasm, set);
      },
    });

    if (!replayRan) {
      // form 편집 모드 등에서 executeOperation 이 조용히 no-op 된 경우 (Phase-1 한계):
      // step-2 revert 를 되돌려 pending 상태를 복원한다.
      this.reapplyOps(set);
      set.status = 'awaiting-review';
      this.emitDocEvents('agent-pending-edit');
      this.syncOverlay();
      this.emitChange({ type: 'invalidated', reason: 'edit blocked (form mode)' });
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
        ops.push({ kind: op.kind, agent: op.agent, range: op.range });
      }
    }
    this.deps.overlay.setOps(ops);
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

  /** §5.4 멀티라인 삽입 — 실패 시 부분 적용분을 best-effort 롤백한다 */
  private performInsert(sec: number, para: number, off: number, text: string):
      { range: DocRange; addedParas: number } {
    const wasm = this.deps.wasm;
    const lines = text.split('\n');
    let curPara = para;
    let curOff = off;
    try {
      if (lines[0].length > 0) {
        this.parseOk(wasm.insertText(sec, para, off, lines[0]), 'insertText');
        curOff = off + lines[0].length;
      }
      for (let i = 1; i < lines.length; i++) {
        this.parseOk(wasm.splitParagraph(sec, curPara, curOff), 'splitParagraph');
        curPara += 1;
        curOff = 0;
        if (lines[i].length > 0) {
          this.parseOk(wasm.insertText(sec, curPara, 0, lines[i]), 'insertText');
          curOff = lines[i].length;
        }
      }
    } catch (e) {
      if (curPara !== para || curOff !== off) {
        try { wasm.deleteRange(sec, para, off, curPara, curOff); } catch { /* best effort */ }
      }
      throw e;
    }
    return {
      range: {
        sectionIdx: sec, startParaIdx: para, startCharOffset: off,
        endParaIdx: curPara, endCharOffset: curOff,
      },
      addedParas: lines.length - 1,
    };
  }

  private captureRangeText(range: DocRange): string {
    const wasm = this.deps.wasm;
    const sec = range.sectionIdx;
    const paraCount = wasm.getParagraphCount(sec);
    if (range.startParaIdx >= paraCount || range.endParaIdx >= paraCount) {
      throw new AgentToolError('INVALID_ARGS',
        `paragraph index out of bounds (section ${sec} has ${paraCount} paragraphs)`);
    }
    const parts: string[] = [];
    for (let p = range.startParaIdx; p <= range.endParaIdx; p++) {
      const len = wasm.getParagraphLength(sec, p);
      const from = p === range.startParaIdx ? range.startCharOffset : 0;
      const to = p === range.endParaIdx ? range.endCharOffset : len;
      if (from > len || to > len) {
        throw new AgentToolError('INVALID_ARGS',
          `char offset out of bounds (paragraph ${p} has length ${len})`);
      }
      parts.push(to > from ? wasm.getTextRange(sec, p, from, to - from) : '');
    }
    return parts.join('\n');
  }

  /** approve/reject 검증: 저장된 텍스트가 아직 그 자리에 있는가 (멀티 문단은 첫 줄만 — 근사) */
  private verifyOpText(op: Extract<PendingOp, { kind: 'insert' | 'delete' }>): boolean {
    const r = op.range;
    const wasm = this.deps.wasm;
    try {
      const paraCount = wasm.getParagraphCount(r.sectionIdx);
      if (r.startParaIdx >= paraCount || r.endParaIdx >= paraCount) return false;
      if (r.startParaIdx === r.endParaIdx) {
        const len = wasm.getParagraphLength(r.sectionIdx, r.startParaIdx);
        if (r.endCharOffset > len || r.startCharOffset > r.endCharOffset) return false;
        return wasm.getTextRange(
          r.sectionIdx, r.startParaIdx, r.startCharOffset, r.endCharOffset - r.startCharOffset,
        ) === op.text;
      }
      const firstLine = op.text.split('\n')[0];
      const len = wasm.getParagraphLength(r.sectionIdx, r.startParaIdx);
      if (r.startCharOffset + firstLine.length > len) return false;
      if (firstLine.length === 0) return true;
      return wasm.getTextRange(r.sectionIdx, r.startParaIdx, r.startCharOffset, firstLine.length) === firstLine;
    } catch {
      return false;
    }
  }

  /** 드리프트된 insert/delete op 을 set 에서 제거하고 개수를 반환 */
  private dropDriftedOps(set: PendingChangeSet): number {
    const kept: PendingOp[] = [];
    let skipped = 0;
    for (const op of set.ops) {
      if ((op.kind === 'insert' || op.kind === 'delete') && !this.verifyOpText(op)) {
        skipped += 1;
        continue;
      }
      kept.push(op);
    }
    set.ops = kept;
    return skipped;
  }

  /** step-2 revert: 이 set 의 적용된 op 을 역순으로 raw wasm 으로 되돌린다 (이벤트 없음) */
  private revertAppliedOps(set: PendingChangeSet): void {
    const wasm = this.deps.wasm;
    for (let i = set.ops.length - 1; i >= 0; i--) {
      const op = set.ops[i];
      try {
        if (op.kind === 'insert') {
          const r = { ...op.range };
          const res = wasm.deleteRange(r.sectionIdx, r.startParaIdx, r.startCharOffset, r.endParaIdx, r.endCharOffset);
          if (res?.ok !== true) continue;
          // 자신 포함 모든 pending 경계를 이동: 자신의 range 는 시작점으로 collapse 되어
          // replay 시 삽입 주소가 된다.
          this.shiftAllAfterDelete(r);
        } else if (op.kind === 'format') {
          wasm.applyCharFormat(
            op.range.sectionIdx, op.range.startParaIdx, op.range.startCharOffset, op.range.endCharOffset,
            JSON.stringify(op.inverse),
          );
        } else if (op.kind === 'field') {
          wasm.setFieldValueByName(op.name, op.oldValue);
        }
        // delete 마크는 되돌릴 것이 없다
      } catch (err) {
        console.warn('[pending-edits] revert failed for op', op.id, err);
      }
    }
  }

  /** approve step-3 실패(form mode) 시 revert 를 다시 원상복구한다 */
  private reapplyOps(set: PendingChangeSet): void {
    const wasm = this.deps.wasm;
    for (const op of set.ops) {
      try {
        if (op.kind === 'insert') {
          const at = { paraIdx: op.range.startParaIdx, charOffset: op.range.startCharOffset };
          const { range, addedParas } = this.performInsert(op.range.sectionIdx, at.paraIdx, at.charOffset, op.text);
          op.range = range;
          this.shiftAllAfterInsert(range.sectionIdx, {
            paraIdx: at.paraIdx, charOffset: at.charOffset, addedParas,
            endParaIdx: range.endParaIdx, endCharOffset: range.endCharOffset, textLen: op.text.length,
          }, op);
        } else if (op.kind === 'format') {
          wasm.applyCharFormat(
            op.range.sectionIdx, op.range.startParaIdx, op.range.startCharOffset, op.range.endCharOffset,
            JSON.stringify(op.format),
          );
        } else if (op.kind === 'field') {
          wasm.setFieldValueByName(op.name, op.newValue);
        }
      } catch (err) {
        console.warn('[pending-edits] reapply failed for op', op.id, err);
      }
    }
  }

  /** approve step-3: snapshot operation 안에서 시간순으로 재적용한다 */
  private replayOps(wasm: WasmBridge, set: PendingChangeSet): DocumentPosition {
    let last: { sectionIdx: number; paraIdx: number; charOffset: number } | null = null;
    for (const op of set.ops) {
      try {
        if (op.kind === 'insert') {
          const at = { paraIdx: op.range.startParaIdx, charOffset: op.range.startCharOffset };
          const { range, addedParas } = this.performInsert(op.range.sectionIdx, at.paraIdx, at.charOffset, op.text);
          op.range = range;
          this.shiftAllAfterInsert(range.sectionIdx, {
            paraIdx: at.paraIdx, charOffset: at.charOffset, addedParas,
            endParaIdx: range.endParaIdx, endCharOffset: range.endCharOffset, textLen: op.text.length,
          }, op);
          last = { sectionIdx: range.sectionIdx, paraIdx: range.endParaIdx, charOffset: range.endCharOffset };
        } else if (op.kind === 'delete') {
          const r = { ...op.range };
          const res = wasm.deleteRange(r.sectionIdx, r.startParaIdx, r.startCharOffset, r.endParaIdx, r.endCharOffset);
          if (res?.ok === true) {
            this.shiftAllAfterDelete(r, op);
            op.range = {
              sectionIdx: r.sectionIdx,
              startParaIdx: r.startParaIdx, startCharOffset: r.startCharOffset,
              endParaIdx: r.startParaIdx, endCharOffset: r.startCharOffset,
            };
            last = { sectionIdx: r.sectionIdx, paraIdx: r.startParaIdx, charOffset: r.startCharOffset };
          }
        } else if (op.kind === 'format') {
          wasm.applyCharFormat(
            op.range.sectionIdx, op.range.startParaIdx, op.range.startCharOffset, op.range.endCharOffset,
            JSON.stringify(op.format),
          );
          last = { sectionIdx: op.range.sectionIdx, paraIdx: op.range.endParaIdx, charOffset: op.range.endCharOffset };
        } else {
          wasm.setFieldValueByName(op.name, op.newValue);
        }
      } catch (err) {
        console.warn('[pending-edits] replay failed for op', op.id, err);
      }
    }
    if (!last) return this.deps.inputHandler.getCursorPosition();
    const paraCount = wasm.getParagraphCount(last.sectionIdx);
    const paraIdx = Math.max(0, Math.min(last.paraIdx, paraCount - 1));
    const len = wasm.getParagraphLength(last.sectionIdx, paraIdx);
    return { sectionIndex: last.sectionIdx, paragraphIndex: paraIdx, charOffset: Math.min(last.charOffset, len) };
  }

  private shiftAllAfterInsert(sectionIdx: number, ins: InsertShift, exclude?: PendingOp): void {
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op === exclude || op.kind === 'field') continue;
        if (op.range.sectionIdx !== sectionIdx) continue;
        this.shiftRange(op.range, (p) => shiftPointAfterInsert(p, ins));
      }
    }
  }

  private shiftAllAfterDelete(del: DocRange, exclude?: PendingOp): void {
    for (const set of this.sets) {
      for (const op of set.ops) {
        if (op === exclude || op.kind === 'field') continue;
        if (op.range.sectionIdx !== del.sectionIdx) continue;
        this.shiftRange(op.range, (p) => shiftPointAfterDelete(p, del));
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
