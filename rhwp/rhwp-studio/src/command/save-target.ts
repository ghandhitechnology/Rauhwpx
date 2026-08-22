import {
  DEFAULT_EXPORT_FORMAT,
  NEW_DOCUMENT_FILE_NAME,
  isUntitledNewDocumentName,
} from '../core/document-names.ts';
import { isFormPackDocument, refuseBinaryHwpExport } from '../core/form-pack.ts';
import { SAVE_FORMAT_DETAILS, type SaveFormat } from './save-format.ts';

export type { SaveFormat } from './save-format.ts';
export {
  DEFAULT_EXPORT_FORMAT,
  FALLBACK_DOCUMENT_FILE_NAME,
  NEW_DOCUMENT_FILE_NAME,
  isUntitledNewDocumentName,
} from '../core/document-names.ts';

export interface SaveTarget {
  format: SaveFormat;
  forceSaveAs: boolean;
  suggestedName: string;
}

export interface NamedSaveHandle {
  name: string;
}

const convertedHmlSaveHandles = new WeakSet<object>();

export function markConvertedHmlSaveHandle(handle: NamedSaveHandle | null): void {
  if (handle) convertedHmlSaveHandles.add(handle);
}

export function forgetConvertedHmlSaveHandle(handle: NamedSaveHandle | null): void {
  if (handle) convertedHmlSaveHandles.delete(handle);
}

export function saveFormatForFileName(fileName: string): SaveFormat | null {
  const normalized = fileName.trim().toLowerCase();
  if (normalized.endsWith('.hml')) return 'hml';
  if (normalized.endsWith('.hwpx')) return 'hwpx';
  if (normalized.endsWith('.hwp')) return 'hwp';
  return null;
}

/** 확장자가 없을 때: 열린 바이너리 HWP만 HWP, 그 외(새 문서·HWPX·모름)는 HWPX. */
export function defaultFormatForSource(sourceFormat: string): SaveFormat {
  const source = sourceFormat.trim().toLowerCase();
  if (source === 'hwp') return 'hwp';
  if (source === 'hml') return 'hml';
  return DEFAULT_EXPORT_FORMAT;
}

/**
 * Save/Save As/다운로드가 쓰는 형식. 파일명 확장자 > 명시 형식 > 새 문서 HWPX >
 * 열린 HWP 원본 > HWPX.
 */
export function inferExportFormat(
  sourceFormat: string,
  requestedName = '',
  explicitFormat?: string | null,
  currentDocumentName?: string | null,
): SaveFormat {
  const explicit = explicitFormat?.trim().toLowerCase();
  if (explicit === 'hml' || explicit === 'hwp' || explicit === 'hwpx') {
    if (explicit === 'hwp' && refuseBinaryHwpExport('hwp', requestedName || currentDocumentName || '')) {
      return DEFAULT_EXPORT_FORMAT;
    }
    return explicit;
  }
  if (isFormPackDocument(requestedName || currentDocumentName || '')) {
    return DEFAULT_EXPORT_FORMAT;
  }
  if (isUntitledNewDocumentName(requestedName)) return DEFAULT_EXPORT_FORMAT;
  const requestedFormat = saveFormatForFileName(requestedName);
  if (requestedFormat) return requestedFormat;
  if (isUntitledNewDocumentName(currentDocumentName ?? '')) return DEFAULT_EXPORT_FORMAT;
  return resolveSaveTarget(sourceFormat, requestedName || currentDocumentName || '').format;
}

export function fileNameForFormat(fileName: string, format: SaveFormat): string {
  const extension = SAVE_FORMAT_DETAILS[format].extension;
  const trimmed = fileName.trim() || `document${extension}`;
  if (/\.(hwp|hwpx|hml)$/i.test(trimmed)) {
    return trimmed.replace(/\.(hwp|hwpx|hml)$/i, extension);
  }
  return `${trimmed}${extension}`;
}

export function requiresSaveFormatChoice(target: SaveTarget, hmlEnabled: boolean): boolean {
  return target.forceSaveAs || (target.format === 'hml' && !hmlEnabled);
}

export function resolveSaveTarget(
  sourceFormat: string,
  fileName: string,
  currentHandle?: NamedSaveHandle | null,
): SaveTarget {
  const hasConvertedHmlTarget = sourceFormat === 'hml'
    && currentHandle != null
    && convertedHmlSaveHandles.has(currentHandle);

  if (sourceFormat === 'hml' && !hasConvertedHmlTarget) {
    return {
      format: 'hml',
      forceSaveAs: true,
      suggestedName: fileNameForFormat(fileName, 'hml'),
    };
  }

  // Once a document has been saved under another format, its current handle/name is
  // the durable target contract. `sourceFormat` deliberately continues to describe
  // the parser provenance (the HWP exporter needs that to run its HWPX adapter), so
  // using it here would make Ctrl+S switch back to the original format. That
  // previously made HWPX -> Save As HWP fail on the next handle-backed save or
  // unexpectedly change the extension again in fallback download mode.
  const currentTarget = currentHandle?.name ?? fileName;
  if (isUntitledNewDocumentName(currentTarget) || isUntitledNewDocumentName(fileName)) {
    return {
      format: DEFAULT_EXPORT_FORMAT,
      forceSaveAs: false,
      suggestedName: fileNameForFormat(fileName || NEW_DOCUMENT_FILE_NAME, DEFAULT_EXPORT_FORMAT),
    };
  }

  if (isFormPackDocument(fileName) || isFormPackDocument(currentTarget)) {
    return {
      format: DEFAULT_EXPORT_FORMAT,
      forceSaveAs: false,
      suggestedName: fileNameForFormat(fileName, DEFAULT_EXPORT_FORMAT),
    };
  }

  const currentFormat = saveFormatForFileName(currentTarget);
  const format: SaveFormat = currentFormat ?? defaultFormatForSource(sourceFormat);

  return {
    format,
    forceSaveAs: false,
    suggestedName: fileNameForFormat(fileName, format),
  };
}
