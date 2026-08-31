// Cursor 서브에이전트(taskToolCall) task 수명주기 파싱과 턴 정착 검증.
//
// 이벤트 모양은 실행 캡처가 아니라 빌드 2026.08.11-e8db854 번들에서 정적 추출한
// 스키마를 그대로 따른다 (이 머신의 cursor-agent 는 미인증이라 실행이 불가능하다):
//   /tmp/rhwp-probe3/cursor/evidence.txt      — agent.v1.ToolCall / TaskArgs /
//       TaskSuccess / TaskError / ConversationStep / SubagentType 필드 목록,
//       system/task_notification 방출 지점, 백그라운드 완료 큐 payload
//   /tmp/rhwp-probe3/cursor/emitter-region.txt — 헤드리스 stream-json 이미터
// protobuf-es toJson(emitDefaultValues) 규약을 지켜 만든다: 비-옵셔널 스칼라는
// 항상 실리고(빈 문자열/false 포함), 옵셔널 필드는 미설정 시 아예 빠지며,
// oneof 는 lowerCamel 키 하나로 평평해지고, uint64 는 문자열로 실린다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCursorSession } from '../agents/cursor.mjs';

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const baseOpts = {
  rootDir: '/tmp/rhwp',
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 6401,
  token: 'secret-token',
  sessionId: 'studio-thread-cursor',
  model: 'auto',
  permissionProfile: 'safe',
  onEvent() {},
};

