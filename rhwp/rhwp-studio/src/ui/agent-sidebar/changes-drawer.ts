import './changes-drawer.css';

import { createIcon } from './icons.ts';
import { appendSvgMarkup } from '../dom-utils.ts';
import type { PendingOp } from '../../agent/types.ts';
import type { DiffItem } from '../../compare/types.ts';
import type { VersionCommitView, VersionManagerController, VersionManagerState } from './version-manager.ts';

export interface ChangesDrawerOptions {
  versionController?: VersionManagerController;
  isEditing?: () => boolean;
  onNavigate?: (item: DiffItem) => void;
  onWorkingDiff?: (items: DiffItem[]) => void;
}

export interface ChangesDrawer {
  element: HTMLElement;
  reviewSlot: HTMLElement;
  setCompactHost(host: HTMLElement | null): void;
  setOpen(open: boolean): void;
  refresh(): Promise<void>;
  refreshEditingState(): void;
  dispose(): void;
}

export interface DiffItemSummary {
  additions: number;
  deletions: number;
  nonTextChanges: number;
  itemCount: number;
}

type DiffPiece = { text: string; changed: boolean };
type DiffParts = { before: DiffPiece[]; after: DiffPiece[] };
const expandedLines = new Set<string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

// Keep the full text in the DOM. The six-line preview is only a CSS clamp.
function splitWords(text: string): string[] {
  return text.match(/\s+|[^\s]+/gu) ?? [];
}

function coalesce(tokens: string[], changed: boolean): DiffPiece[] {
  return tokens.length ? [{ text: tokens.join(''), changed }] : [];
}

