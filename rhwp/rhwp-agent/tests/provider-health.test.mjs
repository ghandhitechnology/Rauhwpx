import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createProviderHealth } from '../provider-health.mjs';

class FakeStream extends EventEmitter {}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = null;

  kill(signal) {
    this.killed = signal;
    return true;
  }

  succeed(version) {
    if (version !== undefined) this.stdout.emit('data', `${version}\n`);
    this.emit('close', 0, null);
  }

  fail(code, stderrText) {
    if (stderrText) this.stderr.emit('data', stderrText);
    this.emit('close', code, null);
  }

  enoent() {
    const error = new Error('spawn claude ENOENT');
    error.code = 'ENOENT';
    this.emit('error', error);
  }
}

/** 명령별로 프로세스를 만들어 두고, 스폰 순서/횟수를 기록한다. */
function fakeSpawner(onSpawn) {
  const spawns = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    spawns.push({ command, argv, options, proc });
    queueMicrotask(() => onSpawn?.(command, proc));
    return proc;
  };
  return { spawns, spawnProcess };
}

test('probes report versions from the first stdout line', async () => {
  const versions = {
    claude: '  2.1.0 (Claude Code)  ',
    codex: 'codex-cli 0.9.3',
    grok: 'grok 1.0.5 (5115b46bc909)',
    'cursor-agent': '2026.08.11-e8db854',
  };
  const { spawns, spawnProcess } = fakeSpawner((command, proc) => {
    proc.succeed(versions[command]);
  });
  const health = createProviderHealth({ spawnProcess });
  const result = await health.check();

  assert.deepEqual(spawns.map((s) => [s.command, ...s.argv]), [
    ['claude', '--version'],
    ['codex', '--version'],
    ['grok', '--version'],
    ['cursor-agent', '--version'],
  ]);
  assert.equal(result.claude.available, true);
  assert.equal(result.claude.version, '2.1.0 (Claude Code)');
  assert.equal(result.claude.error, null);
  assert.ok(Number.isFinite(result.claude.checkedAt));
  assert.equal(result.codex.available, true);
  assert.equal(result.codex.version, 'codex-cli 0.9.3');
  assert.equal(result.grok.available, true);
  assert.equal(result.grok.version, 'grok 1.0.5 (5115b46bc909)');
  assert.equal(result.cursor.available, true);
  assert.equal(result.cursor.version, '2026.08.11-e8db854');
});

test('the cursor probe runs with the injected probe environment', async () => {
  const { spawns, spawnProcess } = fakeSpawner((command, proc) => proc.succeed(`${command} 1.0`));
  const probeHome = '/rhwp/cli/cursor-home';
  await createProviderHealth({
    spawnProcess,
    probeEnv: (agent) => (agent === 'cursor' ? { HOME: probeHome } : undefined),
  }).check();

  const cursorSpawn = spawns.find((s) => s.command === 'cursor-agent');
  assert.equal(cursorSpawn.options.env.HOME, probeHome);
  const claudeSpawn = spawns.find((s) => s.command === 'claude');
  assert.equal(claudeSpawn.options.env, undefined, '다른 프로브는 환경을 덮지 않는다');
});

test('ENOENT reports a missing command without a version', async () => {
  const { spawnProcess } = fakeSpawner((command, proc) => {
    if (command === 'claude') proc.enoent();
    else proc.succeed('codex 1.0.0');
  });
  const result = await createProviderHealth({ spawnProcess }).check();

  assert.equal(result.claude.available, false);
  assert.equal(result.claude.version, null);
  assert.match(result.claude.error, /명령을 찾을 수 없습니다/);
  assert.equal(result.codex.available, true);
});

test('a nonzero exit surfaces the stderr tail', async () => {
  const { spawnProcess } = fakeSpawner((command, proc) => {
    if (command === 'codex') proc.fail(2, 'first line\nnot logged in\n');
    else proc.succeed('2.1.0');
  });
  const result = await createProviderHealth({ spawnProcess }).check();

  assert.equal(result.codex.available, false);
  assert.equal(result.codex.version, null);
  assert.match(result.codex.error, /code 2/);
  assert.match(result.codex.error, /not logged in/);
});

