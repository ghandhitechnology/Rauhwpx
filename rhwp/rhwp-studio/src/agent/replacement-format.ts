import type { CharShapeRun } from '../core/types.ts';
import { computeExactTextDiff } from './exact-text-diff.ts';

/** Keep unchanged text's formatting; new text inherits the style at its edit. */
export function replacementCharShapes(before: string, after: string, runs: CharShapeRun[]): CharShapeRun[] {
  if (!runs.length || !after.length) return [];
  const oldChars = [...before];
  const newChars = [...after];
  const result: CharShapeRun[] = [];
  const shapeAt = (offset: number): number =>
    (runs.find(run => run.startOffset <= offset && offset < run.endOffset) ?? runs.at(-1)!).charShapeId;
  const append = (startOffset: number, endOffset: number, charShapeId: number): void => {
    if (endOffset <= startOffset) return;
    const last = result.at(-1);
    if (last?.endOffset === startOffset && last.charShapeId === charShapeId) last.endOffset = endOffset;
    else result.push({ startOffset, endOffset, charShapeId });
  };
  const copyRuns = (oldStart: number, oldEnd: number, newStart: number): void => {
    for (const run of runs) {
      const start = Math.max(run.startOffset, oldStart);
      const end = Math.min(run.endOffset, oldEnd);
      if (end > start) append(newStart + start - oldStart, newStart + end - oldStart, run.charShapeId);
    }
  };
  const unchanged = (oldStart: number, oldEnd: number, newStart: number, newEnd: number): void => {
    const oldText = oldChars.slice(oldStart, oldEnd).join('');
    const newText = newChars.slice(newStart, newEnd).join('');
    if (oldText === newText) {
      copyRuns(oldStart, oldEnd, newStart);
      return;
    }
    // The display diff also considers composed and decomposed graphemes equal.
    // Map each one separately so scalar shifts do not repaint an unchanged suffix.
    if (typeof Intl.Segmenter !== 'function') {
      append(newStart, newEnd, shapeAt(oldStart));
      return;
    }
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const oldParts = [...segmenter.segment(oldText)].map(part => part.segment);
    const newParts = [...segmenter.segment(newText)].map(part => part.segment);
    if (oldParts.length !== newParts.length) {
      append(newStart, newEnd, shapeAt(oldStart));
      return;
    }
    let oldAt = oldStart;
    let newAt = newStart;
    for (let i = 0; i < oldParts.length; i++) {
      const oldPart = oldParts[i];
      const newPart = newParts[i];
      const oldNext = oldAt + [...oldPart].length;
      const newNext = newAt + [...newPart].length;
      if (oldPart === newPart) copyRuns(oldAt, oldNext, newAt);
      else append(newAt, newNext, shapeAt(oldAt));
      oldAt = oldNext;
      newAt = newNext;
    }
  };
  let oldOffset = 0;
  let newOffset = 0;
  for (const hunk of computeExactTextDiff(before, after).hunks) {
    unchanged(oldOffset, hunk.oldStart, newOffset, hunk.newStart);
    append(hunk.newStart, hunk.newEnd, shapeAt(hunk.oldStart));
    oldOffset = hunk.oldEnd;
    newOffset = hunk.newEnd;
  }
  unchanged(oldOffset, oldChars.length, newOffset, newChars.length);
  return result;
}
