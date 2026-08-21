/**
 * 가짜 grok CLI — 서브에이전트 fleet 시나리오 재생기 (provider fleet e2e 전용).
 *
 * grok 1.0.5 의 두 출처를 실측대로 재현한다:
 *  1. stdout(`--output-format streaming-messages-json`): 스폰 전까지는 정상적인
 *     Anthropic 와이어 스트림이지만, 스폰 이후에는 귀속이 깨진다 —
 *     parent_tool_use_id 가 전부 null 이고 자식 본문이 루트 텍스트 블록에 그대로
 *     이어 붙는다 (캡처: /tmp/rhwp-probe3/grok/runD.ndjson 255행 부근, 문장
 *     중간부터 시작하는 msg_3 텍스트 블록). 이 시나리오도 스폰 뒤에 자식 본문이
 *     섞인 루트 델타를 흘리며, 하니스는 그걸 전부 버려야 한다.
 *  2. $GROK_HOME/sessions/<percent-encoded cwd>/<sessionId>/updates.jsonl:
 *     깨끗한 JSON-RPC 수명주기. 자식은 형제 디렉터리 <subagent_id>/updates.jsonl
 *     을 갖는다 (캡처: /tmp/rhwp-probe3/grok/capture-sessions/*).
 *     파일은 턴 도중 증분으로 쓰이므로 여기서도 단계마다 append 한다.
 *
 * 허브가 PATH 에서 `grok` 으로 스폰하고 GROK_HOME 을 환경으로 준다. 세션 ID 는
 * argv 의 `-s`/`-r` 값을 그대로 쓴다 (실제 CLI 와 동일하게 init 로도 보고한다).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const argv = process.argv.slice(2);
function argValue(...flags) {
  for (const flag of flags) {
    const idx = argv.indexOf(flag);
    if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  }
  return null;
}

const SESSION_ID = argValue('-s', '--session-id', '-r', '--resume') || 'E2E-GROK-FLEET-SESSION';
const grokHome = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
// grok 이 sessions 디렉터리 키로 쓰는 인코딩: realpath 를 percent-encode 한다.
const cwdKey = encodeURIComponent(fs.realpathSync(process.cwd()));
const sessionsRoot = path.join(grokHome, 'sessions', cwdKey);

const SUB_A = '01a01a89-544c-71f1-a661-8af179ec9ab8';
const SUB_B = '01a01a89-544c-71f1-a661-8b050251670c';
const SPAWN_CALL_A = 'call-f0421835-5e25-4d0c-8426-78a5d1a8e6a8-0';
const SPAWN_CALL_B = 'call-f0421835-5e25-4d0c-8426-78a5d1a8e6a8-1';
const COLLECT_CALL = 'call-a77f9c89-d08d-44b1-b6fb-b0671b8a4a62-2';
const PROMPT_ID = '60c24529-9c7e-4e00-bfb5-d36f1612c3ac';

const ROOT_INTRO = '2쪽과 3쪽을 서브에이전트 둘에게 나눠 맡기겠습니다.';
const ROOT_SUMMARY = '두 서브에이전트가 모두 끝났습니다. 2쪽 표와 3쪽 서식이 정리되었습니다.';

// ── stdout ────────────────────────────────────────────────────
let eventSeq = 0;
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const streamEvent = (event) => emit({
  type: 'stream_event', event, parent_tool_use_id: null, session_id: SESSION_ID,
  uuid: `uuid-${++eventSeq}`,
});
/** 실제 CLI 의 델타 입자 — 토큰 단위로 잘라 흘린다. */
function textDeltas(index, text) {
  streamEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  for (const piece of text.match(/.{1,4}/gs) ?? []) {
    streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
  }
  streamEvent({ type: 'content_block_stop', index });
}

// ── 디스크 (updates.jsonl) ────────────────────────────────────
function updatesPath(sessionDirName) {
  return path.join(sessionsRoot, sessionDirName, 'updates.jsonl');
}
function writeUpdates(sessionDirName, sessionId, updates) {
  const file = updatesPath(sessionDirName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = updates.map((update) => JSON.stringify({
    timestamp: Math.floor(Date.now() / 1000),
    // `_x.ai/session/update` 와 `session/update` 가 섞여 온다 — 하니스는 method 를
    // 보지 않고 params.update.sessionUpdate 만 본다.
    method: update.sessionUpdate.startsWith('subagent_') || update.sessionUpdate === 'turn_completed'
      ? '_x.ai/session/update'
      : 'session/update',
    params: {
      sessionId,
      update,
      _meta: { eventId: `${sessionId}-${++eventSeq}`, agentTimestampMs: Date.now() },
    },
  })).join('\n') + '\n';
  fs.appendFileSync(file, lines, 'utf8');
}
const parentUpdates = (...updates) => writeUpdates(SESSION_ID, SESSION_ID, updates);
const childUpdates = (subagentId, ...updates) => writeUpdates(subagentId, subagentId, updates);

const messageChunk = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const thoughtChunk = (text) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });

