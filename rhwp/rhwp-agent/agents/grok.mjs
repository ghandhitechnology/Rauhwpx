// cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
import spawn from 'cross-spawn';
import crypto from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
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
  RHWP_SUBAGENTS,
  systemBriefFor,
  truncate,
  validateExecutionMode,
} from './backend.mjs';
import { createGrokSessionTail } from './grok-session-tail.mjs';
import { acpMcpServer, createPersistentAcpSession } from './acp-session.mjs';
import {
  GROK_ASK_USER_QUESTION_METHODS,
  decodeGrokAskUserQuestionFrame,
  encodeGrokAskUserQuestionFrame,
  handleGrokAskUserQuestionFrame,
  selectGrokUserInputTransport,
} from './provider-user-input.mjs';
export {
  GROK_ASK_USER_QUESTION_METHODS,
  decodeGrokAskUserQuestionFrame,
  encodeGrokAskUserQuestionFrame,
  handleGrokAskUserQuestionFrame,
  selectGrokUserInputTransport,
};
import {
  isolatedProcessEnv,
  processTreeSpawnOptions,
  terminateProcessTree,
} from '../process-tree.mjs';

/** grok compat 스캐너가 읽는 외부 벤더 아티팩트 종류 — 전부 끈다. */
const COMPAT_KEYS = ['skills', 'rules', 'agents', 'mcps', 'hooks', 'sessions'];
/** MCP 결과 인라인 상한. 기본값 20 KB 는 rhwp 도구 결과(export_svg 800 KB)에 턱없이 작다. */
const MCP_MAX_OUTPUT_BYTES = 1_000_000;

/**
 * 세션 전용 GROK_HOME 을 만들고 공유 로그인 파일(auth.json)을 심볼릭 링크로 심는다.
 * OS 가 임시 부모 디렉터리를 지웠어도 매 스폰마다 복구된다.
 *
 * @param {string} grokHome
 * @param {string} [authPath]
 */
export function prepareGrokHome(grokHome, authPath, {
  copyFile = copyFileSync,
  platform = process.platform,
  symlink = symlinkSync,
} = {}) {
  mkdirSync(grokHome, { recursive: true });
  if (!authPath) return;

  let authStat;
  try {
    authStat = lstatSync(authPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!authStat.isFile() || authStat.isSymbolicLink()) return;

  const target = path.join(grokHome, 'auth.json');
  try {
    const targetStat = lstatSync(target);
    if (!targetStat.isSymbolicLink()) return;
    const existingTarget = path.resolve(grokHome, readlinkSync(target));
    if (existingTarget === path.resolve(authPath)) return;
    unlinkSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    symlink(authPath, target);
  } catch (error) {
    if (platform !== 'win32' || error?.code !== 'EPERM') throw error;
    copyFile(authPath, target);
  }
}

/** TOML 기본 문자열 — 이 값 범위에서는 JSON 문자열 이스케이프가 그대로 유효하다. */
function tomlString(value) {
  return JSON.stringify(String(value));
}

/**
 * 세션 GROK_HOME 에 쓸 config.toml 내용을 만든다.
 * 자동 업데이트/텔레메트리를 끄고, 호스트의 Claude/Cursor 설정(스킬·규칙·MCP·훅)
 * 흡수를 전부 차단한 뒤 rhwp MCP 서버만 등록한다.
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 */
export function buildGrokConfigToml(opts) {
  const runtime = mcpRuntimeFor(opts);
  const mcpEnv = {
    ...runtime.env,
    RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
    RHWP_AGENT_TOKEN: opts.token,
    RHWP_AGENT_NAME: 'grok',
    ...mcpCapabilityEnv(opts),
  };
  const compatOff = COMPAT_KEYS.map((key) => `${key} = false`);
  return [
    '[cli]',
    'auto_update = false',
    '',
    '[features]',
    'telemetry = false',
    '',
    '[toolset.ask_user_question]',
    'timeout_enabled = false',
    '',
    '[compat.claude]',
    ...compatOff,
    '',
    '[compat.cursor]',
    ...compatOff,
    '',
    '[mcp]',
    `max_output_bytes = ${MCP_MAX_OUTPUT_BYTES}`,
    '',
    '[mcp_servers.rhwp]',
    `command = ${tomlString(runtime.command)}`,
    `args = [${runtime.args.map(tomlString).join(', ')}]`,
    'startup_timeout_sec = 20',
    '',
    '[mcp_servers.rhwp.env]',
    ...Object.entries(mcpEnv).map(([key, value]) => `${key} = ${tomlString(value)}`),
    '',
  ].join('\n');
}

/**
 * 스코프 셸 접두사는 인터프리터 + 절대 스크립트 경로여야 한다.
 * `python3` / `python` 같은 맨 이름만 오면 `python3 -c` 가 열려 무시한다.
 *
 * @param {unknown} prefixes
 * @returns {string[]}
 */
export function pinnedShellAllowPrefixes(prefixes) {
  return (Array.isArray(prefixes) ? prefixes : [])
    .map((prefix) => String(prefix).trim())
    .filter((prefix) => {
      if (!prefix) return false;
      const tokens = prefix.replaceAll('"', '').split(/\s+/).filter(Boolean);
      return tokens.length >= 2 && path.isAbsolute(tokens[1]);
    });
}

/**
 * grok Bash 규칙. 접두사 자체와 그 뒤 공백+인자만 허용한다.
 *
 * @param {string[]} prefixes
 * @returns {string[]}
 */
export function scopedBashAllowRules(prefixes) {
  return prefixes.flatMap((prefix) => [`Bash(${prefix})`, `Bash(${prefix} *)`]);
}

/**
 * grok 헤드리스 인자를 만든다. 프롬프트는 --prompt-file 로 전달한다 —
 * '-' 로 시작하는 메시지의 플래그 오파싱과 ARG_MAX 초과를 함께 막는다.
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 * @param {string} sessionId
 * @param {boolean} resume
 * @param {string} promptFilePath
 */
export function buildGrokArgv(opts, sessionId, resume, promptFilePath) {
  const unrestricted = opts.permissionProfile === 'unrestricted';
  const planningRestricted = isPlanningRestricted(opts);
  const interactionMode = providerInteractionMode(opts);
  const rootGlob = `${String(opts.rootDir ?? '').replace(/\\/g, '/')}/**`;
  // 백그라운드 작업자(복사 레이아웃 등)가 헬퍼 스크립트를 실행할 수 있게 풀어 주는
  // 스코프 셸 접두사. grok 규칙은 glob 이고 deny 가 allow 보다 우선하므로(~/.grok
  // README "Permission Rules"), 전면 --deny Bash 를 유지한 채로는 스코프 허용이
  // 죽는다 — 이 모드에서는 Bash deny 를 빼고 dontAsk 의 allowlist 폐쇄성(허용
  // 목록 밖은 무프롬프트 거부)으로 경계를 유지한다. 접두사는 `python3 /abs/helper.py`
  // 처럼 인터프리터+절대 경로여야 한다. `python3*` 는 `python3 -c` 와 임의 스크립트까지
  // 열리므로 버린다. 규칙은 `Bash(prefix)` 와 `Bash(prefix *)` 로만 연다 — 끝에 * 를
  // 붙이면 helper.pyevil 같은 이웃 경로도 맞는다. 대화형 안전 채팅에는 이 옵션이
  // 없으므로 기존 전면 deny 가 그대로 간다.
  const shellAllowPrefixes = pinnedShellAllowPrefixes(opts.shellAllowPrefixes);
  const scopedShell = shellAllowPrefixes.length > 0 && !planningRestricted;
  const allowRules = [
    `Read(${rootGlob})`,
    ...(planningRestricted ? [] : [`Edit(${rootGlob})`]),
    'Grep', 'WebFetch', 'WebSearch', 'MCPTool(rhwp__*)',
    ...(scopedShell ? scopedBashAllowRules(shellAllowPrefixes) : []),
  ];
  // --sandbox 는 붙이지 않는다: grok 1.0.5 의 macOS seatbelt 샌드박스는 프로필을
  // 적용한 직후 기동 전에 멈춰(무한 대기, 출력 없음) 턴이 영원히 끝나지 않는다.
  // CLI 가 이 문제를 고칠 때까지 이 플래그는 꺼 둔다.
  // dontAsk 의 실제 의미(1.0.5 라이브 확인): allow 목록과 내장 읽기 전용
  // 목록만 통과시키고 나머지는 프롬프트 없이 거부한다. 단, whoami/ls/cat 같은
  // 내장 읽기 전용 셸 명령은 --allow 없이도 "모든 모드에서" 실행되므로 allow
  // 목록만으로는 셸이 닫히지 않는다 — 안전 프로필은 --deny Bash 로 셸을
  // 통째로 막는다(deny 가 읽기 전용 목록보다 우선, "deny rule on bash" 라이브
  // 확인). deny 는 서브에이전트에도 상속된다. 문서 작업은 MCP 도구로 충분하고,
  // 셸이 필요하면 전체 접근을 쓴다. 계획 단계는 편집도 막는다 — --deny Edit 가
  // grok 의 search_replace 와 write 를 모두 차단하고("deny rule on edit" 라이브
  // 확인), --deny Write 는 명시적 이중 안전장치로 함께 붙인다.
  const denyRules = [
    // 스코프 셸 모드에서는 Bash deny 가 허용 접두사를 이기므로 빼고, 대신
    // 고정 헬퍼 접두사 밖의 모든 셸을 dontAsk 가 거부하게 둔다.
    ...(scopedShell ? [] : ['Bash']),
    ...(planningRestricted ? ['Edit', 'Write'] : []),
  ];
  const alwaysApprove = unrestricted && !planningRestricted;
  const permission = alwaysApprove
    ? ['--always-approve']
    : [
      '--permission-mode', interactionMode === 'plan' ? 'plan' : 'dontAsk',
      ...allowRules.flatMap((rule) => ['--allow', rule]),
      ...denyRules.flatMap((rule) => ['--deny', rule]),
    ];
  return [
    '--prompt-file', promptFilePath,
    '--output-format', 'streaming-messages-json',
    '--include-partial-messages',
    '--no-auto-update',
    ...(resume ? ['-r', sessionId] : ['-s', sessionId]),
    '--append-system-prompt', systemBriefFor(opts, 'grok'),
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.effort ? ['--reasoning-effort', opts.effort] : []),
    ...permission,
    // 서브에이전트는 전체 접근(--always-approve)에서만 켠다. rhwp 전용 정의는
    // claude 와 공유한다 — grok 1.0.5 가 claude 스키마 --agents 를 그대로 수용한다
    // (라이브 확인). dontAsk(안전·계획) 아래에서 켜면 안 된다: spawn_subagent 는
    // 권한 규칙 클래스 밖이라 승인 프롬프트가 자동 취소되고("User cancelled",
    // --allow Agent/Task/spawn_subagent 전부 무효, PreToolUse 훅도 deny/block
    // 결정만 지원) 그 오류가 턴 전체를 실패시켜 스테이징 편집이 통째로
    // 되돌아간다. dontAsk 조합은 도구 자체를 꺼서(--no-subagents) 모델이 시도조차
    // 못 하게 하고, backend.mjs 의 브리프도 같은 조건에서 병렬 안내를 뺀다.
    ...(alwaysApprove
      ? ['--agents', JSON.stringify(RHWP_SUBAGENTS)]
      : ['--no-subagents']),
  ];
}

