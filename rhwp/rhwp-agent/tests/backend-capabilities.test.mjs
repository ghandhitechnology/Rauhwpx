import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildClaudeArgv,
  buildClaudeSdkOptions,
  createClaudeSession,
  flushClaudeCredentialMirrors,
  prepareClaudeHome,
} from '../agents/claude.mjs';
import {
  createCodexSession,
  buildCodexArgv,
  flushCodexCredentialMirror,
  prepareCodexHome,
} from '../agents/codex.mjs';
import {
  buildCodexAppServerArgv,
  sandboxPolicy as codexAppServerSandboxPolicy,
} from '../agents/codex-app-server.mjs';
import { buildCursorCliConfig } from '../agents/cursor.mjs';
import { buildGrokArgv } from '../agents/grok.mjs';
import { buildPiArgv, buildPiEnv } from '../agents/pi.mjs';
import {
  mcpCapabilityEnv,
  mcpRuntimeFor,
  parallelWorkBriefFor,
  providerInteractionMode,
  providerToolNoteFor,
  RHWP_SUBAGENTS,
  systemBriefFor,
  validateExecutionMode,
} from '../agents/backend.mjs';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'rhwp-backend-test-'));
test.after(() => rmSync(testHome, { recursive: true, force: true }));

const baseOpts = {
  rootDir: '/tmp/Rau workspace',
  isolatedHome: testHome,
  codexHome: path.join(testHome, '.codex'),
  mcpScriptPath: '/tmp/Rau runtime/mcp stdio.mjs',
  mcpRuntimeCommand: '/Applications/Rau App/Rau',
  mcpRuntimeArgs: ['--no-warnings'],
  mcpRuntimeEnv: { ELECTRON_RUN_AS_NODE: '1' },
  hubPort: 6199,
  token: 'secret-token',
  sessionId: 'studio-thread-42',
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
      this.emit('close', null, signal);
    });
    return true;
  }

  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  exitOnly(code) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  close(code) {
    this.emit('close', code ?? this.exitCode, null);
  }

  exit(code) {
    this.exitOnly(code);
    this.close(code);
  }
}

function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate, message = 'condition did not settle') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await nextTask();
  }
  assert.fail(message);
}

test('MCP runtime defaults to the current executable for development', () => {
  assert.deepEqual(
    mcpRuntimeFor({ mcpScriptPath: '/tmp/dev project/mcp-stdio.mjs' }, {}),
    { command: process.execPath, args: ['/tmp/dev project/mcp-stdio.mjs'], env: {} },
  );
  assert.deepEqual(
    mcpRuntimeFor({ mcpScriptPath: 'C:\\Rau App\\mcp-stdio.mjs' }, { ELECTRON_RUN_AS_NODE: '1' }).env,
    { ELECTRON_RUN_AS_NODE: '1' },
  );
});

test('dedicated worker identity and exact tool profile reach every provider MCP process', () => {
  const opts = {
    ...baseOpts,
    workflow: 'direct',
    phase: 'implementing',
    capabilityEpoch: 17,
    toolProfile: 'copy-layout-worker',
    agentRole: 'copy-layout-worker:job:secret',
    systemPromptOverride: 'AUTONOMOUS TEMPLATE WORKER',
  };
  assert.deepEqual(mcpCapabilityEnv(opts), {
    RHWP_SESSION_ID: 'studio-thread-42',
    RHWP_AGENT_WORKFLOW: 'direct',
    RHWP_AGENT_PHASE: 'implementing',
    RHWP_CAPABILITY_EPOCH: '17',
    RHWP_IMAGE_ROOTS: '/tmp/Rau workspace',
    RHWP_TOOL_PROFILE: 'copy-layout-worker',
    RHWP_AGENT_ROLE: 'copy-layout-worker:job:secret',
  });
  assert.equal(systemBriefFor(opts), 'AUTONOMOUS TEMPLATE WORKER');

  const claudeMcp = JSON.parse(argValue(buildClaudeArgv(opts, sessionId, false), '--mcp-config')).mcpServers.rhwp;
  assert.equal(claudeMcp.env.RHWP_TOOL_PROFILE, 'copy-layout-worker');
  assert.equal(claudeMcp.env.RHWP_AGENT_ROLE, 'copy-layout-worker:job:secret');
  const codexEnv = codexConfig(buildCodexArgv(opts, null), 'mcp_servers.rhwp.env=');
  assert.match(codexEnv, /RHWP_TOOL_PROFILE = "copy-layout-worker"/);
  assert.match(codexEnv, /RHWP_AGENT_ROLE = "copy-layout-worker:job:secret"/);
});

test('safe copy-layout workers have job-local reads and no native write, shell, or web surface', () => {
  const opts = {
    ...baseOpts,
    rootDir: '/tmp/job-only',
    readOnlyRoots: ['/tmp/job-snapshot', '/tmp/job-generated'],
    workflow: 'direct',
    phase: 'implementing',
    capabilityEpoch: 17,
    permissionProfile: 'safe',
    toolProfile: 'copy-layout-worker',
    agentRole: 'copy-layout-worker:job:secret',
  };

  const claude = buildClaudeArgv(opts, sessionId, false);
  assert.equal(argValue(claude, '--tools'), 'Read,Glob,Grep');
  const claudeAllow = JSON.parse(argValue(claude, '--settings')).permissions.allow;
  assert.equal(claudeAllow.some((rule) => /^(?:Bash|Web|Write|Edit|Agent|Workflow)/.test(rule)), false);

  const codex = buildCodexArgv(opts, null);
  assert.match(codexConfig(codex, 'sandbox_mode='), /read-only/);
  for (const feature of ['multi_agent', 'shell_tool', 'unified_exec', 'code_mode_host', 'standalone_web_search']) {
    assert.ok(codex.some((value, index) => value === '--disable' && codex[index + 1] === feature), feature);
    const app = buildCodexAppServerArgv(opts);
    assert.ok(app.some((value, index) => value === '--disable' && app[index + 1] === feature), `app:${feature}`);
  }
  assert.deepEqual(codexAppServerSandboxPolicy(opts), { type: 'readOnly', networkAccess: false });

  const cursor = buildCursorCliConfig(opts, {});
  assert.equal(cursor.permissions.allow.some((rule) => /^(?:Write|Shell|WebFetch)/.test(rule)), false);
  assert.deepEqual(cursor.permissions.deny, ['Write(**)']);

  const grok = buildGrokArgv(opts, 'session', false, '/tmp/prompt');
  const grokAllow = grok.flatMap((value, index) => (value === '--allow' ? [grok[index + 1]] : []));
  const grokDeny = grok.flatMap((value, index) => (value === '--deny' ? [grok[index + 1]] : []));
  assert.equal(grokAllow.some((rule) => /^(?:Edit|WebFetch|WebSearch)/.test(rule)), false);
  assert.deepEqual(grokDeny, ['Bash', 'Edit', 'Write']);

  const pi = buildPiArgv({ ...opts, piRoot: '/tmp/pi' }, 'session');
  assert.equal(pi[pi.indexOf('--exclude-tools') + 1], 'bash,edit,write');
});

