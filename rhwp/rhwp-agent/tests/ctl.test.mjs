import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCtlArgs, runCtl, ctlUsage } from '../ctl.mjs';
import { isHubHealthy, stopHubByPort } from '../../../desktop/agent-hub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = join(HERE, '..');
const REPO_ROOT = join(AGENT_DIR, '..', '..');
const SCRIPT = join(AGENT_DIR, 'server.mjs');

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
    await rm(runDir, { recursive: true, force: true });
  }
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
