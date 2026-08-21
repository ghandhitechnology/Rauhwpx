// Claude 서브에이전트/워크플로 task 수명주기 파싱과 턴 정착 검증.
// 이벤트 모양은 실제 CLI(2.1.235) stream-json 캡처를 그대로 따른다:
// system/task_started·task_progress·task_updated·task_notification, 백그라운드
// task 알림이 만드는 다중 result(wake 재호출), 누적 modelUsage.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';

import { createClaudeSession } from '../agents/claude.mjs';

const baseOpts = {
  rootDir: '/tmp/rhwp',
  isolatedHome: '/tmp/rhwp-home',
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 5175,
  token: 'token',
  model: 'test-model',
  onEvent() {},
};

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

  kill(signal) {
    queueMicrotask(() => {
      this.signalCode = signal ?? 'SIGTERM';
      this.emit('exit', null, this.signalCode);
    });
    return true;
  }

  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }
}

function startSession(events) {
  let child;
  const session = createClaudeSession(
    { ...baseOpts, onEvent: (event) => events.push(event) },
    { spawnProcess() { child = new FakeProcess(); return child; }, terminateProcess(proc) { proc.kill('SIGTERM'); } },
  );
  session.sendUserMessage('go');
  return { session, child: () => child };
}

const TASK_STARTED = {
  type: 'system', subtype: 'task_started', task_id: 'task-a', tool_use_id: 'toolu-1',
  description: '2쪽 정리', subagent_type: 'doc-editor', task_type: 'local_agent', prompt: 'p',
};
const RESULT = {
  type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done',
};

test('task lifecycle events are normalized with parentTaskId attribution', async () => {
  const events = [];
  const { session, child } = startSession(events);
  await new Promise((resolve) => setImmediate(resolve));

  child().emitJson(
    TASK_STARTED,
    {
      type: 'system', subtype: 'task_progress', task_id: 'task-a', tool_use_id: 'toolu-1',
      description: 'Running replace', subagent_type: 'doc-editor',
      usage: { total_tokens: 640, tool_uses: 2, duration_ms: 900 }, last_tool_name: 'replace_range',
    },
    // 서브에이전트 내부 도구 호출/결과 — parent_tool_use_id 로 귀속된다.
    {
      type: 'assistant', parent_tool_use_id: 'toolu-1',
      message: { content: [{ type: 'tool_use', id: 'toolu-child', name: 'mcp__rhwp__replace_range', input: { paraIdx: 3 } }] },
    },
    {
      type: 'user', parent_tool_use_id: 'toolu-1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-child', content: 'ok' }] },
    },
    {
      type: 'assistant', parent_tool_use_id: 'toolu-1',
      message: { content: [{ type: 'text', text: '2쪽 정리 완료' }] },
    },
    { type: 'system', subtype: 'task_updated', task_id: 'task-a', patch: { status: 'completed', end_time: 1 } },
    {
      type: 'system', subtype: 'task_notification', task_id: 'task-a', tool_use_id: 'toolu-1',
      status: 'completed', summary: '정리 완료', usage: { total_tokens: 700, tool_uses: 2, duration_ms: 1100 },
    },
  );

  const start = events.find((e) => e.type === 'task-start');
  assert.deepEqual(start, {
    type: 'task-start', agent: 'claude', taskId: 'task-a', callId: 'toolu-1',
    title: '2쪽 정리', role: 'doc-editor', taskKind: 'agent',
  });
  const progress = events.find((e) => e.type === 'task-progress');
  assert.equal(progress.lastTool, 'replace_range');
  assert.deepEqual(progress.usage, { totalTokens: 640, toolUses: 2, durationMs: 900 });

  const call = events.find((e) => e.type === 'tool-call');
  assert.equal(call.parentTaskId, 'task-a');
  assert.equal(call.tool, 'replace_range');
  const toolResult = events.find((e) => e.type === 'tool-result');
  assert.equal(toolResult.parentTaskId, 'task-a');
  const childText = events.find((e) => e.type === 'text-delta');
  assert.equal(childText.parentTaskId, 'task-a');
  assert.equal(childText.text, '2쪽 정리 완료');

  const ends = events.filter((e) => e.type === 'task-end');
  // task_updated 가 상태를 먼저 확정하고 task_notification 이 summary/usage 를 채운다.
  assert.equal(ends.length, 2);
  assert.equal(ends[0].status, 'completed');
  assert.equal(ends[0].summary, undefined);
  assert.equal(ends[1].summary, '정리 완료');
  assert.deepEqual(ends[1].usage, { totalTokens: 700, toolUses: 2, durationMs: 1100 });

  await session.dispose();
});

