import type { MergeConflict } from '../versioning/types.ts';
import { mergeChoiceLabel, mergeErrorMessage, mergeTokenLabel } from './merge-labels.ts';

export type ManualEditorFamily =
  | 'rich-text'
  | 'table'
  | 'shape-chart'
  | 'image'
  | 'document-properties'
  | 'typed-value';

export interface ManualConflictEditorOptions {
  conflict: MergeConflict;
  initialValue: unknown;
  onResolve(payload: unknown): void;
  onChooseSide?(side: 'current' | 'incoming'): void;
  uploadAsset?(file: File, conflict: MergeConflict): Promise<unknown>;
}

type ValuePath = readonly (string | number)[];

interface EditableLeaf {
  path: ValuePath;
  value: string | number | boolean | null;
}

interface CollectedLeaves {
  leaves: EditableLeaf[];
  truncated: boolean;
}

const MAX_EDITABLE_LEAVES = 200;
const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/webp',
]);

const TABLE_OPERATIONS = [
  'insert-row',
  'delete-row',
  'insert-column',
  'delete-column',
  'merge-cells',
  'split-cell',
];

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectLeaves(value: unknown): CollectedLeaves {
  const leaves: EditableLeaf[] = [];
  let truncated = false;

  const visit = (child: unknown, path: (string | number)[]): void => {
    if (child instanceof ArrayBuffer || ArrayBuffer.isView(child)) return;
    if (child === null || ['string', 'number', 'boolean'].includes(typeof child)) {
      if (leaves.length >= MAX_EDITABLE_LEAVES) {
        truncated = true;
        return;
      }
      leaves.push({ path, value: child as EditableLeaf['value'] });
      return;
    }
    if (Array.isArray(child)) {
      for (let index = 0; index < child.length && !truncated; index += 1) {
        visit(child[index], [...path, index]);
      }
      return;
    }
    if (isRecord(child)) {
      for (const key of Object.keys(child).sort()) {
        visit(child[key], [...path, key]);
        if (truncated) break;
      }
    }
  };

  visit(value, []);
  return { leaves, truncated };
}

function pathLabel(path: ValuePath, fallback: string): string {
  if (path.length === 0) return fallback;
  return path.map((part) => (
    typeof part === 'number' ? `${part + 1}번` : mergeTokenLabel(part, '기타 속성')
  )).join(' / ');
}

function keyAt(path: ValuePath): string {
  return String(path.at(-1) ?? '').toLowerCase();
}

function setAtPath(root: unknown, path: ValuePath, value: unknown): unknown {
  if (path.length === 0) return value;
  let cursor = root as Record<string | number, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor = cursor[path[index]!] as Record<string | number, unknown>;
  }
  cursor[path.at(-1)!] = value;
  return root;
}

function readControl(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, original: EditableLeaf['value']): unknown {
  if (typeof original === 'boolean' && control instanceof HTMLInputElement) return control.checked;
  if (typeof original === 'number') {
    const value = control.value.trim();
    if (!value) throw new Error('올바른 숫자를 입력하세요.');
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error('올바른 숫자를 입력하세요.');
    return parsed;
  }
  if (original === null) {
    const normalized = control.value.trim();
    if (normalized === '' || normalized === 'null' || normalized === '없음') return null;
    return normalized;
  }
  return control.value;
}

function textAreaKey(key: string): boolean {
  return /text|content|formula|script|description|title|label/.test(key);
}

function selectValues(family: ManualEditorFamily, key: string, value: string): string[] | null {
  if (family === 'rich-text' && /align/.test(key)) {
    return [...new Set([value, 'left', 'center', 'right', 'justify'])];
  }
  if (family === 'table' && /operation|structuralop|action/.test(key)) {
    return [...new Set([value, ...TABLE_OPERATIONS])];
  }
  if (family === 'document-properties' && /direction/.test(key)) {
    return [...new Set([value, 'horizontal', 'vertical', 'left-to-right', 'right-to-left'])];
  }
  return null;
}

function createLeafControl(
  family: ManualEditorFamily,
  leaf: EditableLeaf,
  fallbackLabel: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const key = keyAt(leaf.path);
  if (typeof leaf.value === 'boolean') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = leaf.value;
    input.setAttribute('aria-label', pathLabel(leaf.path, fallbackLabel));
    return input;
  }
  if (typeof leaf.value === 'string') {
    const choices = selectValues(family, key, leaf.value);
    if (choices) {
      const select = document.createElement('select');
      for (const choice of choices) select.appendChild(new Option(choice ? mergeChoiceLabel(choice) : '(비어 있음)', choice));
      select.value = leaf.value;
      select.setAttribute('aria-label', pathLabel(leaf.path, fallbackLabel));
      return select;
    }
    if (textAreaKey(key) || (leaf.path.length === 0 && family === 'rich-text')) {
      const textarea = document.createElement('textarea');
      textarea.rows = /formula|script/.test(key) ? 3 : 5;
      textarea.value = leaf.value;
      textarea.setAttribute('aria-label', pathLabel(leaf.path, fallbackLabel));
      return textarea;
    }
  }
  const input = document.createElement('input');
  input.type = typeof leaf.value === 'number' ? 'number' : 'text';
  input.value = leaf.value === null ? '없음' : String(leaf.value);
  input.setAttribute('aria-label', pathLabel(leaf.path, fallbackLabel));
  return input;
}