function inlineParts(before: string, after: string): DiffParts {
  if (before === after) return { before: coalesce([before], false), after: coalesce([after], false) };
  const left = splitWords(before);
  const right = splitWords(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;

  const leftMiddle = left.slice(prefix, left.length - suffix);
  const rightMiddle = right.slice(prefix, right.length - suffix);
  const beforePieces: DiffPiece[] = coalesce(left.slice(0, prefix), false);
  const afterPieces: DiffPiece[] = coalesce(right.slice(0, prefix), false);

  // Large paragraphs stay responsive. Prefix/suffix still mark the exact changed span.
  if (leftMiddle.length * rightMiddle.length > 40_000) {
    beforePieces.push(...coalesce(leftMiddle, true));
    afterPieces.push(...coalesce(rightMiddle, true));
  } else {
    const rows = leftMiddle.length + 1;
    const cols = rightMiddle.length + 1;
    const table = new Uint16Array(rows * cols);
    for (let i = leftMiddle.length - 1; i >= 0; i -= 1) {
      for (let j = rightMiddle.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] = leftMiddle[i] === rightMiddle[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    const append = (list: DiffPiece[], token: string, changed: boolean): void => {
      const last = list[list.length - 1];
      if (last?.changed === changed) last.text += token;
      else list.push({ text: token, changed });
    };
    while (i < leftMiddle.length || j < rightMiddle.length) {
      if (i < leftMiddle.length && j < rightMiddle.length && leftMiddle[i] === rightMiddle[j]) {
        append(beforePieces, leftMiddle[i], false);
        append(afterPieces, rightMiddle[j], false);
        i += 1;
        j += 1;
      } else if (i < leftMiddle.length && (j === rightMiddle.length || table[(i + 1) * cols + j] >= table[i * cols + j + 1])) {
        append(beforePieces, leftMiddle[i], true);
        i += 1;
      } else {
        append(afterPieces, rightMiddle[j], true);
        j += 1;
      }
    }
  }
  beforePieces.push(...coalesce(left.slice(left.length - suffix), false));
  afterPieces.push(...coalesce(right.slice(right.length - suffix), false));
  return { before: beforePieces, after: afterPieces };
}

export function summarizeDiffItems(items: readonly DiffItem[]): DiffItemSummary {
  const summary: DiffItemSummary = { additions: 0, deletions: 0, nonTextChanges: 0, itemCount: items.length };
  for (const item of items) {
    if (item.kind !== 'text') {
      summary.nonTextChanges += 1;
      continue;
    }
    const parts = inlineParts(item.leftPreview, item.rightPreview);
    summary.deletions += Array.from(parts.before.filter((part) => part.changed).map((part) => part.text).join('')).length;
    summary.additions += Array.from(parts.after.filter((part) => part.changed).map((part) => part.text).join('')).length;
  }
  return summary;
}

function isLong(text: string): boolean {
  return text.length > 100 || text.split('\n').length > 5;
}

function diffLine(sign: '+' | '−' | '·', pieces: DiffPiece[], key?: string): HTMLElement {
  const row = el('div', `ag-changes-line ag-changes-line-${sign === '+' ? 'add' : sign === '−' ? 'del' : 'neutral'}`);
  row.append(el('span', 'ag-changes-sign', sign));
  const content = el('div', 'ag-changes-line-content');
  const text = pieces.map((part) => part.text).join('');
  if (!text) {
    content.append(el('span', 'ag-changes-empty-text', '빈 내용'));
  } else {
    for (const part of pieces) {
      const span = el('span', part.changed ? 'ag-changes-word-change' : '', part.text);
      content.append(span);
    }
  }
  row.append(content);
  if (isLong(text)) {
    if (key && expandedLines.has(key)) row.classList.add('ag-expanded');
    const expand = el('button', 'ag-changes-expand', row.classList.contains('ag-expanded') ? '접기' : '더 보기');
    expand.type = 'button';
    if (key) expand.dataset.lineKey = key;
    expand.setAttribute('aria-expanded', String(row.classList.contains('ag-expanded')));
    expand.addEventListener('click', () => {
      const expanded = row.classList.toggle('ag-expanded');
      if (key) {
        if (expanded) {
          expandedLines.add(key);
          if (expandedLines.size > 200) expandedLines.delete(expandedLines.values().next().value!);
        }
        else expandedLines.delete(key);
      }
      expand.textContent = expanded ? '접기' : '더 보기';
      expand.setAttribute('aria-expanded', String(expanded));
    });
    row.append(expand);
  }
  return row;
}

function pendingAddress(op: PendingOp): string {
  if (op.kind === 'field') return op.name;
  if (op.kind === 'template') return op.label;
  if (op.kind === 'object') {
    const obj = op.obj;
    const para = 'tableParaIdx' in obj ? obj.tableParaIdx : 'paraIdx' in obj ? obj.paraIdx
      : obj.type === 'engineBatch' ? obj.touched[0]?.paraStart ?? null : null;
    const cell = 'cellIdx' in obj && typeof obj.cellIdx === 'number' ? ` · ${obj.cellIdx + 1}셀` : '';
    return `${para === null ? '문서' : `${para + 1}문단`}${cell}`;
  }
  const range = op.range;
  const cell = range.cell ? `${range.cell.cellIdx + 1}셀 · ` : '';
  return `${cell}${range.startParaIdx + 1}문단${range.startParaIdx === range.endParaIdx ? '' : `–${range.endParaIdx + 1}문단`}`;
}

/** Icon-only jump button. The label stays available to screen readers and on hover. */
export function createJumpButton(label: string, className = ''): HTMLButtonElement {
  const button = el('button', `ag-changes-text-button ag-changes-go${className ? ` ${className}` : ''}`);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(createIcon('jump'));
  return button;
}

/** Section headings only earn their space when changes span several sections. */
function needsSectionHeadings(sections: readonly (number | null)[]): boolean {
  return sections.length > 1 || (sections.length === 1 && sections[0] !== 0);
}

const SHAPE_LABELS = { line: '선', rectangle: '사각형', ellipse: '타원', textBox: '글상자' } as const;

function pendingObjectDetail(op: PendingOp): string {
  if (op.kind === 'template') return `템플릿 ${op.label}`;
  if (op.kind === 'format') {
    const names: Record<string, string> = { bold: '굵게', italic: '기울임', underline: '밑줄', strikethrough: '취소선', fontSize: '글자 크기', textColor: '글자 색', fontId: '글꼴' };
    const detail = Object.entries(op.format).map(([name, value]) => {
      if (name === 'fontId') return '글꼴 변경';
      if (name === 'fontSize' && typeof value === 'number') return `글자 크기 ${value / 100}pt`;
      return `${names[name] ?? name} ${typeof value === 'boolean' ? value ? '적용' : '해제' : value}`;
    }).join(' · ');
    return `글자 서식${detail ? ` · ${detail}` : ''}`;
  }
  if (op.kind !== 'object') return '';
  const obj = op.obj;
  switch (obj.type) {
    case 'createTable': return `표 삽입 · ${obj.rows}행 × ${obj.cols}열`;
    case 'insertImage': return `그림 삽입${obj.description ? ` · ${obj.description}` : ''}`;
    case 'insertEquation': return `수식 삽입 · ${obj.script}`;
    case 'insertShape': return `도형 삽입 · ${SHAPE_LABELS[obj.shape]}`;
    case 'editObject': return `${obj.kind === 'picture' ? '그림' : '도형'} 배치 변경`;
    case 'deleteObject': return `${obj.kind === 'picture' ? '그림' : '도형'} 삭제`;
    case 'tableStructure': return `표 ${({
      insert_row: '행 삽입', insert_col: '열 삽입', delete_row: '행 삭제',
      delete_col: '열 삭제', merge_cells: '셀 병합', split_cell: '셀 나누기',
    } as const)[obj.op]}`;
    case 'deleteTable': return `표 삭제 · ${obj.dims.rowCount}행 × ${obj.dims.colCount}열`;
    case 'setCellProps': return '셀 속성 변경';
    case 'setTableProps': return '표 속성 변경';
    case 'setColumnWidths': return '열 너비 변경';
    case 'fitToPage': return '표를 쪽 너비에 맞춤';
    case 'setZoneProps': return '셀 테두리·배경 변경';
    case 'applyFormula': return `표 계산식 · ${obj.formula}`;
    case 'setCaption': return `표 캡션 · ${obj.text}`;
    case 'paraFormat': return '문단 서식 변경';
    case 'applyStyle': return '문단 스타일 적용';
    case 'pageLayout': return '쪽 설정 변경';
    case 'engineBatch': return `엔진 편집 ${obj.methods.length}개 · ${[...new Set(obj.methods)].slice(0, 3).join(', ')}`;
    case 'headerFooter': {
      const kind = obj.isHeader ? '머리말' : '꼬리말';
      const preview = obj.lines.filter((line) => line.length > 0).join(' / ');
      return `${kind} ${obj.existedBefore ? '변경' : '삽입'}${preview ? ` · ${preview}` : ''}`;
    }
    case 'insertNote': return `${obj.noteKind === 'endnote' ? '미주' : '각주'} 삽입 · ${obj.text}`;
    case 'setNoteText': return `각주/미주 변경 · ${obj.text}`;
    case 'bookmark': {
      const label = ({ add: '추가', delete: '삭제', rename: '이름 변경' } as const)[obj.op];
      const name = obj.name ?? obj.prev?.name;
      return `책갈피 ${label}${name ? ` · ${name}` : ''}`;
    }
    default: return '개체 변경';
  }
}

/** Full pending operation diff shared by the latest-turn review and drawer. */
export function renderPendingOpDiff(op: PendingOp, imageUrls?: Map<string, string>): HTMLElement {
  const item = el('article', 'ag-changes-item ag-changes-pending-item');
  // The address is not shown. It labels the jump button instead.
  item.dataset.location = pendingAddress(op);
  const lines = el('div', 'ag-changes-lines');
  if (op.kind === 'insert') lines.append(diffLine('+', [{ text: op.text, changed: false }], `${op.id}:add`));
  else if (op.kind === 'replace') {
    const parts = inlineParts(op.deletedText, op.text);
    lines.append(diffLine('−', parts.before, `${op.id}:del`));
    if (op.text) lines.append(diffLine('+', parts.after, `${op.id}:add`));
  } else if (op.kind === 'field') {
    const parts = inlineParts(op.oldValue, op.newValue);
    lines.append(diffLine('−', parts.before, `${op.id}:del`), diffLine('+', parts.after, `${op.id}:add`));
  } else {
    lines.append(diffLine('·', [{ text: pendingObjectDetail(op), changed: false }], `${op.id}:ctx`));
    // 행/열/표 삭제 — 지워진 내용을 삭제 줄로 보여 준다.
    if (op.kind === 'object' && 'removedText' in op.obj && op.obj.removedText?.trim()) {
      lines.append(diffLine('−', [{ text: op.obj.removedText, changed: true }], `${op.id}:del`));
    }
    if (op.kind === 'object' && op.obj.type === 'insertImage' && imageUrls) {
      const preview = el('div', 'ag-object-preview ag-image-preview');
      const image = el('img', '');
      let url = imageUrls.get(op.id);
      if (!url) {
        const extension = op.obj.extension.toLowerCase().replace(/^\./, '');
        const mime = extension === 'jpg' ? 'image/jpeg'
          : extension === 'svg' ? 'image/svg+xml' : `image/${extension}`;
        url = URL.createObjectURL(new Blob([new Uint8Array(op.obj.bytes)], { type: mime }));
        imageUrls.set(op.id, url);
      }
      image.src = url;
      image.alt = op.obj.description || '삽입할 그림';
      preview.appendChild(image);
      lines.appendChild(preview);
    } else if (op.kind === 'object' && op.obj.type === 'insertEquation' && op.obj.previewSvg) {
      const preview = el('div', 'ag-object-preview ag-equation-preview');
      preview.setAttribute('role', 'img');
      preview.setAttribute('aria-label', op.obj.script);
      appendSvgMarkup(preview, op.obj.previewSvg);
      lines.appendChild(preview);
    }
  }
  item.append(lines);
  return item;
}

export function renderPendingOpsDiff(
  ops: readonly PendingOp[],
  renderOp: (op: PendingOp) => HTMLElement = renderPendingOpDiff,
): DocumentFragment {
  const groups = new Map<number | null, PendingOp[]>();
  for (const op of ops) {
    const section = 'range' in op ? op.range.sectionIdx
      : op.kind === 'object' ? op.obj.sectionIdx : null;
    const group = groups.get(section) ?? [];
    group.push(op);
    groups.set(section, group);
  }
  const fragment = document.createDocumentFragment();
  const headings = needsSectionHeadings([...groups.keys()]);
  for (const [section, group] of groups) {
    if (headings) fragment.append(el('div', 'ag-changes-group-heading', section === null ? '문서 전체' : `${section + 1}구역`));
    for (const op of group) fragment.append(renderOp(op));
  }
  return fragment;
}

function itemLocation(item: DiffItem): string {
  return item.path.paragraph === undefined ? '' : `${item.path.paragraph + 1}문단`;
}

function summaryFields(value: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of value.matchAll(/([a-z]+)=(?:"([^"]*)"|([^\s]+))/g)) {
    fields[match[1]] = match[2] ?? match[3] ?? '';
  }
  return fields;
}

function readableSize(value?: string): string | null {
  if (!value || value === '(없음)' || value === 'nobox') return null;
  const match = value.match(/^(\d+)x(\d+)$/);
  return match ? `폭 ${match[1]} · 높이 ${match[2]}` : null;
}

function tableCellLines(encoded?: string): string[] {
  if (!encoded || encoded === '(없음)') return [];
  const cells: string[] = [];
  for (const pair of encoded.split('&')) {
    const equal = pair.indexOf('=');
    const address = pair.slice(0, equal);
    const match = address.match(/^r(\d+)c(\d+)$/);
    if (equal < 0 || !match) continue;
    let content = pair.slice(equal + 1);
    try { content = decodeURIComponent(content); } catch { /* Keep malformed legacy previews readable. */ }
    cells.push(`${match[1]}행 ${match[2]}열: ${content || '빈 셀'}`);
  }
  return cells;
}

/** Convert compare-engine control summaries to copy suitable for a document review. */
export function formatDiffPreview(kind: DiffItem['kind'], preview: string): string {
  if (!preview) return '';
  if (kind === 'text') return preview;
  if (kind === 'paragraphMeta') {
    const position = preview.match(/^[AB] idx=(\d+)$/);
    if (position) return `문서의 ${Number(position[1]) + 1}번째 문단`;
    const controls = preview.match(/^controls=(\d+)$/);
    return controls ? `개체 ${controls[1]}개` : preview;
  }
  // New compare snapshots carry the complete text of each changed cell.
  if (kind === 'table' && /^r\d+c\d+: /m.test(preview)) {
    return preview.replace(/^r(\d+)c(\d+): /gm, (_, row: string, col: string) => `${row}행 ${col}열: `);
  }
  const fields = summaryFields(preview);
  const details: string[] = [];
  if (kind === 'table') {
    if (fields.r && fields.c) details.push(`${fields.r}행 × ${fields.c}열`);
    const size = readableSize(fields.box);
    if (size) details.push(size);
    const cells = tableCellLines(fields.cprev);
    if (cells.length) details.push(...cells);
    else if (fields.tprev && fields.tprev !== '(없음)') details.push(`내용: ${fields.tprev}`);
    return details.join('\n') || '표 속성 변경';
  }
  const size = readableSize(fields.box);
  if (size) details.push(size);
  if (fields.text && fields.text !== '(없음)') details.push(`설명: ${fields.text}`);
  if (fields.crop && fields.crop !== '(없음)') details.push(`자르기: ${fields.crop}`);
  if (fields.effect && fields.effect !== '(없음)') details.push(`효과: ${fields.effect}`);
  if (fields.rot && fields.rot !== '(없음)') details.push(`회전: ${fields.rot}°`);
  if (fields.flip && fields.flip !== '(없음)') details.push(`대칭: ${fields.flip}`);
  if (fields.wrap && fields.wrap !== '(없음)') details.push(`배치: ${fields.wrap}`);
  if (details.length) return details.join('\n');
  // A changed image hash can be the only signal when its description is unchanged.
  if (fields.pix) return kind === 'image' ? '그림 데이터' : '도형 데이터';
  return preview.replace(/\b(?:csha|txt|props|pix|sig)=(?:"[^"]*"|\S+)/g, '').trim()
    || '개체 속성 변경';
}

function displayDiffTitle(item: DiffItem): string {
  if ((item.kind === 'image' || item.kind === 'shape') && item.title.includes('텍스트 변경')) {
    const left = summaryFields(item.leftPreview);
    const right = summaryFields(item.rightPreview);
    if (left.pix && right.pix && left.pix !== right.pix && left.text === right.text) {
      return item.kind === 'image' ? '그림 내용 변경' : '도형 내용 변경';
    }
  }
  return item.title.replace(/\s*\(구역 \d+, 문단 \d+\)$/, '');
}

function renderDiffItem(item: DiffItem, onNavigate?: (item: DiffItem) => void, navigateLabel = '문서에서 보기', navigateDisabled = false, keyPrefix = ''): HTMLElement {
  const card = el('article', 'ag-changes-item');
  const location = itemLocation(item);
  if (onNavigate && (navigateLabel !== '문서에서 보기' || item.severity !== 'removed' || item.contextOnRight || item.rightAnchor)) {
    const jump = createJumpButton(location && navigateLabel === '문서에서 보기' ? `${location}으로 이동` : navigateLabel);
    jump.disabled = navigateDisabled;
    jump.dataset.navigateJump = '';
    if (navigateLabel === '비교에서 보기') jump.dataset.compareJump = '';
    jump.addEventListener('click', () => onNavigate(item));
    card.append(jump);
  }
  const lines = el('div', 'ag-changes-lines');
  let before = formatDiffPreview(item.kind, item.leftPreview);
  let after = formatDiffPreview(item.kind, item.rightPreview);
  if ((item.kind === 'image' || item.kind === 'shape') && before === after
    && summaryFields(item.leftPreview).pix !== summaryFields(item.rightPreview).pix) {
    before = `${before}\n이전 ${item.kind === 'image' ? '그림' : '도형'} 데이터`;
    after = `${after}\n새 ${item.kind === 'image' ? '그림' : '도형'} 데이터`;
  }
  const parts = inlineParts(before, after);
  if (item.severity === 'added') parts.after = [{ text: after, changed: false }];
  if (item.severity === 'removed') parts.before = [{ text: before, changed: false }];
  if (item.leftPreview || item.severity !== 'added') lines.append(diffLine('−', parts.before, `${keyPrefix}${item.id}:del`));
  if (item.rightPreview || item.severity !== 'removed') lines.append(diffLine('+', parts.after, `${keyPrefix}${item.id}:add`));
  if (!lines.childElementCount) lines.append(diffLine('·', [{ text: displayDiffTitle(item), changed: false }]));
  card.append(lines);
  return card;
}

function renderDiffList(items: readonly DiffItem[], onNavigate?: (item: DiffItem) => void, navigateLabel?: string, navigateDisabled = false, keyPrefix = ''): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const sections = new Map<number, DiffItem[]>();
  for (const item of items) {
    const group = sections.get(item.path.section) ?? [];
    group.push(item);
    sections.set(item.path.section, group);
  }
  const sorted = [...sections].sort(([a], [b]) => a - b);
  const headings = needsSectionHeadings(sorted.map(([section]) => section));
  for (const [section, group] of sorted) {
    if (headings) fragment.append(el('div', 'ag-changes-group-heading', `${section + 1}구역`));
    for (const item of group) fragment.append(renderDiffItem(item, onNavigate, navigateLabel, navigateDisabled, keyPrefix));
  }
  return fragment;
}

function stateMessage(state: VersionManagerState): string | null {
  if (!state.documentId) return '열린 문서 없음';
  if (!state.saved) return '문서 저장 필요';
  if (!state.enabled) return '버전 기록 꺼짐';
  return null;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(timestamp);
}

function relativeDate(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat('ko-KR', sameYear ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp);
}

/** `+12 −3 · 개체 1`, colored per part. Zero parts are left out. */
function statsParts(summary: DiffItemSummary): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (summary.additions) parts.push(el('span', 'ag-changes-add', `+${summary.additions.toLocaleString('ko-KR')}`));
  if (summary.deletions) parts.push(el('span', 'ag-changes-del', `−${summary.deletions.toLocaleString('ko-KR')}`));
  if (summary.nonTextChanges) parts.push(el('span', 'ag-changes-obj', `개체 ${summary.nonTextChanges}`));
  if (!parts.length && summary.itemCount) parts.push(el('span', 'ag-changes-obj', `${summary.itemCount}건`));
  return parts;
}

function emptyState(text: string, done = false): HTMLElement {
  const node = el('div', `ag-changes-notice ag-changes-empty${done ? ' ag-changes-done' : ''}`);
  if (done) node.append(createIcon('check', 'ag-changes-empty-icon'));
  node.append(el('span', '', text));
  return node;
}

export function createChangesDrawer(options: ChangesDrawerOptions): ChangesDrawer {
  const controller = options.versionController;
  const root = el('div', 'ag-changes-overlay');
  root.hidden = true;
  const panel = el('section', 'ag-changes-drawer');
  const body = el('div', 'ag-changes-body');

  const latestSection = el('section', 'ag-changes-section ag-changes-latest');
  const latestHeading = el('div', 'ag-changes-section-head');
  latestHeading.append(el('h2', 'ag-changes-section-title', '이번 턴'));
  const reviewSlot = el('div', 'ag-changes-review-slot');
  latestSection.append(latestHeading, reviewSlot);

  const workingSection = el('section', 'ag-changes-section');
  const workingHeading = el('div', 'ag-changes-section-head');
  const workingCount = el('span', 'ag-changes-section-count');
  workingHeading.append(el('h2', 'ag-changes-section-title', '커밋 전'), workingCount);
  const workingNotice = el('div', 'ag-changes-notice');
  const workingList = el('div', 'ag-changes-diff-list');
  const workingActions = el('div', 'ag-changes-working-actions');
  const composer = el('div', 'ag-changes-composer');
  const message = el('input', 'ag-changes-message');
  message.type = 'text';
  message.maxLength = 160;
  message.placeholder = '커밋 메시지';
  message.setAttribute('aria-label', '커밋 메시지');
  message.enterKeyHint = 'done';
  const commit = el('button', 'ag-changes-primary', '커밋');
  commit.type = 'button';
  composer.append(message, commit);
  const discard = el('button', 'ag-changes-danger');
  discard.type = 'button';
  discard.title = '모두 되돌리기';
  discard.setAttribute('aria-label', '모두 되돌리기');
  discard.append(createIcon('undo'));
  const discardConfirm = el('div', 'ag-changes-confirm');
  discardConfirm.hidden = true;
  discardConfirm.append(el('span', '', '모두 되돌릴까요?'));
  const cancelDiscard = el('button', 'ag-changes-text-button', '취소');
  cancelDiscard.type = 'button';
  const confirmDiscard = el('button', 'ag-changes-danger-solid', '되돌리기');
  confirmDiscard.type = 'button';
  discardConfirm.append(cancelDiscard, confirmDiscard);
  workingActions.append(composer, discard, discardConfirm);
  workingSection.append(workingHeading, workingActions, workingNotice, workingList);

  const historySection = el('section', 'ag-changes-section ag-changes-history');
  const historyHeading = el('div', 'ag-changes-section-head');
  historyHeading.append(el('h2', 'ag-changes-section-title', '커밋'));
  const historyList = el('div', 'ag-changes-history-list');
  historySection.append(historyHeading, historyList);
  body.append(latestSection, workingSection, historySection);
  panel.append(body);
  root.append(panel);

  let disposed = false;
  let open = false;
  let busy = false;
  let loading = false;
  let workingItems: DiffItem[] = [];
  let workingError: string | null = null;
  let serial = 0;
  let expandedCommitId: string | null = null;
  let commitDiff: DiffItem[] | null = null;
  let commitError: string | null = null;
  let commitLoading = false;
  let commitSerial = 0;
  let animateDetail = false;
  let flashCommitId: string | null = null;
  let currentDocumentId = controller?.getState().documentId ?? null;
  const stateSignature = (state: VersionManagerState): string =>
    [state.documentId, state.saved, state.enabled, state.dirty, state.activeBranch,
      state.branches.find((branch) => branch.isActive)?.headId,
      state.commits.slice(0, 12).map((commit) => `${commit.id}:${commit.title}`).join(',')].join('|');
  let stateKey = controller ? stateSignature(controller.getState()) : '';
  const commitCache = new Map<string, Promise<DiffItem[]>>();
  const commitSummaries = new Map<string, DiffItemSummary>();
  const commitFailures = new Set<string>();
  let statsGeneration = 0;
  let statsLoop: Promise<void> | null = null;

  const isLocked = (): boolean => busy || Boolean(options.isEditing?.()) || Boolean(controller?.getState().mutationBlockedReason);

  function renderWorking(): void {
    const state = controller?.getState();
    const unavailable = !state || stateMessage(state);
    const summary = summarizeDiffItems(workingItems);
    workingCount.replaceChildren(...(!unavailable && !loading && summary.itemCount ? statsParts(summary) : []));
    workingNotice.hidden = false;
    // A lone "no document" message belongs to the whole drawer, not to one section.
    historySection.hidden = Boolean(unavailable);
    if (!state) workingNotice.replaceChildren(emptyState('버전 기록 사용 불가'));
    else if (stateMessage(state)) workingNotice.replaceChildren(emptyState(stateMessage(state)!));
    else if (loading && !workingItems.length) workingNotice.replaceChildren(emptyState('불러오는 중…'));
    else if (workingError) {
      const notice = emptyState(workingError);
      notice.classList.add('ag-changes-error');
      const retry = el('button', 'ag-changes-text-button', '다시 시도');
      retry.type = 'button';
      retry.addEventListener('click', () => void refresh());
      notice.append(retry);
      workingNotice.replaceChildren(notice);
    } else if (!workingItems.length) workingNotice.replaceChildren(state.dirty
      ? emptyState('서식·설정 변경') : emptyState('모두 커밋됨', true));
    else workingNotice.hidden = true;
    const focusedLine = workingList.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.lineKey : undefined;
    workingList.replaceChildren();
    // Keep the previous list while a refresh is in flight so rows do not blink.
    workingList.classList.toggle('ag-changes-stale', loading);
    if (!unavailable && !workingError) workingList.append(renderDiffList(workingItems, options.onNavigate, undefined, isLocked(), 'working:'));
    if (focusedLine) {
      const next = Array.from(workingList.querySelectorAll<HTMLButtonElement>('[data-line-key]'))
        .find((button) => button.dataset.lineKey === focusedLine);
      next?.focus({ preventScroll: true });
    }
    workingActions.hidden = Boolean(unavailable) || Boolean(workingError) || (!workingItems.length && !state?.dirty);
    composer.hidden = !discardConfirm.hidden;
    discard.hidden = !discardConfirm.hidden;
    commit.disabled = isLocked();
    discard.disabled = isLocked();
    confirmDiscard.disabled = isLocked();
    message.disabled = isLocked();
    if (state?.mutationBlockedReason && workingItems.length && !unavailable) {
      workingNotice.hidden = false;
      workingNotice.replaceChildren(emptyState(state.mutationBlockedReason));
    }
  }

  function fillStats(node: HTMLElement, id: string): void {
    const summary = commitSummaries.get(id);
    node.classList.toggle('ag-pending', !summary && !commitFailures.has(id));
    node.title = commitFailures.has(id) ? '변경 확인 실패' : '';
    node.replaceChildren(...(summary ? statsParts(summary) : commitFailures.has(id) ? [el('span', '', '—')] : []));
  }

  function renderHistory(): void {
    const state = controller?.getState();
    const focusedCommit = historyList.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.commitId : undefined;
    historyList.replaceChildren();
    if (!state || stateMessage(state)) return;
    const commits = state.commits.slice(0, 12);
    if (!commits.length) {
      historyList.append(emptyState(state.loading ? '불러오는 중…' : '커밋 없음'));
      return;
    }
    const now = Date.now();
    for (const entry of commits) {
      const expanded = expandedCommitId === entry.id;
      const row = el('article', 'ag-changes-commit');
      if (expanded) row.classList.add('ag-open');
      if (entry.id === flashCommitId) {
        row.classList.add('ag-changes-commit-new');
        flashCommitId = null;
      }
      const toggle = el('button', 'ag-changes-commit-toggle');
      toggle.type = 'button';
      toggle.dataset.commitId = entry.id;
      toggle.setAttribute('aria-expanded', String(expanded));
      const copy = el('span', 'ag-changes-commit-copy');
      const meta = el('span', 'ag-changes-commit-meta');
      const date = el('span', '', relativeDate(entry.createdAt, now));
      date.title = formatDate(entry.createdAt);
      meta.append(el('span', 'ag-changes-commit-hash', entry.shortId), date);
      copy.append(el('span', 'ag-changes-commit-title', entry.title), meta);
      const stats = el('span', 'ag-changes-commit-stats');
      fillStats(stats, entry.id);
      toggle.append(el('span', 'ag-changes-commit-dot'), copy, stats);
      toggle.addEventListener('click', () => {
        if (expandedCommitId === entry.id) {
          expandedCommitId = null;
          commitSerial += 1;
          renderHistory();
        } else void expandCommit(entry);
      });
      row.append(toggle);
      if (expanded) {
        const detail = el('div', 'ag-changes-commit-detail');
        if (animateDetail) {
          detail.classList.add('ag-enter');
          if (!commitLoading) animateDetail = false;
        }
        const compare = el('button', 'ag-changes-secondary', '현재와 비교');
        compare.type = 'button';
        compare.disabled = isLocked();
        compare.addEventListener('click', () => void perform(async () => controller!.compare(entry.id)));
        detail.append(compare);
        if (commitLoading) detail.append(emptyState('불러오는 중…'));
        else if (commitError) {
          const notice = emptyState(commitError);
          notice.classList.add('ag-changes-error');
          const retry = el('button', 'ag-changes-text-button', '다시 시도');
          retry.type = 'button';
          retry.addEventListener('click', () => void expandCommit(entry));
          notice.append(retry);
          detail.append(notice);
        } else if (commitDiff?.length) {
          const list = el('div', 'ag-changes-commit-diff');
          list.append(renderDiffList(commitDiff,
            () => void perform(() => controller!.compare(entry.id)), '비교에서 보기', isLocked(), `commit:${entry.id}:`));
          detail.append(list);
        } else detail.append(emptyState(entry.parentIds.length ? '표시할 변경 없음' : '첫 커밋'));
        row.append(detail);
      }
      historyList.append(row);
    }
    if (focusedCommit) {
      const next = Array.from(historyList.querySelectorAll<HTMLButtonElement>('[data-commit-id]'))
        .find((button) => button.dataset.commitId === focusedCommit);
      next?.focus({ preventScroll: true });
    }
  }

  function getCommitDiff(id: string): Promise<DiffItem[]> {
    if (!controller) return Promise.resolve([]);
    const cached = commitCache.get(id);
    if (cached) return cached;
    const docId = controller.getState().documentId;
    const request = controller.diffCommit(id).then((items) => {
      if (!disposed && controller.getState().documentId === docId) commitSummaries.set(id, summarizeDiffItems(items));
      return items;
    }).catch((error: unknown) => {
      commitCache.delete(id);
      throw error;
    });
    commitCache.set(id, request);
    return request;
  }

  function startStatsLoop(): void {
    if (statsLoop || disposed || !open || loading || !controller) return;
    const generation = statsGeneration;
    const documentId = controller.getState().documentId;
    statsLoop = (async () => {
      for (const entry of controller.getState().commits.slice(0, 12)) {
        if (disposed || !open || generation !== statsGeneration || controller.getState().documentId !== documentId) return;
        if (commitSummaries.has(entry.id) || commitFailures.has(entry.id)) continue;
        try {
          await getCommitDiff(entry.id);
        } catch {
          commitFailures.add(entry.id);
        }
        if (disposed || generation !== statsGeneration) return;
        const row = Array.from(historyList.querySelectorAll<HTMLElement>('.ag-changes-commit'))
          .find((node) => node.querySelector<HTMLButtonElement>('.ag-changes-commit-toggle')?.dataset.commitId === entry.id);
        const stats = row?.querySelector<HTMLElement>('.ag-changes-commit-stats');
        if (stats) fillStats(stats, entry.id);
        // Let clicks enqueue mutations before the next historical comparison.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    })().finally(() => {
      statsLoop = null;
      if (!disposed && open && generation !== statsGeneration) startStatsLoop();
    });
  }

  async function expandCommit(entry: VersionCommitView): Promise<void> {
    if (!controller) return;
    const docId = controller.getState().documentId;
    const request = ++commitSerial;
    if (expandedCommitId !== entry.id) animateDetail = true;
    expandedCommitId = entry.id;
    commitDiff = null;
    commitError = null;
    commitLoading = true;
    commitFailures.delete(entry.id);
    renderHistory();
    try {
      const items = await getCommitDiff(entry.id);
      if (disposed || request !== commitSerial || controller.getState().documentId !== docId) return;
      commitDiff = items;
    } catch (error) {
      if (disposed || request !== commitSerial || controller.getState().documentId !== docId) return;
      commitError = error instanceof Error ? error.message : String(error);
      commitFailures.add(entry.id);
    } finally {
      if (request === commitSerial && !disposed) {
        commitLoading = false;
        renderHistory();
      }
    }
  }

  async function perform(action: () => Promise<void>): Promise<void> {
    if (!controller || isLocked()) return;
    const docId = controller.getState().documentId;
    busy = true;
    workingError = null;
    renderWorking();
    renderHistory();
    try {
      await action();
      if (controller.getState().documentId !== docId) return;
      await refresh();
    } catch (error) {
      if (controller.getState().documentId !== docId) return;
      workingError = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      discardConfirm.hidden = true;
      renderWorking();
      renderHistory();
    }
  }

  async function refresh(): Promise<void> {
    const request = ++serial;
    const state = controller?.getState();
    const documentId = state?.documentId ?? null;
    if (!controller || !state || stateMessage(state)) {
      workingItems = [];
      workingError = null;
      loading = false;
      options.onWorkingDiff?.([]);
      renderWorking();
      renderHistory();
      return;
    }
    loading = true;
    workingError = null;
    renderWorking();
    try {
      const items = await controller.diffWorkingTree();
      if (disposed || request !== serial || controller.getState().documentId !== documentId) return;
      workingItems = items;
      options.onWorkingDiff?.(items);
    } catch (error) {
      if (disposed || request !== serial || controller.getState().documentId !== documentId) return;
      workingItems = [];
      options.onWorkingDiff?.([]);
      workingError = error instanceof Error ? error.message : String(error);
    } finally {
      if (!disposed && request === serial) {
        loading = false;
        renderWorking();
        startStatsLoop();
      }
    }
  }

  function onState(state: VersionManagerState): void {
    if (disposed) return;
    const nextKey = stateSignature(state);
    if (state.documentId !== currentDocumentId) {
      currentDocumentId = state.documentId;
      serial += 1;
      commitSerial += 1;
      workingItems = [];
      expandedCommitId = null;
      commitDiff = null;
      commitCache.clear();
      commitSummaries.clear();
      commitFailures.clear();
      expandedLines.clear();
      options.onWorkingDiff?.([]);
    }
    if (nextKey !== stateKey) {
      stateKey = nextKey;
      statsGeneration += 1;
      renderHistory();
      void refresh();
    } else {
      refreshEditingState();
    }
  }

  function refreshEditingState(): void {
    const locked = isLocked();
    commit.disabled = locked;
    discard.disabled = locked;
    confirmDiscard.disabled = locked;
    message.disabled = locked;
    for (const button of historyList.querySelectorAll<HTMLButtonElement>('.ag-changes-secondary')) button.disabled = locked;
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-navigate-jump]')) button.disabled = locked;
  }

  function setOpen(next: boolean): void {
    if (disposed || open === next) return;
    open = next;
    root.hidden = !next;
    if (next) {
      renderHistory();
      void refresh();
    } else {
      statsGeneration += 1;
    }
  }

  commit.addEventListener('click', () => void perform(async () => {
    const documentId = controller!.getState().documentId;
    const draft = message.value;
    await controller!.checkpoint(draft.trim() || undefined);
    if (controller!.getState().documentId !== documentId) return;
    flashCommitId = controller!.getState().commits[0]?.id ?? null;
    if (message.value === draft) message.value = '';
  }));
  message.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || commit.disabled) return;
    event.preventDefault();
    commit.click();
  });
  const setConfirming = (confirming: boolean): void => {
    discardConfirm.hidden = !confirming;
    composer.hidden = confirming;
    discard.hidden = confirming;
    (confirming ? confirmDiscard : discard).focus();
  };
  discard.addEventListener('click', () => setConfirming(true));
  cancelDiscard.addEventListener('click', () => setConfirming(false));
  discardConfirm.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); setConfirming(false); }
  });
  confirmDiscard.addEventListener('click', () => void perform(() => controller!.discardUncommitted()));
  const unsubscribe = controller?.subscribe(onState);
  renderWorking();
  renderHistory();

  return {
    element: root,
    reviewSlot,
    setCompactHost(host) {
      if (disposed) return;
      if (host) host.appendChild(workingSection);
      else body.insertBefore(workingSection, historySection);
    },
    setOpen,
    refresh,
    refreshEditingState,
    dispose() {
      if (disposed) return;
      disposed = true;
      serial += 1;
      commitSerial += 1;
      statsGeneration += 1;
      expandedLines.clear();
      unsubscribe?.();
      root.remove();
    },
  };
}
