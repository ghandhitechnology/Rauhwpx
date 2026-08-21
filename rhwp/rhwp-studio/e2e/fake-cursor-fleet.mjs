/**
 * 가짜 cursor-agent CLI — 서브에이전트 fleet 시나리오 재생기 (provider fleet e2e 전용).
 *
 * cursor 는 이 머신에서 미인증이라 라이브 캡처가 없다. 이벤트 모양은 빌드
 * 2026.08.11-e8db854 번들에서 정적 추출한 스키마를 그대로 따른다
 * (/tmp/rhwp-probe3/cursor/evidence.txt, emitter-region.txt), protobuf-es
 * toJson(emitDefaultValues) 규약대로: 비-옵셔널 스칼라는 빈 값이라도 항상 싣고,
 * 옵셔널 필드는 미설정이면 빼고, oneof 는 lowerCamel 키 하나로 평평해지며
 * uint64 는 문자열로 실린다. tool_call 페이로드에는 oneof 가 아닌 형제
 * (hookAdditionalContexts/startedAtMs/completedAtMs)를 일부러 앞에 둔다 —
 * 하니스가 키 순서에 기대지 않는지 종단간에서도 확인하기 위해서다.
 *
 * 시나리오: 서브에이전트 2건. 하나는 완료 전사(conversationSteps)를 통째로
 * 들고 오고, 하나는 background 로 넘어가 전사가 비어 있다가 나중에 나오는
 * system/task_notification 으로 닫힌다. result 는 그 백그라운드 카드가 열려
 * 있는 동안 먼저 도착한다 — 턴이 거기서 닫히면 정착 회귀다.
 *
 * 허브가 PATH 에서 `cursor-agent` 로 스폰한다. 프롬프트는 positional 인자이고
 * stdin 은 닫혀 오므로, argv 를 무시하고 곧바로 시나리오를 재생한다.
 */
const SESSION_ID = '9f1b6f4e-1c2a-4e77-9b0e-2f7c4a1d9e30';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

let stamp = 1;
const nextStamp = () => String(1787151600000 + (stamp += 1));

/** 진짜 증분 델타 = timestamp_ms 가 있고 model_call_id 가 없는 assistant 이벤트. */
const assistantDelta = (text) => emit({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  session_id: SESSION_ID,
  timestamp_ms: Number(nextStamp()),
});

/** agent.v1.TaskArgs — description/prompt/subagentType/mode/environment 는 항상 실린다. */
const taskArgs = (overrides = {}) => ({
  description: '',
  prompt: '',
  subagentType: { explore: {} },
  attachments: [],
  mode: 'TASK_MODE_AGENT',
  respondingToMessageIds: [],
  environment: 'SUBAGENT_EXECUTION_ENVIRONMENT_LOCAL',
  ...overrides,
});

const taskStarted = (callId, args) => emit({
  type: 'tool_call', subtype: 'started', call_id: callId,
  model_call_id: 'mc-1', session_id: SESSION_ID, timestamp_ms: Number(nextStamp()),
  tool_call: { hookAdditionalContexts: [], startedAtMs: nextStamp(), taskToolCall: { args } },
});

const taskCompleted = (callId, args, result) => emit({
  type: 'tool_call', subtype: 'completed', call_id: callId,
  model_call_id: 'mc-1', session_id: SESSION_ID, timestamp_ms: Number(nextStamp()),
  tool_call: { hookAdditionalContexts: [], completedAtMs: nextStamp(), taskToolCall: { args, result } },
});

/** agent.v1.McpArgs — 기본값 필드까지 전부 실린다. 실제 인자는 안쪽 args 다. */
const mcpArgs = (name, args) => ({
  name: `mcp__rhwp__${name}`,
  args,
  toolCallId: '',
  providerIdentifier: '',
  toolName: name,
  smartModeApprovalOnly: false,
  skipApproval: false,
  serverIdentifier: '',
});

const ARGS_A = taskArgs({
  description: '2쪽 표 정리',
  prompt: 'Fix the table on page 2.',
  subagentType: { custom: { name: 'doc-editor' } },
});
const ARGS_B = taskArgs({
  description: '3쪽 서식 정리',
  prompt: 'Normalize the formatting on page 3.',
  subagentType: { explore: {} },
});

