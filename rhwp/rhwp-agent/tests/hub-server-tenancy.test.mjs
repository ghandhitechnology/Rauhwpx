import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';

import { issueScopedHubToken } from '../hub-session-registry.mjs';

const TOKEN = 'hub-tenancy-test-token';
const LAUNCH_ID = 'hub-tenancy-test-launch';

function waitForLine(stream, predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error('Timed out waiting for process output'));
    }, timeoutMs);
    lines.on('line', (line) => {
      if (!predicate(line)) return;
      clearTimeout(timer);
      lines.close();
      resolve(line);
    });
  });
}

function openSocket(url, { origin } = {}) {
  const socket = new WebSocket(url, origin ? { origin } : undefined);
  const firstMessage = new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, firstMessage }));
    socket.once('error', reject);
  });
}

function rejectedUpgrade(url, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, origin ? { origin } : undefined);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error('WebSocket upgrade unexpectedly succeeded')));
    socket.once('error', () => {});
  });
}

function waitForMessage(socket, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket message'));
    }, timeoutMs);
    const onMessage = (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

function sendFrame(socket, frame) {
  socket.send(JSON.stringify({ v: 3, ...frame }));
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for process exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve([code, signal]);
    });
  });
}

test('two idle backends route overlapping MCP ids only to their owning Studio', { timeout: 35_000 }, async (t) => {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-tenancy-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RHWP_AGENT_PORT: '0',
      RHWP_AGENT_TOKEN: TOKEN,
      RHWP_LAUNCH_ID: LAUNCH_ID,
      RHWP_WORK_DIR: workRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(workRoot, { recursive: true, force: true });
  });

  const readyLine = await waitForLine(child.stdout, (line) => line.startsWith('RHWP_HUB_READY '));
  const ready = JSON.parse(readyLine.slice('RHWP_HUB_READY '.length));
  assert.equal(ready.pid, child.pid);
  assert.equal(ready.launchId, LAUNCH_ID);
  assert.equal(Number.isInteger(ready.port) && ready.port > 0, true);

  const wsBase = `ws://127.0.0.1:${ready.port}`;
  const alphaToken = issueScopedHubToken(TOKEN, 'alpha');
  const betaToken = issueScopedHubToken(TOKEN, 'beta');
  const httpBase = `http://127.0.0.1:${ready.port}`;
  const studioOrigin = 'rauhwpx://app';
  assert.equal(
    await rejectedUpgrade(`${wsBase}/studio?token=${TOKEN}&sessionId=originless`),
    403,
  );
  assert.equal(
    await rejectedUpgrade(`${wsBase}/studio?token=${TOKEN}&sessionId=alpha`, { origin: studioOrigin }),
    401,
  );
  assert.equal(
    await rejectedUpgrade(`${wsBase}/mcp?token=${alphaToken}&sessionId=alpha`, { origin: studioOrigin }),
    403,
  );
  const { socket: alpha, firstMessage: alphaWelcome } = await openSocket(
    `${wsBase}/studio?token=${alphaToken}&sessionId=alpha`,
    { origin: studioOrigin },
  );
  const { socket: beta, firstMessage: betaWelcome } = await openSocket(
    `${wsBase}/studio?token=${betaToken}&sessionId=beta`,
    { origin: studioOrigin },
  );
  assert.equal((await alphaWelcome).hubSessionId, 'alpha');
  assert.equal((await betaWelcome).hubSessionId, 'beta');

  const alphaStarted = waitForMessage(alpha, (msg) => msg.type === 'chat-started');
  const betaStarted = waitForMessage(beta, (msg) => msg.type === 'chat-started');
  sendFrame(alpha, { type: 'chat-start', agent: 'claude', threadId: 'thread-alpha', documentId: 'doc-alpha' });
  sendFrame(beta, { type: 'chat-start', agent: 'claude', threadId: 'thread-beta', documentId: 'doc-beta' });
  const [alphaSession, betaSession] = await Promise.all([alphaStarted, betaStarted]);
  assert.equal(alphaSession.status, undefined);
  assert.equal(betaSession.status, undefined);

  const { socket: alphaMcp } = await openSocket(`${wsBase}/mcp?token=${alphaToken}&sessionId=alpha&agent=claude`);
  const { socket: betaMcp } = await openSocket(`${wsBase}/mcp?token=${betaToken}&sessionId=beta&agent=claude`);
  const alphaRequest = waitForMessage(alpha, (msg) => msg.type === 'tool-request');
  const betaRequest = waitForMessage(beta, (msg) => msg.type === 'tool-request');
  const alphaResult = waitForMessage(alphaMcp, (msg) => msg.type === 'tool-result');
  const betaResult = waitForMessage(betaMcp, (msg) => msg.type === 'tool-result');
  sendFrame(alphaMcp, { type: 'tool-call', id: 7, tool: 'get_structure', args: {}, workflow: 'direct', capabilityEpoch: alphaSession.capabilityEpoch });
  sendFrame(betaMcp, { type: 'tool-call', id: 7, tool: 'get_structure', args: {}, workflow: 'direct', capabilityEpoch: betaSession.capabilityEpoch });
  const [toAlpha, toBeta] = await Promise.all([alphaRequest, betaRequest]);
  assert.equal(toAlpha.id, 1);
  assert.equal(toBeta.id, 1);
  sendFrame(alpha, { type: 'tool-response', id: toAlpha.id, ok: true, result: { owner: 'alpha' } });
  sendFrame(beta, { type: 'tool-response', id: toBeta.id, ok: true, result: { owner: 'beta' } });
  assert.deepEqual((await alphaResult).result, { owner: 'alpha' });
  assert.deepEqual((await betaResult).result, { owner: 'beta' });

  const recordDirectories = readdirSync(path.join(workRoot, 'sessions'));
  assert.equal(recordDirectories.length, 2);
  assert.equal(recordDirectories.every((directory) => {
    const entries = readdirSync(path.join(workRoot, 'sessions', directory));
    return entries.includes('home') && entries.includes('work');
  }), true);
  const alphaClosed = Promise.all([once(alpha, 'close'), once(alphaMcp, 'close')]);
  const deleted = await fetch(`${httpBase}/sessions/alpha`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-RHWP-Launch-ID': LAUNCH_ID },
  });
  assert.equal(deleted.status, 200);
  await alphaClosed;
  assert.equal(beta.readyState, WebSocket.OPEN);
  assert.equal(betaMcp.readyState, WebSocket.OPEN);
  assert.equal(readdirSync(path.join(workRoot, 'sessions')).length, 1);

  const betaRequestAfterClose = waitForMessage(beta, (msg) => msg.type === 'tool-request');
  const betaResultAfterClose = waitForMessage(betaMcp, (msg) => msg.type === 'tool-result' && msg.id === 8);
  sendFrame(betaMcp, { type: 'tool-call', id: 8, tool: 'get_structure', args: {}, workflow: 'direct', capabilityEpoch: betaSession.capabilityEpoch });
  const stillOwned = await betaRequestAfterClose;
  sendFrame(beta, { type: 'tool-response', id: stillOwned.id, ok: true, result: { owner: 'beta-still' } });
  assert.deepEqual((await betaResultAfterClose).result, { owner: 'beta-still' });

  const healthResponse = await fetch(`${httpBase}/healthz?token=${TOKEN}`);
  const health = await healthResponse.json();
  assert.deepEqual(health.sessions.map(({ sessionId }) => sessionId), ['beta']);
  assert.equal(health.sessions[0].studioConnected, true, stderr);

  await Promise.all([closeSocket(betaMcp), closeSocket(beta)]);
  const shutdown = await fetch(`${httpBase}/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-RHWP-Launch-ID': LAUNCH_ID },
  });
  assert.equal(shutdown.status, 202);
  assert.deepEqual(await shutdown.json(), { status: 'shutting-down', launchId: LAUNCH_ID });
  assert.deepEqual(await waitForExit(child), [0, null]);
});

test('owner watchdog disposes the hub when its desktop owner exits', { timeout: 20_000 }, async (t) => {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-owner-'));
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const hub = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RHWP_AGENT_PORT: '0',
      RHWP_AGENT_TOKEN: TOKEN,
      RHWP_LAUNCH_ID: `${LAUNCH_ID}-owner`,
      RHWP_OWNER_PID: String(owner.pid),
      RHWP_WORK_DIR: workRoot,
      RHWP_OWN_WORK_DIR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (owner.exitCode === null) owner.kill('SIGTERM');
    if (hub.exitCode === null) hub.kill('SIGTERM');
    if (hub.exitCode === null) await waitForExit(hub).catch(() => {});
    rmSync(workRoot, { recursive: true, force: true });
  });

  await waitForLine(hub.stdout, (line) => line.startsWith('RHWP_HUB_READY '));
  owner.kill('SIGTERM');
  await waitForExit(owner);
  const [code, signal] = await waitForExit(hub);
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(existsSync(workRoot), false);
});
