import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

import { boundBrowserbaseResultContent } from './browserbase-result.mjs';

const SIDECAR_CLI = fileURLToPath(new URL('./browserbase-sidecar.mjs', import.meta.url));
const REQUIRED_TOOLS = Object.freeze(['start', 'end', 'navigate', 'act', 'observe', 'extract']);
const MAX_API_ERROR_DETAIL_LENGTH = 240;
const BROWSERBASE_API_BASE = 'https://api.browserbase.com';

/** 기본(공유) 브라우저 id — browserId 를 생략한 호출은 모두 여기로 간다. */
export const MAIN_BROWSER_ID = 'main';
/** 한 채팅이 동시에 띄울 수 있는 원격 브라우저 수(메인 포함). */
export const MAX_BROWSERS = 4;
export const BROWSER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** 사이드카가 요구하는 세 자격 증명 — 환경 변수 이름이 곧 필드 이름이다. */
export const BROWSERBASE_CREDENTIAL_FIELDS = Object.freeze({
  apiKey: 'BROWSERBASE_API_KEY',
  projectId: 'BROWSERBASE_PROJECT_ID',
  geminiApiKey: 'GEMINI_API_KEY',
});

function browserError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanupUncertainError(cause = null) {
  const error = browserError(
    'BROWSERBASE_CLEANUP_UNCERTAIN',
    'The previous Browserbase sidecar or remote session could not be confirmed closed. Restart the app before using Browserbase again.',
  );
  if (cause) error.cause = cause;
  error.processCleanupUncertain = true;
  return error;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(browserError('BROWSERBASE_TIMEOUT', message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function cleanValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function apiErrorDetail(body, secret) {
  if (!body) return '';
  let detail = '';
  if (typeof body === 'string') {
    detail = body;
  } else if (typeof body === 'object') {
    const candidate = body.message ?? body.error;
    if (typeof candidate === 'string') detail = candidate;
  }
  const clean = detail
    .replaceAll(secret, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? `: ${clean.slice(0, MAX_API_ERROR_DETAIL_LENGTH)}` : '';
}

async function readApiBody(response) {
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (typeof response.json === 'function') return response.json();
  return null;
}

function projectRows(body) {
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
  if (!rows) return null;
  return rows
    .filter((project) => project && typeof project.id === 'string' && project.id.length > 0)
    .map((project) => ({ id: project.id, name: typeof project.name === 'string' ? project.name : null }));
}

/** 끝 네 글자만 — 상태 표시용. 키 본문은 어디에도 돌려주지 않는다. */
export function credentialTail(value) {
  const clean = cleanValue(value);
  if (!clean) return null;
  return clean.slice(-4);
}

/**
 * 스튜디오가 앱 안에서 입력한 값(override)이 환경 변수보다 앞선다 — 필드별로.
 * 반환값의 각 필드는 { value, source } 이며 source 는 'studio' | 'env' | null.
 *
 * @param {{ env?: NodeJS.ProcessEnv, override?: BrowserbaseOverride | null }} [input]
 */
export function resolveBrowserbaseCredentials({ env = process.env, override = null } = {}) {
  const resolved = {};
  for (const [field, envName] of Object.entries(BROWSERBASE_CREDENTIAL_FIELDS)) {
    const fromStudio = cleanValue(override?.[field]);
    if (fromStudio) {
      resolved[field] = { value: fromStudio, source: 'studio' };
      continue;
    }
    const fromEnv = cleanValue(env[envName]);
    resolved[field] = fromEnv ? { value: fromEnv, source: 'env' } : { value: null, source: null };
  }
  return resolved;
}

/** @typedef {{ apiKey?: string | null, projectId?: string | null, geminiApiKey?: string | null }} BrowserbaseOverride */

/** 스튜디오가 보낸 override 를 다듬는다 — 빈 문자열은 버리고, 세 필드 모두 비면 null. */
export function normalizeBrowserbaseOverride(input) {
  if (!input || typeof input !== 'object') return null;
  const next = {};
  for (const field of Object.keys(BROWSERBASE_CREDENTIAL_FIELDS)) {
    const value = cleanValue(input[field]);
    if (!value) continue;
    if (value.length > 512) throw browserError('BROWSERBASE_INVALID_CREDENTIALS', `${field} is too long`);
    if (/[\r\n\0]/.test(value)) throw browserError('BROWSERBASE_INVALID_CREDENTIALS', `${field} contains control characters`);
    next[field] = value;
  }
  return Object.keys(next).length > 0 ? next : null;
}

function missingFields(resolved) {
  return Object.entries(BROWSERBASE_CREDENTIAL_FIELDS)
    .filter(([field]) => !resolved[field].value)
    .map(([, envName]) => envName);
}

/**
 * Browserbase API 에 키를 직접 확인한다. 프로젝트 id 를 주면 그 키의 계정에
 * 실제로 있는지 보고, 비우면 계정의 첫 프로젝트를 골라 준다.
 *
 * @param {{ apiKey: string, projectId?: string | null }} input
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, baseUrl?: string }} [options]
 * @returns {Promise<{ projectId: string, projectName: string | null, projects: Array<{ id: string, name: string | null }> }>}
 */
export async function validateBrowserbaseCredentials(input, options = {}) {
  const apiKey = cleanValue(input?.apiKey);
  if (!apiKey) throw browserError('BROWSERBASE_INVALID_CREDENTIALS', 'Browserbase API key is empty');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const baseUrl = (options.baseUrl ?? BROWSERBASE_API_BASE).replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const wanted = cleanValue(input?.projectId);
  const path = wanted ? `/v1/projects/${encodeURIComponent(wanted)}` : '/v1/projects';
  let response;
  let body = null;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { 'X-BB-API-Key': apiKey, Accept: 'application/json' },
      signal: controller.signal,
    });
    try {
      body = await readApiBody(response);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (response.ok) throw browserError('BROWSERBASE_API_ERROR', 'Browserbase API returned an unreadable response');
    }
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('BROWSERBASE_')) throw error;
    const reason = error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(error?.message ?? error);
    throw browserError('BROWSERBASE_UNREACHABLE', `Could not reach the Browserbase API (${reason})`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    throw browserError('BROWSERBASE_KEY_INVALID', 'Browserbase rejected this API key');
  }
  if (response.status === 404 && wanted) {
    throw browserError('BROWSERBASE_PROJECT_NOT_FOUND', `Project ${wanted} was not found for this Browserbase API key`);
  }
  if (response.status === 404) {
    throw browserError(
      'BROWSERBASE_PROJECT_REQUIRED',
      'Browserbase did not allow automatic project discovery for this API key. Enter its Project ID and try again.',
    );
  }
  if (!response.ok) {
    throw browserError(
      'BROWSERBASE_API_ERROR',
      `Browserbase API answered ${response.status} while ${wanted ? 'checking the project' : 'listing projects'}${apiErrorDetail(body, apiKey)}`,
    );
  }
  if (wanted) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string') {
      throw browserError('BROWSERBASE_API_ERROR', 'Browserbase API returned a malformed project response');
    }
    if (body.id !== wanted) {
      throw browserError('BROWSERBASE_API_ERROR', 'Browserbase API returned a different project than requested');
    }
    const project = { id: body.id, name: typeof body.name === 'string' ? body.name : null };
    return { projectId: project.id, projectName: project.name, projects: [project] };
  }
  const projects = projectRows(body);
  if (!projects) throw browserError('BROWSERBASE_API_ERROR', 'Browserbase API returned a malformed project list');
  if (projects.length === 0) throw browserError('BROWSERBASE_NO_PROJECT', 'This Browserbase account has no projects yet');
  return { projectId: projects[0].id, projectName: projects[0].name, projects };
}