async function scenario() {
  emit({
    type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(),
    session_id: SESSION_ID, model: 'gpt-5.2', permissionMode: 'default',
  });
  await sleep(60);
  assistantDelta('2쪽과 3쪽을 서브에이전트 둘에게 나눠 맡기겠습니다.');
  await sleep(60);

  // 스폰 ×2 — 도구 행이 아니라 fleet 카드로 그려져야 한다.
  taskStarted('call-task-a', ARGS_A);
  taskStarted('call-task-b', ARGS_B);
  await sleep(400);

  // A 완료: 자식 전사가 통째로 도착한다 (헤드리스는 자식을 스트리밍하지 않는다).
  taskCompleted('call-task-a', ARGS_A, {
    success: {
      conversationSteps: [
        { assistantMessage: { text: '2쪽 표를 확인했습니다.' } },
        {
          toolCall: {
            toolCallId: 'child-call-a-1',
            mcpToolCall: {
              args: mcpArgs('replace_range', { sectionIdx: 0, startParaIdx: 3, endParaIdx: 3, text: '정리된 2쪽' }),
              result: { success: { revision: 12 } },
            },
          },
        },
        // thinkingMessage 는 카드에 싣지 않는다.
        { thinkingMessage: { text: '열 너비를 어디까지 줄일지', durationMs: 120 } },
        { assistantMessage: { text: '표 너비를 맞췄습니다.' } },
      ],
      agentId: 'agent-uuid-a',
      isBackground: false,
      backgroundReason: 'SUBAGENT_BACKGROUND_REASON_UNSPECIFIED',
      durationMs: '4200',
      resultSuffix: '2쪽 표 정리 완료',
      transcriptPath: '/tmp/cursor-transcript-a.json',
    },
  });
  await sleep(300);

  // B 는 background 로 넘어갔다: 전사가 비어 있고 agentId 만 실린다 — 카드는 열려 있다.
  taskCompleted('call-task-b', ARGS_B, {
    success: {
      conversationSteps: [],
      agentId: 'agent-uuid-b',
      isBackground: true,
      backgroundReason: 'SUBAGENT_BACKGROUND_REASON_AGENT_REQUEST',
    },
  });
  await sleep(300);

  // 백그라운드 카드가 열린 채로 result 가 먼저 온다.
  emit({
    type: 'result', subtype: 'success', duration_ms: 8_000, duration_api_ms: 7_900,
    is_error: false, result: '2쪽은 끝났고 3쪽은 백그라운드에서 이어집니다.',
    session_id: SESSION_ID, request_id: 'req-1',
    usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });

  // 카드 B 가 열려 있는 동안은 유예(1.5s)와 무관하게 턴이 붙들려야 한다 —
  // 그 사이에도 stdout 은 계속 흐른다.
  for (let i = 0; i < 5; i += 1) {
    await sleep(600);
    emit({ type: 'thinking', subtype: 'delta', text: '백그라운드 결과를 기다리는 중', session_id: SESSION_ID, timestamp_ms: Number(nextStamp()) });
  }

  // 백그라운드 셸 알림 — 숫자 task_id 는 아는 카드가 아니므로 조용히 버려져야 한다.
  emit({
    type: 'system', subtype: 'task_notification', task_id: '7', status: 'success',
    title: 'npm test', detail: 'exit 0', session_id: SESSION_ID, timestamp_ms: Number(nextStamp()),
  });
  await sleep(200);
  // 서브에이전트 알림 — task_id 는 success.agentId 다. 이걸로 카드가 닫히고 턴이 정착한다.
  emit({
    type: 'system', subtype: 'task_notification', task_id: 'agent-uuid-b', status: 'success',
    title: '3쪽 서식 정리', detail: '3쪽 문단 서식을 맞췄습니다.', session_id: SESSION_ID,
    timestamp_ms: Number(nextStamp()),
  });

  await sleep(2500);
  process.exit(0);
}

scenario().catch((error) => {
  process.stderr.write(`fake-cursor-fleet scenario error: ${error?.stack ?? error}\n`);
  process.exit(1);
});

// 허브가 SIGKILL 로 죽는 경우의 고아 방지.
const orphanWatch = setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 1_000);
orphanWatch.unref?.();
