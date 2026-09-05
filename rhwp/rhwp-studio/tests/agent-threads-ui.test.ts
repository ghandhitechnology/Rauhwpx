import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');
const calibration = readFileSync(new URL('../src/ui/agent-sidebar/writing-style-calibration.ts', import.meta.url), 'utf8');
const calibrationCss = readFileSync(new URL('../src/ui/agent-sidebar/writing-style-calibration.css', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../../rhwp-agent/server.mjs', import.meta.url), 'utf8');
const documentSwitchSource = source.slice(
  source.indexOf('function handleDocumentSwitch'),
  source.indexOf('\n  function setConfigPanelOpen', source.indexOf('function handleDocumentSwitch')),
);

test('reasoning and model tweaks do not lock or rebuild the composer', () => {
  // 추론 강도/모델만 바꿀 때는 입력칸을 '채팅을 여는 중'으로 잠그지 않는다.
  assert.match(source, /if \(force\) chatStartPendingThreadId = currentThread\.id;/);
  assert.match(source, /if \(force\) updateComposer\(\);/);
  assert.match(source, /function selectEffort[\s\S]*changeCurrentProviderSettings\(\);/);
  assert.match(source, /function selectModel[\s\S]*changeCurrentProviderSettings\(\);/);
  // 서버가 같은 선택을 메아리치면 열린 피커 메뉴를 다시 그리지 않는다.
  assert.match(
    source,
    /if \(selectedAgent !== prevAgent \|\| selectedModel !== prevModel\) rebuildLlmMenu\(\);/,
  );
  assert.match(
    source,
    /if \(selectedAgent !== prevAgent \|\| selectedModel !== prevModel \|\| selectedEffort !== prevEffort\)/,
  );
  // 보내기 아이콘은 라벨이 바뀔 때만 갈아끼운다 — 매 chat-started 마다 깜빡이지 않게.
  assert.match(source, /if \(send\.dataset\.icon !== sendIcon\)/);
  // 계획 상태가 그대로면 검토 칸을 비웠다 다시 그리지 않는다.
  assert.match(
    source,
    /if \(chatWorkflow === state\.workflow && planningPhase === state\.phase && samePlanId && sameApproval\) \{\s*if \(hadPendingAction\) \{[\s\S]*?\}\s*return;/,
  );
});

test('writing-style calibration opens from a local slash command', () => {
  assert.match(source, /value: '\/calibration'[^\n]*local: 'calibration'/);
  assert.match(source, /detail: '말투를 맞출까요\? 열기'/);
  assert.doesNotMatch(source, /말투 모방/);
  assert.match(source, /option\.local === 'calibration'[^\n]*writingStyleCalibration\.open\(\)/);
  assert.match(source, /text === '\/calibration'[^\n]*writingStyleCalibration\.open\(\)/);
  assert.ok(source.indexOf("if (text === '/calibration')") < source.indexOf('recordUserMessage(messageText,'));
  assert.match(calibration, /export interface WritingStyleCalibrationUi \{\s*open\(\): void;/);
  assert.match(calibration, /if \(requestId \|\| submitting\) \{\s*setStep\(2\);/);
  assert.match(calibration, /else if \(activeStatus\?\.active\) showResult\(activeStatus\);/);
  assert.doesNotMatch(calibration, /ag-calibration-launch/);
  assert.doesNotMatch(calibrationCss, /ag-calibration-launch/);
});

test('replaced connection state exposes an explicit takeover action', () => {
  assert.match(source, /이 탭에서 연결/);
  assert.match(source, /bridge\.takeOverConnection\(\)/);
  assert.match(source, /takeoverBtn\.hidden = state !== 'replaced'/);
});

test('saving a document rebinds the current chat instead of starting a new one', () => {
  assert.match(
    documentSwitchSource,
    /const sameIdentity = Boolean\(\s*nextDocumentId && currentDocumentId && nextDocumentId === currentDocumentId/s,
  );
  assert.match(documentSwitchSource, /const activeThreadMatchesDocument = readOnlyDocLabel === null[\s\S]*threadMatchesDocument\(currentThread, currentDocumentId, currentDocKey\)/);
  assert.match(documentSwitchSource, /if \(activeThreadMatchesDocument\) \{\s*currentThread\.docKey = nextKey;\s*currentThread\.documentId = nextDocumentId;/);
});

test('past chats on the active file reopen as writable and adopt stable document identity', () => {
  assert.match(source, /threadMatchesDocument\(\s*loaded,\s*currentDocumentId,\s*currentDocKey/);
  assert.match(source, /currentThread\.documentId = currentDocumentId \?\? currentThread\.documentId/);
  assert.match(source, /currentThread\.docKey = currentDocKey \?\? currentThread\.docKey/);
  assert.match(source, /persistCurrentThread\(\);[\s\S]*localThreadId = currentThread\.id;[\s\S]*editorCloudScope\.bind\([\s\S]*const scopeRefresh = cloudUi\.refreshLeaseScope\(\);\s*exitReadOnlyMode\(\);[\s\S]*if \(liveQuestion\)[\s\S]*void scopeRefresh\.then/);
  assert.match(source, /currentThread\.id !== selectedThreadId[\s\S]*composerExecution\(workspace\.composerTarget\(\)\)\.kind === 'local'[\s\S]*startCurrentBridgeChat\(true\)/);
  assert.match(source, /const history = serializeThreadMessagesForProviderHistory\(currentThread\.messages\)/);
  assert.match(source, /currentThread\.id, currentThread\.documentId, currentThread\.docKey, history/);
  assert.match(serverSource, /bootstrapHistory: normalizeChatHistory\(requestedHistory\)/);
  assert.match(serverSource, /addReopenedChatHistory\(\s*activeSession,/);
});

test('rapid past-chat switches cannot activate a stale provider session', () => {
  assert.match(source, /if \(force\) chatStartPendingThreadId = currentThread\.id/);
  assert.match(source, /if \(e\.threadId && e\.threadId !== currentThread\.id\) break/);
  assert.match(source, /input\.disabled = connState !== 'connected' \|\| attachmentsSending \|\| chatStarting/);
  assert.match(bridgeSource, /msg\.threadId !== this\.threadId\) break/);
  assert.match(serverSource, /studioMessageQueue: Promise\.resolve\(\)/);
  assert.match(serverSource, /record\.studioMessageQueue = record\.studioMessageQueue[\s\S]*if \(record\.studioSocket !== sock\) return;[\s\S]*handleStudioMessage\(record, sock, msg\)/);
});

test('changing files ends the open chat and starts a fresh chat for the next file', () => {
  assert.match(documentSwitchSource, /startNewChat\(\{ silent: true, documentSwitch: true \}\)/);
  assert.match(source, /function startNewChat[\s\S]*workspace\.select\('local'\);[\s\S]*localThreadSnapshot = structuredClone\(nextThread\);[\s\S]*editorCloudScope\.bind\([\s\S]*cloudUi\.refreshLeaseScope\(\)/);
  assert.match(documentSwitchSource, /rebuildThreadsList\(\);/);
  assert.doesNotMatch(documentSwitchSource, /if \(threadsListVisible\(\)\) rebuildThreadsList/);
  assert.doesNotMatch(documentSwitchSource, /currentThreadMatches/);
  assert.match(source, /if \(currentThread\.messages\.length === 0\) \{\s*removeThread\(currentThread\.id\);/);
  assert.match(source, /if \(previousThreadWasEmpty\) \{\s*planArchives\.delete\(previousThreadId\);\s*threadWorkflows\.delete\(previousThreadId\);/);
  assert.match(
    source,
    /function startNewChat[\s\S]*persistCurrentThread\(\);[\s\S]*createEmptyThread\(\{[\s\S]*documentId: currentDocumentId[\s\S]*bridge\.stopChat\(\);[\s\S]*startCurrentBridgeChat\(true\)/,
  );
});

test('explorer current badge uses unique filename fallback after document switch', () => {
  assert.match(source, /explorerGroupIsCurrent\(group, currentDocumentId, currentDocKey, groups\)/);
  assert.match(source, /if \(isCurrentDoc\) groupBtn\.append\(el\('span', 'ag-threads-group-badge', '현재'\)\)/);
});
