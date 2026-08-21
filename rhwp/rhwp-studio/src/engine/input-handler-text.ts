/** input-handler text methods — extracted from InputHandler class */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  InsertTextCommand,
  DeleteTextCommand,
  MergeParagraphCommand,
  MergeNextParagraphCommand,
  MergeParagraphInCellCommand,
  MergeNextParagraphInCellCommand,
  InsertTextInHeaderFooterCommand,
  DeleteTextInHeaderFooterCommand,
  MergeParagraphInHeaderFooterCommand,
  InsertTextInFootnoteCommand,
  insertTextWithMutationEffects,
  deleteTextWithMutationEffects,
  replaceBodyTextWithMutationEffects,
  canUseDeferredCellTextReplace,
  replaceCellTextWithMutationEffects,
  canUseLocalBodyTextReplace,
  cellParaIndexOf,
  IMMEDIATE_TEXT_MUTATION_EFFECTS,
  NO_TEXT_MUTATION_EFFECTS,
  TextMutationEffectAccumulator,
} from './command';
import type { TextMutationEffects } from './command';
import type { DocumentPosition } from '@/core/types';
import { showConfirm } from '@/ui/confirm-dialog';
import {
  detectPlatformKind,
  getNavigationAction,
  shouldSuppressUnmappedNavigation,
  type NavigationAction,
  type NavigationKeyInput,
} from './navigation-keymap';

/** WASM의 offset/count 계약인 Unicode scalar 길이로 DOM 문자열을 변환한다. */
function charCount(s: string): number {
  return [...s].length;
}

const FOOTNOTE_DELETE_TITLE = '각주 삭제';
const FOOTNOTE_DELETE_MESSAGE = '각주를 삭제하시겠습니까?';

function tryConfirmRemoveClickHereAtBoundary(
  this: any,
  pos: DocumentPosition,
  direction: 'backward' | 'forward',
): boolean {
  if (this.isFormMode?.()) return false;
  try {
    const fi = this.wasm.getFieldInfoAt(pos);
    if (!fi.inField || fi.fieldType !== 'clickhere') return false;
    const start = fi.startCharIdx ?? -1;
    const end = fi.endCharIdx ?? -1;
    if (start < 0 || end < 0) return false;

    const atBoundary = direction === 'forward'
      ? pos.charOffset >= end
      : pos.charOffset <= start || (pos.charOffset >= end && this.isAtExitedFieldEnd?.(pos, fi));
    if (!atBoundary) return false;

    return this.confirmRemoveCurrentField?.() ?? true;
  } catch {
    return false;
  }
}

/** IME 조합 종료 후 대기 중인 탐색 키를 처리한다 */
function executeNavigationAction(this: any, action: NavigationAction, shiftKey: boolean): void {
  if (shiftKey) this.cursor.setAnchor();
  else this.cursor.clearSelection();

  switch (action) {
    case 'wordBackward':
      this.cursor.moveToWordBoundary(-1);
      break;
    case 'wordForward':
      this.cursor.moveToWordBoundary(1);
      break;
    case 'lineStart':
      this.cursor.moveToLineStart();
      this.markCurrentFieldStartOutside?.();
      break;
    case 'lineEnd':
      this.cursor.moveToLineEnd();
      this.markCurrentFieldEndOutside?.();
      break;
    case 'paragraphBackward':
      this.cursor.moveToParagraphBoundary(-1);
      break;
    case 'paragraphForward':
      this.cursor.moveToParagraphBoundary(1);
      break;
  }

  this.updateCaret();
  if (shiftKey) this.updateSelection();
}

