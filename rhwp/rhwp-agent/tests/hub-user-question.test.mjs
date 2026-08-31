import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';

import { ALIVE_PI_FIXTURE_SOURCE, writeFakeCliBin } from './fake-cli-bin.mjs';

const TOKEN = 'hub-user-question-test-token';
const LAUNCH_ID = 'hub-user-question-test-launch';

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

async function waitForPath(filePath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for path: ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function registerSession(port, sessionId) {
  const registration = await fetch(
    `http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Rhwp-Launch-Id': LAUNCH_ID,
      },
    },
  );
  assert.equal(registration.status, 200);
  return registration.json();
}

async function openClient(url) {
  const parsedUrl = new URL(url);
  const sessionId = parsedUrl.searchParams.get('sessionId');
  if (sessionId) await registerSession(parsedUrl.port, sessionId);
  const socket = new WebSocket(url);
  const buffered = [];
  const waiters = [];
  socket.on('message', (data) => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index < 0) {
      buffered.push(frame);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  });
  await once(socket, 'open');
  return {
    socket,
    next(predicate, timeoutMs = 10_000) {
      const index = buffered.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timeoutError = new Error('Timed out waiting for websocket frame');
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const current = waiters.indexOf(waiter);
          if (current >= 0) waiters.splice(current, 1);
          timeoutError.message += `; buffered=${JSON.stringify(buffered)}`;
          reject(timeoutError);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function rejectedUpgrade(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error('WebSocket upgrade unexpectedly succeeded')));
    socket.once('error', reject);
  });
}

function sendFrame(client, frame) {
  client.socket.send(JSON.stringify({ v: 5, ...frame }));
}

async function closeClient(client) {
  if (!client || client.socket.readyState === WebSocket.CLOSED) return;
  const closed = once(client.socket, 'close');
  client.socket.close();
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
  writeFakeCliBin(binDir, 'pi', ALIVE_PI_FIXTURE_SOURCE);
}

async function startHub(t, {
  fakeCursor = false,
  fakePi = false,
  gateCursorQuestion = false,
  emitCursorQuestion = true,
} = {}) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-user-question-'));
  const piRoot = path.join(workRoot, 'pi');
  const cursorLegacyReadyPath = path.join(workRoot, 'cursor-legacy-ready');
  const cursorQuestionReleasePath = path.join(workRoot, 'cursor-question-release');
  if (fakePi) prepareFakePi(piRoot);
  let testPath = process.env.PATH;
  if (fakeCursor) {
    const binDir = path.join(workRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const cursorFixture = path.join(binDir, 'cursor-agent-fixture.cjs');
    const cursorBin = path.join(binDir, process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent');
    const init = {
      type: 'system', subtype: 'init',
      session_id: 'cursor-fallback-question', model: 'mock-cursor', permissionMode: 'default',
    };
    const call = {
      type: 'tool_call', subtype: 'started', call_id: 'cursor-question-call',
      tool_call: { mcpToolCall: { args: {
        name: 'mcp__rhwp__ask_user_question',
        args: questionArgs(),
        toolCallId: '', providerIdentifier: '', toolName: 'ask_user_question',
        smartModeApprovalOnly: false, skipApproval: false, serverIdentifier: '',
      } } },
    };
    writeFileSync(cursorFixture, [
      "const fs = require('node:fs');",
      "if (process.argv.includes('--version')) { console.log('2026.08.11-e2e'); process.exit(0); }",
      "if (process.argv.includes('status')) { console.log('Not logged in'); process.exit(1); }",
      // Refuse ACP over JSON-RPC while staying alive so Windows can taskkill a
      // live leader before legacy fallback. process.exit(1) loses tree identity.
      "if (process.argv.includes('acp')) {",
      "  process.stderr.write('ACP unavailable in fixture\\n');",
      "  let buf = '';",
      "  process.stdin.setEncoding('utf8');",
      "  process.stdin.on('data', (chunk) => {",
      "    buf += chunk;",
      '    let idx;',
      "    while ((idx = buf.indexOf('\\n')) !== -1) {",
      '      const line = buf.slice(0, idx);',
      '      buf = buf.slice(idx + 1);',
      '      let msg;',
      '      try { msg = JSON.parse(line); } catch { continue; }',
      '      if (msg && msg.id !== undefined) {',
      '        process.stdout.write(JSON.stringify({',
      "          jsonrpc: '2.0', id: msg.id,",
      "          error: { code: -32000, message: 'ACP unavailable in fixture' },",
      "        }) + '\\n');",
      '      }',
      '    }',
      '  });',
      '  setInterval(() => {}, 1000);',
      '  return;',
      '}',
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(init)}\n`)});`,
      `fs.writeFileSync(${JSON.stringify(cursorLegacyReadyPath)}, '');`,
      ...(emitCursorQuestion && gateCursorQuestion
        ? [
          'const releaseWait = new Int32Array(new SharedArrayBuffer(4));',
          // Windows must first fail the ACP launch and reap that process tree.
          // Keep the fixture gate inside the test's 40-second outer deadline
          // without racing the valid fallback path on slower hosted runners.
          'const releaseDeadline = Date.now() + 30000;',
          `while (!fs.existsSync(${JSON.stringify(cursorQuestionReleasePath)})) {`,
          "  if (Date.now() >= releaseDeadline) { console.error('timed out waiting for question release'); process.exit(2); }",
          '  Atomics.wait(releaseWait, 0, 0, 20);',
          '}',
        ]
        : []),
      ...(emitCursorQuestion
        ? [`process.stdout.write(${JSON.stringify(`${JSON.stringify(call)}\n`)});`]
        : []),
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    if (process.platform === 'win32') {
      writeFileSync(
        cursorBin,
        `@echo off\r\n"${process.execPath}" "${cursorFixture}" %*\r\n`,
      );
    } else {
      writeFileSync(
        cursorBin,
        `#!/bin/sh\nexec "${process.execPath}" "${cursorFixture}" "$@"\n`,
        { mode: 0o755 },
      );
    }
    testPath = `${binDir}${path.delimiter}${testPath}`;
  }
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
      ...(fakePi ? { RHWP_PI_DIR: piRoot } : {}),
      PATH: testPath,
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
  return {
    port: ready.port,
    stderr: () => stderr,
    cursorLegacyReadyPath,
    cursorQuestionReleasePath,
  };
}

