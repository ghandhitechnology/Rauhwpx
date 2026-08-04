/** 얇은 stroke 쉐브론 (아래 방향). CSS transform 으로 방향을 바꾼다. */
const CHEVRON_PATH = 'M2.75 4.5L6 7.75L9.25 4.5';

export function createChevron(className = ''): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute(
    'class',
    className ? `ui-chevron ${className}` : 'ui-chevron',
  );
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', CHEVRON_PATH);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/** HTML 정적 마크업용 동일 아이콘. */
export const CHEVRON_SVG_HTML =
  '<svg class="ui-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">'
  + `<path d="${CHEVRON_PATH}" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>`
  + '</svg>';

/** 채팅 목록(사이드 컬럼) 아이콘 — 얇은 stroke. */
export function createColumnIcon(className = ''): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute(
    'class',
    className ? `ui-column-icon ${className}` : 'ui-column-icon',
  );
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('fill', 'none');
  g.setAttribute('stroke', 'currentColor');
  g.setAttribute('stroke-width', '1.25');
  g.setAttribute('stroke-linecap', 'round');
  g.setAttribute('stroke-linejoin', 'round');
  const outer = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  outer.setAttribute('x', '2.5');
  outer.setAttribute('y', '2.5');
  outer.setAttribute('width', '11');
  outer.setAttribute('height', '11');
  outer.setAttribute('rx', '1.5');
  const col = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  col.setAttribute('d', 'M6.25 2.5V13.5');
  g.append(outer, col);
  svg.appendChild(g);
  return svg;
}
