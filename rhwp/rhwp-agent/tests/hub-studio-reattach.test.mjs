// 스튜디오 소켓이 잠깐 끊겼다 붙는 동안 인플라이트 도구 호출이 어떻게 되는지 고정한다.
//  - 같은 instance 로 돌아오면 호출은 살아 있고, 재연결 후 도착한 응답으로 마무리된다.
//  - 다른 instance(새로고침·다른 탭)가 붙으면 즉시 NO_STUDIO 로 실패한다.
//  - 인자 스키마를 캐시해도 strict/passthrough 검증 결과는 그대로다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';

const TOKEN = 'hub-reattach-test-token';
const LAUNCH_ID = 'hub-reattach-test-launch';

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

function openSocket(url) {
  const socket = new WebSocket(url);
  // welcome 은 upgrade 직후 날아온다 — open 이벤트 뒤에 리스너를 달면 놓칠 수 있으니 여기서 받아 둔다.
  const firstMessage = new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(Object.assign(socket, { firstMessage })));
    socket.once('error', reject);
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

/** 정해진 시간 안에 predicate 에 걸리는 프레임이 없어야 통과. */
function expectNoMessage(socket, predicate, windowMs) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      reject(new Error(`Unexpected frame: ${JSON.stringify(message)}`));
    };
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve();
    }, windowMs);
    socket.on('message', onMessage);
  });
}

function sendFrame(socket, frame) {
  socket.send(JSON.stringify({ v: 5, ...frame }));
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}

function prepareFakePi(root) {
  const packageDir = path.join(root, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const binDir = path.join(root, 'prefix', 'node_modules', '.bin');
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    version: 1,
    installedVersion: '0.0.0-test',
    models: [{
      id: 'mock-model', name: 'Mock model', reasoning: false, supportsImages: false,
      efforts: [], defaultEffort: null, contextLength: 8_192,
      pricing: { prompt: 0, completion: 0 },
    }],
    defaultModelId: 'mock-model',
  }));
  const agentDir = path.join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: { openrouter: { apiKey: 'test-placeholder-key' } },
  }));
  const fake = path.join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  if (process.platform === 'win32') {
    writeFileSync(fake, '@echo off\r\nnode -e "setInterval(() =^> {}, 1000)"\r\n');
  } else {
    writeFileSync(
      fake,
      `#!/bin/sh\nexec "${process.execPath}" -e 'setInterval(() => {}, 1000)'\n`,
      { mode: 0o755 },
    );
  }
}

async function startHub(t) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-reattach-'));
  const piRoot = path.join(workRoot, 'pi');
  prepareFakePi(piRoot);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RHWP_AGENT_PORT: '0',
      RHWP_AGENT_TOKEN: TOKEN,
      RHWP_LAUNCH_ID: LAUNCH_ID,
      RHWP_WORK_DIR: workRoot,
      RHWP_TEMPLATES_DIR: path.join(workRoot, 'templates'),
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(workRoot, 'agent-instructions'),
      RHWP_PI_DIR: piRoot,
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
  return { port: ready.port, stderr: () => stderr };
}

async function startRunningChat(studio, { threadId, documentId }) {
  const started = waitForMessage(studio, (msg) => msg.type === 'chat-started');
  sendFrame(studio, { type: 'chat-start', agent: 'pi', threadId, documentId });
  const session = await started;
  const turnStarted = waitForMessage(
    studio,
    (msg) => msg.type === 'agent-event' && msg.event?.type === 'turn-start',
  );
  sendFrame(studio, {
    type: 'chat-user-message',
    threadId: session.threadId,
    documentId: session.documentId,
    text: 'Keep this provider turn active while the Studio connection is tested.',
  });
  await turnStarted;
  return session;
}

/** 스튜디오·MCP 소켓을 붙이고 세션을 띄운 뒤 사용할 준비를 마친다. */
async function connectStudio(port, { sessionId, instance }) {
  const capabilities = await registerHubSession({
    port,
    token: TOKEN,
    launchId: LAUNCH_ID,
    sessionId,
  });
  const query = instance === null ? '' : `&instance=${encodeURIComponent(instance)}`;
  return openSocket(`ws://127.0.0.1:${port}/studio?token=${capabilities.studio}&sessionId=${sessionId}${query}`);
}

