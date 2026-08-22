/** 새 문서·이름 없는 내보내기의 기본 저장 형식. 열린 .hwp 원본은 이 값을 쓰지 않는다. */
export const DEFAULT_EXPORT_FORMAT = 'hwpx' as const;

export const NEW_DOCUMENT_FILE_NAME = `새 문서.${DEFAULT_EXPORT_FORMAT}`;
export const FALLBACK_DOCUMENT_FILE_NAME = `document.${DEFAULT_EXPORT_FORMAT}`;

const UNTITLED_NEW_DOCUMENT_NAMES = new Set([
  NEW_DOCUMENT_FILE_NAME.toLowerCase(),
  '새 문서.hwp',
]);

/** 아직 경로가 없는 새 문서(현재·이전 HWP 기본 이름 포함). */
export function isUntitledNewDocumentName(fileName: string): boolean {
  return UNTITLED_NEW_DOCUMENT_NAMES.has(fileName.trim().toLowerCase());
}
