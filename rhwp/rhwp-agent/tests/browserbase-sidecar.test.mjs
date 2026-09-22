import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  BrowserbaseSidecarRuntime,
  compatibleStagehandResult,
  createStagehandSession,
  requireBrowserbaseCredentials,
} from '../browserbase-sidecar-runtime.mjs';
import {
  BROWSERBASE_TOOL_DEFINITIONS,
  supportsStagehandNode,
} from '../browserbase-sidecar.mjs';
import {
  MAX_BROWSERBASE_RESULT_TEXT_BYTES,
  browserbaseJsonResult,
} from '../browserbase-result.mjs';
import { cleanupBrowserbaseLiveCycle } from './browserbase-live-smoke.mjs';

function parsed(result) {
  return JSON.parse(result.content[0].text);
}

function fakeSession(events = []) {
  const page = {
    async goto(url, options) {
      events.push(['goto', url, options]);
    },
    async snapshot(options) {
      events.push(['snapshot', options]);
      return { formattedTree: 'page tree', xpathMap: {}, urlMap: {} };
    },
  };
  const context = {
    async activePage() {
      events.push(['activePage']);
      return page;
    },
    async newPage() {
      events.push(['newPage']);
      return page;
    },
  };
  return {
    browser: {
      sessionId: 'bb-session-1',
      context,
      async close() { events.push(['browser.close']); },
    },
    stagehand: {
      async act(action) {
        events.push(['act', action]);
        return { data: { success: true }, metadata: { actionId: 'a1' } };
      },
      async observe(instruction) {
        events.push(['observe', instruction]);
        return { data: [{ selector: '#submit', description: 'Submit' }] };
      },
      async extract(instruction) {
        events.push(['extract', instruction]);
        return { data: { extraction: 'value' } };
      },
      async close() { events.push(['stagehand.close']); },
    },
  };
}

test('sidecar keeps the six existing names and input schemas', () => {
  assert.deepEqual(
    BROWSERBASE_TOOL_DEFINITIONS.map((tool) => tool.name),
    ['start', 'end', 'navigate', 'act', 'observe', 'extract'],
  );
  const schemas = Object.fromEntries(BROWSERBASE_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.inputSchema]));
  assert.equal(schemas.start.safeParse({}).success, true);
  assert.equal(schemas.navigate.safeParse({ url: 'https://example.test' }).success, true);
  assert.equal(schemas.act.safeParse({ action: 'click submit' }).success, true);
  assert.equal(schemas.observe.safeParse({ instruction: 'find buttons' }).success, true);
  assert.equal(schemas.extract.safeParse({}).success, true);
  assert.equal(schemas.navigate.safeParse({}).success, false);
  assert.equal(schemas.start.safeParse({ unexpected: true }).success, false);
});

test('sidecar preserves result envelopes and uses a snapshot for instruction-free extraction', async () => {
  const events = [];
  let creates = 0;
  const runtime = new BrowserbaseSidecarRuntime({
    createSession: async () => {
      creates += 1;
      return fakeSession(events);
    },
  });

  assert.deepEqual(parsed(await runtime.start()), {
    success: true,
    data: { sessionId: 'bb-session-1' },
  });
  assert.deepEqual(parsed(await runtime.start()), {
    success: true,
    data: { sessionId: 'bb-session-1' },
  });
  assert.equal(creates, 1);
  assert.deepEqual(parsed(await runtime.navigate({ url: 'https://example.test' })), {
    success: true,
    data: { url: 'https://example.test' },
  });
  assert.deepEqual(parsed(await runtime.act({ action: 'submit' })).data, { success: true });
  assert.deepEqual(parsed(await runtime.observe({ instruction: 'buttons' })).data, [
    { selector: '#submit', description: 'Submit' },
  ]);
  assert.deepEqual(parsed(await runtime.extract({ instruction: 'title' })).data, {
    extraction: 'value',
  });
  assert.deepEqual(parsed(await runtime.extract()).data, {
    formattedTree: 'page tree',
    xpathMap: {},
    urlMap: {},
  });
  assert.deepEqual(parsed(await runtime.end()), { success: true });
  assert.deepEqual(events.slice(-2), [['stagehand.close'], ['browser.close']]);
  assert.deepEqual(events.find((event) => event[0] === 'goto'), [
    'goto',
    'https://example.test',
    { waitUntil: 'domcontentloaded' },
  ]);
  assert.ok(events.some((event) => event[0] === 'snapshot' && event[1].includeIframes));
});

test('a failed operation poisons the remote session and closes Stagehand before Browserbase', async () => {
  const events = [];
  const session = fakeSession(events);
  session.stagehand.act = async () => {
    events.push(['act']);
    throw new Error('action failed');
  };
  const runtime = new BrowserbaseSidecarRuntime({ createSession: async () => session });

  await assert.rejects(
    runtime.act({ action: 'submit' }),
    /Failed to perform action: action failed/,
  );
  assert.deepEqual(events.slice(-2), [['stagehand.close'], ['browser.close']]);
  assert.equal(runtime.session, null);
});

