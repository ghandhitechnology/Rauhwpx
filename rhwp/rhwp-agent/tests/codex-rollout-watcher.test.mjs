// codex 롤아웃 워처 검증. 픽스처는 실제 라이브 프로브 캡처
// (/tmp/rhwp-probe3/codex/rollouts/*.jsonl, codex-cli 0.147.0)를 줄 단위로 추려
// 암호화 블롭과 초장문 지시문만 자리표시자로 바꾼 것이다:
//   tests/fixtures/codex-rollout/{parent,child-math_a,child-shell}.jsonl
// child-forked-resume.jsonl 만 합성이다 — resume 으로 이어 온 부모(턴 2개)가 자식에
// 포크된 모양이며, 그 구조는 위 캡처와 동일하다.
// 시계와 스케줄러는 주입하고 파일시스템은 실제 tmp 디렉터리를 써서 바이트 오프셋
// 증분 읽기와 부분 줄 처리를 그대로 검증한다.
//
// 중요한 전제: 자식 롤아웃 파일은 watcher.start() 이후에 생긴다 (start 는
// thread.started 시점, 즉 모델이 첫 토큰을 내기도 전이다). start 시점에 이미 있던
// 파일은 지난 턴 몫이므로 워처가 열지 않는다 — 테스트도 그 순서를 지킨다.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCodexRolloutWatcher } from '../agents/codex-rollout-watcher.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-rollout');

const ROOT_THREAD = '01a01a8f-836f-7a71-8101-bc1d4f0aba01';
const MATH_THREAD = '01a01a8f-9e92-7873-b389-cfcce5ecedb8';
const HAIKU_THREAD = '01a01a8f-a64d-7b71-aac2-ff9c4de12bcf';
/** child-shell.jsonl 은 다른 세션(runC)에서 왔다 — 남의 롤아웃 판정에 그대로 쓴다. */
const SHELL_ROOT_THREAD = '01a01a99-ae53-7a00-a920-0d7d1c2a7341';
const SHELL_THREAD = '01a01a99-c0f6-7a60-afc2-fc9059494a32';
/** child-forked-resume.jsonl 의 자식 스레드 (부모는 ROOT_THREAD). */
const RESUME_CHILD_THREAD = '01a01a8f-b1f4-7d20-91aa-2c0a9f13ee01';

function fixtureLines(name) {
  return readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8').trimEnd().split('\n');
}