function processPendingNav(this: any, nav: NavigationKeyInput): void {
  this.flushDeferredPaginationIfNeeded('before-navigation', false);
  const { code, shiftKey } = nav;
  const platform = detectPlatformKind();
  const action = getNavigationAction(nav, platform);
  if (action) {
    executeNavigationAction.call(this, action, shiftKey);
    return;
  }
  if (shouldSuppressUnmappedNavigation(nav, platform)) return;

  // 방향키 처리
  if (code === 'ArrowLeft' || code === 'ArrowRight' ||
      code === 'ArrowUp' || code === 'ArrowDown') {
    const vertical = this.cursor.isInVerticalCell?.() ?? false;
    if (shiftKey) {
      this.cursor.setAnchor();
    } else {
      this.cursor.clearSelection();
    }
    let moveH: number | null = null;
    let moveV: number | null = null;
    if (code === 'ArrowLeft') {
      if (vertical) moveV = -1; else moveH = -1;
    } else if (code === 'ArrowRight') {
      if (vertical) moveV = 1; else moveH = 1;
    } else if (code === 'ArrowUp') {
      if (vertical) moveH = -1; else moveV = -1;
    } else {
      if (vertical) moveH = 1; else moveV = 1;
    }
    if (!shiftKey && moveH === 1 && this.tryEnterExitedFieldStart?.()) {
      this.updateCaret();
      return;
    }
    if (!shiftKey && moveH === -1 && this.tryEnterExitedFieldEnd?.()) {
      this.updateCaret();
      return;
    }
    if (!shiftKey && moveH === -1 && this.tryExitCurrentFieldStart?.()) {
      this.updateCaret();
      return;
    }
    if (!shiftKey && moveH === 1 && this.tryExitCurrentFieldEnd?.()) {
      this.updateCaret();
      return;
    }
    if (moveH !== null) this.cursor.moveHorizontal(moveH);
    if (moveV !== null) this.cursor.moveVertical(moveV);
    this.updateCaret();
  } else if (code === 'Home') {
    if (shiftKey) this.cursor.setAnchor(); else this.cursor.clearSelection();
    this.cursor.moveToLineStart();
    this.markCurrentFieldStartOutside?.();
    this.updateCaret();
  } else if (code === 'End') {
    if (shiftKey) this.cursor.setAnchor(); else this.cursor.clearSelection();
    this.cursor.moveToLineEnd();
    this.markCurrentFieldEndOutside?.();
    this.updateCaret();
  } else if (code === 'Enter') {
    // Enter는 조합 확정만으로 충분 (줄바꿈은 별도 처리 불필요)
  }
}

function tryDeleteBodyFootnoteAtCursor(
  this: any,
  pos: DocumentPosition,
  direction: 'backward' | 'forward',
): boolean {
  if (pos.parentParaIndex !== undefined || pos.cellPath || pos.isTextBox) return false;

  try {
    const hit = this.wasm.getFootnoteAtCursor(
      pos.sectionIndex,
      pos.paragraphIndex,
      pos.charOffset,
      direction,
    );
    if (!hit.hit || hit.controlIndex === undefined) return false;

    const sectionIndex = hit.sectionIndex ?? pos.sectionIndex;
    const paragraphIndex = hit.paragraphIndex ?? pos.paragraphIndex;
    const controlIndex = hit.controlIndex;

    void showConfirm(FOOTNOTE_DELETE_TITLE, FOOTNOTE_DELETE_MESSAGE)
      .then((ok) => {
        if (!ok) {
          this.textarea?.focus();
          return;
        }
        this.executeOperation({
          kind: 'snapshot',
          operationType: 'deleteFootnote',
          operation: (wasm: any) => {
            const result = wasm.deleteFootnote(sectionIndex, paragraphIndex, controlIndex);
            return {
              sectionIndex: result.sectionIndex,
              paragraphIndex: result.paragraphIndex,
              charOffset: result.charOffset,
            };
          },
        });
        this.textarea?.focus();
      })
      .catch(() => {
        this.textarea?.focus();
      });
    return true;
  } catch {
    return false;
  }
}

