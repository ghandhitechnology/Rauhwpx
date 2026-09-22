import spawn from 'cross-spawn';
import { processTreeSpawnOptions, terminateAndWaitForProcessTreeExit, terminateProcessTree } from './process-tree.mjs';
import { applyManagedCliLaunch } from './npm-cli-launch.mjs';

const PROBE_COMMANDS = Object.freeze({ claude: 'claude', codex: 'codex' });
const CLI_AGENTS = Object.keys(PROBE_COMMANDS);
const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
const STDERR_TAIL_LIMIT = 2_000;
export const PROBE_STDOUT_LIMIT_BYTES = 64 * 1024;
export const PROBE_STDERR_LIMIT_BYTES = 16 * 1024;
const PI_NOT_INSTALLED = '설치되지 않았어요';

function firstLine(text) { return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null; }
function stderrTail(text) { return String(text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(' / ').slice(-STDERR_TAIL_LIMIT); }

/** Probe supported CLI providers and the locally managed Pi binary. */
export function createProviderHealth({ spawnProcess = spawn, timeoutMs = PROBE_TIMEOUT_MS, cacheTtlMs = CACHE_TTL_MS, now = Date.now, piBin = () => null, cliBin = (agent) => PROBE_COMMANDS[agent], probeEnv = () => undefined, platform = process.platform, nodeCommand = process.execPath } = {}) {
  let cache = null;
  let inFlight = null;
  function probe(command, env) {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let forcedHealth = null;
      let timer = null;
      const done = (health) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve({ ...health, checkedAt: now() }); };
      const stopWith = (health) => {
        if (settled || forcedHealth) return;
        forcedHealth = health;
        void terminateAndWaitForProcessTreeExit(proc, {
          timeoutMs: Math.min(4_000, Math.max(1_500, timeoutMs)),
          terminateProcess: terminateProcessTree,
          terminateOptions: { platform, spawnProcess, graceMs: 1_000, env: env ?? process.env },
        }).finally(() => done(health));
      };
      let proc;
      try {
        const launched = applyManagedCliLaunch(command, ['--version'], { platform, nodeCommand, env });
        const options = { stdio: ['ignore', 'pipe', 'pipe'], ...processTreeSpawnOptions(platform) };
        if (env || (launched.env && Object.keys(launched.env).length > 0)) options.env = launched.env;
        proc = spawnProcess(launched.command, launched.argv, options);
      } catch (error) { done({ available: false, version: null, error: `${command} 실행에 실패했습니다: ${error?.message ?? error}` }); return; }
      timer = setTimeout(() => stopWith({ available: false, version: null, error: `${command} --version 이 ${Math.round(timeoutMs / 100) / 10}초 안에 응답하지 않았습니다.` }), timeoutMs);
      proc.stdout?.on?.('data', (chunk) => {
        if (settled || forcedHealth) return;
        stdoutBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
        if (stdoutBytes > PROBE_STDOUT_LIMIT_BYTES) { stopWith({ available: false, version: null, error: `${command} --version stdout 이 64 KiB 안전 한도를 넘었습니다.` }); return; }
        stdout += String(chunk);
      });
      proc.stderr?.on?.('data', (chunk) => {
        if (settled || forcedHealth) return;
        stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
        if (stderrBytes > PROBE_STDERR_LIMIT_BYTES) { stopWith({ available: false, version: null, error: `${command} --version stderr 이 16 KiB 안전 한도를 넘었습니다.` }); return; }
        stderr += String(chunk);
      });
      proc.stdout?.on?.('error', () => {});
      proc.stderr?.on?.('error', () => {});
      proc.on('error', (error) => {
        if (forcedHealth) return;
        done({ available: false, version: null, error: error?.code === 'ENOENT' ? `${command} 명령을 찾을 수 없습니다 — CLI 를 설치하고 PATH 에 등록하세요.` : `${command} 실행에 실패했습니다: ${error?.message ?? error}` });
      });
      const finish = (code, signal) => {
        if (forcedHealth) return;
        if (code === 0) { done({ available: true, version: firstLine(stdout), error: null }); return; }
        const exit = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        const detail = stderrTail(stderr);
        done({ available: false, version: null, error: detail ? `${command} --version 이 실패했습니다 (${exit}): ${detail}` : `${command} --version 이 실패했습니다 (${exit}).` });
      };
      proc.on('close', finish);
      proc.on('exit', (code, signal) => setImmediate(() => finish(code, signal)));
    });
  }
  function probePi() {
    let bin = null;
    try { bin = typeof piBin === 'function' ? piBin() : null; } catch {}
    if (typeof bin !== 'string' || !bin) return Promise.resolve({ available: false, version: null, error: PI_NOT_INSTALLED, checkedAt: now() });
    return probe(bin).then((health) => (!health.available && /찾을 수 없습니다/.test(health.error ?? '') ? { ...health, error: PI_NOT_INSTALLED } : health));
  }
  return {
    cached: () => cache?.result ?? null,
    check(refresh = false) {
      if (!refresh && cache && now() - cache.checkedAt < cacheTtlMs) return Promise.resolve(cache.result);
      if (inFlight) return inFlight;
      const probing = Promise.all([...CLI_AGENTS.map((agent) => probe(cliBin(agent) || PROBE_COMMANDS[agent], probeEnv(agent))), probePi()]).then((healths) => { const result = {}; CLI_AGENTS.forEach((agent, index) => { result[agent] = healths[index]; }); result.pi = healths[CLI_AGENTS.length]; cache = { result, checkedAt: now() }; return result; });
      inFlight = probing;
      probing.then(() => { if (inFlight === probing) inFlight = null; }, () => { if (inFlight === probing) inFlight = null; });
      return probing;
    },
  };
}
