/**
 * 가짜 codex CLI — 서브에이전트 fleet 시나리오 재생기 (provider fleet e2e 전용).
 *
 * codex 0.147.0 의 실측 두 갈래를 그대로 흉내 낸다:
 *  1. stdout(`exec --json`): thread.started / turn.started / item.* / turn.completed 만.
 *     자식 에이전트 활동은 단 한 줄도 오지 않고, collab_tool_call 은 wait 호출에만
 *     나오며 receiver_thread_ids·agents_states 는 언제나 비어 있다
 *     (캡처: /tmp/rhwp-probe3/codex/runA2.ndjson).
 *  2. $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl: 부모·자식 롤아웃을 턴 도중
 *     증분으로 append 한다. fleet 카드의 유일한 소스이며, codex-rollout-watcher 가
 *     이 파일들을 폴링한다 (캡처: /tmp/rhwp-probe3/codex/rollouts/*.jsonl).
 *
 * 허브가 PATH 에서 `codex` 로 스폰하고 CODEX_HOME 을 환경으로 준다. 프로세스 종료가
 * 곧 턴 종료다 (자식은 부모 프로세스 안에서 돌기 때문에 exit 로 전부 죽는다).
 *
 * 절대 지켜야 할 것: 이 가짜는 사용자의 진짜 ~/.codex 를 건드리지 않는다.
 * 허브는 기동 때마다 `codex --version` 으로 설치 여부를 프로브하고, 그때 stdin 은
 * /dev/null 이라 곧바로 EOF 가 온다. 예전 판은 그 EOF 만으로 시나리오를 시작했고
 * CODEX_HOME 이 없으면 홈 디렉터리로 떨어져 진짜 세션 저장소에 가짜 롤아웃을 쌓았다.
 * 그래서 (1) --version 은 버전 한 줄만 찍고 끝내고, (2) 진짜 exec 호출에 stdin
 * 프롬프트가 실제로 들어왔을 때만 시나리오를 돌리고, (3) CODEX_HOME 이 없으면
 * os.tmpdir() 아래 임시 디렉터리를 새로 판다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const argv = process.argv.slice(2);

if (argv.includes('--version') || argv.includes('-V')) {
  // 허브의 provider-health 프로브가 첫 줄을 버전으로 읽는다.
  process.stdout.write('codex-cli 0.147.0-fake\n');
  process.exit(0);
}
if (argv[0] !== 'exec') {
  process.stderr.write(`fake-codex-fleet: exec 호출이 아니라 아무것도 하지 않는다 (${argv.join(' ') || '<no args>'})\n`);
  process.exit(0);
}

// 캡처의 실제 스레드 id 를 그대로 쓴다 — 형식(UUIDv7 계열)까지 실측과 같다.
const ROOT_THREAD = '01a01a8f-836f-7a71-8101-bc1d4f0aba01';
const CHILD_A = '01a01a8f-9e92-7873-b389-cfcce5ecedb8';
const CHILD_B = '01a01a8f-a64d-7b71-aac2-ff9c4de12bcf';
const SPAWN_CALL_A = 'call_VKzyVYF4fHPtIxTLXhtp2dMg';
const SPAWN_CALL_B = 'call_A5JYorpBf4qWtxAsAnDcJg4M';
const TURN_ID = '01a01a8f-8494-7192-b30a-78ceb9e62af1';

// CODEX_HOME 이 없으면 홈이 아니라 새 임시 디렉터리로 떨어진다 — 진짜 세션 저장소
// 오염 방지. 허브는 항상 격리된 CODEX_HOME 을 준다.
const codexHome = process.env.CODEX_HOME
  || fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-home-'));
const cwd = process.cwd();

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** sessions/YYYY/MM/DD — CLI 도 로컬 시각으로 디렉터리를 만든다. */
function sessionDir(date = new Date()) {
  return path.join(
    codexHome, 'sessions',
    String(date.getFullYear()), pad2(date.getMonth() + 1), pad2(date.getDate()),
  );
}

