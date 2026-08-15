// cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
import spawn from 'cross-spawn';
import { copyFileSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLineReader,
  isPlanningRestricted,
  mcpCapabilityEnv,
  mcpRuntimeFor,
  normalizeExecutionMode,
  normalizeUsageTokens,
  systemBriefFor,
  truncate,
  validateExecutionMode,
} from './backend.mjs';
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
export function prepareCodexHome(codexHome, authPath, {
  copyFile = copyFileSync,
  platform = process.platform,
  symlink = symlinkSync,
} = {}) {
  mkdirSync(codexHome, { recursive: true });
  if (!authPath) return;

  let authStat;
  try {
    authStat = lstatSync(authPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!authStat.isFile() || authStat.isSymbolicLink()) return;

  const target = path.join(codexHome, 'auth.json');
  try {
    const targetStat = lstatSync(target);
    if (!targetStat.isSymbolicLink()) return;
    const existingTarget = path.resolve(codexHome, readlinkSync(target));
    if (existingTarget === path.resolve(authPath)) return;
    unlinkSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    symlink(authPath, target);
  } catch (error) {
    if (platform !== 'win32' || error?.code !== 'EPERM') throw error;
    copyFile(authPath, target);
  }
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
    // Headless MCP calls cannot display an approval prompt. Auto-approve rhwp
    // tools (document edits still wait for sidebar approval) and use config
    // keys understood by both the initial and resume subcommands.
    '-c', 'mcp_servers.rhwp.default_tools_approval_mode="auto"',
    '-c', 'approval_policy="never"',
    '-c', `sandbox_mode="${planningRestricted ? 'read-only' : (unrestricted ? 'danger-full-access' : 'workspace-write')}"`,
    ...(opts.workflow === 'plan' ? ['-c', 'web_search="live"'] : []),
    ...(opts.effort
      ? ['-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`]
      : []),
  ];
  const common = [
    '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
    '--disable', 'image_generation',
    ...(opts.workflow === 'plan' ? ['--enable', 'multi_agent'] : ['--disable', 'multi_agent']),
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
  let clean = stderrText.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  if (token) clean = clean.split(token).join('[redacted]');
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
export function createCodexSession(opts, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
} = {}) {
  const onEvent = opts.onEvent;

  /** @type {string | null} */
  let threadId = null;
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let turnOpen = false;
  let turnCompleted = false;
  let turnFailureMessage = null;
  let disposed = false;
  let loggedToolCallSample = false;
  let stderrTail = '';
  let childExitPromise = Promise.resolve();
  let resolveChildExit = null;

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
          if (!loggedToolCallSample) {
            loggedToolCallSample = true;
            process.stderr.write(`[codex] first mcp_tool_call item: ${JSON.stringify(item).slice(0, 1000)}\n`);
          }
          if (type === 'item.started') {
            onEvent({
              type: 'tool-call',
              agent: 'codex',
              callId: itemId,
              tool: String(item.tool ?? item.name ?? 'mcp_tool').replace(/^mcp__rhwp__/, ''),
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
          const tool = String(item.tool ?? 'subagent');
          if (type === 'item.started') {
            onEvent({
              type: 'tool-call',
              agent: 'codex',
              callId: itemId,
              tool: `subagent:${tool}`,
              argsJson: JSON.stringify({
                prompt: item.prompt ?? undefined,
                receiverThreadIds: item.receiver_thread_ids ?? [],
              }),
            });
          } else if (type === 'item.completed' || type === 'item.failed') {
            onEvent({
              type: 'tool-result',
              agent: 'codex',
              callId: itemId,
              ok: item.status !== 'failed' && type !== 'item.failed',
              resultPreview: truncate(JSON.stringify(item.agents_states ?? item.result ?? item.error ?? null)),
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
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    terminateProcess(proc);
  }

  return {
    agent: 'codex',
    getSessionId() {
      return threadId;
    },
    sendUserMessage(text) {
      if (disposed) return;
      turnOpen = true;
      turnCompleted = false;
      turnFailureMessage = null;
      onEvent({ type: 'turn-start', agent: 'codex' });

      // 프롬프트는 positional 인자가 아니라 stdin('-')으로 전달한다: '-' 로 시작하는
      // 메시지가 CLI 플래그로 파싱되는 것과 초장문 메시지의 ARG_MAX 초과를 막는다.
      const mode = normalizeExecutionMode(opts);
      const prompt = threadId && mode.workflow === 'direct'
        ? text
        : systemBriefFor(opts) + '\n\n' + text;
      const argv = buildCodexArgv(opts, threadId);
      stderrTail = '';

      const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
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
        onEvent({ type: 'error', agent: 'codex', message: `failed to start codex: ${e?.message ?? e}` });
        endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'exited' });
        return;
      }
      child = proc;
      childExitPromise = new Promise((resolve) => { resolveChildExit = resolve; });
      proc.stdin.on('error', (err) => {
        process.stderr.write(`[codex] stdin write error: ${err?.message ?? err}\n`);
      });
      proc.stdin.end(prompt);
      proc.stdout.on('data', createLineReader(makeHandler()));
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
        for (const line of text.split('\n')) {
          if (line.trim()) process.stderr.write(`[codex] ${line}\n`);
        }
      });
      proc.on('error', (err) => {
        if (proc !== child) return;
        process.stderr.write(`[codex] spawn error: ${err?.message ?? err}\n`);
        if (turnOpen) {
          onEvent({ type: 'error', agent: 'codex', message: `codex process error: ${err?.message ?? err}` });
          endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'exited' });
        }
      });
      proc.on('exit', (code, signal) => {
        if (proc !== child) return;
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
        child = null;
        resolveChildExit?.();
        resolveChildExit = null;
      });
      proc.on('close', () => {
        if (proc !== child) return;
        child = null;
        resolveChildExit?.();
        resolveChildExit = null;
      });
    },
    setPermissionProfile(profile) {
      if (turnOpen) throw new Error('Permission profile can only change between turns');
      if (profile !== 'safe' && profile !== 'unrestricted') throw new Error(`Unknown permission profile: ${profile}`);
      opts.permissionProfile = profile;
    },
    async setExecutionMode(mode) {
      if (turnOpen) throw new Error('Execution mode can only change between turns');
      validateExecutionMode(mode);
      if (child && child.exitCode === null && child.signalCode === null) killChild();
      await childExitPromise;
      opts.workflow = mode.workflow;
      opts.phase = mode.phase;
      opts.capabilityEpoch = mode.capabilityEpoch;
    },
    interrupt() {
      killChild();
      endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'interrupted' });
    },
    dispose() {
      disposed = true;
      turnOpen = false;
      // 죽어가는 자식의 stdout 을 아예 파싱하지 않는다.
      try { child?.stdout?.removeAllListeners('data'); } catch {}
      const exited = waitForProcessTreeExit(child);
      killChild();
      return exited;
    },
  };
}
