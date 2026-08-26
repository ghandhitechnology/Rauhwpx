import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeSshConfig, normalizeTailscaleHttpsPort } from './cloud-profile.mjs';

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const BOOTSTRAP_LIMIT = 1024 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const EXPECTED_CLOUD_PROTOCOL = 1;
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
        if (!line) continue;
        onLine(line.startsWith('RAUHWpx_RECEIPT=') ? 'RAUHWpx_RECEIPT=' : line);
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

function bootstrapArchitecture(machineArchitecture) {
  if (machineArchitecture === 'x86_64') return 'amd64';
  if (machineArchitecture === 'aarch64' || machineArchitecture === 'arm64') return 'arm64';
  throw new Error('VPS architecture must be amd64 or arm64');
}

function bundledInstallRemoteCommand({ channel, transport, publicHost, tailscaleHttpsPort, assetArchitecture }) {
  const archive = `rauhwpx-cloud-linux-${assetArchitecture}.tar.gz`;
  const install = [
    'sudo -n env',
    `RAUHWpx_CHANNEL=${channel}`,
    `RAUHWpx_TRANSPORT=${transport}`,
    ...(transport === 'tailscale' ? [`RAUHWpx_TAILSCALE_HTTPS_PORT=${tailscaleHttpsPort}`] : []),
    ...(transport === 'public-https' ? [`RAUHWpx_PUBLIC_HOST=${publicHost}`] : []),
    `RAUHWpx_RELEASE_URL=file://$TMP/${archive}`,
    'bash "$TMP/install.sh"',
  ].join(' ');
  return [
    'set -eu',
    'TMP=$(mktemp -d)',
    'trap \'rm -rf "$TMP"\' EXIT HUP INT TERM',
    'tar -xzf - -C "$TMP"',
    `test -f "$TMP/${archive}"`,
    `test -f "$TMP/${archive}.sha256"`,
    `test -f "$TMP/${archive}.sigstore.json"`,
    'test -f "$TMP/install.sh"',
    install,
  ].join('; ');
}