test('image roots cannot smuggle extra allowlisted paths through the platform delimiter', () => {
  assert.throws(
    () => mcpCapabilityEnv({
      ...baseOpts,
      workflow: 'direct',
      phase: 'implementing',
      capabilityEpoch: 1,
      rootDir: `/tmp/workspace${path.delimiter}/etc`,
    }),
    /image root cannot contain the platform path delimiter/,
  );
  assert.throws(
    () => mcpCapabilityEnv({
      ...baseOpts,
      workflow: 'direct',
      phase: 'implementing',
      capabilityEpoch: 1,
      readOnlyRoots: [`/tmp/private${path.delimiter}/etc`],
    }),
    /read-only root cannot contain the platform path delimiter/,
  );
});

test('hub-private paths are readable but never writable across every provider profile', () => {
  const privateRoot = '/tmp/Rau hub private/snapshots';
  const opts = {
    ...baseOpts,
    readOnlyRoots: [privateRoot],
    workflow: 'direct',
    phase: 'implementing',
    capabilityEpoch: 1,
    permissionProfile: 'safe',
  };
  const imageRoots = [baseOpts.rootDir, privateRoot].join(path.delimiter);
  assert.equal(mcpCapabilityEnv(opts).RHWP_IMAGE_ROOTS, imageRoots);

  for (const planning of [false, true]) {
    const profile = planning
      ? { ...opts, workflow: 'plan', phase: 'planning' }
      : opts;
    const claude = buildClaudeArgv(profile, sessionId, false);
    const claudeSettings = JSON.parse(argValue(claude, '--settings'));
    assert.deepEqual(claudeSettings.sandbox.filesystem.allowRead, [baseOpts.rootDir, privateRoot]);
    assert.equal(
      claudeSettings.permissions.allow.includes(`Read(//tmp/Rau hub private/snapshots/**)`),
      true,
    );
    assert.equal(
      claudeSettings.permissions.allow.some((rule) => /^(?:Write|Edit)\(/.test(rule) && rule.includes(privateRoot)),
      false,
    );
    assert.equal(claudeSettings.sandbox.filesystem.allowWrite.includes(privateRoot), false);

    const codex = buildCodexArgv(profile, null);
    assert.match(codexConfig(codex, 'mcp_servers.rhwp.env='), /Rau hub private\/snapshots/);
    assert.equal(codex.some((value) => String(value).includes('writable_roots')), false);
    const appPolicy = codexAppServerSandboxPolicy(profile);
    assert.equal(appPolicy.writableRoots?.includes(privateRoot) ?? false, false);
    if (!planning) assert.deepEqual(appPolicy.writableRoots, [baseOpts.rootDir]);
    else assert.equal(appPolicy.type, 'readOnly');

    const cursor = buildCursorCliConfig(profile, {});
    assert.ok(cursor.permissions.allow.includes('Read(**)'));
    assert.equal(cursor.permissions.allow.some((rule) => rule.startsWith(`Write(${privateRoot}`)), false);

    const grok = buildGrokArgv(profile, 'session', false, '/tmp/prompt');
    const grokAllows = grok.flatMap((value, index) => (value === '--allow' ? [grok[index + 1]] : []));
    assert.ok(grokAllows.includes('Read(/tmp/Rau hub private/snapshots/**)'));
    assert.equal(grokAllows.some((rule) => rule.startsWith(`Edit(${privateRoot}`)), false);

    for (const agentName of ['pi', 'rau']) {
      const env = buildPiEnv({ ...profile, piRoot: '/tmp/pi', agentName }, { PATH: '/usr/bin' });
      assert.equal(env.RHWP_READONLY_ROOTS, privateRoot);
      assert.equal(env.RHWP_ROOT_DIR, baseOpts.rootDir);
      assert.equal(env.RHWP_AGENT_NAME, agentName);
    }
  }
});

test('execution mode validation rejects impossible direct workflow phases', () => {
  for (const phase of ['planning', 'awaiting-approval', 'switching']) {
    assert.throws(
      () => validateExecutionMode({ workflow: 'direct', phase, capabilityEpoch: 1 }),
      new RegExp(`Invalid execution mode: direct/${phase}`),
    );
  }
  assert.doesNotThrow(() => validateExecutionMode({
    workflow: 'direct', phase: 'implementing', capabilityEpoch: 1,
  }));
  assert.doesNotThrow(() => validateExecutionMode({
    workflow: 'question', phase: 'questioning', capabilityEpoch: 1,
  }));
  assert.throws(
    () => validateExecutionMode({ workflow: 'question', phase: 'planning', capabilityEpoch: 1 }),
    /Invalid execution mode: question\/planning/,
  );
});

test('provider interaction modes fail closed on explicit invalid state', () => {
  assert.equal(providerInteractionMode({}), 'default');
  assert.equal(providerInteractionMode({ workflow: 'question', phase: 'questioning' }), 'plan');
  assert.throws(
    () => providerInteractionMode({ workflow: 'unknown', phase: 'planning' }),
    /Unknown workflow: unknown/,
  );
  assert.throws(
    () => providerInteractionMode({ workflow: 'plan', phase: 'unknown' }),
    /Unknown execution phase: unknown/,
  );
  assert.throws(
    () => providerInteractionMode({ workflow: 'direct', phase: 'planning' }),
    /Invalid execution mode: direct\/planning/,
  );
});

const matrix = [
  { name: 'direct safe', workflow: 'direct', phase: 'implementing', permissionProfile: 'safe', interactionMode: 'default', claudeMode: 'dontAsk', claudeWrite: true, claudeBypass: false, codexSandbox: 'workspace-write', planCapabilities: false },
  { name: 'direct full', workflow: 'direct', phase: 'implementing', permissionProfile: 'unrestricted', interactionMode: 'default', claudeMode: 'bypassPermissions', claudeWrite: true, claudeBypass: true, codexSandbox: 'danger-full-access', planCapabilities: false },
  { name: 'planning safe', workflow: 'plan', phase: 'planning', permissionProfile: 'safe', interactionMode: 'plan', claudeMode: 'plan', claudeWrite: false, claudeBypass: false, codexSandbox: 'read-only', planCapabilities: true },
  { name: 'planning full', workflow: 'plan', phase: 'planning', permissionProfile: 'unrestricted', interactionMode: 'plan', claudeMode: 'plan', claudeWrite: false, claudeBypass: false, codexSandbox: 'read-only', planCapabilities: true },
  { name: 'implementing safe', workflow: 'plan', phase: 'implementing', permissionProfile: 'safe', interactionMode: 'build', claudeMode: 'dontAsk', claudeWrite: true, claudeBypass: false, codexSandbox: 'workspace-write', planCapabilities: true },
  { name: 'implementing full', workflow: 'plan', phase: 'implementing', permissionProfile: 'unrestricted', interactionMode: 'build', claudeMode: 'bypassPermissions', claudeWrite: true, claudeBypass: true, codexSandbox: 'danger-full-access', planCapabilities: true },
];

for (const entry of matrix) {
  test(`provider argv capability profile: ${entry.name}`, () => {
    const opts = { ...baseOpts, ...entry, capabilityEpoch: `epoch-${entry.name}` };
    const claude = buildClaudeArgv(opts, sessionId, false);
    const claudeTools = argValue(claude, '--tools').split(',');
    const claudeSettings = JSON.parse(argValue(claude, '--settings'));
    const claudeMcp = JSON.parse(argValue(claude, '--mcp-config')).mcpServers.rhwp;

    assert.equal(providerInteractionMode(opts), entry.interactionMode);
    assert.equal(argValue(claude, '--permission-mode'), entry.claudeMode);
    assert.equal(claudeTools.includes('Write'), entry.claudeWrite);
    assert.equal(claudeTools.includes('Edit'), entry.claudeWrite);
    assert.ok(claudeTools.includes('Read'));
    assert.ok(claudeTools.includes('Glob'));
    assert.ok(claudeTools.includes('Grep'));
    assert.ok(claudeTools.includes('Bash'));
    assert.ok(claudeTools.includes('WebSearch'));
    assert.ok(claudeTools.includes('WebFetch'));
    // Agent/Workflow 는 모든 모드에서 켜진다 — --tools 제한이 서브에이전트에도
    // 상속되므로 planning 의 read-only 경계는 그대로 유지된다.
    assert.ok(claudeTools.includes('Agent'));
    assert.ok(claudeTools.includes('Workflow'));
    assert.ok(claude.includes('--forward-subagent-text'));
    const claudeAgents = JSON.parse(argValue(claude, '--agents'));
    assert.ok(claudeAgents['doc-editor']);
    assert.ok(claudeAgents['doc-researcher']);
    assert.equal(claudeAgents['doc-editor'].tools, undefined);
    assert.equal(claude.includes('--dangerously-skip-permissions'), entry.claudeBypass);
    if (!entry.claudeWrite) {
      assert.deepEqual(claudeSettings.sandbox.filesystem.allowWrite, []);
      assert.doesNotMatch(JSON.stringify(claudeSettings.permissions.allow), /Write|Edit/);
    }
    assert.equal(claudeMcp.env.RHWP_AGENT_WORKFLOW, entry.workflow);
    assert.equal(claudeMcp.env.RHWP_AGENT_PHASE, entry.phase);
    assert.equal(claudeMcp.env.RHWP_CAPABILITY_EPOCH, `epoch-${entry.name}`);
    assert.equal(claudeMcp.env.RHWP_SESSION_ID, 'studio-thread-42');
    assert.equal(claudeMcp.command, '/Applications/Rau App/Rau');
    assert.deepEqual(claudeMcp.args, ['--no-warnings', '/tmp/Rau runtime/mcp stdio.mjs']);
    assert.equal(claudeMcp.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(claudeMcp.env.RHWP_WS_URL, 'ws://127.0.0.1:6199/mcp');

    const codex = buildCodexArgv(opts, null);
    assert.ok(codex.includes(`sandbox_mode="${entry.codexSandbox}"`));
    assert.ok(codex.includes('mcp_servers.rhwp.default_tools_approval_mode="auto"'));
    // 네이티브 서브에이전트는 모든 모드에서 켠다 — `--disable multi_agent` 는 codex
    // 0.147.0 에서 스폰을 막지 못한다(라이브 프로브 확인).
    const multiAgentIndex = codex.indexOf('multi_agent');
    assert.notEqual(multiAgentIndex, -1);
    assert.equal(codex[multiAgentIndex - 1], '--enable');
    assert.equal(codex.includes('web_search="live"'), entry.planCapabilities);
    assert.equal(JSON.parse(codexConfig(codex, 'mcp_servers.rhwp.command=').split('=', 2)[1]), '/Applications/Rau App/Rau');
    assert.deepEqual(
      JSON.parse(codexConfig(codex, 'mcp_servers.rhwp.args=').slice('mcp_servers.rhwp.args='.length)),
      ['--no-warnings', '/tmp/Rau runtime/mcp stdio.mjs'],
    );
    const codexEnv = codexConfig(codex, 'mcp_servers.rhwp.env=');
    assert.match(codexEnv, new RegExp(`RHWP_AGENT_WORKFLOW = "${entry.workflow}"`));
    assert.match(codexEnv, new RegExp(`RHWP_AGENT_PHASE = "${entry.phase}"`));
    assert.match(codexEnv, new RegExp(`RHWP_CAPABILITY_EPOCH = "epoch-${entry.name}"`));
    assert.match(codexEnv, /RHWP_SESSION_ID = "studio-thread-42"/);
    assert.match(codexEnv, /ELECTRON_RUN_AS_NODE = "1"/);
    assert.match(codexEnv, /RHWP_WS_URL = "ws:\/\/127\.0\.0\.1:6199\/mcp"/);
  });
}

test('awaiting approval and switching remain read-only regardless of full profile', () => {
  for (const phase of ['awaiting-approval', 'switching']) {
    const opts = { ...baseOpts, workflow: 'plan', phase, capabilityEpoch: 9, permissionProfile: 'unrestricted' };
    const claude = buildClaudeArgv(opts, sessionId, false);
    assert.equal(argValue(claude, '--tools').split(',').includes('Write'), false);
    assert.equal(argValue(claude, '--permission-mode'), 'plan');
    assert.equal(providerInteractionMode(opts), 'plan');
    assert.ok(buildCodexArgv(opts, null).includes('sandbox_mode="read-only"'));
  }
});

test('question workflow uses native Plan capabilities without write tools', () => {
  const opts = {
    ...baseOpts,
    workflow: 'question',
    phase: 'questioning',
    capabilityEpoch: 3,
    permissionProfile: 'unrestricted',
  };
  assert.equal(providerInteractionMode(opts), 'plan');
  const claude = buildClaudeArgv(opts, sessionId, false);
  assert.equal(argValue(claude, '--permission-mode'), 'plan');
  assert.equal(argValue(claude, '--tools').split(',').includes('Write'), false);
  assert.equal(argValue(claude, '--tools').split(',').includes('Edit'), false);
  const codex = buildCodexArgv(opts, null);
  assert.ok(codex.includes('sandbox_mode="read-only"'));
  assert.ok(codex.includes('web_search="live"'));
});

test('Claude SDK projects plan and build intent independently from access', () => {
  const requestUserInput = async () => ({ status: 'cancelled', reason: 'user-stop' });
  const plan = buildClaudeSdkOptions({
    ...baseOpts,
    workflow: 'plan',
    phase: 'awaiting-approval',
    permissionProfile: 'unrestricted',
    requestUserInput,
    agentRole: 'chat',
    providerEnv: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/host/custom-claude' },
  }, sessionId, false, new AbortController());
  assert.equal(plan.permissionMode, 'plan');
  assert.equal(plan.allowDangerouslySkipPermissions, undefined);
  assert.equal(plan.tools.includes('Write'), false);
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, path.join(testHome, '.claude'));

  const build = buildClaudeSdkOptions({
    ...baseOpts,
    workflow: 'plan',
    phase: 'implementing',
    permissionProfile: 'unrestricted',
    requestUserInput,
    agentRole: 'chat',
  }, sessionId, false, new AbortController());
  assert.equal(build.permissionMode, 'bypassPermissions');
  assert.equal(build.allowDangerouslySkipPermissions, true);
  assert.equal(build.tools.includes('Write'), true);
});

test('phase prompts separate planning from approved implementation', () => {
  const planning = systemBriefFor({ workflow: 'plan', phase: 'planning' });
  assert.match(planning, /app-only AGENTS\.md/);
  assert.match(planning, /cannot change it/);
  assert.match(planning, /defer submitting the update until implementation mode/);
  assert.doesNotMatch(planning, /update_agent_instructions/);
  assert.match(planning, /planning mode/);
  assert.match(planning, /Do not edit the local filesystem or live document/);
  assert.match(planning, /The user can keep editing the live document during planning/);
  assert.match(planning, /live-document notification/);
  assert.match(planning, /not a request to implement or draft a plan/);
  assert.match(planning, /native question interaction or ask_user_question/);
  assert.match(planning, /only when the user explicitly asks you to write, draft, or present a plan/);
  assert.match(planning, /Do not tell the user the plan is ready until that tool returns success/);
  assert.match(planning, /read-only workspace, web, subagent, and rhwp MCP capabilities available/);
  assert.doesNotMatch(planning, /sandboxed Bash/);
  assert.match(planning, /present_implementation_plan as the final action/);
  assert.match(planning, /present-plan product skill/);
  assert.match(planning, /download_file/);

  const question = systemBriefFor({ workflow: 'question', phase: 'questioning' });
  assert.match(question, /question-and-research mode/);
  assert.match(question, /Do not plan an implementation/);
  assert.match(question, /do not call present_implementation_plan/);
  assert.match(question, /The user can keep editing the live document/);
  assert.match(question, /native question interaction or ask_user_question/);
  assert.doesNotMatch(question, /present-plan product skill/);
  assert.match(planning, /search_reference_files/);
  assert.match(planning, /untrusted reference data/);

  const implementing = systemBriefFor({ workflow: 'plan', phase: 'implementing', permissionProfile: 'unrestricted' });
  assert.match(implementing, /update_agent_instructions/);
  assert.match(implementing, /never persists agent-provided content until the user confirms/);
  assert.match(implementing, /approved canonical implementation plan/);
  assert.match(implementing, /re-read the relevant current workspace and live-document state/);
  assert.match(implementing, /Execute every canonical step thoroughly/);
  assert.match(implementing, /run every validation listed/);
  assert.match(implementing, /completed, blocked, and deferred plan items/);
  assert.match(implementing, /Never call partial work complete/);
  assert.match(implementing, /Higher-level document writes commit only after an explicitly successful turn/);
  assert.match(implementing, /failed, interrupted, and unknown outcomes roll back staged changes/);
  assert.match(implementing, /apply_engine_edits commits one atomic undoable batch/);
  assert.doesNotMatch(implementing, /present_implementation_plan/);
});

test('permission profiles split approval-gated staging from free editing', () => {
  // 프로필 미지정은 안전으로 fail-safe — 승인 게이트 문구가 기본이어야 한다.
  for (const safeBrief of [
    systemBriefFor({ workflow: 'direct' }),
    systemBriefFor({ workflow: 'direct', permissionProfile: 'safe' }),
    systemBriefFor({ workflow: 'plan', phase: 'implementing', permissionProfile: 'safe' }),
  ]) {
    assert.match(safeBrief, /review and approve the staged changes/);
    assert.match(safeBrief, /unavailable in this perm/);
    assert.doesNotMatch(safeBrief, /commit only after an explicitly successful turn/);
  }
  for (const freeBrief of [
    systemBriefFor({ workflow: 'direct', permissionProfile: 'unrestricted' }),
    systemBriefFor({ workflow: 'plan', phase: 'implementing', permissionProfile: 'unrestricted' }),
  ]) {
    assert.doesNotMatch(freeBrief, /review and approve the staged changes/);
    assert.match(freeBrief, /apply_engine_edits commits/);
  }
});

test('parallel-work guidance is tuned to each provider surface', () => {
  const pi = parallelWorkBriefFor('pi');
  assert.doesNotMatch(pi, /Workflow tool/);
  assert.match(pi, /subagent_spawn/);
  assert.match(pi, /role=doc-editor/);
  assert.match(pi, /subagent_wait until every agent/);
  assert.match(pi, /Never call subagent_wait for an MCP-managed background job/);
  assert.match(pi, /ONE apply_edits call/, '배치가 pi 의 대체 병렬성이다');
  assert.equal(parallelWorkBriefFor('rau'), pi);

  const grok = parallelWorkBriefFor('grok');
  assert.match(grok, /spawn_subagent/);
  assert.match(grok, /get_command_or_subagent_output/);
  assert.match(
    grok,
    /Never use get_command_or_subagent_output on the hub background job delegate_copy_layout/,
    '수거 지시가 허브 백그라운드 작업을 집어 오는 사고를 막는다',
  );

  const cursor = parallelWorkBriefFor('cursor');
  assert.match(cursor, /transcript arrives only when it finishes/);
  assert.match(cursor, /tightly bounded objective/, '전사 재생 상한을 고려한 목표 경계');

  const codex = parallelWorkBriefFor('codex');
  assert.match(codex, /wait_agent until every agent/);
  assert.match(codex, /Never call wait_agent for an MCP-managed background job such as delegate_copy_layout/);

  // claude 기본 브리프는 그대로 편대 안내를 실는다.
  assert.match(parallelWorkBriefFor(), /doc-editor for edits/);
});

test('provider tool notes correct activated skill text per collaboration surface', () => {
  for (const [agent, fragment] of [
    ['claude', /never poll or wait for them/],
    ['codex', /never call wait_agent or list_agents for one/],
    ['grok', /never collect them with get_command_or_subagent_output/],
    ['cursor', /there is no polling tool/],
    ['pi', /never call subagent_wait or subagent_list for one/],
    ['rau', /never call subagent_wait or subagent_list for one/],
  ]) {
    const note = providerToolNoteFor(agent);
    assert.match(note, fragment, agent);
    assert.match(note, /delegate_copy_layout/, agent);
    assert.match(note, /hub will start a new turn carrying/, agent);
  }
  assert.equal(providerToolNoteFor('rau'), providerToolNoteFor('pi'));
  assert.equal(providerToolNoteFor('mystery'), '', '알 수 없는 provider 는 주석을 붙이지 않는다');
});

test('every write-capable brief directs batched writes through apply_edits', () => {
  for (const writeBrief of [
    systemBriefFor({ workflow: 'direct' }),
    systemBriefFor({ workflow: 'direct', permissionProfile: 'safe' }),
    systemBriefFor({ workflow: 'direct', permissionProfile: 'unrestricted' }),
    systemBriefFor({ workflow: 'plan', phase: 'implementing', permissionProfile: 'safe' }),
    systemBriefFor({ workflow: 'plan', phase: 'implementing', permissionProfile: 'unrestricted' }),
  ]) {
    assert.match(writeBrief, /apply_edits/);
    assert.match(writeBrief, /up to 32 items/);
    assert.match(writeBrief, /bottom-of-document first/);
    assert.match(writeBrief, /recovery guidance in the error message/);
    assert.doesNotMatch(writeBrief, /ONE AT A TIME/);
  }
});

test('doc-editor subagent prompt batches independent writes through apply_edits', () => {
  const prompt = RHWP_SUBAGENTS['doc-editor'].prompt;
  assert.match(prompt, /apply_edits/);
  assert.match(prompt, /up to 32 items/);
  assert.doesNotMatch(prompt, /one write at a time/i);
});

test('all workflow system prompts default document design to black and white', () => {
  const briefs = [
    systemBriefFor({ workflow: 'direct', phase: 'implementing' }),
    systemBriefFor({ workflow: 'plan', phase: 'planning' }),
    systemBriefFor({ workflow: 'plan', phase: 'implementing' }),
  ];
  for (const brief of briefs) {
    assert.match(brief, /default to black text, white or unfilled backgrounds, and black borders/);
    assert.match(brief, /obvious, consistent color palette/);
    assert.match(brief, /user explicitly requests a color/);
    assert.match(brief, /reuse its established colors/);
  }
});

test('plan revision prompt reopens discovery instead of forcing replacement', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /Return to discovery: inspect the affected current state/);
  assert.match(server, /ambiguous or changes an assumption/);
  assert.match(server, /ask one focused question in normal chat instead of immediately presenting a replacement/);
  assert.doesNotMatch(server, /Revise the plan in response and present the complete replacement/);
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
  assert.equal(spawnEnv.USERPROFILE, isolatedHome);
  assert.equal(spawnEnv.RHWP_SESSION_ID, 'studio-thread-42');
  assert.equal(spawnEnv.CODEX_HOME, codexHome);
  child.exit(0);
  session.dispose();
});

