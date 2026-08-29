import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeSshConfig, normalizeTailscaleHttpsPort } from './cloud-profile.mjs';

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const BOOTSTRAP_LIMIT = 1024 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const EXPECTED_CLOUD_PROTOCOL = 1;
const CHANNELS = new Set(['stable', 'prerelease']);
const SSH_RETRY_ATTEMPTS = 3;

const TRANSIENT_SSH_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

const TRANSIENT_SSH_MESSAGE = /(?:connection (?:closed|refused|reset|timed out)|connection to .* closed|broken pipe|connection reset by peer|could not resolve hostname|host is down|kex_exchange_identification|network is (?:down|unreachable)|no route to host|operation timed out|ssh_exchange_identification|temporary failure in name resolution)/i;

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
    const carry = { stdout: '', stderr: '' };
    let outputSize = 0;
    let settled = false;
    const emitLogLine = (line) => {
      if (!line) return;
      onLine(line.startsWith('RAUHWpx_RECEIPT=') ? 'RAUHWpx_RECEIPT=' : line);
    };
    const capture = (target, stream, chunk) => {
      outputSize += chunk.length;
      if (outputSize > OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        rejectOnce(new Error('SSH output exceeded the safety limit'));
        return;
      }
      target.push(chunk);
      const text = carry[stream] + stripControl(chunk.toString('utf8'));
      const lines = text.split(/\r?\n/);
      carry[stream] = lines.pop() ?? '';
      for (const line of lines) emitLogLine(line);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectOnce(Object.assign(new Error(`${command} timed out`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    child.once('error', rejectOnce);
    // SSH can reject a command before Electron finishes streaming an installer
    // or bootstrap archive. A pipe then reports EPIPE on stdin; without an
    // error listener Node treats it as an uncaught process error.
    child.stdin?.on('error', (cause) => {
      const error = Object.assign(
        new Error(`${command} input failed: ${cause.message}`),
        { code: cause.code || 'SSH_STDIN_FAILED', cause },
      );
      child.kill('SIGTERM');
      rejectOnce(error);
    });
    child.stdout.on('data', (chunk) => capture(stdout, 'stdout', chunk));
    child.stderr.on('data', (chunk) => capture(stderr, 'stderr', chunk));
    child.once('close', (code, signal) => {
      emitLogLine(carry.stdout);
      emitLogLine(carry.stderr);
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
    try {
      if (input != null) child.stdin.end(input);
      else child.stdin.end();
    } catch (cause) {
      child.kill('SIGTERM');
      rejectOnce(Object.assign(
        new Error(`${command} input failed: ${cause.message}`),
        { code: cause.code || 'SSH_STDIN_FAILED', cause },
      ));
    }
  });
}

function transientSshFailure(error) {
  if (TRANSIENT_SSH_CODES.has(String(error?.code ?? '').toUpperCase())) return true;
  if (Number(error?.result?.code) !== 255) return false;
  return TRANSIENT_SSH_MESSAGE.test(String(error?.message ?? ''));
}

async function retryTransientSsh(operation, {
  attempts = SSH_RETRY_ATTEMPTS,
  onLine = () => {},
  sleep = (ms) => delay(ms),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !transientSshFailure(error)) throw error;
      onLine(`SSH connection was interrupted; retrying (${attempt + 1}/${attempts})`);
      await sleep(Math.min(1_000, 200 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
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

function receiptCacheCommands(platform, requestId) {
  const normalized = String(requestId ?? randomBytes(16).toString('hex'));
  if (!/^[a-f0-9]{32}$/.test(normalized)) throw new Error('Provision receipt request id is invalid');
  const directory = platform === 'darwin'
    ? '/Library/Application Support/Rauhwpx Cloud/provision-receipts'
    : '/var/lib/rauhwpx-cloud/provision-receipts';
  return {
    before: [
      `RECEIPT_DIR='${directory}'`,
      'sudo -n install -d -m 0700 "$RECEIPT_DIR"',
      'sudo -n find "$RECEIPT_DIR" -type f -name \'*.receipt\' -mmin +15 -delete >/dev/null 2>&1 || true',
      `RECEIPT_FILE="$RECEIPT_DIR/${normalized}.receipt"`,
      'if sudo -n test -s "$RECEIPT_FILE"; then sudo -n cat "$RECEIPT_FILE"; exit 0; fi',
    ],
    after: [
      'RECEIPT_LINE="RAUHWpx_RECEIPT=$RECEIPT"',
      'printf "%s\\n" "$RECEIPT_LINE" | sudo -n sh -c \'umask 077; cat >"$1"\' sh "$RECEIPT_FILE.tmp"',
      'sudo -n mv -f "$RECEIPT_FILE.tmp" "$RECEIPT_FILE"',
      'sudo -n cat "$RECEIPT_FILE"',
    ],
  };
}

function existingInstallRemoteCommand({
  transport,
  publicHost,
  tailscaleHttpsPort,
  requiredVersion = '',
  requestId,
}) {
  const receiptCache = receiptCacheCommands('linux', requestId);
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
    : transport === 'ssh-tunnel'
      ? [
        'ENDPOINT=http://127.0.0.1:7740/rauhwpx-cloud',
        'RECEIPT_PORT=',
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
    ...receiptCache.before,
    'PAIRING_JSON=$(sudo -n /usr/local/bin/rauhwpx-cloud pairing create "Origin device")',
    `RECEIPT=$(sudo -n /opt/rauhwpx-node/bin/node -e '
      const pairing=JSON.parse(process.argv[1]);
      const receipt={endpoint:process.argv[2],serverPublicKey:pairing.serverPublicKey,pairingCode:pairing.code,transport:process.argv[4]};
      if(process.argv[3]) receipt.tailscaleHttpsPort=Number(process.argv[3]);
      process.stdout.write(JSON.stringify(receipt));
    ' "$PAIRING_JSON" "$ENDPOINT" "$RECEIPT_PORT" "${transport}")`,
    ...receiptCache.after,
  ].join('; ');
}

function existingMacosInstallRemoteCommand({ requiredVersion = '', requestId } = {}) {
  const receiptCache = receiptCacheCommands('darwin', requestId);
  return [
    'set -eu',
    'sudo -n launchctl print system/com.hataewook.rauhwpx-cloud >/dev/null 2>&1 || exit 0',
    'sudo -n test -x /usr/local/bin/rauhwpx-cloud || exit 0',
    `EXISTING_BASE=$(sudo -n sed -n 's/^RAUHWpx_BASE_PATH=//p' '/Library/Application Support/Rauhwpx Cloud/cloud.env' | tail -1) || exit 0`,
    '[ "$EXISTING_BASE" = /rauhwpx-cloud ] || exit 0',
    `EXISTING_HOST=$(sudo -n sed -n 's/^RAUHWpx_HOST=//p' '/Library/Application Support/Rauhwpx Cloud/cloud.env' | tail -1) || exit 0`,
    '[ "$EXISTING_HOST" = 127.0.0.1 ] || exit 0',
    `EXISTING_PORT=$(sudo -n sed -n 's/^RAUHWpx_PORT=//p' '/Library/Application Support/Rauhwpx Cloud/cloud.env' | tail -1) || exit 0`,
    '[ "$EXISTING_PORT" = 7740 ] || exit 0',
    'sudo -n test -x /opt/homebrew/opt/node@24/bin/node || exit 0',
    `EXISTING_PROTOCOL=$(sudo -n /opt/homebrew/opt/node@24/bin/node -e 'import("/Library/Application Support/Rauhwpx Cloud/current/src/protocol.mjs").then((m)=>process.stdout.write(String(m.PROTOCOL_VERSION)))') || exit 0`,
    `[ "$EXISTING_PROTOCOL" = ${EXPECTED_CLOUD_PROTOCOL} ] || exit 0`,
    ...(requiredVersion ? [
      `EXISTING_VERSION=$(sudo -n /opt/homebrew/opt/node@24/bin/node -p 'require("/Library/Application Support/Rauhwpx Cloud/current/package.json").version') || exit 0`,
      `[ "$EXISTING_VERSION" = "${requiredVersion}" ] || exit 0`,
    ] : []),
    'sudo -n curl --fail --silent --connect-timeout 10 http://127.0.0.1:7740/v1/health >/dev/null || exit 0',
    ...receiptCache.before,
    'PAIRING_JSON=$(sudo -n /usr/local/bin/rauhwpx-cloud pairing create "Origin device")',
    `RECEIPT=$(sudo -n /opt/homebrew/opt/node@24/bin/node -e '
      const pairing=JSON.parse(process.argv[1]);
      process.stdout.write(JSON.stringify({
        endpoint:"http://127.0.0.1:7740/rauhwpx-cloud",
        serverPublicKey:pairing.serverPublicKey,
        pairingCode:pairing.code,
        transport:"ssh-tunnel"
      }));
    ' "$PAIRING_JSON")`,
    ...receiptCache.after,
  ].join('; ');
}

export function sshArguments(sshConfig, knownHostsPath, remoteCommand, { acceptNew = false } = {}) {
  const ssh = normalizeSshConfig(sshConfig);
  return [
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=12',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
    '-o', `StrictHostKeyChecking=${acceptNew ? 'accept-new' : 'yes'}`,
    '-p', String(ssh.port),
    ...(ssh.keyPath ? ['-i', ssh.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    sshDestination(ssh),
    remoteCommand,
  ];
}

function invalidProvisionReceipt(message) {
  return Object.assign(new Error(message), { code: 'PROVISION_RECEIPT_INVALID' });
}

function parseProvisionReceipt(stdout) {
  const line = stdout.split(/\r?\n/).findLast((candidate) => candidate.startsWith('RAUHWpx_RECEIPT='));
  if (!line) throw invalidProvisionReceipt('VPS installer did not return a provisioning receipt');
  let receipt;
  try { receipt = JSON.parse(line.slice('RAUHWpx_RECEIPT='.length)); } catch {
    throw invalidProvisionReceipt('VPS installer returned an invalid provisioning receipt');
  }
  if (!/^ed25519:[A-Za-z0-9_-]{59}$/.test(String(receipt.serverPublicKey ?? ''))) {
    throw invalidProvisionReceipt('VPS installer did not return a valid server identity');
  }
  let endpoint;
  try { endpoint = new URL(receipt.endpoint); } catch {
    throw invalidProvisionReceipt('VPS installer did not return a secure endpoint');
  }
  const loopbackTunnel = receipt.transport === 'ssh-tunnel'
    && endpoint.protocol === 'http:'
    && endpoint.hostname === '127.0.0.1'
    && Number(endpoint.port) === 7740;
  if ((!loopbackTunnel && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password) {
    throw invalidProvisionReceipt('VPS installer did not return a secure endpoint');
  }
  if (receipt.tailscaleHttpsPort !== undefined) {
    if (typeof receipt.tailscaleHttpsPort !== 'number') {
      throw invalidProvisionReceipt('VPS installer returned an invalid Tailscale HTTPS port');
    }
    let port;
    try { port = normalizeTailscaleHttpsPort(receipt.tailscaleHttpsPort); } catch {
      throw invalidProvisionReceipt('VPS installer returned an invalid Tailscale HTTPS port');
    }
    if (Number(endpoint.port || 443) !== port) {
      throw invalidProvisionReceipt('VPS installer endpoint does not match its Tailscale HTTPS port');
    }
  }
  if (receipt.pairingCode != null && !/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(receipt.pairingCode)) {
    throw invalidProvisionReceipt('VPS installer returned an invalid pairing code');
  }
  return receipt;
}

export class CloudProvisioner {
  constructor({
    spawnImpl = nodeSpawn,
    installerPath,
    bootstrapDir = '',
    appVersion = '',
    knownHostsPath,
    retrySleep = (ms) => delay(ms),
  }) {
    if (!installerPath) throw new Error('CloudProvisioner requires an installer path');
    if (!knownHostsPath) throw new Error('CloudProvisioner requires a known-hosts path');
    this.spawn = spawnImpl;
    this.installerPath = installerPath;
    this.bootstrapDir = bootstrapDir;
    this.appVersion = appVersion;
    this.knownHostsPath = knownHostsPath;
    this.retrySleep = retrySleep;
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
    const remote = options.platform === 'darwin'
      ? existingMacosInstallRemoteCommand(options)
      : existingInstallRemoteCommand(options);
    const result = await retryTransientSsh(() => runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote),
      { timeoutMs: 30_000, onLine },
    ), { onLine, sleep: this.retrySleep });
    if (!result.stdout.split(/\r?\n/).some((line) => line.startsWith('RAUHWpx_RECEIPT='))) return null;
    onLine('Using the compatible Cloud service already installed on this VPS');
    return parseProvisionReceipt(result.stdout);
  }

  async #installWithRecovery(ssh, options, preflight, onLine, install) {
    let failure;
    try {
      const result = await install();
      return { ...parseProvisionReceipt(result.stdout), preflight };
    } catch (error) {
      if (!transientSshFailure(error) && error?.code !== 'PROVISION_RECEIPT_INVALID') throw error;
      failure = error;
    }

    onLine('The installer response was interrupted; checking the installed Cloud service');
    const recovered = await this.#reuseExisting(ssh, {
      ...options,
      platform: preflight.platform,
    }, onLine);
    if (!recovered) throw failure;
    onLine('Recovered the Cloud installation after the interrupted installer response');
    return { ...recovered, preflight, recovered: true };
  }

  async preflight(sshConfig, { onLine = () => {} } = {}) {
    const ssh = normalizeSshConfig(sshConfig);
    await fs.mkdir(path.dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
    const remote = [
      'set -eu',
      'printf "arch=%s\\n" "$(uname -m)"',
      'if [ "$(uname -s)" = Darwin ]; then printf "os=macos version=%s\\n" "$(sw_vers -productVersion)"; else . /etc/os-release; printf "os=%s version=%s\\n" "$ID" "$VERSION_ID"; fi',
      'command -v sudo >/dev/null',
      'sudo -n true',
      ...(ssh.useTailscaleSsh ? ['command -v tailscale >/dev/null', 'tailscale status --json >/dev/null'] : []),
      'printf "preflight=ok\\n"',
    ].join('; ');
    const result = await retryTransientSsh(() => runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote, { acceptNew: true }),
      { timeoutMs: 25_000, onLine },
    ), { onLine, sleep: this.retrySleep });
    const output = `${result.stdout}\n${result.stderr}`;
    if (!output.includes('preflight=ok')) throw new Error('VPS preflight did not complete');
    const os = output.match(/os=([^\s]+) version=([^\s]+)/);
    const arch = output.match(/arch=([^\s]+)/);
    if (!os || !['ubuntu', 'debian', 'macos'].includes(os[1])) throw new Error('Remote host must run macOS, Ubuntu, or Debian');
    if (!arch || !['x86_64', 'aarch64', 'arm64'].includes(arch[1])) {
      throw new Error('VPS architecture must be amd64 or arm64');
    }
    if (os[1] === 'macos' && arch[1] !== 'arm64') throw new Error('Mac Cloud hosts require Apple silicon');
    if (os[1] === 'macos' && Number(os[2].split('.')[0]) < 14) throw new Error('Mac Cloud hosts require macOS 14 or newer');
    return { platform: os[1] === 'macos' ? 'darwin' : 'linux', os: os[1], version: os[2], arch: arch[1] };
  }

  async provision(sshConfig, {
    channel = 'stable',
    transport = 'tailscale',
    tailscaleHttpsPort = 443,
    publicHost = '',
    onLine = () => {},
  } = {}) {
    if (!CHANNELS.has(channel)) throw new Error('Unsupported cloud install channel');
    if (!['tailscale', 'public-https', 'ssh-tunnel'].includes(transport)) throw new Error('Unsupported cloud transport');
    const servePort = transport === 'tailscale'
      ? normalizeTailscaleHttpsPort(tailscaleHttpsPort)
      : 443;
    if (transport === 'public-https' && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])$/.test(publicHost)) {
      throw new Error('Public HTTPS provisioning requires a valid DNS hostname');
    }
    const ssh = normalizeSshConfig(sshConfig);
    const preflight = await this.preflight(ssh, { onLine });
    const bootstrap = preflight.platform === 'linux' ? await this.#bootstrap(preflight.arch) : null;
    if (preflight.platform === 'darwin' && transport !== 'ssh-tunnel') {
      throw new Error('Mac Cloud hosts require the SSH tunnel transport');
    }
    if (preflight.platform === 'darwin') {
      const existing = await this.#reuseExisting(ssh, {
        platform: 'darwin',
        transport,
        publicHost,
        tailscaleHttpsPort: servePort,
      }, onLine);
      if (existing) return { ...existing, preflight, reused: true };
      const installerPath = path.join(path.dirname(this.installerPath), 'install-macos.sh');
      const installer = await fs.readFile(installerPath);
      const remote = installRemoteCommand({
        channel,
        transport,
        publicHost,
        tailscaleHttpsPort: servePort,
      });
      return this.#installWithRecovery(ssh, {
        transport,
        publicHost,
        tailscaleHttpsPort: servePort,
      }, preflight, onLine, () => runProcess(
        this.spawn,
        'ssh',
        sshArguments(ssh, this.knownHostsPath, remote),
        { input: installer, timeoutMs: INSTALL_TIMEOUT_MS, onLine },
      ));
    }
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
      return this.#installWithRecovery(ssh, {
        transport,
        publicHost,
        tailscaleHttpsPort: servePort,
        requiredVersion: this.appVersion,
      }, preflight, onLine, () => runProcess(
        this.spawn,
        'ssh',
        sshArguments(ssh, this.knownHostsPath, remote),
        { input: bootstrap.bytes, timeoutMs: INSTALL_TIMEOUT_MS, onLine },
      ));
    }
    const installer = await fs.readFile(this.installerPath);
    if (!installer.length || installer.length > 2 * 1024 * 1024) throw new Error('Cloud installer is missing or invalid');
    const remote = installRemoteCommand({
      channel,
      transport,
      publicHost,
      tailscaleHttpsPort: servePort,
    });
    return this.#installWithRecovery(ssh, {
      transport,
      publicHost,
      tailscaleHttpsPort: servePort,
    }, preflight, onLine, () => runProcess(
      this.spawn,
      'ssh',
      sshArguments(ssh, this.knownHostsPath, remote),
      { input: installer, timeoutMs: INSTALL_TIMEOUT_MS, onLine },
    ));
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
  existingMacosInstallRemoteCommand,
  installRemoteCommand,
  parseProvisionReceipt,
  retryTransientSsh,
  runProcess,
  transientSshFailure,
};
