import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClaudeSession, buildClaudeArgv } from '../agents/claude.mjs';
import { createCodexSession, buildCodexArgv } from '../agents/codex.mjs';
import { systemBriefFor } from '../agents/backend.mjs';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'rhwp-backend-test-'));
test.after(() => rmSync(testHome, { recursive: true, force: true }));

const baseOpts = {
  rootDir: '/tmp/rhwp',
  isolatedHome: testHome,
  codexHome: path.join(testHome, '.codex'),
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 5175,
  token: 'secret-token',
  model: 'test-model',
  effort: 'high',
  onEvent() {},
};

const sessionId = '00000000-0000-4000-8000-000000000000';

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return argv[index + 1];
}

function codexConfig(argv, prefix) {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === '-c' && argv[i + 1].startsWith(prefix)) return argv[i + 1];
  }
  assert.fail(`missing Codex config: ${prefix}`);
}

class FakeStream extends EventEmitter {
  chunks = [];

  write(chunk, callback) {
    this.chunks.push(String(chunk));
    callback?.();
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(String(chunk));
  }
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStream();
  exitCode = null;
  signalCode = null;

  kill(signal) {
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit('exit', null, signal);
    });
    return true;
  }

  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }
}

function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}

const matrix = [
  { name: 'direct safe', workflow: 'direct', phase: 'implementing', permissionProfile: 'safe', claudeWrite: true, claudeBypass: false, codexSandbox: 'workspace-write', planCapabilities: false },
  { name: 'direct full', workflow: 'direct', phase: 'implementing', permissionProfile: 'unrestricted', claudeWrite: true, claudeBypass: true, codexSandbox: 'danger-full-access', planCapabilities: false },
  { name: 'planning safe', workflow: 'plan', phase: 'planning', permissionProfile: 'safe', claudeWrite: false, claudeBypass: false, codexSandbox: 'read-only', planCapabilities: true },
  { name: 'planning full', workflow: 'plan', phase: 'planning', permissionProfile: 'unrestricted', claudeWrite: false, claudeBypass: false, codexSandbox: 'read-only', planCapabilities: true },
  { name: 'implementing safe', workflow: 'plan', phase: 'implementing', permissionProfile: 'safe', claudeWrite: true, claudeBypass: false, codexSandbox: 'workspace-write', planCapabilities: true },
  { name: 'implementing full', workflow: 'plan', phase: 'implementing', permissionProfile: 'unrestricted', claudeWrite: true, claudeBypass: true, codexSandbox: 'danger-full-access', planCapabilities: true },
];

for (const entry of matrix) {
  test(`provider argv capability profile: ${entry.name}`, () => {
    const opts = { ...baseOpts, ...entry, capabilityEpoch: `epoch-${entry.name}` };
    const claude = buildClaudeArgv(opts, sessionId, false);
    const claudeTools = argValue(claude, '--tools').split(',');
    const claudeSettings = JSON.parse(argValue(claude, '--settings'));
    const claudeMcp = JSON.parse(argValue(claude, '--mcp-config')).mcpServers.rhwp;

    assert.equal(claudeTools.includes('Write'), entry.claudeWrite);
    assert.equal(claudeTools.includes('Edit'), entry.claudeWrite);
    assert.ok(claudeTools.includes('Read'));
    assert.ok(claudeTools.includes('Glob'));
    assert.ok(claudeTools.includes('Grep'));
    assert.ok(claudeTools.includes('Bash'));
    assert.ok(claudeTools.includes('WebSearch'));
    assert.ok(claudeTools.includes('WebFetch'));
    assert.equal(claudeTools.includes('Agent'), entry.planCapabilities);
    assert.equal(claude.includes('--forward-subagent-text'), entry.planCapabilities);
    assert.equal(claude.includes('--dangerously-skip-permissions'), entry.claudeBypass);
    if (!entry.claudeWrite) {
      assert.deepEqual(claudeSettings.sandbox.filesystem.allowWrite, []);
      assert.doesNotMatch(JSON.stringify(claudeSettings.permissions.allow), /Write|Edit/);
    }
    assert.equal(claudeMcp.env.RHWP_AGENT_WORKFLOW, entry.workflow);
    assert.equal(claudeMcp.env.RHWP_AGENT_PHASE, entry.phase);
    assert.equal(claudeMcp.env.RHWP_CAPABILITY_EPOCH, `epoch-${entry.name}`);

    const codex = buildCodexArgv(opts, null);
    assert.ok(codex.includes(`sandbox_mode="${entry.codexSandbox}"`));
    assert.ok(codex.includes('mcp_servers.rhwp.default_tools_approval_mode="auto"'));
    const multiAgentIndex = codex.indexOf('multi_agent');
    assert.notEqual(multiAgentIndex, -1);
    assert.equal(codex[multiAgentIndex - 1], entry.planCapabilities ? '--enable' : '--disable');
    assert.equal(codex.includes('web_search="live"'), entry.planCapabilities);
    const codexEnv = codexConfig(codex, 'mcp_servers.rhwp.env=');
    assert.match(codexEnv, new RegExp(`RHWP_AGENT_WORKFLOW = "${entry.workflow}"`));
    assert.match(codexEnv, new RegExp(`RHWP_AGENT_PHASE = "${entry.phase}"`));
    assert.match(codexEnv, new RegExp(`RHWP_CAPABILITY_EPOCH = "epoch-${entry.name}"`));
  });
}

