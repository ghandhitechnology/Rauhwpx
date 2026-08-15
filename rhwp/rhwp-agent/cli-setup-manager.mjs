import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { fetchLatestPackage, updatePrefixAtomically } from './harness-update.mjs';

const require = createRequire(import.meta.url);
let crossSpawn = null;

function spawn(command, argv, options) {
  crossSpawn ??= require('cross-spawn');
  return crossSpawn(command, argv, options);
}

const CLI_CONFIG = {
  codex: { package: '@openai/codex', bin: 'codex' },
  claude: { package: '@anthropic-ai/claude-code', bin: 'claude' },
};
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10_000;
const REGISTRY_TIMEOUT_MS = 10_000;
const PROGRESS_INTERVAL_MS = 160;

function setupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanTail(text) {
  return String(text ?? '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-5)
    .join(' / ')
    .slice(-1600);
}

function keyTail(key) {
  const value = String(key ?? '').trim();
  return value ? value.slice(-4) : null;
}

export function defaultCliSetupRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RHWP_CLI_DIR) return path.resolve(env.RHWP_CLI_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'rhwp', 'cli');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'rhwp', 'cli');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rhwp', 'cli');
}

/** App-managed Codex and Claude installers plus their local authentication state. */
export function createCliSetupManager({
  rootDir = defaultCliSetupRoot(),
  spawnProcess = spawn,
  npmCommand = 'npm',
  platform = process.platform,
  baseEnv = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const prefixDir = path.join(rootDir, 'prefix');
  const configPath = path.join(rootDir, 'config.json');
  const binDir = path.join(prefixDir, 'node_modules', '.bin');
  const installs = new Map();
  const authRuns = new Map();
  const updateInfo = new Map([
    ['claude', { latestVersion: null, updateRequired: false }],
    ['codex', { latestVersion: null, updateRequired: false }],
  ]);
  let updateChain = Promise.resolve();
  let loaded = false;
  let config = {
    claudeApiKey: null,
    claudeAuthMethod: null,
    codexAuthMethod: null,
    codexKeyTail: null,
  };

  function assertAgent(agent) {
    if (agent !== 'codex' && agent !== 'claude') {
      throw setupError('AGENT_SETUP_INVALID', `지원하지 않는 에이전트예요: ${agent}`);
    }
    return CLI_CONFIG[agent];
  }

  function binPath(agent) {
    const item = assertAgent(agent);
    return path.join(binDir, platform === 'win32' ? `${item.bin}.cmd` : item.bin);
  }

  function packageJsonPath(agent, basePrefix = prefixDir) {
    const item = assertAgent(agent);
    return path.join(basePrefix, 'node_modules', ...item.package.split('/'), 'package.json');
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
      config.claudeApiKey = typeof raw?.claudeApiKey === 'string' && raw.claudeApiKey.trim()
        ? raw.claudeApiKey.trim()
        : null;
      config.claudeAuthMethod = raw?.claudeAuthMethod === 'api-key' || raw?.claudeAuthMethod === 'oauth'
        ? raw.claudeAuthMethod
        : null;
      config.codexAuthMethod = raw?.codexAuthMethod === 'api-key' || raw?.codexAuthMethod === 'oauth'
        ? raw.codexAuthMethod
        : null;
      config.codexKeyTail = typeof raw?.codexKeyTail === 'string' ? raw.codexKeyTail : null;
    } catch {}
  }

  async function persist() {
    await fs.mkdir(rootDir, { recursive: true });
    const temp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, configPath);
  }

  async function installedVersion(agent, basePrefix = prefixDir) {
    try {
      const raw = JSON.parse(await fs.readFile(packageJsonPath(agent, basePrefix), 'utf8'));
      return typeof raw?.version === 'string' ? raw.version : null;
    } catch {
      return null;
    }
  }

  function envFor(agent) {
    const env = { ...baseEnv, PATH: `${binDir}${path.delimiter}${baseEnv.PATH ?? ''}` };
    if (agent === 'claude' && config.claudeApiKey) env.ANTHROPIC_API_KEY = config.claudeApiKey;
    return env;
  }

  function run(command, argv, { input = null, timeoutMs = STATUS_TIMEOUT_MS, env = baseEnv, onOutput } = {}) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer = null;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      let proc;
      try {
        proc = spawnProcess(command, argv, {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        finish(error);
        return;
      }
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish(setupError('AGENT_SETUP_TIMEOUT', '설정 작업이 제한 시간 안에 끝나지 않았어요.'));
      }, timeoutMs);
      timer.unref?.();
      const collect = (target, chunk) => {
        const text = chunk.toString();
        if (target === 'stdout') stdout += text;
        else stderr += text;
        if (typeof onOutput === 'function') onOutput(text);
      };
      proc.stdout?.on?.('data', (chunk) => collect('stdout', chunk));
      proc.stderr?.on?.('data', (chunk) => collect('stderr', chunk));
      proc.on('error', (error) => finish(error));
      proc.on('close', (code, signal) => finish(null, { code, signal, stdout, stderr }));
      if (input !== null) proc.stdin?.end(input);
      else proc.stdin?.end();
    });
  }

  async function authState(agent) {
    await load();
    if (agent === 'claude' && config.claudeApiKey) {
      return { authenticated: true, authMethod: 'api-key', keyTail: keyTail(config.claudeApiKey) };
    }
    const version = await installedVersion(agent);
    const command = version ? binPath(agent) : assertAgent(agent).bin;
    try {
      const argv = agent === 'codex' ? ['login', 'status'] : ['auth', 'status'];
      const result = await run(command, argv, { env: envFor(agent) });
      return {
        authenticated: result.code === 0,
        authMethod: result.code === 0
          ? (agent === 'codex' ? config.codexAuthMethod : config.claudeAuthMethod) ?? 'oauth'
          : null,
        keyTail: result.code === 0 && agent === 'codex' && config.codexAuthMethod === 'api-key'
          ? config.codexKeyTail
          : null,
      };
    } catch {
      return { authenticated: false, authMethod: null, keyTail: null };
    }
  }

  async function status(agent) {
    assertAgent(agent);
    await load();
    const version = await installedVersion(agent);
    const auth = await authState(agent);
    const update = updateInfo.get(agent);
    return {
      agent,
      installed: Boolean(version),
      installing: installs.has(agent),
      version,
      ...auth,
      authenticating: authRuns.has(agent),
      setupComplete: Boolean(version) && auth.authenticated,
      latestVersion: update?.latestVersion ?? null,
      updateRequired: update?.updateRequired === true,
      error: null,
    };
  }

  async function install(agent, onProgress) {
    const item = assertAgent(agent);
    if (installs.has(agent)) return installs.get(agent);
    const running = (async () => {
      let percent = 0;
      let lastActivity = 0;
      const emit = (phase, nextPercent, detail, activity = false) => {
        percent = Math.max(percent, Math.min(100, nextPercent));
        onProgress?.({
          state: phase === 'done' ? 'done' : 'installing',
          phase,
          percent,
          ...(detail ? { detail } : {}),
          ...(activity ? { activity: true } : {}),
        });
      };
      await load();
      emit('preparing', 8, `${item.bin} CLI 설치 준비 중`);
      await fs.mkdir(prefixDir, { recursive: true });
      emit('resolving', 20, `${item.bin} 패키지 확인 중`);
      emit('installing', 28, `${item.bin} CLI 설치 중`);
      const result = await run(
        npmCommand,
        ['install', '--prefix', prefixDir, '--no-fund', '--no-audit', item.package],
        {
          timeoutMs: INSTALL_TIMEOUT_MS,
          onOutput: () => {
            const now = Date.now();
            if (now - lastActivity < PROGRESS_INTERVAL_MS) return;
            lastActivity = now;
            emit('installing', Math.min(84, percent + 1.5), `${item.bin} CLI 설치 중`, true);
          },
        },
      );
      if (result.code !== 0) {
        const detail = cleanTail(result.stderr || result.stdout);
        throw setupError(
          'AGENT_INSTALL_FAILED',
          detail ? `${item.bin} 설치가 실패했어요: ${detail}` : `${item.bin} 설치가 실패했어요.`,
        );
      }
      emit('verifying', 92, `${item.bin} CLI 확인 중`);
      const version = await installedVersion(agent);
      if (!version) throw setupError('AGENT_INSTALL_FAILED', `${item.bin} 설치본을 확인하지 못했어요.`);
      const update = updateInfo.get(agent);
      if (update?.latestVersion === version) update.updateRequired = false;
      emit('done', 100, version);
      return status(agent);
    })();
    installs.set(agent, running);
    try {
      return await running;
    } finally {
      if (installs.get(agent) === running) installs.delete(agent);
    }
  }

  async function runAutomaticUpdate(agent, canActivate) {
    const item = assertAgent(agent);
    const installed = await installedVersion(agent);
    if (!installed) return status(agent);
    const update = updateInfo.get(agent);

    let latest;
    try {
      latest = await fetchLatestPackage(fetchImpl, item.package, REGISTRY_TIMEOUT_MS);
    } catch {
      return status(agent);
    }
    update.latestVersion = latest.version;
    update.updateRequired = latest.version !== installed;
    if (!update.updateRequired) return status(agent);

    try {
      await updatePrefixAtomically({
        prefixDir,
        label: agent,
        canActivate,
        install: async (stagingDir) => {
          const result = await run(
            npmCommand,
            ['install', '--prefix', stagingDir, '--no-fund', '--no-audit', `${item.package}@${latest.version}`],
            { timeoutMs: INSTALL_TIMEOUT_MS },
          );
          if (result.code !== 0) throw setupError('AGENT_UPDATE_FAILED', 'harness update failed');
        },
        verify: async (stagingDir) => {
          if (await installedVersion(agent, stagingDir) !== latest.version) {
            throw setupError('AGENT_UPDATE_FAILED', 'updated harness version did not verify');
          }
        },
      });
      update.updateRequired = false;
    } catch {
      // 자동 갱신 실패는 작업을 끊지 않는다. 기존 prefix 를 유지하고 상태 카드로만 알린다.
      update.updateRequired = true;
    }
    return status(agent);
  }

  async function authenticate(agent, method, key, onProgress) {
    assertAgent(agent);
    if (authRuns.has(agent)) throw setupError('AGENT_AUTH_BUSY', '이미 로그인 작업이 진행 중이에요.');
    const running = (async () => {
      await load();
      const managedVersion = await installedVersion(agent);
      const command = managedVersion ? binPath(agent) : assertAgent(agent).bin;
      onProgress?.({ state: 'authorizing' });
      if (method === 'api-key') {
        const value = String(key ?? '').trim();
        if (!value) throw setupError('AGENT_KEY_INVALID', 'API 키를 입력해 주세요.');
        if (agent === 'claude') {
          config.claudeApiKey = value;
          config.claudeAuthMethod = 'api-key';
          baseEnv.ANTHROPIC_API_KEY = value;
          await persist();
          onProgress?.({ state: 'done' });
          return status(agent);
        }
        const result = await run(command, ['login', '--with-api-key'], {
          input: `${value}\n`,
          timeoutMs: 30_000,
          env: envFor(agent),
        });
        if (result.code !== 0) {
          throw setupError('AGENT_KEY_INVALID', cleanTail(result.stderr || result.stdout) || 'Codex API 키가 거절됐어요.');
        }
        config.codexAuthMethod = 'api-key';
        config.codexKeyTail = keyTail(value);
        await persist();
        onProgress?.({ state: 'done' });
        return status(agent);
      }
      if (method !== 'oauth') throw setupError('AGENT_AUTH_INVALID', '지원하지 않는 로그인 방식이에요.');
      if (agent === 'claude') {
        config.claudeApiKey = null;
        delete baseEnv.ANTHROPIC_API_KEY;
        await persist();
      }
      let buffered = '';
      const result = await run(
        command,
        agent === 'codex' ? ['login'] : ['auth', 'login'],
        {
          timeoutMs: AUTH_TIMEOUT_MS,
          env: envFor(agent),
          onOutput: (text) => {
            buffered = (buffered + text).slice(-4000);
            const url = buffered.match(/https?:\/\/[^\s<>"']+/)?.[0];
            onProgress?.({ state: 'authorizing', ...(url ? { authUrl: url } : {}) });
          },
        },
      );
      if (result.code !== 0) {
        throw setupError('AGENT_AUTH_FAILED', cleanTail(result.stderr || result.stdout) || '로그인을 완료하지 못했어요.');
      }
      if (agent === 'claude') config.claudeAuthMethod = 'oauth';
      else {
        config.codexAuthMethod = 'oauth';
        config.codexKeyTail = null;
      }
      await persist();
      onProgress?.({ state: 'done' });
      return status(agent);
    })();
    authRuns.set(agent, running);
    try {
      return await running;
    } finally {
      if (authRuns.get(agent) === running) authRuns.delete(agent);
    }
  }

  return {
    rootDir,
    prefixDir,
    binDir,
    binPath,
    envFor,
    async init() {
      await fs.mkdir(rootDir, { recursive: true }).catch(() => {});
      await load();
      return this;
    },
    status,
    install,
    authenticate,
    automaticUpdate(agent, { canActivate = () => true } = {}) {
      const runUpdate = updateChain.then(
        () => runAutomaticUpdate(agent, canActivate),
        () => runAutomaticUpdate(agent, canActivate),
      );
      updateChain = runUpdate.then(() => undefined, () => undefined);
      return runUpdate;
    },
  };
}
