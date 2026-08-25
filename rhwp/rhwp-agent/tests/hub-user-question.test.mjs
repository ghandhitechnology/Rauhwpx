import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';

const TOKEN = 'hub-user-question-test-token';

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

async function openClient(url) {
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

function sendFrame(client, frame) {
  client.socket.send(JSON.stringify({ v: 4, ...frame }));
}

async function closeClient(client) {
  if (!client || client.socket.readyState === WebSocket.CLOSED) return;
  const closed = once(client.socket, 'close');
  client.socket.close();
  await closed;
}

async function startHub(t, { fakeCursor = false, cursorQuestionDelayMs = 0 } = {}) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-user-question-'));
  let testPath = process.env.PATH;
  if (fakeCursor) {
    const binDir = path.join(workRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const cursorBin = path.join(binDir, 'cursor-agent');
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
    writeFileSync(cursorBin, [
      '#!/usr/bin/env node',
      "if (process.argv.includes('--version')) { console.log('2026.08.11-e2e'); process.exit(0); }",
      "if (process.argv.includes('status')) { console.log('Not logged in'); process.exit(1); }",
      "if (process.argv[2] === 'acp') process.exit(1);",
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(init)}\n`)});`,
      `setTimeout(() => process.stdout.write(${JSON.stringify(`${JSON.stringify(call)}\n`)}), ${cursorQuestionDelayMs});`,
      'setInterval(() => {}, 1000);',
    ].join('\n'), { mode: 0o755 });
    testPath = `${binDir}${path.delimiter}${testPath}`;
  }
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RHWP_AGENT_PORT: '0',
      RHWP_AGENT_TOKEN: TOKEN,
      RHWP_LAUNCH_ID: 'hub-user-question-test-launch',
      RHWP_WORK_DIR: workRoot,
      RHWP_TEMPLATES_DIR: path.join(workRoot, 'templates'),
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
  return { port: ready.port, stderr: () => stderr };
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
  await new Promise((resolve) => setTimeout(resolve, 50));
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
  const { port } = await startHub(t);
  const sessionId = 'typed-plan-approval';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  sendFrame(studio, {
    type: 'chat-start',
    agent: 'claude',
    workflow: 'plan',
    threadId: 'thread-typed-plan-approval',
    documentId: 'document-typed-plan-approval',
  });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  assert.equal(started.workflow, 'plan');
  assert.equal(started.phase, 'planning');

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=claude&role=chat`);
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
  const { port } = await startHub(t, { fakeCursor: true, cursorQuestionDelayMs: 200 });
  const sessionId = 'question-correlated-root';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, 'cursor');

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=cursor&role=chat`);
  t.after(() => closeClient(mcp));
  sendFrame(mcp, {
    type: 'tool-call', id: 9, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
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
  const { port, stderr } = await startHub(t);
  const studioUrl = `ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=question-session`;
  const studio = await openClient(`${studioUrl}&instance=page-1`);
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio);

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
    v: 4,
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

test('root-scope violations fail and MCP disconnect expires the active question', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t);
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=question-loss&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio);

  const subagent = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-loss&agent=claude&role=subagent`);
  sendFrame(subagent, {
    type: 'tool-call', id: 20, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const rejected = await subagent.next((frame) => frame.type === 'tool-result' && frame.id === 20);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'ROOT_INTERACTION_REQUIRED');
  await closeClient(subagent);

  const unknownRoot = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-loss&agent=claude&role=chat`);
  sendFrame(unknownRoot, {
    type: 'tool-call', id: 21, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const unknown = await unknownRoot.next((frame) => frame.type === 'tool-result' && frame.id === 21);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'CALLER_SCOPE_UNKNOWN');
  await closeClient(unknownRoot);

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-loss&agent=pi&role=chat`);
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
  const disconnected = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-loss&agent=pi&role=chat`);
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
    const { port } = await startHub(t);
    const sessionId = `question-${stopType}`;
    const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
    t.after(() => closeClient(studio));
    await studio.next((frame) => frame.type === 'welcome');
    await startRunningChat(studio);

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
  const { port } = await startHub(t);
  const sessionId = 'question-hub-shutdown';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio);

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
  assert.equal(response.status, 202);

  const resolved = await studio.next((frame) => (
    frame.type === 'user-question-resolved'
      && frame.interactionId === requested.interaction.interactionId
  ));
  assert.deepEqual(resolved.outcome, { status: 'expired', reason: 'hub-restarted' });
  await Promise.allSettled([closeClient(studio), closeClient(mcp)]);
});
