import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildGrokArgv,
  buildGrokConfigToml,
  buildGrokEnv,
  createGrokSession,
  formatGrokExitError,
  pinnedShellAllowPrefixes,
  prepareGrokHome,
  scopedBashAllowRules,
} from '../agents/grok.mjs';
import { copyLayoutShellAllowPrefixes } from '../copy-layout-shell.mjs';

const baseOpts = {
  rootDir: '/tmp/rhwp',
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 6301,
  token: 'secret-token',
  sessionId: 'studio-thread-grok',
  model: 'grok-4.6',
  effort: 'high',
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

/** 세션을 만들고 스폰 기록/이벤트 배열과 임시 grokHome 을 함께 돌려준다. */
function startSession(t, extra = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-grok-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const spawns = [];
  const opts = {
    ...baseOpts,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    grokHome: path.join(root, 'home', '.grok'),
    ...extra,
    onEvent: (event) => events.push(event),
  };
  const session = createGrokSession(opts, {
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
  });
  return { session, events, spawns, opts, root };
}

function types(events) {
  return events.map((event) => event.type);
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

// streaming-messages-json 리터럴은 Anthropic Messages 와이어 포맷 문서 형태를 따른다.
const INIT_LINE = {
  type: 'system', subtype: 'init',
  session_id: '11111111-2222-4333-8444-555555555555',
  model: 'grok-4.6',
  mcp_servers: [{ name: 'rhwp', status: 'connected' }],
  tools: [], slash_commands: [], skills: [],
};

test('argv carries the prompt file, session, model, effort and safe allow rules', () => {
  const argv = buildGrokArgv({ ...baseOpts }, 'sess-uuid', false, '/g/prompt.txt');
  assert.deepEqual(argv.slice(0, 6), [
    '--prompt-file', '/g/prompt.txt',
    '--output-format', 'streaming-messages-json',
    '--include-partial-messages', '--no-auto-update',
  ]);
  assert.equal(argValue(argv, '-s'), 'sess-uuid');
  assert.equal(argv.includes('-r'), false);
  assert.match(argValue(argv, '--append-system-prompt'), /rhwp MCP tools/);
  // dontAsk 는 spawn_subagent 를 자동 취소하므로 안전 브리프에는 병렬 안내가 없다
  // — 도구도 꺼 놓고 스폰하라고 시키면 턴 전체가 실패한다.
  assert.doesNotMatch(argValue(argv, '--append-system-prompt'), /spawn_subagent/);
  assert.equal(argValue(argv, '-m'), 'grok-4.6');
  assert.equal(argValue(argv, '--reasoning-effort'), 'high');
  assert.equal(argValue(argv, '--permission-mode'), 'dontAsk');
  assert.equal(argv.includes('--sandbox'), false, 'grok 1.0.5 의 macOS 샌드박스는 기동 전에 멈춘다 — 플래그를 붙이지 않는다');
  const allows = argv.flatMap((value, index) => (value === '--allow' ? [argv[index + 1]] : []));
  // 샌드박스가 없는 동안 Bash 를 허용하면 경로 규칙이 무의미해진다 — 안전 프로필은 셸을 뺀다.
  assert.deepEqual(allows, [
    'Read(/tmp/rhwp/**)', 'Edit(/tmp/rhwp/**)',
    'Grep', 'WebFetch', 'WebSearch', 'MCPTool(rhwp__*)',
  ]);
  assert.equal(allows.includes('Bash'), false, '안전 프로필에서는 셸을 허용하지 않는다');
  // dontAsk 는 allowlist 를 강제하지 않는다 (1.0.5 라이브 확인) — 실제 경계는 deny 다.
  const denies = argv.flatMap((value, index) => (value === '--deny' ? [argv[index + 1]] : []));
  assert.deepEqual(denies, ['Bash'], '안전 프로필은 --deny Bash 로 셸을 실제로 막는다');
  // dontAsk 아래에서 spawn_subagent 는 승인 프롬프트가 자동 취소되고("User
  // cancelled") 그 오류가 턴 전체를 실패시켜 스테이징 편집이 되돌아간다 —
  // 안전 프로필은 서브에이전트 도구 자체를 끈다 (1.0.5 라이브 확인).
  assert.ok(argv.includes('--no-subagents'), '안전 프로필은 서브에이전트를 끈다');
  assert.equal(argValue(argv, '--agents'), undefined, 'dontAsk 에서는 --agents 를 싣지 않는다');
});

test('scoped shell prefixes swap the blanket Bash deny for allowlist closure in workers', () => {
  // 복사 레이아웃 워커는 python3 헬퍼 실행이 필요하다. grok 규칙은 deny 가
  // allow 보다 우선하므로 --deny Bash 를 남겨 두면 스코프 허용이 죽는다 —
  // 이 모드에서는 deny 를 빼고 dontAsk 의 allowlist 폐쇄성(허용 접두사와 내장
  // 읽기 전용 목록 밖은 무프롬프트 거부)으로 경계를 유지한다. 접두사는
  // 잡 헬퍼 절대 경로까지 고정한다 — python3* 는 인라인 코드와 임의 스크립트를 연다.
  const helperPath = path.resolve('/private/job/copy_layout.py');
  const prefixes = copyLayoutShellAllowPrefixes(helperPath);
  const argv = buildGrokArgv(
    { ...baseOpts, shellAllowPrefixes: prefixes },
    's', false, '/g/p',
  );
  assert.equal(argValue(argv, '--permission-mode'), 'dontAsk');
  const allows = argv.flatMap((value, index) => (value === '--allow' ? [argv[index + 1]] : []));
  assert.deepEqual(allows, [
    'Read(/tmp/rhwp/**)', 'Edit(/tmp/rhwp/**)',
    'Grep', 'WebFetch', 'WebSearch', 'MCPTool(rhwp__*)',
    ...scopedBashAllowRules(prefixes),
  ]);
  assert.equal(allows.includes('Bash(python3*)'), false);
  assert.equal(allows.includes('Bash(python*)'), false);
  assert.ok(allows.includes(`Bash(python3 ${helperPath})`));
  assert.ok(allows.includes(`Bash(python3 ${helperPath} *)`));
  const denies = argv.flatMap((value, index) => (value === '--deny' ? [argv[index + 1]] : []));
  assert.deepEqual(denies, [], '전면 Bash deny 는 스코프 허용을 이기므로 함께 빠진다');
  assert.ok(argv.includes('--no-subagents'), '워커도 안전 프로필 — 서브에이전트는 계속 꺼져 있다');
});

test('bare interpreter prefixes stay closed instead of opening python3*', () => {
  const argv = buildGrokArgv(
    { ...baseOpts, shellAllowPrefixes: ['python3', 'python'] },
    's', false, '/g/p',
  );
  const allows = argv.flatMap((value, index) => (value === '--allow' ? [argv[index + 1]] : []));
  assert.equal(allows.some((rule) => rule.startsWith('Bash(')), false);
  const denies = argv.flatMap((value, index) => (value === '--deny' ? [argv[index + 1]] : []));
  assert.deepEqual(denies, ['Bash'], '고정 경로가 없으면 전면 Bash deny 를 유지한다');
  assert.deepEqual(pinnedShellAllowPrefixes(['python3', 'python', '']), []);
});

test('scoped shell prefixes stay inert during planning restriction', () => {
  const argv = buildGrokArgv(
    { ...baseOpts, shellAllowPrefixes: copyLayoutShellAllowPrefixes(path.resolve('/private/job/copy_layout.py')), workflow: 'plan', phase: 'planning' },
    's', false, '/g/p',
  );
  const allows = argv.flatMap((value, index) => (value === '--allow' ? [argv[index + 1]] : []));
  assert.equal(allows.some((rule) => rule.startsWith('Bash(')), false);
  const denies = argv.flatMap((value, index) => (value === '--deny' ? [argv[index + 1]] : []));
  assert.deepEqual(denies, ['Bash', 'Edit', 'Write'], '계획 단계는 기존 전면 deny 를 유지한다');
});

test('unrestricted argv always-approves without a sandbox flag and enables subagents', () => {
  const argv = buildGrokArgv({ ...baseOpts, permissionProfile: 'unrestricted' }, 's', false, '/g/p');
  assert.ok(argv.includes('--always-approve'));
  assert.equal(argv.includes('--sandbox'), false);
  assert.equal(argv.includes('--permission-mode'), false);
  // 전체 접근에서만 셸이 열린다 — 개별 --allow/--deny 없이 always-approve 가 전부 승인한다.
  assert.equal(argv.includes('--allow'), false);
  assert.equal(argv.includes('--deny'), false);
  // 편대는 스폰 승인이 실제로 통과하는 always-approve 에서만 켠다.
  assert.equal(argv.includes('--no-subagents'), false);
  const agents = JSON.parse(argValue(argv, '--agents'));
  assert.deepEqual(Object.keys(agents).sort(), ['doc-editor', 'doc-researcher']);
  assert.match(argValue(argv, '--append-system-prompt'), /spawn_subagent/, '전체 접근 브리프에는 병렬 안내가 실린다');
});

test('planning phases use native Plan, drop Edit and disable subagents', () => {
  for (const profile of ['safe', 'unrestricted']) {
    for (const phase of ['planning', 'awaiting-approval', 'switching']) {
      const argv = buildGrokArgv(
        { ...baseOpts, permissionProfile: profile, workflow: 'plan', phase },
        's', false, '/g/p',
      );
      const label = `${profile}/${phase}`;
      assert.equal(argValue(argv, '--permission-mode'), 'plan', label);
      assert.equal(argv.includes('--sandbox'), false, label);
      const allows = argv.flatMap((value, index) => (value === '--allow' ? [argv[index + 1]] : []));
      assert.equal(allows.some((rule) => rule.startsWith('Edit(')), false, label);
      assert.equal(allows.includes('Bash'), false, label);
      // 계획 단계의 읽기 전용 경계는 deny 가 강제한다 — Edit 가 search_replace 와
      // write 를 모두 막고(라이브 확인), Write 는 명시적 이중 안전장치다.
      const denies = argv.flatMap((value, index) => (value === '--deny' ? [argv[index + 1]] : []));
      assert.deepEqual(denies, ['Bash', 'Edit', 'Write'], label);
      assert.ok(argv.includes('--no-subagents'), label);
      assert.equal(argValue(argv, '--agents'), undefined, label);
      assert.match(argValue(argv, '--append-system-prompt'), /planning mode/);
    }
  }
  // 계획 워크플로라도 unrestricted 구현 단계는 always-approve 로 돌아간다 — 편대도 켜진다.
  const implementing = buildGrokArgv(
    { ...baseOpts, permissionProfile: 'unrestricted', workflow: 'plan', phase: 'implementing' },
    's', false, '/g/p',
  );
  assert.ok(implementing.includes('--always-approve'));
  assert.equal(implementing.includes('--no-subagents'), false);
  assert.ok(argValue(implementing, '--agents'));
  assert.match(argValue(implementing, '--append-system-prompt'), /implementation mode/);
});

test('config.toml disables updates, telemetry and vendor compat, and wires the rhwp MCP server', () => {
  const toml = buildGrokConfigToml({ ...baseOpts, capabilityEpoch: 7 });
  assert.match(toml, /\[cli\]\nauto_update = false/);
  assert.match(toml, /\[features\]\ntelemetry = false/);
  assert.match(toml, /\[toolset\.ask_user_question\]\ntimeout_enabled = false/);
  for (const vendor of ['claude', 'cursor']) {
    const section = toml.slice(toml.indexOf(`[compat.${vendor}]`));
    for (const key of ['skills', 'rules', 'agents', 'mcps', 'hooks', 'sessions']) {
      assert.match(section.slice(0, 200), new RegExp(`${key} = false`), `${vendor}.${key}`);
    }
  }
  assert.match(toml, /\[mcp\]\nmax_output_bytes = 1000000/, 'MCP 결과 상한을 기본 20 KB 에서 올린다');
  assert.match(toml, /\[mcp_servers\.rhwp\]/);
  assert.match(toml, /startup_timeout_sec = 20/);
  assert.match(toml, /args = \[.*"\/tmp\/mcp-stdio\.mjs"\]/);
  assert.match(toml, /RHWP_WS_URL = "ws:\/\/127\.0\.0\.1:6301\/mcp"/);
  assert.match(toml, /RHWP_AGENT_TOKEN = "secret-token"/);
  assert.match(toml, /RHWP_AGENT_NAME = "grok"/);
  assert.match(toml, /RHWP_CAPABILITY_EPOCH = "7"/);
});

test('the child env pins GROK_HOME and turns off the auto-updater and memory', () => {
  const env = buildGrokEnv(
    { ...baseOpts, isolatedHome: '/tmp/rhwp isolated', grokHome: '/tmp/rhwp isolated/.grok' },
    { PATH: '/usr/bin' },
  );
  assert.equal(env.HOME, '/tmp/rhwp isolated');
  assert.equal(env.USERPROFILE, '/tmp/rhwp isolated');
  assert.equal(env.GROK_HOME, '/tmp/rhwp isolated/.grok');
  assert.equal(env.GROK_DISABLE_AUTOUPDATER, '1');
  assert.equal(env.GROK_MEMORY, '0');
  assert.equal(env.RHWP_SESSION_ID, 'studio-thread-grok');
});

test('native ACP keeps one Grok process, registers both question methods and routes cancel', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-grok-native-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const prompts = [];
  let config;
  let creates = 0;
  let cancels = 0;
  let started = false;
  const configureCalls = [];
  let restarts = 0;
  const session = createGrokSession({
    ...baseOpts,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    grokHome: path.join(root, 'home', '.grok'),
    requestUserInput: async () => ({ status: 'cancelled' }),
    onEvent: (event) => events.push(event),
  }, {
    createAcpSession(input) {
      creates += 1;
      config = input;
      return {
        isStarted: () => started,
        async configure(options) {
          configureCalls.push(options);
          if (!started) {
            started = true;
            input.onSessionStarted({ sessionId: 'grok-acp-1', setupResponse: {} });
          }
        },
        async prompt(text) {
          prompts.push(text);
          input.onSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native' } });
          return { stopReason: 'end_turn' };
        },
        getSessionId: () => 'grok-acp-1',
        hasSeenPromptUpdate: () => true,
        restart: async () => {
          await new Promise((resolve) => setImmediate(resolve));
          restarts += 1;
        },
        cancel: async () => { cancels += 1; },
        dispose: async () => {},
      };
    },
  });
  t.after(() => session.dispose());

  session.sendUserMessage('one');
  await new Promise((resolve) => setImmediate(resolve));
  session.sendUserMessage('two');
  await new Promise((resolve) => setImmediate(resolve));
  const permissionChange = session.setPermissionProfile('unrestricted');
  assert.equal(restarts, 0);
  await permissionChange;
  assert.equal(restarts, 1, 'permission ACK waits for the native restart');
  await session.setExecutionMode({ workflow: 'plan', phase: 'awaiting-approval', capabilityEpoch: 2 });
  assert.deepEqual(configureCalls.at(-1).modeAliases, ['plan', 'architect'], 'Plan ACK waits for ACP mode selection');
  session.sendUserMessage('three');
  await new Promise((resolve) => setImmediate(resolve));
  await session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 3 });
  session.sendUserMessage('four');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(creates, 1);
  assert.deepEqual(config.args, ['agent', 'stdio']);
  assert.deepEqual(config.requestHandlers.map((entry) => entry.method), [
    'x.ai/ask_user_question', '_x.ai/ask_user_question',
  ]);
  assert.match(prompts[0], /rhwp MCP tools/);
  assert.match(prompts[0], /one$/);
  assert.equal(prompts[1], 'two');
  assert.match(prompts[2], /three$/);
  assert.match(prompts[3], /four$/);
  assert.deepEqual(configureCalls.map((call) => call.modeAliases), [
    ['agent', 'code', 'default'],
    ['agent', 'code', 'default'],
    ['plan', 'architect'],
    ['plan', 'architect'],
    ['agent', 'code', 'default'],
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'text-delta').map((event) => event.text), ['native', 'native', 'native', 'native']);
  assert.equal(restarts, 3);

  session.sendUserMessage('pending interrupt');
  session.interrupt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancels, 1);
  assert.equal(events.filter((event) => event.type === 'turn-end').at(-1)?.stopReason, 'interrupted');
});

