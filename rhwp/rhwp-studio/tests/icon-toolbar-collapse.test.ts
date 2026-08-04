import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const toolbarCss = readFileSync(new URL('../src/styles/toolbar.css', import.meta.url), 'utf8');
const styleBarCss = readFileSync(new URL('../src/styles/style-bar.css', import.meta.url), 'utf8');
const view = readFileSync(new URL('../src/command/commands/view.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('collapse toggle lives on the style bar, not the icon toolbar', () => {
  assert.match(html, /id="style-bar"[\s\S]*class="sb-collapse-btn"[\s\S]*data-cmd="view:toolbox-basic"/);
  const iconToolbar = html.match(/id="icon-toolbar"([\s\S]*?)id="style-bar"/)?.[1] ?? '';
  assert.ok(iconToolbar.length > 0);
  assert.doesNotMatch(iconToolbar, /collapse-btn/);
});

test('collapsed icon toolbar is fully hidden so the top chrome compacts', () => {
  assert.match(toolbarCss, /#icon-toolbar\.collapsed\s*\{[^}]*display:\s*none;/s);
  assert.match(styleBarCss, /\.sb-collapse-btn\s*\{/);
});

test('style-bar collapse uses a stroked chevron that rotates with aria-expanded', () => {
  assert.match(html, /class="sb-collapse-btn"[\s\S]*class="ui-chevron"/);
  assert.match(styleBarCss, /\.sb-collapse-btn\[aria-expanded='true'\] \.ui-chevron/);
  assert.doesNotMatch(view, /textContent\s*=\s*expanded/);
});

test('view:toolbox-basic syncs the style-bar chevron and expands for mode toolbars', () => {
  assert.match(view, /syncBasicToolboxUi/);
  assert.match(view, /setBasicToolboxExpanded/);
  assert.match(view, /sb-collapse-btn/);
  assert.match(main, /\.tb-btn\[data-cmd\],\s*\.sb-collapse-btn\[data-cmd\]/);
  assert.match(main, /setBasicToolboxExpanded\(true\)/);
});