test('turn stays open across wake results and settles after quiescence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const { session, child } = startSession(events);
  await new Promise((resolve) => setImmediate(resolve));

  // 백그라운드 스폰: tool_result 는 즉시 오고 result #1 은 fleet 완료 전에 온다.
  child().emitJson(TASK_STARTED, RESULT);
  assert.equal(events.filter((e) => e.type === 'turn-end').length, 0, 'pending task must hold the turn');

  // task 완료 알림 → wake 재호출 시작 → 새 result.
  child().emitJson(
    { type: 'system', subtype: 'task_notification', task_id: 'task-a', tool_use_id: 'toolu-1', status: 'completed', summary: 'ok' },
    RESULT,
  );
  assert.equal(events.filter((e) => e.type === 'turn-end').length, 0, 'grace must delay settling');

  // 유예 중 새 stdout 라인이 오면 정착이 미뤄진다 (wake 가 아직 일하는 중).
  t.mock.timers.tick(1_000);
  child().emitJson({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }, RESULT);
  t.mock.timers.tick(1_400);
  assert.equal(events.filter((e) => e.type === 'turn-end').length, 0);
  t.mock.timers.tick(200);

  const turnEnds = events.filter((e) => e.type === 'turn-end');
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].stopReason, 'end_turn');
  assert.equal(turnEnds[0].errorMessage, undefined);

  await session.dispose();
});

test('wake invocation root text starts a new paragraph', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const { session, child } = startSession(events);
  await new Promise((resolve) => setImmediate(resolve));

  child().emitJson(
    { type: 'assistant', message: { content: [{ type: 'text', text: '두 에이전트를 띄웁니다.' }] } },
    TASK_STARTED,
    RESULT,
    { type: 'system', subtype: 'task_notification', task_id: 'task-a', tool_use_id: 'toolu-1', status: 'completed' },
    // wake 재호출의 루트 텍스트 — 이전 메시지와 이어 붙지 않아야 한다.
    { type: 'assistant', message: { content: [{ type: 'text', text: '완료했습니다.' }] } },
    RESULT,
  );
  t.mock.timers.tick(1_600);

  const texts = events.filter((e) => e.type === 'text-delta' && !e.parentTaskId).map((e) => e.text);
  assert.deepEqual(texts, ['두 에이전트를 띄웁니다.', '\n\n완료했습니다.']);
  // 서브에이전트 텍스트에는 구분을 붙이지 않는다 — 자기 행 활동 줄로만 간다.
  assert.equal(events.filter((e) => e.type === 'turn-end').length, 1);

  await session.dispose();
});

test('turns without tasks settle immediately on result', async () => {
  const events = [];
  const { session, child } = startSession(events);
  await new Promise((resolve) => setImmediate(resolve));

  child().emitJson(RESULT);
  const turnEnds = events.filter((e) => e.type === 'turn-end');
  assert.equal(turnEnds.length, 1, 'no grace latency for plain turns');
  assert.equal(turnEnds[0].stopReason, 'end_turn');

  await session.dispose();
});

test('any errored wake result marks the settled turn as failed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const { session, child } = startSession(events);
  await new Promise((resolve) => setImmediate(resolve));

  child().emitJson(
    TASK_STARTED,
    { type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: 'end_turn', result: 'boom' },
    { type: 'system', subtype: 'task_notification', task_id: 'task-a', tool_use_id: 'toolu-1', status: 'completed' },
    RESULT,
  );
  t.mock.timers.tick(1_600);

  const turnEnds = events.filter((e) => e.type === 'turn-end');
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].errorMessage, 'boom');

  await session.dispose();
});

