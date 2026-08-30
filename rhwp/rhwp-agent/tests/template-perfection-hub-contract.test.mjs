import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const mcp = readFileSync(new URL('../mcp-stdio.mjs', import.meta.url), 'utf8');
const piExtension = readFileSync(new URL('../pi/extension/rhwp.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../copy-layout-runner.mjs', import.meta.url), 'utf8');

test('hub launches the copy-layout worker as a real isolated provider session', () => {
  assert.match(server, /const createBackend = SESSION_FACTORIES\[job\.agent\]/);
  assert.match(server, /job\.backend = createBackend\(opts\)/);
  assert.match(server, /toolProfile: 'copy-layout-worker'/);
  assert.match(server, /agentRole: job\.workerRole/);
  assert.match(server, /permissionProfile: 'safe'/);
  assert.match(server, /rootDir: jobDir/);
  assert.match(server, /workDir: jobDir/);
  assert.match(server, /readOnlyRoots: \[jobSnapshotRoot, jobGeneratedRoot\]/);
  assert.doesNotMatch(server, /shellAllowPrefixes/);
  assert.match(server, /runCopyLayoutHelper\(args/);
  assert.match(runner, /shell: false/);
  assert.match(runner, /COPY_LAYOUT_RUN_TIMEOUT_MS/);
  assert.match(runner, /cleanupProcess\(child\)/);
  assert.match(server, /copy-layout-providers/);
  assert.match(server, /prepareCodexHome\(codexHome/);
  assert.match(server, /prepareClaudeHome\(isolatedHome/);
  assert.match(server, /prepareGrokHome\(grokHome/);
  assert.match(server, /prepareCursorHome\(cursorHome/);
  assert.match(mcp, /url\.searchParams\.set\('role', AGENT_ROLE\)/);
  assert.match(mcp, /url\.searchParams\.set\('workerJobId', COPY_LAYOUT_JOB_ID\)/);
  assert.match(piExtension, /RHWP_AGENT_ROLE/);
  assert.match(piExtension, /workerJobId=/);
  assert.match(server, /profile = 'copy-layout-worker'/);
  assert.match(server, /authenticatedUrl\.searchParams\.set\('profile', profile\)/);
  assert.match(server, /audience: HUB_CAPABILITY_AUDIENCES\.COPY_LAYOUT_WORKER,[\s\S]*resource: job\.jobId/);
  assert.match(server, /requestedAgentRole !== authenticatedWorkerJob\.workerRole/);
  assert.match(server, /ws\.agentRole = authenticatedWorkerJob\?\.workerRole \?\? authenticatedProviderIdentity\.role/);
  assert.match(server, /sock\.copyLayoutJobId/);
  assert.doesNotMatch(server, /workerJobForSocket\(record, sock\)[\s\S]{0,200}sock\.agentRole/);
});

test('hub reuses fleet task events and keeps worker tools source-bound', () => {
  assert.match(server, /type: 'task-start'[\s\S]*taskKind: 'agent', background: true/);
  assert.doesNotMatch(server, /전용 백그라운드 워커/);
  assert.match(server, /taskProgressForJob\(job/);
  assert.match(server, /type: 'task-end'/);
  assert.match(server, /COPY_LAYOUT_TOOL_DENIED/);
  assert.match(server, /args\.sourceDocumentId !== workerJob\.binding\.documentId/);
  assert.match(server, /args\.sourceDigest !== workerJob\.binding\.digest/);
  assert.match(server, /documentIdentity: workerJob[\s\S]*workerJob\.binding\.documentId/);
  assert.match(server, /workerJob\.snapshot = Object\.freeze/);
  assert.match(server, /const boundSnapshot = workerJob\.snapshot/);
  assert.match(server, /sourcePath: boundSnapshot\.path/);
  assert.match(server, /COPY_LAYOUT_ARTIFACT_UNBOUND/);
  assert.match(server, /workerJob\.publishedArtifacts\.get\(args\.artifactId\)/);
  assert.match(server, /result\.digest !== workerJob\.binding\.digest/);
  assert.match(server, /workerJob\.snapshot\.checksum !== result\.checksum/);
  assert.match(server, /workerJob\.helperPending > 0/);
  assert.match(server, /workerJob\.generatedCandidates\.size >= COPY_LAYOUT_MAX_ITERATIONS/);
  assert.match(server, /claimCopyLayoutSettlement\(workerJob\)/);
  assert.match(server, /active\.status !== 'completed' && active\.status !== 'failed'/);
  assert.match(server, /workerJob\.snapshotPending/);
  assert.match(server, /claimCopyLayoutSnapshot\(workerJob\)[\s\S]*record\.pendingCalls\.set/);
  assert.match(server, /claimCopyLayoutPublication\(workerJob, workerCandidate\)[\s\S]*record\.artifactStore\.publish/);
  assert.match(server, /workerJob\.generatedCandidates\.get\(workerCandidate\.iteration\) !== workerCandidate/);
  assert.match(server, /copyLayoutCandidateClaims\(workerJob, published\)/);
  assert.match(server, /candidate_evidence/);
  assert.match(server, /source_renders/);
  assert.match(server, /output_renders/);
  assert.match(server, /COPY_LAYOUT_ITERATIONS_REQUIRED/);
  assert.match(server, /exactJsonArray\(args\.preview\.representativePages/);
  assert.match(server, /counts: completionClaims\.counts/);
  assert.match(server, /preview: completionClaims\.preview/);
  assert.match(server, /MAX_COPY_LAYOUT_JOB_HISTORY = 20/);
  assert.match(server, /cleanupTemplateGeneratedRoot/);
});

test('template artifacts are card-triggered instead of auto-opened', () => {
  assert.match(server, /downloadUrl\.searchParams\.set\('templatePreview', '1'\)/);
  assert.doesNotMatch(server, /template-preview-ready/);
  assert.doesNotMatch(server, /template-preview-opened/);
  assert.doesNotMatch(server, /sendTemplatePreviewReady/);
});

test('completion wakes the owning chat without collaboration wait polling', () => {
  assert.match(server, /completionDelivery: 'automatic-owning-chat-turn'/);
  assert.match(server, /waitForCompletion: false/);
  assert.match(server, /wait_agent로 기다리거나 폴링하지 말고 현재 턴을 끝내세요/);
  assert.match(server, /record\.pendingTemplateCompletions\.push/);
  assert.match(server, /activeSession\.backend\.sendUserMessage\(addAgentInstructionsContext\([\s\S]*buildCopyLayoutCompletionPrompt\(entry\.result\)/);
  assert.match(server, /if \(evt\.type === 'turn-end'\) drainTemplateCompletion\(record\)/);
});

test('hub cleanup retains every root that contains a pending credential copyback', () => {
  assert.match(server, /ensureCredentialRetentionRootSync\(WORK_ROOT\)/);
  assert.match(server, /!credentialCopiesSettled \|\| hasPendingCredentialCopybackSync\(record\.recordRoot\)/);
  assert.match(server, /launchCleanupRetentionRequired \|\| hasPendingLaunchCleanupSync\(root\)/);
  assert.match(server, /retainLaunchRootForProcessCleanupSync\(WORK_ROOT/);
  assert.match(server, /if \(!processCleanupSettled\)[\s\S]*retainUncertainProcessCleanup\(record\.recordRoot\)/);
});

test('auxiliary leader exit retains tree identity until cleanup is proven', () => {
  assert.match(server, /auxiliaryProcessCleanups: new Map\(\)/);
  assert.match(server, /child\.once\('exit', cleanup\)/);
  assert.match(server, /terminateAndWaitForProcessTreeExit\(child\)/);
  assert.match(server, /if \(cleaned\) \{[\s\S]*record\.auxiliaryProcesses\.delete\(child\)/);
  assert.doesNotMatch(server, /child\.once\('exit', forget\)/);
  assert.doesNotMatch(server, /record\.auxiliaryProcesses\.clear\(\)/);
});

test('provider replacement and stop fail closed on an unconfirmed process tree', () => {
  assert.match(server, /const retainedUncertainBackends = new Set\(\)/);
  assert.match(server, /const retainedUncertainBrowserbaseSessions = new Set\(\)/);
  assert.match(server, /processCleanupUncertain: false/);
  assert.match(
    server,
    /retainedUncertainBackends\.add\(activeSession\.backend\);[\s\S]*retainUncertainProcessCleanup\(record\.recordRoot\)/,
  );
  assert.match(
    server,
    /retainedUncertainBrowserbaseSessions\.add\(record\.browserbaseSession\);[\s\S]*retainUncertainProcessCleanup\(record\.recordRoot\)/,
  );
  assert.match(server, /Promise\.allSettled\(\[backendExit, browserbaseExit\]\)/);
  assert.doesNotMatch(server, /void record\.browserbaseSession\.cleanup/);
  assert.match(
    server,
    /const browserbaseCleaned = await record\.browserbaseSession\.cleanup\('workflow changed to direct'\)[\s\S]*if \(!browserbaseCleaned\)[\s\S]*sendChatError\(sock, agentProcessCleanupUncertain\(\)/,
  );
  assert.match(server, /error\.code = 'AGENT_PROCESS_CLEANUP_UNCERTAIN'/);
  assert.match(
    server,
    /if \(error\?\.processCleanupUncertain\)[\s\S]*retainedUncertainBrowserbaseSessions\.add\(record\.browserbaseSession\)[\s\S]*retainUncertainProcessCleanup\(record\.recordRoot\)/,
  );
  assert.match(
    server,
    /if \(!await disposeSession\(record\)\) throw agentProcessCleanupUncertain\(\)/,
  );
  assert.match(
    server,
    /const cleaned = await disposeSession\(record\);[\s\S]*const reported = cleaned \? e : agentProcessCleanupUncertain\(e\)/,
  );
  assert.match(
    server,
    /case 'chat-stop':[\s\S]*if \(!await disposeSession\(record\)\)[\s\S]*sendChatError\(sock, agentProcessCleanupUncertain\(\)/,
  );
});