function familyLegend(family: ManualEditorFamily): string {
  switch (family) {
    case 'rich-text': return '글과 서식';
    case 'table': return '표 셀, 구조, 수식';
    case 'shape-chart': return '도형, 차트, 개체 속성';
    case 'image': return '이미지와 배치 속성';
    case 'document-properties': return '문서 속성';
    default: return '직접 값 편집';
  }
}

function familyHint(family: ManualEditorFamily): string {
  switch (family) {
    case 'rich-text': return '주변 문단 구조를 유지하면서 글과 서식을 편집합니다.';
    case 'table': return '셀, 수식, 크기, 병합 범위 또는 표 구조 작업을 편집합니다.';
    case 'shape-chart': return '크기, 위치, 모양, 축, 계열 또는 개체 속성을 편집합니다.';
    case 'image': return '이미지 속성과 배치를 편집하거나 한쪽 이미지를 선택하거나 새 이미지를 올립니다.';
    case 'document-properties': return '구역, 스타일, 번호, 필드, 양식, 책갈피 또는 리소스 속성을 편집합니다.';
    default: return '원래 자료형을 유지하면서 값을 편집합니다.';
  }
}

function excludedLeaf(family: ManualEditorFamily, leaf: EditableLeaf): boolean {
  const key = keyAt(leaf.path);
  if (family === 'image' && /bytesbase64|bytes|data/.test(key)) return true;
  return false;
}

function tableCellPosition(leaf: EditableLeaf): { row: number; column: number } | null {
  if (leaf.path[0] !== 'cells') return null;
  const row = leaf.path[1];
  const column = leaf.path[2];
  if (typeof row !== 'number' || typeof column !== 'number') return null;
  const property = String(leaf.path[3] ?? 'value').toLowerCase();
  return /value|text|formula|content/.test(property) ? { row, column } : null;
}

export function manualEditorFamily(kind: string): ManualEditorFamily {
  const normalized = kind.toLowerCase();
  if (/image|picture|crop/.test(normalized)) return 'image';
  if (normalized === 'column-settings') return 'document-properties';
  if (/table|cell|row|column|formula/.test(normalized)) return 'table';
  if (/text|paragraph|formatting|character|line-layout/.test(normalized)) return 'rich-text';
  if (/shape|chart|connector|equation|ole|geometry|transform/.test(normalized)) return 'shape-chart';
  if (/section|column-settings|style|numbering|bullet|field|form|bookmark|resource|font|border|tab-|document-property|memo/.test(normalized)) {
    return 'document-properties';
  }
  return 'typed-value';
}