function questionArgs() {
  return {
    questions: [{
      id: 'format',
      header: 'Format',
      question: 'Which format should I use?',
      options: [
        { label: 'Brief', description: 'Keep it compact.' },
        { label: 'Detailed', description: 'Include supporting detail.' },
      ],
    }],
  };
}

function implementationPlanArgs() {
  return {
    goal: 'Implement the requested mode synchronization',
    title: 'Mode synchronization plan',
    summary: 'Keep the provider and UI on the same authoritative phase.',
    assumptions: [],
    decisions: ['Use the hub transition as the authority'],
    steps: [{ title: 'Switch mode', details: 'Apply the confirmed provider mode.' }],
    files: [],
    validation: ['Verify the implementation phase event'],
    risks: [],
    exclusions: [],
  };
}

async function startRunningChat(studio, agent = 'claude') {
  sendFrame(studio, {
    type: 'chat-start',
    agent,
    threadId: 'thread-question',
    documentId: 'document-question',
  });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  sendFrame(studio, {
    type: 'chat-user-message',
    threadId: started.threadId,
    documentId: started.documentId,
    text: 'Wait while a tool asks me one question.',
  });
  await studio.next(
    (frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start',
  );
  return started;
}

test('an explicit unknown workflow is rejected instead of opening Direct mode', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t);
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=invalid-workflow&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');

  sendFrame(studio, {
    type: 'chat-start',
    agent: 'claude',
    workflow: 'surprise-mode',
    threadId: 'thread-invalid-workflow',
    documentId: 'document-invalid-workflow',
  });
  const error = await studio.next((frame) => frame.type === 'chat-error');
  assert.equal(error.code, 'INVALID_WORKFLOW');
  assert.match(error.message, /Unknown workflow: surprise-mode/);
});

