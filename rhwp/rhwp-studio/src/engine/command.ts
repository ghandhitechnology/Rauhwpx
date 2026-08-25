import type { RemovedParaMeta, WasmBridge } from '@/core/wasm-bridge';
import type { DocumentPosition, CharProperties, ParaProperties, CellPathLike, CellPathEntry } from '@/core/types';
import { MAX_PAGE_LOCAL_TEXT_EDIT_CHARS } from './input-edit-invalidation';
import type { LineEndpoints as LineEndpointsLike } from './object-drag-record';
import {
  editableTargetFromPosition,
  targetCellPathJson,
  type EditableParagraphTarget,
  type EditableTextRange,
} from './edit-target';

/** 편집 명령 공통 인터페이스 */
export interface EditCommand {
  readonly type: string;
  readonly timestamp: number;
  /** 명령 실행 — 실행 후 커서 위치 반환 */
  execute(wasm: WasmBridge): DocumentPosition;
  /** 역실행 — 실행 전 커서 위치 반환 */
  undo(wasm: WasmBridge): DocumentPosition;
  /** 연속 명령 병합 시도 */
  mergeWith(other: EditCommand): EditCommand | null;
  /** 리소스 해제 (스냅샷 명령의 메모리 반환 등). 스택에서 제거될 때 호출. */
  discard?(wasm: WasmBridge): void;
  /**
   * [Task #2328] 이 명령이 현재 점유한 WASM 스냅샷 id 개수(없으면 0).
   * CommandHistory 가 스냅샷 예산을 WASM 상한과 정합시키는 데 쓴다.
   */
  snapshotResourceCount?(): number;
  /** page-local refresh 판정을 위한 가벼운 텍스트 편집 payload. */
  getPageLocalTextEditOptions?(): { insertedText?: string; deleteCount?: number };
  /** 방금 실행한 mutation effect를 한 번만 반환한다. */
  consumeTextMutationEffects?(): TextMutationEffects;
  /**
   * [Task #2337] 이 커맨드의 마지막 execute/undo 후 복원할 머리말/꼬리말·각주 편집
   * 컨텍스트. 본문 커맨드는 미구현(→ 반환 없음 = 본문 모드). InputHandler 가 undo/redo
   * 시 이 값을 읽어 HF/FN 모드 재진입 + 커서 위치를 복원하고 본문 moveTo 를 건너뛴다.
   */
  editContext?(): EditContext | null;
}

/**
 * [Task #2337] 머리말/꼬리말·각주 편집 커맨드가 undo/redo 후 복원할 편집 컨텍스트.
 * 본문 DocumentPosition 과 별개인 HF/FN 커서 모드를 서술한다(cursor.ts 의
 * enterHeaderFooterMode/enterFootnoteMode + set{Hf,Fn}CursorPosition 인자에 대응).
 */
export type EditContext =
  | {
      readonly mode: 'headerFooter';
      readonly sectionIdx: number;
      readonly isHeader: boolean;
      readonly applyTo: number;
      readonly paraIdx: number;
      readonly charOffset: number;
    }
  | {
      readonly mode: 'footnote';
      readonly sectionIdx: number;
      readonly paraIdx: number;
      readonly controlIdx: number;
      readonly footnoteIndex: number;
      readonly pageNum: number;
      readonly innerParaIdx: number;
      readonly charOffset: number;
    };

/** text mutation의 document pagination/flow 경계와 immediate 완료를 함께 전달한다. */
export interface TextMutationEffects {
  readonly documentPaginationPending: boolean;
  readonly flowChanged: boolean;
  readonly paginationCompleted: boolean;
}

export const NO_TEXT_MUTATION_EFFECTS: TextMutationEffects = Object.freeze({
  documentPaginationPending: false,
  flowChanged: false,
  paginationCompleted: false,
});

export const IMMEDIATE_TEXT_MUTATION_EFFECTS: TextMutationEffects = Object.freeze({
  documentPaginationPending: false,
  flowChanged: false,
  paginationCompleted: true,
});

/** raw IME/iOS 묶음에서 effect를 OR 누적하고 한 번만 소비한다. */
export class TextMutationEffectAccumulator {
  private effects: TextMutationEffects = NO_TEXT_MUTATION_EFFECTS;

  add(effects: TextMutationEffects): void {
    this.effects = {
      documentPaginationPending:
        this.effects.documentPaginationPending || effects.documentPaginationPending,
      flowChanged: this.effects.flowChanged || effects.flowChanged,
      paginationCompleted: this.effects.paginationCompleted || effects.paginationCompleted,
    };
  }

  consume(): TextMutationEffects {
    const effects = this.effects;
    this.effects = NO_TEXT_MUTATION_EFFECTS;
    return effects;
  }

  clear(): void {
    this.effects = NO_TEXT_MUTATION_EFFECTS;
  }
}

// ─── 편집 작업 서술자 (라우팅 통합) ────────────────────

export type EditDomain =
  | 'text'
  | 'charFormat'
  | 'paraFormat'
  | 'table'
  | 'object'
  | 'page'
  | 'field'
  | 'view'
  | 'unknown';

export type RefreshPolicy = 'auto' | 'full' | 'pageLocal' | 'selectionOnly' | 'none';

export type DirtyScope =
  | 'document'
  | 'section'
  | 'page'
  | 'paragraph'
  | 'table'
  | 'object'
  | 'none';

export type SelectionPolicy =
  | 'auto'
  | 'keep'
  | 'moveToResult'
  | 'restoreObjectSelection'
  | 'none';

export interface OperationMetadata {
  /** 메뉴/툴바/단축키 action id. */
  actionId?: string;
  /** 사용자 입력 잠금을 건너뛸 수 있는 자율 편집 bookkeeping 인가. */
  origin?: 'user' | 'agent';
  /** 편집 도메인. 직접 wasm mutation을 audit 할 때 분류 기준으로 사용한다. */
  domain?: EditDomain;
  /** mutation 후 렌더링 갱신 정책. 생략하면 kind 별 기존 기본값을 따른다. */
  refresh?: RefreshPolicy;
  /** 장기적으로 renderer invalidation 최적화에 사용할 dirty 범위. */
  dirtyScope?: DirtyScope;
  /** selection/caret 복원 정책. 현재는 문서화용 metadata로만 사용한다. */
  selection?: SelectionPolicy;
  /**
   * mutation 후 뷰포트 정책. 'preserve' 는 caret 자동 스크롤(scrollCaretIntoView)을
   * 생략한다 — 에이전트 승인처럼 사용자가 보고 있는 지점이 caret 과 다른 편집용.
   */
  scroll?: 'auto' | 'preserve';
}

/**
 * 편집 작업 서술자 — 호출부가 "무엇을 하려는가"만 기술하고,
 * 라우터(executeOperation)가 적절한 Undo 전략을 자동 선택한다.
 *
 * - command: 정밀 커맨드 (텍스트 삽입/삭제, 문단 분할/병합, 서식)
 * - snapshot: 스냅샷 기반 커맨드 (붙여넣기, 객체 삭제 등)
 * - record:  WASM 직접 호출 후 히스토리에만 기록 (IME, 객체 이동).
 *            아키텍처 문서에서는 recordApplied 계약으로 정의한다.
 */
export type OperationDescriptor =
  | { kind: 'command'; command: EditCommand; meta?: OperationMetadata }
  | { kind: 'snapshot'; operationType: string; operation: (wasm: WasmBridge) => DocumentPosition; meta?: OperationMetadata }
  | { kind: 'record'; command: EditCommand; meta?: OperationMetadata };

// ─── 본문/셀 분기 헬퍼 ────────────────────────────────

function isCell(pos: DocumentPosition): boolean {
  return pos.parentParaIndex !== undefined;
}

/** 중첩 표(depth > 1)인지 확인 */
function isNestedCell(pos: DocumentPosition): boolean {
  return (pos.cellPath?.length ?? 0) > 1;
}

export function canUseDeferredCellTextInsert(pos: DocumentPosition, text: string): boolean {
  if (!isCell(pos) || isNestedCell(pos)) return false;
  if (text.length === 0 || charCount(text) > MAX_PAGE_LOCAL_TEXT_EDIT_CHARS) return false;
  if (/[\r\n\t]/.test(text)) return false;
  return true;
}

export function canUseDeferredCellTextDelete(pos: DocumentPosition, count: number): boolean {
  if (!isCell(pos) || isNestedCell(pos)) return false;
  return Number.isInteger(count) && count > 0 && count <= MAX_PAGE_LOCAL_TEXT_EDIT_CHARS;
}

export function canUseDeferredCellTextReplace(
  pos: DocumentPosition,
  deleteCount: number,
  text: string,
): boolean {
  if (!isCell(pos) || isNestedCell(pos)) return false;
  if (
    !Number.isInteger(deleteCount) ||
    deleteCount < 1 ||
    deleteCount > MAX_PAGE_LOCAL_TEXT_EDIT_CHARS
  ) {
    return false;
  }
  const textChars = charCount(text);
  if (textChars < 1 || textChars > MAX_PAGE_LOCAL_TEXT_EDIT_CHARS) return false;
  if (/[\r\n\t]/.test(text)) return false;
  return true;
}

export function canUseLocalBodyTextReplace(
  pos: DocumentPosition,
  deleteCount: number,
  text: string,
): boolean {
  if (isCell(pos)) return false;
  if (!Number.isInteger(deleteCount) || deleteCount < 0 || deleteCount > MAX_PAGE_LOCAL_TEXT_EDIT_CHARS) {
    return false;
  }
  if (deleteCount === 0 && text.length === 0) return false;
  if (charCount(text) > MAX_PAGE_LOCAL_TEXT_EDIT_CHARS) return false;
  if (/[\r\n\t]/.test(text)) return false;
  return true;
}

/** cellPath를 WASM용 JSON 문자열로 변환 */
function cellPathJson(pos: DocumentPosition): string {
  return JSON.stringify(pos.cellPath ?? []);
}

/**
 * 셀 문단 인덱스 — cellPath 가 있으면 마지막(가장 안쪽) 엔트리에서 읽는다.
 *
 * hit-test 는 flat 필드(controlIndex/cellIndex/cellParaIndex)를 `cellPath[0]`, 즉 **최외곽**
 * 엔트리에서 채운다(cursor_rect.rs 의 `outer = &ctx.path[0]`). 그래서 중첩 셀에서
 * `pos.cellParaIndex` 는 바깥 셀의 문단 인덱스이고, 안쪽 셀의 값은
 * `cellPath[last].cellParaIndex` 다. 이를 섞으면 ...ByPath API 에 바깥 축의 인덱스를 넘겨
 * 엉뚱한 문단을 병합/분할한다.
 *
 * cursor.ts(:399) 와 input-handler-text.ts(:307) 의 `useCellPath` 분기와 동일한 규칙이다.
 * depth 1 에서는 `cellPath[0]` 이 곧 최외곽이라 flat 값과 같으므로 동작 변화가 없다.
 *
 * [#2717] 셀 문단 경계 판정(호출자 가드)도 같은 축이어야 해서 export 한다 —
 * 축 유도를 복제하면 한쪽만 고쳐지는 회귀가 재발한다
 * (tests/undo-nested-cell-merge-offset.test.ts).
 */
export function cellParaIndexOf(pos: DocumentPosition): number {
  const path = pos.cellPath;
  return (path?.length ?? 0) > 0 ? path![path!.length - 1].cellParaIndex : pos.cellParaIndex!;
}

