import { SAVE_FORMAT_DETAILS, type SaveFormat } from './save-format.ts';

export type { SaveFormat } from './save-format.ts';

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

function saveFormatForFileName(fileName: string): SaveFormat | null {
  const normalized = fileName.trim().toLowerCase();
  if (normalized.endsWith('.hml')) return 'hml';
  if (normalized.endsWith('.hwpx')) return 'hwpx';
  if (normalized.endsWith('.hwp')) return 'hwp';
  return null;
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
  const currentFormat = saveFormatForFileName(currentTarget);
  const format: SaveFormat = currentFormat
    ?? (sourceFormat === 'hwpx' ? 'hwpx' : 'hwp');

  return {
    format,
    forceSaveAs: false,
    suggestedName: fileNameForFormat(fileName, format),
  };
}
