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
