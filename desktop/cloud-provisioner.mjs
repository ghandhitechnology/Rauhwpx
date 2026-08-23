import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeSshConfig, normalizeTailscaleHttpsPort } from './cloud-profile.mjs';

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const CHANNELS = new Set(['stable', 'prerelease']);

function stripControl(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function runProcess(spawnImpl, command, args, { input, timeoutMs = 30_000, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    const stdout = [];
    const stderr = [];
    let outputSize = 0;
    let settled = false;
    const capture = (target, chunk) => {
      outputSize += chunk.length;
      if (outputSize > OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        rejectOnce(new Error('SSH output exceeded the safety limit'));
        return;
      }
      target.push(chunk);
      for (const line of stripControl(chunk.toString('utf8')).split(/\r?\n/)) {
        if (line) onLine(line);
      }
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectOnce(new Error(`${command} timed out`));
    }, timeoutMs);
    child.once('error', rejectOnce);
    child.stdout.on('data', (chunk) => capture(stdout, chunk));
    child.stderr.on('data', (chunk) => capture(stderr, chunk));
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolve(result);
      else {
        const detail = stripControl(result.stderr || result.stdout).trim().slice(-1200);
        const error = new Error(`${command} exited with ${code ?? signal}${detail ? `: ${detail}` : ''}`);
        error.result = result;
        reject(error);
      }
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function sshDestination(ssh) {
  return `${ssh.user}@${ssh.host}`;
}

function installRemoteCommand({ channel, transport, publicHost, tailscaleHttpsPort }) {
  return [
    'sudo -n env',
    `RAUHWpx_CHANNEL=${channel}`,
    `RAUHWpx_TRANSPORT=${transport}`,
    ...(transport === 'tailscale' ? [`RAUHWpx_TAILSCALE_HTTPS_PORT=${tailscaleHttpsPort}`] : []),
    ...(transport === 'public-https' ? [`RAUHWpx_PUBLIC_HOST=${publicHost}`] : []),
    'bash -s',
  ].join(' ');
}

export function sshArguments(sshConfig, knownHostsPath, remoteCommand, { acceptNew = false } = {}) {
  const ssh = normalizeSshConfig(sshConfig);
  return [
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=12',
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
    '-o', `StrictHostKeyChecking=${acceptNew ? 'accept-new' : 'yes'}`,
    '-p', String(ssh.port),
    ...(ssh.keyPath ? ['-i', ssh.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    sshDestination(ssh),
    remoteCommand,
  ];
}

function parseProvisionReceipt(stdout) {
  const line = stdout.split(/\r?\n/).findLast((candidate) => candidate.startsWith('RAUHWpx_RECEIPT='));
  if (!line) throw new Error('VPS installer did not return a provisioning receipt');
  let receipt;
  try { receipt = JSON.parse(line.slice('RAUHWpx_RECEIPT='.length)); } catch {
    throw new Error('VPS installer returned an invalid provisioning receipt');
  }
  if (!/^ed25519:[A-Za-z0-9_-]{59}$/.test(String(receipt.serverPublicKey ?? ''))) {
    throw new Error('VPS installer did not return a valid server identity');
  }
  let endpoint;
  try { endpoint = new URL(receipt.endpoint); } catch {
    throw new Error('VPS installer did not return a secure endpoint');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('VPS installer did not return a secure endpoint');
  }
  if (receipt.tailscaleHttpsPort !== undefined) {
    if (typeof receipt.tailscaleHttpsPort !== 'number') {
      throw new Error('VPS installer returned an invalid Tailscale HTTPS port');
    }
    let port;
    try { port = normalizeTailscaleHttpsPort(receipt.tailscaleHttpsPort); } catch {
      throw new Error('VPS installer returned an invalid Tailscale HTTPS port');
    }
    if (Number(endpoint.port || 443) !== port) {
      throw new Error('VPS installer endpoint does not match its Tailscale HTTPS port');
    }
  }
  if (receipt.pairingCode != null && !/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(receipt.pairingCode)) {
    throw new Error('VPS installer returned an invalid pairing code');
  }
  return receipt;
}

export class CloudProvisioner {
  constructor({ spawnImpl = nodeSpawn, installerPath, knownHostsPath }) {
    if (!installerPath) throw new Error('CloudProvisioner requires an installer path');
    if (!knownHostsPath) throw new Error('CloudProvisioner requires a known-hosts path');
    this.spawn = spawnImpl;
    this.installerPath = installerPath;
    this.knownHostsPath = knownHostsPath;
  }

  async preflight(sshConfig, { onLine = () => {} } = {}) {
    const ssh = normalizeSshConfig(sshConfig);
    await fs.mkdir(path.dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
    const remote = [
      'set -eu',
      'printf "arch=%s\\n" "$(uname -m)"',
      '. /etc/os-release',
      'printf "os=%s version=%s\\n" "$ID" "$VERSION_ID"',
      'command -v sudo >/dev/null',
      'sudo -n true',
      ...(ssh.useTailscaleSsh ? ['command -v tailscale >/dev/null', 'tailscale status --json >/dev/null'] : []),
      'printf "preflight=ok\\n"',
    ].join('; ');
    const firstConnect = !await fs.stat(this.knownHostsPath).then((stat) => stat.size > 0, () => false);
    const result = await runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote, { acceptNew: firstConnect }),
      { timeoutMs: 25_000, onLine },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    if (!output.includes('preflight=ok')) throw new Error('VPS preflight did not complete');
    const os = output.match(/os=([^\s]+) version=([^\s]+)/);
    const arch = output.match(/arch=([^\s]+)/);
    if (!os || !['ubuntu', 'debian'].includes(os[1])) throw new Error('VPS must run Ubuntu or Debian');
    if (!arch || !['x86_64', 'aarch64', 'arm64'].includes(arch[1])) {
      throw new Error('VPS architecture must be amd64 or arm64');
    }
    return { os: os[1], version: os[2], arch: arch[1] };
  }

  async provision(sshConfig, {
    channel = 'stable',
    transport = 'tailscale',
    tailscaleHttpsPort = 443,
    publicHost = '',
    onLine = () => {},
  } = {}) {
    if (!CHANNELS.has(channel)) throw new Error('Unsupported cloud install channel');
    if (!['tailscale', 'public-https'].includes(transport)) throw new Error('Unsupported cloud transport');
    const servePort = transport === 'tailscale'
      ? normalizeTailscaleHttpsPort(tailscaleHttpsPort)
      : 443;
    if (transport === 'public-https' && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])$/.test(publicHost)) {
      throw new Error('Public HTTPS provisioning requires a valid DNS hostname');
    }
    const ssh = normalizeSshConfig(sshConfig);
    const preflight = await this.preflight(ssh, { onLine });
    const installer = await fs.readFile(this.installerPath);
    if (!installer.length || installer.length > 2 * 1024 * 1024) throw new Error('Cloud installer is missing or invalid');
    const remote = installRemoteCommand({
      channel,
      transport,
      publicHost,
      tailscaleHttpsPort: servePort,
    });
    const result = await runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote),
      { input: installer, timeoutMs: 10 * 60_000, onLine },
    );
    return { ...parseProvisionReceipt(result.stdout), preflight };
  }

  async verify(sshConfig, { onLine = () => {} } = {}) {
    const ssh = normalizeSshConfig(sshConfig);
    const remote = [
      'set -eu',
      'sudo -n systemctl is-active rauhwpx-cloud.service',
      'sudo -n systemctl is-enabled rauhwpx-cloud.service',
      'sudo -n /usr/local/lib/rauhwpx-cloud/current/bin/rauhwpx-cloud doctor --json',
    ].join('; ');
    const result = await runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote),
      { timeoutMs: 60_000, onLine },
    );
    const jsonLine = result.stdout.split(/\r?\n/).findLast((line) => line.trim().startsWith('{'));
    if (!jsonLine) throw new Error('Cloud doctor did not return JSON');
    const doctor = JSON.parse(jsonLine);
    if (doctor.ok !== true) throw new Error('Cloud doctor reported an unhealthy service');
    return doctor;
  }
}

export const __test = { installRemoteCommand, parseProvisionReceipt, runProcess };
