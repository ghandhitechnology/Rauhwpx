import assert from 'node:assert/strict';
import test from 'node:test';

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