function sidecarEnvironment(resolved, source = {}) {
  const missing = missingFields(resolved);
  if (missing.length > 0) {
    throw browserError(
      'BROWSERBASE_NOT_CONFIGURED',
      `Browserbase is not configured. Set ${missing.join(', ')} in the rhwp-agent environment or enter the key in the studio settings.`,
    );
  }
  const env = {
    ...getDefaultEnvironment(),
    BROWSERBASE_API_KEY: resolved.apiKey.value,
    BROWSERBASE_PROJECT_ID: resolved.projectId.value,
    GEMINI_API_KEY: resolved.geminiApiKey.value,
  };
  if (source.BROWSERBASE_MODEL_NAME) {
    env.BROWSERBASE_MODEL_NAME = String(source.BROWSERBASE_MODEL_NAME);
  }
  if (source.ELECTRON_RUN_AS_NODE === '1') env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

/** 자격 증명이 바뀌었는지 비교하는 지문 — 값 자체는 저장하지 않는다. */
export function credentialFingerprint(resolved) {
  return Object.keys(BROWSERBASE_CREDENTIAL_FIELDS)
    .map((field) => `${resolved[field].source ?? ''}:${resolved[field].value ?? ''}`)
    .join('\0');
}

function resultText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * 허브가 소유하는, 느리게 뜨는 Browserbase MCP 사이드카 하나 = 원격 브라우저 하나.
 *
 * 강화 지점: 사이드카가 죽으면 상태를 스스로 비워 다음 호출이 다시 띄우고,
 * 자격 증명이 바뀌면 다음 호출 전에 새 키로 다시 뜨며, 한동안 쓰이지 않으면
 * 원격 세션을 닫아 과금을 멈춘다. 원격 end 나 로컬 close 가 확인되지 않으면
 * 이후 호출은 BROWSERBASE_CLEANUP_UNCERTAIN 으로 막는다.
 */
export class BrowserbaseSession {
  /**
   * @param {{
   *   env?: NodeJS.ProcessEnv,
   *   credentials?: () => ReturnType<typeof resolveBrowserbaseCredentials>,
   *   startupTimeoutMs?: number,
   *   callTimeoutMs?: number,
   *   idleTimeoutMs?: number,
   *   log?: (message: string) => void,
   *   label?: string,
   *   execPath?: string,
   *   sidecarPath?: string,
   *   clientFactory?: () => Client,
   *   transportFactory?: (options: object) => StdioClientTransport,
   * }} [options]
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.getCredentials = options.credentials ?? (() => resolveBrowserbaseCredentials({ env: this.env }));
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 120_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60_000;
    this.label = options.label ?? MAIN_BROWSER_ID;
    this.execPath = options.execPath ?? process.execPath;
    this.sidecarPath = options.sidecarPath ?? SIDECAR_CLI;
    this.clientFactory = options.clientFactory ?? (() => new Client({
      name: 'rhwp-agent-browserbase-proxy',
      version: '1.0.0',
    }));
    this.transportFactory = options.transportFactory ?? ((params) => new StdioClientTransport(params));
    const log = options.log ?? (() => {});
    this.log = (message) => log(this.label === MAIN_BROWSER_ID ? message : `[${this.label}] ${message}`);
    /** @type {Client | null} */
    this.client = null;
    /** @type {StdioClientTransport | null} */
    this.transport = null;
    /** @type {Promise<Client> | null} */
    this.connecting = null;
    /** @type {string | null} */
    this.chatId = null;
    /** @type {string | null} */
    this.liveFingerprint = null;
    /** @type {NodeJS.Timeout | null} */
    this.idleTimer = null;
    this.cleanupConfirmed = true;
    this.uncertainResources = [];
    this.queue = Promise.resolve();
  }

  retainUncertainResources(client, transport, chatId = null) {
    this.uncertainResources.push({ client, transport, chatId });
  }

  enqueue(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  status() {
    const resolved = this.getCredentials();
    return {
      configured: missingFields(resolved).length === 0,
      connected: this.client !== null,
    };
  }

  armIdleTimer() {
    this.clearIdleTimer();
    if (!(this.idleTimeoutMs > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.cleanup('idle timeout');
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** 사이드카가 스스로 끝났을 때 — 죽은 핸들을 붙들고 있으면 모든 호출이 실패만 반복한다. */
  onSidecarClosed(client, reason) {
    if (this.client !== client) return;
    this.client = null;
    this.transport = null;
    this.liveFingerprint = null;
    this.clearIdleTimer();
    this.log(`Browserbase sidecar exited unexpectedly (${reason}); it will relaunch on the next call`);
  }

  async ensureConnected() {
    if (!this.cleanupConfirmed) throw cleanupUncertainError();
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const resolved = this.getCredentials();
      const env = sidecarEnvironment(resolved, this.env);
      const transport = this.transportFactory({
        command: this.execPath,
        args: ['--max-old-space-size=512', this.sidecarPath],
        env,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => {
        const message = chunk.toString().trim().slice(0, 8 * 1024);
        if (message) this.log(`[browserbase] ${message}`);
      });
      const client = this.clientFactory();
      try {
        await withTimeout(client.connect(transport), this.startupTimeoutMs, 'Browserbase sidecar did not become ready in time');
        const listed = await withTimeout(client.listTools(), this.startupTimeoutMs, 'Browserbase sidecar health check timed out');
        const names = new Set((listed.tools ?? []).map((tool) => tool.name));
        const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
        if (missing.length > 0) throw browserError('BROWSERBASE_UNHEALTHY', `Browserbase sidecar is missing tools: ${missing.join(', ')}`);
        this.transport = transport;
        this.client = client;
        this.liveFingerprint = credentialFingerprint(resolved);
        client.onclose = () => this.onSidecarClosed(client, 'transport closed');
        client.onerror = (error) => this.log(`Browserbase sidecar error: ${error?.message ?? error}`);
        this.log(`Browserbase sidecar ready (key from ${resolved.apiKey.source})`);
        return client;
      } catch (error) {
        const cleanupResults = await Promise.allSettled([
          withTimeout(client.close(), 5_000, 'Browserbase client cleanup timed out'),
          withTimeout(transport.close(), 5_000, 'Browserbase transport cleanup timed out'),
        ]);
        if (cleanupResults.some((result) => result.status === 'rejected')) {
          this.cleanupConfirmed = false;
          this.retainUncertainResources(client, transport, this.chatId);
        }
        if (!this.cleanupConfirmed) throw cleanupUncertainError(error);
        if (error?.code) throw error;
        throw browserError('BROWSERBASE_START_FAILED', String(error?.message ?? error));
      }
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  call(chatId, name, args = {}) {
    return this.enqueue(() => this.callNow(chatId, name, args));
  }

  async callNow(chatId, name, args = {}) {
    if (!REQUIRED_TOOLS.includes(name)) throw browserError('BROWSERBASE_TOOL_UNKNOWN', `Unknown Browserbase tool: ${name}`);
    if (this.chatId && this.chatId !== chatId) {
      const cleaned = await this.cleanupNow('chat changed');
      if (!cleaned) throw cleanupUncertainError();
    }
    this.chatId = chatId;
    if (this.client && this.liveFingerprint !== null && this.liveFingerprint !== credentialFingerprint(this.getCredentials())) {
      const cleaned = await this.cleanupNow('credentials changed');
      if (!cleaned) throw cleanupUncertainError();
      this.chatId = chatId;
    }
    const client = await this.ensureConnected();
    this.clearIdleTimer();
    let result;
    try {
      result = await withTimeout(
        client.callTool({ name, arguments: args }),
        this.callTimeoutMs,
        `Browserbase ${name} timed out after ${this.callTimeoutMs}ms`,
      );
    } catch (error) {
      if (error?.code === 'BROWSERBASE_TIMEOUT') {
        const cleaned = await this.abortNow(`tool timeout: ${name}`);
        if (!cleaned) throw cleanupUncertainError(error);
        throw browserError(
          'BROWSERBASE_TIMEOUT',
          `${error.message}. The remote action may already have applied; start a fresh session and observe state before retrying.`,
        );
      }
      if (!this.client) {
        await this.abortNow(`sidecar exited during ${name}`);
        throw browserError(
          'BROWSERBASE_SIDECAR_EXITED',
          `Browserbase sidecar exited during ${name}; call browserbase_start again and observe state before retrying`,
        );
      }
      const cleaned = await this.abortNow(`tool failure: ${name}`);
      if (!cleaned) throw cleanupUncertainError(error);
      if (error?.code) throw error;
      throw browserError('BROWSERBASE_TOOL_FAILED', String(error?.message ?? error));
    }
    if (result?.isError) {
      const message = resultText(result) || `Browserbase ${name} failed`;
      const remoteCleanupUncertain = message.includes('BROWSERBASE_CLEANUP_UNCERTAIN');
      const cleaned = await this.abortNow(`tool error: ${name}`);
      if (remoteCleanupUncertain) {
        this.cleanupConfirmed = false;
        throw cleanupUncertainError(browserError('BROWSERBASE_TOOL_FAILED', message));
      }
      if (!cleaned) throw cleanupUncertainError(browserError('BROWSERBASE_TOOL_FAILED', message));
      throw browserError('BROWSERBASE_TOOL_FAILED', message);
    }
    if (name === 'end') {
      await this.closeLocalNow('session ended');
    } else {
      this.armIdleTimer();
    }
    return {
      mcpContent: boundBrowserbaseResultContent(result?.content),
      ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    };
  }

  cleanup(reason = 'cleanup') {
    return this.enqueue(() => this.cleanupNow(reason));
  }

  detachHandles() {
    const client = this.client;
    const transport = this.transport;
    const chatId = this.chatId;
    this.client = null;
    this.transport = null;
    this.chatId = null;
    this.liveFingerprint = null;
    this.clearIdleTimer();
    if (client) client.onclose = undefined;
    return { client, transport, chatId };
  }

  async closeHandles(client, transport, chatId, confirmed) {
    const closeResults = await Promise.allSettled([
      withTimeout(client?.close(), 5_000, 'Browserbase client close timed out'),
      withTimeout(transport?.close(), 5_000, 'Browserbase transport close timed out'),
    ]);
    if (closeResults.some((result) => result.status === 'rejected')) confirmed = false;
    if (!confirmed) this.retainUncertainResources(client, transport, chatId);
    this.cleanupConfirmed &&= confirmed;
    return this.cleanupConfirmed;
  }

  async abortNow(reason) {
    const { client, transport, chatId } = this.detachHandles();
    let confirmed = true;
    if (client) {
      try {
        const result = await withTimeout(
          client.callTool({ name: 'end', arguments: {} }),
          5_000,
          'Browserbase emergency cleanup timed out',
        );
        if (result?.isError) confirmed = false;
      } catch (error) {
        confirmed = false;
        this.log(`Browserbase emergency cleanup failed: ${error?.message ?? error}`);
      }
    }
    const cleaned = await this.closeHandles(client, transport, chatId, confirmed);
    this.log(`Browserbase sidecar aborted (${reason})`);
    return cleaned;
  }

  async closeLocalNow(reason) {
    const { client, transport, chatId } = this.detachHandles();
    const cleaned = await this.closeHandles(client, transport, chatId, true);
    this.log(`Browserbase sidecar aborted (${reason})`);
    return cleaned;
  }

  async cleanupNow(reason = 'cleanup') {
    if (this.connecting) {
      try { await this.connecting; } catch {}
    }
    const { client, transport, chatId } = this.detachHandles();
    if (!client && !transport) return this.cleanupConfirmed;
    let confirmed = true;
    if (client) {
      try {
        const result = await withTimeout(
          client.callTool({ name: 'end', arguments: {} }),
          10_000,
          'Browserbase end timed out',
        );
        if (result?.isError) confirmed = false;
      } catch (error) {
        confirmed = false;
        this.log(`Browserbase end during ${reason} failed: ${error?.message ?? error}`);
      }
    }
    const cleaned = await this.closeHandles(client, transport, chatId, confirmed);
    this.log(`Browserbase sidecar closed (${reason})`);
    return cleaned;
  }
}

/**
 * 채팅 하나의 원격 브라우저 묶음. 메인 브라우저는 오케스트레이터 몫이고, 서브에이전트는
 * 저마다 browserId 를 붙여 격리된 브라우저를 받는다. 자격 증명(환경 변수 + 스튜디오
 * override)은 묶음 단위로 관리해 모든 브라우저가 같은 키로 뜬다.
 */
export class BrowserbaseFleet {
  /**
   * @param {{
   *   env?: NodeJS.ProcessEnv,
   *   log?: (message: string) => void,
   *   maxBrowsers?: number,
   *   sessionOptions?: Record<string, unknown>,
   *   createSession?: (options: Record<string, unknown>) => BrowserbaseSession,
   * }} [options]
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.log = options.log ?? (() => {});
    this.maxBrowsers = options.maxBrowsers ?? MAX_BROWSERS;
    this.sessionOptions = options.sessionOptions ?? {};
    this.createSession = options.createSession ?? ((sessionOptions) => new BrowserbaseSession(sessionOptions));
    /** @type {BrowserbaseOverride | null} */
    this.override = null;
    /** @type {Map<string, BrowserbaseSession>} */
    this.sessions = new Map();
    /** @type {BrowserbaseSession[]} */
    this.uncertainSessions = [];
    /** @type {string | null} */
    this.chatId = null;
    /** 자격 증명 set/clear마다 올라간다. 늦은 검증 결과는 버린다. */
    this.credentialRevision = 0;
  }

  beginCredentialChange() {
    this.credentialRevision += 1;
    return this.credentialRevision;
  }

  isCurrentCredentialChange(revision) {
    return revision === this.credentialRevision;
  }

  /**
   * 검증이 끝난 덮어쓰기를 적용한다. 그 사이 다른 set/clear가 있으면 현재 상태를 돌려주고
   * override는 건드리지 않는다.
   */
  async applyVerifiedOverride(override, options, revision) {
    if (!this.isCurrentCredentialChange(revision)) return this.status();
    return this.setOverride(override, options);
  }

  credentials() {
    return resolveBrowserbaseCredentials({ env: this.env, override: this.override });
  }

  /**
   * 스튜디오가 입력한 자격 증명을 앱이 도는 동안만 덮어쓴다 — 디스크에 남기지 않는다.
   * 살아 있는 브라우저는 옛 키로 떠 있으므로 바로 내린다.
   */
  async setOverride(override, { restart = true } = {}) {
    this.override = normalizeBrowserbaseOverride(override);
    // 턴이 도는 중이면(restart=false) 떠 있는 브라우저를 끊지 않는다 — 세션의 자격 증명
    // 지문이 다음 호출에서 차이를 알아채고 스스로 새 키로 다시 뜬다.
    if (restart) await this.cleanup('credentials changed');
    return this.status();
  }

  status() {
    const resolved = this.credentials();
    return {
      configured: missingFields(resolved).length === 0,
      missing: missingFields(resolved),
      keySource: resolved.apiKey.source,
      keyTail: credentialTail(resolved.apiKey.value),
      projectId: resolved.projectId.value,
      projectSource: resolved.projectId.source,
      geminiSource: resolved.geminiApiKey.source,
      browsers: [...this.sessions.entries()].map(([id, session]) => ({ id, connected: session.client !== null })),
    };
  }

  sessionFor(browserId) {
    const id = browserId ?? MAIN_BROWSER_ID;
    if (!BROWSER_ID_PATTERN.test(id)) {
      throw browserError('BROWSERBASE_INVALID_BROWSER_ID', `browserId must match ${BROWSER_ID_PATTERN}`);
    }
    let session = this.sessions.get(id);
    if (session) return session;
    if (this.sessions.size >= this.maxBrowsers) {
      const open = [...this.sessions.keys()].join(', ');
      throw browserError(
        'BROWSERBASE_BROWSER_LIMIT',
        `At most ${this.maxBrowsers} browsers can be open per chat (open: ${open}). Call browserbase_end on one you no longer need first.`,
      );
    }
    session = this.createSession({
      ...this.sessionOptions,
      env: this.env,
      log: this.log,
      label: id,
      credentials: () => this.credentials(),
    });
    this.sessions.set(id, session);
    return session;
  }

  dropSession(id, session) {
    if (this.sessions.get(id) !== session) return;
    this.sessions.delete(id);
    if (session.cleanupConfirmed === false) this.uncertainSessions.push(session);
  }

  /**
   * @param {string} chatId
   * @param {string | undefined} browserId
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   */
  async call(chatId, browserId, name, args = {}) {
    if (this.chatId && this.chatId !== chatId) await this.cleanup('chat changed');
    this.chatId = chatId;
    const id = browserId ?? MAIN_BROWSER_ID;
    const existing = this.sessions.get(id);
    const session = this.sessionFor(id);
    try {
      const result = await session.call(chatId, name, args);
      if (name === 'end' && id !== MAIN_BROWSER_ID) this.dropSession(id, session);
      return result;
    } catch (error) {
      if (!existing && id !== MAIN_BROWSER_ID && session.client === null) {
        this.dropSession(id, session);
      }
      throw error;
    }
  }

  async settleSessions(entries, reason) {
    const results = await Promise.all(entries.map(([, session]) => session.cleanup(reason)));
    for (let index = 0; index < entries.length; index += 1) {
      const [id, session] = entries[index];
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      if (results[index] === false) this.uncertainSessions.push(session);
    }
    return results.every((cleaned) => cleaned !== false);
  }

  /** 서브에이전트 브라우저만 닫는다 — 턴이 끝나면 자식들은 이미 없다. */
  async cleanupExtras(reason = 'turn ended') {
    const extras = [...this.sessions.entries()].filter(([id]) => id !== MAIN_BROWSER_ID);
    return this.settleSessions(extras, reason);
  }

  async cleanup(reason = 'cleanup') {
    const live = [...this.sessions.entries()];
    const previouslyUncertain = this.uncertainSessions;
    this.uncertainSessions = [];
    this.chatId = null;
    const liveCleaned = await this.settleSessions(live, reason);
    const retainedResults = await Promise.all(previouslyUncertain.map((session) => session.cleanup(reason)));
    for (const [index, session] of previouslyUncertain.entries()) {
      if (retainedResults[index] === false) this.uncertainSessions.push(session);
    }
    return liveCleaned && retainedResults.every((cleaned) => cleaned !== false);
  }
}