test('Grok rejects Plan before ACK when ACP cannot prove the mode', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-grok-plan-readiness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const opts = {
    ...baseOpts,
    workflow: 'direct',
    phase: 'implementing',
    capabilityEpoch: 1,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    grokHome: path.join(root, 'home', '.grok'),
    requestUserInput: async () => ({ status: 'cancelled' }),
  };
  let disposed = 0;
  const session = createGrokSession(opts, {
    createAcpSession() {
      return {
        configure: async () => { throw new Error('Grok ACP does not advertise required mode (plan, architect)'); },
        getSessionId: () => 'grok-unproved-plan',
        dispose: async () => { disposed += 1; },
      };
    },
  });
  t.after(() => session.dispose());

  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 }),
    /does not advertise required mode/,
  );
  assert.deepEqual([opts.workflow, opts.phase, opts.capabilityEpoch], ['direct', 'implementing', 1]);
  assert.equal(disposed, 1);
});

test('Grok ACP startup failure falls back before emitting a native provider update', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-grok-fallback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const spawns = [];
  const session = createGrokSession({
    ...baseOpts,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    grokHome: path.join(root, 'home', '.grok'),
    requestUserInput: async () => ({ status: 'cancelled' }),
    onEvent: (event) => events.push(event),
  }, {
    createAcpSession() {
      return {
        isStarted: () => false,
        configure: async () => { throw new Error('ACP unavailable'); },
        hasSeenPromptUpdate: () => false,
        dispose: async () => {},
      };
    },
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
  });
  t.after(() => session.dispose());

  session.sendUserMessage('fallback');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawns.length, 1);
  assert.deepEqual(types(events), ['turn-start']);
  assert.deepEqual(spawns[0].argv.slice(0, 2), ['--prompt-file', path.join(root, 'home', '.grok', 'prompt.txt')]);
});