test('a standalone implementation command follows the same Plan approval transition', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakePi: true });
  const sessionId = 'typed-plan-approval';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  sendFrame(studio, {
    type: 'chat-start',
    agent: 'pi',
    workflow: 'plan',
    threadId: 'thread-typed-plan-approval',
    documentId: 'document-typed-plan-approval',
  });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  assert.equal(started.workflow, 'plan');
  assert.equal(started.phase, 'planning');

  sendFrame(studio, {
    type: 'chat-user-message',
    threadId: started.threadId,
    documentId: started.documentId,
    text: 'Prepare the implementation plan.',
  });
  await studio.next(
    (frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start',
  );

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(mcp));
  sendFrame(mcp, {
    type: 'tool-call',
    id: 31,
    tool: 'present_implementation_plan',
    args: implementationPlanArgs(),
    workflow: 'plan',
    capabilityEpoch: started.capabilityEpoch,
  });
  const ready = await studio.next((frame) => frame.type === 'plan-ready');
  const planResult = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 31);
  assert.equal(planResult.ok, true);
  assert.equal(ready.phase, 'awaiting-approval');

  // A Studio frame cannot forge the internal document-save transition lock
  // and revise a plan while the provider turn that presented it is active.
  sendFrame(studio, {
    type: 'plan-request-changes',
    planId: ready.planId,
    feedback: 'This must wait until the current turn settles.',
    sessionStatusOverride: 'idle',
  });
  const busy = await studio.next(
    (frame) => frame.type === 'chat-error' && frame.code === 'AGENT_BUSY',
  );
  assert.match(busy.message, /agent is idle/i);

  sendFrame(studio, { type: 'chat-interrupt' });
  await studio.next(
    (frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end',
  );

  sendFrame(studio, {
    type: 'chat-user-message',
    threadId: started.threadId,
    documentId: started.documentId,
    text: 'implement the plan',
  });
  const approved = await studio.next((frame) => frame.type === 'plan-approved');
  const implementing = await studio.next((frame) => frame.type === 'implementation-started');
  assert.equal(approved.planId, ready.planId);
  assert.equal(approved.phase, 'switching');
  assert.equal(implementing.planId, ready.planId);
  assert.equal(implementing.phase, 'implementing');
});

