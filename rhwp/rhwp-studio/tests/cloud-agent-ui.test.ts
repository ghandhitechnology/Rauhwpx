import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const sidebarCss = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const cloudUi = readFileSync(new URL('../src/ui/agent-sidebar/cloud-ui.ts', import.meta.url), 'utf8');
const cloudCss = readFileSync(new URL('../src/ui/agent-sidebar/cloud-ui.css', import.meta.url), 'utf8');
const onboarding = readFileSync(new URL('../src/ui/agent-sidebar/cloud-onboarding.ts', import.meta.url), 'utf8');
const onboardingCss = readFileSync(new URL('../src/ui/agent-sidebar/cloud-onboarding.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const desktop = readFileSync(new URL('../src/desktop-integration.ts', import.meta.url), 'utf8');
const agentTools = readFileSync(new URL('../../rhwp-agent/tools.mjs', import.meta.url), 'utf8');
const executor = readFileSync(new URL('../src/agent/tool-executor.ts', import.meta.url), 'utf8');
const pending = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');
const cloudStart = readFileSync(new URL('../src/cloud/cloud-start.ts', import.meta.url), 'utf8');

test('empty-thread composer exposes a Local/Cloud switch and starts Cloud on first Send', () => {
  assert.match(sidebar, /ag-composer-mode-row/);
  assert.match(sidebar, /ag-cloud-mode-badge/);
  assert.match(sidebar, /function startCloudFromFirstMessage/);
  assert.match(sidebar, /CLOUD_UNSAVED_MESSAGE/);
  assert.match(cloudStart, /클라우드 사용 전 문서를 저장해주세요/);
  assert.match(sidebar, /execution\.kind === 'cloud-start'/);
  assert.match(sidebar, /if \(currentDocumentId\) void deleteCloudComposerDraft/);
  assert.match(sidebarCss, /\.ag-composer-mode-row/);
  assert.match(sidebarCss, /\.ag-cloud-start-placeholder/);
  assert.doesNotMatch(sidebar, /클라우드로 계속/);
});

test('cloud action is available in sidebar and fullscreen headers', () => {
  assert.match(sidebar, /headerActions\.insertBefore\(cloudUi\.sidebarButton/);
  assert.match(sidebar, /workspaceTrailing\.insertBefore\(cloudUi\.workspaceButton/);
  assert.match(cloudUi, /createIcon\('cloud'\)/);
  assert.match(cloudUi, /ag-cloud-session-select/);
  assert.match(cloudUi, /selectedSessionId/);
  assert.match(cloudUi, /createCloudOnboarding/);
  assert.match(sidebar, /loginAccount: \(\) => bridge\.loginRauAccount\(\)/);
  assert.match(sidebar, /cloudUi\.handleAccountEvent/);
  assert.match(onboarding, /내 VPS에서 Cloud 시작하기/);
  assert.match(onboarding, /Tailscale HTTPS 포트/);
  assert.match(onboarding, /async function checkConnection[\s\S]*controller\.testProfile\(draft\)/);
  const installFlow = onboarding.match(/async function install[\s\S]*?\n  }\n\n  async function pairExisting/)?.[0] ?? '';
  assert.match(installFlow, /controller\.provision\('stable', draft\)/);
  assert.doesNotMatch(installFlow, /saveProfile/);
  assert.doesNotMatch(installFlow, /testProfile/);
  assert.match(onboarding, /controller\.pair\(pairingCode, draft\)/);
  assert.match(onboarding, /operationEpoch/);
  assert.match(onboarding, /node\.inert = true/);
  assert.match(onboarding, /preserveOnOpen\s*\n?\s*&& \(state\?\.kind === 'install-failed' \|\| state\?\.kind === 'sandbox-failed'\)/);
  assert.match(onboarding, /연결 정보 수정/);
  assert.match(onboarding, /role', 'dialog'/);
  assert.match(onboarding, /aria-modal', 'true'/);
  assert.match(onboarding, /event\.key !== 'Tab'/);
  assert.match(onboardingCss, /max-width:\s*600px/);
  assert.match(onboardingCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(cloudUi, /sidebarButton\.hidden = !snapshot\.available/);
  assert.match(cloudUi, /workspaceButton\.hidden = !snapshot\.available/);
  assert.match(cloudUi, /onWorkspaceSwitchVisibilityChange\([\s\S]*shouldShowCloudWorkspaceSwitch/);
  assert.match(sidebar, /onWorkspaceSwitchVisibilityChange:[\s\S]*syncWorkspaceModeAvailability\(\)/);
  assert.match(sidebarCss, /\.ag-workspace-mode-switch\[hidden\][\s\S]*display:\s*none/);
  assert.match(cloudUi, /aria-controls', 'ag-cloud-panel/);
  assert.match(cloudUi, /closePanel\(true\)/);
  assert.match(cloudUi, /const focusTrigger = panelTrigger \?\? sidebarButton/);
  assert.match(onboarding, /document\.body\.appendChild\(overlay\)/);
  assert.match(sidebar, /stage\.appendChild\(cloudUi\.statusPanel\)/);
  assert.match(cloudCss, /\.ag-cloud-btn\[hidden\],[\s\S]*\.ag-workspace-cloud-btn\[hidden\][\s\S]*display:\s*none/);
});

test('Raucloud stays visible but locks account-scoped starts without locking self-hosted', () => {
  assert.match(cloudUi, /function raucloudLock\(snapshot: CloudSnapshot\)/);
  assert.match(cloudUi, /snapshot\.profile\.mode !== 'app-hosted'\) return null/);
  assert.match(cloudUi, /sidebarButton\.hidden = !snapshot\.available/);
  assert.match(cloudUi, /Raucloud를 사용하려면 로그인해야 합니다/);
  assert.match(onboarding, /option\.disabled = disabled/);
  assert.match(onboarding, /Boolean\(raucloudHardLock\(snapshot\)\)/);
  assert.match(onboarding, /loginRequired && \(accountAuthPending \|\| accountBusy \|\| !deps\.loginAccount\)/);
  assert.match(onboarding, /accountAuthPending \|\| accountBusy \? '로그인 확인 중…' : '로그인'/);
  assert.match(onboarding, /window\.open\(next\.authUrl, '_blank', 'noopener,noreferrer'\)/);
  assert.match(onboarding, /'내 서버 사용'/);
  assert.match(onboarding, /내 서버는 로그인 없이 연결할 수 있습니다/);
});

test('cloud transfer includes portable timeline, exact document bytes and reference bytes', () => {
  assert.match(sidebar, /buildCloudStartTransfer\(\{/);
  assert.match(sidebar, /startId/);
  assert.match(sidebar, /initialMessage/);
  assert.match(sidebar, /const bytes = await cloudController\.readReference\(descriptor\)/);
  assert.match(sidebar, /references\.push\(\{ \.\.\.descriptor, bytes \}\)/);
  assert.match(cloudStart, /permissionProfile: 'unrestricted'/);
  const transfer = sidebar.match(/async function transferCurrentSession\([\s\S]*?\n  function ensureCloudTransferIntent/)?.[0] ?? '';
  assert.doesNotMatch(transfer, /setPermissionProfile\('unrestricted'\)/);
  const prepare = main.match(/async function prepareCloudTransferDocument\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(prepare, /saveCurrentDocument/);
  assert.match(prepare, /documentState\.isDirty\(\) \|\| wasm\.isNewDocument/);
  assert.match(main, /exportDocumentForFormat\(wasm, format\)/);
  assert.match(main, /isNewDocument: wasm\.isNewDocument/);
});

test('cloud lease locks local editing and queued messages cross only at a remote boundary', () => {
  assert.match(cloudUi, /isCloudConversation: \(\) => cloudOwnsConversation\(snapshot\)/);
  assert.match(cloudUi, /async queueMessage\(text, messageId, attachments = \[\], target\)/);
  assert.match(cloudUi, /command: 'queue-message'/);
  assert.match(cloudUi, /expectedVersion: target\.expectedVersion/);
  assert.match(main, /setCloudDocumentLease/);
  assert.match(main, /syncDocumentReadOnly/);
  assert.match(main, /cloudAuthorityTransitionCount > 0/);
  assert.match(main, /inputHandler\?\.setReadOnly\(documentReadOnly\)/);
  assert.match(main, /inputHandler\?\.setUserEditingLocked\(lease\.active\)/);
  assert.doesNotMatch(
    main.match(/function syncDocumentReadOnly\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '',
    /planModeAllowsUserEditing/,
  );
  assert.match(cloudUi, /completeTakeover\(sessionId, payload\.operationId\)/);
  assert.match(cloudUi, /runTakeoverAuthorityTransition/);
  assert.match(cloudUi, /context: authorityContext/);
  assert.match(sidebar, /runCloudMessageSubmission/);
  assert.match(sidebar, /acquire: \(\) => workspace\.lock\('cloud-message'\)/);
  assert.match(sidebar, /isCurrent: \(target\) => cloudUi\.matchesTarget\(target\)/);
});

test('cloud lease scope stays bound to the primary editor context', () => {
  assert.match(sidebar, /const editorCloudScope = createCloudEditorScope/);
  assert.match(sidebar, /getScope: \(\) => editorCloudScope\.current\(\)/);
  assert.doesNotMatch(sidebar, /getScope: \(\) => \(\{ threadId: currentThread\.id/);
  assert.match(sidebar, /editorCloudScope\.bind\(\{ threadId: currentThread\.id, documentId: binding\.documentId \}\);[\s\S]*refreshLeaseScope\(\)/);
});

test('active Local turns keep the Local transcript mounted until authoritative turn-end', () => {
  const openCloud = sidebar.match(/function openCloudWorkspace\(\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';
  const guard = openCloud.indexOf('canSelectCloudWorkspace(workspace.mode(), bridge.isTurnRunning()');
  assert.ok(guard >= 0);
  assert.ok(guard < openCloud.indexOf("workspace.select('cloud')"));
  assert.doesNotMatch(openCloud, /flushAssistantBuffer\(\)/);
  assert.doesNotMatch(openCloud, /bridge\.stopChat\(\)/);
  assert.match(sidebar, /cloudModeButton\.disabled = transitionLocked \|\| localTurnBlocksCloud/);
  assert.match(sidebar, /cloudModeButton\.setAttribute\(\s*'aria-label',[\s\S]*로컬 응답이 끝난 후 전환 가능/);
  assert.match(sidebar, /function setTurnRunning[\s\S]*syncWorkspaceModeAvailability\(\);/);
});

test('desktop close waits for a requested handoff through the local turn boundary', () => {
  assert.match(sidebar, /awaitPendingCloudTransferForClose\(\): Promise<void>/);
  assert.match(sidebar, /function startCloudFromFirstMessage/);
  assert.doesNotMatch(sidebar, /requestCloudTransfer\(\)/);
  const cancel = sidebar.match(/function cancelPendingCloudTransfer\(\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';
  const pendingOff = cancel.indexOf('cloudTransferPending = false;');
  const waitingOff = cancel.indexOf('setWaitingForLocalTurn(false)');
  const clearOff = cancel.indexOf('clearCloudTransferIntent');
  assert.ok(pendingOff >= 0 && waitingOff >= 0 && clearOff > pendingOff && clearOff > waitingOff);
  assert.match(cancel, /failPendingCloudTransfer/);
  assert.match(main, /await awaitPendingCloudTransferForClose\(\)/);
  assert.match(main, /return false;[\s\S]*const allowClose = await canReplaceCurrentDocument\(\)/);
  assert.match(sidebar, /setTransferIntent\(\{ \.\.\.intent, pending: true \}\)/);
  assert.match(sidebar, /await clearCloudTransferIntent\(\)/);
  assert.match(cloudUi, /refresh\(selectedScope\(\)\)/);
  assert.match(desktop, /cloudSetTransferIntent/);
  const desktopMainSource = readFileSync(new URL('../../../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(desktopMainSource, /CLOUD_CLOSE_WAIT_MS = 120_000/);
});

test('result preview requires explicit resolution and external conflicts cannot replace', () => {
  assert.match(cloudUi, /downloadResult\(session\.sessionId\)/);
  assert.match(cloudUi, /conflict === 'external-change' && actionName === 'replace'/);
  assert.match(cloudUi, /resolveResult\('keep-both'\)/);
  assert.match(cloudUi, /resolveResult\('replace'\)/);
  assert.match(main, /open-document-bytes/);
  assert.match(main, /resolution\.action !== 'replace'/);
  assert.match(main, /requestId/);
  assert.match(main, /open-document-bytes:done/);
  assert.match(desktop, /cloudResolveResult/);
  assert.match(desktop, /cloudReadReference/);
  assert.match(cloudUi, /pendingResultReplace/);
  assert.match(cloudUi, /syncAuthorityMutationLock/);
});

test('delayed selected timelines can establish a missing cloud binding', () => {
  assert.match(cloudUi, /if \(deps\.isCloudMode\(\) && snapshot\.timeline\)/);
  assert.doesNotMatch(cloudUi, /snapshot\.timeline && mountedBinding/);
  assert.match(cloudUi, /mountedBinding = binding;[\s\S]*deps\.onCloudBinding\(binding\)/);
  assert.match(cloudUi, /if \(pendingSessionSelections > 0 && !profileChanged\) return;[\s\S]*snapshot = next/);
});

test('agents can append a paragraph without moving controls from an empty anchor paragraph', () => {
  assert.match(agentTools, /name: 'insert_paragraph_after'/);
  assert.match(agentTools, /inline controls[\s\S]*remain anchored/);
  assert.match(executor, /case 'insert_paragraph_after'/);
  assert.match(pending, /wasm\.insertParagraph\(sectionIdx, insertedParaIdx\)/);
  assert.match(pending, /startParaIdx: afterParaIdx,[\s\S]*endParaIdx: insertedParaIdx/);
});
