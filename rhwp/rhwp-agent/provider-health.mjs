import spawn from 'cross-spawn';
import { processTreeSpawnOptions, terminateAndWaitForProcessTreeExit, terminateProcessTree } from './process-tree.mjs';
import { applyManagedCliLaunch } from './npm-cli-launch.mjs';

const PROBE_COMMANDS = Object.freeze({ claude: 'claude', codex: 'codex' });
const CLI_AGENTS = Object.keys(PROBE_COMMANDS);
const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
export const PROBE_STDOUT_LIMIT_BYTES = 64 * 1024;
export const PROBE_STDERR_LIMIT_BYTES = 16 * 1024;

function firstLine(text) { return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null; }
function stderrTail(text) { return String(text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(' / ').slice(-2_000); }

/** Probe supported CLI providers and the locally managed Pi binary. */
export function createProviderHealth({ spawnProcess = spawn, timeoutMs = PROBE_TIMEOUT_MS, cacheTtlMs = CACHE_TTL_MS, now = Date.now, piBin = () => null, cliBin = (agent) => PROBE_COMMANDS[agent], probeEnv = () => undefined, platform = process.platform, nodeCommand = process.execPath } = {}) {
  let cache = null;
  let inFlight = null;
  function probe(command, env) {
    return new Promise((resolve) => {
      let settled = false; let stdout = ''; let stderr = ''; let timer;
      const done = (health) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ...health, checkedAt: now() }); };
      let proc;
      try {
        const launched = applyManagedCliLaunch(command, ['--version'], { platform, nodeCommand, env });
        proc = spawnProcess(launched.command, launched.argv, { stdio: ['ignore', 'pipe', 'pipe'], ...processTreeSpawnOptions(platform), env: launched.env });
      } catch (error) { done({ available: false, version: null, error: `${command} 실행에 실패했습니다: ${error?.message ?? error}` }); return; }
      timer = setTimeout(() => { void terminateAndWaitForProcessTreeExit(proc, { timeoutMs: 2_000, terminateProcess: terminateProcessTree, terminateOptions: { platform, spawnProcess, env: env ?? process.env } }).finally(() => done({ available: false, version: null, error: `${command} --version 이 시간 초과되었습니다.` })); }, timeoutMs);
      proc.stdout?.on('data', (chunk) => { stdout += String(chunk); if (Buffer.byteLength(stdout) > PROBE_STDOUT_LIMIT_BYTES) proc.kill?.(); });
      proc.stderr?.on('data', (chunk) => { stderr += String(chunk); if (Buffer.byteLength(stderr) > PROBE_STDERR_LIMIT_BYTES) proc.kill?.(); });
      proc.on('error', (error) => done({ available: false, version: null, error: `${command} 실행에 실패했습니다: ${error?.message ?? error}` }));
      proc.on('close', (code, signal) => { if (code === 0) done({ available: true, version: firstLine(stdout), error: null }); else done({ available: false, version: null, error: stderrTail(stderr) || `${command} --version 이 실패했습니다 (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).` }); });
    });
  }
  function probePi() { const bin = typeof piBin === 'function' ? piBin() : null; return typeof bin === 'string' && bin ? probe(bin) : Promise.resolve({ available: false, version: null, error: '설치되지 않았어요', checkedAt: now() }); }
  return {
    cached: () => cache?.result ?? null,
    check(refresh = false) {
      if (!refresh && cache && now() - cache.checkedAt < cacheTtlMs) return Promise.resolve(cache.result);
      if (inFlight) return inFlight;
      inFlight = Promise.all([...CLI_AGENTS.map((agent) => probe(cliBin(agent) || PROBE_COMMANDS[agent], probeEnv(agent))), probePi()]).then((healths) => { const result = {}; CLI_AGENTS.forEach((agent, index) => { result[agent] = healths[index]; }); result.pi = healths[CLI_AGENTS.length]; cache = { result, checkedAt: now() }; return result; }).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