export function handleBackspace(this: any, pos: DocumentPosition, inCell: boolean): void {
  if (this.isFormMode?.() && !this.canEditCurrentFormField?.()) return;
  // 머리말/꼬리말 편집 모드
  if (this.cursor.isInHeaderFooter()) {
    const isHeader = this.cursor.headerFooterMode === 'header';
    const hfOff = this.cursor.hfCharOffset;
    const target = { sectionIdx: this.cursor.hfSectionIdx, isHeader, applyTo: this.cursor.hfApplyTo };
    const paraIdx = this.cursor.hfParaIdx;
    if (hfOff > 0) {
      // [Task #2337] 삭제 텍스트를 WASM 반환에서 확보해 역연산(재삽입) 기록. Backspace 이므로
      // undo 후 커서는 hfOff(삭제 전 위치)로 복귀.
      const res = JSON.parse(this.wasm.deleteTextInHeaderFooter(target.sectionIdx, isHeader, target.applyTo, paraIdx, hfOff - 1, 1));
      this.executeOperation({ kind: 'record', command: new DeleteTextInHeaderFooterCommand(target, paraIdx, hfOff - 1, res.deletedText ?? '', hfOff) });
      this.cursor.setHfCursorPosition(paraIdx, hfOff - 1);
      this.afterEdit();
    } else if (paraIdx > 0) {
      // 문단 시작에서 Backspace → 이전 문단과 병합
      const result = JSON.parse(this.wasm.mergeParagraphInHeaderFooter(target.sectionIdx, isHeader, target.applyTo, paraIdx));
      // Backspace 병합: 병합 전 커서는 (paraIdx, 0).
      this.executeOperation({ kind: 'record', command: new MergeParagraphInHeaderFooterCommand(target, paraIdx, result.hfParaIndex, result.charOffset, paraIdx, 0, result.removedParaMeta) });
      this.cursor.setHfCursorPosition(result.hfParaIndex, result.charOffset);
      this.afterEdit();
    }
    return;
  }

  const { charOffset } = pos;

  // 필드 경계 보호: 필드 시작 위치에서는 Backspace 차단
  try {
    const fi = this.wasm.getFieldInfoAt(pos);
    if (fi.inField && this.isAtExitedFieldStart?.(pos, fi)) {
      // 누름틀 시작 바깥에서는 Backspace가 앞쪽 본문 글자를 지운다.
    } else if (fi.inField && charOffset <= fi.startCharIdx) {
      if (tryConfirmRemoveClickHereAtBoundary.call(this, pos, 'backward')) return;
      return;
    }
    if (fi.inField && this.isAtExitedFieldEnd?.(pos, fi)) {
      if (tryConfirmRemoveClickHereAtBoundary.call(this, pos, 'backward')) return;
    }
  } catch { /* 무시 */ }

  // 번호/글머리표 문단 시작에서 Backspace → 병합 대신 번호를 해제해 일반 문단으로
  // 돌아간다 (한/글·Word 공통 관례). 이미 일반 문단이면 기존 병합/삭제가 실행된다.
  if (charOffset === 0) {
    try {
      const props = this.getParaProperties();
      if (props.headType && props.headType !== 'None') {
        this.clearParaNumbering();
        return;
      }
    } catch { /* 문단 속성 조회 실패 시 기존 동작 유지 */ }
  }

  if (inCell) {
    if (charOffset > 0) {
      const deletePos = { ...pos, charOffset: charOffset - 1 };
      this.executeOperation({ kind: 'command', command: new DeleteTextCommand(deletePos, 1, 'backward') });
    } else if (cellParaIndexOf(pos) > 0) {
      // 셀 문단 시작에서 Backspace → 이전 셀 문단과 병합.
      // [#2717] 중첩 셀에서 flat `pos.cellParaIndex` 는 hit-test 가 cellPath[0](최외곽)로 채운
      // 바깥 셀의 문단 인덱스라, 그대로 쓰면 안쪽 셀 2번째 문단에서 병합이 통째로 누락되고
      // (바깥이 0), 안쪽 첫 문단에서는 cellParaIndex:-1 경로로 병합이 실행된다(바깥이 ≥1).
      // 아래 handleDelete(:307 useCellPath) 와 동일하게 안쪽 축으로 판정한다.
      this.executeOperation({ kind: 'command', command: new MergeParagraphInCellCommand(pos) });
    }
  } else {
    const { sectionIndex: sec, paragraphIndex: para } = pos;
    if (tryDeleteBodyFootnoteAtCursor.call(this, pos, 'backward')) return;
    if (charOffset > 0) {
      const deletePos = { ...pos, charOffset: charOffset - 1 };
      this.executeOperation({ kind: 'command', command: new DeleteTextCommand(deletePos, 1, 'backward') });
    } else if (para > 0) {
      // 문단 시작에서 Backspace → 이전 문단과 병합
      this.executeOperation({ kind: 'command', command: new MergeParagraphCommand({ sectionIndex: sec, paragraphIndex: para, charOffset: 0 }) });
    }
  }
}

