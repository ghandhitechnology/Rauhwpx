// cross-spawn: Windows에서 npm .cmd 심을 인자 이스케이프 손상 없이 실행한다.
import spawn from 'cross-spawn';
import crypto from 'node:crypto';
import path from 'node:path';

import { toolProfileForPhase } from '../planning-state.mjs';
import {
  createLineReader,
  isPlanningRestricted,
  mcpCapabilityEnv,
  normalizeExecutionMode,
  systemBriefFor,
  truncate,
  validateExecutionMode,
} from './backend.mjs';
import {
  processTreeSpawnOptions,
  terminateProcessTree,
  waitForProcessTreeExit,
} from '../process-tree.mjs';

const STDERR_TAIL_LIMIT = 16_000;
/** macOS ARG_MAX(1MB) 여유분. 프롬프트는 positional 인자로 넘어간다. */
const PROMPT_ARG_LIMIT = 700_000;
/** 계획 단계에서 막는 pi 내장 도구. 확장 도구(rhwp)는 그대로 남는다. */
const PLANNING_EXCLUDED_TOOLS = 'bash,edit,write';

/**
 * 자식에게 넘겨줄 환경변수 화이트리스트. 여기 없는 값은 전달하지 않는다 —
 * 앰비언트 *_API_KEY 가 남아 있으면 pi 가 우리가 설정하지 않은 provider 를
 * 추가로 붙여버린다(검증됨).
 */
const ENV_PASSTHROUGH = [
  'PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR',
  // Windows 에서 cross-spawn/셸이 요구하는 값들.
  'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP',
];

/** 화이트리스트에 실수로 자격증명이 섞여도 걸러낸다. */
const CREDENTIAL_NAME = /(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|SECRET|ACCESS_KEY|BEARER)/i;
/** 오류 문자열에서 API 키처럼 보이는 토큰을 지운다. */
const SECRET_LIKE = /\b(?:sk|pk)-[A-Za-z0-9_-]{12,}/g;
const CREDIT_ERROR = /(?:\b402\b|payment required|insufficient (?:credits|quota)|credit(?:s)? (?:exhausted|depleted|exceeded)|out of credits)/i;

export function isOpenRouterCreditError(text) {
  return CREDIT_ERROR.test(String(text ?? ''));
}

export function formatOpenRouterCreditError(text, agent = 'pi') {
  if (!isOpenRouterCreditError(text)) return null;
  return agent === 'rau'
    ? 'Rau 체험 크레딧이 다 됐어요. 다른 모델을 연결해 주세요.'
    : 'OpenRouter 크레딧이 부족합니다.';
}

/**
 * @typedef {import('./backend.mjs').BackendOptions & {
 *   piBin?: string,
 *   piRoot?: string,
 *   openRouterApiKey?: string,
 *   reasoning?: boolean,
 *   agentName?: 'pi' | 'rau',
 * }} PiBackendOptions
 *
 * piBin  — pi 실행 파일 경로(`<piRoot>/prefix/node_modules/.bin/pi`).
 * piRoot — 영속 pi 루트. 에이전트 디렉터리는 `<piRoot>/agent`, 세션은 `<piRoot>/sessions`.
 * model  — provider 접두사 없는 OpenRouter 모델 id. argv 에서 `openrouter/` 를 붙인다.
 * effort — 추론 강도(low|medium|high) 또는 null.
 * reasoning — 선택한 모델이 thinking 을 지원하는지 여부.
 */

/** 계획 단계에서는 확장 도구 목록도 좁혀야 하므로 phase 기준으로 다시 계산한다. */
function toolProfileFor(opts) {
  const { workflow, phase } = normalizeExecutionMode(opts);
  return workflow === 'direct' ? 'direct' : toolProfileForPhase(phase);
}

/**
 * 참고 자료 블록은 프롬프트 앞에 붙는다. 인자 한계를 넘으면 뒤(사용자 요청)를
 * 남기고 앞쪽 참고 블록을 잘라낸다 — 요청 자체를 자르지 않는다.
 *
 * @param {string} prompt
 */
export function clampPromptArg(prompt) {
  if (Buffer.byteLength(prompt) <= PROMPT_ARG_LIMIT) return prompt;
  let kept = prompt.slice(-PROMPT_ARG_LIMIT);
  while (Buffer.byteLength(kept) > PROMPT_ARG_LIMIT) kept = kept.slice(1024);
  return `[참고 자료 일부 생략]\n\n${kept}`;
}

