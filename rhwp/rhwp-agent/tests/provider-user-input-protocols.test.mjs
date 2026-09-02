import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildClaudeSdkOptions,
  createClaudeAskUserQuestionPermissionHandler,
  createClaudeSession,
} from '../agents/claude.mjs';
import {
  codexDefaultModeUserInputEnabled,
  decodeCodexRequestUserInputFrame,
  encodeCodexRequestUserInputFrame,
  selectCodexUserInputTransport,
} from '../agents/codex.mjs';
import {
  decodeCursorAskQuestionFrame,
  encodeCursorAskQuestionFrame,
  handleCursorAskQuestionFrame,
  selectCursorUserInputTransport,
} from '../agents/cursor.mjs';
import {
  decodeGrokAskUserQuestionFrame,
  encodeGrokAskUserQuestionFrame,
  selectGrokUserInputTransport,
} from '../agents/grok.mjs';

const baseOpts = {
  rootDir: '/tmp/rhwp',
  isolatedHome: '/tmp/rhwp-home',
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 5175,
  token: 'token',
  workflow: 'direct',
  phase: 'implementing',
  capabilityEpoch: 1,
  permissionProfile: 'safe',
  agentRole: 'chat',
  requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
  onEvent() {},
};

const CLAUDE_INPUT = {
  questions: [
    {
      header: 'Runtime',
      question: 'Which runtime?',
      options: [
        { label: 'Node', description: 'Use Node.js' },
        { label: 'Bun', description: 'Use Bun' },
      ],
      multiSelect: false,
    },
    {
      header: 'Checks',
      question: 'Which checks?',
      options: [
        { label: 'Unit', description: 'Run unit tests' },
        { label: 'Lint', description: 'Run lint' },
      ],
      multiSelect: true,
    },
  ],
};

async function waitUntil(predicate, message = 'condition did not settle') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // Pump timers, not only immediates: Windows timer resolution can make a
    // 20ms closeGrace and a 30ms sleep fire in the same tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('Claude Agent SDK callback round-trips captured AskUserQuestion input and preserves abort signal', async () => {
  const controller = new AbortController();
  let received;
  const handler = createClaudeAskUserQuestionPermissionHandler({
    ...baseOpts,
    requestUserInput: async (request, signal) => {
      received = { request, signal };
      return {
        status: 'answered',
        answers: {
          'question-1': { selectedOptionIds: ['option-1'] },
          'question-2': { selectedOptionIds: ['option-1'], otherText: 'Typecheck' },
        },
      };
    },
  });
  const result = await handler('AskUserQuestion', CLAUDE_INPUT, {
    signal: controller.signal,
    toolUseID: 'toolu-ask',
    requestId: 'permission-1',
  });

  assert.equal(received.signal, controller.signal);
  assert.equal(received.request.providerRequestId, 'permission-1');
  assert.equal(received.request.questions.length, 2);
  assert.deepEqual(result, {
    behavior: 'allow',
    updatedInput: {
      ...CLAUDE_INPUT,
      answers: {
        'Which runtime?': 'Node',
        'Which checks?': 'Unit, Typecheck',
      },
    },
  });
});

test('Claude native options expose AskUserQuestion in direct, plan, and question workflows', () => {
  for (const workflow of ['direct', 'plan', 'question']) {
    const opts = {
      ...baseOpts,
      workflow,
      phase: workflow === 'plan' ? 'planning' : workflow === 'question' ? 'questioning' : 'implementing',
    };
    const sdk = buildClaudeSdkOptions(opts, '00000000-0000-4000-8000-000000000000', false, new AbortController());
    assert.ok(sdk.tools.includes('AskUserQuestion'));
    assert.equal(typeof sdk.canUseTool, 'function');
    assert.equal(sdk.permissionMode, workflow === 'direct' ? 'default' : 'plan');
    if (workflow !== 'direct') {
      assert.ok(!sdk.tools.includes('Write'));
      assert.ok(!sdk.tools.includes('Edit'));
    }
  }
});

