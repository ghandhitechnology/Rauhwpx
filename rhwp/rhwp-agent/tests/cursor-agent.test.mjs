import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCursorArgv,
  buildCursorCliConfig,
  buildCursorMcpConfig,
  createCursorSession,
  flushCursorCredentialMirrors,
  formatCursorExitError,
  prepareCursorHome,
} from '../agents/cursor.mjs';

const baseOpts = {
  rootDir: '/tmp/rhwp',
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 6401,
  token: 'secret-token',
  sessionId: 'studio-thread-cursor',
  model: 'auto',
  effort: null,
  permissionProfile: 'safe',
  onEvent() {},
};

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

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
      this.emit('close', null, signal);
    });
    return true;
  }

  /** NDJSON 한 줄씩 흘려보낸다. */
  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  /** 실제 프로세스처럼 exit 뒤 close 까지 낸다. */
  exit(code) {
    this.exitOnly(code);
    this.close(code);
  }

  /** stdout 꼬리가 아직 남은 상태의 종료를 흉내 낸다. */
  exitOnly(code) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  close(code) {
    this.emit('close', code ?? this.exitCode, null);
  }
}

const PROVEN_TREE_CLEANUP = {
  terminateProcess: (child) => child.kill('SIGTERM'),
  waitForExit: async () => true,
};

/** 세션을 만들고 스폰 기록/이벤트 배열과 임시 격리 홈을 함께 돌려준다. */
function startSession(t, extra = {}, dependencies = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const spawns = [];
  const opts = {
    ...baseOpts,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    cursorSourceDir: path.join(root, 'source', '.cursor'),
    ...extra,
    onEvent: (event) => events.push(event),
  };
  const session = createCursorSession(opts, {
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
    ...dependencies,
  });
  return { session, events, spawns, opts, root };
}

function types(events) {
  return events.map((event) => event.type);
}

const INIT_LINE = {
  type: 'system', subtype: 'init',
  session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  model: 'gpt-5.2', permissionMode: 'default',
};

/** agent.v1.McpArgs 직렬화 형태 — 기본값 필드까지 전부 실린다. */
const MCP_ARGS = {
  name: 'mcp__rhwp__get_structure',
  args: { sectionIdx: 0 },
  toolCallId: '',
  providerIdentifier: '',
  toolName: 'get_structure',
  smartModeApprovalOnly: false,
  skipApproval: false,
  serverIdentifier: '',
};

test('argv streams JSON, auto-approves MCP servers and omits --model for auto', () => {
  const argv = buildCursorArgv({ ...baseOpts }, null, 'prompt text');
  assert.deepEqual(argv, [
    '-p', '--output-format', 'stream-json', '--stream-partial-output', '--approve-mcps',
    '--', 'prompt text',
  ]);
});

test('argv carries an explicit model, the resume chat id and --force only when unrestricted', () => {
  const argv = buildCursorArgv(
    { ...baseOpts, model: 'gpt-5.2', permissionProfile: 'unrestricted' },
    'chat-1',
    '-leading dash prompt',
  );
  assert.deepEqual(argv.slice(-2), ['--', '-leading dash prompt'], '`--` 뒤라 대시 프롬프트도 안전하다');
  assert.deepEqual(argv.slice(5, 9), ['--model', 'gpt-5.2', '--resume', 'chat-1']);
  assert.ok(argv.includes('--force'));
  // 계획 단계에서는 unrestricted 라도 --force 를 붙이지 않는다.
  const planning = buildCursorArgv(
    { ...baseOpts, permissionProfile: 'unrestricted', workflow: 'plan', phase: 'planning' },
    null, 'p',
  );
  assert.equal(planning.includes('--force'), false);
  assert.equal(argValue(planning, '--mode'), 'plan');

  const build = buildCursorArgv(
    { ...baseOpts, permissionProfile: 'safe', workflow: 'plan', phase: 'implementing' },
    null, 'p',
  );
  assert.equal(build.includes('--mode'), false);
});

test('cli-config merges the source file and overwrites permissions per profile', () => {
  const source = {
    someToken: 'keep-me',
    permissions: { allow: ['Shell(ls)'], deny: ['Read(/etc/**)'] },
    approvalMode: 'allowlist',
    sandbox: { mode: 'disabled', networkAccess: 'user_config_with_defaults' },
  };
  const safe = buildCursorCliConfig({ ...baseOpts }, source);
  assert.equal(safe.someToken, 'keep-me');
  assert.equal(safe.approvalMode, 'allowlist');
  assert.deepEqual(safe.permissions, {
    allow: ['Read(**)', 'Write(/tmp/rhwp/**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(rhwp:*)'],
    deny: [],
  });
  assert.equal(safe.sandbox.mode, 'enabled');
  assert.equal(safe.sandbox.networkAccess, 'user_config_with_defaults');

  const planning = buildCursorCliConfig({ ...baseOpts, workflow: 'plan', phase: 'planning' }, source);
  assert.equal(planning.permissions.allow.some((rule) => rule.startsWith('Write(')), false);
  assert.deepEqual(planning.permissions.deny, ['Write(**)']);
  assert.equal(planning.sandbox.mode, 'enabled');

  const worker = buildCursorCliConfig({
    ...baseOpts,
    toolProfile: 'copy-layout-worker',
    readOnlyRoots: ['/private/snapshot', '/private/generated'],
  }, source);
  assert.deepEqual(worker.permissions, {
    allow: [
      'Read(/tmp/rhwp/**)',
      'Read(/private/snapshot/**)',
      'Read(/private/generated/**)',
      'Mcp(rhwp:*)',
    ],
    deny: ['Write(**)'],
  });
  assert.equal(worker.permissions.allow.includes('Read(**)'), false);
  assert.equal(worker.sandbox.mode, 'enabled');

  const unrestricted = buildCursorCliConfig({ ...baseOpts, permissionProfile: 'unrestricted' }, source);
  assert.equal(unrestricted.approvalMode, 'unrestricted');
  assert.deepEqual(unrestricted.permissions, { allow: [], deny: [] });
  assert.equal(unrestricted.sandbox.mode, 'disabled');
});

