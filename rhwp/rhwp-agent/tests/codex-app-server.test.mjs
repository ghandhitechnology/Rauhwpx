import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCodexAppServerArgv,
} from '../agents/codex-app-server.mjs';
import { createCodexSession } from '../agents/codex.mjs';

class FakeStream extends EventEmitter {
  constructor(onWrite = null) {
    super();
    this.onWrite = onWrite;
    this.chunks = [];
  }

  write(chunk, callback) {
    const text = String(chunk);
    this.chunks.push(text);
    this.onWrite?.(text);
    callback?.();
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
  }
}

class FakeProcess extends EventEmitter {
  constructor(onFrame = null) {
    super();
    this.frames = [];
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.stdin = new FakeStream((text) => {
      if (!onFrame) return;
      for (const line of text.split('\n').filter(Boolean)) {
        const frame = JSON.parse(line);
        this.frames.push(frame);
        queueMicrotask(() => onFrame?.(frame, this));
      }
    });
    this.exitCode = null;
    this.signalCode = null;
  }

  send(frame) {
    this.stdout.emit('data', `${JSON.stringify(frame)}\n`);
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }

  exit(code = 0) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

function feature(enabled, stage = 'underDevelopment') {
  return {
    name: 'default_mode_request_user_input',
    enabled,
    defaultEnabled: false,
    stage,
    displayName: null,
    description: null,
    announcement: null,
  };
}

function reply(result) {
  return (frame, process) => process.send({ id: frame.id, result });
}

function appServerResponder({ features = [feature(true)], enableFails = false } = {}) {
  let currentFeatures = structuredClone(features);
  return (frame, process) => {
    if (frame.method === 'initialize') return reply({ userAgent: 'codex/0.149.0' })(frame, process);
    if (frame.method === 'initialized') return;
    if (frame.method === 'experimentalFeature/list') {
      return reply({ data: currentFeatures, nextCursor: null })(frame, process);
    }
    if (frame.method === 'experimentalFeature/enablement/set') {
      if (enableFails) {
        process.send({ id: frame.id, error: { code: -32603, message: 'enable failed' } });
      } else {
        currentFeatures = currentFeatures.map((entry) => (
          entry.name === 'default_mode_request_user_input' ? { ...entry, enabled: true } : entry
        ));
        reply({ enablement: { default_mode_request_user_input: true } })(frame, process);
      }
      return;
    }
    if (frame.method === 'thread/start') {
      process.send({ method: 'thread/started', params: { thread: { id: 'thread-native' } } });
      return reply({ thread: { id: 'thread-native' } })(frame, process);
    }
    if (frame.method === 'thread/resume') return reply({ thread: { id: frame.params.threadId } })(frame, process);
    if (frame.method === 'turn/start') {
      process.send({
        method: 'turn/started',
        params: { threadId: frame.params.threadId, turn: { id: 'turn-native', status: 'inProgress' } },
      });
      return reply({ turn: { id: 'turn-native', status: 'inProgress' } })(frame, process);
    }
    if (frame.method === 'turn/interrupt') return reply({})(frame, process);
  };
}

function fakeWatcher() {
  return {
    start() {},
    finalize() {},
    stop() {},
  };
}

function harness(t, {
  workflow = 'direct',
  phase = 'implementing',
  responder = appServerResponder(),
  requestUserInput = async () => ({ status: 'cancelled', reason: 'user-stop' }),
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-app-server-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const spawns = [];
  const session = createCodexSession({
    rootDir: root,
    codexHome: path.join(root, '.codex'),
    mcpScriptPath: '/tmp/mcp-stdio.mjs',
    hubPort: 5123,
    token: 'secret',
    model: 'test-model',
    effort: 'high',
    permissionProfile: 'safe',
    workflow,
    phase,
    capabilityEpoch: 1,
    agentRole: 'chat',
    requestUserInput,
    onEvent: (event) => events.push(event),
  }, {
    spawnProcess(command, argv, options) {
      const native = argv[0] === 'app-server';
      const process = new FakeProcess(native ? responder : null);
      process.featureForced = argv.includes('default_mode_request_user_input');
      spawns.push({ command, argv, options, process, native });
      return process;
    },
    terminateProcess(process) { process.kill('SIGTERM'); },
    createRolloutWatcher: fakeWatcher,
  });
  return { session, events, spawns };
}

async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('app-server argv carries the isolated MCP capability profile', () => {
  const argv = buildCodexAppServerArgv({
    rootDir: '/tmp/project',
    mcpScriptPath: '/tmp/mcp.mjs',
    hubPort: 6199,
    token: 'secret',
    workflow: 'plan',
    phase: 'planning',
    permissionProfile: 'safe',
    agentRole: 'chat',
  });
  assert.deepEqual(argv.slice(0, 2), ['app-server', '--stdio']);
  assert.ok(argv.includes('multi_agent'));
  assert.ok(argv.includes('web_search="live"'));
  assert.ok(argv.includes('sandbox_mode="read-only"'));
  assert.match(argv.find((value) => value.startsWith('mcp_servers.rhwp.env=')), /RHWP_AGENT_ROLE = "chat"/);
});

test('direct mode negotiates native input and answers the original app-server request', async (t) => {
  let capturedRequest;
  const h = harness(t, {
    requestUserInput: async (request) => {
      capturedRequest = request;
      return {
        status: 'answered',
        answers: { database: { selectedOptionIds: ['option-2'] } },
      };
    },
  });
  h.session.sendUserMessage('Build it');
  await settle();

  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].native, true);
  const methods = h.spawns[0].process.frames.map((frame) => frame.method);
  assert.deepEqual(methods.slice(0, 5), [
    'initialize', 'initialized', 'experimentalFeature/list', 'thread/start', 'turn/start',
  ]);
  const turn = h.spawns[0].process.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(turn.params.collaborationMode.mode, 'default');
  assert.equal(turn.params.input[0].text, 'Build it');
  assert.equal(h.session.getSessionId(), 'thread-native');

  h.spawns[0].process.send({
    id: 'question-rpc',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-native',
      turnId: 'turn-native',
      itemId: 'item-question',
      questions: [{
        id: 'database', header: 'Database', question: 'Which database?',
        isOther: true, isSecret: false,
        options: [
          { label: 'SQLite', description: 'Local' },
          { label: 'Postgres', description: 'Remote' },
        ],
      }],
      isBlocking: false,
    },
  });
  await settle();

