import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createClaudeSession } from './agents/claude.mjs';
import { createCodexSession, prepareCodexHome } from './agents/codex.mjs';
import { createPiSession } from './agents/pi.mjs';
import { generateChatTitle } from './agents/title.mjs';
import { SkillRegistry } from './skills.mjs';
import { generateSkillDraft } from './skill-generator.mjs';
import { WritingStyleStore, assertWritingStyleAppendCompatible } from './writing-style.mjs';
import { calibrateWritingStyle } from './style-calibrator.mjs';
import { buildWritingStyleCatalog, resolveWritingStyleSelection } from './writing-style-catalog.mjs';
import { TOOL_DEFINITIONS } from './tools.mjs';
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
import { createReferenceHttpHandler } from './reference-http.mjs';
import { assertMessageScope, referenceScopesForSession, resolveSessionIdentity } from './reference-session.mjs';
import { executeReferenceTool } from './reference-tools.mjs';
import { z } from 'zod';

const PORT = Number(process.env.RHWP_AGENT_PORT ?? 5175);
const TOKEN = process.env.RHWP_AGENT_TOKEN ?? 'dev';
const PROTOCOL_VERSION = 2;
const HUB_NAME = 'rhwp-agent';
const STARTED_AT = Date.now();
const ROOT = new URL('..', import.meta.url).pathname;
const MCP_SCRIPT = new URL('./mcp-stdio.mjs', import.meta.url).pathname;
const BUNDLED_SKILLS = new URL('./skills', import.meta.url).pathname;
const ISOLATED_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-home-'));
const ISOLATED_CODEX_HOME = path.join(ISOLATED_HOME, '.codex');
const STUDIO_TOOL_TIMEOUT_MS = 30_000;
const HARNESS_UPDATE_INITIAL_DELAY_MS = 8_000;
const HARNESS_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HARNESS_UPDATE_BUSY_RETRY_MS = 5 * 60 * 1000;
const HARNESS_UPDATE_FAILURE_RETRY_MS = 60 * 60 * 1000;
const toolDefinitionsByName = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
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
prepareCodexHome(ISOLATED_CODEX_HOME, sourceCodexAuthPath);
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
const [initialClaudeSetup, initialCodexSetup] = await Promise.all([
  cliSetup.status('claude'),
  cliSetup.status('codex'),
]);
let cliSetupStatus = { claude: initialClaudeSetup, codex: initialCodexSetup };
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
});
const usageStore = await createUsageStore().init();
const cliproxy = await createCliproxyClient({ rootDir: usageStore.rootDir }).init();
const referenceStore = await new ReferenceStore({ projectRoot: ROOT }).init();
// .hwp/.hwpx/.hml 텍스트 추출은 rhwp 바이너리에 기댄다 — 없으면 첫 업로드가 아니라 기동 시점에 알린다.
if (!(await resolveHwpExtractor(ROOT))) {
  log('hwp/hwpx text extraction unavailable: build target/release/rhwp, install rhwp on PATH, or set RHWP_BIN');
}
const handleReferenceHttp = createReferenceHttpHandler({ store: referenceStore, token: TOKEN });
const stagedReferenceCleanupTimer = setInterval(() => {
  void referenceStore.cleanupStaged().catch((error) => log(`staged reference cleanup failed: ${error?.message ?? error}`));
}, 15 * 60 * 1000);
stagedReferenceCleanupTimer.unref?.();
/** The calibration process outlives a Studio WebSocket. Keeping its request
 * identity and phase lets a reconnecting tab resume the same progress UI. */
let styleCalibration = null;

/** @type {import('ws').WebSocket | null} */
let studioSocket = null;
const mcpSockets = new Set();
/** @type {{ agent: 'claude'|'codex'|'pi', model: string|null, effort: string|null, permissionProfile: 'safe'|'unrestricted', backend: any, status: 'idle'|'running', sessionId: string|null, threadId: string, documentId: string|null, documentName: string|null, chatId: string, planning: PlanningState } | null} */
let session = null;
/** @type {{ messageId: string, message: any, owner: any } | null} */
let pendingReferenceMessage = null;
let nextCapabilityEpoch = 1;