test('the session cursor home is seeded with links and authored config files', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-home-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCursorDir = path.join(root, 'source', '.cursor');
  mkdirSync(sourceCursorDir, { recursive: true });
  writeFileSync(path.join(sourceCursorDir, 'auth-token.json'), '{"token":"persist"}');
  writeFileSync(path.join(sourceCursorDir, 'cli-config.json'), '{"someToken":"keep"}');
  writeFileSync(path.join(sourceCursorDir, 'mcp.json'), '{"mcpServers":{}}');
  const sessionCursorDir = path.join(root, 'home', '.cursor');

  const opts = { ...baseOpts, capabilityEpoch: 3 };
  prepareCursorHome(sessionCursorDir, sourceCursorDir, {
    mcpConfig: buildCursorMcpConfig(opts),
    cliConfig: buildCursorCliConfig(opts, { someToken: 'keep' }),
  });

  assert.equal(lstatSync(path.join(sessionCursorDir, 'auth-token.json')).isSymbolicLink(), true);
  assert.equal(lstatSync(path.join(sessionCursorDir, 'mcp.json')).isSymbolicLink(), false, 'mcp.json 은 링크가 아니라 저작본이다');
  const mcp = JSON.parse(readFileSync(path.join(sessionCursorDir, 'mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.rhwp.env.RHWP_AGENT_NAME, 'cursor');
  assert.equal(mcp.mcpServers.rhwp.env.RHWP_WS_URL, 'ws://127.0.0.1:6401/mcp');
  assert.equal(mcp.mcpServers.rhwp.env.RHWP_AGENT_TOKEN, 'secret-token');
  assert.equal(mcp.mcpServers.rhwp.env.RHWP_CAPABILITY_EPOCH, '3');
  const cli = JSON.parse(readFileSync(path.join(sessionCursorDir, 'cli-config.json'), 'utf8'));
  assert.equal(cli.someToken, 'keep');
  assert.equal(cli.approvalMode, 'allowlist');

  // 원본이 아예 없어도 조용히 저작만 한다.
  const bare = path.join(root, 'bare', '.cursor');
  prepareCursorHome(bare, path.join(root, 'missing'), { mcpConfig: buildCursorMcpConfig(opts) });
  assert.equal(existsSync(path.join(bare, 'mcp.json')), true);
});

test('Windows Cursor copy fallback journals refreshed credentials for copyback', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-copyback-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCursorDir = path.join(root, 'source', '.cursor');
  const sessionCursorDir = path.join(root, 'isolated', '.cursor');
  const source = path.join(sourceCursorDir, 'auth-token.json');
  const target = path.join(sessionCursorDir, 'auth-token.json');
  mkdirSync(sourceCursorDir, { recursive: true });
  writeFileSync(source, '{"token":"shared"}');

  const windowsDeps = {
    platform: 'win32',
    symlink() {
      const error = new Error('symlinks require elevation');
      error.code = 'EPERM';
      throw error;
    },
  };
  prepareCursorHome(sessionCursorDir, sourceCursorDir, {}, windowsDeps);
  assert.equal(readFileSync(target, 'utf8'), '{"token":"shared"}');
  writeFileSync(target, '{"token":"first-refresh"}');
  prepareCursorHome(sessionCursorDir, sourceCursorDir, {}, windowsDeps);
  assert.equal(readFileSync(source, 'utf8'), '{"token":"first-refresh"}');
  writeFileSync(target, '{"token":"refreshed"}');
  flushCursorCredentialMirrors(sessionCursorDir);
  assert.equal(readFileSync(source, 'utf8'), '{"token":"refreshed"}');
});

test('uncertain Cursor descendant cleanup defers credential copyback', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-uncertain-cleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCursorDir = path.join(root, 'source', '.cursor');
  const isolatedHome = path.join(root, 'isolated');
  const sessionCursorDir = path.join(isolatedHome, '.cursor');
  mkdirSync(sourceCursorDir, { recursive: true });

  const session = createCursorSession({
    ...baseOpts,
    agentRole: 'root',
    isolatedHome,
    cursorSourceDir: sourceCursorDir,
    requestUserInput: async () => ({ status: 'cancelled' }),
  }, {
    createAcpSession(input) {
      return {
        async configure() {
          input.onSessionStarted({ sessionId: 'cursor-uncertain-cleanup', setupResponse: {} });
        },
        async prompt() { return new Promise(() => {}); },
        getSessionId: () => 'cursor-uncertain-cleanup',
        hasSeenPromptUpdate: () => true,
        restart: async () => {},
        cancel: async () => {},
        dispose: async () => false,
      };
    },
  });
  session.sendUserMessage('keep the provider alive');
  await new Promise((resolve) => setImmediate(resolve));

  const source = path.join(sourceCursorDir, 'auth-token.json');
  const target = path.join(sessionCursorDir, 'auth-token.json');
  writeFileSync(source, '{"token":"shared"}');
  prepareCursorHome(sessionCursorDir, sourceCursorDir, {}, {
    platform: 'win32',
    symlink() {
      const error = new Error('symlinks require elevation');
      error.code = 'EPERM';
      throw error;
    },
  });
  writeFileSync(target, '{"token":"provider-refresh"}');

  assert.equal(await session.dispose(), false);
  assert.equal(readFileSync(source, 'utf8'), '{"token":"shared"}');
  assert.equal(readFileSync(target, 'utf8'), '{"token":"provider-refresh"}');

  assert.equal(flushCursorCredentialMirrors(sessionCursorDir), true);
  assert.equal(readFileSync(source, 'utf8'), '{"token":"provider-refresh"}');
});

