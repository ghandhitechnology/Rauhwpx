export interface WordSelectionRange {
  start: number;
  end: number;
}

function scalarOffsetToCodeUnit(text: string, offset: number) {
  return Array.from(text).slice(0, Math.max(0, offset)).join('').length;
}

function codeUnitOffsetToScalar(text: string, offset: number) {
  return Array.from(text.slice(0, Math.max(0, offset))).length;
}

function findFallbackWordRange(text: string, offset: number): WordSelectionRange | null {
  const chars = Array.from(text);
  if (chars.length === 0) return null;

  let index = Math.min(Math.max(0, offset), chars.length - 1);
  const isWordCharacter = (char: string) => /[\p{L}\p{N}\p{M}_]/u.test(char);
  if (!isWordCharacter(chars[index]) && index > 0 && isWordCharacter(chars[index - 1])) index -= 1;
  if (!isWordCharacter(chars[index])) return null;

  let start = index;
  let end = index + 1;
  while (start > 0 && isWordCharacter(chars[start - 1])) start -= 1;
  while (end < chars.length && isWordCharacter(chars[end])) end += 1;
  return { start, end };
}

/** Finds the Unicode word around a document's scalar-character cursor offset. */
export function findWordSelectionRange(text: string, offset: number): WordSelectionRange | null {
  if (!text) return null;

  if (typeof Intl.Segmenter !== 'function') return findFallbackWordRange(text, offset);

  const codeUnitOffset = scalarOffsetToCodeUnit(text, offset);
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text));
  const atOffset = segments.find((segment) => (
    codeUnitOffset >= segment.index && codeUnitOffset < segment.index + segment.segment.length
  ));
  const beforeOffset = codeUnitOffset > 0
    ? segments.find((segment) => (
        codeUnitOffset - 1 >= segment.index
        && codeUnitOffset - 1 < segment.index + segment.segment.length
      ))
    : undefined;
  const selected = atOffset?.isWordLike ? atOffset : beforeOffset?.isWordLike ? beforeOffset : undefined;
  if (!selected) return null;

  return {
    start: codeUnitOffsetToScalar(text, selected.index),
    end: codeUnitOffsetToScalar(text, selected.index + selected.segment.length),
  };
}