const CLAUDE_MODELS = new Set(['opus', 'fable', 'sonnet', 'haiku']);
const CODEX_MODELS = new Set(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
const DEFAULT_MODEL = { claude: 'sonnet', codex: 'gpt-5.6-sol' };
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_EFFORTS_HAIKU = new Set(['low', 'medium', 'high']);
const CODEX_EFFORTS = new Set(['low', 'medium', 'high']);
const DEFAULT_EFFORT = { claude: 'high', codex: 'medium' };

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

async function agentSetupStatuses() {
  const [claudeSetup, codexSetup, health] = await Promise.all([
    cliSetup.status('claude'),
    cliSetup.status('codex'),
    providerHealth.check(),
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
  cliSetupStatus = { claude, codex };
  return { claude, codex, pi: piAgentSetupStatus() };
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
  if (session) {
    scheduleHarnessUpdates(HARNESS_UPDATE_BUSY_RETRY_MS);
    return;
  }
  harnessUpdateRunning = true;
  let nextDelay = HARNESS_UPDATE_INTERVAL_MS;
  const canActivate = () => session === null;
  const before = {
    claude: cliSetupStatus.claude?.version ?? null,
    codex: cliSetupStatus.codex?.version ?? null,
    pi: piStatus.version ?? null,
  };
  try {
    cliSetupStatus.claude = await cliSetup.automaticUpdate('claude', { canActivate });
    cliSetupStatus.codex = await cliSetup.automaticUpdate('codex', { canActivate });
    piStatus = await piManager.automaticUpdate({ canActivate });
    const statuses = await agentSetupStatuses();
    if (Object.values(statuses).some((status) => status.updateRequired)) {
      nextDelay = HARNESS_UPDATE_FAILURE_RETRY_MS;
    }
    sendJson(studioSocket, { v: 1, type: 'agent-setup-status', statuses });
    const changed = before.claude !== statuses.claude.version
      || before.codex !== statuses.codex.version
      || before.pi !== statuses.pi.version;
    if (changed) {
      const providers = await providerHealth.check(true);
      sendJson(studioSocket, { v: 1, type: 'provider-status', providers });
    }
  } catch {
    const statuses = await agentSetupStatuses().catch(() => null);
    if (statuses) {
      if (Object.values(statuses).some((status) => status.updateRequired)) {
        nextDelay = HARNESS_UPDATE_FAILURE_RETRY_MS;
      }
      sendJson(studioSocket, { v: 1, type: 'agent-setup-status', statuses });
    }
  } finally {
    harnessUpdateRunning = false;
    scheduleHarnessUpdates(nextDelay);
  }
}

function sendAgentSetupError(sock, requestId, agent, error, fallback = 'AGENT_SETUP_FAILED') {
  replyToStudio(sock, {
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
  const allowed = agent === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
  if (typeof requested === 'string' && allowed.has(requested)) return requested;
  const envDefault = agent === 'claude' ? process.env.RHWP_CLAUDE_MODEL : process.env.RHWP_CODEX_MODEL;
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
  const allowed = agent === 'codex'
    ? CODEX_EFFORTS
    : (model === 'haiku' ? CLAUDE_EFFORTS_HAIKU : CLAUDE_EFFORTS);
  if (typeof requested === 'string' && allowed.has(requested)) return requested;
  const preferred = DEFAULT_EFFORT[agent];
  return allowed.has(preferred) ? preferred : [...allowed][0];
}
/** @type {Map<number, { mcpSocket: any, clientId: number, timer: NodeJS.Timeout }>} */
const pendingCalls = new Map();
let nextHubId = 1;

// 스튜디오 소켓이 닫히거나 새 탭 연결에 밀려나면 인플라이트 호출은 영원히 응답받지 못한다 —
// 30초 타임아웃까지 기다리지 말고 즉시 NO_STUDIO 로 실패시킨다.
function failAllPendingCalls(message) {
  for (const [hubId, entry] of pendingCalls) {
    clearTimeout(entry.timer);
    pendingCalls.delete(hubId);
    sendJson(entry.mcpSocket, {
      v: 1, type: 'tool-result', id: entry.clientId, ok: false,
      error: { code: 'NO_STUDIO', message },
    });
  }
}

function log(msg) {
  process.stderr.write(`[rhwp-agent] ${msg}\n`);
}

const downloadManager = new DownloadManager({ rootDir: ROOT });
const browserbaseSession = new BrowserbaseSession({ log });

function sendJson(sock, obj) {
  if (sock && sock.readyState === sock.OPEN) {
    try {
      sock.send(JSON.stringify(obj?.v === 1 ? { ...obj, v: PROTOCOL_VERSION } : obj));
    } catch (e) {
      log(`send failed: ${e?.message ?? e}`);
    }
  }
}

function writingStyleCatalog() {
  return buildWritingStyleCatalog({
    health: providerHealth.cached(),
    piStatus,
    currentSelection: session ? { agent: session.agent, model: session.model, effort: session.effort } : null,
  });
}

function sendStyleProgress(event) {
  if (!styleCalibration) return;
  const snapshot = {
    v: 1,
    type: 'writing-style-progress',
    requestId: styleCalibration.requestId,
    jobId: styleCalibration.jobId,
    startedAt: styleCalibration.startedAt,
    agent: styleCalibration.agent,
    model: styleCalibration.model,
    ...event,
  };
  styleCalibration.progress = snapshot;
  sendJson(studioSocket, snapshot);
}

// 비동기 응답이 도착할 때쯤 스튜디오 탭이 교체되었을 수 있다 — 현재 소켓에만 보낸다.
function replyToStudio(sock, obj) {
  if (sock !== studioSocket) return;
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
function auxDeps(requestedAgent, cliAgent) {
  const agent = requestedAgent === 'pi' || requestedAgent === 'claude' || requestedAgent === 'codex'
    ? requestedAgent
    : (session?.agent ?? null);
  const health = providerHealth.cached();
  // 프로브 전이면 CLI 가 있다고 보고 기존 경로를 먼저 태운다.
  const cliAvailable = health ? health[cliAgent]?.available !== false : true;
  return {
    useOpenRouter: piStatus.setupComplete && (agent === 'pi' || !cliAvailable),
    piManager,
    openRouter,
  };
}

function sessionInfo() {
  return session
    ? {
      agent: session.agent,
      model: session.model,
      effort: session.effort,
      permissionProfile: session.permissionProfile,
      sessionId: session.sessionId,
      threadId: session.threadId,
      documentId: session.documentId,
      documentName: session.documentName,
      status: session.status,
      ...session.planning.snapshot(),
    }
    : null;
}

// 폐기된 백엔드가 죽는 동안 흘리는 이벤트가 새 세션 상태를 덮어쓰지 않도록
// 세션마다 generation 을 발급해 이벤트 핸들러에 묶는다.
let sessionGeneration = 0;
/** 스튜디오 소켓이 끊긴 사이에 끝난 턴 — 다음 접속 때 한 번 재생한다. */
let missedTurnEnd = null;

function makeBackendEventHandler(generation) {
  return (evt) => {
    if (!session || session.generation !== generation) return; // 폐기된 백엔드 → 폐기
    if (evt.type === 'session-info' && evt.sessionId) session.sessionId = evt.sessionId;
    if (evt.type === 'usage') {
      // 사용량은 원본 이벤트가 아니라 집계 리포트로만 스튜디오에 전달한다.
      // pi 는 OpenRouter 청구액(costUsd)을 이벤트 바깥에 달고 온다.
      usageStore.record({
        agent: session.agent, model: evt.model, costUsd: evt.costUsd, ...(evt.usage ?? {}),
      });
      sendJson(studioSocket, { v: 1, type: 'usage-report', usage: usageSnapshot() });
      return;
    }
    if (evt.type === 'turn-start') missedTurnEnd = null;
    if (evt.type === 'turn-end') {
      session.status = 'idle';
      if (!studioSocket || studioSocket.readyState !== studioSocket.OPEN) missedTurnEnd = evt;
    }
    sendJson(studioSocket, { v: 1, type: 'agent-event', event: evt });
  };
}

function disposeSession() {
  pendingReferenceMessage = null;
  if (!session) return;
  const wasRunning = session.status === 'running';
  const agent = session.agent;
  try {
    session.backend.dispose();
  } catch (e) {
    log(`session dispose error: ${e?.message ?? e}`);
  }
  session = null;
  void browserbaseSession.cleanup('session disposed');
  if (wasRunning) {
    // backend.dispose() 는 turnOpen 을 먼저 닫아 turn-end 를 내보내지 않는다 —
    // 스튜디오의 turnRunning/pending change-set 이 열린 채 남지 않도록 합성해 보낸다.
    const evt = { type: 'turn-end', agent, stopReason: 'interrupted' };
    if (!studioSocket || studioSocket.readyState !== studioSocket.OPEN) missedTurnEnd = evt;
    sendJson(studioSocket, { v: 1, type: 'agent-event', event: evt });
  }
}

function resolvePermissionProfile(value) {
  return value === 'unrestricted' ? 'unrestricted' : 'safe';
}

function resolveWorkflow(value) {
  return value === 'plan' ? 'plan' : 'direct';
}

function referenceScopes(activeSession = session) {
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

function dispatchUserMessage(sock, msg, activeSession, messageAttachments = []) {
  if (activeSession.planning.phase === 'awaiting-approval') {
    const planId = activeSession.planning.latestPlan?.planId;
    if (!planId) {
      sendJson(sock, { v: 1, type: 'chat-error', code: 'PLAN_NOT_FOUND', message: 'The latest plan is unavailable; return to planning and present it again.' });
      return;
    }
    void requestImplementationPlanChanges(sock, { planId, feedback: msg.text })
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
      if (session !== activeSession) throw new Error('Agent session changed before the message was dispatched');
      activeSession.backend.sendUserMessage(addReferenceContext(activeSession, msg.text, prompt, messageAttachments));
    })
    .catch((e) => {
      if (session === activeSession) activeSession.status = 'idle';
      sendJson(sock, { v: 1, type: 'chat-error', code: e?.code ?? 'AGENT_SPAWN_FAILED', message: String(e?.message ?? e) });
    });
}

async function dispatchStagedUserMessage(sock, msg, activeSession) {
  const rawIds = Array.isArray(msg.stagedReferenceIds) ? msg.stagedReferenceIds : [];
  const stageIds = [...new Set(rawIds.filter((id) => typeof id === 'string' && id))];
  if (stageIds.length === 0 || stageIds.length !== rawIds.length || stageIds.length > 10) {
    throw Object.assign(new Error('Message attachments require 1-10 unique staged reference ids'), { code: 'INVALID_REFERENCE_MESSAGE' });
  }
  pendingReferenceMessage = { messageId: msg.messageId, message: msg, owner: activeSession };
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
  if (pendingReferenceMessage?.messageId === msg.messageId) pendingReferenceMessage = null;
  const readyFiles = settled.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value.file] : []);
  if (session === activeSession) dispatchUserMessage(sock, msg, activeSession, readyFiles);
}

function emitWorkflowState(extra = {}) {
  if (!session) return;
  sendJson(studioSocket, { v: 1, type: 'workflow-changed', ...session.planning.snapshot(), ...extra });
}

function startSession(
  agent,
  requestedModel,
  requestedEffort,
  requestedPermission,
  requestedWorkflow,
  requestedThreadId,
  requestedDocumentId,
  requestedDocumentName,
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
    existing: session,
    force,
  });
  if (
    !force
    && session
    && session.agent === agent
    && session.model === model
    && session.effort === effort
    && session.permissionProfile === permissionProfile
    && session.planning.workflow === workflow
    && session.threadId === threadId
    && session.documentId === documentId
  ) {
    session.documentName = documentName;
    return session;
  }
  disposeSession();
  const planning = new PlanningState({
    workflow,
    initialCapabilityEpoch: nextCapabilityEpoch++,
    allocateEpoch: () => nextCapabilityEpoch++,
  });
  // onEvent 는 createXSession 이 반환하기 전에 필요하므로 backend 비교 대신
  // generation 을 먼저 발급해 핸들러에 캡처시킨다.
  const generation = ++sessionGeneration;
  const opts = {
    rootDir: ROOT,
    mcpScriptPath: MCP_SCRIPT,
    hubPort: PORT,
    token: TOKEN,
    model,
    effort,
    permissionProfile,
    isolatedHome: ISOLATED_HOME,
    codexHome: ISOLATED_CODEX_HOME,
    codexAuthPath: sourceCodexAuthPath,
    codexBin: cliSetupStatus.codex?.installed ? cliSetup.binPath('codex') : 'codex',
    claudeBin: cliSetupStatus.claude?.installed ? cliSetup.binPath('claude') : 'claude',
    providerEnv: agent === 'claude' || agent === 'codex' ? cliSetup.envFor(agent) : {},
    onEvent: makeBackendEventHandler(generation),
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
  const backend = agent === 'claude'
    ? createClaudeSession(opts)
    : (agent === 'pi' ? createPiSession(opts) : createCodexSession(opts));
  session = {
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
    planning,
    workflowTransition: Promise.resolve(),
  };
  return session;
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
function sendPiError(sock, requestId, error, fallbackCode) {
  replyToStudio(sock, {
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

async function approveImplementationPlan(sock, msg) {
  const activeSession = session;
  if (!activeSession) throw workflowError('AGENT_NOT_STARTED', 'Start a chat before approving a plan');
  requireWorkflowSwitchBackend(activeSession);
  const transition = activeSession.planning.beginApproval({
    planId: String(msg.planId ?? ''),
    sessionStatus: activeSession.status,
  });
  sendJson(sock, { v: 1, type: 'plan-approved', ...activeSession.planning.snapshot() });
  try {
    await activeSession.backend.setExecutionMode(providerModeRequest(activeSession, 'implementing'));
    if (session !== activeSession || activeSession.planning.phase !== 'switching') return;
    activeSession.planning.completeSwitch(transition.approvedPlan.planId);
    sendJson(sock, {
      v: 1,
      type: 'implementation-started',
      planId: transition.approvedPlan.planId,
      ...activeSession.planning.snapshot(),
    });
    activeSession.status = 'running';
    const approvedPrompt = buildApprovedPlanPrompt(transition.approvedPlan);
    activeSession.backend.sendUserMessage(addReferenceContext(
      activeSession,
      JSON.stringify(transition.approvedPlan.plan),
      approvedPrompt,
    ));
  } catch (error) {
    if (session === activeSession && activeSession.planning.phase === 'switching') {
      activeSession.planning.failSwitch(transition.approvedPlan.planId);
      activeSession.status = 'idle';
      emitWorkflowState({ reason: 'provider-switch-failed' });
    }
    sendChatError(sock, error, 'BACKEND_SWITCH_FAILED');
  }
}

async function requestImplementationPlanChanges(sock, msg) {
  const activeSession = session;
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
    if (session !== activeSession) return;
    if (typeof msg.feedback === 'string' && msg.feedback.trim()) {
      activeSession.status = 'running';
      const revisionPrompt = [
        'The user requested changes to the latest implementation plan.',
        'Revise the plan in response and present the complete replacement with present_implementation_plan.',
        `Feedback: ${msg.feedback.trim()}`,
      ].join('\n\n');
      activeSession.backend.sendUserMessage(addReferenceContext(activeSession, msg.feedback, revisionPrompt));
    }
  } catch (error) {
    if (session === activeSession) activeSession.status = 'idle';
    sendChatError(sock, error, 'BACKEND_SWITCH_FAILED');
  }
}

async function setChatWorkflow(sock, msg) {
  if (msg.workflow !== 'direct' && msg.workflow !== 'plan') {
    throw workflowError('INVALID_WORKFLOW', `Unknown workflow: ${String(msg.workflow)}`);
  }
  const activeSession = session;
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
  if (activeSession.planning.workflow === msg.workflow) {
    emitWorkflowState();
    return;
  }
  requireWorkflowSwitchBackend(activeSession);
  const previousPlanId = activeSession.planning.latestPlan?.planId ?? null;
  const nextPlanning = new PlanningState({
    workflow: msg.workflow,
    initialCapabilityEpoch: nextCapabilityEpoch++,
    allocateEpoch: () => nextCapabilityEpoch++,
  });
  const phase = msg.workflow === 'plan' ? 'planning' : 'implementing';
  await activeSession.backend.setExecutionMode({
    workflow: msg.workflow,
    phase,
    capabilityEpoch: nextPlanning.capabilityEpoch,
  });
  if (session !== activeSession) return;
  activeSession.planning = nextPlanning;
  if (msg.workflow === 'direct') void browserbaseSession.cleanup('workflow changed to direct');
  if (previousPlanId) {
    sendJson(sock, {
      v: 1,
      type: 'plan-invalidated',
      planId: previousPlanId,
      reason: 'workflow-changed',
      ...nextPlanning.snapshot(),
    });
  }
  emitWorkflowState();
}

function handleStudioMessage(sock, msg) {
  switch (msg.type) {
    case 'chat-start': {
      const agent = msg.agent;
      if (agent !== 'claude' && agent !== 'codex' && agent !== 'pi') {
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
        const s = startSession(
          agent,
          msg.model,
          msg.effort,
          msg.permissionProfile,
          msg.workflow,
          msg.threadId,
          msg.documentId,
          msg.documentName,
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
        disposeSession();
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
      generateChatTitle(preview, auxDeps(msg.agent, 'codex'))
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
      if (!session) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'No agent session; send chat-start first.' });
        return;
      }
      try {
        assertMessageScope(session, msg);
      } catch (error) {
        sendChatError(sock, error, 'INVALID_REQUEST');
        return;
      }
      if (session.status === 'running' || pendingReferenceMessage) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_BUSY', message: 'A turn is already in progress.' });
        return;
      }
      if (typeof msg.text !== 'string' || msg.text.length === 0) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REQUEST', message: 'chat-user-message requires text' });
        return;
      }
      if (Array.isArray(msg.stagedReferenceIds) && msg.stagedReferenceIds.length > 0) {
        if (typeof msg.messageId !== 'string' || !msg.messageId) {
          sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REFERENCE_MESSAGE', message: 'Attachment messages require messageId' });
          return;
        }
        void dispatchStagedUserMessage(sock, msg, session)
          .catch((error) => {
            if (pendingReferenceMessage?.messageId === msg.messageId) pendingReferenceMessage = null;
            sendChatError(sock, error, 'REFERENCE_COMMIT_FAILED');
          });
        return;
      }
      if (msg.referencesPending === true) {
        if (typeof msg.messageId !== 'string' || !msg.messageId) {
          sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REQUEST', message: 'Reference-bearing messages require messageId' });
          return;
        }
        pendingReferenceMessage = { messageId: msg.messageId, message: msg, owner: session };
        return;
      }
      dispatchUserMessage(sock, msg, session);
      return;
    }
    case 'chat-reference-uploads-complete': {
      const pending = pendingReferenceMessage;
      if (!pending || pending.owner !== session || msg.messageId !== pending.messageId) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REFERENCE_MESSAGE', message: 'No matching message is waiting for reference uploads.' });
        return;
      }
      pendingReferenceMessage = null;
      dispatchUserMessage(sock, pending.message, pending.owner);
      return;
    }
    case 'chat-permission-set': {
      if (!session) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'Start a chat before changing permissions.' });
        return;
      }
      if (session.status === 'running') {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_BUSY', message: 'Permissions can only change between turns.' });
        return;
      }
      const profile = resolvePermissionProfile(msg.permissionProfile);
      try {
        session.backend.setPermissionProfile(profile);
        session.permissionProfile = profile;
        sendJson(sock, { v: 1, type: 'chat-permission-changed', permissionProfile: profile });
      } catch (e) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'PERMISSION_CHANGE_FAILED', message: String(e?.message ?? e) });
      }
      return;
    }
    case 'chat-workflow-set': {
      const transitionOwner = session;
      if (!transitionOwner) {
        void setChatWorkflow(sock, msg).catch((error) => sendChatError(sock, error));
        return;
      }
      const transition = transitionOwner.workflowTransition.then(() => {
        if (session !== transitionOwner) return undefined;
        return setChatWorkflow(sock, msg);
      });
      transitionOwner.workflowTransition = transition.catch(() => undefined);
      void transition.catch((error) => sendChatError(sock, error));
      return;
    }
    case 'chat-plan-approve':
    case 'implementation-plan-approve':
    case 'plan-approve': {
      void approveImplementationPlan(sock, msg).catch((error) => sendChatError(sock, error));
      return;
    }
    case 'chat-plan-request-changes':
    case 'implementation-plan-request-changes':
    case 'plan-request-changes': {
      void requestImplementationPlanChanges(sock, msg).catch((error) => sendChatError(sock, error));
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
      const agent = msg.agent === 'codex' || msg.agent === 'pi' ? msg.agent : 'claude';
      const model = resolveModel(agent, msg.model);
      sendJson(sock, { v: 1, type: 'skill-draft-progress', requestId: msg.requestId ?? null, state: 'generating' });
      void generateSkillDraft(
        { agent, model, goal: String(msg.goal ?? ''), triggerExamples: String(msg.triggerExamples ?? ''), nonTriggerExamples: String(msg.nonTriggerExamples ?? ''), resourceNotes: String(msg.resourceNotes ?? ''), existingSkill: typeof msg.existingSkill === 'string' ? msg.existingSkill : undefined },
        auxDeps(agent, agent === 'claude' ? 'claude' : 'codex'),
      )
        .then((draft) => sendJson(sock, { v: 1, type: 'skill-draft-result', requestId: msg.requestId ?? null, draft }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: 'SKILL_GENERATION_FAILED', message: String(e?.message ?? e) }));
      return;
    }
    case 'provider-status-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void providerHealth.check(msg.refresh === true)
        .then((providers) => replyToStudio(sock, { v: 1, type: 'provider-status', requestId, providers }))
        .catch((e) => replyToStudio(sock, {
          v: 1, type: 'provider-error', requestId,
          code: 'PROVIDER_PROBE_FAILED', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'agent-setup-status-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void agentSetupStatuses()
        .then((statuses) => replyToStudio(sock, { v: 1, type: 'agent-setup-status', requestId, statuses }))
        .catch((e) => sendAgentSetupError(sock, requestId, null, e));
      return;
    }
    case 'agent-setup-install': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const agent = msg.agent;
      if (agent !== 'claude' && agent !== 'codex' && agent !== 'pi') {
        sendAgentSetupError(sock, requestId, null, new Error('지원하지 않는 에이전트예요.'));
        return;
      }
      const progress = (entry) => replyToStudio(sock, {
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
          replyToStudio(sock, { v: 1, type: 'agent-setup-status', requestId, statuses });
          void providerHealth.check(true).then((providers) => replyToStudio(sock, { v: 1, type: 'provider-status', providers }));
        })
        .catch((e) => sendAgentSetupError(sock, requestId, agent, e, 'AGENT_INSTALL_FAILED'));
      return;
    }
    case 'agent-setup-auth': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      const agent = msg.agent;
      const method = msg.method;
      if ((agent !== 'claude' && agent !== 'codex' && agent !== 'pi') || (method !== 'oauth' && method !== 'api-key')) {
        sendAgentSetupError(sock, requestId, null, new Error('로그인 요청을 확인하지 못했어요.'));
        return;
      }
      let authUrl = null;
      let run;
      if (agent === 'pi' && method === 'oauth') {
        const callbackUrl = `http://127.0.0.1:${PORT}/oauth/openrouter/callback`;
        authUrl = piManager.beginOAuth(callbackUrl).authUrl;
        run = Promise.resolve(null);
      } else if (agent === 'pi') {
        run = piManager.setApiKey(String(msg.key ?? '')).then((status) => { piStatus = status; });
      } else {
        run = cliSetup.authenticate(agent, method, msg.key, (entry) => replyToStudio(sock, {
          v: 1,
          type: 'agent-setup-progress',
          agent,
          state: entry.state,
          ...(entry.authUrl ? { authUrl: entry.authUrl } : {}),
        })).then(async (status) => {
          cliSetupStatus[agent] = status;
          if (agent === 'codex') {
            sourceCodexAuthPath = await findSourceCodexAuthPath();
            prepareCodexHome(ISOLATED_CODEX_HOME, sourceCodexAuthPath);
          }
        });
      }
      replyToStudio(sock, { v: 1, type: 'agent-setup-auth-started', requestId, agent, ...(authUrl ? { authUrl } : {}) });
      if (authUrl) {
        replyToStudio(sock, { v: 1, type: 'agent-setup-progress', agent, state: 'authorizing', authUrl });
        return;
      }
      void run
        .then(agentSetupStatuses)
        .then((statuses) => {
          replyToStudio(sock, { v: 1, type: 'agent-setup-status', statuses });
          if (agent === 'pi') replyToStudio(sock, { v: 1, type: 'pi-status', status: piStatus });
          void providerHealth.check(true).then((providers) => replyToStudio(sock, { v: 1, type: 'provider-status', providers }));
        })
        .catch((e) => sendAgentSetupError(sock, null, agent, e, 'AGENT_AUTH_FAILED'));
      return;
    }
    case 'agent-setup-cancel': {
      const agent = msg.agent;
      if (agent === 'pi') void piManager.cancelSetup();
      else if (agent === 'claude' || agent === 'codex') void cliSetup.cancel(agent);
      return;
    }
    case 'usage-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void usageSnapshotRefreshing(msg.refresh === true)
        .then((usage) => replyToStudio(sock, { v: 1, type: 'usage-report', requestId, usage }))
        .catch((e) => replyToStudio(sock, {
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
        .then((usage) => replyToStudio(sock, { v: 1, type: 'usage-report', requestId, usage }))
        .catch((e) => replyToStudio(sock, {
          v: 1, type: 'usage-error', requestId,
          code: e?.code ?? 'INVALID_PLAN', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'pi-status-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void refreshPiStatus()
        .then((status) => replyToStudio(sock, { v: 1, type: 'pi-status', requestId, status }))
        .catch((e) => sendPiError(sock, requestId, e, 'PI_STATUS_FAILED'));
      return;
    }
    case 'pi-install': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void piManager.install((progress) => replyToStudio(sock, {
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
          replyToStudio(sock, { v: 1, type: 'pi-status', requestId, status });
          // 설치 직후 프로바이더 목록에 pi 가 나타나야 한다.
          void providerHealth.check(true)
            .then((providers) => replyToStudio(sock, { v: 1, type: 'provider-status', providers }))
            .catch(() => {});
        })
        .catch((e) => sendPiError(sock, requestId, e, 'PI_INSTALL_FAILED'));
      return;
    }
    case 'pi-set-key': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void piManager.setApiKey(String(msg.key ?? ''))
        .then(async (status) => {
          piStatus = status;
          replyToStudio(sock, { v: 1, type: 'pi-status', requestId, status });
          await refreshOpenRouterCredits(true);
          replyToStudio(sock, { v: 1, type: 'usage-report', usage: usageSnapshot() });
        })
        .catch((e) => sendPiError(sock, requestId, e, 'OPENROUTER_KEY_INVALID'));
      return;
    }
    case 'pi-catalog-request': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void piManager.catalog(msg.refresh === true)
        .then((models) => replyToStudio(sock, { v: 1, type: 'pi-catalog', requestId, models }))
        .catch((e) => sendPiError(sock, requestId, e, 'OPENROUTER_UNREACHABLE'));
      return;
    }
    case 'pi-set-models': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void piManager.setModels(Array.isArray(msg.models) ? msg.models : [])
        .then((status) => {
          piStatus = status;
          replyToStudio(sock, { v: 1, type: 'pi-status', requestId, status });
        })
        .catch((e) => sendPiError(sock, requestId, e, 'PI_MODELS_INVALID'));
      return;
    }
    case 'cliproxy-connect': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void cliproxy.connect({ url: msg.url, key: msg.key })
        .then((status) => replyToStudio(sock, {
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
          replyToStudio(sock, { v: 1, type: 'usage-report', requestId, usage });
        });
      return;
    }
    case 'cliproxy-disconnect': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
      void cliproxy.disconnect()
        .then(() => replyToStudio(sock, { v: 1, type: 'usage-report', requestId, usage: usageSnapshot() }))
        .catch((e) => replyToStudio(sock, {
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
          v: 1, type: 'writing-style-catalog', requestId, ...writingStyleCatalog(),
        }))
        .catch((e) => sendJson(sock, {
          v: 1, type: 'writing-style-error', requestId,
          code: e?.code ?? 'STYLE_CATALOG_FAILED', message: String(e?.message ?? e),
        }));
      return;
    }
    case 'writing-style-calibrate': {
      const requestId = msg.requestId ?? null;
      if (styleCalibration) {
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
            currentSelection: session ? { agent: session.agent, model: session.model, effort: session.effort } : null,
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
      styleCalibration = {
        requestId, jobId, startedAt: new Date().toISOString(),
        agent: selection.agent, model: selection.model, progress: null,
      };
      sendStyleProgress({
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
              onProgress: (event) => {
                if (styleCalibration?.jobId === jobId) sendStyleProgress(event);
              },
            },
          );
        })
        .then(async (profile) => {
          if (styleCalibration?.jobId === jobId) sendStyleProgress({
            state: 'saving', phase: 'saving', activity: 'saving-profile',
            detail: 'Saving the profile and its source samples', completed: 0, total: 1,
          });
          const status = await writingStyleStore.save(profile, { sources: calibrationSources });
          if (styleCalibration?.jobId === jobId) sendStyleProgress({
            state: 'saving', phase: 'saving', activity: 'saving-profile',
            detail: 'Saved the calibrated writing profile', completed: 1, total: 1,
          });
          sendJson(studioSocket, { v: 1, type: 'writing-style-result', requestId, jobId, status });
          sendJson(studioSocket, { v: 1, type: 'writing-style-status', requestId, status });
        })
        .catch((e) => sendJson(studioSocket, {
          v: 1,
          type: 'writing-style-error',
          requestId,
          jobId,
          code: e?.code ?? 'CALIBRATION_FAILED',
          message: String(e?.message ?? e),
        }))
        .finally(() => {
          if (styleCalibration?.jobId === jobId) styleCalibration = null;
        });
      return;
    }
    case 'writing-style-instruction-set': {
      const requestId = msg.requestId ?? null;
      void writingStyleStore.setAdditionalInstruction(msg.instruction)
        .then((status) => sendJson(studioSocket, {
          v: 1, type: 'writing-style-status', requestId, status,
        }))
        .catch((e) => sendJson(studioSocket, {
          v: 1,
          type: 'writing-style-error',
          requestId,
          code: 'STYLE_INSTRUCTION_FAILED',
          message: String(e?.message ?? e),
        }));
      return;
    }
    case 'chat-interrupt': {
      if (session) {
        try {
          session.backend.interrupt();
        } catch (e) {
          log(`interrupt error: ${e?.message ?? e}`);
        }
        session.status = 'idle';
      }
      return;
    }
    case 'chat-stop': {
      disposeSession();
      return;
    }
    case 'tool-response': {
      const entry = pendingCalls.get(msg.id);
      if (!entry) {
        log(`tool-response for unknown id ${msg.id}`);
        return;
      }
      pendingCalls.delete(msg.id);
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

function handleMcpMessage(sock, msg) {
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
        if (!session && tool !== 'read_product_skill') {
          throw workflowError('AGENT_NOT_STARTED', 'No active chat session');
        }
        if (session) {
          if (msg.workflow && msg.workflow !== session.planning.workflow) {
            throw workflowError('WORKFLOW_MISMATCH', `MCP call declared ${msg.workflow} but the active workflow is ${session.planning.workflow}`);
          }
          authorizeToolCall({
            category: definition.category,
            tool,
            workflow: session.planning.workflow,
            phase: session.planning.phase,
            expectedEpoch: session.planning.capabilityEpoch,
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
        void executeReferenceTool({ tool, args, store: referenceStore, session })
          .then(({ handled, result }) => {
            if (!handled) throw workflowError('UNKNOWN_TOOL', `Unknown reference tool: ${tool}`);
            sendResult(result);
          })
          .catch((error) => sendError(error, 'REFERENCE_READ_FAILED'));
        return;
      }
      if (tool === 'present_implementation_plan') {
        if (!studioSocket || studioSocket.readyState !== studioSocket.OPEN) {
          sendError(workflowError('NO_STUDIO', 'Studio must be connected to review an implementation plan'));
          return;
        }
        try {
          const record = session.planning.present(args);
          sendJson(studioSocket, {
            v: 1,
            type: 'plan-ready',
            planId: record.planId,
            plan: record.plan,
            ...session.planning.snapshot(),
          });
          emitWorkflowState({ reason: 'plan-presented' });
          const { workflow, phase, capabilityEpoch } = session.planning.snapshot();
          sendResult({ planId: record.planId, workflow, phase, capabilityEpoch });
        } catch (error) {
          sendError(error);
        }
        return;
      }
      if (tool === 'download_file') {
        void downloadManager.download({ sessionId: session.chatId, ...args })
          .then(sendResult)
          .catch((error) => sendError(error, 'DOWNLOAD_FAILED'));
        return;
      }
      if (definition.category === 'browser') {
        const sidecarTool = tool.replace(/^browserbase_/, '');
        void browserbaseSession.call(session.chatId, sidecarTool, args)
          .then(sendResult)
          .catch((error) => sendError(error, 'BROWSERBASE_TOOL_FAILED'));
        return;
      }
      if (!studioSocket || studioSocket.readyState !== studioSocket.OPEN) {
        sendError(workflowError('NO_STUDIO', 'Studio is not connected; open rhwp-studio in a browser'));
        return;
      }
      const hubId = nextHubId++;
      const timer = setTimeout(() => {
        pendingCalls.delete(hubId);
        sendJson(sock, {
          v: 1, type: 'tool-result', id: clientId, ok: false,
          error: { code: 'STUDIO_TIMEOUT', message: `Studio did not answer within ${STUDIO_TOOL_TIMEOUT_MS / 1000}s — the edit may still have applied; re-read with get_structure/get_text_range before retrying to avoid duplicates` },
        });
      }, STUDIO_TOOL_TIMEOUT_MS);
      pendingCalls.set(hubId, { mcpSocket: sock, clientId, timer });
      sendJson(studioSocket, {
        v: 1, type: 'tool-request', id: hubId,
        // 호출을 보낸 MCP 소켓의 에이전트 라벨을 단다 — 현재 세션 기준으로 찍으면
        // 세션 교체 직후 남은 호출이 엉뚱한 에이전트로 기록될 수 있다.
        agent: sock.agentLabel ?? session?.agent ?? 'claude',
        tool,
        args,
        phase: session?.planning.snapshot().phase,
        capabilityEpoch: session?.planning.capabilityEpoch,
      });
      return;
    }
    default:
      log(`ignoring unknown mcp message type: ${String(msg.type)}`);
  }
}

function attachSocket(sock, role) {
  sock.on('message', (data, isBinary) => {
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
      if (role === 'studio') handleStudioMessage(sock, msg);
      else handleMcpMessage(sock, msg);
    } catch (e) {
      log(`message handler error (${role}): ${e?.stack ?? e}`);
    }
  });
  sock.on('error', (err) => log(`${role} socket error: ${err?.message ?? err}`));
}

