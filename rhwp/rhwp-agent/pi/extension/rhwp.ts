/**
 * rhwp pi extension — 허브가 정의한 rhwp 도구를 pi 에 등록하고 실행을 허브로 넘긴다.
 *
 * pi 는 jiti 로 이 파일을 그대로 읽는다(빌드 단계 없음). 그래서 런타임 의존성은
 * node 내장 모듈과 typebox(동적 임포트) 뿐이고, 순수 로직은 전부 named export 로 빼서
 * tests/pi-extension.test.mjs 가 직접 임포트한다.
 *
 * 설정은 전부 process.env 로 들어온다 (agents/pi.mjs 가 자식 env 를 조립한다).
 */
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult }
  from '@earendil-works/pi-coding-agent';

// ─────────────────────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────────────────────

/** 확장이 필요로 하는 모든 환경 설정. */
export interface PiExtensionConfig {
  /** 허브 HTTP 베이스 (도구 정의 조회용). */
  hubHttp: string;
  /** 허브 /mcp WS 엔드포인트. */
  wsUrl: string;
  token: string;
  agentName: string;
  workflow: string;
  phase: string;
  capabilityEpoch: string | undefined;
  toolProfile: string;
  permissionProfile: string;
  rootDir: string;
}

/** 허브 GET /pi/tool-definitions 응답 한 건. */
export interface HubToolDefinition {
  name: string;
  description: string;
  category?: string;
  inputSchema?: Record<string, unknown>;
}

/** pi 에 돌려주는 content 블록 (pi-ai 의 TextContent | ImageContent 와 같은 모양). */
export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** decodeHubFrame 결과. */
export type HubFrame =
  | { kind: 'tool-result'; id: number; ok: boolean; result: unknown; code: string; message: string }
  | { kind: 'protocol-error'; message: string }
  | { kind: 'ignored'; type: string }
  | { kind: 'unparseable' };

const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 180_000;
const DEFINITIONS_TIMEOUT_MS = 8_000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTS = ['png', 'jpg', 'gif', 'bmp'];

/** 계획 단계에서 막는 pi 내장 도구 (pi.mjs 의 --exclude-tools 와 이중 방어). */
export const PLANNING_BLOCKED_TOOLS = Object.freeze(['bash', 'edit', 'write']);
/** safe 프로필에서 경로 탈출을 검사하는 pi 내장 도구. */
export const PATH_GUARDED_TOOLS = Object.freeze(['read', 'edit', 'write']);

function log(message: string): void {
  process.stderr.write(`[rhwp-pi] ${message}\n`);
}

/** code 를 달아 formatErrorText 가 "CODE: message" 로 만들 수 있게 한다. */
export function hubError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// 순수 로직 — 환경/프레임/결과 변환
// ─────────────────────────────────────────────────────────────────────────────

/**
 * process.env 를 확장 설정으로 정규화한다. mcp-stdio.mjs 와 같은 기본값을 쓴다.
 * @param env 환경 변수 맵
 * @param cwd RHWP_ROOT_DIR 가 없을 때 쓰는 작업 디렉터리
 */
export function readExtensionConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): PiExtensionConfig {
  const workflow = env.RHWP_AGENT_WORKFLOW ?? env.RHWP_WORKFLOW ?? 'direct';
  const phase = env.RHWP_AGENT_PHASE ?? env.RHWP_PLAN_PHASE
    ?? (workflow === 'plan' ? 'planning' : 'implementing');
  return {
    hubHttp: env.RHWP_HUB_HTTP ?? 'http://127.0.0.1:5175',
    wsUrl: env.RHWP_WS_URL ?? 'ws://127.0.0.1:5175/mcp',
    token: env.RHWP_AGENT_TOKEN ?? 'dev',
    agentName: env.RHWP_AGENT_NAME ?? 'pi',
    workflow,
    phase,
    capabilityEpoch: env.RHWP_CAPABILITY_EPOCH,
    toolProfile: env.RHWP_TOOL_PROFILE ?? (workflow === 'plan' ? phase : 'direct'),
    permissionProfile: env.RHWP_PERMISSION_PROFILE ?? 'safe',
    rootDir: env.RHWP_ROOT_DIR ?? cwd,
  };
}

