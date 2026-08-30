import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const cloudUi = readFileSync(new URL('../src/ui/agent-sidebar/cloud-ui.ts', import.meta.url), 'utf8');
const cloudCss = readFileSync(new URL('../src/ui/agent-sidebar/cloud-ui.css', import.meta.url), 'utf8');
const onboarding = readFileSync(new URL('../src/ui/agent-sidebar/cloud-onboarding.ts', import.meta.url), 'utf8');
const onboardingCss = readFileSync(new URL('../src/ui/agent-sidebar/cloud-onboarding.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const desktop = readFileSync(new URL('../src/desktop-integration.ts', import.meta.url), 'utf8');
const agentTools = readFileSync(new URL('../../rhwp-agent/tools.mjs', import.meta.url), 'utf8');
const executor = readFileSync(new URL('../src/agent/tool-executor.ts', import.meta.url), 'utf8');
const pending = readFileSync(new URL('../src/agent/pending-edits.ts', import.meta.url), 'utf8');

test('cloud action is available in sidebar and fullscreen headers', () => {
  assert.match(sidebar, /headerActions\.insertBefore\(cloudUi\.sidebarButton/);
  assert.match(sidebar, /workspaceTrailing\.insertBefore\(cloudUi\.workspaceButton/);
  assert.match(cloudUi, /createIcon\('cloud'\)/);
  assert.match(cloudUi, /ag-cloud-session-select/);
  assert.match(cloudUi, /selectedSessionId/);
  assert.match(cloudUi, /createCloudOnboarding/);
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
  assert.match(cloudUi, /aria-controls', 'ag-cloud-panel/);
  assert.match(cloudUi, /closePanel\(true\)/);
  assert.match(cloudUi, /const focusTrigger = panelTrigger \?\? sidebarButton/);
  assert.match(onboarding, /document\.body\.appendChild\(overlay\)/);
  assert.match(sidebar, /stage\.appendChild\(cloudUi\.statusPanel\)/);
  assert.match(cloudCss, /\.ag-cloud-btn\[hidden\],[\s\S]*\.ag-workspace-cloud-btn\[hidden\][\s\S]*display:\s*none/);
});

test('cloud transfer includes portable timeline, exact document bytes and reference bytes', () => {
  assert.match(sidebar, /timeline: exportCloudTimeline\(currentThread\)/);
  assert.match(sidebar, /const bytes = await cloudController\.readReference\(descriptor\)/);
  assert.match(sidebar, /references\.push\(\{ \.\.\.descriptor, bytes \}\)/);
  assert.match(sidebar, /permissionProfile: 'unrestricted'/);
  const transfer = sidebar.match(/async function transferCurrentSession\(\)[\s\S]*?\n  function ensureCloudTransferIntent/)?.[0] ?? '';
  assert.doesNotMatch(transfer, /setPermissionProfile\('unrestricted'\)/);
  assert.match(main, /await saveCurrentDocument\(commandServices\)/);
  assert.match(main, /exportDocumentForFormat\(wasm, format\)/);
});

test('cloud lease locks local editing and queued messages cross only at a remote boundary', () => {
  assert.match(sidebar, /isCloudConversation\(\)/);
  assert.match(cloudUi, /async queueMessage\(text, messageId, attachments = \[\]\)/);
  assert.match(cloudUi, /command: 'queue-message'/);
  assert.match(main, /setCloudDocumentLease/);
  assert.match(main, /syncDocumentReadOnly/);
  assert.match(main, /documentReadOnly = previewDocumentReadOnly \|\| cloudDocumentLeaseSessionId !== null/);
  assert.match(main, /inputHandler\?\.setReadOnly\(documentReadOnly\)/);
  assert.match(main, /inputHandler\?\.setUserEditingLocked\(lease\.active\)/);
  assert.doesNotMatch(
    main.match(/function syncDocumentReadOnly\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '',
    /planModeAllowsUserEditing/,
  );
  assert.match(cloudUi, /completeTakeover\(session\.sessionId\)/);
});

test('desktop close waits for a requested handoff through the local turn boundary', () => {
  assert.match(sidebar, /awaitPendingCloudTransferForClose\(\): Promise<void>/);
  assert.match(sidebar, /if \(turnRunning\) \{[\s\S]*cloudTransferPending = true;[\s\S]*ensureCloudTransferCloseWaiter\(\)/);
  assert.match(sidebar, /if \(cloudTransferPending\) requestCloudTransfer\(\)/);
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
});

test('agents can append a paragraph without moving controls from an empty anchor paragraph', () => {
  assert.match(agentTools, /name: 'insert_paragraph_after'/);
  assert.match(agentTools, /inline controls[\s\S]*remain anchored/);
  assert.match(executor, /case 'insert_paragraph_after'/);
  assert.match(pending, /wasm\.insertParagraph\(sectionIdx, insertedParaIdx\)/);
  assert.match(pending, /startParaIdx: afterParaIdx,[\s\S]*endParaIdx: insertedParaIdx/);
});
