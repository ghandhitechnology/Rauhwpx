import {
  SAVE_FORMAT_DETAILS,
  type FilePickerType,
  type SaveFormat,
} from './save-format.ts';

export interface FileSystemWritableFileStreamLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

/** File System Access 권한 상태 (queryPermission/requestPermission 반환). */
export type FileSystemPermissionState = 'granted' | 'denied' | 'prompt';

export interface FileSystemFileHandleLike {
  kind?: 'file';
  name: string;
  /** Desktop opaque handles have canonical native-path identity in Electron main. */
  identityKind?: 'native-path';
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStreamLike>;
  validateSaveTarget?(): Promise<void>;
  /** Desktop Save As handles release their canonical path claim if writing fails. */
  releaseUnusedSaveTarget?(): Promise<void>;
  adoptSaveTarget?(): void;
  isSameEntry?(other: FileSystemFileHandleLike): Promise<boolean>;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemPermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemPermissionState>;
}

/** Drag & Drop API가 반환할 수 있는 file/directory handle의 공통 최소 형태. */
export type DroppedFileSystemHandleLike = FileSystemFileHandleLike | {
  kind: 'directory';
  name: string;
};

/** `getAsFileSystemHandle` 미포함 TypeScript DOM lib와도 호환하기 위한 좁은 item 타입. */
export interface DroppedDataTransferItemLike {
  kind: string;
  getAsFile(): File | null;
  getAsFileSystemHandle?(): Promise<DroppedFileSystemHandleLike | null>;
}

export interface SaveFilePickerOptionsLike {
  excludeAcceptAllOption?: boolean;
  suggestedName?: string;
  types?: FilePickerType[];
}

export interface FileSystemWindowLike {
  showOpenFilePicker?: (options?: {
    excludeAcceptAllOption?: boolean;
    multiple?: boolean;
    types?: FilePickerType[];
  }) => Promise<FileSystemFileHandleLike[]>;
  showSaveFilePicker?: (options?: SaveFilePickerOptionsLike) => Promise<FileSystemFileHandleLike>;
}

export interface FileHandleReadResult {
  name: string;
  bytes: Uint8Array;
}

export interface SaveDocumentOptions {
  blob: Blob;
  suggestedName: string;
  currentHandle: FileSystemFileHandleLike | null;
  windowLike: FileSystemWindowLike;
  /** [Task #833] true 시 currentHandle 무시 + 항상 showSaveFilePicker 호출 (다른 이름으로 저장). */
  forceSaveAs: boolean;
  /** 저장 picker와 확장자 검증을 결정하는 단일 출력 포맷. */
  saveFormat: SaveFormat;
  /** Desktop native Save As picker; undefined falls back to the browser picker. */
  pickSaveHandle?: (
    options: SaveFilePickerOptionsLike,
  ) => Promise<FileSystemFileHandleLike | null | undefined>;
  /** Cross-window ownership reservation acquired immediately before writing. */
  validateTarget?: (
    handle: FileSystemFileHandleLike,
  ) => Promise<((saved: boolean) => Promise<void>) | void>;
}

export interface SaveDocumentResult {
  method: 'current-handle' | 'save-picker' | 'fallback';
  handle: FileSystemFileHandleLike | null;
  fileName: string;
}

export const HWP_DOCUMENT_ACCEPT: Record<string, string[]> = {
  'application/x-hwp': ['.hwp'],
  'application/hwp+zip': ['.hwpx'],
  'application/xml': ['.hml'],
  'text/xml': ['.hml'],
};

const HWP_OPEN_PICKER_TYPES: FilePickerType[] = [{
  description: 'HWP/HWPX/HML 문서',
  accept: HWP_DOCUMENT_ACCEPT,
}];

function pickerTypesForFormat(format: SaveFormat): FilePickerType[] {
  return [SAVE_FORMAT_DETAILS[format].pickerType];
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function isSupportedDocumentFileName(fileName: string): boolean {
  return /\.(hwp|hwpx|hml)$/i.test(fileName.trim());
}

export function canUseOpenFilePicker(windowLike: FileSystemWindowLike): boolean {
  return typeof windowLike.showOpenFilePicker === 'function';
}

function isSameDroppedFile(candidate: File, selected: File): boolean {
  return candidate === selected
    || (
      candidate.name === selected.name
      && candidate.size === selected.size
      && candidate.lastModified === selected.lastModified
      && candidate.type === selected.type
    );
}

function isDroppedFileHandle(handle: DroppedFileSystemHandleLike | null): handle is FileSystemFileHandleLike {
  if (!handle || handle.kind !== 'file') return false;
  const candidate = handle as Partial<FileSystemFileHandleLike>;
  return typeof candidate.name === 'string'
    && typeof candidate.getFile === 'function'
    && typeof candidate.createWritable === 'function';
}

/**
 * Finder/Explorer drop의 선택 파일 handle을 **동기적으로** capture한다.
 *
 * Chromium의 `DataTransferItem.getAsFileSystemHandle()`은 drop event와 같은 tick에서
 * 호출해야 한다. 이 함수는 파일 bytes를 읽거나 handle을 저장하지 않고 Promise만 즉시
 * 시작한다. 호출자는 사용자 확인 뒤에만 결과를 await하여 문서를 열어야 한다 (#3259).
 */
export function captureDroppedFileHandle(
  items: ArrayLike<DroppedDataTransferItemLike> | null | undefined,
  selectedFile: File,
): Promise<FileSystemFileHandleLike | null> {
  if (!items) return Promise.resolve(null);

  let matchedItem: DroppedDataTransferItemLike | undefined;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== 'file') continue;
    try {
      const candidate = item.getAsFile();
      if (candidate && isSameDroppedFile(candidate, selectedFile)) {
        matchedItem = item;
        break;
      }
    } catch {
      // 다음 item을 확인하거나 API 미지원 fallback으로 종료한다.
    }
  }
  if (!matchedItem || typeof matchedItem.getAsFileSystemHandle !== 'function') {
    return Promise.resolve(null);
  }

  let handlePromise: Promise<DroppedFileSystemHandleLike | null>;
  try {
    // 반드시 caller가 await하기 전에 실행된다. 여기서 비동기 경계를 만들면 안 된다.
    handlePromise = matchedItem.getAsFileSystemHandle();
  } catch {
    return Promise.resolve(null);
  }

  return handlePromise.then(
    (handle) => {
      if (!isDroppedFileHandle(handle) || handle.name !== selectedFile.name) return null;
      return handle;
    },
    () => null,
  );
}

