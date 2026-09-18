import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { HUB_CAPABILITY_AUDIENCES, issueScopedHubToken } from '../hub-session-registry.mjs';

test('MCP user questions have no ordinary 180 second timeout', () => {
  const source = readFileSync(new URL('../mcp-stdio.mjs', import.meta.url), 'utf8');
  assert.match(source, /tool === 'ask_user_question'\s*\? null\s*:\s*setTimeout/);
});

test('MCP client caps provider frames at 8 MiB', () => {
  const source = readFileSync(new URL('../mcp-stdio.mjs', import.meta.url), 'utf8');
  assert.match(source, /const MAX_PROVIDER_FRAME_BYTES = 8 \* 1024 \* 1024/);
  assert.match(source, /new WebSocket\(url, \{ maxPayload: MAX_PROVIDER_FRAME_BYTES \}\)/);
  assert.match(source, /const MAX_INFLIGHT_CALLS = 64/);
  assert.match(source, /inflight\.size >= MAX_INFLIGHT_CALLS/);
});

test('MCP client redacts URL credentials and capabilities from logs', () => {
  const source = readFileSync(new URL('../mcp-stdio.mjs', import.meta.url), 'utf8');
  assert.match(source, /const LOG_WS_ENDPOINT = safeHubEndpoint\(WS_URL\)/);
  assert.doesNotMatch(source, /hub=\$\{WS_URL\}/);
  assert.doesNotMatch(source, /connected to hub at \$\{WS_URL\}/);
});

test('mcp stdio recovers its scoped session and sends protocol v5 query identity', { timeout: 15_000 }, async (t) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address();
  assert.equal(typeof address, 'object');

  const sessionId = 'stdio-window';
  const scopedToken = issueScopedHubToken('master-token', sessionId, {
    generation: 7,
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
  });
  const requestUrl = new Promise((resolve) => {
    wss.once('connection', (_socket, request) => resolve(request.url));
  });
  const child = spawn(process.execPath, ['mcp-stdio.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RHWP_AGENT_TOKEN: scopedToken,
      RHWP_WS_URL: `ws://127.0.0.1:${address.port}/mcp?leak=query-secret`,
      RHWP_AGENT_NAME: 'codex',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    await new Promise((resolve) => wss.close(resolve));
  });

  const rawUrl = await requestUrl;
  const url = new URL(rawUrl, `ws://127.0.0.1:${address.port}`);
  assert.equal(url.pathname, '/mcp');
  assert.equal(url.searchParams.get('token'), scopedToken);
  assert.equal(url.searchParams.get('sessionId'), sessionId);
  assert.equal(url.searchParams.get('agent'), 'codex');
  assert.match(stderr, /session=stdio-window/);
  assert.doesNotMatch(stderr, /query-secret|token=/);
});
