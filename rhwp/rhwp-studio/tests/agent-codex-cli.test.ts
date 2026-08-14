import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexArgv,
  formatCodexExitError,
} from '../../rhwp-agent/agents/codex.mjs';

const opts = {
  rootDir: '/tmp/rhwp',
  mcpScriptPath: '/tmp/rhwp-agent/mcp-stdio.mjs',
  hubPort: 5175,
  token: 'secret-agent-token',
  model: 'gpt-5.6-sol',
  effort: 'high',
  permissionProfile: 'unrestricted' as const,
  onEvent: () => {},
};

test('Codex resume uses only flags accepted by the resume subcommand', () => {
  const threadId = '019fcd88-e0e6-7a43-801b-4e54d791c1e2';
  const argv = buildCodexArgv(opts, threadId);

  assert.deepEqual(argv.slice(0, 2), ['exec', 'resume']);
  assert.equal(argv.includes('--sandbox'), false);
  assert.equal(argv.includes('-C'), false);
  assert.ok(argv.includes('sandbox_mode="danger-full-access"'));
  assert.ok(argv.indexOf('--json') < argv.indexOf(threadId));
  assert.deepEqual(argv.slice(-2), [threadId, '-']);
});

test('initial Codex turns still set the working root explicitly', () => {
  const argv = buildCodexArgv(opts, null);
  const rootFlag = argv.indexOf('-C');

  assert.equal(argv[0], 'exec');
  assert.equal(argv[1], '--json');
  assert.equal(argv[rootFlag + 1], opts.rootDir);
  assert.equal(argv.at(-1), '-');
});

test('safe Codex turns use workspace-write while retaining core web and shell support', () => {
  const argv = buildCodexArgv({ ...opts, permissionProfile: 'safe' }, null);
  assert.ok(argv.includes('sandbox_mode="workspace-write"'));
  assert.ok(argv.includes('mcp_servers.rhwp.default_tools_approval_mode="auto"'));
  assert.ok(argv.includes('--ignore-user-config'));
  assert.ok(argv.includes('--ignore-rules'));
  assert.ok(argv.includes('skill_search'));
});

test('Codex exit errors expose stderr while redacting the agent token', () => {
  const message = formatCodexExitError(
    `error: unexpected argument '--sandbox' found\nUsage: codex exec resume secret-agent-token\n`,
    2,
    null,
    opts.token,
  );

  assert.match(message, /중단.*code 2/);
  assert.match(message, /unexpected argument '--sandbox'/);
  assert.doesNotMatch(message, /secret-agent-token/);
  assert.doesNotMatch(message, /Usage:/);
});