test('same-instance reattach keeps in-flight tool calls alive', { timeout: 40_000 }, async (t) => {
  const { port, stderr } = await startHub(t);
  const sessionId = 'blip';
  const studio = await connectStudio(port, { sessionId, instance: 'page-1' });
  const session = await startRunningChat(studio, { threadId: 'thread-blip', documentId: 'doc-blip' });

  const mcp = await openSocket(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi`);
  const request = waitForMessage(studio, (msg) => msg.type === 'tool-request');
  const result = waitForMessage(mcp, (msg) => msg.type === 'tool-result' && msg.id === 11);
  sendFrame(mcp, {
    type: 'tool-call', id: 11, tool: 'get_structure', args: {},
    workflow: 'direct', capabilityEpoch: session.capabilityEpoch,
  });
  const toolRequest = await request;

  // 응답하지 않은 채 소켓만 끊는다 — 예전 허브는 여기서 곧바로 NO_STUDIO 를 돌려줬다.
  await closeSocket(studio);
  await expectNoMessage(mcp, (msg) => msg.type === 'tool-result' && msg.id === 11, 700);

  // 같은 페이지가 돌아와 버퍼에 담아 뒀던 응답을 흘려보낸다.
  const reattached = await connectStudio(port, { sessionId, instance: 'page-1' });
  t.after(() => closeSocket(reattached));
  assert.equal((await reattached.firstMessage).type, 'welcome');
  sendFrame(reattached, { type: 'tool-response', id: toolRequest.id, ok: true, result: { owner: 'blip' } });
  const answered = await result;
  assert.equal(answered.ok, true, stderr());
  assert.deepEqual(answered.result, { owner: 'blip' });

  await closeSocket(mcp);
});

test('a studio that never comes back fails in-flight calls after the grace window', { timeout: 40_000 }, async (t) => {
  const { port, stderr } = await startHub(t);
  const sessionId = 'gone';
  const studio = await connectStudio(port, { sessionId, instance: 'page-1' });
  const session = await startRunningChat(studio, { threadId: 'thread-gone', documentId: 'doc-gone' });

  const mcp = await openSocket(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi`);
  t.after(() => closeSocket(mcp));
  const request = waitForMessage(studio, (msg) => msg.type === 'tool-request');
  const result = waitForMessage(mcp, (msg) => msg.type === 'tool-result' && msg.id === 41, 20_000);
  sendFrame(mcp, {
    type: 'tool-call', id: 41, tool: 'get_structure', args: {},
    workflow: 'direct', capabilityEpoch: session.capabilityEpoch,
  });
  await request;

  // 탭이 닫혀 다시는 붙지 않는다 — 30초 도구 타임아웃까지 끌지 않고 유예 시간 뒤에 접힌다.
  const closedAt = Date.now();
  await closeSocket(studio);
  const failed = await result;
  const elapsed = Date.now() - closedAt;
  assert.equal(failed.ok, false, stderr());
  assert.equal(failed.error.code, 'NO_STUDIO');
  assert.equal(elapsed >= 4_000, true, `유예 없이 즉시 실패했다 (${elapsed}ms)`);
  assert.equal(elapsed < 15_000, true, `도구 타임아웃까지 끌었다 (${elapsed}ms)`);
});