/**
 * [#2756] 비교용 셀 경로 — `cellParaIndexOf` 와 같은 축 규약의 경로 전체 버전.
 *
 * `cellParaIndexOf` 가 최내곽 **문단 인덱스** 하나를 주는 것과 달리, 이쪽은 셀 **정체성**을
 * 깊이별로 비교해야 하는 곳(선택 영역 정렬)에 쓴다. 두 함수는 같은 규약을 공유한다 —
 * `cellParaIndexOf(pos) === cellAxisPath(pos)[last].cellParaIndex`.
 *
 * `cellPath` 가 없는 위치(레거시 flat 좌표, `applyNavResult` 산출물)는 flat 필드로 1-depth
 * 경로를 합성한다. hit-test 가 flat 을 `cellPath[0]`(최외곽)에서 채우므로, depth 1 에서는
 * 합성 경로가 실제 경로와 완전히 같아 **동작 변화가 없다**.
 */
export function cellAxisPath(pos: DocumentPosition): CellPathEntry[] {
  if ((pos.cellPath?.length ?? 0) > 0) return pos.cellPath!;
  return [{
    controlIndex: pos.controlIndex ?? 0,
    cellIndex: pos.cellIndex ?? 0,
    cellParaIndex: pos.cellParaIndex ?? 0,
  }];
}

/** 셀 문단 구조 편집 뒤 flat/path 커서 위치를 같은 문단으로 맞춘다. */
function cellParagraphPosition(
  pos: DocumentPosition,
  cellParaIndex: number,
  charOffset: number,
): DocumentPosition {
  const cellPath = pos.cellPath?.map((entry, index, path) =>
    index + 1 === path.length ? { ...entry, cellParaIndex } : entry,
  );
  return {
    ...pos,
    paragraphIndex: cellParaIndex,
    cellParaIndex,
    cellPath,
    charOffset,
    cursorRect: undefined,
  };
}

export function insertTextWithMutationEffects(
  wasm: WasmBridge,
  pos: DocumentPosition,
  text: string,
): TextMutationEffects {
  if (isNestedCell(pos)) {
    wasm.insertTextInCellByPath(pos.sectionIndex, pos.parentParaIndex!, cellPathJson(pos), pos.charOffset, text);
  } else if (isCell(pos)) {
    if (canUseDeferredCellTextInsert(pos, text)) {
      const result = wasm.insertTextInCellDeferredPagination(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!, pos.cellParaIndex!, pos.charOffset, text);
      return {
        documentPaginationPending: result.paginationDeferred,
        flowChanged: result.cellFlowChanged,
        paginationCompleted: !result.paginationDeferred,
      };
    } else {
      wasm.insertTextInCell(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!, pos.cellParaIndex!, pos.charOffset, text);
    }
  } else if (canUseLocalBodyTextReplace(pos, 0, text)) {
    return replaceBodyTextWithMutationEffects(wasm, pos, 0, text);
  } else {
    wasm.insertText(pos.sectionIndex, pos.paragraphIndex, pos.charOffset, text);
  }
  return IMMEDIATE_TEXT_MUTATION_EFFECTS;
}

export function replaceBodyTextWithMutationEffects(
  wasm: WasmBridge,
  pos: DocumentPosition,
  deleteCount: number,
  text: string,
): TextMutationEffects {
  const result = wasm.replaceBodyTextLocal(
    pos.sectionIndex,
    pos.paragraphIndex,
    pos.charOffset,
    deleteCount,
    text,
  );
  return {
    documentPaginationPending: result.documentPaginationPending,
    flowChanged: result.flowChanged,
    paginationCompleted: !result.documentPaginationPending,
  };
}

export function replaceCellTextWithMutationEffects(
  wasm: WasmBridge,
  pos: DocumentPosition,
  deleteCount: number,
  text: string,
): TextMutationEffects {
  const result = wasm.replaceTextInCellDeferredPagination(
    pos.sectionIndex,
    pos.parentParaIndex!,
    pos.controlIndex!,
    pos.cellIndex!,
    pos.cellParaIndex!,
    pos.charOffset,
    deleteCount,
    text,
  );
  return {
    documentPaginationPending: result.paginationDeferred,
    flowChanged: result.paginationDeferred && result.cellFlowChanged,
    paginationCompleted: !result.paginationDeferred,
  };
}

/** undo/구조 명령의 full-refresh 복원은 flat cell에서도 immediate pagination을 사용한다. */
function doInsertTextImmediate(wasm: WasmBridge, pos: DocumentPosition, text: string): void {
  if (isNestedCell(pos)) {
    wasm.insertTextInCellByPath(pos.sectionIndex, pos.parentParaIndex!, cellPathJson(pos), pos.charOffset, text);
  } else if (isCell(pos)) {
    wasm.insertTextInCell(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!, pos.cellParaIndex!, pos.charOffset, text);
  } else {
    wasm.insertText(pos.sectionIndex, pos.paragraphIndex, pos.charOffset, text);
  }
}

export function deleteTextWithMutationEffects(
  wasm: WasmBridge,
  pos: DocumentPosition,
  count: number,
): TextMutationEffects {
  if (isNestedCell(pos)) {
    wasm.deleteTextInCellByPath(pos.sectionIndex, pos.parentParaIndex!, cellPathJson(pos), pos.charOffset, count);
  } else if (isCell(pos)) {
    if (canUseDeferredCellTextDelete(pos, count)) {
      const result = wasm.deleteTextInCellDeferredPagination(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!, pos.cellParaIndex!, pos.charOffset, count);
      return {
        documentPaginationPending: result.paginationDeferred,
        flowChanged: result.cellFlowChanged,
        paginationCompleted: !result.paginationDeferred,
      };
    }
    wasm.deleteTextInCell(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!, pos.cellParaIndex!, pos.charOffset, count);
  } else if (canUseLocalBodyTextReplace(pos, count, '')) {
    return replaceBodyTextWithMutationEffects(wasm, pos, count, '');
  } else {
    wasm.deleteText(pos.sectionIndex, pos.paragraphIndex, pos.charOffset, count);
  }
  return IMMEDIATE_TEXT_MUTATION_EFFECTS;
}

function doDeleteTextImmediate(wasm: WasmBridge, pos: DocumentPosition, count: number): void {
  if (isNestedCell(pos)) {
    wasm.deleteTextInCellByPath(pos.sectionIndex, pos.parentParaIndex!, cellPathJson(pos), pos.charOffset, count);
  } else if (isCell(pos)) {
    wasm.deleteTextInCell(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!, pos.cellParaIndex!, pos.charOffset, count);
  } else {
    wasm.deleteText(pos.sectionIndex, pos.paragraphIndex, pos.charOffset, count);
  }
}

function doGetTextRange(wasm: WasmBridge, pos: DocumentPosition, count: number): string {
  if (isNestedCell(pos)) {
    return wasm.getTextInCellByPath(pos.sectionIndex, pos.parentParaIndex!, cellPathJson(pos), pos.charOffset, count);
  } else if (isCell(pos)) {
    return wasm.getTextInCell(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!, pos.cellParaIndex!, pos.charOffset, count);
  } else {
    return wasm.getTextRange(pos.sectionIndex, pos.paragraphIndex, pos.charOffset, count);
  }
}

// ─── 텍스트 삽입 명령 ─────────────────────────────────

export function isNonEmptyCharFormat(
  props?: Partial<CharProperties> | null,
): props is Partial<CharProperties> {
  return !!props && Object.keys(props).length > 0;
}

/** 방금 삽입한 글자에 타이핑 서식(글꼴 등)을 입힌다. redo 시 insert 가 이전 run 을 물려받아도 복구한다. */
export function applyCharFormatToInsertedText(
  wasm: WasmBridge,
  position: DocumentPosition,
  text: string,
  charFormat?: Partial<CharProperties>,
): void {
  if (!isNonEmptyCharFormat(charFormat) || !text) return;
  const startOffset = position.charOffset;
  const endOffset = startOffset + charCount(text);
  if (endOffset <= startOffset) return;
  applyCharFormatToTarget(wasm, {
    target: editableTargetFromPosition(position),
    startOffset,
    endOffset,
  }, JSON.stringify(charFormat));
}

export class InsertTextCommand implements EditCommand {
  readonly type = 'insertText';
  readonly timestamp: number;
  private lastMutationEffects: TextMutationEffects = NO_TEXT_MUTATION_EFFECTS;

  constructor(
    private position: DocumentPosition,
    private text: string,
    timestamp?: number,
    private charFormat?: Partial<CharProperties>,
  ) {
    this.timestamp = timestamp ?? Date.now();
  }

  execute(wasm: WasmBridge): DocumentPosition {
    this.lastMutationEffects = NO_TEXT_MUTATION_EFFECTS;
    this.lastMutationEffects = insertTextWithMutationEffects(wasm, this.position, this.text);
    applyCharFormatToInsertedText(wasm, this.position, this.text, this.charFormat);
    return { ...this.position, charOffset: this.position.charOffset + charCount(this.text) };
  }

  consumeTextMutationEffects(): TextMutationEffects {
    const effects = this.lastMutationEffects;
    this.lastMutationEffects = NO_TEXT_MUTATION_EFFECTS;
    return effects;
  }

  getPageLocalTextEditOptions(): { insertedText: string } {
    return { insertedText: this.text };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    this.lastMutationEffects = NO_TEXT_MUTATION_EFFECTS;
    // [#2337-review] 삭제 count 는 char(Unicode scalar) 단위다. UTF-16 length 를 넘기면
    // astral 문자에서 실제보다 많이 지워 인접 문자를 잃는다 → HF/FN 과 동일하게 charCount.
    doDeleteTextImmediate(wasm, this.position, charCount(this.text));
    return { ...this.position };
  }

  mergeWith(other: EditCommand): EditCommand | null {
    if (!(other instanceof InsertTextCommand)) return null;
    // 같은 문단/셀인지 확인
    if (other.position.sectionIndex !== this.position.sectionIndex) return null;
    if (other.position.paragraphIndex !== this.position.paragraphIndex) return null;
    if (isCell(this.position) !== isCell(other.position)) return null;
    if (isCell(this.position)) {
      if (other.position.parentParaIndex !== this.position.parentParaIndex) return null;
      if (other.position.controlIndex !== this.position.controlIndex) return null;
      if (other.position.cellIndex !== this.position.cellIndex) return null;
      if (other.position.cellParaIndex !== this.position.cellParaIndex) return null;
    }
    // 연속 위치 확인
    const expectedOffset = this.position.charOffset + charCount(this.text);
    if (other.position.charOffset !== expectedOffset) return null;
    // 300ms 이내
    if (other.timestamp - this.timestamp > 300) return null;
    // 줄바꿈/탭 포함 시 병합 불가
    if (other.text.includes('\n') || other.text.includes('\t')) return null;
    if (JSON.stringify(this.charFormat ?? null) !== JSON.stringify(other.charFormat ?? null)) return null;

    return new InsertTextCommand(this.position, this.text + other.text, this.timestamp, this.charFormat);
  }
}

// ─── 텍스트 삭제 명령 ─────────────────────────────────

export class DeleteTextCommand implements EditCommand {
  readonly type = 'deleteText';
  readonly timestamp: number;

  /** undo용 삭제된 텍스트 (execute 시 보존) */
  private deletedText: string;
  private lastMutationEffects: TextMutationEffects = NO_TEXT_MUTATION_EFFECTS;

  constructor(
    private position: DocumentPosition,
    private count: number,
    private direction: 'forward' | 'backward',
    deletedText?: string,
    timestamp?: number,
  ) {
    this.deletedText = deletedText ?? '';
    this.timestamp = timestamp ?? Date.now();
  }

