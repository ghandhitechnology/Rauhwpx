import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createClaudeSession } from './agents/claude.mjs';
import { createCodexSession } from './agents/codex.mjs';

const PORT = Number(process.env.RHWP_AGENT_PORT ?? 5175);
const TOKEN = process.env.RHWP_AGENT_TOKEN ?? 'dev';
const ROOT = new URL('..', import.meta.url).pathname;
const MCP_SCRIPT = new URL('./mcp-stdio.mjs', import.meta.url).pathname;
const STUDIO_TOOL_TIMEOUT_MS = 30_000;

/** @type {import('ws').WebSocket | null} */
let studioSocket = null;
const mcpSockets = new Set();
/** @type {{ agent: 'claude'|'codex', backend: any, status: 'idle'|'running', sessionId: string|null } | null} */
let session = null;
/** @type {Map<number, { mcpSocket: any, clientId: number, timer: NodeJS.Timeout }>} */
const pendingCalls = new Map();
let nextHubId = 1;

function log(msg) {
  process.stderr.write(`[rhwp-agent] ${msg}\n`);
}

function sendJson(sock, obj) {
  if (sock && sock.readyState === sock.OPEN) {
    try {
      sock.send(JSON.stringify(obj));
    } catch (e) {
      log(`send failed: ${e?.message ?? e}`);
    }
  }
}

function sessionInfo() {
  return session
    ? { agent: session.agent, sessionId: session.sessionId, status: session.status }
    : null;
}

function onBackendEvent(evt) {
  if (!session) return;
  if (evt.type === 'session-info' && evt.sessionId) session.sessionId = evt.sessionId;
  if (evt.type === 'turn-end') session.status = 'idle';
  sendJson(studioSocket, { v: 1, type: 'agent-event', event: evt });
}

function disposeSession() {
  if (!session) return;
  const wasRunning = session.status === 'running';
  const agent = session.agent;
  try {
    session.backend.dispose();
  } catch (e) {
    log(`session dispose error: ${e?.message ?? e}`);
  }
  session = null;
  if (wasRunning) {
    // backend.dispose() 는 turnOpen 을 먼저 닫아 turn-end 를 내보내지 않는다 —
    // 스튜디오의 turnRunning/pending change-set 이 열린 채 남지 않도록 합성해 보낸다.
    sendJson(studioSocket, {
      v: 1, type: 'agent-event',
      event: { type: 'turn-end', agent, stopReason: 'interrupted' },
    });
  }
}

function startSession(agent) {
  if (session && session.agent === agent) return session;
  disposeSession();
  const opts = {
    rootDir: ROOT,
    mcpScriptPath: MCP_SCRIPT,
    hubPort: PORT,
    token: TOKEN,
    model: agent === 'claude' ? process.env.RHWP_CLAUDE_MODEL : process.env.RHWP_CODEX_MODEL,
    onEvent: onBackendEvent,
  };
  const backend = agent === 'claude' ? createClaudeSession(opts) : createCodexSession(opts);
  session = { agent, backend, status: 'idle', sessionId: backend.getSessionId() };
  return session;
}

function handleStudioMessage(sock, msg) {
  switch (msg.type) {
    case 'chat-start': {
      const agent = msg.agent;
      if (agent !== 'claude' && agent !== 'codex') {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REQUEST', message: `unknown agent: ${String(agent)}` });
        return;
      }
      try {
        const s = startSession(agent);
        sendJson(sock, { v: 1, type: 'chat-started', agent: s.agent, sessionId: s.sessionId });
      } catch (e) {
        disposeSession();
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_SPAWN_FAILED', message: String(e?.message ?? e) });
      }
      return;
    }
    case 'chat-user-message': {
      if (!session) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_NOT_STARTED', message: 'No agent session; send chat-start first.' });
        return;
      }
      if (session.status === 'running') {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_BUSY', message: 'A turn is already in progress.' });
        return;
      }
      if (typeof msg.text !== 'string' || msg.text.length === 0) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REQUEST', message: 'chat-user-message requires text' });
        return;
      }
      session.status = 'running';
      try {
        session.backend.sendUserMessage(msg.text);
      } catch (e) {
        session.status = 'idle';
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_SPAWN_FAILED', message: String(e?.message ?? e) });
      }
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
      if (!studioSocket || studioSocket.readyState !== studioSocket.OPEN) {
        sendJson(sock, {
          v: 1, type: 'tool-result', id: clientId, ok: false,
          error: { code: 'NO_STUDIO', message: 'Studio is not connected; open rhwp-studio in a browser' },
        });
        return;
      }
      const hubId = nextHubId++;
      const timer = setTimeout(() => {
        pendingCalls.delete(hubId);
        sendJson(sock, {
          v: 1, type: 'tool-result', id: clientId, ok: false,
          error: { code: 'STUDIO_TIMEOUT', message: `Studio did not answer within ${STUDIO_TOOL_TIMEOUT_MS / 1000}s` },
        });
      }, STUDIO_TOOL_TIMEOUT_MS);
      pendingCalls.set(hubId, { mcpSocket: sock, clientId, timer });
      sendJson(studioSocket, {
        v: 1, type: 'tool-request', id: hubId,
        agent: session?.agent ?? 'claude',
        tool: String(msg.tool ?? ''),
        args: msg.args ?? {},
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
    if (msg?.v !== 1) {
      sendJson(sock, {
        v: 1, type: 'protocol-error', code: 'UNSUPPORTED_VERSION',
        message: `protocol version ${String(msg?.v)} is not supported`, supportedVersions: [1],
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

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      protocol: 1,
      studioConnected: !!studioSocket && studioSocket.readyState === studioSocket.OPEN,
      mcpClients: mcpSockets.size,
      session: sessionInfo(),
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
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
        try {
          studioSocket.close(4000, 'replaced');
        } catch {}
      }
      studioSocket = ws;
      attachSocket(ws, 'studio');
      ws.on('close', () => {
        if (studioSocket === ws) studioSocket = null;
      });
      sendJson(ws, { v: 1, type: 'welcome', protocol: 1, session: sessionInfo() });
      log('studio connected');
    } else {
      const agentLabel = url.searchParams.get('agent') ?? 'unknown';
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
  log(`rhwp-agent hub listening on ws://127.0.0.1:${PORT} (token=${TOKEN})`);
  log(`claude/codex CLIs must be on PATH (e.g. ~/.local/bin)`);
});

httpServer.on('error', (err) => {
  log(`server error: ${err?.message ?? err}`);
  process.exit(1);
});
