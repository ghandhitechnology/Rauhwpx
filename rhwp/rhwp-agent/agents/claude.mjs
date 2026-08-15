// cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
import spawn from 'cross-spawn';
import crypto from 'node:crypto';
import {
  createLineReader,
  isPlanningRestricted,
  mcpCapabilityEnv,
  normalizeExecutionMode,
  normalizeUsageTokens,
  systemBriefFor,
  truncate,
  validateExecutionMode,
} from './backend.mjs';

const DIRECT_TOOLS = 'Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch';
const PLAN_IMPLEMENTATION_TOOLS = `${DIRECT_TOOLS},Agent`;
const PLANNING_TOOLS = 'Read,Glob,Grep,Bash,WebSearch,WebFetch,Agent';
const STDERR_TAIL_LIMIT = 16_000;

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
  const mcpConfig = {
    mcpServers: {
      rhwp: {
        command: 'node',
        args: [opts.mcpScriptPath],
        env: {
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
    'WebSearch', 'WebFetch', ...(planWorkflow ? ['Agent'] : []), 'mcp__rhwp__*',
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
    ...(planWorkflow ? ['--forward-subagent-text'] : []),
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
 * @param {import('./backend.mjs').BackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createClaudeSession(opts, { spawnProcess = spawn } = {}) {
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
  let killTimer = null;
  let restartReady = Promise.resolve();
  let stderrTail = '';
  // usage 집계에 붙일 모델 — CLI 가 보고한 실제 모델을 우선한다.
  let currentModel = opts.model ?? null;

  function buildArgv(resume) {
    return buildClaudeArgv(opts, sessionId, resume);
  }

  function endTurn(evt) {
    if (!turnOpen) return;
    turnOpen = false;
    onEvent(evt);
  }

  /**
   * result 메시지의 토큰 사용량을 usage 이벤트로 흘려보낸다.
   * modelUsage 가 있으면 모델별로 쪼개 보내고 aggregate 는 버린다 — 이중 집계 방지.
   */
  function emitUsage(e) {
    const perModel = e?.modelUsage;
    if (perModel && typeof perModel === 'object' && !Array.isArray(perModel) && Object.keys(perModel).length > 0) {
      for (const [model, raw] of Object.entries(perModel)) {
        const usage = normalizeUsageTokens(raw);
        if (usage) onEvent({ type: 'usage', agent: 'claude', model: String(model), usage });
      }
      return;
    }
    const usage = normalizeUsageTokens(e?.usage);
    if (usage) onEvent({ type: 'usage', agent: 'claude', model: currentModel, usage });
  }

  function handleEvent(e) {
    if (disposed) return; // 폐기 후 죽어가는 CLI 가 흘리는 stdout 은 무시한다.
    if (e?.type === 'system' && e.subtype === 'init') {
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
    if (e?.type === 'stream_event') {
      const ev = e.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        if (e.parent_tool_use_id) streamedSubagents.add(String(e.parent_tool_use_id));
        else sawRootTextDelta = true;
        if (ev.delta.text) onEvent({ type: 'text-delta', agent: 'claude', text: ev.delta.text });
      }
      return;
    }
    if (e?.type === 'assistant') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
      const parentToolUseId = e.parent_tool_use_id ? String(e.parent_tool_use_id) : null;
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
          });
        } else if (block?.type === 'text') {
          // Subagent assistant messages carry parent_tool_use_id. Deduplicate
          // them independently so a root text delta never suppresses child text.
          if (!alreadyStreamed && block.text) {
            onEvent({ type: 'text-delta', agent: 'claude', text: block.text });
          }
        }
      }
      return;
    }
    if (e?.type === 'user') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
      for (const b of blocks) {
        if (b?.type === 'tool_result') {
          onEvent({
            type: 'tool-result',
            agent: 'claude',
            callId: String(b.tool_use_id ?? ''),
            ok: !b.is_error,
            resultPreview: truncate(typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null)),
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
      endTurn({
        type: 'turn-end',
        agent: 'claude',
        stopReason: e.stop_reason ?? e.subtype,
        errorMessage: e.is_error ? String(e.result) : undefined,
      });
      return;
    }
  }

  function spawnChild() {
    const resume = hasCompletedTurn;
    if (!resume && sessionIdConsumed) {
      // 이전 --session-id 스폰이 turn 완료 전에 죽었다 — 그 ID 는 소진되었으므로
      // 새 세션 ID 로 다시 시작한다 (재개할 완료 turn 도 없다).
      sessionId = crypto.randomUUID();
    }
    sessionIdConsumed = true;
    const proc = spawnProcess(opts.claudeBin ?? 'claude', buildArgv(resume), {
      cwd: opts.rootDir,
      env: { ...process.env, ...(opts.providerEnv ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
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
    proc.kill('SIGTERM');
    killTimer = setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      } catch {}
    }, 3000);
    if (killTimer.unref) killTimer.unref();
  }

  function restartForConfigChange() {
    const priorReady = restartReady;
    const previous = child;
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
    restartReady = Promise.all([priorReady, shutdownReady]).then(() => {});
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
      onEvent({ type: 'turn-start', agent: 'claude' });
      void restartReady.then(() => {
        if (disposed || !turnOpen) return;
        try {
          if (!child || !childAlive) spawnChild();
          const line = JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text }] },
          }) + '\n';
          child.stdin.write(line, (err) => {
            if (err) process.stderr.write(`[claude] stdin write error: ${err.message}\n`);
          });
        } catch (e) {
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
      killChild();
      childAlive = false;
      endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'interrupted' });
    },
    dispose() {
      disposed = true;
      turnOpen = false;
      // 죽어가는 자식의 stdout 을 아예 파싱하지 않는다.
      try { child?.stdout?.removeAllListeners('data'); } catch {}
      killChild();
      childAlive = false;
    },
  };
}
