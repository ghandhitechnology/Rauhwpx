import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const markdown = readFileSync(new URL('../src/ui/agent-sidebar/plan-markdown.ts', import.meta.url), 'utf8');

test('plan and build slash commands accept a trailing prompt and switch before sending', () => {
  assert.match(source, /const workflowInvocation = text\.match\(\/\^\\\/\(plan\|build\|question\)\(\?:\\s\+\(\[\\s\\S\]\*\)\)\?\$\/i\)/);
  assert.match(source, /command === 'question' \? 'question'/);
  assert.match(source, /if \(!requestWorkflow\(next\)\) \{\s*if \(rest\) input\.value = rest;\s*return;\s*\}/);
  assert.match(source, /if \(!rest\) \{\s*input\.focus\(\);\s*return;\s*\}/);
  assert.match(source, /text = rest;/);
  assert.match(source, /function requestWorkflow\(next: AgentWorkflow\): boolean/);
});

test('workflow switches use local slash commands without changing the access profile', () => {
  assert.match(source, /value: '\/plan',[^\n]*workflow: 'plan'/);
  assert.match(source, /value: '\/question',[^\n]*workflow: 'question'/);
  assert.match(source, /value: '\/build',[^\n]*workflow: 'direct'/);
  assert.match(source, /if \(option\.workflow\) \{\s*input\.value = '';\s*requestWorkflow\(option\.workflow\);\s*return;/);
  assert.match(source, /if \(workflowInvocation\) \{[\s\S]*requestWorkflow\(next\)/);
  // 로컬 명령은 사용자 메시지 기록과 에이전트 전송 전에 끝난다.
  assert.ok(source.indexOf('const workflowInvocation = text.match') < source.indexOf('recordUserMessage(messageText,'));
  assert.ok(source.indexOf('const workflowInvocation = text.match') < source.indexOf('bridge.sendUserMessage(requestText, skillNameForMessage,'));
  assert.doesNotMatch(source, /ag-workflow-item|workflowGroup|workflowItems/);
  assert.doesNotMatch(css, /\.ag-workflow(?:-item)?\s*\{/);
  assert.match(source, /composerUtilityActions\.append\(phaseBadge, permissionBtn\)/);
  assert.match(source, /composerUtilities\.append\(composerUtilityActions\)/);
  assert.doesNotMatch(css, /\.ag-composer-utilities\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(source, /permissionBtn\.textContent = unrestricted \? '전체' : '안전'/);
  assert.match(source, /const planReadOnly = chatWorkflow === 'question'\s*\|\| \(chatWorkflow === 'plan' && planningPhase !== 'implementing'\)/);
  assert.match(source, /'전체 접근 · 계획 단계는 읽기 전용'/);
  assert.match(source, /'전체 접근 · 질문 단계는 읽기 전용'/);
  assert.doesNotMatch(source, /planPermissionDefaultPending/);
  assert.doesNotMatch(source, /e\.workflow === 'plan'[\s\S]{0,300}bridge\.setPermissionProfile\('unrestricted'\)/);
  assert.doesNotMatch(source, /workflowTransitionPending = true;\s*applyWorkflow\(next\);\s*bridge\.setWorkflow\(next\)/);
  assert.match(source, /workflowTransitionPending = true;\s*bridge\.setWorkflow\(next\)/);
});

test('composer submit keeps plan-transition locks', () => {
  assert.match(
    source,
    /if \(planningPhase === 'switching' \|\| workflowTransitionPending \|\| planActionPending/,
  );
});

test('planning phase shows a persistent compact Korean label and skips a badge in direct mode', () => {
  assert.match(source, /PLANNING_PHASE_LABEL: Record<AgentPhase, string>/);
  assert.match(source, /planning: '구상 중'/);
  assert.match(source, /questioning: '질문 중'/);
  assert.match(source, /'awaiting-approval': '승인 대기'/);
  assert.match(source, /switching: '전환 중'/);
  assert.match(source, /implementing: '실행 중'/);
  assert.match(source, /phaseBadge\.setAttribute\('role', 'status'\)/);
  assert.match(source, /phaseBadge\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(source, /phaseBadge\.hidden = !planActive \|\| planningPhase === 'direct'/);
  assert.match(css, /\.ag-phase-badge \{/);
});

test('plan renders as a readable document with a clickable chat presentation', () => {
  assert.match(source, /function buildPlanCard\(plan: StructuredPlan\)/);
  assert.match(source, /el\('section', `ag-plan-card ag-plan-doc ag-\$\{selectedAgent\}`\)/);
  assert.match(source, /card\.setAttribute\('role', 'article'\)/);
  assert.match(source, /card\.setAttribute\('aria-labelledby', titleId\)/);
  assert.match(source, /const card = buildPlanCard\(activePlan\);[\s\S]*planCardSlot\.appendChild\(card\)/);
  assert.match(source, /function renderPlanMessage\(message: Extract<ThreadMessage, \{ kind: 'plan' \}>\)/);
  assert.match(source, /el\('button', 'ag-msg-plan-action'\)/);
  assert.match(source, /openPresentedPlan\(message\.planId\)/);
  assert.match(source, /presentPlanInChat\(e\.plan\)/);
  assert.match(source, /setPlanColCollapsed\(false\)/);
  assert.match(css, /\.ag-msg-plan-action \{/);
  // 단계는 대상·예상 결과가 접기 상태에도 보이고, 보조 정보만 접힌다.
  assert.match(source, /el\('h3', 'ag-plan-title'/);
  assert.match(source, /el\('p', 'ag-plan-goal', goalText\)/);
  assert.match(source, /el\(hasDetails \? 'details' : 'div', 'ag-plan-step-details'\)/);
  assert.match(source, /ag-plan-step-preview/);
  assert.match(source, /el\('details', 'ag-plan-secondary'\)/);
  assert.match(source, /ag-plan-validation-list/);
  assert.match(source, /safeMarkdownHref\(source\.url\)/);
  assert.match(source, /source\.fileId, source\.chunkId/);
  assert.match(css, /\.ag-plan-card \{/);
  assert.match(css, /\.ag-plan-body \{/);
});

test('plan sections and actions share normal flow inside the separate plan scrollport', () => {
  assert.doesNotMatch(source, /MAX_PLAN_STEP_LINES|MAX_PLAN_LIST_LINES|planDetailOpen|ag-plan-disclosure/);
  assert.doesNotMatch(css, /\.ag-plan-disclosure/);
  assert.match(css, /\.ag-plan-card-slot \{[^}]*overflow-y: auto;/s);
  assert.match(source, /review\.tabIndex = 0/);
  assert.match(source, /review\.setAttribute\('aria-label', '변경 사항 검토'\)/);
  assert.match(source, /planSurface\.setAttribute\('aria-label', '실행 계획'\)/);
  assert.match(css, /\.ag-plan-card \{[^}]*flex: 0 0 auto;/s);
  assert.match(css, /\.ag-plan-body \{[^}]*flex: 0 0 auto;[^}]*overflow: visible;/s);
  assert.match(css, /\.ag-plan-footer \{[^}]*position: static;/s);
  assert.doesNotMatch(css, /\.ag-plan-footer \{[^}]*position: sticky;/s);
});

test('execution updates keep the plan visible and preserve reading position', () => {
  assert.match(source, /case 'plan-progress':[\s\S]*recordPlan\(e\.latestPlan\);[\s\S]*showPlanExecution\(e\.planId\)/);
  assert.match(source, /const previousScrollTop = planCardSlot\.scrollTop/);
  assert.match(source, /const openStepIds = new Set/);
  assert.match(source, /const openSecondaryLabels = new Set/);
  assert.match(source, /target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /planCardSlot\.scrollTop = previousScrollTop/);
  assert.match(source, /if \(previousPlanId === activePlan\.planId\) card\.classList\.add\('ag-plan-update'\)/);
  assert.match(css, /\.ag-plan-card\.ag-plan-update \{ animation: none; \}/);
  assert.match(source, /step\.id \?\? `step-\$\{index \+ 1\}`/);
  assert.match(css, /\.ag-plan-step\[data-status='in-progress'\]/);
});

test('draft and revision controls submit distinct plan requests', () => {
  assert.match(source, /function buildPlanDraftCard\(\): HTMLElement/);
  assert.match(source, /현재 대화를 바탕으로 계획 초안을 작성해 주세요/);
  assert.match(source, /composer\.requestSubmit\(\)/);
  assert.match(source, /function preparePlanRevision\(planId: string\)/);
  assert.match(source, /revisionPlanId = revisionPlanId === planId \? null : planId/);
  assert.match(source, /sent = bridge\.requestPlanChanges\(planId, text\)/);
  assert.match(source, /revisionPlanId && referenceLibrary\.hasDrafts\(\)/);
  assert.match(source, /revisionPlanId = null;[\s\S]*function restorePlanningForThread/);
});

test('approval uses the exact plan id and waits for authoritative hub phase events', () => {
  assert.match(source, /el\('button', 'ag-approve ag-plan-approve', '문서에 적용'\)/);
  assert.match(source, /approve\.addEventListener\('click', \(\) => approveActivePlan\(plan\.planId\)\)/);
  assert.match(source, /bridge\.approvePlan\(planId\)/);
  assert.match(source, /el\('button', 'ag-reject ag-plan-revise', revisionPlanId === plan\.planId/);
  assert.match(source, /bridge\.requestPlanChanges\(planId, text\)/);
  assert.match(source, /if \(planningPhase === 'awaiting-approval'\) footer\.appendChild\(actions\);[\s\S]*if \(footer\.childElementCount > 0\) card\.appendChild\(footer\)/);
  assert.match(source, /planActionPending = true;[\s\S]*bridge\.requestPlanChanges\(planId, text\)/);
  assert.match(source, /input\.focus\(\);/);
  assert.doesNotMatch(
    source,
    /if \(chatWorkflow === 'plan' && planningPhase === 'awaiting-approval'\) \{\s*\n\s*setPlanningPhase\('planning'\);/,
  );
  assert.doesNotMatch(source, /function approveActivePlan[\s\S]{0,500}setPlanningPhase\('switching'\)/);
  assert.doesNotMatch(source, /function requestPlanRevision[\s\S]{0,500}setPlanningPhase\('planning'\)/);
  assert.doesNotMatch(source, /승인은 이 버튼으로만 됩니다/);
});

test('approval disables duplicate actions and switches only after hub acknowledgement', () => {
  assert.match(source, /planActionPending = true;\s*rebuildReview\(\);\s*try \{\s*if \(!bridge\.approvePlan\(planId\)\)/);
  assert.match(source, /sent = bridge\.requestPlanChanges\(planId, text\)/);
  assert.match(source, /const hadPendingAction = planActionPending;\s*planActionPending = false;\s*const state = bridge\.getWorkflowState\(\)/);
  assert.match(source, /case 'plan-approved':[\s\S]*planActionPending = false;[\s\S]*setPlanningPhase\(e\.phase\)/);
  assert.match(source, /case 'implementation-started':[\s\S]*showPlanExecution\(e\.planId \|\| activePlan\?\.planId \|\| ''\)/);
  assert.match(source, /case 'plan-progress':[\s\S]*activePlan = e\.latestPlan;[\s\S]*recordPlan\(e\.latestPlan\)/);
  assert.match(source, /&& !planActionPending[\s\S]*approve\.disabled = !approvableNow/);
  assert.match(source, /if \(planningPhase === 'switching' \|\| workflowTransitionPending \|\| planActionPending[\s\S]*referenceLibrary\.hasBlockingDrafts\(\)\) return;/);
  assert.match(source, /if \(planningPhase === 'switching'\)[\s\S]*else if \(planningPhase === 'implementing'\)/);
  assert.match(source, /승인했습니다\. 실행 단계로 전환 중입니다…/);
});

test('plan mode warns once about full remote-browser control and scoped downloads', () => {
  assert.match(source, /BROWSERBASE_FULL_CONTROL_WARNING/);
  assert.match(source, /BROWSERBASE_FULL_CONTROL_TITLE = '원격 브라우저 전체 제어'/);
  assert.match(source, /양식을 제출하고/);
  assert.match(source, /로그인된 계정의 설정을 바꿀 수 있습니다/);
  assert.match(source, /이 채팅 전용 다운로드 폴더에만 저장됩니다/);
  assert.match(source, /if \(!browserbaseAcknowledged\)/);
  assert.match(source, /browserbaseAcknowledged = true/);
  assert.match(source, /browserbaseNoticePending = true/);
  assert.match(
    source,
    /case 'workflow-changed':[\s\S]*applyWorkflow\(e\.workflow\);[\s\S]*if \(\(e\.workflow === 'plan' \|\| e\.workflow === 'question'\) && browserbaseNoticePending\) \{\s*browserbaseNoticePending = false;\s*systemMessage\(BROWSERBASE_ENABLED_NOTICE\);/,
  );
  assert.doesNotMatch(
    source,
    /browserbaseAcknowledged = true;\s*systemMessage\(BROWSERBASE_ENABLED_NOTICE\)/,
  );
  // 동작마다 다시 묻지 않는다.
  assert.match(source, /에이전트가 묻지 않고 페이지를 열고/);
  // 확인 시트는 비동기라 승인 후 같은 전환을 다시 요청한다.
  assert.match(source, /confirmSheet\(root, BROWSERBASE_FULL_CONTROL_TITLE, BROWSERBASE_FULL_CONTROL_WARNING[\s\S]{0,400}requestWorkflow\(next\);/);
});

test('mode, model and permission switches are locked while a turn runs or the chat is switching', () => {
  assert.match(source, /function isControlLocked\(\): boolean \{[\s\S]*return turnRunning \|\| attachmentsSending \|\| chatStartPendingThreadId !== null[\s\S]*workflowTransitionPending \|\| planActionPending \|\| planningPhase === 'switching';/);
  assert.match(source, /workflowTransitionPending = true;[\s\S]*bridge\.setWorkflow\(next\)/);
  assert.match(source, /case 'workflow-changed':[\s\S]*workflowTransitionPending = false/);
  assert.match(source, /permissionBtn\.addEventListener[\s\S]*workflowTransitionPending = true;[\s\S]*bridge\.setPermissionProfile\(nextProfile\)/);
  assert.match(source, /case 'permission-changed':[\s\S]*workflowTransitionPending = false/);
  assert.match(source, /input\.disabled =[\s\S]*workflowTransitionPending \|\| planActionPending/);
  assert.match(source, /send\.disabled =[\s\S]*workflowTransitionPending \|\| planActionPending/);
  assert.match(source, /const controlsLocked = isControlLocked\(\)/);
  assert.match(source, /providerTrigger\.disabled = selectionLocked/);
  assert.match(source, /llmTrigger\.disabled = selectionLocked/);
  assert.match(source, /effortTrigger\.disabled = selectionLocked/);
  assert.match(source, /permissionBtn\.disabled = controlsLocked \|\| connState !== 'connected'/);
  assert.match(source, /if \(selectionLocked && chatStartPendingThreadId === null\) setConfigPanelOpen\(false\)/);
  assert.match(source, /if \(isControlLocked\(\) \|\| connState !== 'connected'\)/);
});

test('entering plan mode is blocked while document edits await review', () => {
  assert.match(source, /function hasPendingDocumentEdits\(\)/);
  assert.match(source, /bridge\.pendingEdits\.getChangeSets\(\)\.length > 0/);
  assert.match(source, /검토 대기 중인 편집을 먼저 처리합니다/);
});

test('completed plans open as history without reactivating live plan UI', () => {
  assert.match(source, /const restartCompletedPlan = next === 'plan'[\s\S]*planningPhase === 'implementing'/);
  assert.match(source, /if \(next === chatWorkflow && !restartCompletedPlan\)/);
  assert.match(source, /button\.addEventListener\('click', \(\) => openPresentedPlan\(message\.planId\)\)/);
  assert.match(source, /activePlanHistorical = workflowState\.latestPlan\?\.planId !== planId[\s\S]*execution\?\.status === 'completed'/);
  assert.match(source, /activePlanHistorical \? '계획 기록' : plan\.execution/);
  assert.match(source, /if \(!activePlanHistorical\) \{[\s\S]*const approvableNow = planApprovable/);
  assert.match(source, /planRestore\.replaceChildren\(activePlanHistorical \? planHistoryIcon : planOrbit\)/);
  assert.match(source, /activePlanHistorical \? '계획 기록 펼치기' : '계획 펼치기'/);
  assert.match(css, /\.ag-plan-history-icon \{[^}]*width:\s*20px;[^}]*height:\s*20px;/s);
});

test('plan history and chat presentations restore while only the active server plan is approvable', () => {
  assert.match(source, /currentThread\.workflow = chatWorkflow/);
  assert.match(source, /message\.kind === 'plan'/);
  assert.match(source, /message\.planId === plan\.planId/);
  assert.match(source, /appendConversation\(renderPlanMessage\(msg\)\)/);
  assert.match(source, /currentThread\.latestPlan = activePlan/);
  assert.match(source, /currentThread\.plans = \[\.\.\.planHistory\]/);
  assert.match(source, /loaded\.plans\?\.length/);
  assert.match(source, /threadWorkflows\.set\(id, loaded\.workflow\)/);
  assert.match(source, /const planArchives = new Map<string, StructuredPlan\[\]>\(\)/);
  assert.match(source, /const threadWorkflows = new Map<string, AgentWorkflow>\(\)/);
  assert.match(source, /function restorePlanningForThread\(threadId: string, thread\?: ChatThread\)/);
  assert.match(source, /message\.planState === 'executed'/);
  assert.match(source, /el\('span', 'ag-msg-plan-kicker', executed \? '실행 됨' : '계획'\)/);
  assert.match(source, /activePlan = latestPlan;/);
  assert.match(source, /planApprovable = false;/);
  assert.doesNotMatch(source, /이전 계획입니다\. 표시만 되고 승인할 수 없습니다\./);
  assert.match(source, /const approvableNow = planApprovable[\s\S]*planningPhase === 'awaiting-approval'[\s\S]*!turnRunning/);
});

test('sidebar consumes the planning bridge contract and its sidebar events', () => {
  // 브리지 계약(agent/bridge.ts)과 사이드바 호출부가 같은 이름을 쓰는지 고정한다.
  for (const method of [
    'getWorkflowState\\(\\): AgentWorkflowState',
    'setWorkflow\\(workflow: AgentWorkflow\\): void',
    'approvePlan\\(planId: string\\): boolean',
    'requestPlanChanges\\(planId: string, feedback\\?: string\\): boolean',
  ]) {
    assert.match(bridge, new RegExp(method));
  }
  assert.match(source, /bridge\.getWorkflowState\(\)/);
  assert.match(source, /bridge\.setWorkflow\(next\)/);
  assert.match(source, /bridge\.approvePlan\(planId\)/);
  assert.match(source, /bridge\.requestPlanChanges\(planId, text\)/);
  // 모델·에이전트 전환으로 세션을 다시 열어도 작업 방식은 유지된다.
  assert.match(source, /bridge\.startChat\([^)]*chatWorkflow,[^)]*currentThread\.id/);
  for (const event of [
    'workflow-changed',
    'plan-ready',
    'plan-approved',
    'plan-invalidated',
    'implementation-started',
    'planning-document-saved',
  ]) {
    assert.match(source, new RegExp(`case '${event}':`));
  }
  assert.match(source, /function syncPlanningFromBridge\(\)/);
  assert.match(source, /case 'chat-started':[\s\S]*syncPlanningFromBridge\(\);/);
});

test('plan card submission is announced from the tool call, not from assistant prose', () => {
  assert.match(source, /event\.tool === 'present_implementation_plan'/);
  assert.match(source, /계획 카드를 만드는 중/);
  assert.match(source, /계획 카드가 도착하지 않았습니다/);
});

test('saving the document during planning notifies the agent instead of locking the editor', () => {
  assert.match(source, /case 'planning-document-saved':/);
  assert.match(source, /문서를 저장했습니다/);
  assert.match(source, /if \(e\.reason !== 'document-saved' && e\.reason !== 'workflow-changed'\) \{/);
  assert.match(source, /계획을 수정하고 있습니다/);
  assert.match(bridge, /type: 'chat-document-saved'/);
});

test('pending HWP review stays unchanged for plan-driven implementations', () => {
  assert.match(source, /bridge\.pendingEdits\.approve\(set\.id\)/);
  assert.match(source, /bridge\.pendingEdits\.reject\(set\.id\)/);
  assert.match(source, /const changeSets = bridge\.pendingEdits\.getChangeSets\(\);/);
  assert.match(source, /const reviewSets = changeSets\.filter\(\(set\) => set\.status !== 'open'\)/);
  assert.match(source, /for \(const set of reviewSets\) \{/);
  assert.match(source, /변경 사항을 검토해 주세요/);
  // 구상·승인 대기 턴은 문서를 편집하지 않았으므로 일반 작업 완료 문구를 붙이지 않는다.
  assert.match(source, /const editingPhase = chatWorkflow === 'direct' \|\| planningPhase === 'implementing'/);
  assert.match(source, /turnToolCount > 0 && !turnPresentedPlan && !finalBubble && completed && editingPhase/);
});

test('planning UI honors icon and motion conventions', () => {
  // 계획 문서에는 글자 아이콘을 쓰지 않는다 — 체크 표시도 CSS 가 그린다.
  assert.doesNotMatch(source, /ag-plan[\s\S]{0,400}[▶▼✓✕→]/);
  assert.doesNotMatch(markdown, /[▶▼✓✕→]/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.ag-plan-card \{\s*\n\s*animation: none;/);
});
