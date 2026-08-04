import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/view/canvas-view.ts', import.meta.url), 'utf8');

test('viewport resize repositions pooled canvases after pageLeft changes', () => {
  assert.match(source, /private repositionRenderedPages\(\): void/);
  assert.match(source, /this\.repositionRenderedPages\(\)/);
  assert.match(
    source,
    /updateVisiblePages 는 pool hit 시 style\.left 를 건드리지 않는다/,
  );
  assert.match(source, /syncViewportSize\(\)/);
});