/** rollout-2026-08-20T01-40-44-<threadId>.jsonl — 이름의 타임스탬프가 정렬 순서다. */
function rolloutPath(threadId, offsetSeconds) {
  const stamp = new Date(Date.now() + offsetSeconds * 1000)
    .toISOString().replace(/\..*$/, '').replace(/:/g, '-');
  return path.join(sessionDir(), `rollout-${stamp}-${threadId}.jsonl`);
}

function append(file, ...lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = lines.map((line) => JSON.stringify({ timestamp: new Date().toISOString(), ...line })).join('\n') + '\n';
  fs.appendFileSync(file, text, 'utf8');
}

const eventMsg = (payload) => ({ type: 'event_msg', payload });
const responseItem = (payload) => ({ type: 'response_item', payload });

/** 자식 롤아웃의 첫 두 줄: 자기 session_meta + 포크된 부모 사본 (실측 구조). */
function childHeader(threadId, agentPath, nickname) {
  return [
    {
      type: 'session_meta',
      payload: {
        session_id: ROOT_THREAD,
        id: threadId,
        forked_from_id: ROOT_THREAD,
        parent_thread_id: ROOT_THREAD,
        timestamp: new Date().toISOString(),
        cwd,
        originator: 'codex_exec',
        cli_version: '0.147.0',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: ROOT_THREAD,
              depth: 1,
              agent_path: agentPath,
              agent_nickname: nickname,
              agent_role: null,
            },
          },
        },
        thread_source: 'subagent',
        agent_nickname: nickname,
        agent_path: agentPath,
        model_provider: 'openai',
        multi_agent_version: 'v2',
      },
    },
    {
      type: 'session_meta',
      payload: {
        session_id: ROOT_THREAD,
        id: ROOT_THREAD,
        timestamp: new Date().toISOString(),
        cwd,
        originator: 'codex_exec',
        cli_version: '0.147.0',
        source: 'exec',
        thread_source: 'user',
        model_provider: 'openai',
      },
    },
    eventMsg({ type: 'task_started', turn_id: TURN_ID, started_at: 1, model_context_window: 258400 }),
    // thread_settings_applied = 포크된 부모 히스토리의 끝. 워처는 이 뒤부터만 그린다.
    eventMsg({ type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-sol', approval_policy: 'never' } }),
    eventMsg({ type: 'task_started', turn_id: `${threadId}-turn`, started_at: 2, model_context_window: 258400 }),
    responseItem({
      type: 'agent_message',
      id: `amsg_${threadId}`,
      author: '/root',
      recipient: agentPath,
      content: [
        { type: 'input_text', text: `Message Type: NEW_TASK\nTask name: ${agentPath}\nSender: /root\nPayload:\n` },
        // 실제 payload 는 암호화되어 있다 — 자리만 지킨다.
        { type: 'encrypted_content', encrypted_content: 'gAAAA<trimmed>' },
      ],
    }),
  ];
}

const tokenCount = (total) => eventMsg({
  type: 'token_count',
  info: {
    total_token_usage: {
      input_tokens: total - 40, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 40, reasoning_output_tokens: 12, total_tokens: total,
    },
  },
});

