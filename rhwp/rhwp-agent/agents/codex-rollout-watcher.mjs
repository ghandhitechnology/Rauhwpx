// codex 0.147.0 의 `exec --json` 은 자식 에이전트 활동을 스트림에 전혀 싣지 않는다
// (라이브 프로브 확인: collab_tool_call 은 wait 호출에만 나오고 receiver_thread_ids /
// agents_states 는 항상 비어 있으며, 자식의 텍스트·도구 호출은 단 한 줄도 오지 않는다).
// 자식별 실측 데이터가 존재하는 유일한 곳은 롤아웃 파일이다:
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
// 이 워처가 그 디렉터리를 폴링해 부모/자식 롤아웃을 증분으로 읽고, 통일 task 이벤트
// (task-start/-progress/-end + parentTaskId 가 붙은 tool-call/tool-result/text-delta)로
// 옮긴다. 스트림 파서(codex.mjs)는 그대로 두고 이 워처만 추가로 붙인다.
import nodeFs from 'node:fs';
import path from 'node:path';

import { truncate } from './backend.mjs';

/** 롤아웃 파일 이름: rollout-2026-08-19T01-40-44-<threadId>.jsonl */
const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl$/;
/** 기본 폴링 주기 — 카드가 살아 있다고 느껴지는 하한과 I/O 사이의 절충. */
const DEFAULT_POLL_MS = 500;
/** 한 번의 폴링에서 파일 하나당 읽을 최대 바이트 (버스트 방어). */
const MAX_READ_BYTES = 1_048_576;
/** 추적할 롤아웃 파일 수 상한 — 오래된 세션 파일이 쌓인 CODEX_HOME 방어. */
const MAX_TRACKED_FILES = 96;
/** 카드 수 상한. 넘으면 새 자식은 무시한다(루트 스트림은 영향 없음). */
const MAX_TASKS = 64;
/** 한 파일을 EOF 까지 몰아 읽을 때의 안전 상한 (MAX_READ_BYTES × 이 값). */
const MAX_DRAIN_ROUNDS = 64;
/** 루트 에이전트의 agent_path. 자식은 항상 그 아래 경로를 받는다. */
const ROOT_AGENT_PATH = '/root';
/** 자식에게는 노출되지 않지만, 포크된 히스토리에 섞여 들어오면 도구 줄로 그리지 않는다. */
const COLLAB_TOOL_NAMES = new Set([
  'spawn_agent', 'wait_agent', 'send_message', 'followup_task', 'interrupt_agent',
  'list_agents', 'close_agent', 'resume_agent', 'send_input',
]);
const SPAWN_TOOL_NAMES = new Set(['spawn_agent']);
const EMPTY = Buffer.alloc(0);

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 로컬 날짜 기준 sessions/YYYY/MM/DD 경로. CLI 도 로컬 시각으로 쓴다. */
function sessionDayDir(sessionsDir, date) {
  return path.join(sessionsDir, String(date.getFullYear()), pad2(date.getMonth() + 1), pad2(date.getDate()));
}

/**
 * 파일을 offset 부터 증분으로 읽는다. openSync/readSync 가 있으면 그 경로를 쓰고
 * (90KB 롤아웃을 매 폴링마다 통째로 읽지 않기 위해), 주입된 간이 fs 에는
 * readFileSync 폴백을 쓴다.
 */
function readTailFrom(fs, file, offset) {
  let size;
  try {
    size = Number(fs.statSync(file)?.size ?? 0);
  } catch {
    return null;
  }
  // 파일이 줄었다 = 잘렸거나 교체됐다 — 처음부터 다시 읽는다. 이때 앞 턴에서 남은
  // 부분 줄(state.pending)은 새 내용과 이어 붙이면 깨진 JSON 이 되므로 버려야 한다.
  const restarted = size < offset;
  const from = restarted ? 0 : offset;
  if (size === from) return { chunk: EMPTY, nextOffset: from, restarted };
  const length = Math.min(size - from, MAX_READ_BYTES);
  if (typeof fs.openSync === 'function' && typeof fs.readSync === 'function') {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, from);
      return { chunk: buf.subarray(0, read), nextOffset: from + read, restarted };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }
  let whole;
  try {
    whole = fs.readFileSync(file);
  } catch {
    return null;
  }
  const buf = Buffer.isBuffer(whole) ? whole : Buffer.from(String(whole));
  const slice = buf.subarray(from, Math.min(buf.length, from + length));
  return { chunk: slice, nextOffset: from + slice.length, restarted };
}

