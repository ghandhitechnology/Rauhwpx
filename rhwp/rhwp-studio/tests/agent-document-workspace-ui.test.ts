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

test('focus mode is a dedicated shell with navigation and one conversation workspace', () => {
  assert.doesNotMatch(source, /workspaceMark|ag-workspace-mark/);
  assert.doesNotMatch(css, /\.ag-workspace-mark/);
  assert.match(source, /let reviewColCollapsed = true;/);
  assert.match(source, /const changesActive = focusLayoutActive && !reviewColCollapsed;/);
  assert.match(source, /const workspaceTitle = el\('div', 'ag-workspace-title', '대화'\)/);
  assert.match(source, /workspaceBar\.append\(workspaceLeading, workspaceTitle, workspaceTrailing\)/);
  assert.doesNotMatch(source, /workspaceTabs|conversationTab|changesTab/);
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

test('changes stay discoverable through the environment row', () => {
  assert.doesNotMatch(source, /ag-review-toggle|const reviewBtn|const reviewBadge/);
  assert.doesNotMatch(source, /workspaceReviewBadge|ag-workspace-review-badge/);
  assert.match(source, /environmentChanges\.setAttribute\('aria-controls', 'ag-review-column'\)/);
  assert.match(source, /environmentChanges\.append\(environmentChangesLabel, environmentDiffSummary, environmentChangesChevron\)/);
  assert.match(source, /const diff = summarizePendingDiffs\(changeSets\)/);
  assert.match(source, /updateReviewControl\(changeSets\)/);
  assert.match(source, /environmentDiffNeutral\.textContent = hasPending/);
  assert.doesNotMatch(css, /\.ag-review-toggle|\.ag-review-badge|\.ag-workspace-review-badge/);
});

test('focus mode environment panel is persistent, informative, and opens changes explicitly', () => {
  assert.match(source, /ENVIRONMENT_PANEL_OPEN_KEY/);
  assert.match(source, /localStorage\.getItem\(ENVIRONMENT_PANEL_OPEN_KEY\) !== '0'/);
  assert.match(source, /persistEnvironmentPanelOpen\(open\)/);
  assert.match(source, /environmentPanel\.append\(environmentTitle, environmentFileRow, environmentChanges\)/);
  assert.match(source, /workspaceTrailing\.append\(workspaceAgentContext, environmentWrap, workspaceExitBtn\)/);
  assert.match(source, /environmentToggle\.addEventListener\('click',[\s\S]*setEnvironmentPanelOpen\(!environmentPanelOpen\)/);
  assert.match(source, /environmentChanges\.addEventListener\('click',[\s\S]*setReviewColCollapsed\(false\);[\s\S]*setEnvironmentPanelOpen\(false\)/);
  assert.match(source, /updateEnvironmentFilename\(currentDocumentName\)/);
  assert.match(source, /파일 첨부나 대화 브랜치 기능이 생기면/);
  assert.doesNotMatch(source, /environmentPanel[\s\S]{0,120}pointerdown/);
  assert.match(css, /\.ag-environment-panel\s*\{[^}]*position:\s*absolute;[^}]*box-shadow:\s*var\(--n-elev-3\)/s);
  assert.match(css, /\.ag-fullscreen \.ag-environment-wrap\s*\{[^}]*position:\s*static;/s);
  assert.match(css, /\.ag-fullscreen \.ag-environment-panel\s*\{[^}]*right:\s*8px;/s);
  assert.match(css, /@keyframes ag-filename-marquee/);
  assert.match(css, /prefers-reduced-motion:[^)]*reduce[\s\S]*\.ag-environment-panel/s);
});

test('changes drawer presents a unified diff and an intentional empty state', () => {
  assert.match(source, /reviewColumnTitle = el\('span', 'ag-review-column-title', '변경 사항'\)/);
  assert.match(source, /el\('div', 'ag-review-empty-title', '변경 사항 없음'\)/);
  assert.match(source, /diff\.appendChild\(buildDiffLine\('del', op\.deletedText\)\)/);
  // 빈 새 텍스트(즉시 적용 삭제)는 add 줄을 만들지 않는다
  assert.match(source, /if \(op\.text\.length > 0\) diff\.appendChild\(buildDiffLine\('add', op\.text\)\)/);
  assert.match(css, /\.ag-op-head\s*\{[^}]*border-bottom:[^}]*background:/s);
  assert.match(css, /\.ag-diff-sign\s*\{[^}]*border-right:/s);
  assert.match(css, /\.ag-review-actions\s*\{[^}]*border-top:[^}]*background:/s);
  assert.match(css, /\.ag-fullscreen\.ag-review-drawer-open:not\(\.ag-review-collapsed\) \.ag-stage\s*\{[^}]*grid-template-columns:[^;]*var\(--ag-review-w, 480px\)/s);
  assert.match(css, /\.ag-fullscreen\.ag-review-collapsed \.ag-stage\s*\{[^}]*grid-template-columns:[^;]*minmax\(0, 1fr\) 0;/s);
  assert.match(css, /\.ag-fullscreen \.ag-review-column,[\s\S]*?position:\s*relative;[\s\S]*?grid-column:\s*3;[\s\S]*?grid-row:\s*2;[\s\S]*?border-left:\s*1px solid var\(--ag-border\);/);
  assert.match(css, /\.ag-fullscreen\.ag-review-drawer-open:not\(\.ag-review-collapsed\) \.ag-review-column\s*\{[^}]*opacity:\s*1;[^}]*visibility:\s*visible;/s);
  assert.match(css, /\.ag-fullscreen \.ag-review-column-close\s*\{[^}]*display:\s*inline-flex;/s);
});