test('Claude isolation seeds only the shared login files with a Windows copy fallback', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-copy-test-'));
  const sourceHome = path.join(root, 'source');
  const isolatedHome = path.join(root, 'isolated');
  const credentialsPath = path.join(sourceHome, '.claude', '.credentials.json');
  const configPath = path.join(sourceHome, '.claude.json');
  mkdirSync(path.dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, '{"oauth":"shared"}');
  writeFileSync(configPath, '{"account":"shared"}');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const windowsDeps = {
    platform: 'win32',
    symlink() {
      const error = new Error('symlinks require elevation');
      error.code = 'EPERM';
      throw error;
    },
  };
  prepareClaudeHome(isolatedHome, { credentialsPath, configPath }, windowsDeps);

  assert.equal(readFileSync(path.join(isolatedHome, '.claude', '.credentials.json'), 'utf8'), '{"oauth":"shared"}');
  assert.equal(readFileSync(path.join(isolatedHome, '.claude.json'), 'utf8'), '{"account":"shared"}');
  assert.deepEqual(readdirSync(path.join(isolatedHome, '.claude')), ['.credentials.json']);
  writeFileSync(path.join(isolatedHome, '.claude', '.credentials.json'), '{"oauth":"first-refresh"}');
  writeFileSync(path.join(isolatedHome, '.claude.json'), '{"account":"first-refresh"}');
  prepareClaudeHome(isolatedHome, { credentialsPath, configPath }, windowsDeps);
  assert.equal(readFileSync(credentialsPath, 'utf8'), '{"oauth":"first-refresh"}');
  assert.equal(readFileSync(configPath, 'utf8'), '{"account":"first-refresh"}');
  writeFileSync(path.join(isolatedHome, '.claude', '.credentials.json'), '{"oauth":"refreshed"}');
  writeFileSync(path.join(isolatedHome, '.claude.json'), '{"account":"refreshed"}');
  flushClaudeCredentialMirrors(isolatedHome);
  assert.equal(readFileSync(credentialsPath, 'utf8'), '{"oauth":"refreshed"}');
  assert.equal(readFileSync(configPath, 'utf8'), '{"account":"refreshed"}');
});

