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
  const unrestricted = opts.permissionProfile === 'unrestricted' && !planningRestricted;
  const model = String(opts.model ?? '');
  return [
    '-p',
    '--output-format', 'stream-json',
    '--stream-partial-output',
    '--approve-mcps',
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

/**
 * @param {import('./backend.mjs').BackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createCursorSession(opts, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
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

  function makeHandler() {
    let emittedText = false;
    // 이번 턴에 이미 내보낸 본문 — 재시도 플러시의 재생을 걸러내는 데 쓴다.
    let emittedTurnText = '';
    return (e) => {
      if (lifecycle.isDisposed()) return; // 폐기 후 죽어가는 CLI 가 흘리는 stdout 은 무시한다.
      const type = e?.type;
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
        const key = Object.keys(payload)[0];
        const inner = key ? payload[key] : null;
        const kind = key ? key.replace(/ToolCall$/, '') : 'tool';
        const tool = kind === 'mcp' ? mcpToolLabel(inner) : kind;
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
          // 결과는 protobuf oneof 다 — 성공이면 success 멤버 하나만 실린다.
          // 실패 변형(rejected/permissionDenied/timeout/fileNotFound/noSpace …)에는
          // success 도 error 도 없으므로 success 키의 유무만으로 판정한다.
          const ok = result == null
            ? true
            : Object.prototype.hasOwnProperty.call(result, 'success');
          onEvent({
            type: 'tool-result',
            agent: 'cursor',
            callId,
            ok,
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
        lifecycle.endTurn({
          type: 'turn-end',
          agent: 'cursor',
          stopReason: e.subtype ?? 'completed',
          errorMessage: e.is_error ? String(e.result) : undefined,
        });
        return;
      }
    };
  }

  return {
    agent: 'cursor',
    getSessionId() {
      return chatId;
    },
    sendUserMessage(text) {
      if (lifecycle.isDisposed()) return;
      lifecycle.beginTurn();

      const mode = normalizeExecutionMode(opts);
      const prompt = chatId && mode.workflow === 'direct'
        ? text
        : systemBriefFor(opts) + '\n\n' + text;

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

      let proc;
      try {
        if (!opts.isolatedHome) throw new Error('Cursor 세션에는 격리 홈이 필요합니다.');
        const sessionCursorDir = path.join(String(opts.isolatedHome), '.cursor');
        let sourceCliConfig = null;
        if (opts.cursorSourceDir) {
          try {
            sourceCliConfig = JSON.parse(readFileSync(path.join(String(opts.cursorSourceDir), 'cli-config.json'), 'utf8'));
          } catch {}
        }
        // 인증/프로필/토큰이 바뀔 수 있으므로 스폰마다 다시 저작한다.
        prepareCursorHome(sessionCursorDir, opts.cursorSourceDir, {
          mcpConfig: buildCursorMcpConfig(opts),
          cliConfig: buildCursorCliConfig(opts, sourceCliConfig),
        });
        const childEnv = isolatedProcessEnv(opts, opts.providerEnv ?? process.env);
        // 상속된 CURSOR_CONFIG_DIR 은 HOME 보다 우선해 cli-config.json 을 다른
        // 디렉터리에서 읽게 만든다 — 이번 턴의 권한 프로필이 통째로 무시되므로 지운다.
        delete childEnv.CURSOR_CONFIG_DIR;
        proc = spawnProcess(opts.cursorBin ?? 'cursor-agent', buildCursorArgv(opts, chatId, prompt), {
          ...processTreeSpawnOptions(),
          cwd: opts.rootDir,
          env: childEnv,
          // 프롬프트는 positional 인자다 — stdin 은 닫아 둔다.
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        lifecycle.failStart(e);
        return;
      }
      // 턴 상태는 스폰마다 새로 만든 핸들러가 들고 있다 — 재생 필터가 턴 경계에서 초기화된다.
      lifecycle.attachChild(proc, makeHandler());
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
