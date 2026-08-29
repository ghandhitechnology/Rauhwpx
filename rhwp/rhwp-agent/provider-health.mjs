// cross-spawn is required for app-managed .cmd shims on Windows.
import spawn from 'cross-spawn';

/** CLI 가 살아 있는지 확인하는 프로브 — `<cli> --version` 한 줄이면 충분하다. */
const PROBE_COMMANDS = /** @type {const} */ ({
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  cursor: 'cursor-agent',
});
const CLI_AGENTS = /** @type {const} */ (Object.keys(PROBE_COMMANDS));
const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
const STDERR_TAIL_LIMIT = 2_000;

/** pi 는 PATH 가 아니라 우리가 설치한 경로에 있다 — 미설치면 프로브 자체를 걸지 않는다. */
const PI_NOT_INSTALLED = '설치되지 않았어요';

/**
 * @typedef {Object} ProviderHealth
 * @property {boolean} available
 * @property {string|null} version
 * @property {string|null} error
 * @property {number} checkedAt
 */

function stderrTail(text) {
  const clean = String(text ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  return clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' / ')
    .slice(-STDERR_TAIL_LIMIT);
}

function firstLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * 프로바이더 CLI 설치 여부를 캐시와 함께 조사한다. 결과는 60초간 유효하고,
 * 동시에 들어온 요청은 하나의 프로브를 공유한다(single-flight).
 *
 * piBin 은 게터로 받는다 — pi 는 설치 도중에 생기므로 부팅 시점 값에 묶으면 안 된다.
 *
 * probeEnv 는 프로브별 환경을 준다 — cursor-agent 는 CONFIG_DIR 재지정 없이
 * `--version` 만 실행해도 실제 `~/.cursor/projects/` 에 흔적을 남기기 때문이다.
 *
 * @param {{ spawnProcess?: typeof spawn, timeoutMs?: number, cacheTtlMs?: number,
 *           now?: () => number, piBin?: () => string|null,
 *           cliBin?: (agent: 'claude'|'codex'|'grok'|'cursor') => string|null,
 *           probeEnv?: (agent: string) => NodeJS.ProcessEnv|undefined }} [deps]
 */
export function createProviderHealth({
  spawnProcess = spawn,
  timeoutMs = PROBE_TIMEOUT_MS,
  cacheTtlMs = CACHE_TTL_MS,
  now = Date.now,
  piBin = () => null,
  cliBin = (agent) => PROBE_COMMANDS[agent],
  probeEnv = () => undefined,
} = {}) {
  /** @type {{ result: { claude: ProviderHealth, codex: ProviderHealth, grok: ProviderHealth, cursor: ProviderHealth, pi: ProviderHealth }, checkedAt: number } | null} */
  let cache = null;
  /** @type {Promise<{ claude: ProviderHealth, codex: ProviderHealth, grok: ProviderHealth, cursor: ProviderHealth, pi: ProviderHealth }> | null} */
  let inFlight = null;

  /**
   * @param {string} command
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Promise<ProviderHealth>}
   */
  function probe(command, env) {
    return new Promise((resolve) => {
      let settled = false;
      let stdoutText = '';
      let stderrText = '';
      /** @type {NodeJS.Timeout | null} */
      let timer = null;

      const done = (health) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ ...health, checkedAt: now() });
      };

      let proc;
      try {
        proc = spawnProcess(command, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(env ? { env } : {}),
        });
      } catch (error) {
        done({
          available: false,
          version: null,
          error: `${command} 실행에 실패했습니다: ${error?.message ?? error}`,
        });
        return;
      }

      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        done({
          available: false,
          version: null,
          error: `${command} --version 이 ${Math.round(timeoutMs / 100) / 10}초 안에 응답하지 않았습니다.`,
        });
      }, timeoutMs);

      proc.stdout?.on?.('data', (chunk) => { stdoutText += chunk.toString(); });
      proc.stderr?.on?.('data', (chunk) => { stderrText += chunk.toString(); });
      proc.stdout?.on?.('error', () => {});
      proc.stderr?.on?.('error', () => {});
      proc.on('error', (error) => {
        if (error?.code === 'ENOENT') {
          done({
            available: false,
            version: null,
            error: `${command} 명령을 찾을 수 없습니다 — CLI 를 설치하고 PATH 에 등록하세요.`,
          });
          return;
        }
        done({
          available: false,
          version: null,
          error: `${command} 실행에 실패했습니다: ${error?.message ?? error}`,
        });
      });
      const finish = (code, signal) => {
        if (code === 0) {
          done({ available: true, version: firstLine(stdoutText), error: null });
          return;
        }
        const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        const detail = stderrTail(stderrText);
        done({
          available: false,
          version: null,
          error: detail
            ? `${command} --version 이 실패했습니다 (${exit}): ${detail}`
            : `${command} --version 이 실패했습니다 (${exit}).`,
        });
      };
      proc.on('close', finish);
      // 일부 스텁/플랫폼은 close 없이 exit 만 낸다 — 한 틱 늦춰 stdout 을 비운 뒤 마감한다.
      proc.on('exit', (code, signal) => setImmediate(() => finish(code, signal)));
    });
  }

  /** pi 는 우리가 설치한 바이너리를 직접 부른다. 경로가 없으면 프로브를 건너뛴다. */
  function probePi() {
    let bin = null;
    try {
      bin = piBin();
    } catch {
      bin = null;
    }
    if (typeof bin !== 'string' || !bin) {
      return Promise.resolve({
        available: false, version: null, error: PI_NOT_INSTALLED, checkedAt: now(),
      });
    }
    // 경로는 있는데 실행 파일이 없으면(설치본 삭제) 미설치로 되돌린다.
    return probe(bin).then((health) => (!health.available && /찾을 수 없습니다/.test(health.error ?? '')
      ? { ...health, error: PI_NOT_INSTALLED }
      : health));
  }

  return {
    /** 캐시된 결과. 첫 프로브 전에는 null 이다. */
    cached() {
      return cache?.result ?? null;
    },
    /**
     * @param {boolean} [refresh] true 면 캐시를 무시하고 다시 프로브한다.
     * @returns {Promise<{ claude: ProviderHealth, codex: ProviderHealth, grok: ProviderHealth, cursor: ProviderHealth, pi: ProviderHealth, rau: ProviderHealth }>}
     */
    check(refresh = false) {
      if (!refresh && cache && now() - cache.checkedAt < cacheTtlMs) {
        return Promise.resolve(cache.result);
      }
      if (inFlight) return inFlight;
      const probing = Promise.all([
        ...CLI_AGENTS.map((agent) => probe(cliBin(agent) || PROBE_COMMANDS[agent], probeEnv(agent))),
        probePi(),
      ])
        .then((healths) => {
          const result = {};
          CLI_AGENTS.forEach((agent, index) => { result[agent] = healths[index]; });
          result.pi = healths[CLI_AGENTS.length];
          result.rau = result.pi;
          cache = { result, checkedAt: now() };
          return result;
        });
      inFlight = probing;
      probing.then(
        () => { if (inFlight === probing) inFlight = null; },
        () => { if (inFlight === probing) inFlight = null; },
      );
      return probing;
    },
  };
}
