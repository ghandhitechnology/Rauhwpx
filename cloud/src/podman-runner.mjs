import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CloudError } from './protocol.mjs';

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 4_096;

function command(spawnProcess, executable, args, {
  input,
  timeoutMs = 30_000,
  rejectStdoutOverflow = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(new CloudError('PODMAN_TIMEOUT', `${executable} command timed out`, 503));
    }, timeoutMs);
    let stdoutBytes = 0;
    const append = (current, chunk) => `${current}${chunk}`.slice(-MAX_COMMAND_OUTPUT_BYTES);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (rejectStdoutOverflow && stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        done(new CloudError('PODMAN_OUTPUT_LIMIT', `${executable} output exceeded the safe limit`, 503));
        return;
      }
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => done(new CloudError('PODMAN_UNAVAILABLE', error.message, 503)));
    child.on('close', (code) => done(
      code === 0 ? null : new CloudError('PODMAN_FAILED', stderr.trim() || `${executable} exited ${code}`, 503),
      stdout.trim(),
    ));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

function invalidInventory() {
  return new CloudError('PODMAN_RESPONSE_INVALID', 'Podman returned an invalid container inventory', 503);
}

function parseInventory(output) {
  let entries;
  try {
    entries = JSON.parse(output);
  } catch {
    throw invalidInventory();
  }
  if (!Array.isArray(entries) || entries.length > MAX_LIST_ENTRIES) throw invalidInventory();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalidInventory();
    const { Id: sandboxId, Labels: labels } = entry;
    if (typeof sandboxId !== 'string' || !/^[a-f0-9]{64}$/i.test(sandboxId)) throw invalidInventory();
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw invalidInventory();
    const sessionId = labels['com.rauhwpx.session'];
    if (typeof sessionId !== 'string'
      || sessionId.length < 8
      || sessionId.length > 128
      || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw invalidInventory();
    }
    return { sandboxId, sessionId };
  });
}

export class PodmanRunner {
  constructor(config, { spawnProcess = spawn } = {}) {
    this.config = config;
    this.spawnProcess = spawnProcess;
  }

  async list({ all = false } = {}) {
    const args = [
      '--cgroup-manager=cgroupfs', 'ps', '--no-trunc', ...(all ? ['--all'] : []), '--filter', 'label=com.rauhwpx.cloud=true',
      '--format', 'json',
    ];
    const output = await command(this.spawnProcess, 'podman', args, { rejectStdoutOverflow: true });
    return parseInventory(output);
  }

  async start(session, { workerToken, controlSocket }) {
    const providerAuth = path.join(this.config.providerAuthDirectory, session.provider);
    await fs.mkdir(providerAuth, { recursive: true, mode: 0o700 });
    const name = `rauhwpx-${session.id.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48)}`;
    return command(this.spawnProcess, 'podman', [
      '--cgroup-manager=cgroupfs', 'run', '--detach', '--replace', '--name', name,
      '--label', 'com.rauhwpx.cloud=true',
      '--label', `com.rauhwpx.session=${session.id}`,
      '--log-driver', 'k8s-file', '--log-opt', 'max-size=1048576',
      '--uidmap', '0:1:1000',
      '--uidmap', '1000:0:1',
      '--uidmap', '1001:1001:64535',
      '--gidmap', '0:1:1000',
      '--gidmap', '1000:0:1',
      '--gidmap', '1001:1001:64535',
      '--security-opt=no-new-privileges', '--cap-drop=all', '--read-only',
      '--cpus', String(this.config.workerCpuCount),
      '--memory', String(this.config.workerMemoryBytes),
      '--pids-limit', String(this.config.workerPids),
      // Podman 4.9 rejects uid=/gid= tmpfs mount options and always creates
      // tmpfs roots as container root. Each mount is private to this sandbox;
      // sticky 1777 makes it usable by the image's UID 1000 worker, whose
      // startup umask keeps every created file private.
      '--tmpfs', `/workspace:rw,size=${this.config.workspaceBytes},mode=1777`,
      '--tmpfs', '/tmp:rw,size=268435456,mode=1777',
      '--volume', `${providerAuth}:/provider-auth:ro,Z`,
      '--volume', `${path.dirname(controlSocket)}:/run/rauhwpx:ro,Z`,
      '--env', `RAUHWpx_SESSION_ID=${session.id}`,
      '--env', `RAUHWpx_PROVIDER=${session.provider}`,
      '--env', `RAUHWpx_WORKER_TOKEN=${workerToken}`,
      '--env', 'RAUHWpx_CONTROL_SOCKET=/run/rauhwpx/control.sock',
      this.config.workerImage,
    ]);
  }

  async stop(sandboxId) {
    if (!sandboxId) return;
    await command(this.spawnProcess, 'podman', ['--cgroup-manager=cgroupfs', 'rm', '--force', sandboxId]).catch((error) => {
      if (error.code !== 'PODMAN_FAILED') throw error;
    });
  }
}
