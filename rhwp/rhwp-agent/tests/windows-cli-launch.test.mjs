import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildClaudeArgv, createClaudeSession } from '../agents/claude.mjs';
import { buildGrokArgv } from '../agents/grok.mjs';
import { buildPiArgv } from '../agents/pi.mjs';
import {
  applyNpmCliLaunch,
  parseNpmCmdShimScript,
  resolveNpmCliLaunch,
  WINDOWS_CMD_LINE_LIMIT,
  windowsCmdExeCommandLineLength,
} from '../npm-cli-launch.mjs';

const sessionId = '00000000-0000-4000-8000-000000000000';
const claudeOpts = {
  rootDir: '/tmp/Rau workspace',
  isolatedHome: '/tmp/rhwp-home',
  mcpScriptPath: '/tmp/Rau runtime/mcp stdio.mjs',
  mcpRuntimeCommand: '/Applications/Rau App/Rau',
  mcpRuntimeArgs: ['--no-warnings'],
  mcpRuntimeEnv: { ELECTRON_RUN_AS_NODE: '1' },
  hubPort: 5175,
  token: 'a'.repeat(36),
  sessionId: 'studio-thread-42',
  model: 'claude-opus-4-6',
  effort: 'high',
  permissionProfile: 'safe',
  workflow: 'direct',
  phase: 'implementing',
  capabilityEpoch: 1,
  onEvent() {},
};

function writeNpmCmdShim(root, binName, scriptRelPath) {
  const binDir = path.join(root, 'npm-bin');
  mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(root, scriptRelPath);
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  const cmdPath = path.join(binDir, `${binName}.cmd`);
  const relativeFromBin = path.relative(binDir, scriptPath).replace(/\\/g, '\\');
  writeFileSync(scriptPath, [
    'if (process.argv.includes("--version")) {',
    '  console.log("0.0.0-test");',
    '  process.exit(0);',
    '}',
    'console.log(JSON.stringify({ argvLength: process.argv.slice(2).join(" ").length }));',
  ].join('\n'));
  writeFileSync(cmdPath, [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'GOTO :eof',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeFromBin}" %*`,
    '',
  ].join('\r\n'));
  return { cmdPath, scriptPath };
}

test('realistic Claude argv exceeds the Windows cmd.exe ceiling through a .cmd shim', () => {
  const argv = buildClaudeArgv(claudeOpts, sessionId, false);
  const length = windowsCmdExeCommandLineLength('claude.cmd', argv);
  assert.ok(
    length > WINDOWS_CMD_LINE_LIMIT,
    `expected cmd.exe line ${length} to exceed ${WINDOWS_CMD_LINE_LIMIT}`,
  );
});

test('Grok unrestricted and Pi node_modules/.bin shims also overflow cmd.exe', () => {
  const grok = buildGrokArgv(
    { ...claudeOpts, permissionProfile: 'unrestricted' },
    sessionId,
    false,
    '/tmp/prompt.txt',
  );
  assert.ok(
    windowsCmdExeCommandLineLength('grok.cmd', grok) > WINDOWS_CMD_LINE_LIMIT,
    'unrestricted grok should overflow cmd.exe',
  );

  const pi = [...buildPiArgv({ ...claudeOpts, piRoot: '/tmp/pi', model: 'x' }, sessionId), 'review'];
  assert.ok(
    windowsCmdExeCommandLineLength(
      String.raw`C:\app\prefix\node_modules\.bin\pi.cmd`,
      pi,
      { doubleEscapeMetaChars: true },
    ) > WINDOWS_CMD_LINE_LIMIT,
    'pi .bin shim with caret-escaping should overflow cmd.exe',
  );
});

test('npm cmd-shim parser expands %dp0% to the sibling JS entry', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-npm-cmd-shim-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(
    root, 'claude', path.join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  );
  const parsed = parseNpmCmdShimScript(cmdPath, readFileSync(cmdPath, 'utf8'));
  assert.equal(parsed, scriptPath);
});