test('Grok never switches transports after the native prompt starts', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-grok-atomic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  let legacySpawns = 0;
  const session = createGrokSession({
    ...baseOpts,
    agentRole: 'root',
    isolatedHome: path.join(root, 'home'),
    grokHome: path.join(root, 'home', '.grok'),
    requestUserInput: async () => ({ status: 'cancelled' }),
    onEvent: (event) => events.push(event),
  }, {
    createAcpSession() {
      return {
        isStarted: () => true,
        configure: async () => {},
        getSessionId: () => 'grok-native-atomic',
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

test('a tool-call turn maps the Anthropic wire stream to the unified sequence', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('probe the document');
  const { proc } = spawns[0];

  proc.emitJson(
    INIT_LINE,
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '도구를 부릅니다. ' } },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '도구를 부릅니다. ' },
          { type: 'tool_use', id: 'toolu_1', name: 'mcp__rhwp__get_structure', input: { sectionIdx: 0 } },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: '{"revision":7}' }] },
    },
    {
      type: 'result', subtype: 'success', is_error: false, result: '확인했습니다.',
      stop_reason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    },
  );

  assert.deepEqual(types(events), [
    'turn-start', 'session-info', 'text-delta', 'tool-call', 'tool-result', 'usage', 'turn-end',
  ]);
  const info = events[1];
  assert.equal(info.sessionId, INIT_LINE.session_id);
  assert.equal(info.model, 'grok-4.6');
  assert.equal(info.mcpStatus, 'connected');
  assert.equal(session.getSessionId(), INIT_LINE.session_id);

  const call = events.find((event) => event.type === 'tool-call');
  assert.deepEqual(
    { tool: call.tool, callId: call.callId, argsJson: call.argsJson },
    { tool: 'get_structure', callId: 'toolu_1', argsJson: '{"sectionIdx":0}' },
  );
  const result = events.find((event) => event.type === 'tool-result');
  assert.equal(result.ok, true);
  assert.deepEqual(events.find((event) => event.type === 'usage'), {
    type: 'usage', agent: 'grok', model: 'grok-4.6',
    usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 10, cacheCreationTokens: 5 },
  });
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'grok', stopReason: 'completed', errorMessage: undefined,
  });
  session.dispose();
});

