import http from 'node:http';
import crypto from 'node:crypto';
import { mkdirSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { WebSocketServer } from 'ws';
import {
  createClaudeSession,
  flushClaudeCredentialMirrors,
  prepareClaudeHome,
} from './agents/claude.mjs';
import {
  createCodexSession,
  flushCodexCredentialMirror,
  prepareCodexHome,
} from './agents/codex.mjs';
import { createPiSession, isOpenRouterCreditError } from './agents/pi.mjs';
import {
  createGrokSession,
  flushGrokCredentialMirror,
  prepareGrokHome,
} from './agents/grok.mjs';
import {
  createCursorSession,
  flushCursorCredentialMirrors,
  prepareCursorHome,
} from './agents/cursor.mjs';
import { generateChatTitle } from './agents/title.mjs';
import {
  CHECKPOINT_TITLE_OVERALL_TIMEOUT_MS,
  findDeepSeekV4FlashModel,
  generateCheckpointTitle,
  resolveCheckpointTitleCliRoute,
} from './agents/checkpoint-title.mjs';
import { SkillRegistry } from './skills.mjs';
import { generateSkillDraft } from './skill-generator.mjs';
import { WritingStyleStore, assertWritingStyleAppendCompatible } from './writing-style.mjs';
import { AgentInstructionsStore } from './agent-instructions.mjs';
import { calibrateWritingStyle } from './style-calibrator.mjs';
import { buildWritingStyleCatalog, resolveWritingStyleSelection } from './writing-style-catalog.mjs';
import { filterToolDefinitions, TOOL_DEFINITIONS } from './tools.mjs';
import { replayMissedTurnEnd } from './turn-outcome-replay.mjs';
import {
  PlanningState,
  authorizeToolCall,
  buildApprovedPlanPrompt,
  buildPlanningDocumentSavedPrompt,
  isExplicitImplementationApproval,
  workflowError,
} from './planning-state.mjs';
import { DownloadManager } from './download-manager.mjs';
import { DocumentSnapshotManager } from './document-snapshot-manager.mjs';
import { ArtifactStore } from './artifact-store.mjs';
import { BrowserbaseSession } from './browserbase-session.mjs';
import { createProviderHealth } from './provider-health.mjs';
import { createUsageStore } from './usage-store.mjs';
import { createCliproxyClient } from './cliproxy.mjs';
import {
  createPiManager,
  defaultPiRoot,
  defaultRauRoot,
  RAU_LOCKED_MODELS,
  RAU_SECRET_ID,
} from './pi-manager.mjs';
import { createRauCreditsClient, storeRauApiKey } from './rau-credits-client.mjs';
import { AuthRunRegistry } from './auth-run-registry.mjs';
import { createCliSetupManager } from './cli-setup-manager.mjs';
import { createOpenRouter, creditBalanceEmpty } from './openrouter.mjs';
import { createIpcSecretStore } from './secret-store.mjs';
import { handlePiToolDefinitions } from './pi/tool-schema.mjs';
import { resolveHwpExtractor } from './reference-extractor.mjs';
import { ReferenceStore } from './reference-store.mjs';
import { createReferenceHttpHandler, isAllowedStudioOrigin } from './reference-http.mjs';
import {
  createUserQuestionInteraction,
  isAskUserQuestionTool,
  normalizeMcpUserQuestionRequest,
  normalizeProviderUserQuestionRequest,
  sameUserQuestionRequest,
  userQuestionAnswersForMcp,
  userQuestionArgsFromToolInput,
  validateUserQuestionAnswers,
} from './user-question.mjs';
import {
  activeDocumentIdentity,
  addActiveDocumentContext,
  assertMessageScope,
  attachActiveDocumentIdentity,
  referenceScopesForSession,
  resolveSessionIdentity,
} from './reference-session.mjs';
import { executeReferenceTool } from './reference-tools.mjs';
import { TemplateStore } from './template-store.mjs';
import { createTemplateHttpHandler } from './template-http.mjs';
import {
  buildCopyLayoutCompletionPrompt,
  buildCopyLayoutWorkerPrompt,
  claimCopyLayoutPublication,
  claimCopyLayoutSettlement,
  claimCopyLayoutSnapshot,
  COPY_LAYOUT_MAX_ITERATIONS,
  copyLayoutPhaseIndex,
  defaultTemplateName,
  releaseCopyLayoutPublication,
  releaseCopyLayoutSnapshot,
  taskProgressForJob,
} from './template-perfection.mjs';
import { runCopyLayoutHelper } from './copy-layout-runner.mjs';
import { z } from 'zod/v3';
import {
  terminateAndWaitForProcessTreeExit,
  terminateProcessTree,
} from './process-tree.mjs';
import {
  ensureCredentialRetentionRootSync,
  hasPendingCredentialCopybackSync,
  hasPendingLaunchCleanupSync,
  retainLaunchRootForProcessCleanupSync,
} from './credential-mirror.mjs';
import {
  authenticateMasterToken,
  HUB_CAPABILITY_AUDIENCES,
  HubSessionRegistry,
  mcpProviderResource,
  resolveHubIdentity,
  timingSafeTextEqual,
} from './hub-session-registry.mjs';

const REQUESTED_PORT = Number(process.env.RHWP_AGENT_PORT ?? 5175);
const PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RHWP_AGENT_MODE === 'production';
const { token: TOKEN, development: DEVELOPMENT_AUTH, launchId: LAUNCH_ID } = resolveHubIdentity();
const PROTOCOL_VERSION = 5;
const HUB_NAME = 'rhwp-agent';
const STARTED_AT = Date.now();
// The bundle is discovery-only. Every per-window cwd, home, download, and
// temporary work path lives below RHWP_WORK_DIR.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MCP_SCRIPT = fileURLToPath(new URL('./mcp-stdio.mjs', import.meta.url));
const BUNDLED_SKILLS = fileURLToPath(new URL('./skills', import.meta.url));
if (PRODUCTION && !process.env.RHWP_WORK_DIR) {
  throw Object.assign(new Error('RHWP_WORK_DIR is required in production'), { code: 'HUB_WORK_DIR_REQUIRED' });
}
const WORK_ROOT = path.resolve(process.env.RHWP_WORK_DIR || path.join(os.tmpdir(), `rhwp-agent-work-${process.pid}`));
const RUNTIME_ROOT = process.env.RHWP_RUNTIME_DIR
  ? path.resolve(process.env.RHWP_RUNTIME_DIR)
  : null;
const RECORDS_ROOT = path.join(WORK_ROOT, 'sessions');
await fs.mkdir(RECORDS_ROOT, { recursive: true, mode: 0o700 });
ensureCredentialRetentionRootSync(WORK_ROOT);
let hubPort = REQUESTED_PORT;
const STUDIO_TOOL_TIMEOUT_MS = 30_000;
const MAX_CHAT_MESSAGE_CHARS = 128_000;
const MAX_PENDING_STUDIO_TOOL_CALLS = 64;
// One 64 MiB snapshot expands to about 85.4 MiB as base64. Keep room for a
// handful of small control messages without retaining a second giant frame.
const MAX_STUDIO_QUEUED_FRAME_BYTES = 96 * 1024 * 1024;
const MAX_STUDIO_QUEUED_MESSAGES = 64;
// 스튜디오가 끊긴 뒤 다시 붙기를 기다려 주는 시간 — 브리지의 첫 재접속 백오프(250·500ms)보다
// 넉넉하되, 탭이 아주 닫힌 경우 30초 타임아웃까지 끌지 않을 만큼 짧게 잡는다.
const STUDIO_REATTACH_GRACE_MS = Number(process.env.RHWP_STUDIO_REATTACH_GRACE_MS ?? 5_000);
// 프로바이더 이벤트와 별도 MCP 소켓의 도구 호출 순서가 뒤집힐 수 있어
// 정확한 루트 범위 티켓이 도착할 짧은 여유를 둔다.
const USER_QUESTION_SCOPE_WAIT_MS = 2_000;
const HARNESS_UPDATE_INITIAL_DELAY_MS = 8_000;
const HARNESS_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HARNESS_UPDATE_BUSY_RETRY_MS = 5 * 60 * 1000;
const HARNESS_UPDATE_FAILURE_RETRY_MS = 60 * 60 * 1000;
const configuredOrphanIdleShutdownMs = Number(process.env.RHWP_ORPHAN_IDLE_SHUTDOWN_MS);
const ORPHAN_IDLE_SHUTDOWN_MS = Number.isSafeInteger(configuredOrphanIdleShutdownMs)
  && configuredOrphanIdleShutdownMs >= 100
  ? configuredOrphanIdleShutdownMs
  : 15 * 60 * 1000;
const configuredOrphanHardShutdownMs = Number(process.env.RHWP_ORPHAN_HARD_SHUTDOWN_MS);
const ORPHAN_HARD_SHUTDOWN_MS = Number.isSafeInteger(configuredOrphanHardShutdownMs)
  && configuredOrphanHardShutdownMs >= 100
  ? Math.max(configuredOrphanHardShutdownMs, ORPHAN_IDLE_SHUTDOWN_MS)
  : 30 * 60 * 1000;
const toolDefinitionsByName = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
const copyLayoutWorkerTools = new Set(
  filterToolDefinitions('copy-layout-worker').map((definition) => definition.name),
);
const MAX_COPY_LAYOUT_JOB_HISTORY = 20;
// 인자 스키마는 도구마다 한 번만 만든다 — 호출마다 z.object() 를 다시 세우면
// 툴 하나당 수십 개 필드를 매번 컴파일하게 된다. insert_image 는 passthrough,
// 나머지는 strict 이므로 도구 이름으로 캐시하면 변형도 자연히 분리된다.
const toolArgSchemas = new Map();
function toolArgSchema(tool, definition) {
  const cached = toolArgSchemas.get(tool);
  if (cached) return cached;
  const base = z.object(definition.shape);
  const schema = tool === 'insert_image' ? base.passthrough() : base.strict();
  toolArgSchemas.set(tool, schema);
  return schema;
}
const HOST_PROFILE_HOME = process.platform === 'win32' && process.env.USERPROFILE
  ? path.resolve(process.env.USERPROFILE)
  : os.homedir();
const SOURCE_CLAUDE_CONFIG_DIR = typeof process.env.CLAUDE_CONFIG_DIR === 'string'
  && process.env.CLAUDE_CONFIG_DIR.trim()
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(HOST_PROFILE_HOME, '.claude');
const sourceClaudeAuth = {
  credentialsPath: path.join(SOURCE_CLAUDE_CONFIG_DIR, '.credentials.json'),
  configPath: path.join(HOST_PROFILE_HOME, '.claude.json'),
};
const sourceCodexHomes = [...new Set([
  process.env.CODEX_HOME,
  path.join(HOST_PROFILE_HOME, '.codex'),
].filter(Boolean))];
async function findSourceCodexAuthPath() {
  for (const sourceCodexHome of sourceCodexHomes) {
    const authPath = path.join(sourceCodexHome, 'auth.json');
    try {
      const authStat = await fs.lstat(authPath);
      if (authStat.isFile() && !authStat.isSymbolicLink()) return authPath;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}
let sourceCodexAuthPath = await findSourceCodexAuthPath();
const writingStyleStore = await new WritingStyleStore().init();
const agentInstructionsStore = await new AgentInstructionsStore().init();
const skillRegistry = await new SkillRegistry({ bundledRoot: BUNDLED_SKILLS, writingStyleStore }).init();
const PI_ROOT = defaultPiRoot();
const RAU_ROOT = defaultRauRoot();
const openRouter = createOpenRouter({ cacheDir: PI_ROOT });
const rauOpenRouter = createOpenRouter({ cacheDir: RAU_ROOT });
const secretStore = createIpcSecretStore();
if (process.env.RHWP_AGENT_MODE === 'production' && !secretStore.available) {
  throw Object.assign(new Error('The packaged hub requires the desktop secure-secret broker.'), {
    code: 'HUB_SECRET_BROKER_REQUIRED',
  });
}
const piManager = await createPiManager({ rootDir: PI_ROOT, openRouter, secretStore }).init();
const rauManager = await createPiManager({
  rootDir: RAU_ROOT,
  prefixDir: piManager.prefixDir,
  openRouter: rauOpenRouter,
  secretStore,
  secretId: RAU_SECRET_ID,
  lockedModels: RAU_LOCKED_MODELS,
  skipLegacyKey: true,
}).init();
const rauCredits = createRauCreditsClient();
const authRuns = new AuthRunRegistry();
let npmPrefixMutationQueue = Promise.resolve();
function mutateSharedNpmPrefix(operation) {
  const running = npmPrefixMutationQueue.then(operation, operation);
  npmPrefixMutationQueue = running.catch(() => {});
  return running;
}
const cliSetup = await createCliSetupManager({ secretStore }).init();
function claudeRuntimeEnv(isolatedHome) {
  return {
    ...cliSetup.envFor('claude'),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CLAUDE_CONFIG_DIR: path.join(isolatedHome, '.claude'),
  };
}
// App-managed bins are available to auxiliary CLI calls as soon as installation completes.
// 허브가 관리하는 API 키는 process.env 에 올리지 않는다 — npm lifecycle 스크립트,
// 설치 스크립트 등 무관한 자식 프로세스까지 상속받는 누수 지점이 된다.
// 키는 auxSpawnProcess 가 해당 CLI 자식에게만 env 로 얹어 준다.
process.env.PATH = `${cliSetup.binDir}${path.delimiter}${process.env.PATH ?? ''}`;
const [initialClaudeSetup, initialCodexSetup, initialGrokSetup, initialCursorSetup] = await Promise.all([
  cliSetup.status('claude'),
  cliSetup.status('codex'),
  cliSetup.status('grok'),
  cliSetup.status('cursor'),
]);
let cliSetupStatus = {
  claude: initialClaudeSetup,
  codex: initialCodexSetup,
  grok: initialGrokSetup,
  cursor: initialCursorSetup,
};
// grok 세션 시딩용 auth.json 원본 — 발견 순서는 cli-setup-manager 와 같다
// (env GROK_HOME → ~/.grok → 관리형 홈, 심볼릭 링크 원본은 제외).
let sourceGrokAuthPath = (await cliSetup.grokAuthPath()) ?? undefined;
/** cursor-agent 가 보고한 모델 id 목록 — 인증된 setup-status 갱신 때 채워진다. */
let cursorModelIds = [];
/** pi 상태는 동기 경로(resolveModel/startSession)에서도 필요해 캐시해 둔다. */
let piStatus = await piManager.status();
let rauStatus = await rauManager.status();
/** OpenRouter 잔액. 키가 있을 때만 채워지고 사용량 리포트에 얹힌다. */
let openRouterCredits = null;
let rauCreditsBalance = null;
if (piStatus.installed || rauStatus.installed) {
  // 저장소가 갱신되면 확장/스킬도 따라와야 한다 — 실패해도 허브는 그대로 뜬다.
  await piManager.syncAssets().catch((error) => log(`pi asset sync failed: ${error?.message ?? error}`));
  await rauManager.syncAssets().catch((error) => log(`rau asset sync failed: ${error?.message ?? error}`));
}
const providerHealth = createProviderHealth({
  piBin: () => (piStatus.installed ? piManager.piBin : null),
  cliBin: (agent) => (cliSetupStatus[agent]?.installed ? cliSetup.binPath(agent) : null),
  // Version probes can write provider config. Keep both Cursor and Claude in
  // app-owned probe homes instead of inheriting a live profile override.
  probeEnv: (agent) => {
    if (agent === 'cursor') {
      return {
        ...process.env,
        HOME: cliSetup.cursorHomeDir,
        CURSOR_CONFIG_DIR: path.join(cliSetup.cursorHomeDir, '.cursor-probe'),
      };
    }
    if (agent === 'claude') {
      const probeHome = path.join(cliSetup.rootDir, 'claude-probe');
      return claudeRuntimeEnv(probeHome);
    }
    return undefined;
  },
});
const usageStore = await createUsageStore().init();
const cliproxy = await createCliproxyClient({ rootDir: usageStore.rootDir }).init();
const referenceStore = await new ReferenceStore({ projectRoot: ROOT }).init();
const templateStore = await new TemplateStore().init();
// .hwp/.hwpx/.hml 텍스트 추출은 rhwp 바이너리에 기댄다 — 없으면 첫 업로드가 아니라 기동 시점에 알린다.
const hwpExtractor = await resolveHwpExtractor(ROOT);
if (!hwpExtractor) {
  log('hwp/hwpx text extraction unavailable: build target/release/rhwp, install rhwp on PATH, or set RHWP_BIN');
}
const stagedReferenceCleanupTimer = setInterval(() => {
  void referenceStore.cleanupStaged().catch((error) => log(`staged reference cleanup failed: ${error?.message ?? error}`));
}, 15 * 60 * 1000);
stagedReferenceCleanupTimer.unref?.();
let writingStyleCalibrationOwner = null;
// If a bounded provider cleanup cannot prove tree exit, retain the backend
// object (and therefore its exact child/process-group identity) until this hub
// exits. A replacement provider must never share the same work/home paths.
const retainedUncertainBackends = new Set();
const retainedUncertainBrowserbaseSessions = new Set();
const sessions = new HubSessionRegistry({
  createRecord(sessionId) {
    const recordKey = `${crypto.createHash('sha256').update(sessionId).digest('hex')}-${crypto.randomUUID()}`;
    const recordRoot = path.join(RECORDS_ROOT, recordKey);
    const workDir = path.join(recordRoot, 'work');
    // Providers can mutate workDir. Hub-created files must live in a sibling
    // tree whose parents are outside every safe-profile writable root, or a
    // checked directory can be swapped for a symlink/junction before open().
    const hubStorageDir = path.join(recordRoot, 'hub-storage');
    const isolatedHome = path.join(recordRoot, 'home');
    const codexHome = path.join(isolatedHome, '.codex');
    const grokHome = path.join(isolatedHome, '.grok');
    const cursorHome = path.join(isolatedHome, '.cursor');
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    mkdirSync(hubStorageDir, { recursive: true, mode: 0o700 });
    prepareCodexHome(codexHome, sourceCodexAuthPath);
    prepareClaudeHome(isolatedHome, sourceClaudeAuth);
    prepareGrokHome(grokHome, sourceGrokAuthPath);
    prepareCursorHome(cursorHome, cliSetup.cursorSourceDir);
    const downloadManager = new DownloadManager({ rootDir: hubStorageDir, writableRoot: workDir });
    const documentSnapshotManager = new DocumentSnapshotManager({
      rootDir: hubStorageDir,
      writableRoot: workDir,
    });
    const copyLayoutGeneratedRoot = path.join(hubStorageDir, '.rhwp-agent', 'copy-layout-generated');
    const hubReadOnlyRoots = Object.freeze([
      downloadManager.baseDir,
      documentSnapshotManager.baseDir,
      copyLayoutGeneratedRoot,
    ]);
    return {
      sessionId,
      disposed: false,
      createdAt: Date.now(),
      lastConnectedAt: Date.now(),
      studioSocket: null,
      studioInstanceId: null,
      studioReattachTimer: null,
      mcpSockets: new Set(),
      studioMessageQueue: Promise.resolve(),
      agentSession: null,
      processCleanupUncertain: false,
      pendingReferenceMessage: null,
      nextCapabilityEpoch: 1,
      pendingCalls: new Map(),
      pendingUserQuestion: null,
      suppressedUserQuestionCallIds: new Set(),
      pendingUserQuestionScopes: [],
      userQuestionResponseReceipts: new Map(),
      nextHubId: 1,
      sessionGeneration: 0,
      missedTurnEnd: null,
      styleCalibration: null,
      pendingInstructionDraft: null,
      auxiliaryProcesses: new Set(),
      auxiliaryProcessCleanups: new Map(),
      checkpointTitleControllers: new Set(),
      templateJobs: new Map(),
      activeTemplateJobId: null,
      copyLayoutStorageUncertain: false,
      pendingTemplateCompletions: [],
      pendingDocumentSaved: null,
      browserbaseSession: new BrowserbaseSession({ log }),
      downloadManager,
      documentSnapshotManager,
      artifactStore: new ArtifactStore({ rootDir: workDir, trustedReadRoots: hubReadOnlyRoots }),
      recordRoot,
      workDir,
      hubStorageDir,
      hubReadOnlyRoots,
      copyLayoutGeneratedRoot,
      isolatedHome,
      codexHome,
      grokHome,
      cursorHome,
    };
  },
});

function hasAgentSessions() {
  return [...sessions.values()].some((record) => (
    record.agentSession !== null
    || record.processCleanupUncertain
    || [...record.templateJobs.values()].some((job) => job.status === 'running')
  ));
}

function hasConnectedSessionSockets() {
  return [...sessions.values()].some((record) => (
    record.studioSocket?.readyState === 1
    || [...record.mcpSockets].some((socket) => socket?.readyState === 1)
  ));
}

function hasOrphanActiveWork() {
  return [...sessions.values()].some((record) => (
    record.agentSession?.status === 'running'
    || record.pendingCalls.size > 0
    || record.auxiliaryProcesses.size > 0
    || [...record.templateJobs.values()].some((job) => job.status === 'running')
  ));
}

function broadcastToStudios(message) {
  for (const record of sessions.values()) sendJson(record.studioSocket, message);
}

function broadcastAgentInstructions(status, changedBy) {
  for (const record of sessions.values()) {
    if (record.pendingInstructionDraft
      && record.pendingInstructionDraft.expectedRevision !== status.revision) {
      clearInstructionDraft(record, 'stale');
    }
  }
  broadcastToStudios({ v: 1, type: 'agent-instructions', status, changedBy });
}

function instructionDraftFrame(draft) {
  return {
    id: draft.id,
    content: draft.content,
    expectedRevision: draft.expectedRevision,
    reason: draft.reason,
    requestedBy: draft.requestedBy,
    createdAt: new Date(draft.createdAt).toISOString(),
    expiresAt: new Date(draft.expiresAt).toISOString(),
    confirmationToken: draft.confirmationToken,
  };
}

function clearInstructionDraft(record, outcome) {
  const draft = record.pendingInstructionDraft;
  if (!draft) return null;
  record.pendingInstructionDraft = null;
  if (draft.expiryTimer) clearTimeout(draft.expiryTimer);
  sendJson(record.studioSocket, {
    v: 1,
    type: 'agent-instructions-draft-cleared',
    draftId: draft.id,
    outcome,
  });
  return draft;
}

function currentInstructionDraft(record) {
  const draft = record.pendingInstructionDraft;
  if (!draft) return null;
  if (draft.expiresAt <= Date.now()) {
    clearInstructionDraft(record, 'expired');
    return null;
  }
  return draft;
}

function sendInstructionDraft(record, sock = record.studioSocket) {
  const draft = currentInstructionDraft(record);
  if (!draft) return false;
  return sendJson(sock, {
    v: 1,
    type: 'agent-instructions-draft',
    draft: instructionDraftFrame(draft),
  });
}

function authorizedInstructionDraft(record, msg) {
  const draft = currentInstructionDraft(record);
  if (!draft
    || typeof msg.draftId !== 'string'
    || msg.draftId !== draft.id
    || typeof msg.confirmationToken !== 'string'
    || !timingSafeTextEqual(msg.confirmationToken, draft.confirmationToken)) {
    throw workflowError(
      'INSTRUCTIONS_CONFIRMATION_INVALID',
      'The instruction proposal is missing, expired, or no longer authorized.',
    );
  }
  return draft;
}

function consumeAuthorizedInstructionDraft(record, msg) {
  const draft = authorizedInstructionDraft(record, msg);
  record.pendingInstructionDraft = null;
  if (draft.expiryTimer) clearTimeout(draft.expiryTimer);
  return draft;
}

function refreshSessionCredentials(agent) {
  for (const record of sessions.values()) {
    if (agent === 'codex') prepareCodexHome(record.codexHome, sourceCodexAuthPath);
    if (agent === 'claude') prepareClaudeHome(record.isolatedHome, sourceClaudeAuth);
    if (agent === 'grok') prepareGrokHome(record.grokHome, sourceGrokAuthPath);
    if (agent === 'cursor') prepareCursorHome(record.cursorHome, cliSetup.cursorSourceDir);
  }
}

function flushProviderCredentialHomes(homes) {
  if (!homes) return true;
  /** @type {Array<[string, () => boolean]>} */
  const flushes = [
    ['claude', () => flushClaudeCredentialMirrors(homes.isolatedHome)],
    ['codex', () => flushCodexCredentialMirror(homes.codexHome)],
    ['grok', () => flushGrokCredentialMirror(homes.grokHome)],
    ['cursor', () => flushCursorCredentialMirrors(homes.cursorHome)],
  ];
  let settled = true;
  for (const [agent, flush] of flushes) {
    try {
      if (!flush()) settled = false;
    } catch (error) {
      settled = false;
      log(`${agent} credential refresh copyback failed: ${error?.message ?? error}`);
    }
  }
  return settled;
}

/** CLI 설치·인증을 cli-setup-manager 가 관리하는 에이전트들. */
const CLI_SETUP_AGENTS = ['claude', 'codex', 'grok', 'cursor'];
const KNOWN_AGENTS = new Set([...CLI_SETUP_AGENTS, 'pi', 'rau']);
const OPENROUTER_AGENTS = new Set(['pi', 'rau']);
const AGENT_INSTRUCTION_DRAFT_TTL_MS = 5 * 60 * 1000;

const CLAUDE_MODELS = new Set(['opus', 'fable', 'sonnet', 'haiku']);
const CODEX_MODELS = new Set(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
const GROK_MODELS = new Set(['grok-4.6', 'grok-4.5']);
const DEFAULT_MODEL = { claude: 'sonnet', codex: 'gpt-5.6-sol', grok: 'grok-4.6', cursor: 'auto' };
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_EFFORTS_HAIKU = new Set(['low', 'medium', 'high']);
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const GROK_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const DEFAULT_EFFORT = { claude: 'high', codex: 'medium', grok: 'high' };

/** 알 수 없는 에이전트가 코덱스/클로드로 조용히 넘어가지 않도록 명시 테이블로 찾는다. */
const SESSION_FACTORIES = {
  claude: createClaudeSession,
  codex: createCodexSession,
  pi: createPiSession,
  rau: createPiSession,
  grok: createGrokSession,
  cursor: createCursorSession,
};

function openRouterManager(agent) {
  if (agent === 'rau') return rauManager;
  if (agent === 'pi') return piManager;
  return null;
}

function openRouterStatus(agent) {
  if (agent === 'rau') return rauStatus;
  if (agent === 'pi') return piStatus;
  return null;
}

function rauTrialEmpty() {
  if (!rauStatus.setupComplete) return false;
  return creditBalanceEmpty(rauCreditsBalance);
}

function unknownAgentError(agent) {
  return Object.assign(new Error(`unknown agent: ${String(agent)}`), { code: 'INVALID_REQUEST' });
}

/** pi/rau 모델은 캐시된 상태에서 찾는다. */
function piModelConfig(id, agent = 'pi') {
  return (openRouterStatus(agent)?.models ?? []).find((model) => model.id === id) ?? null;
}

async function refreshPiStatus() {
  piStatus = await piManager.status();
  return piStatus;
}

async function refreshRauStatus() {
  rauStatus = await rauManager.status();
  return rauStatus;
}

function openRouterAgentSetupStatus(agent) {
  const status = openRouterStatus(agent);
  return {
    agent,
    installed: status.installed,
    available: status.installed,
    installing: status.installing,
    version: status.version,
    authenticated: status.keyConfigured,
    authMethod: status.keyConfigured ? 'api-key' : null,
    keyTail: status.keyTail,
    account: status.account ?? null,
    authenticating: false,
    setupComplete: status.setupComplete,
    connected: status.setupComplete,
    latestVersion: status.latestVersion ?? null,
    updateRequired: status.updateRequired === true,
    error: status.error,
  };
}

function piAgentSetupStatus() {
  return openRouterAgentSetupStatus('pi');
}

function rauAgentSetupStatus() {
  const status = openRouterAgentSetupStatus('rau');
  if (status.authenticated) status.authMethod = 'oauth';
  if (rauTrialEmpty()) status.exhausted = true;
  return status;
}

function withAuthRunStatus(statuses, ownerSessionId = null) {
  return Object.fromEntries(Object.entries(statuses).map(([agent, status]) => {
    const auth = authRuns.status(agent, ownerSessionId);
    return [agent, {
      ...status,
      ...auth,
      authenticating: status.authenticating === true || auth.authenticating,
    }];
  }));
}

function broadcastAgentSetupStatuses(statuses) {
  for (const record of sessions.values()) {
    sendJson(record.studioSocket, {
      v: 1,
      type: 'agent-setup-status',
      statuses: withAuthRunStatus(statuses, record.sessionId),
    });
  }
}

/** 모델 목록 조회가 상태 응답을 붙잡아 둘 수 있는 상한. */
const CURSOR_MODELS_SOFT_DEADLINE_MS = 2_500;

/**
 * cursor 모델 목록을 짧은 상한 안에서만 기다린다. 늦거나 실패하면 null 을 돌려주고
 * 이번 응답은 직전 목록으로 넘어간다 — 뒤늦게 도착한 결과는 cursorModels 의 TTL
 * 캐시에 남아 다음 집계에서 즉시 쓰인다.
 */
function cursorModelsSoon() {
  const probe = cliSetup.cursorModels().catch(() => null);
  const deadline = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), CURSOR_MODELS_SOFT_DEADLINE_MS);
    timer.unref?.();
  });
  return Promise.race([probe, deadline]);
}