test('Claude custom config credentials are copied per session and CAS refreshed', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-custom-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const customConfigDir = path.join(root, 'host-custom-config');
  const credentialsPath = path.join(customConfigDir, '.credentials.json');
  const configPath = path.join(root, 'host', '.claude.json');
  const firstHome = path.join(root, 'session-a');
  const secondHome = path.join(root, 'session-b');
  mkdirSync(customConfigDir, { recursive: true });
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(credentialsPath, '{"oauth":"host-old"}');
  writeFileSync(configPath, '{"account":"host"}');

  prepareClaudeHome(firstHome, { credentialsPath, configPath });
  prepareClaudeHome(secondHome, { credentialsPath, configPath });
  const firstCredential = path.join(firstHome, '.claude', '.credentials.json');
  const secondCredential = path.join(secondHome, '.claude', '.credentials.json');
  assert.equal(lstatSync(firstCredential).isSymbolicLink(), false);
  assert.equal(lstatSync(secondCredential).isSymbolicLink(), false);

  writeFileSync(firstCredential, '{"oauth":"session-a-refresh"}');
  assert.equal(readFileSync(credentialsPath, 'utf8'), '{"oauth":"host-old"}');
  assert.equal(readFileSync(secondCredential, 'utf8'), '{"oauth":"host-old"}');
  assert.equal(flushClaudeCredentialMirrors(firstHome), true);
  assert.equal(readFileSync(credentialsPath, 'utf8'), '{"oauth":"session-a-refresh"}');

  writeFileSync(secondCredential, '{"oauth":"session-b-refresh"}');
  assert.equal(flushClaudeCredentialMirrors(secondHome), true);
  assert.equal(
    readFileSync(credentialsPath, 'utf8'),
    '{"oauth":"session-a-refresh"}',
    'the later session cannot overwrite a host credential changed since its seed',
  );
});