test('concurrent shutdown paths share one bounded cleanup that starts every closer', async () => {
  const events = [];
  const session = fakeSession(events);
  let release;
  session.stagehand.close = async () => {
    events.push(['stagehand.close']);
    await new Promise((resolve) => { release = resolve; });
  };
  const runtime = new BrowserbaseSidecarRuntime({ createSession: async () => session });
  await runtime.start();

  const first = runtime.close();
  const second = runtime.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event[0] === 'stagehand.close'));
  assert.ok(events.some((event) => event[0] === 'browser.close'));
  release();
  await Promise.all([first, second]);
  assert.equal(events.filter((event) => event[0] === 'stagehand.close').length, 1);
  assert.equal(events.filter((event) => event[0] === 'browser.close').length, 1);
});

test('sidecar caps oversized UTF-8 results before they cross stdio', async () => {
  const session = fakeSession();
  session.stagehand.extract = async () => ({
    data: { extraction: '한'.repeat(30_000) },
  });
  const runtime = new BrowserbaseSidecarRuntime({ createSession: async () => session });

  const result = await runtime.extract({ instruction: 'everything' });
  const text = result.content.map((block) => block.text ?? '').join('');
  assert.ok(Buffer.byteLength(text, 'utf8') <= 50 * 1024);
  assert.doesNotMatch(text, /�/);
  assert.match(text, /truncated at 51200 bytes/);
  await runtime.close();
});

test('result traversal budgets cycles, depth, entries, and strings before JSON serialization', () => {
  const root = { huge: '\u0000'.repeat(100_000) };
  root.self = root;
  let cursor = root;
  for (let depth = 0; depth < 100; depth += 1) {
    cursor.child = { depth };
    cursor = cursor.child;
  }
  root.toJSON = () => { throw new Error('untrusted toJSON must not run'); };

  const result = browserbaseJsonResult(root);
  const text = result.content.map((block) => block.text ?? '').join('');
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_BROWSERBASE_RESULT_TEXT_BYTES);
  assert.doesNotThrow(() => JSON.parse(text));
  assert.match(text, /truncated at 51200 bytes|max depth|circular/);
});

test('cache compatibility metadata does not spread an unbounded Stagehand object', () => {
  const data = {};
  let getterReads = 0;
  for (let index = 0; index < 10_000; index += 1) {
    Object.defineProperty(data, `field${index}`, {
      enumerable: true,
      get() {
        getterReads += 1;
        return index;
      },
    });
  }

  const compatible = compatibleStagehandResult({
    data,
    metadata: { cache: { status: 'HIT' } },
  });
  assert.equal(compatible.cacheStatus, 'HIT');
  assert.ok(getterReads <= 2_048, `read ${getterReads} remote getters`);
  assert.ok(Buffer.byteLength(JSON.stringify(compatible), 'utf8') <= MAX_BROWSERBASE_RESULT_TEXT_BYTES);
});

test('session creation times out and releases a session that arrives late', async () => {
  const events = [];
  let release;
  const runtime = new BrowserbaseSidecarRuntime({
    createTimeoutMs: 5,
    cleanupTimeoutMs: 20,
    createSession: () => new Promise((resolve) => { release = () => resolve(fakeSession(events)); }),
  });
  await assert.rejects(runtime.start(), {
    code: 'BROWSERBASE_CLEANUP_UNCERTAIN',
    processCleanupUncertain: true,
  });
  await assert.rejects(runtime.start(), { code: 'BROWSERBASE_CLEANUP_UNCERTAIN' });
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(events.some((event) => event[0] === 'stagehand.close'));
  assert.ok(events.some((event) => event[0] === 'browser.close'));
});