test('a correlated root provider event authorizes MCP even when its socket call arrives first', { timeout: 40_000 }, async (t) => {
  const {
    port,
    cursorLegacyReadyPath,
    cursorQuestionReleasePath,
  } = await startHub(t, { fakeCursor: true, gateCursorQuestion: true });
  const sessionId = 'question-correlated-root';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, 'cursor');
  // ACP fallback takes longer on Windows because the failed native process
  // must be reaped first. The fixture stops after claiming the legacy turn.
  await waitForPath(cursorLegacyReadyPath);

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=cursor&role=chat`);
  t.after(() => closeClient(mcp));
  sendFrame(mcp, {
    type: 'tool-call', id: 9, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  // WebSocket message order plus this response proves the server handled id 9
  // and entered its scope wait before the provider can publish the matching
  // event. The unknown tool changes no session state.
  sendFrame(mcp, { type: 'tool-call', id: 10, tool: 'ordering_barrier', args: {} });
  const barrier = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 10);
  assert.equal(barrier.ok, false);
  assert.equal(barrier.error.code, 'UNKNOWN_TOOL');
  writeFileSync(cursorQuestionReleasePath, '');
  const requested = await studio.next((frame) => frame.type === 'user-question-requested');
  sendFrame(studio, {
    type: 'user-question-answer',
    interactionId: requested.interaction.interactionId,
    responseId: 'correlated-root-answer',
    answers: { format: { selectedOptionIds: ['option-1'] } },
  });
  const result = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 9);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.answers.format.selected, ['Brief']);
});

test('direct MCP questions survive Studio reload and settle atomically', { timeout: 40_000 }, async (t) => {
  const { port, stderr } = await startHub(t, { fakePi: true });
  const studioUrl = `ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=question-session`;
  const studio = await openClient(`${studioUrl}&instance=page-1`);
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, 'pi');

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-session&agent=pi&role=chat`);
  t.after(() => closeClient(mcp));
  sendFrame(mcp, {
    type: 'tool-call', id: 17, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const requested = await studio.next((frame) => frame.type === 'user-question-requested');
  assert.equal(requested.interaction.source, 'mcp');
  assert.equal(requested.interaction.questions[0].options[1].id, 'option-2');

  const busyMcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-session&agent=pi&role=chat`);
  t.after(() => closeClient(busyMcp));
  sendFrame(busyMcp, {
    type: 'tool-call', id: 18, tool: 'ask_user_question', args: {
      questions: [{
        id: 'tone', header: 'Tone', question: 'Which tone?',
        options: [
          { label: 'Neutral', description: 'Use a neutral tone.' },
          { label: 'Warm', description: 'Use a warm tone.' },
        ],
      }],
    }, workflow: 'direct',
  });
  const busy = await busyMcp.next((frame) => frame.type === 'tool-result' && frame.id === 18);
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, 'INTERACTION_ALREADY_PENDING');

  await closeClient(studio);
  const reloaded = await openClient(`${studioUrl}&instance=page-2`);
  t.after(() => closeClient(reloaded));
  const welcome = await reloaded.next((frame) => frame.type === 'welcome');
  assert.equal(welcome.session.pendingUserQuestion.interactionId, requested.interaction.interactionId);
  const replay = await reloaded.next((frame) => frame.type === 'user-question-requested');
  assert.equal(replay.replayed, true);
  assert.equal(replay.interaction.interactionId, requested.interaction.interactionId);

  sendFrame(reloaded, {
    type: 'user-question-answer',
    interactionId: requested.interaction.interactionId,
    responseId: 'response-invalid',
    answers: { format: { selectedOptionIds: ['unknown'] } },
  });
  const invalid = await reloaded.next((frame) => frame.type === 'user-question-answer-result' && frame.responseId === 'response-invalid');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_USER_QUESTION_ANSWER');

  const answer = {
    type: 'user-question-answer',
    interactionId: requested.interaction.interactionId,
    responseId: 'response-valid',
    answers: { format: { selectedOptionIds: ['option-2'] } },
  };
  sendFrame(reloaded, answer);
  const acknowledged = await reloaded.next((frame) => frame.type === 'user-question-answer-result' && frame.responseId === 'response-valid');
  const resolved = await reloaded.next((frame) => frame.type === 'user-question-resolved');
  const toolResult = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 17);
  assert.equal(acknowledged.ok, true);
  assert.deepEqual(resolved.outcome, {
    status: 'answered',
    answers: { format: { selectedOptionIds: ['option-2'] } },
  });
  assert.deepEqual(toolResult, {
    v: 5,
    type: 'tool-result',
    id: 17,
    ok: true,
    result: {
      status: 'answered',
      answers: { format: { selected: ['Detailed'] } },
    },
  });

  sendFrame(reloaded, answer);
  const replayedReceipt = await reloaded.next((frame) => frame.type === 'user-question-answer-result' && frame.responseId === 'response-valid');
  assert.deepEqual(replayedReceipt, acknowledged);
  assert.doesNotMatch(stderr(), /response-valid|option-2/);
});

test('provider MCP writes are bound to one exact running turn', { timeout: 40_000 }, async (t) => {
  const { port, stderr } = await startHub(t, { fakePi: true });
  const sessionId = 'mcp-turn-ownership';
  const studio = await openClient(
    `ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`,
  );
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  const started = await startRunningChat(studio, 'pi');
  const mcp = await openClient(
    `ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`,
  );
  t.after(() => closeClient(mcp));
  const writeArgs = {
    expectedRevision: 0,
    sectionIdx: 0,
    paraIdx: 0,
    charOffset: 0,
    text: 'must stay inside the owning turn',
  };

  sendFrame(mcp, {
    type: 'tool-call', id: 61, tool: 'insert_text', args: writeArgs,
    workflow: 'direct', capabilityEpoch: started.capabilityEpoch,
  });
  const forwarded = await studio.next(
    (frame) => frame.type === 'tool-request' && frame.tool === 'insert_text',
  );
  assert.equal(forwarded.turnBound, true);
  assert.equal(typeof forwarded.providerTurnId, 'string');
  const mcpClosed = once(mcp.socket, 'close');
  sendFrame(studio, { type: 'chat-interrupt' });
  const cancelled = await studio.next(
    (frame) => frame.type === 'tool-request-cancel' && frame.id === forwarded.id,
  );
  assert.equal(cancelled.providerTurnId, forwarded.providerTurnId);
  const invalidated = await mcp.next(
    (frame) => frame.type === 'tool-result' && frame.id === 61,
  );
  assert.equal(invalidated.ok, false, stderr());
  assert.equal(invalidated.error.code, 'NO_ACTIVE_TURN');
  const [closeCode] = await mcpClosed;
  assert.equal(closeCode, 4003, 'the settled turn permanently retires its MCP socket');

  // A late Studio response cannot be rebound to the settled or a future turn.
  sendFrame(studio, {
    type: 'tool-response', id: forwarded.id, ok: true, result: { revision: 1 },
  });
  await assert.rejects(
    mcp.next((frame) => frame.type === 'tool-result' && frame.id === 61, 300),
    /Timed out waiting for websocket frame/,
  );

  const idleMcp = await openClient(
    `ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`,
  );
  const [idleCloseCode] = await once(idleMcp.socket, 'close');
  assert.equal(idleCloseCode, 4003, 'a socket opened between turns is never eligible later');
  await assert.rejects(
    studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'insert_text', 300),
    /Timed out waiting for websocket frame/,
  );
});

test('URL agent and role spoofing cannot bypass root question correlation', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakeCursor: true, emitCursorQuestion: false });
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=question-loss&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, 'cursor');

  const subagent = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-loss&agent=cursor&role=chat`);
  sendFrame(subagent, {
    type: 'tool-call', id: 20, tool: 'ask_user_question', args: questionArgs(),
    workflow: 'direct', parentTaskId: 'child-task',
  });
  const rejected = await subagent.next((frame) => frame.type === 'tool-result' && frame.id === 20);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'ROOT_INTERACTION_REQUIRED');
  await closeClient(subagent);

  assert.equal(
    await rejectedUpgrade(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-loss&agent=pi&role=chat`),
    401,
  );

  const unknownRoot = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-loss&agent=cursor&role=chat`);
  sendFrame(unknownRoot, {
    type: 'tool-call', id: 21, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const unknown = await unknownRoot.next((frame) => frame.type === 'tool-result' && frame.id === 21);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'CALLER_SCOPE_UNKNOWN');
  await closeClient(unknownRoot);
});