export function buildManualConflictEditor(options: ManualConflictEditorOptions): HTMLElement | null {
  const { conflict } = options;
  if (conflict.supportsManual === false) return null;
  const family = manualEditorFamily(conflict.kind);
  const section = node('section', `merge-manual-editor merge-manual-family-${family}`);
  section.dataset.editorFamily = family;
  section.append(
    node('h3', '', familyLegend(family)),
    node('p', 'merge-manual-hint', familyHint(family)),
  );

  const error = node('p', 'merge-manual-error');
  error.setAttribute('role', 'alert');
  const collected = collectLeaves(options.initialValue);
  const leaves = collected.leaves.filter((leaf) => !excludedLeaf(family, leaf));
  const controls: Array<{
    leaf: EditableLeaf;
    control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  }> = [];
  let uploadGeneration = 0;

  if (family === 'image') {
    const source = node('fieldset', 'merge-image-source');
    const legend = document.createElement('legend');
    legend.textContent = '이미지 선택';
    source.appendChild(legend);
    for (const [label, side, payload] of [
      ['현재 이미지 선택', 'current', conflict.current],
      ['가져올 이미지 선택', 'incoming', conflict.incoming],
    ] as const) {
      const button = node('button', 'merge-secondary-button', label);
      button.type = 'button';
      button.addEventListener('click', () => {
        uploadGeneration += 1;
        if (options.onChooseSide) options.onChooseSide(side);
        else options.onResolve(cloneValue(payload));
      });
      source.appendChild(button);
    }
    const uploadLabel = node('label', 'merge-upload-field');
    uploadLabel.appendChild(node('span', '', '대체 이미지 올리기'));
    const upload = document.createElement('input');
    upload.type = 'file';
    upload.accept = [...ALLOWED_IMAGE_MIME_TYPES].join(',');
    upload.setAttribute('aria-label', '대체 이미지 올리기');
    upload.addEventListener('change', () => {
      const file = upload.files?.[0];
      if (!file) return;
      const generation = ++uploadGeneration;
      void (async () => {
        try {
          if (!ALLOWED_IMAGE_MIME_TYPES.has(file.type.toLowerCase())) {
            throw new Error('PNG, JPEG, GIF, BMP, WEBP 이미지 파일만 올릴 수 있습니다.');
          }
          if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
            throw new Error('이미지는 5MB 이하만 올릴 수 있습니다.');
          }
          const payload = options.uploadAsset
            ? await options.uploadAsset(file, conflict)
            : { name: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
          if (generation !== uploadGeneration || !section.isConnected) return;
          error.textContent = '';
          options.onResolve(payload);
        } catch (cause) {
          if (generation !== uploadGeneration || !section.isConnected) return;
          error.textContent = mergeErrorMessage(cause, '값을 적용하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.');
        }
      })();
    });
    uploadLabel.appendChild(upload);
    source.appendChild(uploadLabel);
    section.appendChild(source);
  }

  const fieldset = node('fieldset', 'merge-structured-fields');
  const legend = document.createElement('legend');
  legend.textContent = familyLegend(family);
  fieldset.appendChild(legend);
  const tableLeaves = family === 'table'
    ? leaves.filter((leaf) => tableCellPosition(leaf) !== null)
    : [];
  if (tableLeaves.length > 0) {
    const grid = node('table', 'merge-table-grid');
    grid.setAttribute('aria-label', '편집 가능한 표 셀');
    const body = document.createElement('tbody');
    const positions = tableLeaves.map((leaf) => tableCellPosition(leaf)!);
    const leavesByPosition = new Map(
      tableLeaves.map((leaf, index) => {
        const { row, column } = positions[index]!;
        return [`${row}:${column}`, leaf] as const;
      }),
    );
    const rowCount = Math.max(...positions.map(({ row }) => row)) + 1;
    const columnCount = Math.max(...positions.map(({ column }) => column)) + 1;
    for (let row = 0; row < rowCount; row += 1) {
      const tr = document.createElement('tr');
      for (let column = 0; column < columnCount; column += 1) {
        const cell = document.createElement('td');
        const leaf = leavesByPosition.get(`${row}:${column}`);
        if (leaf) {
          const label = node('label', 'merge-table-cell-field');
          label.dataset.fieldPath = leaf.path.join('.');
          const caption = node('span', 'merge-visually-hidden', `${row + 1}행 ${column + 1}열`);
          const control = createLeafControl(family, leaf, `${row + 1}행 ${column + 1}열`);
          label.append(caption, control);
          controls.push({ leaf, control });
          cell.appendChild(label);
        }
        tr.appendChild(cell);
      }
      body.appendChild(tr);
    }
    grid.appendChild(body);
    fieldset.appendChild(grid);
  }
  for (const leaf of leaves.filter((candidate) => !tableLeaves.includes(candidate))) {
    const label = node('label', 'merge-structured-field');
    label.dataset.fieldPath = leaf.path.join('.');
    label.appendChild(node('span', '', pathLabel(leaf.path, familyLegend(family))));
    const control = createLeafControl(family, leaf, familyLegend(family));
    label.appendChild(control);
    controls.push({ leaf, control });
    fieldset.appendChild(label);
  }
  if (leaves.length === 0) {
    fieldset.appendChild(node('p', 'merge-manual-hint', '직접 편집할 수 있는 속성이 없습니다. 현재 변경이나 가져올 변경을 선택하세요.'));
  }
  if (collected.truncated) {
    fieldset.appendChild(node('p', 'merge-manual-hint', '속성이 많아 200개 이후 속성은 숨겼습니다.'));
  }

  const apply = node('button', 'merge-secondary-button', '직접 편집 적용');
  apply.type = 'button';
  apply.disabled = controls.length === 0;
  apply.addEventListener('click', () => {
    uploadGeneration += 1;
    try {
      let result = cloneValue(options.initialValue);
      for (const { leaf, control } of controls) {
        result = setAtPath(result, leaf.path, readControl(control, leaf.value));
      }
      options.onResolve(result);
      error.textContent = '';
    } catch (cause) {
      error.textContent = mergeErrorMessage(cause, '값을 적용하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.');
      controls[0]?.control.focus();
    }
  });
  fieldset.append(error, apply);
  section.appendChild(fieldset);
  return section;
}
