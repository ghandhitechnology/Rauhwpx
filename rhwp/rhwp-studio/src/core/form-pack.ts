export const FORM_PACK_ID = 'rauhwpx-office';
export const FORM_PACK_MARKER_PATH = 'META-INF/rauhwpx-form-pack';

/** 사무실 거절 안내. 한글이 본문이고, 영문은 같은 뜻의 짝이다. */
export const REFUSE_BINARY_HWP_KO =
  '이 서식은 HWPX만 저장됩니다. HWP 저장은 막아 두었습니다. 표와 배치는 그대로입니다.';
export const REFUSE_BINARY_HWP_EN =
  'This form is HWPX-only. HWP save is blocked. Tables and layout stay.';
export const REFUSE_BINARY_HWP = `${REFUSE_BINARY_HWP_KO}\n${REFUSE_BINARY_HWP_EN}`;

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
  activeFormPackId = id === FORM_PACK_ID ? FORM_PACK_ID : null;
}

export function getActiveFormPack(): string | null {
  return activeFormPackId;
}

/** ZIP 표식의 팩 id. 파일명 `공문.hwpx`/`품의.hwpx` 로는 식별하지 않는다. */
export function formPackIdFromHwpxBytes(bytes: Uint8Array): string | null {
  const wanted = FORM_PACK_MARKER_PATH;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 30 <= bytes.length; offset += 1) {
    if (
      bytes[offset] !== 0x50
      || bytes[offset + 1] !== 0x4b
      || bytes[offset + 2] !== 0x03
      || bytes[offset + 3] !== 0x04
    ) {
      continue;
    }
    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.length) continue;
    if (decoder.decode(bytes.subarray(nameStart, nameEnd)) !== wanted) continue;
    if (method !== 0) return null;
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) return null;
    const text = decoder.decode(bytes.subarray(dataStart, dataEnd)).trim();
    return text === FORM_PACK_ID ? FORM_PACK_ID : null;
  }
  return null;
}

export function isFormPackDocument(): boolean {
  return activeFormPackId === FORM_PACK_ID;
}

export function formPackAssetUrl(entry: FormPackEntry): string {
  return `/form-pack/${encodeURIComponent(entry.file)}`;
}

export function refuseBinaryHwpExport(format: string, fileName?: string): string | null {
  if (!isFormPackDocument()) return null;
  const requested = format.trim().toLowerCase();
  if (requested === 'hwp' || (fileName ?? '').toLowerCase().endsWith('.hwp')) {
    return REFUSE_BINARY_HWP;
  }
  return null;
}
