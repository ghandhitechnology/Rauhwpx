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

test('threads column control sits on the selector bar and opens a page', () => {
  assert.match(source, /ag-threads-btn/);
  assert.match(source, /createColumnIcon/);
  assert.match(source, /새 채팅/);
  assert.match(source, /startNewChat/);
  assert.match(source, /requestTitle/);
  assert.match(source, /ag-chat-page/);
  assert.match(source, /ag-threads-page/);
  assert.match(source, /chatPage\.append\(header,/);
  assert.match(css, /\.ag-threads-page/);
  assert.match(css, /\.ag-threads-open \.ag-chat-page/);
  assert.match(css, /\.ag-threads-open \.ag-threads-page/);
});

test('sidebar header keeps one compact model summary and expands all settings together', () => {
  assert.match(source, /ag-document-context/);
  assert.match(source, /ag-document-name/);
  assert.match(source, /ag-selection-context/);
  assert.match(source, /ag-model-summary/);
  assert.match(source, /ag-config-panel/);
  assert.match(source, /providerTrigger\.append\(providerIcon, providerName\)/);
  assert.match(source, /llmTrigger\.append\(llmName\)/);
  assert.match(source, /effortTrigger\.append\(effortName, summaryCaret\)/);
  assert.doesNotMatch(source, /createChevron\('ag-model-caret'\)/);
  assert.match(source, /configPanelInner\.append\(providerGroup, llmGroup, effortGroup\)/);
  // 추론 강도가 없는 프로바이더에서는 트리거와 '추론' 묶음이 함께 접힌다.
  assert.match(source, /effortWrap\.hidden = noEfforts;\s*\n\s*effortGroup\.hidden = noEfforts;/);
  assert.match(css, /\.ag-config-group\[hidden\]\s*\{[^}]*display:\s*none;/s);
  // .ag-model 의 display:inline-flex 가 기본 [hidden] 을 덮으므로 따로 눌러 준다
  // — 없으면 Cursor 처럼 추론 강도가 없는 프로바이더에서 빈 알약이 남는다.
  assert.match(css, /\.ag-model\[hidden\]\s*\{[^}]*display:\s*none;/s);
  assert.match(css, /\.ag-config-panel\s*\{[^}]*display:\s*grid;/s);
  assert.match(css, /\.ag-config-panel \.ag-model-menu\s*\{[^}]*position:\s*static;/s);
  // 턴 실행 중에는 설정 패널을 접되, 채팅을 다시 여는 잠금만으로는 접지 않는다.
  assert.match(
    source,
    /if \(controlsLocked && chatStartPendingThreadId === null\) setConfigPanelOpen\(false\)/,
  );
});

test('reasoning and model tweaks do not lock or rebuild the composer', () => {
  // 추론 강도/모델만 바꿀 때는 입력칸을 '채팅을 여는 중'으로 잠그지 않는다.
  assert.match(source, /if \(force\) chatStartPendingThreadId = currentThread\.id;/);
  assert.match(source, /if \(force\) updateComposer\(\);/);
  assert.match(source, /function selectEffort[\s\S]*startCurrentBridgeChat\(\);/);
  assert.match(source, /function selectModel[\s\S]*startCurrentBridgeChat\(\);/);
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
  assert.match(source, /if \(send\.getAttribute\('aria-label'\) !== sendLabel\)/);
  // 계획 상태가 그대로면 검토 칸을 비웠다 다시 그리지 않는다.
  assert.match(
    source,
    /if \(chatWorkflow === state\.workflow && planningPhase === state\.phase && samePlanId && sameApproval\) \{\s*if \(hadPendingAction\) \{[\s\S]*?\}\s*return;/,
  );
});

test('model, permission, and skill utilities live in the composer accessory row', () => {
  assert.match(source, /ag-composer-utilities/);
  assert.match(source, /ag-composer-meta/);
  assert.match(source, /composerUtilityActions\.append\(phaseBadge, permissionBtn, skillsBtn\)/);
  assert.match(source, /composerUtilities\.append\(composerUtilityActions\)/);
  assert.match(source, /composerMeta\.append\(selectors, composerUtilities\)/);
  assert.match(source, /composer\.append\(composerOverlay, slashMenu, templateChip, composerField, composerMeta, configPanel\)/);
  assert.match(source, /chatPage\.append\(header, connBanner, messages, review, planSurface, questionController\.root, composer\)/);
  assert.match(source, /permissionBtn\.textContent = unrestricted \? '전체' : '안전'/);
  assert.match(css, /\.ag-composer-meta\s*\{/);
  assert.doesNotMatch(css, /\.ag-composer-utilities\s*\{[^}]*flex-direction:\s*column;/s);
});

test('writing-style calibration opens from a local slash command', () => {
  assert.match(source, /value: '\/calibration'[^\n]*local: 'calibration'/);
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
  assert.match(css, /\.ag-takeover-btn/);
});

test('library move is a context menu on document group names', () => {
  assert.match(source, /showActionMenu/);
  assert.match(source, /groupBtn\.addEventListener\('contextmenu'/);
  assert.match(source, /label: '이동'/);
  assert.match(source, /moveToLibraryDocument\?\.\(\{[\s\S]*documentId: group\.documentId[\s\S]*fileName: group\.docKey/s);
  assert.match(source, /disabled: isCurrentDoc/);
  assert.match(source, /dataset\.libraryDoc = 'true'/);
  assert.match(source, /aria-haspopup', 'menu'/);
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
  assert.match(source, /persistCurrentThread\(\);\s*exitReadOnlyMode\(\);[\s\S]*if \(liveQuestion\)[\s\S]*startCurrentBridgeChat\(true\)/);
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
  assert.match(documentSwitchSource, /startNewChat\(\{ silent: true \}\)/);
  assert.match(documentSwitchSource, /rebuildThreadsList\(\);/);
  assert.doesNotMatch(documentSwitchSource, /if \(threadsListVisible\(\)\) rebuildThreadsList/);
  assert.doesNotMatch(documentSwitchSource, /currentThreadMatches/);
  assert.doesNotMatch(documentSwitchSource, /currentThread\.messages\.length/);
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
