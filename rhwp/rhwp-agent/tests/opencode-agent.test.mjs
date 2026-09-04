import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildOpenCodeConfig,
  buildOpenCodeEnv,
  buildOpenCodePermissions,
  createOpenCodeSession,
  flushOpenCodeCredentialMirror,
  normalizeOpenCodeUsage,
  openCodeAuthPath,
  openCodeResultPreview,
  openCodeToolName,
  prepareOpenCodeHome,
} from '../agents/opencode.mjs';

const baseOpts = {
  rootDir: '/tmp/rhwp-opencode',
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 6401,
  token: 'secret-token',
  sessionId: 'studio-opencode-session',
  model: 'openai/gpt-5',
  effort: 'high',
  permissionProfile: 'safe',
  workflow: 'direct',
  phase: 'implementing',
  capabilityEpoch: 3,
  isolatedHome: '/tmp/rhwp-opencode-home',
  onEvent() {},
};

async function waitFor(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function openCodeApiAuth(key) {
  return JSON.stringify({ openai: { type: 'api', key } });
}

test('OpenCode config applies explicit ordered permissions for each execution profile', () => {
  assert.deepEqual(buildOpenCodePermissions(baseOpts), {
    '*': 'allow', edit: { '*': 'allow' }, bash: 'ask', external_directory: { '*': 'deny' },
  });
  assert.deepEqual(buildOpenCodePermissions({
    ...baseOpts, permissionProfile: 'unrestricted',
  }), {
    '*': 'allow', edit: { '*': 'allow' }, external_directory: 'allow',
  });
  assert.deepEqual(buildOpenCodePermissions({
    ...baseOpts,
    permissionProfile: 'unrestricted',
    workflow: 'plan',
    phase: 'planning',
  }), {
    '*': 'allow', edit: { '*': 'deny' }, bash: 'deny', external_directory: { '*': 'deny' },
  });
  assert.deepEqual(buildOpenCodePermissions({
    ...baseOpts, toolProfile: 'copy-layout-worker',
  }), {
    '*': 'allow',
    edit: { '*': 'deny' },
    bash: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    task: 'deny',
    external_directory: { '*': 'deny' },
  });

  const withReadOnlyRoots = buildOpenCodePermissions({
    ...baseOpts,
    readOnlyRoots: ['/private/snapshot/', '/private/generated', '/private/snapshot/'],
  });
  assert.deepEqual(withReadOnlyRoots.edit, {
    '*': 'allow',
    '/private/snapshot/**': 'deny',
    '/private/generated/**': 'deny',
  });
  assert.deepEqual(withReadOnlyRoots.external_directory, {
    '*': 'deny',
    '/private/snapshot/**': 'allow',
    '/private/generated/**': 'allow',
  });

  const unrestrictedWithReadOnlyRoots = buildOpenCodePermissions({
    ...baseOpts,
    permissionProfile: 'unrestricted',
    readOnlyRoots: ['/private/snapshot/'],
  });
  assert.deepEqual(unrestrictedWithReadOnlyRoots.edit, {
    '*': 'allow',
    '/private/snapshot/**': 'deny',
  });
  assert.equal(unrestrictedWithReadOnlyRoots.external_directory, 'allow');

  const config = buildOpenCodeConfig({
    ...baseOpts,
    openCodeConfig: { provider: { custom: { npm: '@ai-sdk/openai-compatible' } }, autoupdate: true },
  });
  assert.deepEqual(config.provider, { custom: { npm: '@ai-sdk/openai-compatible' } });
  assert.equal(config.autoupdate, false);
  assert.deepEqual(config.permission, {
    '*': 'allow', edit: { '*': 'allow' }, bash: 'ask', external_directory: { '*': 'deny' },
  });
});

test('OpenCode environment isolates every XDG state root and ignores inherited config paths', () => {
  const env = buildOpenCodeEnv(baseOpts, {
    PATH: '/managed/bin',
    LANG: 'ko_KR.UTF-8',
    HTTPS_PROXY: 'http://proxy.test:8443',
    NODE_EXTRA_CA_CERTS: '/etc/test-ca.pem',
    OPENCODE_API_KEY: 'ambient-open-code-key',
    OPENROUTER_API_KEY: 'ambient-openrouter-key',
    GOOGLE_GENERATIVE_AI_API_KEY: 'ambient-google-key',
    GROQ_API_KEY: 'ambient-groq-key',
    AWS_ACCESS_KEY_ID: 'ambient-aws-id',
    AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret',
    AZURE_OPENAI_API_KEY: 'ambient-azure-key',
    GITHUB_TOKEN: 'ambient-github-token',
    OPENCODE_CONFIG: '/host/opencode.json',
    OPENCODE_CONFIG_DIR: '/host/.opencode',
    OPENCODE_DB: '/host/opencode.db',
    OPENCODE_AUTH_CONTENT: 'host-secret',
    OPENCODE_PERMISSION: '{"*":"allow"}',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  });
  assert.equal(env.PATH, '/managed/bin');
  assert.equal(env.HOME, '/tmp/rhwp-opencode-home');
  assert.equal(env.USERPROFILE, '/tmp/rhwp-opencode-home');
  assert.equal(env.XDG_CONFIG_HOME, '/tmp/rhwp-opencode-home/.config');
  assert.equal(env.XDG_DATA_HOME, '/tmp/rhwp-opencode-home/.local/share');
  assert.equal(env.XDG_CACHE_HOME, '/tmp/rhwp-opencode-home/.cache');
  assert.equal(env.XDG_STATE_HOME, '/tmp/rhwp-opencode-home/.local/state');
  assert.equal(env.OPENCODE_CONFIG, undefined);
  assert.equal(env.OPENCODE_CONFIG_DIR, '/tmp/rhwp-opencode-home/.config/opencode');
  assert.equal(env.OPENCODE_DB, undefined);
  assert.equal(env.OPENCODE_AUTH_CONTENT, undefined);
  assert.equal(env.OPENCODE_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.GOOGLE_GENERATIVE_AI_API_KEY, undefined);
  assert.equal(env.GROQ_API_KEY, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.AZURE_OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.LANG, 'ko_KR.UTF-8');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.test:8443');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/test-ca.pem');
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, '1');
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, '1');
  assert.equal(env.OPENCODE_DISABLE_DEFAULT_PLUGINS, '1');
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(env.OPENCODE_DISABLE_LSP_DOWNLOAD, '1');
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission, {
    '*': 'allow', edit: { '*': 'allow' }, bash: 'ask', external_directory: { '*': 'deny' },
  });
  assert.deepEqual(JSON.parse(env.OPENCODE_PERMISSION), {
    '*': 'allow', edit: { '*': 'allow' }, bash: 'ask', external_directory: { '*': 'deny' },
  });
  assert.throws(
    () => buildOpenCodeEnv({ ...baseOpts, isolatedHome: '' }, {}),
    /isolated home/,
  );

  const appKeyEnv = buildOpenCodeEnv({
    ...baseOpts,
    providerEnv: {
      PATH: '/managed/bin',
      OPENCODE_API_KEY: 'app-owned-key',
      OPENROUTER_API_KEY: 'must-not-leak',
    },
  });
  assert.equal(appKeyEnv.OPENCODE_API_KEY, 'app-owned-key');
  assert.equal(appKeyEnv.OPENROUTER_API_KEY, undefined);

  let managedKey = 'first-key';
  const dynamicOpts = {
    ...baseOpts,
    openCodeProviderEnv: () => ({ PATH: '/managed/bin', OPENCODE_API_KEY: managedKey }),
  };
  assert.equal(buildOpenCodeEnv(dynamicOpts).OPENCODE_API_KEY, 'first-key');
  managedKey = 'second-key';
  assert.equal(buildOpenCodeEnv(dynamicOpts).OPENCODE_API_KEY, 'second-key');
});