test('different-instance reattach fails in-flight tool calls at once', { timeout: 40_000 }, async (t) => {
  const { port, stderr } = await startHub(t);
  const sessionId = 'reload';
  const studio = await connectStudio(port, { sessionId, instance: 'page-1' });
  const session = await startRunningChat(studio, { threadId: 'thread-reload', documentId: 'doc-reload' });
  const mcp = await openSocket(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi`);

  // (1) 새로고침: 소켓이 닫힌 뒤 다른 instance 가 붙는다.
  const reloadRequest = waitForMessage(studio, (msg) => msg.type === 'tool-request');
  const reloadResult = waitForMessage(mcp, (msg) => msg.type === 'tool-result' && msg.id === 21);
  sendFrame(mcp, {
    type: 'tool-call', id: 21, tool: 'get_structure', args: {},
    workflow: 'direct', capabilityEpoch: session.capabilityEpoch,
  });
  await reloadRequest;
  await closeSocket(studio);
  const reloaded = await connectStudio(port, { sessionId, instance: 'page-2' });
  const failed = await reloadResult;
  assert.equal(failed.ok, false, stderr());
  assert.equal(failed.error.code, 'NO_STUDIO');

  // (2) 다른 탭이 살아 있는 소켓을 밀어내는 경우에도 즉시 실패한다.
  const takeoverRequest = waitForMessage(reloaded, (msg) => msg.type === 'tool-request');
  const takeoverResult = waitForMessage(mcp, (msg) => msg.type === 'tool-result' && msg.id === 22);
  sendFrame(mcp, {
    type: 'tool-call', id: 22, tool: 'get_structure', args: {},
    workflow: 'direct', capabilityEpoch: session.capabilityEpoch,
  });
  await takeoverRequest;
  const replacedClose = once(reloaded, 'close');
  const takeover = await connectStudio(port, { sessionId, instance: 'page-3' });
  t.after(() => closeSocket(takeover));
  const replaced = await takeoverResult;
  assert.equal(replaced.ok, false);
  assert.equal(replaced.error.code, 'NO_STUDIO');
  assert.equal((await replacedClose)[0], 4000);

  // (3) instance 를 붙이지 않는 예전 스튜디오는 예전대로 곧바로 실패시킨다.
  const legacyRequest = waitForMessage(takeover, (msg) => msg.type === 'tool-request');
  const legacyResult = waitForMessage(mcp, (msg) => msg.type === 'tool-result' && msg.id === 23);
  sendFrame(mcp, {
    type: 'tool-call', id: 23, tool: 'get_structure', args: {},
    workflow: 'direct', capabilityEpoch: session.capabilityEpoch,
  });
  await legacyRequest;
  await closeSocket(takeover);
  const legacy = await connectStudio(port, { sessionId, instance: null });
  t.after(() => closeSocket(legacy));
  const legacyFailed = await legacyResult;
  assert.equal(legacyFailed.ok, false);
  assert.equal(legacyFailed.error.code, 'NO_STUDIO');

  await closeSocket(mcp);
});

test('cached argument schemas keep strict/passthrough validation', { timeout: 40_000 }, async (t) => {
  const { port, stderr } = await startHub(t);
  const sessionId = 'schema';
  const studio = await connectStudio(port, { sessionId, instance: 'page-1' });
  t.after(() => closeSocket(studio));
  const session = await startRunningChat(studio, { threadId: 'thread-schema', documentId: 'doc-schema' });
  const mcp = await openSocket(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi`);
  t.after(() => closeSocket(mcp));
  const call = (id, tool, args) => {
    const answer = waitForMessage(mcp, (msg) => msg.type === 'tool-result' && msg.id === id);
    sendFrame(mcp, { type: 'tool-call', id, tool, args, workflow: 'direct', capabilityEpoch: session.capabilityEpoch });
    return answer;
  };

  // strict 스키마: 모르는 키는 캐시 전후 모두 거절한다.
  const firstBad = await call(31, 'get_text_range', { sectionIdx: 0, paraIdx: 0, bogus: 1 });
  assert.equal(firstBad.ok, false, stderr());
  assert.equal(firstBad.error.code, 'INVALID_ARGS');

  const goodRequest = waitForMessage(studio, (msg) => msg.type === 'tool-request' && msg.tool === 'get_text_range');
  const good = call(32, 'get_text_range', { sectionIdx: 0, paraIdx: 0 });
  sendFrame(studio, { type: 'tool-response', id: (await goodRequest).id, ok: true, result: { text: 'ok' } });
  assert.deepEqual((await good).result, { text: 'ok' });

  const secondBad = await call(33, 'get_text_range', { sectionIdx: 0, paraIdx: 0, bogus: 1 });
  assert.equal(secondBad.ok, false);
  assert.equal(secondBad.error.code, 'INVALID_ARGS');

  // insert_image 만 passthrough — 같은 캐시를 써도 모르는 키가 그대로 통과한다.
  const imageRequest = waitForMessage(studio, (msg) => msg.type === 'tool-request' && msg.tool === 'insert_image');
  const image = call(34, 'insert_image', {
    expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0,
    imageBase64: 'AAAA', extension: 'png', imageBytesLength: 4,
  });
  const forwarded = await imageRequest;
  assert.equal(forwarded.args.imageBytesLength, 4);
  sendFrame(studio, { type: 'tool-response', id: forwarded.id, ok: true, result: { inserted: true } });
  assert.deepEqual((await image).result, { inserted: true });
});