test('changes drawer exposes synchronized accessible state', () => {
  assert.match(source, /reviewColumn\.setAttribute\('aria-labelledby', 'ag-review-column-title'\)/);
  assert.match(source, /reviewColumnTitle\.id = 'ag-review-column-title'/);
  assert.match(source, /environmentChanges\.setAttribute\('aria-expanded', changesActive \? 'true' : 'false'\)/);
  assert.match(source, /reviewColumn\.setAttribute\('aria-hidden', changesActive \? 'false' : 'true'\)/);
  assert.match(source, /reviewColumn\.inert = !changesActive/);
  assert.match(source, /reviewResize\.setAttribute\('role', 'separator'\)/);
  assert.match(source, /reviewResize\.setAttribute\('aria-orientation', 'vertical'\)/);
  assert.match(source, /reviewResize\.setAttribute\('aria-hidden', changesActive \? 'false' : 'true'\)/);
  assert.match(source, /reviewResize\.tabIndex = changesActive \? 0 : -1/);
  assert.match(source, /reviewResize\.inert = !changesActive/);
  assert.match(source, /else applyReviewWidth\(rect\.right - e\.clientX\)/);
  assert.match(source, /else applyReviewWidth\(reviewWidth - delta, \{ persist: true \}\)/);
  assert.match(source, /window\.addEventListener\('pointermove', onColumnResizePointerMove, true\)/);
  assert.match(source, /window\.addEventListener\('pointerup', endColumnResize, true\)/);
  assert.match(source, /window\.removeEventListener\('pointermove', onColumnResizePointerMove, true\)/);
  assert.doesNotMatch(source, /handle\.addEventListener\('pointermove', onColumnResizePointerMove\)/);
  assert.match(css, /\.ag-fullscreen \.ag-review-resize\s*\{[^}]*top:\s*48px;[^}]*right:\s*calc\(var\(--ag-review-w, 480px\) - 3px\);/s);
  assert.match(css, /\.ag-fullscreen \.ag-chat-page\s*\{[^}]*--ag-chat-content-left:\s*max\(24px,[^;]+;/s);
  assert.match(css, /\.ag-fullscreen \.ag-composer\s*\{[^}]*width:\s*min\(860px, calc\(100% - var\(--ag-chat-content-left\) - 24px\)\);[^}]*margin-left:\s*var\(--ag-chat-content-left\);/s);
  assert.match(source, /reviewColumnClose\.setAttribute\('aria-label', '검토 닫기'\)/);
  assert.match(source, /reviewColumnClose\.addEventListener\('click', \(\) => \{[\s\S]*?setReviewColCollapsed\(true\);[\s\S]*?environmentToggle\.focus\(\)/);
  assert.match(source, /if \(root\.classList\.contains\('ag-review-drawer-open'\)\) \{[\s\S]*?setReviewColCollapsed\(true\)/);
  assert.match(css, /\.ag-review-column-close\s*\{[^}]*margin-left:\s*auto;/s);
});

test('the same review node returns to its inline sidebar position after focus mode', () => {
  assert.match(source, /chatPage\.append\(header, connBanner, messages, review, composer\)/);
  assert.match(source, /reviewColumn\.appendChild\(review\)/);
  assert.match(source, /chatPage\.append\(review, composer\)/);
  assert.doesNotMatch(source, /chatPage\.insertBefore\(review, composerUtilities\)/);
});
