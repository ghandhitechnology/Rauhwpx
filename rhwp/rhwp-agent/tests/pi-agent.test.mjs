import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import {
  buildPiArgv,
  buildPiEnv,
  createPiSession,
  formatOpenRouterCreditError,
  formatPiExitError,
  isOpenRouterCreditError,
} from '../agents/pi.mjs';

const baseOpts = {
  rootDir: '/tmp/rhwp',
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 6201,
  token: 'secret-token',
  isolatedHome: '/tmp/rhwp isolated home',
  sessionId: 'studio-thread-pi',
  piBin: '/pi/prefix/node_modules/.bin/pi',
  piRoot: '/pi',
  model: 'deepseek/deepseek-chat-v3.1',
  effort: 'high',
  reasoning: true,
  permissionProfile: 'safe',
  onEvent() {},
};

class FakeStream extends EventEmitter {}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode = null;
  signalCode = null;
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    queueMicrotask(() => {
      if (this.signalCode !== null || this.exitCode !== null) return;
      this.signalCode = signal;
      this.emit('exit', null, signal);
    });
    return true;
  }

  /** NDJSON 한 줄씩 흘려보낸다. */
  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  exit(code) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

/** 세션을 만들고 스폰 기록/이벤트 배열을 함께 돌려준다. */
function startSession(extra = {}) {
  const events = [];
  const spawns = [];
  const opts = { ...baseOpts, ...extra, onEvent: (event) => events.push(event) };
  const session = createPiSession(opts, {
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
  });
  return { session, events, spawns, opts };
}

function types(events) {
  return events.map((event) => event.type);
}

// 아래 NDJSON 리터럴은 실제 pi 0.84 json 모드 출력(프로브 캡처)에서 다듬어 옮겼다.
const SESSION_LINE = {
  type: 'session', version: 3, id: '019ffe74-43ec-7b98-9c93-bf9bd338ec62',
  timestamp: '2026-08-14T04:07:40.268Z', cwd: '/tmp/rhwp',
};

const TOOL_USAGE = {
  input: 111, output: 45, cacheRead: 12, cacheWrite: 0, reasoning: 7, totalTokens: 168,
  cost: { input: 0.000111, output: 0.00009, cacheRead: 0.0000012, cacheWrite: 0, total: 0.0002022 },
};

test('a tool-call turn maps to the unified event sequence and settles', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('probe the document');
  const { proc } = spawns[0];

  proc.emitJson(
    SESSION_LINE,
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'probe' }] } },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'probe' }] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Calling the tool. ' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"messa' },
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant', model: 'mock-1', usage: TOOL_USAGE, stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'call_probe_1', name: 'get_structure', arguments: {} }],
      },
    },
    {
      type: 'tool_execution_start',
      toolCallId: 'call_probe_1', toolName: 'get_structure', args: { sectionIdx: 0 },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call_probe_1', toolName: 'get_structure', isError: false,
      result: { content: [{ type: 'text', text: '{"revision":7}' }], details: { revision: 7 } },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '문단 3개를' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' 확인했습니다.' },
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant', model: 'mock-1', usage: TOOL_USAGE, stopReason: 'stop',
        content: [{ type: 'text', text: '문단 3개를 확인했습니다.' }],
      },
    },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled' },
  );
  assert.equal(events.some((event) => event.type === 'turn-end'), false, '프로세스 종료 전에는 턴이 열려 있다');

  proc.exit(0);
  assert.deepEqual(types(events), [
    'turn-start', 'session-info', 'text-delta', 'usage',
    'tool-call', 'tool-result', 'text-delta', 'text-delta', 'usage', 'turn-end',
  ]);

  const sessionInfo = events[1];
  assert.equal(sessionInfo.sessionId, SESSION_LINE.id);
  assert.equal(sessionInfo.model, baseOpts.model);
  assert.equal(session.getSessionId(), SESSION_LINE.id);

  const call = events.find((event) => event.type === 'tool-call');
  assert.deepEqual(
    { tool: call.tool, callId: call.callId, argsJson: call.argsJson },
    { tool: 'get_structure', callId: 'call_probe_1', argsJson: '{"sectionIdx":0}' },
  );
  const result = events.find((event) => event.type === 'tool-result');
  assert.equal(result.ok, true);
  assert.match(result.resultPreview, /revision\\":7/);

  assert.deepEqual(events.find((event) => event.type === 'usage'), {
    type: 'usage',
    agent: 'pi',
    model: baseOpts.model,
    usage: { inputTokens: 111, outputTokens: 45, cacheReadTokens: 12, cacheCreationTokens: 0 },
    costUsd: 0.0002022,
  });
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'pi', stopReason: 'completed' });
  session.dispose();
});

