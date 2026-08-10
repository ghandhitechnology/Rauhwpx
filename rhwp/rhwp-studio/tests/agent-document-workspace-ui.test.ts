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
  assert.doesNotMatch(source, /workspaceMark|ag-workspace-mark/);
  assert.doesNotMatch(css, /\.ag-workspace-mark/);
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

test('changes stay discoverable in focus mode while pending edits drive the workspace badge', () => {
  assert.doesNotMatch(source, /ag-review-toggle|const reviewBtn|const reviewBadge/);
  assert.match(source, /const workspaceReviewBadge = el\('span', 'ag-workspace-review-badge', '0'\)/);
  assert.match(source, /workspaceReviewBadge\.hidden = true;/);
  assert.match(source, /const diff = summarizePendingDiffs\(changeSets\)/);
  assert.match(source, /updateReviewControl\(changeSets\)/);
  assert.match(source, /workspaceReviewBadge\.textContent = String\(pendingReviewOpCount\)/);
  assert.match(source, /workspaceReviewBadge\.hidden = !hasPending;/);
  assert.doesNotMatch(css, /\.ag-review-toggle|\.ag-review-badge/);
});

test('focus mode environment panel is persistent, informative, and opens changes explicitly', () => {
  assert.match(source, /ENVIRONMENT_PANEL_OPEN_KEY/);
  assert.match(source, /localStorage\.getItem\(ENVIRONMENT_PANEL_OPEN_KEY\) !== '0'/);
  assert.match(source, /persistEnvironmentPanelOpen\(open\)/);
  assert.match(source, /environmentPanel\.append\(environmentTitle, environmentFileRow, environmentChanges\)/);
  assert.match(source, /workspaceTrailing\.append\(workspaceAgentContext, environmentWrap, workspaceExitBtn\)/);
  assert.match(source, /environmentToggle\.addEventListener\('click',[\s\S]*setEnvironmentPanelOpen\(!environmentPanelOpen\)/);
  assert.match(source, /environmentChanges\.addEventListener\('click',[\s\S]*setReviewColCollapsed\(false\)/);
  assert.match(source, /updateEnvironmentFilename\(currentDocumentName\)/);
  assert.match(source, /파일 첨부나 대화 브랜치 기능이 생기면/);
  assert.doesNotMatch(source, /environmentPanel[\s\S]{0,120}pointerdown/);
  assert.match(css, /\.ag-environment-panel\s*\{[^}]*position:\s*absolute;[^}]*box-shadow:\s*var\(--n-elev-3\)/s);
  assert.match(css, /@keyframes ag-filename-marquee/);
  assert.match(css, /prefers-reduced-motion:[^)]*reduce[\s\S]*\.ag-environment-panel/s);
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
