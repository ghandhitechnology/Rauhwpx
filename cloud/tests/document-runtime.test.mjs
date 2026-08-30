import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runSession } from '../document-runtime/run.mjs';
import { createSessionDisplayMode } from '../document-runtime/session-display.mjs';
import {
  chromiumLaunchOptions,
  launchChromium,
  safeHubBaseEnvironment,
  seedCursorRuntime,
  uploadRequiredReferences,
} from '../document-runtime/studio-harness.mjs';
import {
  composeTurnPrompt,
  readTimeline,
  TIMELINE_SCHEMA,
  TIMELINE_VERSION,
  TimelineRecorder,
} from '../document-runtime/timeline.mjs';

function portableTimeline(provider = 'codex') {
  return {
    schema: TIMELINE_SCHEMA,
    version: TIMELINE_VERSION,
    exportedAt: '2026-08-23T00:00:00.000Z',
    thread: {
      id: 'thread-cloud-test',
      title: 'Edit the document',
      titleRequested: false,
      createdAt: 1,
      updatedAt: 1,
      agent: provider,
      model: provider === 'pi' ? 'openai/gpt-5.4' : provider === 'claude' ? 'sonnet' : provider === 'grok' ? 'grok-4.6' : provider === 'cursor' ? 'auto' : 'gpt-5.6-sol',
      effort: provider === 'cursor' ? '' : 'high',
      workflow: 'direct',
      docKey: 'source.hwp',
      documentId: 'document-cloud-test',
      activeTemplateId: null,
      messages: [{ role: 'user', text: 'Edit the document' }],
    },
  };
}

function boundaryReceipt(boundary) {
  return {
    ...boundary,
    committedAt: '2026-08-23T00:00:00.000Z',
    checkpoint: { ...boundary.checkpoint, name: 'checkpoint.hwp', downloadPath: '/checkpoint' },
    timeline: { ...boundary.timeline, downloadPath: '/timeline' },
  };
}

