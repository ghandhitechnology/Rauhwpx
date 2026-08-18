import type { SaveFormat } from './save-format.ts';
import { detectDocumentByteKind } from '../core/document-signature.ts';

export interface DocumentFormatExporter {
  exportHml(): Uint8Array;
  exportHwp(): Uint8Array;
  exportHwpx(): Uint8Array;
}

export function exportDocumentForFormat(
  exporter: DocumentFormatExporter,
  format: SaveFormat,
): Uint8Array {
  const bytes = format === 'hml'
    ? exporter.exportHml()
    : format === 'hwpx'
      ? exporter.exportHwpx()
      : exporter.exportHwp();
  const actual = detectDocumentByteKind(bytes);
  if (actual !== format) {
    throw new Error(
      `${format.toUpperCase()} 내보내기가 올바르지 않은 파일 형식(${actual})을 반환했습니다. 기존 파일은 변경하지 않았습니다.`,
    );
  }
  return bytes;
}