/** 픽스처 로그의 날짜와 무관하게, 테스트가 정한 '오늘' 디렉터리에 파일을 놓는다. */
function makeHarness({ date = new Date('2026-08-19T12:00:00') } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-rollout-'));
  const events = [];
  let clock = date;
  const intervals = [];
  const watcher = createCodexRolloutWatcher({
    codexHome: home,
    emit: (evt) => events.push(evt),
    now: () => clock,
    scheduler: {
      setInterval: (fn, ms) => {
        const handle = { fn, ms, cleared: false, unref() { return handle; } };
        intervals.push(handle);
        return handle;
      },
      clearInterval: (handle) => { if (handle) handle.cleared = true; },
    },
  });
  const dayDir = (when = clock) => path.join(
    home, 'sessions', String(when.getFullYear()),
    String(when.getMonth() + 1).padStart(2, '0'), String(when.getDate()).padStart(2, '0'),
  );
  return {
    home,
    events,
    watcher,
    intervals,
    dayDir,
    setClock(next) { clock = next; },
    /** 롤아웃 파일을 만들거나 이어 쓴다. lines 는 JSONL 줄 배열. */
    write(threadId, lines, { append = false, when = clock, partial = false } = {}) {
      const dir = dayDir(when);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-2026-08-19T12-00-00-${threadId}.jsonl`);
      const body = lines.join('\n') + (partial ? '' : '\n');
      if (append) appendFileSync(file, body);
      else writeFileSync(file, body);
      return file;
    },
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

function ofType(events, type) {
  return events.filter((e) => e.type === type);
}

test('부모+자식 롤아웃에서 자식 카드 전체 수명주기를 만든다', () => {
  const h = makeHarness();
  try {
    const parent = fixtureLines('parent');
    // 실제 순서: thread.started 시점의 부모 파일에는 머리말만 있고, 그 뒤에 부모가
    // spawn 하고(→ sub_agent_activity) 자식 롤아웃이 생기며, 마지막에 부모가
    // 자식들의 FINAL_ANSWER 를 받는다.
    // 프로브 타임스탬프상 자식 롤아웃 파일은 부모의 sub_agent_activity 보다 먼저
    // 생기므로(15:06:55.248 vs .266) 보통 같은 폴링에서 함께 읽힌다.
    h.write(ROOT_THREAD, parent.slice(0, 2));
    h.watcher.start(ROOT_THREAD);
    h.write(ROOT_THREAD, parent.slice(2, 10), { append: true });
    h.write(MATH_THREAD, fixtureLines('child-math_a'));
    h.watcher.pollOnce();
    h.write(ROOT_THREAD, parent.slice(10), { append: true });
    h.watcher.pollOnce();

    const starts = ofType(h.events, 'task-start');
    // 부모 롤아웃의 sub_agent_activity 는 두 자식을 알리지만 자식 롤아웃은 math_a 것만 있다.
    assert.deepEqual(starts.map((e) => e.taskId).sort(), [HAIKU_THREAD, MATH_THREAD].sort());
    const math = starts.find((e) => e.taskId === MATH_THREAD);
    assert.deepEqual(math, {
      type: 'task-start', agent: 'codex', taskId: MATH_THREAD,
      title: 'math_a', role: 'Halley', taskKind: 'agent',
    });
    const haiku = starts.find((e) => e.taskId === HAIKU_THREAD);
    assert.equal(haiku.title, 'haiku_b');
    assert.equal(haiku.role, undefined);

    const text = ofType(h.events, 'text-delta');
    assert.deepEqual(text, [{ type: 'text-delta', agent: 'codex', text: '391', parentTaskId: MATH_THREAD }]);

    const ends = ofType(h.events, 'task-end');
    const mathEnd = ends.find((e) => e.taskId === MATH_THREAD);
    assert.equal(mathEnd.status, 'completed');
    assert.equal(mathEnd.summary, '391');
    assert.equal(mathEnd.usage.totalTokens, 18322);
    // haiku_b 는 자기 롤아웃이 없지만 부모의 FINAL_ANSWER 로 닫힌다.
    const haikuEnd = ends.find((e) => e.taskId === HAIKU_THREAD);
    assert.equal(haikuEnd.status, 'completed');
    assert.match(haikuEnd.summary, /Waves whisper at dawn/);

    // 카드는 항상 자기 이벤트보다 먼저 나간다.
    const startIdx = h.events.findIndex((e) => e.type === 'task-start' && e.taskId === MATH_THREAD);
    const textIdx = h.events.findIndex((e) => e.type === 'text-delta');
    assert.ok(startIdx < textIdx);
    assert.deepEqual(h.watcher.debugState().openTasks, []);
  } finally {
    h.cleanup();
  }
});

test('포크된 부모 히스토리는 자식 활동으로 재생하지 않는다', () => {
  const h = makeHarness();
  try {
    h.watcher.start(ROOT_THREAD);
    h.write(MATH_THREAD, fixtureLines('child-math_a'));
    h.watcher.pollOnce();
    const texts = ofType(h.events, 'text-delta').map((e) => e.text);
    // 자식 롤아웃 앞부분에는 부모의 발화("spawn_agent, followup_task, …")가 통째로 복사돼 있다.
    assert.deepEqual(texts, ['391']);
  } finally {
    h.cleanup();
  }
});

test('resume 으로 이어 온 부모의 포크 히스토리(task_started 여러 개)도 재생하지 않는다', () => {
  const h = makeHarness();
  try {
    h.watcher.start(ROOT_THREAD);
    // 부모가 exec resume 으로 두 턴째를 돌면 자식에는 task_started 가 2개 이상
    // 포크된다 — 개수로 경계를 잡으면 부모의 지난 턴이 자식 활동으로 새어 나온다.
    h.write(RESUME_CHILD_THREAD, fixtureLines('child-forked-resume'));
    h.watcher.pollOnce();

    assert.deepEqual(ofType(h.events, 'task-start').map((e) => e.title), ['resume_child']);
    assert.deepEqual(ofType(h.events, 'text-delta').map((e) => e.text), ['2쪽을 끝냈습니다.']);
    const calls = ofType(h.events, 'tool-call');
    assert.equal(calls.length, 1);
    assert.match(JSON.parse(calls[0].argsJson).input, /child-own-work/);
    const end = ofType(h.events, 'task-end')[0];
    assert.equal(end.status, 'completed');
    assert.equal(end.usage.totalTokens, 9200);
    assert.equal(end.usage.toolUses, 1);
  } finally {
    h.cleanup();
  }
});

/** child-shell 자식(runC)을 스폰하고 끝까지 지켜본 부모 롤아웃 줄들. */
function shellParentLines() {
  const spawnCall = 'call_ShellChildSpawn';
  return {
    head: [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: SHELL_ROOT_THREAD, id: SHELL_ROOT_THREAD, cwd: '/tmp/ws',
          originator: 'codex_exec', cli_version: '0.147.0', source: 'exec', thread_source: 'user',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call', id: 'fc_shell', name: 'spawn_agent', namespace: 'collaboration',
          arguments: JSON.stringify({ fork_turns: 'all', message: 'gAAAA<trimmed>', task_name: 'shell_child' }),
          call_id: spawnCall,
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity', event_id: spawnCall, agent_thread_id: SHELL_THREAD,
          agent_path: '/root/shell_child', kind: 'started',
        },
      }),
    ],
    final: [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'agent_message', id: 'amsg_final_shell', author: '/root/shell_child', recipient: '/root',
          content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/shell_child\nPayload:\nhello-from-child' }],
        },
      }),
    ],
  };
}

/** 자식 카드가 활동·사용량을 다 싣고 닫혔는지 본다(순서와 무관하게 같아야 한다). */
function assertShellChildComplete(events) {
  const start = ofType(events, 'task-start')[0];
  assert.equal(start.taskId, SHELL_THREAD);
  const call = ofType(events, 'tool-call')[0];
  assert.match(JSON.parse(call.argsJson).input, /echo hello-from-child/);
  assert.equal(call.parentTaskId, SHELL_THREAD);
  assert.deepEqual(ofType(events, 'text-delta').map((e) => e.text), ['hello-from-child']);
  const end = ofType(events, 'task-end')[0];
  assert.equal(end.status, 'completed');
  assert.deepEqual(end.usage, { totalTokens: 37014, toolUses: 1 });
  // 카드 종료는 반드시 그 카드의 마지막 활동 뒤에 온다.
  const endIdx = events.findIndex((e) => e.type === 'task-end');
  assert.ok(events.findIndex((e) => e.type === 'tool-result') < endIdx);
  assert.ok(events.findIndex((e) => e.type === 'text-delta') < endIdx);
}

test('부모의 종료 신호가 먼저 읽혀도 자식 롤아웃을 먼저 비우고 카드를 닫는다', () => {
  const h = makeHarness();
  try {
    const parent = shellParentLines();
    h.write(SHELL_ROOT_THREAD, parent.head.slice(0, 1));
    h.watcher.start(SHELL_ROOT_THREAD);
    // 한 폴링 안에서 부모 파일이 자식 파일보다 먼저 읽힌다(이름 정렬). 부모의
    // FINAL_ANSWER 까지 한 번에 도착한 상황 — 예전에는 자식 롤아웃을 읽기도 전에
    // 카드가 닫혀 자식의 텍스트·도구·토큰이 통째로 버려졌다.
    h.write(SHELL_ROOT_THREAD, [...parent.head.slice(1), ...parent.final], { append: true });
    h.write(SHELL_THREAD, fixtureLines('child-shell'));
    h.watcher.pollOnce();

    assertShellChildComplete(h.events);
    assert.deepEqual(h.watcher.debugState().openTasks, []);
  } finally {
    h.cleanup();
  }
});

test('자식 롤아웃이 먼저 읽힌 순서에서도 같은 카드 결과가 나온다', () => {
  const h = makeHarness();
  try {
    const parent = shellParentLines();
    h.write(SHELL_ROOT_THREAD, parent.head.slice(0, 1));
    h.watcher.start(SHELL_ROOT_THREAD);
    h.write(SHELL_ROOT_THREAD, parent.head.slice(1), { append: true });
    h.write(SHELL_THREAD, fixtureLines('child-shell'));
    h.watcher.pollOnce();
    // 자식이 자기 task_complete 로 이미 닫혔다 — 뒤늦은 부모 FINAL_ANSWER 는
    // 카드를 두 번 닫지 않는다.
    h.write(SHELL_ROOT_THREAD, parent.final, { append: true });
    h.watcher.pollOnce();

    assertShellChildComplete(h.events);
    assert.equal(ofType(h.events, 'task-end').length, 1);
  } finally {
    h.cleanup();
  }
});

test('finalize 도 남은 자식 롤아웃을 먼저 비운 뒤 카드를 닫는다', () => {
  const h = makeHarness();
  try {
    const parent = shellParentLines();
    h.write(SHELL_ROOT_THREAD, parent.head.slice(0, 1));
    h.watcher.start(SHELL_ROOT_THREAD);
    // 종료 직전에 부모의 FINAL_ANSWER 와 자식 롤아웃이 한꺼번에 도착했다 —
    // 폴링 없이 곧장 finalize 로 들어가는 경로다.
    h.write(SHELL_ROOT_THREAD, [...parent.head.slice(1), ...parent.final], { append: true });
    const child = fixtureLines('child-shell');
    h.write(SHELL_THREAD, child.slice(0, child.length - 1));
    h.watcher.finalize();

    assertShellChildComplete(h.events);
    assert.equal(ofType(h.events, 'task-end').length, 1);
  } finally {
    h.cleanup();
  }
});

test('파일이 잘려 처음부터 다시 읽을 때 남아 있던 부분 줄을 버린다', () => {
  const h = makeHarness();
  try {
    h.watcher.start(SHELL_ROOT_THREAD);
    const child = fixtureLines('child-shell');
    // 첫 줄이 개행 없이 길게 반만 쓰인 상태 — 아직 아무것도 판정되지 않는다.
    const half = `{"type":"response_item","payload":{"type":"custom_tool_call","input":"${'A'.repeat(20_000)}`;
    const file = h.write(SHELL_THREAD, [half], { partial: true });
    h.watcher.pollOnce();
    assert.deepEqual(h.events, []);

    // 파일이 더 짧은 내용으로 교체됐다 — 오프셋은 0으로 돌아간다. 남아 있던 부분
    // 줄을 그대로 이어 붙이면 첫 줄(session_meta)이 깨져 자식 판정 자체가 사라진다.
    truncateSync(file, 0);
    writeFileSync(file, child.join('\n') + '\n');
    h.watcher.pollOnce();

    assert.deepEqual(ofType(h.events, 'task-start').map((e) => e.taskId), [SHELL_THREAD]);
    assert.deepEqual(ofType(h.events, 'text-delta').map((e) => e.text), ['hello-from-child']);
    assert.equal(ofType(h.events, 'task-end')[0].status, 'completed');
  } finally {
    h.cleanup();
  }
});

test('자식 도구 호출/결과는 parentTaskId 로 귀속되고 exec 입력은 미리보기로 나간다', () => {
  const h = makeHarness();
  try {
    h.watcher.start(SHELL_ROOT_THREAD);
    h.write(SHELL_THREAD, fixtureLines('child-shell'));
    h.watcher.pollOnce();

    const call = ofType(h.events, 'tool-call')[0];
    assert.equal(call.tool, 'exec');
    assert.equal(call.parentTaskId, SHELL_THREAD);
    assert.match(JSON.parse(call.argsJson).input, /echo hello-from-child/);
    const result = ofType(h.events, 'tool-result')[0];
    assert.equal(result.callId, call.callId);
    assert.equal(result.ok, true);
    assert.match(result.resultPreview, /hello-from-child/);
    assert.equal(result.parentTaskId, SHELL_THREAD);

    const end = ofType(h.events, 'task-end')[0];
    assert.equal(end.status, 'completed');
    assert.equal(end.summary, 'hello-from-child');
    assert.equal(end.usage.toolUses, 1);
    assert.equal(end.usage.totalTokens, 37014);
  } finally {
    h.cleanup();
  }
});

test('증분 읽기: 폴링 사이에 덧붙은 줄만 처리하고 잘린 줄은 다음 폴링까지 기다린다', () => {
  const h = makeHarness();
  try {
    const parent = fixtureLines('parent');
    const child = fixtureLines('child-math_a');
    h.write(ROOT_THREAD, parent.slice(0, 4));
    h.watcher.start(ROOT_THREAD);
    assert.equal(ofType(h.events, 'task-start').length, 0);

    // spawn function_call + sub_agent_activity 가 도착하면 카드가 생긴다.
    h.write(ROOT_THREAD, parent.slice(4, 7), { append: true });
    h.watcher.pollOnce();
    assert.deepEqual(ofType(h.events, 'task-start').map((e) => e.title), ['math_a']);

    // 자식 롤아웃의 마지막 줄을 개행 없이 반쯤 쓴다 — 아직 처리되면 안 된다.
    h.write(MATH_THREAD, child.slice(0, child.length - 1));
    const half = child[child.length - 1].slice(0, 40);
    h.write(MATH_THREAD, [half], { append: true, partial: true });
    h.watcher.pollOnce();
    assert.equal(ofType(h.events, 'task-end').length, 0);

    h.write(MATH_THREAD, [child[child.length - 1].slice(40)], { append: true });
    h.watcher.pollOnce();
    const end = ofType(h.events, 'task-end')[0];
    assert.equal(end.taskId, MATH_THREAD);
    assert.equal(end.status, 'completed');
  } finally {
    h.cleanup();
  }
});

test('다른 세션의 롤아웃은 무시한다', () => {
  const h = makeHarness();
  try {
    // child-shell 은 다른 세션(runC)의 자식 롤아웃이다 — session_id 도 부모 스레드도
    // 우리 것이 아니므로 판정 즉시 버려진다(파일명은 무관, 내용으로 판정한다).
    h.watcher.start(ROOT_THREAD);
    h.write(SHELL_THREAD, fixtureLines('child-shell'));
    h.watcher.pollOnce();
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.watcher.debugState().trackedFiles, []);
  } finally {
    h.cleanup();
  }
});

test('자정을 넘어가면 다음 날 디렉터리에서 새 롤아웃을 찾는다', () => {
  const beforeMidnight = new Date('2026-08-19T23:59:30');
  const h = makeHarness({ date: beforeMidnight });
  try {
    h.write(ROOT_THREAD, fixtureLines('parent').slice(0, 1));
    h.watcher.start(ROOT_THREAD);

    const afterMidnight = new Date('2026-08-20T00:00:30');
    h.setClock(afterMidnight);
    h.write(MATH_THREAD, fixtureLines('child-math_a'), { when: afterMidnight });
    h.watcher.pollOnce();
    assert.deepEqual(ofType(h.events, 'task-start').map((e) => e.taskId), [MATH_THREAD]);

    // 어제 디렉터리도 계속 본다 — 부모 롤아웃은 자정 전 디렉터리에 남아 있다.
    h.write(ROOT_THREAD, fixtureLines('parent').slice(1), { append: true, when: beforeMidnight });
    h.watcher.pollOnce();
    assert.ok(ofType(h.events, 'task-start').some((e) => e.taskId === HAIKU_THREAD));
  } finally {
    h.cleanup();
  }
});

test('finalize 는 마지막으로 한 번 더 읽고 남은 카드를 stopped 로 닫는다', () => {
  const h = makeHarness();
  try {
    const child = fixtureLines('child-math_a');
    h.write(ROOT_THREAD, fixtureLines('parent').slice(0, 2));
    h.watcher.start(ROOT_THREAD);
    h.write(ROOT_THREAD, fixtureLines('parent').slice(2, 7), { append: true });
    // 자식은 도중에 죽었다: task_complete 없이 끊긴 롤아웃.
    h.write(MATH_THREAD, child.slice(0, child.length - 4));
    h.watcher.pollOnce();
    assert.equal(ofType(h.events, 'task-end').length, 0);

    // finalize 직전에 도착한 줄도 반영돼야 한다.
    h.write(MATH_THREAD, [child[child.length - 4]], { append: true });
    h.watcher.finalize();

    const texts = ofType(h.events, 'text-delta').map((e) => e.text);
    assert.deepEqual(texts, ['391']);
    const ends = ofType(h.events, 'task-end');
    assert.equal(ends.length, 1);
    assert.deepEqual({ taskId: ends[0].taskId, status: ends[0].status }, { taskId: MATH_THREAD, status: 'stopped' });
    assert.ok(h.intervals.every((i) => i.cleared));
  } finally {
    h.cleanup();
  }
});

test('depth 2 자식은 최상위 자식 카드에 귀속된다', () => {
  const h = makeHarness();
  try {
    const child = fixtureLines('child-math_a');
    h.write(ROOT_THREAD, fixtureLines('parent').slice(0, 2));
    h.watcher.start(ROOT_THREAD);
    h.write(ROOT_THREAD, fixtureLines('parent').slice(2, 7), { append: true });
    h.write(MATH_THREAD, child);
    // 프로브에 depth 2 캡처는 없다 — math_a 자식 롤아웃의 session_meta 만 고쳐
    // /root/math_a/deep 손자를 만든다 (thread_spawn 스키마는 그대로).
    const meta = JSON.parse(child[0]);
    const grandThread = '01a01a8f-dead-7000-0000-000000000001';
    meta.payload.id = grandThread;
    meta.payload.source.subagent.thread_spawn = {
      parent_thread_id: MATH_THREAD, depth: 2, agent_path: '/root/math_a/deep', agent_nickname: 'Kepler', agent_role: null,
    };
    meta.payload.agent_path = '/root/math_a/deep';
    h.write(grandThread, [JSON.stringify(meta), ...child.slice(1)]);
    h.watcher.pollOnce();

    // 손자 전용 카드는 만들지 않는다.
    assert.equal(ofType(h.events, 'task-start').some((e) => e.taskId === grandThread), false);
    assert.ok(ofType(h.events, 'text-delta').every((e) => e.parentTaskId === MATH_THREAD));
  } finally {
    h.cleanup();
  }
});

test('start 이전에 있던 롤아웃은 지난 턴 몫이다', () => {
  const h = makeHarness();
  try {
    // 지난 턴이 남긴 자식 롤아웃 — 이번 턴 워처는 열지도 않는다.
    h.write(MATH_THREAD, fixtureLines('child-math_a'));
    h.watcher.start(ROOT_THREAD);
    h.watcher.pollOnce();
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.watcher.debugState().trackedFiles, []);
  } finally {
    h.cleanup();
  }
});

