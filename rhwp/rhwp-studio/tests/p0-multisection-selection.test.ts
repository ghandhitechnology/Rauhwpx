import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBodySelectionSegments } from '../src/engine/body-selection-range.ts';

const sections = [
  ['S0-HEAD', 'S0-TAIL'],
  ['S1-ONLY'],
  ['S2-HEAD', 'S2-TAIL'],
] as const;

const reader = {
  getParagraphCount(sectionIndex: number): number {
    return sections[sectionIndex]?.length ?? 0;
  },
  getParagraphLength(sectionIndex: number, paragraphIndex: number): number {
    return sections[sectionIndex]?.[paragraphIndex]?.length ?? 0;
  },
};

const start = { sectionIndex: 0, paragraphIndex: 0, charOffset: 3 };
const end = { sectionIndex: 2, paragraphIndex: 1, charOffset: 2 };

test('cross-section range is split into exact ordered section segments', () => {
  assert.deepEqual(getBodySelectionSegments(reader, start, end), [
    {
      sectionIndex: 0,
      startParagraphIndex: 0,
      startCharOffset: 3,
      endParagraphIndex: 1,
      endCharOffset: 7,
    },
    {
      sectionIndex: 1,
      startParagraphIndex: 0,
      startCharOffset: 0,
      endParagraphIndex: 0,
      endCharOffset: 7,
    },
    {
      sectionIndex: 2,
      startParagraphIndex: 0,
      startCharOffset: 0,
      endParagraphIndex: 1,
      endCharOffset: 2,
    },
  ]);
});

test('segmented copy covers every unique sentinel in document order', () => {
  const selectedParagraphs: string[] = [];
  for (const segment of getBodySelectionSegments(reader, start, end)) {
    for (let paragraphIndex = segment.startParagraphIndex;
      paragraphIndex <= segment.endParagraphIndex;
      paragraphIndex++) {
      const text = sections[segment.sectionIndex][paragraphIndex];
      const from = paragraphIndex === segment.startParagraphIndex ? segment.startCharOffset : 0;
      const to = paragraphIndex === segment.endParagraphIndex ? segment.endCharOffset : text.length;
      selectedParagraphs.push(text.slice(from, to));
    }
  }
  assert.equal(selectedParagraphs.join('\n'), 'HEAD\nS0-TAIL\nS1-ONLY\nS2-HEAD\nS2');
});

test('character and paragraph formatting enumerate all selected sections', () => {
  const characterTargets: string[] = [];
  const paragraphTargets: string[] = [];
  for (const segment of getBodySelectionSegments(reader, start, end)) {
    for (let paragraphIndex = segment.startParagraphIndex;
      paragraphIndex <= segment.endParagraphIndex;
      paragraphIndex++) {
      paragraphTargets.push(`${segment.sectionIndex}:${paragraphIndex}`);
      const text = sections[segment.sectionIndex][paragraphIndex];
      const from = paragraphIndex === segment.startParagraphIndex ? segment.startCharOffset : 0;
      const to = paragraphIndex === segment.endParagraphIndex ? segment.endCharOffset : text.length;
      for (let offset = from; offset < to; offset++) {
        characterTargets.push(`${segment.sectionIndex}:${paragraphIndex}:${offset}`);
      }
    }
  }

  assert.deepEqual(paragraphTargets, ['0:0', '0:1', '1:0', '2:0', '2:1']);
  assert.ok(characterTargets.includes('0:0:3'));
  assert.ok(characterTargets.includes('1:0:0'));
  assert.ok(characterTargets.includes('2:1:1'));
  assert.ok(!characterTargets.includes('0:0:2'));
  assert.ok(!characterTargets.includes('2:1:2'));
});

test('Studio routes copy/delete/format/render through cross-section APIs or segments', () => {
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const command = readFileSync(join(rootDir, 'src/engine/command.ts'), 'utf8');
  const keyboard = readFileSync(join(rootDir, 'src/engine/input-handler-keyboard.ts'), 'utf8');
  const inputHandler = readFileSync(join(rootDir, 'src/engine/input-handler.ts'), 'utf8');

  assert.match(keyboard, /copySelectionAcrossSections\(/);
  assert.match(keyboard, /exportSelectionAcrossSectionsHtml\(/);
  assert.match(command, /deleteRangeAcrossSections\(/);
  // Formatting now uses the shared editable-target command path so the same
  // undo/redo implementation also covers cells, HF and notes. Body ranges are
  // still segmented across sections by InputHandler, then applied one target
  // at a time here.
  assert.match(command, /for \(const range of this\.ranges\)/);
  assert.match(command, /applyCharFormatToTarget\(wasm, range, propsJson\)/);
  assert.match(command, /for \(const entry of entries\)/);
  assert.match(command, /applyParaFormatToTarget\(wasm, entry\.target, propsJson\)/);
  assert.match(inputHandler, /getBodySelectionSegments\(this\.wasm, start, end\)\.flatMap/);
});
