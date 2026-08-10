import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');

test('workflow switches use local slash commands and stay separate from the permission profile', () => {
  assert.match(source, /value: '\/plan',[^\n]*workflow: 'plan'/);
  assert.match(source, /value: '\/build',[^\n]*workflow: 'direct'/);
  assert.match(source, /if \(option\.workflow\) \{\s*input\.value = '';\s*requestWorkflow\(option\.workflow\);\s*return;/);
  assert.match(source, /if \(text === '\/plan' \|\| text === '\/build'\) \{[\s\S]*requestWorkflow\(text === '\/plan' \? 'plan' : 'direct'\);\s*return;/);
  // 로컬 명령은 사용자 메시지 기록과 에이전트 전송 전에 끝난다.
  assert.ok(source.indexOf("if (text === '/plan' || text === '/build')") < source.indexOf('recordUserMessage(visibleText)'));
  assert.ok(source.indexOf("if (text === '/plan' || text === '/build')") < source.indexOf('bridge.sendUserMessage(text, skillNameForMessage)'));
  assert.doesNotMatch(source, /ag-workflow-item|workflowGroup|workflowItems/);
  assert.doesNotMatch(css, /\.ag-workflow(?:-item)?\s*\{/);
  assert.match(source, /composerUtilityActions\.append\(phaseBadge, permissionBtn, skillsBtn\)/);
  assert.match(source, /composerUtilities\.append\(composerUtilityActions\)/);
  assert.doesNotMatch(css, /\.ag-composer-utilities\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(source, /permissionBtn\.textContent = unrestricted \? '전체' : '안전'/);
});

test('planning phase shows a persistent compact Korean label and skips a badge in direct mode', () => {
  assert.match(source, /PLANNING_PHASE_LABEL: Record<AgentPhase, string>/);
  assert.match(source, /planning: '계획 중'/);
  assert.match(source, /'awaiting-approval': '승인 대기'/);
  assert.match(source, /switching: '전환 중'/);
  assert.match(source, /implementing: '실행 중'/);
  assert.match(source, /phaseBadge\.setAttribute\('role', 'status'\)/);
  assert.match(source, /phaseBadge\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(source, /phaseBadge\.hidden = !planActive \|\| planningPhase === 'direct'/);
  assert.match(css, /\.ag-phase-badge \{/);
});

test('plan renders as a review-area operator card, not a chat bubble', () => {
  assert.match(source, /function buildPlanCard\(plan: StructuredPlan\)/);
  assert.match(source, /el\('section', `ag-plan-card ag-\$\{selectedAgent\}`\)/);
  assert.match(source, /card\.setAttribute\('aria-labelledby', titleId\)/);
  assert.match(source, /review\.appendChild\(buildPlanCard\(activePlan\)\)/);
  assert.doesNotMatch(source, /ag-msg-plan|messages\.appendChild\(buildPlanCard/);
  // 제목·요약·단계·예상 파일·검증·위험이 모두 카드 안에 있다.
  assert.match(source, /el\('h3', 'ag-plan-title'/);
  assert.match(source, /el\('p', 'ag-plan-summary'/);
  assert.match(source, /'단계'/);
  assert.match(source, /\['예상 파일', plan\.files\]/);
  assert.match(source, /\['검증', plan\.validation\]/);
  assert.match(source, /\['위험', plan\.risks\]/);
  assert.match(css, /\.ag-plan-card \{/);
});

test('long plans stay compact behind an accessible disclosure', () => {
  assert.match(source, /const MAX_PLAN_STEP_LINES = 4/);
  assert.match(source, /const MAX_PLAN_LIST_LINES = 3/);
  assert.match(source, /disclosure\.setAttribute\('aria-expanded', planDetailOpen \? 'true' : 'false'\)/);
  assert.match(source, /disclosure\.setAttribute\('aria-controls', overflow\.id\)/);
  assert.match(source, /overflow\.hidden = !planDetailOpen/);
  assert.match(source, /'자세한 내용 보기'/);
  assert.match(css, /\.ag-plan-disclosure/);
});

test('approval uses the exact plan id and revision routes feedback through the composer', () => {
  assert.match(source, /el\('button', 'ag-approve ag-plan-approve', '승인하고 실행'\)/);
  assert.match(source, /approve\.addEventListener\('click', \(\) => approveActivePlan\(plan\.planId\)\)/);
  assert.match(source, /bridge\.approvePlan\(planId\)/);
  assert.match(source, /el\('button', 'ag-reject ag-plan-revise', '수정 요청'\)/);
  assert.match(source, /bridge\.requestPlanChanges\(planId\)/);
  assert.match(source, /setPlanningPhase\('planning'\);\s*\n\s*systemMessage\('수정 요청을 보냈습니다/);
  assert.match(source, /input\.focus\(\);/);
  // 텍스트 '네/승인'으로는 절대 승인되지 않는다 — 승인 대기 중 입력은 피드백.
  assert.match(
    source,
    /if \(chatWorkflow === 'plan' && planningPhase === 'awaiting-approval'\) \{\s*\n\s*setPlanningPhase\('planning'\);/,
  );
});

test('approval immediately switches to implementation with a disabled, announced switching state', () => {
  assert.match(source, /setPlanningPhase\('switching'\);\s*\n\s*systemMessage\('계획을 승인했습니다\. 실행 단계로 전환 중입니다\.'\)/);
  assert.match(source, /case 'implementation-started':\s*\n\s*planApprovable = false;\s*\n\s*setPlanningPhase\(e\.phase\)/);
  assert.match(source, /approve\.disabled = !approvableNow/);
  assert.match(source, /if \(planningPhase === 'switching'\) return;/);
  assert.match(source, /if \(planningPhase === 'switching'\)[\s\S]*else if \(!planApprovable\)/);
});

test('plan mode warns once about full remote-browser control and scoped downloads', () => {
  assert.match(source, /BROWSERBASE_FULL_CONTROL_WARNING/);
  assert.match(source, /원격 브라우저\(Browserbase\)를 전체 제어/);
  assert.match(source, /양식을 제출하고/);
  assert.match(source, /로그인된 계정의 설정을 바꿀 수 있습니다/);
  assert.match(source, /이 채팅 전용 다운로드 폴더에만 저장됩니다/);
  assert.match(source, /if \(!browserbaseAcknowledged\)/);
  assert.match(source, /browserbaseAcknowledged = true/);
  assert.match(source, /browserbaseNoticePending = true/);
  assert.match(
    source,
    /case 'workflow-changed':[\s\S]*applyWorkflow\(e\.workflow\);[\s\S]*if \(e\.workflow === 'plan' && browserbaseNoticePending\) \{\s*browserbaseNoticePending = false;\s*systemMessage\(BROWSERBASE_ENABLED_NOTICE\);/,
  );
  assert.doesNotMatch(
    source,
    /browserbaseAcknowledged = true;\s*systemMessage\(BROWSERBASE_ENABLED_NOTICE\)/,
  );
  // 동작마다 다시 묻지 않는다.
  assert.match(source, /동작마다 다시 묻지 않고/);
});

test('mode, model and permission switches are locked while a turn runs or the chat is switching', () => {
  assert.match(source, /function isControlLocked\(\): boolean \{\s*\n\s*return turnRunning \|\| workflowTransitionPending \|\| planningPhase === 'switching';/);
  assert.match(source, /workflowTransitionPending = true;[\s\S]*bridge\.setWorkflow\(next\)/);
  assert.match(source, /case 'workflow-changed':[\s\S]*workflowTransitionPending = false/);
  assert.match(source, /const controlsLocked = isControlLocked\(\)/);
  assert.match(source, /providerTrigger\.disabled = controlsLocked/);
  assert.match(source, /llmTrigger\.disabled = controlsLocked/);
  assert.match(source, /effortTrigger\.disabled = controlsLocked/);
  assert.match(source, /permissionBtn\.disabled = controlsLocked \|\| connState !== 'connected'/);
  assert.match(source, /if \(isControlLocked\(\) \|\| connState !== 'connected'\)/);
});

test('entering plan mode is blocked while document edits await review', () => {
  assert.match(source, /function hasPendingDocumentEdits\(\)/);
  assert.match(source, /bridge\.pendingEdits\.getChangeSets\(\)\.length > 0/);
  assert.match(source, /검토 대기 중인 문서 편집이 있습니다/);
});

test('plan history restores for display while only the active server plan is approvable', () => {
  assert.match(source, /currentThread\.workflow = chatWorkflow/);
  assert.match(source, /currentThread\.latestPlan = activePlan/);
  assert.match(source, /threadWorkflows\.set\(id, loaded\.workflow\)/);
  assert.match(source, /const planArchives = new Map<string, StructuredPlan\[\]>\(\)/);
  assert.match(source, /const threadWorkflows = new Map<string, AgentWorkflow>\(\)/);
  assert.match(source, /function restorePlanningForThread\(threadId: string\)/);
  assert.match(source, /planApprovable = false;/);
  assert.match(source, /이전 계획입니다\. 표시만 되고 승인할 수 없습니다\./);
  assert.match(source, /const approvableNow = planApprovable[\s\S]*planningPhase === 'awaiting-approval'[\s\S]*!turnRunning/);
});

test('sidebar consumes the planning bridge contract and its sidebar events', () => {
  // 브리지 계약(agent/bridge.ts)과 사이드바 호출부가 같은 이름을 쓰는지 고정한다.
  for (const method of [
    'getWorkflowState\\(\\): AgentWorkflowState',
    'setWorkflow\\(workflow: AgentWorkflow\\): void',
    'approvePlan\\(planId: string\\): void',
    'requestPlanChanges\\(planId: string, feedback\\?: string\\): void',
  ]) {
    assert.match(bridge, new RegExp(method));
  }
  assert.match(source, /bridge\.getWorkflowState\(\)/);
  assert.match(source, /bridge\.setWorkflow\(next\)/);
  assert.match(source, /bridge\.approvePlan\(planId\)/);
  assert.match(source, /bridge\.requestPlanChanges\(planId\)/);
  // 모델·에이전트 전환으로 세션을 다시 열어도 작업 방식은 유지된다.
  assert.match(source, /bridge\.startChat\([^)]*chatWorkflow\)/);
  for (const event of [
    'workflow-changed',
    'plan-ready',
    'plan-approved',
    'plan-invalidated',
    'implementation-started',
  ]) {
    assert.match(source, new RegExp(`case '${event}':`));
  }
  assert.match(source, /function syncPlanningFromBridge\(\)/);
  assert.match(source, /case 'chat-started':[\s\S]*syncPlanningFromBridge\(\);/);
});

test('pending HWP review stays unchanged for plan-driven implementations', () => {
  assert.match(source, /bridge\.pendingEdits\.approve\(set\.id\)/);
  assert.match(source, /bridge\.pendingEdits\.reject\(set\.id\)/);
  assert.match(source, /const changeSets = bridge\.pendingEdits\.getChangeSets\(\);/);
  assert.match(source, /for \(const set of changeSets\) \{/);
  assert.match(source, /실행 중입니다\. 문서 편집은 기존처럼 검토 후 승인합니다\./);
});

test('planning UI honors icon and motion conventions', () => {
  assert.match(source, /createChevron\('ag-plan-chevron'\)/);
  assert.doesNotMatch(source, /ag-plan[\s\S]{0,400}[▶▼✓✕→]/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.ag-plan-chevron/);
});
