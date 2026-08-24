import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { normalizeCloudProfile } from './cloud-profile.mjs';

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
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
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
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

function waitForForward(child, port, timeoutMs = START_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onError = (error) => finish(error);
    const onClose = (code, signal) => finish(new Error(
      `SSH tunnel exited with ${code ?? signal}${stderr.trim() ? `: ${stderr.trim().slice(-800)}` : ''}`,
    ));
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    child.once('error', onError);
    child.once('close', onClose);
    const poll = setInterval(() => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.unref();
      socket.once('connect', () => {
        socket.destroy();
        finish();
      });
      socket.once('error', () => socket.destroy());
    }, 100);
    const timeout = setTimeout(() => finish(new Error('SSH tunnel timed out')), timeoutMs);
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
    if (this.active?.key === key && this.active.child.exitCode === null) return this.#lease(this.active);
    if (this.starting?.key === key) return withSignal(this.starting.promise, signal);
    await this.stop();
    const controller = new AbortController();
    const promise = this.#start(profile, key, controller.signal).finally(() => {
      if (this.starting?.promise === promise) this.starting = null;
    });
    this.starting = { key, promise, controller };
    return withSignal(promise, signal);
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
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await waitForForward(child, localPort);
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
    this.starting = null;
    if (starting) {
      starting.controller.abort(new Error('SSH tunnel was stopped'));
      await starting.promise.catch(() => {});
    }
    const active = this.active;
    this.active = null;
    if (!active || active.child.exitCode !== null) return;
    active.child.stdin.end();
    active.child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => active.child.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
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