test('a non-end_turn stop reason still ends the turn as completed, and errors keep their subtype', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('long rewrite');
  spawns[0].proc.emitJson({
    type: 'result', subtype: 'success', is_error: false, result: '중간에 잘렸습니다.',
    stop_reason: 'max_tokens',
  });
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'grok', stopReason: 'completed', errorMessage: undefined,
  }, 'max_tokens 를 그대로 흘리면 스튜디오가 스테이징 편집을 되돌린다');

  session.sendUserMessage('again');
  spawns[1].proc.emitJson({
    type: 'result', subtype: 'error_during_execution', is_error: true, result: '도구 호출이 실패했습니다.',
    stop_reason: 'refusal',
  });
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'grok', stopReason: 'error_during_execution',
    errorMessage: '도구 호출이 실패했습니다.',
  });
  session.dispose();
});

test('per-model usage is preferred and an all-zero ledger emits nothing', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('go');
  spawns[0].proc.emitJson(
    INIT_LINE,
    {
      type: 'result', subtype: 'success', is_error: false, result: 'done',
      modelUsage: {
        'grok-4.6': { input_tokens: 10, output_tokens: 3 },
        'grok-4.5': { input_tokens: 0, output_tokens: 0 },
      },
      usage: { input_tokens: 999, output_tokens: 999 },
    },
  );
  const usage = events.filter((event) => event.type === 'usage');
  assert.equal(usage.length, 1, '모델별 사용량이 있으면 집계본은 버린다');
  assert.equal(usage[0].model, 'grok-4.6');

  session.sendUserMessage('again');
  spawns[1].proc.emitJson({
    type: 'result', subtype: 'success', is_error: false, result: 'done',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
  });
  assert.equal(events.filter((event) => event.type === 'usage').length, 1, '전부 0 인 usage 는 미상으로 취급한다');
  session.dispose();
});