test('OpenCode auth is mirrored at its isolated XDG data path with validated copyback', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const isolatedHome = path.join(root, 'isolated');
  const source = path.join(root, 'source', 'auth.json');
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, openCodeApiAuth('initial'));
  const windows = {
    platform: 'win32',
    symlink() {
      const error = new Error('symlink privilege unavailable');
      error.code = 'EPERM';
      throw error;
    },
  };

  const mirror = prepareOpenCodeHome(isolatedHome, source, windows);
  const target = openCodeAuthPath(isolatedHome);
  assert.equal(mirror.mode, 'copy');
  assert.equal(readFileSync(target, 'utf8'), openCodeApiAuth('initial'));
  writeFileSync(target, openCodeApiAuth('refreshed'));
  prepareOpenCodeHome(isolatedHome, source, windows);
  assert.equal(readFileSync(source, 'utf8'), openCodeApiAuth('refreshed'));
  writeFileSync(target, openCodeApiAuth('final'));
  assert.equal(flushOpenCodeCredentialMirror(isolatedHome), true);
  assert.equal(readFileSync(source, 'utf8'), openCodeApiAuth('final'));
  assert.equal(existsSync(target), false, 'the private credential copy is removed after cleanup');
});

test('OpenCode auth mirroring rejects malformed, wellknown, and mixed host credentials', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-rejected-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source', 'auth.json');
  mkdirSync(path.dirname(source), { recursive: true });
  const rejected = [
    '{"token":"junk"}',
    JSON.stringify({ openai: { type: 'api', key: '' } }),
    JSON.stringify({ openai: { type: 'wellknown', key: 'https://config.invalid/auth' } }),
    JSON.stringify({
      openai: { type: 'api', key: 'valid-key' },
      remote: { type: 'wellknown', key: 'https://config.invalid/auth' },
    }),
  ];

  rejected.forEach((content, index) => {
    const isolatedHome = path.join(root, `isolated-${index}`);
    writeFileSync(source, content);
    assert.equal(prepareOpenCodeHome(isolatedHome, source), null);
    assert.equal(existsSync(openCodeAuthPath(isolatedHome)), false);
  });
});