test('Claude denies AskUserQuestion from SDK subagents without invoking the host', async () => {
  let calls = 0;
  const handler = createClaudeAskUserQuestionPermissionHandler({
    ...baseOpts,
    requestUserInput: async () => { calls += 1; },
  });
  const result = await handler('AskUserQuestion', CLAUDE_INPUT, {
    signal: new AbortController().signal,
    toolUseID: 'toolu-child',
    requestId: 'permission-child',
    agentID: 'agent-child',
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, {
    behavior: 'deny',
    message: 'Subagents cannot ask the user questions.',
    interrupt: false,
  });
});

test('Claude closes each SDK query before turn-end and resumes in a fresh query', async () => {
  const events = [];
  const prompts = [];
  const optionsByQuery = [];
  let closeCalls = 0;
  const queryAgent = ({ prompt, options }) => {
    optionsByQuery.push(options);
    const query = (async function* () {
      for await (const message of prompt) {
        prompts.push(message);
        yield {
          type: 'system',
          subtype: 'init',
          session_id: options.sessionId ?? options.resume,
          model: 'claude-test',
        };
        yield { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' };
        if (options.sessionId) {
          // A misbehaving iterator can still yield after close() starts. The
          // closed generation must not publish that notification.
          yield {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'stale-turn-a-task',
            status: 'completed',
          };
        }
      }
    })();
    query.close = () => { closeCalls += 1; };
    return query;
  };
  const session = createClaudeSession({
    ...baseOpts,
    onEvent: (event) => events.push(event),
  }, {
    queryAgent,
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
  });
  session.sendUserMessage('Choose a runtime');
  await waitUntil(() => events.filter((event) => event.type === 'turn-end').length === 1);

  session.sendUserMessage('Continue the same session');
  await waitUntil(() => events.filter((event) => event.type === 'turn-end').length === 2);

  assert.equal(prompts[0].message.content[0].text, 'Choose a runtime');
  assert.equal(prompts[1].message.content[0].text, 'Continue the same session');
  assert.equal(optionsByQuery.length, 2);
  assert.ok(optionsByQuery[0].tools.includes('AskUserQuestion'));
  assert.equal(typeof optionsByQuery[0].sessionId, 'string');
  assert.equal(optionsByQuery[0].resume, undefined);
  assert.equal(optionsByQuery[1].sessionId, undefined);
  assert.equal(optionsByQuery[1].resume, optionsByQuery[0].sessionId);
  assert.equal(closeCalls, 2);
  assert.equal(events.some((event) => event.type === 'task-end'), false);
  assert.deepEqual(events.map((event) => event.type), [
    'turn-start', 'session-info', 'turn-end',
    'turn-start', 'session-info', 'turn-end',
  ]);
  assert.equal(await session.dispose(), true);
});

test('Claude rejects turn A user-input callbacks after turn B starts', async () => {
  const events = [];
  const optionsByQuery = [];
  const releaseResult = [];
  const hostSignals = [];
  let resolveFirstHostRequest;
  let hostCalls = 0;
  const session = createClaudeSession({
    ...baseOpts,
    requestUserInput(_request, signal) {
      hostCalls += 1;
      hostSignals.push(signal);
      if (hostCalls === 1) {
        return new Promise((resolve) => { resolveFirstHostRequest = resolve; });
      }
      return Promise.resolve({ status: 'cancelled', reason: 'user-stop' });
    },
    onEvent: (event) => events.push(event),
  }, {
    queryAgent({ prompt, options }) {
      optionsByQuery.push(options);
      let release;
      const resultGate = new Promise((resolve) => { release = resolve; });
      releaseResult.push(release);
      const query = (async function* () {
        for await (const _message of prompt) {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: options.sessionId ?? options.resume,
            model: 'claude-test',
          };
          await resultGate;
          yield { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' };
        }
      })();
      query.close = () => {};
      return query;
    },
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
  });

  session.sendUserMessage('turn A');
  await waitUntil(() => optionsByQuery.length === 1);
  const turnAQuestion = optionsByQuery[0].canUseTool('AskUserQuestion', CLAUDE_INPUT, {
    signal: new AbortController().signal,
    toolUseID: 'toolu-a',
    requestId: 'permission-a',
  });
  const turnARejection = assert.rejects(turnAQuestion, (error) => error?.name === 'AbortError');
  await waitUntil(() => hostCalls === 1);
  releaseResult[0]();
  await waitUntil(() => events.filter((event) => event.type === 'turn-end').length === 1);

  await turnARejection;
  assert.equal(hostSignals[0].aborted, true);
  session.sendUserMessage('turn B');
  await waitUntil(() => optionsByQuery.length === 2);

  await assert.rejects(
    optionsByQuery[0].canUseTool('AskUserQuestion', CLAUDE_INPUT, {
      signal: new AbortController().signal,
      toolUseID: 'toolu-stale-a',
      requestId: 'permission-stale-a',
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(hostCalls, 1, 'a stale turn A callback must not reach the host during turn B');

  const turnBAnswer = await optionsByQuery[1].canUseTool('AskUserQuestion', CLAUDE_INPUT, {
    signal: new AbortController().signal,
    toolUseID: 'toolu-b',
    requestId: 'permission-b',
  });
  assert.equal(hostCalls, 2);
  assert.equal(turnBAnswer.behavior, 'deny');
  resolveFirstHostRequest({ status: 'answered', answers: {} });

  releaseResult[1]();
  await waitUntil(() => events.filter((event) => event.type === 'turn-end').length === 2);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 2);
  assert.equal(await session.dispose(), true);
});

test('Claude terminal settlement and disposal await asynchronous SDK shutdown', async () => {
  const events = [];
  let releaseClose;
  let resolvePendingNext;
  let pendingNextStarted;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const pendingNext = new Promise((resolve) => { resolvePendingNext = resolve; });
  const enteredPendingNext = new Promise((resolve) => { pendingNextStarted = resolve; });
  let step = 0;
  const queryAgent = () => ({
    [Symbol.asyncIterator]() { return this; },
    next() {
      step += 1;
      if (step === 1) {
        return Promise.resolve({
          value: { type: 'system', subtype: 'init', session_id: 'sdk-close-test', model: 'claude-test' },
          done: false,
        });
      }
      if (step === 2) {
        return Promise.resolve({
          value: { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' },
          done: false,
        });
      }
      pendingNextStarted();
      return pendingNext;
    },
    async close() {
      await closeGate;
      resolvePendingNext({ value: undefined, done: true });
    },
  });
  let flushes = 0;
  const session = createClaudeSession({
    ...baseOpts,
    onEvent: (event) => events.push(event),
  }, {
    queryAgent,
    closeGraceMs: 200,
    flushCredentialMirrors() { flushes += 1; },
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
  });
  session.sendUserMessage('close cleanly');
  await enteredPendingNext;
  assert.equal(events.some((event) => event.type === 'turn-end'), false);

  let disposed = false;
  const disposal = session.dispose().then((cleaned) => {
    disposed = true;
    return cleaned;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, false, 'dispose must await an asynchronous query.close()');
  releaseClose();
  assert.equal(await disposal, true);
  assert.equal(events.some((event) => event.type === 'turn-end'), false, 'dispose cancels pending event delivery');
  assert.equal(flushes, 1);
});

test('a never-settling Claude SDK query quarantines restart and credential cleanup', async () => {
  const events = [];
  const never = new Promise(() => {});
  let queryCalls = 0;
  let closeCalls = 0;
  let step = 0;
  const queryAgent = () => {
    queryCalls += 1;
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        step += 1;
        if (step === 1) {
          return Promise.resolve({
            value: { type: 'system', subtype: 'init', session_id: 'sdk-stuck-test', model: 'claude-test' },
            done: false,
          });
        }
        if (step === 2) {
          return Promise.resolve({
            value: { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' },
            done: false,
          });
        }
        return never;
      },
      async close() {
        closeCalls += 1;
        await never;
      },
    };
  };
  let flushes = 0;
  const session = createClaudeSession({
    ...baseOpts,
    onEvent: (event) => events.push(event),
  }, {
    queryAgent,
    closeGraceMs: 20,
    flushCredentialMirrors() { flushes += 1; },
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
  });
  session.sendUserMessage('finish one turn then hang');
  await waitUntil(() => events.at(-1)?.type === 'turn-end');
  assert.equal(events.at(-1)?.type, 'turn-end');
  assert.equal(events.at(-1)?.stopReason, 'failed');

  await assert.rejects(
    session.setPermissionProfile('unrestricted'),
    /Claude SDK cleanup remains unconfirmed/,
  );
  assert.equal(closeCalls, 1);

  assert.throws(
    () => session.sendUserMessage('must not reuse the workspace'),
    /Claude SDK cleanup remains unconfirmed/,
  );
  assert.equal(queryCalls, 1);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);
  assert.match(events.findLast((event) => event.type === 'error').message, /cleanup could not be confirmed/);
  assert.equal(await session.dispose(), false);
  assert.equal(flushes, 0, 'an uncertain SDK owner must not publish credential mirrors');
});

test('Claude does not announce a queued turn when interrupted SDK cleanup times out', async () => {
  const events = [];
  const never = new Promise(() => {});
  let queryCalls = 0;
  const session = createClaudeSession({
    ...baseOpts,
    onEvent: (event) => events.push(event),
  }, {
    queryAgent() {
      queryCalls += 1;
      let step = 0;
      return {
        [Symbol.asyncIterator]() { return this; },
        next() {
          step += 1;
          if (step === 1) {
            return Promise.resolve({
              value: { type: 'system', subtype: 'init', session_id: 'sdk-interrupt-test', model: 'claude-test' },
              done: false,
            });
          }
          return never;
        },
        close() { return never; },
      };
    },
    closeGraceMs: 20,
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
  });

  session.sendUserMessage('turn A');
  await waitUntil(() => events.some((event) => event.type === 'session-info'));
  session.interrupt();
  session.sendUserMessage('turn B must remain unannounced');
  await waitUntil(() => events.filter((event) => event.type === 'turn-end').length === 2);

  assert.equal(queryCalls, 1);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);
  assert.deepEqual(
    events.filter((event) => event.type === 'turn-end'),
    [
      { type: 'turn-end', agent: 'claude', stopReason: 'interrupted' },
      { type: 'turn-end', agent: 'claude', stopReason: 'failed' },
    ],
  );
  assert.match(events.findLast((event) => event.type === 'error').message, /cleanup remains unconfirmed/);
  assert.equal(await session.dispose(), false);
});

test('Claude waits for async SDK startup cleanup before dispatching the legacy fallback', async () => {
  const stdin = [];
  let closeCalls = 0;
  let releaseClose;
  let markCloseStarted;
  let markLegacyWritten;
  let sdkSignal;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const closeStarted = new Promise((resolve) => { markCloseStarted = resolve; });
  const legacyWritten = new Promise((resolve) => { markLegacyWritten = resolve; });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(value, callback) {
      stdin.push(String(value));
      callback?.();
      markLegacyWritten();
    },
  };
  child.exitCode = null;
  child.signalCode = null;
  let spawnCalls = 0;
  const session = createClaudeSession(baseOpts, {
    queryAgent({ options }) {
      sdkSignal = options.abortController.signal;
      return {
        [Symbol.asyncIterator]() { return this; },
        next() { return Promise.reject(new Error('async SDK startup rejection')); },
        async close() {
          closeCalls += 1;
          markCloseStarted();
          await closeGate;
        },
      };
    },
    closeGraceMs: 200,
    spawnProcess() {
      spawnCalls += 1;
      return child;
    },
    terminateProcess() { return true; },
    waitForExit() { return true; },
  });

  session.sendUserMessage('Fallback only after shutdown');
  await closeStarted;
  assert.equal(sdkSignal.aborted, true);
  assert.equal(closeCalls, 1);
  assert.equal(spawnCalls, 0, 'legacy must wait while query.close() still owns the SDK transport');
  assert.deepEqual(stdin, []);

  releaseClose();
  await legacyWritten;
  assert.equal(spawnCalls, 1);
  assert.equal(JSON.parse(stdin[0]).message.content[0].text, 'Fallback only after shutdown');
  await session.dispose();
});

test('Claude quarantines an async SDK startup failure when cleanup proof times out', async () => {
  const events = [];
  const never = new Promise(() => {});
  let closeCalls = 0;
  let spawnCalls = 0;
  let sdkSignal;
  let markTurnEnded;
  const turnEnded = new Promise((resolve) => { markTurnEnded = resolve; });
  const session = createClaudeSession({
    ...baseOpts,
    onEvent(event) {
      events.push(event);
      if (event.type === 'turn-end') markTurnEnded();
    },
  }, {
    queryAgent({ options }) {
      sdkSignal = options.abortController.signal;
      return {
        [Symbol.asyncIterator]() { return this; },
        next() { return Promise.reject(new Error('async SDK startup rejection')); },
        async close() {
          closeCalls += 1;
          await never;
        },
      };
    },
    closeGraceMs: 10,
    spawnProcess() {
      spawnCalls += 1;
      throw new Error('legacy must not overlap uncertain SDK cleanup');
    },
  });

  session.sendUserMessage('Do not overlap transports');
  await turnEnded;
  assert.equal(sdkSignal.aborted, true);
  assert.equal(closeCalls, 1);
  assert.equal(spawnCalls, 0);
  assert.match(
    events.findLast((event) => event.type === 'error').message,
    /cleanup could not be confirmed; legacy fallback was not started/,
  );
  assert.equal(events.at(-1).stopReason, 'failed');
  assert.equal(await session.dispose(), false);
});

test('Claude retries through the legacy MCP transport when SDK startup fails before an event', async () => {
  const stdin = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write(value, callback) { stdin.push(String(value)); callback?.(); } };
  child.exitCode = null;
  child.signalCode = null;
  const session = createClaudeSession(baseOpts, {
    queryAgent() { throw new Error('SDK unavailable'); },
    spawnProcess() { return child; },
    terminateProcess(proc) {
      proc.exitCode = 0;
      queueMicrotask(() => proc.emit('exit', 0, null));
    },
  });
  session.sendUserMessage('Fallback prompt');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(stdin[0]).message.content[0].text, 'Fallback prompt');
  await session.dispose();
});

