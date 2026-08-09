import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');

test('agent sidebar push layout reserves editor-area width when open', () => {
  assert.match(css, /--ag-sidebar-width:\s*400px;/);
  assert.match(css, /--ag-sidebar-duration:\s*320ms;/);
  assert.match(
    css,
    /body\.ag-sidebar-open #editor-area\s*\{[^}]*margin-right:\s*var\(--ag-sidebar-width\);/s,
  );
  assert.match(
    css,
    /#editor-area\s*\{[^}]*transition:\s*margin-right var\(--ag-sidebar-duration\) var\(--ag-sidebar-ease\);/s,
  );
  assert.match(
    css,
    /\.ag-root\s*\{[^}]*transition:\s*transform var\(--ag-sidebar-duration\) var\(--ag-sidebar-ease\);/s,
  );
});

test('agent sidebar toggles body.ag-sidebar-open with collapse state', () => {
  assert.match(source, /document\.body\.classList\.toggle\('ag-sidebar-open', !collapsed\)/);
  assert.match(source, /document\.body\.classList\.remove\([\s\S]*?'ag-sidebar-open'/);
  assert.match(source, /setCollapsed\(false, \{ recenter: false \}\)/);
});

test('agent sidebar asks canvas to recenter during inset animation', () => {
  assert.match(source, /eventBus\?\.emit\('viewport-inset-changed'\)/);
  assert.match(source, /ag-sidebar-animating/);
  assert.match(source, /startInsetRecenterLoop/);
  assert.match(source, /SIDEBAR_MOTION_DURATION_MS\s*=\s*320/);
  assert.match(source, /const durationMs = SIDEBAR_MOTION_DURATION_MS/);

  const canvasSource = readFileSync(
    new URL('../src/view/canvas-view.ts', import.meta.url),
    'utf8',
  );
  assert.match(canvasSource, /viewport-inset-changed/);
  assert.match(canvasSource, /recenterHorizontally\(/);
  assert.match(canvasSource, /repositionRenderedPages\(/);
  assert.match(canvasSource, /ag-sidebar-animating/);
});

test('agent sidebar supports drag resize up to half the viewport', () => {
  assert.match(source, /ag-resize-handle/);
  assert.match(source, /maxSidebarWidth/);
  assert.match(source, /0\.5/);
  assert.match(source, /ag-sidebar-resizing/);
  assert.match(source, /applySidebarWidth/);
  assert.match(source, /onCollapseTabPointerDown/);
  assert.match(source, /RESIZE_DRAG_THRESHOLD_PX/);
  assert.match(css, /\.ag-resize-handle/);
  assert.match(css, /body\.ag-sidebar-resizing #editor-area/);
  assert.match(css, /\.ag-collapse-tab\s*\{[^}]*cursor:\s*col-resize;/s);
});