test('rhwp__-prefixed tool names are stripped and bare-text assistant blocks dedupe against deltas', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('go');
  spawns[0].proc.emitJson(
    INIT_LINE,
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't2', name: 'rhwp__replace_range', input: {} }] },
    },
    {
      // use_tool 메타 도구로 감싼 MCP 호출은 실제 도구 이름과 인자로 풀어서 보고한다.
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use', id: 't3', name: 'use_tool',
          input: { tool_name: 'rhwp__get_structure', tool_input: { sectionIdx: 1 } },
        }],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: '델타 없이 온 본문' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
  );
  assert.equal(events.find((event) => event.type === 'tool-call').tool, 'replace_range');
  const wrapped = events.find((event) => event.type === 'tool-call' && event.callId === 't3');
  assert.equal(wrapped.tool, 'get_structure');
  assert.equal(wrapped.argsJson, '{"sectionIdx":1}');
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    ['델타 없이 온 본문'],
  );
  session.dispose();
});

test('the prompt goes through a file, the config is authored per spawn and stdin stays closed', (t) => {
  const { session, spawns, opts } = startSession(t);
  session.sendUserMessage('--help 처럼 보이는 요청');
  const { command, argv, options } = spawns[0];

  assert.equal(command, 'grok');
  const promptPath = argValue(argv, '--prompt-file');
  assert.equal(promptPath, path.join(opts.grokHome, 'prompt.txt'));
  assert.equal(readFileSync(promptPath, 'utf8'), '--help 처럼 보이는 요청');
  const toml = readFileSync(path.join(opts.grokHome, 'config.toml'), 'utf8');
  assert.match(toml, /RHWP_AGENT_NAME = "grok"/);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.cwd, baseOpts.rootDir);
  assert.equal(options.env.GROK_HOME, opts.grokHome);
  assert.equal(options.env.HOME, opts.isolatedHome);
  session.dispose();
});