test('OpenCode never copies an unsafe child auth record back to the host', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-copyback-reject-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const isolatedHome = path.join(root, 'isolated');
  const source = path.join(root, 'source', 'auth.json');
  const original = openCodeApiAuth('host-key');
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, original);
  prepareOpenCodeHome(isolatedHome, source);
  const target = openCodeAuthPath(isolatedHome);
  writeFileSync(target, JSON.stringify({ remote: { type: 'wellknown', key: 'https://config.invalid' } }));

  assert.equal(flushOpenCodeCredentialMirror(isolatedHome), true);
  assert.equal(readFileSync(source, 'utf8'), original);
  assert.equal(existsSync(target), false);
});

test('OpenCode ACP payload helpers normalize usage, MCP labels, and result text', () => {
  assert.deepEqual(normalizeOpenCodeUsage({
    inputTokens: 100,
    outputTokens: 25,
    cachedReadTokens: 20,
    cachedWriteTokens: 5,
    thoughtTokens: 12,
  }), {
    inputTokens: 100,
    outputTokens: 25,
    cacheReadTokens: 20,
    cacheCreationTokens: 5,
  });
  assert.equal(normalizeOpenCodeUsage({ totalTokens: 0 }), null);
  assert.equal(openCodeToolName({ kind: 'other', title: 'rhwp_get_structure' }), 'get_structure');
  assert.equal(openCodeToolName({ kind: 'execute', title: 'npm test' }), 'bash');
  assert.equal(openCodeToolName({ name: 'mcp__rhwp__replace_text', kind: 'other' }), 'replace_text');
  assert.equal(openCodeToolName({
    kind: 'other', title: 'Ask for clarification', rawInput: { questions: [] },
  }), 'ask_user_question');
  assert.equal(openCodeResultPreview({ rawOutput: { output: 'updated document' } }), 'updated document');
  assert.equal(openCodeResultPreview({
    content: [{ type: 'content', content: { type: 'text', text: 'permission denied' } }],
  }), 'permission denied');
});