test('a turn maps init, partial deltas, mcp tool calls and the result line', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('probe the document');
  const { proc } = spawns[0];

  proc.emitJson(
    INIT_LINE,
    // 도구 호출 직전 중복(모델 호출 id 부착) — 건너뛴다.
    { type: 'assistant', message: { content: [{ type: 'text', text: '표를 확인합니다.' }] }, timestamp_ms: 1, model_call_id: 'mc-1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: '표를 ' }] }, timestamp_ms: 2 },
    { type: 'assistant', message: { content: [{ type: 'text', text: '확인합니다.' }] }, timestamp_ms: 3 },
    // McpArgs 래퍼는 기본값 필드를 모두 실어 온다 — 실제 인자는 그 안의 args 다.
    {
      type: 'tool_call', subtype: 'started', call_id: 'call-1',
      tool_call: { mcpToolCall: { args: MCP_ARGS } },
    },
    {
      type: 'tool_call', subtype: 'completed', call_id: 'call-1',
      tool_call: { mcpToolCall: { args: MCP_ARGS, result: { success: { revision: 7 } } } },
    },
    // 마지막 전체 플러시(타임스탬프 없음) — 건너뛴다.
    { type: 'assistant', message: { content: [{ type: 'text', text: '표를 확인합니다.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '표를 확인합니다.', session_id: INIT_LINE.session_id, duration_ms: 10 },
  );
  proc.exit(0);

  assert.deepEqual(types(events), [
    'turn-start', 'session-info', 'text-delta', 'text-delta', 'tool-call', 'tool-result', 'turn-end',
  ]);
  assert.equal(events[1].sessionId, INIT_LINE.session_id);
  assert.equal(events[1].model, 'gpt-5.2');
  assert.equal(session.getSessionId(), INIT_LINE.session_id);
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    ['표를 ', '확인합니다.'],
  );
  const call = events.find((event) => event.type === 'tool-call');
  assert.equal(call.tool, 'get_structure');
  assert.equal(call.callId, 'call-1');
  assert.equal(call.argsJson, '{"sectionIdx":0}');
  const result = events.find((event) => event.type === 'tool-result');
  assert.equal(result.ok, true);
  assert.match(result.resultPreview, /"revision":7/);
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'cursor', stopReason: 'success', errorMessage: undefined,
  });
  session.dispose();
});

test('a result with no streamed deltas replays its text once', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('quick');
  spawns[0].proc.emitJson(
    INIT_LINE,
    { type: 'result', subtype: 'success', is_error: false, result: '바로 끝났습니다.', session_id: INIT_LINE.session_id },
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    ['바로 끝났습니다.'],
  );
  session.dispose();
});

test('a retry flush that replays already-streamed text is dropped, short repeats are not', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('write a paragraph');
  spawns[0].proc.emitJson(
    INIT_LINE,
    { type: 'assistant', message: { content: [{ type: 'text', text: '표를 정리하고 각 열의 너비를 다시 맞추었습니다. ' }] }, timestamp_ms: 1 },
    { type: 'assistant', message: { content: [{ type: 'text', text: '이어서 머리글을 굵게 바꾸겠습니다.' }] }, timestamp_ms: 2 },
    // 재시도 플러시: model_call_id 없이 지금까지의 본문을 그대로 다시 흘린다.
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '표를 정리하고 각 열의 너비를 다시 맞추었습니다. 이어서 머리글을 굵게 바꾸겠습니다.' }] },
      timestamp_ms: 3,
    },
    // 짧은 조각은 정상적으로 반복될 수 있다.
    { type: 'assistant', message: { content: [{ type: 'text', text: '.' }] }, timestamp_ms: 4 },
    { type: 'result', subtype: 'success', is_error: false, result: 'done' },
  );

  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    [
      '표를 정리하고 각 열의 너비를 다시 맞추었습니다. ',
      '이어서 머리글을 굵게 바꾸겠습니다.',
      '.',
    ],
  );
  session.dispose();
});

