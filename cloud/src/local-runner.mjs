import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CloudError } from './protocol.mjs';

const STOP_GRACE_MS = 5_000;
const GROUP_POLL_MS = 25;
const GROUP_KILL_WAIT_MS = 1_000;

const sleep = (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs));

/** 워커가 이미지에서 받아야 하는 실행 경로. 값은 비밀이 아니고 경로뿐이다. */
const WORKER_RUNTIME_ENV = Object.freeze([
  'PUPPETEER_EXECUTABLE_PATH',
  'RAUHWpx_AGENT_ROOT',
  'RAUHWpx_DOCUMENT_RUNTIME',
  'RAUHWpx_PI_PREFIX',
  'RAUHWpx_PROVIDER_CLI_PREFIX',
  'RAUHWpx_STUDIO_DIST',
  'RHWP_BIN',
]);

const WORKER_BASE_ENV = Object.freeze([
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TZ',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

/**
 * Podman 실행에서는 워커 컨테이너가 컨트롤 플레인 환경을 물려받지 않는다. local 실행도 같아야 한다.
 * 워커와 provider CLI는 같은 uid로 돌기 때문에 워커 환경에 남은 비밀은 에이전트가 읽을 수 있다.
 *
 * DISPLAY / XAUTHORITY 는 컨트롤 플레인에서 물려받지 않는다. 세션 워커가 SessionDisplay 로
 * 직접 띄운 뒤에야 hub env 에 실어 보낸다 (session 값으로만 전달 가능).
 */
export function workerEnvironment(environment, session) {
  const result = {};
  for (const name of [...WORKER_BASE_ENV, ...WORKER_RUNTIME_ENV]) {
    const value = environment?.[name];
    if (typeof value === 'string' && value) result[name] = value;
  }
  return { ...result, ...session };
}

async function chownTree(root, uid, gid) {
  await fs.chown(root, uid, gid);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await chownTree(target, uid, gid);
    else await fs.lchown(target, uid, gid);
  }
}

function processGroupExists(groupId) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function signalProcessGroup(groupId, signal) {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessGroupExit(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(groupId)) {
    if (Date.now() >= deadline) return false;
    await sleep(GROUP_POLL_MS);
  }
  return true;
}

async function terminateProcessGroup(entry, { fallbackToChild = false } = {}) {
  if (entry.groupTermination) return entry.groupTermination;
  entry.groupTermination = (async () => {
    const signaled = signalProcessGroup(entry.groupId, 'SIGTERM');
    if (!signaled) {
      if (fallbackToChild && entry.running) entry.child.kill('SIGTERM');
      return;
    }
    if (await waitForProcessGroupExit(entry.groupId, STOP_GRACE_MS)) return;
    signalProcessGroup(entry.groupId, 'SIGKILL');
    await waitForProcessGroupExit(entry.groupId, GROUP_KILL_WAIT_MS);
  })();
  return entry.groupTermination;
}

function activeLinuxProcessOwnedByUid(status, uid) {
  const state = /^State:\s+(\S+)/m.exec(status);
  if (!state) throw new Error('Linux process status has no State field');
  if (state[1] === 'Z') return false;
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
  if (!match) throw new Error('Linux process status has no Uid field');
  return match.slice(1).some((value) => Number(value) === uid);
}

async function listLinuxProcessesForUid(uid) {
  const processes = [];
  for (const entry of await fs.readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    let status;
    try {
      status = await fs.readFile(path.join('/proc', entry.name, 'status'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    try {
      if (activeLinuxProcessOwnedByUid(status, uid)) processes.push(pid);
    } catch (error) {
      throw new Error(`/proc/${entry.name}/status is invalid`, { cause: error });
    }
  }
  return processes.sort((left, right) => left - right);
}

export const __test = Object.freeze({ activeLinuxProcessOwnedByUid });

function cleanupError(message, workerUid, details = {}, cause) {
  const error = new CloudError('LOCAL_WORKER_CLEANUP_FAILED', message, 503, { workerUid, ...details });
  if (cause) error.cause = cause;
  return error;
}

/**
 * 앱이 제공하는 샌드박스는 중첩 컨테이너를 만들 수 없는 호스트에서 돈다. 그래서 세션 워커를
 * 같은 컨테이너의 자식 프로세스로 띄운다. 전용 워커 uid 전체를 세션 사이에 비우고, 세션별 작업
 * 디렉터리도 분리한다. Scheduler는 이 runner의 동시 실행 수를 1로 제한한다.
 */
export class LocalRunner {
  constructor(config, {
    spawnProcess = spawn,
    workerEntry = process.env.RAUHWpx_WORKER_ENTRY || '/app/worker/main.mjs',
    nodeExecutable = process.execPath,
    onWorkerExit = () => {},
    controlPlaneUid = process.getuid?.() ?? null,
    controlPlanePid = process.pid,
    listUidProcesses = process.platform === 'linux' ? listLinuxProcessesForUid : null,
    signalProcess = (pid, signal) => process.kill(pid, signal),
    wait = sleep,
    uidStopGraceMs = STOP_GRACE_MS,
    uidKillWaitMs = GROUP_KILL_WAIT_MS,
    uidPollMs = GROUP_POLL_MS,
  } = {}) {
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.workerEntry = workerEntry;
    this.nodeExecutable = nodeExecutable;
    this.onWorkerExit = onWorkerExit;
    this.controlPlanePid = controlPlanePid;
    this.listUidProcesses = listUidProcesses;
    this.signalProcess = signalProcess;
    this.wait = wait;
    this.uidStopGraceMs = uidStopGraceMs;
    this.uidKillWaitMs = uidKillWaitMs;
    this.uidPollMs = uidPollMs;
    this.workerUidBoundaryRequired = config.workerUid !== null && config.workerUid !== controlPlaneUid;
    this.hardIsolationAvailable = this.workerUidBoundaryRequired && typeof listUidProcesses === 'function';
    this.uidSweep = Promise.resolve();
    this.maxRunningSessions = 1;
    this.children = new Map();
  }

  /** all=true 이면 종료된 자식도 돌려준다. 항목에는 running 플래그가 붙는다. */
  async list({ all = false } = {}) {
    return [...this.children.entries()]
      .filter(([, entry]) => all || entry.running)
      .map(([sandboxId, entry]) => ({ sandboxId, sessionId: entry.sessionId, running: entry.running }));
  }

  async start(session, { workerToken, controlSocket }) {
    await this.#sweepWorkerUid();
    const sandboxId = `local-${randomUUID()}`;
    const workspace = path.join(this.config.workspaceRoot, sandboxId);
    // Chromium's process-singleton socket is limited to a 108-byte Unix path.
    // Keep its TMPDIR short instead of nesting it under the durable workspace path.
    const temporaryDirectory = path.join('/tmp', `rw-${sandboxId.slice(-12)}`);
    const source = path.join(this.config.providerAuthDirectory, session.provider);
    await fs.mkdir(source, { recursive: true, mode: 0o700 });
    await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
    // 워커는 컨트롤 플레인의 데이터 디렉터리를 지날 수 없다. 세션마다 자격 증명 사본을 준다.
    const providerAuth = path.join(workspace, 'provider-auth');
    await fs.cp(source, providerAuth, { recursive: true, force: true });
    await fs.mkdir(temporaryDirectory, { recursive: false, mode: 0o700 });
    const { workerUid, workerGid } = this.config;
    if (workerUid !== null) {
      await chownTree(workspace, workerUid, workerGid ?? workerUid);
      await fs.chown(temporaryDirectory, workerUid, workerGid ?? workerUid);
      await fs.chmod(workspace, 0o700);
      await fs.chmod(temporaryDirectory, 0o700);
    }
    const home = path.join(workspace, 'home');
    const child = this.spawnProcess(this.nodeExecutable, [this.workerEntry], {
      cwd: workspace,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(workerUid === null ? {} : { uid: workerUid, gid: workerGid ?? workerUid }),
      env: workerEnvironment(process.env, {
        HOME: home,
        CODEX_HOME: path.join(home, '.codex'),
        GROK_HOME: path.join(home, '.grok'),
        PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
        TMPDIR: temporaryDirectory,
        RAUHWpx_SESSION_ID: session.id,
        RAUHWpx_PROVIDER: session.provider,
        RAUHWpx_WORKER_TOKEN: workerToken,
        RAUHWpx_CONTROL_SOCKET: controlSocket,
        RAUHWpx_WORKSPACE: workspace,
        RAUHWpx_PROVIDER_AUTH: providerAuth,
      }),
    });
    let resolveExit;
    const entry = {
      sessionId: session.id,
      child,
      groupId: child.pid,
      workspace,
      temporaryDirectory,
      running: true,
      stopping: false,
      cleanup: null,
      groupTermination: null,
      exited: new Promise((resolve) => { resolveExit = resolve; }),
    };
    this.children.set(sandboxId, entry);
    // stderr is the worker's only diagnostics channel; an unread pipe fills
    // up and blocks the worker, so keep a bounded tail and log it on exit.
    let stderrTail = '';
    if (typeof child.stderr?.on === 'function') {
      child.stderr.on('data', (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
      });
      child.stderr.unref?.();
    }
    const exited = (code) => {
      entry.running = false;
      resolveExit();
      if (!entry.stopping && this.children.get(sandboxId) === entry) {
        void this.#cleanupEntry(sandboxId, entry, { terminate: true }).catch((error) => {
          entry.cleanupError = error;
        });
      }
      if (code) this.onWorkerExit?.(sandboxId, session.id, code, stderrTail.trim());
    };
    child.once('error', (error) => {
      entry.running = false;
      entry.error = error;
    });
    child.once('exit', (code) => exited(code));
    child.unref();
    await new Promise((resolve) => setImmediate(resolve));
    if (entry.error) {
      this.children.delete(sandboxId);
      await Promise.allSettled([
        fs.rm(workspace, { recursive: true, force: true }),
        fs.rm(temporaryDirectory, { recursive: true, force: true }),
      ]);
      throw new CloudError('WORKER_SPAWN_FAILED', entry.error.message, 503);
    }
    return sandboxId;
  }

  /** Graceful shutdown must not leave detached workers running. */
  async stopAll() {
    const results = await Promise.allSettled([...this.children.keys()].map((sandboxId) => this.stop(sandboxId)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  /** 이미 사라진 샌드박스도 같은 결과를 돌려준다. uid 정리에 실패하면 복구용 작업 디렉터리를 남긴다. */
  async stop(sandboxId) {
    if (!sandboxId) return;
    const entry = this.children.get(sandboxId);
    if (!entry) return;
    entry.stopping = true;
    await this.#cleanupEntry(sandboxId, entry, { terminate: entry.running, fallbackToChild: true });
  }

  #cleanupEntry(sandboxId, entry, { terminate = false, fallbackToChild = false } = {}) {
    if (entry.cleanup) return entry.cleanup;
    const cleanup = (async () => {
      let groupError;
      if (terminate) {
        try {
          await terminateProcessGroup(entry, { fallbackToChild });
        } catch (error) {
          groupError = error;
        }
      }
      if (this.workerUidBoundaryRequired) await this.#sweepWorkerUid();
      else if (groupError) throw groupError;
      if (entry.running) await entry.exited;
      entry.running = false;
      if (this.children.get(sandboxId) === entry) this.children.delete(sandboxId);
      await Promise.allSettled([
        fs.rm(entry.workspace, { recursive: true, force: true }),
        fs.rm(entry.temporaryDirectory, { recursive: true, force: true }),
      ]);
    })();
    const wrappedCleanup = cleanup.catch((error) => {
      if (entry.cleanup === wrappedCleanup) entry.cleanup = null;
      throw error;
    });
    entry.cleanup = wrappedCleanup;
    return wrappedCleanup;
  }

  #sweepWorkerUid() {
    if (!this.workerUidBoundaryRequired) return Promise.resolve();
    const sweep = this.uidSweep.catch(() => {}).then(() => this.#performWorkerUidSweep());
    this.uidSweep = sweep;
    return sweep;
  }

  async #performWorkerUidSweep() {
    const { workerUid } = this.config;
    if (!this.hardIsolationAvailable) {
      throw cleanupError('Dedicated worker uid cleanup is unavailable on this platform', workerUid, {
        reason: 'UID_INVENTORY_UNAVAILABLE',
      });
    }
    let remaining = await this.#workerPids();
    if (remaining.length === 0) return;
    remaining = await this.#signalWorkerUidUntilEmpty('SIGTERM', this.uidStopGraceMs);
    if (remaining.length === 0) return;
    remaining = await this.#signalWorkerUidUntilEmpty('SIGKILL', this.uidKillWaitMs);
    if (remaining.length > 0) {
      throw cleanupError('Dedicated worker uid still owns processes after cleanup', workerUid, {
        remainingPids: remaining,
      });
    }
  }

  async #signalWorkerUidUntilEmpty(signal, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let emptyInventories = 0;
    while (true) {
      const pids = await this.#workerPids();
      if (pids.length === 0) {
        emptyInventories += 1;
        if (emptyInventories === 2) return [];
      } else {
        emptyInventories = 0;
        await Promise.all(pids.map(async (pid) => {
          try {
            await this.signalProcess(pid, signal);
          } catch (error) {
            if (error.code !== 'ESRCH') {
              throw cleanupError(`Failed to send ${signal} to worker process ${pid}`, this.config.workerUid, {
                pid,
                signal,
              }, error);
            }
          }
        }));
      }
      if (Date.now() >= deadline) return this.#workerPids();
      await this.wait(Math.min(this.uidPollMs, Math.max(0, deadline - Date.now())));
    }
  }

  async #workerPids() {
    let pids;
    try {
      pids = await this.listUidProcesses(this.config.workerUid);
    } catch (error) {
      if (error instanceof CloudError && error.code === 'LOCAL_WORKER_CLEANUP_FAILED') throw error;
      throw cleanupError('Failed to inventory dedicated worker uid processes', this.config.workerUid, {}, error);
    }
    if (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)) {
      throw cleanupError('Dedicated worker uid process inventory was invalid', this.config.workerUid);
    }
    return [...new Set(pids)].filter((pid) => pid !== this.controlPlanePid).sort((left, right) => left - right);
  }
}