/**
 * 자식 프로세스 환경. 격리 홈 위에 세션 전용 GROK_HOME 을 얹고
 * 자동 업데이트와 크로스 세션 메모리를 강제로 끈다.
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 */
export function buildGrokEnv(opts, sourceEnv = opts.providerEnv ?? process.env) {
  const grokHome = opts.grokHome ?? sourceEnv.GROK_HOME ?? path.join(os.homedir(), '.grok');
  return {
    ...isolatedProcessEnv(opts, sourceEnv),
    GROK_HOME: String(grokHome),
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_MEMORY: '0',
  };
}

/**
 * CLI stderr 를 사용자에게 보여줄 짧은 이유로 바꾼다. MCP 설정에 박힌 세션
 * 토큰은 지운다.
 *
 * @param {string} stderrText
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @param {string} token
 */
export function formatGrokExitError(stderrText, code, signal, token) {
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
    ? `Grok 실행이 중단되었습니다 (${exit}).\n${truncate(detail, 1200)}`
    : `Grok 실행이 중단되었습니다 (${exit}). Grok이 오류 설명을 제공하지 않았습니다.`;
}

/** 서브에이전트 스폰/수거/중단 메타 도구 — 도구 행 대신 task 이벤트로 표현한다. */
const SUBAGENT_META_TOOLS = new Set([
  'spawn_subagent', 'get_command_or_subagent_output', 'kill_command_or_subagent',
]);
/**
 * fleet 턴의 정착 유예. pending 이 비워진 뒤에도 grok 이 will_wake 재호출이나
 * 늦은 디스크 flush 를 이어갈 수 있다 — 짧은 정적 후에만 턴을 닫는다
 * (claude 의 TASK_SETTLE_GRACE_MS 와 같은 패턴).
 */
const TASK_SETTLE_GRACE_MS = 1_500;
/**
 * 스폰 결과 문자열에서 subagent_id 를 뽑는다. 배경 스폰("subagent_id: <id>")과
 * 블로킹 스폰('"subagent_id":"<id>"') 둘 다 이 모양을 지난다 (캡처 확인).
 */
const SUBAGENT_ID_RE = /subagent_id[^0-9a-fA-F]{0,4}([0-9a-fA-F][0-9a-fA-F-]{19,})/;
/**
 * 디스크 전환의 잠정 상태 동안 보류하는 stdout 본문 상한 (~512KB). 스폰 성공이
 * 확인되면 버리고(디스크가 진실), 스폰이 무산되면 그대로 되살린다.
 */
const STDOUT_BUFFER_MAX_CHARS = 512 * 1024;
/**
 * 스폰 성공 확인 대기 상한. 디스크 flush 는 라이브에서 스폰 뒤 ~3초 안에
 * 관측됐다 — 10초 동안 디스크 라인이 하나도 없고 살아 있는 자식도 없으면
 * updates.jsonl 이 끝내 나타나지 않는 경우로 보고 stdout 출처로 되돌린다.
 */