test('oneof failure results (rejected / permissionDenied) report ok:false', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('edit the file');
  spawns[0].proc.emitJson(
    INIT_LINE,
    {
      type: 'tool_call', subtype: 'completed', call_id: 'w-1',
      tool_call: { writeToolCall: { args: { path: '/etc/hosts' }, result: { rejected: {} } } },
    },
    {
      type: 'tool_call', subtype: 'completed', call_id: 'm-1',
      tool_call: { mcpToolCall: { args: MCP_ARGS, result: { permissionDenied: { reason: 'not allowed' } } } },
    },
    {
      type: 'tool_call', subtype: 'completed', call_id: 'l-1',
      tool_call: { lsToolCall: { args: { path: '/tmp' }, result: { timeout: {} } } },
    },
    { type: 'result', subtype: 'success', is_error: false, result: 'done' },
  );

  assert.deepEqual(
    events.filter((event) => event.type === 'tool-result').map((event) => event.ok),
    [false, false, false],
  );
  session.dispose();
});

test('usage counts cursor cache-write tokens as cache creation', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('go');
  spawns[0].proc.emitJson(
    INIT_LINE,
    {
      type: 'result', subtype: 'success', is_error: false, result: 'done',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 8, cacheWriteTokens: 30 },
    },
  );
  assert.deepEqual(events.find((event) => event.type === 'usage'), {
    type: 'usage', agent: 'cursor', model: 'gpt-5.2',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 8, cacheCreationTokens: 30 },
  });
  session.dispose();
});

test('an oversized prompt fails the turn before spawning', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('가'.repeat(250_000)); // UTF-8 3바이트 × 25만 = 750 KB

  assert.equal(spawns.length, 0, 'CLI 를 아예 띄우지 않는다');
  assert.match(events.find((event) => event.type === 'error').message, /메시지가 너무 커서/);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'cursor', stopReason: 'failed' });
  session.dispose();
});

test('a result line delivered between exit and close still completes the turn', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('read the whole document');
  const { proc } = spawns[0];

  // 'exit' 은 stdout 꼬리가 파싱되기 전에 온다.
  proc.exitOnly(0);
  proc.emitJson(INIT_LINE, { type: 'result', subtype: 'success', is_error: false, result: '끝났습니다.' });
  proc.close(0);

  assert.equal(events.filter((event) => event.type === 'error').length, 0, '성공 턴에 오류를 붙이지 않는다');
  assert.deepEqual(
    events.filter((event) => event.type === 'turn-end'),
    [{ type: 'turn-end', agent: 'cursor', stopReason: 'success', errorMessage: undefined }],
  );
  session.dispose();
});

test('a newline terminal result without close cannot complete a legacy Cursor turn', async (t) => {
  const { session, events, spawns } = startSession(t, {}, {
    closeGraceMs: 5,
    terminateProcess: async () => true,
    waitForExit: async () => true,
  });
  session.sendUserMessage('descendant keeps stdout open');
  const { proc } = spawns[0];

  proc.emitJson(INIT_LINE, {
    type: 'result', subtype: 'success', is_error: false, result: 'must not commit',
  });
  assert.equal(events.some((event) => event.type === 'turn-end'), false);
  proc.exitOnly(0);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    events.some((event) => event.type === 'turn-end' && event.stopReason === 'success'),
    false,
  );
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'cursor', stopReason: 'exited' });
  assert.equal(await session.dispose(), false);
});

test('a clean exit without a result ends the turn quietly', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('go');
  spawns[0].proc.exit(0);

  assert.equal(events.filter((event) => event.type === 'error').length, 0);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'cursor', stopReason: 'exited' });
  session.dispose();
});

test('a Windows Cursor terminal tail without newline drains before unavailable cleanup quarantine', async (t) => {
  const { session, events, spawns } = startSession(t, {}, {
    platform: 'win32',
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });
  session.sendUserMessage('first');
  spawns[0].proc.stdout.emit('data', `${JSON.stringify(INIT_LINE)}\n${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'done',
  })}`);
  spawns[0].proc.exit(0);
  await new Promise((resolve) => setImmediate(resolve));

  session.sendUserMessage('must not spawn');
  assert.equal(spawns.length, 1);
  assert.match(events.findLast((event) => event.type === 'error').message, /cleanup could not be confirmed/);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'cursor', stopReason: 'failed' });
  assert.equal(await session.dispose(), false);
});

test('Windows Cursor settles before live cleanup and permits a proven follow-up turn', async (t) => {
  let cleanupCalls = 0;
  const { session, spawns } = startSession(t, {}, {
    platform: 'win32',
    terminateProcess(proc) {
      assert.equal(proc.exitCode, null);
      assert.equal(proc.signalCode, null);
      cleanupCalls += 1;
      return true;
    },
    waitForExit: async () => true,
  });
  session.sendUserMessage('first');
  spawns[0].proc.emitJson(
    INIT_LINE,
    { type: 'result', subtype: 'success', is_error: false, result: 'done' },
  );
  assert.equal(cleanupCalls, 1);
  spawns[0].proc.exit(0);
  await new Promise((resolve) => setImmediate(resolve));

  session.sendUserMessage('second');
  assert.equal(spawns.length, 2);
  const disposing = session.dispose();
  spawns[1].proc.exit(0);
  assert.equal(await disposing, true);
});

test('error-ish tool results and unknown tool payloads stay defensive', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('go');
  spawns[0].proc.emitJson(
    INIT_LINE,
    {
      type: 'tool_call', subtype: 'started', call_id: 'sh-1',
      tool_call: { shellToolCall: { args: { command: 'ls' } } },
    },
    {
      type: 'tool_call', subtype: 'completed', call_id: 'sh-1',
      tool_call: { shellToolCall: { args: { command: 'ls' }, result: { error: 'denied' } } },
    },
    { type: 'result', subtype: 'success', is_error: false, result: 'done' },
  );
  const call = events.find((event) => event.type === 'tool-call');
  assert.equal(call.tool, 'shell');
  const result = events.find((event) => event.type === 'tool-result');
  assert.equal(result.ok, false);
  session.dispose();
});