  execute(wasm: WasmBridge): DocumentPosition {
    this.lastMutationEffects = NO_TEXT_MUTATION_EFFECTS;
    // 삭제 전 텍스트 보존
    if (!this.deletedText) {
      this.deletedText = doGetTextRange(wasm, this.position, this.count);
    }
    this.lastMutationEffects = deleteTextWithMutationEffects(wasm, this.position, this.count);
    return { ...this.position };
  }

  consumeTextMutationEffects(): TextMutationEffects {
    const effects = this.lastMutationEffects;
    this.lastMutationEffects = NO_TEXT_MUTATION_EFFECTS;
    return effects;
  }

  getPageLocalTextEditOptions(): { deleteCount: number } {
    return { deleteCount: this.count };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    this.lastMutationEffects = NO_TEXT_MUTATION_EFFECTS;
    doInsertTextImmediate(wasm, this.position, this.deletedText);
    const restoredLen = this.deletedText.length;
    return { ...this.position, charOffset: this.position.charOffset + restoredLen };
  }

  mergeWith(other: EditCommand): EditCommand | null {
    if (!(other instanceof DeleteTextCommand)) return null;
    if (other.direction !== this.direction) return null;
    if (other.timestamp - this.timestamp > 300) return null;
    // 같은 문단/셀 확인
    if (other.position.sectionIndex !== this.position.sectionIndex) return null;
    if (other.position.paragraphIndex !== this.position.paragraphIndex) return null;
    if (isCell(this.position) !== isCell(other.position)) return null;
    if (isCell(this.position)) {
      if (other.position.parentParaIndex !== this.position.parentParaIndex) return null;
      if (other.position.controlIndex !== this.position.controlIndex) return null;
      if (other.position.cellIndex !== this.position.cellIndex) return null;
      if (other.position.cellParaIndex !== this.position.cellParaIndex) return null;
    }

    if (this.direction === 'backward') {
      // Backspace: 연속 앞쪽 삭제
      if (other.position.charOffset === this.position.charOffset - other.count) {
        return new DeleteTextCommand(
          other.position, this.count + other.count, 'backward',
          other.deletedText + this.deletedText, this.timestamp,
        );
      }
    } else {
      // Delete: 같은 위치에서 연속 삭제
      if (other.position.charOffset === this.position.charOffset) {
        return new DeleteTextCommand(
          this.position, this.count + other.count, 'forward',
          this.deletedText + other.deletedText, this.timestamp,
        );
      }
    }
    return null;
  }
}

// ─── 강제 줄바꿈 명령 (Shift+Enter) ─────────────────────

export class InsertLineBreakCommand implements EditCommand {
  readonly type = 'insertLineBreak';
  readonly timestamp = Date.now();

  constructor(private position: DocumentPosition) {}

  execute(wasm: WasmBridge): DocumentPosition {
    doInsertTextImmediate(wasm, this.position, '\n');
    const newPos = { ...this.position, charOffset: this.position.charOffset + 1 };
    return newPos;
  }

  undo(wasm: WasmBridge): DocumentPosition {
    doDeleteTextImmediate(wasm, this.position, 1);
    return { ...this.position };
  }

  mergeWith(): null { return null; }
}

// ─── 탭 삽입 명령 (Tab) ──────────────────────────────

export class InsertTabCommand implements EditCommand {
  readonly type = 'insertTab';
  readonly timestamp = Date.now();

  constructor(private position: DocumentPosition) {}

  execute(wasm: WasmBridge): DocumentPosition {
    doInsertTextImmediate(wasm, this.position, '\t');
    const newPos = { ...this.position, charOffset: this.position.charOffset + 1 };
    return newPos;
  }

  undo(wasm: WasmBridge): DocumentPosition {
    doDeleteTextImmediate(wasm, this.position, 1);
    return { ...this.position };
  }

  mergeWith(): null { return null; }
}

// ─── 문단 분할 명령 (Enter) ───────────────────────────

export class SplitParagraphCommand implements EditCommand {
  readonly type = 'splitParagraph';
  readonly timestamp = Date.now();

  constructor(private position: DocumentPosition) {}

  execute(wasm: WasmBridge): DocumentPosition {
    const { sectionIndex: sec, paragraphIndex: para, charOffset } = this.position;
    const result = JSON.parse(wasm.splitParagraph(sec, para, charOffset));
    if (result.ok) {
      return { sectionIndex: sec, paragraphIndex: result.paraIdx, charOffset: 0 };
    }
    return this.position;
  }

  undo(wasm: WasmBridge): DocumentPosition {
    const { sectionIndex: sec, paragraphIndex: para } = this.position;
    wasm.mergeParagraph(sec, para + 1);
    return { ...this.position };
  }

  mergeWith(): null { return null; }
}

// ─── 문단 병합 명령 (문단 시작에서 Backspace) ─────────

export class MergeParagraphCommand implements EditCommand {
  readonly type = 'mergeParagraph';
  readonly timestamp = Date.now();

  /** undo 시 분할 위치 (이전 문단의 원래 길이) */
  private mergePointOffset = 0;
  /** 병합으로 사라진 문단의 스코프 메타데이터 — undo 분할이 되돌린다 (Task #2342) */
  private removedParaMeta?: RemovedParaMeta;

  constructor(private position: DocumentPosition) {}

  execute(wasm: WasmBridge): DocumentPosition {
    const { sectionIndex: sec, paragraphIndex: para } = this.position;
    // 병합 전 이전 문단 길이 기억
    this.mergePointOffset = wasm.getParagraphLength(sec, para - 1);
    this.removedParaMeta = JSON.parse(wasm.mergeParagraph(sec, para)).removedParaMeta;
    return { sectionIndex: sec, paragraphIndex: para - 1, charOffset: this.mergePointOffset };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    const { sectionIndex: sec, paragraphIndex: para } = this.position;
    wasm.splitParagraph(sec, para - 1, this.mergePointOffset, this.removedParaMeta);
    return { ...this.position };
  }

  mergeWith(): null { return null; }
}

// ─── 선택 영역 삭제 명령 ─────────────────────────────

/**
 * 선택 영역을 히스토리 엔트리 추가 없이 바로 삭제한다.
 * 자체 스냅샷으로 undo를 소유하는 붙여넣기 같은 복합 편집에서만 쓴다.
 */
export function deleteSelectionImmediate(
  wasm: WasmBridge,
  start: DocumentPosition,
  end: DocumentPosition,
): DocumentPosition {
  if (isCell(start)) {
    // 중첩 셀은 flat 좌표가 최외곽 셀을 가리키므로 경로 API를 쓴다.
    wasm.deleteRangeInCellByPath(
      start.sectionIndex, start.parentParaIndex!, cellPathJson(start),
      cellParaIndexOf(start), start.charOffset, cellParaIndexOf(end), end.charOffset,
    );
  } else if (start.sectionIndex === end.sectionIndex) {
    wasm.deleteRange(
      start.sectionIndex, start.paragraphIndex, start.charOffset,
      end.paragraphIndex, end.charOffset,
    );
  } else {
    wasm.deleteRangeAcrossSections(
      start.sectionIndex, start.paragraphIndex, start.charOffset,
      end.sectionIndex, end.paragraphIndex, end.charOffset,
    );
  }
  return { ...start };
}

export class DeleteSelectionCommand implements EditCommand {
  readonly type = 'deleteSelection';
  readonly timestamp = Date.now();

  /**
   * 삭제 범위의 복원은 문서 스냅샷에 맡긴다 (Task #2418).
   *
   * 평문만 저장해 되돌리던 이전 방식은 글자 모양·문단 메타·인라인 컨트롤을 되살리지
   * 못했다 — 재삽입은 삽입 지점의 현재 글자 모양을 쓰고, 다문단 복원은 문단 메타를 앞
   * 문단에서 상속하는 `splitParagraph` 를 타며(#2342), 셀 다문단은 문단 구조 대신
   * `'\n'` 이어붙이기로 대체됐다. 선택 범위의 서식·컨트롤을 평문 밖에서 따로 캡처하려면
   * 글자모양 run·문단 메타·컨트롤을 읽고 되돌리는 API 가 새로 필요한데, 그것은 스냅샷이
   * 이미 하는 일이다. 같은 이유로 붙여넣기(`pasteInternal` 등)가 스냅샷을 쓰므로 그
   * 역연산인 선택 삭제도 같은 방식으로 맞춘다.
   *
   * `kind:'command'` 로 남는다 — 양식 모드 게이트(`isOperationAllowedInEditMode` 의
   * `'deleteSelection'` 분기)가 커맨드 타입에 걸려 있어, `kind:'snapshot'` 으로 바꾸면
   * 양식 모드 선택 삭제가 게이트에서 드롭돼 무언 폐기가 된다.
   */
  private readonly snapshot: SnapshotCommand;

  constructor(start: DocumentPosition, end: DocumentPosition) {
    // 삭제 후 커서는 선택 시작으로 모이고, undo 후에는 선택 끝으로 되돌아간다.
    this.snapshot = new SnapshotCommand(
      'deleteSelection', end, start,
      (wasm) => deleteSelectionImmediate(wasm, start, end),
    );
  }

  execute(wasm: WasmBridge): DocumentPosition {
    return this.snapshot.execute(wasm);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    return this.snapshot.undo(wasm);
  }

  mergeWith(): null { return null; }

  snapshotResourceCount(): number {
    return this.snapshot.snapshotResourceCount();
  }

  discard(wasm: WasmBridge): void {
    this.snapshot.discard(wasm);
  }
}

// ─── 글자 서식 적용 명령 ─────────────────────────────

/** 균일 charShapeId 구간(run) 하나의 스팬 — undo/redo 복원 단위 */
interface CharShapeSpan {
  startOffset: number;
  endOffset: number;
  charShapeId: number;
}

/** 문단 하나에 대한 서식 적용 정보 */
interface ParaFormatEntry {
  target: EditableParagraphTarget;
  /** undo용: 적용 전 run별 스팬 (startOffset~endOffset 을 빈틈없이 덮는다) */
  beforeSpans: CharShapeSpan[];
  /** redo용: 적용 후 run별 스팬 (첫 execute 에서 채움) */
  afterSpans?: CharShapeSpan[];
}

/**
 * 범위 내 run(균일 charShapeId 구간) 경계를 복원한다.
 *
 * WASM 에 run 열거 export 가 없어(wasm_api.rs) 오프셋별 charShapeId 샘플링으로
 * 근사한다 — Rust 측 char_shape_runs_in_range 와 같은 방식으로 인접 오프셋의
 * charShapeId 가 달라지는 지점을 경계로 삼는다. 인접 run 이 우연히 같은 id 를 공유할
 * 때만 하나로 합쳐지는데, 어차피 같은 id 를 같은 구간에 복원하므로 행위 차이는 없다.
 * 비용: 범위 길이만큼의 getCharPropertiesAt 호출(첫 execute 1회).
 */
function sampleCharShapeSpans(propsAt: (offset: number) => number, from: number, to: number): CharShapeSpan[] {
  const spans: CharShapeSpan[] = [];
  let runStart = from;
  let runId = propsAt(from);
  for (let o = from + 1; o < to; o++) {
    const id = propsAt(o);
    if (id !== runId) {
      spans.push({ startOffset: runStart, endOffset: o, charShapeId: runId });
      runStart = o;
      runId = id;
    }
  }
  spans.push({ startOffset: runStart, endOffset: to, charShapeId: runId });
  return spans;
}