export function handleDelete(this: any, pos: DocumentPosition, inCell: boolean): void {
  if (this.isFormMode?.() && !this.canEditCurrentFormField?.()) return;
  // 머리말/꼬리말 편집 모드
  if (this.cursor.isInHeaderFooter()) {
    const isHeader = this.cursor.headerFooterMode === 'header';
    const target = { sectionIdx: this.cursor.hfSectionIdx, isHeader, applyTo: this.cursor.hfApplyTo };
    try {
      const paraIdx = this.cursor.hfParaIdx;
      const info = JSON.parse(this.wasm.getHeaderFooterParaInfo(target.sectionIdx, isHeader, target.applyTo, paraIdx));
      const hfOff = this.cursor.hfCharOffset;
      if (hfOff < info.charCount) {
        // Delete(forward): 커서는 hfOff 유지 → undo 후에도 hfOff.
        const res = JSON.parse(this.wasm.deleteTextInHeaderFooter(target.sectionIdx, isHeader, target.applyTo, paraIdx, hfOff, 1));
        this.executeOperation({ kind: 'record', command: new DeleteTextInHeaderFooterCommand(target, paraIdx, hfOff, res.deletedText ?? '', hfOff) });
        this.afterEdit();
      } else if (paraIdx + 1 < info.paraCount) {
        // 문단 끝에서 Delete → 다음 문단(paraIdx+1)을 현재 문단으로 병합. 병합 전 커서는 (paraIdx, 끝).
        const result = JSON.parse(this.wasm.mergeParagraphInHeaderFooter(target.sectionIdx, isHeader, target.applyTo, paraIdx + 1));
        this.executeOperation({ kind: 'record', command: new MergeParagraphInHeaderFooterCommand(target, paraIdx + 1, result.hfParaIndex, result.charOffset, result.hfParaIndex, result.charOffset, result.removedParaMeta) });
        this.cursor.setHfCursorPosition(result.hfParaIndex, result.charOffset);
        this.afterEdit();
      }
    } catch { /* ignore */ }
    return;
  }

  const { charOffset } = pos;

  // 필드 경계 보호: 필드 끝 위치에서는 Delete 차단
  try {
    const fi = this.wasm.getFieldInfoAt(pos);
    if (fi.inField && charOffset >= fi.endCharIdx) {
      if (tryConfirmRemoveClickHereAtBoundary.call(this, pos, 'forward')) return;
      return;
    }
  } catch { /* 무시 */ }

  if (inCell) {
    const sec = pos.sectionIndex;
    const ppi = pos.parentParaIndex!;
    const ci = pos.controlIndex!;
    const cei = pos.cellIndex!;
    const useCellPath = (pos.cellPath?.length ?? 0) > 0;
    const cpi = useCellPath ? pos.cellPath![pos.cellPath!.length - 1].cellParaIndex : pos.cellParaIndex!;
    const pathJson = useCellPath ? JSON.stringify(pos.cellPath) : '';
    const paraLen = useCellPath
      ? this.wasm.getCellParagraphLengthByPath(sec, ppi, pathJson)
      : this.wasm.getCellParagraphLength(sec, ppi, ci, cei, cpi);
    if (charOffset < paraLen) {
      this.executeOperation({ kind: 'command', command: new DeleteTextCommand(pos, 1, 'forward') });
    } else {
      // 셀 문단 끝에서 Delete → 다음 셀 문단과 병합
      const paraCount = useCellPath
        ? this.wasm.getCellParagraphCountByPath(sec, ppi, pathJson)
        : this.wasm.getCellParagraphCount(sec, ppi, ci, cei);
      if (cpi + 1 < paraCount) {
        this.executeOperation({ kind: 'command', command: new MergeNextParagraphInCellCommand(pos) });
      }
    }
  } else {
    const { sectionIndex: sec, paragraphIndex: para } = pos;
    if (tryDeleteBodyFootnoteAtCursor.call(this, pos, 'forward')) return;
    const paraLen = this.wasm.getParagraphLength(sec, para);
    if (charOffset < paraLen) {
      this.executeOperation({ kind: 'command', command: new DeleteTextCommand(pos, 1, 'forward') });
    } else {
      // 문단 끝에서 Delete → 다음 문단과 병합
      const paraCount = this.wasm.getParagraphCount(sec);
      if (para + 1 < paraCount) {
        this.executeOperation({ kind: 'command', command: new MergeNextParagraphCommand(pos) });
      }
    }
  }
}

