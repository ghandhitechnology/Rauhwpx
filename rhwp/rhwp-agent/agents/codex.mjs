// cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
import spawn from 'cross-spawn';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  credentialMirrorHasPendingCopybackSync,
  flushCredentialMirrorSync,
  prepareCredentialMirrorSync,
} from '../credential-mirror.mjs';
import {
  createLineReader,
  isPlanningRestricted,
  mcpCapabilityEnv,
  mcpRuntimeFor,
  normalizeExecutionMode,
  normalizeUsageTokens,
  redactDiagnosticText,
  systemBriefFor,
  truncate,
  validateExecutionMode,
} from './backend.mjs';
import { createCodexRolloutWatcher } from './codex-rollout-watcher.mjs';
import { createCodexAppServerSession } from './codex-app-server.mjs';
import { isRootUserInputContext } from './provider-user-input.mjs';
export {
  CODEX_REQUEST_USER_INPUT_METHOD,
  codexDefaultModeUserInputEnabled,
  decodeCodexRequestUserInputFrame,
  encodeCodexRequestUserInputFrame,
  handleCodexRequestUserInputFrame,
  selectCodexUserInputTransport,
} from './provider-user-input.mjs';
import {
  isolatedProcessEnv,
  processTreeSpawnOptions,
  terminateProcessTree,
  waitForProcessTreeExit,
} from '../process-tree.mjs';

const STDERR_TAIL_LIMIT = 16_000;
const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';

/**
 * Recreate the isolated Codex home if the OS purged its temporary parent while
 * the long-running hub was idle. The auth link is restored with the directory.
 *
 * @param {string} codexHome
 * @param {string} [authPath]
 */
const codexMirrorsByHome = new Map();

export function prepareCodexHome(codexHome, authPath, deps = {}) {
  const key = path.resolve(codexHome);
  const previous = codexMirrorsByHome.get(key);
  if (previous) {
    const result = flushCredentialMirrorSync(previous, { platform: deps.platform ?? process.platform });
    if (result.pending) throw Object.assign(new Error(result.errorMessage), { code: result.errorCode });
    if (!result.conflict) rmSync(previous.target, { force: true });
    codexMirrorsByHome.delete(key);
  }
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const mirror = prepareCredentialMirrorSync(authPath, path.join(codexHome, 'auth.json'), {
    platform: deps.platform ?? process.platform,
    ...(deps.symlink ? { symlink: deps.symlink } : {}),
  });
  if (mirror?.mode === 'copy') codexMirrorsByHome.set(key, mirror);
  return mirror;
}

export function flushCodexCredentialMirror(codexHome) {
  const key = path.resolve(String(codexHome));
  const mirror = codexMirrorsByHome.get(key);
  if (!mirror) return true;
  try {
    const result = flushCredentialMirrorSync(mirror);
    if (result.pending) {
      process.stderr.write(`[codex] credential refresh copyback pending: ${result.errorMessage}\n`);
      return false;
    }
    codexMirrorsByHome.delete(key);
    if (result.conflict) {
      process.stderr.write(`[codex] credential refresh copyback conflicted: ${mirror.source}\n`);
    }
  } catch (error) {
    process.stderr.write(`[codex] credential refresh copyback failed: ${error?.message ?? error}\n`);
    if (credentialMirrorHasPendingCopybackSync(mirror)) return false;
    codexMirrorsByHome.delete(key);
  }
  return true;
}

function withCredentialCopyback(session, codexHome) {
  const dispose = session.dispose.bind(session);
  let disposed = false;
  session.dispose = async () => {
    const cleaned = await dispose();
    if (cleaned !== false && !disposed) {
      disposed = flushCodexCredentialMirror(codexHome);
    }
    return cleaned;
  };
  return session;
}

/**
 * Build a CLI invocation accepted by both `codex exec` and `codex exec resume`.
 * Resume does not accept the top-level `--sandbox` or `-C` flags, so sandbox
 * mode is supplied through the shared config surface and cwd through spawn().
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 * @param {string | null} threadId
 */
