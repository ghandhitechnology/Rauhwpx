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

test('Claude session selects the persistent SDK stream when native user input is available', async () => {
  const events = [];
  const prompts = [];
  let capturedOptions;
  const queryAgent = ({ prompt, options }) => {
    capturedOptions = options;
    const query = (async function* () {
      for await (const message of prompt) {
        prompts.push(message);
        yield { type: 'system', subtype: 'init', session_id: options.sessionId, model: 'claude-test' };
        yield { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' };
      }
    })();
    query.close = () => {};
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
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prompts[0].message.content[0].text, 'Choose a runtime');
  assert.equal(prompts[0].parent_tool_use_id, null);
  assert.ok(capturedOptions.tools.includes('AskUserQuestion'));
  assert.deepEqual(events.map((event) => event.type), ['turn-start', 'session-info', 'turn-end']);
  await session.dispose();
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
