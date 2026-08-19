/**
 * 가짜 claude CLI — 서브에이전트 fleet 시나리오 재생기 (subagent-fleet e2e 전용).
 *
 * 실제 claude 2.1.235 의 stream-json 캡처를 그대로 본뜬 이벤트를 내보낸다:
 * 백그라운드 Agent 스폰 2건 → 즉시 tool_result(런치 확인) → 첫 result →
 * 서브에이전트 활동(parent_tool_use_id 붙은 tool_use/tool_result/text) →
 * task_updated/task_notification → wake 재호출(init→…→result) 반복.
 * 논리적 한 턴에 result 가 세 번 오는 것이 핵심 — 하니스 턴 정착 검증 지점.
 *
 * 허브가 PATH 에서 `claude` 로 스폰한다. argv 는 전부 무시하고 stdin 의 첫
 * user 메시지에 반응한다. 시나리오 후에도 살아 있는다 (실제 CLI 와 동일).
 */
import { createInterface } from 'node:readline';

const SESSION_ID = 'e2e-fleet-session';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (obj) => process.stdout.write(JSON.stringify({ session_id: SESSION_ID, ...obj }) + '\n');

const assistant = (blocks, parent = null) => emit({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { role: 'assistant', content: blocks },
});
const userResult = (toolUseId, text, parent = null) => emit({
  type: 'user',
  parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
});
const result = (modelUsage) => emit({
  type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn',
  result: 'done', num_turns: 1, modelUsage,
});

async function scenario() {
  emit({
    type: 'system', subtype: 'init', model: 'stub-sonnet',
    mcp_servers: [{ name: 'rhwp', status: 'connected' }],
  });
  await sleep(40);
  assistant([{ type: 'text', text: '두 문단을 병렬로 정리하겠습니다.' }]);
  await sleep(40);

  // 병렬 백그라운드 스폰 ×2
  assistant([{
    type: 'tool_use', id: 'toolu-A', name: 'Agent',
    input: { description: '2쪽 정리', prompt: '2쪽을 정리하라', subagent_type: 'doc-editor', run_in_background: true },
  }]);
  emit({
    type: 'system', subtype: 'task_started', task_id: 'task-A', tool_use_id: 'toolu-A',
    description: '2쪽 정리', subagent_type: 'doc-editor', task_type: 'local_agent', prompt: '2쪽을 정리하라',
  });
  userResult('toolu-A', 'Async agent launched successfully.\nagentId: task-A');
  await sleep(30);
  assistant([{
    type: 'tool_use', id: 'toolu-B', name: 'Agent',
    input: { description: '3쪽 정리', prompt: '3쪽을 정리하라', subagent_type: 'doc-editor', run_in_background: true },
  }]);
  emit({
    type: 'system', subtype: 'task_started', task_id: 'task-B', tool_use_id: 'toolu-B',
    description: '3쪽 정리', subagent_type: 'doc-editor', task_type: 'local_agent', prompt: '3쪽을 정리하라',
  });
  userResult('toolu-B', 'Async agent launched successfully.\nagentId: task-B');
  await sleep(40);

  // 첫 result — fleet 은 아직 진행 중. 턴이 여기서 닫히면 정착 회귀다.
  result({ 'stub-sonnet': { inputTokens: 100, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } });
  await sleep(120);

  // 서브에이전트 A 활동 — parentTaskId 귀속 검증 지점
  assistant([{
    type: 'tool_use', id: 'toolu-A-1', name: 'mcp__rhwp__replace_range',
    input: { sectionIdx: 0, startParaIdx: 3, startCharOffset: 0, endParaIdx: 3, endCharOffset: 4, text: '정리된 2쪽' },
  }], 'toolu-A');
  emit({
    type: 'system', subtype: 'task_progress', task_id: 'task-A', tool_use_id: 'toolu-A',
    description: 'Running replace_range', subagent_type: 'doc-editor',
    usage: { total_tokens: 900, tool_uses: 1, duration_ms: 800 }, last_tool_name: 'replace_range',
  });
  userResult('toolu-A-1', '{"revision":12}', 'toolu-A');
  await sleep(50);
  assistant([{ type: 'text', text: '2쪽 정리를 끝냈습니다.' }], 'toolu-A');

  // 서브에이전트 B 활동
  assistant([{
    type: 'tool_use', id: 'toolu-B-1', name: 'mcp__rhwp__insert_text',
    input: { sectionIdx: 0, paraIdx: 7, charOffset: 0, text: '정리된 3쪽' },
  }], 'toolu-B');
  emit({
    type: 'system', subtype: 'task_progress', task_id: 'task-B', tool_use_id: 'toolu-B',
    description: 'Running insert_text', subagent_type: 'doc-editor',
    usage: { total_tokens: 700, tool_uses: 1, duration_ms: 600 }, last_tool_name: 'insert_text',
  });
  userResult('toolu-B-1', '{"revision":13,"rebasedParaShift":1}', 'toolu-B');
  await sleep(50);

  // A 완료 → wake 재호출 #1
  emit({ type: 'system', subtype: 'task_updated', task_id: 'task-A', patch: { status: 'completed', end_time: 1 } });
  emit({
    type: 'system', subtype: 'task_notification', task_id: 'task-A', tool_use_id: 'toolu-A',
    status: 'completed', summary: '2쪽 정리 완료', usage: { total_tokens: 1100, tool_uses: 1, duration_ms: 1400 },
  });
  await sleep(60);
  emit({ type: 'system', subtype: 'init', model: 'stub-sonnet', mcp_servers: [{ name: 'rhwp', status: 'connected' }] });
  assistant([{ type: 'text', text: '첫 번째 서브에이전트가 끝났습니다. 두 번째를 기다립니다.' }]);
  result({ 'stub-sonnet': { inputTokens: 220, outputTokens: 90, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.02 } });
  await sleep(120);

  // B 완료 → wake 재호출 #2 (최종)
  emit({ type: 'system', subtype: 'task_updated', task_id: 'task-B', patch: { status: 'completed', end_time: 2 } });
  emit({
    type: 'system', subtype: 'task_notification', task_id: 'task-B', tool_use_id: 'toolu-B',
    status: 'completed', summary: '3쪽 정리 완료', usage: { total_tokens: 950, tool_uses: 1, duration_ms: 1700 },
  });
  await sleep(60);
  emit({ type: 'system', subtype: 'init', model: 'stub-sonnet', mcp_servers: [{ name: 'rhwp', status: 'connected' }] });
  assistant([{ type: 'text', text: '두 서브에이전트 모두 완료했습니다. 2쪽과 3쪽이 정리되었습니다.' }]);
  result({ 'stub-sonnet': { inputTokens: 340, outputTokens: 130, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.03 } });
}

let started = false;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (started) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg?.type !== 'user') return;
  started = true;
  scenario().catch((error) => {
    process.stderr.write(`fake-claude-fleet scenario error: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
});
// 실제 CLI 처럼 stdin 이 닫혀도 즉시 죽지 않는다 — 하니스의 dispose 가 트리를 정리한다.
rl.on('close', () => setTimeout(() => process.exit(0), 5_000).unref?.());
// 허브가 SIGKILL 로 죽어 stdin EOF 가 안 오는 경우의 고아 방지 — 부모 사망 감시.
const orphanWatch = setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 1_000);
orphanWatch.unref?.();
