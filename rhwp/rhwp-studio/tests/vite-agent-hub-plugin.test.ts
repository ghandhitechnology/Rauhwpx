import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { get } from 'node:http';

import {
  AGENT_HUB_ENSURE_PATH,
  isExactSameOriginRequest,
  rhwpAgentHubPlugin,
} from '../vite-plugin-agent-hub.mjs';

function request({
  url = AGENT_HUB_ENSURE_PATH,
  method = 'POST',
  origin = 'http://127.0.0.1:5173',
  host = '127.0.0.1:5173',
  encrypted = false,
} = {}) {
  return {
    url,
    method,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(host === null ? {} : { host }),
    },
    socket: { encrypted },
  };
}

function response() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: '',
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    end(value = '') {
      this.body = String(value);
    },
  };
}

function middleware() {
  const previousSkip = process.env.RHWP_SKIP_AGENT_HUB;
  const previousExternal = process.env.VITE_RHWP_AGENT_URL;
  process.env.RHWP_SKIP_AGENT_HUB = '1';
  delete process.env.VITE_RHWP_AGENT_URL;
  try {
    let installed = null;
    rhwpAgentHubPlugin().configureServer({
      middlewares: {
        use(handler) {
          installed = handler;
        },
      },
      httpServer: null,
    });
    assert.equal(typeof installed, 'function');
    return installed;
  } finally {
    if (previousSkip === undefined) delete process.env.RHWP_SKIP_AGENT_HUB;
    else process.env.RHWP_SKIP_AGENT_HUB = previousSkip;
    if (previousExternal === undefined) delete process.env.VITE_RHWP_AGENT_URL;
    else process.env.VITE_RHWP_AGENT_URL = previousExternal;
  }
}

test('capability mint requests require the exact Host transport origin', () => {
  assert.equal(isExactSameOriginRequest(request()), true);
  assert.equal(isExactSameOriginRequest(request({
    origin: 'https://127.0.0.1:5173',
    encrypted: true,
  })), true);
  assert.equal(isExactSameOriginRequest(request({ origin: 'http://evil.example' })), false);
  assert.equal(isExactSameOriginRequest(request({ origin: null })), false);
  assert.equal(isExactSameOriginRequest(request({ host: null })), false);
  assert.equal(isExactSameOriginRequest(request({ origin: 'https://127.0.0.1:5173' })), false);
  assert.equal(isExactSameOriginRequest(request({ origin: 'http://127.0.0.1:5173/' })), false);
});

test('malformed request targets return 400 instead of escaping the async middleware', async () => {
  const handle = middleware();
  const res = response();
  let nextCalls = 0;

  await handle(request({ url: '//[' }), res, () => { nextCalls += 1; });

  assert.equal(res.statusCode, 400);
  assert.equal(nextCalls, 0);
  assert.match(res.body, /Malformed request target/);
});

test('capability mint route rejects non-POST and cross-origin requests before hub work', async () => {
  const handle = middleware();

  const getResponse = response();
  await handle(request({ method: 'GET' }), getResponse, () => assert.fail('route must not fall through'));
  assert.equal(getResponse.statusCode, 405);
  assert.equal(getResponse.headers.get('allow'), 'POST');

  const crossOriginResponse = response();
  await handle(
    request({ url: `${AGENT_HUB_ENSURE_PATH}?sessionId=session-a`, origin: 'http://evil.example' }),
    crossOriginResponse,
    () => assert.fail('route must not fall through'),
  );
  assert.equal(crossOriginResponse.statusCode, 403);

  const invalidSessionResponse = response();
  await handle(
    request({ url: `${AGENT_HUB_ENSURE_PATH}?sessionId=../escape` }),
    invalidSessionResponse,
    () => assert.fail('route must not fall through'),
  );
  assert.equal(invalidSessionResponse.statusCode, 400);
});

test('unrelated valid requests continue through the Vite middleware chain', async () => {
  const handle = middleware();
  const res = response();
  let nextCalls = 0;

  await handle(request({ url: '/assets/app.js', method: 'GET' }), res, () => { nextCalls += 1; });

  assert.equal(nextCalls, 1);
  assert.equal(res.statusCode, 0);
});


test('owned Vite hub starts without Electron and retains production request checks', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rhwp-vite-hub-test-'));
  const overrides = {
    RHWP_SKIP_AGENT_HUB: undefined,
    VITE_RHWP_AGENT_URL: undefined,
    RHWP_AGENT_PORT: '0',
    RHWP_PI_DIR: join(root, 'pi'),
    RHWP_RAU_DIR: join(root, 'rau'),
    RHWP_WRITING_STYLE_DIR: join(root, 'writing-style'),
    RHWP_AGENT_INSTRUCTIONS_DIR: join(root, 'instructions'),
    RHWP_TEMPLATES_DIR: join(root, 'templates'),
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  let server;
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const studioRoot = fileURLToPath(new URL('../', import.meta.url));
    server = await createServer({
      root: studioRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [rhwpAgentHubPlugin(studioRoot)],
      server: { host: '127.0.0.1', port: 0, hmr: false },
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}${AGENT_HUB_ENSURE_PATH}?sessionId=owned-hub-test`, {
      method: 'POST', headers: { origin }, signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ready, true, body.error);
    assert.ok(body.hubToken && body.referenceToken && body.templateToken);
    const hub = body.hubUrl.replace('ws:', 'http:');
    const unauthenticated = await fetch(`${hub}/healthz`);
    assert.equal(unauthenticated.status, 401);
    // fetch normalizes Host, so use HTTP directly to exercise DNS-rebinding protection.
    const reboundStatus = await new Promise<number>((resolve, reject) => {
      get(`${hub}/healthz`, { headers: { host: 'evil.example' } }, response => {
        response.resume();
        resolve(response.statusCode!);
      }).on('error', reject);
    });
    assert.equal(reboundStatus, 403);
  } finally {
    await server?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