test('Codex auth falls back to a copy when Windows rejects symlink creation', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-copy-test-'));
  const codexHome = path.join(root, 'isolated', '.codex');
  const authPath = path.join(root, 'auth.json');
  writeFileSync(authPath, '{"token":"copied"}');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const windowsDeps = {
    platform: 'win32',
    symlink() {
      const error = new Error('symlinks require elevation');
      error.code = 'EPERM';
      throw error;
    },
  };
  prepareCodexHome(codexHome, authPath, windowsDeps);

  assert.equal(readFileSync(path.join(codexHome, 'auth.json'), 'utf8'), '{"token":"copied"}');
  writeFileSync(path.join(codexHome, 'auth.json'), '{"token":"first-refresh"}');
  const mirror = prepareCodexHome(codexHome, authPath, windowsDeps);
  assert.equal(readFileSync(authPath, 'utf8'), '{"token":"first-refresh"}');
  writeFileSync(path.join(codexHome, 'auth.json'), '{"token":"refreshed"}');
  const journal = readFileSync(mirror.journalPath);
  writeFileSync(mirror.journalPath, Buffer.alloc(70 * 1024));
  assert.equal(flushCodexCredentialMirror(codexHome), false);
  assert.equal(existsSync(path.join(codexHome, 'auth.json')), true);
  writeFileSync(mirror.journalPath, journal);
  assert.equal(flushCodexCredentialMirror(codexHome), true);
  assert.equal(readFileSync(authPath, 'utf8'), '{"token":"refreshed"}');
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
    terminateProcess: async () => true,
    waitForExit: async () => true,
  });

  session.sendUserMessage('inspect');
  process.emitJson({ type: 'turn.completed' });
  assert.equal(events.some((event) => event.type === 'turn-end'), false);
  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 2 }),
    /only change between turns/,
  );

  process.exit(0);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  await session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 2 });
  session.dispose();
});

