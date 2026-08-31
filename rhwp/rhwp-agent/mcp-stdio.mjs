import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { open } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import {
  HUB_CAPABILITY_AUDIENCES,
  resolveHubIdentity,
  sessionIdFromScopedHubToken,
} from './hub-session-registry.mjs';
import { filterToolDefinitions, toToolContent, toolAnnotations } from './tools.mjs';
import { assertImagePathInsideRoots, imageRootsFromEnv } from './image-path-policy.mjs';

const WS_URL = process.env.RHWP_WS_URL ?? 'ws://127.0.0.1:5175/mcp';
const { token: TOKEN, development: DEVELOPMENT_AUTH } = resolveHubIdentity();
const SESSION_ID = process.env.RHWP_SESSION_ID
  ?? sessionIdFromScopedHubToken(TOKEN, { audience: HUB_CAPABILITY_AUDIENCES.MCP })
  ?? sessionIdFromScopedHubToken(TOKEN, { audience: HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER })
  ?? (DEVELOPMENT_AUTH ? 'dev' : null);
const AGENT_NAME = process.env.RHWP_AGENT_NAME ?? 'unknown';
const AGENT_ROLE = process.env.RHWP_AGENT_ROLE ?? 'chat';
const COPY_LAYOUT_JOB_ID = /^copy-layout-worker:([^:]+):[A-Za-z0-9_-]+$/.exec(AGENT_ROLE)?.[1] ?? null;
const WORKFLOW = process.env.RHWP_AGENT_WORKFLOW ?? process.env.RHWP_WORKFLOW ?? 'direct';
const PHASE = process.env.RHWP_AGENT_PHASE ?? process.env.RHWP_PLAN_PHASE
  ?? (WORKFLOW === 'plan' ? 'planning' : WORKFLOW === 'question' ? 'questioning' : 'implementing');
const CAPABILITY_EPOCH = process.env.RHWP_CAPABILITY_EPOCH;
const TOOL_PROFILE = process.env.RHWP_TOOL_PROFILE
  ?? (WORKFLOW === 'direct' ? 'direct' : PHASE === 'questioning' ? 'question' : PHASE);
const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 180_000;
const MAX_PROVIDER_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_INFLIGHT_CALLS = 64;

// insert_image 가 읽을 수 있는 루트 디렉터리(세션 작업 공간·다운로드 등).
// 어댑터가 루트를 넘겨주면 그 밖의 절대경로 읽기는 전부 거부한다.
const IMAGE_ALLOWED_ROOTS = imageRootsFromEnv(process.env);

function log(msg) {
  process.stderr.write(`[rhwp-mcp] ${msg}\n`);
}

function safeHubEndpoint(raw) {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<invalid hub URL>';
  }
}

const LOG_WS_ENDPOINT = safeHubEndpoint(WS_URL);

function hubError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** @type {WebSocket | null} */
let ws = null;
/** @type {Promise<WebSocket> | null} */
let connecting = null;
let nextId = 1;
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer: NodeJS.Timeout | null }>} */
const inflight = new Map();

function failAllInflight(err) {
  for (const [, entry] of inflight) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(err);
  }
  inflight.clear();
}