async function agentSetupStatuses(ownerSessionId = null) {
  // cursor 프로브(status + --list-models)는 CLI 를 스폰해 초 단위로 걸린다 —
  // 클로드/코덱스 설정 UI 가 그만큼 늦지 않도록 전부 병렬로 돌린다.
  const [claudeSetup, codexSetup, grokSetup, cursorSetup, health, cursorModelProbe] = await Promise.all([
    cliSetup.status('claude'),
    cliSetup.status('codex'),
    cliSetup.status('grok'),
    cliSetup.status('cursor'),
    providerHealth.check(),
    cursorModelsSoon(),
  ]);
  const withDetectedHarness = (status, provider) => {
    const available = provider?.available === true;
    const connected = available && status.authenticated;
    return {
      ...status,
      available,
      connected,
      version: status.version ?? provider?.version ?? null,
      setupComplete: status.setupComplete || connected,
    };
  };
  const claude = withDetectedHarness(claudeSetup, health.claude);
  const codex = withDetectedHarness(codexSetup, health.codex);
  const grok = withDetectedHarness(grokSetup, health.grok);
  const cursor = withDetectedHarness(cursorSetup, health.cursor);
  // cursor 모델 목록은 인증된 CLI 에서만 나온다 — 실패해도 상태 응답은 막지 않는다.
  cursorModelIds = cursor.authenticated ? (cursorModelProbe ?? cursorModelIds) : [];
  cursor.models = [...cursorModelIds];
  cliSetupStatus = { claude, codex, grok, cursor };
  return withAuthRunStatus(
    { claude, codex, grok, cursor, pi: piAgentSetupStatus(), rau: rauAgentSetupStatus() },
    typeof ownerSessionId === 'string' ? ownerSessionId : null,
  );
}

let harnessUpdateTimer = null;
let harnessUpdateRunning = false;

function scheduleHarnessUpdates(delayMs) {
  if (harnessUpdateTimer) clearTimeout(harnessUpdateTimer);
  harnessUpdateTimer = setTimeout(() => {
    harnessUpdateTimer = null;
    void runAutomaticHarnessUpdates();
  }, delayMs);
  harnessUpdateTimer.unref?.();
}

async function runAutomaticHarnessUpdates() {
  if (harnessUpdateRunning) return;
  // idle 세션도 CLI 프로세스를 물고 있으므로 완전히 닫힌 뒤 디스크의 하네스를 교체한다.
  if (hasAgentSessions()) {
    scheduleHarnessUpdates(HARNESS_UPDATE_BUSY_RETRY_MS);
    return;
  }
  harnessUpdateRunning = true;
  let nextDelay = HARNESS_UPDATE_INTERVAL_MS;
  const canActivate = () => !hasAgentSessions();
  const before = {
    claude: cliSetupStatus.claude?.version ?? null,
    codex: cliSetupStatus.codex?.version ?? null,
    grok: cliSetupStatus.grok?.version ?? null,
    cursor: cliSetupStatus.cursor?.version ?? null,
    pi: piStatus.version ?? null,
  };
  try {
    cliSetupStatus.claude = await cliSetup.automaticUpdate('claude', { canActivate });
    cliSetupStatus.codex = await cliSetup.automaticUpdate('codex', { canActivate });
    cliSetupStatus.grok = await cliSetup.automaticUpdate('grok', { canActivate });
    cliSetupStatus.cursor = await cliSetup.automaticUpdate('cursor', { canActivate });
    piStatus = await mutateSharedNpmPrefix(() => piManager.automaticUpdate({ canActivate }));
    const statuses = await agentSetupStatuses();
    if (Object.values(statuses).some((status) => status.updateRequired)) {
      nextDelay = HARNESS_UPDATE_FAILURE_RETRY_MS;
    }
    broadcastAgentSetupStatuses(statuses);
    const changed = before.claude !== statuses.claude.version
      || before.codex !== statuses.codex.version
      || before.grok !== statuses.grok.version
      || before.cursor !== statuses.cursor.version
      || before.pi !== statuses.pi.version;
    if (changed) {
      const providers = await providerHealth.check(true);
      broadcastToStudios({ v: 1, type: 'provider-status', providers });
    }
  } catch {
    const statuses = await agentSetupStatuses().catch(() => null);
    if (statuses) {
      if (Object.values(statuses).some((status) => status.updateRequired)) {
        nextDelay = HARNESS_UPDATE_FAILURE_RETRY_MS;
      }
      broadcastAgentSetupStatuses(statuses);
    }
  } finally {
    harnessUpdateRunning = false;
    scheduleHarnessUpdates(nextDelay);
  }
}

function sendAgentSetupError(record, sock, requestId, agent, error, fallback = 'AGENT_SETUP_FAILED') {
  replyToStudio(record, sock, {
    v: 1,
    type: 'agent-setup-error',
    requestId,
    agent,
    code: error?.code ?? fallback,
    message: String(error?.message ?? error),
  });
}

function agentAuthCancelled(message = '로그인을 취소했어요.') {
  return Object.assign(new Error(message), { code: 'AGENT_AUTH_CANCELLED' });
}

function ownerRecordForAuthRun(run) {
  return sessions.get(run.ownerSessionId);
}

function sendAuthRunFrame(run, frame) {
  const owner = ownerRecordForAuthRun(run);
  if (!owner) return;
  sendJson(owner.studioSocket, { v: 1, authRunId: run.runId, agent: run.agent, ...frame });
}

function sendAuthRunError(run, error, fallback = 'AGENT_AUTH_FAILED') {
  const owner = ownerRecordForAuthRun(run);
  if (!owner) return;
  sendJson(owner.studioSocket, {
    v: 1,
    type: 'agent-setup-error',
    requestId: run.requestId,
    authRunId: run.runId,
    agent: run.agent,
    code: error?.code ?? fallback,
    message: String(error?.message ?? error),
  });
}

async function broadcastFreshAgentSetupStatuses() {
  const statuses = await agentSetupStatuses();
  broadcastAgentSetupStatuses(statuses);
  return statuses;
}

function resolveModel(agent, requested) {
  if (OPENROUTER_AGENTS.has(agent)) {
    const status = openRouterStatus(agent);
    if (typeof requested === 'string' && piModelConfig(requested, agent)) return requested;
    if (status.defaultModelId && piModelConfig(status.defaultModelId, agent)) return status.defaultModelId;
    return status.models[0]?.id ?? null;
  }
  if (agent === 'cursor') {
    // auto 는 CLI 기본 모델. 캐시된 목록의 id 는 그대로 받고, 목록이 아직 비어
    // 있으면(미인증/미조회) 요청값을 신뢰한다 — 단, 다른 프로바이더의 모델 id 는 거른다.
    if (requested === 'auto') return 'auto';
    const foreignModel = typeof requested === 'string'
      && (CLAUDE_MODELS.has(requested) || CODEX_MODELS.has(requested) || GROK_MODELS.has(requested));
    if (typeof requested === 'string' && requested && !foreignModel
      && (cursorModelIds.length === 0 || cursorModelIds.includes(requested))) {
      return requested;
    }
    return DEFAULT_MODEL.cursor;
  }
  const tables = { claude: CLAUDE_MODELS, codex: CODEX_MODELS, grok: GROK_MODELS };
  const allowed = tables[agent];
  if (!allowed) throw unknownAgentError(agent);
  if (typeof requested === 'string' && allowed.has(requested)) return requested;
  const envDefaults = {
    claude: process.env.RHWP_CLAUDE_MODEL,
    codex: process.env.RHWP_CODEX_MODEL,
    grok: process.env.RHWP_GROK_MODEL,
  };
  const envDefault = envDefaults[agent];
  if (typeof envDefault === 'string' && allowed.has(envDefault)) return envDefault;
  return DEFAULT_MODEL[agent];
}

function resolveEffort(agent, model, requested) {
  if (OPENROUTER_AGENTS.has(agent)) {
    // 추론을 지원하지 않는 모델은 effort 자체가 없다 — 붙이면 요청이 거부된다.
    const efforts = piModelConfig(model, agent)?.efforts ?? [];
    if (efforts.length === 0) return null;
    if (typeof requested === 'string' && efforts.includes(requested)) return requested;
    const preferred = piModelConfig(model, agent)?.defaultEffort;
    return efforts.includes(preferred) ? preferred : efforts[0];
  }
  // cursor CLI 에는 reasoning effort 선택이 없다.
  if (agent === 'cursor') return null;
  const tables = {
    codex: CODEX_EFFORTS,
    grok: GROK_EFFORTS,
    claude: model === 'haiku' ? CLAUDE_EFFORTS_HAIKU : CLAUDE_EFFORTS,
  };
  const allowed = tables[agent];
  if (!allowed) throw unknownAgentError(agent);
  if (typeof requested === 'string' && allowed.has(requested)) return requested;
  const preferred = DEFAULT_EFFORT[agent];
  return allowed.has(preferred) ? preferred : [...allowed][0];
}

function resolveServiceTier(agent, requested) {
  if (agent !== 'codex') return 'standard';
  return requested === 'fast' ? 'fast' : 'standard';
}
// 새 탭·새로고침이 스튜디오 자리를 넘겨받으면 이전 페이지의 실행기와 함께 인플라이트 호출도
// 사라진다 — 30초 타임아웃까지 기다리지 말고 즉시 NO_STUDIO 로 실패시킨다.
// 단순히 소켓만 잠깐 끊긴 경우(같은 인스턴스가 곧바로 재접속)에는 호출을 살려 둔다.
function failAllPendingCalls(record, message) {
  for (const [hubId, entry] of record.pendingCalls) {
    clearTimeout(entry.timer);
    record.pendingCalls.delete(hubId);
    if (entry.tool === 'materialize_document_snapshot' && entry.copyLayoutJobId) {
      const job = record.templateJobs.get(entry.copyLayoutJobId);
      releaseCopyLayoutSnapshot(job);
    }
    sendJson(entry.mcpSocket, {
      v: 1, type: 'tool-result', id: entry.clientId, ok: false,
      error: { code: 'NO_STUDIO', message },
    });
  }
}

function clearStudioReattachGrace(record) {
  if (!record.studioReattachTimer) return;
  clearTimeout(record.studioReattachTimer);
  record.studioReattachTimer = null;
}

// 탭이 아주 닫혔는지, 잠깐 끊겼는지는 소켓만 봐서는 알 수 없다 — 유예 시간을 주고
// 그 안에 스튜디오가 돌아오지 않으면 남은 호출을 NO_STUDIO 로 접는다.
// 유예 중 흘러 들어온 응답으로 이미 끝난 호출은 pendingCalls 에서 빠져 있어 두 번 답하지 않는다.
function armStudioReattachGrace(record) {
  clearStudioReattachGrace(record);
  if (record.pendingCalls.size === 0) return;
  record.studioReattachTimer = setTimeout(() => {
    record.studioReattachTimer = null;
    if (record.studioSocket) return;
    failAllPendingCalls(record, 'Studio disconnected while tool calls were in flight; the edit may still have applied — re-read with get_structure/get_text_range before retrying');
  }, STUDIO_REATTACH_GRACE_MS);
}

function log(msg) {
  process.stderr.write(`[rhwp-agent] ${msg}\n`);
}

function sendJson(sock, obj) {
  if (!sock || sock.readyState !== sock.OPEN) return false;
  try {
    sock.send(JSON.stringify(obj?.v === 1 ? { ...obj, v: PROTOCOL_VERSION } : obj));
    return true;
  } catch (e) {
    log(`send failed: ${e?.message ?? e}`);
    return false;
  }
}

function pendingUserQuestionSnapshot(record) {
  return record.pendingUserQuestion
    ? structuredClone(record.pendingUserQuestion.interaction)
    : null;
}

function userQuestionOutcomeForTurnEnd(event) {
  if (event.stopReason === 'interrupted') return { status: 'cancelled', reason: 'user-stop' };
  if (event.stopReason === 'failed' || event.stopReason === 'exited' || event.errorMessage) {
    return { status: 'expired', reason: 'provider-disconnected' };
  }
  return { status: 'expired', reason: 'request-invalidated' };
}

function settleUserQuestion(record, outcome) {
  const pending = record.pendingUserQuestion;
  if (!pending) return false;
  record.pendingUserQuestion = null;
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener('abort', pending.onAbort);
  }
  sendJson(record.studioSocket, {
    v: 1,
    type: 'user-question-resolved',
    interactionId: pending.interaction.interactionId,
    outcome,
  });
  pending.resolve(structuredClone(outcome));
  return true;
}

function beginAgentTurn(record, activeSession) {
  if (record.pendingUserQuestion) {
    settleUserQuestion(record, { status: 'expired', reason: 'request-invalidated' });
  }
  record.userQuestionResponseReceipts.clear();
  activeSession.turnId = crypto.randomUUID();
  activeSession.status = 'running';
}

function settleAgentTurn(record, activeSession, event) {
  settleUserQuestion(record, userQuestionOutcomeForTurnEnd(event));
  activeSession.status = 'idle';
  activeSession.turnId = null;
}

function requestUserQuestion(record, request, {
  source,
  generation,
  signal,
  mcpSocket = null,
} = {}) {
  const normalizedRequest = normalizeProviderUserQuestionRequest(request);
  const activeSession = record.agentSession;
  if (!activeSession || activeSession.generation !== generation) {
    throw workflowError('REQUEST_INVALIDATED', 'The agent session changed before the question could be presented');
  }
  if (normalizedRequest.parentTaskId) {
    throw workflowError('ROOT_INTERACTION_REQUIRED', 'Only the root conversation may ask the user questions');
  }
  if (activeSession.status !== 'running' || !activeSession.turnId) {
    throw workflowError('NO_ACTIVE_TURN', 'User questions require an active root turn');
  }
  const current = record.pendingUserQuestion;
  if (current) {
    if (current.source === source && sameUserQuestionRequest(current.request, normalizedRequest)) {
      return current.promise;
    }
    throw workflowError('INTERACTION_ALREADY_PENDING', 'Another user question is already waiting for an answer');
  }
  if (signal?.aborted) {
    return Promise.resolve({ status: 'expired', reason: 'provider-disconnected' });
  }
  if (!record.studioSocket || record.studioSocket.readyState !== record.studioSocket.OPEN) {
    throw workflowError('NO_STUDIO', 'Studio is not connected to present the user question');
  }
  const interaction = createUserQuestionInteraction({
    request: normalizedRequest,
    agent: activeSession.agent,
    source,
    threadId: activeSession.threadId,
    turnId: activeSession.turnId,
  });
  let resolveInteraction;
  const promise = new Promise((resolve) => { resolveInteraction = resolve; });
  const onAbort = () => {
    if (record.pendingUserQuestion?.interaction.interactionId !== interaction.interactionId) return;
    settleUserQuestion(record, { status: 'expired', reason: 'provider-disconnected' });
  };
  record.pendingUserQuestion = {
    interaction,
    request: normalizedRequest,
    source,
    generation,
    mcpSocket,
    signal: signal ?? null,
    onAbort: signal ? onAbort : null,
    promise,
    resolve: resolveInteraction,
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const delivered = sendJson(record.studioSocket, {
    v: 1,
    type: 'user-question-requested',
    interaction: structuredClone(interaction),
  });
  if (!delivered) {
    settleUserQuestion(record, { status: 'expired', reason: 'provider-disconnected' });
    throw workflowError('NO_STUDIO', 'Studio disconnected before the user question could be presented');
  }
  return promise;
}

function matchingUserQuestionScopes(record, agent, questions) {
  const expectedQuestions = JSON.stringify(questions);
  return record.pendingUserQuestionScopes
    .map((scope, index) => ({ scope, index }))
    .filter(({ scope }) => (
      scope.agent === agent
      && scope.questions
      && JSON.stringify(scope.questions) === expectedQuestions
    ));
}

async function waitForUserQuestionScopes(record, agent, questions, generation) {
  const deadline = Date.now() + USER_QUESTION_SCOPE_WAIT_MS;
  let matches = matchingUserQuestionScopes(record, agent, questions);
  while (matches.length === 0
    && record.agentSession?.generation === generation
    && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, deadline - Date.now())));
    matches = matchingUserQuestionScopes(record, agent, questions);
  }
  return matches;
}

