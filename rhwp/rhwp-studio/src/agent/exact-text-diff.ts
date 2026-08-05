import type { DocRange } from './types.ts';

export const EXACT_DIFF_STEP_BUDGET = 250_000;

export interface ExactDiffHunk {
  kind: 'insert' | 'delete' | 'replace';
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  oldText: string;
  newText: string;
  fallback: boolean;
}

export interface ExactDiffResult {
  hunks: ExactDiffHunk[];
  exceededBudget: boolean;
  stepsUsed: number;
}

interface Segment {
  value: string;
  key: string;
  start: number;
  end: number;
}

type SequenceEdit<T> =
  | { kind: 'same'; oldValue: T; newValue: T }
  | { kind: 'delete'; oldValue: T }
  | { kind: 'insert'; newValue: T };

interface DiffBudget {
  remaining: number;
  exceeded: boolean;
}

interface SequenceResult<T> {
  edits: SequenceEdit<T>[];
  fallback: boolean;
}

function scalarLen(text: string): number {
  return [...text].length;
}

function visualKey(text: string): string {
  return text.normalize('NFC');
}

function sequenceDiff<T>(
  before: readonly T[],
  after: readonly T[],
  key: (value: T) => string,
  budget: DiffBudget,
): SequenceResult<T> {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length
    && key(before[prefix]) === key(after[prefix])) prefix++;

  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && key(before[before.length - 1 - suffix]) === key(after[after.length - 1 - suffix])) suffix++;

  const oldMid = before.slice(prefix, before.length - suffix);
  const newMid = after.slice(prefix, after.length - suffix);
  const edits: SequenceEdit<T>[] = [];
  for (let i = 0; i < prefix; i++) {
    edits.push({ kind: 'same', oldValue: before[i], newValue: after[i] });
  }

  const cells = oldMid.length * newMid.length;
  let fallback = false;
  if (cells > budget.remaining) {
    fallback = true;
    budget.exceeded = true;
    for (const value of oldMid) edits.push({ kind: 'delete', oldValue: value });
    for (const value of newMid) edits.push({ kind: 'insert', newValue: value });
  } else if (oldMid.length === 0) {
    for (const value of newMid) edits.push({ kind: 'insert', newValue: value });
  } else if (newMid.length === 0) {
    for (const value of oldMid) edits.push({ kind: 'delete', oldValue: value });
  } else {
    budget.remaining -= cells;
    const width = newMid.length + 1;
    const table = new Uint32Array((oldMid.length + 1) * width);
    for (let i = oldMid.length - 1; i >= 0; i--) {
      for (let j = newMid.length - 1; j >= 0; j--) {
        const idx = i * width + j;
        table[idx] = key(oldMid[i]) === key(newMid[j])
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldMid.length && j < newMid.length) {
      if (key(oldMid[i]) === key(newMid[j])) {
        edits.push({ kind: 'same', oldValue: oldMid[i], newValue: newMid[j] });
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        edits.push({ kind: 'delete', oldValue: oldMid[i++] });
      } else {
        edits.push({ kind: 'insert', newValue: newMid[j++] });
      }
    }
    while (i < oldMid.length) edits.push({ kind: 'delete', oldValue: oldMid[i++] });
    while (j < newMid.length) edits.push({ kind: 'insert', newValue: newMid[j++] });
  }

  for (let i = suffix; i > 0; i--) {
    edits.push({
      kind: 'same',
      oldValue: before[before.length - i],
      newValue: after[after.length - i],
    });
  }
  return { edits, fallback };
}

function fallbackWordSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let offset = 0;
  for (const match of text.matchAll(/\s+|[^\s]+/gu)) {
    const value = match[0];
    const length = scalarLen(value);
    out.push({ value, key: visualKey(value), start: offset, end: offset + length });
    offset += length;
  }
  return out;
}

function wordSegments(text: string): Segment[] {
  if (typeof Intl.Segmenter !== 'function') return fallbackWordSegments(text);
  const segmenter = new Intl.Segmenter('ko', { granularity: 'word' });
  const out: Segment[] = [];
  let offset = 0;
  for (const part of segmenter.segment(text)) {
    const value = part.segment;
    const length = scalarLen(value);
    out.push({ value, key: visualKey(value), start: offset, end: offset + length });
    offset += length;
  }
  return out;
}