const DISK_CONFIRM_TIMEOUT_MS = 10_000;

/**
 * 도구 결과 미리보기. grok 은 결과 content 를 보통 문자열로 주지만, 권한 거부
 * 결과는 [{type:'content',content:{type:'text',text}}] 배열이고(라이브 확인),
 * 디스크 rawOutput 은 {type:'Text',text} 객체다 — 세 모양을 모두 받는다.
 *
 * @param {any} raw
 */
export function grokResultPreview(raw) {
  if (typeof raw === 'string') return truncate(raw);
  if (Array.isArray(raw)) {
    const texts = raw
      .map((item) => (typeof item?.content?.text === 'string' ? item.content.text
        : (typeof item?.text === 'string' ? item.text : '')))
      .filter(Boolean);
    if (texts.length > 0) return truncate(texts.join('\n'));
  }
  if (raw && typeof raw === 'object' && raw.type === 'Text' && typeof raw.text === 'string') {
    return truncate(raw.text);
  }
  return truncate(JSON.stringify(raw ?? null));
}

/** summary 는 출력의 꼬리에 결론이 담긴다 — 앞이 아니라 뒤를 남긴다. */
function tailTruncate(value, max = 500) {
  const str = String(value);
  return str.length > max ? '…' + str.slice(-max) : str;
}

/** subagent_finished.status → 정규화된 3상태. 실패 상태는 라이브에서 미관측 —
 * completed/중단류 밖은 전부 실패로 접는다. */
function normalizeGrokTaskStatus(status) {
  const s = String(status ?? '');
  if (s === 'completed') return 'completed';
  if (s === 'cancelled' || s === 'killed' || s === 'stopped' || s === 'interrupted') return 'stopped';
  return 'failed';
}

/** mcp__rhwp__/rhwp__ 접두사를 벗긴 표시용 도구 이름. */
function stripRhwpPrefix(name) {
  return String(name ?? '').replace(/^(?:mcp__rhwp__|rhwp__)/, '');
}

