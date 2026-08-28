import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CloudError } from './protocol.mjs';

const STOP_GRACE_MS = 5_000;

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

/**
 * 앱이 제공하는 샌드박스는 중첩 컨테이너를 만들 수 없는 호스트에서 돈다. 그래서 세션 워커를
 * 같은 컨테이너의 자식 프로세스로 띄우고, 격리는 전용 uid와 세션마다 새로 만드는 작업 디렉터리로
 * 얻는다. 샌드박스 컨테이너 자체가 사용자 한 명에게만 배정되므로 폭발 반경은 그 컨테이너다.
 */
export class LocalRunner {
  constructor(config, {
    spawnProcess = spawn,
    workerEntry = process.env.RAUHWpx_WORKER_ENTRY || '/app/worker/main.mjs',
    nodeExecutable = process.execPath,
    onWorkerExit = () => {},
  } = {}) {
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.workerEntry = workerEntry;
    this.nodeExecutable = nodeExecutable;
    this.onWorkerExit = onWorkerExit;
    this.children = new Map();
  }

  /** all=true 이면 종료된 자식도 돌려준다. 항목에는 running 플래그가 붙는다. */
  async list({ all = false } = {}) {
    return [...this.children.entries()]
      .filter(([, entry]) => all || entry.running)
      .map(([sandboxId, entry]) => ({ sandboxId, sessionId: entry.sessionId, running: entry.running }));
  }

  async start(session, { workerToken, controlSocket }) {
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
    const entry = { sessionId: session.id, child, workspace, temporaryDirectory, running: true };
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
      if (this.children.get(sandboxId) === entry) {
        this.children.delete(sandboxId);
        void Promise.allSettled([
          fs.rm(workspace, { recursive: true, force: true }),
          fs.rm(temporaryDirectory, { recursive: true, force: true }),
        ]);
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
    await Promise.allSettled([...this.children.keys()].map((sandboxId) => this.stop(sandboxId)));
  }

  /** 이미 사라진 샌드박스도 같은 결과를 돌려준다. 작업 디렉터리는 항상 지운다. */
  async stop(sandboxId) {
    if (!sandboxId) return;
    const entry = this.children.get(sandboxId);
    if (!entry) return;
    this.children.delete(sandboxId);
    if (entry.running) {
      const exited = new Promise((resolve) => entry.child.once('exit', resolve));
      try { process.kill(-entry.child.pid, 'SIGTERM'); } catch { entry.child.kill('SIGTERM'); }
      const timer = setTimeout(() => {
        try { process.kill(-entry.child.pid, 'SIGKILL'); } catch { entry.child.kill('SIGKILL'); }
      }, STOP_GRACE_MS);
      timer.unref();
      await exited;
      clearTimeout(timer);
    }
    entry.running = false;
    await Promise.allSettled([
      fs.rm(entry.workspace, { recursive: true, force: true }),
      fs.rm(entry.temporaryDirectory, { recursive: true, force: true }),
    ]);
  }
}
