// cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
import spawn from 'cross-spawn';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  createTurnProcessLifecycle,
  isPlanningRestricted,
  mcpCapabilityEnv,
  mcpRuntimeFor,
  normalizeExecutionMode,
  normalizeTaskUsage,
  normalizeUsageTokens,
  providerInteractionMode,
  systemBriefFor,
  truncate,
  validateExecutionMode,
} from './backend.mjs';
import {
  isolatedProcessEnv,
  processTreeSpawnOptions,
  terminateProcessTree,
} from '../process-tree.mjs';
import { acpMcpServer, createPersistentAcpSession } from './acp-session.mjs';
import {
  CURSOR_ASK_QUESTION_METHOD,
  decodeCursorAskQuestionFrame,
  encodeCursorAskQuestionFrame,
  handleCursorAskQuestionFrame,
  selectCursorUserInputTransport,
} from './provider-user-input.mjs';
export {
  CURSOR_ASK_QUESTION_METHOD,
  decodeCursorAskQuestionFrame,
  encodeCursorAskQuestionFrame,
  handleCursorAskQuestionFrame,
  selectCursorUserInputTransport,
};

/** 세션 디렉터리에 새로 저작하는 파일 — 영속 홈에서 링크로 끌어오지 않는다. */
const AUTHORED_FILES = new Set(['mcp.json', 'cli-config.json']);
/**
 * 프롬프트 바이트 상한. cursor-agent 는 프롬프트를 positional 인자로 받는데,
 * 470 KB 부근부터 stdout/stderr 없이 코드 0 으로 죽고 1 MB 대에서는 spawn 이
 * E2BIG 으로 실패한다(리눅스는 인자당 128 KiB 라 한계가 더 낮다).
 */
const PROMPT_BYTE_LIMIT = 600_000;
/** 재생으로 판정할 최소 길이 — 이보다 짧은 조각은 정상적으로 반복될 수 있다. */
const REPLAY_MIN_LENGTH = 24;
/**
 * 서브에이전트 전사(conversationSteps)를 재생할 상한. cursor 는 자식 활동을
 * 스트리밍하지 않고 완료 시점에 전사를 통째로 넘기므로, 긴 자식 하나가 사이드바를
 * 뒤덮지 않도록 앞에서부터 이 개수까지만 이벤트로 푼다.
 */
const TASK_STEP_REPLAY_LIMIT = 50;
/**
 * task 가 있었던 턴의 정착 유예. 열린 task 가 하나도 없을 때만 돈다 — 열린 task 가
 * 남아 있으면 유예 없이 무한정 붙든다(claude 하니스와 같은 규약). 마지막 카드가
 * 닫힌 뒤에도 후속 줄이 이어질 수 있어 이만큼 조용해야 턴을 닫는다.
 * 프로세스 'exit' 뒤 'close' 를 기다리는 상한으로도 같은 값을 쓴다.
 */
const TASK_SETTLE_GRACE_MS = 1_500;
/** parentTaskId 별칭(agentId → taskId) 맵 상한 — 오래된 것부터 버린다. */
const TASK_ALIAS_LIMIT = 512;
/**
 * agent.v1.ToolCall 은 oneof `tool` 멤버 하나와 비-oneof 형제를 함께 싣는다.
 * 키 순서에 기대지 않도록 형제를 건너뛰고 oneof 멤버를 고른다.
 * 근거: /tmp/rhwp-probe3/cursor/evidence.txt 2행(agent.v1.ToolCall 필드 목록 —
 * hook_additional_contexts(54) / tool_call_id(57) / started_at_ms(59) /
 * completed_at_ms(60) 만 oneof 밖이다).
 */
const TOOL_CALL_SIBLING_KEYS = new Set([
  'hookAdditionalContexts',
  'toolCallId',
  'startedAtMs',
  'completedAtMs',
]);

/**
 * 세션 전용 ~/.cursor 를 만든다. 영속 허브 소유 cursor 홈(sourceCursorDir)의
 * 항목을 심볼릭 링크로 심되(인증 토큰 등), mcp.json/cli-config.json 은 세션마다
 * 새로 저작한다. cursor-agent 는 CURSOR_CONFIG_DIR 로 mcp.json 을 옮기지
 * 못하므로 HOME 재지정( isolatedProcessEnv )과 이 디렉터리 조합만 신뢰한다.
 *
 * @param {string} sessionCursorDir `<isolatedHome>/.cursor`
 * @param {string} [sourceCursorDir] 영속 cursor 홈의 `.cursor` 디렉터리
 * @param {{ mcpConfig?: object|null, cliConfig?: object|null }} [overlay]
 */