function existingInstallRemoteCommand({ transport, publicHost, tailscaleHttpsPort, requiredVersion = '' }) {
  const endpoint = transport === 'tailscale'
    ? [
        `EXISTING_PORT=$(sudo -n sed -n 's/^RAUHWpx_TAILSCALE_HTTPS_PORT=//p' /etc/rauhwpx-cloud.env | tail -1) || exit 0`,
        `[ "$EXISTING_PORT" = "${tailscaleHttpsPort}" ] || exit 0`,
        'TAILSCALE_JSON=$(sudo -n tailscale status --json) || exit 0',
        `DNS_NAME=$(sudo -n /opt/rauhwpx-node/bin/node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.Self?.DNSName||"").replace(/\\.$/,""))' "$TAILSCALE_JSON") || exit 0`,
        '[ -n "$DNS_NAME" ] || exit 0',
        `PORT_SUFFIX=; [ "${tailscaleHttpsPort}" = 443 ] || PORT_SUFFIX=:${tailscaleHttpsPort}`,
        'ENDPOINT="https://${DNS_NAME}${PORT_SUFFIX}/rauhwpx-cloud"',
        `RECEIPT_PORT=${tailscaleHttpsPort}`,
      ]
    : [
        `sudo -n grep -Fqx '${publicHost} {' /etc/caddy/Caddyfile.d/rauhwpx-cloud.caddy || exit 0`,
        `ENDPOINT=https://${publicHost}/rauhwpx-cloud`,
        'RECEIPT_PORT=',
      ];
  return [
    'set -eu',
    'sudo -n systemctl is-active --quiet rauhwpx-cloud.service || exit 0',
    'sudo -n test -x /usr/local/bin/rauhwpx-cloud || exit 0',
    `EXISTING_BASE=$(sudo -n sed -n 's/^RAUHWpx_BASE_PATH=//p' /etc/rauhwpx-cloud.env | tail -1) || exit 0`,
    '[ "$EXISTING_BASE" = /rauhwpx-cloud ] || exit 0',
    `EXISTING_PROTOCOL=$(sudo -n /opt/rauhwpx-node/bin/node -e 'import("/opt/rauhwpx-cloud/current/src/protocol.mjs").then((m)=>process.stdout.write(String(m.PROTOCOL_VERSION)))') || exit 0`,
    `[ "$EXISTING_PROTOCOL" = ${EXPECTED_CLOUD_PROTOCOL} ] || exit 0`,
    ...(requiredVersion ? [
      `EXISTING_VERSION=$(sudo -n /opt/rauhwpx-node/bin/node -p 'require("/opt/rauhwpx-cloud/current/package.json").version') || exit 0`,
      `[ "$EXISTING_VERSION" = "${requiredVersion}" ] || exit 0`,
    ] : []),
    'sudo -n curl --fail --silent http://127.0.0.1:7740/v1/health >/dev/null || exit 0',
    ...endpoint,
    'sudo -n curl --fail --silent --connect-timeout 10 "$ENDPOINT/v1/health" >/dev/null || exit 0',
    'PAIRING_JSON=$(sudo -n /usr/local/bin/rauhwpx-cloud pairing create "Origin device")',
    `RECEIPT=$(sudo -n /opt/rauhwpx-node/bin/node -e '
      const pairing=JSON.parse(process.argv[1]);
      const receipt={endpoint:process.argv[2],serverPublicKey:pairing.serverPublicKey,pairingCode:pairing.code};
      if(process.argv[3]) receipt.tailscaleHttpsPort=Number(process.argv[3]);
      process.stdout.write(JSON.stringify(receipt));
    ' "$PAIRING_JSON" "$ENDPOINT" "$RECEIPT_PORT")`,
    'printf "RAUHWpx_RECEIPT=%s\\n" "$RECEIPT"',
  ].join('; ');
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
  constructor({ spawnImpl = nodeSpawn, installerPath, bootstrapDir = '', appVersion = '', knownHostsPath }) {
    if (!installerPath) throw new Error('CloudProvisioner requires an installer path');
    if (!knownHostsPath) throw new Error('CloudProvisioner requires a known-hosts path');
    this.spawn = spawnImpl;
    this.installerPath = installerPath;
    this.bootstrapDir = bootstrapDir;
    this.appVersion = appVersion;
    this.knownHostsPath = knownHostsPath;
  }

  async #bootstrap(machineArchitecture) {
    if (!this.bootstrapDir) return null;
    const assetArchitecture = bootstrapArchitecture(machineArchitecture);
    const filename = path.join(
      this.bootstrapDir,
      `rauhwpx-cloud-bootstrap-linux-${assetArchitecture}.tar.gz`,
    );
    const stat = await fs.stat(filename).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.size < 1 || stat.size > BOOTSTRAP_LIMIT) {
      throw new Error('Bundled Cloud runtime is invalid');
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(this.appVersion)) {
      throw new Error('Bundled Cloud runtime requires a valid app version');
    }
    return { assetArchitecture, bytes: await fs.readFile(filename) };
  }

  async #reuseExisting(ssh, options, onLine) {
    const remote = existingInstallRemoteCommand(options);
    const result = await runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote),
      { timeoutMs: 30_000, onLine },
    );
    if (!result.stdout.split(/\r?\n/).some((line) => line.startsWith('RAUHWpx_RECEIPT='))) return null;
    onLine('Using the compatible Cloud service already installed on this VPS');
    return parseProvisionReceipt(result.stdout);
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
    const bootstrap = await this.#bootstrap(preflight.arch);
    const existing = await this.#reuseExisting(ssh, {
      transport,
      publicHost,
      tailscaleHttpsPort: servePort,
      requiredVersion: bootstrap ? this.appVersion : '',
    }, onLine);
    if (existing) return { ...existing, preflight, reused: true };
    if (bootstrap) {
      onLine('Using the verified Cloud runtime bundled with Rauhwpx');
      const remote = bundledInstallRemoteCommand({
        channel,
        transport,
        publicHost,
        tailscaleHttpsPort: servePort,
        assetArchitecture: bootstrap.assetArchitecture,
      });
      const result = await runProcess(
        this.spawn,
        'ssh',
        sshArguments(ssh, this.knownHostsPath, remote),
        { input: bootstrap.bytes, timeoutMs: INSTALL_TIMEOUT_MS, onLine },
      );
      return { ...parseProvisionReceipt(result.stdout), preflight };
    }
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
      { input: installer, timeoutMs: INSTALL_TIMEOUT_MS, onLine },
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

export const __test = {
  bootstrapArchitecture,
  bundledInstallRemoteCommand,
  existingInstallRemoteCommand,
  installRemoteCommand,
  parseProvisionReceipt,
  runProcess,
};