const CURSOR_FRAME = {
  jsonrpc: '2.0',
  id: 41,
  method: 'cursor/ask_question',
  params: {
    toolCallId: 'tool-cursor-1',
    title: 'Deployment target',
    questions: [{
      id: 'target',
      prompt: 'Where should this deploy?',
      options: [
        { id: 'preview', label: 'Preview' },
        { id: 'production', label: 'Production' },
      ],
      allowMultiple: false,
    }],
  },
};

test('Cursor ACP cursor/ask_question codec preserves protocol IDs', () => {
  const decoded = decodeCursorAskQuestionFrame(CURSOR_FRAME);
  assert.equal(decoded.request.providerRequestId, 'tool-cursor-1');
  assert.equal(decoded.request.questions[0].allowOther, false);
  assert.equal(decoded.request.questions[0].header, 'Deployment t');
  assert.deepEqual(
    encodeCursorAskQuestionFrame(decoded, {
      status: 'answered',
      answers: { target: { selectedOptionIds: ['production'] } },
    }),
    {
      jsonrpc: '2.0',
      id: 41,
      result: {
        outcome: {
          outcome: 'answered',
          answers: [{ questionId: 'target', selectedOptionIds: ['production'] }],
        },
      },
    },
  );
});

test('Cursor ACP handler passes through the transport abort signal', async () => {
  const controller = new AbortController();
  let receivedSignal;
  const response = await handleCursorAskQuestionFrame({
    ...baseOpts,
    requestUserInput: async (_request, signal) => {
      receivedSignal = signal;
      return { status: 'cancelled', reason: 'user-stop' };
    },
  }, CURSOR_FRAME, controller.signal);
  assert.equal(receivedSignal, controller.signal);
  assert.deepEqual(response.result, { outcome: { outcome: 'cancelled' } });
});