/**
 * 적용 후 run별 파생 shape 를 캡처한다.
 *
 * Rust apply_char_mods_to_paragraph 는 base run 별로 파생 shape 를 하나씩 만들어
 * 적용하므로 적용 후 경계는 적용 전 경계의 부분집합이다 — 각 전 스팬의 시작 오프셋만
 * 샘플링하고(전수 재스캔 불필요), 인접 스팬의 파생 id 가 같으면 합친다.
 */
function deriveAfterSpans(beforeSpans: CharShapeSpan[], propsAt: (offset: number) => number): CharShapeSpan[] {
  const spans: CharShapeSpan[] = [];
  for (const before of beforeSpans) {
    const charShapeId = propsAt(before.startOffset);
    const last = spans[spans.length - 1];
    if (last && last.charShapeId === charShapeId) {
      last.endOffset = before.endOffset;
    } else {
      spans.push({ startOffset: before.startOffset, endOffset: before.endOffset, charShapeId });
    }
  }
  return spans;
}

function useContainerPath(target: Extract<EditableParagraphTarget, { kind: 'container' }>) {
  return target.cellPath.length > 1 || (target.cellPath.length > 0 && !target.isTextBox);
}

function getCharPropertiesAtTarget(
  wasm: WasmBridge,
  target: EditableParagraphTarget,
  offset: number,
): CharProperties {
  switch (target.kind) {
    case 'body':
      return wasm.getCharPropertiesAt(target.sectionIndex, target.paragraphIndex, offset);
    case 'container':
      return useContainerPath(target)
        ? wasm.getCellCharPropertiesAtByPath(
            target.sectionIndex,
            target.parentParagraphIndex,
            targetCellPathJson(target),
            offset,
          )
        : wasm.getCellCharPropertiesAt(
            target.sectionIndex,
            target.parentParagraphIndex,
            target.controlIndex,
            target.cellIndex,
            target.paragraphIndex,
            offset,
          );
    case 'headerFooter':
      return wasm.getCharPropertiesInHf(
        target.sectionIndex,
        target.isHeader,
        target.applyTo,
        target.paragraphIndex,
        offset,
      );
    case 'note':
      return wasm.getCharPropertiesInFootnote(
        target.sectionIndex,
        target.hostParagraphIndex,
        target.controlIndex,
        target.paragraphIndex,
        offset,
      );
  }
}

export function applyCharFormatToTarget(wasm: WasmBridge, range: EditableTextRange, propsJson: string) {
  const { target, startOffset, endOffset } = range;
  switch (target.kind) {
    case 'body':
      wasm.applyCharFormat(target.sectionIndex, target.paragraphIndex, startOffset, endOffset, propsJson);
      break;
    case 'container':
      if (useContainerPath(target)) {
        wasm.applyCharFormatInCellByPath(
          target.sectionIndex,
          target.parentParagraphIndex,
          targetCellPathJson(target),
          startOffset,
          endOffset,
          propsJson,
        );
      } else {
        wasm.applyCharFormatInCell(
          target.sectionIndex,
          target.parentParagraphIndex,
          target.controlIndex,
          target.cellIndex,
          target.paragraphIndex,
          startOffset,
          endOffset,
          propsJson,
        );
      }
      break;
    case 'headerFooter':
      wasm.applyCharFormatInHf(
        target.sectionIndex,
        target.isHeader,
        target.applyTo,
        target.paragraphIndex,
        startOffset,
        endOffset,
        propsJson,
      );
      break;
    case 'note':
      wasm.applyCharFormatInFootnote(
        target.sectionIndex,
        target.hostParagraphIndex,
        target.controlIndex,
        target.paragraphIndex,
        startOffset,
        endOffset,
        propsJson,
      );
      break;
  }
}

function setCharShapeIdAtTarget(
  wasm: WasmBridge,
  target: EditableParagraphTarget,
  span: CharShapeSpan,
) {
  const { startOffset, endOffset, charShapeId } = span;
  switch (target.kind) {
    case 'body':
      wasm.setCharShapeId(target.sectionIndex, target.paragraphIndex, startOffset, endOffset, charShapeId);
      break;
    case 'container':
      if (useContainerPath(target)) {
        wasm.setCharShapeIdInCellByPath(
          target.sectionIndex,
          target.parentParagraphIndex,
          targetCellPathJson(target),
          startOffset,
          endOffset,
          charShapeId,
        );
      } else {
        wasm.setCharShapeIdInCell(
          target.sectionIndex,
          target.parentParagraphIndex,
          target.controlIndex,
          target.cellIndex,
          target.paragraphIndex,
          startOffset,
          endOffset,
          charShapeId,
        );
      }
      break;
    case 'headerFooter':
      wasm.setCharShapeIdInHf(
        target.sectionIndex,
        target.isHeader,
        target.applyTo,
        target.paragraphIndex,
        startOffset,
        endOffset,
        charShapeId,
      );
      break;
    case 'note':
      wasm.setCharShapeIdInFootnote(
        target.sectionIndex,
        target.hostParagraphIndex,
        target.controlIndex,
        target.paragraphIndex,
        startOffset,
        endOffset,
        charShapeId,
      );
      break;
  }
}

function getParaPropertiesAtTarget(wasm: WasmBridge, target: EditableParagraphTarget) {
  switch (target.kind) {
    case 'body':
      return wasm.getParaPropertiesAt(target.sectionIndex, target.paragraphIndex);
    case 'container':
      return useContainerPath(target)
        ? wasm.getCellParaPropertiesAtByPath(
            target.sectionIndex,
            target.parentParagraphIndex,
            targetCellPathJson(target),
          )
        : wasm.getCellParaPropertiesAt(
            target.sectionIndex,
            target.parentParagraphIndex,
            target.controlIndex,
            target.cellIndex,
            target.paragraphIndex,
          );
    case 'headerFooter':
      return wasm.getParaPropertiesInHf(
        target.sectionIndex,
        target.isHeader,
        target.applyTo,
        target.paragraphIndex,
      );
    case 'note':
      return wasm.getParaPropertiesInFootnote(
        target.sectionIndex,
        target.hostParagraphIndex,
        target.controlIndex,
        target.paragraphIndex,
      );
  }
}

function applyParaFormatAtTarget(
  wasm: WasmBridge,
  target: EditableParagraphTarget,
  propsJson: string,
) {
  switch (target.kind) {
    case 'body':
      wasm.applyParaFormat(target.sectionIndex, target.paragraphIndex, propsJson);
      break;
    case 'container':
      if (useContainerPath(target)) {
        wasm.applyParaFormatInCellByPath(
          target.sectionIndex,
          target.parentParagraphIndex,
          targetCellPathJson(target),
          propsJson,
        );
      } else {
        wasm.applyParaFormatInCell(
          target.sectionIndex,
          target.parentParagraphIndex,
          target.controlIndex,
          target.cellIndex,
          target.paragraphIndex,
          propsJson,
        );
      }
      break;
    case 'headerFooter':
      wasm.applyParaFormatInHf(
        target.sectionIndex,
        target.isHeader,
        target.applyTo,
        target.paragraphIndex,
        propsJson,
      );
      break;
    case 'note':
      wasm.applyParaFormatInFootnote(
        target.sectionIndex,
        target.hostParagraphIndex,
        target.controlIndex,
        target.paragraphIndex,
        propsJson,
      );
      break;
  }
}

function setParaShapeIdAtTarget(
  wasm: WasmBridge,
  target: EditableParagraphTarget,
  paraShapeId: number,
) {
  switch (target.kind) {
    case 'body':
      wasm.setParaShapeId(target.sectionIndex, target.paragraphIndex, paraShapeId);
      break;
    case 'container':
      if (useContainerPath(target)) {
        wasm.setCellParaShapeIdByPath(
          target.sectionIndex,
          target.parentParagraphIndex,
          targetCellPathJson(target),
          paraShapeId,
        );
      } else {
        wasm.setCellParaShapeId(
          target.sectionIndex,
          target.parentParagraphIndex,
          target.controlIndex,
          target.cellIndex,
          target.paragraphIndex,
          paraShapeId,
        );
      }
      break;
    case 'headerFooter':
      wasm.setParaShapeIdInHf(
        target.sectionIndex,
        target.isHeader,
        target.applyTo,
        target.paragraphIndex,
        paraShapeId,
      );
      break;
    case 'note':
      wasm.setParaShapeIdInFootnote(
        target.sectionIndex,
        target.hostParagraphIndex,
        target.controlIndex,
        target.paragraphIndex,
        paraShapeId,
      );
      break;
  }
}

function editContextForTarget(target: EditableParagraphTarget | undefined): EditContext | undefined {
  if (target?.kind === 'headerFooter') {
    return {
      mode: 'headerFooter',
      sectionIdx: target.sectionIndex,
      isHeader: target.isHeader,
      applyTo: target.applyTo,
      paraIdx: target.paragraphIndex,
      charOffset: 0,
    };
  }
  if (target?.kind === 'note') {
    return {
      mode: 'footnote',
      sectionIdx: target.sectionIndex,
      paraIdx: target.hostParagraphIndex,
      controlIdx: target.controlIndex,
      footnoteIndex: target.footnoteIndex,
      pageNum: target.pageNum,
      innerParaIdx: target.paragraphIndex,
      charOffset: 0,
    };
  }
}

export class ApplyCharFormatCommand implements EditCommand {
  readonly type = 'applyCharFormat';
  readonly timestamp = Date.now();

  private entries: ParaFormatEntry[] = [];

  constructor(
    private ranges: EditableTextRange[],
    private props: Partial<CharProperties>,
    private cursorBefore: DocumentPosition,
    private contextBefore?: EditContext,
  ) {}

  execute(wasm: WasmBridge): DocumentPosition {
    if (this.entries.length > 0 && this.entries.every((entry) => entry.afterSpans !== undefined)) {
      this.restoreCharShapeIds(wasm, 'after');
      return { ...this.cursorBefore };
    }

    const propsJson = JSON.stringify(this.props);
    this.entries = [];
    for (const range of this.ranges) {
      if (range.endOffset <= range.startOffset) continue;
      const propsAt = (offset: number) =>
        getCharPropertiesAtTarget(wasm, range.target, offset).charShapeId ?? 0;
      const beforeSpans = sampleCharShapeSpans(propsAt, range.startOffset, range.endOffset);
      applyCharFormatToTarget(wasm, range, propsJson);
      this.entries.push({
        target: range.target,
        beforeSpans,
        afterSpans: deriveAfterSpans(beforeSpans, propsAt),
      });
    }

    return { ...this.cursorBefore };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    this.restoreCharShapeIds(wasm, 'before');
    return { ...this.cursorBefore };
  }

  private restoreCharShapeIds(wasm: WasmBridge, side: 'before' | 'after'): void {
    for (const entry of this.entries) {
      const spans = side === 'before' ? entry.beforeSpans : entry.afterSpans;
      if (!spans) continue;

      for (const span of spans) {
        setCharShapeIdAtTarget(wasm, entry.target, span);
      }
    }
  }

  editContext(): EditContext | null {
    return this.contextBefore ?? editContextForTarget(this.ranges[0]?.target) ?? null;
  }

  mergeWith(): null { return null; }
}

// ─── 문단 서식 적용 명령 ─────────────────────────────

export type ParaFormatTarget = EditableParagraphTarget;

interface ParaShapeHistoryEntry {
  target: ParaFormatTarget;
  beforeParaShapeId: number;
  afterParaShapeId?: number;
}

function getParaShapeId(wasm: WasmBridge, target: ParaFormatTarget): number {
  const props = getParaPropertiesAtTarget(wasm, target);
  const paraShapeId = props.paraShapeId;
  if (paraShapeId === undefined) {
    throw new Error('문단 모양 ID를 조회할 수 없습니다');
  }
  return paraShapeId;
}

