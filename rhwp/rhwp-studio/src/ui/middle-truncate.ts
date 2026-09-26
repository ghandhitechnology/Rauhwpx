/**
 * 파일 이름 가운데 줄임 — Finder 처럼 앞부분과 확장자·끝 버전 표기를 남기고
 * 가운데를 … 로 줄인다. 예: 사업계획서_최종_수정본_v3.hwpx → 사업계획서_최종…v3.hwpx
 *
 * 대상 요소는 폭이 부모에 의해 정해져야 한다(block 이거나 flex 로 늘어나는 요소).
 * 폭은 공용 ResizeObserver 하나로 다시 재고, 전체 이름은 title 로 남긴다.
 */

const ELLIPSIS = '…';
/** 확장자: 마지막 점 뒤 1~6자의 영숫자. */
const EXTENSION_RE = /\.[A-Za-z0-9]{1,6}$/;
/** 끝 버전 표기: v3, v1.2, (2), _03 처럼 줄기 끝에 붙은 번호. */
const VERSION_RE = /(?:[vV]\d+(?:[._]\d+)*|\(\d+\)|\d{1,4})$/;

interface Entry {
  full: string;
  width: number;
  font: string;
  /** 한 번이라도 문서에 붙어 그려졌는지 — 붙기 전 요소는 걷어내지 않는다. */
  attached: boolean;
}

const entries = new Map<HTMLElement, Entry>();
let observer: ResizeObserver | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let fontsHooked = false;

function context(): CanvasRenderingContext2D | null {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d');
  return ctx;
}

function fontOf(style: CSSStyleDeclaration): string {
  return style.font
    || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

/** 줄여도 남겨야 하는 꼬리(끝 버전 표기 + 확장자). */
function protectedTail(text: string): string {
  const ext = text.match(EXTENSION_RE)?.[0] ?? '';
  const stem = text.slice(0, text.length - ext.length);
  const version = stem.match(VERSION_RE)?.[0] ?? '';
  // 줄기 전체가 번호뿐이면 남길 앞부분이 없으니 확장자만 지킨다.
  return version && version.length < stem.length ? version + ext : ext;
}

/**
 * 폭 안에 들어가는 가운데 줄임 문자열을 돌려준다. measure 는 문자열 폭(px)을 잰다.
 */
export function truncateMiddle(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  const tail = Array.from(protectedTail(text));
  const chars = Array.from(text);
  const head = chars.slice(0, chars.length - tail.length);

  const fitHead = (tailPart: string[], source: string[]): string | null => {
    const suffix = ELLIPSIS + tailPart.join('');
    if (measure(suffix) > maxWidth) return null;
    let lo = 0;
    let hi = source.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measure(source.slice(0, mid).join('') + suffix) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? source.slice(0, lo).join('') + suffix : null;
  };

  if (tail.length > 0) {
    const kept = fitHead(tail, head);
    if (kept) return kept;
  }
  // 꼬리까지 들어가지 않으면 앞 60%·뒤 40% 비율로 가운데를 줄인다.
  let lo = 0;
  let hi = chars.length;
  let best = ELLIPSIS;
  while (lo <= hi) {
    const keep = Math.floor((lo + hi) / 2);
    const front = Math.ceil(keep * 0.6);
    const back = keep - front;
    const candidate = chars.slice(0, front).join('') + ELLIPSIS + (back > 0 ? chars.slice(-back).join('') : '');
    if (measure(candidate) <= maxWidth) {
      best = candidate;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }
  return best;
}

function render(el: HTMLElement, entry: Entry): void {
  if (!el.isConnected) return;
  entry.attached = true;
  const style = getComputedStyle(el);
  const width = el.clientWidth
    - (Number.parseFloat(style.paddingLeft) || 0)
    - (Number.parseFloat(style.paddingRight) || 0);
  // 숨겨진 동안은 전체 이름을 두고, 보일 때 ResizeObserver 가 다시 부른다.
  if (width <= 0) {
    if (el.textContent !== entry.full) el.textContent = entry.full;
    return;
  }
  const font = fontOf(style);
  if (width === entry.width && font === entry.font && el.dataset.truncated !== undefined) return;
  entry.width = width;
  entry.font = font;
  const c = context();
  let next = entry.full;
  if (c) {
    c.font = font;
    const spacing = style.letterSpacing;
    if ('letterSpacing' in c) (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = spacing === 'normal' ? '0px' : spacing;
    // 캔버스와 DOM 의 반올림 차이만큼 1px 여유를 둔다.
    next = truncateMiddle(entry.full, width - 1, (s) => c.measureText(s).width);
  }
  if (el.textContent !== next) el.textContent = next;
  el.dataset.truncated = next === entry.full ? 'false' : 'true';
}

function ensureObserver(): ResizeObserver | null {
  if (observer || typeof ResizeObserver === 'undefined') return observer;
  observer = new ResizeObserver((records) => {
    for (const record of records) {
      const el = record.target as HTMLElement;
      const entry = entries.get(el);
      if (entry) render(el, entry);
    }
  });
  if (!fontsHooked && document.fonts) {
    fontsHooked = true;
    // 웹폰트가 늦게 도착하면 폭이 바뀌므로 한 번 더 잰다.
    document.fonts.addEventListener?.('loadingdone', () => {
      for (const [el, entry] of entries) {
        entry.width = -1;
        render(el, entry);
      }
    });
  }
  return observer;
}

function release(el: HTMLElement): void {
  entries.delete(el);
  observer?.unobserve(el);
}

/** 목록을 다시 그리면 떨어져 나간 요소가 남는다 — 등록할 때마다 걷어낸다. */
function prune(): void {
  for (const [el, entry] of entries) {
    if (entry.attached && !el.isConnected) release(el);
  }
}

/**
 * 요소에 파일 이름을 가운데 줄임으로 넣는다. 같은 요소에 다시 부르면 이름만 바뀐다.
 * titleText 가 null 이면 title 을 건드리지 않는다.
 */
export function setMiddleTruncatedText(el: HTMLElement, full: string, titleText: string | null = full): void {
  prune();
  if (titleText !== null) el.title = titleText;
  let entry = entries.get(el);
  // 같은 이름이 다시 오면(선택 변경마다 갱신되는 머리글 등) 다시 재지 않는다.
  if (entry?.full === full) return;
  if (!entry) {
    entry = { full, width: -1, font: '', attached: false };
    entries.set(el, entry);
    ensureObserver()?.observe(el);
  } else {
    entry.full = full;
    entry.width = -1;
  }
  el.textContent = full;
  delete el.dataset.truncated;
  // 아직 문서에 붙기 전이면 ResizeObserver 첫 알림이 처리한다.
  if (el.isConnected) render(el, entry);
}