function userQuestionAnswerFrame({ interactionId, responseId, ok, code, message }) {
  return {
    v: 1,
    type: 'user-question-answer-result',
    interactionId,
    responseId,
    ok,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function answerUserQuestion(record, sock, msg) {
  const interactionId = typeof msg.interactionId === 'string' ? msg.interactionId : '';
  const responseId = typeof msg.responseId === 'string' ? msg.responseId : '';
  if (!interactionId || !responseId || interactionId.length > 256 || responseId.length > 256) {
    sendJson(sock, userQuestionAnswerFrame({
      interactionId,
      responseId,
      ok: false,
      code: 'INVALID_USER_QUESTION_ANSWER',
      message: 'interactionId and responseId are required and must be at most 256 characters',
    }));
    return;
  }
  const receipt = record.userQuestionResponseReceipts.get(responseId);
  if (receipt) {
    if (receipt.interactionId === interactionId) sendJson(sock, receipt.frame);
    else sendJson(sock, userQuestionAnswerFrame({
      interactionId,
      responseId,
      ok: false,
      code: 'RESPONSE_ID_REUSED',
      message: 'responseId was already used for another interaction in this turn',
    }));
    return;
  }
  const pending = record.pendingUserQuestion;
  let frame;
  try {
    if (!pending || pending.interaction.interactionId !== interactionId) {
      throw workflowError('USER_QUESTION_NOT_FOUND', 'The question is no longer waiting for an answer');
    }
    const activeSession = record.agentSession;
    if (!activeSession
      || activeSession.generation !== pending.generation
      || activeSession.threadId !== pending.interaction.threadId
      || activeSession.turnId !== pending.interaction.turnId) {
      throw workflowError('REQUEST_INVALIDATED', 'The question no longer belongs to the active root turn');
    }
    const answers = validateUserQuestionAnswers(pending.interaction, msg.answers);
    frame = userQuestionAnswerFrame({ interactionId, responseId, ok: true });
    record.userQuestionResponseReceipts.set(responseId, { interactionId, frame });
    sendJson(sock, frame);
    settleUserQuestion(record, { status: 'answered', answers });
    return;
  } catch (error) {
    frame = userQuestionAnswerFrame({
      interactionId,
      responseId,
      ok: false,
      code: error?.code ?? 'INVALID_USER_QUESTION_ANSWER',
      message: String(error?.message ?? error),
    });
  }
  record.userQuestionResponseReceipts.set(responseId, { interactionId, frame });
  sendJson(sock, frame);
}

function broadcastTemplateCatalog(change = null) {
  const catalog = { v: 1, type: 'templates-catalog', ...templateStore.list(), ...(change ? { change } : {}) };
  for (const record of sessions.values()) {
    const activeSession = record.agentSession;
    if (change?.type === 'deleted' && activeSession?.activeTemplateId === change.template?.id) {
      activeSession.activeTemplateId = null;
      sendJson(record.studioSocket, { v: 1, type: 'chat-template-changed', template: null, reason: 'deleted' });
    }
    sendJson(record.studioSocket, catalog);
  }
}

function writingStyleCatalog(record) {
  const activeSession = record.agentSession;
  return buildWritingStyleCatalog({
    health: providerHealth.cached(),
    piStatus,
    rauStatus,
    currentSelection: activeSession ? { agent: activeSession.agent, model: activeSession.model, effort: activeSession.effort } : null,
  });
}

function sendStyleProgress(record, event) {
  const calibration = record.styleCalibration;
  if (!calibration) return;
  const snapshot = {
    v: 1,
    type: 'writing-style-progress',
    requestId: calibration.requestId,
    jobId: calibration.jobId,
    startedAt: calibration.startedAt,
    agent: calibration.agent,
    model: calibration.model,
    ...event,
  };
  calibration.progress = snapshot;
  sendJson(record.studioSocket, snapshot);
}

// 비동기 응답이 도착할 때쯤 스튜디오 탭이 교체되었을 수 있다 — 현재 소켓에만 보낸다.
function replyToStudio(record, sock, obj) {
  if (sock !== record.studioSocket) return;
  sendJson(sock, obj);
}

function usageSnapshot() {
  const usage = cliproxy.applyToSummary(usageStore.summary());
  if (openRouterCredits) usage.openrouter = openRouterCredits;
  if (rauCreditsBalance) usage.rau = rauCreditsBalance;
  return usage;
}

function emptyCreditsError(error) {
  return {
    balanceUsd: 0,
    totalCreditsUsd: 0,
    totalUsageUsd: 0,
    checkedAt: Date.now(),
    error: String(error?.message ?? error),
  };
}

/** 잔액 조회는 5분 캐시된다 — refresh 일 때만 실제로 다시 부른다. */
async function refreshOpenRouterCredits(refresh = false) {
  if (!piStatus.keyConfigured) {
    openRouterCredits = null;
  } else {
    try {
      openRouterCredits = await piManager.credits(refresh === true);
    } catch (error) {
      openRouterCredits = emptyCreditsError(error);
    }
  }
  if (!rauStatus.keyConfigured) {
    rauCreditsBalance = null;
    return;
  }
  try {
    rauCreditsBalance = await rauManager.credits(refresh === true);
  } catch (error) {
    rauCreditsBalance = emptyCreditsError(error);
  }
}

async function usageSnapshotRefreshing(refresh = false) {
  if (cliproxy.configured()) await cliproxy.refresh(refresh === true);
  await refreshOpenRouterCredits(refresh);
  return usageSnapshot();
}

/**
 * 보조 작업(제목·스킬 초안·문체 분석)을 OpenRouter 로 돌릴지 정한다.
 * pi 를 고른 사용자거나, CLI 가 없는데 pi 설정은 끝나 있는 경우다.
 *
 * @param {string|null|undefined} requestedAgent
 * @param {'claude'|'codex'} cliAgent 이 작업이 원래 쓰는 CLI
 */
function spawnAuxiliaryProcess(record, command, args, options = {}) {
  if (record.disposed) throw new Error('Hub session was disposed');
  const child = spawn(command, args, { ...options, cwd: options.cwd ?? record.workDir });
  record.auxiliaryProcesses.add(child);
  const cleanup = () => beginAuxiliaryProcessCleanup(record, child);
  child.once('exit', cleanup);
  child.once('close', cleanup);
  return child;
}

function beginAuxiliaryProcessCleanup(record, child) {
  const current = record.auxiliaryProcessCleanups.get(child);
  if (current) return current;
  const cleanup = terminateAndWaitForProcessTreeExit(child)
    .catch(() => false)
    .then((cleaned) => {
      if (cleaned) {
        record.auxiliaryProcesses.delete(child);
        record.auxiliaryProcessCleanups.delete(child);
      }
      return cleaned;
    });
  record.auxiliaryProcessCleanups.set(child, cleanup);
  return cleanup;
}

/**
 * 보조 CLI(claude/codex) 스폰 래퍼 — 해당 프로바이더의 키를 그 자식에게만 얹는다.
 * process.env 에 키가 없으므로(위 주석 참고), 인증이 필요한 보조 실행은 여기서 채운다.
 */
function auxSpawnProcess(record, command, args, options = {}) {
  const finalOptions = { ...options };
  if (command === 'claude' || command === 'codex') {
    finalOptions.env = {
      ...cliSetup.envFor(command),
      ...(options.env ?? {}),
    };
  }
  return spawnAuxiliaryProcess(record, command, args, finalOptions);
}

async function stopAuxiliaryProcesses(record) {
  const children = [...record.auxiliaryProcesses];
  const results = await Promise.all(children.map((child) => (
    beginAuxiliaryProcessCleanup(record, child)
  )));
  return results.every(Boolean);
}

function cancelCheckpointTitleJobs(record) {
  const controllers = [...record.checkpointTitleControllers];
  record.checkpointTitleControllers.clear();
  for (const controller of controllers) controller.abort();
}

function checkpointTitleDeps(record, health, signal) {
  const deepSeek = findDeepSeekV4FlashModel(piStatus.models);
  const codex = resolveCheckpointTitleCliRoute(
    'codex', health?.codex, cliSetupStatus.codex, cliSetup.binPath('codex'),
  );
  const grok = resolveCheckpointTitleCliRoute(
    'grok', health?.grok, cliSetupStatus.grok, cliSetup.binPath('grok'),
  );
  const claude = resolveCheckpointTitleCliRoute(
    'claude', health?.claude, cliSetupStatus.claude, cliSetup.binPath('claude'),
  );
  return {
    readiness: {
      pi: {
        ready: Boolean(
          deepSeek
          && health?.pi?.available === true
          && piStatus.installed
          && piStatus.keyConfigured,
        ),
        model: deepSeek?.id ?? '',
      },
      codex: { ready: codex.ready, model: 'gpt-5.6-luna' },
      grok: { ready: grok.ready, model: 'grok-4.6' },
      claude: { ready: claude.ready, model: 'haiku' },
    },
    piManager,
    openRouter,
    workDir: record.workDir,
    isolatedHome: record.isolatedHome,
    sessionId: record.sessionId,
    commands: {
      codex: codex.command,
      grok: grok.command,
      claude: claude.command,
    },
    providerEnvs: {
      codex: { ...cliSetup.envFor('codex'), CODEX_HOME: record.codexHome },
      grok: {
        ...cliSetup.envFor('grok'),
        GROK_HOME: record.grokHome,
        GROK_DISABLE_AUTOUPDATER: '1',
        GROK_MEMORY: '0',
      },
      claude: claudeRuntimeEnv(record.isolatedHome),
    },
    spawnProcess: (command, args, options) => spawnAuxiliaryProcess(record, command, args, options),
    terminateProcess: terminateProcessTree,
    signal,
  };
}

function auxDeps(record, requestedAgent, cliAgent) {
  const agent = requestedAgent === 'pi' || requestedAgent === 'rau'
    || requestedAgent === 'claude' || requestedAgent === 'codex'
    ? requestedAgent
    : (record.agentSession?.agent ?? null);
  const manager = agent === 'rau' ? rauManager : piManager;
  const router = agent === 'rau' ? rauOpenRouter : openRouter;
  const health = providerHealth.cached();
  // 프로브 전이면 CLI 가 있다고 보고 기존 경로를 먼저 태운다.
  const cliAvailable = health ? health[cliAgent]?.available !== false : true;
  return {
    useOpenRouter: (agent === 'rau' && rauStatus.setupComplete)
      || (piStatus.setupComplete && (agent === 'pi' || !cliAvailable)),
    piManager: manager,
    openRouter: router,
    workDir: record.workDir,
    cwd: record.workDir,
    isolatedHome: record.isolatedHome,
    sessionId: record.sessionId,
    spawnProcess: (command, args, options) => auxSpawnProcess(record, command, args, options),
    terminateProcess: terminateProcessTree,
  };
}

function sessionInfo(record) {
  const activeSession = record.agentSession;
  return activeSession
    ? {
      agent: activeSession.agent,
      model: activeSession.model,
      effort: activeSession.effort,
      permissionProfile: activeSession.permissionProfile,
      serviceTier: activeSession.serviceTier,
      sessionId: activeSession.sessionId,
      threadId: activeSession.threadId,
      documentId: activeSession.documentId,
      documentName: activeSession.documentName,
      status: activeSession.status,
      activeTemplateId: activeSession.activeTemplateId,
      pendingUserQuestion: pendingUserQuestionSnapshot(record),
      ...activeSession.planning.snapshot(),
    }
    : null;
}

function artifactDownloadDescriptor(record, artifactId, artifact) {
  const encodePathSegment = (value) => encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const downloadUrl = new URL(
    `/artifacts/${encodePathSegment(artifactId)}/${encodePathSegment(artifact.fileName)}`,
    `http://127.0.0.1:${hubPort}`,
  );
  downloadUrl.searchParams.set('sessionId', record.sessionId);
  downloadUrl.searchParams.set('token', sessions.issue(TOKEN, record.sessionId, {
    audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
    resource: artifactId,
  }));
  downloadUrl.searchParams.set('templatePreview', '1');
  return {
    artifactId,
    fileName: artifact.fileName,
    mime: artifact.mime,
    size: artifact.size,
    checksum: artifact.checksum,
    downloadUrl: downloadUrl.href,
  };
}

function sendTemplateJobEvent(record, event) {
  sendJson(record.studioSocket, { v: 1, type: 'agent-event', event });
}

function workerJobForSocket(record, sock) {
  if (typeof sock.copyLayoutJobId !== 'string') return null;
  return record.templateJobs.get(sock.copyLayoutJobId) ?? null;
}

function templateCompletionResult(job) {
  return {
    jobId: job.jobId,
    outcome: job.status === 'completed' ? 'succeeded' : 'failed',
    source: job.binding,
    ...(job.result ?? {}),
  };
}

function exactJsonArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function copyLayoutCandidateClaims(job, published) {
  const report = published?.report;
  const evidence = report?.candidate_evidence;
  const pages = evidence?.representative_pages;
  const validRender = (entry, page) => entry
    && entry.page === page
    && Number.isSafeInteger(entry.width) && entry.width > 0 && entry.width <= 16_384
    && Number.isSafeInteger(entry.height) && entry.height > 0 && entry.height <= 16_384
    && Number.isSafeInteger(entry.bytes) && entry.bytes >= 24 && entry.bytes <= 16 * 1024 * 1024
    && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256);
  if (!Array.isArray(pages)
    || pages.length < 1 || pages.length > 3
    || !pages.every((page, index) => Number.isSafeInteger(page)
      && page >= 0 && (index === 0 || page > pages[index - 1]))
    || !Number.isSafeInteger(evidence?.source_page_count) || evidence.source_page_count < 1
    || !Number.isSafeInteger(evidence?.output_page_count) || evidence.output_page_count < 1
    || !Number.isSafeInteger(evidence?.output_section_count) || evidence.output_section_count < 1
    || evidence.render_compared !== true
    || evidence.safety_verified !== true
    || evidence.readability_verified !== true
    || !Array.isArray(evidence.source_renders)
    || !Array.isArray(evidence.output_renders)
    || evidence.source_renders.length !== pages.length
    || evidence.output_renders.length !== pages.length
    || !pages.every((page, index) => validRender(evidence.source_renders[index], page)
      && validRender(evidence.output_renders[index], page))) {
    throw workflowError(
      'COPY_LAYOUT_VERIFICATION_MISSING',
      'The published candidate lacks bounded helper-owned source/candidate render evidence',
    );
  }
  const quality = report?.delivery?.quality;
  const warnings = report?.delivery?.warnings;
  if (!['verified', 'best_effort'].includes(quality) || !Array.isArray(warnings)) {
    throw workflowError('COPY_LAYOUT_VERIFICATION_MISSING', 'The helper omitted its delivery result');
  }
  if (quality === 'best_effort' && job.generatedCandidates.size < COPY_LAYOUT_MAX_ITERATIONS) {
    throw workflowError(
      'COPY_LAYOUT_ITERATIONS_REQUIRED',
      `A best-effort candidate may settle only after all ${COPY_LAYOUT_MAX_ITERATIONS} bounded iterations`,
    );
  }
  const counts = {
    keptText: report?.text_decisions?.kept_count,
    removedText: report?.text_decisions?.removed_count,
    replacedText: report?.text_decisions?.replacement_count,
    resetControls: Array.isArray(report?.reset_form_controls)
      ? report.reset_form_controls.length : null,
    clearedMarks: Array.isArray(report?.cleared_border_fill_marks)
      ? report.cleared_border_fill_marks.length : null,
    keptMedia: new Set([
      ...(Array.isArray(report?.kept_layout_media) ? report.kept_layout_media : []),
      ...(Array.isArray(report?.kept_explicit_media) ? report.kept_explicit_media : []),
    ]).size,
    removedMedia: new Set([
      ...(Array.isArray(report?.removed_body_media) ? report.removed_body_media : []),
      ...(Array.isArray(report?.removed_unreferenced_media) ? report.removed_unreferenced_media : []),
    ]).size,
    iterations: job.generatedCandidates.size,
  };
  if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw workflowError('COPY_LAYOUT_VERIFICATION_MISSING', 'The helper omitted bounded decision counts');
  }
  return {
    quality,
    warnings,
    counts,
    preview: {
      representativePages: [...pages],
      sourcePageCount: evidence.source_page_count,
      outputPageCount: evidence.output_page_count,
      outputSectionCount: evidence.output_section_count,
      renderCompared: true,
      geometryMatch: evidence.geometry_match === true,
      safetyVerified: true,
      readabilityVerified: true,
      stoppedReason: quality === 'verified'
        ? 'verified-convergence'
        : 'bounded-no-improvement',
    },
  };
}

function drainTemplateCompletion(record) {
  const activeSession = record.agentSession;
  if (!activeSession || activeSession.status !== 'idle') return;
  const index = record.pendingTemplateCompletions.findIndex(
    (entry) => entry.ownerThreadId === activeSession.threadId,
  );
  if (index < 0) return;
  const [entry] = record.pendingTemplateCompletions.splice(index, 1);
  beginAgentTurn(record, activeSession);
  try {
    activeSession.backend.sendUserMessage(addAgentInstructionsContext(
      buildCopyLayoutCompletionPrompt(entry.result),
    ));
  } catch (error) {
    activeSession.status = 'idle';
    activeSession.turnId = null;
    record.userQuestionResponseReceipts.clear();
    record.pendingTemplateCompletions.splice(index, 0, entry);
    log(`copy-layout completion dispatch failed: ${error?.message ?? error}`);
  }
}

function planningDocumentSavedAllowed(activeSession) {
  const workflow = activeSession?.planning?.workflow;
  const phase = activeSession?.planning?.phase;
  return workflow === 'question'
    || (workflow === 'plan' && (phase === 'planning' || phase === 'awaiting-approval'));
}

function queuePlanningDocumentSaved(record, msg) {
  const activeSession = record.agentSession;
  if (!planningDocumentSavedAllowed(activeSession)) return;
  record.pendingDocumentSaved = {
    threadId: activeSession.threadId,
    revision: Number.isSafeInteger(msg.revision) ? msg.revision : undefined,
    fileName: typeof msg.fileName === 'string' ? msg.fileName : undefined,
  };
  drainPlanningDocumentSaved(record);
}

function drainPlanningDocumentSaved(record) {
  const activeSession = record.agentSession;
  const pending = record.pendingDocumentSaved;
  if (!pending || !activeSession || activeSession.status !== 'idle') return;
  if (pending.threadId !== activeSession.threadId || !planningDocumentSavedAllowed(activeSession)) {
    record.pendingDocumentSaved = null;
    return;
  }
  const phase = activeSession.planning.phase;
  record.pendingDocumentSaved = null;
  const prompt = buildPlanningDocumentSavedPrompt(pending);
  activeSession.status = 'running';
  if (phase === 'awaiting-approval') {
    const planId = activeSession.planning.latestPlan?.planId;
    if (!planId) {
      activeSession.status = 'idle';
      return;
    }
    void requestImplementationPlanChanges(record, record.studioSocket, {
      planId,
      reason: 'document-saved',
      promptOverride: prompt,
      sessionStatusOverride: 'idle',
    }).catch((error) => {
      if (record.agentSession === activeSession) {
        if (activeSession.status === 'running') activeSession.status = 'idle';
        if (!record.pendingDocumentSaved) record.pendingDocumentSaved = pending;
      }
      sendChatError(record.studioSocket, error);
    });
    return;
  }
  try {
    activeSession.backend.sendUserMessage(addAgentInstructionsContext(addActiveDocumentContext(
      activeSession,
      addTemplateContext(record, activeSession, prompt),
    )));
  } catch (error) {
    activeSession.status = 'idle';
    record.pendingDocumentSaved = pending;
    log(`planning document-saved dispatch failed: ${error?.message ?? error}`);
  }
}

function queueTemplateCompletion(record, job) {
  if (job.completionQueued) return;
  job.completionQueued = true;
  record.pendingTemplateCompletions.push({
    ownerThreadId: job.ownerThreadId,
    result: templateCompletionResult(job),
  });
  drainTemplateCompletion(record);
}

function pruneTemplateJobHistory(record) {
  if (record.templateJobs.size <= MAX_COPY_LAYOUT_JOB_HISTORY) return;
  for (const [jobId, job] of record.templateJobs) {
    if (record.templateJobs.size <= MAX_COPY_LAYOUT_JOB_HISTORY) break;
    if (job.status === 'running' || job.status === 'settling' || jobId === record.activeTemplateJobId) continue;
    record.templateJobs.delete(jobId);
  }
}

async function cleanupTemplateGeneratedRoot(record, job) {
  if (!job?.generatedRoot && !job?.snapshotRoot) return true;
  if (record.processCleanupUncertain) {
    record.copyLayoutStorageUncertain = true;
    return false;
  }
  try {
    await Promise.all([
      job.generatedRoot ? fs.rm(job.generatedRoot, { recursive: true, force: true }) : undefined,
      job.snapshotRoot ? fs.rm(job.snapshotRoot, { recursive: true, force: true }) : undefined,
    ]);
    return true;
  } catch (error) {
    record.copyLayoutStorageUncertain = true;
    log(`copy-layout private output cleanup failed: ${error?.message ?? error}`);
    return false;
  }
}

async function cleanupTemplateProviderRoots(record, job, backendCleaned) {
  const credentialsCleaned = flushProviderCredentialHomes(job.providerHomes);
  if (backendCleaned === false || !credentialsCleaned) {
    record.copyLayoutStorageUncertain = true;
    if (backendCleaned === false) {
      record.processCleanupUncertain = true;
      retainUncertainProcessCleanup(record.recordRoot);
    }
    return false;
  }
  try {
    await Promise.all([
      job.jobDir ? fs.rm(job.jobDir, { recursive: true, force: true }) : undefined,
      job.providerRoot ? fs.rm(job.providerRoot, { recursive: true, force: true }) : undefined,
    ]);
    return true;
  } catch (error) {
    record.copyLayoutStorageUncertain = true;
    log(`copy-layout provider workspace cleanup failed: ${error?.message ?? error}`);
    return false;
  }
}

function cancelPendingTemplateCalls(record, job) {
  for (const [hubId, entry] of record.pendingCalls) {
    if (entry.copyLayoutJobId !== job.jobId) continue;
    record.pendingCalls.delete(hubId);
    clearTimeout(entry.timer);
    releaseCopyLayoutSnapshot(job);
    sendJson(entry.mcpSocket, {
      v: 1,
      type: 'tool-result',
      id: entry.clientId,
      ok: false,
      error: {
        code: 'COPY_LAYOUT_JOB_SETTLED',
        message: 'The copy-layout job settled before Studio completed this tool request',
      },
    });
  }
}

function settleTemplateJobFailure(record, job, error) {
  if (!job || job.status !== 'running') return;
  const message = String(error?.message ?? error ?? 'Autonomous copy-layout worker stopped without a completion report');
  job.status = 'failed';
  cancelPendingTemplateCalls(record, job);
  job.activity = message;
  job.result = {
    summary: message,
    warnings: [message],
    counts: {
      keptText: 0, removedText: 0, replacedText: 0, resetControls: 0,
      clearedMarks: 0, keptMedia: 0, removedMedia: 0, iterations: 1,
    },
    preview: {
      representativePages: [], sourcePageCount: 1, outputPageCount: 1,
      outputSectionCount: 1, renderCompared: false, geometryMatch: false,
      safetyVerified: false, readabilityVerified: false, stoppedReason: 'hard-failure',
    },
  };
  job.inspection = null;
  job.generatedCandidates?.clear();
  job.publishedArtifacts?.clear();
  record.activeTemplateJobId = null;
  void Promise.allSettled([
    Promise.resolve(job.helperPromise),
    Promise.resolve(job.snapshotPromise),
  ]).then(() => cleanupTemplateGeneratedRoot(record, job));
  pruneTemplateJobHistory(record);
  sendTemplateJobEvent(record, {
    type: 'task-end', agent: job.agent, taskId: job.jobId,
    status: 'failed', summary: message, ...(job.usage ? { usage: job.usage } : {}),
  });
  queueTemplateCompletion(record, job);
}

function makeTemplateWorkerEventHandler(record, job) {
  return (event) => {
    if (job.status !== 'running' && event.type !== 'turn-end') return;
    if (event.type === 'session-info' && event.sessionId) job.providerSessionId = event.sessionId;
    if (event.type === 'text-delta' && event.text?.trim()) {
      job.activity = event.text.replace(/\s+/g, ' ').trim().slice(-500);
      sendTemplateJobEvent(record, taskProgressForJob(job, job.activity));
      return;
    }
    if (event.type === 'tool-call') {
      job.usage = { ...(job.usage ?? {}), toolUses: (job.usage?.toolUses ?? 0) + 1 };
      sendTemplateJobEvent(record, taskProgressForJob(job, job.activity, event.tool));
      return;
    }
    if (event.type === 'usage') {
      usageStore.record({ agent: job.agent, model: event.model, costUsd: event.costUsd, ...(event.usage ?? {}) });
      const totalTokens = Object.values(event.usage ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
      job.usage = { ...(job.usage ?? {}), totalTokens };
      sendJson(record.studioSocket, { v: 1, type: 'usage-report', usage: usageSnapshot() });
      sendTemplateJobEvent(record, taskProgressForJob(job, job.activity));
      return;
    }
    if (event.type === 'error') {
      job.lastError = event.message;
      job.activity = event.message;
      sendTemplateJobEvent(record, taskProgressForJob(job, event.message));
      return;
    }
    if (event.type === 'turn-end') {
      if (job.status === 'running') settleTemplateJobFailure(record, job, job.lastError || event.errorMessage);
      const backend = job.backend;
      job.backend = null;
      void Promise.resolve(backend?.dispose())
        .catch((error) => {
          log(`copy-layout worker dispose failed: ${error?.message ?? error}`);
          return false;
        })
        .then((cleaned) => cleanupTemplateProviderRoots(record, job, cleaned));
    }
  };
}

async function launchTemplateJob(record, job) {
  // The owning chat provider can mutate record.workDir. Keep even the
  // worker's read-only cwd under a sibling hub-owned parent so it cannot be
  // swapped to a symlink/junction before the worker opens files.
  const jobDir = path.join(record.recordRoot, 'copy-layout-workspaces', job.jobId);
  const jobGeneratedRoot = path.join(record.copyLayoutGeneratedRoot, job.jobId);
  const jobSnapshotRoot = record.documentSnapshotManager.readOnlyRootForChat(job.jobId);
  const providerRoot = path.join(record.recordRoot, 'copy-layout-providers', job.jobId);
  const isolatedHome = path.join(providerRoot, 'home');
  const codexHome = path.join(isolatedHome, '.codex');
  const grokHome = path.join(isolatedHome, '.grok');
  const cursorHome = path.join(isolatedHome, '.cursor');
  job.providerHomes = { isolatedHome, codexHome, grokHome, cursorHome };
  job.providerRoot = providerRoot;
  await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(providerRoot, { recursive: true, mode: 0o700 });
  prepareCodexHome(codexHome, sourceCodexAuthPath);
  prepareClaudeHome(isolatedHome, sourceClaudeAuth);
  prepareGrokHome(grokHome, sourceGrokAuthPath);
  prepareCursorHome(cursorHome, cliSetup.cursorSourceDir);
  job.jobDir = jobDir;
  job.generatedRoot = jobGeneratedRoot;
  job.snapshotRoot = jobSnapshotRoot;

  const opts = {
    rootDir: jobDir,
    workDir: jobDir,
    // A background worker can read only its own immutable snapshot and
    // generated candidates, never the owning chat's workspace/downloads.
    readOnlyRoots: [jobSnapshotRoot, jobGeneratedRoot],
    mcpScriptPath: MCP_SCRIPT,
    hubPort,
    token: sessions.issue(TOKEN, record.sessionId, {
      audience: HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER,
      resource: job.jobId,
    }),
    sessionId: record.sessionId,
    model: job.model,
    effort: job.effort,
    permissionProfile: 'safe',
    isolatedHome,
    codexHome,
    codexAuthPath: sourceCodexAuthPath,
    grokHome,
    grokAuthPath: sourceGrokAuthPath,
    cursorSourceDir: cliSetup.cursorSourceDir,
    codexBin: cliSetupStatus.codex?.installed ? cliSetup.binPath('codex') : 'codex',
    claudeBin: cliSetupStatus.claude?.installed ? cliSetup.binPath('claude') : 'claude',
    grokBin: cliSetupStatus.grok?.installed ? cliSetup.binPath('grok') : 'grok',
    cursorBin: cliSetupStatus.cursor?.installed ? cliSetup.binPath('cursor') : 'cursor-agent',
    providerEnv: job.agent === 'claude'
      ? claudeRuntimeEnv(isolatedHome)
      : (CLI_SETUP_AGENTS.includes(job.agent) ? cliSetup.envFor(job.agent) : {}),
    onEvent: makeTemplateWorkerEventHandler(record, job),
    workflow: 'direct',
    phase: 'implementing',
    capabilityEpoch: job.capabilityEpoch,
    toolProfile: 'copy-layout-worker',
    agentRole: job.workerRole,
    systemPromptOverride: buildCopyLayoutWorkerPrompt({
      jobId: job.jobId,
      binding: job.binding,
      jobDir,
    }),
    piBin: (job.agent === 'rau' ? rauManager : piManager).piBin,
    piRoot: job.agent === 'rau' ? rauManager.rootDir : piManager.rootDir,
    openRouterApiKey: openRouterManager(job.agent)?.apiKey() ?? undefined,
    agentName: OPENROUTER_AGENTS.has(job.agent) ? job.agent : 'pi',
    reasoning: OPENROUTER_AGENTS.has(job.agent)
      ? Boolean(piModelConfig(job.model, job.agent)?.reasoning)
      : false,
  };
  const createBackend = SESSION_FACTORIES[job.agent];
  if (!createBackend) throw unknownAgentError(job.agent);
  job.backend = createBackend(opts);
  job.backend.sendUserMessage('Begin the autonomous copy-layout workflow now. Follow the system workflow exactly and do not ask questions.');
}

function createTemplateJob(record, activeSession, binding) {
  if (record.copyLayoutStorageUncertain) {
    throw workflowError('COPY_LAYOUT_STORAGE_UNCERTAIN', 'A prior copy-layout workspace could not be cleaned; restart the hub before retrying');
  }
  if (record.activeTemplateJobId) {
    const active = record.templateJobs.get(record.activeTemplateJobId);
    if (active && active.status !== 'completed' && active.status !== 'failed') {
      throw workflowError('COPY_LAYOUT_JOB_ACTIVE', 'A copy-layout job is already running for this Studio window');
    }
  }
  if (binding.documentId !== activeSession.documentId) {
    throw workflowError('DOCUMENT_ID_MISMATCH', 'The copy-layout binding does not match this chat\'s exact documentId');
  }
  const latest = activeSession.lastDocumentInfo;
  if (!latest
    || latest.documentId !== binding.documentId
    || latest.digest !== binding.digest
    || latest.sourceFormat !== binding.sourceFormat
    || latest.dirty !== binding.dirty
    || latest.sourcePath !== binding.sourcePath) {
    throw workflowError(
      'COPY_LAYOUT_BINDING_STALE',
      'Call get_document_info immediately before delegation and pass its exact current binding',
    );
  }
  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    ownerThreadId: activeSession.threadId,
    agent: activeSession.agent,
    model: activeSession.model,
    effort: activeSession.effort,
    binding: structuredClone(binding),
    status: 'running',
    phase: 'binding-source',
    activity: '정확한 원본 문서를 고정하는 중',
    capabilityEpoch: activeSession.planning.capabilityEpoch,
    workerRole: `copy-layout-worker:${jobId}:${crypto.randomBytes(18).toString('base64url')}`,
    backend: null,
    usage: { toolUses: 0 },
    completionQueued: false,
    registeredTemplateId: null,
    providerHomes: null,
    snapshot: null,
    snapshotPending: false,
    snapshotPromise: null,
    helperPending: 0,
    helperPromise: null,
    inspection: null,
    generatedCandidates: new Map(),
    publishedArtifacts: new Map(),
    publishPending: false,
    completionPromise: null,
    generatedRoot: null,
    snapshotRoot: null,
  };
  record.templateJobs.set(jobId, job);
  record.activeTemplateJobId = jobId;
  sendTemplateJobEvent(record, {
    type: 'task-start', agent: job.agent, taskId: job.jobId,
    title: '레이아웃 템플릿 자동 완성',
    taskKind: 'agent', background: true,
  });
  sendTemplateJobEvent(record, taskProgressForJob(job, job.activity));
  void launchTemplateJob(record, job).catch((error) => {
    flushProviderCredentialHomes(job.providerHomes);
    settleTemplateJobFailure(record, job, error);
  });
  return job;
}

function makeBackendEventHandler(record, generation) {
  return (evt) => {
    const activeSession = record.agentSession;
    if (!activeSession || activeSession.generation !== generation) return;
    // The fallback question tool is a first-class blocking interaction. Keep
    // its provider bookkeeping out of the generic tool activity transcript;
    // the dedicated requested/resolved lifecycle is the only Studio surface.
    if (evt.type === 'tool-call' && isAskUserQuestionTool(evt.tool)) {
      if (evt.callId) record.suppressedUserQuestionCallIds.add(evt.callId);
      let questions = null;
      try {
        const args = userQuestionArgsFromToolInput(JSON.parse(evt.argsJson ?? '{}'));
        questions = normalizeMcpUserQuestionRequest(args, 'scope-ticket').questions;
      } catch {
        // The MCP boundary will return the detailed schema error. Keep this
        // ticket unusable so malformed or uncorrelated callers fail closed.
      }
      const duplicateScope = record.pendingUserQuestionScopes.findIndex((scope) => (
        scope.agent === evt.agent && scope.callId === evt.callId
      ));
      if (duplicateScope >= 0) record.pendingUserQuestionScopes.splice(duplicateScope, 1);
      record.pendingUserQuestionScopes.push({
        agent: evt.agent,
        callId: evt.callId,
        parentTaskId: evt.parentTaskId ?? null,
        questions,
      });
      if (record.pendingUserQuestionScopes.length > 8) {
        record.pendingUserQuestionScopes.splice(0, record.pendingUserQuestionScopes.length - 8);
      }
      return;
    }
    if (evt.type === 'tool-result' && record.suppressedUserQuestionCallIds.has(evt.callId)) {
      record.suppressedUserQuestionCallIds.delete(evt.callId);
      const scopeIndex = record.pendingUserQuestionScopes.findIndex((scope) => scope.callId === evt.callId);
      if (scopeIndex >= 0) record.pendingUserQuestionScopes.splice(scopeIndex, 1);
      return;
    }
    if (evt.type === 'session-info' && evt.sessionId) activeSession.sessionId = evt.sessionId;
    if (evt.type === 'usage') {
      usageStore.record({
        agent: activeSession.agent, model: evt.model, costUsd: evt.costUsd, ...(evt.usage ?? {}),
      });
      sendJson(record.studioSocket, { v: 1, type: 'usage-report', usage: usageSnapshot() });
      return;
    }
    if (evt.type === 'error' && activeSession.agent === 'rau' && isOpenRouterCreditError(evt.message)) {
      rauCreditsBalance = {
        balanceUsd: 0,
        totalCreditsUsd: Number(rauCreditsBalance?.totalCreditsUsd) || 5,
        totalUsageUsd: Number(rauCreditsBalance?.totalUsageUsd) || 5,
        checkedAt: Date.now(),
        error: null,
      };
      sendJson(record.studioSocket, { v: 1, type: 'usage-report', usage: usageSnapshot() });
    }
    if (evt.type === 'turn-start') record.missedTurnEnd = null;
    if (evt.type === 'turn-end') settleAgentTurn(record, activeSession, evt);
    const delivered = sendJson(record.studioSocket, { v: 1, type: 'agent-event', event: evt });
    if (evt.type === 'turn-end' && !delivered) record.missedTurnEnd = evt;
    if (evt.type === 'turn-end') {
      record.userQuestionResponseReceipts.clear();
      record.suppressedUserQuestionCallIds.clear();
      record.pendingUserQuestionScopes.length = 0;
    }
    if (evt.type === 'turn-end') drainTemplateCompletion(record);
    if (evt.type === 'turn-end') drainPlanningDocumentSaved(record);
  };
}