async function scenario() {
  const parentFile = rolloutPath(ROOT_THREAD, 0);
  const childAFile = rolloutPath(CHILD_A, 6);
  const childBFile = rolloutPath(CHILD_B, 8);

  append(parentFile, {
    type: 'session_meta',
    payload: {
      session_id: ROOT_THREAD,
      id: ROOT_THREAD,
      timestamp: new Date().toISOString(),
      cwd,
      originator: 'codex_exec',
      cli_version: '0.147.0',
      source: 'exec',
      thread_source: 'user',
      model_provider: 'openai',
    },
  }, eventMsg({ type: 'task_started', turn_id: TURN_ID, started_at: 1, model_context_window: 258400 }));

  emit({ type: 'thread.started', thread_id: ROOT_THREAD });
  emit({ type: 'turn.started' });
  await sleep(700); // 워처가 부모 롤아웃을 먼저 잡게 둔다.

  emit({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: '2쪽과 3쪽을 자식 에이전트 둘에게 나눠 맡기겠습니다.' },
  });
  append(parentFile, eventMsg({
    type: 'agent_message',
    message: '2쪽과 3쪽을 자식 에이전트 둘에게 나눠 맡기겠습니다.',
    phase: 'commentary',
  }));
  await sleep(300);

  // 스폰 ×2 — stdout 에는 아무것도 오지 않는다. 롤아웃만이 진실이다.
  // 실측 순서: 부모의 spawn function_call → 자식 롤아웃 생성 → 부모의
  // sub_agent_activity(started). 자식 파일이 먼저 있어야 카드가 처음 그려질 때
  // agent_nickname 까지 실린다.
  append(parentFile, responseItem({
    type: 'function_call',
    id: 'fc_spawn_a',
    name: 'spawn_agent',
    namespace: 'collaboration',
    // message 는 암호화 blob 이다 — task_name 만 의미가 있다.
    arguments: JSON.stringify({ fork_turns: 'all', message: 'gAAAA<trimmed>', task_name: 'page2_edit' }),
    call_id: SPAWN_CALL_A,
  }));
  append(childAFile, ...childHeader(CHILD_A, '/root/page2_edit', 'Halley'));
  append(parentFile,
    eventMsg({
      type: 'sub_agent_activity',
      event_id: SPAWN_CALL_A,
      occurred_at_ms: Date.now(),
      agent_thread_id: CHILD_A,
      agent_path: '/root/page2_edit',
      kind: 'started',
    }),
    responseItem({
      type: 'function_call_output',
      id: 'fco_spawn_a',
      call_id: SPAWN_CALL_A,
      output: JSON.stringify({ task_name: '/root/page2_edit' }),
    }),
  );
  await sleep(300);

  append(parentFile, responseItem({
    type: 'function_call',
    id: 'fc_spawn_b',
    name: 'spawn_agent',
    namespace: 'collaboration',
    arguments: JSON.stringify({ fork_turns: 'all', message: 'gAAAA<trimmed>', task_name: 'page3_edit' }),
    call_id: SPAWN_CALL_B,
  }));
  append(childBFile, ...childHeader(CHILD_B, '/root/page3_edit', 'Popper'));
  append(parentFile,
    eventMsg({
      type: 'sub_agent_activity',
      event_id: SPAWN_CALL_B,
      occurred_at_ms: Date.now(),
      agent_thread_id: CHILD_B,
      agent_path: '/root/page3_edit',
      kind: 'started',
    }),
    responseItem({
      type: 'function_call_output',
      id: 'fco_spawn_b',
      call_id: SPAWN_CALL_B,
      output: JSON.stringify({ task_name: '/root/page3_edit' }),
    }),
  );
  await sleep(800);

  // 자식 도구 호출 — 캡처에 실재하는 모양(custom_tool_call "exec")만 쓴다.
  append(childAFile,
    responseItem({
      type: 'custom_tool_call',
      id: 'ctc_a',
      status: 'completed',
      call_id: 'call_child_a_exec',
      name: 'exec',
      input: 'const r = await tools.exec_command({"cmd":"rhwp-page2-check","yield_time_ms":10000});',
    }),
    responseItem({
      type: 'custom_tool_call_output',
      id: 'ctco_a',
      call_id: 'call_child_a_exec',
      output: [{ type: 'input_text', text: 'Script completed\nOutput:\npage2-ok\n' }],
    }),
    tokenCount(18322),
  );
  append(childBFile,
    responseItem({
      type: 'custom_tool_call',
      id: 'ctc_b',
      status: 'completed',
      call_id: 'call_child_b_exec',
      name: 'exec',
      input: 'const r = await tools.exec_command({"cmd":"rhwp-page3-check","yield_time_ms":10000});',
    }),
    responseItem({
      type: 'custom_tool_call_output',
      id: 'ctco_b',
      call_id: 'call_child_b_exec',
      output: [{ type: 'input_text', text: 'Script completed\nOutput:\npage3-ok\n' }],
    }),
    tokenCount(17114),
  );
  await sleep(900);

  // wait 호출 — 루트의 평범한 도구 행 한 줄로만 그려져야 한다 (fleet 카드 아님).
  emit({
    type: 'item.started',
    item: {
      id: 'item_1', type: 'collab_tool_call', tool: 'wait',
      sender_thread_id: ROOT_THREAD, receiver_thread_ids: [], prompt: null,
      agents_states: {}, status: 'in_progress',
    },
  });

  // 여기서 한동안 붙든다 — 자식 둘이 아직 살아 있는 구간이다 (턴 유지 검증 지점).
  await sleep(2600);

  // 자식의 최종 답변 텍스트는 자기 롤아웃에 먼저 남고, 부모의 FINAL_ANSWER 합성
  // 메시지는 그 뒤에 도착한다 — 그 사이에 자식 본문이 카드에 붙는다.
  append(childAFile, eventMsg({ type: 'agent_message', message: '2쪽 표 정렬을 끝냈습니다.', phase: 'final_answer' }));
  await sleep(700);
  append(childAFile,
    eventMsg({ type: 'task_complete', turn_id: `${CHILD_A}-turn`, last_agent_message: '2쪽 표 정렬을 끝냈습니다.', duration_ms: 3280 }),
  );
  append(parentFile, responseItem({
    type: 'agent_message',
    id: 'amsg_final_a',
    author: '/root/page2_edit',
    recipient: '/root',
    content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/page2_edit\nPayload:\n2쪽 표 정렬을 끝냈습니다.' }],
  }));
  emit({
    type: 'item.completed',
    item: {
      id: 'item_1', type: 'collab_tool_call', tool: 'wait',
      sender_thread_id: ROOT_THREAD, receiver_thread_ids: [], prompt: null,
      agents_states: {}, status: 'completed',
    },
  });
  await sleep(700);

  append(childBFile, eventMsg({ type: 'agent_message', message: '3쪽 문단 서식을 맞췄습니다.', phase: 'final_answer' }));
  await sleep(700);
  append(childBFile,
    eventMsg({ type: 'task_complete', turn_id: `${CHILD_B}-turn`, last_agent_message: '3쪽 문단 서식을 맞췄습니다.', duration_ms: 4120 }),
  );
  append(parentFile, responseItem({
    type: 'agent_message',
    id: 'amsg_final_b',
    author: '/root/page3_edit',
    recipient: '/root',
    content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/page3_edit\nPayload:\n3쪽 문단 서식을 맞췄습니다.' }],
  }));
  await sleep(900);

  emit({
    type: 'item.completed',
    item: { id: 'item_2', type: 'agent_message', text: '두 자식 모두 끝났습니다. 2쪽과 3쪽이 정리되었습니다.' },
  });
  emit({
    type: 'turn.completed',
    usage: {
      input_tokens: 89755, cached_input_tokens: 79616, cache_write_input_tokens: 0,
      output_tokens: 316, reasoning_output_tokens: 75,
    },
  });
  await sleep(400);
  // 프로세스 종료 = 턴 종료. 워처의 finalize 가 turn-end 앞에서 마지막으로 훑는다.
  process.exit(0);
}

let started = false;
function begin() {
  if (started) return;
  started = true;
  scenario().catch((error) => {
    process.stderr.write(`fake-codex-fleet scenario error: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
// 프롬프트는 stdin('-')으로 온다 — 첫 조각이 오면 바로 시작한다. 한 바이트도
// 오지 않은 채 EOF 가 나면 프롬프트 없는 호출(설치 프로브 등)이므로 그냥 끝낸다.
let promptBytes = 0;
process.stdin.on('data', (chunk) => {
  promptBytes += chunk.length;
  begin();
});
process.stdin.on('end', () => {
  if (promptBytes > 0) begin();
  else process.exit(0);
});
process.stdin.resume();

// 허브가 SIGKILL 로 죽어 stdin EOF 가 안 오는 경우의 고아 방지.
const orphanWatch = setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 1_000);
orphanWatch.unref?.();
