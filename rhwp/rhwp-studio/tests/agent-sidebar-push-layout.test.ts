import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const baseCss = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
const calibrationCss = readFileSync(
  new URL('../src/ui/agent-sidebar/writing-style-calibration.css', import.meta.url),
  'utf8',
);
const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');

test('agent sidebar and fullscreen workspace use bundled NanumSquare typography', () => {
  assert.match(baseCss, /url\('\/fonts\/NanumSquare-Regular\.woff2'\)/);
  assert.match(baseCss, /url\('\/fonts\/NanumSquare-Bold\.woff2'\)/);
  assert.match(css, /--ag-font:\s*'NanumSquare',\s*'나눔스퀘어'/);
  assert.match(css, /\.ag-root\s*\{[^}]*font-family:\s*var\(--ag-font\);/s);
  assert.match(calibrationCss, /font-family:\s*var\(--ag-font,/);
});

test('agent sidebar push layout reserves editor-area width when open', () => {
  assert.match(css, /--ag-sidebar-width:\s*600px;/);
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
  assert.match(source, /SIDEBAR_WIDTH_DEFAULT\s*=\s*600/);
  assert.match(source, /SIDEBAR_WIDTH_MIN_FALLBACK\s*=\s*280/);
  assert.match(source, /refreshSidebarWidthMin/);
  assert.match(source, /packedFlexWidth/);
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

test('composer metadata stays on one row at the minimum sidebar width', () => {
  assert.match(css, /\.ag-composer-meta\s*\{[^}]*flex-wrap:\s*nowrap;/s);
  assert.match(css, /\.ag-composer-meta \.ag-selectors\s*\{[^}]*flex:\s*0 1 auto;/s);
  assert.match(css, /\.ag-composer-meta \.ag-selectors\s*\{[^}]*min-width:\s*0;/s);
  assert.match(css, /\.ag-composer-meta \.ag-selectors\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.ag-composer-meta \.ag-composer-utilities\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(css, /\.ag-composer-meta \.ag-composer-utilities\s*\{[^}]*margin-left:\s*auto;/s);
});