test('Codex interrupt discards an unterminated terminal frame', async () => {
  const events = [];
  let child;
  const session = createCodexSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    spawnProcess() {
      child = new FakeProcess();
      return child;
    },
    terminateProcess: async () => true,
    waitForExit: async () => true,
  });

  session.sendUserMessage('interrupt before the terminal frame is drained');
  child.stdout.emit('data', JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 12, output_tokens: 4 },
  }));
  session.interrupt();
  child.exit(0);
  await nextTask();

  assert.equal(events.some((event) => event.type === 'usage'), false);
  assert.deepEqual(
    events.filter((event) => event.type === 'turn-end'),
    [{ type: 'turn-end', agent: 'codex', stopReason: 'interrupted' }],
  );
  assert.equal(await session.dispose(), true);
});

test('Claude interrupt discards an unterminated terminal frame', async () => {
  const events = [];
  let child;
  const session = createClaudeSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    spawnProcess() {
      child = new FakeProcess();
      return child;
    },
    terminateProcess: async () => true,
    waitForExit: async () => true,
  });

  session.sendUserMessage('interrupt before the terminal frame is drained');
  await nextTask();
  child.stdout.emit('data', JSON.stringify({
    type: 'result',
    subtype: 'success',
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 4 },
  }));
  session.interrupt();
  child.exit(0);
  await nextTask();

  assert.equal(events.some((event) => event.type === 'usage'), false);
  assert.deepEqual(
    events.filter((event) => event.type === 'turn-end'),
    [{ type: 'turn-end', agent: 'claude', stopReason: 'interrupted' }],
  );
  assert.equal(await session.dispose(), true);
});