/** 롤아웃 파일 이름 끝에 스레드 id 가 그대로 박힌다: rollout-<ts>-<threadId>.jsonl */
function isThreadFile(name, threadId) {
  return Boolean(threadId) && name.endsWith(`-${threadId}.jsonl`);
}

/** content 배열(input_text/encrypted_content 혼재)에서 평문만 이어 붙인다. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (part && typeof part.text === 'string') out += part.text;
  }
  return out;
}

/** "Message Type: FINAL_ANSWER\n…\nPayload:\n<본문>" 에서 본문만 꺼낸다. */
function finalAnswerPayload(text) {
  const idx = text.indexOf('Payload:\n');
  return (idx === -1 ? text : text.slice(idx + 'Payload:\n'.length)).trim();
}

/** sub_agent_activity.kind → 수명주기. 'started' 외의 값은 미검증이므로 방어적으로 매핑한다. */
function activityKindToStatus(kind) {
  if (kind === 'completed' || kind === 'finished' || kind === 'done' || kind === 'final_answer') return 'completed';
  if (kind === 'failed' || kind === 'error') return 'failed';
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'cancelled' || kind === 'killed' || kind === 'stopped') return 'stopped';
  return null;
}

/**
 * @param {Object} options
 * @param {string} options.codexHome CODEX_HOME (하니스가 정한 격리 홈)
 * @param {(evt: import('./backend.mjs').UnifiedAgentEvent) => void} options.emit
 * @param {import('./backend.mjs').AgentName} [options.agent]
 * @param {number} [options.pollIntervalMs]
 * @param {any} [options.fs] readdirSync/statSync/readFileSync (+선택적 openSync/readSync/closeSync)
 * @param {() => Date} [options.now] 주입 가능한 시계 — 날짜 디렉터리 경계 테스트용
 * @param {{setInterval: Function, clearInterval: Function}} [options.scheduler]
 */