export function onCompositionStart(this: any): void {
  if (this.isComposing) onCompositionEnd.call(this);
  this.resetRawTextMutationEffects();
  // 선택 영역이 있으면 삭제 후 조합 시작
  if (this.cursor.hasSelection()) {
    if (!this.canDeleteSelectionInFormMode?.()) {
      this.resetTextareaBuffer();
      return;
    }
    this.deleteSelection();
  }
  let basePos = this.cursor.isInHeaderFooter()
    ? { ...this.cursor.getPosition(), charOffset: this.cursor.hfCharOffset }
    : this.cursor.isInFootnote()
      ? { ...this.cursor.getPosition(), charOffset: this.cursor.fnCharOffset }
      : this.cursor.getPosition();
  if (!this.cursor.isInHeaderFooter() && !this.cursor.isInFootnote()) {
    basePos = this.prepareClickHereInputPosition?.() ?? basePos;
  }
  if (!this.canInsertTextInFormMode?.(basePos)) {
    this.resetTextareaBuffer();
    this.imeSession.reset();
    this.compositionAnchor = null;
    this.clearCompositionAnchorRect();
    this.compositionLength = 0;
    return;
  }

  this.captureCompositionAnchorRect(basePos);
  this.compositionFontFamily = null;
  this.compositionFontSizePx = null;
  this.imeSession.start();
  this.compositionAnchor = basePos;
  this.compositionLength = 0;
}

export function onCompositionUpdate(this: any, event: CompositionEvent): void {
  if (!this.active || !this.isComposing || !this.compositionAnchor) return;
  const previous = this.imeSession.preedit;
  const preedit = this.imeSession.update(event.data.replace(/[\r\n]+/g, ''));
  this.compositionLength = charCount(preedit);
  if (preedit !== previous) this.updateCompositionOverlay();
}

export function onCompositionEnd(this: any, event?: CompositionEvent): void {
  const anchor = this.compositionAnchor;
  const textareaText = this.unconsumedTextareaValue().replace(/[\r\n]+/g, '');
  const commit = this.imeSession.finish(event?.data, textareaText);
  if (!commit) return;

  const composed = commit.text;
  this.compositionAnchor = null;
  this.clearCompositionAnchorRect();
  this.compositionLength = 0;
  this.compositionFontFamily = null;
  this.compositionFontSizePx = null;
  // value 를 비우지 않는다 — 다음 음절의 조합이 이미 textarea 에서 진행 중일 수
  // 있고 (렌더링이 타자 속도보다 느릴 때), 그 순간의 value 변경은 브라우저가
  // 조합을 파기해 글자를 씹는다. 반영 완료 지점만 전진시킨다.
  this.consumeTextareaValue();
  this.caret.hideComposition();
  this.resetRawTextMutationEffects();

  let committed = false;
  if (anchor && composed && this.canInsertTextInFormMode?.(anchor)) {
    const scalarLength = charCount(composed);
    if (this.cursor.isInHeaderFooter()) {
      const target = {
        sectionIdx: this.cursor.hfSectionIdx,
        isHeader: this.cursor.headerFooterMode === 'header',
        applyTo: this.cursor.hfApplyTo,
      };
      const paraIdx = this.cursor.hfParaIdx;
      this.insertTextAtRaw(anchor, composed);
      this.consumeRawTextMutationBeforeCursor();
      this.executeOperation({
        kind: 'record',
        command: new InsertTextInHeaderFooterCommand(target, paraIdx, anchor.charOffset, composed),
      });
      this.cursor.setHfCursorPosition(paraIdx, anchor.charOffset + scalarLength);
      this.afterEdit();
      committed = true;
    } else if (this.cursor.isInFootnote()) {
      const target = {
        sectionIdx: this.cursor.fnSectionIdx, paraIdx: this.cursor.fnParaIdx, controlIdx: this.cursor.fnControlIdx,
        footnoteIndex: this.cursor.fnFootnoteIndex, pageNum: this.cursor.fnPageNum,
      };
      const innerParaIdx = this.cursor.fnInnerParaIdx;
      this.insertTextAtRaw(anchor, composed);
      this.consumeRawTextMutationBeforeCursor();
      this.executeOperation({
        kind: 'record',
        command: new InsertTextInFootnoteCommand(target, innerParaIdx, anchor.charOffset, composed),
      });
      this.cursor.setFnCursorPosition(innerParaIdx, anchor.charOffset + scalarLength);
      this.afterEdit();
      committed = true;
    } else {
      const refreshClickHereGuide = this.isClickHereGuidePosition?.(anchor) === true;
      this.executeOperation({ kind: 'command', command: new InsertTextCommand(anchor, composed) });
      if (refreshClickHereGuide) this.refreshClickHereAfterFirstInput?.();
      committed = true;
    }
  }

  if (!committed) this.updateCaret();

  // 조합 종료 후 대기 중인 탐색 키 처리 (IME 조합 중 방향키 등)
  if (this._pendingNavAfterIME) {
    const nav = this._pendingNavAfterIME;
    this._pendingNavAfterIME = null;
    processPendingNav.call(this, nav);
  }
}