test('awaiting approval and switching remain read-only regardless of full profile', () => {
  for (const phase of ['awaiting-approval', 'switching']) {
    const opts = { ...baseOpts, workflow: 'plan', phase, capabilityEpoch: 9, permissionProfile: 'unrestricted' };
    const claude = buildClaudeArgv(opts, sessionId, false);
    assert.equal(argValue(claude, '--tools').split(',').includes('Write'), false);
    assert.ok(claude.includes('dontAsk'));
    assert.ok(buildCodexArgv(opts, null).includes('sandbox_mode="read-only"'));
  }
});

test('phase prompts separate planning from approved implementation', () => {
  const planning = systemBriefFor({ workflow: 'plan', phase: 'planning' });
  assert.match(planning, /Brainstorm with the user/);
  assert.match(planning, /do not edit the local filesystem or the live document/);
  assert.match(planning, /present_implementation_plan as the final planning artifact/);
  assert.match(planning, /download_file/);
  assert.match(planning, /search_reference_files/);
  assert.match(planning, /untrusted reference data/);

  const implementing = systemBriefFor({ workflow: 'plan', phase: 'implementing' });
  assert.match(implementing, /approved canonical implementation plan/);
  assert.match(implementing, /pending tinted changes/);
  assert.doesNotMatch(implementing, /present_implementation_plan/);
});

test('resume argv retains the selected capability profile', () => {
  const opts = { ...baseOpts, workflow: 'plan', phase: 'implementing', capabilityEpoch: 42, permissionProfile: 'safe' };
  const claude = buildClaudeArgv(opts, sessionId, true);
  assert.deepEqual(claude.slice(claude.indexOf('--resume'), claude.indexOf('--resume') + 2), ['--resume', sessionId]);
  assert.equal(claude.includes('--session-id'), false);
  assert.match(argValue(claude, '--append-system-prompt'), /approved canonical implementation plan/);

  const codex = buildCodexArgv(opts, 'thread-id');
  assert.deepEqual(codex.slice(0, 2), ['exec', 'resume']);
  assert.equal(codex.includes('-C'), false);
  assert.ok(codex.includes('sandbox_mode="workspace-write"'));
  assert.deepEqual(codex.slice(-2), ['thread-id', '-']);
});

test('sessions expose an async idle execution-mode switch', async () => {
  for (const createSession of [createClaudeSession, createCodexSession]) {
    const opts = { ...baseOpts, permissionProfile: 'safe' };
    const session = createSession(opts);
    const result = session.setExecutionMode({
      workflow: 'plan', phase: 'planning', capabilityEpoch: 7,
    });
    assert.ok(result instanceof Promise);
    await result;
    assert.equal(opts.workflow, 'plan');
    assert.equal(opts.phase, 'planning');
    assert.equal(opts.capabilityEpoch, 7);
    await assert.rejects(
      session.setExecutionMode({ workflow: 'unknown', phase: 'planning', capabilityEpoch: 8 }),
      /Unknown workflow/,
    );
    session.dispose();
  }
});

