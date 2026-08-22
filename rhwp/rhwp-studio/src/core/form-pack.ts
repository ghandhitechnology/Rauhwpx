export const FORM_PACK_ID = 'rauhwpx-office';

export const REFUSE_BINARY_HWP =
  '이 서식은 HWPX로만 저장할 수 있습니다. 바이너리 HWP 경로는 거부합니다.';

export interface FormPackEntry {
  id: string;
  title: string;
  file: string;
  kind: string;
  description: string;
}

export const FORM_PACK_FORMS: readonly FormPackEntry[] = [
  {
    id: 'gongmun',
    title: '공문',
    file: '공문.hwpx',
    kind: 'official-letter',
    description: '온메일형 시행문·공문. 수신·제목·본문·발신명의·결재 누름틀.',
  },
  {
    id: 'pumui',
    title: '품의',
    file: '품의.hwpx',
    kind: 'approval',
    description: '온메일형 품의. 문서정보 표 안에 결재란 중첩 표가 들어 있다.',
  },
];

let activeFormPackId: string | null = null;

export function setActiveFormPack(id: string | null): void {
  activeFormPackId = id;
}

export function getActiveFormPack(): string | null {
  return activeFormPackId;
}

export function formPackIdFromFileName(fileName: string): string | null {
  const name = fileName.trim().split(/[/\\]/).pop()?.toLowerCase() ?? '';
  if (name === '공문.hwpx' || name.startsWith('공문.') && name.endsWith('.hwpx')) return 'gongmun';
  if (name === '품의.hwpx' || name.startsWith('품의.') && name.endsWith('.hwpx')) return 'pumui';
  return null;
}

export function isFormPackDocument(fileName?: string): boolean {
  return activeFormPackId != null || formPackIdFromFileName(fileName ?? '') != null;
}

export function formPackAssetUrl(entry: FormPackEntry): string {
  return `/form-pack/${encodeURIComponent(entry.file)}`;
}

export function refuseBinaryHwpExport(
  format: string,
  fileName?: string,
): string | null {
  if (!isFormPackDocument(fileName)) return null;
  const requested = format.trim().toLowerCase();
  if (requested === 'hwp' || (fileName ?? '').toLowerCase().endsWith('.hwp')) {
    return REFUSE_BINARY_HWP;
  }
  return null;
}
