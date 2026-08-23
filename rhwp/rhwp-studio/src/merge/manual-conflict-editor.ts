import type { MergeConflict } from '../versioning/types.ts';

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

function collectLeaves(value: unknown, path: (string | number)[] = [], output: EditableLeaf[] = []): EditableLeaf[] {
  if (output.length >= 200 || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return output;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    output.push({ path, value: value as EditableLeaf['value'] });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      if (output.length < 200) collectLeaves(child, [...path, index], output);
    });
    return output;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value).sort()) {
      if (output.length >= 200) break;
      collectLeaves(value[key], [...path, key], output);
    }
  }
  return output;
}

function pathLabel(path: ValuePath, fallback: string): string {
  if (path.length === 0) return fallback;
  return path.map((part) => typeof part === 'number' ? `[${part + 1}]` : part)
    .join(' · ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

function keyAt(path: ValuePath): string {
  return String(path.at(-1) ?? '').toLowerCase();
}

function setAtPath(root: unknown, path: ValuePath, value: unknown): unknown {
  if (path.length === 0) return value;
  const copy = cloneValue(root);
  let cursor = copy as Record<string | number, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor = cursor[path[index]!] as Record<string | number, unknown>;
  }
  cursor[path.at(-1)!] = value;
  return copy;
}

function readControl(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, original: EditableLeaf['value']): unknown {
  if (typeof original === 'boolean' && control instanceof HTMLInputElement) return control.checked;
  if (typeof original === 'number') {
    const parsed = Number(control.value);
    if (!Number.isFinite(parsed)) throw new Error('Enter a valid number.');
    return parsed;
  }
  if (original === null) {
    const normalized = control.value.trim();
    if (normalized === '' || normalized === 'null') return null;
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
      for (const choice of choices) select.appendChild(new Option(choice || '(empty)', choice));
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
  input.value = leaf.value === null ? 'null' : String(leaf.value);
  input.setAttribute('aria-label', pathLabel(leaf.path, fallbackLabel));
  return input;
}

function familyLegend(family: ManualEditorFamily): string {
  switch (family) {
    case 'rich-text': return 'Rich text and formatting';
    case 'table': return 'Table cells, structure, and formulas';
    case 'shape-chart': return 'Shape, chart, and object properties';
    case 'image': return 'Image source, placement, crop, and properties';
    case 'document-properties': return 'Document model properties';
    default: return 'Typed value';
  }
}

function familyHint(family: ManualEditorFamily): string {
  switch (family) {
    case 'rich-text': return 'Edit text and formatting without changing the surrounding paragraph structure.';
    case 'table': return 'Edit individual cells, formulas, dimensions, spans, or an existing structural operation.';
    case 'shape-chart': return 'Edit geometry, placement, styling, axes, series, or embedded object properties.';
    case 'image': return 'Edit image metadata and placement, select either side, or upload complete replacement bytes.';
    case 'document-properties': return 'Edit section, style, numbering, field, form, bookmark, or resource properties.';
    default: return 'Edit this value while preserving its original data type.';
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
  let result = cloneValue(options.initialValue);
  const leaves = collectLeaves(options.initialValue).filter((leaf) => !excludedLeaf(family, leaf));
  const controls: Array<{
    leaf: EditableLeaf;
    control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  }> = [];

  if (family === 'image') {
    const source = node('fieldset', 'merge-image-source');
    const legend = document.createElement('legend');
    legend.textContent = 'Image selection';
    source.appendChild(legend);
    for (const [label, side, payload] of [
      ['Select current image', 'current', conflict.current],
      ['Select incoming image', 'incoming', conflict.incoming],
    ] as const) {
      const button = node('button', 'merge-secondary-button', label);
      button.type = 'button';
      button.addEventListener('click', () => {
        if (options.onChooseSide) options.onChooseSide(side);
        else options.onResolve(cloneValue(payload));
      });
      source.appendChild(button);
    }
    const uploadLabel = node('label', 'merge-upload-field');
    uploadLabel.appendChild(node('span', '', 'Upload replacement image'));
    const upload = document.createElement('input');
    upload.type = 'file';
    upload.accept = 'image/*';
    upload.setAttribute('aria-label', 'Upload replacement image');
    upload.addEventListener('change', () => {
      const file = upload.files?.[0];
      if (!file) return;
      void (async () => {
        try {
          const payload = options.uploadAsset
            ? await options.uploadAsset(file, conflict)
            : { name: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
          options.onResolve(payload);
          error.textContent = '';
        } catch (cause) {
          error.textContent = cause instanceof Error ? cause.message : String(cause);
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
    grid.setAttribute('aria-label', 'Editable table cell grid');
    const body = document.createElement('tbody');
    const positions = tableLeaves.map((leaf) => tableCellPosition(leaf)!);
    const rowCount = Math.max(...positions.map(({ row }) => row)) + 1;
    const columnCount = Math.max(...positions.map(({ column }) => column)) + 1;
    for (let row = 0; row < rowCount; row += 1) {
      const tr = document.createElement('tr');
      for (let column = 0; column < columnCount; column += 1) {
        const cell = document.createElement('td');
        const leaf = tableLeaves.find((candidate) => {
          const position = tableCellPosition(candidate);
          return position?.row === row && position.column === column;
        });
        if (leaf) {
          const label = node('label', 'merge-table-cell-field');
          label.dataset.fieldPath = leaf.path.join('.');
          const caption = node('span', 'merge-visually-hidden', `Row ${row + 1}, column ${column + 1}`);
          const control = createLeafControl(family, leaf, `Row ${row + 1}, column ${column + 1}`);
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
    fieldset.appendChild(node('p', 'merge-manual-hint', 'This value has no editable scalar properties. Choose Current or Incoming.'));
  }

  const apply = node('button', 'merge-secondary-button', `Apply ${familyLegend(family).toLowerCase()}`);
  apply.type = 'button';
  apply.disabled = controls.length === 0;
  apply.addEventListener('click', () => {
    try {
      result = cloneValue(options.initialValue);
      for (const { leaf, control } of controls) {
        result = setAtPath(result, leaf.path, readControl(control, leaf.value));
      }
      options.onResolve(result);
      error.textContent = '';
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause);
      controls[0]?.control.focus();
    }
  });
  fieldset.append(error, apply);
  section.appendChild(fieldset);
  return section;
}