test('a completed turn resumes with -r and a dead first spawn gets a fresh session UUID', (t) => {
  const { session, spawns } = startSession(t);
  session.sendUserMessage('first');
  const firstId = argValue(spawns[0].argv, '-s');
  assert.ok(firstId);

  // 첫 스폰이 turn 완료 없이 죽으면 -s UUID 는 소진된 것으로 보고 새로 발급한다.
  spawns[0].proc.exit(1);
  session.sendUserMessage('retry');
  const retryId = argValue(spawns[1].argv, '-s');
  assert.ok(retryId);
  assert.notEqual(retryId, firstId);

  spawns[1].proc.emitJson(INIT_LINE, { type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  spawns[1].proc.exit(0);

  session.sendUserMessage('follow-up');
  assert.equal(argValue(spawns[2].argv, '-r'), INIT_LINE.session_id, '완료된 턴 뒤에는 CLI 가 보고한 ID 로 재개한다');
  assert.equal(spawns[2].argv.includes('-s'), false);
  session.dispose();
});

test('a startup failure reports the stderr reason without the session token', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('go');
  const { proc } = spawns[0];

  proc.stderr.emit('data', 'Error: not logged in\ntoken=secret-token\nUsage: grok [OPTIONS]\n');
  proc.exit(1);

  const error = events.find((event) => event.type === 'error');
  assert.match(error.message, /Grok 실행이 중단되었습니다 \(code 1\)/);
  assert.match(error.message, /not logged in/);
  assert.doesNotMatch(error.message, /secret-token/);
  assert.doesNotMatch(error.message, /^Usage:/m);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'grok', stopReason: 'exited' });
  session.dispose();
});