/**
 * 턴마다 새로 스폰하고(코덱스 수명주기) Anthropic Messages 와이어 포맷 스트림을
 * 파싱한다(클로드 이벤트 처리). 서브에이전트가 스폰되면 stdout 은 귀속 불명이
 * 되므로(자식 본문이 루트 블록에 붙음) 그 시점부터 본문/도구 이벤트의 출처를
 * 디스크의 updates.jsonl 로 전환한다 — grok-session-tail.mjs 참고.
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createGrokSession(opts, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
  createSessionTail = createGrokSessionTail,
  createAcpSession = createPersistentAcpSession,
  now = Date.now,
} = {}) {
  const rawOnEvent = opts.onEvent;
  /**
   * turn-end 가 어느 경로(정착 타이머, result 즉시 종료, 프로세스 close 판정,
   * 인터럽트)로 나가든 그 앞에서 디스크 꼬리를 마지막으로 수확하고 남은 task 를
   * stopped 로 쓸어 낸다 — 어떤 턴도 열린 task 를 남기고 끝나지 않는다.
   */
  const onEvent = (evt) => {
    if (evt?.type === 'turn-end' && fleetActive) {
      clearSettleTimer();
      try { tail?.drain(); } catch {}
      // 드레인이 전환을 확정하지 못한 채 턴이 닫힌다 — 보류한 stdout 본문을
      // 되살려 어느 경로로든 루트 본문이 정확히 한 번 렌더되게 한다.
      revertToStdoutSource();
      sweepPendingTasks();
      stopTail();
      fleetActive = false;
    }
    rawOnEvent(evt);
  };
  const lifecycle = createTurnProcessLifecycle({
    agent: 'grok',
    onEvent,
    formatExitError: (stderrText, code, signal) => formatGrokExitError(stderrText, code, signal, opts.token),
    terminateProcess,
  });

  /** @type {string} */
  let sessionId = crypto.randomUUID();
  let hasCompletedTurn = false;
  // -s 는 한 번 스폰에 쓰면 소진된다: 그 스폰이 turn 을 완료하지 못한 채 죽으면
  // 같은 UUID 재사용이 "already exists" 로 영구히 실패한다. 재스폰 시 완료된
  // turn 이 없으면 새 UUID 를 발급한다.
  let sessionIdConsumed = false;
  let sawRootTextDelta = false;
  const streamedSubagents = new Set();
  // usage 집계에 붙일 모델 — CLI 가 보고한 실제 모델을 우선한다.
  let currentModel = opts.model ?? null;
  let nativeDisabled = selectGrokUserInputTransport(opts, {
    transport: 'acp',
    methods: GROK_ASK_USER_QUESTION_METHODS,
    askUserTimeoutDisabled: true,
  }).transport !== 'native-acp';
  /** @type {ReturnType<typeof createPersistentAcpSession>|null} */
  let nativeSession = null;
  let nativeRestart = Promise.resolve();
  let nativeTurnToken = 0;
  let nativeSessionInfoEmitted = false;

  // ── 서브에이전트 fleet 상태 ─────────────────────────────────────
  // subagent_id → 방출한 taskId (스폰 tool_use id). 늦은 디스크 라인 대비
  // 세션 수명 동안 유지, 긴 세션 대비 상한 512 (claude 와 동일).
  const taskIdBySubagent = new Map();
  // 이하는 턴 단위 상태 — resetTurnFleetState 가 초기화한다.
  let fleetActive = false; // turn-end 가로채기용 — 턴이 살아 있는 동안 true.
  let diskMode = false; // 첫 spawn_subagent 이후 true: 본문/도구 출처가 디스크다.
  // 전환은 스폰 성공이 확인될 때까지 잠정적이다: 거부된 스폰(dontAsk 취소,
  // 알 수 없는 타입)이나 끝내 나타나지 않는 updates.jsonl 이 턴의 나머지를
  // 빈 화면으로 만들면 안 된다. 확인 신호는 둘 — 스폰 tool_result 성공,
  // 디스크의 subagent_spawned.
  let diskConfirmed = false;
  let diskEventSeen = false; // 이번 턴 타임스탬프를 통과한 디스크 라인이 있었는가.
  const stdoutBuffer = []; // 잠정 구간에 보류한 stdout 이벤트 (확정 시 폐기).
  let bufferedTextChars = 0;
  let preSwitchTextLen = 0; // 전환 시점까지 방출한 루트 본문 길이 — 복원 dedup 기준.
  let stdoutSkipChars = 0; // 복원 뒤 stdout 델타에서 건너뛸(디스크가 이미 낸) 글자 수.
  /** @type {ReturnType<typeof setTimeout> | null} */
  let confirmTimer = null;
  let emittedTurnText = ''; // 이번 턴에 방출한 루트 본문 전체 (stdout+디스크, dedup 기준).
  let diskSkipChars = 0; // 디스크 본문에서 건너뛸 이미 방출된 글자 수.
  const emittedToolCalls = new Set(); // 전환 전 stdout 으로 낸 tool-call id.
  const emittedToolResults = new Set(); // 전환 전 stdout 으로 낸 tool-result id.
  const toolNameByCallId = new Map(); // 디스크 tool_call_update 억제 판단용.
  const pendingTasks = new Set(); // 아직 안 끝난 taskId — 남아 있으면 턴을 닫지 않는다.
  /** @type {Map<string, {taskId:string, title:string, mapped:boolean}>} */
  const pendingSpawnByCallId = new Map();
  /** @type {string[]} 스폰 순서 — subagent_id 매핑의 FIFO 폴백. */
  const spawnOrder = [];
  let tasksSeenThisTurn = 0;
  let resultSeen = false;
  let lastStopReason;
  /** @type {string | undefined} */
  let resultErrorMessage;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let settleTimer = null;
  /** @type {ReturnType<typeof createSessionTail> | null} */
  let tail = null;
  let turnGrokHome = '';
  let turnStartMs = 0;

  function clearSettleTimer() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  function clearConfirmTimer() {
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
  }

  function stopTail() {
    try { tail?.stop(); } catch {}
    tail = null;
  }

  function sweepPendingTasks() {
    for (const taskId of pendingTasks) {
      rawOnEvent({ type: 'task-end', agent: 'grok', taskId, status: 'stopped' });
    }
    pendingTasks.clear();
  }

  function resetTurnFleetState() {
    clearSettleTimer();
    clearConfirmTimer();
    stopTail();
    fleetActive = true;
    diskMode = false;
    diskConfirmed = false;
    diskEventSeen = false;
    stdoutBuffer.length = 0;
    bufferedTextChars = 0;
    preSwitchTextLen = 0;
    stdoutSkipChars = 0;
    emittedTurnText = '';
    diskSkipChars = 0;
    emittedToolCalls.clear();
    emittedToolResults.clear();
    toolNameByCallId.clear();
    pendingTasks.clear();
    pendingSpawnByCallId.clear();
    spawnOrder.length = 0;
    tasksSeenThisTurn = 0;
    resultSeen = false;
    lastStopReason = undefined;
    resultErrorMessage = undefined;
  }

  /** result 가 담아 온 정보로 턴을 닫는다 — onEvent 래퍼가 잔여 task 를 정리한다. */
  function settleTurn() {
    lifecycle.endTurn({
      type: 'turn-end',
      agent: 'grok',
      stopReason: lastStopReason ?? 'completed',
      errorMessage: resultErrorMessage,
    });
  }

  function scheduleSettle() {
    clearSettleTimer();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      settleTurn();
    }, TASK_SETTLE_GRACE_MS);
    settleTimer.unref?.();
  }

  /** 디스크 활동이 잦아든 뒤에만 fleet 턴을 닫는다. */
  function maybeScheduleSettle() {
    if (fleetActive && lifecycle.isTurnOpen() && resultSeen
      && tasksSeenThisTurn > 0 && pendingTasks.size === 0) {
      scheduleSettle();
    }
  }

  function rememberSubagentTaskId(subagentId, taskId) {
    taskIdBySubagent.set(String(subagentId), taskId);
    if (taskIdBySubagent.size > 512) {
      taskIdBySubagent.delete(taskIdBySubagent.keys().next().value);
    }
  }

  /** 스폰 tool_use 블록 → task-start. taskId 는 스폰 tool_use id 로 고정하고
   * subagent_id 는 내부에서만 이 taskId 로 번역한다. */
  function startTask(block) {
    const callId = String(block.id ?? '');
    const input = block.input ?? {};
    const title = String(input.description ?? '').trim()
      || truncate(String(input.prompt ?? '').split('\n')[0], 80)
      || '서브에이전트';
    toolNameByCallId.set(callId, 'spawn_subagent');
    pendingSpawnByCallId.set(callId, { taskId: callId, title, mapped: false });
    spawnOrder.push(callId);
    pendingTasks.add(callId);
    tasksSeenThisTurn++;
    onEvent({
      type: 'task-start',
      agent: 'grok',
      taskId: callId,
      callId,
      title,
      ...(input.subagent_type ? { role: String(input.subagent_type) } : {}),
      taskKind: 'agent',
    });
  }

  /**
   * subagent_id 를 이번 턴의 스폰과 잇는다. 설명이 일치하는 미매핑 스폰을
   * 우선하고, 없으면 FIFO. stdout 이 스폰 tool_use 를 흘리지 못한 방어 경로에서는
   * 디스크가 처음 알린 스폰을 subagent_id 그대로 task 로 세운다.
   */
  function mapSubagent(subagentId, info) {
    if (!subagentId || taskIdBySubagent.has(subagentId)) return;
    /** @type {{taskId:string, title:string, mapped:boolean}|null} */
    let entry = null;
    const description = typeof info?.description === 'string' ? info.description : '';
    if (description) {
      for (const callId of spawnOrder) {
        const candidate = pendingSpawnByCallId.get(callId);
        if (candidate && !candidate.mapped && candidate.title === description) {
          entry = candidate;
          break;
        }
      }
    }
    if (!entry) {
      for (const callId of spawnOrder) {
        const candidate = pendingSpawnByCallId.get(callId);
        if (candidate && !candidate.mapped) {
          entry = candidate;
          break;
        }
      }
    }
    if (entry) {
      entry.mapped = true;
      rememberSubagentTaskId(subagentId, entry.taskId);
      return;
    }
    pendingTasks.add(subagentId);
    tasksSeenThisTurn++;
    rememberSubagentTaskId(subagentId, subagentId);
    onEvent({
      type: 'task-start',
      agent: 'grok',
      taskId: subagentId,
      title: description || '서브에이전트',
      ...(info?.subagent_type ? { role: String(info.subagent_type) } : {}),
      taskKind: 'agent',
    });
  }

  /** 스폰 tool_result 본문에서 subagent_id 를 뽑아 해당 스폰에 잇는다. */
  function mapSubagentFromSpawnResult(callId, rawText) {
    const match = SUBAGENT_ID_RE.exec(String(rawText ?? ''));
    if (!match) return;
    const subagentId = match[1];
    if (taskIdBySubagent.has(subagentId)) return;
    const entry = pendingSpawnByCallId.get(callId);
    if (!entry || entry.mapped) return;
    entry.mapped = true;
    rememberSubagentTaskId(subagentId, entry.taskId);
  }

  /** 스폰 자체가 실패했다(알 수 없는 subagent_type 등) — 자식은 뜨지 않았다. */
  function failSpawnTask(callId, message) {
    const entry = pendingSpawnByCallId.get(callId);
    if (!entry || !pendingTasks.delete(entry.taskId)) return;
    entry.mapped = true;
    onEvent({
      type: 'task-end',
      agent: 'grok',
      taskId: entry.taskId,
      status: 'failed',
      ...(message ? { summary: tailTruncate(message) } : {}),
    });
  }

  /** subagent_finished → task-end. 자식 내부의 도구 실패는 스폰 실패가 아니다 —
   * status 필드만 믿는다 (라이브 확인: 자식 read_file 오류에도 completed). */
  function endTask(update) {
    const subagentId = String(update.subagent_id ?? '');
    mapSubagent(subagentId, update); // spawned 라인을 놓친 배치 flush 방어.
    const taskId = taskIdBySubagent.get(subagentId);
    if (!taskId || !pendingTasks.delete(taskId)) return;
    const usage = normalizeTaskUsage({
      total_tokens: update.tokens_used,
      tool_uses: update.tool_calls,
      duration_ms: update.duration_ms,
    });
    onEvent({
      type: 'task-end',
      agent: 'grok',
      taskId,
      status: normalizeGrokTaskStatus(update.status),
      ...(update.output ? { summary: tailTruncate(update.output) } : {}),
      ...(usage ? { usage } : {}),
    });
  }

  /** subagent_progress 는 바이너리에 정의만 있고 관측된 적 없다 — 방어적 매핑. */
  function progressTask(update) {
    const taskId = taskIdBySubagent.get(String(update.subagent_id ?? ''));
    if (!taskId || !pendingTasks.has(taskId)) return;
    const usage = normalizeTaskUsage({
      tool_uses: update.tool_call_count,
      duration_ms: update.duration_ms,
    });
    if (!usage) return;
    onEvent({ type: 'task-progress', agent: 'grok', taskId, usage });
  }

  /** 디스크 tool_call/tool_call_update 를 tool-call/tool-result 로 바꾼다.
   * 스폰/수거/중단 메타 도구는 task 이벤트가 대신하므로 억제한다. */
  function routeDiskToolUpdate(update, parentTaskId) {
    const kind = String(update.sessionUpdate ?? '');
    if (kind === 'tool_call') {
      const callId = String(update.toolCallId ?? '');
      let name = String(update._meta?.['x.ai/tool']?.name ?? update.title ?? '');
      if (callId) toolNameByCallId.set(callId, name);
      if (SUBAGENT_META_TOOLS.has(name)) return;
      if (emittedToolCalls.has(callId)) return; // 전환 전에 stdout 으로 이미 냈다.
      let input = update.rawInput ?? {};
      if (name === 'use_tool' && typeof input?.tool_name === 'string') {
        name = String(input.tool_name);
        input = input.tool_input ?? {};
      }
      emittedToolCalls.add(callId);
      onEvent({
        type: 'tool-call',
        agent: 'grok',
        callId,
        tool: stripRhwpPrefix(name),
        argsJson: JSON.stringify(input),
        ...(parentTaskId ? { parentTaskId } : {}),
      });
      return;
    }
    // tool_call_update 는 rawInput 보강 틱(status 없음)과 종결 틱(completed/failed)이
    // 섞여 온다 — 종결 틱만 결과로 삼는다 (라이브 확인).
    const status = String(update.status ?? '');
    if (status !== 'completed' && status !== 'failed') return;
    const callId = String(update.toolCallId ?? '');
    const spawn = pendingSpawnByCallId.get(callId);
    if (spawn) {
      if (status === 'failed') {
        failSpawnTask(callId, grokResultPreview(update.content ?? update.rawOutput));
        maybeRevertAfterSpawnFailure();
      } else {
        mapSubagentFromSpawnResult(callId, JSON.stringify(update.rawOutput ?? update.content ?? null));
        confirmDiskSource(); // 스폰 성공 — 전환 확정.
      }
      return;
    }
    if (SUBAGENT_META_TOOLS.has(toolNameByCallId.get(callId) ?? '')) return;
    if (emittedToolResults.has(callId)) return;
    emittedToolResults.add(callId);
    onEvent({
      type: 'tool-result',
      agent: 'grok',
      callId,
      ok: status === 'completed',
      resultPreview: grokResultPreview(update.rawOutput ?? update.content),
      ...(parentTaskId ? { parentTaskId } : {}),
    });
  }

  function routeParentDiskUpdate(update) {
    const kind = String(update.sessionUpdate ?? '');
    if (kind === 'agent_message_chunk') {
      const text = typeof update.content?.text === 'string' ? update.content.text : '';
      if (!text) return;
      // 전환 전에 stdout 으로 이미 흘린 앞부분은 건너뛴다. 디스크 chunk 는 메시지
      // 단위 통짜(메시지 완성 시점 flush)라 stdout 델타와 경계가 다르므로 글자
      // 수로 자른다 — 디스크 본문과 stdout 루트 본문이 동일함은 라이브로 확인
      // (2,091자 에세이가 stdout 델타 460개 == 디스크 chunk 1개).
      if (diskSkipChars >= text.length) {
        diskSkipChars -= text.length;
        return;
      }
      const remainder = diskSkipChars > 0 ? text.slice(diskSkipChars) : text;
      diskSkipChars = 0;
      emittedTurnText += remainder; // 복원 dedup 이 디스크가 낸 분량을 알아야 한다.
      onEvent({ type: 'text-delta', agent: 'grok', text: remainder });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      routeDiskToolUpdate(update, undefined);
      return;
    }
    if (kind === 'subagent_spawned') {
      confirmDiskSource(); // 자식이 디스크에 실재한다 — 전환 확정.
      mapSubagent(String(update.subagent_id ?? ''), update);
      return;
    }
    if (kind === 'subagent_finished') {
      endTask(update);
      return;
    }
    if (kind === 'subagent_progress') {
      progressTask(update);
      return;
    }
    // user_message_chunk / agent_thought_chunk / turn_completed — stdout result 가
    // 턴 종결의 진실이므로 버린다.
  }

  function routeChildDiskUpdate(subagentId, update) {
    const parentTaskId = taskIdBySubagent.get(subagentId);
    if (!parentTaskId) return; // 부모 파일을 먼저 비우므로 매핑 전 라인은 없다시피 하다.
    const kind = String(update.sessionUpdate ?? '');
    if (kind === 'agent_message_chunk') {
      const text = typeof update.content?.text === 'string' ? update.content.text : '';
      if (text) onEvent({ type: 'text-delta', agent: 'grok', text, parentTaskId });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      routeDiskToolUpdate(update, parentTaskId);
    }
    // user_message_chunk / agent_thought_chunk / turn_completed 는 버린다 —
    // 자식의 종결은 부모 파일의 subagent_finished 가 알린다.
  }

  /** 꼬리 추적기가 전달하는 디스크 라인의 공통 관문 — 턴 경계 필터와 정착 연기. */
  function handleDiskUpdate(scope, update, meta) {
    if (lifecycle.isDisposed() || !fleetActive) return;
    // -r 재개 턴: 파일 앞부분에 이전 턴 기록이 그대로 남아 있다 — 이번 턴 시작
    // 이전의 타임스탬프는 건너뛴다 (같은 머신 시계, grok 이 생성 시점에 찍는다).
    const ts = Number(meta?.timestampMs);
    if (Number.isFinite(ts) && ts > 0 && ts < turnStartMs) return;
    diskEventSeen = true; // 이번 턴의 디스크 라인 — 확인 타임아웃 복원을 막는다.
    clearSettleTimer(); // 새 디스크 활동 — 정착을 미룬다.
    try {
      if (scope.kind === 'parent') routeParentDiskUpdate(update);
      else routeChildDiskUpdate(scope.subagentId, update);
    } finally {
      maybeScheduleSettle();
    }
  }

  /** 루트 본문을 stdout 경로로 낸다 — 복원이 남긴 잔여 skip(디스크가 stdout 보다
   * 앞서 낸 글자)을 먼저 소화해 어느 경로로든 본문이 정확히 한 번 렌더된다. */
  function emitRootStdoutText(text) {
    let out = text;
    if (stdoutSkipChars > 0) {
      if (stdoutSkipChars >= out.length) {
        stdoutSkipChars -= out.length;
        return;
      }
      out = out.slice(stdoutSkipChars);
      stdoutSkipChars = 0;
    }
    emittedTurnText += out;
    onEvent({ type: 'text-delta', agent: 'grok', text: out });
  }

  /** 잠정 전환 구간의 stdout 루트 본문을 보류한다 (상한 초과분은 버린다). */
  function bufferStdoutText(text) {
    if (!text || bufferedTextChars >= STDOUT_BUFFER_MAX_CHARS) return;
    const room = STDOUT_BUFFER_MAX_CHARS - bufferedTextChars;
    const kept = text.length > room ? text.slice(0, room) : text;
    bufferedTextChars += kept.length;
    stdoutBuffer.push({ kind: 'text', text: kept });
  }

  /** 잠정 전환 구간의 stdout 블록(본문/도구)을 보류한다. */
  function bufferStdoutBlock(block) {
    if (block?.type === 'text') {
      // 델타로 이미 보류/방출된 본문은 다시 담지 않는다 (솔로 경로와 동일 dedup).
      if (!sawRootTextDelta && block.text) bufferStdoutText(block.text);
      return;
    }
    if (block?.type !== 'tool_use') return;
    let name = String(block.name ?? '');
    let input = block.input ?? {};
    if (name === 'use_tool' && typeof input?.tool_name === 'string') {
      name = String(input.tool_name);
      input = input.tool_input ?? {};
    }
    const callId = String(block.id ?? '');
    toolNameByCallId.set(callId, name);
    if (SUBAGENT_META_TOOLS.has(name)) return; // 메타 도구는 어느 출처에서도 행이 아니다.
    stdoutBuffer.push({
      kind: 'tool-call',
      event: {
        type: 'tool-call', agent: 'grok', callId,
        tool: stripRhwpPrefix(name), argsJson: JSON.stringify(input),
      },
    });
  }

  /** 스폰 성공이 확인됐다 — 전환을 확정하고 보류분을 버린다 (디스크가 진실). */
  function confirmDiskSource() {
    if (!diskMode || diskConfirmed) return;
    diskConfirmed = true;
    stdoutBuffer.length = 0;
    bufferedTextChars = 0;
    clearConfirmTimer();
  }

  /**
   * 스폰이 무산됐거나 디스크가 끝내 나타나지 않았다 — stdout 출처로 되돌리고
   * 보류분을 흘린다. 본문은 디스크가 그동안 낸 글자 수만큼 잘라(전환 시점 기준
   * char-count dedup) 정확히 한 번만 렌더되고, 도구 행은 callId 로 걸러진다.
   */
  function revertToStdoutSource() {
    if (!diskMode || diskConfirmed) return;
    diskMode = false;
    clearConfirmTimer();
    stopTail();
    let skip = emittedTurnText.length - preSwitchTextLen; // 잠정 구간에 디스크가 낸 루트 본문.
    for (const entry of stdoutBuffer) {
      if (entry.kind === 'text') {
        if (skip >= entry.text.length) {
          skip -= entry.text.length;
          continue;
        }
        const rest = skip > 0 ? entry.text.slice(skip) : entry.text;
        skip = 0;
        emittedTurnText += rest;
        onEvent({ type: 'text-delta', agent: 'grok', text: rest });
      } else if (entry.kind === 'tool-call') {
        if (emittedToolCalls.has(entry.event.callId)) continue;
        emittedToolCalls.add(entry.event.callId);
        onEvent(entry.event);
      } else if (entry.kind === 'tool-result') {
        if (emittedToolResults.has(entry.event.callId)) continue;
        emittedToolResults.add(entry.event.callId);
        onEvent(entry.event);
      }
    }
    stdoutBuffer.length = 0;
    bufferedTextChars = 0;
    stdoutSkipChars = skip; // 디스크가 stdout 보류분보다 앞섰던 잔여 — 이후 델타에서 소화.
  }

  /** 스폰 실패 뒤 살아 있는 자식이 하나도 없으면 stdout 출처로 되돌린다. */
  function maybeRevertAfterSpawnFailure() {
    if (pendingTasks.size === 0) revertToStdoutSource();
  }

  /** 첫 spawn_subagent 이후 본문/도구 출처를 디스크로 (잠정) 전환한다. */
  function switchToDiskSource() {
    if (diskMode) return;
    diskMode = true;
    diskConfirmed = false;
    preSwitchTextLen = emittedTurnText.length;
    diskSkipChars = emittedTurnText.length;
    // 확인 실패 폴백: 유예 안에 디스크 라인이 하나도 없고 확인된 자식도 없으면
    // 파일이 끝내 나타나지 않는 경우다 — stdout 으로 되돌린다.
    clearConfirmTimer();
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      if (diskMode && !diskConfirmed && !diskEventSeen) revertToStdoutSource();
    }, DISK_CONFIRM_TIMEOUT_MS);
    confirmTimer.unref?.();
    if (tail) return;
    try {
      tail = createSessionTail({
        grokHome: turnGrokHome,
        cwd: opts.rootDir,
        sessionId,
        onUpdate: handleDiskUpdate,
      });
      tail.start();
    } catch (e) {
      onEvent({ type: 'error', agent: 'grok', message: `서브에이전트 추적을 시작하지 못했습니다: ${e?.message ?? e}` });
    }
  }

  /**
   * result 메시지의 토큰 사용량을 usage 이벤트로 흘려보낸다. modelUsage 가 있으면
   * 모델별로 쪼개 보낸다. grok 의 전부 0 인 usage 는 "미상"이므로 아무것도 내지
   * 않는다 — normalizeUsageTokens 가 null 을 돌려준다.
   */
  function emitUsage(e) {
    const perModel = e?.modelUsage;
    if (perModel && typeof perModel === 'object' && !Array.isArray(perModel) && Object.keys(perModel).length > 0) {
      for (const [model, raw] of Object.entries(perModel)) {
        const usage = normalizeUsageTokens(raw);
        if (usage) onEvent({ type: 'usage', agent: 'grok', model: String(model), usage });
      }
      return;
    }
    const usage = normalizeUsageTokens(e?.usage);
    if (usage) onEvent({ type: 'usage', agent: 'grok', model: currentModel, usage });
  }

  /** 전환 전 stdout assistant 블록 처리 — 기존 솔로 턴 경로 그대로. */
  function emitStdoutBlocks(blocks, e) {
    const parentToolUseId = e.parent_tool_use_id ? String(e.parent_tool_use_id) : null;
    const alreadyStreamed = parentToolUseId
      ? streamedSubagents.has(parentToolUseId)
      : sawRootTextDelta;
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        // grok 은 MCP 도구를 mcp__rhwp__*/rhwp__* 직접 호출 또는 use_tool 메타 도구
        // ({tool_name, tool_input})로 감싸 보고한다 — 실제 도구 이름을 풀어서 보여준다.
        let name = String(block.name ?? '');
        let input = block.input ?? {};
        if (name === 'use_tool' && typeof input?.tool_name === 'string') {
          name = input.tool_name;
          input = input.tool_input ?? {};
        }
        const callId = String(block.id ?? '');
        toolNameByCallId.set(callId, name);
        // 스폰/수거/중단 메타 도구는 stdout 경로에서도 행이 아니다 — 배경 자식만
        // 수거하는 재개 턴이 TaskOutput 덩어리를 루트 행으로 흘리면 안 된다.
        if (SUBAGENT_META_TOOLS.has(name)) continue;
        emittedToolCalls.add(callId);
        onEvent({
          type: 'tool-call',
          agent: 'grok',
          callId,
          tool: stripRhwpPrefix(name),
          argsJson: JSON.stringify(input),
        });
      } else if (block?.type === 'text') {
        if (!alreadyStreamed && block.text) {
          if (parentToolUseId) onEvent({ type: 'text-delta', agent: 'grok', text: block.text });
          else emitRootStdoutText(block.text);
        }
      }
    }
  }

  function handleEvent(e) {
    if (lifecycle.isDisposed()) return; // 폐기 후 죽어가는 CLI 가 흘리는 stdout 은 무시한다.
    // 새 stdout 라인 = CLI 가 아직 할 일이 있다(wake 재호출 등) — 예약된 턴 정착을
    // 미룬다. result/디스크 경로가 처리 끝에 다시 예약한다 (claude 와 동일 패턴).
    clearSettleTimer();
    if (e?.type === 'system' && e.subtype === 'init') {
      // CLI 가 보고하는 실제 세션 ID 를 추적한다 (-r 이 새 ID 로 fork 할 수 있다).
      if (e.session_id) sessionId = String(e.session_id);
      if (typeof e.model === 'string' && e.model) currentModel = e.model;
      onEvent({
        type: 'session-info',
        agent: 'grok',
        sessionId: e.session_id ?? sessionId,
        model: e.model,
        mcpStatus: (e.mcp_servers?.find?.((s) => s?.name === 'rhwp')?.status) ?? 'unknown',
      });
      return;
    }
    if (e?.type === 'stream_event') {
      const ev = e.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        // 전환 뒤 stdout 델타는 귀속 불명이다 — 자식 델타가 루트 블록에 이어
        // 붙는 것까지 확인됐다(캡처 runD). 확정 전에는 스폰 무산에 대비해
        // 보류하고, 확정 뒤에는 버린다 — 디스크가 본문의 진실이다.
        if (diskMode) {
          if (!diskConfirmed && !e.parent_tool_use_id) {
            sawRootTextDelta = true;
            bufferStdoutText(ev.delta.text);
          }
          return;
        }
        if (e.parent_tool_use_id) streamedSubagents.add(String(e.parent_tool_use_id));
        else sawRootTextDelta = true;
        if (ev.delta.text) {
          if (e.parent_tool_use_id) onEvent({ type: 'text-delta', agent: 'grok', text: ev.delta.text });
          else emitRootStdoutText(ev.delta.text);
        }
      }
      return;
    }
    if (e?.type === 'assistant') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
      const spawnIdx = blocks.findIndex(
        (block) => block?.type === 'tool_use' && String(block.name) === 'spawn_subagent',
      );
      if (!diskMode && spawnIdx === -1) {
        emitStdoutBlocks(blocks, e); // 스폰 없는 턴 — 오늘과 동일한 경로.
        return;
      }
      // 스폰 tool_use 가 전환의 경계다: 그 앞의 블록까지는 stdout 으로 내고
      // (이미 델타로 흘렸다면 dedup), 스폰은 task-start 로 바꾸고, 나머지는
      // 확정 전이면 보류·확정 뒤면 버린다 — 이후 본문/도구는 디스크가 공급한다.
      const boundary = diskMode ? 0 : spawnIdx;
      emitStdoutBlocks(blocks.slice(0, boundary), e);
      switchToDiskSource();
      for (const block of blocks.slice(boundary)) {
        if (block?.type === 'tool_use' && String(block.name) === 'spawn_subagent') {
          startTask(block);
        } else if (!diskConfirmed) {
          bufferStdoutBlock(block);
        }
      }
      return;
    }
    if (e?.type === 'user') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
      for (const b of blocks) {
        if (b?.type !== 'tool_result') continue;
        const callId = String(b.tool_use_id ?? '');
        // 스폰 결과는 화면에 내지 않는다 — subagent_id 매핑(성공 = 전환 확정)과
        // 스폰 실패(dontAsk 취소, 알 수 없는 타입 등) 판정에만 쓴다.
        if (pendingSpawnByCallId.has(callId)) {
          if (b.is_error) {
            failSpawnTask(callId, grokResultPreview(b.content));
            maybeRevertAfterSpawnFailure();
          } else {
            mapSubagentFromSpawnResult(
              callId,
              typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null),
            );
            switchToDiskSource(); // 복원 뒤 늦게 성공한 스폰 — 다시 전환한다.
            confirmDiskSource();
          }
          continue;
        }
        // 수거/중단 메타 도구 결과는 어느 출처에서도 행이 아니다 (G3).
        if (SUBAGENT_META_TOOLS.has(toolNameByCallId.get(callId) ?? '')) continue;
        if (diskMode) {
          // 전환 뒤 stdout 결과는 화면에 내지 않는다 — 확정 전이면 복원에 대비해
          // 보류하고, 확정 뒤에는 버린다 (디스크가 결과를 공급한다).
          if (!diskConfirmed) {
            stdoutBuffer.push({
              kind: 'tool-result',
              event: {
                type: 'tool-result', agent: 'grok', callId,
                ok: !b.is_error, resultPreview: grokResultPreview(b.content),
              },
            });
          }
          continue;
        }
        emittedToolResults.add(callId);
        onEvent({
          type: 'tool-result',
          agent: 'grok',
          callId,
          ok: !b.is_error,
          resultPreview: grokResultPreview(b.content),
        });
      }
      return;
    }
    if (e?.type === 'result') {
      hasCompletedTurn = true;
      lifecycle.markTurnCompleted();
      emitUsage(e);
      // grok 은 permission_denials 를 내지 않는다 — 클로드식 거부 보고는 없다.
      // grok 의 stop_reason(max_tokens/refusal/max_turn_requests …)은 그대로
      // 흘리지 않는다: 스튜디오는 end_turn|completed|success 밖의 값을 실패로 보고
      // 그 턴의 스테이징 편집을 전부 되돌린다. 성공/실패 판정은 is_error 로만 한다.
      resultSeen = true;
      if (e.is_error) {
        resultErrorMessage = String(e.result);
        lastStopReason = e.subtype ?? 'failed';
      } else if (resultErrorMessage === undefined) {
        lastStopReason = 'completed';
      }
      if (tasksSeenThisTurn === 0) {
        // 서브에이전트 없는 보통 턴 — 기존과 동일하게 즉시 닫는다 (지연 없음).
        settleTurn();
        return;
      }
      if (pendingTasks.size > 0) return; // fleet 진행 중 — finished/종료가 닫는다.
      scheduleSettle();
      return;
    }
  }

  function emitNativeSessionInfo() {
    if (nativeSessionInfoEmitted || !sessionId) return;
    nativeSessionInfoEmitted = true;
    onEvent({
      type: 'session-info',
      agent: 'grok',
      sessionId,
      model: currentModel,
      mcpStatus: 'connected',
    });
  }

  function handleNativeUpdate(update) {
    emitNativeSessionInfo();
    const kind = String(update?.sessionUpdate ?? '');
    if (kind === 'usage_update') {
      const usage = normalizeUsageTokens(update.usage ?? update);
      if (usage) onEvent({ type: 'usage', agent: 'grok', model: currentModel, usage });
      return;
    }
    routeParentDiskUpdate(update);
  }

  function makeNativeSession() {
    const runtime = mcpRuntimeFor(opts);
    const childEnv = {
      ...buildGrokEnv(opts),
      GROK_OAUTH2_REFERRER: 't3code',
    };
    const handlers = GROK_ASK_USER_QUESTION_METHODS.map((method) => ({
      method,
      async handler(ctx) {
        const response = await handleGrokAskUserQuestionFrame(opts, {
          jsonrpc: '2.0', id: ctx.requestId, method, params: ctx.params,
        }, ctx.signal);
        return response.result;
      },
    }));
    return createAcpSession({
      clientName: 'rhwp-grok',
      command: opts.grokBin ?? 'grok',
      args: ['agent', 'stdio'],
      cwd: opts.rootDir,
      env: childEnv,
      authMethodId: String(childEnv['XAI_API_KEY'] ?? '').trim() ? 'xai.api_key' : 'cached_token',
      setModelMethod: 'session/set_model',
      promptCompletionMethods: ['x.ai/session/prompt_complete', '_x.ai/session/prompt_complete'],
      mcpServers: [acpMcpServer('rhwp', {
        ...runtime,
        env: {
          ...runtime.env,
          RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
          RHWP_AGENT_TOKEN: opts.token,
          RHWP_AGENT_NAME: 'grok',
          ...mcpCapabilityEnv(opts),
        },
      })],
      resumeSessionId: hasCompletedTurn ? sessionId : null,
      getUnrestricted: () => opts.permissionProfile === 'unrestricted' && !isPlanningRestricted(opts),
      requestHandlers: handlers,
      onSessionStarted(info) {
        sessionId = String(info.sessionId);
        sessionIdConsumed = true;
        nativeSessionInfoEmitted = false;
      },
      onSessionUpdate: handleNativeUpdate,
    }, { spawnProcess, terminateProcess });
  }

  function prepareNativeHome() {
    const grokHome = opts.grokHome ?? process.env.GROK_HOME ?? path.join(os.homedir(), '.grok');
    turnGrokHome = String(grokHome);
    prepareGrokHome(grokHome, opts.grokAuthPath);
    writeFileSync(path.join(grokHome, 'config.toml'), buildGrokConfigToml(opts), 'utf8');
    return grokHome;
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
      model: opts.model,
      effort: opts.effort,
    });
    sessionId = nativeSession.getSessionId() ?? sessionId;
    return nativeSession;
  }

  function startLegacyTurn(text) {
    const resume = hasCompletedTurn;
    if (!resume && sessionIdConsumed) sessionId = crypto.randomUUID();
    sessionIdConsumed = true;
    const grokHome = opts.grokHome ?? process.env.GROK_HOME ?? path.join(os.homedir(), '.grok');
    turnGrokHome = String(grokHome);
    const promptPath = path.join(grokHome, 'prompt.txt');
    let proc;
    try {
      prepareNativeHome();
      writeFileSync(promptPath, text, 'utf8');
      proc = spawnProcess(opts.grokBin ?? 'grok', buildGrokArgv(opts, sessionId, resume, promptPath), {
        ...processTreeSpawnOptions(),
        cwd: opts.rootDir,
        env: buildGrokEnv(opts),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      lifecycle.failStart(e);
      return;
    }
    lifecycle.attachChild(proc, handleEvent);
  }

  async function runNativeTurn(text, token) {
    let promptStarted = false;
    try {
      const firstPrompt = !hasCompletedTurn;
      const session = await configureNativeMode();
      const prompt = firstPrompt ? `${systemBriefFor(opts, 'grok')}\n\n${text}` : text;
      // Never replay a message through legacy after ACP has accepted the
      // prompt. A cancelled or malformed native question belongs to this exact
      // turn and cannot trigger a mid-turn transport switch.
      promptStarted = true;
      const response = await session.prompt(prompt);
      if (token !== nativeTurnToken || !lifecycle.isTurnOpen()) return;
      emitNativeSessionInfo();
      hasCompletedTurn = true;
      lifecycle.markTurnCompleted();
      const usage = normalizeUsageTokens(response?.usage);
      if (usage) onEvent({ type: 'usage', agent: 'grok', model: currentModel, usage });
      resultSeen = true;
      lastStopReason = response?.stopReason === 'end_turn' ? 'completed' : response?.stopReason;
      if (tasksSeenThisTurn === 0) settleTurn();
      else if (pendingTasks.size === 0) scheduleSettle();
    } catch (error) {
      if (token !== nativeTurnToken || !lifecycle.isTurnOpen()) return;
      if (!promptStarted) {
        nativeDisabled = true;
        const failed = nativeSession;
        nativeSession = null;
        try { await failed?.dispose(); } catch {}
        startLegacyTurn(text);
        return;
      }
      onEvent({ type: 'error', agent: 'grok', message: error?.message ?? String(error) });
      resultErrorMessage = error?.message ?? String(error);
      lastStopReason = 'failed';
      settleTurn();
    }
  }

  return {
    agent: 'grok',
    getSessionId() {
      return sessionId;
    },
    sendUserMessage(text) {
      if (lifecycle.isDisposed()) return;
      sawRootTextDelta = false;
      streamedSubagents.clear();
      resetTurnFleetState();
      // 디스크 타임스탬프 필터의 기준 — 스폰 전에 찍어야 첫 라인도 걸리지 않는다.
      turnStartMs = now();
      lifecycle.beginTurn();
      if (nativeDisabled) {
        startLegacyTurn(text);
        return;
      }
      const token = ++nativeTurnToken;
      void runNativeTurn(text, token);
    },
    async setPermissionProfile(profile) {
      if (lifecycle.isTurnOpen()) throw new Error('Permission profile can only change between turns');
      if (profile !== 'safe' && profile !== 'unrestricted') throw new Error(`Unknown permission profile: ${profile}`);
      const previous = opts.permissionProfile;
      const previousNativeSession = nativeSession;
      const previousSessionId = sessionId;
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
          sessionId = previousSessionId;
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
      const previousSessionId = sessionId;
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
        // Do not ACK Plan until the native provider has proved a selectable
        // Plan/Architect mode. Legacy-only sessions use the explicit CLI
        // --permission-mode plan contract.
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
          sessionId = previousSessionId;
          try { await failed.dispose(); } catch {}
        }
        throw error;
      }
    },
    interrupt() {
      nativeTurnToken += 1;
      if (!nativeDisabled) void nativeSession?.cancel().catch(() => {});
      lifecycle.interrupt();
    },
    async dispose() {
      clearSettleTimer();
      clearConfirmTimer();
      stopTail();
      nativeTurnToken += 1;
      const [, legacy] = await Promise.allSettled([nativeSession?.dispose(), lifecycle.dispose()]);
      return legacy.status === 'fulfilled' ? legacy.value : false;
    },
  };
}
