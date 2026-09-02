// cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
import spawn from 'cross-spawn';
import crypto from 'node:crypto';
import { query as queryClaude } from '@anthropic-ai/claude-agent-sdk';
import {
  mkdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import {
  credentialMirrorHasPendingCopybackSync,
  flushCredentialMirrorSync,
  prepareCredentialMirrorSync,
} from '../credential-mirror.mjs';
import { resolveNpmCliLaunch } from '../npm-cli-launch.mjs';
import {
  createLineReader,
  isPlanningRestricted,
  mcpCapabilityEnv,
  mcpRuntimeFor,
  normalizeExecutionMode,
  normalizeTaskUsage,
  normalizeUsageTokens,
  providerReadOnlyRoots,
  providerInteractionMode,
  redactDiagnosticText,
  RHWP_SUBAGENTS,
  systemBriefFor,
  truncate,
  validateExecutionMode,
} from './backend.mjs';
import {
  createClaudeAskUserQuestionPermissionHandler,
  isRootUserInputContext,
} from './provider-user-input.mjs';
export {
  createClaudeAskUserQuestionPermissionHandler,
  decodeClaudeAskUserQuestion,
  encodeClaudeAskUserQuestion,
} from './provider-user-input.mjs';
import {
  isolatedProcessEnv,
  PROCESS_TREE_CLEANUP_OUTCOME,
  processTreeCleanupOutcome,
  processTreeSpawnOptions,
  terminateProcessTree,
  waitForProcessTreeExit,
} from '../process-tree.mjs';

// Agent/Workflow 는 모든 모드에서 켠다 — --tools 제한은 서브에이전트에도 상속되므로
// (CLI 확인: 2.1.235) planning 의 read-only 경계가 서브에이전트에서도 유지된다.
const DIRECT_TOOLS = 'Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch,Agent,Workflow';
const PLANNING_TOOLS = 'Read,Glob,Grep,Bash,WebSearch,WebFetch,Agent,Workflow';
const STDERR_TAIL_LIMIT = 16_000;
/**
 * 백그라운드 서브에이전트/워크플로 턴의 정착 유예. task_notification 이 큐에 남긴
 * wake 재호출(result 뒤 init→…→result)이 이 시간 안에 시작되지 않으면 턴을 닫는다.
 * 관찰상 wake 는 result 직후 즉시 시작된다 — 유예는 순수 안전 마진이다.
 */
const TASK_SETTLE_GRACE_MS = 1_500;

function createClaudeInputQueue() {
  const values = [];
  const waiters = [];
  let closed = false;
  return {
    push(value) {
      if (closed) throw new Error('Claude input stream is closed');
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length) return Promise.resolve({ value: values.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

// rhwp 전용 서브에이전트 정의(RHWP_SUBAGENTS)는 backend.mjs 로 이동했다 —
// grok 도 같은 정의를 --agents 로 공유한다.

const claudeMirrorsByHome = new Map();

function seedClaudeCredential(source, target, deps = {}) {
  return prepareCredentialMirrorSync(source, target, {
    platform: deps.platform ?? process.platform,
    ...(deps.symlink ? { symlink: deps.symlink } : {}),
    // Two live Claude sessions must never share a writable host credential
    // inode. Copyback applies refreshes with the mirror's CAS rules on close.
    copyOnly: true,
  });
}

export function flushClaudeCredentialMirrors(isolatedHome) {
  const key = path.resolve(String(isolatedHome ?? ''));
  const mirrors = claudeMirrorsByHome.get(key) ?? [];
  const pending = [];
  for (const mirror of mirrors) {
    try {
      const result = flushCredentialMirrorSync(mirror, { platform: mirror.platform ?? process.platform });
      if (result.pending) {
        pending.push(mirror);
        process.stderr.write(`[claude] credential refresh copyback pending: ${result.errorMessage}\n`);
      } else if (result.conflict) {
        process.stderr.write(`[claude] credential refresh copyback conflicted: ${mirror.source}\n`);
      }
    } catch (error) {
      if (credentialMirrorHasPendingCopybackSync(mirror)) pending.push(mirror);
      process.stderr.write(`[claude] credential refresh copyback failed: ${error?.message ?? error}\n`);
    }
  }
  if (pending.length > 0) claudeMirrorsByHome.set(key, pending);
  else claudeMirrorsByHome.delete(key);
  return pending.length === 0;
}

/** Seed only Claude's shared login files into an otherwise isolated home. */
export function prepareClaudeHome(isolatedHome, {
  credentialsPath,
  configPath,
} = {}, deps = {}) {
  const key = path.resolve(isolatedHome);
  const previous = claudeMirrorsByHome.get(key) ?? [];
  for (const mirror of previous) {
    const result = flushCredentialMirrorSync(mirror, { platform: deps.platform ?? process.platform });
    if (result.pending) throw Object.assign(new Error(result.errorMessage), { code: result.errorCode });
    if (!result.conflict) rmSync(mirror.target, { force: true });
  }
  claudeMirrorsByHome.delete(key);
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  const mirrors = [seedClaudeCredential(
    credentialsPath,
    path.join(isolatedHome, '.claude', '.credentials.json'),
    deps,
  ), seedClaudeCredential(
    configPath,
    path.join(isolatedHome, '.claude.json'),
    deps,
  )].filter((mirror) => mirror?.mode === 'copy');
  if (mirrors.length > 0) claudeMirrorsByHome.set(key, mirrors);
  return mirrors;
}

export function formatClaudeExitError(stderrText, code, signal, token) {
  const clean = redactDiagnosticText(stderrText, [token]);
  const detail = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-8).join('\n');
  const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
  return detail
    ? `Claude 실행이 중단되었습니다 (${exit}).\n${truncate(detail, 1200)}`
    : `Claude 실행이 중단되었습니다 (${exit}). Claude가 오류 설명을 제공하지 않았습니다.`;
}

function permissionPathRule(tool, value) {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  return `${tool}(//${normalized.replace(/^\/+/, '')}/**)`;
}

function claudeProcessEnv(opts, sourceEnv) {
  const env = isolatedProcessEnv(opts, sourceEnv);
  if (!opts.isolatedHome) {
    delete env.CLAUDE_CONFIG_DIR;
    return env;
  }
  env.CLAUDE_CONFIG_DIR = path.join(String(opts.isolatedHome), '.claude');
  return env;
}

export function buildClaudeArgv(opts, sessionId, resume) {
  const unrestricted = opts.permissionProfile === 'unrestricted';
  const planningRestricted = isPlanningRestricted(opts);
  const interactionMode = providerInteractionMode(opts);
  const copyLayoutWorker = opts.toolProfile === 'copy-layout-worker';
  const activeTools = copyLayoutWorker ? 'Read,Glob,Grep' : planningRestricted ? PLANNING_TOOLS : DIRECT_TOOLS;
  const capabilityEnv = mcpCapabilityEnv(opts);
  const readOnlyRoots = providerReadOnlyRoots(opts);
  const runtime = mcpRuntimeFor(opts);
  const mcpConfig = {
    mcpServers: {
      rhwp: {
        command: runtime.command,
        args: runtime.args,
        env: {
          ...runtime.env,
          RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
          RHWP_AGENT_TOKEN: opts.token,
          RHWP_AGENT_NAME: 'claude',
          ...capabilityEnv,
        },
      },
    },
  };
  const allow = [
    permissionPathRule('Read', opts.rootDir),
    ...readOnlyRoots.map((root) => permissionPathRule('Read', root)),
    ...(!planningRestricted && !copyLayoutWorker ? [
      permissionPathRule('Write', opts.rootDir),
      permissionPathRule('Edit', opts.rootDir),
    ] : []),
    permissionPathRule('Glob', opts.rootDir),
    permissionPathRule('Grep', opts.rootDir),
    ...(copyLayoutWorker ? [] : ['Bash', 'WebSearch', 'WebFetch', 'Agent', 'Workflow']),
    'mcp__rhwp__*',
  ];
  const settings = unrestricted && !planningRestricted ? {} : {
    permissions: { allow },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowRead: [opts.rootDir, ...readOnlyRoots],
        allowWrite: planningRestricted || copyLayoutWorker ? [] : [opts.rootDir],
      },
    },
  };
  return [
    '-p', '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    // 서브에이전트 텍스트는 항상 전달받는다 — 사이드바 fleet 카드의 활동 줄이 이걸 쓴다.
    // (도구 호출/결과 전달은 플래그와 무관하게 항상 온다 — CLI 2.1.235 확인.)
    '--forward-subagent-text',
    '--agents', JSON.stringify(RHWP_SUBAGENTS),
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    '--mcp-config', JSON.stringify(mcpConfig),
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--tools', activeTools,
    '--settings', JSON.stringify(settings),
    ...(interactionMode === 'plan'
      ? ['--permission-mode', 'plan']
      : unrestricted
        ? ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions']
        : ['--permission-mode', 'dontAsk']),
    '--append-system-prompt', systemBriefFor(opts),
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--effort', opts.effort] : []),
  ];
}

/**
 * Native AskUserQuestion requires the Agent SDK's bidirectional permission
 * callback. This mirrors the legacy CLI surface and is used only when the host
 * advertises requestUserInput. Without that host capability, buildClaudeArgv
 * remains the automatic MCP fallback.
 */
export function buildClaudeSdkOptions(opts, sessionId, resume, abortController) {
  const unrestricted = opts.permissionProfile === 'unrestricted';
  const planningRestricted = isPlanningRestricted(opts);
  const interactionMode = providerInteractionMode(opts);
  const copyLayoutWorker = opts.toolProfile === 'copy-layout-worker';
  const activeTools = copyLayoutWorker ? 'Read,Glob,Grep' : planningRestricted ? PLANNING_TOOLS : DIRECT_TOOLS;
  const capabilityEnv = mcpCapabilityEnv(opts);
  const readOnlyRoots = providerReadOnlyRoots(opts);
  const runtime = mcpRuntimeFor(opts);
  const allow = [
    permissionPathRule('Read', opts.rootDir),
    ...readOnlyRoots.map((root) => permissionPathRule('Read', root)),
    ...(!planningRestricted && !copyLayoutWorker ? [
      permissionPathRule('Write', opts.rootDir),
      permissionPathRule('Edit', opts.rootDir),
    ] : []),
    permissionPathRule('Glob', opts.rootDir),
    permissionPathRule('Grep', opts.rootDir),
    ...(copyLayoutWorker ? [] : ['Bash', 'WebSearch', 'WebFetch', 'Agent', 'Workflow']),
    'mcp__rhwp__*',
  ];
  const settings = unrestricted && !planningRestricted ? {} : {
    permissions: { allow },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowRead: [opts.rootDir, ...readOnlyRoots],
        allowWrite: planningRestricted || copyLayoutWorker ? [] : [opts.rootDir],
      },
    },
  };
  const canUseTool = createClaudeAskUserQuestionPermissionHandler(opts);
  if (!canUseTool) throw new Error('Claude native user input requires a root requestUserInput capability');
  return {
    abortController,
    agents: RHWP_SUBAGENTS,
    allowedTools: [...allow, 'AskUserQuestion'],
    canUseTool,
    cwd: opts.rootDir,
    env: claudeProcessEnv(opts, opts.providerEnv ?? process.env),
    extraArgs: { 'disable-slash-commands': null },
    forwardSubagentText: true,
    includePartialMessages: true,
    mcpServers: {
      rhwp: {
        command: runtime.command,
        args: runtime.args,
        env: {
          ...runtime.env,
          RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
          RHWP_AGENT_TOKEN: opts.token,
          RHWP_AGENT_NAME: 'claude',
          ...capabilityEnv,
        },
      },
    },
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.claudeBin && path.isAbsolute(opts.claudeBin)
      ? { pathToClaudeCodeExecutable: opts.claudeBin }
      : {}),
    permissionMode: interactionMode === 'plan'
      ? 'plan'
      : unrestricted ? 'bypassPermissions' : 'default',
    ...(interactionMode !== 'plan' && unrestricted ? { allowDangerouslySkipPermissions: true } : {}),
    ...(resume ? { resume: sessionId } : { sessionId }),
    settingSources: [],
    settings,
    strictMcpConfig: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemBriefFor(opts) },
    tools: [...activeTools.split(','), 'AskUserQuestion'],
  };
}

