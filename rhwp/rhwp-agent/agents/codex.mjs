import { spawn } from 'node:child_process';
import { createLineReader, truncate, SYSTEM_BRIEF } from './backend.mjs';

/**
 * @param {import('./backend.mjs').BackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createCodexSession(opts) {
  const onEvent = opts.onEvent;

  /** @type {string | null} */
  let threadId = null;
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let turnOpen = false;
  let turnCompleted = false;
  let disposed = false;
  let loggedToolCallSample = false;
  let killTimer = null;

  const cfg = [
    '-c', 'mcp_servers.rhwp.command="node"',
    '-c', `mcp_servers.rhwp.args=["${opts.mcpScriptPath}"]`,
    '-c', `mcp_servers.rhwp.env={RHWP_WS_URL = "ws://127.0.0.1:${opts.hubPort}/mcp", RHWP_AGENT_TOKEN = "${opts.token}", RHWP_AGENT_NAME = "codex"}`,
    '-c', 'mcp_servers.rhwp.startup_timeout_sec=20',
    // codex 0.146 기준 headless(exec)에서 MCP 도구 호출은 승인 프롬프트를 띄울 수 없어
    // "user cancelled MCP tool call"로 자동 취소된다. approval_policy=never 와
    // sandbox danger-full-access 조합에서만 MCP 호출이 실행됨을 실측으로 확인했다.
    // (read-only/workspace-write 샌드박스에서는 MCP 호출이 무조건 취소됨)
    '-c', 'approval_policy="never"',
  ];
  const common = [
    '--json', '--skip-git-repo-check', '--ignore-user-config',
    '--sandbox', 'danger-full-access',
    '-m', opts.model ?? 'gpt-5.6-sol', ...cfg,
  ];

  function endTurn(evt) {
    if (!turnOpen) return;
    turnOpen = false;
    onEvent(evt);
  }

  function makeHandler() {
    const lastText = new Map();
    return (e) => {
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
        return;
      }
      if (type === 'turn.completed') {
        turnCompleted = true;
        endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'completed' });
        return;
      }
      if (type === 'turn.failed') {
        turnCompleted = true;
        const message = String(e.error?.message ?? e.message ?? 'turn failed');
        onEvent({ type: 'error', agent: 'codex', message });
        endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: message });
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
    proc.kill('SIGTERM');
    killTimer = setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      } catch {}
    }, 3000);
    if (killTimer.unref) killTimer.unref();
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
      onEvent({ type: 'turn-start', agent: 'codex' });

      // 프롬프트는 positional 인자가 아니라 stdin('-')으로 전달한다: '-' 로 시작하는
      // 메시지가 CLI 플래그로 파싱되는 것과 초장문 메시지의 ARG_MAX 초과를 막는다.
      const prompt = threadId ? text : SYSTEM_BRIEF + '\n\n' + text;
      const argv = threadId
        ? ['exec', 'resume', threadId, ...common, '-']
        : ['exec', ...common, '-C', opts.rootDir, '-'];

      let proc;
      try {
        proc = spawn('codex', argv, {
          cwd: opts.rootDir,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        onEvent({ type: 'error', agent: 'codex', message: `failed to spawn codex: ${e?.message ?? e}` });
        endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'exited' });
        return;
      }
      child = proc;
      proc.stdin.on('error', (err) => {
        process.stderr.write(`[codex] stdin write error: ${err?.message ?? err}\n`);
      });
      proc.stdin.end(prompt);
      proc.stdout.on('data', createLineReader(makeHandler()));
      proc.stderr.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
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
      proc.on('exit', (code) => {
        if (proc !== child) return;
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        if (turnOpen && !disposed) {
          if (!turnCompleted && code !== 0) {
            onEvent({ type: 'error', agent: 'codex', message: `codex exited with code ${code}` });
            endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'exited' });
          } else {
            endTurn({ type: 'turn-end', agent: 'codex', stopReason: turnCompleted ? 'completed' : 'exited' });
          }
        }
      });
    },
    interrupt() {
      killChild();
      endTurn({ type: 'turn-end', agent: 'codex', stopReason: 'interrupted' });
    },
    dispose() {
      disposed = true;
      turnOpen = false;
      killChild();
    },
  };
}
