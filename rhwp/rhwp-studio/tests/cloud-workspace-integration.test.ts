import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const cloudUi = readFileSync(new URL('../src/ui/agent-sidebar/cloud-ui.ts', import.meta.url), 'utf8');
const cloudPreview = readFileSync(new URL('../src/cloud/cloud-document-preview.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const desktopMain = readFileSync(new URL('../../../desktop/main.mjs', import.meta.url), 'utf8');

function handler(source: string, channel: string): string {
  const start = source.indexOf(`ipcMain.handle('${channel}'`);
  assert.notEqual(start, -1, `${channel} handler is missing`);
  const next = source.indexOf('\nipcMain.handle(', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('sidebar and fullscreen switches commit one guarded document and conversation workspace', () => {
  assert.match(sidebar, /headerActions\.insertBefore\(cloudUi\.sidebarWorkspaceSwitch/);
  assert.match(sidebar, /workspaceTrailing\.insertBefore\(cloudUi\.fullscreenWorkspaceSwitch/);
  assert.match(sidebar, /interface LocalConversationMemento/);
  assert.match(sidebar, /cloudDocumentPreview\.stageCheckpoint/);
  assert.match(sidebar, /!stage \|\| !isCurrent\(\) \|\| !cloudDocumentPreview\.canCommit\(stage, binding\)/);
  assert.match(sidebar, /referenceLibrary\.parkDraftFiles\(\)/);
  assert.match(sidebar, /messages\.scrollTop = local\.scrollTop/);
  assert.match(cloudUi, /workspace\.matches\(binding\)/);
  assert.match(cloudUi, /checkpoint\.sessionId !== sessionId/);
});

test('passive cloud checkpoints use the independent preview and never reload the primary editor', () => {
  assert.match(cloudPreview, /import \{ DocumentPreviewPane \}/);
  assert.match(cloudPreview, /stages = new Map<symbol, CloudPreviewStageRecord>/);
  assert.match(cloudPreview, /const pane = new DocumentPreviewPane/);
  assert.match(cloudPreview, /record\.pane\.dispose\(\)/);
  assert.match(cloudPreview, /localScroll\.inert = true/);
  assert.match(cloudPreview, /previousPane\.element\.contains\(document\.activeElement\)[\s\S]*?target \?\? this\.element/);
  assert.match(cloudPreview, /revision \$\{checkpoint\.revision\} · \$\{checkpoint\.turn\}턴/);
  assert.doesNotMatch(main, /applyCloudCheckpoint/);
  assert.doesNotMatch(sidebar, /deps\.applyCloudCheckpoint/);
  assert.match(main, /previewDocumentReadOnly[\s\S]*?\|\| cloudWorkspacePreviewReadOnly[\s\S]*?\|\| cloudDocumentLeaseSessionId !== null/);
});

test('completed results stay in the same renderer preview and desktop forwards checkpoint operation IDs', () => {
  const resultHandler = handler(desktopMain, 'cloud:download-result');
  const checkpointHandler = handler(desktopMain, 'cloud:download-checkpoint');

  assert.doesNotMatch(resultHandler, /createWindow|previewOpened/);
  assert.match(cloudUi, /const previewed = await deps\.onResultPreview\(/);
  assert.match(cloudPreview, /stageResult\(result: CloudDownloadResult/);
  assert.match(cloudUi, /session\.kind === 'completed' && session\.result\.availableOnThisDevice/);
  assert.match(cloudUi, /결과 반영을 다시 시도한 뒤 Local로 돌아갈 수 있습니다/);
  assert.match(checkpointHandler, /payload\?\.operationId/);
  assert.match(checkpointHandler, /downloadCheckpoint\(\{ sessionId, operationId \}\)/);
});

test('completed workspaces open their archived result without requiring a checkpoint', () => {
  assert.match(cloudUi, /if \(session\.kind === 'completed' && session\.result\.availableOnThisDevice\)/);
  assert.match(cloudUi, /initialResult = await deps\.controller\.downloadResult\(sessionId\)/);
  assert.match(cloudUi, /document = \{ kind: 'result', payload: initialResult \}/);
  assert.match(cloudUi, /downloadedResult = initialResult/);
  assert.match(sidebar, /bundle\.document\.kind === 'checkpoint'[\s\S]*?stageResult\(bundle\.document\.payload/);
});

test('workspace commit precedes cloud controls and pending snapshots stay private', () => {
  const commit = cloudUi.slice(cloudUi.indexOf('function commitWorkspaceSelection'));
  assert.ok(commit.indexOf('snapshot = committed.snapshot;') > commit.indexOf('workspace.commit(receipt, deps.controller.getSnapshot())'));
  assert.match(cloudUi, /if \(!workspace\.observeSnapshot\(next\)\) snapshot = snapshotForCurrentSelection\(next\)/);
  assert.match(cloudUi, /sidebarButton\.disabled = next/);
  assert.match(cloudUi, /workspaceButton\.disabled = next/);
  const application = sidebar.slice(sidebar.indexOf('async function applyCloudWorkspace'));
  assert.ok(application.indexOf('const committed = commit((latest) => {') < application.indexOf('applyCloudThread('));
  assert.ok(application.indexOf('cloudDocumentPreview.commit(stage, binding)') < application.indexOf('applyCloudThread('));
  assert.ok(application.indexOf('referenceLibrary.contextChanged()') < application.indexOf('restoreCloudConversation(binding)'));
});

test('cloud lifecycle guards replacement, takeover, result retry, and visible drafts', () => {
  assert.match(main, /if \(cloudWorkspacePreviewReadOnly && !allowCloudWorkspaceReplacement\)/);
  assert.match(main, /Local로 돌아온 뒤 문서를 바꿀 수 있습니다/);
  assert.match(main, /preservedHandle && preservedDocumentId[\s\S]*?kind: 'verified'/);
  assert.match(main, /클라우드 결과를 열지 못했습니다:[\s\S]*?throw error/);
  assert.match(cloudUi, /await selectCloudWorkspace\(sessionId\)[\s\S]*?command: 'takeover'/);
  assert.match(cloudUi, /pendingResultResolution = \{ result: resolvedResult, resolution \}[\s\S]*?await deps\.onResultResolved[\s\S]*?downloadedResult = null/);
  assert.match(sidebar, /deferredVisibleDraftFiles/);
  assert.match(sidebar, /function parkVisibleDraftFiles/);
  assert.match(sidebar, /cloudUi\.isRunning\(\) && !cloudUi\.isBusy\(\)/);
  assert.match(sidebar, /if \(!transferHasFiles\(event\.dataTransfer\) \|\| !canStageComposerAttachments\(\)\) return/);
});

test('final-session actions and passive mirrors cannot cross workspace boundaries', () => {
  const retry = cloudUi.slice(cloudUi.indexOf('function retryFailedSession'), cloudUi.indexOf('async function download'));
  assert.ok(retry.indexOf('selectLocalWorkspace()') < retry.indexOf('deps.onRequestTransfer()'));
  const dismiss = cloudUi.slice(cloudUi.indexOf('function dismissSession'), cloudUi.indexOf('function retryFailedSession'));
  assert.ok(dismiss.indexOf('selectLocalWorkspace(true)') < dismiss.indexOf('deps.controller.dismissSession(sessionId)'));
  assert.match(cloudUi, /function canCommitCheckpoint[\s\S]*?!busy && !workspace\.isTransitioning\(\)/);
  assert.match(cloudUi, /checkpointReconnectPending = true/);
  assert.match(cloudUi, /flushCheckpointReconnect\(\)/);
  const resultPreview = sidebar.slice(sidebar.indexOf('async function previewCloudResult'), sidebar.indexOf('function cancelCloudWorkspaceTransition'));
  assert.ok(resultPreview.indexOf('cloudDocumentPreview.commit(stage, binding)') < resultPreview.indexOf('applyCloudTimelineProjection('));
});

test('reference scope changes with the committed workspace before drafts restore', () => {
  assert.match(sidebar, /resolveWorkspaceReferenceContext\(\s*cloudUi\.getWorkspaceBinding\(\),\s*cloudUi\.getSnapshot\(\)/);
  const localRestore = sidebar.slice(sidebar.indexOf('function restoreLocalWorkspace'), sidebar.indexOf('function applyTakenOverTimeline'));
  assert.ok(localRestore.indexOf('referenceLibrary.contextChanged()') < localRestore.indexOf('restoreVisibleDraftFiles(local.draftFiles)'));
});