/** 허브 도구 정의 엔드포인트 URL. */
export function hubToolDefinitionsUrl(config: PiExtensionConfig): string {
  const base = config.hubHttp.replace(/\/+$/, '');
  const token = encodeURIComponent(config.token);
  const profile = encodeURIComponent(config.toolProfile);
  return `${base}/pi/tool-definitions?token=${token}&profile=${profile}`;
}

/** 허브 /mcp WS URL — mcp-stdio.mjs 와 같은 쿼리 계약. */
export function hubSocketUrl(config: PiExtensionConfig): string {
  const parts = [
    `token=${encodeURIComponent(config.token)}`,
    `agent=${encodeURIComponent(config.agentName)}`,
    `workflow=${encodeURIComponent(config.workflow)}`,
  ];
  if (config.capabilityEpoch) {
    parts.push(`capabilityEpoch=${encodeURIComponent(config.capabilityEpoch)}`);
  }
  return `${config.wsUrl}?${parts.join('&')}`;
}

/** 허브로 보낼 v2 tool-call 프레임. */
export function encodeToolCallFrame(
  id: number,
  tool: string,
  args: unknown,
  config: PiExtensionConfig,
): Record<string, unknown> {
  return {
    v: 2,
    type: 'tool-call',
    id,
    tool,
    args,
    workflow: config.workflow,
    ...(config.capabilityEpoch ? { capabilityEpoch: config.capabilityEpoch } : {}),
  };
}

/** 허브에서 온 프레임을 해석한다. 파싱 실패나 모르는 타입은 무시 대상으로 표시한다. */
export function decodeHubFrame(raw: unknown): HubFrame {
  let msg: any;
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return { kind: 'unparseable' };
  }
  if (!msg || typeof msg !== 'object') return { kind: 'unparseable' };
  if (msg.type === 'tool-result') {
    return {
      kind: 'tool-result',
      id: Number(msg.id),
      ok: msg.ok === true,
      result: msg.result,
      code: typeof msg.error?.code === 'string' ? msg.error.code : 'RPC_ERROR',
      message: typeof msg.error?.message === 'string' ? msg.error.message : 'unknown hub error',
    };
  }
  if (msg.type === 'protocol-error') {
    return { kind: 'protocol-error', message: String(msg.message ?? 'protocol error') };
  }
  return { kind: 'ignored', type: String(msg.type ?? '') };
}

/** text/image 이외의 블록은 텍스트로 눌러 담는다 (pi content 는 두 종류만 받는다). */
function normalizeContentBlock(block: any): ToolContentBlock {
  if (block && block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block && block.type === 'image' && typeof block.data === 'string'
    && typeof block.mimeType === 'string') {
    return { type: 'image', data: block.data, mimeType: block.mimeType };
  }
  return { type: 'text', text: JSON.stringify(block) };
}

/**
 * 스튜디오 결과를 pi content 블록으로 바꾼다 (tools.mjs 의 toToolContent 와 같은 의미).
 * result.image 가 있으면 image 블록을 먼저 두고 나머지 필드를 text(JSON) 로 남긴다
 * (render_page png, verify_changes includeImage).
 */
export function toToolContent(result: unknown): ToolContentBlock[] {
  const value = result as any;
  if (value && typeof value === 'object' && Array.isArray(value.mcpContent)) {
    return value.mcpContent.map(normalizeContentBlock);
  }
  const image = value && typeof value === 'object' ? value.image : null;
  if (image && typeof image === 'object' && typeof image.data === 'string'
    && typeof image.mimeType === 'string') {
    const { image: _omit, ...rest } = value;
    return [
      { type: 'image', data: image.data, mimeType: image.mimeType },
      { type: 'text', text: JSON.stringify(rest) },
    ];
  }
  return [{ type: 'text', text: JSON.stringify(result) }];
}

/** 던져진 에러를 "CODE: message" 한 줄로 만든다. pi 는 throw 로만 isError 를 세운다. */
export function formatErrorText(err: unknown): string {
  const raw = (err as any)?.code;
  let code = 'RPC_ERROR';
  if (typeof raw === 'string' && raw.length > 0) {
    code = raw === 'ENOENT' ? 'FILE_NOT_FOUND' : raw;
  } else if ((err as any)?.syscall === 'open') {
    code = 'FILE_NOT_FOUND';
  }
  const message = err instanceof Error ? err.message : String(err);
  return `${code}: ${message}`;
}

