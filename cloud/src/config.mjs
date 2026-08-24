import os from 'node:os';
import path from 'node:path';
import { CloudError, DEFAULT_LIMITS } from './protocol.mjs';

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

export function parseConfig(environment = process.env) {
  const dataDirectory = path.resolve(environment.RAUHWpx_DATA_DIR || '/var/lib/rauhwpx-cloud');
  const platform = environment.RAUHWpx_PLATFORM || process.platform;
  const workerControlMode = environment.RAUHWpx_WORKER_CONTROL_MODE || (platform === 'darwin' ? 'http' : 'socket');
  if (!['http', 'socket'].includes(workerControlMode)) {
    throw new CloudError('CONFIG_INVALID', 'RAUHWpx_WORKER_CONTROL_MODE is invalid');
  }
  return {
    platform,
    host: environment.RAUHWpx_HOST || '127.0.0.1',
    port: port(environment.RAUHWpx_PORT || '7740'),
    basePath: basePath(environment.RAUHWpx_BASE_PATH),
    dataDirectory,
    databasePath: path.join(dataDirectory, 'cloud.sqlite3'),
    blobDirectory: path.join(dataDirectory, 'objects'),
    workerControlDirectory: path.join(dataDirectory, 'worker-control'),
    workerControlSocket: path.join(dataDirectory, 'worker-control', 'control.sock'),
    workerControlMode,
    providerAuthDirectory: path.join(dataDirectory, 'provider-auth'),
    providerCliDirectory: environment.RAUHWpx_PROVIDER_CLI_DIR || '/opt/rauhwpx-cloud/provider-cli',
    workerImage: environment.RAUHWpx_WORKER_IMAGE || 'ghcr.io/ghandhitechnology/rauhwpx-cloud-worker:stable',
    podmanConnection: environment.RAUHWpx_PODMAN_CONNECTION || null,
    releaseChannel: environment.RAUHWpx_CHANNEL === 'prerelease' ? 'prerelease' : 'stable',
    maxRunningSessions: positiveInteger(
      environment.RAUHWpx_MAX_RUNNING,
      'RAUHWpx_MAX_RUNNING',
      DEFAULT_LIMITS.maxRunningSessions,
      { min: 1, max: 8 },
    ),
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