/**
 * @param {import('./backend.mjs').BackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createClaudeSession(opts, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
  waitForExit = waitForProcessTreeExit,
  queryAgent = queryClaude,
  closeGraceMs = 2_000,
  flushCredentialMirrors = flushClaudeCredentialMirrors,
  platform = process.platform,
  nodeCommand = process.execPath,
} = {}) {
  let sessionId = crypto.randomUUID();
  const onEvent = opts.onEvent;

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let childAlive = false;
  const childCleanupPromises = new WeakMap();
  const childDrainPromises = new WeakMap();
  const childDrainStarters = new WeakMap();
  const childLifecycleStates = new WeakMap();
  const childOutputDiscarders = new WeakMap();
  let suppressChildOutput = () => {};
  let uncertainTreeCleanup = false;
  let hasCompletedTurn = false;
  // --session-id 는 한 번 스폰에 쓰면 소진된다: 그 스폰이 turn 을 완료하지 못한 채
  // 죽으면(인터럽트/크래시) 같은 ID 재사용 시 "Session ID … is already in use" 로
  // 영구히 실패한다. 재스폰 시 완료된 turn 이 없으면 새 UUID 를 발급한다.
  let sessionIdConsumed = false;
  let turnOpen = false;
  let sawRootTextDelta = false;
  const streamedSubagents = new Set();
  let disposed = false;
  let restartReady = Promise.resolve();
  /** @type {{ text: string } | null} */
  let queuedTurn = null;
  let stderrTail = '';
  // Only root chat sessions with a host callback enter the bidirectional SDK
  // transport. Any SDK initialization failure before the first provider frame
  // permanently selects the existing CLI+MCP path for this session.
  let nativeUserInput = typeof opts.requestUserInput === 'function'
    && isRootUserInputContext({ agentRole: opts.agentRole });
  /**
   * The Agent SDK owns a Claude process and its MCP descendants. Keep one
   * owner record per provider turn so callbacks and iterator events from a
   * closed query cannot be accepted by a later resumed query.
   * @type {{
   *   generation: number,
   *   query: any,
   *   queue: ReturnType<typeof createClaudeInputQueue>,
   *   run: Promise<void> | null,
   *   abortController: AbortController,
   *   active: boolean,
   *   sawEvent: boolean,
   *   pendingPrompt: string | null,
   *   shutdown: Promise<boolean> | null,
   *   settling: boolean,
   * } | null}
   */
  let sdkOwner = null;
  let sdkGeneration = 0;
  let sdkShutdownReady = Promise.resolve(true);
  let uncertainSdkCleanup = false;
  // usage 집계에 붙일 모델 — CLI 가 보고한 실제 모델을 우선한다.
  let currentModel = opts.model ?? null;

  // ── 서브에이전트/워크플로 task 추적 ────────────────────────────
  // tool_use id → taskId (parentTaskId 번역용). 프로세스 수명 동안 유지 —
  // 늦게 흘러오는 child 이벤트가 다음 턴 초기에 도착해도 귀속이 맞아야 한다.
  const taskIdByToolUse = new Map();
  // 아직 안 끝난 task — 하나라도 남아 있으면 result 가 와도 턴을 닫지 않는다.
  const pendingTasks = new Set();
  let tasksSeenThisTurn = 0;
  // 이번 턴 result 들의 집계 — 정착 시 turn-end 에 실을 값.
  let lastStopReason;
  let resultErrorMessage;
  // result 뒤에 이어지는 wake 재호출의 루트 텍스트는 별개 메시지다 — 문단을 띄운다.
  let needsWakeTextBreak = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let settleTimer = null;
  // task_progress 의 workflow_progress 는 매 틱 전체 배열을 반복한다 — 실질
  // 변화가 있을 때만 members/phases 를 재전송하기 위한 지문.
  const workflowFingerprints = new Map();

  function buildArgv(resume) {
    return buildClaudeArgv(opts, sessionId, resume);
  }

  function claudeCliLaunch() {
    return resolveNpmCliLaunch(opts.claudeBin ?? 'claude', {
      platform,
      nodeCommand,
      env: claudeProcessEnv(opts, opts.providerEnv ?? process.env),
    });
  }

  function clearSettleTimer() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  function resetTurnTaskState() {
    clearSettleTimer();
    pendingTasks.clear();
    tasksSeenThisTurn = 0;
    lastStopReason = undefined;
    resultErrorMessage = undefined;
    needsWakeTextBreak = false;
    workflowFingerprints.clear();
  }

  /** 루트 텍스트 방출 직전 호출 — wake 경계라면 문단 구분을 앞에 붙인다. */
  function rootTextWithWakeBreak(text) {
    if (!needsWakeTextBreak) return text;
    needsWakeTextBreak = false;
    return `\n\n${text}`;
  }

  function endTurn(evt) {
    if (!turnOpen) return;
    clearSettleTimer();
    turnOpen = false;
    onEvent(evt);
  }

  /** result 라인이 담아 온 정보로 턴을 닫는다 — 정착 판정을 거친 뒤에만 호출된다. */
  function settleTurn(source = null) {
    if (!turnOpen) return;
    const event = {
      type: 'turn-end',
      agent: 'claude',
      stopReason: lastStopReason,
      errorMessage: resultErrorMessage,
    };
    if (!source) {
      const proc = child;
      if (!proc) {
        const message = 'Claude process ownership was lost before terminal cleanup';
        uncertainTreeCleanup = true;
        onEvent({ type: 'error', agent: 'claude', message });
        event.stopReason = 'failed';
        event.errorMessage ??= message;
        endTurn(event);
        return;
      }
      const state = childLifecycleStates.get(proc);
      if (state?.settling) return;
      if (state) state.settling = true;
      childAlive = false;
      void stopChildProcess(proc, true).then((cleaned) => {
        if (disposed || !turnOpen) return;
        if (!cleaned) {
          const message = 'Claude process-tree cleanup could not be confirmed after the terminal result';
          onEvent({ type: 'error', agent: 'claude', message });
          event.stopReason = 'failed';
          event.errorMessage ??= message;
        }
        endTurn(event);
      });
      return;
    }
    if (source !== sdkOwner || !source.active || source.settling) return;
    source.settling = true;
    void closeSdkQuery(source).then((cleaned) => {
      if (disposed || !turnOpen) return;
      if (!cleaned) {
        const message = 'Claude SDK cleanup could not be confirmed after the terminal result';
        onEvent({ type: 'error', agent: 'claude', message });
        event.stopReason = 'failed';
        event.errorMessage ??= message;
      }
      endTurn(event);
    });
  }

  function parentTaskIdOf(e) {
    const parent = e?.parent_tool_use_id;
    if (!parent) return undefined;
    return taskIdByToolUse.get(String(parent));
  }

  // ── usage: result 의 modelUsage 는 프로세스 수명 누적치다 ──────────
  // (백그라운드 task 알림이 만드는 wake 재호출마다 같은 턴/프로세스 안에서
  // result 가 반복된다.) 마지막 스냅샷과의 차분만 흘린다.
  /** @type {Map<string, {inputTokens:number,outputTokens:number,cacheReadTokens:number,cacheCreationTokens:number,costUsd:number}>} */
  let usageBaseline = new Map();

  function usageSnapshotOf(raw) {
    const usage = normalizeUsageTokens(raw) ?? {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    };
    const cost = Number(raw?.costUSD ?? raw?.costUsd);
    return { ...usage, costUsd: Number.isFinite(cost) && cost > 0 ? cost : 0 };
  }

  function emitUsage(e) {
    const perModel = e?.modelUsage;
    if (perModel && typeof perModel === 'object' && !Array.isArray(perModel) && Object.keys(perModel).length > 0) {
      for (const [model, raw] of Object.entries(perModel)) {
        const current = usageSnapshotOf(raw);
        const base = usageBaseline.get(model);
        let delta = current;
        if (base) {
          delta = {
            inputTokens: current.inputTokens - base.inputTokens,
            outputTokens: current.outputTokens - base.outputTokens,
            cacheReadTokens: current.cacheReadTokens - base.cacheReadTokens,
            cacheCreationTokens: current.cacheCreationTokens - base.cacheCreationTokens,
            costUsd: current.costUsd - base.costUsd,
          };
          // 카운터가 뒤로 갔다 = 누적이 리셋됐다 — 현재값을 새 기준으로 그대로 흘린다.
          if (delta.inputTokens < 0 || delta.outputTokens < 0
            || delta.cacheReadTokens < 0 || delta.cacheCreationTokens < 0) {
            delta = current;
          }
        }
        usageBaseline.set(model, current);
        const total = delta.inputTokens + delta.outputTokens + delta.cacheReadTokens + delta.cacheCreationTokens;
        if (total > 0) {
          const { costUsd, ...usage } = delta;
          onEvent({
            type: 'usage', agent: 'claude', model: String(model), usage,
            ...(costUsd > 0 ? { costUsd } : {}),
          });
        }
      }
      return;
    }
    // modelUsage 가 없을 때의 result.usage 는 해당 호출 1회분이다 — 그대로 흘린다.
    const usage = normalizeUsageTokens(e?.usage);
    if (usage) onEvent({ type: 'usage', agent: 'claude', model: currentModel, usage });
  }

  /** 워크플로 멤버 상태 (CLI workflow_progress.state → 정규화). */
  function workflowMemberState(item) {
    const s = String(item?.state ?? '');
    if (s === 'done') return 'completed';
    if (s === 'error') return 'failed';
    if ((s === 'start' || s === 'running') && item?.startedAt) return 'running';
    return 'pending';
  }

  /** task_notification/task_updated 의 status → 정규화된 3상태. */
  function normalizeTaskStatus(status) {
    const s = String(status ?? '');
    if (s === 'failed' || s === 'error') return 'failed';
    if (s === 'killed' || s === 'cancelled' || s === 'stopped' || s === 'interrupted') return 'stopped';
    return 'completed';
  }

  /**
   * workflow_progress 배열 → {phases, members}. CLI 는 매 틱 전체 배열을 반복하므로
   * 지문이 달라졌을 때만 값을 돌려준다 (그 외 {}).
   */
  function normalizeWorkflowProgress(taskId, rawList) {
    if (!Array.isArray(rawList) || rawList.length === 0) return {};
    const phases = [];
    const members = [];
    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'workflow_phase' && phases.length < 64) {
        const index = Number(item.index);
        if (Number.isFinite(index)) phases.push({ index, title: String(item.title ?? '') });
      } else if (item.type === 'workflow_agent' && members.length < 100) {
        const index = Number(item.index);
        if (!Number.isFinite(index)) continue;
        const member = { index, label: String(item.label ?? `agent ${index}`), state: workflowMemberState(item) };
        const phaseIndex = Number(item.phaseIndex);
        if (Number.isFinite(phaseIndex)) member.phaseIndex = phaseIndex;
        if (typeof item.model === 'string' && item.model) member.model = item.model;
        const tokens = Number(item.tokens);
        if (Number.isFinite(tokens) && tokens >= 0) member.tokens = Math.round(tokens);
        const toolCalls = Number(item.toolCalls);
        if (Number.isFinite(toolCalls) && toolCalls >= 0) member.toolCalls = Math.round(toolCalls);
        if (typeof item.resultPreview === 'string' && item.resultPreview) {
          member.activity = truncate(item.resultPreview, 160);
        } else if (typeof item.lastToolName === 'string' && item.lastToolName) {
          member.activity = truncate(item.lastToolName, 160);
        }
        members.push(member);
      }
    }
    if (phases.length === 0 && members.length === 0) return {};
    const fingerprint = JSON.stringify([phases, members]);
    if (workflowFingerprints.get(taskId) === fingerprint) return {};
    workflowFingerprints.set(taskId, fingerprint);
    return { phases, members };
  }

  function handleSystemEvent(e) {
    if (e.subtype === 'init') {
      // CLI 가 보고하는 실제 세션 ID 를 추적한다 (--resume 이 새 ID 로 fork 할 수 있다).
      if (e.session_id) sessionId = String(e.session_id);
      if (typeof e.model === 'string' && e.model) currentModel = e.model;
      onEvent({
        type: 'session-info',
        agent: 'claude',
        sessionId: e.session_id ?? sessionId,
        model: e.model,
        mcpStatus: (e.mcp_servers?.find?.((s) => s?.name === 'rhwp')?.status) ?? 'unknown',
      });
      return;
    }
    if (e.subtype === 'task_started') {
      const taskId = String(e.task_id ?? '');
      if (!taskId) return;
      if (e.tool_use_id) {
        taskIdByToolUse.set(String(e.tool_use_id), taskId);
        // 긴 세션 대비 상한 — 가장 오래된 매핑부터 버린다 (늦은 child 이벤트는
        // 귀속만 잃고 루트 스트림으로 떨어질 뿐, 유실되지 않는다).
        if (taskIdByToolUse.size > 512) {
          taskIdByToolUse.delete(taskIdByToolUse.keys().next().value);
        }
      }
      pendingTasks.add(taskId);
      tasksSeenThisTurn++;
      const isWorkflow = e.task_type === 'local_workflow';
      onEvent({
        type: 'task-start',
        agent: 'claude',
        taskId,
        ...(e.tool_use_id ? { callId: String(e.tool_use_id) } : {}),
        title: String(e.description ?? '') || (isWorkflow ? '워크플로' : '서브에이전트'),
        ...(e.subagent_type ? { role: String(e.subagent_type) } : {}),
        taskKind: isWorkflow ? 'workflow' : 'agent',
        ...(e.workflow_name ? { workflowName: String(e.workflow_name) } : {}),
      });
      return;
    }
    if (e.subtype === 'task_progress') {
      const taskId = String(e.task_id ?? '');
      if (!taskId) return;
      const usage = normalizeTaskUsage(e.usage);
      onEvent({
        type: 'task-progress',
        agent: 'claude',
        taskId,
        ...(e.description ? { activity: truncate(String(e.description), 200) } : {}),
        ...(e.last_tool_name ? { lastTool: String(e.last_tool_name) } : {}),
        ...(usage ? { usage } : {}),
        ...normalizeWorkflowProgress(taskId, e.workflow_progress),
      });
      return;
    }
    if (e.subtype === 'task_updated') {
      const taskId = String(e.task_id ?? '');
      const status = e.patch?.status;
      if (!taskId || !status) return;
      if (status === 'completed' || status === 'failed' || status === 'killed') {
        pendingTasks.delete(taskId);
        // summary/usage 는 곧 오는 task_notification 이 채운다 — 상태만 먼저 확정.
        onEvent({ type: 'task-end', agent: 'claude', taskId, status: normalizeTaskStatus(status) });
      }
      return;
    }
    if (e.subtype === 'task_notification') {
      const taskId = String(e.task_id ?? '');
      if (!taskId) return;
      pendingTasks.delete(taskId);
      const usage = normalizeTaskUsage(e.usage);
      onEvent({
        type: 'task-end',
        agent: 'claude',
        taskId,
        status: normalizeTaskStatus(e.status),
        ...(e.summary ? { summary: truncate(String(e.summary), 500) } : {}),
        ...(usage ? { usage } : {}),
      });
      return;
    }
    // 나머지 system subtype (status/thinking_tokens/background_tasks_changed/…)은
    // 정보성 — task_* 수명주기가 유일한 진실이므로 버린다.
  }

  function handleEvent(e, source = null) {
    if (disposed) return; // 폐기 후 죽어가는 CLI 가 흘리는 stdout 은 무시한다.
    if (source && (source !== sdkOwner || !source.active)) return;
    // 새 stdout 라인 = CLI 가 아직 할 일이 있다 — 예약된 턴 정착을 미룬다.
    // (result 분기가 처리 끝에 다시 예약한다.)
    clearSettleTimer();
    if (e?.type === 'system') {
      handleSystemEvent(e);
      return;
    }
    if (e?.type === 'stream_event') {
      const ev = e.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const parentTaskId = parentTaskIdOf(e);
        if (e.parent_tool_use_id) streamedSubagents.add(String(e.parent_tool_use_id));
        else sawRootTextDelta = true;
        if (ev.delta.text) {
          const isRoot = !e.parent_tool_use_id;
          onEvent({
            type: 'text-delta', agent: 'claude',
            text: isRoot ? rootTextWithWakeBreak(ev.delta.text) : ev.delta.text,
            ...(parentTaskId ? { parentTaskId } : {}),
          });
        }
      }
      return;
    }
    if (e?.type === 'assistant') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
      const parentToolUseId = e.parent_tool_use_id ? String(e.parent_tool_use_id) : null;
      const parentTaskId = parentTaskIdOf(e);
      const alreadyStreamed = parentToolUseId
        ? streamedSubagents.has(parentToolUseId)
        : sawRootTextDelta;
      for (const block of blocks) {
        if (block?.type === 'tool_use') {
          onEvent({
            type: 'tool-call',
            agent: 'claude',
            callId: String(block.id ?? ''),
            tool: String(block.name ?? '').replace(/^mcp__rhwp__/, ''),
            argsJson: JSON.stringify(block.input ?? {}),
            ...(parentTaskId ? { parentTaskId } : {}),
          });
        } else if (block?.type === 'text') {
          // Subagent assistant messages carry parent_tool_use_id. Deduplicate
          // them independently so a root text delta never suppresses child text.
          if (!alreadyStreamed && block.text) {
            onEvent({
              type: 'text-delta', agent: 'claude',
              text: parentToolUseId ? block.text : rootTextWithWakeBreak(block.text),
              ...(parentTaskId ? { parentTaskId } : {}),
            });
          }
        }
      }
      return;
    }
    if (e?.type === 'user') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
      const parentTaskId = parentTaskIdOf(e);
      for (const b of blocks) {
        if (b?.type === 'tool_result') {
          onEvent({
            type: 'tool-result',
            agent: 'claude',
            callId: String(b.tool_use_id ?? ''),
            ok: !b.is_error,
            resultPreview: truncate(typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null)),
            ...(parentTaskId ? { parentTaskId } : {}),
          });
        }
      }
      return;
    }
    if (e?.type === 'result') {
      hasCompletedTurn = true;
      emitUsage(e);
      if (e.permission_denials?.length) {
        const names = e.permission_denials
          .map((d) => d?.tool_name ?? d?.tool ?? JSON.stringify(d))
          .join(', ');
        onEvent({ type: 'error', agent: 'claude', message: `permission denied for: ${names}` });
      }
      lastStopReason = e.stop_reason ?? e.subtype;
      // 어느 호출이든 한 번 실패했으면 실패한 턴이다 — studio 가 스테이징 편집을
      // 규칙대로 되돌릴 수 있게 보존한다.
      if (e.is_error) resultErrorMessage = String(e.result);
      // 이 result 뒤에 wake 재호출이 이어질 수 있다 — 그 텍스트는 별개 문단이다.
      needsWakeTextBreak = true;
      if (pendingTasks.size > 0) return; // 백그라운드 fleet 진행 중 — 턴 유지.
      if (tasksSeenThisTurn === 0) {
        // 서브에이전트 없는 보통 턴 — 기존과 동일하게 즉시 닫는다 (지연 없음).
        settleTurn(source);
        return;
      }
      // task 가 있었던 턴: task_notification 이 큐에 남긴 wake 재호출이 이 result
      // 뒤에 이어질 수 있다 (init→…→result 반복). 짧은 정적 후에만 닫는다.
      settleTimer = setTimeout(() => {
        settleTimer = null;
        settleTurn(source);
      }, TASK_SETTLE_GRACE_MS);
      return;
    }
  }

  function dispatchLegacy(text) {
    if (!child) spawnChild();
    else if (!childAlive) throw new Error('Previous Claude process tree cleanup is still pending');
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n';
    child.stdin.write(line, (err) => {
      if (err) process.stderr.write(`[claude] stdin write error: ${err.message}\n`);
    });
  }

  function sdkAbortError(message = 'Claude SDK turn is no longer active') {
    return new DOMException(message, 'AbortError');
  }

  async function requestSdkUserInput(owner, request, signal) {
    if (owner !== sdkOwner || !owner.active || !turnOpen || disposed) {
      throw sdkAbortError();
    }
    const generationSignal = owner.abortController.signal;
    const combinedSignal = signal
      ? AbortSignal.any([signal, generationSignal])
      : generationSignal;
    if (combinedSignal.aborted) throw combinedSignal.reason ?? sdkAbortError();
    const outcome = await new Promise((resolve, reject) => {
      const onAbort = () => reject(combinedSignal.reason ?? sdkAbortError());
      combinedSignal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => opts.requestUserInput(request, combinedSignal))
        .then(resolve, reject)
        .finally(() => combinedSignal.removeEventListener('abort', onAbort));
    });
    if (combinedSignal.aborted) throw combinedSignal.reason ?? sdkAbortError();
    if (owner !== sdkOwner || !owner.active || !turnOpen || disposed) {
      throw sdkAbortError();
    }
    return outcome;
  }

  function failSdkTurn(owner, error) {
    if (owner !== sdkOwner || !owner.active || !turnOpen || disposed) return;
    const message = `claude SDK error: ${error?.message ?? error}`;
    onEvent({ type: 'error', agent: 'claude', message });
    void closeSdkQuery(owner).then((cleaned) => {
      if (disposed || !turnOpen) return;
      if (!cleaned) {
        onEvent({
          type: 'error',
          agent: 'claude',
          message: 'Claude SDK cleanup could not be confirmed after the transport failed',
        });
      }
      endTurn({
        type: 'turn-end',
        agent: 'claude',
        stopReason: cleaned ? 'exited' : 'failed',
      });
    });
  }

  function startSdkQuery() {
    if (sdkOwner) throw new Error('Previous Claude SDK query still owns the session');
    const resume = hasCompletedTurn;
    if (!resume && sessionIdConsumed) sessionId = crypto.randomUUID();
    sessionIdConsumed = true;
    usageBaseline = new Map();
    const owner = {
      generation: ++sdkGeneration,
      query: null,
      queue: createClaudeInputQueue(),
      run: null,
      abortController: new AbortController(),
      active: true,
      sawEvent: false,
      pendingPrompt: null,
      shutdown: null,
      settling: false,
    };
    sdkOwner = owner;
    let query;
    try {
      const launch = claudeCliLaunch();
      const options = buildClaudeSdkOptions({
        ...opts,
        ...(launch.leadingArgs[0] ? { claudeBin: launch.leadingArgs[0] } : {}),
        requestUserInput(request, signal) {
          return requestSdkUserInput(owner, request, signal);
        },
      }, sessionId, resume, owner.abortController);
      options.env = { ...options.env, ...launch.env };
      query = queryAgent({
        prompt: owner.queue,
        options,
      });
    } catch (error) {
      owner.active = false;
      if (sdkOwner === owner) sdkOwner = null;
      try { owner.queue.close(); } catch {}
      try { owner.abortController.abort(sdkAbortError('Claude SDK startup failed')); } catch {}
      throw error;
    }
    owner.query = query;
    owner.run = (async () => {
      try {
        for await (const event of query) {
          if (!owner.active || owner !== sdkOwner) continue;
          owner.sawEvent = true;
          handleEvent(event, owner);
        }
        if (owner === sdkOwner && owner.active && !disposed && turnOpen) {
          throw new Error(owner.sawEvent
            ? 'Claude SDK stream ended before the turn settled'
            : 'Claude SDK transport ended during startup');
        }
      } catch (error) {
        if (owner !== sdkOwner || !owner.active || disposed) return;
        const pendingPrompt = owner.pendingPrompt;
        if (!owner.sawEvent && turnOpen && pendingPrompt !== null) {
          // Capability negotiation failed before Claude produced anything.
          // Shut the SDK transport down before retrying through CLI/MCP. An
          // async first-next rejection can leave the SDK subprocess alive even
          // though this iterator has rejected; overlapping it with legacy would
          // give two providers ownership of the same turn and workspace.
          nativeUserInput = false;
          const cleanupReady = closeSdkQuery(owner);
          void cleanupReady.then((cleaned) => {
            if (disposed || !turnOpen) return;
            if (!cleaned) {
              onEvent({
                type: 'error',
                agent: 'claude',
                message: 'Claude SDK cleanup could not be confirmed; legacy fallback was not started',
              });
              endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'failed' });
              return;
            }
            process.stderr.write(`[claude] native user-input transport unavailable; using MCP fallback: ${error?.message ?? error}\n`);
            try {
              dispatchLegacy(pendingPrompt);
            } catch (fallbackError) {
              onEvent({ type: 'error', agent: 'claude', message: `failed to dispatch message: ${fallbackError?.message ?? fallbackError}` });
              endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'exited' });
            }
          });
          return;
        }
        failSdkTurn(owner, error);
      }
    })();
    return owner;
  }

  function dispatchNative(text) {
    const owner = startSdkQuery();
    owner.pendingPrompt = text;
    owner.queue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    });
  }

  function closeSdkQuery(owner = sdkOwner) {
    if (!owner) return sdkShutdownReady;
    if (owner.shutdown) return owner.shutdown;
    owner.active = false;
    owner.pendingPrompt = null;
    if (sdkOwner === owner) sdkOwner = null;
    try { owner.queue.close(); } catch {}
    try { owner.abortController.abort(sdkAbortError('Claude SDK session closed')); } catch {}

    let closeResult;
    let closeFailed = false;
    try {
      if (typeof owner.query?.close !== 'function') closeFailed = true;
      else closeResult = owner.query.close();
    } catch {
      closeFailed = true;
    }
    const closeReady = closeFailed
      ? Promise.resolve(false)
      : Promise.resolve(closeResult).then(() => true, () => false);
    // Rejection still means the iterator run settled. A close rejection is
    // tracked separately above and remains a failed cleanup outcome.
    const runReady = owner.run
      ? Promise.resolve(owner.run).then(() => true, () => true)
      : Promise.resolve(true);
    let timer;
    const shutdown = Promise.race([
      Promise.all([closeReady, runReady]).then(([closed]) => closed),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), closeGraceMs);
      }),
    ]).finally(() => clearTimeout(timer));
    owner.shutdown = shutdown.then((cleaned) => {
      if (!cleaned) uncertainSdkCleanup = true;
      return cleaned;
    });
    sdkShutdownReady = owner.shutdown;
    return owner.shutdown;
  }

  function spawnChild() {
    const resume = hasCompletedTurn;
    if (!resume && sessionIdConsumed) {
      // 이전 --session-id 스폰이 turn 완료 전에 죽었다 — 그 ID 는 소진되었으므로
      // 새 세션 ID 로 다시 시작한다 (재개할 완료 turn 도 없다).
      sessionId = crypto.randomUUID();
    }
    sessionIdConsumed = true;
    // 새 프로세스 = usage 누적 카운터 리셋 — 차분 기준선도 함께 리셋한다.
    usageBaseline = new Map();
    const launch = claudeCliLaunch();
    const proc = spawnProcess(launch.command, [...launch.leadingArgs, ...buildArgv(resume)], {
      ...processTreeSpawnOptions(),
      cwd: opts.rootDir,
      env: { ...claudeProcessEnv(opts, opts.providerEnv ?? process.env), ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = proc;
    childAlive = true;
    stderrTail = '';
    let acceptOutput = true;
    let outputEnded = false;
    let readerEnded = false;
    let spawnErrorMessage = null;
    /** @type {{ code: number|null, signal: NodeJS.Signals|null } | null} */
    let exitInfo = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let closeGraceTimer = null;
    let resolveDrain = () => {};
    const readStdout = createLineReader((event) => {
      // createLineReader can have more complete frames in the chunk that
      // contained the terminal result. Recheck ownership for every frame, not
      // only once at the data-event boundary.
      if (proc !== child || disposed || !acceptOutput) return;
      handleEvent(event);
    });
    const lifecycleState = {
      forcedCleanup: false,
      drainedClose: false,
      completedAtDrain: false,
      code: null,
      settling: false,
    };
    childLifecycleStates.set(proc, lifecycleState);
    const drained = new Promise((resolve) => { resolveDrain = resolve; });
    childDrainPromises.set(proc, drained);
    const closeOutputReader = (flush) => {
      if (readerEnded) return;
      readerEnded = true;
      acceptOutput = false;
      if (flush) readStdout.end();
      else readStdout.discard();
    };
    const discardOutputReader = () => closeOutputReader(false);
    const finishOutput = (flush) => {
      if (outputEnded) return;
      outputEnded = true;
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer);
        closeGraceTimer = null;
      }
      closeOutputReader(flush);
      resolveDrain(true);
      resolveDrain = () => {};
    };
    const endOutput = () => finishOutput(true);
    const discardOutput = () => finishOutput(false);
    childOutputDiscarders.set(proc, discardOutput);
    suppressChildOutput = () => {
      if (proc === child) discardOutput();
    };
    const settleUnexpectedExit = (code, signal, fromClose) => {
      if (proc !== child || outputEnded) return;
      lifecycleState.drainedClose = fromClose;
      lifecycleState.code = code ?? null;
      if (fromClose) endOutput();
      else discardOutput();
      lifecycleState.completedAtDrain = !turnOpen && hasCompletedTurn;
      if (turnOpen && !disposed) {
        onEvent({
          type: 'error',
          agent: 'claude',
          message: spawnErrorMessage
            ?? formatClaudeExitError(stderrTail, code, signal, opts.token),
        });
        endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'exited' });
      }
    };
    const scheduleCloseGrace = (code, signal) => {
      if (outputEnded || closeGraceTimer) return;
      closeGraceTimer = setTimeout(() => {
        closeGraceTimer = null;
        settleUnexpectedExit(code ?? null, signal ?? null, false);
      }, closeGraceMs);
      closeGraceTimer.unref?.();
    };
    childDrainStarters.set(proc, () => scheduleCloseGrace(
      exitInfo?.code ?? proc.exitCode ?? null,
      exitInfo?.signal ?? proc.signalCode ?? null,
    ));
    proc.stdout.on('data', (chunk) => {
      if (proc !== child || disposed || !acceptOutput) return;
      readStdout(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      if (proc !== child || disposed || !acceptOutput) return;
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });
    proc.on('error', (err) => {
      if (proc !== child) return;
      childAlive = false;
      discardOutputReader();
      const safeError = redactDiagnosticText(err?.message ?? err, [opts.token]);
      spawnErrorMessage = `claude process error: ${safeError}`;
      process.stderr.write(`[claude] spawn error: ${safeError}\n`);
      void stopChildProcess(proc, true, false);
      scheduleCloseGrace(proc.exitCode ?? null, proc.signalCode ?? null);
    });
    proc.on('exit', (code, signal) => {
      if (proc !== child) return;
      childAlive = false;
      exitInfo = { code, signal };
      void stopChildProcess(proc, false);
      scheduleCloseGrace(code, signal);
    });
    proc.on('close', (code, signal) => {
      settleUnexpectedExit(code ?? exitInfo?.code ?? null, signal ?? exitInfo?.signal ?? null, true);
      void stopChildProcess(proc, false);
    });
    return proc;
  }

  function stopChildProcess(proc, forced = true, suppressOutput = forced) {
    if (!proc) return Promise.resolve(true);
    if (suppressOutput) childOutputDiscarders.get(proc)?.();
    const lifecycleState = childLifecycleStates.get(proc);
    if (lifecycleState) lifecycleState.forcedCleanup ||= forced;
    const active = childCleanupPromises.get(proc);
    if (active) return active;
    let resolveCleanup = () => {};
    const cleanup = new Promise((resolve) => { resolveCleanup = resolve; });
    childCleanupPromises.set(proc, cleanup);
    let termination;
    let exited;
    try { termination = Promise.resolve(terminateProcess(proc)); } catch { termination = Promise.resolve(false); }
    try { exited = Promise.resolve(waitForExit(proc)); } catch { exited = Promise.resolve(false); }
    void Promise.all([termination, exited]).then(
      ([terminationResult, exitResult]) => processTreeCleanupOutcome(
        terminationResult,
        exitResult,
      ),
      () => PROCESS_TREE_CLEANUP_OUTCOME.FAILED,
    ).then(async (outcome) => {
      if (outcome !== PROCESS_TREE_CLEANUP_OUTCOME.PROVEN) uncertainTreeCleanup = true;
      childDrainStarters.get(proc)?.();
      await (childDrainPromises.get(proc) ?? Promise.resolve());
      const state = childLifecycleStates.get(proc);
      const naturalDrainedRelease = outcome === PROCESS_TREE_CLEANUP_OUTCOME.UNAVAILABLE
        && state?.drainedClose === true
        && state.completedAtDrain === true
        && state.code === 0
        && state.forcedCleanup !== true;
      const released = outcome === PROCESS_TREE_CLEANUP_OUTCOME.PROVEN || naturalDrainedRelease;
      if (released && child === proc) child = null;
      resolveCleanup(outcome === PROCESS_TREE_CLEANUP_OUTCOME.PROVEN);
    });
    return cleanup;
  }

  function killChild() {
    return stopChildProcess(child);
  }

  function restartForConfigChange() {
    const priorReady = restartReady;
    const previous = child;
    const sdkShutdownReady = closeSdkQuery();
    childAlive = false;
    const shutdownReady = stopChildProcess(previous, true);
    // Preserve an earlier in-flight restart barrier when permission and
    // execution-mode updates arrive back-to-back.
    restartReady = Promise.all([priorReady, shutdownReady, sdkShutdownReady]).then(([, childCleaned, sdkCleaned]) => {
      if (sdkCleaned === false) throw new Error('Claude SDK cleanup could not be confirmed for restart');
      if (childCleaned === false) throw new Error('Claude process tree could not be stopped for restart');
    });
    return restartReady;
  }

  function beginQueuedTurn(text) {
    if (disposed) return;
    turnOpen = true;
    sawRootTextDelta = false;
    streamedSubagents.clear();
    resetTurnTaskState();
    onEvent({ type: 'turn-start', agent: 'claude' });
    try {
      if (nativeUserInput) dispatchNative(text);
      else dispatchLegacy(text);
    } catch (error) {
      let failure = error;
      if (nativeUserInput) {
        nativeUserInput = false;
        process.stderr.write(`[claude] native user-input transport unavailable; using MCP fallback: ${error?.message ?? error}\n`);
        try {
          dispatchLegacy(text);
          return;
        } catch (fallbackError) {
          failure = fallbackError;
        }
      }
      onEvent({ type: 'error', agent: 'claude', message: `failed to dispatch message: ${failure?.message ?? failure}` });
      endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'exited' });
    }
  }

  function failQueuedTurn(entry, error) {
    if (queuedTurn !== entry) return;
    queuedTurn = null;
    if (disposed) return;
    onEvent({
      type: 'error',
      agent: 'claude',
      message: error?.message ?? 'Claude process-tree cleanup could not be confirmed before the next turn',
    });
    // The hub allocated this user turn before dispatch. Close that allocation
    // without advertising provider authority through a matching turn-start.
    onEvent({ type: 'turn-end', agent: 'claude', stopReason: 'failed' });
  }

  return {
    agent: 'claude',
    getSessionId() {
      return sessionId;
    },
    sendUserMessage(text) {
      if (disposed) return;
      if (turnOpen || queuedTurn) throw new Error('Claude already has a turn in progress');
      if (uncertainSdkCleanup) {
        throw new Error('Claude SDK cleanup remains unconfirmed; start a new isolated session');
      }
      if (uncertainTreeCleanup) {
        throw new Error('Claude process-tree cleanup remains unconfirmed; start a new isolated session');
      }
      const entry = { text };
      queuedTurn = entry;
      void Promise.all([restartReady, sdkShutdownReady]).then(async ([, sdkCleaned]) => {
        if (queuedTurn !== entry || disposed) return;
        if (!sdkCleaned) {
          failQueuedTurn(entry, new Error(
            'Claude SDK cleanup remains unconfirmed; start a new isolated session',
          ));
          return;
        }
        if (child && !childAlive) {
          const released = await stopChildProcess(child, false);
          if (queuedTurn !== entry || disposed) return;
          if (!released || child) {
            failQueuedTurn(entry);
            return;
          }
        }
        queuedTurn = null;
        beginQueuedTurn(entry.text);
      }, (error) => failQueuedTurn(entry, error));
    },
    async setPermissionProfile(profile) {
      if (turnOpen || queuedTurn) throw new Error('Permission profile can only change between turns');
      if (uncertainSdkCleanup) throw new Error('Claude SDK cleanup remains unconfirmed');
      if (uncertainTreeCleanup) throw new Error('Claude process tree cleanup remains unconfirmed');
      if (profile !== 'safe' && profile !== 'unrestricted') throw new Error(`Unknown permission profile: ${profile}`);
      if (opts.permissionProfile === profile) {
        const [, sdkCleaned] = await Promise.all([restartReady, sdkShutdownReady]);
        if (!sdkCleaned) throw new Error('Claude SDK cleanup remains unconfirmed');
        return;
      }
      const previous = opts.permissionProfile;
      opts.permissionProfile = profile;
      try {
        await restartForConfigChange();
      } catch (error) {
        opts.permissionProfile = previous;
        restartReady = Promise.resolve();
        throw error;
      }
    },
    async setExecutionMode(mode) {
      if (turnOpen || queuedTurn) throw new Error('Execution mode can only change between turns');
      if (uncertainSdkCleanup) throw new Error('Claude SDK cleanup remains unconfirmed');
      if (uncertainTreeCleanup) throw new Error('Claude process tree cleanup remains unconfirmed');
      validateExecutionMode(mode);
      const current = normalizeExecutionMode(opts);
      if (current.workflow === mode.workflow
        && current.phase === mode.phase
        && String(current.capabilityEpoch) === String(mode.capabilityEpoch)) {
        const [, sdkCleaned] = await Promise.all([restartReady, sdkShutdownReady]);
        if (!sdkCleaned) throw new Error('Claude SDK cleanup remains unconfirmed');
        return;
      }
      opts.workflow = mode.workflow;
      opts.phase = mode.phase;
      opts.capabilityEpoch = mode.capabilityEpoch;
      try {
        await restartForConfigChange();
      } catch (error) {
        opts.workflow = current.workflow;
        opts.phase = current.phase;
        opts.capabilityEpoch = current.capabilityEpoch;
        restartReady = Promise.resolve();
        throw error;
      }
    },
    interrupt() {
      queuedTurn = null;
      if (sdkOwner) {
        // Closing the SDK query aborts the exact signal handed to canUseTool,
        // so an open host question is cancelled with the turn.
        void closeSdkQuery();
      }
      suppressChildOutput();
      killChild();
      childAlive = false;
      endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'interrupted' });
    },
    dispose() {
      disposed = true;
      turnOpen = false;
      queuedTurn = null;
      clearSettleTimer();
      suppressChildOutput();
      // 죽어가는 자식의 stdout 을 아예 파싱하지 않는다.
      try { child?.stdout?.removeAllListeners('data'); } catch {}
      const exited = Promise.all([stopChildProcess(child, true), closeSdkQuery()])
        .then(([childExited, sdkExited]) => {
          // A surviving descendant can still write the isolated credential.
          // Leave its journal/root marker intact for dead-owner recovery.
          const cleaned = childExited && sdkExited
            && !uncertainTreeCleanup && !uncertainSdkCleanup;
          if (cleaned) flushCredentialMirrors(opts.isolatedHome);
          return cleaned;
        });
      childAlive = false;
      return exited;
    },
  };
}
