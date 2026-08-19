import http from 'node:http';
import crypto from 'node:crypto';
import { mkdirSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { WebSocketServer } from 'ws';
import { createClaudeSession, prepareClaudeHome } from './agents/claude.mjs';
import { createCodexSession, prepareCodexHome } from './agents/codex.mjs';
import { createPiSession } from './agents/pi.mjs';
import { createGrokSession, prepareGrokHome } from './agents/grok.mjs';
import { createCursorSession, prepareCursorHome } from './agents/cursor.mjs';
import { generateChatTitle } from './agents/title.mjs';
import { SkillRegistry } from './skills.mjs';
import { generateSkillDraft } from './skill-generator.mjs';
import { WritingStyleStore, assertWritingStyleAppendCompatible } from './writing-style.mjs';
import { calibrateWritingStyle } from './style-calibrator.mjs';
import { buildWritingStyleCatalog, resolveWritingStyleSelection } from './writing-style-catalog.mjs';
import { TOOL_DEFINITIONS } from './tools.mjs';
import { replayMissedTurnEnd } from './turn-outcome-replay.mjs';
import { PlanningState, authorizeToolCall, buildApprovedPlanPrompt, workflowError } from './planning-state.mjs';
import { DownloadManager } from './download-manager.mjs';
import { BrowserbaseSession } from './browserbase-session.mjs';
import { createProviderHealth } from './provider-health.mjs';
import { createUsageStore } from './usage-store.mjs';
import { createCliproxyClient } from './cliproxy.mjs';
import { createPiManager, defaultPiRoot } from './pi-manager.mjs';
import { createCliSetupManager } from './cli-setup-manager.mjs';
import { createOpenRouter } from './openrouter.mjs';
import { createIpcSecretStore } from './secret-store.mjs';
import { handlePiToolDefinitions } from './pi/tool-schema.mjs';
import { resolveHwpExtractor } from './reference-extractor.mjs';
import { ReferenceStore } from './reference-store.mjs';
import { createReferenceHttpHandler, isAllowedStudioOrigin } from './reference-http.mjs';
import { assertMessageScope, referenceScopesForSession, resolveSessionIdentity } from './reference-session.mjs';
import { executeReferenceTool } from './reference-tools.mjs';
import { TemplateStore } from './template-store.mjs';
import { createTemplateHttpHandler } from './template-http.mjs';
import { z } from 'zod';
import { terminateProcessTree } from './process-tree.mjs';
import {
  authenticateHubSession,
  authenticateMasterToken,
  HubSessionRegistry,
  issueScopedHubToken,
  resolveHubIdentity,
} from './hub-session-registry.mjs';

const REQUESTED_PORT = Number(process.env.RHWP_AGENT_PORT ?? 5175);
const PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RHWP_AGENT_MODE === 'production';
const { token: TOKEN, development: DEVELOPMENT_AUTH, launchId: LAUNCH_ID } = resolveHubIdentity();
const PROTOCOL_VERSION = 3;
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
let hubPort = REQUESTED_PORT;
const STUDIO_TOOL_TIMEOUT_MS = 30_000;
const HARNESS_UPDATE_INITIAL_DELAY_MS = 8_000;
const HARNESS_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HARNESS_UPDATE_BUSY_RETRY_MS = 5 * 60 * 1000;
const HARNESS_UPDATE_FAILURE_RETRY_MS = 60 * 60 * 1000;
const toolDefinitionsByName = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
const sourceClaudeAuth = {
  credentialsPath: path.join(os.homedir(), '.claude', '.credentials.json'),
  configPath: path.join(os.homedir(), '.claude.json'),
};
const sourceCodexHomes = [...new Set([
  process.env.CODEX_HOME,
  path.join(os.homedir(), '.codex'),
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
const skillRegistry = await new SkillRegistry({ bundledRoot: BUNDLED_SKILLS, writingStyleStore }).init();
const PI_ROOT = defaultPiRoot();
const openRouter = createOpenRouter({ cacheDir: PI_ROOT });
const secretStore = createIpcSecretStore();
const piManager = await createPiManager({ rootDir: PI_ROOT, openRouter, secretStore }).init();
const cliSetup = await createCliSetupManager({ secretStore }).init();
// App-managed bins are available to auxiliary CLI calls as soon as installation completes.
process.env.PATH = `${cliSetup.binDir}${path.delimiter}${process.env.PATH ?? ''}`;
Object.assign(process.env, cliSetup.envFor('claude'));
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
/** OpenRouter 잔액. 키가 있을 때만 채워지고 사용량 리포트에 얹힌다. */
let openRouterCredits = null;
if (piStatus.installed) {
  // 저장소가 갱신되면 확장/스킬도 따라와야 한다 — 실패해도 허브는 그대로 뜬다.
  await piManager.syncAssets().catch((error) => log(`pi asset sync failed: ${error?.message ?? error}`));
}
const providerHealth = createProviderHealth({
  piBin: () => (piStatus.installed ? piManager.piBin : null),
  cliBin: (agent) => (cliSetupStatus[agent]?.installed ? cliSetup.binPath(agent) : null),
  // cursor-agent 는 CONFIG_DIR 재지정 없이 --version 만 실행해도 실제
  // ~/.cursor/projects/ 에 디렉터리를 만든다 — 프로브를 관리형 홈으로 돌린다.
  probeEnv: (agent) => (agent === 'cursor'
    ? {
      ...process.env,
      HOME: cliSetup.cursorHomeDir,
      CURSOR_CONFIG_DIR: path.join(cliSetup.cursorHomeDir, '.cursor-probe'),
    }
    : undefined),
});
const usageStore = await createUsageStore().init();
const cliproxy = await createCliproxyClient({ rootDir: usageStore.rootDir }).init();
const referenceStore = await new ReferenceStore({ projectRoot: ROOT }).init();
const templateStore = await new TemplateStore().init();
// .hwp/.hwpx/.hml 텍스트 추출은 rhwp 바이너리에 기댄다 — 없으면 첫 업로드가 아니라 기동 시점에 알린다.
if (!(await resolveHwpExtractor(ROOT))) {
  log('hwp/hwpx text extraction unavailable: build target/release/rhwp, install rhwp on PATH, or set RHWP_BIN');
}
const stagedReferenceCleanupTimer = setInterval(() => {
  void referenceStore.cleanupStaged().catch((error) => log(`staged reference cleanup failed: ${error?.message ?? error}`));
}, 15 * 60 * 1000);
stagedReferenceCleanupTimer.unref?.();
let writingStyleCalibrationOwner = null;
const sessions = new HubSessionRegistry({
  createRecord(sessionId) {
    const recordKey = `${crypto.createHash('sha256').update(sessionId).digest('hex')}-${crypto.randomUUID()}`;
    const recordRoot = path.join(RECORDS_ROOT, recordKey);
    const workDir = path.join(recordRoot, 'work');
    const isolatedHome = path.join(recordRoot, 'home');
    const codexHome = path.join(isolatedHome, '.codex');
    const grokHome = path.join(isolatedHome, '.grok');
    const cursorHome = path.join(isolatedHome, '.cursor');
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    prepareCodexHome(codexHome, sourceCodexAuthPath);
    prepareClaudeHome(isolatedHome, sourceClaudeAuth);
    prepareGrokHome(grokHome, sourceGrokAuthPath);
    prepareCursorHome(cursorHome, cliSetup.cursorSourceDir);
    return {
      sessionId,
      disposed: false,
      createdAt: Date.now(),
      lastConnectedAt: Date.now(),
      studioSocket: null,
      mcpSockets: new Set(),
      studioMessageQueue: Promise.resolve(),
      agentSession: null,
      pendingReferenceMessage: null,
      nextCapabilityEpoch: 1,
      pendingCalls: new Map(),
      nextHubId: 1,
      sessionGeneration: 0,
      missedTurnEnd: null,
      styleCalibration: null,
      auxiliaryProcesses: new Set(),
      browserbaseSession: new BrowserbaseSession({ log }),
      downloadManager: new DownloadManager({ rootDir: workDir }),
      recordRoot,
      workDir,
      isolatedHome,
      codexHome,
      grokHome,
      cursorHome,
    };
  },
});

function hasAgentSessions() {
  return [...sessions.values()].some((record) => record.agentSession !== null);
}

function broadcastToStudios(message) {
  for (const record of sessions.values()) sendJson(record.studioSocket, message);
}

function refreshSessionCredentials(agent) {
  for (const record of sessions.values()) {
    if (agent === 'codex') prepareCodexHome(record.codexHome, sourceCodexAuthPath);
    if (agent === 'claude') prepareClaudeHome(record.isolatedHome, sourceClaudeAuth);
    if (agent === 'grok') prepareGrokHome(record.grokHome, sourceGrokAuthPath);
    if (agent === 'cursor') prepareCursorHome(record.cursorHome, cliSetup.cursorSourceDir);
  }
}

/** CLI 설치·인증을 cli-setup-manager 가 관리하는 에이전트들. */
const CLI_SETUP_AGENTS = ['claude', 'codex', 'grok', 'cursor'];
const KNOWN_AGENTS = new Set([...CLI_SETUP_AGENTS, 'pi']);

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
  grok: createGrokSession,
  cursor: createCursorSession,
};

function unknownAgentError(agent) {
  return Object.assign(new Error(`unknown agent: ${String(agent)}`), { code: 'INVALID_REQUEST' });
}

/** pi 모델은 사용자가 고른 것뿐이다 — 정적 목록이 아니라 캐시된 상태에서 찾는다. */
function piModelConfig(id) {
  return piStatus.models.find((model) => model.id === id) ?? null;
}

async function refreshPiStatus() {
  piStatus = await piManager.status();
  return piStatus;
}

function piAgentSetupStatus() {
  return {
    agent: 'pi',
    installed: piStatus.installed,
    available: piStatus.installed,
    installing: piStatus.installing,
    version: piStatus.version,
    authenticated: piStatus.keyConfigured,
    authMethod: piStatus.keyConfigured ? 'api-key' : null,
    keyTail: piStatus.keyTail,
    authenticating: false,
    setupComplete: piStatus.setupComplete,
    connected: piStatus.setupComplete,
    latestVersion: piStatus.latestVersion ?? null,
    updateRequired: piStatus.updateRequired === true,
    error: piStatus.error,
  };
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

async function agentSetupStatuses() {
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
  return { claude, codex, grok, cursor, pi: piAgentSetupStatus() };
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
    piStatus = await piManager.automaticUpdate({ canActivate });
    const statuses = await agentSetupStatuses();
    if (Object.values(statuses).some((status) => status.updateRequired)) {
      nextDelay = HARNESS_UPDATE_FAILURE_RETRY_MS;
    }
    broadcastToStudios({ v: 1, type: 'agent-setup-status', statuses });
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
      broadcastToStudios({ v: 1, type: 'agent-setup-status', statuses });
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

function resolveModel(agent, requested) {
  if (agent === 'pi') {
    if (typeof requested === 'string' && piModelConfig(requested)) return requested;
    if (piStatus.defaultModelId && piModelConfig(piStatus.defaultModelId)) return piStatus.defaultModelId;
    return piStatus.models[0]?.id ?? null;
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
  if (agent === 'pi') {
    // 추론을 지원하지 않는 모델은 effort 자체가 없다 — 붙이면 요청이 거부된다.
    const efforts = piModelConfig(model)?.efforts ?? [];
    if (efforts.length === 0) return null;
    if (typeof requested === 'string' && efforts.includes(requested)) return requested;
    const preferred = piModelConfig(model)?.defaultEffort;
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
// 스튜디오 소켓이 닫히거나 새 탭 연결에 밀려나면 인플라이트 호출은 영원히 응답받지 못한다 —
// 30초 타임아웃까지 기다리지 말고 즉시 NO_STUDIO 로 실패시킨다.
function failAllPendingCalls(record, message) {
  for (const [hubId, entry] of record.pendingCalls) {
    clearTimeout(entry.timer);
    record.pendingCalls.delete(hubId);
    sendJson(entry.mcpSocket, {
      v: 1, type: 'tool-result', id: entry.clientId, ok: false,
      error: { code: 'NO_STUDIO', message },
    });
  }
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
  return usage;
}

/** 잔액 조회는 5분 캐시된다 — refresh 일 때만 실제로 다시 부른다. */
async function refreshOpenRouterCredits(refresh = false) {
  if (!piStatus.keyConfigured) {
    openRouterCredits = null;
    return;
  }
  try {
    openRouterCredits = await piManager.credits(refresh === true);
  } catch (error) {
    openRouterCredits = {
      balanceUsd: 0,
      totalCreditsUsd: 0,
      totalUsageUsd: 0,
      checkedAt: Date.now(),
      error: String(error?.message ?? error),
    };
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
  const forget = () => record.auxiliaryProcesses.delete(child);
  child.once('exit', forget);
  child.once('close', forget);
  return child;
}

async function stopAuxiliaryProcesses(record) {
  const children = [...record.auxiliaryProcesses];
  record.auxiliaryProcesses.clear();
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 3_500);
    timer.unref?.();
    child.once('exit', finish);
    terminateProcessTree(child);
  })));
}

function auxDeps(record, requestedAgent, cliAgent) {
  const agent = requestedAgent === 'pi' || requestedAgent === 'claude' || requestedAgent === 'codex'
    ? requestedAgent
    : (record.agentSession?.agent ?? null);
  const health = providerHealth.cached();
  // 프로브 전이면 CLI 가 있다고 보고 기존 경로를 먼저 태운다.
  const cliAvailable = health ? health[cliAgent]?.available !== false : true;
  return {
    useOpenRouter: piStatus.setupComplete && (agent === 'pi' || !cliAvailable),
    piManager,
    openRouter,
    workDir: record.workDir,
    cwd: record.workDir,
    isolatedHome: record.isolatedHome,
    sessionId: record.sessionId,
    spawnProcess: (command, args, options) => spawnAuxiliaryProcess(record, command, args, options),
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
      sessionId: activeSession.sessionId,
      threadId: activeSession.threadId,
      documentId: activeSession.documentId,
      documentName: activeSession.documentName,
      status: activeSession.status,
      activeTemplateId: activeSession.activeTemplateId,
      ...activeSession.planning.snapshot(),
    }
    : null;
}

function makeBackendEventHandler(record, generation) {
  return (evt) => {
    const activeSession = record.agentSession;
    if (!activeSession || activeSession.generation !== generation) return;
    if (evt.type === 'session-info' && evt.sessionId) activeSession.sessionId = evt.sessionId;
    if (evt.type === 'usage') {
      usageStore.record({
        agent: activeSession.agent, model: evt.model, costUsd: evt.costUsd, ...(evt.usage ?? {}),
      });
      sendJson(record.studioSocket, { v: 1, type: 'usage-report', usage: usageSnapshot() });
      return;
    }
    if (evt.type === 'turn-start') record.missedTurnEnd = null;
    if (evt.type === 'turn-end') activeSession.status = 'idle';
    const delivered = sendJson(record.studioSocket, { v: 1, type: 'agent-event', event: evt });
    if (evt.type === 'turn-end' && !delivered) record.missedTurnEnd = evt;
  };
}

function disposeSession(record) {
  record.pendingReferenceMessage = null;
  const activeSession = record.agentSession;
  if (!activeSession) return Promise.resolve();
  const wasRunning = activeSession.status === 'running';
  const agent = activeSession.agent;
  let backendExit = Promise.resolve();
  try {
    backendExit = Promise.resolve(activeSession.backend.dispose());
  } catch (e) {
    log(`session dispose error: ${e?.message ?? e}`);
  }
  record.agentSession = null;
  void record.browserbaseSession.cleanup('session disposed');
  if (wasRunning) {
    const evt = { type: 'turn-end', agent, stopReason: 'interrupted' };
    if (!sendJson(record.studioSocket, { v: 1, type: 'agent-event', event: evt })) {
      record.missedTurnEnd = evt;
    }
  }
  return backendExit.catch((error) => {
    log(`session process exit wait failed: ${error?.message ?? error}`);
  });
}

function resolvePermissionProfile(value) {
  return value === 'unrestricted' ? 'unrestricted' : 'safe';
}

function resolveWorkflow(value) {
  return value === 'plan' ? 'plan' : 'direct';
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
    void requestImplementationPlanChanges(record, sock, { planId, feedback: msg.text })
      .catch((error) => sendChatError(sock, error));
    return;
  }
  if (activeSession.planning.phase === 'switching') {
    sendJson(sock, { v: 1, type: 'chat-error', code: 'WORKFLOW_SWITCHING', message: 'The provider is switching into implementation mode.' });
    return;
  }
  activeSession.status = 'running';
  void skillRegistry.promptContext(msg.text, typeof msg.skillName === 'string' ? msg.skillName : undefined, {
    phase: activeSession.planning.snapshot().phase,
  })
    .then((prompt) => {
      if (record.agentSession !== activeSession) throw new Error('Agent session changed before the message was dispatched');
      activeSession.backend.sendUserMessage(addReopenedChatHistory(
        activeSession,
        addTemplateContext(
          record,
          activeSession,
          addReferenceContext(activeSession, msg.text, prompt, messageAttachments),
        ),
      ));
    })
    .catch((e) => {
      if (record.agentSession === activeSession) activeSession.status = 'idle';
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
) {
  const model = resolveModel(agent, requestedModel);
  const effort = resolveEffort(agent, model, requestedEffort);
  const permissionProfile = resolvePermissionProfile(requestedPermission);
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
    && currentSession.planning.workflow === workflow
    && currentSession.threadId === threadId
    && currentSession.documentId === documentId
  ) {
    currentSession.documentName = documentName;
    return currentSession;
  }
  await disposeSession(record);
  const planning = new PlanningState({
    workflow,
    initialCapabilityEpoch: record.nextCapabilityEpoch++,
    allocateEpoch: () => record.nextCapabilityEpoch++,
  });
  const generation = ++record.sessionGeneration;
  const opts = {
    rootDir: record.workDir,
    workDir: record.workDir,
    mcpScriptPath: MCP_SCRIPT,
    hubPort,
    token: issueScopedHubToken(TOKEN, record.sessionId),
    sessionId: record.sessionId,
    model,
    effort,
    permissionProfile,
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
    providerEnv: CLI_SETUP_AGENTS.includes(agent) ? cliSetup.envFor(agent) : {},
    onEvent: makeBackendEventHandler(record, generation),
    workflow,
    phase: workflow === 'direct' ? 'implementing' : planning.phase,
    capabilityEpoch: planning.capabilityEpoch,
    toolProfile: planning.mcpEnvironment().RHWP_TOOL_PROFILE,
    mcpEnvironment: planning.mcpEnvironment(),
    // pi 전용 — 설치 경로와 영속 루트, 그리고 선택한 모델의 추론 지원 여부.
    piBin: piManager.piBin,
    piRoot: piManager.rootDir,
    openRouterApiKey: agent === 'pi' ? piManager.apiKey() : undefined,
    reasoning: agent === 'pi' ? Boolean(piModelConfig(model)?.reasoning) : false,
  };
  const createBackend = SESSION_FACTORIES[agent];
  if (!createBackend) throw unknownAgentError(agent);
  const backend = createBackend(opts);
  record.agentSession = {
    agent,
    model,
    effort,
    permissionProfile,
    backend,
    generation,
    status: 'idle',
    sessionId: backend.getSessionId(),
    threadId,
    documentId,
    documentName,
    // Legacy download/browser code uses chatId. It is now the stable Studio
    // thread identity rather than an unrelated hub-generated UUID.
    chatId: threadId,
    activeTemplateId: null,
    bootstrapHistory: normalizeChatHistory(requestedHistory),
    planning,
    workflowTransition: Promise.resolve(),
  };
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
    activeSession.status = 'running';
    const approvedPrompt = buildApprovedPlanPrompt(transition.approvedPlan);
    activeSession.backend.sendUserMessage(addTemplateContext(
      record,
      activeSession,
      addReferenceContext(
        activeSession,
        JSON.stringify(transition.approvedPlan.plan),
        approvedPrompt,
      ),
    ));
  } catch (error) {
    if (record.agentSession === activeSession && activeSession.planning.phase === 'switching') {
      activeSession.planning.failSwitch(transition.approvedPlan.planId);
      activeSession.status = 'idle';
      emitWorkflowState(record, { reason: 'provider-switch-failed' });
    }
    sendChatError(sock, error, 'BACKEND_SWITCH_FAILED');
  }
}

async function requestImplementationPlanChanges(record, sock, msg) {
  const activeSession = record.agentSession;
  if (!activeSession) throw workflowError('AGENT_NOT_STARTED', 'Start a chat before requesting plan changes');
  requireWorkflowSwitchBackend(activeSession);
  activeSession.planning.requestChanges({
    planId: String(msg.planId ?? ''),
    sessionStatus: activeSession.status,
  });
  sendJson(sock, {
    v: 1,
    type: 'plan-invalidated',
    planId: String(msg.planId ?? ''),
    reason: typeof msg.feedback === 'string' ? msg.feedback : 'changes-requested',
    ...activeSession.planning.snapshot(),
    latestPlan: null,
  });
  try {
    await activeSession.backend.setExecutionMode(providerModeRequest(activeSession, 'planning'));
    if (record.agentSession !== activeSession) return;
    if (typeof msg.feedback === 'string' && msg.feedback.trim()) {
      activeSession.status = 'running';
      const revisionPrompt = [
        'The user requested changes, so the previous implementation plan is no longer authoritative.',
        'Return to discovery: inspect the affected current state and evaluate the feedback. If it is ambiguous or changes an assumption, discuss it with the user and ask one focused question in normal chat instead of immediately presenting a replacement. If it is already concrete, do not invent a question; follow the planning checkpoint and presentation rules before presenting a complete replacement.',
        `Feedback: ${msg.feedback.trim()}`,
      ].join('\n\n');
      activeSession.backend.sendUserMessage(addTemplateContext(
        record,
        activeSession,
        addReferenceContext(activeSession, msg.feedback, revisionPrompt),
      ));
    }
  } catch (error) {
    if (record.agentSession === activeSession) activeSession.status = 'idle';
    sendChatError(sock, error, 'BACKEND_SWITCH_FAILED');
  }
}

async function setChatWorkflow(record, sock, msg) {
  if (msg.workflow !== 'direct' && msg.workflow !== 'plan') {
    throw workflowError('INVALID_WORKFLOW', `Unknown workflow: ${String(msg.workflow)}`);
  }
  const activeSession = record.agentSession;
  if (!activeSession) {
    sendJson(sock, {
      v: 1,
      type: 'workflow-changed',
      workflow: msg.workflow,
      phase: msg.workflow === 'plan' ? 'planning' : 'direct',
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
  const nextPlanning = new PlanningState({
    workflow: msg.workflow,
    initialCapabilityEpoch: record.nextCapabilityEpoch++,
    allocateEpoch: () => record.nextCapabilityEpoch++,
  });
  const phase = msg.workflow === 'plan' ? 'planning' : 'implementing';
  await activeSession.backend.setExecutionMode({
    workflow: msg.workflow,
    phase,
    capabilityEpoch: nextPlanning.capabilityEpoch,
  });
  if (record.agentSession !== activeSession) return;
  activeSession.planning = nextPlanning;
  if (msg.workflow === 'direct') void record.browserbaseSession.cleanup('workflow changed to direct');
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
      const agent = msg.agent;
      if (!KNOWN_AGENTS.has(agent)) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REQUEST', message: `unknown agent: ${String(agent)}` });
        return;
      }
      // 설정이 끝나지 않은 pi 로는 세션을 열지 않는다 — 살아 있는 세션도 건드리지 않는다.
      if (agent === 'pi' && !piStatus.setupComplete) {
        sendJson(sock, {
          v: 1, type: 'chat-error', code: 'PI_NOT_CONFIGURED',
          message: 'Pi 설정을 먼저 끝내 주세요 (설치 · OpenRouter 키 · 모델 선택).',
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
        );
        sendJson(sock, {
          v: 1,
          type: 'chat-started',
          agent: s.agent,
          model: s.model,
          effort: s.effort,
          permissionProfile: s.permissionProfile,
          sessionId: s.sessionId,
          threadId: s.threadId,
          documentId: s.documentId,
          documentName: s.documentName,
          ...s.planning.snapshot(),
        });
      } catch (e) {
        await disposeSession(record);
        sendJson(sock, { v: 1, type: 'chat-error', code: e?.code ?? 'AGENT_SPAWN_FAILED', message: String(e?.message ?? e) });
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
    case 'chat-user-message': {
      if (!record.agentSession) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'No agent session; send chat-start first.' });
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
    case 'chat-permission-set': {
      if (!record.agentSession) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'Start a chat before changing permissions.' });
        return;
      }
      if (record.agentSession.status === 'running') {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_BUSY', message: 'Permissions can only change between turns.' });
        return;
      }
      const profile = resolvePermissionProfile(msg.permissionProfile);
      try {
        record.agentSession.backend.setPermissionProfile(profile);
        record.agentSession.permissionProfile = profile;
        sendJson(sock, { v: 1, type: 'chat-permission-changed', permissionProfile: profile });
      } catch (e) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'PERMISSION_CHANGE_FAILED', message: String(e?.message ?? e) });
      }
      return;
    }
    case 'chat-workflow-set': {
      const transitionOwner = record.agentSession;
      if (!transitionOwner) {
        void setChatWorkflow(record, sock, msg).catch((error) => sendChatError(sock, error));
        return;
      }
      const transition = transitionOwner.workflowTransition.then(() => {
        if (record.agentSession !== transitionOwner) return undefined;
        return setChatWorkflow(record, sock, msg);
      });
      transitionOwner.workflowTransition = transition.catch(() => undefined);
      void transition.catch((error) => sendChatError(sock, error));
      return;
    }
    case 'chat-plan-approve':
    case 'implementation-plan-approve':
    case 'plan-approve': {
      void approveImplementationPlan(record, sock, msg).catch((error) => sendChatError(sock, error));
      return;
    }
    case 'chat-plan-request-changes':
    case 'implementation-plan-request-changes':
    case 'plan-request-changes': {
      void requestImplementationPlanChanges(record, sock, msg).catch((error) => sendChatError(sock, error));
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
      void agentSetupStatuses()
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
        ? piManager.install(progress).then((status) => { piStatus = status; })
        : cliSetup.install(agent, progress).then((status) => { cliSetupStatus[agent] = status; });
      void installing
        .then(agentSetupStatuses)
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
      let authUrl = null;
      let run;
      if (agent === 'pi' && method === 'oauth') {
        const callbackUrl = `http://127.0.0.1:${hubPort}/oauth/openrouter/callback`;
        authUrl = piManager.beginOAuth(callbackUrl).authUrl;
        run = Promise.resolve(null);
      } else if (agent === 'pi') {
        run = piManager.setApiKey(String(msg.key ?? '')).then((status) => { piStatus = status; });
      } else {
        run = cliSetup.authenticate(agent, method, msg.key, (entry) => replyToStudio(record, sock, {
          v: 1,
          type: 'agent-setup-progress',
          agent,
          state: entry.state,
          ...(entry.authUrl ? { authUrl: entry.authUrl } : {}),
          ...(entry.userCode ? { userCode: entry.userCode } : {}),
        })).then(async (status) => {
          cliSetupStatus[agent] = status;
          if (agent === 'codex') {
            sourceCodexAuthPath = await findSourceCodexAuthPath();
          }
          if (agent === 'grok') {
            sourceGrokAuthPath = (await cliSetup.grokAuthPath()) ?? undefined;
          }
          refreshSessionCredentials(agent);
        });
      }
      replyToStudio(record, sock, { v: 1, type: 'agent-setup-auth-started', requestId, agent, ...(authUrl ? { authUrl } : {}) });
      if (authUrl) {
        replyToStudio(record, sock, { v: 1, type: 'agent-setup-progress', agent, state: 'authorizing', authUrl });
        return;
      }
      void run
        .then(agentSetupStatuses)
        .then((statuses) => {
          replyToStudio(record, sock, { v: 1, type: 'agent-setup-status', statuses });
          if (agent === 'pi') replyToStudio(record, sock, { v: 1, type: 'pi-status', status: piStatus });
          void providerHealth.check(true).then((providers) => replyToStudio(record, sock, { v: 1, type: 'provider-status', providers }));
        })
        .catch((e) => {
          // 사용자가 스스로 취소한 로그인은 오류 카드 대신 새 상태만 보낸다.
          if (e?.code === 'AGENT_AUTH_CANCELLED') {
            void agentSetupStatuses().then((statuses) => replyToStudio(record, sock, { v: 1, type: 'agent-setup-status', statuses }));
            return;
          }
          sendAgentSetupError(record, sock, null, agent, e, 'AGENT_AUTH_FAILED');
        });
      return;
    }
    case 'agent-setup-auth-code': {
      const agent = msg.agent;
      if (agent !== 'claude' && agent !== 'codex') {
        sendAgentSetupError(record, sock, null, null, new Error('인증 코드 요청을 확인하지 못했어요.'));
        return;
      }
      void cliSetup.submitAuthCode(agent, msg.code)
        .catch((e) => sendAgentSetupError(record, sock, null, agent, e, 'AGENT_AUTH_FAILED'));
      return;
    }
    case 'agent-setup-cancel': {
      const agent = msg.agent;
      if (agent === 'pi') void piManager.cancelSetup();
      else if (CLI_SETUP_AGENTS.includes(agent)) void cliSetup.cancel(agent);
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
      void piManager.install((progress) => replyToStudio(record, sock, {
        v: 1,
        type: 'pi-setup-progress',
        requestId,
        state: progress.state,
        ...(Number.isFinite(progress.percent) ? { percent: progress.percent } : {}),
        ...(progress.detail ? { detail: progress.detail } : {}),
        ...(Number.isFinite(progress.receivedBytes) ? { receivedBytes: progress.receivedBytes } : {}),
        ...(Number.isFinite(progress.totalBytes) ? { totalBytes: progress.totalBytes } : {}),
        ...(progress.activity === true ? { activity: true } : {}),
      }))
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
              useOpenRouter: selection.agent === 'pi',
              piManager,
              openRouter,
              projectRoot: ROOT,
              workDir: record.workDir,
              isolatedHome: record.isolatedHome,
              sessionId: record.sessionId,
              spawnProcess: (command, args, options) => spawnAuxiliaryProcess(record, command, args, options),
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
        try {
          record.agentSession.backend.interrupt();
        } catch (e) {
          log(`interrupt error: ${e?.message ?? e}`);
        }
        record.agentSession.status = 'idle';
      }
      return;
    }
    case 'chat-stop': {
      await disposeSession(record);
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
      if (entry.mcpSocket.readyState !== entry.mcpSocket.OPEN) return;
      if (msg.ok) {
        sendJson(entry.mcpSocket, { v: 1, type: 'tool-result', id: entry.clientId, ok: true, result: msg.result });
      } else {
        sendJson(entry.mcpSocket, {
          v: 1, type: 'tool-result', id: entry.clientId, ok: false,
          error: msg.error ?? { code: 'RPC_ERROR', message: 'unknown studio error' },
        });
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
      try {
        const schema = z.object(definition.shape);
        args = (tool === 'insert_image' ? schema.passthrough() : schema.strict()).parse(msg.args ?? {});
        definition.validate?.(args);
        if (!record.agentSession && tool !== 'read_product_skill') {
          throw workflowError('AGENT_NOT_STARTED', 'No active chat session');
        }
        if (record.agentSession) {
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
      if (definition.category === 'browser') {
        const sidecarTool = tool.replace(/^browserbase_/, '');
        void record.browserbaseSession.call(record.agentSession.chatId, sidecarTool, args)
          .then(sendResult)
          .catch((error) => sendError(error, 'BROWSERBASE_TOOL_FAILED'));
        return;
      }
      if (!record.studioSocket || record.studioSocket.readyState !== record.studioSocket.OPEN) {
        sendError(workflowError('NO_STUDIO', 'Studio is not connected; open rhwp-studio in a browser'));
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
      const timer = setTimeout(() => {
        record.pendingCalls.delete(hubId);
        sendJson(sock, {
          v: 1, type: 'tool-result', id: clientId, ok: false,
          error: { code: 'STUDIO_TIMEOUT', message: `Studio did not answer within ${STUDIO_TOOL_TIMEOUT_MS / 1000}s — the edit may still have applied; re-read with get_structure/get_text_range before retrying to avoid duplicates` },
        });
      }, STUDIO_TOOL_TIMEOUT_MS);
      record.pendingCalls.set(hubId, { mcpSocket: sock, clientId, timer });
      sendJson(record.studioSocket, {
        v: 1, type: 'tool-request', id: hubId,
        // 호출을 보낸 MCP 소켓의 에이전트 라벨을 단다 — 현재 세션 기준으로 찍으면
        // 세션 교체 직후 남은 호출이 엉뚱한 에이전트로 기록될 수 있다.
        agent: sock.agentLabel ?? record.agentSession?.agent ?? 'claude',
        tool,
        args,
        ...(activeTemplate ? { template: activeTemplate } : {}),
        phase: record.agentSession?.planning.snapshot().phase,
        capabilityEpoch: record.agentSession?.planning.capabilityEpoch,
      });
      return;
    }
    default:
      log(`ignoring unknown mcp message type: ${String(msg.type)}`);
  }
}

function attachSocket(record, sock, role) {
  sock.on('message', async (data, isBinary) => {
    if (record.disposed) {
      try { sock.close(1001, 'hub session closed'); } catch {}
      return;
    }
    if (isBinary) {
      sock.close(4400, 'binary frames not supported');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sock.close(4400, 'malformed JSON');
      return;
    }
    if (msg?.v !== PROTOCOL_VERSION) {
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
          });
      } else {
        handleMcpMessage(record, sock, msg);
      }
    } catch (e) {
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

function authenticateHttpSession(req, url) {
  return authenticateHubSession({
    masterToken: TOKEN,
    token: requestToken(req, url),
    sessionId: url.searchParams.get('sessionId'),
    allowMaster: !PRODUCTION,
  });
}

function authenticateOwnerRequest(req, url) {
  authenticateMasterToken(TOKEN, requestToken(req, url));
  if (String(req.headers['x-rhwp-launch-id'] ?? '') !== LAUNCH_ID) {
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

const httpServer = http.createServer((req, res) => {
  void Promise.resolve().then(async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${hubPort || REQUESTED_PORT || 5175}`);
    if (isReferencePath(url.pathname) || isTemplatePath(url.pathname)) {
      if (req.method !== 'OPTIONS') {
        const sessionId = authenticateHttpSession(req, url);
        sessions.getOrCreate(sessionId);
      }
      const suppliedToken = requestToken(req, url);
      if (isReferencePath(url.pathname)) {
        const handleReferenceHttp = createReferenceHttpHandler({ store: referenceStore, token: suppliedToken });
        if (await handleReferenceHttp(req, res, url)) return;
      }
      if (isTemplatePath(url.pathname)) {
        const handleTemplateHttp = createTemplateHttpHandler({
          store: templateStore,
          token: suppliedToken,
          onChanged: broadcastTemplateCatalog,
        });
        if (await handleTemplateHttp(req, res, url)) return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/oauth/openrouter/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><p>OpenRouter login did not return a code.</p>');
        return;
      }
      try {
        piStatus = await piManager.completeOAuth(code, state);
        const statuses = await agentSetupStatuses();
        broadcastToStudios({ v: 1, type: 'agent-setup-status', statuses });
        broadcastToStudios({ v: 1, type: 'pi-status', status: piStatus });
        void refreshOpenRouterCredits(true).then(() => {
          broadcastToStudios({ v: 1, type: 'usage-report', usage: usageSnapshot() });
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><style>body{font:16px system-ui;margin:48px;color:#202124}</style><h1>OpenRouter connected</h1><p>You can return to Rauhwpx and close this tab.</p>');
      } catch (error) {
        broadcastToStudios({
          v: 1,
          type: 'agent-setup-error',
          requestId: null,
          agent: 'pi',
          code: error?.code ?? 'OPENROUTER_OAUTH_FAILED',
          message: String(error?.message ?? error),
        });
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><p>OpenRouter login could not be completed. Return to Rauhwpx and try again.</p>');
      }
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
      if (!(DEVELOPMENT_AUTH && !token)) authenticateMasterToken(TOKEN, token);
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
      const allowOrigin = origin && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(origin)
        ? origin
        : null;
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...(allowOrigin ? { 'access-control-allow-origin': allowOrigin, vary: 'Origin' } : {}),
      });
      res.end(JSON.stringify(healthzBody()));
      return;
    }
    // pi extension requests a shared catalog with its signed session credential.
    if (req.method === 'GET' && url.pathname === '/pi/tool-definitions') {
      authenticateHttpSession(req, url);
      const authenticatedUrl = new URL(url);
      authenticatedUrl.searchParams.set('token', TOKEN);
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

const wss = new WebSocketServer({ noServer: true });

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
  if (PRODUCTION) {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (pathname === '/studio' && !isAllowedStudioOrigin(origin)) {
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
  let record;
  try {
    const authenticatedSessionId = authenticateHubSession({
      masterToken: TOKEN,
      token,
      sessionId,
      allowMaster: !PRODUCTION,
    });
    record = sessions.getOrCreate(authenticatedSessionId);
  } catch {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (pathname === '/studio') {
      if (record.studioSocket) {
        failAllPendingCalls(record, 'Studio connection was replaced by a new tab; the edit may still have applied — re-read with get_structure/get_text_range before retrying');
        try { record.studioSocket.close(4000, 'replaced'); } catch {}
      }
      record.studioSocket = ws;
      attachSocket(record, ws, 'studio');
      ws.on('close', () => {
        if (record.studioSocket === ws) {
          record.studioSocket = null;
          record.pendingReferenceMessage = null;
          failAllPendingCalls(record, 'Studio disconnected while tool calls were in flight; the edit may still have applied — re-read with get_structure/get_text_range before retrying');
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
      const cachedProviders = providerHealth.cached();
      if (cachedProviders) sendJson(ws, { v: 1, type: 'provider-status', providers: cachedProviders });
      void providerHealth.check().then((providers) => {
        if (providers !== cachedProviders) replyToStudio(record, ws, { v: 1, type: 'provider-status', providers });
      });
      sendJson(ws, { v: 1, type: 'pi-status', status: piStatus });
      void agentSetupStatuses().then((statuses) => {
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

    const agentLabel = url.searchParams.get('agent') ?? 'unknown';
    ws.agentLabel = url.searchParams.get('agent');
    ws.workflow = url.searchParams.get('workflow');
    ws.capabilityEpoch = url.searchParams.get('capabilityEpoch');
    record.mcpSockets.add(ws);
    attachSocket(record, ws, 'mcp');
    ws.on('close', () => {
      record.mcpSockets.delete(ws);
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
async function disposeRecord(record, reason) {
  record.disposed = true;
  failAllPendingCalls(record, 'Hub session is shutting down');
  const backendExit = disposeSession(record);
  for (const sock of [record.studioSocket, ...record.mcpSockets]) {
    try { sock?.close(1001, reason); } catch {}
  }
  record.mcpSockets.clear();
  record.studioSocket = null;
  await Promise.all([
    backendExit,
    stopAuxiliaryProcesses(record),
    record.browserbaseSession.cleanup(reason),
  ]);
  await fs.rm(record.recordRoot, { recursive: true, force: true });
}

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    clearInterval(stagedReferenceCleanupTimer);
    if (harnessUpdateTimer) clearTimeout(harnessUpdateTimer);
    if (ownerWatchdog) clearInterval(ownerWatchdog);
    log(`shutting down (${signal})`);
    await sessions.disposeAll((record) => disposeRecord(record, 'hub shutdown'));
    for (const sock of wss.clients) {
      try { sock.close(1001, 'server shutting down'); } catch {}
    }
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    const ownedRoots = [
      process.env.RHWP_OWN_WORK_DIR === '1' ? WORK_ROOT : null,
      process.env.RHWP_OWN_RUNTIME_DIR === '1' ? RUNTIME_ROOT : null,
    ].filter(Boolean);
    await Promise.all(ownedRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  })();
  return shutdownPromise;
}

const ownerPid = Number(process.env.RHWP_OWNER_PID);
const ownerWatchdog = Number.isSafeInteger(ownerPid) && ownerPid > 0
  ? setInterval(() => {
    try {
      process.kill(ownerPid, 0);
    } catch (error) {
      if (error?.code !== 'EPERM') {
        void shutdown('owner exited').finally(() => process.exit(0));
      }
    }
  }, 1_000)
  : null;
ownerWatchdog?.unref?.();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown(signal).finally(() => process.exit(0)); });
}