test('exec resume: 같은 부모 롤아웃에 이어 써도 지난 턴 자식이 유령 카드로 살아나지 않는다', () => {
  const h = makeHarness();
  try {
    // 턴 1: 부모 롤아웃 전체(자식 둘 스폰 + FINAL_ANSWER 둘)와 그 자식 롤아웃이
    // 이미 디스크에 있다. `exec resume` 은 이 부모 파일에 그대로 이어 쓴다.
    const parent = fixtureLines('parent');
    h.write(ROOT_THREAD, parent);
    h.write(MATH_THREAD, fixtureLines('child-math_a'));

    // 턴 2 시작 — 워처는 새로 만들어지고 같은 루트 스레드를 받는다.
    h.watcher.start(ROOT_THREAD);
    h.watcher.pollOnce();
    assert.deepEqual(h.events, [], '지난 턴 히스토리는 한 줄도 재생하지 않는다');

    // 턴 2 의 새 자식: 부모 파일에 spawn + sub_agent_activity 가 이어 붙고
    // 새 자식 롤아웃 파일이 생긴다.
    const newChild = '01a01a90-1111-7a00-8000-00000000abcd';
    const spawnCall = 'call_TurnTwoSpawn';
    h.write(ROOT_THREAD, [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call', id: 'fc_turn2', name: 'spawn_agent', namespace: 'collaboration',
          arguments: JSON.stringify({ fork_turns: 'all', message: 'gAAAA<trimmed>', task_name: 'turn2_child' }),
          call_id: spawnCall,
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity', event_id: spawnCall, agent_thread_id: newChild,
          agent_path: '/root/turn2_child', kind: 'started',
        },
      }),
    ], { append: true });
    const childLines = fixtureLines('child-math_a');
    const meta = JSON.parse(childLines[0]);
    meta.payload.id = newChild;
    meta.payload.agent_path = '/root/turn2_child';
    meta.payload.source.subagent.thread_spawn = {
      parent_thread_id: ROOT_THREAD, depth: 1, agent_path: '/root/turn2_child',
      agent_nickname: 'Turing', agent_role: null,
    };
    h.write(newChild, [JSON.stringify(meta), ...childLines.slice(1)]);
    h.watcher.pollOnce();

    assert.deepEqual(ofType(h.events, 'task-start').map((e) => e.taskId), [newChild]);
    assert.deepEqual(ofType(h.events, 'task-end').map((e) => e.taskId), [newChild]);
    assert.deepEqual(h.watcher.debugState().openTasks, []);
  } finally {
    h.cleanup();
  }
});