function healthzBody() {
  return {
    ok: true,
    name: HUB_NAME,
    pid: process.pid,
    uptimeMs: Date.now() - STARTED_AT,
    protocol: PROTOCOL_VERSION,
    secretBroker: secretStore.available,
    studioConnected: !!studioSocket && studioSocket.readyState === studioSocket.OPEN,
    mcpClients: mcpSockets.size,
    session: sessionInfo(),
    providers: providerHealth.cached(),
    browserbase: browserbaseSession.status(),
  };
}

const httpServer = http.createServer((req, res) => {
  void Promise.resolve().then(async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (await handleReferenceHttp(req, res, url)) return;
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
        replyToStudio(studioSocket, { v: 1, type: 'agent-setup-status', statuses });
        replyToStudio(studioSocket, { v: 1, type: 'pi-status', status: piStatus });
        void refreshOpenRouterCredits(true).then(() => replyToStudio(studioSocket, { v: 1, type: 'usage-report', usage: usageSnapshot() }));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><style>body{font:16px system-ui;margin:48px;color:#202124}</style><h1>OpenRouter connected</h1><p>You can return to Rauhwpx and close this tab.</p>');
      } catch (error) {
        sendAgentSetupError(studioSocket, null, 'pi', error, 'OPENROUTER_OAUTH_FAILED');
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Rauhwpx</title><p>OpenRouter login could not be completed. Return to Rauhwpx and try again.</p>');
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
      const allowOrigin = origin && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(origin)
        ? origin
        : null;
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(allowOrigin ? { 'access-control-allow-origin': allowOrigin, vary: 'Origin' } : {}),
      });
      res.end(JSON.stringify(healthzBody()));
      return;
    }
    // pi 확장은 MCP 대신 이 엔드포인트로 도구 정의를 받아 간다.
    if (req.method === 'GET' && url.pathname === '/pi/tool-definitions') {
      const { status, body } = handlePiToolDefinitions({ url, token: TOKEN });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }).catch((error) => {
    log(`http request failed: ${error?.stack ?? error}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ status: 'error', message: 'Internal server error' }));
  });
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const path = url.pathname;
  const token = url.searchParams.get('token');
  if ((path !== '/studio' && path !== '/mcp') || token !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (path === '/studio') {
      if (studioSocket) {
        // 새 탭에 밀려나면 구 소켓의 인플라이트 호출은 응답이 오지 않으므로 즉시 실패시킨다.
        failAllPendingCalls('Studio connection was replaced by a new tab; the edit may still have applied — re-read with get_structure/get_text_range before retrying');
        try {
          studioSocket.close(4000, 'replaced');
        } catch {}
      }
      studioSocket = ws;
      attachSocket(ws, 'studio');
      ws.on('close', () => {
        if (studioSocket === ws) {
          studioSocket = null;
          pendingReferenceMessage = null;
          failAllPendingCalls('Studio disconnected while tool calls were in flight; the edit may still have applied — re-read with get_structure/get_text_range before retrying');
        }
      });
      sendJson(ws, { v: 1, type: 'welcome', protocol: PROTOCOL_VERSION, session: sessionInfo() });
      if (session?.planning.latestPlan && session.planning.phase === 'awaiting-approval') {
        sendJson(ws, {
          v: 1,
          type: 'plan-ready',
          planId: session.planning.latestPlan.planId,
          plan: structuredClone(session.planning.latestPlan.plan),
          ...session.planning.snapshot(),
        });
      }
      if (missedTurnEnd) {
        // 소켓이 끊긴 사이에 끝난 턴 — welcome 직후 한 번 재생해 UI 를 닫아준다.
        const evt = missedTurnEnd;
        missedTurnEnd = null;
        sendJson(ws, { v: 1, type: 'agent-event', event: evt });
      }
      void skillRegistry.list().then((catalog) => sendJson(ws, { v: 1, type: 'skills-catalog', ...catalog }));
      void writingStyleStore.status()
        .then((status) => sendJson(ws, { v: 1, type: 'writing-style-status', status }))
        .catch((e) => sendJson(ws, {
          v: 1, type: 'writing-style-error', code: e?.code ?? 'STYLE_STATUS_FAILED', message: String(e?.message ?? e),
        }));
      if (styleCalibration) {
        sendJson(ws, styleCalibration.progress ?? {
          v: 1, type: 'writing-style-progress',
          requestId: styleCalibration.requestId, jobId: styleCalibration.jobId,
          startedAt: styleCalibration.startedAt, agent: styleCalibration.agent, model: styleCalibration.model,
          state: 'preparing', phase: 'preparing', activity: 'collecting-samples',
          detail: 'Preparing writing samples', completed: 0, total: 1,
        });
      }
      // 프로바이더 프로브로 접속을 붙잡아 두지 않는다 — 캐시를 먼저 주고 결과가 오면 갱신한다.
      const cachedProviders = providerHealth.cached();
      if (cachedProviders) sendJson(ws, { v: 1, type: 'provider-status', providers: cachedProviders });
      void providerHealth.check().then((providers) => {
        if (providers !== cachedProviders) replyToStudio(ws, { v: 1, type: 'provider-status', providers });
      });
      sendJson(ws, { v: 1, type: 'pi-status', status: piStatus });
      void agentSetupStatuses().then((statuses) => replyToStudio(ws, { v: 1, type: 'agent-setup-status', statuses }));
      sendJson(ws, { v: 1, type: 'writing-style-catalog', ...writingStyleCatalog() });
      sendJson(ws, { v: 1, type: 'usage-report', usage: usageSnapshot() });
      if (piStatus.keyConfigured && !openRouterCredits) {
        // 잔액도 접속을 붙잡지 않는다 — 도착하면 사용량 리포트를 한 번 더 보낸다.
        void refreshOpenRouterCredits(false)
          .then(() => replyToStudio(ws, { v: 1, type: 'usage-report', usage: usageSnapshot() }));
      }
      if (cliproxy.configured()) {
        void cliproxy.refresh(false).then((status) => {
          if (status.connected || status.error) replyToStudio(ws, { v: 1, type: 'usage-report', usage: usageSnapshot() });
        });
      }
      log('studio connected');
    } else {
      const agentLabel = url.searchParams.get('agent') ?? 'unknown';
      // 도구 호출에 찍을 에이전트 라벨 — 접속 시점 값을 소켓에 붙여 둔다 (없으면 null, 세션 값이 대신 쓰인다).
      ws.agentLabel = url.searchParams.get('agent');
      ws.workflow = url.searchParams.get('workflow');
      ws.capabilityEpoch = url.searchParams.get('capabilityEpoch');
      mcpSockets.add(ws);
      attachSocket(ws, 'mcp');
      ws.on('close', () => {
        mcpSockets.delete(ws);
        for (const [hubId, entry] of pendingCalls) {
          if (entry.mcpSocket === ws) {
            clearTimeout(entry.timer);
            pendingCalls.delete(hubId);
          }
        }
        log(`mcp client disconnected (agent=${agentLabel})`);
      });
      log(`mcp client connected (agent=${agentLabel})`);
    }
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  log(`rhwp-agent hub listening on ws://127.0.0.1:${PORT} (bearer token configured)`);
  log('claude/codex/pi can be installed and authenticated from Studio settings');
  scheduleHarnessUpdates(HARNESS_UPDATE_INITIAL_DELAY_MS);
});

httpServer.on('error', (err) => {
  log(`server error: ${err?.message ?? err}`);
  void fs.rm(ISOLATED_HOME, { recursive: true, force: true }).finally(() => process.exit(1));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(stagedReferenceCleanupTimer);
  if (harnessUpdateTimer) clearTimeout(harnessUpdateTimer);
  log(`shutting down (${signal})`);
  disposeSession();
  await browserbaseSession.cleanup('hub shutdown');
  for (const sock of wss.clients) {
    try { sock.close(1001, 'server shutting down'); } catch {}
  }
  await new Promise((resolve) => httpServer.close(resolve));
  await fs.rm(ISOLATED_HOME, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown(signal).finally(() => process.exit(0)); });
}