export function onInput(this: any, e?: InputEvent): void {
  if (!this.active) return;

  if (e && this.imeSession.consumeTrailingInput({
    inputType: e.inputType,
    data: e.data,
    isComposing: e.isComposing,
    value: this.unconsumedTextareaValue(),
  })) {
    this.consumeTextareaValue();
    return;
  }

  // 줄바꿈은 문단 분할 Command 로만 들어온다. textarea 의 기본 동작으로 값에 섞여 들어온
  // \r\n 을 그대로 삽입하면 문단 안에 리터럴 개행 문자가 박힌다.
  const text = (this.unconsumedTextareaValue() || e?.data || '').replace(/[\r\n]+/g, '');

  // 조합 중에는 문서를 변경하지 않고 transient preedit만 갱신한다.
  if (this.isComposing && this.compositionAnchor) {
    if (!this.canInsertTextInFormMode?.(this.compositionAnchor)) {
      this.resetTextareaBuffer();
      this.imeSession.reset();
      this.compositionAnchor = null;
      this.clearCompositionAnchorRect();
      this.compositionLength = 0;
      this.updateCaret();
      return;
    }
    const previous = this.imeSession.preedit;
    const preedit = this.imeSession.update(text);
    this.compositionLength = charCount(preedit);
    if (preedit !== previous) this.updateCompositionOverlay();
    return;
  }

  // iOS 폴백: composition 이벤트 없이 input만으로 한글 조합 처리
  // iOS contentEditable에서는 compositionStart/End가 발생하지 않는다.
  // div의 textContent를 건드리지 않고, 이전 상태와 비교하여 변경분만 처리.
  // iOS 폴백: iOS Safari/Chrome은 한글 조합을 compositionStart/End 없이
  // deleteContentBackward + insertText 쌍으로 처리한다.
  // div의 textContent(value)가 iOS에 의해 완벽하게 관리되므로,
  // 매 input마다 문서의 이전 삽입을 삭제하고 현재 value 전체로 교체한다.
  // 주의: afterEdit() 호출 시 document-changed 이벤트가 Canvas를 재렌더링하면서
  // div의 focus/textContent를 교란하므로, 렌더링은 디바운스하여 마지막에 한 번만 수행.
  if (this._isIOS && !this.isComposing) {
    // 앵커 설정 (첫 입력 시)
    if (!this._iosAnchor) {
      this._iosRequiresFullRefresh = false;
      this._iosBeforePageIndex = this.cursor.getRect()?.pageIndex;
      if (this.cursor.isInHeaderFooter()) {
        this._iosAnchor = { ...this.cursor.getPosition(), charOffset: this.cursor.hfCharOffset };
      } else if (this.cursor.isInFootnote()) {
        this._iosAnchor = { ...this.cursor.getPosition(), charOffset: this.cursor.fnCharOffset };
      } else {
        this._iosAnchor = this.prepareClickHereInputPosition?.() ?? this.cursor.getPosition();
      }
      this._iosLength = 0;
    }
    if (!this.canInsertTextInFormMode?.(this._iosAnchor)) {
      this.resetTextareaBuffer();
      return;
    }
    this.resetRawTextMutationEffects();

    this.replaceTextAtRaw(this._iosAnchor, this._iosLength, text);
    this._iosLength = charCount(text);

    const boundaryHandled = this.consumeRawTextMutationBeforeCursor();
    this._iosRequiresFullRefresh = this._iosRequiresFullRefresh || boundaryHandled;

    // 커서 이동 (렌더링 없이 문서만 갱신)
    const newOffset = this._iosAnchor.charOffset + charCount(text);
    if (this.cursor.isInHeaderFooter()) {
      this.cursor.setHfCursorPosition(this.cursor.hfParaIdx, newOffset);
    } else if (this.cursor.isInFootnote()) {
      this.cursor.setFnCursorPosition(this.cursor.fnInnerParaIdx, newOffset);
    } else {
      this.cursor.moveTo({ ...this._iosAnchor, charOffset: newOffset });
    }

    clearTimeout(this._iosInputTimer);
    const iosAnchor = this._iosAnchor;
    const iosAfterPos = this.cursor.getPosition();
    const beforePageIndex = this._iosBeforePageIndex;
    const afterPageIndex = this.cursor.getRect()?.pageIndex;
    const requiresFullRefresh = this._iosRequiresFullRefresh;
    this._iosRequiresFullRefresh = false;
    this.afterTextInputEdit(iosAnchor, iosAfterPos, {
      insertedText: text,
      beforePageIndex,
      afterPageIndex,
    }, requiresFullRefresh);
    this.textarea.focus();
    return;
  }

  // 일반 입력 (비조합) → Command로 실행
  if (!text) {
    // 개행만 들어온 경우 반영 완료로 표시해 다음 입력에 새지 않게 한다.
    this.consumeTextareaValue();
    return;
  }

  this.imeSession.clearPendingCommit();
  this.consumeTextareaValue();

  // 머리말/꼬리말 편집 모드
  if (this.cursor.isInHeaderFooter()) {
    const isHeader = this.cursor.headerFooterMode === 'header';
    try {
      const target = { sectionIdx: this.cursor.hfSectionIdx, isHeader, applyTo: this.cursor.hfApplyTo };
      const paraIdx = this.cursor.hfParaIdx;
      const charOffset = this.cursor.hfCharOffset;
      this.wasm.insertTextInHeaderFooter(target.sectionIdx, isHeader, target.applyTo, paraIdx, charOffset, text);
      // [Task #2337] 히스토리 기록 → 본문 스냅샷 undo 가 이 편집을 무언 파괴하지 않게 한다.
      this.executeOperation({ kind: 'record', command: new InsertTextInHeaderFooterCommand(target, paraIdx, charOffset, text) });
      this.cursor.setHfCursorPosition(paraIdx, charOffset + charCount(text));
      this.afterEdit();
    } catch (err) {
      console.error('[HF-input] insertTextInHeaderFooter 실패:', err);
    }
    return;
  }

  // 각주 편집 모드
  if (this.cursor.isInFootnote()) {
    try {
      const target = {
        sectionIdx: this.cursor.fnSectionIdx, paraIdx: this.cursor.fnParaIdx, controlIdx: this.cursor.fnControlIdx,
        footnoteIndex: this.cursor.fnFootnoteIndex, pageNum: this.cursor.fnPageNum,
      };
      const innerParaIdx = this.cursor.fnInnerParaIdx;
      const charOffset = this.cursor.fnCharOffset;
      this.wasm.insertTextInFootnote(target.sectionIdx, target.paraIdx, target.controlIdx, innerParaIdx, charOffset, text);
      this.executeOperation({ kind: 'record', command: new InsertTextInFootnoteCommand(target, innerParaIdx, charOffset, text) });
      this.cursor.setFnCursorPosition(innerParaIdx, charOffset + charCount(text));
      this.afterEdit();
    } catch (err) {
      console.error('[FN-input] insertTextInFootnote 실패:', err);
    }
    return;
  }

  // 선택 영역이 있으면 먼저 삭제
  let insertPos = this.prepareClickHereInputPosition?.() ?? this.cursor.getPosition();
  let refreshClickHereGuide = this.isClickHereGuidePosition?.(insertPos) === true;
  if (this.cursor.hasSelection()) {
    if (!this.canDeleteSelectionInFormMode?.()) {
      this.consumeTextareaValue();
      return;
    }
    this.deleteSelection();
    insertPos = this.prepareClickHereInputPosition?.() ?? this.cursor.getPosition();
    refreshClickHereGuide = this.isClickHereGuidePosition?.(insertPos) === true;
  }
  if (!this.canInsertTextInFormMode?.(insertPos)) {
    this.consumeTextareaValue();
    return;
  }
  this.executeOperation({ kind: 'command', command: new InsertTextCommand(insertPos, text) });
  if (refreshClickHereGuide) {
    this.refreshClickHereAfterFirstInput?.();
  }
}