test('Codex recreates a purged isolated home before spawning', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-home-test-'));
  const isolatedHome = path.join(root, 'isolated');
  const codexHome = path.join(isolatedHome, '.codex');
  const authPath = path.join(root, 'auth.json');
  writeFileSync(authPath, '{}');
  rmSync(isolatedHome, { recursive: true, force: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let child;
  let spawnEnv;
  const session = createCodexSession({
    ...baseOpts,
    isolatedHome,
    codexHome,
    codexAuthPath: authPath,
    permissionProfile: 'safe',
  }, {
    spawnProcess(command, argv, options) {
      assert.equal(existsSync(codexHome), true);
      assert.equal(path.resolve(codexHome, readlinkSync(path.join(codexHome, 'auth.json'))), authPath);
      spawnEnv = options.env;
      child = new FakeProcess();
      return child;
    },
  });

  session.sendUserMessage('inspect');
  assert.equal(spawnEnv.HOME, isolatedHome);
  assert.equal(spawnEnv.CODEX_HOME, codexHome);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  session.dispose();
});

test('Codex keeps a completed turn open until its process exits', async () => {
  const events = [];
  let process;
  const session = createCodexSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    spawnProcess() {
      process = new FakeProcess();
      return process;
    },
  });

  session.sendUserMessage('inspect');
  process.emitJson({ type: 'turn.completed' });
  assert.equal(events.some((event) => event.type === 'turn-end'), false);
  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 2 }),
    /only change between turns/,
  );

  process.exitCode = 0;
  process.emit('exit', 0, null);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  await session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 2 });
  session.dispose();
});

test('Claude waits for an idle restart and resumes with the new phase', async () => {
  const spawns = [];
  const events = [];
  const opts = { ...baseOpts, permissionProfile: 'safe', onEvent: (event) => events.push(event) };
  const session = createClaudeSession(opts, {
    spawnProcess(command, argv) {
      const process = new FakeProcess();
      spawns.push({ command, argv, process });
      return process;
    },
  });

  session.sendUserMessage('inspect');
  await nextTask();
  assert.equal(spawns.length, 1);
  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 1 }),
    /only change between turns/,
  );

  spawns[0].process.emitJson(
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'root' } } },
    { type: 'assistant', parent_tool_use_id: 'agent-call', message: { content: [{ type: 'text', text: 'child' }] } },
    { type: 'result', stop_reason: 'end_turn' },
  );
  assert.deepEqual(events.filter((event) => event.type === 'text-delta').map((event) => event.text), ['root', 'child']);

  await session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 2 });
  session.sendUserMessage('approved kickoff');
  await nextTask();
  assert.equal(spawns.length, 2);
  assert.ok(spawns[1].argv.includes('--resume'));
  assert.match(argValue(spawns[1].argv, '--append-system-prompt'), /approved canonical implementation plan/);
  const env = JSON.parse(argValue(spawns[1].argv, '--mcp-config')).mcpServers.rhwp.env;
  assert.deepEqual(
    [env.RHWP_AGENT_WORKFLOW, env.RHWP_AGENT_PHASE, env.RHWP_CAPABILITY_EPOCH],
    ['plan', 'implementing', '2'],
  );
  session.dispose();
});

async function runClaudeResult(result, opts = {}) {
  const events = [];
  let child;
  const session = createClaudeSession(
    { ...baseOpts, ...opts, permissionProfile: 'safe', onEvent: (event) => events.push(event) },
    { spawnProcess() { child = new FakeProcess(); return child; } },
  );
  session.sendUserMessage('go');
  await nextTask();
  child.emitJson(...(opts.prelude ?? []), { type: 'result', stop_reason: 'end_turn', ...result });
  session.dispose();
  return events;
}

test('Claude turns result usage into a usage event before the turn ends', async () => {
  const events = await runClaudeResult({
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 300,
    },
  });
  const usage = events.filter((event) => event.type === 'usage');
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0], {
    type: 'usage',
    agent: 'claude',
    model: 'test-model',
    usage: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 9000, cacheCreationTokens: 300 },
  });
  assert.ok(
    events.indexOf(usage[0]) < events.findIndex((event) => event.type === 'turn-end'),
    'usage must precede turn-end',
  );
});