export function createCodexRolloutWatcher({
  codexHome,
  emit,
  agent = 'codex',
  pollIntervalMs = DEFAULT_POLL_MS,
  fs = nodeFs,
  now = () => new Date(),
  scheduler = { setInterval, clearInterval },
} = {}) {
  const sessionsDir = path.join(codexHome ?? '', 'sessions');
  /** @type {string | null} */
  let rootThreadId = null;
  let started = false;
  let stopped = false;
  let timer = null;
  /** endTask 안에서 자식 롤아웃을 몰아 읽는 중인지 — 재진입 방지. */
  let draining = false;
  /**
   * 지금 consume() 이 버퍼를 처리 중인 파일 상태. 자식 자신의 task_complete 가
   * 버퍼 중간에서 endTask→drainChildFiles 를 부르면 같은 상태를 재진입 소비해
   * pending/offset 커서가 어긋난다 — 진행 중인 파일은 드레인에서 건너뛴다
   * (남은 줄은 바깥 consume 루프가 마저 처리한다).
   */
  let consumingState = null;

  /** 추적 중인 롤아웃 파일. key = 절대 경로 */
  const files = new Map();
  /** 우리 세션이 아니라고 판정된 파일 — 다시 열지 않는다. */
  const ignoredFiles = new Set();
  /** taskId → 카드 상태 */
  const tasks = new Map();
  /** agent_path → taskId (FINAL_ANSWER 귀속과 depth>1 승격에 쓴다) */
  const taskIdByAgentPath = new Map();
  /** 자식 thread id → taskId */
  const taskIdByThread = new Map();
  /** spawn_agent call_id → task_name (sub_agent_activity.event_id 가 이 call_id 다) */
  const spawnNameByCallId = new Map();
  /** 이번 폴링에서 usage 가 변한 task — 폴링 끝에 한 번만 진행 이벤트를 낸다. */
  const dirtyTasks = new Set();

  function safeEmit(evt) {
    try {
      emit?.(evt);
    } catch (error) {
      process.stderr.write(`[codex-rollout] emit error: ${error?.stack ?? error}\n`);
    }
  }

  /**
   * 카드를 만든다. 같은 자식이 부모 롤아웃(sub_agent_activity)과 자기 롤아웃
   * (session_meta)에서 각각 발견되므로, task-start 방출은 이번 폴링이 끝날 때까지
   * 미뤄 두 소스의 정보를 합친다(이름은 부모 쪽, 닉네임은 자식 쪽에만 있다).
   * 자식 이벤트가 먼저 나가야 할 때는 flushStart 가 그 자리에서 앞세운다.
   */
  function ensureTask(taskId, { title, role, agentPath } = {}) {
    let task = tasks.get(taskId);
    if (!task) {
      if (tasks.size >= MAX_TASKS) return null;
      task = {
        taskId,
        agentPath: null,
        title: '',
        role: '',
        pendingStart: true,
        toolUses: 0,
        totalTokens: 0,
        lastText: '',
        ended: false,
      };
      tasks.set(taskId, task);
    }
    if (agentPath && !task.agentPath) {
      task.agentPath = agentPath;
      taskIdByAgentPath.set(agentPath, taskId);
    }
    if (task.pendingStart) {
      if (title && !task.title) task.title = String(title);
      if (role && !task.role) task.role = String(role);
    }
    return task;
  }

  function flushStart(taskId) {
    const task = tasks.get(taskId);
    if (!task || !task.pendingStart) return;
    task.pendingStart = false;
    const fallback = task.agentPath ? task.agentPath.split('/').filter(Boolean).pop() : '';
    safeEmit({
      type: 'task-start',
      agent,
      taskId,
      title: truncate(String(task.title || fallback || '서브에이전트'), 120),
      ...(task.role ? { role: task.role } : {}),
      taskKind: 'agent',
    });
  }

  function endTask(taskId, status, summary, usage) {
    let task = tasks.get(taskId);
    if (!task || task.ended) return;
    // 종료 신호는 대개 부모 롤아웃에서 먼저 온다(부모 파일을 자식보다 먼저 읽는다).
    // 카드를 그대로 닫으면 아직 안 읽은 자식 줄(텍스트·도구·token_count)이 통째로
    // 버려진다 — 빠르게 끝난 자식이 활동도 사용량도 없이 닫히던 원인이다.
    // 그래서 닫기 전에 그 자식 롤아웃을 EOF 까지 마저 읽어 이벤트를 먼저 내보낸다.
    drainChildFiles(taskId);
    task = tasks.get(taskId);
    if (!task || task.ended) return; // 자식 롤아웃이 스스로 카드를 닫았다.
    flushStart(taskId);
    task.ended = true;
    dirtyTasks.delete(taskId);
    const finalUsage = usage ?? taskUsage(task);
    safeEmit({
      type: 'task-end',
      agent,
      taskId,
      status,
      ...(summary ? { summary: truncate(String(summary), 500) } : {}),
      ...(finalUsage ? { usage: finalUsage } : {}),
    });
  }

  function taskUsage(task) {
    /** @type {import('./backend.mjs').TaskUsage} */
    const usage = {};
    if (task.totalTokens > 0) usage.totalTokens = task.totalTokens;
    if (task.toolUses > 0) usage.toolUses = task.toolUses;
    return Object.keys(usage).length > 0 ? usage : undefined;
  }

  function flushPending() {
    for (const taskId of tasks.keys()) flushStart(taskId);
    for (const taskId of dirtyTasks) {
      const task = tasks.get(taskId);
      if (!task || task.ended) continue;
      const usage = taskUsage(task);
      if (!usage) continue;
      safeEmit({ type: 'task-progress', agent, taskId, usage });
    }
    dirtyTasks.clear();
  }

  /**
   * depth>1 자식은 자기 카드를 만들지 않고 최상위 자식 카드에 귀속시킨다
   * (agent_path 의 첫 구간이 최상위 자식이다: /root/a/b → /root/a).
   */
  function resolveTaskId(threadId, spawn) {
    const depth = Number(spawn?.depth ?? 1);
    const agentPath = String(spawn?.agent_path ?? '');
    const parentThreadId = String(spawn?.parent_thread_id ?? '');
    if (depth <= 1 || parentThreadId === rootThreadId) return threadId;
    const segments = agentPath.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const topPath = `/${segments[0]}/${segments[1]}`;
      const known = taskIdByAgentPath.get(topPath);
      if (known) return known;
    }
    const viaParent = taskIdByThread.get(parentThreadId);
    if (viaParent) return viaParent;
    // 조상을 못 찾으면 자기 카드로 떨어진다 — 활동이 사라지는 것보다 낫다.
    return threadId;
  }

  function classify(state, payload) {
    const sessionId = String(payload?.session_id ?? '');
    const id = String(payload?.id ?? '');
    const spawn = payload?.source?.subagent?.thread_spawn;
    if (spawn) {
      const parentThreadId = String(spawn.parent_thread_id ?? '');
      const mine = sessionId === rootThreadId
        || parentThreadId === rootThreadId
        || taskIdByThread.has(parentThreadId);
      if (!mine) {
        state.kind = 'foreign';
        return;
      }
      const taskId = resolveTaskId(id, spawn);
      state.kind = 'child';
      state.threadId = id;
      state.taskId = taskId;
      state.agentPath = String(spawn.agent_path ?? '');
      state.selfStarted = false;
      taskIdByThread.set(id, taskId);
      // agent_path 의 마지막 구간이 곧 spawn_agent 의 task_name 이다(/root/math_a → math_a).
      ensureTask(taskId, {
        title: state.agentPath.split('/').filter(Boolean).pop(),
        role: spawn.agent_nickname ? String(spawn.agent_nickname) : undefined,
        agentPath: state.agentPath,
      });
      return;
    }
    if (id === rootThreadId || sessionId === rootThreadId) {
      state.kind = 'parent';
      return;
    }
    state.kind = 'foreign';
  }

  function handleParentLine(type, payload) {
    if (type === 'event_msg') {
      if (payload?.type !== 'sub_agent_activity') return;
      const threadId = String(payload.agent_thread_id ?? '');
      if (!threadId) return;
      const agentPath = String(payload.agent_path ?? '');
      const kind = String(payload.kind ?? '');
      const taskId = taskIdByThread.get(threadId) ?? threadId;
      if (kind === 'started' || !tasks.has(taskId)) {
        taskIdByThread.set(threadId, taskId);
        ensureTask(taskId, {
          title: spawnNameByCallId.get(String(payload.event_id ?? '')) ?? agentPath.split('/').filter(Boolean).pop(),
          agentPath: agentPath || undefined,
        });
      }
      if (kind === 'started') return;
      const status = activityKindToStatus(kind);
      if (status) {
        endTask(taskId, status);
      } else if (kind) {
        // 미검증 kind — 카드를 닫지 않고 활동 줄로만 흘린다.
        flushStart(taskId);
        safeEmit({ type: 'task-progress', agent, taskId, activity: truncate(kind, 200) });
      }
      return;
    }
    if (type !== 'response_item') return;
    if (payload?.type === 'function_call') {
      const name = String(payload.name ?? '');
      if (!SPAWN_TOOL_NAMES.has(name)) return;
      const callId = String(payload.call_id ?? '');
      if (!callId) return;
      let taskName = '';
      try {
        const args = JSON.parse(String(payload.arguments ?? '{}'));
        // message 는 암호화되어 있다 — task_name 만 쓴다.
        taskName = String(args?.task_name ?? '');
      } catch {}
      if (!taskName) return;
      spawnNameByCallId.set(callId, taskName);
      if (spawnNameByCallId.size > 512) {
        spawnNameByCallId.delete(spawnNameByCallId.keys().next().value);
      }
      return;
    }
    if (payload?.type === 'agent_message') {
      // 자식의 결과는 부모 롤아웃에 합성 agent_message 로 도착한다.
      const author = String(payload.author ?? '');
      if (!author || author === ROOT_AGENT_PATH) return;
      const text = contentText(payload.content);
      if (!/^Message Type:\s*FINAL_ANSWER/.test(text)) return;
      const taskId = taskIdByAgentPath.get(author);
      if (!taskId) return;
      endTask(taskId, 'completed', finalAnswerPayload(text));
    }
  }

  function childToolCall(state, callId, tool, argsJson) {
    const task = tasks.get(state.taskId);
    if (!task || task.ended) return;
    task.toolUses += 1;
    dirtyTasks.add(state.taskId);
    // 자식 이벤트는 항상 자기 카드 뒤에 와야 한다.
    flushStart(state.taskId);
    safeEmit({
      type: 'tool-call',
      agent,
      callId,
      tool: tool.replace(/^mcp__rhwp__/, '').replace(/^rhwp__/, ''),
      argsJson,
      parentTaskId: state.taskId,
    });
  }

  function handleChildLine(state, type, payload) {
    if (type === 'event_msg') {
      const t = payload?.type;
      if (t === 'thread_settings_applied') {
        // 자식 스레드가 자기 설정을 적용한 지점 = 포크된 부모 히스토리의 끝.
        // task_started 개수로는 이 경계를 잡을 수 없다: exec resume 으로 이어 온
        // 부모는 이전 턴 수만큼 task_started 를 이미 갖고 있고, 그게 그대로 자식에
        // 포크되어 부모의 지난 턴이 자식 활동으로 재생된다. 경계는 오직
        // thread_settings_applied 와 자기 앞으로 온 NEW_TASK 뿐이다.
        state.selfStarted = true;
        return;
      }
      if (!state.selfStarted) return;
      const task = tasks.get(state.taskId);
      if (!task) return;
      if (t === 'agent_message') {
        const text = String(payload.message ?? '');
        if (text && !task.ended) {
          flushStart(state.taskId);
          safeEmit({ type: 'text-delta', agent, text, parentTaskId: state.taskId });
          task.lastText = text;
        }
        return;
      }
      if (t === 'token_count') {
        const total = Number(payload?.info?.total_token_usage?.total_tokens);
        if (Number.isFinite(total) && total > task.totalTokens) {
          task.totalTokens = Math.round(total);
          dirtyTasks.add(state.taskId);
        }
        return;
      }
      if (t === 'task_complete') {
        endTask(state.taskId, 'completed', String(payload.last_agent_message ?? task.lastText ?? ''));
        return;
      }
      if (t === 'turn_aborted') {
        endTask(state.taskId, 'stopped');
      }
      return;
    }
    if (type !== 'response_item') return;
    const t = payload?.type;
    if (t === 'agent_message') {
      // 부모가 보낸 NEW_TASK 지시 = 이 자식의 작업 시작점. 수신자와 메시지 종류를
      // 함께 본다 — 포크된 히스토리에 섞인 남의 지시/보고는 경계가 아니다.
      if (String(payload.recipient ?? '') === state.agentPath
        && /^Message Type:\s*NEW_TASK/.test(contentText(payload.content))) {
        state.selfStarted = true;
      }
      return;
    }
    if (!state.selfStarted) return;
    if (t === 'function_call') {
      const name = String(payload.name ?? '');
      if (COLLAB_TOOL_NAMES.has(name)) return;
      const callId = String(payload.call_id ?? payload.id ?? '');
      if (!callId) return;
      childToolCall(state, callId, name || 'tool', truncate(String(payload.arguments ?? '{}'), 400));
      return;
    }
    if (t === 'custom_tool_call') {
      const callId = String(payload.call_id ?? payload.id ?? '');
      if (!callId) return;
      childToolCall(
        state,
        callId,
        String(payload.name ?? 'custom_tool'),
        JSON.stringify({ input: truncate(String(payload.input ?? ''), 400) }),
      );
      return;
    }
    if (t === 'function_call_output' || t === 'custom_tool_call_output') {
      const callId = String(payload.call_id ?? '');
      if (!callId) return;
      const raw = payload.output;
      const text = typeof raw === 'string' ? raw : contentText(raw) || JSON.stringify(raw ?? null);
      safeEmit({
        type: 'tool-result',
        agent,
        callId,
        ok: true,
        resultPreview: truncate(text),
        parentTaskId: state.taskId,
      });
    }
  }

  function handleLine(state, obj) {
    const type = obj?.type;
    if (type === 'session_meta') {
      // 자식 롤아웃의 두 번째 session_meta 는 포크된 부모 사본이다 — 첫 판정만 쓴다.
      if (state.kind === 'unknown') classify(state, obj.payload);
      return;
    }
    if (state.kind === 'parent') handleParentLine(type, obj?.payload);
    else if (state.kind === 'child') handleChildLine(state, type, obj?.payload);
  }

  function consume(file, state) {
    const read = readTailFrom(fs, file, state.offset);
    if (!read) return;
    // 파일이 잘려 처음부터 다시 읽는 경우, 남아 있던 부분 줄은 이제 쓸모가 없다.
    if (read.restarted) state.pending = EMPTY;
    state.offset = read.nextOffset;
    if (read.chunk.length === 0 && state.pending.length === 0) return;
    // 부분 줄과 멀티바이트 경계를 안전하게 넘기기 위해 바이트 버퍼로 이어 붙인다.
    let buf = state.pending.length ? Buffer.concat([state.pending, read.chunk]) : read.chunk;
    let start = 0;
    let nl;
    const prevConsuming = consumingState;
    consumingState = state;
    try {
      while ((nl = buf.indexOf(0x0a, start)) !== -1) {
        const line = buf.subarray(start, nl).toString('utf8').trim();
        start = nl + 1;
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // 롤아웃에 깨진 줄이 섞여도 나머지는 계속 읽는다.
        }
        try {
          handleLine(state, obj);
        } catch (error) {
          process.stderr.write(`[codex-rollout] line handler error: ${error?.stack ?? error}\n`);
        }
        if (state.kind === 'foreign') {
          state.pending = EMPTY;
          return;
        }
      }
      state.pending = start < buf.length ? Buffer.from(buf.subarray(start)) : EMPTY;
    } finally {
      consumingState = prevConsuming;
    }
  }

  /** 파일 하나를 더 읽을 게 없을 때까지 몰아 읽는다(폴링 1회 상한을 넘어서). */
  function consumeToEnd(file, state) {
    for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
      const before = state.offset;
      consume(file, state);
      if (state.kind === 'foreign' || state.offset === before) return;
    }
  }

  /**
   * 카드를 닫기 직전에 그 자식의 롤아웃을 EOF 까지 읽는다. 아직 분류되지 않은
   * ('unknown') 파일도 함께 읽는다 — 그 안에 방금 만들어진 그 자식의 롤아웃이
   * 들어 있을 수 있고, 첫 줄(session_meta)을 읽어야 누구 것인지 알 수 있다.
   */
  function drainChildFiles(taskId) {
    if (draining || !started) return;
    draining = true;
    try {
      scanDirs();
      for (const [file, state] of [...files]) {
        if (state.kind === 'parent' || state.kind === 'foreign') continue;
        if (state.kind === 'child' && state.taskId !== taskId) continue;
        if (state === consumingState) continue; // 바깥 consume 이 처리 중 — 커서를 건드리지 않는다.
        consumeToEnd(file, state);
        if (state.kind === 'foreign') {
          files.delete(file);
          ignoredFiles.add(file);
        }
      }
    } catch (error) {
      process.stderr.write(`[codex-rollout] drain error: ${error?.stack ?? error}\n`);
    } finally {
      draining = false;
    }
  }

  /**
   * @param {boolean} [seed] start() 시점의 첫 스캔. 이미 존재하던 롤아웃 파일은
   *   지난 턴의 것이다 — `exec resume` 은 같은 부모 롤아웃 파일에 이어 쓰므로,
   *   부모 파일은 현재 EOF 부터 읽기 시작하고(이번 턴 줄만 본다) 그 밖의 파일은
   *   아예 열지 않는다. 그러지 않으면 지난 턴의 자식들이 유령 카드로 되살아난다.
   *   start() 이후에 새로 생긴 파일만 0바이트부터 읽는다.
   */
  function scanDirs(seed = false) {
    if (files.size >= MAX_TRACKED_FILES) return;
    const today = now();
    const yesterday = new Date(today.getTime() - 86_400_000);
    // 자정을 넘겨 실행되면 롤아웃이 다음 날 디렉터리에 생긴다 — 두 날을 함께 본다.
    const dirs = [sessionDayDir(sessionsDir, yesterday), sessionDayDir(sessionsDir, today)];
    for (const dir of dirs) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      // 파일 이름의 타임스탬프 순으로 본다 — 부모 롤아웃이 항상 먼저 생기므로
      // 자식 카드가 부모의 spawn 이름을 얻은 뒤에 그려진다.
      for (const name of [...names].sort()) {
        if (typeof name !== 'string' || !ROLLOUT_FILE_RE.test(name)) continue;
        const full = path.join(dir, name);
        if (files.has(full) || ignoredFiles.has(full)) continue;
        // 파일 이름 끝의 스레드 id 로 부모 롤아웃을 알아본다. 첫 줄을 건너뛰고
        // EOF 부터 읽는 경우에도 분류가 필요하기 때문이다.
        const isRoot = isThreadFile(name, rootThreadId);
        if (seed) {
          if (!isRoot) {
            ignoredFiles.add(full);
            continue;
          }
          let size;
          try {
            size = Number(fs.statSync(full)?.size ?? 0);
          } catch {
            continue;
          }
          files.set(full, { offset: size, pending: EMPTY, kind: 'parent' });
          continue;
        }
        if (files.size >= MAX_TRACKED_FILES) return;
        files.set(full, { offset: 0, pending: EMPTY, kind: isRoot ? 'parent' : 'unknown' });
      }
    }
  }

  function pollOnce({ toEnd = false } = {}) {
    if (!started || !rootThreadId) return;
    scanDirs();
    for (const [file, state] of files) {
      if (toEnd) consumeToEnd(file, state);
      else consume(file, state);
      if (state.kind === 'foreign') {
        files.delete(file);
        ignoredFiles.add(file);
      }
    }
    flushPending();
  }

  function stop() {
    stopped = true;
    started = false;
    if (timer) {
      scheduler.clearInterval(timer);
      timer = null;
    }
  }

  return {
    /** thread.started 로 루트 스레드 id 가 밝혀진 순간 호출한다. */
    start(threadId) {
      if (stopped || started || !threadId || !codexHome) return;
      rootThreadId = String(threadId);
      started = true;
      // 이미 있던 롤아웃은 지난 턴 몫이다 — 오프셋을 EOF 로 앉히고 시작한다.
      scanDirs(true);
      timer = scheduler.setInterval(() => {
        try {
          pollOnce();
        } catch (error) {
          process.stderr.write(`[codex-rollout] poll error: ${error?.stack ?? error}\n`);
        }
      }, pollIntervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      pollOnce();
    },
    /** 테스트와 finalize 가 쓰는 동기 1회 스캔. */
    pollOnce,
    /**
     * 프로세스 종료 시점의 마지막 동기 읽기 + 남은 카드 정리.
     * codex.mjs 는 turn-end 보다 먼저 이걸 부른다 — 턴이 끝날 때 열린 task 가
     * 남아 있으면 안 된다는 공용 계약을 지키기 위해서다.
     */
    finalize() {
      if (!started) {
        stopped = true;
        return;
      }
      try {
        // 마지막 훑기는 파일마다 EOF 까지 간다 — 종료 직전에 몰려 쓰인 자식 줄이
        // 폴링 1회 상한에 걸려 잘려 나가면 안 된다.
        pollOnce({ toEnd: true });
      } catch (error) {
        process.stderr.write(`[codex-rollout] finalize poll error: ${error?.stack ?? error}\n`);
      }
      // 남은 카드도 endTask 를 거친다 — 그 안에서 자식 롤아웃을 한 번 더 훑으므로
      // stopped 로 닫히기 전에 마지막 활동과 사용량이 먼저 나간다.
      for (const task of tasks.values()) {
        if (task.ended) continue;
        endTask(task.taskId, 'stopped');
      }
      stop();
    },
    stop,
    /** 테스트용 내부 상태 스냅샷. */
    debugState() {
      return {
        rootThreadId,
        trackedFiles: [...files.keys()],
        openTasks: [...tasks.values()].filter((t) => !t.ended).map((t) => t.taskId),
      };
    },
  };
}