test('rau harness events carry the rau agent name', () => {
  const { session, events, spawns } = startSession({ agentName: 'rau' });
  session.sendUserMessage('probe the document');
  const { proc } = spawns[0];

  proc.emitJson(
    SESSION_LINE,
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '확인했습니다.' },
    },
    { type: 'agent_settled' },
  );
  proc.exit(0);

  assert.ok(events.length > 0);
  for (const event of events) assert.equal(event.agent, 'rau');
  assert.equal(events.at(-1).type, 'turn-end');
  session.dispose();
});

test('thinking deltas stay out of the transcript', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('explain');
  const { proc } = spawns[0];

  proc.emitJson(
    SESSION_LINE,
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Let me think. ' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '답은 42입니다.' },
    },
    { type: 'agent_settled' },
  );
  proc.exit(0);

  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    ['답은 42입니다.'],
  );
  session.dispose();
});

test('a 401 turn exits 0 but ends as failed with the API message', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('say hi');
  const { proc } = spawns[0];

  const errorMessage = '401: {"message":"Incorrect API key provided: test.","code":"invalid_api_key"}';
  const zeroUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  proc.emitJson(
    SESSION_LINE,
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_end',
      message: {
        role: 'assistant', content: [], model: 'mock-1', usage: zeroUsage,
        stopReason: 'error', errorMessage,
      },
    },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled' },
  );
  proc.exit(0);

  // 토큰도 비용도 0 인 턴은 사용량으로 기록하지 않는다.
  assert.deepEqual(events.filter((event) => event.type === 'usage'), []);
  assert.deepEqual(events.find((event) => event.type === 'error'), {
    type: 'error', agent: 'pi', message: errorMessage,
  });
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'pi', stopReason: 'failed', errorMessage,
  });
  session.dispose();
});

test('a startup failure reports the stderr reason without the session token', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('go');
  const { proc } = spawns[0];

  proc.stderr.emit(
    'data',
    'Error: Model "nope/nope" not found. Use --list-models to see available models.\n'
      + 'token=secret-token\nUsage: pi [options]\n',
  );
  proc.exit(1);

  const error = events.find((event) => event.type === 'error');
  assert.match(error.message, /Pi 실행이 중단되었습니다 \(code 1\)/);
  assert.match(error.message, /Model "nope\/nope" not found/);
  assert.doesNotMatch(error.message, /secret-token/);
  assert.doesNotMatch(error.message, /^Usage:/m);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'pi', stopReason: 'exited' });
  session.dispose();
});

test('formatPiExitError redacts key-shaped strings and falls back without stderr', () => {
  assert.match(
    formatPiExitError('401 sk-or-v1-0123456789abcdef bad key', 1, null, ''),
    /\[redacted\] bad key/,
  );
  assert.equal(
    formatPiExitError('', null, 'SIGKILL', 'tok'),
    'Pi 실행이 중단되었습니다 (signal SIGKILL). Pi가 오류 설명을 제공하지 않았습니다.',
  );
});

test('OpenRouter 402 blocks a Rau turn with the empty-credit copy', () => {
  assert.equal(isOpenRouterCreditError('OpenRouter 402 Payment Required'), true);
  assert.equal(
    formatOpenRouterCreditError('HTTP 402: insufficient credits', 'rau'),
    'Rau 체험 크레딧이 다 됐어요. 다른 모델을 연결해 주세요.',
  );
  assert.match(
    formatPiExitError('402 Payment Required: out of credits', 1, null, '', 'rau'),
    /체험 크레딧이 다 됐어요/,
  );
});

