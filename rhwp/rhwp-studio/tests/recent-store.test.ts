import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  addRecentDoc,
  clearRecentDocs,
  listRecentDocs,
  removeRecentDoc,
} from '../src/recent/recent-store.ts';
import type { FileSystemFileHandleLike } from '../src/command/file-system-access.ts';

/**
 * PR #2286 리뷰 회귀 테스트 (#2285 범위 + 메타-only 확장):
 * - 핸들 있으면 라이브 재열기용 저장, 없으면 메타-only 기록 (바이트 미보관)
 * - 동일 파일 판정은 isSameEntry 권위 (같은 파일명·다른 파일 공존)
 * - 핸들 비교가 불가능할 때만 sourceDigest로 논리 documentId 복원 (파일명 미사용)
 * - 최대 8개 상한, 목록 지우기
 * node 환경(IndexedDB 없음)이라 메모리 폴백 경로를 검증한다 — 스토어 로직은
 * withDb 양쪽 분기에 동일 규칙으로 구현되어 있다.
 */

/** isSameEntry가 참조 동일성으로 동작하는 테스트용 핸들. */
function makeHandle(key: string): FileSystemFileHandleLike {
  const self = {
    kind: 'file' as const,
    name: key,
    isSameEntry: async (other: unknown) => other === self,
    getFile: async () => {
      throw new Error('not used in store tests');
    },
  };
  return self as unknown as FileSystemFileHandleLike;
}

test('핸들 없는 열기는 메타-only 로 기록된다 (드롭/input/URL)', async () => {
  await clearRecentDocs();
  await addRecentDoc({ sourceDigest: 'blake3:drop', fileName: '드롭.hwp', sourceFormat: 'hwp' });
  await addRecentDoc({ sourceDigest: 'blake3:input', fileName: '인풋.hwpx', sourceFormat: 'hwpx', handle: null });
  const docs = await listRecentDocs();
  assert.equal(docs.length, 2, '핸들 없는 열기도 목록에 남는다');
  for (const d of docs) {
    assert.equal(d.handle, undefined, '메타-only 항목은 핸들을 갖지 않는다');
    assert.ok(d.documentId, '논리 문서 ID를 갖는다');
    assert.match(d.sourceDigest, /^blake3:/);
    assert.ok(!('bytes' in d), '바이트 스냅샷을 보관하면 안 된다');
  }
  assert.deepEqual(docs.map((d) => d.fileName).sort(), ['드롭.hwp', '인풋.hwpx']);
});

test('핸들 없는 동명 문서라도 digest가 다르면 별도 identity로 공존한다', async () => {
  await clearRecentDocs();
  const first = await addRecentDoc({ sourceDigest: 'blake3:first', fileName: 'dup.hwp', sourceFormat: 'hwp' });
  const second = await addRecentDoc({ sourceDigest: 'blake3:second', fileName: 'dup.hwp', sourceFormat: 'hwp' });
  const docs = await listRecentDocs();
  assert.equal(docs.length, 2, '파일명만으로 서로 다른 문서를 병합하면 안 된다');
  assert.notEqual(first.documentId, second.documentId);
});

test('핸들 없는 동일 digest 재열기는 파일명이 바뀌어도 documentId를 재사용한다', async () => {
  await clearRecentDocs();
  const first = await addRecentDoc({
    sourceDigest: 'blake3:same-bytes',
    fileName: '원본.hwp',
    sourceFormat: 'hwp',
  });
  await new Promise((r) => setTimeout(r, 5));
  const reopened = await addRecentDoc({
    sourceDigest: 'blake3:same-bytes',
    fileName: '이름변경.hwp',
    sourceFormat: 'hwp',
  });
  const docs = await listRecentDocs();
  assert.equal(docs.length, 1);
  assert.equal(reopened.id, first.id, '최근 레코드 key도 안정적으로 최신화한다');
  assert.equal(reopened.documentId, first.documentId);
  assert.equal(reopened.fileName, '이름변경.hwp');
});

test('저장 항목은 핸들+메타만 보관하고 바이트를 갖지 않는다', async () => {
  await clearRecentDocs();
  await addRecentDoc({ sourceDigest: 'blake3:a', fileName: 'a.hwp', sourceFormat: 'hwp', handle: makeHandle('a') });
  const [doc] = await listRecentDocs();
  assert.ok(doc.handle);
  assert.equal(doc.fileName, 'a.hwp');
  assert.ok(!('bytes' in doc), '바이트 스냅샷을 보관하면 안 된다 (#2285 보존 정책)');
});

