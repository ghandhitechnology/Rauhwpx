// 도구 텔레메트리 — 결과 크기 측정 규칙과 허브의 턴별 JSONL 행을 지킨다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';

import { writeFakeCliBin } from './fake-cli-bin.mjs';
import {
  measureToolResult,
  readToolTelemetryRows,
  ToolTurnTelemetry,
} from '../tool-telemetry.mjs';

const TOKEN = 'tool-telemetry-test-token';
const LAUNCH_ID = 'tool-telemetry-test-launch';

// 3x2 PNG 의 시그니처 + IHDR (픽셀 데이터는 측정에 필요 없다)
function pngBase64(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

test('measureToolResult counts model-visible text and image pixels', () => {
  assert.deepEqual(measureToolResult({ revision: 3, text: 'abc' }), {
    resultChars: JSON.stringify({ revision: 3, text: 'abc' }).length, images: 0, imagePixels: 0,
  });
  assert.deepEqual(measureToolResult({ pageIndex: 0, image: { data: pngBase64(300, 200), mimeType: 'image/png' } }), {
    resultChars: JSON.stringify({ pageIndex: 0 }).length, images: 1, imagePixels: 60_000,
  });
  assert.deepEqual(measureToolResult({ mcpContent: [
    { type: 'image', data: pngBase64(10, 10), mimeType: 'image/png' },
    { type: 'text', text: 'hello' },
  ] }), { resultChars: 5, images: 1, imagePixels: 100 });
});

test('turn telemetry counts errors by code and retries after a failed call', () => {
  const turn = new ToolTurnTelemetry('turn-1');
  turn.record({ tool: 'insert_text', errorCode: 'REVISION_MISMATCH', resultChars: 40, ms: 2 });
  turn.record({ tool: 'get_structure', resultChars: 100, ms: 3 });
  turn.record({ tool: 'insert_text', resultChars: 20, ms: 4 });
  turn.record({ tool: 'insert_text', resultChars: 20, ms: 4 });
  const summary = turn.summary();
  assert.equal(summary.toolCalls, 4);
  assert.equal(summary.resultChars, 180);
  assert.equal(summary.toolMs, 13);
  assert.deepEqual(summary.errors, { REVISION_MISMATCH: 1 });
  assert.deepEqual(summary.retries, { REVISION_MISMATCH: 1 });
  assert.equal(summary.calls[0].error, 'REVISION_MISMATCH');
});

function waitForLine(stream, predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream });
    const timer = setTimeout(() => { lines.close(); reject(new Error('Timed out waiting for hub')); }, timeoutMs);
    lines.on('line', (line) => {
      if (!predicate(line)) return;
      clearTimeout(timer);
      lines.close();
      resolve(line);
    });
  });
}

async function openClient(url) {
  const socket = new WebSocket(url);
  const buffered = [];
  const waiters = [];
  socket.on('message', (data) => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index < 0) { buffered.push(frame); return; }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  });
  await once(socket, 'open');
  return {
    socket,
    send(frame) { socket.send(JSON.stringify({ v: 5, ...frame })); },
    next(predicate, timeoutMs = 10_000) {
      const index = buffered.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for frame; buffered=${JSON.stringify(buffered)}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close() { socket.close(); },
  };
}