test('a result line delivered between exit and close still completes the turn', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('big output');
  const { proc } = spawns[0];

  // 'exit' 은 stdout 꼬리가 파싱되기 전에 온다.
  proc.exitOnly(0);
  proc.emitJson(INIT_LINE, { type: 'result', subtype: 'success', is_error: false, result: '끝났습니다.' });
  proc.close(0);

  assert.equal(events.filter((event) => event.type === 'error').length, 0, '성공 턴에 오류를 붙이지 않는다');
  assert.deepEqual(
    events.filter((event) => event.type === 'turn-end'),
    [{ type: 'turn-end', agent: 'grok', stopReason: 'completed', errorMessage: undefined }],
  );
  session.dispose();
});

test('a clean exit without a result ends the turn quietly', (t) => {
  const { session, events, spawns } = startSession(t);
  session.sendUserMessage('go');
  spawns[0].proc.exit(0);

  assert.equal(events.filter((event) => event.type === 'error').length, 0);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'grok', stopReason: 'exited' });
  session.dispose();
});

test('formatGrokExitError falls back to a plain message without stderr', () => {
  assert.equal(
    formatGrokExitError('', null, 'SIGTERM', 'tok'),
    'Grok 실행이 중단되었습니다 (signal SIGTERM). Grok이 오류 설명을 제공하지 않았습니다.',
  );
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
    [{ type: 'turn-end', agent: 'grok', stopReason: 'interrupted' }],
  );
  proc.exit(143);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  session.dispose();
});

test('a mode switch waits for the running child and the next spawn reflects it', async (t) => {
  const { session, opts, spawns } = startSession(t);
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
  const allows = spawns[1].argv.flatMap((value, index) => (value === '--allow' ? [spawns[1].argv[index + 1]] : []));
  assert.equal(allows.some((rule) => rule.startsWith('Edit(')), false, '계획 단계 인자로 다시 스폰한다');
  session.dispose();
});

test('prepareGrokHome links the shared auth file and skips symlinked sources', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-grok-home-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const grokHome = path.join(root, 'home', '.grok');
  const authPath = path.join(root, 'auth.json');
  writeFileSync(authPath, '{"token":"shared"}');

  prepareGrokHome(grokHome, authPath);
  assert.equal(path.resolve(grokHome, readlinkSync(path.join(grokHome, 'auth.json'))), authPath);

  // 윈도우에서 심볼릭 링크가 거부되면 복사로 대체한다.
  const copyHome = path.join(root, 'copy', '.grok');
  prepareGrokHome(copyHome, authPath, {
    platform: 'win32',
    symlink() {
      const error = new Error('symlinks require elevation');
      error.code = 'EPERM';
      throw error;
    },
  });
  assert.equal(readFileSync(path.join(copyHome, 'auth.json'), 'utf8'), '{"token":"shared"}');
});