test('OpenCode session uses pure ACP, forwards Rau MCP, streams events, and persists its session', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const transports = [];
  const configurations = [];
  const prompts = [];
  const homes = [];
  let flushCalls = 0;
  let promptNumber = 0;

  const opts = {
    ...baseOpts,
    rootDir: path.join(root, 'project'),
    isolatedHome: path.join(root, 'home'),
    openCodeBin: '/managed/opencode',
    providerEnv: { PATH: '/managed' },
    onEvent: (event) => events.push(event),
  };
  const session = createOpenCodeSession(opts, {
    prepareHome: (...args) => homes.push(args),
    flushCredentialMirror() {
      flushCalls += 1;
      return true;
    },
    createAcpSession(input) {
      transports.push(input);
      let sessionId = input.resumeSessionId;
      return {
        async configure(selection) {
          configurations.push(selection);
          sessionId ??= 'ses_opencode_1';
          input.onSessionStarted({
            sessionId,
            setupResponse: {
              configOptions: [{ id: 'model', category: 'model', currentValue: 'openai/default' }],
            },
          });
        },
        async prompt(prompt) {
          prompts.push(prompt);
          promptNumber += 1;
          input.onSessionUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `answer-${promptNumber}` },
          });
          input.onSessionUpdate({
            sessionUpdate: 'tool_call',
            toolCallId: `call-${promptNumber}`,
            kind: 'other',
            title: 'rhwp_get_structure',
            status: 'pending',
            rawInput: {},
          });
          input.onSessionUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: `call-${promptNumber}`,
            status: 'in_progress',
            rawInput: { sectionIdx: 0 },
          });
          input.onSessionUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: `call-${promptNumber}`,
            status: 'completed',
            rawOutput: { output: `result-${promptNumber}` },
          });
          input.onSessionUpdate({
            sessionUpdate: 'usage_update',
            used: 500,
            size: 1000,
            cost: { amount: promptNumber === 1 ? 0.002 : 0.005, currency: 'USD' },
          });
          return {
            stopReason: 'end_turn',
            usage: {
              inputTokens: promptNumber * 100,
              outputTokens: promptNumber * 10,
              cachedReadTokens: promptNumber * 5,
              cachedWriteTokens: promptNumber,
            },
          };
        },
        async cancel() {},
        async dispose() { return true; },
        getSessionId: () => sessionId,
        isCleanupUncertain: () => false,
      };
    },
  });

  session.sendUserMessage('first');
  await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 1);
  session.sendUserMessage('second');
  await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 2);

  assert.equal(transports.length, 1, 'the logical ACP session is reused across prompts');
  const input = transports[0];
  assert.equal(input.command, '/managed/opencode');
  assert.deepEqual(input.args, ['acp', '--pure']);
  assert.equal(input.cwd, opts.rootDir);
  assert.equal(input.isolatePrompts, true);
  assert.equal(typeof input.env, 'function');
  const launchEnv = input.env();
  assert.equal(launchEnv.XDG_DATA_HOME, path.join(opts.isolatedHome, '.local', 'share'));
  assert.deepEqual(configurations, [
    {
      modeAliases: ['build'], requireModeMatch: true,
      model: 'openai/gpt-5', requireModelMatch: true, effort: 'high',
    },
    {
      modeAliases: ['build'], requireModeMatch: true,
      model: 'openai/gpt-5', requireModelMatch: true, effort: 'high',
    },
  ]);
  assert.match(prompts[0], /first$/);
  assert.notEqual(prompts[0], 'first', 'the first prompt carries the Rau system brief');
  assert.equal(prompts[1], 'second');
  assert.equal(homes.length, 2, 'every isolated ACP child gets a newly validated credential snapshot');
  assert.equal(flushCalls, 0, 'a live ACP process is not flushed between turns');
  assert.equal(session.getSessionId(), 'ses_opencode_1');

  assert.equal(input.mcpServers.length, 1);
  assert.equal(input.mcpServers[0].name, 'rhwp');
  const mcpEnv = Object.fromEntries(input.mcpServers[0].env.map(({ name, value }) => [name, value]));
  assert.equal(mcpEnv.RHWP_AGENT_NAME, 'opencode');
  assert.equal(mcpEnv.RHWP_AGENT_TOKEN, 'secret-token');
  assert.equal(mcpEnv.RHWP_WS_URL, 'ws://127.0.0.1:6401/mcp');
  assert.equal(mcpEnv.RHWP_AGENT_PHASE, 'implementing');
  assert.equal(mcpEnv.RHWP_CAPABILITY_EPOCH, '3');

  assert.deepEqual(events.filter((event) => event.type === 'text-delta').map((event) => event.text), [
    'answer-1', 'answer-2',
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'tool-call').map((event) => ({
    tool: event.tool, args: JSON.parse(event.argsJson),
  })), [
    { tool: 'get_structure', args: { sectionIdx: 0 } },
    { tool: 'get_structure', args: { sectionIdx: 0 } },
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'tool-result').map((event) => ({
    ok: event.ok, preview: event.resultPreview,
  })), [
    { ok: true, preview: 'result-1' },
    { ok: true, preview: 'result-2' },
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'usage').map((event) => ({
    usage: event.usage, costUsd: event.costUsd,
  })), [
    {
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 1 },
      costUsd: 0.002,
    },
    {
      usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 10, cacheCreationTokens: 2 },
      costUsd: 0.003,
    },
  ]);
  assert.equal(await session.dispose(), true);
  assert.equal(flushCalls, 1);
});

