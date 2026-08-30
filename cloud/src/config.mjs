import os from 'node:os';
import path from 'node:path';
import { CloudError, DEFAULT_LIMITS, PROVIDERS } from './protocol.mjs';

function port(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new CloudError('CONFIG_INVALID', 'RAUHWpx_PORT is invalid');
  return parsed;
}

function positiveInteger(value, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new CloudError('CONFIG_INVALID', `${name} is invalid`);
  return parsed;
}

function basePath(value) {
  const pathValue = value || '/rauhwpx-cloud';
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(pathValue) || pathValue.endsWith('/')) {
    throw new CloudError('CONFIG_INVALID', 'RAUHWpx_BASE_PATH is invalid');
  }
  return pathValue;
}

function bootstrapToken(value) {
  if (value === undefined || value === '') return '';
  const token = String(value);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new CloudError('CONFIG_INVALID', 'RAUHWpx_BOOTSTRAP_TOKEN is invalid');
  }
  return token;
}

function runnerKind(value) {
  if (value === undefined || value === '') return 'podman';
  if (value !== 'podman' && value !== 'local') {
    throw new CloudError('CONFIG_INVALID', 'RAUHWpx_RUNNER must be podman or local');
  }
  return value;
}

function userId(value, name) {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2 ** 31 - 1) {
    throw new CloudError('CONFIG_INVALID', `${name} is invalid`);
  }
  return parsed;
}

function startupProviders(value) {
  if (value === undefined || value === '') return [...PROVIDERS];
  if (!PROVIDERS.includes(value)) {
    throw new CloudError('CONFIG_INVALID', 'RAUHWpx_SANDBOX_PROVIDER is invalid');
  }
  return [value];
}

function browserOrigins(value) {
  if (value === undefined || value === '') return [];
  const origins = [...new Set(String(value).split(',').map((entry) => entry.trim()).filter(Boolean))];
  if (origins.length > 20 || origins.some((entry) => {
    try {
      const parsed = new URL(entry);
      return parsed.origin !== entry || parsed.protocol !== 'https:';
    } catch {
      return true;
    }
  })) {
    throw new CloudError('CONFIG_INVALID', 'RAUHWpx_BROWSER_ORIGINS must contain exact HTTPS origins');
  }
  return origins;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function parseConfig(environment = process.env) {
  const dataDirectory = path.resolve(environment.RAUHWpx_DATA_DIR || '/var/lib/rauhwpx-cloud');
  const platform = environment.RAUHWpx_PLATFORM || process.platform;
  const workerControlMode = environment.RAUHWpx_WORKER_CONTROL_MODE || (platform === 'darwin' ? 'http' : 'socket');
  if (!['http', 'socket'].includes(workerControlMode)) {
    throw new CloudError('CONFIG_INVALID', 'RAUHWpx_WORKER_CONTROL_MODE is invalid');
  }
  const runner = runnerKind(environment.RAUHWpx_RUNNER);
  const workerUid = userId(environment.RAUHWpx_WORKER_UID, 'RAUHWpx_WORKER_UID');
  if (runner === 'local' && workerUid === null && process.getuid?.() === 0) {
    throw new CloudError('CONFIG_INVALID', 'RAUHWpx_WORKER_UID is required when the local runner runs as root');
  }
  // 워커가 다른 uid로 도는 local 실행에서는 컨트롤 소켓이 데이터 디렉터리 밖에 있어야 한다.
  const workerControlDirectory = environment.RAUHWpx_WORKER_CONTROL_DIR
    ? path.resolve(environment.RAUHWpx_WORKER_CONTROL_DIR)
    : path.join(dataDirectory, 'worker-control');
  const workspaceRoot = environment.RAUHWpx_WORKSPACE_ROOT
    ? path.resolve(environment.RAUHWpx_WORKSPACE_ROOT)
    : runner === 'local'
      ? '/var/lib/rauhwpx-workspaces'
      : path.join(dataDirectory, 'workspaces');
  if (runner === 'local' && workerUid !== null && contains(dataDirectory, workspaceRoot)) {
    // 데이터 디렉터리는 0700이라 워커 uid가 통과하지 못한다. 세션마다 EACCES로 죽는 대신 부팅에서 막는다.
    throw new CloudError('CONFIG_INVALID', 'RAUHWpx_WORKSPACE_ROOT must live outside RAUHWpx_DATA_DIR');
  }
  const configuredMaxRunningSessions = positiveInteger(
    environment.RAUHWpx_MAX_RUNNING,
    'RAUHWpx_MAX_RUNNING',
    DEFAULT_LIMITS.maxRunningSessions,
    { min: 1, max: 8 },
  );
  return {
    platform,
    host: environment.RAUHWpx_HOST || '127.0.0.1',
    port: port(environment.RAUHWpx_PORT || '7740'),
    bootstrapToken: bootstrapToken(environment.RAUHWpx_BOOTSTRAP_TOKEN),
    basePath: basePath(environment.RAUHWpx_BASE_PATH),
    runner,
    workerUid,
    workerGid: userId(environment.RAUHWpx_WORKER_GID, 'RAUHWpx_WORKER_GID') ?? workerUid,
    workspaceRoot,
    dataDirectory,
    databasePath: path.join(dataDirectory, 'cloud.sqlite3'),
    blobDirectory: path.join(dataDirectory, 'objects'),
    workerControlDirectory,
    workerControlSocket: path.join(workerControlDirectory, 'control.sock'),
    workerControlMode,
    providerAuthDirectory: path.join(dataDirectory, 'provider-auth'),
    providerCliDirectory: environment.RAUHWpx_PROVIDER_CLI_DIR || '/opt/rauhwpx-cloud/provider-cli',
    startupProviders: startupProviders(environment.RAUHWpx_SANDBOX_PROVIDER),
    browserOrigins: browserOrigins(environment.RAUHWpx_BROWSER_ORIGINS),
    workerImage: environment.RAUHWpx_WORKER_IMAGE || 'ghcr.io/ghandhitechnology/rauhwpx-cloud-worker:stable',
    podmanConnection: environment.RAUHWpx_PODMAN_CONNECTION || null,
    releaseChannel: environment.RAUHWpx_CHANNEL === 'prerelease' ? 'prerelease' : 'stable',
    maxRunningSessions: runner === 'local' ? 1 : configuredMaxRunningSessions,
    maxQueuedSessions: positiveInteger(
      environment.RAUHWpx_MAX_QUEUED,
      'RAUHWpx_MAX_QUEUED',
      DEFAULT_LIMITS.maxQueuedSessions,
      { min: 1, max: 100 },
    ),
    workerCpuCount: positiveInteger(environment.RAUHWpx_WORKER_CPUS, 'RAUHWpx_WORKER_CPUS', DEFAULT_LIMITS.cpuCount, { max: os.cpus().length || 1 }),
    workerMemoryBytes: positiveInteger(environment.RAUHWpx_WORKER_MEMORY_BYTES, 'RAUHWpx_WORKER_MEMORY_BYTES', DEFAULT_LIMITS.memoryBytes),
    workerPids: positiveInteger(environment.RAUHWpx_WORKER_PIDS, 'RAUHWpx_WORKER_PIDS', DEFAULT_LIMITS.pids),
    workspaceBytes: positiveInteger(environment.RAUHWpx_WORKSPACE_BYTES, 'RAUHWpx_WORKSPACE_BYTES', DEFAULT_LIMITS.workspaceBytes),
  };
}