test('cumulative modelUsage is emitted as per-result deltas with cost', async () => {
  const events = [];
  const { session, child } = startSession(events);
  await new Promise((resolve) => setImmediate(resolve));

  child().emitJson(
    TASK_STARTED,
    {
      ...RESULT,
      modelUsage: {
        'claude-haiku-4-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, costUSD: 0.02 },
      },
    },
    { type: 'system', subtype: 'task_notification', task_id: 'task-a', tool_use_id: 'toolu-1', status: 'completed' },
    {
      ...RESULT,
      modelUsage: {
        'claude-haiku-4-5': { inputTokens: 160, outputTokens: 80, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, costUSD: 0.03 },
      },
    },
  );

  const usage = events.filter((e) => e.type === 'usage');
  assert.equal(usage.length, 2);
  assert.deepEqual(usage[0].usage, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 });
  assert.equal(usage[0].costUsd, 0.02);
  assert.deepEqual(usage[1].usage, { inputTokens: 60, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.ok(Math.abs(usage[1].costUsd - 0.01) < 1e-9);

  await session.dispose();
});

test('workflow progress is normalized and deduplicated by fingerprint', async () => {
  const events = [];
  const { session, child } = startSession(events);
  await new Promise((resolve) => setImmediate(resolve));

  const workflowProgress = [
    { type: 'workflow_phase', index: 1, title: 'Draft' },
    {
      type: 'workflow_agent', index: 1, label: 'page-1', phaseIndex: 1, phaseTitle: 'Draft',
      state: 'start', startedAt: 10, attempt: 1, model: 'claude-haiku-4-5', tokens: 120, toolCalls: 3,
      lastToolName: 'insert_text',
    },
    { type: 'workflow_agent', index: 2, label: 'page-2', phaseIndex: 1, state: 'queued', attempt: 1 },
  ];
  const progressEvent = {
    type: 'system', subtype: 'task_progress', task_id: 'wf-1', tool_use_id: 'toolu-wf',
    description: 'Draft: page-1', usage: { total_tokens: 120, tool_uses: 3, duration_ms: 500 },
    workflow_progress: workflowProgress,
  };
  child().emitJson(
    {
      type: 'system', subtype: 'task_started', task_id: 'wf-1', tool_use_id: 'toolu-wf',
      description: '문서 초안', task_type: 'local_workflow', workflow_name: 'draft-doc',
    },
    progressEvent,
    progressEvent, // 같은 스냅샷 반복 — members/phases 는 다시 오지 않아야 한다.
  );

  const start = events.find((e) => e.type === 'task-start');
  assert.equal(start.taskKind, 'workflow');
  assert.equal(start.workflowName, 'draft-doc');

  const progress = events.filter((e) => e.type === 'task-progress');
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0].phases, [{ index: 1, title: 'Draft' }]);
  assert.deepEqual(progress[0].members, [
    { index: 1, label: 'page-1', state: 'running', phaseIndex: 1, model: 'claude-haiku-4-5', tokens: 120, toolCalls: 3, activity: 'insert_text' },
    { index: 2, label: 'page-2', state: 'pending', phaseIndex: 1 },
  ]);
  assert.equal(progress[1].members, undefined, 'unchanged snapshot must not re-emit members');
  assert.equal(progress[1].phases, undefined);

  await session.dispose();
});

test('interrupt closes a fleet turn and clears the settle timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const { session, child } = startSession(events);
  await new Promise((resolve) => setImmediate(resolve));

  child().emitJson(TASK_STARTED, RESULT);
  session.interrupt();

  const turnEnds = events.filter((e) => e.type === 'turn-end');
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].stopReason, 'interrupted');

  t.mock.timers.tick(5_000);
  assert.equal(events.filter((e) => e.type === 'turn-end').length, 1, 'no second turn-end after interrupt');

  await session.dispose();
});
