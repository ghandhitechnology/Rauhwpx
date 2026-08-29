import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { normalizeCloudProfile, sshOptionFilePath } from './cloud-profile.mjs';

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const HEALTH_PROBE_TIMEOUT_MS = 1_500;
const MAX_HEALTH_BYTES = 64 * 1024;
const DIRECT_SIGNAL = new AbortController().signal;

function destination(ssh) {
  return `${ssh.user}@${ssh.host}`;
}

function sshTunnelArguments(profile, knownHostsPath, localPort) {
  const { ssh, api } = profile;
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=12',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', sshOptionFilePath('UserKnownHostsFile', knownHostsPath),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(ssh.port),
    ...(ssh.keyPath ? ['-i', ssh.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    '-L', `127.0.0.1:${localPort}:${api.remoteHost}:${api.remotePort}`,
    destination(ssh),
    'exec cat >/dev/null',
  ];
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function probeForwardHealth(port, healthPath = '/rauhwpx-cloud/v1/health', {
  signal,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: healthPath,
      method: 'GET',
      agent: false,
      signal,
      headers: {
        accept: 'application/json',
        connection: 'close',
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_HEALTH_BYTES) {
          const error = new Error('SSH tunnel health response is too large');
          response.destroy(error);
          request.destroy(error);
          finish(error);
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', (error) => finish(error));
      response.once('end', () => {
        if (response.statusCode !== 200) {
          finish(new Error(`SSH tunnel health check returned HTTP ${response.statusCode}`));
          return;
        }
        let health;
        try {
          health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          finish(new Error('SSH tunnel health check returned invalid JSON'));
          return;
        }
        if (health?.ok !== true
          || !Number.isSafeInteger(health.protocolVersion)
          || health.protocolVersion < 1) {
          finish(new Error('SSH tunnel health response is incomplete'));
          return;
        }
        finish(null, health);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(
      new Error('SSH tunnel health check timed out'),
      { code: 'ETIMEDOUT' },
    )));
    request.once('error', (error) => finish(error));
    request.end();
  });
}

function waitForForward(child, port, timeoutMs = START_TIMEOUT_MS, {
  healthPath = '/rauhwpx-cloud/v1/health',
  probeTimeoutMs = HEALTH_PROBE_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let lastProbeError = null;
    let polling = false;
    let poll = null;
    let timeout = null;
    let probeController = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      probeController?.abort();
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onError = (error) => finish(error);
    const onClose = (code, signal) => finish(Object.assign(new Error(
      `SSH tunnel exited with ${code ?? signal}${stderr.trim() ? `: ${stderr.trim().slice(-800)}` : ''}`,
    ), { code: 'SSH_TUNNEL_UNAVAILABLE', retryable: true }));
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    child.once('error', onError);
    child.once('close', onClose);
    const probe = async () => {
      if (settled || polling) return;
      polling = true;
      probeController = new AbortController();
      try {
        await probeForwardHealth(port, healthPath, {
          signal: probeController.signal,
          timeoutMs: Math.min(probeTimeoutMs, timeoutMs),
        });
        finish();
      } catch (error) {
        if (!settled && error?.name !== 'AbortError') lastProbeError = error;
      } finally {
        polling = false;
        probeController = null;
      }
    };
    poll = setInterval(() => { void probe(); }, 100);
    poll.unref?.();
    timeout = setTimeout(() => {
      const detail = lastProbeError?.message ? `: ${lastProbeError.message}` : '';
      finish(Object.assign(
        new Error(`SSH tunnel did not reach the Cloud health endpoint in time${detail}`),
        {
          code: lastProbeError?.code || 'ETIMEDOUT',
          retryable: true,
          cause: lastProbeError ?? undefined,
        },
      ));
    }, timeoutMs);
    void probe();
  });
}

function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('SSH tunnel was cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('SSH tunnel was cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class SshTunnelManager {
  constructor({ spawnImpl = nodeSpawn, knownHostsPath }) {
    if (!knownHostsPath) throw new Error('SshTunnelManager requires a known-hosts path');
    this.spawn = spawnImpl;
    this.knownHostsPath = knownHostsPath;
    this.active = null;
    this.starting = null;
    this.stopping = null;
    this.transition = Promise.resolve();
    this.generation = 0;
  }

  async acquire(rawProfile, { signal } = {}) {
    const profile = normalizeCloudProfile(rawProfile);
    if (profile.api.kind !== 'ssh-tunnel') {
      return Object.freeze({
        baseUrl: profile.endpoint,
        generation: 0,
        broken: DIRECT_SIGNAL,
        release() {},
      });
    }
    const key = JSON.stringify({ ssh: profile.ssh, api: profile.api });
    if (!this.stopping && this.active?.key === key && this.active.child.exitCode === null) {
      return this.#lease(this.active);
    }
    if (this.starting?.key === key) return withSignal(this.starting.promise, signal);
    const previous = this.starting;
    if (previous) {
      this.starting = null;
      previous.controller.abort(new Error('SSH tunnel was replaced'));
    }
    const controller = new AbortController();
    let promise;
    const operation = this.#enqueue(async () => {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new Error('SSH tunnel was cancelled');
      }
      await this.#stopActive();
      return this.#start(profile, key, controller.signal);
    });
    promise = operation.finally(() => {
      if (this.starting?.promise === promise) this.starting = null;
    });
    this.starting = { key, promise, controller };
    return withSignal(promise, signal);
  }

  #enqueue(operation) {
    const run = this.transition.then(operation, operation);
    this.transition = run.catch(() => {});
    return run;
  }

  async #start(profile, key, signal) {
    await fs.mkdir(path.dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error('SSH tunnel was cancelled');
      const localPort = await reservePort();
      const child = this.spawn('ssh', sshTunnelArguments(profile, this.knownHostsPath, localPort), {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
      // A tunnel may exit just before stop() closes stdin. Keep EPIPE from
      // becoming an uncaught EventEmitter error while close drives cleanup.
      child.stdin?.on('error', () => {});
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const basePath = String(profile.api.basePath || '/rauhwpx-cloud').replace(/\/$/, '');
        await waitForForward(child, localPort, START_TIMEOUT_MS, {
          healthPath: `${basePath}/v1/health`,
        });
        if (signal?.aborted) throw signal.reason ?? new Error('SSH tunnel was cancelled');
        const broken = new AbortController();
        const active = { key, child, localPort, broken, generation: ++this.generation };
        child.once('close', () => {
          broken.abort(new Error('SSH tunnel disconnected'));
          if (this.active === active) this.active = null;
        });
        this.active = active;
        return this.#lease(active);
      } catch (error) {
        lastError = error;
        child.kill('SIGTERM');
        if (!/address already in use|cannot listen|forwarding failed/i.test(error.message)) throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    }
    throw lastError ?? new Error('SSH tunnel could not reserve a local port');
  }

  #lease(active) {
    return Object.freeze({
      baseUrl: `http://127.0.0.1:${active.localPort}/rauhwpx-cloud`,
      generation: active.generation,
      broken: active.broken.signal,
      release() {},
    });
  }

  async stop() {
    const starting = this.starting;
    if (starting) {
      this.starting = null;
      starting.controller.abort(new Error('SSH tunnel was stopped'));
    }
    if (this.stopping) return this.stopping;
    let stopping;
    stopping = this.#enqueue(() => this.#stopActive()).finally(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  async #stopActive() {
    const active = this.active;
    this.active = null;
    if (!active || active.child.exitCode !== null) return;
    active.broken.abort(new Error('SSH tunnel was stopped'));
    const closed = new Promise((resolve) => {
      if (active.child.exitCode !== null) resolve();
      else active.child.once('close', resolve);
    });
    try { active.child.stdin?.end(); } catch {}
    active.child.kill('SIGTERM');
    let stopTimer;
    try {
      await Promise.race([
        closed,
        new Promise((resolve) => { stopTimer = setTimeout(resolve, STOP_TIMEOUT_MS); }),
      ]);
    } finally {
      clearTimeout(stopTimer);
    }
    if (active.child.exitCode === null) active.child.kill('SIGKILL');
  }
}

export class CloudApiTransport {
  constructor({ tunnelManager }) {
    this.tunnelManager = tunnelManager;
  }

  acquire(profile, options) {
    return this.tunnelManager.acquire(profile, options);
  }

  stop() {
    return this.tunnelManager.stop();
  }
}

export const __test = { reservePort, sshTunnelArguments, waitForForward, withSignal };
