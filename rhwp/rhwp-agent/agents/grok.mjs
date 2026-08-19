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
  normalizeUsageTokens,
  systemBriefFor,
  truncate,
  validateExecutionMode,
} from './backend.mjs';
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
  const rootGlob = `${String(opts.rootDir ?? '').replace(/\\/g, '/')}/**`;
  const allowRules = [
    `Read(${rootGlob})`,
    ...(planningRestricted ? [] : [`Edit(${rootGlob})`]),
    'Grep', 'WebFetch', 'WebSearch', 'MCPTool(rhwp__*)',
  ];
  // --sandbox 는 붙이지 않는다: grok 1.0.5 의 macOS seatbelt 샌드박스는 프로필을
  // 적용한 직후 기동 전에 멈춰(무한 대기, 출력 없음) 턴이 영원히 끝나지 않는다.
  // CLI 가 이 문제를 고칠 때까지 이 플래그는 꺼 둔다. 안전/계획 프로필의 강제는
  // --permission-mode dontAsk 와 아래 --allow 규칙(목록 밖은 기본 거부, 계획
  // 단계에서는 Edit 제외)이 담당한다.
  // 안전 프로필은 셸을 아예 막는다 — 샌드박스 없이 Bash 를 허용하면 경로 규칙이
  // 무의미해진다. 문서 작업은 MCP 도구로 충분하고, 셸이 필요하면 전체 접근을 쓴다.
  const permission = unrestricted && !planningRestricted
    ? ['--always-approve']
    : ['--permission-mode', 'dontAsk', ...allowRules.flatMap((rule) => ['--allow', rule])];
  return [
    '--prompt-file', promptFilePath,
    '--output-format', 'streaming-messages-json',
    '--include-partial-messages',
    '--no-auto-update',
    ...(resume ? ['-r', sessionId] : ['-s', sessionId]),
    '--append-system-prompt', systemBriefFor(opts),
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.effort ? ['--reasoning-effort', opts.effort] : []),
    ...permission,
    // 계획 워크플로에서는 서브에이전트를 살리고, 직접 편집에서는 끈다.
    ...(opts.workflow === 'plan' ? [] : ['--no-subagents']),
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

/**
 * 턴마다 새로 스폰하고(코덱스 수명주기) Anthropic Messages 와이어 포맷 스트림을
 * 파싱한다(클로드 이벤트 처리).
 *
 * @param {import('./backend.mjs').BackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createGrokSession(opts, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
} = {}) {
  const onEvent = opts.onEvent;
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

  function handleEvent(e) {
    if (lifecycle.isDisposed()) return; // 폐기 후 죽어가는 CLI 가 흘리는 stdout 은 무시한다.
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
        if (e.parent_tool_use_id) streamedSubagents.add(String(e.parent_tool_use_id));
        else sawRootTextDelta = true;
        if (ev.delta.text) onEvent({ type: 'text-delta', agent: 'grok', text: ev.delta.text });
      }
      return;
    }
    if (e?.type === 'assistant') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
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
          onEvent({
            type: 'tool-call',
            agent: 'grok',
            callId: String(block.id ?? ''),
            tool: name.replace(/^(?:mcp__rhwp__|rhwp__)/, ''),
            argsJson: JSON.stringify(input),
          });
        } else if (block?.type === 'text') {
          if (!alreadyStreamed && block.text) {
            onEvent({ type: 'text-delta', agent: 'grok', text: block.text });
          }
        }
      }
      return;
    }
    if (e?.type === 'user') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
      for (const b of blocks) {
        if (b?.type === 'tool_result') {
          onEvent({
            type: 'tool-result',
            agent: 'grok',
            callId: String(b.tool_use_id ?? ''),
            ok: !b.is_error,
            resultPreview: truncate(typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null)),
          });
        }
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
      lifecycle.endTurn({
        type: 'turn-end',
        agent: 'grok',
        stopReason: e.is_error ? (e.subtype ?? 'failed') : 'completed',
        errorMessage: e.is_error ? String(e.result) : undefined,
      });
      return;
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
      lifecycle.beginTurn();

      const resume = hasCompletedTurn;
      if (!resume && sessionIdConsumed) {
        // 이전 -s 스폰이 turn 완료 전에 죽었다 — 그 UUID 는 소진되었으므로
        // 새 세션 ID 로 다시 시작한다 (재개할 완료 turn 도 없다).
        sessionId = crypto.randomUUID();
      }
      sessionIdConsumed = true;

      const grokHome = opts.grokHome ?? process.env.GROK_HOME ?? path.join(os.homedir(), '.grok');
      const promptPath = path.join(grokHome, 'prompt.txt');
      let proc;
      try {
        prepareGrokHome(grokHome, opts.grokAuthPath);
        // 설정과 프롬프트는 스폰마다 다시 쓴다 — 토큰/프로필/에포크가 바뀔 수 있다.
        writeFileSync(path.join(grokHome, 'config.toml'), buildGrokConfigToml(opts), 'utf8');
        writeFileSync(promptPath, text, 'utf8');
        proc = spawnProcess(opts.grokBin ?? 'grok', buildGrokArgv(opts, sessionId, resume, promptPath), {
          ...processTreeSpawnOptions(),
          cwd: opts.rootDir,
          env: buildGrokEnv(opts),
          // grok 헤드리스는 stdin 을 프롬프트 채널로 쓰지 않는다 — 닫아 둔다.
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        lifecycle.failStart(e);
        return;
      }
      lifecycle.attachChild(proc, handleEvent);
    },
    setPermissionProfile(profile) {
      if (lifecycle.isTurnOpen()) throw new Error('Permission profile can only change between turns');
      if (profile !== 'safe' && profile !== 'unrestricted') throw new Error(`Unknown permission profile: ${profile}`);
      opts.permissionProfile = profile;
    },
    async setExecutionMode(mode) {
      if (lifecycle.isTurnOpen()) throw new Error('Execution mode can only change between turns');
      validateExecutionMode(mode);
      lifecycle.killChild();
      await lifecycle.waitForChildExit();
      opts.workflow = mode.workflow;
      opts.phase = mode.phase;
      opts.capabilityEpoch = mode.capabilityEpoch;
    },
    interrupt: lifecycle.interrupt,
    dispose: lifecycle.dispose,
  };
}