/**
 * pi CLI 인자를 만든다. 프롬프트는 호출자가 마지막 positional 인자로 덧붙인다.
 *
 * @param {PiBackendOptions} opts
 * @param {string} sessionId
 */
export function buildPiArgv(opts, sessionId) {
  const piRoot = opts.piRoot ?? '';
  const modelId = String(opts.model ?? '').replace(/^openrouter\//, '');
  const argv = ['--mode', 'json', '--model', `openrouter/${modelId}`];
  // thinking 은 추론 모델에서만 유효하다. 나머지는 요청 자체가 거부된다.
  if (opts.reasoning && opts.effort) argv.push('--thinking', String(opts.effort));
  argv.push(
    '--session-dir', path.join(piRoot, 'sessions'),
    '--session-id', sessionId,
    // 'pi' 를 명시한다 — 미지정은 클로드 기본 브리프(스폰 지시 포함)를 낳았다.
    '--append-system-prompt', systemBriefFor(opts, 'pi'),
    // 워크스페이스의 CLAUDE.md/AGENTS.md 를 끌어오지 않는다.
    '--no-context-files',
  );
  // 계획 단계에서는 내장 쓰기/셸 도구를 아예 빼고, 구현 단계에서는 전부 살린다.
  if (isPlanningRestricted(opts)) argv.push('--exclude-tools', PLANNING_EXCLUDED_TOOLS);
  return argv;
}

/**
 * 자식 프로세스 환경을 처음부터 조립한다(앰비언트 상속 없음).
 *
 * @param {PiBackendOptions} opts
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 */
export function buildPiEnv(opts, sourceEnv = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of ENV_PASSTHROUGH) {
    const value = sourceEnv[name];
    if (typeof value !== 'string' || CREDENTIAL_NAME.test(name)) continue;
    env[name] = value;
  }
  if (opts.isolatedHome) {
    env.HOME = String(opts.isolatedHome);
    env.USERPROFILE = String(opts.isolatedHome);
  }
  const piRoot = opts.piRoot ?? '';
  return {
    ...env,
    PI_CODING_AGENT_DIR: path.join(piRoot, 'agent'),
    ...(opts.openRouterApiKey ? { OPENROUTER_API_KEY: String(opts.openRouterApiKey) } : {}),
    // 버전 확인/카탈로그 갱신 같은 기동 시 네트워크 동작을 끈다.
    PI_OFFLINE: '1',
    RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
    RHWP_AGENT_TOKEN: String(opts.token ?? ''),
    RHWP_AGENT_NAME: 'pi',
    RHWP_HUB_HTTP: `http://127.0.0.1:${opts.hubPort}`,
    RHWP_ROOT_DIR: String(opts.rootDir ?? ''),
    RHWP_PERMISSION_PROFILE: opts.permissionProfile ?? 'safe',
    RHWP_TOOL_PROFILE: toolProfileFor(opts),
    ...mcpCapabilityEnv(opts),
  };
}

/**
 * CLI stderr 를 사용자에게 보여줄 짧은 이유로 바꾼다. 세션 토큰과 키처럼 보이는
 * 문자열은 지운다.
 *
 * @param {string} stderrText
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @param {string} token
 */
export function formatPiExitError(stderrText, code, signal, token, agent = 'pi') {
  const credit = formatOpenRouterCreditError(stderrText, agent);
  if (credit) return credit;
  let clean = String(stderrText ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  if (token) clean = clean.split(token).join('[redacted]');
  clean = clean.replace(SECRET_LIKE, '[redacted]');
  const detail = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Usage:/i.test(line) && !/^For more information/i.test(line))
    .slice(-8)
    .join('\n');
  const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
  return detail
    ? `Pi 실행이 중단되었습니다 (${exit}).\n${truncate(detail, 1200)}`
    : `Pi 실행이 중단되었습니다 (${exit}). Pi가 오류 설명을 제공하지 않았습니다.`;
}

/**
 * pi usage 는 {input,output,cacheRead,cacheWrite,reasoning,cost:{total}} 모양이라
 * 공용 normalizeUsageTokens 로는 읽히지 않는다. 여기서 직접 정규화한다.
 *
 * @param {any} raw
 * @returns {{ usage: import('./backend.mjs').UsageTokens, costUsd: number } | null}
 */
function normalizePiUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  const usage = {
    inputTokens: count(raw.input),
    outputTokens: count(raw.output),
    cacheReadTokens: count(raw.cacheRead),
    cacheCreationTokens: count(raw.cacheWrite),
  };
  const cost = Number(raw.cost?.total);
  const costUsd = Number.isFinite(cost) && cost > 0 ? cost : 0;
  const tokens = usage.inputTokens + usage.outputTokens
    + usage.cacheReadTokens + usage.cacheCreationTokens;
  // 값이 전부 0 이면(예: 401 로 끝난 턴) 기록할 것이 없다.
  return tokens > 0 || costUsd > 0 ? { usage, costUsd } : null;
}

/**
 * @param {PiBackendOptions} opts
 * @returns {import('./backend.mjs').AgentSession}
 */
export function createPiSession(opts, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
} = {}) {
  const onEvent = opts.onEvent;

  // pi 세션 id 는 우리가 발급한다. 첫 스폰은 세션 파일을 만들고(“creating a new
  // session” 경고가 stderr 에 찍힌다) 이후 스폰은 같은 파일을 이어 쓴다.
  let sessionId = crypto.randomUUID();
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let turnOpen = false;
  let turnCompleted = false;
  let turnFailureMessage = null;
  let disposed = false;
  let stderrTail = '';
  let childExitPromise = Promise.resolve();
  let resolveChildExit = null;

  function endTurn(evt) {
    if (!turnOpen) return;
    turnOpen = false;
    onEvent(evt);
  }

  function makeHandler() {
    return (e) => {
      if (disposed) return; // 폐기 후 죽어가는 CLI 가 흘리는 stdout 은 무시한다.
      const type = e?.type;
      if (type === 'session') {
        if (e.id) {
          sessionId = String(e.id);
          onEvent({
            type: 'session-info',
            agent: 'pi',
            sessionId,
            model: opts.model ?? undefined,
          });
        }
        return;
      }
      if (type === 'message_update') {
        // thinking_*/toolcall_* 델타는 흘리지 않는다. 도구는 tool_execution_* 로 본다.
        const sub = e.assistantMessageEvent;
        if (sub?.type === 'text_delta' && sub.delta) {
          onEvent({ type: 'text-delta', agent: 'pi', text: String(sub.delta) });
        }
        return;
      }
      if (type === 'message_end') {
        const message = e.message ?? {};
        if (message.role !== 'assistant') return;
        const usage = normalizePiUsage(message.usage);
        if (usage) {
          onEvent({
            type: 'usage',
            agent: 'pi',
            model: opts.model ?? null,
            usage: usage.usage,
            costUsd: usage.costUsd,
          });
        }
        if (message.stopReason === 'error') {
          // json 모드의 API 오류는 종료 코드 0 으로 끝난다. 이유는 여기에만 있다.
          const detail = String(message.errorMessage ?? 'pi turn failed');
          turnFailureMessage = formatOpenRouterCreditError(detail, opts.agentName)
            ?? detail;
          onEvent({ type: 'error', agent: 'pi', message: turnFailureMessage });
        }
        return;
      }
      if (type === 'tool_execution_start') {
        onEvent({
          type: 'tool-call',
          agent: 'pi',
          callId: String(e.toolCallId ?? ''),
          tool: String(e.toolName ?? 'tool'),
          argsJson: JSON.stringify(e.args ?? {}),
        });
        return;
      }
      if (type === 'tool_execution_end') {
        onEvent({
          type: 'tool-result',
          agent: 'pi',
          callId: String(e.toolCallId ?? ''),
          ok: !e.isError,
          resultPreview: truncate(JSON.stringify(e.result?.content ?? e.result ?? null)),
        });
        return;
      }
      if (type === 'agent_settled') {
        // 완료 신호는 agent_end 가 아니라 agent_settled 다 — agent_end 뒤에도
        // 자동 재시도/압축이 이어질 수 있다.
        turnCompleted = true;
        return;
      }
      if (type === 'error') {
        onEvent({ type: 'error', agent: 'pi', message: String(e.message ?? 'unknown error') });
      }
    };
  }

  function killChild() {
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    terminateProcess(proc);
  }

  return {
    agent: 'pi',
    getSessionId() {
      return sessionId;
    },
    sendUserMessage(text) {
      if (disposed) return;
      turnOpen = true;
      turnCompleted = false;
      turnFailureMessage = null;
      onEvent({ type: 'turn-start', agent: 'pi' });

      if (!opts.model) {
        onEvent({ type: 'error', agent: 'pi', message: 'Pi 모델이 선택되지 않았습니다.' });
        endTurn({ type: 'turn-end', agent: 'pi', stopReason: 'exited' });
        return;
      }

      // 시스템 브리핑은 --append-system-prompt 로 매 스폰마다 붙는다.
      // 프롬프트만 마지막 positional 인자로 넘긴다. '-' 로 시작하면 플래그로
      // 파싱되므로 앞에 공백 하나를 둔다.
      const raw = clampPromptArg(text);
      const prompt = raw.startsWith('-') ? ` ${raw}` : raw;
      const argv = [...buildPiArgv(opts, sessionId), prompt];
      stderrTail = '';

      let proc;
      try {
        proc = spawnProcess(opts.piBin ?? 'pi', argv, {
          ...processTreeSpawnOptions(),
          cwd: opts.rootDir,
          env: buildPiEnv(opts),
          // stdin 은 반드시 닫아야 한다: json 모드는 열린 stdin 을 계속 기다린다.
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        onEvent({ type: 'error', agent: 'pi', message: `failed to start pi: ${e?.message ?? e}` });
        endTurn({ type: 'turn-end', agent: 'pi', stopReason: 'exited' });
        return;
      }
      child = proc;
      childExitPromise = new Promise((resolve) => { resolveChildExit = resolve; });
      proc.stdout.on('data', createLineReader(makeHandler()));
      proc.stderr.on('data', (chunk) => {
        const chunkText = chunk.toString();
        stderrTail = (stderrTail + chunkText).slice(-STDERR_TAIL_LIMIT);
        for (const line of chunkText.split('\n')) {
          if (line.trim()) process.stderr.write(`[pi] ${line}\n`);
        }
      });
      proc.on('error', (err) => {
        if (proc !== child) return;
        process.stderr.write(`[pi] spawn error: ${err?.message ?? err}\n`);
        if (turnOpen) {
          onEvent({ type: 'error', agent: 'pi', message: `pi process error: ${err?.message ?? err}` });
          endTurn({ type: 'turn-end', agent: 'pi', stopReason: 'exited' });
        }
      });
      proc.on('exit', (code, signal) => {
        if (proc !== child) return;
        if (turnOpen && !disposed) {
          if (turnFailureMessage) {
            endTurn({ type: 'turn-end', agent: 'pi', stopReason: 'failed', errorMessage: turnFailureMessage });
          } else if (!turnCompleted && code !== 0) {
            onEvent({
              type: 'error',
              agent: 'pi',
              message: formatPiExitError(stderrTail, code, signal, opts.token, opts.agentName),
            });
            endTurn({ type: 'turn-end', agent: 'pi', stopReason: 'exited' });
          } else {
            endTurn({ type: 'turn-end', agent: 'pi', stopReason: turnCompleted ? 'completed' : 'exited' });
          }
        }
        child = null;
        resolveChildExit?.();
        resolveChildExit = null;
      });
      proc.on('close', () => {
        if (proc !== child) return;
        child = null;
        resolveChildExit?.();
        resolveChildExit = null;
      });
    },
    setPermissionProfile(profile) {
      if (turnOpen) throw new Error('Permission profile can only change between turns');
      if (profile !== 'safe' && profile !== 'unrestricted') throw new Error(`Unknown permission profile: ${profile}`);
      opts.permissionProfile = profile;
    },
    async setExecutionMode(mode) {
      if (turnOpen) throw new Error('Execution mode can only change between turns');
      validateExecutionMode(mode);
      if (child && child.exitCode === null && child.signalCode === null) killChild();
      await childExitPromise;
      opts.workflow = mode.workflow;
      opts.phase = mode.phase;
      opts.capabilityEpoch = mode.capabilityEpoch;
    },
    interrupt() {
      killChild();
      endTurn({ type: 'turn-end', agent: 'pi', stopReason: 'interrupted' });
    },
    dispose() {
      disposed = true;
      turnOpen = false;
      // 죽어가는 자식의 stdout 을 아예 파싱하지 않는다.
      try { child?.stdout?.removeAllListeners('data'); } catch {}
      const exited = waitForProcessTreeExit(child);
      killChild();
      return exited;
    },
  };
}