test('같은 파일명이라도 isSameEntry=false면 별도 항목으로 공존한다', async () => {
  await clearRecentDocs();
  const h1 = makeHandle('dirA/문서.hwp');
  const h2 = makeHandle('dirB/문서.hwp');
  await addRecentDoc({ sourceDigest: 'blake3:a', fileName: '문서.hwp', sourceFormat: 'hwp', handle: h1 });
  await addRecentDoc({ sourceDigest: 'blake3:b', fileName: '문서.hwp', sourceFormat: 'hwp', handle: h2 });
  const docs = await listRecentDocs();
  assert.equal(docs.length, 2, '다른 경로의 동명 문서가 병합되면 안 된다');
  const handles = new Set(docs.map((d) => d.handle));
  assert.ok(handles.has(h1) && handles.has(h2));
});

test('서로 다른 두 핸들은 digest가 같아도 isSameEntry=false가 권위다', async () => {
  await clearRecentDocs();
  const h1 = makeHandle('dirA/copy.hwp');
  const h2 = makeHandle('dirB/copy.hwp');
  const first = await addRecentDoc({
    sourceDigest: 'blake3:identical-copy',
    fileName: 'copy.hwp',
    sourceFormat: 'hwp',
    handle: h1,
  });
  const second = await addRecentDoc({
    sourceDigest: 'blake3:identical-copy',
    fileName: 'copy.hwp',
    sourceFormat: 'hwp',
    handle: h2,
  });
  assert.equal((await listRecentDocs()).length, 2);
  assert.notEqual(first.documentId, second.documentId);
});

test('동일 핸들(isSameEntry=true)은 파일 내용 digest가 바뀌어도 identity를 유지한다', async () => {
  await clearRecentDocs();
  const h = makeHandle('same.hwp');
  const first = await addRecentDoc({ sourceDigest: 'blake3:before-save', fileName: 'same.hwp', sourceFormat: 'hwp', handle: h });
  const firstAt = first.openedAt;
  await new Promise((r) => setTimeout(r, 5));
  const reopened = await addRecentDoc({ sourceDigest: 'blake3:after-save', fileName: 'same.hwp', sourceFormat: 'hwp', handle: h });
  const docs = await listRecentDocs();
  assert.equal(docs.length, 1);
  assert.ok(docs[0].openedAt >= firstAt);
  assert.equal(reopened.documentId, first.documentId);
  assert.equal(reopened.sourceDigest, 'blake3:after-save');
});

test('명시한 documentId는 Save As 메타 갱신에서도 보존된다', async () => {
  await clearRecentDocs();
  const savedAsHandle = makeHandle('renamed');
  const original = await addRecentDoc({
    sourceDigest: 'blake3:original',
    fileName: 'original.hwp',
    sourceFormat: 'hwp',
    handle: makeHandle('original'),
  });
  const savedAs = await addRecentDoc({
    documentId: original.documentId,
    sourceDigest: 'blake3:saved-as',
    fileName: 'renamed.hwpx',
    sourceFormat: 'hwpx',
    handle: savedAsHandle,
  });
  assert.equal(savedAs.documentId, original.documentId);
  assert.equal(savedAs.id, original.id);
  assert.equal((await listRecentDocs()).length, 1);

  const reopenedNextSession = await addRecentDoc({
    sourceDigest: 'blake3:bytes-read-back-after-save',
    fileName: 'renamed.hwpx',
    sourceFormat: 'hwpx',
    handle: savedAsHandle,
  });
  assert.equal(
    reopenedNextSession.documentId,
    original.documentId,
    '저장된 새 핸들을 다시 열면 명시 ID 없이도 같은 논리 문서를 복원한다',
  );
});