const CODEX_FRAME = {
  jsonrpc: '2.0',
  id: 'rpc-7',
  method: 'item/tool/requestUserInput',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    questions: [{
      id: 'database',
      header: 'Database',
      question: 'Which database?',
      isOther: true,
      isSecret: false,
      options: [
        { label: 'SQLite', description: 'Local database' },
        { label: 'Postgres', description: 'Network database' },
      ],
    }],
    isBlocking: true,
    autoResolutionMs: null,
  },
};

test('Codex app-server requestUserInput codec maps labels and user notes', () => {
  const decoded = decodeCodexRequestUserInputFrame(CODEX_FRAME);
  assert.deepEqual(
    encodeCodexRequestUserInputFrame(decoded, {
      status: 'answered',
      answers: { database: { selectedOptionIds: [], otherText: 'DuckDB' } },
    }),
    {
      jsonrpc: '2.0',
      id: 'rpc-7',
      result: { answers: { database: { answers: ['user_note: DuckDB'] } } },
    },
  );
});

test('Codex native selection requires app-server and detects the default-mode feature', () => {
  const capabilities = {
    transport: 'app-server',
    methods: ['item/tool/requestUserInput'],
    features: [{ name: 'default_mode_request_user_input', enabled: true }],
  };
  assert.equal(codexDefaultModeUserInputEnabled(capabilities.features), true);
  assert.equal(selectCodexUserInputTransport(baseOpts, capabilities), 'native-app-server');
  assert.equal(selectCodexUserInputTransport(baseOpts, { ...capabilities, features: [] }), 'legacy-mcp');
  assert.equal(selectCodexUserInputTransport({ ...baseOpts, workflow: 'plan', phase: 'planning' }, { ...capabilities, features: [] }), 'native-app-server');
  assert.equal(selectCodexUserInputTransport({ ...baseOpts, workflow: 'question', phase: 'questioning' }, { ...capabilities, features: [] }), 'native-app-server');
  assert.equal(selectCodexUserInputTransport({ ...baseOpts, workflow: 'plan', phase: 'implementing' }, { ...capabilities, features: [] }), 'legacy-mcp');
  assert.equal(selectCodexUserInputTransport({ ...baseOpts, agentRole: 'copy-layout-worker:1' }, capabilities), 'legacy-mcp');
});

