/**
 * 라이브러리 "이동": 현재 문서를 저장한 뒤 선택한 문서로 연다.
 *
 * 첫 저장(새 문서)은 기존 저장 경로가 이름을 묻는다. 저장을 취소하면 이동하지 않는다.
 * documentId가 있는 대상은 openProjectFile 로만 연다. 파일명만 있는 레거시 그룹은
 * 겨냥할 identity가 없으므로 기존 열기 대화상자로 넘긴다.
 */

import type { RecentDoc } from '../recent/recent-store.ts';
import { claimForExplorerGroup } from '../project-file/claim.ts';
import type { ProjectFileClaim } from '../project-file/identity.ts';
import type { ProjectOpenOutcome } from '../project-file/open.ts';

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
  openProjectFile: (claim: ProjectFileClaim) => Promise<ProjectOpenOutcome>;
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
  if (!target.documentId) return undefined;
  return recents.find((row) => row.documentId === target.documentId);
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

  if (!target.documentId) {
    deps.toast(
      `"${target.fileName ?? '선택한 문서'}"을(를) 자동으로 열 수 없습니다. 파일을 선택하세요.`,
    );
    await deps.openViaPicker();
    return 'moved';
  }

  const recents = await deps.listRecent();
  const claim = claimForExplorerGroup(
    { documentId: target.documentId, displayName: target.fileName },
    recents,
  );
  if (!claim) {
    deps.toast('이동할 문서를 찾을 수 없습니다.');
    return 'failed';
  }

  const opened = await deps.openProjectFile(claim);
  if (opened.kind === 'opened') return 'moved';
  if (opened.kind === 'cancelled') return 'cancelled';
  return 'failed';
}
