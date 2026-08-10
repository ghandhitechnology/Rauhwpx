import test from 'node:test';
import assert from 'node:assert/strict';
import {
  editableTargetFromPosition,
  positionsShareEditableContainer,
} from '../src/engine/edit-target.ts';
import type { DocumentPosition } from '../src/core/types.ts';

function position(overrides: Partial<DocumentPosition> = {}): DocumentPosition {
  return { sectionIndex: 0, paragraphIndex: 0, charOffset: 0, ...overrides };
}

test('editableTargetFromPosition preserves the full nested path and replaces only the leaf paragraph', () => {
  const target = editableTargetFromPosition(position({
    parentParaIndex: 4,
    controlIndex: 2,
    cellIndex: 1,
    cellParaIndex: 3,
    cellPath: [
      { controlIndex: 2, cellIndex: 1, cellParaIndex: 3 },
      { controlIndex: 5, cellIndex: 6, cellParaIndex: 7 },
    ],
  }), 9);

  assert.deepEqual(target, {
    kind: 'container',
    sectionIndex: 0,
    parentParagraphIndex: 4,
    paragraphIndex: 9,
    controlIndex: 2,
    cellIndex: 1,
    cellPath: [
      { controlIndex: 2, cellIndex: 1, cellParaIndex: 3 },
      { controlIndex: 5, cellIndex: 6, cellParaIndex: 9 },
    ],
    isTextBox: false,
  });
});

test('container identity allows leaf paragraph changes but rejects a different nested container', () => {
  const first = position({
    parentParaIndex: 4,
    cellPath: [
      { controlIndex: 2, cellIndex: 1, cellParaIndex: 3 },
      { controlIndex: 5, cellIndex: 6, cellParaIndex: 7 },
    ],
  });
  const nextParagraph = position({
    parentParaIndex: 4,
    cellPath: [
      { controlIndex: 2, cellIndex: 1, cellParaIndex: 3 },
      { controlIndex: 5, cellIndex: 6, cellParaIndex: 8 },
    ],
  });
  const differentOuterParagraph = position({
    parentParaIndex: 4,
    cellPath: [
      { controlIndex: 2, cellIndex: 1, cellParaIndex: 4 },
      { controlIndex: 5, cellIndex: 6, cellParaIndex: 8 },
    ],
  });

  assert.equal(positionsShareEditableContainer(first, nextParagraph), true);
  assert.equal(positionsShareEditableContainer(first, differentOuterParagraph), false);
});

test('flat text-box and table positions are never treated as the same container', () => {
  const textBox = position({
    parentParaIndex: 4,
    controlIndex: 2,
    cellIndex: 0,
    cellParaIndex: 0,
    isTextBox: true,
  });
  const tableCell = { ...textBox, isTextBox: undefined };

  assert.equal(positionsShareEditableContainer(textBox, tableCell), false);
});