function grokFrame(method) {
  return {
    jsonrpc: '2.0',
    id: 99,
    method,
    params: {
      sessionId: 'session-grok',
      toolCallId: 'tool-grok',
      mode: 'plan',
      questions: [{
        id: 'scope',
        question: 'Which scope?',
        options: [
          { id: 'small', label: 'Small', description: 'Small scope' },
          { id: 'large', label: 'Large', description: 'Large scope' },
        ],
        multiSelect: false,
      }],
    },
  };
}

test('Grok ACP accepts both ask-user-question spellings and encodes Other annotations', () => {
  for (const method of ['x.ai/ask_user_question', '_x.ai/ask_user_question']) {
    const decoded = decodeGrokAskUserQuestionFrame(grokFrame(method));
    const response = encodeGrokAskUserQuestionFrame(decoded, {
      status: 'answered',
      answers: { scope: { selectedOptionIds: [], otherText: 'Medium' } },
    });
    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 99,
      result: {
        outcome: 'accepted',
        answers: { 'Which scope?': ['Other'] },
        annotations: { 'Which scope?': { notes: 'Medium' } },
      },
    });
  }
});

test('Grok codec accepts the 1.0.x wrapped private-extension payload', () => {
  const frame = grokFrame('_x.ai/ask_user_question');
  const decoded = decodeGrokAskUserQuestionFrame({
    ...frame,
    params: { method: 'x.ai/ask_user_question', params: frame.params },
  });
  assert.equal(decoded.request.providerRequestId, 'tool-grok');
  assert.equal(decoded.request.questions[0].id, 'scope');
});