test('Codex exit grace without close discards an unterminated terminal frame', async () => {
  const events = [];
  let child;
  const session = createCodexSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    closeGraceMs: 5,
    spawnProcess() {
      child = new FakeProcess();
      return child;
    },
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });

  session.sendUserMessage('leader exits while a descendant retains stdout');
  child.stdout.emit('data', JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 12, output_tokens: 4 },
  }));
  child.exitOnly(0);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(events.some((event) => event.type === 'usage'), false);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'codex', stopReason: 'exited' });
  assert.equal(await session.dispose(), false);
});

test('Codex exit grace without close rejects a newline-terminated terminal frame', async () => {
  const events = [];
  let child;
  const session = createCodexSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    closeGraceMs: 5,
    spawnProcess() {
      child = new FakeProcess();
      return child;
    },
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });

  session.sendUserMessage('terminal frame arrives but stdout never closes');
  child.emitJson({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } });
  child.exitOnly(0);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(events.some((event) => event.type === 'usage'), true);
  assert.equal(
    events.some((event) => event.type === 'turn-end' && event.stopReason === 'completed'),
    false,
  );
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'codex', stopReason: 'exited' });
  assert.equal(await session.dispose(), false);
});

test('Claude exit grace without close discards an unterminated terminal frame', async () => {
  const events = [];
  let child;
  const session = createClaudeSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    closeGraceMs: 5,
    spawnProcess() {
      child = new FakeProcess();
      return child;
    },
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });

  session.sendUserMessage('leader exits while a descendant retains stdout');
  await nextTask();
  child.stdout.emit('data', JSON.stringify({
    type: 'result',
    subtype: 'success',
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 4 },
  }));
  child.exitOnly(0);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(events.some((event) => event.type === 'usage'), false);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'claude', stopReason: 'exited' });
  assert.equal(await session.dispose(), false);
});

test('natural Codex leader exit retains tree cleanup result for delayed disposal', async () => {
  let child;
  let finishTermination;
  let finishTreeWait;
  let terminationCalls = 0;
  const termination = new Promise((resolve) => { finishTermination = resolve; });
  const treeWait = new Promise((resolve) => { finishTreeWait = resolve; });
  const session = createCodexSession({
    ...baseOpts,
    permissionProfile: 'safe',
  }, {
    spawnProcess() {
      child = new FakeProcess();
      return child;
    },
    terminateProcess() {
      terminationCalls += 1;
      return termination;
    },
    waitForExit: () => treeWait,
  });
  session.sendUserMessage('finish while a descendant owns stdout');
  child.emitJson({ type: 'turn.completed', usage: {} });
  child.exitOnly(0);

  let settled = false;
  const disposed = session.dispose().then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(terminationCalls, 1);
  finishTermination(true);
  finishTreeWait(false);
  assert.equal(await disposed, false);
  assert.equal(await session.dispose(), false);
});

test('a Windows Codex terminal tail without newline drains before unavailable cleanup quarantine', async () => {
  const events = [];
  const children = [];
  const session = createCodexSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    spawnProcess() {
      const child = new FakeProcess();
      children.push(child);
      return child;
    },
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });

  session.sendUserMessage('first');
  children[0].stdout.emit('data', JSON.stringify({ type: 'turn.completed', usage: {} }));
  children[0].exit(0);
  await nextTask();
  session.sendUserMessage('must not spawn');

  assert.equal(children.length, 1);
  assert.equal(
    events.filter((event) => event.type === 'turn-start').length,
    1,
    'quarantined cleanup must not advertise a second provider turn',
  );
  assert.match(events.findLast((event) => event.type === 'error').message, /cleanup remains unconfirmed/);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'codex', stopReason: 'failed' });
  assert.equal(await session.dispose(), false);
});

test('Windows Codex terminal cleanup starts live, drains buffered output, and allows another turn', async () => {
  const events = [];
  const children = [];
  let cleanupCalls = 0;
  const session = createCodexSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    spawnProcess() {
      const child = new FakeProcess();
      children.push(child);
      return child;
    },
    terminateProcess(child) {
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      cleanupCalls += 1;
      return true;
    },
    waitForExit: async () => true,
  });

  session.sendUserMessage('first');
  children[0].emitJson(
    { type: 'turn.completed', usage: {} },
    {
      type: 'item.completed',
      item: {
        id: 'buffered-command',
        type: 'command_execution',
        status: 'completed',
        aggregated_output: 'drained',
      },
    },
  );
  assert.equal(cleanupCalls, 1);
  assert.equal(events.some((event) => event.type === 'tool-result' && event.callId === 'buffered-command'), true);
  children[0].exit(0);
  await nextTask();

  session.sendUserMessage('second');
  assert.equal(children.length, 2);
  const disposing = session.dispose();
  children[1].exit(0);
  assert.equal(await disposing, true);
});

test('a Windows Claude terminal tail without newline drains before unavailable cleanup quarantine', async () => {
  const events = [];
  const children = [];
  const session = createClaudeSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    spawnProcess() {
      const child = new FakeProcess();
      children.push(child);
      return child;
    },
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });

  session.sendUserMessage('first');
  await nextTask();
  children[0].stdout.emit('data', JSON.stringify({ type: 'result', stop_reason: 'end_turn' }));
  children[0].exit(0);
  await nextTask();
  const turnStarts = events.filter((event) => event.type === 'turn-start').length;
  const turnEnds = events.filter((event) => event.type === 'turn-end').length;
  assert.throws(
    () => session.sendUserMessage('must not spawn'),
    /cleanup remains unconfirmed/,
  );

  assert.equal(children.length, 1);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, turnStarts);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, turnEnds);
  assert.equal(await session.dispose(), false);
});

