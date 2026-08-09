import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/ui/agent-sidebar/index.ts', import.meta.url),
  'utf8',
);
const css = readFileSync(
  new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url),
  'utf8',
);

test('workspace keeps document context in the header and execution settings with the composer', () => {
  assert.match(source, /modelSummary\.append\(fullscreenBtn, contextRow, headerActions\)/);
  assert.match(source, /header\.append\(modelSummary, connectionRow\)/);
  assert.match(source, /composerMeta\.setAttribute\('aria-label', '에이전트 및 채팅 설정'\)/);
  assert.match(source, /composerMeta\.append\(selectors, composerUtilities\)/);
  assert.match(source, /composer\.append\(slashMenu, composerField, composerMeta, configPanel\)/);
  assert.doesNotMatch(source, /modelSummary\.append\([^;]*selectors/);
});

test('focus mode is a dedicated shell with navigation and a tabbed workspace', () => {
  assert.match(
    source,
    /if \(raw === null\) return true;[\s\S]*?return raw !== '0';/,
    'a new user starts with the optional review drawer closed',
  );
  assert.match(
    source,
    /const changesActive = focusLayoutActive && !reviewColCollapsed;/,
  );
  assert.match(source, /root\.classList\.toggle\('ag-workspace-changes', changesActive\)/);
  assert.match(source, /workspaceBar\.append\(workspaceLeading, workspaceTabs, workspaceTrailing\)/);
  assert.match(source, /workspaceTabs\.setAttribute\('role', 'tablist'\)/);
  assert.match(source, /conversationTab\.setAttribute\('role', 'tab'\)/);
  assert.match(source, /changesTab\.setAttribute\('role', 'tab'\)/);
  assert.match(
    css,
    /\.ag-fullscreen \.ag-workspace-bar\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-row:\s*1;/s,
    'the workspace title bar spans the complete viewport shell',
  );
  assert.match(
    css,
    /\.ag-fullscreen \.ag-stage,[\s\S]*?grid-template-rows:\s*48px minmax\(0, 1fr\);/s,
    'content lives below a stable application title bar',
  );
});

test('changes stay discoverable while pending edits drive only the badge', () => {
  assert.match(source, /const reviewBadge = el\('span', 'ag-review-badge', '0'\)/);
  assert.match(source, /reviewBadge\.hidden = true;/);
  assert.match(source, /if \(!fullscreen\) \{[\s\S]*?setReviewColCollapsed\(false\);[\s\S]*?setFullscreen\(true\)/);
  assert.match(source, /opCount \+= set\.ops\.length;[\s\S]*?updateReviewControl\(opCount\)/);
  assert.match(source, /reviewBadge\.textContent = String\(pendingReviewOpCount\)/);
  assert.match(source, /reviewBadge\.hidden = !hasPending;/);
  assert.doesNotMatch(source, /reviewBtn\.hidden = !hasPending/);
  assert.match(css, /\.ag-review-badge\s*\{/);
  assert.match(css, /\.ag-review-badge\[hidden\]\s*\{[^}]*display:\s*none;/s);
});

test('changes workspace presents a full-surface unified diff and an intentional empty state', () => {
  assert.match(source, /reviewColumnTitle = el\('span', 'ag-review-column-title', '변경 사항'\)/);
  assert.match(source, /el\('div', 'ag-review-empty-title', '변경 사항 없음'\)/);
  assert.match(source, /diff\.append\(buildDiffLine\('del', op\.deletedText\), buildDiffLine\('add', op\.text\)\)/);
  assert.match(css, /\.ag-op-head\s*\{[^}]*border-bottom:[^}]*background:/s);
  assert.match(css, /\.ag-diff-sign\s*\{[^}]*border-right:/s);
  assert.match(css, /\.ag-review-actions\s*\{[^}]*border-top:[^}]*background:/s);
  assert.match(
    css,
    /\/\* Changes is a full workspace surface, never an inset drawer\. \*\/[\s\S]*?\.ag-fullscreen \.ag-review-column,[\s\S]*?border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/,
  );
});

test('changes tab exposes synchronized accessible state', () => {
  assert.match(source, /reviewBtn\.setAttribute\('aria-controls', 'ag-review-column'\)/);
  assert.match(source, /reviewBtn\.setAttribute\('aria-expanded', changesActive \? 'true' : 'false'\)/);
  assert.match(source, /conversationTab\.setAttribute\('aria-selected', changesActive \? 'false' : 'true'\)/);
  assert.match(source, /changesTab\.setAttribute\('aria-selected', changesActive \? 'true' : 'false'\)/);
  assert.match(source, /reviewColumn\.setAttribute\('role', 'region'\)/);
  assert.match(source, /reviewColumn\.setAttribute\('aria-label', '검토'\)/);
  assert.match(source, /reviewColumn\.setAttribute\('aria-hidden', changesActive \? 'false' : 'true'\)/);
  assert.match(source, /reviewResize\.setAttribute\('role', 'separator'\)/);
  assert.match(source, /reviewResize\.setAttribute\('aria-orientation', 'vertical'\)/);
  assert.match(source, /reviewResize\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(source, /reviewResize\.tabIndex = -1/);
  assert.match(source, /reviewColumnClose\.setAttribute\('aria-label', '검토 닫기'\)/);
  assert.match(source, /reviewColumnClose\.addEventListener\('click', \(\) => \{[\s\S]*?setReviewColCollapsed\(true\)/);
  assert.match(source, /if \(root\.classList\.contains\('ag-review-drawer-open'\)\) \{[\s\S]*?setReviewColCollapsed\(true\)/);
  assert.match(css, /\.ag-review-column-close\s*\{[^}]*margin-left:\s*auto;/s);
});

test('the same review node returns to its inline sidebar position after focus mode', () => {
  assert.match(source, /chatPage\.append\(header, messages, review, composer\)/);
  assert.match(source, /reviewColumn\.appendChild\(review\)/);
  assert.match(source, /chatPage\.append\(review, composer\)/);
  assert.doesNotMatch(source, /chatPage\.insertBefore\(review, composerUtilities\)/);
});
