import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const READY_PREFIX = 'RHWP_HUB_READY ';
const LOG_LIMIT = 16 * 1024;

function appendLog(current, chunk) {
  return `${current}${String(chunk)}`.slice(-LOG_LIMIT);
}

function waitForReady(child, { timeoutMs, stderr }) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const consume = () => {
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith(READY_PREFIX)) continue;
        cleanup();
        try {
          resolve(JSON.parse(line.slice(READY_PREFIX.length)));
        } catch (error) {
          reject(new Error(`Packaged agent hub emitted an invalid ready line: ${error.message}`));
        }
        return;
      }
    };
    const onData = (chunk) => {
      buffer = appendLog(buffer, chunk);
      consume();
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) => {
      fail(new Error(`Packaged agent hub exited before ready (${code ?? signal ?? 'unknown'}):\n${stderr()}`));
    };
    const timer = setTimeout(() => {
      fail(new Error(`Packaged agent hub did not become ready within ${timeoutMs}ms:\n${stderr()}`));
    }, timeoutMs);
    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function ownerRequest(baseUrl, pathname, { token, launchId, method = 'GET' }) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-rhwp-launch-id': launchId,
    },
  });
}

export async function smokePackagedAgentHub({ executable, agentDir, timeoutMs = 30_000 }) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rauhwpx-packaged-hub-'));
  const token = `package-smoke-${process.pid}-${Date.now()}`;
  const launchId = `package-smoke-${process.pid}`;
  const scriptPath = path.join(agentDir, 'server.mjs');
  let stderr = '';
  let child;
  const secrets = new Map();
  try {
    child = spawn(executable, [scriptPath], {
      cwd: agentDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        RHWP_AGENT_MODE: 'production',
        RHWP_AGENT_PORT: '0',
        RHWP_AGENT_TOKEN: token,
        RHWP_LAUNCH_ID: launchId,
        RHWP_SECRET_BROKER: 'ipc',
        RHWP_WORK_DIR: path.join(workRoot, 'work'),
        RHWP_RUNTIME_DIR: path.join(workRoot, 'runtime'),
        RHWP_AGENT_INSTRUCTIONS_DIR: path.join(workRoot, 'agent-instructions'),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', (message) => {
      if (!message || message.type !== 'rhwp-secret-request' || typeof message.id !== 'string') return;
      let value = null;
      if (message.operation === 'get') value = secrets.get(message.key) ?? null;
      else if (message.operation === 'set') {
        secrets.set(message.key, String(message.value));
        value = true;
      } else if (message.operation === 'delete') value = secrets.delete(message.key);
      else if (message.operation === 'reset') {
        secrets.clear();
        value = true;
      } else {
        child.send({
          type: 'rhwp-secret-response',
          id: message.id,
          ok: false,
          code: 'SECRET_STORE_INVALID_OPERATION',
          error: `Unsupported secret operation: ${message.operation}`,
        });
        return;
      }
      child.send({ type: 'rhwp-secret-response', id: message.id, ok: true, value });
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendLog(stderr, chunk);
    });

    const ready = await waitForReady(child, { timeoutMs, stderr: () => stderr });
    assert.equal(ready.launchId, launchId, 'packaged hub ready line used the wrong launch id');
    assert.equal(ready.pid, child.pid, 'packaged hub ready line used the wrong process id');
    assert.ok(Number.isSafeInteger(ready.port) && ready.port > 0, 'packaged hub did not bind a port');
    const baseUrl = `http://127.0.0.1:${ready.port}`;

    const healthResponse = await ownerRequest(baseUrl, '/healthz', { token, launchId });
    const healthText = await healthResponse.text();
    assert.equal(healthResponse.status, 200, `packaged hub health check failed: ${healthText}`);
    const health = JSON.parse(healthText);
    assert.equal(health.ok, true);
    assert.equal(health.launchId, launchId);
    assert.equal(health.pid, child.pid);

    const sessionPath = '/sessions/package-smoke';
    const sessionResponse = await ownerRequest(baseUrl, sessionPath, {
      token,
      launchId,
      method: 'POST',
    });
    const sessionText = await sessionResponse.text();
    assert.equal(sessionResponse.status, 200, `packaged hub session connection failed: ${sessionText}`);
    const session = JSON.parse(sessionText);
    assert.equal(session.status, 'registered');
    assert.equal(session.sessionId, 'package-smoke');
    assert.ok(session.capabilities?.studio);

    const deleteResponse = await ownerRequest(baseUrl, sessionPath, {
      token,
      launchId,
      method: 'DELETE',
    });
    assert.equal(deleteResponse.status, 200, `packaged hub session cleanup failed: ${await deleteResponse.text()}`);

    const shutdownResponse = await ownerRequest(baseUrl, '/shutdown', {
      token,
      launchId,
      method: 'POST',
    });
    assert.equal(shutdownResponse.status, 200, `packaged hub shutdown failed: ${await shutdownResponse.text()}`);
    assert.equal(await waitForExit(child), true, 'packaged hub did not exit after shutdown');
    return { port: ready.port, pid: ready.pid, sessionId: session.sessionId };
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
      await waitForExit(child);
    }
    rmSync(workRoot, { recursive: true, force: true });
  }
}