test('a legitimate Pi root question expires on disconnect or a missing Studio', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakePi: true });
  const sessionId = 'question-pi-disconnect';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, 'pi');
  const registration = await registerSession(port, sessionId);

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${registration.capabilities.mcp}&sessionId=${sessionId}&agent=pi&role=chat`);
  sendFrame(mcp, {
    type: 'tool-call', id: 22, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const requested = await studio.next((frame) => frame.type === 'user-question-requested');
  await closeClient(mcp);
  const resolved = await studio.next((frame) => (
    frame.type === 'user-question-resolved'
      && frame.interactionId === requested.interaction.interactionId
  ));
  assert.deepEqual(resolved.outcome, { status: 'expired', reason: 'provider-disconnected' });

  await closeClient(studio);
  const disconnected = await openClient(`ws://127.0.0.1:${port}/mcp?token=${registration.capabilities.mcp}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(disconnected));
  sendFrame(disconnected, {
    type: 'tool-call', id: 23, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const unavailable = await disconnected.next((frame) => frame.type === 'tool-result' && frame.id === 23);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, 'NO_STUDIO');
});

for (const stopType of ['chat-interrupt', 'chat-stop']) {
  test(`${stopType} cancels an active question`, { timeout: 40_000 }, async (t) => {
    const { port } = await startHub(t, { fakePi: true });
    const sessionId = `question-${stopType}`;
    const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
    t.after(() => closeClient(studio));
    await studio.next((frame) => frame.type === 'welcome');
    await startRunningChat(studio, 'pi');

    const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
    t.after(() => closeClient(mcp));
    sendFrame(mcp, {
      type: 'tool-call', id: 31, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
    });
    const requested = await studio.next((frame) => frame.type === 'user-question-requested');
    sendFrame(studio, { type: stopType });

    const resolved = await studio.next((frame) => (
      frame.type === 'user-question-resolved'
        && frame.interactionId === requested.interaction.interactionId
    ));
    const toolResult = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 31);
    assert.deepEqual(resolved.outcome, { status: 'cancelled', reason: 'user-stop' });
    assert.equal(toolResult.ok, false);
    assert.equal(toolResult.error.code, 'USER_QUESTION_CANCELLED');
  });
}

test('hub shutdown expires an active question before closing transports', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakePi: true });
  const sessionId = 'question-hub-shutdown';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, 'pi');

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  sendFrame(mcp, {
    type: 'tool-call', id: 41, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const requested = await studio.next((frame) => frame.type === 'user-question-requested');
  const response = await fetch(`http://127.0.0.1:${port}/shutdown`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-rhwp-launch-id': 'hub-user-question-test-launch',
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'prepared');

  const resolved = await studio.next((frame) => (
    frame.type === 'user-question-resolved'
      && frame.interactionId === requested.interaction.interactionId
  ));
  assert.deepEqual(resolved.outcome, { status: 'expired', reason: 'hub-restarted' });
  await Promise.allSettled([closeClient(studio), closeClient(mcp)]);
});