test('handle-backed Save/Save As만 active document identity를 recent-store에 연결한다', () => {
  const commands = readFileSync(new URL('../src/command/commands/file.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  assert.match(
    commands,
    /if \(result\.method !== 'fallback'\)[\s\S]*?completeHandleSave\(/,
    'fallback download가 handle-save 완료 경로로 들어가면 안 된다',
  );
  assert.match(
    commands,
    /eventBus\.emit\('document-file-handle-saved', \{[\s\S]*?fileHandle: result\.handle,[\s\S]*?fileName: result\.fileName,[\s\S]*?sourceFormat: savedFormat/,
  );
  assert.match(
    commands,
    /services\.wasm\.fileName = result\.fileName;[\s\S]*?markClean\(reason\);[\s\S]*?emit\('document-context-changed'\)/,
  );
  assert.match(
    commands,
    /emit\('open-document-bytes', \{[\s\S]*?skipUnsavedGuard: true[\s\S]*?grant: \{ kind: 'verified', documentId \}/,
  );
  assert.match(
    main,
    /moveToLibraryDocument: \(target\) => \{[\s\S]*runLibraryMove\(commandServices, target, \(\) => activeDocumentId\)/s,
  );
  assert.match(
    main,
    /eventBus\.on\('document-file-handle-saved',[\s\S]*?documentId = activeDocumentId;[\s\S]*?rememberNativeDocument\(documentId, saved\.fileHandle[\s\S]*?addRecentDoc\(\{[\s\S]*?handle: saved\.fileHandle/,
  );
  assert.match(main, /captureDesktopNativeDroppedFile\(file\)/);
  assert.match(main, /grant: data\.grant/);
  assert.match(main, /rememberNativeDocument\(\s*ownership\.identity\.documentId,\s*fileHandle/);
});

test('최대 8개 상한 — 가장 오래된 항목부터 밀려난다', async () => {
  await clearRecentDocs();
  for (let i = 0; i < 10; i++) {
    await addRecentDoc({ sourceDigest: `blake3:f${i}`, fileName: `f${i}.hwp`, sourceFormat: 'hwp', handle: makeHandle(`f${i}`) });
    await new Promise((r) => setTimeout(r, 2));
  }
  const docs = await listRecentDocs();
  assert.equal(docs.length, 8);
  assert.equal(docs[0].fileName, 'f9.hwp', '최신이 맨 앞');
  const names = docs.map((d) => d.fileName);
  assert.ok(!names.includes('f0.hwp') && !names.includes('f1.hwp'), '가장 오래된 2개 제거');
});

test('isSameEntry가 멈추면 digest로 같은 문서를 병합한다', async () => {
  await clearRecentDocs();
  const first = await addRecentDoc({
    sourceDigest: 'blake3:same-bytes',
    fileName: '원본.hwp',
    sourceFormat: 'hwp',
    handle: makeHandle('old'),
  });
  const hanging = {
    ...makeHandle('new'),
    isSameEntry: () => new Promise<boolean>(() => {}),
  } as FileSystemFileHandleLike;
  const reopened = await addRecentDoc({
    sourceDigest: 'blake3:same-bytes',
    fileName: '원본.hwp',
    sourceFormat: 'hwp',
    handle: hanging,
  });
  assert.equal(reopened.documentId, first.documentId);
});

test('native-path 핸들은 세션 오버레이로 목록에 남는다', async () => {
  await clearRecentDocs();
  const handle = {
    ...makeHandle('native'),
    identityKind: 'native-path' as const,
  };
  const stored = await addRecentDoc({
    sourceDigest: 'blake3:native',
    fileName: 'n.hwp',
    sourceFormat: 'hwp',
    handle,
  });
  const docs = await listRecentDocs();
  assert.equal(docs[0]?.handle, handle, 'native-path 핸들은 IDB에 못 넣어도 세션에서 복원한다');
  assert.equal(stored.handle, handle);
});

test('removeRecentDoc / clearRecentDocs', async () => {
  await clearRecentDocs();
  await addRecentDoc({ sourceDigest: 'blake3:x', fileName: 'x.hwp', sourceFormat: 'hwp', handle: makeHandle('x') });
  await addRecentDoc({ sourceDigest: 'blake3:y', fileName: 'y.hwp', sourceFormat: 'hwp', handle: makeHandle('y') });
  const docs = await listRecentDocs();
  await removeRecentDoc(docs[0].id);
  assert.equal((await listRecentDocs()).length, 1);
  await clearRecentDocs();
  assert.equal((await listRecentDocs()).length, 0);
});

test('최근 문서 저장소는 IndexedDB 무응답에 타임아웃한다', () => {
  const store = readFileSync(new URL('../src/recent/recent-store.ts', import.meta.url), 'utf8');
  assert.match(store, /openIndexedDatabase/);
  assert.match(store, /withTimeout/);
  assert.match(store, /SAME_ENTRY_TIMEOUT_MS/);
  assert.match(store, /identityKind === 'native-path'/);
  assert.match(store, /liveHandles/);
});