function applyParaFormatToTarget(wasm: WasmBridge, target: ParaFormatTarget, propsJson: string): void {
  applyParaFormatAtTarget(wasm, target, propsJson);
}

function restoreParaShapeId(wasm: WasmBridge, target: ParaFormatTarget, paraShapeId: number): void {
  setParaShapeIdAtTarget(wasm, target, paraShapeId);
}

export class ApplyParaFormatCommand implements EditCommand {
  readonly type = 'applyParaFormat';
  readonly timestamp = Date.now();

  private entries: ParaShapeHistoryEntry[] = [];

  constructor(
    private targets: ParaFormatTarget[],
    private props: Partial<ParaProperties>,
    private cursorBefore: DocumentPosition,
    private contextBefore?: EditContext,
  ) {}

  execute(wasm: WasmBridge): DocumentPosition {
    if (this.entries.length > 0 && this.entries.every(entry => entry.afterParaShapeId !== undefined)) {
      for (const entry of this.entries) {
        restoreParaShapeId(wasm, entry.target, entry.afterParaShapeId!);
      }
      return { ...this.cursorBefore };
    }

    const propsJson = JSON.stringify(this.props);
    const entries: ParaShapeHistoryEntry[] = this.targets.map(target => ({
      target,
      beforeParaShapeId: getParaShapeId(wasm, target),
    }));

    for (const entry of entries) {
      applyParaFormatToTarget(wasm, entry.target, propsJson);
    }
    for (const entry of entries) {
      entry.afterParaShapeId = getParaShapeId(wasm, entry.target);
    }

    this.entries = entries;
    return { ...this.cursorBefore };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    for (const entry of this.entries) {
      restoreParaShapeId(wasm, entry.target, entry.beforeParaShapeId);
    }
    return { ...this.cursorBefore };
  }

  editContext(): EditContext | null {
    return this.contextBefore ?? editContextForTarget(this.targets[0]) ?? null;
  }

  mergeWith(): null { return null; }
}

// ─── 문단 끝에서 Delete로 다음 문단 병합 ─────────────

export class MergeNextParagraphCommand implements EditCommand {
  readonly type = 'mergeNextParagraph';
  readonly timestamp = Date.now();

  /** 병합으로 사라진 문단의 스코프 메타데이터 — undo 분할이 되돌린다 (Task #2342) */
  private removedParaMeta?: RemovedParaMeta;

  constructor(private position: DocumentPosition) {}

  execute(wasm: WasmBridge): DocumentPosition {
    const { sectionIndex: sec, paragraphIndex: para } = this.position;
    this.removedParaMeta = JSON.parse(wasm.mergeParagraph(sec, para + 1)).removedParaMeta;
    return { ...this.position };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    const { sectionIndex: sec, paragraphIndex: para, charOffset } = this.position;
    wasm.splitParagraph(sec, para, charOffset, this.removedParaMeta);
    return { ...this.position };
  }

  mergeWith(): null { return null; }
}

// ─── [Task #2337] 머리말/꼬리말·각주 편집 커맨드 ───────────────────────────
//
// HF/FN 편집은 본문과 별개 WASM 경로(insert/delete/merge/split × HeaderFooter/Footnote)
// 를 쓰고 커서도 별도 모드다. 본문 텍스트/문단 커맨드(역연산 경량)를 미러링해 히스토리에
// 기록함으로써, 본문 스냅샷 undo 가 미기록 HF/FN 편집을 무언 파괴하던 데이터 손실을 막는다.
// 최초 적용은 InputHandler 가 인라인 뮤테이션 후 kind:'record' 로 기록하므로 execute()
// 는 redo 시에만 호출된다. undo()/execute() 는 lastContext 를 각각 실행 전/후 좌표로
// 갱신하며, InputHandler 가 editContext() 로 읽어 HF/FN 커서 모드를 복원한다(커맨드는 순수).

export interface HeaderFooterEditTarget {
  readonly sectionIdx: number;
  readonly isHeader: boolean;
  readonly applyTo: number;
}

export interface FootnoteEditTarget {
  readonly sectionIdx: number;
  /** 각주 컨트롤을 담은 본문 문단 인덱스 */
  readonly paraIdx: number;
  readonly controlIdx: number;
  /** 모드 재진입용 (enterFootnoteMode 인자) */
  readonly footnoteIndex: number;
  readonly pageNum: number;
}

function hfEditContext(t: HeaderFooterEditTarget, paraIdx: number, charOffset: number): EditContext {
  return { mode: 'headerFooter', sectionIdx: t.sectionIdx, isHeader: t.isHeader, applyTo: t.applyTo, paraIdx, charOffset };
}

function fnEditContext(t: FootnoteEditTarget, innerParaIdx: number, charOffset: number): EditContext {
  return {
    mode: 'footnote', sectionIdx: t.sectionIdx, paraIdx: t.paraIdx, controlIdx: t.controlIdx,
    footnoteIndex: t.footnoteIndex, pageNum: t.pageNum, innerParaIdx, charOffset,
  };
}

/**
 * HF/FN 커맨드의 execute/undo 반환 위치는 형식상 값이다 — InputHandler 는 editContext()
 * 로 커서를 복원하며 이 본문 위치로 moveTo 하지 않는다(단, 반환은 non-null 이어야
 * history.undo/redo 가 성공으로 간주한다).
 */
function hfFnStubPosition(sectionIdx: number): DocumentPosition {
  return { sectionIndex: sectionIdx, paragraphIndex: 0, charOffset: 0 };
}

/**
 * WASM 텍스트 API의 offset/count는 Rust `char`(Unicode scalar) 단위다.
 * DOM의 UTF-16 문자열은 명령 경계에서 scalar 길이로 변환한다.
 */
function charCount(s: string): number {
  return [...s].length;
}

// ── 머리말/꼬리말 ──────────────────────────────────────────

export class InsertTextInHeaderFooterCommand implements EditCommand {
  readonly type = 'insertTextInHeaderFooter';
  readonly timestamp = Date.now();
  private lastContext: EditContext;

  constructor(
    private target: HeaderFooterEditTarget,
    private paraIdx: number,
    private charOffset: number,
    private text: string,
    private charFormat?: Partial<CharProperties>,
  ) {
    this.lastContext = hfEditContext(target, paraIdx, charOffset + charCount(text));
  }