test('pnpm-style %~dp0 shim resolves the JS entry', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-pnpm-cmd-shim-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'claude-code', 'cli.js');
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, 'console.log("ok")\n');
  const cmdPath = path.join(root, 'bin', 'claude.cmd');
  mkdirSync(path.dirname(cmdPath), { recursive: true });
  writeFileSync(cmdPath, `@ECHO OFF\r\n"%~dp0\\node" "%~dp0\\..\\claude-code\\cli.js" %*\r\n`);
  assert.equal(parseNpmCmdShimScript(cmdPath, readFileSync(cmdPath, 'utf8')), scriptPath);
});

test('parser does not unwrap a .cmd that invokes notnode.exe', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cmd-notnode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'entry.js');
  writeFileSync(scriptPath, 'console.log("not node")\n');
  const cmdPath = path.join(root, 'wrapper.cmd');
  writeFileSync(
    cmdPath,
    `@ECHO OFF\r\n"C:\\tools\\notnode.exe" "%~dp0\\entry.js" %*\r\n`,
  );
  assert.equal(parseNpmCmdShimScript(cmdPath, readFileSync(cmdPath, 'utf8')), null);
  const launch = resolveNpmCliLaunch(cmdPath, { platform: 'win32', nodeCommand: process.execPath });
  assert.equal(launch.command, cmdPath);
  assert.deepEqual(launch.leadingArgs, []);
});

test('parser does not unwrap a .cmd that only quotes a .js path', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cmd-quoted-js-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'helper.js');
  writeFileSync(scriptPath, 'console.log("data")\n');
  const cmdPath = path.join(root, 'wrapper.cmd');
  writeFileSync(cmdPath, [
    '@ECHO OFF',
    `echo using "%~dp0\\helper.js" as data`,
    'copy "%~dp0\\helper.js" "%TEMP%\\out.js"',
    '',
  ].join('\r\n'));
  assert.equal(parseNpmCmdShimScript(cmdPath, readFileSync(cmdPath, 'utf8')), null);
  const launch = resolveNpmCliLaunch(cmdPath, { platform: 'win32', nodeCommand: process.execPath });
  assert.equal(launch.command, cmdPath);
  assert.deepEqual(launch.leadingArgs, []);
  assert.deepEqual(launch.env, {});
});

test('parser does not unwrap a node shim whose JS entry is missing', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cmd-missing-js-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cmdPath = path.join(root, 'claude.cmd');
  writeFileSync(cmdPath, `@ECHO OFF\r\n"%_prog%" "%~dp0\\missing-cli.js" %*\r\n`);
  assert.equal(parseNpmCmdShimScript(cmdPath, readFileSync(cmdPath, 'utf8')), null);
  const launch = resolveNpmCliLaunch(cmdPath, { platform: 'win32', nodeCommand: process.execPath });
  assert.equal(launch.command, cmdPath);
  assert.deepEqual(launch.leadingArgs, []);
});

test('Windows PATH lookup uses the provided env, not process.env', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cmd-path-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  const seen = [];
  const launch = resolveNpmCliLaunch('claude', {
    platform: 'win32',
    nodeCommand: process.execPath,
    env: { PATH: 'C:\\custom\\bin' },
    whichSync(command, options) {
      seen.push({ command, options });
      return command === 'claude' ? cmdPath : null;
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, 'claude');
  assert.equal(seen[0].options.path, 'C:\\custom\\bin');
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.leadingArgs, [scriptPath]);
});

test('Unix launches stay on the original binary', () => {
  const launch = resolveNpmCliLaunch('claude', { platform: 'linux', nodeCommand: '/usr/bin/node' });
  assert.deepEqual(launch, { command: 'claude', leadingArgs: [], env: {} });
});

