import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createClaudeSession } from './agents/claude.mjs';
import { createCodexSession } from './agents/codex.mjs';
import { generateChatTitle } from './agents/title.mjs';
import { SkillRegistry } from './skills.mjs';
import { generateSkillDraft } from './skill-generator.mjs';
import { WritingStyleStore } from './writing-style.mjs';
import { calibrateWritingStyle } from './style-calibrator.mjs';

const PORT = Number(process.env.RHWP_AGENT_PORT ?? 5175);
const TOKEN = process.env.RHWP_AGENT_TOKEN ?? 'dev';
const ROOT = new URL('..', import.meta.url).pathname;
const MCP_SCRIPT = new URL('./mcp-stdio.mjs', import.meta.url).pathname;
const BUNDLED_SKILLS = new URL('./skills', import.meta.url).pathname;
const ISOLATED_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-home-'));
const ISOLATED_CODEX_HOME = path.join(ISOLATED_HOME, '.codex');
const STUDIO_TOOL_TIMEOUT_MS = 30_000;
await fs.mkdir(ISOLATED_CODEX_HOME, { recursive: true });
const sourceCodexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
try {
  const authPath = path.join(sourceCodexHome, 'auth.json');
  const authStat = await fs.lstat(authPath);
  if (authStat.isFile() && !authStat.isSymbolicLink()) {
    await fs.symlink(authPath, path.join(ISOLATED_CODEX_HOME, 'auth.json'));
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const writingStyleStore = await new WritingStyleStore().init();
const skillRegistry = await new SkillRegistry({ bundledRoot: BUNDLED_SKILLS, writingStyleStore }).init();
let styleCalibrationRunning = false;

/** @type {import('ws').WebSocket | null} */
let studioSocket = null;
const mcpSockets = new Set();
/** @type {{ agent: 'claude'|'codex', model: string|null, effort: string|null, permissionProfile: 'safe'|'unrestricted', backend: any, status: 'idle'|'running', sessionId: string|null } | null} */
let session = null;

const CLAUDE_MODELS = new Set(['opus', 'fable', 'sonnet', 'haiku']);
const CODEX_MODELS = new Set(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
const DEFAULT_MODEL = { claude: 'sonnet', codex: 'gpt-5.6-sol' };
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_EFFORTS_HAIKU = new Set(['low', 'medium', 'high']);
const CODEX_EFFORTS = new Set(['low', 'medium', 'high']);
const DEFAULT_EFFORT = { claude: 'high', codex: 'high' };

function resolveModel(agent, requested) {
  const allowed = agent === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
  if (typeof requested === 'string' && allowed.has(requested)) return requested;
  const envDefault = agent === 'claude' ? process.env.RHWP_CLAUDE_MODEL : process.env.RHWP_CODEX_MODEL;
  if (typeof envDefault === 'string' && allowed.has(envDefault)) return envDefault;
  return DEFAULT_MODEL[agent];
}

function resolveEffort(agent, model, requested) {
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
    ? {
      agent: session.agent,
      model: session.model,
      effort: session.effort,
      permissionProfile: session.permissionProfile,
      sessionId: session.sessionId,
      status: session.status,
    }
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

function resolvePermissionProfile(value) {
  return value === 'unrestricted' ? 'unrestricted' : 'safe';
}

function startSession(agent, requestedModel, requestedEffort, requestedPermission, force = false) {
  const model = resolveModel(agent, requestedModel);
  const effort = resolveEffort(agent, model, requestedEffort);
  const permissionProfile = resolvePermissionProfile(requestedPermission);
  if (
    !force
    && session
    && session.agent === agent
    && session.model === model
    && session.effort === effort
    && session.permissionProfile === permissionProfile
  ) return session;
  disposeSession();
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
    onEvent: onBackendEvent,
  };
  const backend = agent === 'claude' ? createClaudeSession(opts) : createCodexSession(opts);
  session = { agent, model, effort, permissionProfile, backend, status: 'idle', sessionId: backend.getSessionId() };
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
        const s = startSession(agent, msg.model, msg.effort, msg.permissionProfile, Boolean(msg.force));
        sendJson(sock, {
          v: 1,
          type: 'chat-started',
          agent: s.agent,
          model: s.model,
          effort: s.effort,
          permissionProfile: s.permissionProfile,
          sessionId: s.sessionId,
        });
      } catch (e) {
        disposeSession();
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_SPAWN_FAILED', message: String(e?.message ?? e) });
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
      generateChatTitle(preview)
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
      if (session.status === 'running') {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'AGENT_BUSY', message: 'A turn is already in progress.' });
        return;
      }
      if (typeof msg.text !== 'string' || msg.text.length === 0) {
        sendJson(sock, { v: 1, type: 'chat-error', code: 'INVALID_REQUEST', message: 'chat-user-message requires text' });
        return;
      }
      const activeSession = session;
      activeSession.status = 'running';
      void skillRegistry.promptContext(msg.text, typeof msg.skillName === 'string' ? msg.skillName : undefined)
        .then((prompt) => {
          if (session !== activeSession) throw new Error('Agent session changed before the message was dispatched');
          activeSession.backend.sendUserMessage(prompt);
        })
        .catch((e) => {
          if (session === activeSession) activeSession.status = 'idle';
          sendJson(sock, { v: 1, type: 'chat-error', code: e?.code ?? 'AGENT_SPAWN_FAILED', message: String(e?.message ?? e) });
        });
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
      const agent = msg.agent === 'codex' ? 'codex' : 'claude';
      const model = resolveModel(agent, msg.model);
      sendJson(sock, { v: 1, type: 'skill-draft-progress', requestId: msg.requestId ?? null, state: 'generating' });
      void generateSkillDraft({ agent, model, goal: String(msg.goal ?? ''), triggerExamples: String(msg.triggerExamples ?? ''), nonTriggerExamples: String(msg.nonTriggerExamples ?? ''), resourceNotes: String(msg.resourceNotes ?? ''), existingSkill: typeof msg.existingSkill === 'string' ? msg.existingSkill : undefined })
        .then((draft) => sendJson(sock, { v: 1, type: 'skill-draft-result', requestId: msg.requestId ?? null, draft }))
        .catch((e) => sendJson(sock, { v: 1, type: 'skills-error', requestId: msg.requestId ?? null, code: 'SKILL_GENERATION_FAILED', message: String(e?.message ?? e) }));
      return;
    }
    case 'writing-style-status-request': {
      void writingStyleStore.status()
        .then((status) => sendJson(sock, { v: 1, type: 'writing-style-status', requestId: msg.requestId ?? null, status }))
        .catch((e) => sendJson(sock, { v: 1, type: 'writing-style-error', requestId: msg.requestId ?? null, code: 'STYLE_STATUS_FAILED', message: String(e?.message ?? e) }));
      return;
    }
    case 'writing-style-calibrate': {
      const requestId = msg.requestId ?? null;
      if (styleCalibrationRunning) {
        sendJson(sock, { v: 1, type: 'writing-style-error', requestId, code: 'CALIBRATION_BUSY', message: 'A writing-style calibration is already running.' });
        return;
      }
      styleCalibrationRunning = true;
      sendJson(sock, { v: 1, type: 'writing-style-progress', requestId, state: 'reading' });
      void Promise.resolve()
        .then(() => {
          sendJson(sock, { v: 1, type: 'writing-style-progress', requestId, state: 'analyzing' });
          return calibrateWritingStyle({ language: msg.language, files: msg.files });
        })
        .then(async (profile) => {
          sendJson(sock, { v: 1, type: 'writing-style-progress', requestId, state: 'saving' });
          const status = await writingStyleStore.save(profile);
          sendJson(sock, { v: 1, type: 'writing-style-result', requestId, status });
          sendJson(sock, { v: 1, type: 'writing-style-status', requestId, status });
        })
        .catch((e) => sendJson(sock, {
          v: 1,
          type: 'writing-style-error',
          requestId,
          code: e?.code ?? 'CALIBRATION_FAILED',
          message: String(e?.message ?? e),
        }))
        .finally(() => { styleCalibrationRunning = false; });
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
      if (msg.tool === 'read_product_skill') {
        void skillRegistry.readResource(String(msg.args?.name ?? ''), String(msg.args?.resourcePath ?? 'SKILL.md'))
          .then((result) => sendJson(sock, { v: 1, type: 'tool-result', id: clientId, ok: true, result }))
          .catch((error) => sendJson(sock, {
            v: 1, type: 'tool-result', id: clientId, ok: false,
            error: { code: error?.code ?? 'SKILLS_ERROR', message: String(error?.message ?? error) },
          }));
        return;
      }
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
          error: { code: 'STUDIO_TIMEOUT', message: `Studio did not answer within ${STUDIO_TOOL_TIMEOUT_MS / 1000}s — the edit may still have applied; re-read with get_structure/get_text_range before retrying to avoid duplicates` },
        });
      }, STUDIO_TOOL_TIMEOUT_MS);
      pendingCalls.set(hubId, { mcpSocket: sock, clientId, timer });
      sendJson(studioSocket, {
        v: 1, type: 'tool-request', id: hubId,
        // 호출을 보낸 MCP 소켓의 에이전트 라벨을 단다 — 현재 세션 기준으로 찍으면
        // 세션 교체 직후 남은 호출이 엉뚱한 에이전트로 기록될 수 있다.
        agent: sock.agentLabel ?? session?.agent ?? 'claude',
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
          failAllPendingCalls('Studio disconnected while tool calls were in flight; the edit may still have applied — re-read with get_structure/get_text_range before retrying');
        }
      });
      sendJson(ws, { v: 1, type: 'welcome', protocol: 1, session: sessionInfo() });
      void skillRegistry.list().then((catalog) => sendJson(ws, { v: 1, type: 'skills-catalog', ...catalog }));
      void writingStyleStore.status().then((status) => sendJson(ws, { v: 1, type: 'writing-style-status', status }));
      log('studio connected');
    } else {
      const agentLabel = url.searchParams.get('agent') ?? 'unknown';
      // 도구 호출에 찍을 에이전트 라벨 — 접속 시점 값을 소켓에 붙여 둔다 (없으면 null, 세션 값이 대신 쓰인다).
      ws.agentLabel = url.searchParams.get('agent');
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
  void fs.rm(ISOLATED_HOME, { recursive: true, force: true }).finally(() => process.exit(1));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${signal})`);
  disposeSession();
  for (const sock of wss.clients) {
    try { sock.close(1001, 'server shutting down'); } catch {}
  }
  await new Promise((resolve) => httpServer.close(resolve));
  await fs.rm(ISOLATED_HOME, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown(signal).finally(() => process.exit(0)); });
}
