/**
 * 글꼴 실재 여부 프로브 — 캔버스 글립 폭 비교로 "이 서체가 실제로 설치되어 있는가"를 판정한다.
 *
 * `document.fonts.check()` 를 쓰면 안 된다. 스펙상 check() 는 "매칭되는 @font-face 중
 * 로드가 필요한 것이 없는가" 를 묻는 API 이므로, 아예 존재하지 않는 서체 이름에 대해서도
 * 항상 true 를 돌려준다(실측 확인: `document.fonts.check('16px "ZZZ_NoSuchFont"')` → true).
 * 그 결과 Windows 전용 서체(맑은 고딕/바탕/돋움/굴림/궁서)가 macOS·Linux 에서도
 * "설치됨" 으로 오검출되어 대체 웹폰트 로딩이 통째로 생략됐다.
 *
 * 여기서는 generic fallback(monospace/serif/sans-serif) 대비 글립 폭이 달라지는지로
 * 판정한다 — 폭이 어떤 기준과도 다르면 실제 서체가 매칭된 것이다.
 */

const PROBE_FONT_SIZE = 72;
const PROBE_WIDTH_EPSILON = 0.1;
const PROBE_FALLBACKS = ['monospace', 'serif', 'sans-serif'];
const PROBE_TEXTS = [
  'mmmmmmmmmiiiiiiiiiWWW',
  '0123456789 ABCDEFG abcdefg',
  '가나다라마바사아자차카타파하',
  '한글과 English 12345',
];

export type ProbeContext = Pick<CanvasRenderingContext2D, 'font' | 'measureText'>;

export function cssQuoteFontFamily(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function createFontProbeContext(): ProbeContext | null {
  try {
    const documentLike = (globalThis as typeof globalThis & {
      document?: { createElement?: (tag: string) => unknown };
    }).document;
    const canvas = documentLike?.createElement?.('canvas') as {
      getContext?: (contextId: '2d') => CanvasRenderingContext2D | null;
    } | null | undefined;
    return canvas?.getContext?.('2d') ?? null;
  } catch {
    return null;
  }
}

function measureWithFamily(context: ProbeContext, family: string, text: string): number {
  context.font = `${PROBE_FONT_SIZE}px ${family}`;
  return context.measureText(text).width;
}

/**
 * 해당 서체가 실제 사용 가능한지(설치되어 있거나 이미 로드된 @font-face 가 있는지) 판정한다.
 *
 * 주의: @font-face 등록 **전에** 호출해야 "OS 설치 여부" 를 뜻한다.
 * 등록 후에 호출하면 등록된 웹폰트까지 포함해 "사용 가능" 으로 잡힌다.
 */
export function isFontFamilyAvailable(family: string, context?: ProbeContext | null): boolean {
  const ctx = context ?? createFontProbeContext();
  if (!ctx) return false;
  const name = family.trim();
  if (!name) return false;
  const quoted = cssQuoteFontFamily(name);
  for (const fallback of PROBE_FALLBACKS) {
    for (const text of PROBE_TEXTS) {
      const baseWidth = measureWithFamily(ctx, fallback, text);
      const candidateWidth = measureWithFamily(ctx, `${quoted}, ${fallback}`, text);
      if (Math.abs(candidateWidth - baseWidth) > PROBE_WIDTH_EPSILON) {
        return true;
      }
    }
  }
  return false;
}

/** 여러 서체를 한 컨텍스트로 일괄 판정한다. */
export function filterAvailableFontFamilies(families: readonly string[]): string[] {
  const ctx = createFontProbeContext();
  if (!ctx) return [];
  return families.filter(family => isFontFamilyAvailable(family, ctx));
}