export function prepareCursorHome(sessionCursorDir, sourceCursorDir, {
  mcpConfig = null,
  cliConfig = null,
} = {}, {
  copyFile = copyFileSync,
  platform = process.platform,
  symlink = symlinkSync,
} = {}) {
  mkdirSync(sessionCursorDir, { recursive: true, mode: 0o700 });
  // 원본이 없으면 목록이 비어 아래 루프를 돌지 않는다.
  const sourceDir = sourceCursorDir ? String(sourceCursorDir) : '';
  let entries = [];
  if (sourceDir) {
    try {
      entries = readdirSync(sourceDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  for (const name of entries) {
    if (AUTHORED_FILES.has(name)) continue;
    const source = path.join(sourceDir, name);
    const target = path.join(sessionCursorDir, name);
    try {
      const targetStat = lstatSync(target);
      if (!targetStat.isSymbolicLink()) continue;
      const existingTarget = path.resolve(sessionCursorDir, readlinkSync(target));
      if (existingTarget === path.resolve(source)) continue;
      unlinkSync(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      symlink(source, target);
    } catch (error) {
      if (platform !== 'win32' || error?.code !== 'EPERM') throw error;
      try {
        if (lstatSync(source).isFile()) copyFile(source, target);
      } catch {}
    }
  }
  if (mcpConfig) {
    writeFileSync(path.join(sessionCursorDir, 'mcp.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');
  }
  if (cliConfig) {
    writeFileSync(path.join(sessionCursorDir, 'cli-config.json'), `${JSON.stringify(cliConfig, null, 2)}\n`, 'utf8');
  }
}

/**
 * 세션 mcp.json 내용 — rhwp 서버 하나만 등록한다.
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 */
export function buildCursorMcpConfig(opts) {
  const runtime = mcpRuntimeFor(opts);
  return {
    mcpServers: {
      rhwp: {
        command: runtime.command,
        args: runtime.args,
        env: {
          ...runtime.env,
          RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
          RHWP_AGENT_TOKEN: opts.token,
          RHWP_AGENT_NAME: 'cursor',
          ...mcpCapabilityEnv(opts),
        },
      },
    },
  };
}

/**
 * 세션 cli-config.json 내용. 영속 홈의 원본에서 시작해(토큰류 필드 보존)
 * permissions/approvalMode/sandbox 만 프로필에 맞게 덮어쓴다.
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 * @param {object|null} [sourceCliConfig] 영속 홈 cli-config.json 의 파싱 결과
 */
export function buildCursorCliConfig(opts, sourceCliConfig = null) {
  const base = sourceCliConfig && typeof sourceCliConfig === 'object' && !Array.isArray(sourceCliConfig)
    ? { ...sourceCliConfig }
    : {};
  const baseSandbox = base.sandbox && typeof base.sandbox === 'object' ? base.sandbox : {};
  const planningRestricted = isPlanningRestricted(opts);
  const unrestricted = opts.permissionProfile === 'unrestricted' && !planningRestricted;
  const rootGlob = `${String(opts.rootDir ?? '').replace(/\\/g, '/')}/**`;
  if (unrestricted) {
    base.approvalMode = 'unrestricted';
    base.permissions = { allow: [], deny: [] };
    base.sandbox = { ...baseSandbox, mode: 'disabled' };
    return base;
  }
  base.approvalMode = 'allowlist';
  base.permissions = {
    allow: [
      'Read(**)',
      ...(planningRestricted ? [] : [`Write(${rootGlob})`]),
      'Shell(*)',
      'WebFetch(*)',
      'Mcp(rhwp:*)',
    ],
    deny: planningRestricted ? ['Write(**)'] : [],
  };
  base.sandbox = { ...baseSandbox, mode: 'enabled' };
  return base;
}

/**
 * cursor-agent 헤드리스 인자. 프롬프트는 `--` 뒤 마지막 positional 인자다 —
 * '-' 로 시작하는 메시지도 안전하다 (stdin 은 프롬프트 채널이 아니다).
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 * @param {string|null} chatId
 * @param {string} prompt
 */
export function buildCursorArgv(opts, chatId, prompt) {
  const planningRestricted = isPlanningRestricted(opts);
  const interactionMode = providerInteractionMode(opts);
  const unrestricted = opts.permissionProfile === 'unrestricted' && !planningRestricted;
  const model = String(opts.model ?? '');
  return [
    '-p',
    '--output-format', 'stream-json',
    '--stream-partial-output',
    '--approve-mcps',
    ...(interactionMode === 'plan' ? ['--mode', 'plan'] : []),
    // auto 는 CLI 자체 기본 모델을 쓴다 — 플래그를 아예 붙이지 않는다.
    ...(model && model !== 'auto' ? ['--model', model] : []),
    ...(chatId ? ['--resume', chatId] : []),
    ...(unrestricted ? ['--force'] : []),
    '--',
    prompt,
  ];
}

/**
 * CLI stderr 를 사용자에게 보여줄 짧은 이유로 바꾼다. 인증 오류는 stdout JSON
 * 없이 stderr 평문으로만 오므로 이 경로가 그대로 표면화한다.
 *
 * @param {string} stderrText
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @param {string} token
 */
export function formatCursorExitError(stderrText, code, signal, token) {
  let clean = String(stderrText ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  if (token) clean = clean.split(token).join('[redacted]');
  const detail = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Usage:/i.test(line) && !/^For more information/i.test(line))
    .slice(-8)
    .join('\n');
  const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
  return detail
    ? `Cursor 실행이 중단되었습니다 (${exit}).\n${truncate(detail, 1200)}`
    : `Cursor 실행이 중단되었습니다 (${exit}). Cursor가 오류 설명을 제공하지 않았습니다.`;
}

/** mcpToolCall 안쪽에서 도구 이름으로 보이는 필드를 찾아 서버 접두사를 벗긴다. */
function mcpToolLabel(inner) {
  for (const candidate of [inner, inner?.args]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const raw = candidate.name ?? candidate.tool ?? candidate.toolName;
    if (typeof raw === 'string' && raw) {
      return raw.replace(/^mcp__rhwp__/, '').replace(/^rhwp__/, '').replace(/^rhwp[:.]/, '');
    }
  }
  return 'mcp';
}

/**
 * 도구 호출 인자. mcpToolCall 의 `args` 는 McpArgs 래퍼(name/toolCallId/
 * providerIdentifier … 기본값 포함)이고 실제 도구 인자는 그 안의 `args` 다 —
 * 사이드바에 래퍼가 아니라 인자가 보이도록 한 겹 벗긴다.
 *
 * @param {string} kind
 * @param {any} inner
 */
function toolCallArgs(kind, inner) {
  const args = inner?.args;
  if (kind === 'mcp' && args && typeof args === 'object' && !Array.isArray(args)) {
    return args.args && typeof args.args === 'object' ? args.args : {};
  }
  return args ?? inner ?? {};
}

function acpRawInput(update) {
  const rawInput = update?.rawInput;
  return rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
}

function acpToolArgs(rawInput) {
  if (
    rawInput.args
    && typeof rawInput.args === 'object'
    && !Array.isArray(rawInput.args)
    && (rawInput.name || rawInput.toolName || rawInput.tool || Array.isArray(rawInput.args.questions))
  ) {
    return rawInput.args;
  }
  return rawInput;
}

/** ACP tool_call 이름을 stream-json MCP 경로와 같은 짧은 도구명으로 맞춘다.
 * MCP 는 title 만으로 도구를 알 수 없으므로 이름이나 질문 페이로드가 올 때까지 보류한다. */
function projectAcpToolCall(update) {
  const rawInput = acpRawInput(update);
  const args = acpToolArgs(rawInput);
  if (Array.isArray(args.questions)) {
    return { tool: 'ask_user_question', args };
  }
  const fromWrapper = mcpToolLabel({ args: rawInput });
  const namedUpdate = String(update?.kind ?? '') === 'mcp'
    ? { name: update?.name, args: rawInput }
    : { name: update?.name ?? update?.title, args: rawInput };
  const fromUpdate = mcpToolLabel(namedUpdate);
  const labeled = fromWrapper !== 'mcp' ? fromWrapper : fromUpdate;
  if (String(update?.kind ?? '') === 'mcp' && labeled === 'mcp') return null;
  return { tool: labeled, args };
}

/**
 * tool_call 페이로드에서 oneof 멤버 키를 고른다 (없으면 빈 문자열).
 *
 * @param {any} payload
 */
function pickToolCallKey(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const key of Object.keys(payload)) {
    if (!TOOL_CALL_SIBLING_KEYS.has(key)) return key;
  }
  return '';
}

/** oneof 결과에서 성공 여부 — 실패 변형에는 success 키가 없다. */
function isSuccessResult(result) {
  if (result == null) return true;
  return Object.prototype.hasOwnProperty.call(result, 'success');
}

/**
 * 서브에이전트 종류 → 카드 role. subagentType 은 빈 메시지들의 oneof 라
 * JSON 이 {"explore":{}} 형태이고 custom 만 {name} 을 싣는다. protobuf-es 는
 * 설정되지 않은 메시지 필드를 빼거나 null 로 낼 수 있어 둘 다 받는다.
 * 근거: /tmp/rhwp-probe3/cursor/evidence.txt (agent.v1.SubagentType).
 *
 * @param {any} subagentType
 */
function subagentRole(subagentType) {
  if (!subagentType || typeof subagentType !== 'object') return '';
  const key = Object.keys(subagentType)[0];
  if (!key || key === 'unspecified') return '';
  if (key === 'custom') {
    const name = subagentType.custom?.name;
    return typeof name === 'string' && name ? name : 'custom';
  }
  return key;
}

/**
 * task 카드 제목. description 은 비-옵셔널 스칼라라 항상 실리지만 빈 문자열일 수
 * 있다 — 그 경우 프롬프트 첫 줄로 대체한다.
 *
 * @param {any} args agent.v1.TaskArgs
 */
function taskTitle(args) {
  const description = typeof args?.description === 'string' ? args.description.trim() : '';
  if (description) return truncate(description, 120);
  const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? truncate(firstLine, 120) : '서브에이전트';
}

/**
 * system/task_notification 의 status → 통일 task-end 상태.
 * (BackgroundTaskStatus 가 success/error/aborted 로 실린다.)
 *
 * @param {any} status
 */
function taskNotificationStatus(status) {
  const s = String(status ?? '');
  if (s === 'success') return 'completed';
  if (s === 'aborted') return 'stopped';
  // error 를 포함해 모르는 상태는 실패로 본다 — 성공을 지어내면 실패한 턴의
  // 스테이징 편집이 그대로 커밋된다.
  return 'failed';
}

/**
 * @param {import('./backend.mjs').BackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createCursorSession(opts, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
  createAcpSession = createPersistentAcpSession,
} = {}) {
  const onEvent = opts.onEvent;
  const lifecycle = createTurnProcessLifecycle({
    agent: 'cursor',
    onEvent,
    // 사용자에게 보이는 실행 파일 이름은 CLI 이름 그대로다.
    processLabel: 'cursor-agent',
    formatExitError: (stderrText, code, signal) => formatCursorExitError(stderrText, code, signal, opts.token),
    terminateProcess,
  });

  /** @type {string | null} */
  let chatId = null;
  let currentModel = opts.model ?? null;
  let nativeDisabled = selectCursorUserInputTransport(opts, {
    transport: 'acp',
    methods: [CURSOR_ASK_QUESTION_METHOD],
  }) !== 'native-acp';
  /** @type {ReturnType<typeof createPersistentAcpSession>|null} */
  let nativeSession = null;
  let nativeRestart = Promise.resolve();
  let nativeTurnToken = 0;
  let nativeSessionInfoEmitted = false;
  const acpToolState = new Map();

  // ── 서브에이전트 task 추적 ────────────────────────────────────────
  // cursor 의 서브에이전트 표면은 tool_call 의 taskToolCall oneof 하나뿐이고,
  // 자식 활동은 스트리밍되지 않는다(헤드리스 이미터가 toolCallDelta 를 다루지
  // 않는다). 그래서 started 에서 카드를 열고 completed 의 conversationSteps 를
  // 자식 이벤트로 재생한다.
  // 근거: /tmp/rhwp-probe3/cursor/evidence.txt + emitter-region.txt (빌드
  // 2026.08.11-e8db854 번들 정적 추출). 이 머신의 cursor-agent 는 미인증이라 실행
  // 검증이 불가능하므로 아래는 전부 방어적으로 읽는다: started 시점의 agentId 유무,
  // 백그라운드 완료의 실제 모양(전사가 비어 오는지), 자식 토큰 usage 의 귀속은
  // 확인되지 않았다.
  /** 아직 안 닫힌 task 의 taskId 집합. @type {Set<string>} */
  const openTasks = new Set();
  /** success.agentId → taskId. 뒤늦은 task_notification 을 카드에 잇는 별칭. */
  const taskIdByAlias = new Map();
  /** 이번 턴에 카드를 연 task 수 — 0 이면 result 줄에서 즉시 닫는다(지연 없음). */
  let tasksSeenThisTurn = 0;
  /**
   * result 줄이 담아 온 turn-end 재료 — 열린 task 가 있으면 보류한다.
   * @type {{ stopReason: string, errorMessage: string | undefined } | null}
   */
  let pendingTurnResult = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let settleTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let exitSweepTimer = null;
  /** 이번 스폰의 세대 — 죽어가는 이전 턴의 exit 이 새 턴을 건드리지 못하게 막는다. */
  let turnToken = 0;

  function clearSettleTimer() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  function clearExitSweepTimer() {
    if (exitSweepTimer) {
      clearTimeout(exitSweepTimer);
      exitSweepTimer = null;
    }
  }

  function resetTurnTaskState() {
    clearSettleTimer();
    clearExitSweepTimer();
    // 이전 턴이 'close' 없이 끝났다면 카드가 남아 있다 — 조용히 지우면 사이드바에
    // 영원히 도는 행이 되므로, 새 turn-start 앞에서 stopped 로 닫아 준다.
    sweepOpenTasks();
    tasksSeenThisTurn = 0;
    pendingTurnResult = null;
  }

  /**
   * 열린 카드 하나를 닫는다. 이미 닫힌(쓸어 담긴) task 는 무시한다 — 뒤늦은
   * completed/알림이 task-end 를 두 번 내지 않게 한다.
   *
   * @param {string} taskId
   * @param {{ status: 'completed'|'failed'|'stopped', summary?: string, usage?: import('./backend.mjs').TaskUsage }} fields
   */
  function closeTask(taskId, fields) {
    if (!openTasks.delete(taskId)) return;
    onEvent({ type: 'task-end', agent: 'cursor', taskId, ...fields });
  }

  /** 남은 task 를 stopped 로 닫는다 — turn-end 앞에 반드시 선행한다. */
  function sweepOpenTasks() {
    for (const taskId of [...openTasks]) {
      closeTask(taskId, { status: 'stopped' });
    }
  }

  /** 보류해 둔 result 로 턴을 닫는다 (열린 task 는 stopped 로 쓸어 담는다). */
  function settleTurn() {
    clearSettleTimer();
    const result = pendingTurnResult ?? { stopReason: 'completed', errorMessage: undefined };
    pendingTurnResult = null;
    sweepOpenTasks();
    lifecycle.endTurn({
      type: 'turn-end',
      agent: 'cursor',
      stopReason: result.stopReason ?? 'completed',
      errorMessage: result.errorMessage,
    });
  }

  /**
   * result 를 이미 받았다면 정착 조건을 본다.
   * - 열린 task 가 있으면 유예 없이 붙든다: 뒤늦은 task_notification 이 성공한
   *   백그라운드 카드를 stopped 로 만들지 않도록, 턴은 카드가 다 닫히거나
   *   프로세스가 죽을 때까지 열려 있다.
   * - 카드가 다 닫혔고 이번 턴에 task 가 있었으면, 후속 줄이 이어질 수 있으니
   *   조용해진 뒤에 닫는다. task 가 없던 턴은 곧바로 닫는다.
   */
  function settleIfReady() {
    if (!pendingTurnResult || !lifecycle.isTurnOpen()) return;
    if (openTasks.size > 0) return;
    if (tasksSeenThisTurn === 0) {
      settleTurn();
      return;
    }
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (lifecycle.isDisposed() || !lifecycle.isTurnOpen()) return;
      settleTurn();
    }, TASK_SETTLE_GRACE_MS);
    settleTimer.unref?.();
  }

  function rememberTaskAlias(alias, taskId) {
    if (!alias || alias === taskId) return;
    taskIdByAlias.set(alias, taskId);
    if (taskIdByAlias.size > TASK_ALIAS_LIMIT) {
      taskIdByAlias.delete(taskIdByAlias.keys().next().value);
    }
  }

  /**
   * conversationSteps 안의 toolCall 하나를 자식 도구 행 한 쌍으로 편다.
   * 자식 전사는 완료 후에 오므로 호출과 결과를 즉시 연달아 낸다.
   *
   * @param {string} taskId
   * @param {any} call agent.v1.ToolCall
   * @param {number} index
   */
  function emitChildToolCall(taskId, call, index) {
    const key = pickToolCallKey(call);
    const inner = key ? call[key] : null;
    const kind = key ? key.replace(/ToolCall$/, '') : 'tool';
    const tool = kind === 'mcp' ? mcpToolLabel(inner) : kind;
    // 중첩 task(자식이 또 스폰한 경우)는 카드가 아니라 자식 도구 행으로만 남긴다 —
    // 프롬프트 전문이 사이드바에 실리지 않게 요약만 붙인다.
    const args = kind === 'task'
      ? {
        description: String(inner?.args?.description ?? ''),
        prompt: truncate(String(inner?.args?.prompt ?? ''), 400),
      }
      : toolCallArgs(kind, inner);
    // toolCallId 는 옵셔널이라 없을 수 있다 — 카드 안에서만 유일하면 충분하다.
    const callId = String(call?.toolCallId ?? '') || `${taskId}:step-${index}`;
    onEvent({
      type: 'tool-call',
      agent: 'cursor',
      callId,
      tool,
      argsJson: JSON.stringify(args),
      parentTaskId: taskId,
    });
    const result = inner?.result;
    onEvent({
      type: 'tool-result',
      agent: 'cursor',
      callId,
      ok: isSuccessResult(result),
      resultPreview: truncate(JSON.stringify(result ?? null)),
      parentTaskId: taskId,
    });
  }

  /**
   * taskToolCall.result.success 재생 → 자식 이벤트 + task-end.
   * ConversationStep 은 assistantMessage | toolCall | thinkingMessage oneof 다
   * (thinking 은 카드에 싣지 않는다).
   *
   * @param {string} taskId
   * @param {any} success agent.v1.TaskSuccess
   */
  function replayTaskTranscript(taskId, success) {
    const steps = Array.isArray(success?.conversationSteps) ? success.conversationSteps : [];
    const limit = Math.min(steps.length, TASK_STEP_REPLAY_LIMIT);
    let lastText = '';
    let toolUses = 0;
    let emittedText = false;
    for (let i = 0; i < limit; i += 1) {
      const step = steps[i];
      const assistant = step?.assistantMessage;
      if (assistant && typeof assistant.text === 'string') {
        if (!assistant.text) continue;
        lastText = assistant.text;
        onEvent({
          type: 'text-delta',
          agent: 'cursor',
          // 전사는 델타가 아니라 메시지 단위다 — 이어 붙지 않게 문단을 띄운다.
          text: emittedText ? `\n\n${assistant.text}` : assistant.text,
          parentTaskId: taskId,
        });
        emittedText = true;
        continue;
      }
      if (step?.toolCall) {
        emitChildToolCall(taskId, step.toolCall, i);
        toolUses += 1;
      }
    }
    return { lastText, toolUses, truncated: steps.length > limit };
  }

  /**
   * tool_call 의 taskToolCall 분기. 스폰 도구 자체는 루트 도구 행으로 내지 않는다 —
   * task 카드가 그 자리를 대신한다.
   *
   * @param {string} subtype
   * @param {string} callId
   * @param {any} inner agent.v1.TaskToolCall
   */
  function handleTaskToolCall(subtype, callId, inner) {
    if (!callId) return;
    if (subtype === 'started') {
      const args = inner?.args;
      const role = subagentRole(args?.subagentType);
      if (!openTasks.has(callId)) tasksSeenThisTurn += 1;
      openTasks.add(callId);
      // agentId 는 started 시점에 비어 있을 수 있다 — 있으면 미리 별칭으로 잡아 둔다.
      rememberTaskAlias(String(args?.agentId ?? ''), callId);
      onEvent({
        type: 'task-start',
        agent: 'cursor',
        taskId: callId,
        callId,
        title: taskTitle(args),
        ...(role ? { role } : {}),
        taskKind: 'agent',
      });
      return;
    }
    if (subtype !== 'completed' || !openTasks.has(callId)) return;
    const result = inner?.result;
    // 결과 멤버가 아예 없는 완료는 루트 도구 경로와 같은 규약으로 읽는다(null → 성공).
    if (result == null) {
      closeTask(callId, { status: 'completed' });
      return;
    }
    if (!isSuccessResult(result)) {
      const message = String(result?.error?.error ?? '');
      closeTask(callId, {
        status: 'failed',
        ...(message ? { summary: truncate(message, 500) } : {}),
      });
      return;
    }
    const success = result.success ?? {};
    const { lastText, toolUses, truncated } = replayTaskTranscript(callId, success);
    rememberTaskAlias(String(success.agentId ?? ''), callId);
    // 백그라운드로 넘어간 서브에이전트는 전사가 비어 있고 나중에
    // system/task_notification 이 닫는다 — 그때까지 카드를 열어 둔다.
    if (success.isBackground === true && toolUses === 0 && !lastText) return;
    // durationMs 는 uint64 라 JSON 에 문자열로 실릴 수 있다 — normalizeTaskUsage 가 흡수한다.
    const usage = normalizeTaskUsage({
      durationMs: success.durationMs,
      ...(toolUses > 0 ? { toolUses } : {}),
    });
    const summary = String(success.resultSuffix ?? '') || lastText;
    closeTask(callId, {
      status: 'completed',
      ...(summary ? { summary: truncate(summary, 500) } : {}),
      ...(usage ? { usage } : {}),
    });
    if (truncated) {
      process.stderr.write(`[cursor] task ${callId}: 전사 ${TASK_STEP_REPLAY_LIMIT}단계까지만 재생했습니다\n`);
    }
  }

  /**
   * 백그라운드 작업 완료 알림. 서브에이전트와 백그라운드 셸이 같은 이벤트를
   * 공유하고 구분용 kind 필드는 방출 전에 떨어져 나가므로, 아는 task 에 걸리지
   * 않는 task_id(셸의 숫자 id 등)는 조용히 버린다.
   *
   * @param {any} e
   */
  function handleTaskNotification(e) {
    const raw = String(e?.task_id ?? '');
    if (!raw) return;
    const taskId = openTasks.has(raw) ? raw : taskIdByAlias.get(raw);
    if (!taskId || !openTasks.has(taskId)) return;
    const detail = typeof e.detail === 'string' ? e.detail : '';
    closeTask(taskId, {
      status: taskNotificationStatus(e.status),
      ...(detail ? { summary: truncate(detail, 500) } : {}),
    });
  }

  function makeHandler() {
    let emittedText = false;
    // 이번 턴에 이미 내보낸 본문 — 재시도 플러시의 재생을 걸러내는 데 쓴다.
    let emittedTurnText = '';
    const handleLine = (e) => {
      const type = e?.type;
      if (type === 'system' && e.subtype === 'task_notification') {
        handleTaskNotification(e);
        return;
      }
      if (type === 'system' && e.subtype === 'init') {
        if (e.session_id) chatId = String(e.session_id);
        if (typeof e.model === 'string' && e.model) currentModel = e.model;
        onEvent({
          type: 'session-info',
          agent: 'cursor',
          sessionId: chatId ?? '',
          ...(typeof e.model === 'string' && e.model ? { model: e.model } : {}),
        });
        return;
      }
      if (type === 'assistant') {
        // --stream-partial-output 의 진짜 증분 델타는 timestamp_ms 가 있고
        // model_call_id 가 없는 이벤트다. model_call_id 가 붙은 이벤트(도구 호출
        // 직전 중복)와 둘 다 없는 이벤트(마지막 전체 플러시)는 건너뛴다.
        const hasTimestamp = e.timestamp_ms !== undefined && e.timestamp_ms !== null;
        const hasCallId = e.model_call_id !== undefined && e.model_call_id !== null;
        if (!hasTimestamp || hasCallId) return;
        const blocks = e.message?.content;
        if (!Array.isArray(blocks)) return;
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) {
            const text = String(block.text);
            // 재시도(onRetryStarting/onRetryResuming)와 질의 승인 경로도 model_call_id
            // 없이 timestamp_ms 만 붙여 플러시하는데, 그 본문은 지금까지 스트리밍한
            // 내용을 그대로 다시 흘린다. 이미 보낸 본문의 꼬리와 정확히 겹치는 긴
            // 조각은 재생으로 보고 버린다 — 짧은 조각은 정상 반복일 수 있어 통과시킨다.
            if (text.length >= REPLAY_MIN_LENGTH && emittedTurnText.endsWith(text)) continue;
            emittedText = true;
            emittedTurnText += text;
            onEvent({ type: 'text-delta', agent: 'cursor', text });
          }
        }
        return;
      }
      if (type === 'tool_call') {
        const callId = String(e.call_id ?? '');
        const payload = e.tool_call && typeof e.tool_call === 'object' ? e.tool_call : {};
        const key = pickToolCallKey(payload);
        const inner = key ? payload[key] : null;
        const kind = key ? key.replace(/ToolCall$/, '') : 'tool';
        const tool = kind === 'mcp' ? mcpToolLabel(inner) : kind;
        // 서브에이전트 스폰은 도구 행이 아니라 task 카드로 표현한다.
        if (kind === 'task') {
          handleTaskToolCall(String(e.subtype ?? ''), callId, inner);
          return;
        }
        if (e.subtype === 'started') {
          onEvent({
            type: 'tool-call',
            agent: 'cursor',
            callId,
            tool,
            argsJson: JSON.stringify(toolCallArgs(kind, inner)),
          });
        } else if (e.subtype === 'completed') {
          const result = inner?.result;
          onEvent({
            type: 'tool-result',
            agent: 'cursor',
            callId,
            // 결과는 protobuf oneof 다 — 성공이면 success 멤버 하나만 실린다.
            // 실패 변형(rejected/permissionDenied/timeout/fileNotFound/noSpace …)에는
            // success 도 error 도 없으므로 success 키의 유무만으로 판정한다.
            ok: isSuccessResult(result),
            resultPreview: truncate(JSON.stringify(result ?? null)),
          });
        }
        return;
      }
      if (type === 'result') {
        lifecycle.markTurnCompleted();
        if (e.session_id) chatId = String(e.session_id);
        // 스키마 드리프트 안전장치: 델타가 하나도 안 왔으면 최종 결과 텍스트를 흘린다.
        if (!emittedText && typeof e.result === 'string' && e.result && !e.is_error) {
          onEvent({ type: 'text-delta', agent: 'cursor', text: e.result });
        }
        // usage 는 {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
        // camelCase 로 온다 — normalizeUsageTokens 가 네 필드를 모두 흡수한다.
        const usage = normalizeUsageTokens(e.usage);
        if (usage) onEvent({ type: 'usage', agent: 'cursor', model: currentModel, usage });
        // 아래 settleIfReady 가 정착 조건을 본다. 열린 카드가 있으면 턴을 붙들고,
        // 서브에이전트가 없던 턴은 지연 없이 여기서 닫힌다.
        pendingTurnResult = {
          stopReason: e.subtype ?? 'completed',
          errorMessage: e.is_error ? String(e.result) : undefined,
        };
        return;
      }
    };
    return (e) => {
      if (lifecycle.isDisposed()) return; // 폐기 후 죽어가는 CLI 가 흘리는 stdout 은 무시한다.
      // 새 stdout 라인 = CLI 가 아직 할 일이 있다 — 예약된 정착을 미룬다.
      clearSettleTimer();
      handleLine(e);
      settleIfReady();
    };
  }

  function emitNativeSessionInfo() {
    if (nativeSessionInfoEmitted || !chatId) return;
    nativeSessionInfoEmitted = true;
    onEvent({
      type: 'session-info',
      agent: 'cursor',
      sessionId: chatId,
      ...(currentModel ? { model: currentModel } : {}),
    });
  }

  /** ACP updates are projected onto the same compact event vocabulary as stream-json. */
  function handleNativeUpdate(update) {
    emitNativeSessionInfo();
    const kind = String(update?.sessionUpdate ?? '');
    if (kind === 'agent_message_chunk') {
      const text = typeof update.content?.text === 'string' ? update.content.text : '';
      if (text) onEvent({ type: 'text-delta', agent: 'cursor', text });
      return;
    }
    if (kind === 'usage_update') {
      const usage = normalizeUsageTokens(update.usage ?? update);
      if (usage) onEvent({ type: 'usage', agent: 'cursor', model: currentModel, usage });
      return;
    }
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return;
    const callId = String(update.toolCallId ?? '');
    if (!callId) return;
    const previous = acpToolState.get(callId) ?? {};
    const merged = { ...previous, ...update };
    acpToolState.set(callId, merged);
    const projected = projectAcpToolCall(merged);
    if (!projected) return;
    const argsJson = JSON.stringify(projected.args);
    const shouldEmit = !previous.emitted
      || (projected.tool === 'ask_user_question'
        && (previous.projectedTool !== 'ask_user_question' || previous.projectedArgsJson !== argsJson));
    if (shouldEmit) {
      merged.emitted = true;
      merged.projectedTool = projected.tool;
      merged.projectedArgsJson = argsJson;
      onEvent({
        type: 'tool-call',
        agent: 'cursor',
        callId,
        tool: projected.tool,
        argsJson,
      });
    }
    const status = String(merged.status ?? '');
    if ((status === 'completed' || status === 'failed') && !previous.finished) {
      merged.finished = true;
      onEvent({
        type: 'tool-result',
        agent: 'cursor',
        callId,
        ok: status === 'completed',
        resultPreview: truncate(JSON.stringify(update.rawOutput ?? update.content ?? null)),
      });
    }
  }

  function makeNativeSession() {
    const runtime = mcpRuntimeFor(opts);
    return createAcpSession({
      clientName: 'rhwp-cursor',
      command: opts.cursorBin ?? 'cursor-agent',
      args: ['acp'],
      cwd: opts.rootDir,
      env: (() => {
        const childEnv = isolatedProcessEnv(opts, opts.providerEnv ?? process.env);
        delete childEnv.CURSOR_CONFIG_DIR;
        return childEnv;
      })(),
      authMethodId: 'cursor_login',
      mcpServers: [acpMcpServer('rhwp', {
        ...runtime,
        env: {
          ...runtime.env,
          RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
          RHWP_AGENT_TOKEN: opts.token,
          RHWP_AGENT_NAME: 'cursor',
          ...mcpCapabilityEnv(opts),
        },
      })],
      resumeSessionId: chatId,
      getUnrestricted: () => opts.permissionProfile === 'unrestricted' && !isPlanningRestricted(opts),
      requestHandlers: [{
        method: CURSOR_ASK_QUESTION_METHOD,
        async handler(ctx) {
          const response = await handleCursorAskQuestionFrame(opts, {
            jsonrpc: '2.0', id: ctx.requestId,
            method: CURSOR_ASK_QUESTION_METHOD,
            params: ctx.params,
          }, ctx.signal);
          return response.result;
        },
      }],
      onSessionStarted(info) {
        chatId = String(info.sessionId);
        nativeSessionInfoEmitted = false;
      },
      onSessionUpdate: handleNativeUpdate,
    }, { spawnProcess, terminateProcess });
  }

  function prepareNativeHome() {
    if (!opts.isolatedHome) throw new Error('Cursor 세션에는 격리 홈이 필요합니다.');
    const sessionCursorDir = path.join(String(opts.isolatedHome), '.cursor');
    let sourceCliConfig = null;
    if (opts.cursorSourceDir) {
      try {
        sourceCliConfig = JSON.parse(readFileSync(path.join(String(opts.cursorSourceDir), 'cli-config.json'), 'utf8'));
      } catch {}
    }
    prepareCursorHome(sessionCursorDir, opts.cursorSourceDir, {
      mcpConfig: buildCursorMcpConfig(opts),
      cliConfig: buildCursorCliConfig(opts, sourceCliConfig),
    });
  }

  async function configureNativeMode() {
    await nativeRestart;
    if (!nativeSession) nativeSession = makeNativeSession();
    prepareNativeHome();
    const interactionMode = providerInteractionMode(opts);
    await nativeSession.configure({
      modeAliases: interactionMode === 'plan'
        ? ['plan', 'architect']
        : ['agent', 'code', 'default'],
      requireModeMatch: interactionMode === 'plan',
      model: opts.model === 'auto' ? null : opts.model,
      effort: opts.effort,
    });
    chatId = nativeSession.getSessionId() ?? chatId;
    return nativeSession;
  }

  function startLegacyTurn(prompt) {
    let proc;
    try {
      prepareNativeHome();
      const childEnv = isolatedProcessEnv(opts, opts.providerEnv ?? process.env);
      delete childEnv.CURSOR_CONFIG_DIR;
      proc = spawnProcess(opts.cursorBin ?? 'cursor-agent', buildCursorArgv(opts, chatId, prompt), {
        ...processTreeSpawnOptions(),
        cwd: opts.rootDir,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      lifecycle.failStart(e);
      return;
    }
    const token = ++turnToken;
    const finishOnClose = () => {
      if (token !== turnToken || lifecycle.isDisposed()) return;
      clearSettleTimer();
      clearExitSweepTimer();
      if (pendingTurnResult) {
        settleTurn();
        return;
      }
      sweepOpenTasks();
    };
    proc.on('close', finishOnClose);
    proc.on('exit', () => {
      if (token !== turnToken || lifecycle.isDisposed() || exitSweepTimer) return;
      exitSweepTimer = setTimeout(finishOnClose, TASK_SETTLE_GRACE_MS);
      exitSweepTimer.unref?.();
    });
    lifecycle.attachChild(proc, makeHandler());
  }

  async function runNativeTurn(prompt, token) {
    let promptStarted = false;
    try {
      const session = await configureNativeMode();
      // Transport selection is atomic at the prompt boundary. Once ACP owns
      // the turn, a provider/question failure must settle that turn instead of
      // replaying the same user message through the legacy transport.
      promptStarted = true;
      const response = await session.prompt(prompt);
      if (token !== nativeTurnToken || !lifecycle.isTurnOpen()) return;
      emitNativeSessionInfo();
      lifecycle.markTurnCompleted();
      const usage = normalizeUsageTokens(response?.usage);
      if (usage) onEvent({ type: 'usage', agent: 'cursor', model: currentModel, usage });
      pendingTurnResult = {
        stopReason: response?.stopReason ?? 'end_turn',
        errorMessage: response?.stopReason === 'refusal' ? 'Cursor refused the request.' : undefined,
      };
      settleIfReady();
    } catch (error) {
      if (token !== nativeTurnToken || !lifecycle.isTurnOpen()) return;
      if (!promptStarted) {
        nativeDisabled = true;
        const failed = nativeSession;
        nativeSession = null;
        try { await failed?.dispose(); } catch {}
        startLegacyTurn(prompt);
        return;
      }
      onEvent({ type: 'error', agent: 'cursor', message: error?.message ?? String(error) });
      lifecycle.endTurn({ type: 'turn-end', agent: 'cursor', stopReason: 'failed' });
    }
  }

  return {
    agent: 'cursor',
    getSessionId() {
      return chatId;
    },
    sendUserMessage(text) {
      if (lifecycle.isDisposed()) return;
      resetTurnTaskState();
      acpToolState.clear();
      lifecycle.beginTurn();

      const mode = normalizeExecutionMode(opts);
      const prompt = chatId && mode.workflow === 'direct'
        ? text
        : systemBriefFor(opts, 'cursor') + '\n\n' + text;

      if (Buffer.byteLength(prompt, 'utf8') > PROMPT_BYTE_LIMIT) {
        // 이 크기를 넘기면 CLI 가 아무 출력 없이 죽거나 spawn 이 E2BIG 으로 실패한다.
        onEvent({
          type: 'error',
          agent: 'cursor',
          message: '메시지가 너무 커서 Cursor CLI 인자로 전달할 수 없습니다. 내용을 나눠 보내 주세요.',
        });
        lifecycle.endTurn({ type: 'turn-end', agent: 'cursor', stopReason: 'failed' });
        return;
      }
      if (nativeDisabled) {
        startLegacyTurn(prompt);
        return;
      }
      const token = ++nativeTurnToken;
      void runNativeTurn(prompt, token);
    },
    async setPermissionProfile(profile) {
      if (lifecycle.isTurnOpen()) throw new Error('Permission profile can only change between turns');
      if (profile !== 'safe' && profile !== 'unrestricted') throw new Error(`Unknown permission profile: ${profile}`);
      const previous = opts.permissionProfile;
      const previousNativeSession = nativeSession;
      const previousChatId = chatId;
      opts.permissionProfile = profile;
      try {
        if (nativeSession) {
          const session = nativeSession;
          nativeRestart = nativeRestart.then(() => session.restart());
          await nativeRestart;
        }
        if (!nativeDisabled && providerInteractionMode(opts) === 'plan') {
          await configureNativeMode();
        }
      } catch (error) {
        opts.permissionProfile = previous;
        nativeRestart = Promise.resolve();
        if (!previousNativeSession && nativeSession) {
          const failed = nativeSession;
          nativeSession = null;
          chatId = previousChatId;
          try { await failed.dispose(); } catch {}
        }
        throw error;
      }
    },
    async setExecutionMode(mode) {
      if (lifecycle.isTurnOpen()) throw new Error('Execution mode can only change between turns');
      validateExecutionMode(mode);
      const previous = normalizeExecutionMode(opts);
      const previousNativeSession = nativeSession;
      const previousChatId = chatId;
      lifecycle.killChild();
      await lifecycle.waitForChildExit();
      opts.workflow = mode.workflow;
      opts.phase = mode.phase;
      opts.capabilityEpoch = mode.capabilityEpoch;
      try {
        if (nativeSession) {
          const session = nativeSession;
          nativeRestart = nativeRestart.then(() => session.restart());
          await nativeRestart;
        }
        // The UI must not observe Plan until ACP has started and advertised a
        // selectable Plan/Architect mode. Legacy-only sessions are covered by
        // the explicit CLI --mode plan contract instead.
        if (!nativeDisabled && providerInteractionMode(opts) === 'plan') {
          await configureNativeMode();
        }
      } catch (error) {
        opts.workflow = previous.workflow;
        opts.phase = previous.phase;
        opts.capabilityEpoch = previous.capabilityEpoch;
        nativeRestart = Promise.resolve();
        if (!previousNativeSession && nativeSession) {
          const failed = nativeSession;
          nativeSession = null;
          chatId = previousChatId;
          try { await failed.dispose(); } catch {}
        }
        throw error;
      }
    },
    interrupt() {
      // 열린 task 를 먼저 stopped 로 닫고 turn-end 를 낸다.
      clearSettleTimer();
      clearExitSweepTimer();
      pendingTurnResult = null;
      sweepOpenTasks();
      nativeTurnToken += 1;
      if (!nativeDisabled) void nativeSession?.cancel().catch(() => {});
      lifecycle.interrupt();
    },
    async dispose() {
      clearSettleTimer();
      clearExitSweepTimer();
      nativeTurnToken += 1;
      const [, legacy] = await Promise.allSettled([nativeSession?.dispose(), lifecycle.dispose()]);
      return legacy.status === 'fulfilled' ? legacy.value : false;
    },
  };
}