test('the system brief is prepended except when resuming a direct-workflow chat', async (t) => {
  const { session, spawns } = startSession(t, {}, PROVEN_TREE_CLEANUP);
  session.sendUserMessage('첫 요청');
  assert.match(spawns[0].argv.at(-1), /rhwp MCP tools/);
  assert.match(spawns[0].argv.at(-1), /첫 요청$/);
  assert.equal(spawns[0].argv.includes('--resume'), false);

  spawns[0].proc.emitJson(INIT_LINE, { type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  spawns[0].proc.exit(0);

  session.sendUserMessage('이어지는 요청');
  await new Promise((resolve) => setImmediate(resolve));
  const second = spawns[1].argv;
  assert.equal(second[second.indexOf('--resume') + 1], INIT_LINE.session_id);
  assert.equal(second.at(-1), '이어지는 요청', '재개 턴에는 브리핑을 다시 붙이지 않는다');
  session.dispose();
});

test('the brief carries the cursor parallel-work section, not the claude one', (t) => {
  const { session, spawns } = startSession(t);
  session.sendUserMessage('두 곳을 나눠 고쳐 줘');
  const prompt = spawns[0].argv.at(-1);
  assert.match(prompt, /PARALLEL WORK:/);
  assert.match(prompt, /delegate to subagents/);
  // claude 전용 문구(Workflow 도구, --agents 로 심는 이름)는 붙지 않는다.
  assert.doesNotMatch(prompt, /Workflow tool/);
  assert.doesNotMatch(prompt, /spawn_subagent/);
  session.dispose();
});

test('the spawn env keeps HOME on the isolated home and authors the session cursor dir', (t) => {
  const { session, spawns, opts, root } = startSession(t, {
    // 운영자 셸이 내보낸 값이 그대로 상속되는 상황을 흉내 낸다.
    providerEnv: { PATH: '/usr/bin', CURSOR_CONFIG_DIR: '/operator/.cursor' },
  });
  mkdirSync(opts.cursorSourceDir, { recursive: true });
  writeFileSync(path.join(opts.cursorSourceDir, 'cli-config.json'), '{"someToken":"persisted"}');

  session.sendUserMessage('go');
  const { command, options } = spawns[0];
  assert.equal(command, 'cursor-agent');
  assert.equal(options.env.HOME, opts.isolatedHome);
  assert.equal(options.env.USERPROFILE, opts.isolatedHome);
  assert.equal(
    options.env.CURSOR_CONFIG_DIR, undefined,
    '상속된 CURSOR_CONFIG_DIR 은 HOME 격리를 덮어쓰므로 반드시 지운다',
  );
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);

  const sessionCursorDir = path.join(root, 'home', '.cursor');
  const cli = JSON.parse(readFileSync(path.join(sessionCursorDir, 'cli-config.json'), 'utf8'));
  assert.equal(cli.someToken, 'persisted', '영속 홈의 설정 필드를 보존한다');
  assert.equal(existsSync(path.join(sessionCursorDir, 'mcp.json')), true);
  session.dispose();
});

test('an oversized persistent Cursor config is ignored before spawning', (t) => {
  const { session, opts, root } = startSession(t);
  mkdirSync(opts.cursorSourceDir, { recursive: true });
  writeFileSync(
    path.join(opts.cursorSourceDir, 'cli-config.json'),
    JSON.stringify({ someToken: 'x'.repeat(1024 * 1024) }),
  );

  session.sendUserMessage('go');
  const cli = JSON.parse(readFileSync(path.join(root, 'home', '.cursor', 'cli-config.json'), 'utf8'));
  assert.equal(cli.someToken, undefined);
  session.dispose();
});

test('an authentication failure surfaces the stderr text with the token redacted', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('go');
  const { proc } = spawns[0];

  proc.stderr.emit(
    'data',
    "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\ntoken=secret-token\n",
  );
  proc.exit(1);

  const error = events.find((event) => event.type === 'error');
  assert.match(error.message, /Cursor 실행이 중단되었습니다 \(code 1\)/);
  assert.match(error.message, /Authentication required/);
  assert.doesNotMatch(error.message, /secret-token/);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'cursor', stopReason: 'exited' });
  session.dispose();
});

test('formatCursorExitError falls back to a plain message without stderr', () => {
  assert.equal(
    formatCursorExitError('', null, 'SIGKILL', 'tok'),
    'Cursor 실행이 중단되었습니다 (signal SIGKILL). Cursor가 오류 설명을 제공하지 않았습니다.',
  );
});