function disposeSession(record) {
  record.pendingReferenceMessage = null;
  record.pendingDocumentSaved = null;
  const activeSession = record.agentSession;
  if (!activeSession) return Promise.resolve(record.processCleanupUncertain !== true);
  const wasRunning = activeSession.status === 'running';
  const agent = activeSession.agent;
  settleUserQuestion(record, { status: 'expired', reason: 'request-invalidated' });
  record.userQuestionResponseReceipts.clear();
  record.suppressedUserQuestionCallIds.clear();
  record.pendingUserQuestionScopes.length = 0;
  activeSession.turnId = null;
  const replacedProviderSockets = [...record.mcpSockets].filter(
    (sock) => sock.agentGeneration === activeSession.generation,
  );
  queueMicrotask(() => {
    for (const sock of replacedProviderSockets) {
      try { sock.close(4001, 'provider session replaced'); } catch {}
    }
  });
  let backendExit = Promise.resolve(true);
  try {
    backendExit = Promise.resolve(activeSession.backend.dispose());
  } catch (e) {
    log(`session dispose error: ${e?.message ?? e}`);
    backendExit = Promise.resolve(false);
  }
  try { activeSession.releaseReferenceScopes?.(); } catch {}
  record.agentSession = null;
  let browserbaseExit;
  try {
    browserbaseExit = Promise.resolve(record.browserbaseSession.cleanup('session disposed'));
  } catch (error) {
    log(`Browserbase session cleanup failed: ${error?.message ?? error}`);
    browserbaseExit = Promise.resolve(false);
  }
  if (wasRunning) {
    const evt = { type: 'turn-end', agent, stopReason: 'interrupted' };
    if (!sendJson(record.studioSocket, { v: 1, type: 'agent-event', event: evt })) {
      record.missedTurnEnd = evt;
    }
  }
  return Promise.allSettled([backendExit, browserbaseExit]).then(([backend, browserbase]) => {
    const backendCleaned = backend.status === 'fulfilled' && backend.value !== false;
    const browserbaseCleaned = browserbase.status === 'fulfilled' && browserbase.value !== false;
    if (backend.status === 'rejected') {
      log(`session process exit wait failed: ${backend.reason?.message ?? backend.reason}`);
    }
    if (browserbase.status === 'rejected') {
      log(`Browserbase session exit wait failed: ${browserbase.reason?.message ?? browserbase.reason}`);
    }
    if (backendCleaned && browserbaseCleaned && record.processCleanupUncertain !== true) return true;
    record.processCleanupUncertain = true;
    if (!backendCleaned) retainedUncertainBackends.add(activeSession.backend);
    if (!browserbaseCleaned) retainedUncertainBrowserbaseSessions.add(record.browserbaseSession);
    retainUncertainProcessCleanup(record.recordRoot);
    return false;
  });
}

function agentProcessCleanupUncertain(cause = null) {
  const error = new Error(
    'The previous provider process tree could not be confirmed stopped. Restart the app before starting another provider.',
    cause ? { cause } : undefined,
  );
  error.code = 'AGENT_PROCESS_CLEANUP_UNCERTAIN';
  error.processCleanupUncertain = true;
  return error;
}

function resolvePermissionProfile(value) {
  return value === 'unrestricted' ? 'unrestricted' : 'safe';
}

function resolveWorkflow(value) {
  if (value === undefined || value === null) return 'direct';
  if (value === 'direct' || value === 'plan' || value === 'question') return value;
  throw workflowError('INVALID_WORKFLOW', `Unknown workflow: ${String(value)}`);
}

const CHAT_HISTORY_MAX_MESSAGES = 40;
const CHAT_HISTORY_MAX_ENTRY_CHARS = 8_000;
const CHAT_HISTORY_MAX_TOTAL_CHARS = 32_000;

function normalizeChatHistory(value) {
  if (!Array.isArray(value)) return [];
  const history = [];
  let remaining = CHAT_HISTORY_MAX_TOTAL_CHARS;
  for (const entry of value.slice(-CHAT_HISTORY_MAX_MESSAGES).reverse()) {
    if (!entry || (entry.role !== 'user' && entry.role !== 'assistant')) continue;
    const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, CHAT_HISTORY_MAX_ENTRY_CHARS) : '';
    if (!text || remaining <= 0) continue;
    const bounded = text.slice(-remaining);
    history.unshift({ role: entry.role, text: bounded });
    remaining -= bounded.length;
  }
  return history;
}

function addReopenedChatHistory(activeSession, prompt) {
  const history = activeSession.bootstrapHistory;
  activeSession.bootstrapHistory = [];
  if (!Array.isArray(history) || history.length === 0) return prompt;
  const block = [
    '<reopened_chat_history trust="conversation-transcript">',
    JSON.stringify(history),
    'Continue this conversation consistently. The final user request follows after this transcript.',
    '</reopened_chat_history>',
  ].join('\n');
  return `${block}\n\n${prompt}`;
}

function referenceScopes(activeSession) {
  return referenceScopesForSession(activeSession);
}

function addReferenceContext(activeSession, query, prompt, messageAttachments = []) {
  try {
    const block = referenceStore.promptContext({ query, scopes: referenceScopes(activeSession) });
    const attached = messageAttachments.length > 0
      ? `<message_attachments trust="untrusted-data">\n${JSON.stringify(messageAttachments.map(({ id, name, mimeType, kind }) => ({ fileId: id, name, mimeType, kind })))}\n</message_attachments>`
      : '';
    return [block, attached, prompt].filter(Boolean).join('\n\n');
  } catch (error) {
    log(`reference retrieval failed: ${error?.message ?? error}`);
    return prompt;
  }
}

function addAgentInstructionsContext(prompt) {
  return `${agentInstructionsStore.promptBlock()}\n\n${prompt}`;
}

function addTemplateContext(record, activeSession, prompt) {
  if (!activeSession?.activeTemplateId) return prompt;
  try {
    const template = templateStore.get(activeSession.activeTemplateId);
    const block = [
      '<active_document_template trust="untrusted-reference">',
      JSON.stringify(template),
      'Treat the open document as the editable draft and this template as read-only context.',
      'Inspect both documents and map the whole open document before writing. If meaningful source content has no clear template destination, ask the user before editing.',
      'Use template inspection and transfer tools for structural fidelity. Preserve the open document format. Report any transfer warnings or skipped features.',
      '</active_document_template>',
    ].join('\n');
    return [block, prompt].filter(Boolean).join('\n\n');
  } catch (error) {
    activeSession.activeTemplateId = null;
    if (record.agentSession === activeSession) {
      sendJson(record.studioSocket, { v: 1, type: 'chat-template-changed', template: null, reason: 'unavailable' });
    }
    log(`active template unavailable: ${error?.message ?? error}`);
    return prompt;
  }
}

function dispatchUserMessage(record, sock, msg, activeSession, messageAttachments = []) {
  if (activeSession.planning.phase === 'awaiting-approval') {
    const planId = activeSession.planning.latestPlan?.planId;
    if (!planId) {
      sendJson(sock, { v: 1, type: 'chat-error', code: 'PLAN_NOT_FOUND', message: 'The latest plan is unavailable; return to planning and present it again.' });
      return;
    }
    const hasAttachments = messageAttachments.length > 0
      || (Array.isArray(msg.stagedReferenceIds) && msg.stagedReferenceIds.length > 0);
    if (!hasAttachments && isExplicitImplementationApproval(msg.text)) {
      void enqueueWorkflowTransition(record, activeSession, () => approveImplementationPlan(record, sock, { planId }))
        .catch((error) => sendChatError(sock, error));
      return;
    }
    void enqueueWorkflowTransition(
      record,
      activeSession,
      () => requestImplementationPlanChanges(record, sock, { planId, feedback: msg.text }),
    )
      .catch((error) => sendChatError(sock, error));
    return;
  }
  if (activeSession.planning.phase === 'switching') {
    sendJson(sock, { v: 1, type: 'chat-error', code: 'WORKFLOW_SWITCHING', message: 'The provider is switching into implementation mode.' });
    return;
  }
  beginAgentTurn(record, activeSession);
  void skillRegistry.promptContext(msg.text, typeof msg.skillName === 'string' ? msg.skillName : undefined, {
    phase: activeSession.planning.snapshot().phase,
    agent: activeSession.agent,
  })
    .then((prompt) => {
      if (record.agentSession !== activeSession) throw new Error('Agent session changed before the message was dispatched');
      activeSession.backend.sendUserMessage(addAgentInstructionsContext(addReopenedChatHistory(
        activeSession,
        addActiveDocumentContext(
          activeSession,
          addTemplateContext(
            record,
            activeSession,
            addReferenceContext(activeSession, msg.text, prompt, messageAttachments),
          ),
        ),
      )));
    })
    .catch((e) => {
      if (record.agentSession === activeSession) {
        activeSession.status = 'idle';
        activeSession.turnId = null;
        record.userQuestionResponseReceipts.clear();
      }
      sendJson(sock, { v: 1, type: 'chat-error', code: e?.code ?? 'AGENT_SPAWN_FAILED', message: String(e?.message ?? e) });
    });
}

async function dispatchStagedUserMessage(record, sock, msg, activeSession) {
  const rawIds = Array.isArray(msg.stagedReferenceIds) ? msg.stagedReferenceIds : [];
  const stageIds = [...new Set(rawIds.filter((id) => typeof id === 'string' && id))];
  if (stageIds.length === 0 || stageIds.length !== rawIds.length || stageIds.length > 10) {
    throw Object.assign(new Error('Message attachments require 1-10 unique staged reference ids'), { code: 'INVALID_REFERENCE_MESSAGE' });
  }
  record.pendingReferenceMessage = { messageId: msg.messageId, message: msg, owner: activeSession };
  sendJson(sock, {
    v: 1,
    type: 'chat-reference-status',
    messageId: msg.messageId,
    attachments: stageIds.map((stageId) => ({ stageId, status: 'processing' })),
  });
  const settled = await Promise.allSettled(
    stageIds.map(async (stageId) => ({ stageId, file: await referenceStore.promoteStaged({ stageId, scopeId: activeSession.threadId }) })),
  );
  const attachments = settled.map((entry, index) => entry.status === 'fulfilled'
    ? { stageId: entry.value.stageId, status: 'ready', file: entry.value.file }
    : {
      stageId: stageIds[index],
      status: 'error',
      error: String(entry.reason?.message ?? entry.reason ?? 'Attachment processing failed'),
    });
  sendJson(sock, { v: 1, type: 'chat-reference-status', messageId: msg.messageId, attachments });
  if (record.pendingReferenceMessage?.messageId === msg.messageId) record.pendingReferenceMessage = null;
  const readyFiles = settled.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value.file] : []);
  if (record.agentSession === activeSession) dispatchUserMessage(record, sock, msg, activeSession, readyFiles);
}

function emitWorkflowState(record, extra = {}) {
  const activeSession = record.agentSession;
  if (!activeSession) return;
  sendJson(record.studioSocket, { v: 1, type: 'workflow-changed', ...activeSession.planning.snapshot(), ...extra });
}

async function startSession(
  record,
  agent,
  requestedModel,
  requestedEffort,
  requestedPermission,
  requestedWorkflow,
  requestedThreadId,
  requestedDocumentId,
  requestedDocumentName,
  requestedHistory,
  force = false,
  requestedServiceTier,
) {
  if (record.processCleanupUncertain === true) throw agentProcessCleanupUncertain();
  const model = resolveModel(agent, requestedModel);
  const effort = resolveEffort(agent, model, requestedEffort);
  const permissionProfile = resolvePermissionProfile(requestedPermission);
  const serviceTier = resolveServiceTier(agent, requestedServiceTier);
  const workflow = resolveWorkflow(requestedWorkflow);
  const { threadId, documentId, documentName } = resolveSessionIdentity({
    threadId: requestedThreadId,
    documentId: requestedDocumentId,
    documentName: requestedDocumentName,
    existing: record.agentSession,
    force,
  });
  const currentSession = record.agentSession;
  if (
    !force
    && currentSession
    && currentSession.agent === agent
    && currentSession.model === model
    && currentSession.effort === effort
    && currentSession.permissionProfile === permissionProfile
    && currentSession.serviceTier === serviceTier
    && currentSession.planning.workflow === workflow
    && currentSession.threadId === threadId
    && currentSession.documentId === documentId
  ) {
    currentSession.documentName = documentName;
    return currentSession;
  }
  if (!await disposeSession(record)) throw agentProcessCleanupUncertain();
  const sessionReferenceScopes = referenceScopesForSession({ threadId, documentId });
  await referenceStore.activateScopes(sessionReferenceScopes);
  const planning = new PlanningState({
    workflow,
    initialCapabilityEpoch: record.nextCapabilityEpoch++,
    allocateEpoch: () => record.nextCapabilityEpoch++,
  });
  const generation = ++record.sessionGeneration;
  const providerRole = 'chat';
  const providerCapabilityResource = mcpProviderResource({
    agent,
    role: providerRole,
    generation,
  });
  const opts = {
    rootDir: record.workDir,
    workDir: record.workDir,
    readOnlyRoots: record.hubReadOnlyRoots,
    mcpScriptPath: MCP_SCRIPT,
    hubPort,
    token: sessions.issue(TOKEN, record.sessionId, {
      audience: HUB_CAPABILITY_AUDIENCES.MCP,
      resource: providerCapabilityResource,
    }),
    sessionId: record.sessionId,
    model,
    effort,
    permissionProfile,
    serviceTier,
    isolatedHome: record.isolatedHome,
    codexHome: record.codexHome,
    codexAuthPath: sourceCodexAuthPath,
    grokHome: record.grokHome,
    grokAuthPath: sourceGrokAuthPath,
    cursorSourceDir: cliSetup.cursorSourceDir,
    codexBin: cliSetupStatus.codex?.installed ? cliSetup.binPath('codex') : 'codex',
    claudeBin: cliSetupStatus.claude?.installed ? cliSetup.binPath('claude') : 'claude',
    grokBin: cliSetupStatus.grok?.installed ? cliSetup.binPath('grok') : 'grok',
    cursorBin: cliSetupStatus.cursor?.installed ? cliSetup.binPath('cursor') : 'cursor-agent',
    providerEnv: agent === 'claude'
      ? claudeRuntimeEnv(record.isolatedHome)
      : (CLI_SETUP_AGENTS.includes(agent) ? cliSetup.envFor(agent) : {}),
    onEvent: makeBackendEventHandler(record, generation),
    requestUserInput: (request, signal) => requestUserQuestion(record, request, {
      source: 'native',
      generation,
      signal,
    }),
    agentRole: providerRole,
    workflow,
    phase: workflow === 'direct' ? 'implementing' : planning.phase,
    capabilityEpoch: planning.capabilityEpoch,
    toolProfile: planning.mcpEnvironment().RHWP_TOOL_PROFILE,
    mcpEnvironment: planning.mcpEnvironment(),
    // pi · rau 전용 — 설치 경로와 영속 루트, 그리고 선택한 모델의 추론 지원 여부.
    piBin: (agent === 'rau' ? rauManager : piManager).piBin,
    piRoot: agent === 'rau' ? rauManager.rootDir : piManager.rootDir,
    openRouterApiKey: openRouterManager(agent)?.apiKey() ?? undefined,
    agentName: OPENROUTER_AGENTS.has(agent) ? agent : 'pi',
    reasoning: OPENROUTER_AGENTS.has(agent) ? Boolean(piModelConfig(model, agent)?.reasoning) : false,
  };
  const createBackend = SESSION_FACTORIES[agent];
  if (!createBackend) throw unknownAgentError(agent);
  const backend = createBackend(opts);
  record.agentSession = {
    agent,
    model,
    effort,
    permissionProfile,
    serviceTier,
    backend,
    generation,
    providerRole,
    providerCapabilityResource,
    status: 'idle',
    turnId: null,
    sessionId: backend.getSessionId(),
    threadId,
    documentId,
    documentName,
    // Legacy download/browser code uses chatId. It is now the stable Studio
    // thread identity rather than an unrelated hub-generated UUID.
    chatId: threadId,
    activeTemplateId: null,
    lastDocumentInfo: null,
    bootstrapHistory: normalizeChatHistory(requestedHistory),
    planning,
    workflowTransition: Promise.resolve(),
    pendingTransitions: 0,
    releaseReferenceScopes: referenceStore.retainScopes(sessionReferenceScopes),
  };
  if (workflow === 'plan') {
    requireWorkflowSwitchBackend(record.agentSession);
    await record.agentSession.backend.setExecutionMode(providerModeRequest(record.agentSession, 'planning'));
  }
  queueMicrotask(() => drainTemplateCompletion(record));
  queueMicrotask(() => drainPlanningDocumentSaved(record));
  return record.agentSession;
}

function sendChatError(sock, error, fallbackCode = 'WORKFLOW_ERROR') {
  sendJson(sock, {
    v: 1,
    type: 'chat-error',
    code: error?.code ?? fallbackCode,
    message: String(error?.message ?? error),
  });
}

/** pi 요청 실패는 채팅 오류가 아니라 설정 카드에 붙는다. 키는 절대 되돌려 보내지 않는다. */
function sendPiError(record, sock, requestId, error, fallbackCode) {
  replyToStudio(record, sock, {
    v: 1,
    type: 'pi-error',
    requestId,
    code: error?.code ?? fallbackCode,
    message: String(error?.message ?? error),
  });
}

function providerModeRequest(activeSession, phase) {
  return {
    workflow: 'plan',
    phase,
    capabilityEpoch: activeSession.planning.capabilityEpoch,
  };
}

function requireWorkflowSwitchBackend(activeSession) {
  if (typeof activeSession.backend.setExecutionMode !== 'function') {
    throw workflowError(
      'BACKEND_WORKFLOW_UNSUPPORTED',
      'This provider backend does not yet implement setExecutionMode(); update the provider integration before approving or revising plans.',
    );
  }
}

function enqueueWorkflowTransition(record, transitionOwner, transitionFn) {
  transitionOwner.pendingTransitions += 1;
  const transition = transitionOwner.workflowTransition.then(() => {
    if (record.agentSession !== transitionOwner) return undefined;
    return transitionFn();
  });
  const trackedTransition = transition.finally(() => {
    transitionOwner.pendingTransitions = Math.max(0, transitionOwner.pendingTransitions - 1);
  });
  transitionOwner.workflowTransition = trackedTransition.catch(() => undefined);
  return trackedTransition;
}

async function setChatPermission(record, sock, msg) {
  const activeSession = record.agentSession;
  if (!activeSession) throw workflowError('AGENT_NOT_STARTED', 'Start a chat before changing permissions.');
  if (activeSession.status === 'running') {
    throw workflowError('AGENT_BUSY', 'Permissions can only change between turns.');
  }
  const profile = resolvePermissionProfile(msg.permissionProfile);
  await Promise.resolve(activeSession.backend.setPermissionProfile(profile));
  if (record.agentSession !== activeSession) return;
  activeSession.permissionProfile = profile;
  sendJson(sock, { v: 1, type: 'chat-permission-changed', permissionProfile: profile });
}

async function approveImplementationPlan(record, sock, msg) {
  const activeSession = record.agentSession;
  if (!activeSession) throw workflowError('AGENT_NOT_STARTED', 'Start a chat before approving a plan');
  requireWorkflowSwitchBackend(activeSession);
  const transition = activeSession.planning.beginApproval({
    planId: String(msg.planId ?? ''),
    sessionStatus: activeSession.status,
  });
  sendJson(sock, { v: 1, type: 'plan-approved', ...activeSession.planning.snapshot() });
  try {
    await activeSession.backend.setExecutionMode(providerModeRequest(activeSession, 'implementing'));
    if (record.agentSession !== activeSession || activeSession.planning.phase !== 'switching') return;
    activeSession.planning.completeSwitch(transition.approvedPlan.planId);
    sendJson(sock, {
      v: 1,
      type: 'implementation-started',
      planId: transition.approvedPlan.planId,
      ...activeSession.planning.snapshot(),
    });
    beginAgentTurn(record, activeSession);
    const approvedPrompt = buildApprovedPlanPrompt(transition.approvedPlan);
    activeSession.backend.sendUserMessage(addAgentInstructionsContext(addTemplateContext(
      record,
      activeSession,
      addReferenceContext(
        activeSession,
        JSON.stringify(transition.approvedPlan.plan),
        approvedPrompt,
      ),
    )));
  } catch (error) {
    if (record.agentSession === activeSession && activeSession.planning.phase === 'switching') {
      activeSession.planning.failSwitch(transition.approvedPlan.planId);
      activeSession.status = 'idle';
      activeSession.turnId = null;
      record.userQuestionResponseReceipts.clear();
      emitWorkflowState(record, { reason: 'provider-switch-failed' });
    }
    sendChatError(sock, error, 'BACKEND_SWITCH_FAILED');
  }
}

async function requestImplementationPlanChanges(record, sock, msg) {
  const activeSession = record.agentSession;
  if (!activeSession) throw workflowError('AGENT_NOT_STARTED', 'Start a chat before requesting plan changes');
  requireWorkflowSwitchBackend(activeSession);
  const planId = String(msg.planId ?? '');
  activeSession.planning.requestChanges({
    planId,
    sessionStatus: msg.sessionStatusOverride ?? activeSession.status,
  });
  try {
    await activeSession.backend.setExecutionMode(providerModeRequest(activeSession, 'planning'));
    if (record.agentSession !== activeSession) return;
    sendJson(sock, {
      v: 1,
      type: 'plan-invalidated',
      planId,
      reason: typeof msg.reason === 'string' && msg.reason
        ? msg.reason
        : (typeof msg.feedback === 'string' ? msg.feedback : 'changes-requested'),
      ...activeSession.planning.snapshot(),
      latestPlan: null,
    });
    const promptOverride = typeof msg.promptOverride === 'string' ? msg.promptOverride.trim() : '';
    if (promptOverride) {
      activeSession.status = 'running';
      activeSession.backend.sendUserMessage(addAgentInstructionsContext(addTemplateContext(
        record,
        activeSession,
        addReferenceContext(activeSession, promptOverride, promptOverride),
      )));
      return;
    }
    if (typeof msg.feedback === 'string' && msg.feedback.trim()) {
      beginAgentTurn(record, activeSession);
      const revisionPrompt = [
        'The user requested changes, so the previous implementation plan is no longer authoritative.',
        'Return to discovery: inspect the affected current state and evaluate the feedback. If it is ambiguous or changes an assumption, discuss it with the user and ask one focused question in normal chat instead of immediately presenting a replacement. If it is already concrete, do not invent a question; follow the planning checkpoint and presentation rules before presenting a complete replacement.',
        `Feedback: ${msg.feedback.trim()}`,
      ].join('\n\n');
      activeSession.backend.sendUserMessage(addAgentInstructionsContext(addTemplateContext(
        record,
        activeSession,
        addReferenceContext(activeSession, msg.feedback, revisionPrompt),
      )));
    }
  } catch (error) {
    if (record.agentSession === activeSession) {
      activeSession.planning.failRequestChanges(planId);
      activeSession.status = 'idle';
      activeSession.turnId = null;
      record.userQuestionResponseReceipts.clear();
      emitWorkflowState(record, { reason: 'provider-switch-failed' });
    }
    sendChatError(sock, error, 'BACKEND_SWITCH_FAILED');
  }
}

async function setChatWorkflow(record, sock, msg) {
  if (msg.workflow !== 'direct' && msg.workflow !== 'plan' && msg.workflow !== 'question') {
    throw workflowError('INVALID_WORKFLOW', `Unknown workflow: ${String(msg.workflow)}`);
  }
  const activeSession = record.agentSession;
  if (!activeSession) {
    sendJson(sock, {
      v: 1,
      type: 'workflow-changed',
      workflow: msg.workflow,
      phase: msg.workflow === 'plan' ? 'planning' : msg.workflow === 'question' ? 'questioning' : 'direct',
      capabilityEpoch: null,
      latestPlan: null,
    });
    return;
  }
  if (activeSession.status !== 'idle') throw workflowError('AGENT_BUSY', 'Workflow can only change while the agent is idle');
  const restartCompletedPlan = msg.workflow === 'plan'
    && activeSession.planning.workflow === 'plan'
    && activeSession.planning.phase === 'implementing';
  if (activeSession.planning.workflow === msg.workflow && !restartCompletedPlan) {
    emitWorkflowState(record);
    return;
  }
  requireWorkflowSwitchBackend(activeSession);
  const previousPlanId = activeSession.planning.latestPlan?.planId ?? null;
  const previousPlanning = activeSession.planning;
  const nextPlanning = new PlanningState({
    workflow: msg.workflow,
    initialCapabilityEpoch: record.nextCapabilityEpoch++,
    allocateEpoch: () => record.nextCapabilityEpoch++,
  });
  const phase = msg.workflow === 'plan'
    ? 'planning'
    : msg.workflow === 'question'
      ? 'questioning'
      : 'implementing';
  // Codex setExecutionMode 는 자식 재시작을 기다리므로, 스냅샷·도구 게이트는
  // 재시작 전에 구상으로 바꿔 둔다. 실패하면 이전 상태로 되돌린다.
  activeSession.planning = nextPlanning;
  try {
    await activeSession.backend.setExecutionMode({
      workflow: msg.workflow,
      phase,
      capabilityEpoch: nextPlanning.capabilityEpoch,
    });
  } catch (error) {
    if (record.agentSession === activeSession) activeSession.planning = previousPlanning;
    throw error;
  }
  if (record.agentSession !== activeSession) return;
  if (msg.workflow === 'direct') {
    const browserbaseCleaned = await record.browserbaseSession.cleanup('workflow changed to direct')
      .catch(() => false);
    if (!browserbaseCleaned) {
      record.processCleanupUncertain = true;
      retainedUncertainBrowserbaseSessions.add(record.browserbaseSession);
      retainUncertainProcessCleanup(record.recordRoot);
      // The workflow switch itself already succeeded. Report the cleanup
      // failure separately while still publishing the authoritative new mode.
      sendChatError(sock, agentProcessCleanupUncertain(), 'AGENT_PROCESS_CLEANUP_UNCERTAIN');
    }
  }
  if (previousPlanId) {
    sendJson(sock, {
      v: 1,
      type: 'plan-invalidated',
      planId: previousPlanId,
      reason: 'workflow-changed',
      ...nextPlanning.snapshot(),
    });
  }
  emitWorkflowState(record);
}

