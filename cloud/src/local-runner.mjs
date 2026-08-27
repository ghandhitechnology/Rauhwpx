import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CloudError } from './protocol.mjs';

const STOP_GRACE_MS = 5_000;

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
  } = {}) {
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.workerEntry = workerEntry;
    this.nodeExecutable = nodeExecutable;
    this.children = new Map();
  }

  /** all 여부와 무관하게 살아 있는 자식만 있다. 재시작하면 비어 있고 스케줄러가 다시 큐에 넣는다. */
  async list() {
    return [...this.children.entries()]
      .filter(([, entry]) => entry.running)
      .map(([sandboxId, entry]) => ({ sandboxId, sessionId: entry.sessionId }));
  }

  async start(session, { workerToken, controlSocket }) {
    const sandboxId = `local-${randomUUID()}`;
    const workspace = path.join(this.config.workspaceRoot, sandboxId);
    const source = path.join(this.config.providerAuthDirectory, session.provider);
    await fs.mkdir(source, { recursive: true, mode: 0o700 });
    await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
    // 워커는 컨트롤 플레인의 데이터 디렉터리를 지날 수 없다. 세션마다 자격 증명 사본을 준다.
    const providerAuth = path.join(workspace, 'provider-auth');
    await fs.cp(source, providerAuth, { recursive: true, force: true });
    const { workerUid, workerGid } = this.config;
    if (workerUid !== null) {
      await chownTree(workspace, workerUid, workerGid ?? workerUid);
      await fs.chmod(workspace, 0o700);
    }
    const home = path.join(workspace, 'home');
    const child = this.spawnProcess(this.nodeExecutable, [this.workerEntry], {
      cwd: workspace,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(workerUid === null ? {} : { uid: workerUid, gid: workerGid ?? workerUid }),
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, '.codex'),
        GROK_HOME: path.join(home, '.grok'),
        PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
        TMPDIR: path.join(workspace, 'tmp'),
        RAUHWpx_SESSION_ID: session.id,
        RAUHWpx_PROVIDER: session.provider,
        RAUHWpx_WORKER_TOKEN: workerToken,
        RAUHWpx_CONTROL_SOCKET: controlSocket,
        RAUHWpx_WORKSPACE: workspace,
        RAUHWpx_PROVIDER_AUTH: providerAuth,
      },
    });
    const entry = { sessionId: session.id, child, workspace, running: true };
    this.children.set(sandboxId, entry);
    child.once('error', (error) => {
      entry.running = false;
      entry.error = error;
    });
    child.once('exit', () => { entry.running = false; });
    child.unref();
    child.stderr?.unref?.();
    await new Promise((resolve) => setImmediate(resolve));
    if (entry.error) {
      this.children.delete(sandboxId);
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
      throw new CloudError('WORKER_SPAWN_FAILED', entry.error.message, 503);
    }
    return sandboxId;
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
    await fs.rm(entry.workspace, { recursive: true, force: true }).catch(() => {});
  }
}