function graphemeSegments(text: string): Segment[] {
  const values = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(text)].map((part) => part.segment)
    : [...text];
  const out: Segment[] = [];
  let offset = 0;
  for (const value of values) {
    const length = scalarLen(value);
    out.push({ value, key: visualKey(value), start: offset, end: offset + length });
    offset += length;
  }
  return out;
}

function changedBlocks(
  edits: readonly SequenceEdit<Segment>[],
  onBlock: (
    oldValues: Segment[],
    newValues: Segment[],
    oldCursor: number,
    newCursor: number,
    fallback: boolean,
  ) => void,
  fallback: boolean,
): void {
  let oldValues: Segment[] = [];
  let newValues: Segment[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let blockOldCursor = 0;
  let blockNewCursor = 0;
  const beginBlock = (): void => {
    if (oldValues.length === 0 && newValues.length === 0) {
      blockOldCursor = oldCursor;
      blockNewCursor = newCursor;
    }
  };
  const flush = (): void => {
    if (oldValues.length === 0 && newValues.length === 0) return;
    onBlock(oldValues, newValues, blockOldCursor, blockNewCursor, fallback);
    oldValues = [];
    newValues = [];
  };
  for (const edit of edits) {
    if (edit.kind === 'same') {
      flush();
      oldCursor = edit.oldValue.end;
      newCursor = edit.newValue.end;
    } else if (edit.kind === 'delete') {
      beginBlock();
      oldValues.push(edit.oldValue);
      oldCursor = edit.oldValue.end;
    } else {
      beginBlock();
      newValues.push(edit.newValue);
      newCursor = edit.newValue.end;
    }
  }
  flush();
}

function hunkFromSegments(
  oldValues: readonly Segment[],
  newValues: readonly Segment[],
  oldBase: number,
  newBase: number,
  oldCursor: number,
  newCursor: number,
  fallback: boolean,
): ExactDiffHunk {
  const oldStart = oldValues[0]?.start ?? oldCursor;
  const oldEnd = oldValues.at(-1)?.end ?? oldStart;
  const newStart = newValues[0]?.start ?? newCursor;
  const newEnd = newValues.at(-1)?.end ?? newStart;
  const oldText = oldValues.map((segment) => segment.value).join('');
  const newText = newValues.map((segment) => segment.value).join('');
  return {
    kind: oldValues.length === 0 ? 'insert' : newValues.length === 0 ? 'delete' : 'replace',
    oldStart: oldBase + oldStart,
    oldEnd: oldBase + oldEnd,
    newStart: newBase + newStart,
    newEnd: newBase + newEnd,
    oldText,
    newText,
    fallback,
  };
}

function refineGraphemes(
  oldText: string,
  newText: string,
  oldBase: number,
  newBase: number,
  budget: DiffBudget,
  hunks: ExactDiffHunk[],
): void {
  const oldSegments = graphemeSegments(oldText);
  const newSegments = graphemeSegments(newText);
  const result = sequenceDiff(oldSegments, newSegments, (segment) => segment.key, budget);
  changedBlocks(result.edits, (oldValues, newValues, oldCursor, newCursor, fallback) => {
    hunks.push(hunkFromSegments(
      oldValues, newValues, oldBase, newBase, oldCursor, newCursor, fallback,
    ));
  }, result.fallback);
}

function diffParagraph(
  oldText: string,
  newText: string,
  oldBase: number,
  newBase: number,
  budget: DiffBudget,
  hunks: ExactDiffHunk[],
): void {
  const oldWords = wordSegments(oldText);
  const newWords = wordSegments(newText);
  const result = sequenceDiff(oldWords, newWords, (segment) => segment.key, budget);
  changedBlocks(result.edits, (oldValues, newValues, oldCursor, newCursor) => {
    const blockOld = oldValues.map((segment) => segment.value).join('');
    const blockNew = newValues.map((segment) => segment.value).join('');
    const blockOldBase = oldBase + oldCursor;
    const blockNewBase = newBase + newCursor;
    refineGraphemes(blockOld, blockNew, blockOldBase, blockNewBase, budget, hunks);
  }, result.fallback);
}

function paragraphSegments(text: string): Segment[] {
  const paragraphs = text.split('\n');
  const out: Segment[] = [];
  let offset = 0;
  for (const value of paragraphs) {
    const length = scalarLen(value);
    out.push({ value, key: visualKey(value), start: offset, end: offset + length });
    offset += length + 1;
  }
  return out;
}

/**
 * View-only replacement diff. Offsets are Unicode scalar offsets into the
 * original and replacement strings (including one scalar for each newline).
 */
export function computeExactTextDiff(
  before: string,
  after: string,
  stepBudget: number = EXACT_DIFF_STEP_BUDGET,
): ExactDiffResult {
  if (visualKey(before) === visualKey(after)) {
    return { hunks: [], exceededBudget: false, stepsUsed: 0 };
  }
  const budget: DiffBudget = { remaining: Math.max(0, stepBudget), exceeded: false };
  const oldParagraphs = paragraphSegments(before);
  const newParagraphs = paragraphSegments(after);
  const paragraphResult = sequenceDiff(oldParagraphs, newParagraphs, (segment) => segment.key, budget);
  const hunks: ExactDiffHunk[] = [];

  changedBlocks(paragraphResult.edits, (oldValues, newValues, oldCursor, newCursor, fallback) => {
    if (fallback) {
      const oldStart = oldValues[0]?.start ?? oldCursor;
      const oldEnd = oldValues.at(-1)?.end ?? oldStart;
      const newStart = newValues[0]?.start ?? newCursor;
      const newEnd = newValues.at(-1)?.end ?? newStart;
      hunks.push({
        kind: oldValues.length === 0 ? 'insert' : newValues.length === 0 ? 'delete' : 'replace',
        oldStart,
        oldEnd,
        newStart,
        newEnd,
        oldText: oldValues.map((segment) => segment.value).join('\n'),
        newText: newValues.map((segment) => segment.value).join('\n'),
        fallback: true,
      });
      return;
    }
    const paired = Math.min(oldValues.length, newValues.length);
    for (let i = 0; i < paired; i++) {
      diffParagraph(
        oldValues[i].value,
        newValues[i].value,
        oldValues[i].start,
        newValues[i].start,
        budget,
        hunks,
      );
    }
    if (oldValues.length > paired) {
      const extras = oldValues.slice(paired);
      const boundary = newValues.at(-1)?.end ?? newCursor;
      hunks.push({
        kind: 'delete',
        oldStart: extras[0]?.start ?? oldCursor,
        oldEnd: extras.at(-1)?.end ?? oldCursor,
        newStart: boundary,
        newEnd: boundary,
        oldText: extras.map((segment) => segment.value).join('\n'),
        newText: '',
        fallback: paragraphResult.fallback,
      });
    }
    if (newValues.length > paired) {
      const extras = newValues.slice(paired);
      const boundary = oldValues.at(-1)?.end ?? oldCursor;
      hunks.push({
        kind: 'insert',
        oldStart: boundary,
        oldEnd: boundary,
        newStart: extras[0]?.start ?? newCursor,
        newEnd: extras.at(-1)?.end ?? newCursor,
        oldText: '',
        newText: extras.map((segment) => segment.value).join('\n'),
        fallback: paragraphResult.fallback,
      });
    }
  }, paragraphResult.fallback);

  hunks.sort((a, b) => a.newStart - b.newStart || a.newEnd - b.newEnd || a.oldStart - b.oldStart);
  return {
    hunks,
    exceededBudget: budget.exceeded,
    stepsUsed: Math.max(0, stepBudget) - budget.remaining,
  };
}

export function pointAtNewScalarOffset(
  baseRange: DocRange,
  replacementText: string,
  requestedOffset: number,
): { paraIdx: number; charOffset: number } {
  const limit = scalarLen(replacementText);
  const offset = Math.max(0, Math.min(requestedOffset, limit));
  let paraIdx = baseRange.startParaIdx;
  let charOffset = baseRange.startCharOffset;
  let consumed = 0;
  for (const scalar of replacementText) {
    if (consumed >= offset) break;
    if (scalar === '\n') {
      paraIdx++;
      charOffset = 0;
    } else {
      charOffset++;
    }
    consumed++;
  }
  return { paraIdx, charOffset };
}

export function rangeForNewScalarOffsets(
  baseRange: DocRange,
  replacementText: string,
  startOffset: number,
  endOffset: number,
): DocRange {
  const start = pointAtNewScalarOffset(baseRange, replacementText, startOffset);
  const end = pointAtNewScalarOffset(baseRange, replacementText, endOffset);
  return {
    sectionIdx: baseRange.sectionIdx,
    cell: baseRange.cell,
    startParaIdx: start.paraIdx,
    startCharOffset: start.charOffset,
    endParaIdx: end.paraIdx,
    endCharOffset: end.charOffset,
  };
}