test('Grok native selection fails closed until the ACP timeout is disabled', () => {
  const capabilities = {
    transport: 'acp',
    methods: ['_x.ai/ask_user_question'],
  };
  assert.deepEqual(selectGrokUserInputTransport(baseOpts, capabilities), { transport: 'legacy-mcp' });
  assert.deepEqual(
    selectGrokUserInputTransport(baseOpts, { ...capabilities, askUserTimeoutDisabled: true }),
    { transport: 'native-acp', method: '_x.ai/ask_user_question' },
  );
  assert.equal(selectCursorUserInputTransport(baseOpts, {
    transport: 'acp', methods: ['cursor/ask_question'],
  }), 'native-acp');
});

test('captured provider frames fail closed on unsupported card shapes', () => {
  assert.throws(
    () => decodeCodexRequestUserInputFrame({
      ...CODEX_FRAME,
      params: {
        ...CODEX_FRAME.params,
        questions: [{ ...CODEX_FRAME.params.questions[0], isSecret: true }],
      },
    }),
    /secret questions are not supported/,
  );
  assert.throws(
    () => decodeCursorAskQuestionFrame({
      ...CURSOR_FRAME,
      params: {
        ...CURSOR_FRAME.params,
        questions: [{ ...CURSOR_FRAME.params.questions[0], options: [{ id: 'only', label: 'Only' }] }],
      },
    }),
    /must contain 2-4 options/,
  );
});

test('question-text keyed native codecs reject collisions', async () => {
  const duplicateClaude = {
    questions: [CLAUDE_INPUT.questions[0], { ...CLAUDE_INPUT.questions[0], header: 'Second' }],
  };
  await assert.rejects(
    () => createClaudeAskUserQuestionPermissionHandler(baseOpts)(
      'AskUserQuestion',
      duplicateClaude,
      { signal: new AbortController().signal, requestId: 'duplicate-claude' },
    ),
    /duplicate question text/,
  );
  const duplicateGrok = grokFrame('x.ai/ask_user_question');
  duplicateGrok.params.questions.push({ ...duplicateGrok.params.questions[0], id: 'scope-2' });
  assert.throws(() => decodeGrokAskUserQuestionFrame(duplicateGrok), /duplicate question text/);
});
