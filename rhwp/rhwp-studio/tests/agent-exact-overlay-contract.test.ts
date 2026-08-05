import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pendingSrc = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');
const overlaySrc = readFileSync(new URL('../src/agent/pending-overlay.ts', import.meta.url), 'utf8');
const overlayCss = readFileSync(new URL('../src/agent/pending-overlay.css', import.meta.url), 'utf8');

test('replace overlay receives both sides without changing the pending operation model', () => {
  assert.match(pendingSrc, /kind: 'replace',[\s\S]*id: op\.id,[\s\S]*oldText: op\.deletedText,[\s\S]*newText: op\.text/);
  assert.match(overlaySrc, /computeExactTextDiff\(op\.oldText, op\.newText\)/);
  assert.match(overlaySrc, /rangeForNewScalarOffsets\(op\.range, op\.newText, hunk\.newStart, hunk\.newEnd\)/);
});

test('inspection observes pointer and caret state without intercepting editor input', () => {
  const pointerHandler = overlaySrc.slice(
    overlaySrc.indexOf('private onPointerMove'),
    overlaySrc.indexOf('private onPointerLeave'),
  );
  assert.match(pointerHandler, /this\.hitRegions\.find/);
  assert.doesNotMatch(pointerHandler, /preventDefault|stopPropagation/);
  assert.match(overlaySrc, /eventBus\.on\('cursor-rect-updated',[\s\S]*this\.inspectCaret\(\)/);
  assert.match(overlaySrc, /event\.key !== 'Escape'/);
});

test('liquid flow is bounded, one-shot, and reduced-motion safe', () => {
  assert.match(overlaySrc, /const FLOW_STAGGER_MS = 45/);
  assert.match(overlaySrc, /const FLOW_STAGGER_CAP_MS = 700/);
  assert.match(overlaySrc, /this\.animatedHunks\.has\(key\)/);
  assert.match(overlayCss, /ag-liquid-flow 360ms cubic-bezier\(0\.16, 1, 0\.3, 1\)/);
  assert.match(overlayCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
});

test('exact replace colors are semantic green and red', () => {
  assert.match(overlayCss, /\.ag-exact-ink[\s\S]*--ag-pending-ink: 35, 122, 75/);
  assert.match(overlayCss, /\.ag-exact-anchor::before[\s\S]*background: #b23a48/);
});
