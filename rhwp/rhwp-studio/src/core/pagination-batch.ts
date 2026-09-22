interface PaginationBatchDocument {
  canBatchBodyText?: (sectionIdx: number) => boolean;
  beginBatch?: () => unknown;
  endBatch?: () => unknown;
}

const activeBatches = new WeakSet<PaginationBatchDocument>();

/** 동기 텍스트 편집 동안 페이지네이션만 모은다. 중첩 호출은 바깥 배치를 공유한다. */
export function withPaginationBatch<T>(document: PaginationBatchDocument, edit: () => T): T {
  if (activeBatches.has(document)
    || typeof document.beginBatch !== 'function'
    || typeof document.endBatch !== 'function') return edit();

  document.beginBatch();
  activeBatches.add(document);
  try {
    return edit();
  } finally {
    // endBatch 실패 뒤에도 다음 편집이 새 배치를 열 수 있도록 소유권부터 해제한다.
    activeBatches.delete(document);
    document.endBatch();
  }
}

/** 이전 WASM이나 다단 구역은 편집마다 줄 폭을 수렴시키는 기존 경로를 사용한다. */
export function withBodyTextPaginationBatch<T>(
  document: PaginationBatchDocument, sectionIdx: number, edit: () => T,
): T {
  if (document.canBatchBodyText?.(sectionIdx) !== true) return edit();
  return withPaginationBatch(document, edit);
}
