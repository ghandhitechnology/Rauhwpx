import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

import { boundBrowserbaseResultContent } from './browserbase-result.mjs';

const SIDECAR_CLI = fileURLToPath(new URL('./browserbase-sidecar.mjs', import.meta.url));
const REQUIRED_TOOLS = Object.freeze(['start', 'end', 'navigate', 'act', 'observe', 'extract']);

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

function sidecarEnvironment(source) {
  const missing = ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'GEMINI_API_KEY']
    .filter((name) => !source[name]);
  if (missing.length > 0) {
    throw browserError(
      'BROWSERBASE_NOT_CONFIGURED',
      `Browserbase is not configured. Set ${missing.join(', ')} in the rhwp-agent environment and restart the hub.`,
    );
  }
  const env = {
    ...getDefaultEnvironment(),
    BROWSERBASE_API_KEY: String(source.BROWSERBASE_API_KEY),
    BROWSERBASE_PROJECT_ID: String(source.BROWSERBASE_PROJECT_ID),
    GEMINI_API_KEY: String(source.GEMINI_API_KEY),
  };
  if (source.BROWSERBASE_MODEL_NAME) {
    env.BROWSERBASE_MODEL_NAME = String(source.BROWSERBASE_MODEL_NAME);
  }
  if (source.ELECTRON_RUN_AS_NODE === '1') env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function resultText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Hub-owned, lazy Browserbase MCP sidecar and logical browser session. */
export class BrowserbaseSession {
  /** @param {{env?: NodeJS.ProcessEnv, startupTimeoutMs?: number, callTimeoutMs?: number, log?: (message: string) => void, execPath?: string, sidecarPath?: string, clientFactory?: () => Client, transportFactory?: (options: object) => StdioClientTransport}} [options] */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 120_000;
    this.log = options.log ?? (() => {});
    this.execPath = options.execPath ?? process.execPath;
    this.sidecarPath = options.sidecarPath ?? SIDECAR_CLI;
    this.clientFactory = options.clientFactory ?? (() => new Client({
      name: 'rhwp-agent-browserbase-proxy',
      version: '1.0.0',
    }));
    this.transportFactory = options.transportFactory ?? ((params) => new StdioClientTransport(params));
    /** @type {Client | null} */
    this.client = null;
    /** @type {StdioClientTransport | null} */
    this.transport = null;
    /** @type {Promise<Client> | null} */
    this.connecting = null;
    /** @type {string | null} */
    this.chatId = null;
    // Once any end/client/transport cleanup is unconfirmed, later no-op
    // cleanup calls must keep reporting false so the owning session root and
    // hub process-tree identity are retained through shutdown.
    this.cleanupConfirmed = true;
    // Keep the exact client/transport objects alive after an unconfirmed close.
    // The transport owns the sidecar child identity needed by bounded shutdown;
    // fail-closed reconnects keep this list bounded to one failed generation.
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
    return {
      configured: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'GEMINI_API_KEY']
        .every((name) => Boolean(this.env[name])),
      connected: this.client !== null,
    };
  }

  async ensureConnected() {
    if (!this.cleanupConfirmed) throw cleanupUncertainError();
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const env = sidecarEnvironment(this.env);
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
        this.log('Browserbase sidecar ready');
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
    const client = await this.ensureConnected();
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
        // The sidecar has an unresolved late remote session. Closing the local
        // transport restarts the process but cannot prove that remote cleanup.
        this.cleanupConfirmed = false;
        throw cleanupUncertainError(browserError('BROWSERBASE_TOOL_FAILED', message));
      }
      if (!cleaned) throw cleanupUncertainError(browserError('BROWSERBASE_TOOL_FAILED', message));
      throw browserError('BROWSERBASE_TOOL_FAILED', message);
    }
    return {
      mcpContent: boundBrowserbaseResultContent(result?.content),
    };
  }

  cleanup(reason = 'cleanup') {
    return this.enqueue(() => this.cleanupNow(reason));
  }

  async abortNow(reason) {
    const client = this.client;
    const transport = this.transport;
    const chatId = this.chatId;
    this.client = null;
    this.transport = null;
    this.chatId = null;
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
    const closeResults = await Promise.allSettled([
      withTimeout(client?.close(), 5_000, 'Browserbase client close timed out'),
      withTimeout(transport?.close(), 5_000, 'Browserbase transport close timed out'),
    ]);
    if (closeResults.some((result) => result.status === 'rejected')) confirmed = false;
    if (!confirmed) this.retainUncertainResources(client, transport, chatId);
    this.cleanupConfirmed &&= confirmed;
    this.log(`Browserbase sidecar aborted (${reason})`);
    return this.cleanupConfirmed;
  }

  async cleanupNow(reason = 'cleanup') {
    if (this.connecting) {
      try { await this.connecting; } catch {}
    }
    const client = this.client;
    const transport = this.transport;
    const chatId = this.chatId;
    this.client = null;
    this.transport = null;
    this.chatId = null;
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
    const closeResults = await Promise.allSettled([
      withTimeout(client?.close(), 5_000, 'Browserbase client close timed out'),
      withTimeout(transport?.close(), 5_000, 'Browserbase transport close timed out'),
    ]);
    if (closeResults.some((result) => result.status === 'rejected')) confirmed = false;
    if (!confirmed) this.retainUncertainResources(client, transport, chatId);
    this.cleanupConfirmed &&= confirmed;
    this.log(`Browserbase sidecar closed (${reason})`);
    return this.cleanupConfirmed;
  }
}
