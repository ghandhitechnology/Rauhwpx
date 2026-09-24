/** 도형 선택 메뉴 — 도구상자 "도형" 버튼 클릭 시 표시. */

export type ShapeType = 'line' | 'rectangle' | 'ellipse' | 'polygon' | 'arc'
  | 'connector-straight' | 'connector-stroke' | 'connector-arc'
  | 'connector-straight-arrow' | 'connector-stroke-arrow' | 'connector-arc-arrow';

export interface ShapePickerOptions {
  onSelect: (type: ShapeType) => void;
}

interface ShapeGroup {
  title: string;
  items: { type: ShapeType; label: string }[];
}

const GROUPS: ShapeGroup[] = [
  {
    title: '그리기 개체',
    items: [
      { type: 'line', label: '직선' },
      { type: 'rectangle', label: '사각형' },
      { type: 'ellipse', label: '타원' },
      { type: 'polygon', label: '다각형' },
      { type: 'arc', label: '호' },
    ],
  },
  {
    title: '연결선',
    items: [
      { type: 'connector-straight', label: '직선' },
      { type: 'connector-straight-arrow', label: '직선 화살표' },
      { type: 'connector-stroke', label: '꺾인' },
      { type: 'connector-stroke-arrow', label: '꺾인 화살표' },
      { type: 'connector-arc', label: '곡선' },
      { type: 'connector-arc-arrow', label: '곡선 화살표' },
    ],
  },
];

const SHAPE_PATHS: Record<ShapeType, string> = {
  line: 'M4 23 24 5',
  rectangle: 'M4 7h20v14H4z',
  ellipse: 'M4 14a10 7 0 1 0 20 0 10 7 0 1 0-20 0',
  polygon: 'm14 4 11 20H3z',
  arc: 'M4 22C5 8 17 3 24 12',
  'connector-straight': 'M3 14h22',
  'connector-straight-arrow': 'M3 14h21m-6-6 6 6-6 6',
  'connector-stroke': 'M3 6h11v16h11',
  'connector-stroke-arrow': 'M3 6h11v16h10m-6-6 6 6-6 5',
  'connector-arc': 'M3 21C9 3 19 3 25 21',
  'connector-arc-arrow': 'M3 21C9 3 19 3 25 21m-7-4 7 4-7 4',
};

let currentPicker: HTMLDivElement | null = null;
let currentAnchor: HTMLElement | null = null;

function closePicker(restoreFocus = false): void {
  currentPicker?.remove();
  currentPicker = null;
  if (currentAnchor) {
    currentAnchor.setAttribute('aria-expanded', 'false');
    currentAnchor.removeAttribute('aria-controls');
    if (restoreFocus) currentAnchor.focus();
  }
  currentAnchor = null;
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('resize', positionPicker);
  window.removeEventListener('scroll', positionPicker, true);
}

function onOutsidePointer(e: PointerEvent): void {
  if (!currentPicker?.contains(e.target as Node) && !currentAnchor?.contains(e.target as Node)) closePicker();
}

function onKeyDown(e: KeyboardEvent): void {
  if (!currentPicker) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closePicker(true);
    return;
  }
  if (!currentPicker.contains(document.activeElement)) return;
  const buttons = Array.from(currentPicker.querySelectorAll<HTMLButtonElement>('.shape-picker-btn'));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const movement: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 };
  let next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : index + (movement[e.key] ?? 0);
  if (!(e.key in movement) && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  next = Math.max(0, Math.min(buttons.length - 1, next));
  buttons[next]?.focus();
}

function positionPicker(): void {
  if (!currentPicker || !currentAnchor) return;
  const rect = currentAnchor.getBoundingClientRect();
  const panel = currentPicker;
  const gap = 6;
  const margin = 8;
  panel.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - panel.offsetWidth - margin))}px`;
  const below = window.innerHeight - rect.bottom;
  const above = rect.top;
  const openAbove = below < panel.offsetHeight + gap && above > below;
  panel.style.top = `${openAbove
    ? Math.max(margin, rect.top - panel.offsetHeight - gap)
    : Math.min(window.innerHeight - panel.offsetHeight - margin, rect.bottom + gap)}px`;
}

export function showShapePicker(anchorEl: HTMLElement, opts: ShapePickerOptions): void {
  if (currentPicker) {
    const sameAnchor = currentAnchor === anchorEl;
    closePicker();
    if (sameAnchor) return;
  }

  const panel = document.createElement('div');
  panel.className = 'shape-picker';
  panel.id = 'shape-picker';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '도형 선택');

  for (const group of GROUPS) {
    const title = document.createElement('div');
    title.className = 'shape-picker-title';
    title.textContent = group.title;
    panel.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'shape-picker-grid';
    for (const shape of group.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shape-picker-btn';
      btn.title = `${group.title} · ${shape.label}`;
      const icon = document.createElement('span');
      icon.className = 'shape-picker-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = `<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${SHAPE_PATHS[shape.type]}"/></svg>`;
      const label = document.createElement('span');
      label.className = 'shape-picker-label';
      label.textContent = shape.label;
      btn.append(icon, label);
      btn.addEventListener('click', () => {
        closePicker();
        opts.onSelect(shape.type);
      });
      grid.appendChild(btn);
    }
    panel.appendChild(grid);
  }

  document.body.appendChild(panel);
  currentPicker = panel;
  currentAnchor = anchorEl;
  anchorEl.setAttribute('aria-expanded', 'true');
  anchorEl.setAttribute('aria-controls', panel.id);
  positionPicker();
  panel.querySelector<HTMLButtonElement>('.shape-picker-btn')?.focus();

  document.addEventListener('pointerdown', onOutsidePointer, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', positionPicker);
  window.addEventListener('scroll', positionPicker, true);
}
