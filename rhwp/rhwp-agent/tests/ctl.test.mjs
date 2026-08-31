import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_HUB_PROTOCOL, parseCtlArgs, runCtl, ctlUsage } from '../ctl.mjs';
import { isHubHealthy, stopHubByPort } from '../../../desktop/agent-hub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = join(HERE, '..');
const REPO_ROOT = join(AGENT_DIR, '..', '..');
const SCRIPT = join(AGENT_DIR, 'server.mjs');
const WINDOWS_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
const CLEANUP_RETRY_DELAYS_MS = [80, 160, 320, 640, 1_000, 1_500];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Temp-dir cleanup can race Defender / process teardown on win32.
 * Retry lock errors and keep the original code so CI does not see the
 * Korean installer HARNESS_FILES_LOCKED message from retryLockedOperation.
 */
async function retryWindowsCleanup(operation, {
  platform = process.platform,
  delays = CLEANUP_RETRY_DELAYS_MS,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (platform !== 'win32' || !WINDOWS_LOCK_CODES.has(error?.code) || attempt === delays.length) {
        throw error;
      }
      await delay(delays[attempt]);
    }
  }
  throw lastError;
}

function removeRunDir(runDir) {
  return retryWindowsCleanup(() => rm(runDir, { recursive: true, force: true }));
}

test('parseCtlArgs defaults to start and accepts --json', () => {
  assert.deepEqual(parseCtlArgs([]), { command: 'start', json: false });
  assert.deepEqual(parseCtlArgs(['stop', '--json']), { command: 'stop', json: true });
  assert.deepEqual(parseCtlArgs(['--json', 'status']), { command: 'status', json: true });
});

test('unknown command prints usage', async () => {
  const stderr = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  const stdout = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  const { code, result } = await runCtl('nope', { stdout, stderr });
  assert.equal(code, 2);
  assert.equal(result.error, 'unknown-command');
  assert.match(stderr.chunks.join(''), /사용법/);
  assert.match(ctlUsage(), /npm start/);
});

test('status is down when nothing is listening', async () => {
  const port = await freePort();
  const stdout = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  const { code, result } = await runCtl('status', {
    port,
    json: true,
    stdout,
    runDir: await mkdtemp(join(tmpdir(), 'rhwp-ctl-status-')),
  });
  assert.equal(code, 1);
  assert.equal(result.ready, false);
  assert.match(stdout.chunks.join(''), /"ready":false/);
});

test('ctl replaces an authenticated detached hub from an older protocol', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const runDir = await mkdtemp(join(tmpdir(), 'rhwp-ctl-upgrade-'));
  const stdout = { chunks: [], write(chunk) { this.chunks.push(String(chunk)); } };
  const legacy = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/healthz') {
      res.end(JSON.stringify({
        ok: true,
        // A dead pid: stopHubByPort waits for this process to exit after
        // /healthz drops. Using the test-runner pid would stall the full
        // stop timeout.
        pid: 2_147_483_647,
        launchId: 'legacy-hub',
        protocol: EXPECTED_HUB_PROTOCOL - 1,
      }));
      return;
    }
    if (req.url === '/shutdown' && req.method === 'POST') {
      res.setHeader('connection', 'close');
      res.end(JSON.stringify({ status: 'prepared', launchId: 'legacy-hub' }), () => {
        legacy.closeAllConnections?.();
        legacy.close();
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((resolve, reject) => {
    legacy.once('error', reject);
    legacy.listen(port, '127.0.0.1', resolve);
  });

  try {
    const started = await runCtl('start', {
      port,
      runDir,
      repoRoot: REPO_ROOT,
      scriptPath: SCRIPT,
      agentDir: AGENT_DIR,
      json: true,
      stdout,
      env: { ...process.env, RHWP_AGENT_PORT: String(port) },
    });
    assert.equal(started.code, 0, stdout.chunks.join(''));
    assert.equal(started.result.ready, true);
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { authorization: 'Bearer dev' },
    })).json();
    assert.equal(health.protocol, EXPECTED_HUB_PROTOCOL);
  } finally {
    await stopHubByPort(port, { pidPath: join(runDir, 'rhwp-agent.pid') });
    await new Promise((resolve) => legacy.close(resolve)).catch(() => {});
    await removeRunDir(runDir);
  }
});

test('ctl start/stop roundtrip without holding the terminal', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const runDir = await mkdtemp(join(tmpdir(), 'rhwp-ctl-run-'));
  const stdout = { chunks: [], write(chunk) { this.chunks.push(String(chunk)); } };
  try {
    const started = await runCtl('start', {
      port,
      runDir,
      repoRoot: REPO_ROOT,
      scriptPath: SCRIPT,
      agentDir: AGENT_DIR,
      json: true,
      stdout,
      env: { ...process.env, RHWP_AGENT_PORT: String(port) },
    });
    assert.equal(started.code, 0, stdout.chunks.join(''));
    assert.equal(started.result.ready, true);
    assert.equal(await isHubHealthy(port), true);

    const again = await runCtl('start', {
      port,
      runDir,
      repoRoot: REPO_ROOT,
      scriptPath: SCRIPT,
      agentDir: AGENT_DIR,
      json: true,
      stdout,
      env: { ...process.env, RHWP_AGENT_PORT: String(port) },
    });
    assert.equal(again.result.alreadyRunning, true);

    const stopped = await runCtl('stop', { port, runDir, json: true, stdout });
    assert.equal(stopped.code, 0);
    assert.equal(await isHubHealthy(port), false);
  } finally {
    await stopHubByPort(port, { pidPath: join(runDir, 'rhwp-agent.pid') });
    await removeRunDir(runDir);
  }
});

test('ctl restart does not spawn after detached cleanup is unproven', async () => {
  const stdout = { chunks: [], write(chunk) { this.chunks.push(String(chunk)); } };
  let startCalls = 0;
  const restarted = await runCtl('restart', {
    json: true,
    stdout,
    stopHub: async () => ({ stopped: false, ready: false, pid: 4242 }),
    startHub: async () => {
      startCalls += 1;
      return { started: true, ready: true, pid: 5252 };
    },
  });

  assert.equal(restarted.code, 1);
  assert.equal(restarted.result.error, 'hub-cleanup-unproven');
  assert.equal(startCalls, 0);
});

test('Windows temp cleanup retries lock errors without remapping the code', async () => {
  let attempts = 0;
  await retryWindowsCleanup(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
  }, { platform: 'win32', delays: [0, 0] });
  assert.equal(attempts, 3);

  await assert.rejects(
    () => retryWindowsCleanup(
      async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
      { platform: 'win32', delays: [0] },
    ),
    (error) => error.code === 'EBUSY' && error.message === 'busy',
  );
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}