class FakeStream extends EventEmitter {}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode = null;
  signalCode = null;
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    queueMicrotask(() => {
      if (this.signalCode !== null || this.exitCode !== null) return;
      this.signalCode = signal;
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    });
    return true;
  }

  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  exit(code) {
    this.exitCode = code;
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

const PROVEN_TREE_CLEANUP = {
  terminateProcess() { return true; },
  waitForExit: async () => true,
};

function startSession(t, extra = {}, dependencies = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cursor-task-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const spawns = [];
  const session = createCursorSession(
    {
      ...baseOpts,
      isolatedHome: path.join(root, 'home'),
      cursorSourceDir: path.join(root, 'source', '.cursor'),
      ...extra,
      onEvent: (event) => events.push(event),
    },
    {
      spawnProcess() {
        const proc = new FakeProcess();
        spawns.push(proc);
        return proc;
      },
      ...dependencies,
    },
  );
  t.after(() => session.dispose());
  session.sendUserMessage('두 곳을 나눠 고쳐 줘');
  return { session, events, proc: spawns[0], spawns };
}

const INIT_LINE = {
  type: 'system', subtype: 'init', apiKeySource: 'login', cwd: '/tmp/rhwp',
  session_id: SESSION, model: 'gpt-5.2', permissionMode: 'default',
};

const RESULT = {
  type: 'result', subtype: 'success', duration_ms: 8_000, duration_api_ms: 7_900,
  is_error: false, result: '두 곳 모두 고쳤습니다.', session_id: SESSION, request_id: 'req-1',
};

/** agent.v1.McpArgs — 기본값 필드까지 전부 실린다. */
const MCP_ARGS = {
  name: 'mcp__rhwp__replace_range',
  args: { sectionIdx: 0, paraIdx: 3 },
  toolCallId: '',
  providerIdentifier: '',
  toolName: 'replace_range',
  smartModeApprovalOnly: false,
  skipApproval: false,
  serverIdentifier: '',
};

/** agent.v1.TaskArgs. description/prompt/subagentType/mode/environment 는 항상 실린다. */
function taskArgs(overrides = {}) {
  return {
    description: '2쪽 표 정리',
    prompt: 'Fix the table on page 2.\nStay inside paragraphs 10-24.',
    subagentType: { explore: {} },
    attachments: [],
    mode: 'TASK_MODE_AGENT',
    respondingToMessageIds: [],
    environment: 'SUBAGENT_EXECUTION_ENVIRONMENT_LOCAL',
    ...overrides,
  };
}

/**
 * tool_call/started. oneof 아닌 형제(hookAdditionalContexts/startedAtMs)를 일부러
 * 앞에 두어 키 순서에 기대지 않는지 확인한다.
 */
function taskStarted(callId, args = taskArgs()) {
  return {
    type: 'tool_call', subtype: 'started', call_id: callId,
    model_call_id: 'mc-1', session_id: SESSION, timestamp_ms: 10,
    tool_call: { hookAdditionalContexts: [], startedAtMs: '1755600000000', taskToolCall: { args } },
  };
}

function taskCompleted(callId, result, args = taskArgs()) {
  return {
    type: 'tool_call', subtype: 'completed', call_id: callId,
    model_call_id: 'mc-1', session_id: SESSION, timestamp_ms: 20,
    tool_call: {
      hookAdditionalContexts: [],
      completedAtMs: '1755600004200',
      taskToolCall: { args, result },
    },
  };
}

/** agent.v1.TaskSuccess — is_background/background_reason 는 비-옵셔널이라 항상 실린다. */
function taskSuccess(overrides = {}) {
  return {
    success: {
      conversationSteps: [],
      isBackground: false,
      backgroundReason: 'SUBAGENT_BACKGROUND_REASON_UNSPECIFIED',
      ...overrides,
    },
  };
}

test('a task tool call opens a fleet card instead of a root tool row', (t) => {
  const { events, proc } = startSession(t);
  proc.emitJson(INIT_LINE, taskStarted('call-task-1'));

  const start = events.find((event) => event.type === 'task-start');
  assert.deepEqual(start, {
    type: 'task-start', agent: 'cursor', taskId: 'call-task-1', callId: 'call-task-1',
    title: '2쪽 표 정리', role: 'explore', taskKind: 'agent',
  });
  assert.equal(events.some((event) => event.type === 'tool-call'), false, '스폰은 도구 행으로 나오지 않는다');
});

test('the completed transcript replays as parentTaskId-attributed child events', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { events, proc } = startSession(t);
  proc.emitJson(
    INIT_LINE,
    taskStarted('call-task-1'),
    taskCompleted('call-task-1', taskSuccess({
      conversationSteps: [
        { assistantMessage: { text: '표를 확인했습니다.' } },
        {
          toolCall: {
            toolCallId: 'child-call-1',
            mcpToolCall: { args: MCP_ARGS, result: { success: { revision: 8 } } },
          },
        },
        // thinkingMessage 는 카드에 싣지 않는다.
        { thinkingMessage: { text: '어느 열부터 볼지 고민', durationMs: 120 } },
        { assistantMessage: { text: '정리를 마쳤습니다.' } },
      ],
      agentId: 'agent-uuid-1',
      durationMs: '4200',
      resultSuffix: '2쪽 표 정리 완료',
      transcriptPath: '/tmp/transcript.json',
    })),
    RESULT,
  );

  const childTexts = events.filter((event) => event.type === 'text-delta' && event.parentTaskId);
  assert.deepEqual(childTexts.map((event) => event.text), ['표를 확인했습니다.', '\n\n정리를 마쳤습니다.']);
  assert.deepEqual([...new Set(childTexts.map((event) => event.parentTaskId))], ['call-task-1']);

  const call = events.find((event) => event.type === 'tool-call');
  assert.deepEqual(call, {
    type: 'tool-call', agent: 'cursor', callId: 'child-call-1', tool: 'replace_range',
    argsJson: '{"sectionIdx":0,"paraIdx":3}', parentTaskId: 'call-task-1',
  });
  const toolResult = events.find((event) => event.type === 'tool-result');
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.parentTaskId, 'call-task-1');

  const end = events.find((event) => event.type === 'task-end');
  assert.deepEqual(end, {
    type: 'task-end', agent: 'cursor', taskId: 'call-task-1', status: 'completed',
    summary: '2쪽 표 정리 완료',
    // uint64 durationMs 는 문자열로 온다.
    usage: { toolUses: 1, durationMs: 4200 },
  });
  // 서브에이전트 텍스트는 루트 본문으로 새지 않는다 — result 폴백이 그대로 살아 있다.
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta' && !event.parentTaskId).map((event) => event.text),
    ['두 곳 모두 고쳤습니다.'],
  );
  // task 가 있었던 턴은 카드가 다 닫힌 뒤 조용해져야 정착한다.
  assert.equal(events.some((event) => event.type === 'turn-end'), false);
  proc.exit(0);
  assert.equal(events.at(-1).type, 'turn-end');
});