function spawnToolCall(callId, description, prompt) {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: callId,
    title: 'spawn_subagent',
    rawInput: { description, prompt, subagent_type: 'doc-editor', background: true },
    _meta: {
      'x.ai/tool': { version: 1, name: 'spawn_subagent', kind: 'task', namespace: 'grok_build', label: 'Subagent', read_only: false },
      subagentBackground: true,
    },
  };
}
function spawnToolResult(callId, subagentId, description) {
  const text = `Subagent started in background.\nsubagent_id: ${subagentId}\ntype: doc-editor\ndescription: ${description}\n\n`
    + `When you need its result, use get_command_or_subagent_output with task_ids=["${subagentId}"] and a positive timeout_ms.`;
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
    rawOutput: { type: 'Text', text },
  };
}
function spawned(subagentId, description) {
  return {
    sessionUpdate: 'subagent_spawned',
    subagent_id: subagentId,
    parent_session_id: SESSION_ID,
    parent_prompt_id: PROMPT_ID,
    child_session_id: subagentId,
    subagent_type: 'doc-editor',
    description,
    effective_context_source: 'new',
    model: 'grok-4.6',
  };
}
function finished(subagentId, output, { toolCalls = 1, durationMs = 7229, tokens = 10613 } = {}) {
  return {
    sessionUpdate: 'subagent_finished',
    subagent_id: subagentId,
    child_session_id: subagentId,
    status: 'completed',
    tool_calls: toolCalls,
    turns: 1,
    duration_ms: durationMs,
    tokens_used: tokens,
    output,
    will_wake: false,
  };
}
function childToolCall(callId, name, rawInput) {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: callId,
    title: name,
    rawInput,
    _meta: { 'x.ai/tool': { version: 1, name, kind: 'read', namespace: 'grok_build', label: name, read_only: true } },
  };
}
function childToolResult(callId, text) {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
    rawOutput: { type: 'Text', text },
  };
}