test('OpenCode fails before prompting when ACP cannot select the reported model', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-model-mismatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const selections = [];
  let promptCount = 0;
  let disposeCount = 0;
  const session = createOpenCodeSession({
    ...baseOpts,
    rootDir: path.join(root, 'project'),
    isolatedHome: path.join(root, 'home'),
    model: 'reported/model',
    onEvent: (event) => events.push(event),
  }, {
    prepareHome() {},
    flushCredentialMirror: () => true,
    createAcpSession() {
      return {
        async configure(selection) {
          selections.push(selection);
          if (selection.requireModelMatch) {
            throw new Error('rhwp-opencode ACP does not advertise required model (reported/model)');
          }
        },
        async prompt() {
          promptCount += 1;
          return { stopReason: 'end_turn' };
        },
        async cancel() {},
        async dispose() {
          disposeCount += 1;
          return true;
        },
        getSessionId: () => 'ses_model_mismatch',
        isCleanupUncertain: () => false,
      };
    },
  });

  session.sendUserMessage('must not run on another model');
  await waitFor(() => events.some((event) => event.type === 'turn-end'));

  assert.equal(selections.length, 1);
  assert.equal(selections[0].model, 'reported/model');
  assert.equal(selections[0].requireModelMatch, true);
  assert.equal(promptCount, 0);
  assert.equal(disposeCount, 1, 'a configure failure cleans up the child before turn failure');
  assert.match(events.find((event) => event.type === 'error').message, /required model \(reported\/model\)/);
  assert.equal(events.find((event) => event.type === 'turn-end').stopReason, 'failed');
  assert.equal(await session.dispose(), true);
});

test('OpenCode refuses host auth that becomes wellknown before the next process generation', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-auth-generation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const isolatedHome = path.join(root, 'home');
  const source = path.join(root, 'source', 'auth.json');
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, openCodeApiAuth('initial'));
  const events = [];
  const preparedSources = [];
  let transportCount = 0;
  const session = createOpenCodeSession({
    ...baseOpts,
    rootDir: path.join(root, 'project'),
    isolatedHome,
    openCodeAuthPath: () => source,
    onEvent: (event) => events.push(event),
  }, {
    prepareHome(home, authPath) {
      preparedSources.push(authPath);
      return prepareOpenCodeHome(home, authPath);
    },
    createAcpSession(input) {
      transportCount += 1;
      const sessionId = `ses_auth_generation_${transportCount}`;
      return {
        async configure() {
          input.onSessionStarted({ sessionId, setupResponse: { configOptions: [] } });
        },
        async prompt() { return { stopReason: 'end_turn' }; },
        async cancel() {},
        async dispose() { return true; },
        getSessionId: () => sessionId,
        isCleanupUncertain: () => false,
      };
    },
  });

  session.sendUserMessage('first');
  await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 1);
  session.sendUserMessage('next isolated process');
  await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 2);
  assert.equal(preparedSources.length, 2);
  assert.equal(existsSync(openCodeAuthPath(isolatedHome)), true);

  writeFileSync(source, JSON.stringify({ remote: { type: 'wellknown', key: 'https://config.invalid' } }));
  await session.setPermissionProfile('unrestricted');
  session.sendUserMessage('next process');
  await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 3);

  assert.equal(transportCount, 2);
  assert.deepEqual(preparedSources, [source, source, source]);
  assert.equal(existsSync(openCodeAuthPath(isolatedHome)), false);
  assert.equal(await session.dispose(), true);
});