function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    let sock;
    try {
      if (!SESSION_ID) throw hubError('SESSION_REQUIRED', 'RHWP_SESSION_ID or a session-scoped hub token is required');
      const url = new URL(WS_URL);
      url.searchParams.set('token', TOKEN);
      url.searchParams.set('sessionId', SESSION_ID);
      url.searchParams.set('agent', AGENT_NAME);
      url.searchParams.set('role', AGENT_ROLE);
      if (COPY_LAYOUT_JOB_ID) url.searchParams.set('workerJobId', COPY_LAYOUT_JOB_ID);
      url.searchParams.set('workflow', WORKFLOW);
      if (CAPABILITY_EPOCH) url.searchParams.set('capabilityEpoch', CAPABILITY_EPOCH);
      sock = new WebSocket(url, { maxPayload: MAX_PROVIDER_FRAME_BYTES });
    } catch (e) {
      connecting = null;
      reject(e?.code ? e : hubError('HUB_UNAVAILABLE', 'rhwp-agent hub is not running (node server.mjs)'));
      return;
    }
    const openTimer = setTimeout(() => {
      try { sock.terminate(); } catch {}
      connecting = null;
      reject(hubError('HUB_UNAVAILABLE', 'rhwp-agent hub is not running (node server.mjs)'));
    }, CONNECT_TIMEOUT_MS);

    sock.on('open', () => {
      clearTimeout(openTimer);
      ws = sock;
      connecting = null;
      log(`connected to hub at ${LOG_WS_ENDPOINT}`);
      resolve(sock);
    });
    sock.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        log('ignoring unparseable hub frame');
        return;
      }
      if (msg?.type === 'tool-result') {
        const entry = inflight.get(msg.id);
        if (!entry) return;
        inflight.delete(msg.id);
        if (entry.timer) clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(hubError(msg.error?.code ?? 'RPC_ERROR', msg.error?.message ?? 'unknown hub error'));
      } else if (msg?.type === 'protocol-error') {
        log(`hub protocol error: ${msg.message}`);
      }
    });
    sock.on('error', (err) => {
      clearTimeout(openTimer);
      log(`ws error: ${err?.message ?? err}`);
      if (connecting) {
        connecting = null;
        reject(hubError('HUB_UNAVAILABLE', 'rhwp-agent hub is not running (node server.mjs)'));
      }
    });
    sock.on('close', () => {
      // 대체된 옛 소켓의 close 가 현재 연결의 in-flight 호출을 죽이면 안 된다.
      if (ws !== sock) return;
      ws = null;
      failAllInflight(hubError('HUB_UNAVAILABLE', 'connection to rhwp-agent hub was closed'));
    });
  });
  return connecting;
}

async function callHub(tool, args) {
  const sock = await ensureConnected();
  if (inflight.size >= MAX_INFLIGHT_CALLS) {
    throw hubError('TOO_MANY_INFLIGHT_CALLS', `At most ${MAX_INFLIGHT_CALLS} tool calls may be in flight`);
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    // Human input is hub-owned and lives until answered, cancelled, or its provider
    // connection disappears. Applying the ordinary MCP timeout would turn a normal
    // pause into a false tool failure.
    const timer = tool === 'ask_user_question'
      ? null
      : setTimeout(() => {
        inflight.delete(id);
        reject(hubError('TOOL_TIMEOUT', 'The hub did not respond within 180s; if this was a document edit, re-read before retrying to avoid duplicates'));
      }, CALL_TIMEOUT_MS);
    inflight.set(id, { resolve, reject, timer });
    try {
      sock.send(JSON.stringify({
        v: 5,
        type: 'tool-call',
        id,
        tool,
        args,
        workflow: WORKFLOW,
        ...(CAPABILITY_EPOCH ? { capabilityEpoch: CAPABILITY_EPOCH } : {}),
      }));
    } catch (e) {
      inflight.delete(id);
      if (timer) clearTimeout(timer);
      reject(hubError('HUB_UNAVAILABLE', `failed to send to hub: ${e?.message ?? e}`));
    }
  });
}

const server = new McpServer({ name: 'rhwp', version: '0.1.0' });

function registerTool(def) {
  server.registerTool(def.name, {
    description: def.description,
    inputSchema: def.shape,
    annotations: toolAnnotations(def.category),
    _meta: { 'rhwp/toolCategory': def.category },
  }, async (args) => {
    try {
      def.validate?.(args ?? {});
      const result = await callHub(def.name, args ?? {});
      return { content: toToolContent(result) };
    } catch (e) {
      return { content: [{ type: 'text', text: `${e.code ?? 'RPC_ERROR'}: ${e.message}` }], isError: true };
    }
  });
}

// 도구 정의는 tools.mjs 가 단일 소스 — 테스트가 같은 정의를 임포트해 계약을 검증한다.
const visibleTools = filterToolDefinitions(TOOL_PROFILE);
for (const def of visibleTools) {
  // insert_image 만 파일 읽기가 필요해 아래 커스텀 핸들러로 등록한다.
  if (def.name === 'insert_image') registerInsertImageTool(def);
  else registerTool(def);
}

// ─── 이미지 삽입 — 파일은 이 프로세스(로컬)가 읽어 base64 로 전달한다 ───
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTS = ['png', 'jpg', 'gif', 'bmp'];

