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
  assert.match(source, /composer\.append\(composerOverlay, slashMenu, templateChip, composerField, composerMeta, configPanel\)/);
  assert.doesNotMatch(source, /modelSummary\.append\([^;]*selectors/);
});

test('focus mode is a dedicated shell with navigation and one conversation workspace', () => {
  assert.doesNotMatch(source, /workspaceMark|ag-workspace-mark/);
  assert.doesNotMatch(css, /\.ag-workspace-mark/);
  assert.match(source, /let reviewColCollapsed = true;/);
  assert.match(source, /let planColCollapsed = true;/);
  assert.match(source, /const detailActive = changesActive \|\| planActive;/);
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
  assert.match(source, /environmentPlanSection\.appendChild\(environmentPlan\)/);
  assert.match(source, /environmentChangesSection\.appendChild\(environmentChanges\)/);
  assert.match(source, /environmentPanel\.append\([\s\S]*environmentPlanSection,[\s\S]*environmentChangesSection/);
  assert.match(source, /workspaceTrailing\.append\(workspaceAgentContext, environmentWrap, workspaceExitBtn\)/);
  assert.match(source, /environmentToggle\.addEventListener\('click',[\s\S]*setEnvironmentPanelOpen\(!environmentPanelOpen\)/);
  assert.match(source, /environmentChanges\.addEventListener\('click',[\s\S]*setReviewColCollapsed\(false\);[\s\S]*setEnvironmentPanelOpen\(false\)/);
  assert.match(source, /environmentPlan\.addEventListener\('click',[\s\S]*setPlanColCollapsed\(false\);[\s\S]*setEnvironmentPanelOpen\(false\)/);
  assert.match(source, /updateEnvironmentFilename\(currentDocumentName\)/);
  assert.match(source, /파일 첨부나 대화 브랜치 기능이 생기면/);
  assert.doesNotMatch(source, /environmentPanel[\s\S]{0,120}pointerdown/);
  assert.match(css, /\.ag-environment-panel\s*\{[^}]*position:\s*absolute;[^}]*box-shadow:\s*var\(--n-elev-3\)/s);
  assert.match(css, /\.ag-fullscreen \.ag-environment-wrap\s*\{[^}]*position:\s*static;/s);
  assert.match(css, /\.ag-fullscreen \.ag-environment-panel\s*\{[^}]*right:\s*8px;/s);
  assert.match(css, /@keyframes ag-filename-marquee/);
  assert.match(css, /\.ag-fullscreen\s*\{[^}]*--ag-environment-panel-width:\s*clamp\(260px, 36vw, 360px\);[^}]*--ag-environment-lane-width:/s);
  assert.match(css, /\.ag-fullscreen \.ag-chat-page\s*\{[^}]*padding-inline-end:\s*0;[^}]*transition:\s*padding-inline-end 320ms/s);
  assert.match(css, /\.ag-fullscreen\.ag-environment-open:not\(\.ag-detail-drawer-open\) \.ag-chat-page\s*\{[^}]*padding-inline-end:\s*var\(--ag-environment-lane-width\);/s);
  assert.match(css, /\.ag-fullscreen \.ag-environment-panel\s*\{[^}]*width:\s*min\(var\(--ag-environment-panel-width, 360px\), calc\(100vw - 16px\)\);/s);
  assert.doesNotMatch(css, /\.ag-fullscreen\.ag-environment-open \.ag-messages,[\s\S]*?transform:\s*translateX/);
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
  assert.match(css, /\.ag-review-summary\s*\{[^}]*max-height:\s*26dvh;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.ag-review-actions\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(css, /\.ag-fullscreen \.ag-review-column \.ag-review-summary\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s);
  assert.match(css, /\.ag-fullscreen \.ag-review-column \.ag-review\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
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
  assert.match(source, /reviewResize\.setAttribute\('aria-hidden', detailActive \? 'false' : 'true'\)/);
  assert.match(source, /reviewResize\.tabIndex = detailActive \? 0 : -1/);
  assert.match(source, /reviewResize\.inert = !detailActive/);
  assert.match(source, /else applyReviewWidth\(rect\.right - e\.clientX\)/);
  assert.match(source, /else applyReviewWidth\(reviewWidth - delta, \{ persist: true \}\)/);
  assert.match(source, /window\.addEventListener\('pointermove', onColumnResizePointerMove, true\)/);
  assert.match(source, /window\.addEventListener\('pointerup', endColumnResize, true\)/);
  assert.match(source, /window\.removeEventListener\('pointermove', onColumnResizePointerMove, true\)/);
  assert.doesNotMatch(source, /handle\.addEventListener\('pointermove', onColumnResizePointerMove\)/);
  assert.match(css, /\.ag-fullscreen \.ag-review-resize\s*\{[^}]*top:\s*48px;[^}]*right:\s*calc\(var\(--ag-review-w, 480px\) - 3px\);/s);
  assert.match(css, /\.ag-fullscreen \.ag-messages\s*\{[^}]*width:\s*min\(860px, calc\(100% - 48px\)\);[^}]*margin-inline:\s*auto;/s);
  assert.match(css, /\.ag-fullscreen \.ag-composer\s*\{[^}]*width:\s*min\(860px, calc\(100% - 48px\)\);[^}]*margin-inline:\s*auto;/s);
  assert.match(source, /reviewColumnClose\.setAttribute\('aria-label', '검토 닫기'\)/);
  assert.match(source, /reviewColumnClose\.addEventListener\('click', \(\) => \{[\s\S]*?setReviewColCollapsed\(true\);[\s\S]*?environmentToggle\.focus\(\)/);
  assert.match(source, /if \(root\.classList\.contains\('ag-detail-drawer-open'\)\) \{/);
  assert.match(css, /\.ag-review-column-close\s*\{[^}]*margin-left:\s*auto;/s);
});

test('the same review node returns to its inline sidebar position after focus mode', () => {
  assert.match(source, /chatPage\.append\(header, connBanner, messages, review, planSurface, questionController\.root, composer\)/);
  assert.match(source, /reviewColumn\.appendChild\(review\)/);
  assert.match(source, /planColumn\.appendChild\(planSurface\)/);
  assert.match(source, /chatPage\.append\(review, planSurface, questionController\.root, composer\)/);
  assert.doesNotMatch(source, /chatPage\.insertBefore\(review, composerUtilities\)/);
});

test('sidebar plan minimizes into a restorable animated orbit above the composer', () => {
  assert.match(source, /const planRestore = el\('button', 'ag-plan-restore'\)/);
  assert.match(source, /minimize\.addEventListener\('click', \(\) => setPlanMinimized\(true\)\)/);
  assert.match(source, /planRestore\.addEventListener\('click', \(\) => setPlanMinimized\(false\)\)/);
  assert.match(source, /planSurface\.classList\.toggle\('ag-plan-minimized', compact\)/);
  assert.match(source, /composerOverlay\.append\(planRestore\)/);
  assert.doesNotMatch(source, /planRestore\.hidden/);
  assert.doesNotMatch(source, /composerOverlay\.hidden/);
  assert.match(css, /\.ag-plan-surface\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(
    css,
    /\.ag-plan-surface\.ag-plan-minimized\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*0fr\);[^}]*max-height:\s*0;[^}]*border-top-width:\s*0;/s,
  );
  assert.match(css, /\.ag-plan-minimized \.ag-plan-card-slot\s*\{[^}]*transform:\s*scale\(0\.08\);/s);
  assert.match(css, /\.ag-composer-overlay\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*calc\(100% \+ 5px \+ var\(--ag-fleet-dock-h, 0px\)\);/s);
  assert.match(css, /@keyframes ag-plan-orbit/);
});

test('inline sidebar review offers icon-labeled accept and decline actions', () => {
  assert.match(source, /createIcon\('check', 'ag-review-action-icon'\)/);
  assert.match(source, /el\('span', 'ag-review-action-label', '변경 수락'\)/);
  assert.match(source, /createIcon\('close', 'ag-review-action-icon'\)/);
  assert.match(source, /el\('span', 'ag-review-action-label', '변경 거절'\)/);
  assert.match(source, /bridge\.pendingEdits\.approve\(set\.id\)/);
  assert.match(source, /bridge\.pendingEdits\.reject\(set\.id\)/);
  assert.match(css, /\.ag-change-action\s*\{[^}]*display:\s*inline-flex;[^}]*gap:\s*7px;/s);
});