/**
 * 허브의 JSON Schema 를 pi 파라미터 스키마로 감싼다.
 * pi 는 parameters 를 그대로 provider 에 실어 보내므로 $schema 같은 군더더기는 떼어낸다.
 * typebox 의 Type.Unsafe 가 있으면 통과시키고, 없으면 순수 JSON Schema 그대로 쓴다
 * (typebox 의 검증기는 표준 JSON Schema 를 그대로 검사한다).
 */
export function toParameterSchema(
  inputSchema: Record<string, unknown> | undefined,
  unsafe?: (schema: Record<string, unknown>) => any,
): any {
  const source = inputSchema && typeof inputSchema === 'object' ? inputSchema : {};
  const { $schema: _dropped, ...rest } = source as Record<string, unknown>;
  const schema = { type: 'object', properties: {}, ...rest };
  return unsafe ? unsafe(schema) : schema;
}

// ─────────────────────────────────────────────────────────────────────────────
// 순수 로직 — 이미지
// ─────────────────────────────────────────────────────────────────────────────

/** PNG/JPEG/GIF/BMP 헤더에서 픽셀 크기를 읽는다. 실패 시 null. */
export function parseImageDims(
  buf: Buffer,
  ext: string,
): { width: number; height: number } | null {
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
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const segLen = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 (DHT/DNL/DAC 제외) 에 크기가 실린다
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8
          && marker !== 0xcc) {
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

/**
 * insert_image 인자를 허브가 받는 모양으로 만든다.
 * 로컬 파일은 이 프로세스가 읽어 base64 + 원본 픽셀 크기로 바꿔 보낸다.
 * @param args 도구 인자
 * @param readFileImpl 파일 리더 (테스트에서 주입)
 */
export async function prepareInsertImageArgs(
  args: Record<string, unknown>,
  readFileImpl: (filePath: string) => Promise<Buffer>,
): Promise<Record<string, unknown>> {
  const { imagePath, imageBase64, extension, ...rest } = args ?? {};
  let buf: Buffer;
  let ext: string;
  if (typeof imagePath === 'string' && imagePath.length > 0) {
    buf = await readFileImpl(imagePath);
    ext = path.extname(imagePath).slice(1).toLowerCase().replace('jpeg', 'jpg');
  } else if (typeof imageBase64 === 'string' && imageBase64.length > 0) {
    if (typeof extension !== 'string' || extension.length === 0) {
      throw hubError('INVALID_ARGS', 'extension is required with imageBase64');
    }
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
  return {
    ...rest,
    imageBase64: buf.toString('base64'),
    extension: ext,
    naturalWidthPx: dims.width,
    naturalHeightPx: dims.height,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 순수 로직 — 단계/권한 가드
// ─────────────────────────────────────────────────────────────────────────────

/** 계획 워크플로에서 아직 구현 단계로 넘어가지 않았는지. */
export function isPlanningRestricted(workflow: string, phase: string): boolean {
  return workflow === 'plan' && phase !== 'implementing';
}

/** target 이 rootDir 밖으로 나가는지. rootDir 가 비면 검사하지 않는다. */
export function escapesRoot(rootDir: string, target: string, cwd: string): boolean {
  if (!rootDir || typeof target !== 'string' || target.length === 0) return false;
  const root = path.resolve(rootDir);
  const resolved = path.resolve(cwd || root, target);
  const rel = path.relative(root, resolved);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * pi 내장 도구 호출을 막을지 판단한다 (허브의 리비전/대기편집 규율은 그대로 허브가 강제한다).
 * 막지 않을 때는 undefined 를 돌려줘 pi 가 그대로 진행하게 한다.
 */
export function guardToolCall(
  event: { toolName?: string; input?: Record<string, unknown> },
  config: PiExtensionConfig,
  cwd: string,
): ToolCallEventResult | undefined {
  const toolName = event?.toolName;
  if (typeof toolName !== 'string') return undefined;
  if (PLANNING_BLOCKED_TOOLS.includes(toolName)
    && isPlanningRestricted(config.workflow, config.phase)) {
    return {
      block: true,
      reason: `Planning phase: the built-in ${toolName} tool is disabled. Inspect only, then call `
        + 'present_implementation_plan when the proposal is concrete.',
    };
  }
  if (config.permissionProfile === 'safe' && PATH_GUARDED_TOOLS.includes(toolName)) {
    const target = (event?.input as any)?.path;
    if (typeof target === 'string' && escapesRoot(config.rootDir, target, cwd)) {
      return {
        block: true,
        reason: `Safe profile: "${target}" is outside the workspace root ${config.rootDir}.`,
      };
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 허브 통신
// ─────────────────────────────────────────────────────────────────────────────

/**
 * keep-alive 없이 JSON 을 GET 한다.
 * global fetch 는 유휴 소켓을 몇 초 붙들어 턴당 프로세스 종료를 늦추므로 node:http 를 쓴다.
 */
function httpGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (e: any) {
      reject(hubError('HUB_UNAVAILABLE', `invalid hub url: ${e?.message ?? e}`));
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(target, { agent: false, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 0) >= 400) {
          const detail = `hub responded ${res.statusCode}: ${body.slice(0, 200)}`;
          reject(hubError('HUB_UNAVAILABLE', detail));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(hubError('HUB_UNAVAILABLE', 'hub returned a non-JSON tool definition list'));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(hubError('HUB_UNAVAILABLE', 'hub did not answer the tool definition request'));
    });
    req.on('error', (e: any) => {
      reject(e?.code === 'HUB_UNAVAILABLE' ? e : hubError('HUB_UNAVAILABLE', `${e?.message ?? e}`));
    });
    req.end();
  });
}

/** 허브에서 이 프로필의 도구 정의를 가져온다. 실패하면 빈 배열 (pi 는 내장 도구로 계속 돈다). */
export async function fetchToolDefinitions(
  config: PiExtensionConfig,
  getJson: (url: string, timeoutMs: number) => Promise<unknown> = httpGetJson,
): Promise<HubToolDefinition[]> {
  try {
    const body = await getJson(hubToolDefinitionsUrl(config), DEFINITIONS_TIMEOUT_MS);
    if (!Array.isArray(body)) return [];
    return body.filter((def: any) => def && typeof def.name === 'string') as HubToolDefinition[];
  } catch (e: any) {
    log(`tool definitions unavailable (${e?.message ?? e}) — registering rhwp tools is skipped`);
    return [];
  }
}

interface Inflight {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 허브 /mcp WS 클라이언트 — 지연 연결, 끊기면 다음 호출에서 다시 연결한다. */
function createHubClient(config: PiExtensionConfig) {
  let sock: any = null;
  let connecting: Promise<any> | null = null;
  let nextId = 1;
  const inflight = new Map<number, Inflight>();

  function failAllInflight(err: unknown): void {
    for (const [, entry] of inflight) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    inflight.clear();
  }

  function ensureConnected(): Promise<any> {
    if (sock && sock.readyState === 1) return Promise.resolve(sock);
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const unavailable = () => hubError(
        'HUB_UNAVAILABLE',
        'rhwp-agent hub is not running (node server.mjs)',
      );
      let candidate: any;
      try {
        candidate = new WebSocket(hubSocketUrl(config));
      } catch {
        connecting = null;
        reject(unavailable());
        return;
      }
      const openTimer = setTimeout(() => {
        try { candidate.close(); } catch { /* 이미 죽은 소켓 */ }
        connecting = null;
        reject(unavailable());
      }, CONNECT_TIMEOUT_MS);

      candidate.addEventListener('open', () => {
        clearTimeout(openTimer);
        sock = candidate;
        connecting = null;
        resolve(candidate);
      });
      candidate.addEventListener('message', (event: any) => {
        const frame = decodeHubFrame(event?.data);
        if (frame.kind === 'protocol-error') {
          log(`hub protocol error: ${frame.message}`);
          return;
        }
        if (frame.kind !== 'tool-result') return;
        const entry = inflight.get(frame.id);
        if (!entry) return;
        inflight.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.ok) entry.resolve(frame.result);
        else entry.reject(hubError(frame.code, frame.message));
      });
      candidate.addEventListener('error', () => {
        clearTimeout(openTimer);
        if (connecting) {
          connecting = null;
          reject(unavailable());
        }
      });
      candidate.addEventListener('close', () => {
        // 교체된 옛 소켓의 close 가 현재 연결의 in-flight 호출을 죽이면 안 된다.
        if (sock !== candidate) return;
        sock = null;
        failAllInflight(hubError('HUB_UNAVAILABLE', 'connection to rhwp-agent hub was closed'));
      });
    });
    return connecting;
  }

  async function call(tool: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw hubError('ABORTED', 'tool call was aborted');
    const socket = await ensureConnected();
    const id = nextId++;
    return await new Promise((resolve, reject) => {
      const settle = (fn: (v: any) => void, value: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      function onAbort(): void {
        const entry = inflight.get(id);
        if (!entry) return;
        inflight.delete(id);
        clearTimeout(entry.timer);
        settle(reject, hubError('ABORTED', 'tool call was aborted'));
      }
      const timer = setTimeout(() => {
        inflight.delete(id);
        settle(reject, hubError(
          'TOOL_TIMEOUT',
          'The hub did not respond within 180s; if this was a document edit, re-read before '
            + 'retrying to avoid duplicates',
        ));
      }, CALL_TIMEOUT_MS);
      inflight.set(id, {
        resolve: (value) => settle(resolve, value),
        reject: (err) => settle(reject, err),
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        socket.send(JSON.stringify(encodeToolCallFrame(id, tool, args, config)));
      } catch (e: any) {
        inflight.delete(id);
        clearTimeout(timer);
        settle(reject, hubError('HUB_UNAVAILABLE', `failed to send to hub: ${e?.message ?? e}`));
      }
    });
  }

  /** 열린 WS 가 이벤트 루프를 붙들어 턴 종료를 막지 않도록 명시적으로 닫는다. */
  function dispose(): void {
    const closing = sock;
    sock = null;
    failAllInflight(hubError('HUB_UNAVAILABLE', 'hub connection was closed'));
    try { closing?.close(); } catch { /* 이미 닫힘 */ }
  }

  return { call, dispose };
}

type UnsafeBuilder = (schema: Record<string, unknown>) => any;

/** typebox 의 Type.Unsafe 를 찾아온다. 없으면 undefined (toParameterSchema 가 대체한다). */
async function loadUnsafeBuilder(): Promise<UnsafeBuilder | undefined> {
  for (const specifier of ['@sinclair/typebox', 'typebox']) {
    try {
      const mod: any = await import(specifier);
      const unsafe = mod?.Type?.Unsafe ?? mod?.default?.Type?.Unsafe;
      if (typeof unsafe === 'function') return (schema) => unsafe(schema);
    } catch { /* 다음 후보 */ }
  }
  log('typebox is not resolvable — passing raw JSON Schema parameters through');
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 확장 팩토리
// ─────────────────────────────────────────────────────────────────────────────

export default async function rhwpPiExtension(pi: ExtensionAPI): Promise<void> {
  const config = readExtensionConfig();
  const client = createHubClient(config);

  // 내장 도구 가드는 허브 연결과 무관하게 항상 건다.
  pi.on('tool_call', (event: ToolCallEvent, ctx: ExtensionContext) =>
    guardToolCall(event, config, ctx?.cwd ?? process.cwd()));
  pi.on('agent_settled', () => { client.dispose(); });
  pi.on('session_shutdown', () => { client.dispose(); });

  const definitions = await fetchToolDefinitions(config);
  if (definitions.length === 0) return;
  const unsafe = await loadUnsafeBuilder();

  for (const def of definitions) {
    pi.registerTool({
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: toParameterSchema(def.inputSchema, unsafe),
      async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined) {
        try {
          const args = (params ?? {}) as Record<string, unknown>;
          const payload = def.name === 'insert_image'
            ? await prepareInsertImageArgs(args, readFile)
            : args;
          const result = await client.call(def.name, payload, signal);
          return { content: toToolContent(result), details: result };
        } catch (e) {
          // pi 는 throw 한 에러만 isError 로 표시한다 — 코드가 앞에 붙은 한 줄로 던진다.
          throw new Error(formatErrorText(e));
        }
      },
    });
  }

  log(`registered ${definitions.length} rhwp tools (profile=${config.toolProfile}, `
    + `workflow=${config.workflow}, phase=${config.phase})`);
}
