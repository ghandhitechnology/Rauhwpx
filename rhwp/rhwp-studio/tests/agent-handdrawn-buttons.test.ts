import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(
  new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url),
  'utf8',
);
const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');

/** filter: var(--ag-sketch-line) 을 쓰는 규칙 블록들을 모은다. */
function sketchRules(): string[] {
  return css.match(/[^{}]+\{[^}]*filter:\s*var\(--ag-sketch-line\)[^}]*\}/gs) ?? [];
}

function sketchSelectors(): string {
  return sketchRules()
    .map((rule) => rule.slice(0, rule.indexOf('{')))
    .join('\n');
}

test('sketch displacement filter is defined once in the sidebar DOM', () => {
  // CSS 의 filter: url(#ag-sketch-line) 참조가 가리키는 정의를 index.ts 가 심는다.
  assert.match(source, /'ag-sketch-line'/);
  assert.match(source, /feTurbulence/);
  assert.match(source, /baseFrequency/);
  assert.match(source, /feDisplacementMap/);
  // display:none 이면 Safari 가 filter url() 참조를 무시하므로 0 크기로만 숨긴다.
  assert.match(css, /\.ag-sketch-defs\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.ag-sketch-defs\s*\{[^}]*width:\s*0;[^}]*height:\s*0;/s);
  assert.doesNotMatch(css, /\.ag-sketch-defs\s*\{[^}]*display:\s*none/s);
});

test('sketch filter lives behind a token on .ag-root', () => {
  assert.match(css, /--ag-sketch-line:\s*url\(#ag-sketch-line\);/);
});

test('filled sidebar action buttons are hand-drawn', () => {
  const selectors = sketchSelectors();
  for (const sel of [
    '.ag-send',
    '.ag-approve',
    '.ag-reject',
    '.ag-takeover-btn',
    '.ag-threads-new',
    '.ag-skills-new',
    '.ag-skill-generate',
    '.ag-skill-save',
    '.ag-skill-copy',
    '.ag-skill-secondary',
    '.ag-skill-danger',
    '.ag-skill-toggle',
    '.ag-skill-upload-label',
    '.ag-settings-primary',
    '.ag-conn-banner-retry',
    '.ag-hub-retry-btn',
    '.ag-workspace-exit-btn',
  ]) {
    assert.ok(selectors.includes(sel), `${sel} should use the sketch filter`);
  }
});

test('ghost and icon buttons in sidebar and fullscreen are hand-drawn', () => {
  const selectors = sketchSelectors();
  for (const sel of [
    '.ag-header-icon-btn',
    '.ag-workspace-icon-btn',
    '.ag-permission-btn',
    '.ag-skills-btn',
    '.ag-model-trigger',
    '.ag-thread-rename',
    '.ag-environment-changes',
    '.ag-collapse-tab',
  ]) {
    assert.ok(selectors.includes(sel), `${sel} should use the sketch filter`);
  }
});

test('hand-drawn buttons use uneven per-corner radii instead of the even tokens', () => {
  // 상태 오버라이드(:hover 등)는 필터만 이어 받으므로 기본 그룹 규칙만 검사한다.
  const baseRules = sketchRules().filter(
    (rule) => !rule.slice(0, rule.indexOf('{')).includes(':'),
  );
  assert.ok(baseRules.length >= 2, 'expected at least filled and ghost sketch groups');
  for (const rule of baseRules) {
    assert.match(
      rule,
      /border-radius:\s*[^;]*\/[^;]*;/,
      `sketch rule should use the two-axis irregular radius form: ${rule.slice(0, 80)}`,
    );
  }
});

test('stop-send hover keeps the sketch filter while dimming', () => {
  assert.match(
    css,
    /\.ag-send\.ag-stop:hover:not\(:disabled\)\s*\{[^}]*filter:\s*var\(--ag-sketch-line\) brightness\(/s,
  );
});

test('fullscreen overrides keep hand-drawn radii on the new-chat button', () => {
  assert.match(
    css,
    /\.ag-fullscreen \.ag-threads-new\s*\{[^}]*border-radius:\s*[^;]*\/[^;]*;/s,
  );
});