test('interrupt kills the child and closes the turn once', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('long task');
  const { proc } = spawns[0];
  proc.emitJson(SESSION_LINE, {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'thinking slowly' },
  });

  session.interrupt();
  assert.deepEqual(proc.signals, ['SIGTERM']);
  const ends = events.filter((event) => event.type === 'turn-end');
  assert.deepEqual(ends, [{ type: 'turn-end', agent: 'pi', stopReason: 'interrupted' }]);

  // 뒤늦게 도착한 종료 이벤트가 턴을 다시 닫지 않는다.
  proc.exit(0);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  session.dispose();
});

test('argv carries the model, thinking level, session and system brief', () => {
  const argv = buildPiArgv({ ...baseOpts, workflow: 'direct', phase: 'implementing' }, 'sess-1');
  assert.deepEqual(argv.slice(0, 6), [
    '--mode', 'json', '--model', 'openrouter/deepseek/deepseek-chat-v3.1', '--thinking', 'high',
  ]);
  assert.equal(argv[argv.indexOf('--session-dir') + 1], path.join('/pi', 'sessions'));
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'sess-1');
  assert.match(argv[argv.indexOf('--append-system-prompt') + 1], /rhwp MCP tools/);
  assert.ok(argv.includes('--no-context-files'));
  assert.equal(argv.includes('--exclude-tools'), false);
});

test('argv omits thinking for non-reasoning models and never doubles the provider prefix', () => {
  const argv = buildPiArgv(
    { ...baseOpts, reasoning: false, model: 'openrouter/moonshotai/kimi-k2' },
    'sess-1',
  );
  assert.equal(argv[argv.indexOf('--model') + 1], 'openrouter/moonshotai/kimi-k2');
  assert.equal(argv.includes('--thinking'), false);
});

test('pi gets its own sequential brief instead of claude fleet instructions', () => {
  // 미지정 agentName 은 클로드 기본 브리프를 낳아 없는 doc-editor 스폰을
  // 지시했다 — pi 는 스폰 도구가 없으므로 단독 실행 규율이 와야 한다.
  for (const mode of [
    { workflow: 'direct', phase: 'implementing' },
    { workflow: 'plan', phase: 'implementing' },
  ]) {
    const argv = buildPiArgv({ ...baseOpts, ...mode }, 'sess-1');
    const brief = argv[argv.indexOf('--append-system-prompt') + 1];
    assert.doesNotMatch(brief, /doc-editor|doc-researcher|Workflow tool|Sibling agents/, mode.phase);
    assert.match(brief, /no subagent or delegation tools/, mode.phase);
    assert.match(brief, /ONE apply_edits call/, mode.phase);
  }
});

test('planning phases exclude the built-in write and shell tools', () => {
  for (const phase of ['planning', 'awaiting-approval', 'switching']) {
    const argv = buildPiArgv({ ...baseOpts, workflow: 'plan', phase }, 'sess-1');
    assert.equal(argv[argv.indexOf('--exclude-tools') + 1], 'bash,edit,write', phase);
    assert.match(argv[argv.indexOf('--append-system-prompt') + 1], /planning mode|implementation mode/);
  }
  const implementing = buildPiArgv({ ...baseOpts, workflow: 'plan', phase: 'implementing' }, 'x');
  assert.equal(implementing.includes('--exclude-tools'), false);
  assert.match(implementing[implementing.indexOf('--append-system-prompt') + 1], /implementation mode/);
});