test('native ACP MCP question calls emit the canonical root-scope ticket', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-acp-question-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  let onSessionUpdate;
  const native = createCursorSession({
    ...baseOpts,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    requestUserInput: async () => ({ status: 'cancelled' }),
    onEvent: (event) => events.push(event),
  }, {
    createAcpSession(input) {
      onSessionUpdate = input.onSessionUpdate;
      return {
        async configure() {
          input.onSessionStarted({ sessionId: 'cursor-acp-question', setupResponse: {} });
        },
        async prompt() {
          onSessionUpdate({
            sessionUpdate: 'tool_call',
            toolCallId: 'q-1',
            kind: 'mcp',
            title: 'Ask the user',
          });
          onSessionUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'q-1',
            name: 'mcp__rhwp__ask_user_question',
            rawInput: {
              name: 'mcp__rhwp__ask_user_question',
              args: {
                questions: [{
                  id: 'format',
                  header: 'Format',
                  question: 'Which format should I use?',
                  options: [
                    { label: 'Brief', description: 'Keep it compact.' },
                    { label: 'Detailed', description: 'Include supporting detail.' },
                  ],
                }],
              },
              toolName: 'ask_user_question',
            },
          });
          return { stopReason: 'end_turn' };
        },
        getSessionId: () => 'cursor-acp-question',
        hasSeenPromptUpdate: () => true,
        restart: async () => {},
        cancel: async () => {},
        dispose: async () => true,
      };
    },
  });
  t.after(() => native.dispose());

  native.sendUserMessage('ask first');
  await new Promise((resolve) => setImmediate(resolve));
  const calls = events.filter((event) => event.type === 'tool-call');
  assert.deepEqual(calls.map((event) => event.tool), ['ask_user_question']);
  assert.deepEqual(JSON.parse(calls[0].argsJson).questions[0].id, 'format');
});

test('native ACP keeps one Cursor session across turns and streams through unified events', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-native-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let createCount = 0;
  let config;
  const configureCalls = [];
  let restarts = 0;
  const prompts = [];
  const events = [];
  const native = createCursorSession({
    ...baseOpts,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    requestUserInput: async () => ({ status: 'cancelled' }),
    onEvent: (event) => events.push(event),
  }, {
    createAcpSession(input) {
      createCount += 1;
      config = input;
      let started = false;
      return {
        async configure(options) {
          configureCalls.push(options);
          if (!started) {
            started = true;
            input.onSessionStarted({ sessionId: 'cursor-acp-1', setupResponse: {} });
          }
        },
        async prompt(text) {
          prompts.push(text);
          input.onSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
          return { stopReason: 'end_turn' };
        },
        getSessionId: () => 'cursor-acp-1',
        hasSeenPromptUpdate: () => true,
        restart: async () => {
          await new Promise((resolve) => setImmediate(resolve));
          restarts += 1;
        },
        cancel: async () => {}, dispose: async () => {},
      };
    },
  });
  t.after(() => native.dispose());

  native.sendUserMessage('one');
  await new Promise((resolve) => setImmediate(resolve));
  native.sendUserMessage('two');
  await new Promise((resolve) => setImmediate(resolve));
  const permissionChange = native.setPermissionProfile('unrestricted');
  assert.equal(restarts, 0);
  await permissionChange;
  assert.equal(restarts, 1, 'permission ACK waits for the native restart');
  await native.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 });
  assert.deepEqual(configureCalls.at(-1).modeAliases, ['plan', 'architect'], 'Plan ACK waits for ACP mode selection');
  native.sendUserMessage('three');
  await new Promise((resolve) => setImmediate(resolve));
  await native.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 3 });
  native.sendUserMessage('four');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(createCount, 1);
  assert.equal(config.args[0], 'acp');
  assert.equal(config.isolatePrompts, true);
  assert.equal(config.requestHandlers[0].method, 'cursor/ask_question');
  assert.match(prompts[0], /one/);
  assert.equal(prompts[1], 'two');
  assert.match(prompts[2], /three/);
  assert.match(prompts[3], /four/);
  assert.deepEqual(configureCalls.map((call) => call.modeAliases), [
    ['agent', 'code', 'default'],
    ['agent', 'code', 'default'],
    ['plan', 'architect'],
    ['plan', 'architect'],
    ['agent', 'code', 'default'],
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'text-delta').map((event) => event.text), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(events.filter((event) => event.type === 'session-info').length, 1);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 4);
  assert.equal(restarts, 4);
});

test('Cursor rejects Plan before ACK when ACP cannot prove the mode', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-plan-readiness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const opts = {
    ...baseOpts,
    workflow: 'direct',
    phase: 'implementing',
    capabilityEpoch: 1,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    requestUserInput: async () => ({ status: 'cancelled' }),
  };
  let disposed = 0;
  const session = createCursorSession(opts, {
    createAcpSession() {
      return {
        configure: async () => { throw new Error('Cursor ACP does not advertise required mode (plan, architect)'); },
        getSessionId: () => 'cursor-unproved-plan',
        dispose: async () => { disposed += 1; },
      };
    },
  });
  t.after(() => session.dispose());

  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 }),
    /does not advertise required mode/,
  );
  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 3 }),
    /cleanup remains unconfirmed/,
  );
  assert.deepEqual([opts.workflow, opts.phase, opts.capabilityEpoch], ['direct', 'implementing', 1]);
  assert.equal(disposed, 1);
});

test('Cursor ACP startup failure falls back before any native provider event', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-fallback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const fallbackSpawns = [];
  const fallback = createCursorSession({
    ...baseOpts,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    requestUserInput: async () => ({ status: 'cancelled' }),
    onEvent: (event) => events.push(event),
  }, {
    createAcpSession() {
      return {
        configure: async () => { throw new Error('Authentication required'); },
        hasSeenPromptUpdate: () => false,
        dispose: async () => true,
      };
    },
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      fallbackSpawns.push({ command, argv, options, proc });
      return proc;
    },
  });
  t.after(() => fallback.dispose());

  fallback.sendUserMessage('fallback');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fallbackSpawns.length, 1);
  assert.deepEqual(types(events), ['turn-start']);
  fallbackSpawns[0].proc.emitJson(INIT_LINE, { type: 'result', subtype: 'success', result: 'ok' });
  assert.equal(events.filter((event) => event.type === 'session-info').length, 1);
});