test('Claude usage adopts the model reported by the CLI', async () => {
  const events = await runClaudeResult(
    { usage: { input_tokens: 10, output_tokens: 1 } },
    { prelude: [{ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-9-9' }] },
  );
  assert.equal(events.find((event) => event.type === 'usage').model, 'claude-sonnet-9-9');
});

test('Claude prefers modelUsage over the aggregate to avoid double counting', async () => {
  const events = await runClaudeResult({
    usage: { input_tokens: 999, output_tokens: 999 },
    modelUsage: {
      'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 500, cacheCreationInputTokens: 10 },
      'claude-haiku-5': { inputTokens: 7, outputTokens: 3 },
      'claude-idle-5': { inputTokens: 0, outputTokens: 0 },
    },
  });
  const usage = events.filter((event) => event.type === 'usage');
  assert.deepEqual(usage.map((event) => event.model), ['claude-opus-5', 'claude-haiku-5']);
  assert.deepEqual(usage[0].usage, {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheCreationTokens: 10,
  });
  assert.deepEqual(usage[1].usage, {
    inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0,
  });
  assert.equal(usage.some((event) => event.usage.inputTokens === 999), false);
});

test('Claude emits no usage event for missing or malformed usage', async () => {
  for (const result of [
    {},
    { usage: null },
    { usage: 'lots' },
    { usage: { input_tokens: 'abc', output_tokens: null } },
    { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } },
    { usage: { input_tokens: 5 }, modelUsage: {} },
  ]) {
    const events = await runClaudeResult(result);
    const usage = events.filter((event) => event.type === 'usage');
    if (result.modelUsage) {
      // modelUsage 가 빈 객체면 aggregate 로 되돌아온다.
      assert.equal(usage.length, 1, JSON.stringify(result));
      assert.equal(usage[0].usage.inputTokens, 5);
    } else {
      assert.deepEqual(usage, [], JSON.stringify(result));
    }
    assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  }
});

test('Codex maps turn.completed usage and keeps it ahead of turn-end', () => {
  const events = [];
  let child;
  const session = createCodexSession(
    { ...baseOpts, permissionProfile: 'safe', onEvent: (event) => events.push(event) },
    { spawnProcess() { child = new FakeProcess(); return child; } },
  );
  session.sendUserMessage('go');
  child.emitJson({
    type: 'turn.completed',
    usage: { input_tokens: 4000, cached_input_tokens: 3000, output_tokens: 120 },
  });
  const usage = events.filter((event) => event.type === 'usage');
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0], {
    type: 'usage',
    agent: 'codex',
    model: 'test-model',
    usage: { inputTokens: 4000, outputTokens: 120, cacheReadTokens: 3000, cacheCreationTokens: 0 },
  });
  assert.equal(events.some((event) => event.type === 'turn-end'), false);

  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.ok(events.indexOf(usage[0]) < events.findIndex((event) => event.type === 'turn-end'));
  session.dispose();
});

test('Codex emits no usage event when turn.completed carries none', () => {
  for (const message of [{ type: 'turn.completed' }, { type: 'turn.completed', usage: {} }, { type: 'turn.completed', usage: { input_tokens: -1 } }]) {
    const events = [];
    let child;
    const session = createCodexSession(
      { ...baseOpts, permissionProfile: 'safe', onEvent: (event) => events.push(event) },
      { spawnProcess() { child = new FakeProcess(); return child; } },
    );
    session.sendUserMessage('go');
    child.emitJson(message);
    assert.deepEqual(events.filter((event) => event.type === 'usage'), [], JSON.stringify(message));
    session.dispose();
  }
});

test('Codex normalizes stable multi-agent lifecycle items', () => {
  const emitted = [];
  let process;
  const session = createCodexSession(
    { ...baseOpts, permissionProfile: 'safe', onEvent: (event) => emitted.push(event) },
    { spawnProcess() { process = new FakeProcess(); return process; } },
  );
  session.sendUserMessage('delegate');
  process.emitJson(
    { type: 'item.started', item: { id: 'collab-1', type: 'collab_tool_call', tool: 'spawn_agent', prompt: 'inspect', receiver_thread_ids: ['child-1'], status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'collab-1', type: 'collab_tool_call', tool: 'spawn_agent', receiver_thread_ids: ['child-1'], agents_states: { 'child-1': { status: 'completed', message: 'done' } }, status: 'completed' } },
  );
  const call = emitted.find((event) => event.type === 'tool-call');
  const result = emitted.find((event) => event.type === 'tool-result');
  assert.equal(call.tool, 'subagent:spawn_agent');
  assert.match(call.argsJson, /child-1/);
  assert.equal(result.ok, true);
  assert.match(result.resultPreview, /done/);
  session.dispose();
});
