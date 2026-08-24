// cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
import spawn from 'cross-spawn';
import crypto from 'node:crypto';
import { query as queryClaude } from '@anthropic-ai/claude-agent-sdk';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import {
  createLineReader,
  isPlanningRestricted,
  mcpCapabilityEnv,
  mcpRuntimeFor,
  normalizeExecutionMode,
  normalizeTaskUsage,
  normalizeUsageTokens,
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
  processTreeSpawnOptions,
  terminateProcessTree,
  waitForProcessTreeExit,
} from '../process-tree.mjs';

// Agent/Workflow 는 모든 모드에서 켠다 — --tools 제한은 서브에이전트에도 상속되므로
// (CLI 확인: 2.1.235) planning 의 read-only 경계가 서브에이전트에서도 유지된다.
const DIRECT_TOOLS = 'Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch,Agent,Workflow';
const PLAN_IMPLEMENTATION_TOOLS = DIRECT_TOOLS;
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

function seedClaudeCredential(source, target, {
  copyFile = copyFileSync,
  platform = process.platform,
  symlink = symlinkSync,
} = {}) {
  if (!source) return;
  let sourceStat;
  try {
    sourceStat = lstatSync(source);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return;

  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const targetStat = lstatSync(target);
    if (!targetStat.isSymbolicLink()) return;
    const linkedTarget = path.resolve(path.dirname(target), readlinkSync(target));
    if (linkedTarget === path.resolve(source)) return;
    unlinkSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    symlink(source, target);
  } catch (error) {
    const copyFallback = platform === 'win32'
      && (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOTSUP');
    if (!copyFallback) throw error;
    copyFile(source, target);
  }
}

/** Seed only Claude's shared login files into an otherwise isolated home. */
export function prepareClaudeHome(isolatedHome, {
  credentialsPath,
  configPath,
} = {}, deps = {}) {
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  seedClaudeCredential(
    credentialsPath,
    path.join(isolatedHome, '.claude', '.credentials.json'),
    deps,
  );
  seedClaudeCredential(configPath, path.join(isolatedHome, '.claude.json'), deps);
}

export function formatClaudeExitError(stderrText, code, signal, token) {
  let clean = String(stderrText ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  if (token) clean = clean.split(token).join('[redacted]');
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

export function buildClaudeArgv(opts, sessionId, resume) {
  const unrestricted = opts.permissionProfile === 'unrestricted';
  const planningRestricted = isPlanningRestricted(opts);
  const planWorkflow = opts.workflow === 'plan';
  const activeTools = planWorkflow
    ? (planningRestricted ? PLANNING_TOOLS : PLAN_IMPLEMENTATION_TOOLS)
    : DIRECT_TOOLS;
  const capabilityEnv = mcpCapabilityEnv(opts);
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
    ...(!planningRestricted ? [
      permissionPathRule('Write', opts.rootDir),
      permissionPathRule('Edit', opts.rootDir),
    ] : []),
    permissionPathRule('Glob', opts.rootDir),
    permissionPathRule('Grep', opts.rootDir),
    'Bash',
    'WebSearch', 'WebFetch', 'Agent', 'Workflow', 'mcp__rhwp__*',
  ];
  const settings = unrestricted && !planningRestricted ? {} : {
    permissions: { allow },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowRead: [opts.rootDir],
        allowWrite: planningRestricted ? [] : [opts.rootDir],
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
    ...(unrestricted && !planningRestricted
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
  const planWorkflow = opts.workflow === 'plan';
  const activeTools = planWorkflow
    ? (planningRestricted ? PLANNING_TOOLS : PLAN_IMPLEMENTATION_TOOLS)
    : DIRECT_TOOLS;
  const capabilityEnv = mcpCapabilityEnv(opts);
  const runtime = mcpRuntimeFor(opts);
  const allow = [
    permissionPathRule('Read', opts.rootDir),
    ...(!planningRestricted ? [
      permissionPathRule('Write', opts.rootDir),
      permissionPathRule('Edit', opts.rootDir),
    ] : []),
    permissionPathRule('Glob', opts.rootDir),
    permissionPathRule('Grep', opts.rootDir),
    'Bash',
    'WebSearch', 'WebFetch', 'Agent', 'Workflow', 'mcp__rhwp__*',
  ];
  const settings = unrestricted && !planningRestricted ? {} : {
    permissions: { allow },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowRead: [opts.rootDir],
        allowWrite: planningRestricted ? [] : [opts.rootDir],
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
    env: isolatedProcessEnv(opts, opts.providerEnv ?? process.env),
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
    permissionMode: unrestricted && !planningRestricted ? 'bypassPermissions' : 'default',
    ...(unrestricted && !planningRestricted ? { allowDangerouslySkipPermissions: true } : {}),
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
  queryAgent = queryClaude,
} = {}) {
  let sessionId = crypto.randomUUID();
  const onEvent = opts.onEvent;

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let childAlive = false;
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
  let stderrTail = '';
  // Only root chat sessions with a host callback enter the bidirectional SDK
  // transport. Any SDK initialization failure before the first provider frame
  // permanently selects the existing CLI+MCP path for this session.
  let nativeUserInput = typeof opts.requestUserInput === 'function'
    && isRootUserInputContext({ agentRole: opts.agentRole });
  let sdkQuery = null;
  let sdkQueue = null;
  let sdkRun = null;
  let sdkAbortController = null;
  let sdkSawEvent = false;
  let sdkPendingPrompt = null;
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
  function settleTurn() {
    endTurn({
      type: 'turn-end',
      agent: 'claude',
      stopReason: lastStopReason,
      errorMessage: resultErrorMessage,
    });
  }

  function parentTaskIdOf(e) {
    const parent = e?.parent_tool_use_id;
    if (!parent) return undefined;
    return taskIdByToolUse.get(String(parent));
  }

  // ── usage: result 의 modelUsage 는 프로세스 수명 누적치다 ──────────
  // (백그라운드 task 알림이 만드는 wake 재호출마다 result 가 반복되고, 같은
  // 프로세스의 다음 턴에도 누적이 이어진다.) 마지막 스냅샷과의 차분만 흘린다.
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

  function handleEvent(e) {
    if (disposed) return; // 폐기 후 죽어가는 CLI 가 흘리는 stdout 은 무시한다.
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
        settleTurn();
        return;
      }
      // task 가 있었던 턴: task_notification 이 큐에 남긴 wake 재호출이 이 result
      // 뒤에 이어질 수 있다 (init→…→result 반복). 짧은 정적 후에만 닫는다.
      settleTimer = setTimeout(() => {
        settleTimer = null;
        settleTurn();
      }, TASK_SETTLE_GRACE_MS);
      if (settleTimer.unref) settleTimer.unref();
      return;
    }
  }

  function dispatchLegacy(text) {
    if (!child || !childAlive) spawnChild();
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n';
    child.stdin.write(line, (err) => {
      if (err) process.stderr.write(`[claude] stdin write error: ${err.message}\n`);
    });
  }

  function startSdkQuery() {
    const resume = hasCompletedTurn;
    if (!resume && sessionIdConsumed) sessionId = crypto.randomUUID();
    sessionIdConsumed = true;
    usageBaseline = new Map();
    sdkSawEvent = false;
    sdkAbortController = new AbortController();
    sdkQueue = createClaudeInputQueue();
    let query;
    try {
      query = queryAgent({
        prompt: sdkQueue,
        options: buildClaudeSdkOptions(opts, sessionId, resume, sdkAbortController),
      });
    } catch (error) {
      try { sdkQueue.close(); } catch {}
      try { sdkAbortController.abort(new DOMException('Claude SDK startup failed', 'AbortError')); } catch {}
      sdkQueue = null;
      sdkAbortController = null;
      throw error;
    }
    sdkQuery = query;
    sdkRun = (async () => {
      try {
        for await (const event of query) {
          sdkSawEvent = true;
          handleEvent(event);
        }
        if (query === sdkQuery && !disposed && turnOpen) {
          throw new Error(sdkSawEvent
            ? 'Claude SDK stream ended before the turn settled'
            : 'Claude SDK transport ended during startup');
        }
      } catch (error) {
        if (query !== sdkQuery || disposed) return;
        const pendingPrompt = sdkPendingPrompt;
        if (!sdkSawEvent && turnOpen && pendingPrompt !== null) {
          // Capability negotiation failed before Claude produced anything.
          // Retry this turn once through the proven CLI/MCP transport.
          nativeUserInput = false;
          try { sdkQueue?.close(); } catch {}
          try { sdkAbortController?.abort(new DOMException('Claude SDK startup failed', 'AbortError')); } catch {}
          sdkQuery = null;
          sdkQueue = null;
          sdkAbortController = null;
          sdkPendingPrompt = null;
          process.stderr.write(`[claude] native user-input transport unavailable; using MCP fallback: ${error?.message ?? error}\n`);
          try {
            dispatchLegacy(pendingPrompt);
          } catch (fallbackError) {
            onEvent({ type: 'error', agent: 'claude', message: `failed to dispatch message: ${fallbackError?.message ?? fallbackError}` });
            endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'exited' });
          }
          return;
        }
        if (turnOpen) {
          onEvent({ type: 'error', agent: 'claude', message: `claude SDK error: ${error?.message ?? error}` });
          endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'exited' });
        }
      } finally {
        if (query === sdkQuery) {
          sdkQuery = null;
          sdkQueue = null;
          sdkAbortController = null;
          sdkPendingPrompt = null;
        }
      }
    })();
    return query;
  }

  function dispatchNative(text) {
    if (!sdkQuery) startSdkQuery();
    sdkPendingPrompt = text;
    sdkQueue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    });
  }

  function closeSdkQuery() {
    const query = sdkQuery;
    const queue = sdkQueue;
    const run = sdkRun;
    sdkQuery = null;
    sdkQueue = null;
    sdkRun = null;
    sdkPendingPrompt = null;
    try { queue?.close(); } catch {}
    try { sdkAbortController?.abort(new DOMException('Claude session closed', 'AbortError')); } catch {}
    sdkAbortController = null;
    try { query?.close(); } catch {}
    if (!run) return Promise.resolve();
    return Promise.race([
      Promise.resolve(run).catch(() => {}),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 3500);
        if (timer.unref) timer.unref();
      }),
    ]).then(() => {});
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
    const proc = spawnProcess(opts.claudeBin ?? 'claude', buildArgv(resume), {
      ...processTreeSpawnOptions(),
      cwd: opts.rootDir,
      env: isolatedProcessEnv(opts, opts.providerEnv ?? process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = proc;
    childAlive = true;
    stderrTail = '';
    proc.stdout.on('data', createLineReader(handleEvent));
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) process.stderr.write(`[claude] ${line}\n`);
      }
    });
    proc.on('error', (err) => {
      if (proc !== child) return;
      childAlive = false;
      process.stderr.write(`[claude] spawn error: ${err?.message ?? err}\n`);
      if (turnOpen) {
        onEvent({ type: 'error', agent: 'claude', message: `claude process error: ${err?.message ?? err}` });
        endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'exited' });
      }
    });
    proc.on('exit', (code, signal) => {
      if (proc !== child) return;
      childAlive = false;
      if (turnOpen && !disposed) {
        onEvent({
          type: 'error',
          agent: 'claude',
          message: formatClaudeExitError(stderrTail, code, signal, opts.token),
        });
        endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'exited' });
      }
    });
    return proc;
  }

  function killChild() {
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    terminateProcess(proc);
  }

  function restartForConfigChange() {
    const priorReady = restartReady;
    const previous = child;
    const sdkShutdownReady = closeSdkQuery();
    killChild();
    child = null;
    childAlive = false;
    let shutdownReady;
    if (previous && previous.exitCode === null && previous.signalCode === null) {
      shutdownReady = new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        previous.once('exit', finish);
        const timer = setTimeout(finish, 3500);
        if (timer.unref) timer.unref();
      });
    } else {
      shutdownReady = Promise.resolve();
    }
    // Preserve an earlier in-flight restart barrier when permission and
    // execution-mode updates arrive back-to-back.
    restartReady = Promise.all([priorReady, shutdownReady, sdkShutdownReady]).then(() => {});
    return restartReady;
  }

  return {
    agent: 'claude',
    getSessionId() {
      return sessionId;
    },
    sendUserMessage(text) {
      if (disposed) return;
      turnOpen = true;
      sawRootTextDelta = false;
      streamedSubagents.clear();
      resetTurnTaskState();
      onEvent({ type: 'turn-start', agent: 'claude' });
      void restartReady.then(() => {
        if (disposed || !turnOpen) return;
        try {
          if (nativeUserInput) dispatchNative(text);
          else dispatchLegacy(text);
        } catch (e) {
          if (nativeUserInput) {
            nativeUserInput = false;
            process.stderr.write(`[claude] native user-input transport unavailable; using MCP fallback: ${e?.message ?? e}\n`);
            try {
              dispatchLegacy(text);
              return;
            } catch (fallbackError) {
              e = fallbackError;
            }
          }
          onEvent({ type: 'error', agent: 'claude', message: `failed to dispatch message: ${e?.message ?? e}` });
          endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'exited' });
        }
      });
    },
    setPermissionProfile(profile) {
      if (turnOpen) throw new Error('Permission profile can only change between turns');
      if (profile !== 'safe' && profile !== 'unrestricted') throw new Error(`Unknown permission profile: ${profile}`);
      if (opts.permissionProfile === profile) return;
      opts.permissionProfile = profile;
      void restartForConfigChange();
    },
    async setExecutionMode(mode) {
      if (turnOpen) throw new Error('Execution mode can only change between turns');
      validateExecutionMode(mode);
      const current = normalizeExecutionMode(opts);
      if (current.workflow === mode.workflow
        && current.phase === mode.phase
        && String(current.capabilityEpoch) === String(mode.capabilityEpoch)) {
        await restartReady;
        return;
      }
      opts.workflow = mode.workflow;
      opts.phase = mode.phase;
      opts.capabilityEpoch = mode.capabilityEpoch;
      await restartForConfigChange();
    },
    interrupt() {
      if (sdkQuery) {
        // Closing the SDK query aborts the exact signal handed to canUseTool,
        // so an open host question is cancelled with the turn.
        void closeSdkQuery();
      }
      killChild();
      childAlive = false;
      endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'interrupted' });
    },
    dispose() {
      disposed = true;
      turnOpen = false;
      clearSettleTimer();
      // 죽어가는 자식의 stdout 을 아예 파싱하지 않는다.
      try { child?.stdout?.removeAllListeners('data'); } catch {}
      const exited = Promise.all([waitForProcessTreeExit(child), closeSdkQuery()]).then(([childExited]) => childExited);
      killChild();
      childAlive = false;
      return exited;
    },
  };
}