test('portable timeline remains valid and records tools, tasks, text, and cloud delivery', () => {
  let now = 100;
  const timeline = readTimeline(portableTimeline('codex'), {
    sessionId: 'session-test', provider: 'codex', resources: [],
  }, () => ++now);
  const recorder = new TimelineRecorder(timeline, { now: () => ++now });
  recorder.acceptUserMessage('Edit the document', { initial: true });
  recorder.consume({ type: 'agent', event: { type: 'turn-start', agent: 'codex' } });
  recorder.consume({ type: 'agent', event: {
    type: 'tool-call', agent: 'codex', callId: 'call-1', tool: 'replace_range', argsJson: '{"text":"updated"}',
  } });
  recorder.consume({ type: 'agent', event: {
    type: 'tool-result', agent: 'codex', callId: 'call-1', ok: true, resultPreview: '{"revision":2}',
  } });
  recorder.consume({ type: 'agent', event: { type: 'text-delta', agent: 'codex', text: 'Updated the title.' } });
  const outcome = recorder.consume({ type: 'agent', event: { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' } });
  const exported = recorder.export();
  assert.equal(outcome.success, true);
  assert.equal(exported.schema, TIMELINE_SCHEMA);
  assert.equal(exported.version, 1);
  assert.equal(exported.thread.messages[0].delivery, 'accepted-cloud');
  assert.equal(exported.thread.messages.at(-2).kind, 'activity');
  assert.equal(exported.thread.messages.at(-2).tools[0].status, 'completed');
  assert.equal(exported.thread.messages.at(-1).text, 'Updated the title.');
});

test('all five providers retain their selected model and Pi fails closed without one', () => {
  for (const provider of ['claude', 'codex', 'pi', 'grok', 'cursor']) {
    const parsed = readTimeline(portableTimeline(provider), { sessionId: 's', provider, resources: [] });
    assert.equal(parsed.thread.agent, provider);
    assert.ok(parsed.thread.model);
  }
  const broken = portableTimeline('pi');
  broken.thread.model = '';
  assert.throws(() => readTimeline(broken, { sessionId: 's', provider: 'pi', resources: [] }), {
    code: 'MODEL_REQUIRED',
  });
  const authoritative = readTimeline(portableTimeline('codex'), {
    sessionId: 's',
    provider: 'codex',
    resources: [],
    executionConfig: {
      model: 'gpt-5.6-terra', effort: 'medium', workflow: 'plan', permissionProfile: 'unrestricted',
    },
  });
  assert.equal(authoritative.thread.model, 'gpt-5.6-terra');
  assert.equal(authoritative.thread.effort, 'medium');
  assert.equal(authoritative.thread.workflow, 'plan');
});

test('reference paths are explicit untrusted data in the provider prompt', () => {
  const prompt = composeTurnPrompt('Replace the heading', [{
    name: 'policy.pdf', mimeType: 'application/pdf', filename: '/workspace/input/reference-policy.pdf',
  }]);
  assert.match(prompt, /untrusted-reference-data/);
  assert.match(prompt, /\/workspace\/input\/reference-policy\.pdf/);
  assert.match(prompt, /Perform every document mutation through the Rauhwpx MCP tools/);
});

test('agent hub environment cannot inherit worker control-plane credentials', () => {
  const filtered = safeHubBaseEnvironment({
    LANG: 'C.UTF-8',
    HTTPS_PROXY: 'http://proxy.internal',
    RAUHWpx_WORKER_TOKEN: 'worker-secret',
    RAUHWpx_CONTROL_SOCKET: '/run/rauhwpx/control.sock',
    RAUHWpx_SESSION_ID: 'session-secret',
    NODE_OPTIONS: '--require=/tmp/inject.cjs',
  });
  assert.deepEqual(filtered, { LANG: 'C.UTF-8', HTTPS_PROXY: 'http://proxy.internal' });
  assert.equal(filtered.RAUHWpx_WORKER_TOKEN, undefined);
  assert.equal(filtered.RAUHWpx_CONTROL_SOCKET, undefined);
});

test('Chromium uses the live Xvfb display and geometry, with a headless no-display fallback', () => {
  const headed = chromiumLaunchOptions({
    chromiumPath: '/usr/bin/chromium',
    displayEnv: {
      DISPLAY: ':77',
      XAUTHORITY: '/workspace/home/.Xauthority',
      RAUHWpx_SESSION_DISPLAY: 'ready',
    },
    displayGeometry: { width: 1440, height: 900 },
    environment: {
      LANG: 'C.UTF-8',
      RAUHWpx_WORKER_TOKEN: 'worker-secret',
      RAUHWpx_CONTROL_SOCKET: '/run/rauhwpx/control.sock',
      CONTROL_PLANE_SECRET: 'secret',
    },
    pipe: true,
  });
  assert.equal(headed.headless, false);
  assert.equal(headed.pipe, true);
  assert.equal(headed.env.LANG, 'C.UTF-8');
  assert.equal(headed.env.DISPLAY, ':77');
  assert.equal(headed.env.XAUTHORITY, '/workspace/home/.Xauthority');
  assert.equal(headed.env.RAUHWpx_WORKER_TOKEN, undefined);
  assert.equal(headed.env.RAUHWpx_CONTROL_SOCKET, undefined);
  assert.equal(headed.env.CONTROL_PLANE_SECRET, undefined);
  assert.deepEqual(headed.defaultViewport, { width: 1440, height: 900, deviceScaleFactor: 1 });
  for (const argument of [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--ozone-platform=x11',
    '--window-position=0,0',
    '--window-size=1440,900',
  ]) assert.ok(headed.args.includes(argument), argument);

  const fallback = chromiumLaunchOptions({
    chromiumPath: '/usr/bin/chromium',
    displayEnv: {
      DISPLAY: ':99',
      XAUTHORITY: '/stale/authority',
      RAUHWpx_SESSION_DISPLAY: 'error',
    },
    displayGeometry: { width: 1024, height: 768 },
    environment: {
      DISPLAY: ':99',
      XAUTHORITY: '/inherited/authority',
      RAUHWpx_WORKER_TOKEN: 'worker-secret',
      RAUHWpx_CONTROL_SOCKET: '/run/rauhwpx/control.sock',
    },
    pipe: false,
  });
  assert.equal(fallback.headless, true);
  assert.deepEqual(fallback.env, {});
  assert.deepEqual(fallback.defaultViewport, { width: 1024, height: 768, deviceScaleFactor: 1 });
  assert.ok(!fallback.args.some((argument) => argument.startsWith('--ozone-platform=')));
  assert.ok(!fallback.args.some((argument) => argument.startsWith('--window-size=')));
});

test('Chromium transport retry stays headed for an active display session', async () => {
  const attempts = [];
  const browser = {};
  const result = await launchChromium({
    launch: async (options) => {
      attempts.push(options);
      if (attempts.length === 1) throw new Error('pipe transport failed');
      return browser;
    },
  }, {
    chromiumPath: '/usr/bin/chromium',
    displayEnv: {
      DISPLAY: ':78',
      XAUTHORITY: '/workspace/home/.Xauthority',
      RAUHWpx_SESSION_DISPLAY: 'ready',
    },
    displayGeometry: { width: 1280, height: 800 },
  });
  assert.equal(result, browser);
  assert.deepEqual(attempts.map(({ headless, pipe }) => ({ headless, pipe })), [
    { headless: false, pipe: true },
    { headless: false, pipe: false },
  ]);
  assert.ok(attempts.every(({ env }) => env.DISPLAY === ':78'));
});

test('Session display mode is fixed before harness launch', () => {
  let status = 'error';
  const display = {
    get status() { return status; },
    get environment() {
      return status === 'ready'
        ? { DISPLAY: ':79', XAUTHORITY: '/workspace/home/.Xauthority', RAUHWpx_SESSION_DISPLAY: 'ready' }
        : null;
    },
    snapshot: () => ({ status, display: status === 'ready' ? ':79' : null, width: 1280, height: 800 }),
  };
  const mode = createSessionDisplayMode(display);
  status = 'ready';
  assert.equal(mode.kind, 'headless');
  assert.equal(mode.environment, null);
  assert.deepEqual(mode.geometry, { width: 1280, height: 800 });
});

test('required reference indexing fails closed after publishing a bounded diagnostic', async () => {
  const events = [];
  await assert.rejects(uploadRequiredReferences({
    page: { evaluate: async () => { throw new Error('extractor unavailable'); } },
    bootstrap: 'b'.repeat(43),
    origin: 'http://127.0.0.1:7700',
    references: [{ name: 'required-policy.hwp', mimeType: 'application/x-hwp' }],
    scopeId: 'thread-reference',
    onEvent: async (event) => events.push(event),
  }), { code: 'REFERENCE_INDEX_FAILED' });
  assert.deepEqual(events, [{
    type: 'reference.index-failed',
    name: 'required-policy.hwp',
    message: 'extractor unavailable',
  }]);
});

test('Cursor runtime resolves the verified relative symlink and preserves adjacent runtime files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cursor-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binDirectory = path.join(root, 'home', '.local', 'bin');
  const versionDirectory = path.join(root, 'home', '.local', 'share', 'cursor-agent', 'versions', '2026.08.11-e8db854');
  await fs.mkdir(binDirectory, { recursive: true });
  await fs.mkdir(path.join(versionDirectory, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(versionDirectory, 'cursor-agent'), '#!/bin/sh\n', { mode: 0o700 });
  await fs.writeFile(path.join(versionDirectory, 'runtime', 'library.bin'), 'runtime');
  await fs.symlink(path.relative(binDirectory, path.join(versionDirectory, 'cursor-agent')), path.join(binDirectory, 'cursor-agent'));
  const seeded = await seedCursorRuntime(root);
  assert.equal(await fs.realpath(seeded.cursorBin), path.join(
    await fs.realpath(root),
    'provider-cli-state',
    'cursor-home',
    '.local',
    'share',
    'cursor-agent',
    'versions',
    '2026.08.11-e8db854',
    'cursor-agent',
  ));
  assert.equal(await fs.readFile(path.join(
    root,
    'provider-cli-state',
    'cursor-home',
    '.local',
    'share',
    'cursor-agent',
    'versions',
    '2026.08.11-e8db854',
    'runtime',
    'library.bin',
  ), 'utf8'), 'runtime');
});

test('runSession performs provider turns, checkpoints edits, publishes a portable timeline, and returns edited bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document-source.hwp');
  const timelineInput = path.join(root, 'timeline-input.json');
  const referencePath = path.join(root, 'reference-policy.txt');
  await fs.writeFile(documentPath, 'ORIGINAL-DOCUMENT', { mode: 0o600 });
  await fs.writeFile(timelineInput, JSON.stringify(portableTimeline()), { mode: 0o600 });
  await fs.writeFile(referencePath, 'REFERENCE-DATA', { mode: 0o600 });

  const calls = [];
  let uploadSequence = 0;
  let finishClaims = 0;
  const client = {
    event: async (type, payload) => { calls.push(['event', type, payload]); },
    messages: async () => ({ messages: [] }),
    upload: async (filename, metadata) => {
      const bytes = await fs.readFile(filename);
      const id = createHash('sha256').update(bytes).digest('hex');
      calls.push(['upload', metadata.kind, id]);
      uploadSequence += 1;
      return { id, size: bytes.length, sequence: uploadSequence };
    },
    commitBoundary: async (boundary) => { calls.push(['boundary', boundary]); return boundaryReceipt(boundary); },
    completeTurn: async () => { calls.push(['complete-turn']); return { status: 'running' }; },
    control: async () => ({ pauseRequested: false }),
    finishClaim: async () => {
      calls.push(['finish-claim']);
      finishClaims += 1;
      return finishClaims === 1
        ? { ready: false, messages: [{ id: 'queued-1', content: 'Also update the footer.' }] }
        : { ready: true, messages: [] };
    },
  };
  const prompts = [];
  let closeCalls = 0;
  let harnessGeometry = null;
  let studioReady = 0;
  const createHarness = async ({ onEvent, displayGeometry }) => {
    harnessGeometry = displayGeometry;
    return {
      start: async ({ history }) => { calls.push(['start', history.length]); },
      runTurn: async (prompt) => {
        prompts.push(prompt);
        await onEvent({ type: 'agent', event: { type: 'turn-start', agent: 'codex' } });
        await onEvent({ type: 'agent', event: {
          type: 'tool-call', agent: 'codex', callId: `call-${prompts.length}`, tool: 'replace_range', argsJson: '{}',
        } });
        await onEvent({ type: 'agent', event: {
          type: 'tool-result', agent: 'codex', callId: `call-${prompts.length}`, ok: true, resultPreview: '{"revision":2}',
        } });
        await onEvent({ type: 'agent', event: { type: 'text-delta', agent: 'codex', text: `turn ${prompts.length} done` } });
        const end = { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
        await onEvent({ type: 'agent', event: end });
        return end;
      },
      exportDocument: async (_format, destination) => {
        const bytes = Buffer.from(`EDITED-DOCUMENT-TURN-${prompts.length}`);
        await fs.writeFile(destination, bytes, { mode: 0o600 });
        return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      },
      close: async () => { closeCalls += 1; },
    };
  };
  const displayMode = createSessionDisplayMode({
    environment: null,
    snapshot: () => ({ status: 'error', width: 1440, height: 900 }),
  });
  const outcome = await runSession({
    workspace: root,
    credentials: {},
    client,
    createHarness,
    displayMode,
    onStudioReady: () => { studioReady += 1; },
    manifest: {
      sessionId: 'session-document-runtime',
      provider: 'codex',
      goal: 'Edit the document',
      resources: [
        { kind: 'document', name: 'source.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelineInput },
        { kind: 'reference', name: 'policy.txt', filename: referencePath },
      ],
      latestCheckpoint: null,
      limits: { maxDurationSeconds: 900, maxTurns: 4, turnsUsed: 0 },
    },
  });
  assert.equal(closeCalls, 1);
  assert.equal(studioReady, 1);
  assert.equal(harnessGeometry, displayMode.geometry);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /reference-policy\.txt/);
  assert.match(prompts[1], /Also update the footer/);
  assert.equal((await fs.readFile(outcome.resultPath, 'utf8')), 'EDITED-DOCUMENT-TURN-2');
  const published = JSON.parse(await fs.readFile(outcome.timelinePath, 'utf8'));
  assert.equal(published.schema, TIMELINE_SCHEMA);
  assert.ok(published.thread.messages.some((message) => message.messageId === 'queued-1' && message.delivery === 'accepted-cloud'));
  const firstCheckpoint = calls.findIndex(([type]) => type === 'boundary');
  const firstComplete = calls.findIndex(([type]) => type === 'complete-turn');
  assert.ok(firstCheckpoint >= 0 && firstCheckpoint < firstComplete, 'checkpoint must be durable before turn completion');
  const readyClaim = calls.map(([type]) => type).lastIndexOf('finish-claim');
  const completedEvent = calls.findIndex(([type, eventType]) => type === 'event' && eventType === 'runtime.completed');
  assert.ok(readyClaim >= 0 && readyClaim < completedEvent, 'the atomic message gate must close before completion');
});

test('runSession does not publish readiness on Studio startup failure and cleans the harness', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-startup-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document.hwp');
  const timelinePath = path.join(root, 'timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });
  let ready = 0;
  let closed = 0;
  await assert.rejects(runSession({
    workspace: root,
    credentials: {},
    client: { event: async () => {} },
    onStudioReady: () => { ready += 1; },
    createHarness: async () => ({
      start: async () => { throw Object.assign(new Error('Studio startup failed'), { code: 'STUDIO_START_TIMEOUT' }); },
      close: async () => { closed += 1; },
    }),
    manifest: {
      sessionId: 'startup-failure', provider: 'codex', goal: 'Edit', latestCheckpoint: null,
      resources: [
        { kind: 'document', name: 'document.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
      ],
      limits: { maxDurationSeconds: 900, maxTurns: 1, turnsUsed: 0 },
    },
  }), { code: 'STUDIO_START_TIMEOUT' });
  assert.equal(ready, 0);
  assert.equal(closed, 1);
});

test('runSession treats a Chromium exit as a runtime failure and cleans the harness', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-browser-exit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document.hwp');
  const timelinePath = path.join(root, 'timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });
  let ready = 0;
  let closed = 0;
  await assert.rejects(runSession({
    workspace: root,
    credentials: {},
    client: { event: async () => {} },
    onStudioReady: () => { ready += 1; },
    createHarness: async () => ({
      start: async () => {},
      assertHealthy: () => { throw Object.assign(new Error('Headed browser exited'), { code: 'BROWSER_EXITED' }); },
      close: async () => { closed += 1; },
    }),
    manifest: {
      sessionId: 'browser-exit', provider: 'codex', goal: 'Edit', latestCheckpoint: null,
      resources: [
        { kind: 'document', name: 'document.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
      ],
      limits: { maxDurationSeconds: 900, maxTurns: 1, turnsUsed: 0 },
    },
  }), { code: 'BROWSER_EXITED' });
  assert.equal(ready, 0);
  assert.equal(closed, 1);
});

test('runSession detects display loss while client.wait is blocked and cleans up promptly', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-wait-display-loss-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document.hwp');
  const timelinePath = path.join(root, 'timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });

  let displayStatus = 'ready';
  let restarts = 0;
  const displayEnvironment = {
    DISPLAY: ':80', XAUTHORITY: '/workspace/home/.Xauthority', RAUHWpx_SESSION_DISPLAY: 'ready',
  };
  const sessionDisplay = {
    get status() { return displayStatus; },
    get environment() { return displayStatus === 'ready' ? displayEnvironment : null; },
    snapshot: () => ({ status: displayStatus, display: ':80', width: 1280, height: 800 }),
    restart: async () => { restarts += 1; },
  };
  const displayMode = createSessionDisplayMode(sessionDisplay);
  let waitStartedResolve;
  const waitStarted = new Promise((resolve) => { waitStartedResolve = resolve; });
  let closed = 0;
  let unavailable = 0;
  const client = {
    event: async () => {},
    createWait: async () => ({ id: 'wait-blocked', status: 'pending' }),
    wait: async (_waitId, { signal } = {}) => {
      waitStartedResolve();
      return new Promise((_resolve, reject) => signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      ));
    },
  };
  const startedAt = Date.now();
  const running = runSession({
    workspace: root,
    credentials: {},
    client,
    sessionDisplay,
    displayMode,
    onStudioUnavailable: async () => { unavailable += 1; },
    createHarness: async ({ displayEnv }) => {
      assert.equal(displayEnv.DISPLAY, ':80');
      return {
        start: async () => {},
        assertHealthy: async () => {},
        runTurn: async () => ({
          type: 'turn-end', agent: 'codex', stopReason: 'end_turn',
          wait: { kind: 'question', payload: { prompt: 'Which date?' } },
        }),
        close: async () => { closed += 1; },
      };
    },
    manifest: {
      sessionId: 'wait-display-loss', provider: 'codex', goal: 'Edit', latestCheckpoint: null,
      resources: [
        { kind: 'document', name: 'document.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
      ],
      limits: { maxDurationSeconds: 900, maxTurns: 1, turnsUsed: 0 },
    },
  });
  await waitStarted;
  displayStatus = 'error';
  await assert.rejects(running, { code: 'DISPLAY_LOST' });
  assert.ok(Date.now() - startedAt < 1_000, 'display loss must interrupt a blocked durable wait within one second');
  assert.equal(unavailable, 1);
  assert.equal(restarts, 0);
  assert.equal(closed, 1);
});

test('persistent runSession stays warm between turns and finishes only after End', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-persistent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document.hwp');
  const timelinePath = path.join(root, 'timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });
  const prompts = [];
  const addedReferences = [];
  const turnModes = [];
  const workflowChanges = [];
  let finishClaims = 0;
  let harnessCreates = 0;
  const client = {
    event: async () => {},
    upload: async (filename) => {
      const bytes = await fs.readFile(filename);
      return { id: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    commitBoundary: async (boundary) => boundaryReceipt(boundary),
    beginTurn: async (turn) => { turnModes.push(turn.mode); return turn; },
    completeTurn: async () => ({ status: 'running' }),
    control: async () => ({}),
    finishClaim: async () => {
      finishClaims += 1;
      if (finishClaims === 1 || finishClaims === 3) return { ready: false, waiting: true, messages: [] };
      if (finishClaims === 2) {
        return { ready: false, workflow: 'plan', messages: [{
          id: 'follow-up',
          content: 'Apply the follow-up.',
          attachments: [{
            attachmentId: 'notes', version: 1, blobId: 'a'.repeat(64),
            name: 'notes.txt', mimeType: 'text/plain', size: 12,
          }],
        }] };
      }
      return { ready: true, messages: [] };
    },
    download: async (_blobId, destination) => fs.writeFile(destination, 'FOLLOWUP REF', { mode: 0o600 }),
  };
  const result = await runSession({
    workspace: root,
    credentials: {},
    client,
    createHarness: async ({ onEvent }) => {
      harnessCreates += 1;
      return {
        start: async () => {},
        setWorkflow: async (workflow) => { workflowChanges.push(workflow); },
        addReferences: async (references) => { addedReferences.push(...references); },
        runTurn: async (prompt) => {
          prompts.push(prompt);
          await onEvent({ type: 'agent', event: { type: 'turn-start', agent: 'codex' } });
          const end = { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
          await onEvent({ type: 'agent', event: end });
          return end;
        },
        exportDocument: async (_format, destination) => {
          const bytes = Buffer.from(`PERSISTENT-TURN-${prompts.length}`);
          await fs.writeFile(destination, bytes, { mode: 0o600 });
          return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        },
        close: async () => {},
      };
    },
    manifest: {
      sessionId: 'persistent-runtime',
      provider: 'codex',
      persistent: true,
      roomStatus: 'active',
      goal: 'Start the room.',
      resources: [
        { kind: 'document', name: 'document.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
      ],
      latestCheckpoint: null,
      limits: { maxDurationSeconds: 900, maxTurns: 10, turnsUsed: 0 },
    },
  });
  assert.equal(harnessCreates, 1);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Apply the follow-up/);
  assert.match(prompts[1], /notes\.txt/);
  assert.equal(addedReferences[0].version, 1);
  assert.deepEqual(turnModes, ['direct', 'plan']);
  assert.equal(workflowChanges.at(-1), 'plan');
  assert.equal(finishClaims, 4);
  assert.equal(await fs.readFile(result.resultPath, 'utf8'), 'PERSISTENT-TURN-2');
});

test('persistent redirect seals an operation boundary before dispatching the replacement turn', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-redirect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document.hwp');
  const timelinePath = path.join(root, 'timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });
  const boundaries = [];
  const completedTurns = [];
  const prompts = [];
  let finishClaims = 0;
  let activeTurn = 0;
  const client = {
    event: async () => {},
    beginTurn: async (turn) => { activeTurn = turn.turnNumber; return turn; },
    upload: async (filename) => {
      const bytes = await fs.readFile(filename);
      return { id: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    commitBoundary: async (boundary) => { boundaries.push(boundary); return boundaryReceipt(boundary); },
    completeTurn: async (turn) => { completedTurns.push(turn); return { status: 'running' }; },
    control: async () => ({ redirectRequested: activeTurn === 1 }),
    finishClaim: async () => {
      finishClaims += 1;
      if (finishClaims === 1) return { ready: false, messages: [{ id: 'redirect-1', content: 'Use the shorter title.' }] };
      return { ready: true, messages: [] };
    },
  };
  const result = await runSession({
    workspace: root,
    credentials: {},
    client,
    createHarness: async ({ onEvent }) => ({
      start: async () => {},
      runTurn: async (prompt, options) => {
        prompts.push(prompt);
        await onEvent({ type: 'agent', event: { type: 'turn-start', agent: 'codex' } });
        await onEvent({ type: 'agent', event: {
          type: 'tool-result', agent: 'codex', callId: `tool-${activeTurn}`, ok: true, resultPreview: 'done',
        } });
        await options.onSafeBoundary();
        if ((await options.readControl()).redirectRequested) {
          const interrupted = { type: 'turn-end', agent: 'codex', stopReason: 'interrupted', redirected: true };
          await onEvent({ type: 'agent', event: interrupted });
          return interrupted;
        }
        const completed = { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
        await onEvent({ type: 'agent', event: completed });
        return completed;
      },
      exportDocument: async (_format, destination) => {
        const bytes = Buffer.from(`TURN-${activeTurn}`);
        await fs.writeFile(destination, bytes, { mode: 0o600 });
        return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      },
      close: async () => {},
    }),
    manifest: {
      sessionId: 'persistent-redirect-runtime', provider: 'codex', persistent: true,
      roomStatus: 'active', goal: 'Write the title.', executionConfig: { workflow: 'direct' },
      resources: [
        { kind: 'document', name: 'document.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
      ],
      latestCheckpoint: null,
      limits: { maxDurationSeconds: 900, maxTurns: 10, turnsUsed: 0 },
    },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Use the shorter title/);
  assert.deepEqual(completedTurns.map((turn) => turn.outcome), ['redirected', 'completed']);
  assert.deepEqual(boundaries.map((boundary) => boundary.kind), ['operation', 'turn', 'operation', 'turn']);
  assert.ok(boundaries[0].revision < boundaries[1].revision);
  assert.equal(await fs.readFile(result.resultPath, 'utf8'), 'TURN-2');
});

test('plan approval is a durable worker wait instead of an automatic approval', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-plan-wait-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document.hwp');
  const timelinePath = path.join(root, 'timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });
  const waits = [];
  const resumes = [];
  const client = {
    event: async () => {},
    beginTurn: async (turn) => turn,
    createWait: async (wait) => { waits.push(wait); return { id: 'wait-plan-1', status: 'pending' }; },
    wait: async () => ({ id: 'wait-plan-1', status: 'resolved', resolution: { action: 'approve' } }),
    upload: async (filename) => {
      const bytes = await fs.readFile(filename);
      return { id: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    commitBoundary: async (boundary) => boundaryReceipt(boundary),
    completeTurn: async () => ({ status: 'running' }),
    control: async () => ({}),
    finishClaim: async () => ({ ready: true, messages: [] }),
  };
  await runSession({
    workspace: root,
    credentials: {},
    client,
    createHarness: async () => ({
      start: async () => {},
      runTurn: async (_prompt, options) => {
        if (!options.resume) {
          return {
            type: 'turn-end', agent: 'codex', stopReason: 'end_turn',
            wait: { kind: 'plan-approval', payload: { planId: 'plan-cloud-1', plan: { summary: 'Safe plan' } } },
          };
        }
        resumes.push(options.resume);
        return { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
      },
      exportDocument: async (_format, destination) => {
        const bytes = Buffer.from('PLANNED-EDIT');
        await fs.writeFile(destination, bytes, { mode: 0o600 });
        return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      },
      close: async () => {},
    }),
    manifest: {
      sessionId: 'persistent-plan-runtime', provider: 'codex', persistent: true,
      roomStatus: 'active', goal: 'Plan the edit.', executionConfig: { workflow: 'plan' },
      resources: [
        { kind: 'document', name: 'document.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
      ],
      latestCheckpoint: null,
      limits: { maxDurationSeconds: 900, maxTurns: 10, turnsUsed: 0 },
    },
  });
  assert.equal(waits.length, 1);
  assert.equal(waits[0].kind, 'plan-approval');
  assert.equal(waits[0].payload.planId, 'plan-cloud-1');
  assert.deepEqual(resumes, [{ action: 'approve', planId: 'plan-cloud-1' }]);
});

test('question answers and external approvals resume through their durable wait paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-decision-waits-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document.hwp');
  const timelinePath = path.join(root, 'timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });
  const waits = [];
  const resumes = [];
  const client = {
    event: async () => {},
    beginTurn: async (turn) => turn,
    createWait: async (wait) => {
      waits.push(wait);
      return { id: `wait-${waits.length}`, status: 'pending' };
    },
    wait: async (waitId) => waitId === 'wait-1'
      ? { id: waitId, status: 'resolved', resolution: { action: 'answer', feedback: 'Use the fiscal-year date.' } }
      : { id: waitId, status: 'resolved', resolution: { action: 'approve' } },
    upload: async (filename) => {
      const bytes = await fs.readFile(filename);
      return { id: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    commitBoundary: async (boundary) => boundaryReceipt(boundary),
    completeTurn: async () => ({ status: 'running' }),
    control: async () => ({}),
    finishClaim: async () => ({ ready: true, messages: [] }),
  };
  await runSession({
    workspace: root,
    credentials: {},
    client,
    createHarness: async () => ({
      start: async () => {},
      runTurn: async (_prompt, options) => {
        if (!options.resume) {
          return {
            type: 'turn-end', agent: 'codex', stopReason: 'end_turn',
            wait: { kind: 'question', payload: { prompt: 'Which reporting date?' } },
          };
        }
        resumes.push(options.resume);
        if (options.resume.action === 'answer') {
          return {
            type: 'turn-end', agent: 'codex', stopReason: 'end_turn',
            wait: { kind: 'external-side-effect', payload: { prompt: 'Publish the approved report?' } },
          };
        }
        return { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
      },
      exportDocument: async (_format, destination) => {
        const bytes = Buffer.from('DECISION-EDIT');
        await fs.writeFile(destination, bytes, { mode: 0o600 });
        return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      },
      close: async () => {},
    }),
    manifest: {
      sessionId: 'persistent-decision-runtime', provider: 'codex', persistent: true,
      roomStatus: 'active', goal: 'Finish the report.', executionConfig: { workflow: 'direct' },
      resources: [
        { kind: 'document', name: 'document.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
      ],
      latestCheckpoint: null,
      limits: { maxDurationSeconds: 900, maxTurns: 10, turnsUsed: 0 },
    },
  });
  assert.deepEqual(waits.map(({ kind }) => kind), ['question', 'external-side-effect']);
  assert.deepEqual(resumes, [
    { action: 'answer', feedback: 'Use the fiscal-year date.' },
    { action: 'external-effect', kind: 'external-side-effect', feedback: '' },
  ]);
});

test('safe-boundary pause publishes a checkpoint and timeline, acknowledges pause, and returns no result', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-pause-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document.hwp');
  const timelinePath = path.join(root, 'input-timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });
  let paused = 0;
  const pauseOrder = [];
  const client = {
    event: async (type) => { if (type === 'runtime.paused') pauseOrder.push('event'); }, messages: async () => ({ messages: [] }),
    upload: async (filename) => ({ id: createHash('sha256').update(await fs.readFile(filename)).digest('hex'), size: 1 }),
    commitBoundary: async (boundary) => boundaryReceipt(boundary), completeTurn: async () => ({ status: 'running' }),
    control: async () => ({ pauseRequested: true }), pauseAck: async () => { paused += 1; pauseOrder.push('ack'); },
  };
  const createHarness = async ({ onEvent }) => ({
    start: async () => {},
    runTurn: async () => {
      await onEvent({ type: 'agent', event: { type: 'turn-start', agent: 'codex' } });
      const event = { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
      await onEvent({ type: 'agent', event });
      return event;
    },
    exportDocument: async (_format, destination) => {
      const bytes = Buffer.from('EDITED');
      await fs.writeFile(destination, bytes, { mode: 0o600 });
      return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    close: async () => {},
  });
  const result = await runSession({
    workspace: root, credentials: {}, client, createHarness,
    manifest: {
      sessionId: 'pause-session', provider: 'codex', goal: 'Edit the document', latestCheckpoint: null,
      resources: [
        { kind: 'document', name: 'source.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
      ],
      limits: { maxDurationSeconds: 900, maxTurns: 4, turnsUsed: 0 },
    },
  });
  assert.deepEqual(result, { paused: true, timelinePath: path.join(root, 'timeline.json') });
  assert.equal(paused, 1);
  assert.deepEqual(pauseOrder, ['event', 'ack']);
});

test('safe pause then no-message resume publishes the existing stable result without recommitting its operation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-resume-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pauseWorkspace = path.join(root, 'pause');
  const resumeWorkspace = path.join(root, 'resume');
  await fs.mkdir(pauseWorkspace, { recursive: true });
  await fs.mkdir(resumeWorkspace, { recursive: true });
  const originPath = path.join(pauseWorkspace, 'document.hwp');
  const initialTimelinePath = path.join(pauseWorkspace, 'input-timeline.json');
  await fs.writeFile(originPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(initialTimelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });

  let committedBoundary = null;
  let boundaryCalls = 0;
  const upload = async (filename) => {
    const bytes = await fs.readFile(filename);
    return { id: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  };
  const commitBoundary = async (boundary) => {
    boundaryCalls += 1;
    if (committedBoundary) {
      const sameArtifacts = committedBoundary.operationId === boundary.operationId
        && committedBoundary.turnNumber === boundary.turnNumber
        && committedBoundary.revision === boundary.revision
        && committedBoundary.checkpoint.blobId === boundary.checkpoint.blobId
        && committedBoundary.timeline.blobId === boundary.timeline.blobId;
      if (!sameArtifacts) {
        throw Object.assign(new Error('Boundary operationId was reused with different artifacts'), {
          code: 'BOUNDARY_OPERATION_CONFLICT',
        });
      }
    } else {
      committedBoundary = structuredClone(boundary);
    }
    return boundaryReceipt(boundary);
  };
  const harness = ({ onEvent, exportCalls }) => ({
    start: async () => {},
    runTurn: async () => {
      const event = { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
      await onEvent({ type: 'agent', event });
      return event;
    },
    exportDocument: async (_format, destination) => {
      exportCalls.push(destination);
      const bytes = Buffer.from('EDITED-AT-STABLE-TURN-1');
      await fs.writeFile(destination, bytes, { mode: 0o600 });
      return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    close: async () => {},
  });

  const pauseExports = [];
  const paused = await runSession({
    workspace: pauseWorkspace,
    credentials: {},
    client: {
      event: async () => {},
      messages: async () => ({ messages: [] }),
      upload,
      commitBoundary,
      completeTurn: async () => ({ status: 'running' }),
      control: async () => ({ pauseRequested: true }),
      pauseAck: async () => {},
    },
    createHarness: async ({ onEvent }) => harness({ onEvent, exportCalls: pauseExports }),
    manifest: {
      sessionId: 'pause-resume-session', provider: 'codex', goal: 'Edit the document', latestCheckpoint: null,
      resources: [
        { kind: 'document', name: 'source.hwp', filename: originPath },
        { kind: 'timeline', name: 'timeline.json', filename: initialTimelinePath },
      ],
      limits: { maxDurationSeconds: 900, maxTurns: 1, turnsUsed: 0 },
    },
  });
  assert.equal(paused.paused, true);
  assert.equal(boundaryCalls, 1);
  assert.equal(pauseExports.length, 1);

  const recoveredCheckpoint = path.join(resumeWorkspace, 'checkpoint-1.hwp');
  const recoveredTimeline = path.join(resumeWorkspace, 'input-timeline.json');
  await fs.copyFile(pauseExports[0], recoveredCheckpoint);
  await fs.copyFile(paused.timelinePath, recoveredTimeline);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const resumeExports = [];
  const resumeEvents = [];
  let resumeFinishClaims = 0;
  let resumeMessagePolls = 0;
  let resumeHarnessCreates = 0;
  const resumed = await runSession({
    workspace: resumeWorkspace,
    credentials: {},
    client: {
      event: async (type) => { resumeEvents.push(type); },
      messages: async () => { resumeMessagePolls += 1; return { messages: [] }; },
      upload,
      commitBoundary,
      finishClaim: async () => {
        resumeFinishClaims += 1;
        return { ready: true, messages: [] };
      },
    },
    createHarness: async () => {
      resumeHarnessCreates += 1;
      throw new Error('no-message stable recovery must not start Chromium');
    },
    manifest: {
      sessionId: 'pause-resume-session', provider: 'codex', goal: 'Edit the document',
      latestCheckpoint: {
        operationId: committedBoundary.operationId,
        turnNumber: 1,
        revision: 1,
        blobId: committedBoundary.checkpoint.blobId,
        stable: true,
        filename: recoveredCheckpoint,
      },
      resources: [
        { kind: 'document', name: 'source.hwp', filename: originPath },
        { kind: 'timeline', name: 'timeline.json', filename: recoveredTimeline },
      ],
      limits: { maxDurationSeconds: 900, maxTurns: 1, turnsUsed: 1 },
    },
  });

  assert.equal(boundaryCalls, 1, 'resume must not recommit the already stable turn operation');
  assert.equal(resumeFinishClaims, 1, 'resume must atomically claim the finish gate at the exact turn limit');
  assert.equal(resumeMessagePolls, 0, 'resume must claim atomically instead of delivering messages it cannot process');
  assert.equal(resumeHarnessCreates, 0, 'exact stable recovery must finish without creating a Studio harness');
  assert.deepEqual(resumeExports, [], 'resume must not re-export an unchanged stable checkpoint');
  assert.equal(await fs.readFile(resumed.resultPath, 'utf8'), 'EDITED-AT-STABLE-TURN-1');
  assert.deepEqual(await fs.readFile(resumed.timelinePath), await fs.readFile(recoveredTimeline));
  assert.deepEqual(resumeEvents, ['runtime.started', 'runtime.completed']);
});

test('stable recovery with a claimed queued message starts Studio and processes the next turn', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-recovery-message-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkpointPath = path.join(root, 'checkpoint.hwp');
  const originPath = path.join(root, 'origin.hwp');
  const timelineInput = path.join(root, 'input-timeline.json');
  await fs.writeFile(checkpointPath, 'STABLE-TURN-1', { mode: 0o600 });
  await fs.writeFile(originPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelineInput, JSON.stringify(portableTimeline()), { mode: 0o600 });

  const order = [];
  let finishClaims = 0;
  let harnessCreates = 0;
  let turns = 0;
  const client = {
    event: async (type) => { order.push(type); },
    messages: async () => { order.push('messages'); return { messages: [] }; },
    finishClaim: async () => {
      finishClaims += 1;
      order.push(`finish-claim-${finishClaims}`);
      return finishClaims === 1
        ? { ready: false, messages: [{ id: 'resume-message-1', content: 'Add the recovered footer' }] }
        : { ready: true, messages: [] };
    },
    upload: async (filename) => {
      const bytes = await fs.readFile(filename);
      return { id: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    commitBoundary: async (boundary) => boundaryReceipt(boundary),
    completeTurn: async () => ({ status: 'running' }),
    control: async () => ({ pauseRequested: false, takeoverRequested: false }),
  };
  const result = await runSession({
    workspace: root,
    credentials: {},
    client,
    createHarness: async ({ onEvent, document }) => {
      harnessCreates += 1;
      order.push('harness-created');
      assert.equal(document.filename, checkpointPath);
      return {
        start: async () => { order.push('harness-started'); },
        runTurn: async (prompt) => {
          turns += 1;
          assert.match(prompt, /Add the recovered footer/);
          const event = { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
          await onEvent({ type: 'agent', event });
          return event;
        },
        exportDocument: async (_format, destination) => {
          const bytes = Buffer.from('EDITED-TURN-2');
          await fs.writeFile(destination, bytes, { mode: 0o600 });
          return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
        },
        close: async () => {},
      };
    },
    manifest: {
      sessionId: 'recovery-message-session', provider: 'codex', goal: 'Edit the document',
      latestCheckpoint: {
        operationId: 'turn_1_stable', turnNumber: 1, revision: 1,
        blobId: createHash('sha256').update('STABLE-TURN-1').digest('hex'),
        stable: true, filename: checkpointPath,
      },
      resources: [
        { kind: 'document', name: 'source.hwp', filename: originPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelineInput },
      ],
      limits: { maxDurationSeconds: 900, maxTurns: 3, turnsUsed: 1 },
    },
  });

  assert.equal(harnessCreates, 1);
  assert.equal(turns, 1);
  assert.equal(finishClaims, 2);
  assert.ok(order.indexOf('finish-claim-1') < order.indexOf('harness-created'));
  assert.equal(await fs.readFile(result.resultPath, 'utf8'), 'EDITED-TURN-2');
});

test('turn-limit suspension performs no control or final-result calls after completeTurn', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-limit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document.hwp');
  const timelinePath = path.join(root, 'input-timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });
  let postSuspendCalls = 0;
  const client = {
    event: async () => {},
    messages: async () => ({ messages: [] }),
    upload: async (filename) => ({
      id: createHash('sha256').update(await fs.readFile(filename)).digest('hex'),
      size: 1,
    }),
    commitBoundary: async (boundary) => boundaryReceipt(boundary),
    completeTurn: async () => ({ status: 'suspended' }),
    control: async () => { postSuspendCalls += 1; return { pauseRequested: false }; },
    finishClaim: async () => { postSuspendCalls += 1; return { ready: true, messages: [] }; },
  };
  const createHarness = async ({ onEvent }) => ({
    start: async () => {},
    runTurn: async () => {
      await onEvent({ type: 'agent', event: { type: 'turn-start', agent: 'codex' } });
      const event = { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
      await onEvent({ type: 'agent', event });
      return event;
    },
    exportDocument: async (_format, destination) => {
      const bytes = Buffer.from('EDITED');
      await fs.writeFile(destination, bytes, { mode: 0o600 });
      return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    close: async () => {},
  });
  const result = await runSession({
    workspace: root, credentials: {}, client, createHarness,
    manifest: {
      sessionId: 'limit-session', provider: 'codex', goal: 'Edit the document', latestCheckpoint: null,
      resources: [
        { kind: 'document', name: 'source.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
      ],
      limits: { maxDurationSeconds: 900, maxTurns: 1, turnsUsed: 0 },
    },
  });
  assert.deepEqual(result, { suspended: true, timelinePath: path.join(root, 'timeline.json') });
  assert.equal(postSuspendCalls, 0);
});

test('takeover freezes an atomic document and timeline boundary before final acknowledgement', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-document-runtime-takeover-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documentPath = path.join(root, 'document.hwp');
  const timelinePath = path.join(root, 'input-timeline.json');
  await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
  await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });
  const calls = [];
  const client = {
    event: async (type) => { calls.push(type); },
    messages: async () => ({ messages: [] }),
    upload: async (filename) => ({
      id: createHash('sha256').update(await fs.readFile(filename)).digest('hex'),
      size: (await fs.stat(filename)).size,
    }),
    commitBoundary: async (boundary) => { calls.push('boundary'); return boundaryReceipt(boundary); },
    completeTurn: async () => { calls.push('complete-turn'); return { status: 'running' }; },
    control: async () => { calls.push('control'); return { takeoverRequested: true, pauseRequested: false }; },
    takeoverAck: async () => { calls.push('takeover-ack'); },
    finishClaim: async () => { throw new Error('finish claim must not run after takeover'); },
  };
  const createHarness = async ({ onEvent }) => ({
    start: async () => {},
    runTurn: async () => {
      await onEvent({ type: 'agent', event: { type: 'turn-start', agent: 'codex' } });
      const event = { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
      await onEvent({ type: 'agent', event });
      return event;
    },
    exportDocument: async (_format, destination) => {
      const bytes = Buffer.from('EDITED');
      await fs.writeFile(destination, bytes, { mode: 0o600 });
      return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    close: async () => {},
  });
  const result = await runSession({
    workspace: root, credentials: {}, client, createHarness,
    manifest: {
      sessionId: 'takeover-session', provider: 'codex', goal: 'Edit the document', latestCheckpoint: null,
      resources: [
        { kind: 'document', name: 'source.hwp', filename: documentPath },
        { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
      ],
      limits: { maxDurationSeconds: 900, maxTurns: 4, turnsUsed: 0 },
    },
  });
  assert.deepEqual(result, { takenOver: true, timelinePath: path.join(root, 'timeline.json') });
  assert.deepEqual(calls.slice(-5), [
    'boundary',
    'complete-turn',
    'control',
    'runtime.takeover_ready',
    'takeover-ack',
  ]);
});

test('atomic finish claim catches takeover and pause requests that race the control poll', async (t) => {
  for (const request of ['takeover', 'pause']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `rauhwpx-document-runtime-${request}-claim-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const documentPath = path.join(root, 'document.hwp');
    const timelinePath = path.join(root, 'input-timeline.json');
    await fs.writeFile(documentPath, 'ORIGINAL', { mode: 0o600 });
    await fs.writeFile(timelinePath, JSON.stringify(portableTimeline()), { mode: 0o600 });
    const calls = [];
    const client = {
      event: async (type, payload) => { calls.push([type, payload]); },
      messages: async () => ({ messages: [] }),
      upload: async (filename) => ({
        id: createHash('sha256').update(await fs.readFile(filename)).digest('hex'),
        size: (await fs.stat(filename)).size,
      }),
      commitBoundary: async (boundary) => boundaryReceipt(boundary),
      completeTurn: async () => ({ status: 'running' }),
      control: async () => ({ takeoverRequested: false, pauseRequested: false }),
      finishClaim: async () => {
        calls.push(['finish-claim']);
        return request === 'takeover'
          ? { ready: false, messages: [], takeoverRequested: true }
          : { ready: false, messages: [], pauseRequested: true };
      },
      takeoverAck: async () => { calls.push(['takeover-ack']); },
      pauseAck: async () => { calls.push(['pause-ack']); },
    };
    const createHarness = async ({ onEvent }) => ({
      start: async () => {},
      runTurn: async () => {
        const event = { type: 'turn-end', agent: 'codex', stopReason: 'end_turn' };
        await onEvent({ type: 'agent', event });
        return event;
      },
      exportDocument: async (_format, destination) => {
        const bytes = Buffer.from('EDITED');
        await fs.writeFile(destination, bytes, { mode: 0o600 });
        return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      },
      close: async () => {},
    });
    const result = await runSession({
      workspace: root, credentials: {}, client, createHarness,
      manifest: {
        sessionId: `${request}-claim-session`, provider: 'codex', goal: 'Edit the document', latestCheckpoint: null,
        resources: [
          { kind: 'document', name: 'source.hwp', filename: documentPath },
          { kind: 'timeline', name: 'timeline.json', filename: timelinePath },
        ],
        limits: { maxDurationSeconds: 900, maxTurns: 4, turnsUsed: 0 },
      },
    });
    const expectedEvent = request === 'takeover' ? 'runtime.takeover_ready' : 'runtime.paused';
    const expectedAck = request === 'takeover' ? 'takeover-ack' : 'pause-ack';
    assert.equal(result[request === 'takeover' ? 'takenOver' : 'paused'], true);
    assert.deepEqual(calls.slice(-3).map(([name]) => name), ['finish-claim', expectedEvent, expectedAck]);
    if (request === 'takeover') {
      assert.match(calls.at(-2)[1].operationId, /^turn_1_[a-f0-9]{24}$/);
    }
  }
});
