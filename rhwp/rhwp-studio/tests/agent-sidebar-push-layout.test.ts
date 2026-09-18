import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const inlinePrompt = readFileSync(new URL('../src/agent/inline-prompt.ts', import.meta.url), 'utf8');
const inlinePromptCss = readFileSync(new URL('../src/agent/inline-prompt.css', import.meta.url), 'utf8');

test('agent sidebar toggles body.ag-sidebar-open with collapse state', () => {
  assert.match(source, /document\.body\.classList\.toggle\('ag-sidebar-open', !collapsed\)/);
  assert.match(source, /document\.body\.classList\.remove\([\s\S]*?'ag-sidebar-open'/);
  assert.match(source, /setCollapsed\(false, \{ recenter: false \}\)/);
});

test('agent sidebar asks canvas to recenter during inset animation', () => {
  assert.match(source, /eventBus\?\.emit\('viewport-inset-changed'\)/);
  assert.match(source, /ag-sidebar-animating/);
  assert.match(source, /startInsetRecenterLoop/);

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
  assert.match(source, /rhwp-agent-sidebar-width-v3/);
  assert.match(source, /refreshSidebarWidthMin/);
  assert.match(source, /measureComposerMetaFloor/);
  assert.match(source, /ag-measuring-min/);
  assert.match(source, /max-content/);
  assert.match(source, /ag-resize-handle/);
  assert.match(source, /maxSidebarWidth/);
  assert.match(source, /0\.5/);
  assert.match(source, /ag-sidebar-resizing/);
  assert.match(source, /applySidebarWidth/);
  assert.match(source, /RESIZE_DRAG_THRESHOLD_PX/);
  assert.match(source, /requestAnimationFrame\(applyResizeMove\)/);
  assert.match(source, /recenter: false/);
});

test('hiding the sidebar also disables highlight-to-agent indicators', () => {
  assert.match(source, /eventBus\?\.emit\('agent-sidebar-visibility-changed', \{ open: !collapsed \}\)/);
  assert.match(inlinePrompt, /function isAgentSidebarVisible\(/);
  assert.match(inlinePrompt, /body\.classList\.contains\('ag-sidebar-open'\)/);
  assert.match(inlinePrompt, /eventBus\.on\('agent-sidebar-visibility-changed'/);
  assert.match(inlinePrompt, /if \(!isAgentSidebarVisible\(\)\) this\.hideAll\(\)/);
  assert.match(inlinePrompt, /if \(!isAgentSidebarVisible\(\)\) \{\s*if \(this\.state !== 'hidden'\) this\.hideAll\(\);/s);
  assert.match(
    inlinePromptCss,
    /body:not\(\.ag-sidebar-open\) \.ag-inline-chip,\s*body:not\(\.ag-sidebar-open\) \.ag-inline-box\s*\{[^}]*display:\s*none;/s,
  );
});

test('rau icon toggle hides the sidebar completely from the toolbar', () => {
  assert.match(source, /el\('span', 'ag-rau-icon'\)/);
  assert.match(source, /getElementById\('icon-toolbar'\)\?\.appendChild\(collapseTab\)/);
  assert.match(source, /setCollapsed\(!root\.classList\.contains\('ag-collapsed'\)\)/);
  assert.match(source, /collapseTab\.remove\(\)/);
  assert.match(css, /\.ag-collapse-tab\s*\{[^}]*cursor:\s*pointer;/s);
  assert.doesNotMatch(css, /\.ag-collapse-tab\s*\{[^}]*cursor:\s*col-resize;/s);
  assert.match(css, /\.ag-root\.ag-collapsed\s*\{[^}]*pointer-events:\s*none;/s);
});
