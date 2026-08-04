import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createLineReader, truncate, SYSTEM_BRIEF } from './backend.mjs';

/**
 * @param {import('./backend.mjs').BackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createClaudeSession(opts) {
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
  let sawTextDelta = false;
  let disposed = false;
  let killTimer = null;

  const mcpConfig = {
    mcpServers: {
      rhwp: {
        command: 'node',
        args: [opts.mcpScriptPath],
        env: {
          RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
          RHWP_AGENT_TOKEN: opts.token,
          RHWP_AGENT_NAME: 'claude',
        },
      },
    },
  };

  function buildArgv(resume) {
    return [
      '-p', '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
      '--mcp-config', JSON.stringify(mcpConfig),
      '--strict-mcp-config',
      '--allowedTools', 'mcp__rhwp',
      '--tools', '',
      '--permission-mode', 'dontAsk',
      '--append-system-prompt', SYSTEM_BRIEF,
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.effort ? ['--effort', opts.effort] : []),
    ];
  }

  function endTurn(evt) {
    if (!turnOpen) return;
    turnOpen = false;
    onEvent(evt);
  }

  function handleEvent(e) {
    if (e?.type === 'system' && e.subtype === 'init') {
      // CLI 가 보고하는 실제 세션 ID 를 추적한다 (--resume 이 새 ID 로 fork 할 수 있다).
      if (e.session_id) sessionId = String(e.session_id);
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
        sawTextDelta = true;
        if (ev.delta.text) onEvent({ type: 'text-delta', agent: 'claude', text: ev.delta.text });
      }
      return;
    }
    if (e?.type === 'assistant') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
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
          if (!sawTextDelta && block.text) {
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
    const proc = spawn('claude', buildArgv(resume), {
      cwd: opts.rootDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = proc;
    childAlive = true;
    proc.stdout.on('data', createLineReader(handleEvent));
    proc.stderr.on('data', (chunk) => {
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
          message: `claude exited unexpectedly (code=${code}, signal=${signal})`,
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

  return {
    agent: 'claude',
    getSessionId() {
      return sessionId;
    },
    sendUserMessage(text) {
      if (disposed) return;
      turnOpen = true;
      sawTextDelta = false;
      onEvent({ type: 'turn-start', agent: 'claude' });
      try {
        if (!child || !childAlive) spawnChild();
        const line = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
        }) + '\n';
        child.stdin.write(line, (err) => {
          if (err) {
            process.stderr.write(`[claude] stdin write error: ${err.message}\n`);
          }
        });
      } catch (e) {
        onEvent({ type: 'error', agent: 'claude', message: `failed to dispatch message: ${e?.message ?? e}` });
        endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'exited' });
      }
    },
    interrupt() {
      killChild();
      childAlive = false;
      endTurn({ type: 'turn-end', agent: 'claude', stopReason: 'interrupted' });
    },
    dispose() {
      disposed = true;
      turnOpen = false;
      killChild();
      childAlive = false;
    },
  };
}
