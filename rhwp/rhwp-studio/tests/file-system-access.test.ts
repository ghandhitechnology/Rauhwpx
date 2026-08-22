import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HWP_DOCUMENT_ACCEPT,
  canUseOpenFilePicker,
  captureDroppedFileHandle,
  isSupportedDocumentFileName,
  pickOpenFileHandle,
  readFileFromHandle,
  saveDocumentToFileSystem,
} from '../src/command/file-system-access.ts';

type FakeWriteCall = Blob;

interface FakeWritable {
  writes: FakeWriteCall[];
  closed: boolean;
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

function createWritable(): FakeWritable {
  return {
    writes: [],
    closed: false,
    async write(data: Blob) {
      this.writes.push(data);
    },
    async close() {
      this.closed = true;
    },
  };
}

function createHandle(name: string, fileContent = 'fixture') {
  const writable = createWritable();
  return {
    kind: 'file' as const,
    name,
    writable,
    async getFile() {
      return new File([fileContent], name, { type: 'application/x-hwp' });
    },
    async createWritable() {
      return writable;
    },
  };
}

test('isSupportedDocumentFileName은 HWP/HWPX/HML 확장자를 허용한다', () => {
  assert.equal(isSupportedDocumentFileName('sample.hwp'), true);
  assert.equal(isSupportedDocumentFileName('sample.HWPX'), true);
  assert.equal(isSupportedDocumentFileName('sample.HML'), true);
  assert.equal(isSupportedDocumentFileName(' sample.hwpx '), true);
  assert.equal(isSupportedDocumentFileName('sample.txt'), false);
  assert.equal(isSupportedDocumentFileName('sample.hwp.exe'), false);
  assert.equal(isSupportedDocumentFileName('sample'), false);
});

test('HWP_DOCUMENT_ACCEPT는 넓은 binary MIME을 등록하지 않는다', () => {
  assert.deepEqual(HWP_DOCUMENT_ACCEPT, {
    'application/x-hwp': ['.hwp'],
    'application/hwp+zip': ['.hwpx'],
    'application/xml': ['.hml'],
    'text/xml': ['.hml'],
  });
  assert.equal(Object.hasOwn(HWP_DOCUMENT_ACCEPT, 'application/octet-stream'), false);
  assert.equal(Object.hasOwn(HWP_DOCUMENT_ACCEPT, '*/*'), false);
});

test('canUseOpenFilePicker는 native open picker 지원 여부를 구분한다', () => {
  assert.equal(canUseOpenFilePicker({}), false);
  assert.equal(canUseOpenFilePicker({ showOpenFilePicker: async () => [] }), true);
});

test('pickOpenFileHandle는 showOpenFilePicker가 있으면 첫 handle을 반환한다', async () => {
  const handle = createHandle('opened.hwp');
  let receivedOptions: Record<string, unknown> | undefined;

  const result = await pickOpenFileHandle({
    showOpenFilePicker: async (options) => {
      receivedOptions = options as Record<string, unknown>;
      return [handle];
    },
  });

  assert.equal(result, handle);
  assert.ok(receivedOptions);
});

test('pickOpenFileHandle는 native picker 취소 시 null을 반환한다', async () => {
  const result = await pickOpenFileHandle({
    showOpenFilePicker: async () => {
      throw new DOMException('cancelled', 'AbortError');
    },
  });

  assert.equal(result, null);
});

test('readFileFromHandle은 handle 파일 내용을 Uint8Array로 읽는다', async () => {
  const handle = createHandle('opened.hwp', 'abc');

  const result = await readFileFromHandle(handle);

  assert.equal(result.name, 'opened.hwp');
  assert.deepEqual(Array.from(result.bytes), [97, 98, 99]);
});

test('드롭 파일 handle은 확인 대화상자 await 전에 같은 tick에서 capture한다', async () => {
  const file = new File(['dropped'], 'dropped.hwp', {
    type: 'application/x-hwp',
    lastModified: 123,
  });
  const handle = createHandle('dropped.hwp');
  let captureCalls = 0;
  const pending = captureDroppedFileHandle([{
    kind: 'file',
    getAsFile: () => file,
    getAsFileSystemHandle: () => {
      captureCalls += 1;
      return Promise.resolve(handle);
    },
  }], file);

  assert.equal(captureCalls, 1, 'drop handler의 같은 tick에서 handle Promise를 시작해야 한다');
  assert.equal(await pending, handle);
});

test('드롭 handle API 미지원·오류·directory는 기존 null fallback을 쓴다', async () => {
  const file = new File(['dropped'], 'dropped.hwp', { type: 'application/x-hwp' });
  const unsupported = await captureDroppedFileHandle([{
    kind: 'file',
    getAsFile: () => file,
  }], file);
  assert.equal(unsupported, null);

  const rejected = await captureDroppedFileHandle([{
    kind: 'file',
    getAsFile: () => file,
    getAsFileSystemHandle: async () => {
      throw new DOMException('unavailable', 'SecurityError');
    },
  }], file);
  assert.equal(rejected, null);

  const directory = await captureDroppedFileHandle([{
    kind: 'file',
    getAsFile: () => file,
    getAsFileSystemHandle: async () => ({ kind: 'directory', name: 'folder' }),
  }], file);
  assert.equal(directory, null);
});

test('선택한 파일과 일치하지 않는 드롭 item은 handle을 capture하지 않는다', async () => {
  const selected = new File(['selected'], 'selected.hwp', { type: 'application/x-hwp' });
  const other = new File(['other'], 'other.hwp', { type: 'application/x-hwp' });
  let captureCalls = 0;

  const result = await captureDroppedFileHandle([{
    kind: 'file',
    getAsFile: () => other,
    getAsFileSystemHandle: async () => {
      captureCalls += 1;
      return createHandle('other.hwp');
    },
  }], selected);

  assert.equal(result, null);
  assert.equal(captureCalls, 0);
});

test('saveDocumentToFileSystem은 current handle이 있으면 picker 없이 같은 파일에 저장한다', async () => {
  const currentHandle = createHandle('opened.hwp');
  let pickerCalled = false;
  const blob = new Blob(['saved'], { type: 'application/x-hwp' });

  const result = await saveDocumentToFileSystem({
    blob,
    suggestedName: 'opened.hwp',
    currentHandle,
    forceSaveAs: false,
    saveFormat: 'hwp',
    windowLike: {
      showSaveFilePicker: async () => {
        pickerCalled = true;
        return createHandle('picker.hwp');
      },
    },
  });

  assert.equal(result.method, 'current-handle');
  assert.equal(result.handle, currentHandle);
  assert.equal(result.fileName, 'opened.hwp');
  assert.equal(pickerCalled, false);
  assert.equal(currentHandle.writable.writes.length, 1);
  assert.equal(currentHandle.writable.closed, true);
});

test('save target ownership validation runs before creating the writable stream', async () => {
  const calls: string[] = [];
  const handle = {
    ...createHandle('owned.hwp'),
    async validateSaveTarget() {
      calls.push('validate');
    },
    async createWritable() {
      calls.push('create-writable');
      return createWritable();
    },
  };

  await saveDocumentToFileSystem({
    blob: new Blob(['saved']),
    suggestedName: 'owned.hwp',
    currentHandle: handle,
    forceSaveAs: false,
    saveFormat: 'hwp',
    windowLike: {},
  });
  assert.deepEqual(calls, ['validate', 'create-writable']);
});

test('cross-window save reservation wraps the entire write and releases afterward', async () => {
  const calls: string[] = [];
  const handle = {
    ...createHandle('reserved.hwp'),
    async validateSaveTarget() {
      calls.push('native-validate');
    },
    async createWritable() {
      calls.push('create-writable');
      return createWritable();
    },
  };

  await saveDocumentToFileSystem({
    blob: new Blob(['saved']),
    suggestedName: 'reserved.hwp',
    currentHandle: handle,
    forceSaveAs: false,
    saveFormat: 'hwp',
    windowLike: {},
    async validateTarget(candidate) {
      assert.equal(candidate, handle);
      calls.push('reserve');
      return async () => { calls.push('release'); };
    },
  });

  assert.deepEqual(calls, ['reserve', 'native-validate', 'create-writable', 'release']);
});

test('current handle 확장자가 출력 포맷과 다르면 쓰기 전에 거부한다', async () => {
  const mismatchedHandle = createHandle('opened.hwp');
  const blob = new Blob(['saved'], { type: 'application/hwp+zip' });

  await assert.rejects(
    saveDocumentToFileSystem({
      blob,
      suggestedName: 'opened.hwpx',
      currentHandle: mismatchedHandle,
      forceSaveAs: false,
      saveFormat: 'hwpx',
      windowLike: {},
    }),
    /\.hwpx/,
  );

  assert.equal(mismatchedHandle.writable.writes.length, 0);
  assert.equal(mismatchedHandle.writable.closed, false);
});

test('saveDocumentToFileSystem은 current handle이 없으면 save picker를 사용한다', async () => {
  const pickerHandle = createHandle('picked.hwp');
  const blob = new Blob(['saved'], { type: 'application/x-hwp' });

  const result = await saveDocumentToFileSystem({
    blob,
    suggestedName: 'new-doc.hwp',
    currentHandle: null,
    forceSaveAs: false,
    saveFormat: 'hwp',
    windowLike: {
      showSaveFilePicker: async (options) => {
        assert.equal(options?.suggestedName, 'new-doc.hwp');
        assert.equal(options?.excludeAcceptAllOption, true);
        assert.deepEqual(options?.types, [{
          description: 'HWP 5.0 문서',
          accept: { 'application/x-hwp': ['.hwp'] },
        }]);
        return pickerHandle;
      },
    },
  });

  assert.equal(result.method, 'save-picker');
  assert.equal(result.handle, pickerHandle);
  assert.equal(result.fileName, 'picked.hwp');
  assert.equal(pickerHandle.writable.writes.length, 1);
  assert.equal(pickerHandle.writable.closed, true);
});

test('desktop Save As picker takes precedence and adopts its opaque target after success', async () => {
  const target = createHandle('desktop.hwp');
  const calls: string[] = [];
  const nativeTarget = {
    ...target,
    adoptSaveTarget() { calls.push('adopt'); },
    async releaseUnusedSaveTarget() { calls.push('release'); },
  };
  const result = await saveDocumentToFileSystem({
    blob: new Blob(['saved']),
    suggestedName: 'desktop.hwp',
    currentHandle: null,
    forceSaveAs: true,
    saveFormat: 'hwp',
    windowLike: {
      showSaveFilePicker: async () => { throw new Error('browser picker should not run'); },
    },
    pickSaveHandle: async () => nativeTarget,
    validateTarget: async () => async (saved) => { calls.push(`ownership:${saved}`); },
  });

  assert.equal(result.handle, nativeTarget);
  assert.deepEqual(calls, ['adopt', 'ownership:true']);
});

test('HML Save As fails closed when browser and native handles cannot be compared', async () => {
  const original = createHandle('original.hml');
  const target = {
    ...createHandle('converted.hml'),
    async isSameEntry() {
      throw new DOMException('cross-kind', 'NotSupportedError');
    },
  };
  await assert.rejects(
    saveDocumentToFileSystem({
      blob: new Blob(['saved']),
      suggestedName: 'converted.hml',
      currentHandle: original,
      forceSaveAs: true,
      saveFormat: 'hml',
      windowLike: {},
      pickSaveHandle: async () => target,
    }),
    /확인할 수 없습니다/,
  );
  assert.equal(target.writable.writes.length, 0);
});

test('forceSaveAs는 HML 원본 handle을 건드리지 않고 save picker를 사용한다', async () => {
  const originalHandle = createHandle('original.hml');
  const pickerHandle = createHandle('converted.hwp');
  const blob = new Blob(['saved'], { type: 'application/x-hwp' });

  const result = await saveDocumentToFileSystem({
    blob,
    suggestedName: 'original.hwp',
    currentHandle: originalHandle,
    forceSaveAs: true,
    saveFormat: 'hwp',
    windowLike: {
      showSaveFilePicker: async (options) => {
        assert.equal(options?.suggestedName, 'original.hwp');
        return pickerHandle;
      },
    },
  });

  assert.equal(result.method, 'save-picker');
  assert.equal(result.handle, pickerHandle);
  assert.equal(originalHandle.writable.writes.length, 0);
  assert.equal(pickerHandle.writable.writes.length, 1);
});

test('forceSaveAs picker에서 HML 원본을 다시 선택해도 원본에 쓰지 않는다', async () => {
  const originalHandle = createHandle('original.hml');
  const blob = new Blob(['saved'], { type: 'application/x-hwp' });

  await assert.rejects(
    saveDocumentToFileSystem({
      blob,
      suggestedName: 'original.hwp',
      currentHandle: originalHandle,
      forceSaveAs: true,
      saveFormat: 'hwp',
      windowLike: {
        showSaveFilePicker: async () => originalHandle,
      },
    }),
    /HML 원본/,
  );

  assert.equal(originalHandle.writable.writes.length, 0);
  assert.equal(originalHandle.writable.closed, false);
});

test('HML 원본 이름이 .hwp여도 같은 handle을 변환 저장 대상으로 쓸 수 없다', async () => {
  const misleadingOriginal = createHandle('misleading.hwp');
  const blob = new Blob(['saved'], { type: 'application/x-hwp' });

  await assert.rejects(
    saveDocumentToFileSystem({
      blob,
      suggestedName: 'misleading.hwp',
      currentHandle: misleadingOriginal,
      forceSaveAs: true,
      saveFormat: 'hwp',
      windowLike: {
        showSaveFilePicker: async () => misleadingOriginal,
      },
    }),
    /HML 원본/,
  );

  assert.equal(misleadingOriginal.writable.writes.length, 0);
});

test('HML을 HWPX로 선택하면 새 .hwpx handle에만 저장한다', async () => {
  const originalHandle = createHandle('original.hml');
  const convertedHandle = createHandle('converted.hwpx');
  const blob = new Blob(['saved'], { type: 'application/hwp+zip' });

  const result = await saveDocumentToFileSystem({
    blob,
    suggestedName: 'original.hwpx',
    currentHandle: originalHandle,
    forceSaveAs: true,
    saveFormat: 'hwpx',
    windowLike: {
      showSaveFilePicker: async (options) => {
        assert.deepEqual(options?.types, [{
          description: 'HWPX 문서 (권장)',
          accept: { 'application/hwp+zip': ['.hwpx'] },
        }]);
        return convertedHandle;
      },
    },
  });

  assert.equal(result.handle, convertedHandle);
  assert.equal(originalHandle.writable.writes.length, 0);
  assert.equal(convertedHandle.writable.writes.length, 1);
});

test('picker가 새 wrapper로 같은 HML 원본 entry를 반환해도 쓰지 않는다', async () => {
  const originalHandle = createHandle('original.hml');
  const reselectedHandle = {
    ...createHandle('original.hwp'),
    async isSameEntry(other: unknown) {
      return other === originalHandle;
    },
  };
  const blob = new Blob(['saved'], { type: 'application/x-hwp' });

  await assert.rejects(
    saveDocumentToFileSystem({
      blob,
      suggestedName: 'original.hwp',
      currentHandle: originalHandle,
      forceSaveAs: true,
      saveFormat: 'hwp',
      windowLike: {
        showSaveFilePicker: async () => reselectedHandle,
      },
    }),
    /HML 원본/,
  );

  assert.equal(reselectedHandle.writable.writes.length, 0);
  assert.equal(reselectedHandle.writable.closed, false);
});

test('save picker가 출력 포맷과 다른 확장자를 반환하면 쓰기 전에 거부한다', async () => {
  const invalidHandle = createHandle('converted.txt');
  const blob = new Blob(['saved'], { type: 'application/hwp+zip' });

  await assert.rejects(
    saveDocumentToFileSystem({
      blob,
      suggestedName: 'converted.hwpx',
      currentHandle: null,
      forceSaveAs: false,
      saveFormat: 'hwpx',
      windowLike: {
        showSaveFilePicker: async () => invalidHandle,
      },
    }),
    /\.hwpx/,
  );

  assert.equal(invalidHandle.writable.writes.length, 0);
  assert.equal(invalidHandle.writable.closed, false);
});

test('save ownership/write errors do not silently become downloads', () => {
  const commands = readFileSync(new URL('../src/command/commands/file.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(commands, /File System Access API 실패, 폴백/);
  assert.match(
    commands,
    /if \(isUserCancelError\(error\)\) return 'cancelled';\s+throw error;/,
  );
});

test('write failure aborts the browser swap stream', async () => {
  const calls: string[] = [];
  const failure = new Error('disk full');
  const handle = {
    ...createHandle('opened.hwp'),
    async createWritable() {
      return {
        async write() {
          calls.push('write');
          throw failure;
        },
        async close() {
          calls.push('close');
        },
        async abort(reason?: unknown) {
          assert.equal(reason, failure);
          calls.push('abort');
        },
      };
    },
  };

  await assert.rejects(
    saveDocumentToFileSystem({
      blob: new Blob(['saved']),
      suggestedName: 'opened.hwp',
      currentHandle: handle,
      forceSaveAs: false,
      saveFormat: 'hwp',
      windowLike: {},
    }),
    /disk full/,
  );
  assert.deepEqual(calls, ['write', 'abort']);
});

test('HML로 저장을 선택하면 HML 저장 picker 형식(.hml)을 사용한다', async () => {
  const pickerHandle = createHandle('converted.hml');
  const blob = new Blob(['saved'], { type: 'application/xml' });

  const result = await saveDocumentToFileSystem({
    blob,
    suggestedName: 'original.hml',
    currentHandle: null,
    forceSaveAs: false,
    saveFormat: 'hml',
    windowLike: {
      showSaveFilePicker: async (options) => {
        assert.deepEqual(options?.types, [{
          description: 'HML 문서',
          accept: { 'application/xml': ['.hml'] },
        }]);
        return pickerHandle;
      },
    },
  });

  assert.equal(result.handle, pickerHandle);
  assert.equal(pickerHandle.writable.writes.length, 1);
});