test('Cursor rolls provider state back when an acknowledged restart fails', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-restart-rollback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const opts = {
    ...baseOpts,
    workflow: 'direct',
    phase: 'implementing',
    capabilityEpoch: 1,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    requestUserInput: async () => ({ status: 'cancelled' }),
  };
  const session = createCursorSession(opts, {
    createAcpSession() {
      return {
        configure: async () => {},
        prompt: async () => ({ stopReason: 'end_turn' }),
        getSessionId: () => 'cursor-rollback',
        restart: async () => { throw new Error('restart rejected'); },
        dispose: async () => {},
      };
    },
  });
  t.after(() => session.dispose());
  session.sendUserMessage('start native');
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(session.setPermissionProfile('unrestricted'), /restart rejected/);
  assert.equal(opts.permissionProfile, 'safe');
  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 }),
    /restart rejected/,
  );
  assert.deepEqual([opts.workflow, opts.phase, opts.capabilityEpoch], ['direct', 'implementing', 1]);
});

test('Cursor never switches transports after the native prompt starts', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-atomic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  let legacySpawns = 0;
  const session = createCursorSession({
    ...baseOpts,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    requestUserInput: async () => ({ status: 'cancelled' }),
    onEvent: (event) => events.push(event),
  }, {
    createAcpSession() {
      return {
        configure: async () => {},
        getSessionId: () => 'cursor-native-atomic',
        prompt: async () => { throw new Error('native question failed'); },
        dispose: async () => {},
      };
    },
    spawnProcess() { legacySpawns += 1; return new FakeProcess(); },
  });
  t.after(() => session.dispose());

  session.sendUserMessage('one transport only');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(legacySpawns, 0);
  assert.equal(events.filter((event) => event.type === 'turn-end').at(-1)?.stopReason, 'failed');
});

test('Cursor does not advertise the next turn until interrupted ACP teardown finishes', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-native-turn-barrier-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  let prompts = 0;
  let releaseFirstPrompt = () => {};
  let markFirstPromptStarted = () => {};
  const firstPromptStarted = new Promise((resolve) => { markFirstPromptStarted = resolve; });
  const firstPrompt = new Promise((resolve) => {
    releaseFirstPrompt = () => resolve({ stopReason: 'cancelled' });
  });
  const session = createCursorSession({
    ...baseOpts,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    requestUserInput: async () => ({ status: 'cancelled' }),
    onEvent: (event) => events.push(event),
  }, {
    createAcpSession() {
      return {
        configure: async () => {},
        getSessionId: () => 'cursor-turn-barrier',
        async prompt() {
          prompts += 1;
          if (prompts === 1) {
            markFirstPromptStarted();
            return firstPrompt;
          }
          return { stopReason: 'end_turn' };
        },
        isCleanupUncertain: () => false,
        cancel: async () => {},
        dispose: async () => true,
      };
    },
  });
  t.after(() => session.dispose());

  session.sendUserMessage('first');
  await firstPromptStarted;
  session.interrupt();
  session.sendUserMessage('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts, 1);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);

  releaseFirstPrompt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts, 2);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 2);
  assert.equal(events.filter((event) => event.type === 'turn-end').at(-1)?.stopReason, 'end_turn');
});

test('Cursor never sends a stale ACP prompt after interrupt or dispose during configure', async (t) => {
  for (const action of ['interrupt', 'dispose']) {
    await t.test(action, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), `rhwp-cursor-configure-${action}-`));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      let releaseConfigure = () => {};
      let markConfigureStarted = () => {};
      const configureGate = new Promise((resolve) => { releaseConfigure = resolve; });
      const configureStarted = new Promise((resolve) => { markConfigureStarted = resolve; });
      let prompts = 0;
      const session = createCursorSession({
        ...baseOpts,
        agentRole: 'root',
        isolatedHome: path.join(root, 'home'),
        requestUserInput: async () => ({ status: 'cancelled' }),
      }, {
        createAcpSession() {
          return {
            async configure() {
              markConfigureStarted();
              await configureGate;
            },
            getSessionId: () => 'cursor-stale-configure',
            prompt: async () => { prompts += 1; return { stopReason: 'end_turn' }; },
            cancel: async () => {},
            dispose: async () => true,
          };
        },
      });

      session.sendUserMessage('must not be sent');
      await configureStarted;
      const disposing = action === 'dispose' ? session.dispose() : null;
      if (action === 'interrupt') session.interrupt();
      releaseConfigure();
      await new Promise((resolve) => setImmediate(resolve));
      if (disposing) await disposing;
      else await session.dispose();
      assert.equal(prompts, 0);
    });
  }
});

