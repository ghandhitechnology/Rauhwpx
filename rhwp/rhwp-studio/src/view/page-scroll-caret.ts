export interface PageScrollCaretRect {
  pageIndex: number;
  x: number;
  y: number;
  height: number;
}

export interface PageScrollCaretCursor {
  isInHeaderFooter?: () => boolean;
  isInFootnote?: () => boolean;
  isInPictureObjectSelection?: () => boolean;
  isInTableObjectSelection?: () => boolean;
  isInBlockSelectionMode?: () => boolean;
  isInCellSelectionMode?: () => boolean;
  isInTextBox?: () => boolean;
  getRect?: () => PageScrollCaretRect | null | undefined;
}

/**
 * 화면과 함께 옮겨도 되는 캐럿이면 그 rect 를, 아니면 null 을 준다.
 * 글상자·머리말/꼬리말·각주·개체/셀 선택처럼 본문 hit-test 가 문맥을 바꾸면
 * PageUp/PageDown 은 화면만 옮긴다.
 */
export function caretRectForPageScroll(
  cursor: PageScrollCaretCursor | null | undefined,
  isFormMode = false,
): PageScrollCaretRect | null {
  if (isFormMode || !cursor) return null;
  if (cursor.isInHeaderFooter?.() || cursor.isInFootnote?.()) return null;
  if (cursor.isInPictureObjectSelection?.() || cursor.isInTableObjectSelection?.()) return null;
  if (cursor.isInBlockSelectionMode?.() || cursor.isInCellSelectionMode?.()) return null;
  if (cursor.isInTextBox?.()) return null;
  return cursor.getRect?.() ?? null;
}