export function insertTextAtRaw(this: any, pos: DocumentPosition, text: string): TextMutationEffects {
  if (!this.canInsertTextInFormMode?.(pos)) return NO_TEXT_MUTATION_EFFECTS;
  // 머리말/꼬리말 편집 모드
  if (this.cursor.isInHeaderFooter()) {
    const isHeader = this.cursor.headerFooterMode === 'header';
    this.wasm.insertTextInHeaderFooter(
      this.cursor.hfSectionIdx, isHeader, this.cursor.hfApplyTo,
      this.cursor.hfParaIdx, pos.charOffset, text,
    );
    return IMMEDIATE_TEXT_MUTATION_EFFECTS;
  }
  // 각주 편집 모드
  if (this.cursor.isInFootnote()) {
    this.wasm.insertTextInFootnote(
      this.cursor.fnSectionIdx, this.cursor.fnParaIdx, this.cursor.fnControlIdx,
      this.cursor.fnInnerParaIdx, pos.charOffset, text,
    );
    return IMMEDIATE_TEXT_MUTATION_EFFECTS;
  }
  return insertTextWithMutationEffects(this.wasm, pos, text);
}

export function replaceTextAtRaw(
  this: any,
  pos: DocumentPosition,
  deleteCount: number,
  text: string,
): TextMutationEffects {
  if (!this.canInsertTextInFormMode?.(pos)) return NO_TEXT_MUTATION_EFFECTS;
  if (deleteCount > 0 && !this.canDeleteTextInFormMode?.(pos, deleteCount)) {
    return NO_TEXT_MUTATION_EFFECTS;
  }
  if (
    !this.cursor.isInHeaderFooter() &&
    !this.cursor.isInFootnote() &&
    canUseDeferredCellTextReplace(pos, deleteCount, text)
  ) {
    return replaceCellTextWithMutationEffects(this.wasm, pos, deleteCount, text);
  }
  if (
    !this.cursor.isInHeaderFooter() &&
    !this.cursor.isInFootnote() &&
    canUseLocalBodyTextReplace(pos, deleteCount, text)
  ) {
    return replaceBodyTextWithMutationEffects(this.wasm, pos, deleteCount, text);
  }

  const effects = new TextMutationEffectAccumulator();
  if (deleteCount > 0) {
    effects.add(deleteTextAt.call(this, pos, deleteCount));
  }
  if (text.length > 0) {
    effects.add(insertTextAtRaw.call(this, pos, text));
  }
  return effects.consume();
}

export function deleteTextAt(this: any, pos: DocumentPosition, count: number): TextMutationEffects {
  if (!this.canDeleteTextInFormMode?.(pos, count)) return NO_TEXT_MUTATION_EFFECTS;
  // 머리말/꼬리말 편집 모드
  if (this.cursor.isInHeaderFooter()) {
    const isHeader = this.cursor.headerFooterMode === 'header';
    this.wasm.deleteTextInHeaderFooter(
      this.cursor.hfSectionIdx, isHeader, this.cursor.hfApplyTo,
      this.cursor.hfParaIdx, pos.charOffset, count,
    );
    return NO_TEXT_MUTATION_EFFECTS;
  }
  // 각주 편집 모드
  if (this.cursor.isInFootnote()) {
    this.wasm.deleteTextInFootnote(
      this.cursor.fnSectionIdx, this.cursor.fnParaIdx, this.cursor.fnControlIdx,
      this.cursor.fnInnerParaIdx, pos.charOffset, count,
    );
    return NO_TEXT_MUTATION_EFFECTS;
  }
  return deleteTextWithMutationEffects(this.wasm, pos, count);
}