export function buildCodexArgv(opts, threadId) {
  const unrestricted = opts.permissionProfile === 'unrestricted';
  const planningRestricted = isPlanningRestricted(opts);
  const runtime = mcpRuntimeFor(opts);
  const capabilityEnv = {
    ...runtime.env,
    RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
    RHWP_AGENT_TOKEN: opts.token,
    RHWP_AGENT_NAME: 'codex',
    ...mcpCapabilityEnv(opts),
  };
  const mcpEnv = Object.entries(capabilityEnv)
    .map(([key, value]) => `${key} = ${JSON.stringify(String(value))}`)
    .join(', ');
  const cfg = [
    '-c', `mcp_servers.rhwp.command=${JSON.stringify(runtime.command)}`,
    '-c', `mcp_servers.rhwp.args=${JSON.stringify(runtime.args)}`,
    '-c', `mcp_servers.rhwp.env={${mcpEnv}}`,
    '-c', 'mcp_servers.rhwp.startup_timeout_sec=20',
    // 헤드리스 MCP 호출은 승인 프롬프트를 표시할 수 없다. rhwp 도구를 자동 승인하며,
    // Studio는 성공한 문서 편집을 자동 커밋하고 undo 이력을 보존한다. 최초 실행과
    // resume 하위 명령이 모두 이해하는 설정 키만 사용한다.
    '-c', 'mcp_servers.rhwp.default_tools_approval_mode="auto"',
    '-c', 'approval_policy="never"',
    '-c', `sandbox_mode="${planningRestricted || opts.toolProfile === 'copy-layout-worker' ? 'read-only' : (unrestricted ? 'danger-full-access' : 'workspace-write')}"`,
    ...(opts.workflow === 'plan' || opts.workflow === 'question' ? ['-c', 'web_search="live"'] : []),
    ...(opts.effort
      ? ['-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`]
      : []),
    ...(opts.serviceTier === 'fast'
      ? ['-c', 'service_tier="fast"']
      : []),
  ];
  const common = [
    '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
    '--disable', 'image_generation',
    // 네이티브 서브에이전트는 항상 켠다. `--disable multi_agent` 는 0.147.0 에서
    // 실제로 스폰을 막지 못하므로(프로브 확인) 토글할 이유가 없고, 명시적으로 켜 두면
    // exec 와 exec resume 이 같은 능력으로 돈다.
    ...(opts.toolProfile === 'copy-layout-worker'
      ? [
        '--disable', 'multi_agent', '--disable', 'shell_tool', '--disable', 'unified_exec',
        '--disable', 'code_mode_host', '--disable', 'standalone_web_search',
        '--disable', 'view_image', '--disable', 'shell_snapshot',
      ]
      : ['--enable', 'multi_agent']),
    '--disable', 'plugins',
    '--disable', 'skill_search',
    '-m', opts.model ?? DEFAULT_CODEX_MODEL, ...cfg,
  ];
  return threadId
    ? ['exec', 'resume', ...common, threadId, '-']
    : ['exec', ...common, '-C', opts.rootDir, '-'];
}

/**
 * Turn CLI stderr into a concise user-facing reason without leaking the
 * session token embedded in the MCP config.
 *
 * @param {string} stderrText
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @param {string} token
 */
export function formatCodexExitError(stderrText, code, signal, token) {
  const clean = redactDiagnosticText(stderrText, [token]);
  const detail = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Usage:/i.test(line) && !/^For more information/i.test(line))
    .slice(-8)
    .join('\n');
  const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
  return detail
    ? `Codex 실행이 중단되었습니다 (${exit}).\n${truncate(detail, 1200)}`
    : `Codex 실행이 중단되었습니다 (${exit}). Codex가 오류 설명을 제공하지 않았습니다.`;
}

