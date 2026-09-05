import test from 'node:test';
import assert from 'node:assert/strict';
import { inlinePictureInsertionTarget } from '../src/engine/inline-picture-target.ts';

test('body picture insertion retains its body paragraph and caret', () => {
  const position = { sectionIndex: 2, paragraphIndex: 7, charOffset: 9 };
  assert.deepEqual(inlinePictureInsertionTarget(position), {
    paragraphIndex: 7, cellPathJson: '', position,
  });
});

test('flat cell caret becomes a full cell path without changing the character offset', () => {
  const position = {
    sectionIndex: 1, paragraphIndex: 3, charOffset: 9,
    parentParaIndex: 12, controlIndex: 4, cellIndex: 2, cellParaIndex: 3,
  };
  const expectedPath = [{ controlIndex: 4, cellIndex: 2, cellParaIndex: 3 }];
  const target = inlinePictureInsertionTarget(position);
  assert.equal(target.paragraphIndex, 12);
  assert.deepEqual(JSON.parse(target.cellPathJson), expectedPath);
  assert.deepEqual(target.position, { ...position, cellPath: expectedPath });
  assert.equal('cellPath' in position, false, 'do not mutate the history input');
});

test('nested cell path wins over the outer flat cell coordinates', () => {
  const cellPath = [
    { controlIndex: 4, cellIndex: 2, cellParaIndex: 1 },
    { controlIndex: 0, cellIndex: 3, cellParaIndex: 2 },
  ];
  const position = {
    sectionIndex: 0, paragraphIndex: 2, charOffset: 11,
    parentParaIndex: 12, controlIndex: 4, cellIndex: 2, cellParaIndex: 1, cellPath,
  };
  const target = inlinePictureInsertionTarget(position);
  assert.equal(target.paragraphIndex, 12);
  assert.deepEqual(JSON.parse(target.cellPathJson), cellPath);
  assert.deepEqual(target.position, position);
});

test('text-box paths are retained as addressed containers', () => {
  const position = {
    sectionIndex: 0, paragraphIndex: 0, charOffset: 1, parentParaIndex: 5,
    isTextBox: true, cellPath: [{ controlIndex: 2, cellIndex: 65535, cellParaIndex: 0 }],
  };
  const target = inlinePictureInsertionTarget(position);
  assert.equal(target.paragraphIndex, 5);
  assert.deepEqual(JSON.parse(target.cellPathJson), position.cellPath);
});

test('incomplete cell coordinates fail instead of inserting into the body', () => {
  assert.throws(() => inlinePictureInsertionTarget({
    sectionIndex: 0, paragraphIndex: 0, charOffset: 0, parentParaIndex: 5,
  }), /셀 문단 주소/);
});