test('주입된 간이 fs(readFileSync 폴백)로도 동작한다', () => {
  const events = [];
  const home = '/fake-codex-home';
  const dir = path.join(home, 'sessions', '2026', '08', '19');
  const store = new Map();
  const fakeFs = {
    readdirSync(target) {
      if (target !== dir) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...store.keys()].map((key) => path.basename(key));
    },
    statSync(target) {
      const value = store.get(target);
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: Buffer.byteLength(value), mtimeMs: Date.now() };
    },
    readFileSync(target) {
      return Buffer.from(store.get(target) ?? '');
    },
  };
  const watcher = createCodexRolloutWatcher({
    codexHome: home,
    emit: (evt) => events.push(evt),
    fs: fakeFs,
    now: () => new Date('2026-08-19T12:00:00'),
    scheduler: { setInterval: () => ({ unref() {} }), clearInterval() {} },
  });
  watcher.start(ROOT_THREAD);
  store.set(
    path.join(dir, `rollout-2026-08-19T12-00-00-${MATH_THREAD}.jsonl`),
    fixtureLines('child-math_a').join('\n') + '\n',
  );
  watcher.pollOnce();
  watcher.stop();
  assert.deepEqual(ofType(events, 'task-start').map((e) => e.taskId), [MATH_THREAD]);
  assert.deepEqual(ofType(events, 'text-delta').map((e) => e.text), ['391']);
});