async function writeBlobToHandle(
  handle: FileSystemFileHandleLike,
  blob: Blob,
  validateTarget?: SaveDocumentOptions['validateTarget'],
): Promise<void> {
  let release: ((saved: boolean) => Promise<void>) | void = undefined;
  let saved = false;
  try {
    release = await validateTarget?.(handle);
    await handle.validateSaveTarget?.();
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    saved = true;
    handle.adoptSaveTarget?.();
  } finally {
    await release?.(saved);
    if (!saved) await handle.releaseUnusedSaveTarget?.();
  }
}

function expectedSaveExtension(saveFormat: SaveFormat): '.hml' | '.hwp' | '.hwpx' {
  return SAVE_FORMAT_DETAILS[saveFormat].extension;
}

async function assertValidSaveHandle(
  handle: FileSystemFileHandleLike,
  expectedExtension: '.hml' | '.hwp' | '.hwpx',
  originalHandle: FileSystemFileHandleLike | null,
): Promise<void> {
  if (originalHandle) {
    let isOriginal = handle === originalHandle;
    if (!isOriginal && handle.isSameEntry) {
      try {
        isOriginal = await handle.isSameEntry(originalHandle);
      } catch {
        throw new Error('HML 원본과 저장 대상이 다른 파일인지 확인할 수 없습니다. 네이티브 파일 열기로 원본을 다시 여세요.');
      }
    }
    if (isOriginal) {
      throw new Error('HML 원본 파일은 저장 대상으로 선택할 수 없습니다.');
    }
  }

  if (!handle.name.toLowerCase().endsWith(expectedExtension)) {
    throw new Error(`${expectedExtension} 확장자를 가진 파일을 선택해야 합니다.`);
  }
}

export async function pickOpenFileHandle(windowLike: FileSystemWindowLike): Promise<FileSystemFileHandleLike | null> {
  if (!canUseOpenFilePicker(windowLike)) return null;

  try {
    const handles = await windowLike.showOpenFilePicker!({
      excludeAcceptAllOption: true,
      multiple: false,
      types: HWP_OPEN_PICKER_TYPES,
    });
    return handles[0] ?? null;
  } catch (error) {
    if (isAbortError(error)) return null;
    throw error;
  }
}

export async function readFileFromHandle(handle: FileSystemFileHandleLike): Promise<FileHandleReadResult> {
  const file = await handle.getFile();
  return {
    name: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

export async function saveDocumentToFileSystem(options: SaveDocumentOptions): Promise<SaveDocumentResult> {
  const {
    blob,
    suggestedName,
    currentHandle,
    windowLike,
    forceSaveAs,
    saveFormat,
    pickSaveHandle,
    validateTarget,
  } = options;

  // 저장 picker 형식을 출력 포맷에 맞춘다 (HML/HWP/HWPX).
  const pickerTypes = pickerTypesForFormat(saveFormat);

  // [Task #833] forceSaveAs 시 currentHandle 우회 → 항상 picker (다른 이름으로 저장).
  if (currentHandle && !forceSaveAs) {
    await assertValidSaveHandle(
      currentHandle,
      expectedSaveExtension(saveFormat),
      null,
    );
    await writeBlobToHandle(currentHandle, blob, validateTarget);
    return {
      method: 'current-handle',
      handle: currentHandle,
      fileName: currentHandle.name,
    };
  }

  const pickerOptions = {
    excludeAcceptAllOption: true,
    suggestedName,
    types: pickerTypes,
  };
  let handle = await pickSaveHandle?.(pickerOptions);
  if (handle === null) throw new DOMException('Save cancelled', 'AbortError');
  if (!handle && windowLike.showSaveFilePicker) {
    handle = await windowLike.showSaveFilePicker(pickerOptions);
  }
  if (handle) {
    try {
      await assertValidSaveHandle(
        handle,
        expectedSaveExtension(saveFormat),
        forceSaveAs ? currentHandle : null,
      );
      await writeBlobToHandle(handle, blob, validateTarget);
      return {
        method: 'save-picker',
        handle,
        fileName: handle.name,
      };
    } catch (error) {
      await handle.releaseUnusedSaveTarget?.();
      throw error;
    }
  }

  return {
    method: 'fallback',
    handle: null,
    fileName: suggestedName,
  };
}