async function scenario() {
  emit({
    type: 'system', subtype: 'init', session_id: SESSION_ID, apiKeySource: 'oauth',
    model: 'grok-4.6', cwd: process.cwd(), permissionMode: 'always-approve',
    tools: ['run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'grep', 'spawn_subagent'],
    mcp_servers: [{ name: 'rhwp', status: 'connected' }],
  });
  parentUpdates({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '2쪽과 3쪽을 병렬로 정리해줘' } });
  await sleep(80);

  // ── 스폰 전: stdout 이 유일한 출처다 (솔로 턴과 완전히 동일한 경로) ──
  streamEvent({ type: 'message_start', message: { id: 'msg_0', type: 'message', role: 'assistant', model: 'grok-4.6', content: [] } });
  textDeltas(0, ROOT_INTRO);
  await sleep(120);

  // 디스크에는 같은 본문이 메시지 단위 통짜로 뒤늦게 나타난다 — 하니스는 전환
  // 시점에 이미 흘린 글자 수만큼 건너뛰어 중복을 만들지 않아야 한다.
  parentUpdates(thoughtChunk('두 문단을 나눠 맡기자.'), messageChunk(ROOT_INTRO));

  // ── 스폰 tool_use ×2 ──
  streamEvent({
    type: 'content_block_start', index: 1,
    content_block: { type: 'tool_use', id: SPAWN_CALL_A, name: 'spawn_subagent', input: {} },
  });
  streamEvent({
    type: 'content_block_delta', index: 1,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: '2쪽 표 정리', prompt: '2쪽 표를 정리하라', subagent_type: 'doc-editor', background: true }) },
  });
  streamEvent({ type: 'content_block_stop', index: 1 });
  streamEvent({
    type: 'content_block_start', index: 2,
    content_block: { type: 'tool_use', id: SPAWN_CALL_B, name: 'spawn_subagent', input: {} },
  });
  streamEvent({
    type: 'content_block_delta', index: 2,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: '3쪽 서식 정리', prompt: '3쪽 서식을 맞추라', subagent_type: 'doc-editor', background: true }) },
  });
  streamEvent({ type: 'content_block_stop', index: 2 });
  streamEvent({ type: 'message_stop' });
  emit({
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      id: 'msg_0', type: 'message', role: 'assistant', model: 'grok-4.6',
      content: [
        { type: 'text', text: ROOT_INTRO },
        { type: 'tool_use', id: SPAWN_CALL_A, name: 'spawn_subagent', input: { description: '2쪽 표 정리', prompt: '2쪽 표를 정리하라', subagent_type: 'doc-editor', background: true } },
        { type: 'tool_use', id: SPAWN_CALL_B, name: 'spawn_subagent', input: { description: '3쪽 서식 정리', prompt: '3쪽 서식을 맞추라', subagent_type: 'doc-editor', background: true } },
      ],
      stop_reason: 'tool_use',
    },
  });
  emit({
    type: 'user',
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: SPAWN_CALL_A, content: JSON.stringify({ type: 'Text', text: `Subagent started in background.\nsubagent_id: ${SUB_A}` }) },
        { type: 'tool_result', tool_use_id: SPAWN_CALL_B, content: JSON.stringify({ type: 'Text', text: `Subagent started in background.\nsubagent_id: ${SUB_B}` }) },
      ],
    },
  });
  parentUpdates(
    spawnToolCall(SPAWN_CALL_A, '2쪽 표 정리', '2쪽 표를 정리하라'),
    spawnToolCall(SPAWN_CALL_B, '3쪽 서식 정리', '3쪽 서식을 맞추라'),
    spawnToolResult(SPAWN_CALL_A, SUB_A, '2쪽 표 정리'),
    spawnToolResult(SPAWN_CALL_B, SUB_B, '3쪽 서식 정리'),
    spawned(SUB_A, '2쪽 표 정리'),
    spawned(SUB_B, '3쪽 서식 정리'),
  );
  childUpdates(SUB_A, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '2쪽 표를 정리하라' } });
  childUpdates(SUB_B, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '3쪽 서식을 맞추라' } });
  await sleep(700);

  // ── 전환 이후의 stdout: 전부 버려져야 하는 구간 ──
  // 자식 본문이 루트 텍스트 블록에 그대로 이어 붙고(실측), 수거 도구 호출도
  // 루트 행으로 새면 안 된다.
  streamEvent({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'grok-4.6', content: [] } });
  textDeltas(0, 'GARBLED-CHILD-LEAK 표 너비를 맞췄습 outcome: 니다 이어붙은 자식 본문');
  streamEvent({
    type: 'content_block_start', index: 1,
    content_block: { type: 'tool_use', id: COLLECT_CALL, name: 'get_command_or_subagent_output', input: {} },
  });
  streamEvent({
    type: 'content_block_delta', index: 1,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ task_ids: [SUB_A, SUB_B], timeout_ms: 120000 }) },
  });
  streamEvent({ type: 'content_block_stop', index: 1 });
  emit({
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'grok-4.6',
      content: [
        { type: 'text', text: 'GARBLED-CHILD-LEAK 표 너비를 맞췄습 outcome: 니다 이어붙은 자식 본문' },
        { type: 'tool_use', id: COLLECT_CALL, name: 'get_command_or_subagent_output', input: { task_ids: [SUB_A, SUB_B], timeout_ms: 120000 } },
      ],
    },
  });

  // ── 자식 활동은 자기 파일에만 깨끗하게 남는다 ──
  childUpdates(SUB_A,
    thoughtChunk('2쪽 표부터 본다.'),
    childToolCall('call-child-a-1', 'read_file', { path: 'page2.md' }),
    childToolResult('call-child-a-1', '| 항목 | 값 |'),
    messageChunk('2쪽 표 너비를 맞췄습니다.'),
  );
  childUpdates(SUB_B,
    childToolCall('call-child-b-1', 'read_file', { path: 'page3.md' }),
    childToolResult('call-child-b-1', '3쪽 본문'),
    messageChunk('3쪽 문단 서식을 맞췄습니다.'),
  );
  await sleep(900);

  // A 만 먼저 끝난다.
  parentUpdates(finished(SUB_A, '2쪽 표 너비를 맞췄습니다.', { toolCalls: 1, durationMs: 7229, tokens: 10613 }));
  await sleep(700);

  // B 가 아직 열려 있는 채로 stdout result 가 도착한다 — 하니스는 이 턴을 닫으면
  // 안 된다. (배경 스폰이 남아 있을 때 CLI 가 먼저 턴을 마무리하는 방어 경로다.)
  emit({
    type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn',
    result: ROOT_SUMMARY, session_id: SESSION_ID, num_turns: 2,
    usage: { input_tokens: 8242, output_tokens: 236, cache_read_input_tokens: 5760, cache_creation_input_tokens: 0 },
  });
  await sleep(1800);

  parentUpdates(
    finished(SUB_B, '3쪽 문단 서식을 맞췄습니다.', { toolCalls: 1, durationMs: 9130, tokens: 8820 }),
    messageChunk(ROOT_SUMMARY),
    { sessionUpdate: 'turn_completed', prompt_id: PROMPT_ID, stop_reason: 'end_turn' },
  );

  // 디스크 최종 수확 + 정착 유예가 지나갈 시간을 준 뒤 종료한다.
  await sleep(4000);
  process.exit(0);
}

scenario().catch((error) => {
  process.stderr.write(`fake-grok-fleet scenario error: ${error?.stack ?? error}\n`);
  process.exit(1);
});

// 허브가 SIGKILL 로 죽는 경우의 고아 방지.
const orphanWatch = setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 1_000);
orphanWatch.unref?.();