test('Cursor tracks deferred failed ACP startup cleanup across interrupt and dispose', async (t) => {
  for (const action of ['interrupt', 'dispose']) {
    await t.test(action, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), `rhwp-cursor-deferred-cleanup-${action}-`));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const events = [];
      let legacySpawns = 0;
      let cleanupCalls = 0;
      let releaseCleanup = () => {};
      let markCleanupStarted = () => {};
      const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
      const cleanupStarted = new Promise((resolve) => { markCleanupStarted = resolve; });
      const session = createCursorSession({
        ...baseOpts,
        agentRole: 'root',
        isolatedHome: path.join(root, 'home'),
        requestUserInput: async () => ({ status: 'cancelled' }),
        onEvent: (event) => events.push(event),
      }, {
        createAcpSession() {
          return {
            configure: async () => { throw new Error('ACP startup failed'); },
            async dispose() {
              cleanupCalls += 1;
              markCleanupStarted();
              await cleanupGate;
              return false;
            },
          };
        },
        spawnProcess() {
          legacySpawns += 1;
          return new FakeProcess();
        },
      });

      session.sendUserMessage('start');
      await cleanupStarted;

      if (action === 'interrupt') {
        session.interrupt();
        session.sendUserMessage('must remain quarantined');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(legacySpawns, 0);
        assert.match(events.find((event) => event.type === 'error')?.message ?? '', /cleanup remains unconfirmed/);
        releaseCleanup();
        await new Promise((resolve) => setImmediate(resolve));
        session.sendUserMessage('must stay quarantined after cleanup fails');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(events.filter((event) => event.type === 'error').length, 2);
        assert.equal(await session.dispose(), false);
      } else {
        let disposeSettled = false;
        const disposing = session.dispose().then((cleaned) => {
          disposeSettled = true;
          return cleaned;
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(disposeSettled, false, 'dispose must wait for the detached ACP cleanup');
        releaseCleanup();
        assert.equal(await disposing, false);
      }

      assert.equal(cleanupCalls, 1);
      assert.equal(legacySpawns, 0);
    });
  }
});

test('Cursor disposal fences native configuration before accepting cleanup proof', async (t) => {
  await t.test('same-tick disposal prevents late native-session creation', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-same-tick-dispose-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let creates = 0;
    const session = createCursorSession({
      ...baseOpts,
      agentRole: 'root',
      isolatedHome: path.join(root, 'home'),
      requestUserInput: async () => ({ status: 'cancelled' }),
    }, {
      createAcpSession() {
        creates += 1;
        return {
          configure: async () => {},
          getSessionId: () => 'cursor-too-late',
          dispose: async () => true,
        };
      },
    });

    session.sendUserMessage('do not start after disposal');
    assert.equal(await session.dispose(), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(creates, 0);
  });

  await t.test('in-flight configuration and its failed cleanup are awaited', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-configure-dispose-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let releaseConfigure = () => {};
    let markConfigureStarted = () => {};
    const configureGate = new Promise((resolve) => { releaseConfigure = resolve; });
    const configureStarted = new Promise((resolve) => { markConfigureStarted = resolve; });
    let releaseCleanup = () => {};
    let markCleanupStarted = () => {};
    const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
    const cleanupStarted = new Promise((resolve) => { markCleanupStarted = resolve; });
    let cleanupCalls = 0;
    const session = createCursorSession({
      ...baseOpts,
      agentRole: 'root',
      isolatedHome: path.join(root, 'home'),
      requestUserInput: async () => ({ status: 'cancelled' }),
    }, {
      createAcpSession() {
        return {
          async configure() {
            markConfigureStarted();
            await configureGate;
          },
          getSessionId: () => 'cursor-configuring-at-dispose',
          async dispose() {
            cleanupCalls += 1;
            markCleanupStarted();
            await cleanupGate;
            return false;
          },
        };
      },
    });

    session.sendUserMessage('configure');
    await configureStarted;
    let disposeSettled = false;
    const disposing = session.dispose().then((cleaned) => {
      disposeSettled = true;
      return cleaned;
    });
    await cleanupStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposeSettled, false, 'dispose must wait for native cleanup proof');
    releaseCleanup();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposeSettled, false, 'dispose must also wait for the in-flight configure operation');
    releaseConfigure();
    assert.equal(await disposing, false);
    assert.equal(cleanupCalls, 1);
  });
});

test('interrupt kills the child and closes the turn once', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('long task');
  const { proc } = spawns[0];
  proc.emitJson(INIT_LINE);

  session.interrupt();
  assert.deepEqual(proc.signals, ['SIGTERM']);
  assert.deepEqual(
    events.filter((event) => event.type === 'turn-end'),
    [{ type: 'turn-end', agent: 'cursor', stopReason: 'interrupted' }],
  );
  proc.exit(1);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  session.dispose();
});

test('a mode switch waits for the running child to exit', async (t) => {
  const { session, opts, spawns } = startSession(t, {}, {
    terminateProcess: async () => true,
    waitForExit: async () => true,
  });
  session.sendUserMessage('go');
  const { proc } = spawns[0];

  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 }),
    /only change between turns/,
  );
  proc.emitJson(INIT_LINE, { type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  proc.exit(0);
  await session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 3 });
  assert.deepEqual([opts.workflow, opts.phase, opts.capabilityEpoch], ['plan', 'planning', 3]);

  session.sendUserMessage('plan it');
  const cli = JSON.parse(readFileSync(path.join(String(opts.isolatedHome), '.cursor', 'cli-config.json'), 'utf8'));
  assert.deepEqual(cli.permissions.deny, ['Write(**)'], '계획 단계 cli-config 가 다시 저작된다');
  session.dispose();
});
