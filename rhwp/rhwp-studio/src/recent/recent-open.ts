/**
 * 최근 문서 재열기 결과 규칙 (#2285 / PR #2286 리뷰 회귀 고정).
 *
 * 바이트 스냅샷 폴백 없이 저장된 핸들의 라이브 파일로만 연다:
 * - 권한 거부           → 항목 **유지** + 안내 (다음에 다시 시도 가능)
 * - 파일 이동/삭제(read 실패) → 항목 **제거** + 안내 (재열기 영구 불가)
 * - 성공                → open-document-bytes 이벤트 (핸들 연속성 유지)
 *
 * Electron native-path 핸들은 IndexedDB에 못 넣으므로, 세션 오버레이·메인 프로세스
 * 북마크(`restoreNativeDocument`)로 복구한 뒤에만 파일 선택을 유도한다.
 *
 * DOM/전역 의존을 주입(deps)으로 분리해 node 테스트에서 규칙을 고정한다.
 */

import type { FileSystemFileHandleLike } from '@/command/file-system-access';
import type { RecentDoc } from './recent-store';

export interface OpenRecentDeps {
  ensurePermission: (handle: FileSystemFileHandleLike) => Promise<boolean>;
  readFile: (handle: FileSystemFileHandleLike) => Promise<{ bytes: Uint8Array; name: string }>;
  remove: (id: string) => Promise<void>;
  toast: (message: string, durationMs: number) => void;
  emitOpen: (payload: {
    bytes: Uint8Array;
    fileName: string;
    fileHandle: FileSystemFileHandleLike;
    documentId?: string;
  }) => void;
  /**
   * 메타-only 항목(핸들 없음) 재열기 요청 — 파일 선택 대화상자를 다시 연다.
   * 미주입 시 안내 토스트만 띄운다.
   */
  requestReopen?: () => void;
  /**
   * Electron: documentId → 메인 프로세스 북마크로 native handle을 다시 만든다.
   * 다른 창이 소유 중이면 `'owned'`. 북마크가 없으면 `null`.
   */
  restoreNativeDocument?: (
    documentId: string,
  ) => Promise<FileSystemFileHandleLike | 'owned' | null>;
}

export type OpenRecentResult = 'opened' | 'permission-denied' | 'removed' | 'needs-pick';

async function restoreNativeHandle(
  entry: RecentDoc,
  deps: OpenRecentDeps,
): Promise<FileSystemFileHandleLike | 'owned' | null> {
  if (!entry.documentId || !deps.restoreNativeDocument) return null;
  try {
    return await deps.restoreNativeDocument(entry.documentId);
  } catch (err) {
    console.warn('[file:open-recent] native restore failed:', err);
    return null;
  }
}

function ownedElsewhere(deps: OpenRecentDeps): OpenRecentResult {
  deps.toast('다른 창에서 이미 열려 있는 문서입니다.', 3000);
  return 'permission-denied';
}

function requestPick(entry: RecentDoc, deps: OpenRecentDeps): OpenRecentResult {
  deps.toast(`"${entry.fileName}" 파일을 선택하세요.`, 4000);
  deps.requestReopen?.();
  return 'needs-pick';
}

async function emitLiveFile(
  handle: FileSystemFileHandleLike,
  deps: OpenRecentDeps,
  documentId?: string,
): Promise<void> {
  const { bytes, name } = await deps.readFile(handle);
  deps.emitOpen({
    bytes,
    fileName: name,
    fileHandle: handle,
    ...(documentId ? { documentId } : {}),
  });
}

async function removeMissing(entry: RecentDoc, deps: OpenRecentDeps, err: unknown): Promise<OpenRecentResult> {
  console.warn('[file:open-recent] 파일 접근 실패(이동/삭제 추정):', err);
  await deps.remove(entry.id);
  deps.toast(`"${entry.fileName}" 파일을 찾을 수 없어 목록에서 제거했습니다.`, 3500);
  return 'removed';
}

export async function openRecentEntry(
  entry: RecentDoc,
  deps: OpenRecentDeps,
): Promise<OpenRecentResult> {
  let handle = entry.handle ?? null;

  if (!handle) {
    const restored = await restoreNativeHandle(entry, deps);
    if (restored === 'owned') return ownedElsewhere(deps);
    handle = restored;
  }

  if (!handle) return requestPick(entry, deps);

  let granted = false;
  try {
    granted = await deps.ensurePermission(handle);
  } catch {
    granted = false;
  }
  if (!granted) {
    deps.toast(`"${entry.fileName}" 접근 권한이 거부되어 열 수 없습니다.`, 3000);
    return 'permission-denied';
  }

  try {
    await emitLiveFile(handle, deps, entry.documentId);
    return 'opened';
  } catch (err) {
    if (handle.identityKind === 'native-path') {
      const restored = await restoreNativeHandle(entry, deps);
      if (restored === 'owned') return ownedElsewhere(deps);
      if (restored) {
        try {
          await emitLiveFile(restored, deps, entry.documentId);
          return 'opened';
        } catch (restoreErr) {
          return removeMissing(entry, deps, restoreErr);
        }
      }
      console.warn('[file:open-recent] native handle stale without bookmark:', err);
      return requestPick(entry, deps);
    }
    return removeMissing(entry, deps, err);
  }
}