test('a transcript without resultSuffix summarizes with its last assistant message', (t) => {
  const { events, proc } = startSession(t);
  proc.emitJson(
    taskStarted('call-task-1'),
    taskCompleted('call-task-1', taskSuccess({
      conversationSteps: [
        { assistantMessage: { text: '앞부분 확인' } },
        { assistantMessage: { text: '10-24문단 서식만 바꿨습니다.' } },
      ],
      agentId: 'agent-uuid-1',
    })),
  );
  const end = events.find((event) => event.type === 'task-end');
  assert.equal(end.summary, '10-24문단 서식만 바꿨습니다.');
  assert.equal(end.usage, undefined, 'durationMs 도 toolUses 도 없으면 usage 를 만들지 않는다');
});

test('custom subagent types and empty descriptions stay readable', (t) => {
  const { events, proc } = startSession(t);
  proc.emitJson(
    taskStarted('call-task-1', taskArgs({
      description: '',
      prompt: '\n  Rewrite the intro paragraph\nthen stop.',
      subagentType: { custom: { name: 'doc-editor' } },
    })),
    // subagentType 이 비거나(unspecified) 아예 빠진 경우도 방어한다.
    taskStarted('call-task-2', taskArgs({ description: '', prompt: '', subagentType: { unspecified: {} } })),
  );
  const starts = events.filter((event) => event.type === 'task-start');
  assert.equal(starts[0].title, 'Rewrite the intro paragraph');
  assert.equal(starts[0].role, 'doc-editor');
  assert.equal(starts[1].title, '서브에이전트');
  assert.equal(starts[1].role, undefined);
});

test('a task error result closes the card as failed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { events, proc } = startSession(t);
  proc.emitJson(
    taskStarted('call-task-1'),
    taskCompleted('call-task-1', { error: { error: 'subagent exceeded its budget' } }),
    RESULT,
  );
  const end = events.find((event) => event.type === 'task-end');
  assert.deepEqual(end, {
    type: 'task-end', agent: 'cursor', taskId: 'call-task-1', status: 'failed',
    summary: 'subagent exceeded its budget',
  });
  proc.exit(0);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
});

test('a completed task without a result member closes as completed', (t) => {
  const { events, proc } = startSession(t);
  // result 는 옵셔널이라 통째로 빠질 수 있다 — 루트 도구 경로처럼 성공으로 읽는다.
  proc.emitJson(taskStarted('call-task-1'), taskCompleted('call-task-1'));
  assert.deepEqual(
    events.filter((event) => event.type === 'task-end'),
    [{ type: 'task-end', agent: 'cursor', taskId: 'call-task-1', status: 'completed' }],
  );
});