  execute(wasm: WasmBridge): DocumentPosition {
    wasm.insertTextInHeaderFooter(this.target.sectionIdx, this.target.isHeader, this.target.applyTo, this.paraIdx, this.charOffset, this.text);
    if (isNonEmptyCharFormat(this.charFormat) && this.text) {
      wasm.applyCharFormatInHf(
        this.target.sectionIdx,
        this.target.isHeader,
        this.target.applyTo,
        this.paraIdx,
        this.charOffset,
        this.charOffset + charCount(this.text),
        JSON.stringify(this.charFormat),
      );
    }
    this.lastContext = hfEditContext(this.target, this.paraIdx, this.charOffset + charCount(this.text));
    return hfFnStubPosition(this.target.sectionIdx);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    wasm.deleteTextInHeaderFooter(this.target.sectionIdx, this.target.isHeader, this.target.applyTo, this.paraIdx, this.charOffset, charCount(this.text));
    this.lastContext = hfEditContext(this.target, this.paraIdx, this.charOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  editContext(): EditContext { return this.lastContext; }
  mergeWith(): null { return null; }
}

/**
 * [Task #3212] 머리말/꼬리말 필드(쪽 번호·전체 쪽수·파일 이름) 삽입의 역연산 명령.
 *
 * 필드는 HF 문단에 제어문자 마커로 들어가므로 역연산은 그 문자 범위 삭제다. HF 모드
 * '내부' 편집이라 snapshot 으로 기록하면 undo 가 본문 분기를 타 HF 밖으로 튕겨나가므로,
 * editContext 를 노출하는 이 명령으로 기록해 undo/redo 가 HF 모드와 오프셋을 유지한다.
 */
export class InsertFieldInHeaderFooterCommand implements EditCommand {
  readonly type = 'insertFieldInHeaderFooter';
  readonly timestamp = Date.now();
  private lastContext: EditContext;

  constructor(
    private target: HeaderFooterEditTarget,
    private paraIdx: number,
    /** redo 시 native에 다시 넘길 원래 cursor 좌표 */
    private requestedCharOffset: number,
    /** undo가 marker를 지워야 하는 실제 모델 텍스트 좌표 */
    private insertedAt: number,
    private fieldType: number,
    /** 필드 마커가 실제 모델 텍스트에서 차지한 문자 수. */
    private markerLength: number,
    /** 삽입 직후 cursor가 돌아갈 좌표. */
    private cursorAfterOffset: number,
  ) {
    this.lastContext = hfEditContext(target, paraIdx, cursorAfterOffset);
  }

  execute(wasm: WasmBridge): DocumentPosition {
    const result = wasm.insertFieldInHf(
      this.target.sectionIdx, this.target.isHeader, this.target.applyTo,
      this.paraIdx, this.requestedCharOffset, this.fieldType,
    );
    if (result.ok) {
      this.insertedAt = result.insertedAt;
      this.markerLength = result.insertedLength;
      this.cursorAfterOffset = result.charOffset;
    }
    this.lastContext = hfEditContext(this.target, this.paraIdx, this.cursorAfterOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    wasm.deleteTextInHeaderFooter(this.target.sectionIdx, this.target.isHeader, this.target.applyTo, this.paraIdx, this.insertedAt, this.markerLength);
    this.lastContext = hfEditContext(this.target, this.paraIdx, this.requestedCharOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  editContext(): EditContext { return this.lastContext; }
  mergeWith(): null { return null; }
}

export class DeleteTextInHeaderFooterCommand implements EditCommand {
  readonly type = 'deleteTextInHeaderFooter';
  readonly timestamp = Date.now();
  private lastContext: EditContext;

  constructor(
    private target: HeaderFooterEditTarget,
    private paraIdx: number,
    private charOffset: number,
    private deletedText: string,
    /** undo(재삽입) 후 커서 오프셋 — 삭제 방향에 따라 호출부가 정한다(Backspace: charOffset+len, Delete: charOffset). */
    private cursorBeforeOffset: number,
  ) {
    this.lastContext = hfEditContext(target, paraIdx, charOffset);
  }

  execute(wasm: WasmBridge): DocumentPosition {
    wasm.deleteTextInHeaderFooter(this.target.sectionIdx, this.target.isHeader, this.target.applyTo, this.paraIdx, this.charOffset, charCount(this.deletedText));
    this.lastContext = hfEditContext(this.target, this.paraIdx, this.charOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    wasm.insertTextInHeaderFooter(this.target.sectionIdx, this.target.isHeader, this.target.applyTo, this.paraIdx, this.charOffset, this.deletedText);
    this.lastContext = hfEditContext(this.target, this.paraIdx, this.cursorBeforeOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  editContext(): EditContext { return this.lastContext; }
  mergeWith(): null { return null; }
}

export class SplitParagraphInHeaderFooterCommand implements EditCommand {
  readonly type = 'splitParagraphInHeaderFooter';
  readonly timestamp = Date.now();
  private lastContext: EditContext;

  constructor(
    private target: HeaderFooterEditTarget,
    private paraIdx: number,
    private charOffset: number,
    /** 분할로 생긴 다음 문단 인덱스(인라인 결과의 hfParaIndex). */
    private newParaIdx: number,
  ) {
    this.lastContext = hfEditContext(target, newParaIdx, 0);
  }

  execute(wasm: WasmBridge): DocumentPosition {
    wasm.splitParagraphInHeaderFooter(this.target.sectionIdx, this.target.isHeader, this.target.applyTo, this.paraIdx, this.charOffset);
    this.lastContext = hfEditContext(this.target, this.newParaIdx, 0);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    wasm.mergeParagraphInHeaderFooter(this.target.sectionIdx, this.target.isHeader, this.target.applyTo, this.newParaIdx);
    this.lastContext = hfEditContext(this.target, this.paraIdx, this.charOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  editContext(): EditContext { return this.lastContext; }
  mergeWith(): null { return null; }
}

export class MergeParagraphInHeaderFooterCommand implements EditCommand {
  readonly type = 'mergeParagraphInHeaderFooter';
  readonly timestamp = Date.now();
  private lastContext: EditContext;

  constructor(
    private target: HeaderFooterEditTarget,
    /** 병합되는 문단 M (M 을 M-1 로 합침). */
    private paraIdx: number,
    /** 병합 후 이전 문단 인덱스(인라인 결과 hfParaIndex, = paraIdx-1). */
    private prevParaIdx: number,
    /** 병합 지점 오프셋(이전 문단의 원래 길이, 인라인 결과 charOffset). undo 분할점 + 병합 후 커서. */
    private mergeOffset: number,
    /** 병합 전 커서(undo 복원용) — Backspace: (paraIdx,0), Delete: (prevParaIdx,mergeOffset). */
    private beforeParaIdx: number,
    private beforeOffset: number,
    /** 병합으로 사라진 문단의 스코프 메타데이터 — undo 분할이 되돌린다 (Task #2342). */
    private removedParaMeta?: RemovedParaMeta,
  ) {
    this.lastContext = hfEditContext(target, prevParaIdx, mergeOffset);
  }

  execute(wasm: WasmBridge): DocumentPosition {
    wasm.mergeParagraphInHeaderFooter(this.target.sectionIdx, this.target.isHeader, this.target.applyTo, this.paraIdx);
    this.lastContext = hfEditContext(this.target, this.prevParaIdx, this.mergeOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    wasm.splitParagraphInHeaderFooter(this.target.sectionIdx, this.target.isHeader, this.target.applyTo, this.prevParaIdx, this.mergeOffset, this.removedParaMeta);
    this.lastContext = hfEditContext(this.target, this.beforeParaIdx, this.beforeOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  editContext(): EditContext { return this.lastContext; }
  mergeWith(): null { return null; }
}

// ── 각주/미주 ──────────────────────────────────────────────

export class InsertTextInFootnoteCommand implements EditCommand {
  readonly type = 'insertTextInFootnote';
  readonly timestamp = Date.now();
  private lastContext: EditContext;

  constructor(
    private target: FootnoteEditTarget,
    private innerParaIdx: number,
    private charOffset: number,
    private text: string,
    private charFormat?: Partial<CharProperties>,
  ) {
    this.lastContext = fnEditContext(target, innerParaIdx, charOffset + charCount(text));
  }

  execute(wasm: WasmBridge): DocumentPosition {
    wasm.insertTextInFootnote(this.target.sectionIdx, this.target.paraIdx, this.target.controlIdx, this.innerParaIdx, this.charOffset, this.text);
    if (isNonEmptyCharFormat(this.charFormat) && this.text) {
      wasm.applyCharFormatInFootnote(
        this.target.sectionIdx,
        this.target.paraIdx,
        this.target.controlIdx,
        this.innerParaIdx,
        this.charOffset,
        this.charOffset + charCount(this.text),
        JSON.stringify(this.charFormat),
      );
    }
    this.lastContext = fnEditContext(this.target, this.innerParaIdx, this.charOffset + charCount(this.text));
    return hfFnStubPosition(this.target.sectionIdx);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    wasm.deleteTextInFootnote(this.target.sectionIdx, this.target.paraIdx, this.target.controlIdx, this.innerParaIdx, this.charOffset, charCount(this.text));
    this.lastContext = fnEditContext(this.target, this.innerParaIdx, this.charOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  editContext(): EditContext { return this.lastContext; }
  mergeWith(): null { return null; }
}

export class DeleteTextInFootnoteCommand implements EditCommand {
  readonly type = 'deleteTextInFootnote';
  readonly timestamp = Date.now();
  private lastContext: EditContext;

  constructor(
    private target: FootnoteEditTarget,
    private innerParaIdx: number,
    private charOffset: number,
    private deletedText: string,
    private cursorBeforeOffset: number,
  ) {
    this.lastContext = fnEditContext(target, innerParaIdx, charOffset);
  }

  execute(wasm: WasmBridge): DocumentPosition {
    wasm.deleteTextInFootnote(this.target.sectionIdx, this.target.paraIdx, this.target.controlIdx, this.innerParaIdx, this.charOffset, charCount(this.deletedText));
    this.lastContext = fnEditContext(this.target, this.innerParaIdx, this.charOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    wasm.insertTextInFootnote(this.target.sectionIdx, this.target.paraIdx, this.target.controlIdx, this.innerParaIdx, this.charOffset, this.deletedText);
    this.lastContext = fnEditContext(this.target, this.innerParaIdx, this.cursorBeforeOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  editContext(): EditContext { return this.lastContext; }
  mergeWith(): null { return null; }
}

export class SplitParagraphInFootnoteCommand implements EditCommand {
  readonly type = 'splitParagraphInFootnote';
  readonly timestamp = Date.now();
  private lastContext: EditContext;

  constructor(
    private target: FootnoteEditTarget,
    private innerParaIdx: number,
    private charOffset: number,
    private newInnerParaIdx: number,
  ) {
    this.lastContext = fnEditContext(target, newInnerParaIdx, 0);
  }

  execute(wasm: WasmBridge): DocumentPosition {
    wasm.splitParagraphInFootnote(this.target.sectionIdx, this.target.paraIdx, this.target.controlIdx, this.innerParaIdx, this.charOffset);
    this.lastContext = fnEditContext(this.target, this.newInnerParaIdx, 0);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    wasm.mergeParagraphInFootnote(this.target.sectionIdx, this.target.paraIdx, this.target.controlIdx, this.newInnerParaIdx);
    this.lastContext = fnEditContext(this.target, this.innerParaIdx, this.charOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  editContext(): EditContext { return this.lastContext; }
  mergeWith(): null { return null; }
}

export class MergeParagraphInFootnoteCommand implements EditCommand {
  readonly type = 'mergeParagraphInFootnote';
  readonly timestamp = Date.now();
  private lastContext: EditContext;

  constructor(
    private target: FootnoteEditTarget,
    private innerParaIdx: number,
    private prevInnerParaIdx: number,
    private mergeOffset: number,
    /** 병합 전 커서(undo 복원) — Backspace: (innerParaIdx,0), Delete: (prevInnerParaIdx,mergeOffset). */
    private beforeInnerParaIdx: number,
    private beforeOffset: number,
    /** 병합으로 사라진 문단의 스코프 메타데이터 — undo 분할이 되돌린다 (Task #2342). */
    private removedParaMeta?: RemovedParaMeta,
  ) {
    this.lastContext = fnEditContext(target, prevInnerParaIdx, mergeOffset);
  }

  execute(wasm: WasmBridge): DocumentPosition {
    wasm.mergeParagraphInFootnote(this.target.sectionIdx, this.target.paraIdx, this.target.controlIdx, this.innerParaIdx);
    this.lastContext = fnEditContext(this.target, this.prevInnerParaIdx, this.mergeOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    wasm.splitParagraphInFootnote(this.target.sectionIdx, this.target.paraIdx, this.target.controlIdx, this.prevInnerParaIdx, this.mergeOffset, this.removedParaMeta);
    this.lastContext = fnEditContext(this.target, this.beforeInnerParaIdx, this.beforeOffset);
    return hfFnStubPosition(this.target.sectionIdx);
  }

  editContext(): EditContext { return this.lastContext; }
  mergeWith(): null { return null; }
}

// ─── 셀 내부 문단 분할 명령 (셀 내 Enter) ──────────────

export class SplitParagraphInCellCommand implements EditCommand {
  readonly type = 'splitParagraphInCell';
  readonly timestamp = Date.now();

  constructor(private position: DocumentPosition) {}

  execute(wasm: WasmBridge): DocumentPosition {
    const pos = this.position;
    const sec = pos.sectionIndex;
    const ppi = pos.parentParaIndex!;
    const cpi = cellParaIndexOf(pos);
    if (isNestedCell(pos)) {
      wasm.splitParagraphInCellByPath(sec, ppi, cellPathJson(pos), pos.charOffset);
    } else {
      wasm.splitParagraphInCell(sec, ppi, pos.controlIndex!, pos.cellIndex!, cpi, pos.charOffset);
    }
    return cellParagraphPosition(pos, cpi + 1, 0);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    const pos = this.position;
    const sec = pos.sectionIndex;
    const ppi = pos.parentParaIndex!;
    const cpi = cellParaIndexOf(pos);
    if (isNestedCell(pos)) {
      // undo: 분할된 다음 문단을 병합 → cellPath의 cellParaIndex를 +1로 변경
      const undoPath = [...pos.cellPath!];
      undoPath[undoPath.length - 1] = { ...undoPath[undoPath.length - 1], cellParaIndex: cpi + 1 };
      wasm.mergeParagraphInCellByPath(sec, ppi, JSON.stringify(undoPath));
    } else {
      wasm.mergeParagraphInCell(sec, ppi, pos.controlIndex!, pos.cellIndex!, cpi + 1);
    }
    return { ...pos };
  }

  mergeWith(): null { return null; }
}

// ─── 셀 내부 문단 병합 명령 (셀 문단 시작에서 Backspace) ──

export class MergeParagraphInCellCommand implements EditCommand {
  readonly type = 'mergeParagraphInCell';
  readonly timestamp = Date.now();

  private mergePointOffset = 0;
  /** 사라진 문단의 스코프 메타 — undo(분할)가 되돌린다 (Task #2342). */
  private removedParaMeta?: RemovedParaMeta;

  constructor(private position: DocumentPosition) {}

  execute(wasm: WasmBridge): DocumentPosition {
    const pos = this.position;
    const sec = pos.sectionIndex;
    const ppi = pos.parentParaIndex!;
    const cpi = cellParaIndexOf(pos);
    // 병합 전 이전 셀 문단 길이 기억.
    // flat 필드(controlIndex/cellIndex)는 "외부 표 기준" 레거시 좌표라(types.ts DocumentPosition)
    // 중첩 셀에서는 안쪽 셀을 가리키지 못한다. 뮤테이션이 ByPath 로 분기하는 만큼 길이 조회도
    // 같은 축으로 맞춘다(cursor.ts 의 useCellPath 분기와 동형). 어긋나면 undo 가 바깥 셀에서
    // 읽은 길이로 안쪽 셀을 분할해 문단이 엉뚱한 지점에서 잘린다.
    if (isNestedCell(pos)) {
      const prevPath = pos.cellPath!.map((entry, index, path) =>
        index + 1 === path.length ? { ...entry, cellParaIndex: cpi - 1 } : entry,
      );
      this.mergePointOffset = wasm.getCellParagraphLengthByPath(sec, ppi, JSON.stringify(prevPath));
      this.removedParaMeta = JSON.parse(wasm.mergeParagraphInCellByPath(sec, ppi, cellPathJson(pos))).removedParaMeta;
    } else {
      this.mergePointOffset = wasm.getCellParagraphLength(sec, ppi, pos.controlIndex!, pos.cellIndex!, cpi - 1);
      this.removedParaMeta = JSON.parse(wasm.mergeParagraphInCell(sec, ppi, pos.controlIndex!, pos.cellIndex!, cpi)).removedParaMeta;
    }
    return cellParagraphPosition(pos, cpi - 1, this.mergePointOffset);
  }

  undo(wasm: WasmBridge): DocumentPosition {
    const pos = this.position;
    const sec = pos.sectionIndex;
    const ppi = pos.parentParaIndex!;
    const cpi = cellParaIndexOf(pos);
    if (isNestedCell(pos)) {
      const undoPath = [...pos.cellPath!];
      undoPath[undoPath.length - 1] = { ...undoPath[undoPath.length - 1], cellParaIndex: cpi - 1 };
      wasm.splitParagraphInCellByPath(sec, ppi, JSON.stringify(undoPath), this.mergePointOffset, this.removedParaMeta);
    } else {
      wasm.splitParagraphInCell(sec, ppi, pos.controlIndex!, pos.cellIndex!, cpi - 1, this.mergePointOffset, this.removedParaMeta);
    }
    return { ...pos };
  }

  mergeWith(): null { return null; }
}

// ─── 셀 내부 다음 문단 병합 명령 (셀 문단 끝에서 Delete) ──

export class MergeNextParagraphInCellCommand implements EditCommand {
  readonly type = 'mergeNextParagraphInCell';
  readonly timestamp = Date.now();

  /** 사라진 문단의 스코프 메타 — undo(분할)가 되돌린다 (Task #2342). */
  private removedParaMeta?: RemovedParaMeta;

  constructor(private position: DocumentPosition) {}

  execute(wasm: WasmBridge): DocumentPosition {
    const pos = this.position;
    const sec = pos.sectionIndex;
    const ppi = pos.parentParaIndex!;
    const cpi = cellParaIndexOf(pos);
    if (isNestedCell(pos)) {
      const nextPath = [...pos.cellPath!];
      nextPath[nextPath.length - 1] = { ...nextPath[nextPath.length - 1], cellParaIndex: cpi + 1 };
      this.removedParaMeta = JSON.parse(wasm.mergeParagraphInCellByPath(sec, ppi, JSON.stringify(nextPath))).removedParaMeta;
    } else {
      this.removedParaMeta = JSON.parse(wasm.mergeParagraphInCell(sec, ppi, pos.controlIndex!, pos.cellIndex!, cpi + 1)).removedParaMeta;
    }
    return { ...pos };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    const pos = this.position;
    const sec = pos.sectionIndex;
    const ppi = pos.parentParaIndex!;
    const cpi = cellParaIndexOf(pos);
    if (isNestedCell(pos)) {
      wasm.splitParagraphInCellByPath(sec, ppi, cellPathJson(pos), pos.charOffset, this.removedParaMeta);
    } else {
      wasm.splitParagraphInCell(sec, ppi, pos.controlIndex!, pos.cellIndex!, cpi, pos.charOffset, this.removedParaMeta);
    }
    return { ...pos };
  }

  mergeWith(): null { return null; }
}

// ─── 표 이동 명령 ─────────────────────────────────────

export class MoveTableCommand implements EditCommand {
  readonly type = 'moveTable';
  readonly timestamp: number;

  private resultPpi: number;
  private resultCi: number;

  constructor(
    private sec: number,
    private ppi: number,
    private ci: number,
    private deltaH: number,
    private deltaV: number,
    resultPpi: number,
    resultCi: number,
    timestamp?: number,
  ) {
    this.resultPpi = resultPpi;
    this.resultCi = resultCi;
    this.timestamp = timestamp ?? Date.now();
  }

  execute(wasm: WasmBridge): DocumentPosition {
    const result = wasm.moveTableOffset(this.sec, this.ppi, this.ci, this.deltaH, this.deltaV);
    this.resultPpi = result.ppi;
    this.resultCi = result.ci;
    return { sectionIndex: this.sec, paragraphIndex: this.resultPpi, charOffset: 0 };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    // [Task #2903] execute() 는 moveTableOffset 반환값(result.ppi/ci)을 권위 소스로 삼아
    // this.resultPpi/resultCi 를 갱신하는데, undo() 는 동일한 반환값을 버리고 생성 시점의
    // stale this.ppi/this.ci 를 그대로 반환했다. 표 이동과 문단 구조 변경(삽입/삭제/병합)이
    // 같은 세션에서 섞이면 undo 후 커서가 존재하지 않거나 엉뚱한 문단을 가리킬 수 있다 —
    // execute() 와 대칭으로 반환값을 캡처해 this.ppi/this.ci 를 갱신한다.
    const result = wasm.moveTableOffset(this.sec, this.resultPpi, this.resultCi, -this.deltaH, -this.deltaV);
    this.ppi = result.ppi;
    this.ci = result.ci;
    return { sectionIndex: this.sec, paragraphIndex: this.ppi, charOffset: 0 };
  }

  mergeWith(other: EditCommand): EditCommand | null {
    if (!(other instanceof MoveTableCommand)) return null;
    if (other.sec !== this.sec) return null;
    // 연속 이동: 이전 결과 위치 == 다음 시작 위치
    if (other.ppi !== this.resultPpi || other.ci !== this.resultCi) return null;
    if (other.timestamp - this.timestamp > 500) return null;

    return new MoveTableCommand(
      this.sec, this.ppi, this.ci,
      this.deltaH + other.deltaH,
      this.deltaV + other.deltaV,
      other.resultPpi, other.resultCi,
      this.timestamp,
    );
  }
}

// ─── 그림 이동 명령 ─────────────────────────────────────

/** 두 cellPath 가 동일한지 비교 (undefined/빈배열은 본문(body-level)로 동일 취급) */
function sameCellPath(a?: CellPathLike, b?: CellPathLike): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * [Task #825] 머리말/꼬리말 안의 그림을 가리키는 marker.
 *
 * 머리말/꼬리말의 내부 문단 인덱스는 본문 문단 목록과 완전히 다른 인덱스 공간이라
 * `sec/ppi/ci` 만으로는 대상을 찾을 수 없다. 바깥쪽(본문) 문단·컨트롤 인덱스를 함께
 * 넘겨야 `setHeaderFooterPictureProperties` 가 올바른 그림에 도달한다.
 * PictureObjectRef.headerFooter (input-handler-picture.ts) 와 동일한 형태.
 */
export type HeaderFooterObjectRef = {
  kind: 'header' | 'footer';
  outerParaIdx: number;
  outerControlIdx: number;
};

/** 두 headerFooter marker 가 동일한지 비교 (undefined 는 본문으로 동일 취급) */
function sameHeaderFooter(a?: HeaderFooterObjectRef, b?: HeaderFooterObjectRef): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind &&
    a.outerParaIdx === b.outerParaIdx &&
    a.outerControlIdx === b.outerControlIdx;
}

/**
 * 개체 이동 명령용 속성 조회 — headerFooter 우선, 없으면 cellPath 로 분기.
 * (input-handler-picture.ts 의 getObjectProperties 와 동일한 분기 순서)
 */
function moveGetProps(
  wasm: WasmBridge, kind: 'image' | 'shape',
  sec: number, ppi: number, ci: number, cellPath?: CellPathLike,
  headerFooter?: HeaderFooterObjectRef,
): { horzOffset: number; vertOffset: number } {
  const nested = !!cellPath && cellPath.length > 0;
  if (kind === 'shape') {
    return nested ? wasm.getCellShapePropertiesByPath(sec, ppi, cellPath!, ci) : wasm.getShapeProperties(sec, ppi, ci);
  }
  if (headerFooter) {
    return wasm.getHeaderFooterPictureProperties(
      sec, headerFooter.outerParaIdx, headerFooter.outerControlIdx, ppi, ci,
    );
  }
  return nested ? wasm.getCellPicturePropertiesByPath(sec, ppi, cellPath!, ci) : wasm.getPictureProperties(sec, ppi, ci);
}

/**
 * 개체 이동 명령용 속성 변경 — headerFooter 우선, 없으면 cellPath 로 분기.
 * (input-handler-picture.ts 의 setObjectProperties 와 동일한 분기 순서)
 */
function moveSetProps(
  wasm: WasmBridge, kind: 'image' | 'shape',
  sec: number, ppi: number, ci: number, cellPath: CellPathLike | undefined,
  props: Record<string, unknown>,
  headerFooter?: HeaderFooterObjectRef,
): void {
  const nested = !!cellPath && cellPath.length > 0;
  if (kind === 'shape') {
    if (nested) { wasm.setCellShapePropertiesByPath(sec, ppi, cellPath!, ci, props); return; }
    wasm.setShapeProperties(sec, ppi, ci, props);
    return;
  }
  if (headerFooter) {
    wasm.setHeaderFooterPictureProperties(
      sec, headerFooter.outerParaIdx, headerFooter.outerControlIdx, ppi, ci, props,
    );
    return;
  }
  if (nested) { wasm.setCellPicturePropertiesByPath(sec, ppi, cellPath!, ci, props); return; }
  wasm.setPictureProperties(sec, ppi, ci, props);
}

export class MovePictureCommand implements EditCommand {
  readonly type = 'movePicture';
  readonly timestamp: number;

  constructor(
    private sec: number,
    private ppi: number,
    private ci: number,
    private deltaH: number,
    private deltaV: number,
    private origHorzOffset: number,
    private origVertOffset: number,
    private cellPath?: CellPathLike,
    private headerFooter?: HeaderFooterObjectRef,
    timestamp?: number,
  ) {
    this.timestamp = timestamp ?? Date.now();
  }

  execute(wasm: WasmBridge): DocumentPosition {
    const props = moveGetProps(
      wasm, 'image', this.sec, this.ppi, this.ci, this.cellPath, this.headerFooter,
    );
    moveSetProps(wasm, 'image', this.sec, this.ppi, this.ci, this.cellPath, {
      horzOffset: props.horzOffset + this.deltaH,
      vertOffset: props.vertOffset + this.deltaV,
    }, this.headerFooter);
    return { sectionIndex: this.sec, paragraphIndex: this.ppi, charOffset: 0 };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    moveSetProps(wasm, 'image', this.sec, this.ppi, this.ci, this.cellPath, {
      horzOffset: this.origHorzOffset,
      vertOffset: this.origVertOffset,
    }, this.headerFooter);
    return { sectionIndex: this.sec, paragraphIndex: this.ppi, charOffset: 0 };
  }

  mergeWith(other: EditCommand): EditCommand | null {
    if (!(other instanceof MovePictureCommand)) return null;
    if (other.sec !== this.sec || other.ppi !== this.ppi || other.ci !== this.ci) return null;
    if (!sameCellPath(other.cellPath, this.cellPath)) return null;
    // [Task #825] 머리말/꼬리말 그림은 본문 그림과 sec/ppi/ci 가 겹칠 수 있어
    // marker 까지 같아야 병합한다.
    if (!sameHeaderFooter(other.headerFooter, this.headerFooter)) return null;
    if (other.timestamp - this.timestamp > 500) return null;

    return new MovePictureCommand(
      this.sec, this.ppi, this.ci,
      this.deltaH + other.deltaH,
      this.deltaV + other.deltaV,
      this.origHorzOffset,
      this.origVertOffset,
      this.cellPath,
      this.headerFooter,
      this.timestamp,
    );
  }
}

export class MoveShapeCommand implements EditCommand {
  readonly type = 'moveShape';
  readonly timestamp: number;

  constructor(
    private sec: number,
    private ppi: number,
    private ci: number,
    private deltaH: number,
    private deltaV: number,
    private origHorzOffset: number,
    private origVertOffset: number,
    private cellPath?: CellPathLike,
    private headerFooter?: HeaderFooterObjectRef,
    timestamp?: number,
  ) {
    this.timestamp = timestamp ?? Date.now();
  }

  execute(wasm: WasmBridge): DocumentPosition {
    const props = moveGetProps(
      wasm, 'shape', this.sec, this.ppi, this.ci, this.cellPath, this.headerFooter,
    );
    moveSetProps(wasm, 'shape', this.sec, this.ppi, this.ci, this.cellPath, {
      horzOffset: props.horzOffset + this.deltaH,
      vertOffset: props.vertOffset + this.deltaV,
    }, this.headerFooter);
    return { sectionIndex: this.sec, paragraphIndex: this.ppi, charOffset: 0 };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    moveSetProps(wasm, 'shape', this.sec, this.ppi, this.ci, this.cellPath, {
      horzOffset: this.origHorzOffset,
      vertOffset: this.origVertOffset,
    }, this.headerFooter);
    return { sectionIndex: this.sec, paragraphIndex: this.ppi, charOffset: 0 };
  }

  mergeWith(other: EditCommand): EditCommand | null {
    if (!(other instanceof MoveShapeCommand)) return null;
    if (other.sec !== this.sec || other.ppi !== this.ppi || other.ci !== this.ci) return null;
    if (!sameCellPath(other.cellPath, this.cellPath)) return null;
    if (!sameHeaderFooter(other.headerFooter, this.headerFooter)) return null;
    if (other.timestamp - this.timestamp > 500) return null;

    return new MoveShapeCommand(
      this.sec, this.ppi, this.ci,
      this.deltaH + other.deltaH,
      this.deltaV + other.deltaV,
      this.origHorzOffset,
      this.origVertOffset,
      this.cellPath,
      this.headerFooter,
      this.timestamp,
    );
  }
}


// ─── 개체 크기/위치 속성 변경 명령 ─────────────────────

export type ObjectResizeTarget = {
  sec: number;
  ppi: number;
  ci: number;
  type: string;
  cellPath?: CellPathLike;
  /** [Task #825] 머리말/꼬리말 내부 그림이면 반드시 함께 기록해야 undo 가 같은 개체를 찾는다. */
  headerFooter?: HeaderFooterObjectRef;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

/**
 * 그림/도형 리사이즈처럼 드래그 중 WASM에 이미 반영된 속성 변경을
 * Undo/Redo 스택에 기록하기 위한 명령.
 */
export class ResizeObjectCommand implements EditCommand {
  readonly type = 'resizeObject';
  readonly timestamp: number;

  constructor(
    private targets: ObjectResizeTarget[],
    timestamp?: number,
  ) {
    this.timestamp = timestamp ?? Date.now();
  }

  private setProps(wasm: WasmBridge, target: ObjectResizeTarget, props: Record<string, unknown>): void {
    if (target.type === 'shape' || target.type === 'line' || target.type === 'group' || target.type === 'ole') {
      if (target.cellPath && target.cellPath.length > 0) {
        wasm.setCellShapePropertiesByPath(target.sec, target.ppi, target.cellPath, target.ci, props);
        return;
      }
      wasm.setShapeProperties(target.sec, target.ppi, target.ci, props);
    } else {
      // [Task #825] 머리말/꼬리말 그림은 내부 문단 인덱스 공간을 쓰므로 cellPath 보다 우선
      // 분기한다 (input-handler-picture.ts 의 setObjectProperties 와 동일 순서).
      if (target.type === 'image' && target.headerFooter) {
        wasm.setHeaderFooterPictureProperties(
          target.sec,
          target.headerFooter.outerParaIdx,
          target.headerFooter.outerControlIdx,
          target.ppi,
          target.ci,
          props,
        );
        return;
      }
      if (target.type === 'image' && target.cellPath && target.cellPath.length > 0) {
        wasm.setCellPicturePropertiesByPath(target.sec, target.ppi, target.cellPath, target.ci, props);
        return;
      }
      wasm.setPictureProperties(target.sec, target.ppi, target.ci, props);
    }
  }

  execute(wasm: WasmBridge): DocumentPosition {
    for (const target of this.targets) {
      this.setProps(wasm, target, target.after);
    }
    const first = this.targets[0];
    return { sectionIndex: first?.sec ?? 0, paragraphIndex: first?.ppi ?? 0, charOffset: 0 };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    for (const target of this.targets) {
      this.setProps(wasm, target, target.before);
    }
    const first = this.targets[0];
    return { sectionIndex: first?.sec ?? 0, paragraphIndex: first?.ppi ?? 0, charOffset: 0 };
  }

  mergeWith(): null { return null; }
}

/**
 * [Task #2759] 직선/연결선 끝점 드래그를 Undo/Redo 스택에 기록하기 위한 명령.
 *
 * ResizeObjectCommand 와 동일하게 드래그 중 WASM 에 이미 반영된 변경을 kind:'record' 로
 * 사후 기록한다(execute 는 redo 경로에서만 재적용). before/after 는 글로벌 끝점 좌표
 * (HWPUNIT)이며 moveLineEndpoint 는 절대 좌표 setter 라 역연산이 자명하다.
 */
export class MoveLineEndpointCommand implements EditCommand {
  readonly type = 'moveLineEndpoint';
  readonly timestamp: number;

  constructor(
    private sec: number,
    private ppi: number,
    private ci: number,
    private before: LineEndpointsLike,
    private after: LineEndpointsLike,
    timestamp?: number,
  ) {
    this.timestamp = timestamp ?? Date.now();
  }

  execute(wasm: WasmBridge): DocumentPosition {
    wasm.moveLineEndpoint(this.sec, this.ppi, this.ci,
      this.after.sx, this.after.sy, this.after.ex, this.after.ey);
    return { sectionIndex: this.sec, paragraphIndex: this.ppi, charOffset: 0 };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    wasm.moveLineEndpoint(this.sec, this.ppi, this.ci,
      this.before.sx, this.before.sy, this.before.ex, this.before.ey);
    return { sectionIndex: this.sec, paragraphIndex: this.ppi, charOffset: 0 };
  }

  mergeWith(): null { return null; }
}

/**
 * [Task #2374] 양식 값 변경 대상 — 본문 또는 표 셀 내 컨트롤 locator + 전/후 값 JSON.
 * before/after 는 setFormValue(InCell) 에 그대로 전달되는 JSON 문자열이다.
 */
export interface FormValueTarget {
  sec: number;
  para: number;
  ci: number;
  inCell?: { tablePara: number; tableCi: number; cellIdx: number; cellPara: number };
  beforeJson: string;
  afterJson: string;
}

/**
 * [Task #2374] 양식 컨트롤 값 변경의 경량 역연산 명령 (kind:'record' 용, #2337 계열).
 *
 * 뮤테이션은 클릭 핸들러가 직접 적용하고 이 명령은 기록만 담당한다(재실행 안 함).
 * 라디오 버튼처럼 다중 쓰기(그룹 해제 + 선택)인 조작은 targets 배열로 묶어 undo/redo 가
 * 그룹 상태를 원자적으로 왕복하게 한다 — 양식 모드에서는 snapshot 이 게이트에서 드롭되므로
 * record 가 유일한 기록 경로다.
 */
export class SetFormValueCommand implements EditCommand {
  readonly type = 'setFormValue';
  readonly timestamp: number;

  constructor(
    private targets: FormValueTarget[],
    private pos: DocumentPosition,
    timestamp?: number,
  ) {
    this.timestamp = timestamp ?? Date.now();
  }

  private apply(wasm: WasmBridge, t: FormValueTarget, json: string): void {
    if (t.inCell) {
      wasm.setFormValueInCell(t.sec, t.inCell.tablePara, t.inCell.tableCi, t.inCell.cellIdx, t.inCell.cellPara, t.ci, json);
    } else {
      wasm.setFormValue(t.sec, t.para, t.ci, json);
    }
  }

  execute(wasm: WasmBridge): DocumentPosition {
    for (const t of this.targets) this.apply(wasm, t, t.afterJson);
    return this.pos;
  }

  undo(wasm: WasmBridge): DocumentPosition {
    for (let i = this.targets.length - 1; i >= 0; i--) this.apply(wasm, this.targets[i], this.targets[i].beforeJson);
    return this.pos;
  }

  mergeWith(): null { return null; }
}

// ─── 스냅샷 기반 명령 (복잡한 작업의 Undo/Redo) ─────

/**
 * Document 스냅샷을 이용한 Undo/Redo 명령.
 *
 * 역연산 구현이 복잡한 작업(붙여넣기, 객체 삭제 등)에 사용한다.
 * - 최초 실행: before 스냅샷 저장 → 작업 수행 → after 스냅샷 저장
 * - Undo: before 스냅샷으로 복원
 * - Redo: after 스냅샷으로 복원
 * - Discard: 양쪽 스냅샷 메모리 해제
 */
export class SnapshotCommand implements EditCommand {
  readonly type: string;
  readonly timestamp = Date.now();

  private beforeId: number | null = null;
  private afterId: number | null = null;

  /**
   * @param operationType 작업 종류 (예: 'pasteInternal', 'deleteControl')
   * @param cursorBefore 작업 전 커서 위치
   * @param operation 실제 작업을 수행하는 함수. 작업 후 커서 위치를 반환.
   */
  constructor(
    operationType: string,
    private cursorBefore: DocumentPosition,
    private cursorAfter: DocumentPosition,
    private operation: ((wasm: WasmBridge) => DocumentPosition) | null,
  ) {
    this.type = `snapshot:${operationType}`;
  }

  execute(wasm: WasmBridge): DocumentPosition {
    if (this.afterId !== null) {
      // Redo: after 스냅샷으로 복원
      wasm.restoreSnapshot(this.afterId);
      return { ...this.cursorAfter };
    }

    // 최초 실행: before 저장 → 작업 수행 → after 저장
    this.beforeId = wasm.saveSnapshot();
    // [Task #2328] operation 또는 after-save 중 어느 것이 throw 하든 커맨드가
    // 히스토리에 등록되지 못해 discard 주체가 사라진다 → 스냅샷 영구 누수(orphan
    // → WASM 무통보 축출 재발). after-save(대용량 문서 클론 시 메모리 압박 등)까지
    // try 범위에 포함해 before/after 를 대칭적으로 해제한다.
    try {
      if (this.operation) {
        this.cursorAfter = this.operation(wasm);
      }
      this.afterId = wasm.saveSnapshot();
    } catch (e) {
      this.discard(wasm); // before/after id 를 null-safe 로 해제
      throw e;
    }

    // operation 참조 해제 (클로저에 캡처된 리소스 해제)
    this.operation = null;

    return { ...this.cursorAfter };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    if (this.beforeId !== null) {
      wasm.restoreSnapshot(this.beforeId);
    }
    return { ...this.cursorBefore };
  }

  mergeWith(): null { return null; }

  /** [Task #2328] 현재 살아있는 before/after 스냅샷 id 개수. */
  snapshotResourceCount(): number {
    return (this.beforeId !== null ? 1 : 0) + (this.afterId !== null ? 1 : 0);
  }

  discard(wasm: WasmBridge): void {
    if (this.beforeId !== null) {
      wasm.discardSnapshot(this.beforeId);
      this.beforeId = null;
    }
    if (this.afterId !== null) {
      wasm.discardSnapshot(this.afterId);
      this.afterId = null;
    }
  }
}