/**
 * @param {import('./backend.mjs').BackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createLegacyCodexSession(opts, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
  waitForExit = waitForProcessTreeExit,
  createRolloutWatcher = createCodexRolloutWatcher,
  initialThreadId = null,
} = {}) {
  const onEvent = opts.onEvent;

  /** @type {string | null} */
  let threadId = initialThreadId;
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let turnOpen = false;
  let turnCompleted = false;
  let turnFailureMessage = null;
  let disposed = false;
  let loggedToolCallSample = false;
  let stderrTail = '';
  let childExitPromise = Promise.resolve(true);
  let stopChild = () => Promise.resolve(true);
  const pendingTreeCleanups = new Set();
  let uncertainTreeCleanup = false;
  /**
   * 이번 턴의 롤아웃 워처. codex --json 에는 자식 에이전트 활동이 한 줄도 오지
   * 않으므로 fleet 카드의 유일한 소스다.
   * @type {ReturnType<typeof createCodexRolloutWatcher> | null}
   */
  let rolloutWatcher = null;

  /** 턴이 닫히기 전에 마지막 롤아웃을 훑고 남은 카드를 정리한다. */
  function finalizeRolloutWatcher() {
    const watcher = rolloutWatcher;
    rolloutWatcher = null;
    if (!watcher) return;
    try {
      watcher.finalize();
    } catch (error) {
      process.stderr.write(`[codex] rollout finalize error: ${error?.message ?? error}\n`);
    }
  }

  function endTurn(evt) {
    if (!turnOpen) return;
    turnOpen = false;
    onEvent(evt);
  }

  function makeHandler() {
    const lastText = new Map();
    return (e) => {
      if (disposed) return; // 폐기 후 죽어가는 CLI 가 흘리는 stdout 은 무시한다.
      const type = e?.type;
      if (type === 'thread.started') {
        if (e.thread_id) {
          threadId = String(e.thread_id);
          onEvent({ type: 'session-info', agent: 'codex', sessionId: threadId });
          // 루트 스레드 id 를 알게 된 순간이 롤아웃 추적을 시작할 수 있는 첫 시점이다.
          rolloutWatcher?.start(threadId);
        }
        return;
      }
      if (type === 'item.started' || type === 'item.updated' || type === 'item.completed' || type === 'item.failed') {
        const item = e.item ?? {};
        const itemType = item.type;
        const itemId = String(item.id ?? '');
        if (itemType === 'agent_message') {
          if (type === 'item.updated' || type === 'item.completed') {
            const text = String(item.text ?? item.message ?? '');
            const prev = lastText.get(itemId) ?? '';
            const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
            if (delta) onEvent({ type: 'text-delta', agent: 'codex', text: delta });
            lastText.set(itemId, text);
          }
          return;
        }
        if (itemType === 'mcp_tool_call') {
          const toolName = String(item.tool ?? item.name ?? 'mcp_tool').replace(/^mcp__rhwp__/, '');
          if (!loggedToolCallSample && toolName !== 'ask_user_question') {
            loggedToolCallSample = true;
            process.stderr.write(`[codex] first mcp_tool_call observed: ${toolName}\n`);
          }
          if (type === 'item.started') {
            onEvent({
              type: 'tool-call',
              agent: 'codex',
              callId: itemId,
              tool: toolName,
              argsJson: JSON.stringify(item.arguments ?? {}),
            });
          } else if (type === 'item.completed' || type === 'item.failed') {
            onEvent({
              type: 'tool-result',
              agent: 'codex',
              callId: itemId,
              ok: item.status !== 'failed' && type !== 'item.failed',
              resultPreview: truncate(JSON.stringify(item.result ?? item.error ?? null)),
            });
          }
          return;
        }
        if (itemType === 'collab_tool_call') {
          // collab_tool_call 은 서브에이전트 카드가 아니다: 0.147.0 은 이 항목을
          // wait_agent 호출에만 내보내며(tool 은 항상 "wait"), receiver_thread_ids 와
          // agents_states 는 언제나 비어 있다. spawn_agent 는 스트림에 아무것도 남기지
          // 않는다. 그래서 이건 루트의 평범한 도구 호출 한 줄로 그리고, 실제 fleet
          // 카드는 롤아웃 워처가 만든다.
          const tool = String(item.tool ?? 'wait');
          if (type === 'item.started') {
            onEvent({
              type: 'tool-call',
              agent: 'codex',
              callId: itemId,
              tool: tool === 'wait' ? 'wait_agents' : tool,
              argsJson: '{}',
            });
          } else if (type === 'item.completed' || type === 'item.failed') {
            onEvent({
              type: 'tool-result',
              agent: 'codex',
              callId: itemId,
              ok: item.status !== 'failed' && type !== 'item.failed',
              resultPreview: '',
            });
          }
          return;
        }
        if (itemType === 'command_execution' || itemType === 'web_search') {
          if (type === 'item.started') {
            onEvent({
              type: 'tool-call',
              agent: 'codex',
              callId: itemId,
              tool: itemType,
              argsJson: JSON.stringify(
                itemType === 'command_execution'
                  ? { command: item.command ?? '' }
                  : { query: item.query ?? item.action ?? '' }
              ),
            });
          } else if (type === 'item.completed' || type === 'item.failed') {
            onEvent({
              type: 'tool-result',
              agent: 'codex',
              callId: itemId,
              ok: item.status !== 'failed' && type !== 'item.failed',
              resultPreview: truncate(
                itemType === 'command_execution'
                  ? String(item.aggregated_output ?? `exit_code=${item.exit_code ?? '?'}`)
                  : JSON.stringify(item.result ?? null)
              ),
            });
          }
          return;
        }
        if (itemType === 'file_change') {
          if (type === 'item.started') {
            onEvent({
              type: 'tool-call', agent: 'codex', callId: itemId, tool: 'file_change',
              argsJson: JSON.stringify({ changes: item.changes ?? item.path ?? item }),
            });
          } else if (type === 'item.completed' || type === 'item.failed') {
            onEvent({
              type: 'tool-result', agent: 'codex', callId: itemId,
              ok: item.status !== 'failed' && type !== 'item.failed',
              resultPreview: truncate(JSON.stringify(item.changes ?? item.result ?? item.error ?? null)),
            });
          }
          return;
        }
        return;
      }
      if (type === 'turn.completed') {
        // Codex can emit its logical completion before the CLI process exits. Keep
        // the hub turn open until exit so a resumed implementation never overlaps it.
        turnCompleted = true;
        const usage = normalizeUsageTokens(e.usage);
        if (usage) {
          onEvent({
            type: 'usage',
            agent: 'codex',
            model: opts.model ?? DEFAULT_CODEX_MODEL,
            // Codex 는 캐시 생성 토큰을 따로 보고하지 않는다.
            usage: { ...usage, cacheCreationTokens: 0 },
          });
        }
        return;
      }
      if (type === 'turn.failed') {
        turnCompleted = true;
        const message = String(e.error?.message ?? e.message ?? 'turn failed');
        turnFailureMessage = message;
        onEvent({ type: 'error', agent: 'codex', message });
        return;
      }
      if (type === 'error') {
        onEvent({ type: 'error', agent: 'codex', message: String(e.message ?? 'unknown error') });
        return;
      }
    };
  }

  function killChild() {
    return stopChild();
  }

  return {
    agent: 'codex',
    getSessionId() {
      return threadId;
    },
    sendUserMessage(text) {
      if (disposed) return;
      // 이전 턴의 워처가 남아 있으면 turn-start 보다 먼저 정리한다 — 그래야 남은
      // 카드를 닫는 task-end 가 지난 턴 안에서 끝난다 (정상 흐름에서는 exit 에서
      // 이미 정리됐고, 여기 걸리는 건 exit 이 오지 않은 예외 경로다).
      finalizeRolloutWatcher();
      // A same-tick next turn must not discard the previous tree identity.
      // Capture its bounded cleanup before replacing the active child slot.
      if (child) void stopChild();
      turnOpen = true;
      turnCompleted = false;
      turnFailureMessage = null;
      onEvent({ type: 'turn-start', agent: 'codex' });

      // 프롬프트는 positional 인자가 아니라 stdin('-')으로 전달한다: '-' 로 시작하는
      // 메시지가 CLI 플래그로 파싱되는 것과 초장문 메시지의 ARG_MAX 초과를 막는다.
      const mode = normalizeExecutionMode(opts);
      const prompt = threadId && mode.workflow === 'direct'
        ? text
        : systemBriefFor(opts, 'codex') + '\n\n' + text;
      const argv = buildCodexArgv(opts, threadId);
      stderrTail = '';

      const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
      rolloutWatcher = createRolloutWatcher({
        codexHome,
        emit: (evt) => { if (!disposed) onEvent(evt); },
      });
      let proc;
      try {
        prepareCodexHome(codexHome, opts.codexAuthPath);
        proc = spawnProcess(opts.codexBin ?? 'codex', argv, {
          ...processTreeSpawnOptions(),
          cwd: opts.rootDir,
          env: {
            ...isolatedProcessEnv(opts, opts.providerEnv ?? process.env),
            CODEX_HOME: codexHome,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        rolloutWatcher?.stop();
        rolloutWatcher = null;
        onEvent({ type: 'error', agent: 'codex', message: `failed to start codex: ${e?.message ?? e}` });
        endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'exited' });
        return;
      }
      child = proc;
      let resolveOwnership = () => {};
      childExitPromise = new Promise((resolve) => { resolveOwnership = resolve; });
      let cleanupPromise = null;
      let outputEnded = false;
      const readStdout = createLineReader(makeHandler());
      const endOutput = () => {
        if (outputEnded) return;
        outputEnded = true;
        readStdout.end();
      };
      stopChild = () => {
        if (proc !== child) return Promise.resolve(true);
        if (cleanupPromise) return cleanupPromise;
        let resolveCleanup = () => {};
        cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });
        pendingTreeCleanups.add(cleanupPromise);
        void cleanupPromise.then((cleaned) => {
          pendingTreeCleanups.delete(cleanupPromise);
          if (!cleaned) uncertainTreeCleanup = true;
        });
        let termination;
        let exited;
        try { termination = Promise.resolve(terminateProcess(proc)); } catch { termination = Promise.resolve(false); }
        try { exited = Promise.resolve(waitForExit(proc)); } catch { exited = Promise.resolve(false); }
        void Promise.all([termination, exited]).then(
          ([terminationResult, exitResult]) => terminationResult !== false && exitResult !== false,
          () => false,
        ).then((cleaned) => {
          endOutput();
          if (cleaned && proc === child) child = null;
          resolveOwnership(cleaned);
          resolveOwnership = () => {};
          resolveCleanup(cleaned);
        });
        return cleanupPromise;
      };
      proc.stdin.on('error', (err) => {
        process.stderr.write(`[codex] stdin write error: ${err?.message ?? err}\n`);
      });
      proc.stdin.end(prompt);
      proc.stdout.on('data', readStdout);
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      });
      proc.on('error', (err) => {
        if (proc !== child) return;
        const safeError = redactDiagnosticText(err?.message ?? err, [opts.token]);
        process.stderr.write(`[codex] spawn error: ${safeError}\n`);
        // exit 경로와 똑같이 워처부터 정리한다 — 여기서 turn-end 가 나가면
        // 열린 카드가 그대로 매달린 채 턴이 닫힌다.
        finalizeRolloutWatcher();
        if (turnOpen) {
          onEvent({ type: 'error', agent: 'codex', message: `codex process error: ${safeError}` });
          endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'exited' });
        }
      });
      proc.on('exit', (code, signal) => {
        if (proc !== child) return;
        // 자식 에이전트는 부모 프로세스 안에서 돌기 때문에 여기서 전부 죽는다.
        // turn-end 보다 먼저 마지막 롤아웃을 훑어 카드를 닫는다 — 턴이 끝날 때
        // 열린 task 가 남아 있으면 안 된다.
        finalizeRolloutWatcher();
        if (turnOpen && !disposed) {
          if (turnFailureMessage) {
            endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: turnFailureMessage });
          } else if (!turnCompleted && code !== 0) {
            onEvent({
              type: 'error',
              agent: 'codex',
              message: formatCodexExitError(stderrTail, code, signal, opts.token),
            });
            endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'exited' });
          } else {
            endTurn({ type: 'turn-end', agent: 'codex', stopReason: turnCompleted ? 'completed' : 'exited' });
          }
        }
        // Preserve the exited leader until its process group/task tree has
        // completed bounded cleanup.
        void stopChild();
      });
      proc.on('close', () => {
        if (proc !== child) return;
        endOutput();
        void stopChild();
      });
    },
    setPermissionProfile(profile) {
      if (turnOpen) throw new Error('Permission profile can only change between turns');
      if (profile !== 'safe' && profile !== 'unrestricted') throw new Error(`Unknown permission profile: ${profile}`);
      opts.permissionProfile = profile;
    },
    setServiceTier(tier) {
      if (turnOpen) throw new Error('Service tier can only change between turns');
      if (tier !== 'standard' && tier !== 'fast') throw new Error(`Unknown service tier: ${tier}`);
      opts.serviceTier = tier;
    },
    async setExecutionMode(mode) {
      if (turnOpen) throw new Error('Execution mode can only change between turns');
      validateExecutionMode(mode);
      if (child) killChild();
      const cleanupResults = await Promise.all([childExitPromise, ...pendingTreeCleanups]);
      if (uncertainTreeCleanup || cleanupResults.some((cleaned) => cleaned === false)) {
        throw new Error('Codex process tree could not be stopped for the mode change');
      }
      opts.workflow = mode.workflow;
      opts.phase = mode.phase;
      opts.capabilityEpoch = mode.capabilityEpoch;
    },
    interrupt() {
      killChild();
      finalizeRolloutWatcher();
      endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'interrupted' });
    },
    dispose() {
      disposed = true;
      turnOpen = false;
      // 죽어가는 자식의 stdout 을 아예 파싱하지 않는다. 롤아웃 폴링도 같이 멈춘다.
      try { child?.stdout?.removeAllListeners('data'); } catch {}
      rolloutWatcher?.stop();
      rolloutWatcher = null;
      const currentCleanup = killChild();
      return Promise.all([currentCleanup, ...pendingTreeCleanups])
        .then((results) => !uncertainTreeCleanup && results.every((result) => result !== false));
    },
  };
}

/**
 * Prefer Codex app-server for root chat sessions that can surface native
 * request_user_input cards. The app-server adapter owns its pre-turn feature
 * negotiation and falls back to the legacy `codex exec` transport only when
 * that negotiation proves native input unavailable. Worker sessions and hosts
 * without the provider-neutral callback keep the legacy transport directly.
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 * @param {any} [dependencies]
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createCodexSession(opts, dependencies = {}) {
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  if (typeof opts.requestUserInput !== 'function'
    || !isRootUserInputContext({ agentRole: opts.agentRole })) {
    return withCredentialCopyback(createLegacyCodexSession(opts, dependencies), codexHome);
  }
  return withCredentialCopyback(createCodexAppServerSession(opts, {
    ...dependencies,
    prepareHome: dependencies.prepareHome ?? prepareCodexHome,
    createRolloutWatcher: dependencies.createRolloutWatcher ?? createCodexRolloutWatcher,
    createLegacySession: (threadId) => createLegacyCodexSession(opts, {
      ...dependencies,
      initialThreadId: threadId,
    }),
  }), codexHome);
}