test('a browser that launches after timeout retains its rejected cleanup proof', async () => {
  let releaseLaunch;
  let browserCloseCalls = 0;
  const launch = new Promise((resolve) => { releaseLaunch = resolve; });
  let failure;
  try {
    await createStagehandSession({
      env: {
        BROWSERBASE_API_KEY: 'browser-key',
        BROWSERBASE_PROJECT_ID: 'project-id',
        GEMINI_API_KEY: 'model-key',
      },
      createTimeoutMs: 5,
      cleanupTimeoutMs: 5,
      launchBrowser: () => launch,
      createStagehand: () => { throw new Error('Stagehand must not start'); },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'BROWSERBASE_CLEANUP_UNCERTAIN');
  releaseLaunch({
    async close() {
      browserCloseCalls += 1;
      throw new Error('late browser close rejected');
    },
  });
  assert.equal(await failure.lateCleanup, false);
  assert.equal(browserCloseCalls, 1);
});

test('a Stagehand that resolves after timeout retains a hanging cleanup proof', async () => {
  let releaseStagehand;
  let browserCloseCalls = 0;
  let stagehandCloseCalls = 0;
  const stagehandCreation = new Promise((resolve) => { releaseStagehand = resolve; });
  let failure;
  try {
    await createStagehandSession({
      env: {
        BROWSERBASE_API_KEY: 'browser-key',
        BROWSERBASE_PROJECT_ID: 'project-id',
        GEMINI_API_KEY: 'model-key',
      },
      createTimeoutMs: 5,
      cleanupTimeoutMs: 5,
      launchBrowser: async () => ({
        async close() { browserCloseCalls += 1; },
      }),
      createStagehand: () => stagehandCreation,
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'BROWSERBASE_CLEANUP_UNCERTAIN');
  assert.equal(browserCloseCalls, 1, 'the known browser is closed before the error returns');
  releaseStagehand({
    close() {
      stagehandCloseCalls += 1;
      return new Promise(() => {});
    },
  });
  assert.equal(await failure.lateCleanup, false);
  assert.equal(stagehandCloseCalls, 1);
});

test('cleanup deadlines settle even when both remote closers hang', async () => {
  const session = fakeSession();
  session.stagehand.close = () => new Promise(() => {});
  session.browser.close = () => new Promise(() => {});
  const runtime = new BrowserbaseSidecarRuntime({
    createSession: async () => session,
    cleanupTimeoutMs: 5,
  });
  await runtime.start();
  await assert.rejects(runtime.end(), /cleanup both failed|cleanup timed out/);
  assert.equal(runtime.session, null);
});

test('a Browserbase deadline settles when it is the idle process\'s only active handle', () => {
  const runtimeUrl = new URL('../browserbase-sidecar-runtime.mjs', import.meta.url).href;
  const script = `
    const { BrowserbaseSidecarRuntime } = await import(${JSON.stringify(runtimeUrl)});
    const runtime = new BrowserbaseSidecarRuntime({
      createTimeoutMs: 5,
      cleanupTimeoutMs: 5,
      createSession: () => new Promise(() => {}),
    });
    try {
      await runtime.start();
    } catch (error) {
      process.stdout.write(String(error?.code));
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'BROWSERBASE_CLEANUP_UNCERTAIN');
});

test('sidecar validates credentials and the Stagehand Node floor', () => {
  assert.throws(
    () => requireBrowserbaseCredentials({}),
    /BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, GEMINI_API_KEY/,
  );
  assert.deepEqual(requireBrowserbaseCredentials({
    BROWSERBASE_API_KEY: 'browser-key',
    BROWSERBASE_PROJECT_ID: 'project-id',
    GEMINI_API_KEY: 'model-key',
  }), {
    apiKey: 'browser-key',
    projectId: 'project-id',
    modelApiKey: 'model-key',
    modelName: 'google/gemini-3.5-flash',
  });
  assert.equal(supportsStagehandNode('22.17.9'), false);
  assert.equal(supportsStagehandNode('22.18.0'), true);
  assert.equal(supportsStagehandNode('22.18.0-rc.1'), false);
  assert.equal(supportsStagehandNode('22.18.0-rc.1+build.5'), false);
  assert.equal(supportsStagehandNode('22.18.0+build'), true);
  assert.equal(supportsStagehandNode('22.17.9-rc.1'), false);
  assert.equal(supportsStagehandNode('23.0.0-rc.1'), true);
  assert.equal(supportsStagehandNode('24.0.0'), true);
  assert.equal(supportsStagehandNode('22.18.0.1'), false);
  assert.equal(supportsStagehandNode('022.18.0'), false);
  assert.equal(supportsStagehandNode('22.18.0-01'), false);
  assert.equal(supportsStagehandNode('22.18.0+'), false);
  assert.equal(supportsStagehandNode(`22.${'9'.repeat(256)}.0`), false);
  assert.equal(supportsStagehandNode('not-a-version'), false);
});

test('live smoke cleanup preserves and annotates its primary failure', async () => {
  const primary = new Error('navigate failed');
  const reports = [];
  const cleaned = await cleanupBrowserbaseLiveCycle({
    cleanup: async () => false,
  }, 2, primary, (message) => reports.push(message));

  assert.equal(cleaned, false);
  assert.equal(primary.message, 'navigate failed');
  assert.equal(primary.processCleanupUncertain, true);
  assert.equal(primary.cleanupError?.code, 'BROWSERBASE_CLEANUP_UNCERTAIN');
  assert.match(reports.join(''), /preserving the primary cycle error/);
});

test('live smoke cleanup failure is primary when the cycle otherwise passed', async () => {
  await assert.rejects(
    cleanupBrowserbaseLiveCycle({ cleanup: async () => false }, 3),
    {
      code: 'BROWSERBASE_CLEANUP_UNCERTAIN',
      processCleanupUncertain: true,
    },
  );
});