test('OpenCode defers logout mirror removal until the active child generation finishes', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-auth-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const isolatedHome = path.join(root, 'home');
  const source = path.join(root, 'source', 'auth.json');
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, openCodeApiAuth('initial'));
  const events = [];
  let prepareCount = 0;
  let resolvePrompt;
  const session = createOpenCodeSession({
    ...baseOpts,
    rootDir: path.join(root, 'project'),
    isolatedHome,
    openCodeAuthPath: () => source,
    onEvent: (event) => events.push(event),
  }, {
    prepareHome(home, authPath) {
      prepareCount += 1;
      return prepareOpenCodeHome(home, authPath);
    },
    createAcpSession(input) {
      return {
        async configure() {
          input.onSessionStarted({
            sessionId: 'ses_auth_refresh',
            setupResponse: { configOptions: [] },
          });
        },
        prompt() {
          return new Promise((resolve) => { resolvePrompt = resolve; });
        },
        async cancel() {},
        async dispose() { return true; },
        getSessionId: () => 'ses_auth_refresh',
        isCleanupUncertain: () => false,
      };
    },
  });

  session.sendUserMessage('active generation');
  await waitFor(() => typeof resolvePrompt === 'function');
  const target = openCodeAuthPath(isolatedHome);
  assert.equal(prepareCount, 1);
  assert.equal(existsSync(target), true);

  writeFileSync(source, JSON.stringify({ remote: { type: 'wellknown', key: 'REMOTE_TOKEN', token: 'secret' } }));
  session.refreshCredentials();
  assert.equal(prepareCount, 1, 'the live child keeps its immutable private snapshot');
  assert.equal(existsSync(target), true);

  resolvePrompt({ stopReason: 'end_turn' });
  await waitFor(() => events.some((event) => event.type === 'turn-end'));
  await waitFor(() => !existsSync(target), 'rejected auth mirror was not removed after cleanup');
  assert.equal(prepareCount, 2);
  assert.equal(await session.dispose(), true);
});

test('OpenCode sends a fresh direct-mode brief after the permission profile changes', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const inputs = [];
  const prompts = [];
  const opts = {
    ...baseOpts,
    rootDir: path.join(root, 'project'),
    isolatedHome: path.join(root, 'home'),
    onEvent: (event) => events.push(event),
  };
  const session = createOpenCodeSession(opts, {
    prepareHome() {},
    flushCredentialMirror: () => true,
    createAcpSession(input) {
      inputs.push(input);
      const sessionId = input.resumeSessionId ?? 'ses_profile';
      return {
        async configure() {
          input.onSessionStarted({ sessionId, setupResponse: { configOptions: [] } });
        },
        async prompt(value) {
          prompts.push(value);
          return { stopReason: 'end_turn' };
        },
        async cancel() {},
        async dispose() { return true; },
        getSessionId: () => sessionId,
        isCleanupUncertain: () => false,
      };
    },
  });

  session.sendUserMessage('safe turn');
  await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 1);
  await session.setPermissionProfile('unrestricted');
  session.sendUserMessage('full turn');
  await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 2);

  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].resumeSessionId, 'ses_profile');
  assert.match(prompts[0], /Raw engine writes .* unavailable/);
  assert.match(prompts[1], /apply_engine_edits commits its atomic batch immediately/);
  assert.match(prompts[1], /full turn$/);
  assert.deepEqual(JSON.parse(inputs[1].env().OPENCODE_PERMISSION), {
    '*': 'allow', edit: { '*': 'allow' }, external_directory: 'allow',
  });
  assert.equal(await session.dispose(), true);
});

test('OpenCode mode changes rebuild managed permissions and interrupt cancels the active ACP turn', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const inputs = [];
  const selections = [];
  let resolvePrompt;
  let releaseFirstCleanup;
  const firstCleanup = new Promise((resolve) => { releaseFirstCleanup = resolve; });
  let cancelCount = 0;
  let disposeCount = 0;
  const opts = {
    ...baseOpts,
    rootDir: path.join(root, 'project'),
    isolatedHome: path.join(root, 'home'),
    onEvent: (event) => events.push(event),
  };
  const session = createOpenCodeSession(opts, {
    prepareHome() {},
    flushCredentialMirror: () => true,
    createAcpSession(input) {
      inputs.push(input);
      let sessionId = input.resumeSessionId ?? 'ses_cancel';
      return {
        async configure(selection) {
          selections.push(selection);
          input.onSessionStarted({ sessionId, setupResponse: { configOptions: [] } });
        },
        prompt() {
          return new Promise((resolve) => { resolvePrompt = resolve; });
        },
        async cancel() {
          cancelCount += 1;
          resolvePrompt?.({ stopReason: 'cancelled' });
        },
        async dispose() {
          disposeCount += 1;
          resolvePrompt?.({ stopReason: 'cancelled' });
          return disposeCount === 1 ? firstCleanup : true;
        },
        getSessionId: () => sessionId,
        isCleanupUncertain: () => false,
      };
    },
  });

  await session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 4 });
  session.sendUserMessage('plan this');
  await waitFor(() => typeof resolvePrompt === 'function');
  assert.deepEqual(selections[0].modeAliases, ['plan']);
  assert.deepEqual(JSON.parse(inputs[0].env().OPENCODE_CONFIG_CONTENT).permission, {
    '*': 'allow', edit: { '*': 'deny' }, bash: 'deny', external_directory: { '*': 'deny' },
  });

  session.interrupt();
  session.sendUserMessage('after interrupt');
  await waitFor(() => cancelCount === 1 && disposeCount === 1);
  assert.equal(events.filter((event) => event.type === 'turn-end').at(-1).stopReason, 'interrupted');
  assert.equal(inputs.length, 1, 'the next turn cannot reuse the home during cleanup');
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);

  releaseFirstCleanup(true);
  await waitFor(() => inputs.length === 2 && events.filter((event) => event.type === 'turn-start').length === 2);
  assert.equal(inputs[1].resumeSessionId, 'ses_cancel');
  session.interrupt();
  await waitFor(() => cancelCount === 2 && disposeCount === 2);
  assert.equal(await session.dispose(), true);
});