test('the child env is built from scratch without ambient provider keys', () => {
  const sourceEnv = {
    PATH: '/usr/bin',
    HOME: '/Users/tester',
    OPENROUTER_API_KEY: 'sk-or-v1-leak',
    ANTHROPIC_API_KEY: 'sk-ant-leak',
    GEMINI_API_KEY: 'leak',
    AWS_SECRET_ACCESS_KEY: 'leak',
  };
  const env = buildPiEnv({ ...baseOpts, workflow: 'plan', phase: 'planning', capabilityEpoch: 4 }, sourceEnv);

  assert.equal(Object.keys(env).some((name) => /API_KEY|SECRET/.test(name)), false);
  assert.deepEqual(env.PATH, '/usr/bin');
  assert.equal(env.PI_CODING_AGENT_DIR, path.join('/pi', 'agent'));
  assert.equal(env.PI_OFFLINE, '1');
  assert.equal(env.HOME, '/tmp/rhwp isolated home');
  assert.equal(env.USERPROFILE, '/tmp/rhwp isolated home');
  assert.equal(env.RHWP_SESSION_ID, 'studio-thread-pi');
  assert.equal(env.RHWP_WS_URL, 'ws://127.0.0.1:6201/mcp');
  assert.equal(env.RHWP_HUB_HTTP, 'http://127.0.0.1:6201');
  assert.equal(env.RHWP_AGENT_NAME, 'pi');
  assert.equal(env.RHWP_AGENT_TOKEN, 'secret-token');
  assert.equal(env.RHWP_ROOT_DIR, '/tmp/rhwp');
  assert.equal(env.RHWP_PERMISSION_PROFILE, 'safe');
  assert.equal(env.RHWP_TOOL_PROFILE, 'planning');
  assert.equal(env.RHWP_AGENT_WORKFLOW, 'plan');
  assert.equal(env.RHWP_AGENT_PHASE, 'planning');
  assert.equal(env.RHWP_CAPABILITY_EPOCH, '4');

  assert.equal(buildPiEnv({ ...baseOpts }, sourceEnv).RHWP_TOOL_PROFILE, 'direct');
  assert.equal(
    buildPiEnv({ ...baseOpts, workflow: 'plan', phase: 'implementing' }, sourceEnv).RHWP_TOOL_PROFILE,
    'implementing',
  );
});

test('the selected vault key is passed only when the Pi session explicitly provides it', () => {
  const env = buildPiEnv({ ...baseOpts, openRouterApiKey: 'sk-or-v1-vault' }, { PATH: '/usr/bin' });
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-v1-vault');
});

test('the prompt is the last argv entry and stdin stays closed', () => {
  const { session, spawns } = startSession();
  session.sendUserMessage('문서를 정리해 줘');
  const { command, argv, options } = spawns[0];

  assert.equal(command, baseOpts.piBin);
  assert.equal(argv.at(-1), '문서를 정리해 줘');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.cwd, baseOpts.rootDir);
  assert.equal(options.detached, process.platform !== 'win32');
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.HOME, baseOpts.isolatedHome);
  assert.equal(options.env.USERPROFILE, baseOpts.isolatedHome);
  assert.equal(options.env.RHWP_SESSION_ID, baseOpts.sessionId);
  session.dispose();
});

test('a prompt starting with a dash is not parsed as a flag', () => {
  const { session, spawns } = startSession();
  session.sendUserMessage('--help 문단을 지워 줘');
  assert.equal(spawns[0].argv.at(-1), ' --help 문단을 지워 줘');
  session.dispose();
});

test('a mode switch waits for the running child to exit', async () => {
  const { session, opts, spawns } = startSession();
  session.sendUserMessage('go');
  const { proc } = spawns[0];
  proc.emitJson({ type: 'agent_settled' });

  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 }),
    /only change between turns/,
  );
  proc.exit(0);
  await session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 3 });
  assert.deepEqual(
    [opts.workflow, opts.phase, opts.capabilityEpoch],
    ['plan', 'implementing', 3],
  );

  session.sendUserMessage('approved kickoff');
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].argv.includes('--exclude-tools'), false);
  assert.equal(spawns[1].options.env.RHWP_AGENT_PHASE, 'implementing');
  assert.equal(spawns[1].argv[spawns[1].argv.indexOf('--session-id') + 1], session.getSessionId());
  session.dispose();
});