  assert.equal(capturedRequest.providerRequestId, 'item-question');
  assert.deepEqual(h.spawns[0].process.frames.at(-1), {
    id: 'question-rpc',
    result: { answers: { database: { answers: ['Postgres'] } } },
  });
  assert.equal(h.events.some((event) => event.type === 'tool-call' && event.tool === 'ask_user_question'), false);

  h.spawns[0].process.send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-native', turnId: 'turn-native',
      tokenUsage: {
        total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 75, cacheWriteInputTokens: 4 },
        last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 75, cacheWriteInputTokens: 4 },
      },
    },
  });
  h.spawns[0].process.send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-native', turnId: 'turn-native',
      tokenUsage: {
        total: { inputTokens: 160, outputTokens: 35, cachedInputTokens: 100, cacheWriteInputTokens: 4 },
        last: { inputTokens: 60, outputTokens: 15, cachedInputTokens: 25, cacheWriteInputTokens: 0 },
      },
    },
  });
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();
  assert.deepEqual(h.events.find((event) => event.type === 'usage')?.usage, {
    inputTokens: 160, outputTokens: 35, cacheReadTokens: 100, cacheCreationTokens: 4,
  });
  assert.equal(h.events.at(-1).stopReason, 'completed');
  await h.session.dispose();
});