test('a hung probe times out and kills the child', async () => {
  const { spawns, spawnProcess } = fakeSpawner((command, proc) => {
    if (command === 'claude') proc.succeed('2.1.0');
    // codex 는 응답하지 않는다.
  });
  const result = await createProviderHealth({ spawnProcess, timeoutMs: 10 }).check();

  assert.equal(result.claude.available, true);
  assert.equal(result.codex.available, false);
  assert.match(result.codex.error, /응답하지 않았습니다/);
  assert.equal(spawns.find((s) => s.command === 'codex').proc.killed, 'SIGKILL');
});

test('results are cached for the ttl and refresh forces a re-probe', async () => {
  const { spawns, spawnProcess } = fakeSpawner((command, proc) => proc.succeed(`${command} 1.0`));
  let clock = 1_000;
  const health = createProviderHealth({ spawnProcess, now: () => clock });

  assert.equal(health.cached(), null);
  const first = await health.check();
  assert.equal(spawns.length, 4);
  assert.equal(health.cached(), first);

  clock += 59_000;
  assert.equal(await health.check(), first);
  assert.equal(spawns.length, 4);

  const refreshed = await health.check(true);
  assert.notEqual(refreshed, first);
  assert.equal(spawns.length, 8);

  clock += 61_000;
  await health.check();
  assert.equal(spawns.length, 12);
});

test('concurrent checks share a single in-flight probe', async () => {
  const { spawns, spawnProcess } = fakeSpawner((command, proc) => proc.succeed(`${command} 1.0`));
  const health = createProviderHealth({ spawnProcess });

  const [a, b, c] = await Promise.all([health.check(), health.check(), health.check()]);
  assert.equal(spawns.length, 4);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('pi reports 설치되지 않았어요 until a bin path exists', async () => {
  const { spawns, spawnProcess } = fakeSpawner((command, proc) => proc.succeed(`${command} 1.0`));
  const result = await createProviderHealth({ spawnProcess }).check();

  assert.equal(spawns.length, 4, 'pi 미설치면 프로브를 걸지 않는다');
  assert.equal(result.pi.available, false);
  assert.equal(result.pi.version, null);
  assert.equal(result.pi.error, '설치되지 않았어요');
  assert.ok(Number.isFinite(result.pi.checkedAt));
  assert.equal(result.rau, result.pi);
});

test('an installed pi is probed through its own bin path', async () => {
  const piBin = '/pi/prefix/node_modules/.bin/pi';
  const { spawns, spawnProcess } = fakeSpawner((command, proc) => {
    proc.succeed(command === piBin ? 'pi 0.84.1' : `${command} 1.0`);
  });
  const result = await createProviderHealth({ spawnProcess, piBin: () => piBin }).check();

  assert.deepEqual(spawns.map((s) => s.command), ['claude', 'codex', 'grok', 'cursor-agent', piBin]);
  assert.equal(result.pi.available, true);
  assert.equal(result.pi.version, 'pi 0.84.1');
  assert.equal(result.pi.error, null);
});

test('a stale pi bin path falls back to the not-installed message', async () => {
  const { spawnProcess } = fakeSpawner((command, proc) => {
    if (command === '/gone/pi') proc.enoent();
    else proc.succeed(`${command} 1.0`);
  });
  const result = await createProviderHealth({ spawnProcess, piBin: () => '/gone/pi' }).check();

  assert.equal(result.pi.available, false);
  assert.equal(result.pi.error, '설치되지 않았어요');
});

test('an exit without close still settles the probe', async () => {
  const { spawnProcess } = fakeSpawner((command, proc) => {
    proc.stdout.emit('data', `${command} 3.0.0\n`);
    proc.emit('exit', 0, null);
  });
  const result = await createProviderHealth({ spawnProcess }).check();
  assert.equal(result.claude.version, 'claude 3.0.0');
  assert.equal(result.codex.version, 'codex 3.0.0');
});
