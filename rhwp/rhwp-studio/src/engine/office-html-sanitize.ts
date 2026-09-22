/** 오피스(Word/Excel/PowerPoint)·한글 CF_HTML 에서 코어 HTML 파서가 못 거르는 비내용 조각 제거.
 *
 * 정규식 치환을 늘어놓지 않고 **한 번 훑어서** 지운다. 치환은 `<!--<!-- -->` 처럼 겹친 입력에서
 * 여는 표지를 남기고, `</script >` 처럼 이름 뒤에 공백이 낀 닫는 태그를 놓친다. 스캔은 시작 표지를
 * 만나면 닫는 표지까지, 닫는 표지가 없으면 끝까지 버리므로 잔재가 구조적으로 남지 않는다.
 */

/** 내용이 아닌, 통째로 버릴 요소. `<body>` 안 `<style>` 은 코어가 텍스트로 흘린다. */
const NON_CONTENT_ELEMENTS = ['script', 'style', 'xml'] as const;

const CONDITIONAL_END = '<![endif]>';

/** 태그 이름이 여기서 끝나는가 — `<style>`·`<style ...>`·`<style/>` 는 맞고 `<styles>` 는 아니다. */
function isTagNameBoundary(code: number): boolean {
  return Number.isNaN(code) || code === 0x3e /* > */ || code === 0x2f /* / */ || code <= 0x20;
}

/** 여는 태그 위치에서 그 요소가 끝나는 색인. 닫는 태그가 없으면 문자열 끝(= 뒤를 통째로 버린다). */
function skipNonContentElement(html: string, lower: string, start: number, name: string): number {
  const tagEnd = html.indexOf('>', start);
  if (tagEnd < 0) return html.length; // 잘린 여는 태그
  if (html.charCodeAt(tagEnd - 1) === 0x2f) return tagEnd + 1; // <xml/> 처럼 스스로 닫은 태그
  let from = tagEnd + 1;
  for (;;) {
    const close = lower.indexOf(`</${name}`, from);
    if (close < 0) return html.length;
    // `</script >`·`</script\n>` 도 닫는 태그다 — 이름 뒤 공백을 건너뛴 자리가 `>` 여야 한다.
    let cursor = close + 2 + name.length;
    while (cursor < html.length && html.charCodeAt(cursor) <= 0x20) cursor += 1;
    if (cursor >= html.length) return html.length;
    if (html.charCodeAt(cursor) === 0x3e) return cursor + 1;
    from = close + 2 + name.length;
  }
}

/**
 * 코어 파서는 `<!--[` 로 시작하는 주석(MSO 조건부 주석, 한글의 254KB `<!--[data-hwpjson]{…}-->`)을
 * 못 걸러 뒤 본문 전체가 한 문단으로 뭉개지고 CSS 가 새어 나온다
 * (2026-09-03 실측: 이 주석만 빼면 표 4·문단 343 정상).
 * CF_HTML 의 Start/EndFragment 마커도 주석이라 여기서 함께 사라진다.
 */
export function sanitizeOfficeHtmlForCore(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt < 0) {
      out += html.slice(index);
      break;
    }
    out += html.slice(index, lt);

    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    // downlevel-revealed <![if !supportEmptyParas]>…<![endif]>
    if (lower.startsWith('<![if', lt)) {
      const end = lower.indexOf(CONDITIONAL_END, lt);
      index = end < 0 ? html.length : end + CONDITIONAL_END.length;
      continue;
    }
    const dropped = NON_CONTENT_ELEMENTS.find(
      (name) =>
        lower.startsWith(`<${name}`, lt) &&
        isTagNameBoundary(lower.charCodeAt(lt + 1 + name.length)),
    );
    if (dropped) {
      index = skipNonContentElement(html, lower, lt, dropped);
      continue;
    }
    out += '<';
    index = lt + 1;
  }
  return out;
}

/** 붙여넣기 UI를 막지 않도록 문서모델 페이로드 절대 상한. 넘으면 HTML 경로로 폴백한다. */
export const HWPJSON_PASTE_MAX_CHARS = 32_000_000;

/**
 * 한글 클립보드 HTML 에서 문서 모델 JSON 을 꺼낸다.
 *
 * 형태는 `<!--[data-hwpjson]{ … }-->` 이고, 주석 안이 통째로 JSON 이다.
 * 없으면 한글이 아닌 곳(워드·엑셀·브라우저)에서 온 것이므로 null 을 준다.
 */
export function extractHwpJsonModel(html: string): string | null {
  const marker = html.indexOf('[data-hwpjson]');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  if (start < 0) return null;
  const end = html.indexOf('-->', start);
  const raw = (end < 0 ? html.slice(start) : html.slice(start, end)).trim();
  if (raw.length < 2 || raw[0] !== '{') return null;
  if (raw.length > HWPJSON_PASTE_MAX_CHARS) return null;
  return raw;
}
