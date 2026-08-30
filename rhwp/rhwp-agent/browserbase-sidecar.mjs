#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { boundBrowserbaseResultContent } from './browserbase-result.mjs';
import { BrowserbaseSidecarRuntime } from './browserbase-sidecar-runtime.mjs';

const MINIMUM_NODE = Object.freeze([22, 18, 0]);
const SHUTDOWN_TIMEOUT_MS = 12_000;

function settleWithin(promise, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), SHUTDOWN_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

export const BROWSERBASE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'start',
    description: 'Create or reuse a Browserbase session',
    inputSchema: z.object({}).strict(),
  },
  {
    name: 'end',
    description: 'Close the current Browserbase session',
    inputSchema: z.object({}).strict(),
  },
  {
    name: 'navigate',
    description: 'Navigate to a URL',
    inputSchema: z.object({ url: z.string().min(1) }).strict(),
  },
  {
    name: 'act',
    description: 'Perform an action on the page',
    inputSchema: z.object({ action: z.string().min(1) }).strict(),
  },
  {
    name: 'observe',
    description: 'Observe actionable elements on the page',
    inputSchema: z.object({ instruction: z.string().min(1) }).strict(),
  },
  {
    name: 'extract',
    description: 'Extract data from the page',
    inputSchema: z.object({ instruction: z.string().min(1).optional() }).strict(),
  },
]);

function versionTuple(version) {
  return String(version).split('.').slice(0, 3).map((part) => Number(part));
}

export function supportsStagehandNode(version = process.versions.node) {
  const actual = versionTuple(version);
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (!Number.isInteger(actual[index])) return false;
    if (actual[index] > MINIMUM_NODE[index]) return true;
    if (actual[index] < MINIMUM_NODE[index]) return false;
  }
  return true;
}

export function createBrowserbaseMcpServer({ runtime = new BrowserbaseSidecarRuntime() } = {}) {
  const server = new McpServer({
    name: 'Rauhwpx Browserbase sidecar',
    version: '1.0.0',
  });
  for (const definition of BROWSERBASE_TOOL_DEFINITIONS) {
    server.registerTool(definition.name, {
      description: definition.description,
      inputSchema: definition.inputSchema,
    }, async (args) => {
      try {
        return await runtime[definition.name](args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = typeof error?.code === 'string' ? error.code : null;
        return {
          content: boundBrowserbaseResultContent([{
            type: 'text',
            text: code ? `Error [${code}]: ${message}` : `Error: ${message}`,
          }]),
          isError: true,
        };
      }
    });
  }
  return { server, runtime };
}

export async function runBrowserbaseSidecar() {
  if (!supportsStagehandNode()) {
    throw new Error(`Browserbase tools require Node 22.18.0 or newer; found ${process.versions.node}`);
  }
  const { server, runtime } = createBrowserbaseMcpServer();
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 8 * 1024 * 1024,
  });
  let shuttingDown = null;
  const shutdown = (exitCode = null) => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      const settled = await Promise.allSettled([
        settleWithin(runtime.close(), 'Browserbase remote cleanup'),
        settleWithin(server.close(), 'Browserbase MCP server cleanup'),
      ]);
      for (const result of settled) {
        if (result.status !== 'rejected') continue;
        process.stderr.write(`[browserbase] cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`);
        if (exitCode === null || exitCode === 0) exitCode = 1;
      }
      if (exitCode !== null) process.exit(exitCode);
    })();
    return shuttingDown;
  };

  process.stdin.once('end', () => void shutdown());
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));
  process.once('uncaughtException', (error) => {
    process.stderr.write(`[browserbase] uncaught exception: ${error instanceof Error ? error.message : String(error)}\n`);
    void shutdown(1);
  });
  process.once('unhandledRejection', (error) => {
    process.stderr.write(`[browserbase] unhandled rejection: ${error instanceof Error ? error.message : String(error)}\n`);
    void shutdown(1);
  });

  await server.connect(transport);
}

let isMain = false;
try {
  isMain = Boolean(process.argv[1])
    && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMain = false;
}
if (isMain) {
  runBrowserbaseSidecar().catch((error) => {
    process.stderr.write(`[browserbase] startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