test('planning mode remains native without the default-mode feature', async (t) => {
  const h = harness(t, {
    workflow: 'plan',
    phase: 'planning',
    responder: appServerResponder({ features: [] }),
  });
  h.session.sendUserMessage('Plan it');
  await settle();
  assert.equal(h.spawns.length, 1);
  const turn = h.spawns[0].process.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(turn.params.collaborationMode.mode, 'plan');
  assert.equal(h.spawns[0].process.frames.some((frame) => frame.method === 'experimentalFeature/enablement/set'), false);
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('disabled default-mode feature is enabled and verified before the turn', async (t) => {
  const h = harness(t, { responder: appServerResponder({ features: [feature(false)] }) });
  h.session.sendUserMessage('Implement');
  await settle();
  const methods = h.spawns[0].process.frames.map((frame) => frame.method);
  assert.deepEqual(methods.filter((method) => method === 'experimentalFeature/list').length, 2);
  assert.ok(methods.indexOf('experimentalFeature/enablement/set') < methods.indexOf('thread/start'));
  assert.equal(h.spawns.length, 1);
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('0.149 empty runtime enablement response restarts with the CLI flag and re-verifies', async (t) => {
  const responder = (frame, process) => {
    if (frame.method === 'initialize') return reply({ userAgent: 'codex/0.149.0' })(frame, process);
    if (frame.method === 'initialized') return;
    if (frame.method === 'experimentalFeature/list') {
      return reply({ data: [feature(process.featureForced)], nextCursor: null })(frame, process);
    }
    if (frame.method === 'experimentalFeature/enablement/set') {
      return reply({ enablement: {} })(frame, process);
    }
    return appServerResponder()(frame, process);
  };
  const h = harness(t, { responder });
  h.session.sendUserMessage('Implement natively');
  await settle(24);
  assert.equal(h.spawns.length, 2);
  assert.equal(h.spawns.every((entry) => entry.native), true);
  assert.equal(h.spawns[0].argv.includes('default_mode_request_user_input'), false);
  assert.equal(h.spawns[1].argv.includes('default_mode_request_user_input'), true);
  assert.ok(h.spawns[1].process.frames.some((frame) => frame.method === 'turn/start'));
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

for (const entry of [
  { name: 'absent', responder: appServerResponder({ features: [] }) },
  { name: 'removed', responder: appServerResponder({ features: [feature(true, 'removed')] }) },
  { name: 'enablement failure', responder: appServerResponder({ features: [feature(false)], enableFails: true }) },
]) {
  test(`default-mode ${entry.name} falls back to legacy exec before starting a turn`, async (t) => {
    const h = harness(t, { responder: entry.responder });
    h.session.sendUserMessage('Fallback prompt');
    await settle(24);
    assert.equal(h.spawns.length, entry.name === 'enablement failure' ? 3 : 2);
    assert.equal(h.spawns[0].native, true);
    const legacy = h.spawns.at(-1);
    assert.deepEqual(legacy.argv.slice(0, 1), ['exec']);
    assert.equal(h.spawns[0].process.frames.some((frame) => frame.method === 'thread/start'), false);
    assert.match(legacy.process.stdin.chunks.join(''), /Fallback prompt/);
    assert.equal(h.events.filter((event) => event.type === 'turn-start').length, 1);
    legacy.process.exit(0);
    await h.session.dispose();
  });
}

test('interrupt uses turn/interrupt and settles the native turn once', async (t) => {
  const h = harness(t);
  h.session.sendUserMessage('Wait');
  await settle();
  h.session.interrupt();
  await settle();
  const interrupt = h.spawns[0].process.frames.find((frame) => frame.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: 'thread-native', turnId: 'turn-native' });
  assert.deepEqual(h.events.filter((event) => event.type === 'turn-end').map((event) => event.stopReason), ['interrupted']);
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'interrupted' } },
  });
  await settle();
  assert.equal(h.events.filter((event) => event.type === 'turn-end').length, 1);
  await h.session.dispose();
});

test('mode changes restart app-server while idle, resume the thread, and select plan mode', async (t) => {
  const h = harness(t);
  h.session.sendUserMessage('First');
  await settle();
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();
  await h.session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 });
  h.session.sendUserMessage('Plan next');
  await settle(24);

  assert.equal(h.spawns.length, 2);
  const secondMethods = h.spawns[1].process.frames.map((frame) => frame.method);
  assert.ok(secondMethods.includes('thread/resume'));
  assert.equal(secondMethods.includes('thread/start'), false);
  const secondTurn = h.spawns[1].process.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(secondTurn.params.collaborationMode.mode, 'plan');
  assert.equal(secondTurn.params.threadId, 'thread-native');
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('provider loss aborts a blocked native question and expires the turn', async (t) => {
  let receivedSignal;
  const h = harness(t, {
    requestUserInput: (_request, signal) => {
      receivedSignal = signal;
      return new Promise(() => {});
    },
  });
  h.session.sendUserMessage('Ask');
  await settle();
  h.spawns[0].process.send({
    id: 77,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-native', turnId: 'turn-native', itemId: 'item-77',
      questions: [{
        id: 'choice', header: 'Choice', question: 'Choose?', isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }],
      }],
      isBlocking: true,
    },
  });
  await settle();
  assert.equal(receivedSignal.aborted, false);
  h.spawns[0].process.exit(1);
  await settle();
  assert.equal(receivedSignal.aborted, true);
  assert.equal(h.events.filter((event) => event.type === 'turn-end').at(-1).stopReason, 'exited');
  await h.session.dispose();
});

test('native questions from a non-root thread fail closed without reaching the host', async (t) => {
  let calls = 0;
  const h = harness(t, {
    requestUserInput: async () => {
      calls += 1;
      return { status: 'cancelled', reason: 'user-stop' };
    },
  });
  h.session.sendUserMessage('Ask');
  await settle();
  h.spawns[0].process.send({
    id: 'child-question',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'child-thread', turnId: 'child-turn', itemId: 'child-item',
      questions: [{
        id: 'choice', header: 'Choice', question: 'Choose?', isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }],
      }],
      isBlocking: false,
    },
  });
  await settle();
  assert.equal(calls, 0);
  assert.deepEqual(h.spawns[0].process.frames.at(-1), {
    id: 'child-question',
    error: {
      code: -32602,
      message: 'Codex user questions are restricted to the active root turn',
      data: { code: 'SUBAGENT_USER_INPUT_DENIED' },
    },
  });
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('Stop aborts a blocked question and sends turn/interrupt to Codex', async (t) => {
  let receivedSignal;
  const h = harness(t, {
    requestUserInput: (_request, signal) => {
      receivedSignal = signal;
      return new Promise(() => {});
    },
  });
  h.session.sendUserMessage('Ask');
  await settle();
  h.spawns[0].process.send({
    id: 'stop-question',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-native', turnId: 'turn-native', itemId: 'stop-item',
      questions: [{
        id: 'choice', header: 'Choice', question: 'Choose?', isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }],
      }],
      isBlocking: false,
    },
  });
  await settle();
  h.session.interrupt();
  await settle();
  assert.equal(receivedSignal.aborted, true);
  assert.ok(h.spawns[0].process.frames.some((frame) => frame.method === 'turn/interrupt'));
  assert.deepEqual(h.spawns[0].process.frames.find((frame) => frame.id === 'stop-question' && frame.error)?.error?.data, {
    code: 'USER_STOP',
  });
  assert.equal(h.events.filter((event) => event.type === 'turn-end').at(-1).stopReason, 'interrupted');
  await h.session.dispose();
});