/** PNG/JPEG/GIF/BMP 헤더에서 픽셀 크기를 읽는다. 실패 시 null. */
function parseImageDims(buf, ext) {
  try {
    if (ext === 'png') {
      if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (ext === 'gif') {
      if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'GIF') return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (ext === 'bmp') {
      if (buf.length < 26 || buf.toString('ascii', 0, 2) !== 'BM') return null;
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (ext === 'jpg') {
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const segLen = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 (DHT/DNL/DAC 제외) 에 크기가 실린다
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + segLen;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

// insert_image 만 커스텀 등록 — description/shape 는 tools.mjs 정의를 그대로 쓴다.

/** imagePath 가 허용된 루트(실제 경로 기준) 안에 있는지 확인한다. */
function assertImagePathAllowed(imagePath) {
  return assertImagePathInsideRoots(imagePath, IMAGE_ALLOWED_ROOTS);
}

async function readImageFile(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw hubError('INVALID_ARGS', 'image path must name a regular file');
    if (stat.size < 1) throw hubError('INVALID_ARGS', 'image file is empty');
    if (stat.size > IMAGE_MAX_BYTES) {
      throw hubError('INVALID_ARGS', `image is ${(stat.size / 1048576).toFixed(1)}MB — max 5MB`);
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw hubError('INVALID_ARGS', 'image file changed while it was read');
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead !== 0) {
      throw hubError('INVALID_ARGS', 'image file changed while it was read');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function registerInsertImageTool(def) {
  server.registerTool(
    def.name,
    {
      description: def.description,
      inputSchema: def.shape,
      annotations: toolAnnotations(def.category),
      _meta: { 'rhwp/toolCategory': def.category },
    },
    async (args) => {
      try {
        const { imagePath, imageBase64, extension, ...rest } = args ?? {};
        let buf;
        let ext;
        if (typeof imagePath === 'string' && imagePath.length > 0) {
          const resolvedImagePath = await assertImagePathAllowed(imagePath);
          buf = await readImageFile(resolvedImagePath);
          ext = path.extname(resolvedImagePath).slice(1).toLowerCase().replace('jpeg', 'jpg');
        } else if (typeof imageBase64 === 'string' && imageBase64.length > 0) {
          if (!extension) throw hubError('INVALID_ARGS', 'extension is required with imageBase64');
          buf = Buffer.from(imageBase64, 'base64');
          ext = extension.toLowerCase().replace('jpeg', 'jpg');
        } else {
          throw hubError('INVALID_ARGS', 'either imagePath or imageBase64 is required');
        }
        if (!IMAGE_EXTS.includes(ext)) {
          throw hubError('INVALID_ARGS', `unsupported image type "${ext}" — use png/jpg/gif/bmp`);
        }
        if (buf.length === 0) throw hubError('INVALID_ARGS', 'image file is empty');
        if (buf.length > IMAGE_MAX_BYTES) {
          throw hubError('INVALID_ARGS', `image is ${(buf.length / 1048576).toFixed(1)}MB — max 5MB`);
        }
        const dims = parseImageDims(buf, ext);
        if (!dims || dims.width < 1 || dims.height < 1) {
          throw hubError('INVALID_ARGS', 'could not read image dimensions — is the file a valid image?');
        }
        const result = await callHub('insert_image', {
          ...rest,
          imageBase64: buf.toString('base64'),
          extension: ext,
          naturalWidthPx: dims.width,
          naturalHeightPx: dims.height,
        });
        return { content: toToolContent(result) };
      } catch (e) {
        const code = e.code ?? (e.syscall === 'open' ? 'FILE_NOT_FOUND' : 'RPC_ERROR');
        return { content: [{ type: 'text', text: `${code}: ${e.message}` }], isError: true };
      }
    }
  );
}

// 부모 CLI 가 시그널 대신 stdin 을 닫아 종료하는 경우에도 프로세스가 남지 않도록:
// 허브 WS 연결이 이벤트 루프를 붙들고 있으므로 transport 종료 시 명시적으로 나간다.
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  failAllInflight(hubError('HUB_UNAVAILABLE', 'mcp server is shutting down'));
  try { ws?.terminate(); } catch {}
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
// server.connect 가 transport.onclose 를 소유하므로 Protocol 레벨 onclose 훅을 쓴다.
server.server.onclose = () => shutdown('stdio transport closed');
process.stdin.on('end', () => shutdown('stdin EOF'));
process.stdin.on('close', () => shutdown('stdin closed'));
log(`rhwp MCP stdio server started (agent=${AGENT_NAME}, session=${SESSION_ID ?? 'missing'}, hub=${LOG_WS_ENDPOINT}, workflow=${WORKFLOW}, profile=${TOOL_PROFILE}, epoch=${CAPABILITY_EPOCH ?? 'legacy'})`);

ensureConnected().then(
  () => log('eager hub connection established'),
  (e) => log(`eager hub connection failed (will retry on demand): ${e?.message ?? e}`)
);
