import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const SIDECAR_CLI = require.resolve('@browserbasehq/mcp/cli.js');
const REQUIRED_TOOLS = Object.freeze(['start', 'end', 'navigate', 'act', 'observe', 'extract']);
const MAX_RESULT_TEXT_BYTES = 50 * 1024;

function browserError(code, message) {
  const error = new Error(message);
  error.code = code;
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
  return {
    ...getDefaultEnvironment(),
    BROWSERBASE_API_KEY: String(source.BROWSERBASE_API_KEY),
    BROWSERBASE_PROJECT_ID: String(source.BROWSERBASE_PROJECT_ID),
    GEMINI_API_KEY: String(source.GEMINI_API_KEY),
  };
}

function boundResultContent(content) {
  let remaining = MAX_RESULT_TEXT_BYTES;
  let truncated = false;
  const bounded = [];
  for (const block of content ?? []) {
    if (block?.type !== 'text') {
      bounded.push(block);
      continue;
    }
    const bytes = Buffer.from(String(block.text ?? ''), 'utf8');
    if (bytes.length <= remaining) {
      bounded.push(block);
      remaining -= bytes.length;
      continue;
    }
    if (remaining > 0) {
      bounded.push({ ...block, text: bytes.subarray(0, remaining).toString('utf8') });
      remaining = 0;
    }
    truncated = true;
  }
  if (truncated) {
    bounded.push({ type: 'text', text: `Browserbase text output truncated at ${MAX_RESULT_TEXT_BYTES} bytes.` });
  }
  return bounded;
}

function resultText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Hub-owned, lazy Browserbase MCP sidecar and logical browser session. */
export class BrowserbaseSession {
  /** @param {{env?: NodeJS.ProcessEnv, startupTimeoutMs?: number, callTimeoutMs?: number, log?: (message: string) => void}} [options] */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 120_000;
    this.log = options.log ?? (() => {});
    /** @type {Client | null} */
    this.client = null;
    /** @type {StdioClientTransport | null} */
    this.transport = null;
    /** @type {Promise<Client> | null} */
    this.connecting = null;
    /** @type {string | null} */
    this.chatId = null;
    this.queue = Promise.resolve();
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
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const env = sidecarEnvironment(this.env);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--max-old-space-size=512', SIDECAR_CLI],
        env,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message) this.log(`[browserbase] ${message}`);
      });
      const client = new Client({ name: 'rhwp-agent-browserbase-proxy', version: '1.0.0' });
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
        try { await client.close(); } catch {}
        try { await transport.close(); } catch {}
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
    if (this.chatId && this.chatId !== chatId) await this.cleanupNow('chat changed');
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
        await this.abortNow(`tool timeout: ${name}`);
        throw browserError(
          'BROWSERBASE_TIMEOUT',
          `${error.message}. The remote action may already have applied; start a fresh session and observe state before retrying.`,
        );
      }
      if (error?.code) throw error;
      throw browserError('BROWSERBASE_TOOL_FAILED', String(error?.message ?? error));
    }
    if (result?.isError) {
      throw browserError('BROWSERBASE_TOOL_FAILED', resultText(result) || `Browserbase ${name} failed`);
    }
    return {
      mcpContent: boundResultContent(result?.content),
      ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    };
  }

  cleanup(reason = 'cleanup') {
    return this.enqueue(() => this.cleanupNow(reason));
  }

  async abortNow(reason) {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.chatId = null;
    try { await withTimeout(transport?.close(), 5_000, 'Browserbase transport close timed out'); } catch {}
    try { await withTimeout(client?.close(), 5_000, 'Browserbase client close timed out'); } catch {}
    this.log(`Browserbase sidecar aborted (${reason})`);
  }

  async cleanupNow(reason = 'cleanup') {
    if (this.connecting) {
      try { await this.connecting; } catch {}
    }
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.chatId = null;
    if (!client && !transport) return;
    if (client) {
      try {
        await withTimeout(client.callTool({ name: 'end', arguments: {} }), 10_000, 'Browserbase end timed out');
      } catch (error) {
        this.log(`Browserbase end during ${reason} failed: ${error?.message ?? error}`);
      }
      try { await client.close(); } catch {}
    }
    try { await transport?.close(); } catch {}
    this.log(`Browserbase sidecar closed (${reason})`);
  }
}