test('the hub writes one JSONL row per turn with tool sizes, images and error codes', { timeout: 40_000 }, async (t) => {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-tool-telemetry-'));
  const piRoot = path.join(workRoot, 'pi');
  const completePi = path.join(workRoot, 'complete-pi');
  const packageDir = path.join(piRoot, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  writeFileSync(path.join(piRoot, 'config.json'), JSON.stringify({
    version: 1, installedVersion: '0.0.0-test', defaultModelId: 'mock-model',
    models: [{ id: 'mock-model', name: 'Mock model', reasoning: false, supportsImages: false,
      efforts: [], defaultEffort: null, contextLength: 8_192, pricing: { prompt: 0, completion: 0 } }],
  }));
  mkdirSync(path.join(piRoot, 'agent'), { recursive: true });
  writeFileSync(path.join(piRoot, 'agent', 'models.json'), JSON.stringify({
    providers: { openrouter: { apiKey: 'test-placeholder-key' } },
  }));
  writeFakeCliBin(path.join(piRoot, 'prefix', 'node_modules', '.bin'), 'pi', `
    if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
    const timer = setInterval(() => {
      if (!require('node:fs').existsSync(${JSON.stringify(completePi)})) return;
      clearInterval(timer);
      console.log(JSON.stringify({ type: 'agent_settled' }));
    }, 20);
  `);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, NODE_ENV: 'test', RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: TOKEN,
      RHWP_LAUNCH_ID: LAUNCH_ID, RHWP_WORK_DIR: workRoot, RHWP_PI_DIR: piRoot,
      RHWP_TEMPLATES_DIR: path.join(workRoot, 'templates'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(workRoot, { recursive: true, force: true });
  });
  const readyLine = await waitForLine(child.stdout, (line) => line.startsWith('RHWP_HUB_READY '));
  const { port } = JSON.parse(readyLine.slice('RHWP_HUB_READY '.length));

  const sessionId = 'tool-telemetry';
  const registration = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Rhwp-Launch-Id': LAUNCH_ID },
  });
  assert.equal(registration.status, 200);
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  t.after(() => studio.close());
  await studio.next((frame) => frame.type === 'welcome');
  studio.send({ type: 'chat-start', agent: 'pi', workflow: 'direct', threadId: 'thread-telemetry', documentId: 'doc-telemetry' });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  studio.send({ type: 'chat-user-message', threadId: started.threadId, documentId: started.documentId, text: 'Edit.' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => mcp.close());
  const call = (id, tool, args) => mcp.send({
    type: 'tool-call', id, tool, args, workflow: 'direct', capabilityEpoch: started.capabilityEpoch,
  });

  call(1, 'render_page', { pageIndex: 0, format: 'png' });
  const render = await studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'render_page');
  studio.send({ type: 'tool-response', id: render.id, ok: true,
    result: { pageIndex: 0, image: { data: pngBase64(40, 50), mimeType: 'image/png' } } });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 1)).ok, true);

  call(2, 'insert_text', { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x' });
  const stale = await studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'insert_text');
  studio.send({ type: 'tool-response', id: stale.id, ok: false,
    error: { code: 'REVISION_MISMATCH', message: 'current revision is 2' } });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 2)).error.code, 'REVISION_MISMATCH');

  call(3, 'insert_text', { expectedRevision: 2, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x' });
  const write = await studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'insert_text');
  studio.send({ type: 'tool-response', id: write.id, ok: true, result: { revision: 3 } });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 3)).ok, true);

  call(4, 'get_text_range', { sectionIdx: 'zero' });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 4)).error.code, 'INVALID_ARGS');

  writeFileSync(completePi, '');
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  let rows = [];
  for (let i = 0; i < 100 && rows.length === 0; i += 1) {
    rows = await readToolTelemetryRows(workRoot);
    if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.agent, 'pi');
  assert.equal(row.workflow, 'direct');
  assert.equal(row.toolCalls, 4);
  assert.equal(row.images, 1);
  assert.equal(row.imagePixels, 2_000);
  assert.deepEqual(row.errors, { REVISION_MISMATCH: 1, INVALID_ARGS: 1 });
  assert.deepEqual(row.retries, { REVISION_MISMATCH: 1 });
  assert.deepEqual(row.calls.map((entry) => entry.tool), ['render_page', 'insert_text', 'insert_text', 'get_text_range']);
  assert.ok(row.calls.every((entry) => entry.argsBytes > 0 && entry.ms >= 0));
  assert.equal(row.calls[2].resultChars, JSON.stringify({ revision: 3 }).length);
  // 문서 텍스트나 인자 값은 남지 않는다.
  assert.doesNotMatch(JSON.stringify(row), /"text"|expectedRevision|current revision/);
});