test('a background task stays open until task_notification closes it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { events, proc } = startSession(t);
  proc.emitJson(
    taskStarted('call-task-1'),
    // 백그라운드로 넘어간 서브에이전트: 전사가 비어 있고 agentId 만 실린다.
    taskCompleted('call-task-1', taskSuccess({
      agentId: 'agent-uuid-1',
      isBackground: true,
      backgroundReason: 'SUBAGENT_BACKGROUND_REASON_AGENT_REQUEST',
    })),
  );
  assert.equal(events.some((event) => event.type === 'task-end'), false, '알림 전에는 카드를 닫지 않는다');

  proc.emitJson(
    // 백그라운드 셸의 알림 — 숫자 task_id 는 아는 task 가 아니므로 조용히 버린다.
    {
      type: 'system', subtype: 'task_notification', task_id: '3', status: 'success',
      title: 'npm test', detail: 'exit 0', session_id: SESSION, timestamp_ms: 30,
    },
    // 서브에이전트 알림 — task_id 는 success.agentId 다.
    {
      type: 'system', subtype: 'task_notification', task_id: 'agent-uuid-1', status: 'success',
      title: '2쪽 표 정리', detail: '표 너비를 맞췄습니다.', session_id: SESSION, timestamp_ms: 31,
    },
    RESULT,
  );

  const ends = events.filter((event) => event.type === 'task-end');
  assert.deepEqual(ends, [{
    type: 'task-end', agent: 'cursor', taskId: 'call-task-1', status: 'completed',
    summary: '표 너비를 맞췄습니다.',
  }]);
  proc.exit(0);
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'cursor', stopReason: 'success', errorMessage: undefined,
  });
});

test('notification statuses map by name and unknown ones fail closed', (t) => {
  const { events, proc } = startSession(t);
  const background = (callId, agentId) => [
    taskStarted(callId),
    taskCompleted(callId, taskSuccess({ agentId, isBackground: true })),
  ];
  proc.emitJson(
    ...background('call-a', 'agent-a'),
    ...background('call-b', 'agent-b'),
    ...background('call-c', 'agent-c'),
    ...background('call-d', 'agent-d'),
    { type: 'system', subtype: 'task_notification', task_id: 'agent-a', status: 'aborted', title: 'a' },
    { type: 'system', subtype: 'task_notification', task_id: 'agent-b', status: 'error', title: 'b', detail: 'boom' },
    // 스키마가 넓어져 모르는 상태가 오면 성공을 지어내지 않는다.
    { type: 'system', subtype: 'task_notification', task_id: 'agent-c', status: 'timed_out', title: 'c' },
    { type: 'system', subtype: 'task_notification', task_id: 'agent-d', status: 'success', title: 'd' },
    // 모르는 id 는 무시한다 (이미 닫힌 카드의 중복 알림 포함).
    { type: 'system', subtype: 'task_notification', task_id: 'agent-a', status: 'success', title: 'a' },
    { type: 'system', subtype: 'task_notification', task_id: 'unknown-uuid', status: 'success', title: '?' },
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'task-end').map((event) => [event.taskId, event.status, event.summary]),
    [
      ['call-a', 'stopped', undefined],
      ['call-b', 'failed', 'boom'],
      ['call-c', 'failed', undefined],
      ['call-d', 'completed', undefined],
    ],
  );
});

test('an open background task holds the turn indefinitely after the result line', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { events, proc } = startSession(t);
  proc.emitJson(
    taskStarted('call-task-1'),
    taskCompleted('call-task-1', taskSuccess({ agentId: 'agent-uuid-1', isBackground: true })),
    RESULT,
  );
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0, '열린 task 가 턴을 붙든다');

  // 조용한 채로 한참 지나도 카드가 열려 있으면 턴을 닫지 않는다 — 늦게 오는
  // task_notification 이 성공한 백그라운드 카드를 stopped 로 만들면 안 된다.
  t.mock.timers.tick(30_000);
  assert.equal(events.filter((event) => event.type === 'task-end').length, 0);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0);

  // 유예를 한참 넘겨 도착한 알림도 제 카드를 완료로 닫는다.
  proc.emitJson({
    type: 'system', subtype: 'task_notification', task_id: 'agent-uuid-1', status: 'success',
    title: '3쪽 서식 정리', detail: '서식을 맞췄습니다.', session_id: SESSION, timestamp_ms: 90,
  });
  assert.deepEqual(events.at(-1), {
    type: 'task-end', agent: 'cursor', taskId: 'call-task-1', status: 'completed',
    summary: '서식을 맞췄습니다.',
  });
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0, '카드가 닫혀도 유예는 남는다');

  // 카드가 다 닫혀도 legacy 성공은 실제 stdout close 전에는 보류된다.
  t.mock.timers.tick(1_200);
  proc.emitJson({ type: 'thinking', subtype: 'delta', text: '...', session_id: SESSION, timestamp_ms: 95 });
  t.mock.timers.tick(1_400);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0);

  t.mock.timers.tick(200);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0);
  proc.exit(0);
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'cursor', stopReason: 'success', errorMessage: undefined,
  });
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
});

