/**
 * 라이브러리 "이동": 현재 문서를 저장한 뒤 선택한 문서로 연다.
 *
 * 첫 저장(새 문서)은 기존 저장 경로가 이름을 묻는다. 저장을 취소하면 이동하지 않는다.
 * 대상은 최근 문서 핸들로 열고, 핸들이 없으면 Electron 북마크(`documentId`)로
 * 복구한 뒤, 그래도 안 되면 열기 대화상자로 넘긴다.
 */

import type { RecentDoc } from '@/recent/recent-store';
import type { OpenRecentResult } from '@/recent/recent-open';

export interface LibraryDocumentTarget {
  documentId: string | null;
  fileName: string | null;
}

export interface LibraryMoveCurrent {
  documentId: string | null;
  fileName: string | null;
  hasDocument: boolean;
}

export type LibraryMoveResult = 'moved' | 'same' | 'cancelled' | 'failed';

export interface MoveToLibraryDocumentDeps {
  getCurrent: () => LibraryMoveCurrent;
  saveCurrent: () => Promise<'saved' | 'cancelled' | 'failed' | 'unsupported'>;
  listRecent: () => Promise<RecentDoc[]>;
  openRecent: (entry: RecentDoc) => Promise<OpenRecentResult>;
  openViaPicker: () => Promise<void>;
  toast: (message: string) => void;
}

export function isSameLibraryDocument(
  current: LibraryMoveCurrent,
  target: LibraryDocumentTarget,
): boolean {
  if (target.documentId && current.documentId) {
    return target.documentId === current.documentId;
  }
  if (target.fileName && current.fileName) {
    return target.fileName === current.fileName;
  }
  return false;
}

export function findLibraryRecentDoc(
  recents: RecentDoc[],
  target: LibraryDocumentTarget,
): RecentDoc | undefined {
  if (target.documentId) {
    const byId = recents.find((row) => row.documentId === target.documentId);
    if (byId) return byId;
  }
  if (target.fileName) {
    return recents.find((row) => row.fileName === target.fileName);
  }
  return undefined;
}

export function canMoveToLibraryDocument(target: LibraryDocumentTarget): boolean {
  return Boolean(target.documentId || target.fileName);
}

export async function moveToLibraryDocument(
  target: LibraryDocumentTarget,
  deps: MoveToLibraryDocumentDeps,
): Promise<LibraryMoveResult> {
  if (!canMoveToLibraryDocument(target)) {
    deps.toast('이동할 문서를 찾을 수 없습니다.');
    return 'failed';
  }

  const current = deps.getCurrent();
  if (isSameLibraryDocument(current, target)) return 'same';

  if (current.hasDocument) {
    const saved = await deps.saveCurrent();
    if (saved === 'cancelled') return 'cancelled';
    if (saved !== 'saved') {
      deps.toast('현재 문서를 저장하지 못해 이동하지 않았습니다.');
      return 'failed';
    }
  }

  const recents = await deps.listRecent();
  const entry = findLibraryRecentDoc(recents, target)
    ?? (target.documentId
      ? {
        id: `restore:${target.documentId}`,
        documentId: target.documentId,
        sourceDigest: 'blake3:restore',
        fileName: target.fileName ?? 'document.hwp',
        sourceFormat: 'hwp',
        openedAt: 0,
      }
      : undefined);
  if (!entry) {
    deps.toast(
      `"${target.fileName ?? '선택한 문서'}"을(를) 자동으로 열 수 없습니다. 파일을 선택하세요.`,
    );
    await deps.openViaPicker();
    return 'moved';
  }

  const opened = await deps.openRecent(entry);
  if (opened === 'opened' || opened === 'needs-pick') return 'moved';
  if (opened === 'permission-denied') return 'failed';

  await deps.openViaPicker();
  return 'moved';
}
