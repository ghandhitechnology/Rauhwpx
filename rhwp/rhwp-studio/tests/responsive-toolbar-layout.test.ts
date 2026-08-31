import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const toolbar = readFileSync(new URL('../src/styles/toolbar.css', import.meta.url), 'utf8');
const styleBar = readFileSync(new URL('../src/styles/style-bar.css', import.meta.url), 'utf8');
const responsive = readFileSync(new URL('../src/styles/responsive.css', import.meta.url), 'utf8');

test('icon toolbar moves complete groups to a new row instead of overlapping', () => {
  assert.match(toolbar, /#icon-toolbar\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(toolbar, /#icon-toolbar\s*\{[^}]*height:\s*auto;/s);
  assert.match(toolbar, /#icon-toolbar\s*\{[^}]*min-height:\s*60px;/s);
  assert.match(toolbar, /#icon-toolbar\s*\{[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(toolbar, /#icon-toolbar\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.match(toolbar, /\.tb-group\s*\{[^}]*flex-shrink:\s*0;/s);
});

test('constrained layouts hide top-level separators and do not scroll the toolbar', () => {
  assert.match(
    responsive,
    /@media\s*\(max-width:\s*1279px\)[\s\S]*?#icon-toolbar\s*>\s*\.tb-sep,\s*#style-bar\s*>\s*\.sb-sep\s*\{[^}]*display:\s*none;/,
  );
  assert.match(
    responsive,
    /@media\s*\(max-width:\s*1023px\)[\s\S]*?#icon-toolbar\s*\{[^}]*min-height:\s*40px;/,
  );

  const mobileToolbar = responsive.match(
    /@media\s*\(max-width:\s*767px\)[\s\S]*?#icon-toolbar\s*\{([^}]*)\}/,
  );
  assert.ok(mobileToolbar);
  assert.doesNotMatch(mobileToolbar[1], /overflow-x:\s*auto/);
  assert.doesNotMatch(mobileToolbar[1], /-webkit-overflow-scrolling/);
});

test('style ribbon wraps complete groups into visible rows', () => {
  assert.match(styleBar, /#style-bar\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(styleBar, /#style-bar\s*\{[^}]*min-height:\s*38px;/s);
  assert.match(styleBar, /#style-bar\s*\{[^}]*height:\s*auto;/s);
  assert.match(styleBar, /#style-bar\s*\{[^}]*overflow:\s*visible;/s);
  assert.match(styleBar, /\.sb-command-band\s*\{[^}]*flex-shrink:\s*0;/s);
  assert.match(styleBar, /\.sb-ribbon-group\s*\{[^}]*flex-shrink:\s*0;/s);

  assert.match(
    responsive,
    /@media\s*\(max-width:\s*1279px\)[\s\S]*?#icon-toolbar\s*>\s*\.tb-sep,\s*#style-bar\s*>\s*\.sb-sep\s*\{[^}]*display:\s*none;/,
  );

  const responsiveStyleBarRules = [...responsive.matchAll(/#style-bar\s*\{([^}]*)\}/g)];
  assert.ok(responsiveStyleBarRules.some((rule) => /min-height:\s*40px/.test(rule[1])));
  for (const rule of responsiveStyleBarRules) {
    assert.doesNotMatch(rule[1], /^\s*height:\s*40px/m);
    assert.doesNotMatch(rule[1], /overflow-x:\s*auto/);
  }
});

test('tablet style ribbon stacks compact field and command groups without clipping', () => {
  const tabletStart = responsive.indexOf('@media (min-width: 768px) and (max-width: 1023px)');
  const mobileStart = responsive.indexOf('/* ─── 모바일', tabletStart);
  assert.ok(tabletStart >= 0);
  assert.ok(mobileStart > tabletStart);
  const tabletRibbon = responsive.slice(tabletStart, mobileStart);
  assert.match(
    tabletRibbon,
    /#style-bar\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s,
  );
  assert.match(tabletRibbon, /\.sb-ribbon-group\s*\{[^}]*min-height:\s*0;/s);
  assert.match(tabletRibbon, /\.sb-ribbon-label\s*\{[^}]*display:\s*none;/s);
});