test('a process close ends a held turn with the deferred result and sweeps the card', (t) => {
  const { events, proc } = startSession(t);
  proc.emitJson(
    taskStarted('call-task-1'),
    taskCompleted('call-task-1', taskSuccess({ agentId: 'agent-uuid-1', isBackground: true })),
    { ...RESULT, subtype: 'error_max_turns', is_error: true, result: '한도를 넘겼습니다.' },
  );
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0);

  proc.exit(0);
  assert.deepEqual(events.filter((event) => event.type === 'task-end' || event.type === 'turn-end'), [
    { type: 'task-end', agent: 'cursor', taskId: 'call-task-1', status: 'stopped' },
    // 보류해 둔 result 의 stopReason/errorMessage 가 살아 있어야 스테이징 편집이 규칙대로 되돌아간다.
    { type: 'turn-end', agent: 'cursor', stopReason: 'error_max_turns', errorMessage: '한도를 넘겼습니다.' },
  ]);
});

test('a card closed by the exit sweep is not closed again by a late line', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { events, proc } = startSession(t);
  proc.emitJson(INIT_LINE, taskStarted('call-task-1'));
  // 자손이 파이프를 붙들어 'close' 없이 'exit' 만 온 경우 — 1.5s 뒤 카드를 쓸어 담는다.
  proc.exitCode = 0;
  proc.emit('exit', 0, null);
  t.mock.timers.tick(1_500);
  assert.deepEqual(events.filter((event) => event.type === 'task-end'), [
    { type: 'task-end', agent: 'cursor', taskId: 'call-task-1', status: 'stopped' },
  ]);

  // 아직 열린 stdout 이 뒤늦게 흘린 완료 — 이미 닫힌 카드를 다시 닫지 않는다.
  proc.emitJson(taskCompleted('call-task-1', taskSuccess({ resultSuffix: '끝냈습니다' })));
  assert.equal(events.filter((event) => event.type === 'task-end').length, 1);

  // Complete the fake stream lifecycle so test teardown does not wait on an
  // intentionally missing `close` after the assertion has already exercised it.
  proc.emit('close', 0, null);
});

test('even proved tree cleanup cannot reuse an exit-only Cursor turn without close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, proc, spawns } = startSession(t, {}, PROVEN_TREE_CLEANUP);
  proc.emitJson(INIT_LINE, taskStarted('call-task-1'));
  // `exit` alone does not end the current turn. Even with positive cleanup
  // proof, a second request must wait for the bounded close grace to settle.
  proc.emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => session.sendUserMessage('그럼 다시 해줘'),
    /already has a turn in progress/,
  );
  assert.equal(spawns.length, 1, '이전 턴의 close 유예 전에는 다음 턴을 스폰하지 않는다');

  t.mock.timers.tick(2_000);
  session.sendUserMessage('그럼 다시 해줘');

  assert.equal(spawns.length, 1, 'stdio close 없는 이전 턴 뒤에는 새 프로세스를 띄우지 않는다');
  assert.match(events.findLast((event) => event.type === 'error').message, /cleanup could not be confirmed/);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'cursor', stopReason: 'failed' });

  // 뒤늦게 도착한 예약 정리가 카드를 두 번 닫지 않는다.
  t.mock.timers.tick(5_000);
  assert.equal(events.filter((event) => event.type === 'task-end').length, 1);
  assert.equal(await session.dispose(), false);
});