test('OpenCode interrupt cancels a follow-up queued behind ACP cleanup', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-queued-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const inputs = [];
  const prompts = [];
  let resolvePrompt;
  let releaseCleanup;
  let disposeCount = 0;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  const session = createOpenCodeSession({
    ...baseOpts,
    rootDir: path.join(root, 'project'),
    isolatedHome: path.join(root, 'home'),
    onEvent: (event) => events.push(event),
  }, {
    prepareHome() {},
    flushCredentialMirror: () => true,
    createAcpSession(input) {
      inputs.push(input);
      return {
        async configure() {
          input.onSessionStarted({
            sessionId: 'ses_queued_cancel',
            setupResponse: { configOptions: [] },
          });
        },
        prompt(text) {
          prompts.push(text);
          return new Promise((resolve) => { resolvePrompt = resolve; });
        },
        async cancel() {
          resolvePrompt?.({ stopReason: 'cancelled' });
        },
        dispose() {
          disposeCount += 1;
          return cleanup;
        },
        getSessionId: () => 'ses_queued_cancel',
        isCleanupUncertain: () => false,
      };
    },
  });

  session.sendUserMessage('first');
  await waitFor(() => typeof resolvePrompt === 'function');
  session.interrupt();
  session.sendUserMessage('must stay cancelled');
  await waitFor(() => disposeCount === 1);
  session.interrupt();

  releaseCleanup(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(inputs.length, 1);
  assert.equal(prompts.length, 1);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);
  assert.deepEqual(events.filter((event) => event.type === 'turn-end'), [
    { type: 'turn-end', agent: 'opencode', stopReason: 'interrupted' },
    { type: 'turn-end', agent: 'opencode', stopReason: 'interrupted' },
  ]);
  assert.equal(await session.dispose(), true);
});

test('OpenCode disposal waits for cancellation and tree cleanup before credential copyback', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-opencode-dispose-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  let resolvePrompt;
  let releaseCancel;
  let releaseCleanup;
  let disposeCalls = 0;
  let flushCalls = 0;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  const session = createOpenCodeSession({
    ...baseOpts,
    rootDir: path.join(root, 'project'),
    isolatedHome: path.join(root, 'home'),
    onEvent: (event) => events.push(event),
  }, {
    prepareHome() {},
    flushCredentialMirror() {
      flushCalls += 1;
      return true;
    },
    createAcpSession(input) {
      const sessionId = 'ses_dispose';
      return {
        async configure() {
          input.onSessionStarted({ sessionId, setupResponse: { configOptions: [] } });
        },
        prompt() {
          return new Promise((resolve) => { resolvePrompt = resolve; });
        },
        cancel() {
          return new Promise((resolve) => {
            releaseCancel = () => {
              resolvePrompt?.({ stopReason: 'cancelled' });
              resolve();
            };
          });
        },
        dispose() {
          disposeCalls += 1;
          return cleanup;
        },
        getSessionId: () => sessionId,
        isCleanupUncertain: () => false,
      };
    },
  });

  session.sendUserMessage('long turn');
  await waitFor(() => typeof resolvePrompt === 'function');
  const disposing = session.dispose();
  await waitFor(() => typeof releaseCancel === 'function');
  assert.equal(disposeCalls, 0, 'tree disposal waits for the cancel notification');
  assert.equal(flushCalls, 0);

  releaseCancel();
  await waitFor(() => disposeCalls === 1);
  assert.equal(flushCalls, 0, 'credentials remain pinned until cleanup is proven');
  releaseCleanup(true);
  assert.equal(await disposing, true);
  assert.equal(flushCalls, 1);
});
