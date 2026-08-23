import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const compareSource = await readFile(new URL('../src/ui/compare-result-window.ts', import.meta.url), 'utf8');
const paneSource = await readFile(new URL('../src/merge/document-preview-pane.ts', import.meta.url), 'utf8');

test('comparison window reuses the shared preview pane for both documents', () => {
  assert.match(compareSource, /import \{ DocumentPreviewPane \}/);
  assert.match(compareSource, /role: 'comparison-left'/);
  assert.match(compareSource, /role: 'comparison-right'/);
  assert.doesNotMatch(compareSource, /new WasmBridge/);
});

test('shared pane preserves per-document alignment fallback without a false marker', () => {
  assert.match(compareSource, /item\.contextOnLeft/);
  assert.match(compareSource, /item\.contextOnRight/);
  assert.match(paneSource, /getCursorRect\(fallbackPosition\.section, fallbackPosition\.paragraph, 0\)/);
  assert.match(paneSource, /this\.anchor = anchor/);
});

test('shared pane wires resolver panels to their controlling tabs', () => {
  assert.match(paneSource, /setAttribute\('role', 'tabpanel'\)/);
  assert.match(paneSource, /setAttribute\('aria-labelledby', labelledBy\)/);
  assert.match(paneSource, /this\.element\.tabIndex = 0/);
});