test('Claude proves legacy cleanup before turn-end and resumes in a fresh process', async () => {
  const events = [];
  const spawns = [];
  let cleanupCalls = 0;
  const session = createClaudeSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    spawnProcess(command, argv, options) {
      const process = new FakeProcess();
      spawns.push({ command, argv, options, process });
      return process;
    },
    terminateProcess(process) {
      assert.equal(process.exitCode, null);
      assert.equal(process.signalCode, null);
      cleanupCalls += 1;
      process.kill('SIGTERM');
      return true;
    },
    waitForExit: async () => true,
  });

  session.sendUserMessage('turn A');
  await nextTask();
  spawns[0].process.emitJson(
    { type: 'system', subtype: 'init', session_id: 'legacy-resume-id', model: 'claude-test' },
    { type: 'result', subtype: 'success', stop_reason: 'end_turn' },
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'stale-turn-a-task',
      status: 'completed',
    },
  );
  assert.equal(events.some((event) => event.type === 'turn-end'), false);
  await waitUntil(() => events.filter((event) => event.type === 'turn-end').length === 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(events.some((event) => event.type === 'task-end'), false);

  session.sendUserMessage('turn B');
  await waitUntil(() => spawns.length === 2);
  assert.ok(spawns[1].argv.includes('--resume'));
  assert.equal(argValue(spawns[1].argv, '--resume'), 'legacy-resume-id');
  assert.equal(JSON.parse(spawns[1].process.stdin.chunks[0]).message.content[0].text, 'turn B');
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 2);
  assert.equal(await session.dispose(), true);
});

test('Claude waits for an idle restart and resumes with the new phase', async () => {
  const spawns = [];
  const events = [];
  const opts = {
    ...baseOpts,
    permissionProfile: 'safe',
    providerEnv: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/host/custom-claude' },
    onEvent: (event) => events.push(event),
  };
  const session = createClaudeSession(opts, {
    spawnProcess(command, argv, options) {
      const process = new FakeProcess();
      spawns.push({ command, argv, options, process });
      return process;
    },
  });

  session.sendUserMessage('inspect');
  await nextTask();
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.cwd, '/tmp/Rau workspace');
  assert.equal(spawns[0].options.env.HOME, testHome);
  assert.equal(spawns[0].options.env.USERPROFILE, testHome);
  assert.equal(spawns[0].options.env.CLAUDE_CONFIG_DIR, path.join(testHome, '.claude'));
  assert.equal(spawns[0].options.env.RHWP_SESSION_ID, 'studio-thread-42');
  assert.equal(spawns[0].options.detached, process.platform !== 'win32');
  assert.equal(spawns[0].options.windowsHide, true);
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
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));

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

test('Claude terminal cleanup quarantines config changes when proof is unavailable', async () => {
  const events = [];
  let child;
  let finishTermination;
  let finishTreeWait;
  let terminationCalls = 0;
  const termination = new Promise((resolve) => { finishTermination = resolve; });
  const treeWait = new Promise((resolve) => { finishTreeWait = resolve; });
  const session = createClaudeSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    spawnProcess() {
      child = new FakeProcess();
      return child;
    },
    terminateProcess() {
      terminationCalls += 1;
      return termination;
    },
    waitForExit: () => treeWait,
  });
  session.sendUserMessage('complete the current turn');
  await nextTask();
  child.emitJson({ type: 'result', stop_reason: 'end_turn' });
  await nextTask();
  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 2 }),
    /only change between turns/,
  );
  assert.equal(terminationCalls, 1);
  finishTermination(true);
  finishTreeWait(false);
  await waitUntil(() => events.filter((event) => event.type === 'turn-end').length === 1);
  assert.equal(events.at(-1).stopReason, 'failed');
  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 2 }),
    /cleanup remains unconfirmed/,
  );
  assert.equal(await session.dispose(), false);
});

test('Claude preserves a redacted spawn error through delayed exit settlement', async () => {
  const events = [];
  let child;
  const session = createClaudeSession({
    ...baseOpts,
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, {
    spawnProcess() {
      child = new FakeProcess();
      return child;
    },
  });

  session.sendUserMessage('start');
  await nextTask();
  const error = new Error('spawn ENOENT for secret-token');
  error.code = 'ENOENT';
  child.emit('error', error);
  await nextTask();
  await nextTask();

  const surfaced = events.find((event) => event.type === 'error');
  assert.match(surfaced?.message ?? '', /claude process error: spawn ENOENT/);
  assert.doesNotMatch(surfaced?.message ?? '', /secret-token/);
  assert.equal(events.find((event) => event.type === 'turn-end')?.stopReason, 'exited');
  await session.dispose();
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
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));
  await session.dispose();
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

  child.exit(0);
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

// collab_tool_call 은 서브에이전트 카드가 아니다: codex 0.147.0 은 이 항목을
// wait_agent 호출에만 내보낸다(라이브 캡처 runA2.ndjson). 카드는 롤아웃 워처가
// 만들고 — 자세한 배선은 tests/codex-subagent-tasks.test.mjs 를 본다.
test('Codex maps collab wait items to a plain root tool row', () => {
  const emitted = [];
  let process;
  const session = createCodexSession(
    { ...baseOpts, permissionProfile: 'safe', onEvent: (event) => emitted.push(event) },
    { spawnProcess() { process = new FakeProcess(); return process; } },
  );
  session.sendUserMessage('delegate');
  process.emitJson(
    { type: 'item.started', item: { id: 'item_1', type: 'collab_tool_call', tool: 'wait', receiver_thread_ids: [], prompt: null, agents_states: {}, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'collab_tool_call', tool: 'wait', receiver_thread_ids: [], prompt: null, agents_states: {}, status: 'completed' } },
  );
  assert.deepEqual(emitted.filter((event) => event.type.startsWith('task-')), []);
  const call = emitted.find((event) => event.type === 'tool-call');
  assert.equal(call.tool, 'wait_agents');
  assert.equal(call.argsJson, '{}');
  const result = emitted.find((event) => event.type === 'tool-result');
  assert.equal(result.callId, 'item_1');
  assert.equal(result.ok, true);
  session.dispose();
});