test('Windows npm .cmd unwraps to node plus the JS entry, skipping cmd.exe', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-npm-unwrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(
    root, 'claude', path.join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  );
  const nodeCommand = process.execPath;
  const launch = resolveNpmCliLaunch(cmdPath, { platform: 'win32', nodeCommand });
  assert.equal(launch.command, nodeCommand);
  assert.deepEqual(launch.leadingArgs, [scriptPath]);
  assert.match(path.basename(launch.command), /^(?:node|node\.exe)$/i);
  assert.equal(/\.(?:cmd|bat)$/i.test(launch.command), false);

  const argv = buildClaudeArgv(claudeOpts, sessionId, false);
  const launched = applyNpmCliLaunch(cmdPath, argv, { platform: 'win32', nodeCommand });
  assert.equal(launched.command, nodeCommand);
  assert.equal(launched.argv[0], scriptPath);
  assert.equal(launched.argv.includes('--append-system-prompt'), true);
  // cross-spawn only wraps .cmd/.bat. node(.exe) goes through CreateProcessW.
  assert.equal(/\.(?:cmd|bat)$/i.test(launched.command), false);
});

test('Electron host sets ELECTRON_RUN_AS_NODE when unwrapping', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-electron-unwrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  const launch = resolveNpmCliLaunch(cmdPath, {
    platform: 'win32',
    nodeCommand: path.join(root, 'Rauhwpx.exe'),
  });
  assert.equal(launch.command, path.join(root, 'Rauhwpx.exe'));
  assert.deepEqual(launch.leadingArgs, [scriptPath]);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
});

test('unwrapped Claude spawn actually starts with a cmd.exe-overflowing argv', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-unwrap-spawn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  const argv = buildClaudeArgv(claudeOpts, sessionId, false);
  assert.ok(windowsCmdExeCommandLineLength(cmdPath, argv) > WINDOWS_CMD_LINE_LIMIT);
  const launched = applyNpmCliLaunch(cmdPath, argv, {
    platform: 'win32',
    nodeCommand: process.execPath,
  });
  assert.equal(launched.argv[0], scriptPath);

  const child = nodeSpawn(launched.command, launched.argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const { code } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ code: exitCode }));
  });
  assert.equal(code, 0, stderr || stdout);
  const payload = JSON.parse(stdout.trim());
  assert.ok(payload.argvLength > 8000);
});

class FakeStream extends EventEmitter {
  chunks = [];
  write(chunk, callback) {
    this.chunks.push(String(chunk));
    callback?.();
    return true;
  }
  end() {}
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStream();
  exitCode = null;
  signalCode = null;
  kill() { return true; }
}

test('createClaudeSession unwraps a Windows .cmd bin before spawn', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-session-unwrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  const spawns = [];
  const events = [];
  const session = createClaudeSession({
    ...claudeOpts,
    claudeBin: cmdPath,
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    nodeCommand: process.execPath,
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
    terminateProcess() { return true; },
    waitForExit: async () => true,
    closeGraceMs: 1,
  });
  t.after(() => session.dispose());
  session.sendUserMessage('review');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.equal(spawns[0].argv[0], scriptPath);
  assert.equal(spawns[0].argv.includes('--append-system-prompt'), true);
  assert.equal(/\.(?:cmd|bat)$/i.test(spawns[0].command), false);
  assert.equal(events.some((event) => event.type === 'turn-start'), true);
});

async function waitUntil(predicate, message = 'condition did not settle') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('native Claude SDK launch unwraps Windows .cmd and merges Electron env', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-sdk-unwrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  const electronBin = path.join(root, 'Rauhwpx.exe');
  const events = [];
  const sdkOptions = [];
  const session = createClaudeSession({
    ...claudeOpts,
    claudeBin: cmdPath,
    agentRole: 'chat',
    requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    nodeCommand: electronBin,
    queryAgent({ prompt, options }) {
      sdkOptions.push(options);
      const query = (async function* () {
        for await (const _message of prompt) {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: options.sessionId ?? options.resume,
            model: 'claude-test',
          };
          yield { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' };
        }
      })();
      query.close = () => {};
      return query;
    },
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
    terminateProcess() { return true; },
    waitForExit: async () => true,
    closeGraceMs: 1,
  });
  t.after(() => session.dispose());
  session.sendUserMessage('review');
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));
  assert.equal(sdkOptions.length, 1);
  assert.equal(sdkOptions[0].pathToClaudeCodeExecutable, scriptPath);
  assert.equal(sdkOptions[0].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(/\.(?:cmd|bat)$/i.test(sdkOptions[0].pathToClaudeCodeExecutable), false);
});
