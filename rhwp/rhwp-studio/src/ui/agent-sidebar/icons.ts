/* 사이드바 아이콘 — 유니코드 글리프(✓ ✕ ⇄ …) 대신 직접 그린 SVG.
   chevron.ts 와 같은 규약: 12 그리드, currentColor, 1.25 스트로크,
   둥근 캡. 굵기를 한 벌로 맞춰야 글리프마다 폰트 렌더가 달라지는
   문제가 사라진다. */

const NS = 'http://www.w3.org/2000/svg';

/** 스트로크로만 그리는 아이콘의 패스 정의. */
const STROKE_PATHS = {
  check: 'M2.5 6.4 5 8.9l4.5-5.4',
  close: 'M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6',
  send: 'M6 9.5v-7M2.9 5.6 6 2.5l3.1 3.1',
  insert: 'M6 2.6v6.8M2.6 6h6.8',
  delete: 'M2.6 6h6.8',
  replace: 'M2.5 4.3h6.2L6.9 2.6M9.5 7.7H3.3l1.8 1.7',
  format: 'M2.8 9.2 3.2 7.5l4.4-4.4 1.3 1.3-4.4 4.4zM2.8 9.2h2.4',
  field: 'M3.4 9.4V2.6h5.2L7.3 4.6l1.3 2H3.4',
  /* 네 귀퉁이가 바깥을 향한다 — 콘솔 펼치기 */
  expand: 'M2.6 4.8V2.6h2.2M7.2 2.6h2.2v2.2M9.4 7.2v2.2H7.2M4.8 9.4H2.6V7.2',
  /* 같은 형태를 안쪽으로 뒤집는다 — 사이드바로 되돌리기 */
  contract: 'M4.8 2.6v2.2H2.6M9.4 4.8H7.2V2.6M7.2 9.4V7.2h2.2M2.6 7.2h2.2v2.2',
  environment: 'M2.4 3.2h1.1M5.1 3.2h4.5M2.4 8.8h4.5M8.5 8.8h1.1M4.3 2.2v2M7.7 7.8v2',
  document: 'M3 2.2h3.8L9 4.4v5.4H3zM6.8 2.2v2.2H9',
  changes: 'M3 2.2h6v7.6H3zM4.6 5.1h2.8M6 3.7v2.8M4.6 8h2.8',
  paperclip: 'M4.1 6.2 7.3 3a1.7 1.7 0 0 1 2.4 2.4L5.8 9.3A2.5 2.5 0 0 1 2.3 5.8l4-4M4.7 7.5 8 4.2',
  references: 'M3 2.2h4.1L9 4.1v5.7H3zM7.1 2.2v1.9H9M4.4 6h3.2M4.4 7.7h2.3',
  search: 'M5.3 2.5a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6M7.3 7.3l2.2 2.2',
} as const;

/** 사각 프레임(개체)만 채우기 없이 rect 로 그린다. */
const RECT_ICONS = { object: true } as const;

export type SidebarIconName = keyof typeof STROKE_PATHS | keyof typeof RECT_ICONS;

/**
 * 12×12 인라인 SVG 아이콘을 만든다.
 * 색은 currentColor 를 따르므로 부모에서 color 로 제어한다.
 */
export function createIcon(name: SidebarIconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className ? `ag-icon ${className}` : 'ag-icon');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  if (name in RECT_ICONS) {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', '2.9');
    rect.setAttribute('y', '2.9');
    rect.setAttribute('width', '6.2');
    rect.setAttribute('height', '6.2');
    rect.setAttribute('rx', '1');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', 'currentColor');
    rect.setAttribute('stroke-width', '1.25');
    svg.appendChild(rect);
    return svg;
  }

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', STROKE_PATHS[name as keyof typeof STROKE_PATHS]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/** 실행 중지 버튼용 채워진 사각형. 스트로크 아이콘과 달리 면으로 읽혀야 한다. */
export function createStopIcon(className = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className ? `ag-icon ${className}` : 'ag-icon');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', '3.6');
  rect.setAttribute('y', '3.6');
  rect.setAttribute('width', '4.8');
  rect.setAttribute('height', '4.8');
  rect.setAttribute('rx', '1');
  rect.setAttribute('fill', 'currentColor');
  svg.appendChild(rect);
  return svg;
}

/** 편집 종류 → 아이콘 이름. opGlyph 의 유니코드 대응을 대체한다. */
export const OP_ICON: Record<string, SidebarIconName> = {
  insert: 'insert',
  delete: 'delete',
  replace: 'replace',
  format: 'format',
  field: 'field',
  object: 'object',
};