async function handleStudioMessage(record, sock, msg) {
  switch (msg.type) {
    case 'chat-start': {
      if (record.agentSession?.workflowTransition) {
        await record.agentSession.workflowTransition;
      }
      const agent = msg.agent;
      if (!KNOWN_AGENTS.has(agent)) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REQUEST', message: `unknown agent: ${String(agent)}` });
        return;
      }
      // 설정이 끝나지 않은 pi/rau 로는 세션을 열지 않는다 — 살아 있는 세션도 건드리지 않는다.
      if (agent === 'pi' && !piStatus.setupComplete) {
        sendJson(sock, {
          v: 1, type: 'chat-error', code: 'PI_NOT_CONFIGURED',
          message: 'Pi 설정을 먼저 끝내 주세요 (설치 · OpenRouter 키 · 모델 선택).',
        });
        return;
      }
      if (agent === 'rau' && !rauStatus.setupComplete) {
        sendJson(sock, {
          v: 1, type: 'chat-error', code: 'RAU_NOT_CONFIGURED',
          message: 'Rau 연결을 먼저 끝내 주세요.',
        });
        return;
      }
      if (agent === 'rau' && rauTrialEmpty()) {
        sendJson(sock, {
          v: 1, type: 'chat-error', code: 'RAU_CREDITS_EMPTY',
          message: 'Rau 체험 크레딧이 다 됐어요. 다른 모델을 연결해 주세요.',
        });
        return;
      }
      try {
        const s = await startSession(
          record,
          agent,
          msg.model,
          msg.effort,
          msg.permissionProfile,
          msg.workflow,
          msg.threadId,
          msg.documentId,
          msg.documentName,
          msg.history,
          Boolean(msg.force),
          msg.serviceTier,
        );
        sendJson(sock, {
          v: 1,
          type: 'chat-started',
          agent: s.agent,
          model: s.model,
          effort: s.effort,
          permissionProfile: s.permissionProfile,
          serviceTier: s.serviceTier,
          sessionId: s.sessionId,
          threadId: s.threadId,
          documentId: s.documentId,
          documentName: s.documentName,
          ...s.planning.snapshot(),
        });
      } catch (e) {
        const cleaned = await disposeSession(record);
        const reported = cleaned ? e : agentProcessCleanupUncertain(e);
        sendJson(sock, {
          v: 1,
          type: 'chat-error',
          code: reported?.code ?? 'AGENT_SPAWN_FAILED',
          message: String(reported?.message ?? reported),
        });
      }
      return;
    }
    case 'title-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : null;
      if (!requestId || !threadId) {
        sendJson(sock, {
          v: 1, type: 'chat-error', code: 'INVALID_REQUEST',
          message: 'title-request requires requestId and threadId',
        });
        return;
      }
      const preview = typeof msg.preview === 'string' ? msg.preview : '';
      generateChatTitle(preview, auxDeps(record, msg.agent, 'codex'))
        .then((title) => {
          sendJson(sock, {
            v: 1,
            type: 'title-result',
            requestId,
            threadId,
            title: title ?? null,
          });
        })
        .catch((e) => {
          log(`title-request failed: ${e?.message ?? e}`);
          sendJson(sock, {
            v: 1,
            type: 'title-result',
            requestId,
            threadId,
            title: null,
          });
        });
      return;
    }
    case 'checkpoint-title-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      if (!requestId) return;
      const startedAt = Date.now();
      const controller = new AbortController();
      record.checkpointTitleControllers.add(controller);
      const input = {
        commitId: msg.commitId,
        titleRevision: msg.titleRevision,
        appLanguage: msg.appLanguage,
        summary: msg.summary,
      };
      const cachedHealth = providerHealth.cached();
      void (cachedHealth ? Promise.resolve(cachedHealth) : providerHealth.check())
        .then((health) => {
          const remainingMs = Math.max(
            1,
            CHECKPOINT_TITLE_OVERALL_TIMEOUT_MS - (Date.now() - startedAt),
          );
          return generateCheckpointTitle(input, {
            ...checkpointTitleDeps(record, health, controller.signal),
            overallTimeoutMs: remainingMs,
          });
        })
        .then((result) => replyToStudio(record, sock, {
          v: 1,
          type: 'checkpoint-title-result',
          requestId,
          result,
        }))
        .catch((error) => {
          log(`checkpoint-title-request failed: ${error?.message ?? error}`);
          replyToStudio(record, sock, {
            v: 1,
            type: 'checkpoint-title-result',
            requestId,
            result: null,
          });
        })
        .finally(() => record.checkpointTitleControllers.delete(controller));
      return;
    }
    case 'chat-user-message': {
      if (!record.agentSession) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'No agent session; send chat-start first.' });
        return;
      }
      if (record.agentSession.pendingTransitions > 0) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'WORKFLOW_SWITCHING', message: 'The provider is applying a workflow or permission change.' });
        return;
      }
      try {
        assertMessageScope(record.agentSession, msg);
      } catch (error) {
        sendChatError(sock, error, 'INVALID_REQUEST');
        return;
      }
      if (record.agentSession.status === 'running' || record.pendingReferenceMessage) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_BUSY', message: 'A turn is already in progress.' });
        return;
      }
      if (typeof msg.text !== 'string' || msg.text.length === 0) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REQUEST', message: 'chat-user-message requires text' });
        return;
      }
      if (msg.text.length > MAX_CHAT_MESSAGE_CHARS) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REQUEST', message: `chat message exceeds ${MAX_CHAT_MESSAGE_CHARS} characters` });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(msg, 'activeTemplateId')) {
        try {
          const templateId = msg.activeTemplateId == null ? null : String(msg.activeTemplateId);
          if (templateId) templateStore.get(templateId);
          record.agentSession.activeTemplateId = templateId;
        } catch (error) {
          record.agentSession.activeTemplateId = null;
          sendJson(sock, { v: 1, type: 'chat-template-changed', template: null, reason: 'unavailable' });
          log(`message template unavailable: ${error?.message ?? error}`);
        }
      }
      if (Array.isArray(msg.stagedReferenceIds) && msg.stagedReferenceIds.length > 0) {
        if (typeof msg.messageId !== 'string' || !msg.messageId) {
          sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REFERENCE_MESSAGE', message: 'Attachment messages require messageId' });
          return;
        }
        void dispatchStagedUserMessage(record, sock, msg, record.agentSession)
          .catch((error) => {
            if (record.pendingReferenceMessage?.messageId === msg.messageId) record.pendingReferenceMessage = null;
            sendChatError(sock, error, 'REFERENCE_COMMIT_FAILED');
          });
        return;
      }
      dispatchUserMessage(record, sock, msg, record.agentSession);
      return;
    }
    case 'chat-template-set': {
      const activeSession = record.agentSession;
      if (!activeSession) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'Start a chat before selecting a template.' });
        return;
      }
      if (activeSession.status === 'running') {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_BUSY', message: 'Templates can only change between turns.' });
        return;
      }
      try {
        const templateId = msg.templateId == null ? null : String(msg.templateId);
        const template = templateId ? templateStore.get(templateId) : null;
        activeSession.activeTemplateId = templateId;
        sendJson(sock, { v: 1, type: 'chat-template-changed', template });
      } catch (error) {
        sendChatError(sock, error, 'TEMPLATE_NOT_FOUND');
      }
      return;
    }
    case 'templates-list': {
      sendJson(sock, { v: 1, type: 'templates-catalog', ...templateStore.list() });
      return;
    }
    case 'agent-instructions-request': {
      sendJson(sock, {
        v: 1,
        type: 'agent-instructions',
        requestId: msg.requestId ?? null,
        status: agentInstructionsStore.snapshot(),
        changedBy: 'system',
      });
      sendInstructionDraft(record, sock);
      return;
    }
    case 'agent-instructions-save': {
      void agentInstructionsStore.update(msg.content, {
        expectedRevision: Number(msg.expectedRevision),
      }).then((status) => {
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions',
          requestId: msg.requestId ?? null,
          status,
          changedBy: 'user',
        });
        broadcastAgentInstructions(status, 'user');
      }).catch((error) => sendJson(sock, {
        v: 1,
        type: 'agent-instructions-error',
        requestId: msg.requestId ?? null,
        code: error?.code ?? 'INSTRUCTIONS_SAVE_FAILED',
        message: String(error?.message ?? error),
        status: agentInstructionsStore.snapshot(),
      }));
      return;
    }
    case 'agent-instructions-draft-confirm': {
      let draft;
      try {
        draft = consumeAuthorizedInstructionDraft(record, msg);
        // Consume the one-use capability before the asynchronous write.
      } catch (error) {
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions-error',
          requestId: msg.requestId ?? null,
          code: error?.code ?? 'INSTRUCTIONS_CONFIRMATION_INVALID',
          message: String(error?.message ?? error),
          status: agentInstructionsStore.snapshot(),
        });
        return;
      }
      void agentInstructionsStore.update(draft.content, {
        expectedRevision: draft.expectedRevision,
      }).then((status) => {
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions',
          requestId: msg.requestId ?? null,
          status,
          changedBy: `agent-confirmed:${draft.requestedBy}`,
        });
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions-draft-cleared',
          draftId: draft.id,
          outcome: 'confirmed',
        });
        broadcastAgentInstructions(status, `agent-confirmed:${draft.requestedBy}`);
      }).catch((error) => {
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions-draft-cleared',
          draftId: draft.id,
          outcome: 'stale',
        });
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions-error',
          requestId: msg.requestId ?? null,
          code: error?.code ?? 'INSTRUCTIONS_SAVE_FAILED',
          message: String(error?.message ?? error),
          status: agentInstructionsStore.snapshot(),
        });
      });
      return;
    }
    case 'agent-instructions-draft-reject': {
      let draft;
      try {
        draft = consumeAuthorizedInstructionDraft(record, msg);
      } catch (error) {
        sendJson(sock, {
          v: 1,
          type: 'agent-instructions-error',
          requestId: msg.requestId ?? null,
          code: error?.code ?? 'INSTRUCTIONS_CONFIRMATION_INVALID',
          message: String(error?.message ?? error),
          status: agentInstructionsStore.snapshot(),
        });
        return;
      }
      sendJson(sock, {
        v: 1,
        type: 'agent-instructions-draft-cleared',
        requestId: msg.requestId ?? null,
        draftId: draft.id,
        outcome: 'rejected',
      });
      return;
    }
    case 'chat-permission-set': {
      const transitionOwner = record.agentSession;
      if (!transitionOwner) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'Start a chat before changing permissions.' });
        return;
      }
      void enqueueWorkflowTransition(record, transitionOwner, () => setChatPermission(record, sock, msg))
        .catch((e) => sendJson(sock, {
          v: 1,
          type: 'chat-error',
          code: e?.code === 'AGENT_BUSY' ? 'AGENT_BUSY' : 'PERMISSION_CHANGE_FAILED',
          message: String(e?.message ?? e),
        }));
      return;
    }
    case 'chat-service-tier-set': {
      if (!record.agentSession) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'Start a chat before changing the service tier.' });
        return;
      }
      if (record.agentSession.status === 'running') {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_BUSY', message: 'Service tier can only change between turns.' });
        return;
      }
      const tier = resolveServiceTier(record.agentSession.agent, msg.serviceTier);
      try {
        record.agentSession.backend.setServiceTier?.(tier);
        record.agentSession.serviceTier = tier;
        sendJson(sock, { v: 1, type: 'chat-service-tier-changed', serviceTier: tier });
      } catch (e) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'SERVICE_TIER_CHANGE_FAILED', message: String(e?.message ?? e) });
      }
      return;
    }
    case 'chat-workflow-set': {
      const transitionOwner = record.agentSession;
      if (!transitionOwner) {
        try {
          await setChatWorkflow(record, sock, msg);
        } catch (error) {
          sendChatError(sock, error);
        }
        return;
      }
      const transition = enqueueWorkflowTransition(record, transitionOwner, () => setChatWorkflow(record, sock, msg));
      // studioMessageQueue 가 이 전환을 기다리지 않으면 Codex 재시작 중에
      // chat-user-message 가 바로 실행 모드 턴으로 들어가 문서를 잠근다.
      try {
        await transition;
      } catch (error) {
        sendChatError(sock, error);
      }
      return;
    }
    case 'chat-plan-approve':
    case 'implementation-plan-approve':
    case 'plan-approve': {
      const transitionOwner = record.agentSession;
      if (!transitionOwner) {
        void approveImplementationPlan(record, sock, msg).catch((error) => sendChatError(sock, error));
        return;
      }
      void enqueueWorkflowTransition(record, transitionOwner, () => approveImplementationPlan(record, sock, msg))
        .catch((error) => sendChatError(sock, error));
      return;
    }
    case 'chat-plan-request-changes':
    case 'implementation-plan-request-changes':
    case 'plan-request-changes': {
      const transitionOwner = record.agentSession;
      if (!transitionOwner) {
        void requestImplementationPlanChanges(record, sock, msg).catch((error) => sendChatError(sock, error));
        return;
      }
      void enqueueWorkflowTransition(record, transitionOwner, () => requestImplementationPlanChanges(record, sock, msg))
        .catch((error) => sendChatError(sock, error));
      return;
    }
    case 'chat-document-saved': {
      queuePlanningDocumentSaved(record, msg);
      return;
    }
    case 'skills-list': {
      void skillRegistry.list()
        .then((catalog) => sendJson(sock, { v: 1, type: 'skills-catalog', requestId: msg.requestId ?? null, ...catalog }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'skill-read': {
      void skillRegistry.read(String(msg.name ?? ''))
        .then((result) => sendJson(sock, { v: 1, type: 'skill-detail', requestId: msg.requestId ?? null, ...result }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'skill-save': {
      void skillRegistry.save(msg.skill)
        .then(async (result) => {
          sendJson(sock, { v: 1, type: 'skill-saved', requestId: msg.requestId ?? null, ...result });
          sendJson(sock, { v: 1, type: 'skills-catalog', ...(await skillRegistry.list()) });
        })
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'skill-validate': {
      void skillRegistry.validate(msg.skill)
        .then((result) => sendJson(sock, { v: 1, type: 'skill-validated', requestId: msg.requestId ?? null, result }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'skill-enable': {
      void skillRegistry.setEnabled(String(msg.name ?? ''), Boolean(msg.enabled))
        .then((catalog) => sendJson(sock, { v: 1, type: 'skills-catalog', requestId: msg.requestId ?? null, ...catalog }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'skill-delete': {
      void skillRegistry.delete(String(msg.name ?? ''))
        .then(async (result) => {
          sendJson(sock, { v: 1, type: 'skill-deleted', requestId: msg.requestId ?? null, ...result });
          sendJson(sock, { v: 1, type: 'skills-catalog', ...(await skillRegistry.list()) });
        })
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: e?.code ?? 'SKILLS_ERROR', message: String(e?.message ?? e) }));
      return;
    }
    case 'skill-draft-request': {
      if (typeof msg.goal !== 'string' || !msg.goal.trim()) {
        sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: 'INVALID_REQUEST', message: 'Skill goal is required.' });
        return;
      }
      // grok/cursor 는 스킬 초안 러너가 아니다 — claude 가 없으면 codex 로 내려보낸다.
      const skillHealth = providerHealth.cached();
      const agent = msg.agent === 'codex' || msg.agent === 'pi' || msg.agent === 'claude'
        ? msg.agent
        : (skillHealth && skillHealth.claude?.available === false && skillHealth.codex?.available !== false
          ? 'codex'
          : 'claude');
      const model = resolveModel(agent, msg.model);
      sendJson(sock, { v: 1, type: 'skill-draft-progress', requestId: msg.requestId ?? null, state: 'generating' });
      void generateSkillDraft(
        { agent, model, goal: String(msg.goal ?? ''), triggerExamples: String(msg.triggerExamples ?? ''), nonTriggerExamples: String(msg.nonTriggerExamples ?? ''), resourceNotes: String(msg.resourceNotes ?? ''), existingSkill: typeof msg.existingSkill === 'string' ? msg.existingSkill : undefined },
        auxDeps(record, agent, agent === 'claude' ? 'claude' : 'codex'),
      )
        .then((draft) => sendJson(sock, { v: 1, type: 'skill-draft-result', requestId: msg.requestId ?? null, draft }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: 'SKILL_GENERATION_FAILED', message: String(e?.message ?? e) }));
      return;
    }
    case 'provider-status-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void providerHealth.check(msg.refresh === true)
        .then((providers) => replyToStudio(record, sock, { v: 1, type: 'provider-status', requestId, providers }))
        .catch((e) => replyToStudio(record, sock, {
          v: 1, type: 'provider-error', requestId,
          code: 'PROVIDER_PROBE_FAILED', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'agent-setup-status-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void agentSetupStatuses(record.sessionId)
        .then((statuses) => replyToStudio(record, sock, { v: 1, type: 'agent-setup-status', requestId, statuses }))
        .catch((e) => sendAgentSetupError(record, sock, requestId, null, e));
      return;
    }
    case 'agent-setup-install': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const agent = msg.agent;
      if (!KNOWN_AGENTS.has(agent)) {
        sendAgentSetupError(record, sock, requestId, null, new Error('지원하지 않는 에이전트예요.'));
        return;
      }
      const progress = (entry) => replyToStudio(record, sock, {
        v: 1,
        type: 'agent-setup-progress',
        requestId,
        agent,
        state: entry.state,
        ...(entry.phase ? { phase: entry.phase } : {}),
        ...(Number.isFinite(entry.percent) ? { percent: entry.percent } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
        ...(entry.activity === true ? { activity: true } : {}),
        ...(Number.isFinite(entry.receivedBytes) ? { receivedBytes: entry.receivedBytes } : {}),
        ...(Number.isFinite(entry.totalBytes) ? { totalBytes: entry.totalBytes } : {}),
      });
      const installing = agent === 'pi'
        ? mutateSharedNpmPrefix(() => piManager.install(progress)).then(async (status) => {
          piStatus = status;
          rauStatus = await rauManager.status();
        })
        : agent === 'rau'
          ? mutateSharedNpmPrefix(() => rauManager.install(progress)).then(async (status) => {
            rauStatus = status;
            piStatus = await piManager.status();
          })
        : cliSetup.install(agent, progress).then((status) => { cliSetupStatus[agent] = status; });
      void installing
        .then(() => agentSetupStatuses(record.sessionId))
        .then((statuses) => {
          replyToStudio(record, sock, { v: 1, type: 'agent-setup-status', requestId, statuses });
          void providerHealth.check(true).then((providers) => replyToStudio(record, sock, { v: 1, type: 'provider-status', providers }));
        })
        .catch((e) => sendAgentSetupError(record, sock, requestId, agent, e, 'AGENT_INSTALL_FAILED'));
      return;
    }
    case 'agent-setup-auth': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const agent = msg.agent;
      const method = msg.method;
      if (!KNOWN_AGENTS.has(agent) || (method !== 'oauth' && method !== 'api-key')) {
        sendAgentSetupError(record, sock, requestId, null, new Error('로그인 요청을 확인하지 못했어요.'));
        return;
      }
      const abort = new AbortController();
      let rejectProof = null;
      let authRun;
      let credentialsCommitted = false;
      const cancelProvider = () => {
        abort.abort();
        rejectProof?.(agentAuthCancelled());
        rejectProof = null;
        if (agent === 'pi') void piManager.cancelSetup();
        else if (agent === 'rau') void rauManager.cancelSetup();
        else if (CLI_SETUP_AGENTS.includes(agent)) void cliSetup.cancel(agent);
      };
      try {
        authRun = authRuns.begin({
          agent,
          ownerSessionId: record.sessionId,
          requestId,
          method,
          cancel: cancelProvider,
        });
      } catch (error) {
        sendAgentSetupError(record, sock, requestId, agent, error, 'AGENT_AUTH_FAILED');
        return;
      }

      const isLiveAuthRun = () => !abort.signal.aborted && authRuns.get(agent) === authRun;
      const commitAuthRun = () => {
        if (credentialsCommitted) return;
        if (!isLiveAuthRun() || !authRuns.finish(authRun)) throw agentAuthCancelled();
        credentialsCommitted = true;
        authRun.credentialsCommitted = true;
      };
      // Pi completes in the loopback HTTP callback, outside this WS handler stack.
      // Keep only the exact originating run's cancellation and commit capabilities.
      authRun.signal = abort.signal;
      authRun.commitCredentials = commitAuthRun;

      const progress = (entry) => {
        if (!isLiveAuthRun()) return;
        const replayableUi = {
          ...(entry.authUrl ? { authUrl: entry.authUrl } : {}),
          ...(entry.userCode ? { userCode: entry.userCode } : {}),
          ...(entry.pairingCode ? { pairingCode: entry.pairingCode } : {}),
        };
        authRuns.update(authRun, { phase: entry.state ?? entry.phase ?? 'authorizing', replayableUi });
        sendAuthRunFrame(authRun, {
          type: 'agent-setup-progress',
          state: entry.state ?? 'authorizing',
          ...(entry.phase ? { phase: entry.phase } : {}),
          ...(entry.authUrl ? { authUrl: entry.authUrl } : {}),
          ...(entry.userCode ? { userCode: entry.userCode } : {}),
          ...(entry.pairingCode ? { pairingCode: entry.pairingCode } : {}),
          ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
          ...(Number.isFinite(entry.percent) ? { percent: entry.percent } : {}),
          ...(entry.detail ? { detail: entry.detail } : {}),
          ...(entry.activity === true ? { activity: true } : {}),
        });
      };
      const started = (details = {}) => {
        if (!isLiveAuthRun()) return;
        authRuns.update(authRun, { phase: 'authorizing', replayableUi: details });
        replyToStudio(record, sock, {
          v: 1,
          type: 'agent-setup-auth-started',
          requestId,
          authRunId: authRun.runId,
          agent,
          ...details,
        });
      };
      const finish = async (error = null) => {
        authRuns.finish(authRun);
        if (error && credentialsCommitted) {
          log(`post-auth ${agent} refresh failed: ${error?.message ?? error}`);
        } else if (error && !['AGENT_AUTH_CANCELLED', 'RAU_LOGIN_CANCELLED'].includes(error?.code)) {
          sendAuthRunError(authRun, error);
        }
        await broadcastFreshAgentSetupStatuses().catch((statusError) => {
          log(`agent setup status refresh failed: ${statusError?.message ?? statusError}`);
        });
      };

      if (agent === 'rau' && method === 'oauth') {
        void (async () => {
          const callbackState = crypto.randomBytes(24).toString('base64url');
          const redirectUri = `http://127.0.0.1:${hubPort}/oauth/rau/callback`;
          const session = await rauCredits.createDeviceSessionV2({
            signal: abort.signal,
            redirectUri,
            callbackState,
            returnMode: 'hybrid',
            clientVersion: `hub-protocol-${PROTOCOL_VERSION}`,
          });
          if (!isLiveAuthRun()) throw agentAuthCancelled();
          authRun.deviceSessionId = session.id;
          authRun.codeVerifier = session.codeVerifier;
          authRun.callbackState = callbackState;
          const authDetails = {
            authUrl: session.loginUrl,
            pairingCode: session.pairingCode,
            expiresAt: session.expiresAt,
          };
          started(authDetails);
          progress({ state: 'authorizing', ...authDetails });

          let redeemed;
          while (!redeemed) {
            const proof = await new Promise((resolve, reject) => {
              rejectProof = reject;
              authRun.submitProof = (candidate) => {
                rejectProof = null;
                authRun.submitProof = null;
                resolve(candidate);
              };
            });
            if (!isLiveAuthRun()) throw agentAuthCancelled();
            authRuns.update(authRun, { phase: 'redeeming' });
            try {
              redeemed = await rauCredits.redeemDeviceSessionV2(
                session.id,
                session.codeVerifier,
                proof,
                { signal: abort.signal },
              );
              if (!isLiveAuthRun()) throw agentAuthCancelled();
              authRun.acceptedProof = proof;
            } catch (error) {
              if (error?.code !== 'DEVICE_PROOF_INVALID') throw error;
              if (!isLiveAuthRun()) throw agentAuthCancelled();
              authRuns.update(authRun, { phase: 'authorizing' });
              sendAuthRunError(authRun, error, 'DEVICE_PROOF_INVALID');
              progress({ state: 'authorizing', ...authDetails });
            }
          }
          rauStatus = await storeRauApiKey(rauManager.setApiKey.bind(rauManager), redeemed.apiKey, {
            signal: abort.signal,
            account: redeemed.email,
            onCommitted: commitAuthRun,
          });
          await rauCredits.acknowledgeDeviceSessionV2(
            session.id,
            session.codeVerifier,
            authRun.acceptedProof,
            { signal: abort.signal },
          ).catch((error) => {
            if (error?.code === 'RAU_LOGIN_CANCELLED') throw error;
            log(`Rau v2 acknowledgement failed after local key storage: ${error?.message ?? error}`);
          });
          if (!rauStatus.installed) {
            rauStatus = await mutateSharedNpmPrefix(() => rauManager.install(progress));
            piStatus = await piManager.status();
          }
          await refreshOpenRouterCredits(true);
          sendAuthRunFrame(authRun, { type: 'usage-report', usage: usageSnapshot() });
        })().then(() => finish(), finish);
        return;
      }

      let run;
      if (agent === 'pi' && method === 'oauth') {
        try {
          const callbackUrl = `http://127.0.0.1:${hubPort}/oauth/openrouter/callback`;
          const authUrl = piManager.beginOAuth(callbackUrl).authUrl;
          started({ authUrl });
          progress({ state: 'authorizing', authUrl });
        } catch (error) {
          void finish(error);
        }
        return;
      }
      started();
      if (agent === 'pi') {
        run = piManager.setApiKey(String(msg.key ?? ''), {
          signal: abort.signal,
          onCommitted: commitAuthRun,
        })
          .then((status) => { piStatus = status; });
      } else {
        run = cliSetup.authenticate(agent, method, msg.key, progress, {
          signal: abort.signal,
          onCommitted: commitAuthRun,
        })
          .then(async (status) => {
            cliSetupStatus[agent] = status;
            if (agent === 'codex') sourceCodexAuthPath = await findSourceCodexAuthPath();
            if (agent === 'grok') sourceGrokAuthPath = (await cliSetup.grokAuthPath()) ?? undefined;
            refreshSessionCredentials(agent);
          });
      }
      void run.then(async () => {
        if (agent === 'pi') sendAuthRunFrame(authRun, { type: 'pi-status', status: piStatus });
        const providers = await providerHealth.check(true);
        sendAuthRunFrame(authRun, { type: 'provider-status', providers });
      }).then(() => finish(), finish);
      return;
    }
    case 'agent-setup-auth-code': {
      const agent = msg.agent;
      let authRun;
      try {
        authRun = authRuns.requireOwned({
          agent,
          runId: msg.authRunId,
          ownerSessionId: record.sessionId,
        });
      } catch (error) {
        sendAgentSetupError(record, sock, null, agent, error, 'AGENT_AUTH_FAILED');
        return;
      }
      if (agent === 'rau' && typeof authRun.submitProof === 'function') {
        authRun.submitProof({ kind: 'manual', code: String(msg.code ?? '') });
        return;
      }
      if (agent !== 'claude' && agent !== 'codex') {
        sendAgentSetupError(record, sock, null, agent, new Error('인증 코드 요청을 확인하지 못했어요.'));
        return;
      }
      void cliSetup.submitAuthCode(agent, msg.code)
        .catch((e) => sendAgentSetupError(record, sock, null, agent, e, 'AGENT_AUTH_FAILED'));
      return;
    }
    case 'agent-setup-cancel': {
      const agent = msg.agent;
      try {
        authRuns.cancelOwned({
          agent,
          runId: msg.authRunId,
          ownerSessionId: record.sessionId,
        });
        void broadcastFreshAgentSetupStatuses();
      } catch (error) {
        sendAgentSetupError(record, sock, null, agent, error, 'AGENT_AUTH_FAILED');
      }
      return;
    }
    case 'agent-setup-disconnect': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      if (msg.agent !== 'rau') {
        sendAgentSetupError(record, sock, requestId, msg.agent, new Error('연결 해제 요청을 확인하지 못했어요.'));
        return;
      }
      const rauSessions = [...sessions.values()]
        .filter((session) => session.agentSession?.agent === 'rau');
      void rauManager.clearApiKey()
        .then(async (status) => {
          rauStatus = status;
          await Promise.all(rauSessions.map(disposeSession));
          await refreshOpenRouterCredits(true);
          const statuses = await agentSetupStatuses(record.sessionId);
          replyToStudio(record, sock, { v: 1, type: 'agent-setup-status', requestId, statuses });
          replyToStudio(record, sock, { v: 1, type: 'usage-report', usage: usageSnapshot() });
        })
        .catch((e) => sendAgentSetupError(record, sock, requestId, 'rau', e, 'AGENT_SETUP_FAILED'));
      return;
    }
    case 'usage-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void usageSnapshotRefreshing(msg.refresh === true)
        .then((usage) => replyToStudio(record, sock, { v: 1, type: 'usage-report', requestId, usage }))
        .catch((e) => replyToStudio(record, sock, {
          v: 1, type: 'usage-error', requestId,
          code: e?.code ?? 'CLIPROXY_FAILED', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'usage-plan-set': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void Promise.resolve()
        .then(() => usageStore.setPlan(msg.agent, msg.plan))
        .then(() => usageSnapshotRefreshing(false))
        .then((usage) => replyToStudio(record, sock, { v: 1, type: 'usage-report', requestId, usage }))
        .catch((e) => replyToStudio(record, sock, {
          v: 1, type: 'usage-error', requestId,
          code: e?.code ?? 'INVALID_PLAN', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'pi-status-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void refreshPiStatus()
        .then((status) => replyToStudio(record, sock, { v: 1, type: 'pi-status', requestId, status }))
        .catch((e) => sendPiError(record, sock, requestId, e, 'PI_STATUS_FAILED'));
      return;
    }
    case 'pi-install': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void mutateSharedNpmPrefix(() => piManager.install((progress) => replyToStudio(record, sock, {
        v: 1,
        type: 'pi-setup-progress',
        requestId,
        state: progress.state,
        ...(Number.isFinite(progress.percent) ? { percent: progress.percent } : {}),
        ...(progress.detail ? { detail: progress.detail } : {}),
        ...(Number.isFinite(progress.receivedBytes) ? { receivedBytes: progress.receivedBytes } : {}),
        ...(Number.isFinite(progress.totalBytes) ? { totalBytes: progress.totalBytes } : {}),
        ...(progress.activity === true ? { activity: true } : {}),
      })))
        .then((status) => {
          piStatus = status;
          replyToStudio(record, sock, { v: 1, type: 'pi-status', requestId, status });
          // 설치 직후 프로바이더 목록에 pi 가 나타나야 한다.
          void providerHealth.check(true)
            .then((providers) => replyToStudio(record, sock, { v: 1, type: 'provider-status', providers }))
            .catch(() => {});
        })
        .catch((e) => sendPiError(record, sock, requestId, e, 'PI_INSTALL_FAILED'));
      return;
    }
    case 'pi-set-key': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void piManager.setApiKey(String(msg.key ?? ''))
        .then(async (status) => {
          piStatus = status;
          replyToStudio(record, sock, { v: 1, type: 'pi-status', requestId, status });
          await refreshOpenRouterCredits(true);
          replyToStudio(record, sock, { v: 1, type: 'usage-report', usage: usageSnapshot() });
        })
        .catch((e) => sendPiError(record, sock, requestId, e, 'OPENROUTER_KEY_INVALID'));
      return;
    }
    case 'pi-catalog-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void piManager.catalog(msg.refresh === true)
        .then((models) => replyToStudio(record, sock, { v: 1, type: 'pi-catalog', requestId, models }))
        .catch((e) => sendPiError(record, sock, requestId, e, 'OPENROUTER_UNREACHABLE'));
      return;
    }
    case 'pi-set-models': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void piManager.setModels(Array.isArray(msg.models) ? msg.models : [])
        .then((status) => {
          piStatus = status;
          replyToStudio(record, sock, { v: 1, type: 'pi-status', requestId, status });
        })
        .catch((e) => sendPiError(record, sock, requestId, e, 'PI_MODELS_INVALID'));
      return;
    }
    case 'cliproxy-connect': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void cliproxy.connect({ url: msg.url, key: msg.key })
        .then((status) => replyToStudio(record, sock, {
          v: 1, type: 'usage-report', requestId, usage: cliproxy.applyToSummary(usageStore.summary()),
        }))
        .catch((e) => {
          const usage = cliproxy.applyToSummary(usageStore.summary());
          usage.cliproxy = {
            ...usage.cliproxy,
            configured: false,
            connected: false,
            error: String(e?.message ?? e),
          };
          replyToStudio(record, sock, { v: 1, type: 'usage-report', requestId, usage });
        });
      return;
    }
    case 'cliproxy-disconnect': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void cliproxy.disconnect()
        .then(() => replyToStudio(record, sock, { v: 1, type: 'usage-report', requestId, usage: usageSnapshot() }))
        .catch((e) => replyToStudio(record, sock, {
          v: 1, type: 'usage-error', requestId,
          code: e?.code ?? 'CLIPROXY_DISCONNECT_FAILED', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'writing-style-status-request': {
      void writingStyleStore.status()
        .then((status) => sendJson(sock, { v: 1, type: 'writing-style-status', requestId: msg.requestId ?? null, status }))
        .catch((e) => sendJson(sock, { v: 1, type: 'writing-style-error', requestId: msg.requestId ?? null, code: 'STYLE_STATUS_FAILED', message: String(e?.message ?? e) }));
      return;
    }
    case 'writing-style-catalog-request': {
      const requestId = msg.requestId ?? null;
      const refresh = msg.refresh === true;
      void Promise.all([
        providerHealth.check(refresh),
        refresh ? refreshPiStatus() : Promise.resolve(piStatus),
      ])
        .then(() => sendJson(sock, {
          v: 1, type: 'writing-style-catalog', requestId, ...writingStyleCatalog(record),
        }))
        .catch((e) => sendJson(sock, {
          v: 1, type: 'writing-style-error', requestId,
          code: e?.code ?? 'STYLE_CATALOG_FAILED', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'writing-style-calibrate': {
      const requestId = msg.requestId ?? null;
      if (record.styleCalibration || writingStyleCalibrationOwner !== null) {
        sendJson(sock, { v: 1, type: 'writing-style-error', requestId, code: 'CALIBRATION_BUSY', message: 'A writing-style calibration is already running.' });
        return;
      }
      let selection;
      try {
        selection = resolveWritingStyleSelection(
          { agent: msg.agent, model: msg.model, effort: msg.effort },
          {
            health: providerHealth.cached(),
            piStatus,
            rauStatus,
            currentSelection: record.agentSession ? { agent: record.agentSession.agent, model: record.agentSession.model, effort: record.agentSession.effort } : null,
          },
        );
      } catch (e) {
        sendJson(sock, {
          v: 1, type: 'writing-style-error', requestId,
          code: e?.code ?? 'INVALID_CALIBRATION_SELECTION', message: String(e?.message ?? e),
        });
        return;
      }
      const jobId = crypto.randomUUID();
      writingStyleCalibrationOwner = record;
      record.styleCalibration = {
        requestId, jobId, startedAt: new Date().toISOString(),
        agent: selection.agent, model: selection.model, progress: null,
      };
      sendStyleProgress(record, {
        state: 'preparing', phase: 'preparing', activity: 'collecting-samples',
        detail: msg.append === true ? 'Combining saved and new writing samples' : 'Preparing writing samples',
        completed: 0, total: 1,
      });
      let calibrationSources = null;
      void Promise.resolve()
        .then(async () => {
          if (msg.append === true) {
            const current = await writingStyleStore.status();
            assertWritingStyleAppendCompatible(current, {
              language: msg.language,
              baseRevision: typeof msg.baseRevision === 'string' ? msg.baseRevision : null,
            });
          }
          calibrationSources = await writingStyleStore.calibrationSources(msg.files, { append: msg.append === true });
          return calibrateWritingStyle(
            {
              language: msg.language,
              files: calibrationSources,
              agent: selection.agent,
              model: selection.model,
              effort: selection.effort,
            },
            {
              useOpenRouter: selection.agent === 'pi' || selection.agent === 'rau',
              piManager: selection.agent === 'rau' ? rauManager : piManager,
              openRouter: selection.agent === 'rau' ? rauOpenRouter : openRouter,
              projectRoot: ROOT,
              workDir: record.workDir,
              isolatedHome: record.isolatedHome,
              sessionId: record.sessionId,
              spawnProcess: (command, args, options) => auxSpawnProcess(record, command, args, options),
              terminateProcess: terminateProcessTree,
              onProgress: (event) => {
                if (record.styleCalibration?.jobId === jobId) sendStyleProgress(record, event);
              },
            },
          );
        })
        .then(async (profile) => {
          if (record.styleCalibration?.jobId === jobId) sendStyleProgress(record, {
            state: 'saving', phase: 'saving', activity: 'saving-profile',
            detail: 'Saving the profile and its source samples', completed: 0, total: 1,
          });
          const status = await writingStyleStore.save(profile, { sources: calibrationSources });
          if (record.styleCalibration?.jobId === jobId) sendStyleProgress(record, {
            state: 'saving', phase: 'saving', activity: 'saving-profile',
            detail: 'Saved the calibrated writing profile', completed: 1, total: 1,
          });
          sendJson(record.studioSocket, { v: 1, type: 'writing-style-result', requestId, jobId, status });
          sendJson(record.studioSocket, { v: 1, type: 'writing-style-status', requestId, status });
        })
        .catch((e) => sendJson(record.studioSocket, {
          v: 1,
          type: 'writing-style-error',
          requestId,
          jobId,
          code: e?.code ?? 'CALIBRATION_FAILED',
          message: String(e?.message ?? e),
        }))
        .finally(() => {
          if (record.styleCalibration?.jobId === jobId) record.styleCalibration = null;
          if (writingStyleCalibrationOwner === record) writingStyleCalibrationOwner = null;
        });
      return;
    }
    case 'writing-style-instruction-set': {
      const requestId = msg.requestId ?? null;
      void writingStyleStore.setAdditionalInstruction(msg.instruction)
        .then((status) => sendJson(record.studioSocket, {
          v: 1, type: 'writing-style-status', requestId, status,
        }))
        .catch((e) => sendJson(record.studioSocket, {
          v: 1,
          type: 'writing-style-error',
          requestId,
          code: 'STYLE_INSTRUCTION_FAILED',
          message: String(e?.message ?? e),
        }));
      return;
    }
    case 'chat-interrupt': {
      if (record.agentSession) {
        settleUserQuestion(record, { status: 'cancelled', reason: 'user-stop' });
        try {
          record.agentSession.backend.interrupt();
        } catch (e) {
          log(`interrupt error: ${e?.message ?? e}`);
        }
        record.agentSession.status = 'idle';
        record.agentSession.turnId = null;
        record.userQuestionResponseReceipts.clear();
      }
      return;
    }
    case 'chat-stop': {
      settleUserQuestion(record, { status: 'cancelled', reason: 'user-stop' });
      cancelCheckpointTitleJobs(record);
      if (!await disposeSession(record)) {
        sendChatError(sock, agentProcessCleanupUncertain(), 'AGENT_PROCESS_CLEANUP_UNCERTAIN');
      }
      return;
    }
    case 'user-question-answer': {
      answerUserQuestion(record, sock, msg);
      return;
    }
    case 'tool-response': {
      const entry = record.pendingCalls.get(msg.id);
      if (!entry) {
        log(`tool-response for unknown id ${msg.id}`);
        return;
      }
      record.pendingCalls.delete(msg.id);
      clearTimeout(entry.timer);
      const releaseSnapshotClaim = () => {
        if (entry.tool !== 'materialize_document_snapshot' || !entry.copyLayoutJobId) return;
        const job = record.templateJobs.get(entry.copyLayoutJobId);
        releaseCopyLayoutSnapshot(job);
      };
      try {
        if (entry.mcpSocket.readyState !== entry.mcpSocket.OPEN) return;
        if (msg.ok) {
          try {
            let result;
            if (entry.tool === 'get_document_info') {
              result = attachActiveDocumentIdentity(msg.result, entry.documentIdentity);
            } else if (entry.tool === 'materialize_document_snapshot') {
              const snapshotJob = entry.copyLayoutJobId
                ? record.templateJobs.get(entry.copyLayoutJobId)
                : null;
              if (entry.copyLayoutJobId && (!snapshotJob || snapshotJob.status !== 'running')) {
                throw workflowError('COPY_LAYOUT_JOB_SETTLED', 'The copy-layout job settled before its snapshot was bound');
              }
              if (snapshotJob && (
                msg.result?.digest !== snapshotJob.binding.digest
                || msg.result?.sourceFormat !== snapshotJob.binding.sourceFormat
              )) {
                throw workflowError('COPY_LAYOUT_SOURCE_MISMATCH', 'Studio returned snapshot bytes for a different document revision or format');
              }
              const materialization = record.documentSnapshotManager.materialize({
                chatId: entry.chatId,
                documentIdentity: entry.documentIdentity,
                snapshot: msg.result,
              });
              if (snapshotJob) snapshotJob.snapshotPromise = materialization;
              try {
                result = await materialization;
              } finally {
                if (snapshotJob?.snapshotPromise === materialization) snapshotJob.snapshotPromise = null;
              }
            } else {
              result = msg.result;
            }
          if (entry.tool === 'get_document_info' && !entry.copyLayoutJobId
            && record.agentSession?.generation === entry.sessionGeneration) {
            record.agentSession.lastDocumentInfo = Object.freeze({
              documentId: result.documentId,
              digest: result.digest,
              sourceFormat: result.sourceFormat,
              dirty: result.dirty === true,
              sourcePath: result.sourcePath ?? null,
            });
          }
          if (entry.tool === 'materialize_document_snapshot' && entry.copyLayoutJobId) {
            const workerJob = record.templateJobs.get(entry.copyLayoutJobId);
            if (!workerJob || workerJob.status !== 'running') {
              throw workflowError('COPY_LAYOUT_JOB_SETTLED', 'The copy-layout job settled before its snapshot was bound');
            }
            if (result.documentId !== workerJob.binding.documentId
              || result.digest !== workerJob.binding.digest
              || result.sourceFormat !== workerJob.binding.sourceFormat) {
              throw workflowError('COPY_LAYOUT_SOURCE_MISMATCH', 'The immutable snapshot no longer matches the delegated document binding');
            }
            if (workerJob.snapshot) {
              if (workerJob.snapshot.checksum !== result.checksum
                || workerJob.snapshot.digest !== result.digest
                || workerJob.snapshot.path !== result.path) {
                throw workflowError('COPY_LAYOUT_SNAPSHOT_ALREADY_BOUND', 'This job is already bound to a different immutable snapshot');
              }
            } else {
              workerJob.snapshot = Object.freeze({ ...result });
            }
          }
            sendJson(entry.mcpSocket, { v: 1, type: 'tool-result', id: entry.clientId, ok: true, result });
          } catch (error) {
            sendJson(entry.mcpSocket, {
              v: 1, type: 'tool-result', id: entry.clientId, ok: false,
              error: {
                code: error?.code ?? 'SNAPSHOT_WRITE_FAILED',
                message: String(error?.message ?? error),
              },
            });
          }
        } else {
          sendJson(entry.mcpSocket, {
            v: 1, type: 'tool-result', id: entry.clientId, ok: false,
            error: msg.error ?? { code: 'RPC_ERROR', message: 'unknown studio error' },
          });
        }
      } finally {
        releaseSnapshotClaim();
      }
      return;
    }
    default:
      log(`ignoring unknown studio message type: ${String(msg.type)}`);
  }
}

function handleMcpMessage(record, sock, msg) {
  switch (msg.type) {
    case 'tool-call': {
      const clientId = msg.id;
      if (!Number.isSafeInteger(clientId) || clientId < 0) {
        sendJson(sock, {
          v: 1,
          type: 'protocol-error',
          code: 'INVALID_CALL_ID',
          message: 'tool-call id must be a non-negative safe integer',
        });
        try { sock.close(1002, 'invalid tool-call id'); } catch {}
        return;
      }
      const tool = String(msg.tool ?? '');
      const definition = toolDefinitionsByName.get(tool);
      const sendResult = (result) => sendJson(sock, { v: 1, type: 'tool-result', id: clientId, ok: true, result });
      const sendError = (error, fallback = 'TOOL_ERROR') => sendJson(sock, {
        v: 1,
        type: 'tool-result',
        id: clientId,
        ok: false,
        error: { code: error?.code ?? fallback, message: String(error?.message ?? error) },
      });
      if (!definition) {
        sendError(workflowError('UNKNOWN_TOOL', `Unknown tool: ${tool}`));
        return;
      }
      let args;
      const workerJob = workerJobForSocket(record, sock);
      if (!workerJob) {
        const activeSession = record.agentSession;
        if (
          !activeSession
          || sock.agentGeneration !== activeSession.generation
          || sock.agentLabel !== activeSession.agent
          || sock.agentRole !== activeSession.providerRole
        ) {
          sendError(workflowError(
            'PROVIDER_SESSION_STALE',
            'This MCP connection no longer belongs to the active provider session',
          ));
          try { sock.close(4001, 'provider session replaced'); } catch {}
          return;
        }
      }
      try {
        args = toolArgSchema(tool, definition).parse(msg.args ?? {});
        definition.validate?.(args);
        if (!record.agentSession && !workerJob && tool !== 'read_product_skill') {
          throw workflowError('AGENT_NOT_STARTED', 'No active chat session');
        }
        if (sock.agentRole?.startsWith('copy-layout-worker:') && !workerJob) {
          throw workflowError('COPY_LAYOUT_JOB_UNAUTHORIZED', 'This background worker is not bound to an active copy-layout job');
        }
        if (workerJob) {
          if (workerJob.status !== 'running') {
            throw workflowError('COPY_LAYOUT_JOB_SETTLED', 'This copy-layout job is already settled');
          }
          if (!copyLayoutWorkerTools.has(tool)) {
            throw workflowError('COPY_LAYOUT_TOOL_DENIED', `The autonomous copy-layout worker cannot call ${tool}`);
          }
          if (args.jobId && args.jobId !== workerJob.jobId) {
            throw workflowError('COPY_LAYOUT_JOB_MISMATCH', 'The tool call does not match this worker\'s bound job');
          }
        } else if (record.agentSession) {
          if (msg.workflow && msg.workflow !== record.agentSession.planning.workflow) {
            throw workflowError('WORKFLOW_MISMATCH', `MCP call declared ${msg.workflow} but the active workflow is ${record.agentSession.planning.workflow}`);
          }
          authorizeToolCall({
            category: definition.category,
            tool,
            workflow: record.agentSession.planning.workflow,
            phase: record.agentSession.planning.phase,
            expectedEpoch: record.agentSession.planning.capabilityEpoch,
            receivedEpoch: msg.capabilityEpoch,
          });
        }
      } catch (error) {
        if (error?.name === 'ZodError') error.code = 'INVALID_ARGS';
        sendError(error, 'INVALID_ARGS');
        return;
      }
      if (tool === 'read_product_skill') {
        void skillRegistry.readResource(String(args.name ?? ''), String(args.resourcePath ?? 'SKILL.md'))
          .then(sendResult)
          .catch((error) => sendError(error, 'SKILLS_ERROR'));
        return;
      }
      if (tool === 'ask_user_question') {
        if (workerJob || sock.agentRole !== 'chat' || msg.parentTaskId) {
          sendError(workflowError(
            'ROOT_INTERACTION_REQUIRED',
            'Only the root conversation may ask the user questions',
          ));
          return;
        }
        let request;
        try {
          request = normalizeMcpUserQuestionRequest(args, `mcp:${String(clientId)}`);
        } catch (error) {
          if (error?.name === 'ZodError') error.code = 'INVALID_ARGS';
          sendError(error, 'INVALID_ARGS');
          return;
        }
        const generation = record.agentSession.generation;
        void (async () => {
          // Pi/Rau에는 위임 에이전트 질문 경로가 없어 MCP 프로세스 자체가 루트다.
          // 다른 레거시 전송은 별도 프로바이더 스트림의 정확한 일회용 범위 티켓을
          // 기다린 뒤 소비해, 상속된 환경 변수만으로 루트를 사칭하지 못하게 한다.
          if (!OPENROUTER_AGENTS.has(sock.agentLabel)) {
            const matchingScopes = await waitForUserQuestionScopes(
              record,
              sock.agentLabel,
              request.questions,
              generation,
            );
            if (matchingScopes.length !== 1) {
              throw workflowError(
                'CALLER_SCOPE_UNKNOWN',
                'The provider did not unambiguously establish that this question came from the root conversation',
              );
            }
            const scopeIndex = matchingScopes[0].index;
            const [scope] = record.pendingUserQuestionScopes.splice(scopeIndex, 1);
            if (scope.parentTaskId) {
              throw workflowError(
                'ROOT_INTERACTION_REQUIRED',
                'Only the root conversation may ask the user questions',
              );
            }
          }
          const outcome = await requestUserQuestion(record, request, {
            source: 'mcp',
            generation,
            mcpSocket: sock,
          });
          if (outcome.status === 'answered') {
            sendResult({
              status: 'answered',
              answers: userQuestionAnswersForMcp(request, outcome.answers),
            });
            return;
          }
          const code = outcome.status === 'cancelled'
            ? 'USER_QUESTION_CANCELLED'
            : 'USER_QUESTION_EXPIRED';
          sendError(workflowError(code, `User question ${outcome.status}: ${outcome.reason}`));
        })()
          .catch((error) => sendError(error, 'USER_QUESTION_FAILED'));
        return;
      }
      if (tool === 'delegate_copy_layout') {
        try {
          const job = createTemplateJob(record, record.agentSession, args);
          sendResult({
            jobId: job.jobId,
            status: 'running',
            provider: job.agent,
            model: job.model,
            completionDelivery: 'automatic-owning-chat-turn',
            waitForCompletion: false,
            message: '백그라운드 작업을 시작했습니다. wait_agent로 기다리거나 폴링하지 말고 현재 턴을 끝내세요. 완료되면 허브가 이 채팅을 자동으로 다시 시작해 결과를 전달합니다.',
          });
        } catch (error) {
          sendError(error, 'COPY_LAYOUT_DELEGATION_FAILED');
        }
        return;
      }
      if (tool === 'update_copy_layout_job') {
        if (!workerJob) {
          sendError(workflowError('COPY_LAYOUT_JOB_UNAUTHORIZED', 'Only the bound copy-layout worker can report progress'));
          return;
        }
        workerJob.phase = args.phase;
        workerJob.activity = args.activity;
        if (args.iteration !== undefined) workerJob.iteration = args.iteration;
        sendTemplateJobEvent(record, taskProgressForJob(workerJob, args.activity, tool));
        sendResult({
          jobId: workerJob.jobId,
          phase: workerJob.phase,
          phaseIndex: copyLayoutPhaseIndex(workerJob.phase),
          iteration: workerJob.iteration ?? 0,
        });
        return;
      }
      if (tool === 'run_copy_layout_helper') {
        if (!workerJob) {
          sendError(workflowError('COPY_LAYOUT_JOB_UNAUTHORIZED', 'Only the bound copy-layout worker can run the helper'));
          return;
        }
        if (!workerJob.snapshot?.path) {
          sendError(workflowError('COPY_LAYOUT_SNAPSHOT_REQUIRED', 'Call materialize_document_snapshot before running the helper'));
          return;
        }
        if (workerJob.helperPending > 0) {
          sendError(workflowError('COPY_LAYOUT_HELPER_ACTIVE', 'Only one structured helper call may run at a time'));
          return;
        }
        if (args.action === 'inspect' && workerJob.inspection) {
          sendError(workflowError('COPY_LAYOUT_INSPECTION_COMPLETE', 'This immutable snapshot was already inspected'));
          return;
        }
        if (args.action === 'generate') {
          if (workerJob.publishedArtifacts.size > 0) {
            sendError(workflowError('COPY_LAYOUT_ARTIFACT_ALREADY_PUBLISHED', 'The final candidate is already snapshotted for completion'));
            return;
          }
          if (!workerJob.inspection) {
            sendError(workflowError('COPY_LAYOUT_INSPECTION_REQUIRED', 'Inspect the bound snapshot before generating a candidate'));
            return;
          }
          if (workerJob.generatedCandidates.has(args.iteration)
            || workerJob.generatedCandidates.size >= COPY_LAYOUT_MAX_ITERATIONS) {
            sendError(workflowError('COPY_LAYOUT_ITERATION_USED', 'Each of the three bounded candidate iterations may run only once'));
            return;
          }
        }
        const boundSnapshot = workerJob.snapshot;
        workerJob.helperPending = 1;
        const run = runCopyLayoutHelper(args, {
          sourcePath: boundSnapshot.path,
          sourceFormat: boundSnapshot.sourceFormat,
          helperPath: path.join(BUNDLED_SKILLS, 'copy-layout', 'scripts', 'copy_layout.py'),
          privateRoot: workerJob.generatedRoot,
          hwpBinary: hwpExtractor,
          spawnProcess: (command, argv, options) => spawnAuxiliaryProcess(
            record,
            command,
            argv,
            options,
          ),
          cleanupProcess: (child) => beginAuxiliaryProcessCleanup(record, child),
        }).then((result) => {
          if (workerJob.status !== 'running' || workerJob.snapshot !== boundSnapshot) {
            throw workflowError('COPY_LAYOUT_JOB_SETTLED', 'The copy-layout job changed before the helper completed');
          }
          if (args.action === 'inspect') workerJob.inspection = Object.freeze(result);
          else workerJob.generatedCandidates.set(args.iteration, Object.freeze(result));
          return result;
        }).finally(() => { workerJob.helperPending = 0; });
        workerJob.helperPromise = run;
        void run.then((result) => {
          sendTemplateJobEvent(record, taskProgressForJob(workerJob, `${args.action} helper completed`, tool));
          sendResult(result);
        }).catch((error) => {
          if (error?.processCleanupUncertain) {
            record.processCleanupUncertain = true;
            retainUncertainProcessCleanup(record.recordRoot);
          }
          sendError(error, 'COPY_LAYOUT_HELPER_FAILED');
        });
        return;
      }
      if (tool === 'complete_copy_layout_job') {
        if (!workerJob) {
          sendError(workflowError('COPY_LAYOUT_JOB_UNAUTHORIZED', 'Only the bound copy-layout worker can complete this job'));
          return;
        }
        if (workerJob.helperPending > 0) {
          sendError(workflowError('COPY_LAYOUT_HELPER_ACTIVE', 'Wait for the structured helper call to finish before completing the job'));
          return;
        }
        if (args.sourceDocumentId !== workerJob.binding.documentId || args.sourceDigest !== workerJob.binding.digest) {
          sendError(workflowError('COPY_LAYOUT_SOURCE_MISMATCH', 'Completion does not match the immutable source binding'));
          return;
        }
        const published = args.outcome === 'succeeded'
          ? workerJob.publishedArtifacts.get(args.artifactId)
          : null;
        if (args.outcome === 'succeeded' && !published) {
          sendError(workflowError('COPY_LAYOUT_ARTIFACT_UNBOUND', 'Completion must use an artifact published from this job\'s verified helper candidate'));
          return;
        }
        let storedClaims = null;
        try {
          storedClaims = published ? copyLayoutCandidateClaims(workerJob, published) : null;
        } catch (error) {
          sendError(error, 'COPY_LAYOUT_VERIFICATION_MISSING');
          return;
        }
        if (storedClaims && (
          published.report?.delivery?.ready !== true
          || published.report?.verification?.layout_structure_match !== true
          || args.quality !== storedClaims.quality
          || !exactJsonArray(args.warnings, storedClaims.warnings)
          || Object.entries(storedClaims.counts).some(([key, value]) => args.counts[key] !== value)
          || !exactJsonArray(args.preview.representativePages, storedClaims.preview.representativePages)
          || Object.entries(storedClaims.preview)
            .filter(([key]) => key !== 'representativePages')
            .some(([key, value]) => args.preview[key] !== value)
        )) {
          sendError(workflowError('COPY_LAYOUT_VERIFICATION_MISMATCH', 'Completion claims do not exactly match the stored helper render and verification evidence'));
          return;
        }
        const completionClaims = storedClaims ?? {
          quality: null,
          warnings: args.warnings,
          counts: {
            keptText: 0, removedText: 0, replacedText: 0, resetControls: 0,
            clearedMarks: 0, keptMedia: 0, removedMedia: 0,
            iterations: Math.max(1, Math.min(COPY_LAYOUT_MAX_ITERATIONS, workerJob.generatedCandidates.size || 1)),
          },
          preview: {
            representativePages: [], sourcePageCount: 1, outputPageCount: 1,
            outputSectionCount: 1, renderCompared: false, geometryMatch: false,
            safetyVerified: false, readabilityVerified: false, stoppedReason: 'hard-failure',
          },
        };
        // Claim the one-shot completion before the first await so concurrent
        // requests cannot both settle the same worker job.
        try {
          claimCopyLayoutSettlement(workerJob);
        } catch (error) {
          sendError(error, 'COPY_LAYOUT_JOB_SETTLED');
          return;
        }
        const completion = (async () => {
          let artifact = null;
          if (args.outcome === 'succeeded') {
            artifact = await record.artifactStore.read(args.artifactId);
          }
          workerJob.status = args.outcome === 'succeeded' ? 'completed' : 'failed';
          workerJob.activity = args.summary;
          workerJob.result = {
            summary: args.summary,
            warnings: completionClaims.warnings,
            counts: completionClaims.counts,
            preview: completionClaims.preview,
            ...(artifact ? {
              quality: completionClaims.quality,
              artifact: artifactDownloadDescriptor(record, args.artifactId, artifact),
            } : {}),
          };
          workerJob.inspection = null;
          workerJob.generatedCandidates.clear();
          workerJob.publishedArtifacts.clear();
          record.activeTemplateJobId = null;
          pruneTemplateJobHistory(record);
          sendTemplateJobEvent(record, {
            type: 'task-end',
            agent: workerJob.agent,
            taskId: workerJob.jobId,
            status: workerJob.status === 'completed' ? 'completed' : 'failed',
            summary: args.summary,
            ...(workerJob.usage ? { usage: workerJob.usage } : {}),
          });
          queueTemplateCompletion(record, workerJob);
          sendResult({ jobId: workerJob.jobId, status: workerJob.status });
        })();
        workerJob.completionPromise = completion;
        void completion.catch((error) => {
          if (workerJob.status === 'settling') workerJob.status = 'running';
          settleTemplateJobFailure(record, workerJob, error);
          sendError(error, 'COPY_LAYOUT_COMPLETION_FAILED');
        });
        return;
      }
      if (tool === 'register_copy_layout_template') {
        const job = record.templateJobs.get(args.jobId);
        if (!job || job.ownerThreadId !== record.agentSession?.threadId) {
          sendError(workflowError('COPY_LAYOUT_JOB_NOT_FOUND', 'No completed copy-layout job belongs to this chat'));
          return;
        }
        if (job.status !== 'completed' || !job.result?.artifact) {
          sendError(workflowError('COPY_LAYOUT_JOB_NOT_READY', 'The copy-layout artifact is not ready for registration'));
          return;
        }
        if (job.registeredTemplateId) {
          try {
            sendResult({ template: templateStore.get(job.registeredTemplateId), alreadyRegistered: true });
          } catch (error) {
            sendError(error, 'TEMPLATE_NOT_FOUND');
          }
          return;
        }
        void record.artifactStore.read(job.result.artifact.artifactId)
          .then((artifact) => templateStore.add({
            name: args.name ?? defaultTemplateName(artifact.fileName),
            originalName: artifact.fileName,
            format: path.extname(artifact.fileName).slice(1).toLowerCase(),
            pageCount: job.result.preview.outputPageCount,
            sectionCount: job.result.preview.outputSectionCount,
            bytes: artifact.bytes,
          }))
          .then((template) => {
            job.registeredTemplateId = template.id;
            broadcastTemplateCatalog({ type: 'added', template });
            sendResult({ template, alreadyRegistered: false });
          })
          .catch((error) => sendError(error, 'TEMPLATE_REGISTER_FAILED'));
        return;
      }
      if (tool === 'read_agent_instructions') {
        sendResult(agentInstructionsStore.snapshot());
        return;
      }
      if (tool === 'update_agent_instructions') {
        try {
          const status = agentInstructionsStore.snapshot();
          const prepared = agentInstructionsStore.prepareUpdate(args.content, {
            expectedRevision: args.expectedRevision,
          });
          if (prepared.content === status.content) {
            sendResult({ ...status, changed: false, pendingConfirmation: false });
            return;
          }
          if (!record.studioSocket || record.studioSocket.readyState !== record.studioSocket.OPEN) {
            throw workflowError(
              'INSTRUCTIONS_CONFIRMATION_UNAVAILABLE',
              'Rauhwpx Studio must be connected so the user can confirm the instruction proposal.',
            );
          }
          if (record.pendingInstructionDraft) clearInstructionDraft(record, 'replaced');
          const requestedBy = sock.agentLabel ?? record.agentSession?.agent ?? 'unknown';
          const createdAt = Date.now();
          const draft = {
            id: crypto.randomUUID(),
            confirmationToken: crypto.randomUUID(),
            content: prepared.content,
            expectedRevision: prepared.expectedRevision,
            reason: typeof args.reason === 'string' ? args.reason : null,
            requestedBy,
            createdAt,
            expiresAt: createdAt + AGENT_INSTRUCTION_DRAFT_TTL_MS,
          };
          record.pendingInstructionDraft = draft;
          draft.expiryTimer = setTimeout(() => {
            if (record.pendingInstructionDraft?.id === draft.id) {
              clearInstructionDraft(record, 'expired');
            }
          }, AGENT_INSTRUCTION_DRAFT_TTL_MS);
          draft.expiryTimer.unref?.();
          if (!sendInstructionDraft(record)) {
            record.pendingInstructionDraft = null;
            throw workflowError(
              'INSTRUCTIONS_CONFIRMATION_UNAVAILABLE',
              'Rauhwpx Studio disconnected before the instruction proposal could be shown.',
            );
          }
          sendResult({
            ...status,
            changed: false,
            pendingConfirmation: true,
            draftId: draft.id,
            expiresAt: new Date(draft.expiresAt).toISOString(),
            ...(draft.reason ? { reason: draft.reason } : {}),
          });
        } catch (error) {
          sendError(error, 'INSTRUCTIONS_DRAFT_FAILED');
        }
        return;
      }
      if (definition.category === 'reference-read') {
        void executeReferenceTool({ tool, args, store: referenceStore, session: record.agentSession })
          .then(({ handled, result }) => {
            if (!handled) throw workflowError('UNKNOWN_TOOL', `Unknown reference tool: ${tool}`);
            sendResult(result);
          })
          .catch((error) => sendError(error, 'REFERENCE_READ_FAILED'));
        return;
      }
      if (tool === 'get_active_template') {
        try {
          if (!record.agentSession?.activeTemplateId) throw workflowError('TEMPLATE_NOT_SELECTED', 'Select a template with /templates first.');
          sendResult({
            template: templateStore.get(record.agentSession.activeTemplateId),
            transferCapabilities: {
              exact: ['paragraphText', 'characterFormatting', 'paragraphFormatting', 'tables', 'embeddedPictures'],
              supported: ['pageGeometry', 'columns', 'sectionDefaults', 'pageBorders', 'headerFooterTextAndPageScope'],
              fallback: ['styles', 'numbering', 'unsupportedControls', 'shapes', 'headerFooterFormattingAndControls'],
              skipped: [],
            },
          });
        } catch (error) {
          sendError(error, 'TEMPLATE_NOT_FOUND');
        }
        return;
      }
      if (tool === 'present_implementation_plan') {
        if (!record.studioSocket || record.studioSocket.readyState !== record.studioSocket.OPEN) {
          sendError(workflowError('NO_STUDIO', 'Studio must be connected to review an implementation plan'));
          return;
        }
        try {
          const planRecord = record.agentSession.planning.present(args);
          sendJson(record.studioSocket, {
            v: 1,
            type: 'plan-ready',
            planId: planRecord.planId,
            plan: planRecord.plan,
            ...record.agentSession.planning.snapshot(),
          });
          emitWorkflowState(record, { reason: 'plan-presented' });
          const { workflow, phase, capabilityEpoch } = record.agentSession.planning.snapshot();
          sendResult({ planId: planRecord.planId, workflow, phase, capabilityEpoch });
        } catch (error) {
          sendError(error);
        }
        return;
      }
      if (tool === 'download_file') {
        void record.downloadManager.download({ sessionId: record.agentSession.chatId, ...args })
          .then(sendResult)
          .catch((error) => sendError(error, 'DOWNLOAD_FAILED'));
        return;
      }
      if (tool === 'publish_artifact') {
        let workerCandidate = null;
        let workerPublishClaimed = false;
        if (workerJob) {
          const requestedPath = path.resolve(String(args.filePath ?? ''));
          workerCandidate = [...workerJob.generatedCandidates.values()]
            .find((candidate) => path.resolve(candidate.outputPath) === requestedPath) ?? null;
          try {
            if (workerCandidate) {
              copyLayoutCandidateClaims(workerJob, { report: workerCandidate.report });
            }
            claimCopyLayoutPublication(workerJob, workerCandidate);
          } catch (error) {
            sendError(error, 'COPY_LAYOUT_ARTIFACT_UNBOUND');
            return;
          }
          workerPublishClaimed = true;
        }
        void record.artifactStore.publish(args)
          .then(async ({ artifactId, fileName, mime, size, checksum }) => {
            if (workerJob) {
              await Promise.resolve(workerJob.helperPromise);
              if (workerJob.status !== 'running'
                || workerJob.helperPending !== 0
                || workerJob.generatedCandidates.get(workerCandidate.iteration) !== workerCandidate
                || checksum !== workerCandidate.checksum) {
                throw workflowError('COPY_LAYOUT_ARTIFACT_MISMATCH', 'Published bytes no longer match the verified helper candidate');
              }
              workerJob.publishedArtifacts.set(artifactId, Object.freeze({
                checksum,
                outputPath: workerCandidate.outputPath,
                iteration: workerCandidate.iteration,
                report: workerCandidate.report,
              }));
              // ArtifactStore owns an immutable byte snapshot now. Remove all
              // private candidates immediately so sequential jobs cannot grow
              // hub storage by 3 x 64 MiB each.
              await cleanupTemplateGeneratedRoot(record, workerJob);
            }
            const encodePathSegment = (value) => encodeURIComponent(value).replace(
              /[!'()*]/g,
              (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
            );
            const downloadUrl = new URL(
              `/artifacts/${encodePathSegment(artifactId)}/${encodePathSegment(fileName)}`,
              `http://127.0.0.1:${hubPort}`,
            );
            downloadUrl.searchParams.set('sessionId', record.sessionId);
            downloadUrl.searchParams.set('token', sessions.issue(TOKEN, record.sessionId, {
              audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
              resource: artifactId,
            }));
            sendResult({ artifactId, fileName, mime, size, checksum, downloadUrl: downloadUrl.href });
          })
          .catch((error) => {
            if (workerJob && workerPublishClaimed) {
              releaseCopyLayoutPublication(workerJob, workerCandidate);
            }
            sendError(error, 'ARTIFACT_PUBLISH_FAILED');
          });
        return;
      }
      if (definition.category === 'browser') {
        const sidecarTool = tool.replace(/^browserbase_/, '');
        void record.browserbaseSession.call(record.agentSession.chatId, sidecarTool, args)
          .then(sendResult)
          .catch((error) => {
            if (error?.processCleanupUncertain) {
              record.processCleanupUncertain = true;
              retainedUncertainBrowserbaseSessions.add(record.browserbaseSession);
              retainUncertainProcessCleanup(record.recordRoot);
            }
            sendError(error, 'BROWSERBASE_TOOL_FAILED');
          });
        return;
      }
      if (workerJob && tool === 'materialize_document_snapshot') {
        if (workerJob.snapshot) {
          sendResult(workerJob.snapshot);
          return;
        }
        if (workerJob.snapshotPending) {
          sendError(workflowError(
            'COPY_LAYOUT_SNAPSHOT_ACTIVE',
            'The immutable document snapshot is already being materialized for this job',
          ));
          return;
        }
      }
      if (!record.studioSocket || record.studioSocket.readyState !== record.studioSocket.OPEN) {
        sendError(workflowError('NO_STUDIO', 'Studio is not connected; open rhwp-studio in a browser'));
        return;
      }
      if (record.pendingCalls.size >= MAX_PENDING_STUDIO_TOOL_CALLS) {
        sendError(workflowError(
          'TOO_MANY_INFLIGHT_CALLS',
          `At most ${MAX_PENDING_STUDIO_TOOL_CALLS} Studio tool calls may be in flight`,
        ));
        return;
      }
      let activeTemplate = null;
      if (tool.startsWith('template_')) {
        try {
          if (!record.agentSession?.activeTemplateId) throw workflowError('TEMPLATE_NOT_SELECTED', 'Select a template with /templates first.');
          activeTemplate = templateStore.get(record.agentSession.activeTemplateId);
          if (args.templateRevision !== activeTemplate.revision) {
            throw workflowError('TEMPLATE_REVISION_MISMATCH', `Template changed from revision ${String(args.templateRevision)} to ${activeTemplate.revision}; inspect it again before continuing.`);
          }
        } catch (error) {
          sendError(error, 'TEMPLATE_NOT_FOUND');
          return;
        }
      }
      const hubId = record.nextHubId++;
      if (workerJob && tool === 'materialize_document_snapshot') {
        try {
          claimCopyLayoutSnapshot(workerJob);
        } catch (error) {
          sendError(error, 'COPY_LAYOUT_SNAPSHOT_ACTIVE');
          return;
        }
      }
      // apply_edits 는 항목 수만큼 변이+마감 리플로우를 안고 오므로 배치 크기에
      // 비례해 늘린다. 전체 문서 직렬화+base64 전송도 큰 파일에서는 길어질 수 있어
      // 별도 예산을 준다 (둘 다 mcp-stdio 의 180s 한도 아래로 유지).
      const timeoutMs = tool === 'apply_edits'
        ? Math.min(STUDIO_TOOL_TIMEOUT_MS + 2_000 * (Array.isArray(args.edits) ? args.edits.length : 0), 120_000)
        : tool === 'materialize_document_snapshot'
          ? 120_000
          : STUDIO_TOOL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        record.pendingCalls.delete(hubId);
        if (workerJob && tool === 'materialize_document_snapshot') {
          releaseCopyLayoutSnapshot(workerJob);
        }
        sendJson(sock, {
          v: 1, type: 'tool-result', id: clientId, ok: false,
          error: { code: 'STUDIO_TIMEOUT', message: `Studio did not answer within ${timeoutMs / 1000}s — the edit may still have applied; re-read with get_structure/get_text_range before retrying to avoid duplicates` },
        });
      }, timeoutMs);
      record.pendingCalls.set(hubId, {
        mcpSocket: sock,
        clientId,
        timer,
        tool,
        documentIdentity: workerJob
          ? { documentId: workerJob.binding.documentId, documentName: workerJob.binding.documentName }
          : activeDocumentIdentity(record.agentSession),
        chatId: workerJob?.jobId
          ?? record.agentSession?.chatId
          ?? record.agentSession?.threadId
          ?? record.sessionId,
        copyLayoutJobId: workerJob?.jobId ?? null,
        sessionGeneration: record.agentSession?.generation ?? null,
      });
      const forwarded = sendJson(record.studioSocket, {
        v: 1, type: 'tool-request', id: hubId,
        // 호출을 보낸 MCP 소켓의 에이전트 라벨을 단다 — 현재 세션 기준으로 찍으면
        // 세션 교체 직후 남은 호출이 엉뚱한 에이전트로 기록될 수 있다.
        agent: sock.agentLabel ?? record.agentSession?.agent ?? 'claude',
        tool,
        args,
        ...(activeTemplate ? { template: activeTemplate } : {}),
        workflow: record.agentSession?.planning.snapshot().workflow,
        phase: record.agentSession?.planning.snapshot().phase,
        capabilityEpoch: record.agentSession?.planning.capabilityEpoch,
      });
      if (!forwarded) {
        clearTimeout(timer);
        record.pendingCalls.delete(hubId);
        if (workerJob && tool === 'materialize_document_snapshot') {
          releaseCopyLayoutSnapshot(workerJob);
        }
        sendError(workflowError('NO_STUDIO', 'Studio disconnected before receiving the tool request'));
      }
      return;
    }
    default:
      log(`ignoring unknown mcp message type: ${String(msg.type)}`);
  }
}

function attachSocket(record, sock, role) {
  let queuedStudioBytes = 0;
  let queuedStudioMessages = 0;
  sock.on('message', async (data, isBinary) => {
    if (record.disposed) {
      try { sock.close(1001, 'hub session closed'); } catch {}
      return;
    }
    if (isBinary) {
      sock.close(4400, 'binary frames not supported');
      return;
    }
    const frameBytes = Number(data?.byteLength ?? Buffer.byteLength(String(data), 'utf8'));
    let releaseStudioBudget = () => {};
    if (role === 'studio') {
      if (!Number.isSafeInteger(frameBytes) || frameBytes < 0
        || queuedStudioMessages >= MAX_STUDIO_QUEUED_MESSAGES
        || queuedStudioBytes + frameBytes > MAX_STUDIO_QUEUED_FRAME_BYTES) {
        sock.close(4408, 'studio message queue limit exceeded');
        return;
      }
      queuedStudioMessages += 1;
      queuedStudioBytes += frameBytes;
      let released = false;
      releaseStudioBudget = () => {
        if (released) return;
        released = true;
        queuedStudioMessages -= 1;
        queuedStudioBytes -= frameBytes;
      };
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      releaseStudioBudget();
      sock.close(4400, 'malformed JSON');
      return;
    }
    if (msg?.v !== PROTOCOL_VERSION) {
      releaseStudioBudget();
      sendJson(sock, {
        v: 1, type: 'protocol-error', code: 'UNSUPPORTED_VERSION',
        message: `protocol version ${String(msg?.v)} is not supported`, supportedVersions: [PROTOCOL_VERSION],
      });
      sock.close(1002, 'unsupported protocol version');
      return;
    }
    try {
      if (role === 'studio') {
        // WebSocket 은 async 메시지 리스너를 동시에 실행한다. Studio 명령을 직렬화해
        // 빠른 중지/시작/열기 조작이 옛 채팅을 되살리지 못하게 한다.
        record.studioMessageQueue = record.studioMessageQueue
          .then(() => {
            if (record.studioSocket !== sock) return;
            return handleStudioMessage(record, sock, msg);
          })
          .catch((error) => {
            log(`message handler error (${role}, session=${record.sessionId}): ${error?.stack ?? error}`);
          })
          .finally(releaseStudioBudget);
      } else {
        handleMcpMessage(record, sock, msg);
      }
    } catch (e) {
      releaseStudioBudget();
      log(`message handler error (${role}, session=${record.sessionId}): ${e?.stack ?? e}`);
    }
  });
  sock.on('error', (err) => log(`${role} socket error (session=${record.sessionId}): ${err?.message ?? err}`));
}

function recordHealth(record) {
  return {
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
    studioConnected: !!record.studioSocket && record.studioSocket.readyState === record.studioSocket.OPEN,
    mcpClients: record.mcpSockets.size,
    session: sessionInfo(record),
    browserbase: record.browserbaseSession.status(),
  };
}

function healthzBody() {
  return {
    ok: true,
    name: HUB_NAME,
    pid: process.pid,
    launchId: LAUNCH_ID,
    port: hubPort,
    uptimeMs: Date.now() - STARTED_AT,
    protocol: PROTOCOL_VERSION,
    secretBroker: secretStore.available,
    sessions: sessions.summaries(recordHealth),
    providers: providerHealth.cached(),
  };
}

function requestToken(req, url) {
  const authorization = String(req.headers.authorization ?? '');
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return url.searchParams.get('token') ?? '';
}

function sendHttpJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authenticateHttpSession(req, url, { audience, resource } = {}) {
  return sessions.authenticate({
    masterToken: TOKEN,
    token: requestToken(req, url),
    sessionId: url.searchParams.get('sessionId'),
    audience,
    ...(resource === undefined ? {} : { resource }),
    allowMaster: !PRODUCTION,
  });
}

function authenticateOwnerRequest(req, url) {
  // 소유자 엔드포인트(/shutdown, DELETE /sessions)는 마스터 토큰을 Authorization
  // 헤더로만 받는다 — URL 에 실린 토큰은 히스토리·로그·크래시 리포트에 남는다.
  const authorization = String(req.headers.authorization ?? '');
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!bearer || url.searchParams.get('token')) {
    const error = new Error('owner endpoints require a bearer token');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
  authenticateMasterToken(TOKEN, bearer);
  if (!timingSafeTextEqual(String(req.headers['x-rhwp-launch-id'] ?? ''), LAUNCH_ID)) {
    const error = new Error('invalid hub launch id');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
}

function isReferencePath(pathname) {
  return pathname === '/reference-files'
    || pathname === '/reference-staging'
    || pathname === '/reference-search'
    || pathname.startsWith('/reference-files/')
    || pathname.startsWith('/reference-staging/');
}

function isTemplatePath(pathname) {
  return pathname === '/templates' || pathname.startsWith('/templates/');
}

/** Host 헤더가 루프백(127.0.0.1/localhost/[::1])인지 — DNS rebinding 차단용. */
function isLoopbackHost(hostHeader) {
  const host = String(hostHeader ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

const httpServer = http.createServer((req, res) => {
  void Promise.resolve().then(async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${hubPort || REQUESTED_PORT || 5175}`);
    // DNS rebinding 방어: 프로덕션(데스크톱 소유 허브)에서는 Host 가 루프백이어야 한다.
    // 브라우저는 요청에 재바인딩된 도메인을 Host 로 실어 보내므로 여기서 걸러진다.
    if (PRODUCTION && !isLoopbackHost(req.headers.host)) {
      sendHttpJson(res, 403, { status: 'forbidden' });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
      if (origin && !isAllowedStudioOrigin(origin)) {
        sendHttpJson(res, 403, { status: 'forbidden' });
        return;
      }
      const [, , encodedArtifactId] = url.pathname.split('/');
      const artifactId = decodeURIComponent(encodedArtifactId ?? '');
      const sessionId = authenticateHttpSession(req, url, {
        audience: HUB_CAPABILITY_AUDIENCES.ARTIFACT,
        resource: artifactId,
      });
      const record = sessions.require(sessionId);
      let artifact;
      try {
        artifact = await record.artifactStore.read(artifactId);
      } catch (error) {
        if (error?.code !== 'ARTIFACT_NOT_FOUND') throw error;
        sendHttpJson(res, 404, { status: 'not-found' });
        return;
      }
      const encodedName = encodeURIComponent(artifact.fileName).replaceAll('%20', ' ');
      const asciiName = artifact.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.writeHead(200, {
        'content-type': artifact.mime,
        'content-length': artifact.bytes.length,
        'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        'cache-control': 'no-store, private',
        'x-content-type-options': 'nosniff',
        ...(origin ? {
          'access-control-allow-origin': origin,
          'access-control-expose-headers': 'Content-Disposition, Content-Length',
          vary: 'Origin',
        } : {}),
      });
      res.end(artifact.bytes);
      return;
    }
    if (isReferencePath(url.pathname) || isTemplatePath(url.pathname)) {
      let authSessionId = null;
      if (req.method !== 'OPTIONS') {
        authSessionId = authenticateHttpSession(req, url, {
          audience: isReferencePath(url.pathname)
            ? HUB_CAPABILITY_AUDIENCES.REFERENCE
            : HUB_CAPABILITY_AUDIENCES.TEMPLATE,
        });
        sessions.require(authSessionId);
      }
      // The route handler still enforces a Bearer header. Its accepted value is
      // the capability already authenticated above, never a freshly derived
      // session-wide token.
      const presentedToken = requestToken(req, url);
      const expectedTokens = authSessionId ? [presentedToken] : [];
      const allowedScopes = authSessionId
        ? referenceScopesForSession(sessions.require(authSessionId).agentSession)
        : [];
      if (isReferencePath(url.pathname)) {
        const handleReferenceHttp = createReferenceHttpHandler({
          store: referenceStore,
          tokens: expectedTokens,
          allowedScopes,
        });
        if (await handleReferenceHttp(req, res, url)) return;
      }
      if (isTemplatePath(url.pathname)) {
        const handleTemplateHttp = createTemplateHttpHandler({
          store: templateStore,
          tokens: expectedTokens,
          onChanged: broadcastTemplateCatalog,
        });
        if (await handleTemplateHttp(req, res, url)) return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/oauth/rau/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const authRun = authRuns.get('rau');
      if (!authRun || !code || !state || !timingSafeTextEqual(state, authRun.callbackState ?? '')) {
        res.writeHead(400, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end('Invalid or expired Rau login callback.');
        return;
      }
      if (typeof authRun.submitProof !== 'function') {
        res.writeHead(409, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      authRun.submitProof({ kind: 'loopback', code });
      res.writeHead(204, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/oauth/openrouter/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const authRun = authRuns.get('pi');
      if (!code || !authRun || authRun.method !== 'oauth'
        || authRun.signal?.aborted || typeof authRun.commitCredentials !== 'function') {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><p>OpenRouter login did not return a code.</p>');
        return;
      }
      try {
        // The manager checks this exact run signal throughout exchange and commits.
        // commitCredentials rechecks identity and removes the run synchronously with
        // the credential write, before any slow post-auth status work begins.
        piStatus = await piManager.completeOAuth(code, state, {
          signal: authRun.signal,
          onCommitted: authRun.commitCredentials,
        });
        if (authRun.credentialsCommitted !== true) throw agentAuthCancelled();
        await broadcastFreshAgentSetupStatuses();
        sendAuthRunFrame(authRun, { type: 'pi-status', status: piStatus });
        void refreshOpenRouterCredits(true).then(() => {
          broadcastToStudios({ v: 1, type: 'usage-report', usage: usageSnapshot() });
        }).catch((refreshError) => {
          log(`post-auth pi credit refresh failed: ${refreshError?.message ?? refreshError}`);
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><style>body{font:16px system-ui;margin:48px;color:#202124}</style><h1>OpenRouter connected</h1><p>You can return to Rauhwpx and close this tab.</p>');
      } catch (error) {
        if (authRun.credentialsCommitted === true) {
          log(`post-auth pi status refresh failed: ${error?.message ?? error}`);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><h1>OpenRouter connected</h1><p>You can return to Rauhwpx and close this tab.</p>');
          return;
        }
        if (error?.code !== 'OPENROUTER_OAUTH_INVALID') {
          sendAuthRunError(authRun, error, 'OPENROUTER_OAUTH_FAILED');
        }
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><p>OpenRouter login could not be completed. Return to Rauhwpx and try again.</p>');
      }
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/sessions/')) {
      authenticateOwnerRequest(req, url);
      const sessionId = decodeURIComponent(url.pathname.slice('/sessions/'.length));
      const record = sessions.register(sessionId);
      sendHttpJson(res, 200, {
        status: 'registered',
        sessionId: record.sessionId,
        capabilities: {
          studio: sessions.issue(TOKEN, record.sessionId, {
            audience: HUB_CAPABILITY_AUDIENCES.STUDIO,
          }),
          mcp: sessions.issue(TOKEN, record.sessionId, {
            audience: HUB_CAPABILITY_AUDIENCES.MCP,
            ...(record.agentSession?.providerCapabilityResource
              ? { resource: record.agentSession.providerCapabilityResource }
              : {}),
          }),
          reference: sessions.issue(TOKEN, record.sessionId, {
            audience: HUB_CAPABILITY_AUDIENCES.REFERENCE,
          }),
          template: sessions.issue(TOKEN, record.sessionId, {
            audience: HUB_CAPABILITY_AUDIENCES.TEMPLATE,
          }),
        },
      });
      return;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/sessions/')) {
      authenticateOwnerRequest(req, url);
      const sessionId = decodeURIComponent(url.pathname.slice('/sessions/'.length));
      const record = sessions.get(sessionId);
      if (!record) {
        sendHttpJson(res, 404, { status: 'not-found', sessionId });
        return;
      }
      sessions.delete(sessionId);
      authRuns.cancelForSession(sessionId, 'owner-session-closed');
      await disposeRecord(record, 'hub session closed');
      sendHttpJson(res, 200, { status: 'deleted', sessionId });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      authenticateOwnerRequest(req, url);
      sendHttpJson(res, 202, { status: 'shutting-down', launchId: LAUNCH_ID });
      setImmediate(() => {
        void shutdown('owner request').finally(() => process.exit(0));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const token = requestToken(req, url);
      const authenticated = !(DEVELOPMENT_AUTH && !token);
      if (authenticated) authenticateMasterToken(TOKEN, token);
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
      const allowOrigin = origin && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(origin)
        ? origin
        : null;
      // 개발 모드 무인증 liveness 확인에도 상태를 노출하지 않는다 —
      // launchId·세션 요약·프로바이더 캐시는 인증된 응답에만 실린다.
      const body = authenticated ? healthzBody() : {
        ok: true,
        name: HUB_NAME,
        pid: process.pid,
        port: hubPort,
        uptimeMs: Date.now() - STARTED_AT,
        protocol: PROTOCOL_VERSION,
      };
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...(allowOrigin ? { 'access-control-allow-origin': allowOrigin, vary: 'Origin' } : {}),
      });
      res.end(JSON.stringify(body));
      return;
    }
    // pi extension requests a shared catalog with its signed session credential.
    if (req.method === 'GET' && url.pathname === '/pi/tool-definitions') {
      const candidateSession = sessions.get(url.searchParams.get('sessionId'));
      const requestedWorkerJobId = url.searchParams.get('workerJobId');
      const requestedAgentRole = url.searchParams.get('role') ?? 'chat';
      const workerJob = requestedWorkerJobId
        ? candidateSession?.templateJobs.get(requestedWorkerJobId)
        : null;
      let audience;
      let resource;
      let profile;
      if (requestedWorkerJobId) {
        if (
          !workerJob
          || workerJob.status !== 'running'
          || requestedAgentRole !== workerJob.workerRole
        ) {
          const error = new Error('copy-layout worker identity mismatch');
          error.code = 'UNAUTHORIZED_SESSION';
          throw error;
        }
        audience = HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER;
        resource = workerJob.jobId;
        profile = 'copy-layout-worker';
      } else if (candidateSession?.agentSession?.providerCapabilityResource) {
        if (requestedAgentRole !== candidateSession.agentSession.providerRole) {
          const error = new Error('provider identity mismatch');
          error.code = 'UNAUTHORIZED_SESSION';
          throw error;
        }
        audience = HUB_CAPABILITY_AUDIENCES.MCP;
        resource = candidateSession.agentSession.providerCapabilityResource;
        profile = candidateSession.agentSession.planning.mcpEnvironment().RHWP_TOOL_PROFILE;
      } else {
        const error = new Error('no active provider session');
        error.code = 'UNAUTHORIZED_SESSION';
        throw error;
      }
      authenticateHttpSession(req, url, {
        audience,
        resource,
      });
      const authenticatedUrl = new URL(url);
      authenticatedUrl.searchParams.set('token', TOKEN);
      // Never trust a provider-supplied profile. The authenticated live
      // session/worker capability fixes the only catalog it may receive.
      authenticatedUrl.searchParams.set('profile', profile);
      const { status, body } = handlePiToolDefinitions({ url: authenticatedUrl, token: TOKEN });
      sendHttpJson(res, status, body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }).catch((error) => {
    const unauthorized = error?.code === 'UNAUTHORIZED' || error?.code === 'UNAUTHORIZED_SESSION';
    const invalidSession = error?.code === 'INVALID_SESSION_ID' || error instanceof URIError;
    if (unauthorized || invalidSession) {
      if (!res.headersSent) sendHttpJson(res, unauthorized ? 401 : 400, {
        status: 'error',
        error: { code: error?.code ?? 'INVALID_SESSION_ID', message: String(error.message) },
      });
      return;
    }
    log(`http request failed: ${error?.stack ?? error}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ status: 'error', message: 'Internal server error' }));
  });
});

// MCP provider frames stay tightly bounded. Studio additionally carries the
// 64 MiB document-snapshot payload as base64 (about 85.4 MiB on the wire), so
// it needs a separate authenticated transport budget.
const mcpWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
const studioWss = new WebSocketServer({ noServer: true, maxPayload: 88 * 1024 * 1024 });
function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

httpServer.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${hubPort || REQUESTED_PORT || 5175}`);
  } catch {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }
  const pathname = url.pathname;
  if (pathname !== '/studio' && pathname !== '/mcp') {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }
  // Origin 검증은 개발 모드에서도 한다 — 브라우저는 교차 출처 WS 업그레이드에
  // 항상 Origin 을 실어 보내므로, 웹페이지발 드라이바이 연결을 여기서 끊는다.
  // 프로덕션은 허용된 Studio 출처를 요구하고(무-Origin 도 거부), 개발 모드는
  // 비브라우저 클라이언트(CLI, 테스트)를 위해 Origin 이 없는 연결만 통과시킨다.
  {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (pathname === '/studio' && (PRODUCTION ? !isAllowedStudioOrigin(origin) : (origin && !isAllowedStudioOrigin(origin)))) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (pathname === '/mcp' && origin) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
  }
  const token = url.searchParams.get('token') ?? '';
  const sessionId = url.searchParams.get('sessionId');
  const requestedAgentRole = url.searchParams.get('role') ?? 'chat';
  const requestedWorkerJobId = pathname === '/mcp'
    ? url.searchParams.get('workerJobId')
    : null;
  const requestedAgent = pathname === '/mcp' ? url.searchParams.get('agent') : null;
  let record;
  let authenticatedWorkerJob = null;
  let authenticatedProviderIdentity = null;
  try {
    const audience = pathname === '/studio'
      ? HUB_CAPABILITY_AUDIENCES.STUDIO
      : requestedWorkerJobId
        ? HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER
        : HUB_CAPABILITY_AUDIENCES.MCP;
    let providerCapabilityResource;
    if (pathname === '/mcp' && !requestedWorkerJobId) {
      const candidateRecord = sessions.get(sessionId);
      const activeSession = candidateRecord?.agentSession;
      if (!activeSession?.providerCapabilityResource) {
        throw new Error('active provider identity required');
      }
      providerCapabilityResource = activeSession.providerCapabilityResource;
    }
    const authenticatedSessionId = sessions.authenticate({
      masterToken: TOKEN,
      token,
      sessionId,
      audience,
      ...(requestedWorkerJobId
        ? { resource: requestedWorkerJobId }
        : providerCapabilityResource
          ? { resource: providerCapabilityResource }
          : {}),
      allowMaster: !PRODUCTION,
    });
    record = sessions.require(authenticatedSessionId);
    if (requestedWorkerJobId) {
      authenticatedWorkerJob = record.templateJobs.get(requestedWorkerJobId);
      if (
        !authenticatedWorkerJob
        || authenticatedWorkerJob.status !== 'running'
        || requestedAgentRole !== authenticatedWorkerJob.workerRole
      ) {
        throw new Error('copy-layout worker identity mismatch');
      }
    } else if (requestedAgentRole.startsWith('copy-layout-worker:')) {
      throw new Error('copy-layout worker capability required');
    } else if (pathname === '/mcp') {
      const activeSession = record.agentSession;
      if (
        !activeSession
        || activeSession.providerCapabilityResource !== providerCapabilityResource
        || requestedAgent !== activeSession.agent
        || requestedAgentRole !== activeSession.providerRole
      ) {
        throw new Error('provider identity mismatch');
      }
      authenticatedProviderIdentity = Object.freeze({
        agent: activeSession.agent,
        role: activeSession.providerRole,
        generation: activeSession.generation,
      });
    }
  } catch {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }
  const wss = pathname === '/studio' ? studioWss : mcpWss;
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (pathname === '/studio') {
      // 페이지 로드마다 새로 발급되는 인스턴스 id — 같으면 같은 페이지의 WS 끊김,
      // 다르면(또는 없으면) 새로고침·다른 탭이라 이전 호출은 답을 받을 수 없다.
      const instanceId = url.searchParams.get('instance');
      const previousInstanceId = record.studioInstanceId;
      const replacing = record.studioSocket !== null;
      record.studioInstanceId = instanceId;
      clearStudioReattachGrace(record);
      if (replacing) {
        try { record.studioSocket.close(4000, 'replaced'); } catch {}
      }
      if (!instanceId || instanceId !== previousInstanceId) {
        failAllPendingCalls(record, replacing
          ? 'Studio connection was replaced by a new tab; the edit may still have applied — re-read with get_structure/get_text_range before retrying'
          : 'Studio reloaded while tool calls were in flight; the edit may still have applied — re-read with get_structure/get_text_range before retrying');
      }
      record.studioSocket = ws;
      attachSocket(record, ws, 'studio');
      // 소켓이 닫혔다고 곧바로 인플라이트 호출을 접지 않는다 — 스튜디오는 보통 250ms 안에
      // 같은 세션으로 돌아온다. 대신 유예 타이머를 걸어 돌아오지 않는 경우만 실패시킨다.
      ws.on('close', () => {
        if (record.studioSocket === ws) {
          record.studioSocket = null;
          record.pendingReferenceMessage = null;
          armStudioReattachGrace(record);
        }
      });
      // welcome이 유휴 세션 fallback을 만들기 전에 권위 있는 최종 결과를 먼저 보낸다.
      // 전송 실패 시 다음 재연결에서 다시 시도할 수 있도록 결과를 보존한다.
      replayMissedTurnEnd(record, ws, sendJson);
      sendJson(ws, {
        v: 1,
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        launchId: LAUNCH_ID,
        hubSessionId: record.sessionId,
        session: sessionInfo(record),
      });
      for (const authRun of authRuns.forSession(record.sessionId)) {
        sendJson(ws, {
          v: 1,
          type: 'agent-setup-progress',
          state: 'authorizing',
          replayed: true,
          ...authRun,
        });
      }
      sendJson(ws, {
        v: 1,
        type: 'agent-instructions',
        status: agentInstructionsStore.snapshot(),
        changedBy: 'system',
      });
      sendInstructionDraft(record, ws);
      const activeSession = record.agentSession;
      if (activeSession?.planning.latestPlan && activeSession.planning.phase === 'awaiting-approval') {
        sendJson(ws, {
          v: 1,
          type: 'plan-ready',
          planId: activeSession.planning.latestPlan.planId,
          plan: structuredClone(activeSession.planning.latestPlan.plan),
          ...activeSession.planning.snapshot(),
        });
      }
      const pendingUserQuestion = pendingUserQuestionSnapshot(record);
      if (pendingUserQuestion) {
        sendJson(ws, {
          v: 1,
          type: 'user-question-requested',
          interaction: pendingUserQuestion,
          replayed: true,
        });
      }
      void skillRegistry.list().then((catalog) => sendJson(ws, { v: 1, type: 'skills-catalog', ...catalog }));
      void writingStyleStore.status()
        .then((status) => sendJson(ws, { v: 1, type: 'writing-style-status', status }))
        .catch((e) => sendJson(ws, {
          v: 1, type: 'writing-style-error', code: e?.code ?? 'STYLE_STATUS_FAILED', message: String(e?.message ?? e),
        }));
      const calibration = record.styleCalibration;
      if (calibration) {
        sendJson(ws, calibration.progress ?? {
          v: 1, type: 'writing-style-progress',
          requestId: calibration.requestId, jobId: calibration.jobId,
          startedAt: calibration.startedAt, agent: calibration.agent, model: calibration.model,
          state: 'preparing', phase: 'preparing', activity: 'collecting-samples',
          detail: 'Preparing writing samples', completed: 0, total: 1,
        });
      }
      for (const job of record.templateJobs.values()) {
        if (job.status === 'running') {
          sendTemplateJobEvent(record, {
            type: 'task-start', agent: job.agent, taskId: job.jobId,
            title: '레이아웃 템플릿 자동 완성',
            taskKind: 'agent', background: true,
          });
          sendTemplateJobEvent(record, taskProgressForJob(job, job.activity));
        }
      }
      const cachedProviders = providerHealth.cached();
      if (cachedProviders) sendJson(ws, { v: 1, type: 'provider-status', providers: cachedProviders });
      void providerHealth.check().then((providers) => {
        if (providers !== cachedProviders) replyToStudio(record, ws, { v: 1, type: 'provider-status', providers });
      });
      sendJson(ws, { v: 1, type: 'pi-status', status: piStatus });
      void agentSetupStatuses(record.sessionId).then((statuses) => {
        replyToStudio(record, ws, { v: 1, type: 'agent-setup-status', statuses });
      });
      sendJson(ws, { v: 1, type: 'writing-style-catalog', ...writingStyleCatalog(record) });
      sendJson(ws, { v: 1, type: 'templates-catalog', ...templateStore.list() });
      sendJson(ws, { v: 1, type: 'usage-report', usage: usageSnapshot() });
      if (piStatus.keyConfigured && !openRouterCredits) {
        void refreshOpenRouterCredits(false)
          .then(() => replyToStudio(record, ws, { v: 1, type: 'usage-report', usage: usageSnapshot() }));
      }
      if (cliproxy.configured()) {
        void cliproxy.refresh(false).then((status) => {
          if (status.connected || status.error) replyToStudio(record, ws, { v: 1, type: 'usage-report', usage: usageSnapshot() });
        });
      }
      log(`studio connected (session=${record.sessionId})`);
      return;
    }

    const agentLabel = authenticatedWorkerJob?.agent ?? authenticatedProviderIdentity.agent;
    ws.agentLabel = agentLabel;
    ws.agentRole = authenticatedWorkerJob?.workerRole ?? authenticatedProviderIdentity.role;
    ws.agentGeneration = authenticatedWorkerJob ? null : authenticatedProviderIdentity.generation;
    ws.copyLayoutJobId = authenticatedWorkerJob?.jobId ?? null;
    ws.workflow = url.searchParams.get('workflow');
    ws.capabilityEpoch = url.searchParams.get('capabilityEpoch');
    record.mcpSockets.add(ws);
    attachSocket(record, ws, 'mcp');
    ws.on('close', () => {
      record.mcpSockets.delete(ws);
      if (record.pendingUserQuestion?.mcpSocket === ws) {
        settleUserQuestion(record, { status: 'expired', reason: 'provider-disconnected' });
      }
      for (const [hubId, entry] of record.pendingCalls) {
        if (entry.mcpSocket === ws) {
          clearTimeout(entry.timer);
          record.pendingCalls.delete(hubId);
        }
      }
      log(`mcp client disconnected (agent=${agentLabel}, session=${record.sessionId})`);
    });
    log(`mcp client connected (agent=${agentLabel}, session=${record.sessionId})`);
  });
});

httpServer.listen(REQUESTED_PORT, '127.0.0.1', () => {
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Hub did not receive a TCP port');
  hubPort = address.port;
  process.stdout.write(`RHWP_HUB_READY ${JSON.stringify({ port: hubPort, pid: process.pid, launchId: LAUNCH_ID })}\n`);
  log(`rhwp-agent hub listening on ws://127.0.0.1:${hubPort} (protocol v${PROTOCOL_VERSION})`);
  log('claude/codex/pi/grok/cursor can be installed and authenticated from Studio settings');
  scheduleHarnessUpdates(HARNESS_UPDATE_INITIAL_DELAY_MS);
});

httpServer.on('error', (err) => {
  log(`server error: ${err?.message ?? err}`);
  process.exitCode = 1;
});

let shutdownPromise = null;
let launchCleanupRetentionRequired = false;

function retainUncertainProcessCleanup(recordRoot) {
  launchCleanupRetentionRequired = true;
  try {
    retainLaunchRootForProcessCleanupSync(WORK_ROOT, { launchId: LAUNCH_ID });
  } catch (error) {
    log(`failed to persist process cleanup retention marker: ${error?.message ?? error}`);
  }
  log(`retaining session root after uncertain process cleanup: ${recordRoot}`);
}

async function disposeRecord(record, reason) {
  record.disposed = true;
  authRuns.cancelForSession(record.sessionId, reason);
  cancelCheckpointTitleJobs(record);
  if (record.pendingInstructionDraft?.expiryTimer) {
    clearTimeout(record.pendingInstructionDraft.expiryTimer);
  }
  record.pendingInstructionDraft = null;
  clearStudioReattachGrace(record);
  settleUserQuestion(record, { status: 'expired', reason: 'hub-restarted' });
  failAllPendingCalls(record, 'Hub session is shutting down');
  const backendExit = disposeSession(record);
  const templateBackendExits = [];
  for (const job of record.templateJobs.values()) {
    if (job.status === 'running') {
      job.status = 'failed';
      job.activity = reason;
    }
    const backend = job.backend;
    job.backend = null;
    if (!backend) continue;
    try {
      templateBackendExits.push(Promise.resolve(backend.dispose()).catch((error) => {
        log(`copy-layout worker exit wait failed: ${error?.message ?? error}`);
        return false;
      }));
    } catch (error) {
      log(`copy-layout worker dispose failed: ${error?.message ?? error}`);
      templateBackendExits.push(Promise.resolve(false));
    }
  }
  for (const sock of [record.studioSocket, ...record.mcpSockets]) {
    try { sock?.close(1001, reason); } catch {}
  }
  record.mcpSockets.clear();
  record.studioSocket = null;
  const cleanupResults = await Promise.allSettled([
    backendExit,
    ...templateBackendExits,
    stopAuxiliaryProcesses(record),
    record.browserbaseSession.cleanup(reason),
  ]);
  let processCleanupSettled = true;
  for (const result of cleanupResults) {
    if (result.status === 'rejected') {
      processCleanupSettled = false;
      log(`session cleanup failed: ${result.reason?.message ?? result.reason}`);
    } else if (result.value === false) {
      processCleanupSettled = false;
    }
  }
  if (!processCleanupSettled) {
    retainUncertainProcessCleanup(record.recordRoot);
    return false;
  }
  let credentialCopiesSettled = flushProviderCredentialHomes(record);
  for (const job of record.templateJobs.values()) {
    if (!flushProviderCredentialHomes(job.providerHomes)) credentialCopiesSettled = false;
  }
  // Another live record may own a WORK_ROOT journal. It must retain the launch
  // root at shutdown, but must not pin this already-flushed record (including
  // its hub-private downloads and snapshots).
  if (!credentialCopiesSettled || hasPendingCredentialCopybackSync(record.recordRoot)) {
    log(`retaining session root for pending credential copyback: ${record.recordRoot}`);
    return false;
  }
  await fs.rm(record.recordRoot, { recursive: true, force: true });
  return true;
}

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    clearInterval(stagedReferenceCleanupTimer);
    if (harnessUpdateTimer) clearTimeout(harnessUpdateTimer);
    if (ownerWatchdog) clearInterval(ownerWatchdog);
    log(`shutting down (${signal})`);
    await sessions.disposeAll((record) => disposeRecord(record, 'hub shutdown'));
    for (const wss of [studioWss, mcpWss]) {
      for (const sock of wss.clients) {
        try { sock.close(1001, 'server shutting down'); } catch {}
      }
    }
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    const ownedRoots = [
      process.env.RHWP_OWN_WORK_DIR === '1' ? WORK_ROOT : null,
      process.env.RHWP_OWN_RUNTIME_DIR === '1' ? RUNTIME_ROOT : null,
    ].filter(Boolean);
    await Promise.all(ownedRoots.map(async (root) => {
      if (root === WORK_ROOT
        && (launchCleanupRetentionRequired || hasPendingLaunchCleanupSync(root))) {
        log(`retaining owned work root for pending cleanup: ${root}`);
        return;
      }
      await fs.rm(root, { recursive: true, force: true });
    }));
  })();
  return shutdownPromise;
}

const ownerPid = Number(process.env.RHWP_OWNER_PID);
let ownerMissing = false;
let ownerMissingSince = null;
let orphanIdleSince = null;
function noteMissingOwner(reason = `owner process ${ownerPid} exited`) {
  if (!ownerMissing) {
    log(`${reason}; waiting for orphaned work to become idle`);
    ownerMissingSince = Date.now();
  }
  ownerMissing = true;
}
if (process.env.RHWP_OWNER_IPC === '1') {
  if (process.connected) {
    process.once('disconnect', () => noteMissingOwner('owner IPC channel closed'));
  } else {
    noteMissingOwner('required owner IPC channel was unavailable');
  }
}
const ownerWatchdog = Number.isSafeInteger(ownerPid) && ownerPid > 0
  ? setInterval(() => {
    if (!ownerMissing) {
      let alive = true;
      try {
        process.kill(ownerPid, 0);
      } catch (error) {
        if (error?.code !== 'EPERM') alive = false;
      }
      if (alive) return;
      noteMissingOwner();
    }
    if (Date.now() - ownerMissingSince >= ORPHAN_HARD_SHUTDOWN_MS) {
      void shutdown('owner exited and orphan deadline elapsed').finally(() => process.exit(0));
      return;
    }
    if (hasConnectedSessionSockets() || hasOrphanActiveWork()) {
      orphanIdleSince = null;
      return;
    }
    orphanIdleSince ??= Date.now();
    if (Date.now() - orphanIdleSince >= ORPHAN_IDLE_SHUTDOWN_MS) {
      void shutdown('owner exited and hub stayed idle').finally(() => process.exit(0));
    }
  }, 1_000)
  : null;
ownerWatchdog?.unref?.();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown(signal).finally(() => process.exit(0)); });
}