test('turns without tasks settle on the drained close after the result line', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { events, proc } = startSession(t);
  proc.emitJson(INIT_LINE, RESULT);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 0);
  proc.exit(0);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
});

test('a process that dies with an open task sweeps it before turn-end', (t) => {
  const { events, proc } = startSession(t);
  proc.emitJson(INIT_LINE, taskStarted('call-task-1'));
  proc.exit(1);

  const tail = events.filter((event) => event.type === 'task-end' || event.type === 'turn-end');
  assert.deepEqual(tail, [
    { type: 'task-end', agent: 'cursor', taskId: 'call-task-1', status: 'stopped' },
    { type: 'turn-end', agent: 'cursor', stopReason: 'exited' },
  ]);
});

test('an errored result keeps its error message through the settle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { events, proc } = startSession(t);
  proc.emitJson(
    taskStarted('call-task-1'),
    taskCompleted('call-task-1', taskSuccess({ resultSuffix: '끝냈습니다' })),
    { ...RESULT, is_error: true, result: 'boom' },
  );
  proc.exit(0);
  const turnEnds = events.filter((event) => event.type === 'turn-end');
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].errorMessage, 'boom', '스테이징 편집 롤백 판정이 살아 있어야 한다');
});

test('interrupt closes open cards once and cancels the settle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, events, proc } = startSession(t);
  proc.emitJson(taskStarted('call-task-1'), RESULT);
  session.interrupt();

  assert.deepEqual(
    events.filter((event) => event.type === 'task-end' || event.type === 'turn-end'),
    [
      { type: 'task-end', agent: 'cursor', taskId: 'call-task-1', status: 'stopped' },
      { type: 'turn-end', agent: 'cursor', stopReason: 'interrupted' },
    ],
  );
  t.mock.timers.tick(5_000);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
});

test('a long transcript is replayed up to the step cap', (t) => {
  const { events, proc } = startSession(t);
  const conversationSteps = Array.from({ length: 60 }, (_, i) => ({
    assistantMessage: { text: `step-${i}` },
  }));
  proc.emitJson(
    taskStarted('call-task-1'),
    taskCompleted('call-task-1', taskSuccess({ conversationSteps, agentId: 'agent-uuid-1' })),
  );
  const childTexts = events.filter((event) => event.type === 'text-delta' && event.parentTaskId);
  assert.equal(childTexts.length, 50);
  assert.equal(childTexts.at(-1).text, '\n\nstep-49');
  // 잘린 전사여도 카드는 정상적으로 닫힌다.
  assert.equal(events.find((event) => event.type === 'task-end').status, 'completed');
});

test('a nested task spawned by a child stays a child tool row with a trimmed prompt', (t) => {
  const { events, proc } = startSession(t);
  proc.emitJson(
    taskStarted('call-task-1'),
    taskCompleted('call-task-1', taskSuccess({
      conversationSteps: [{
        toolCall: {
          taskToolCall: { args: taskArgs({ description: '손자', prompt: 'x'.repeat(1_000) }) },
        },
      }],
      agentId: 'agent-uuid-1',
    })),
  );
  const calls = events.filter((event) => event.type === 'tool-call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'task');
  assert.equal(calls[0].parentTaskId, 'call-task-1');
  assert.equal(calls[0].callId, 'call-task-1:step-0', 'toolCallId 가 없으면 카드 안에서 유일한 id 를 만든다');
  const args = JSON.parse(calls[0].argsJson);
  assert.equal(args.description, '손자');
  assert.ok(args.prompt.length < 500, '프롬프트 전문을 사이드바에 싣지 않는다');
  assert.equal(events.filter((event) => event.type === 'task-start').length, 1, '중첩 카드는 만들지 않는다');
});
