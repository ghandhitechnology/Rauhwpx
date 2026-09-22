import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CloudProvisioner, __test as provisionerTest } from '../desktop/cloud-provisioner.mjs';

const SERVER_KEY = `ed25519:${'A'.repeat(59)}`;
const RECEIPT = `RAUHWpx_RECEIPT=${JSON.stringify({
  endpoint: 'http://127.0.0.1:7740/rauhwpx-cloud',
  serverPublicKey: SERVER_KEY,
  pairingCode: 'ABCD-EFGH-JKLM',
  transport: 'ssh-tunnel',
})}\n`;

function completedChild({ stdout = '', stderr = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => true;
  queueMicrotask(() => {
    child.exitCode = code;
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', code, null);
  });
  return child;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rauhwpx-provision-recovery-'));
  await writeFile(path.join(root, 'install.sh'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(root, 'install-macos.sh'), '#!/bin/sh\nexit 0\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function sshConfig() {
  return {
    host: 'cloud-host.example',
    user: 'cloud-user',
    port: 22,
    useTailscaleSsh: false,
  };
}

test('Linux provisioning reconciles a committed install after its SSH response is lost', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'rauhwpx-cloud-bootstrap-linux-amd64.tar.gz'), 'bundled-runtime');
  const lines = [];
  let existingCalls = 0;
  let installerCalls = 0;
  const existingCommands = [];
  const spawnImpl = (_command, args) => {
    const remote = args.at(-1);
    if (remote.includes('printf "arch=%s')) {
      return completedChild({ stdout: 'arch=x86_64\nos=ubuntu version=24.04\npreflight=ok\n' });
    }
    if (remote.includes('systemctl is-active --quiet rauhwpx-cloud.service')) {
      existingCalls += 1;
      existingCommands.push(remote);
      if (existingCalls === 1) return completedChild();
      if (existingCalls === 2) {
        return completedChild({
          code: 255,
          stderr: 'ssh: connection to host cloud-host.example closed after receipt commit\n',
        });
      }
      return completedChild({ stdout: RECEIPT });
    }
    if (remote.includes('tar -xzf -') && remote.includes('RAUHWpx_CHANNEL=stable')) {
      installerCalls += 1;
      return completedChild({
        code: 255,
        stderr: 'ssh: connection to host cloud-host.example closed after remote commit\n',
      });
    }
    throw new Error(`Unexpected remote command: ${remote}`);
  };
  const provisioner = new CloudProvisioner({
    spawnImpl,
    installerPath: path.join(root, 'install.sh'),
    bootstrapDir: root,
    appVersion: '1.2.3',
    knownHostsPath: path.join(root, 'known-hosts'),
    retrySleep: async () => {},
  });

  const result = await provisioner.provision(sshConfig(), {
    transport: 'ssh-tunnel',
    onLine: (line) => lines.push(line),
  });

  assert.equal(result.endpoint, 'http://127.0.0.1:7740/rauhwpx-cloud');
  assert.equal(result.recovered, true);
  assert.equal(installerCalls, 1, 'the ambiguous installer command is never replayed');
  assert.equal(existingCalls, 3, 'the service and its replayable recovery receipt are reconciled');
  assert.equal(existingCommands[1], existingCommands[2], 'receipt retry reuses one stable recovery request id');
  assert.match(existingCommands[1], /EXISTING_VERSION/);
  assert.match(existingCommands[1], /1\.2\.3/);
  assert.ok(lines.includes('The installer response was interrupted; checking the installed Cloud service'));
  assert.ok(lines.includes('Recovered the Cloud installation after the interrupted installer response'));
});

test('macOS provisioning recovers a healthy launchd service when the receipt is missing', async (t) => {
  const root = await fixture(t);
  const commands = [];
  let installerCalls = 0;
  let existingCalls = 0;
  const spawnImpl = (_command, args) => {
    const remote = args.at(-1);
    commands.push(remote);
    if (remote.includes('printf "arch=%s')) {
      return completedChild({ stdout: 'arch=arm64\nos=macos version=14.6.1\npreflight=ok\n' });
    }
    if (remote.includes('launchctl print system/com.hataewook.rauhwpx-cloud')) {
      existingCalls += 1;
      return completedChild({ stdout: existingCalls === 1 ? '' : RECEIPT });
    }
    if (remote.includes('RAUHWpx_CHANNEL=stable') && remote.endsWith('bash -s')) {
      installerCalls += 1;
      return completedChild({ stdout: 'Cloud service installed; receipt channel closed\n' });
    }
    throw new Error(`Unexpected remote command: ${remote}`);
  };
  const provisioner = new CloudProvisioner({
    spawnImpl,
    installerPath: path.join(root, 'install.sh'),
    knownHostsPath: path.join(root, 'known-hosts'),
    retrySleep: async () => {},
  });

  const result = await provisioner.provision(sshConfig(), { transport: 'ssh-tunnel' });

  assert.equal(result.recovered, true);
  assert.equal(installerCalls, 1, 'a receipt failure does not rerun the macOS installer');
  assert.equal(existingCalls, 2, 'macOS checks for a compatible service before install and after receipt loss');
  const recovery = commands.filter((command) => command.includes('launchctl print')).at(-1);
  assert.match(recovery, /127\.0\.0\.1:7740\/v1\/health/);
  assert.match(recovery, /PROTOCOL_VERSION/);
  assert.match(recovery, /pairing create/);
});

test('an ambiguous installer is not replayed when no compatible service can be proven', async (t) => {
  const root = await fixture(t);
  let existingCalls = 0;
  let installerCalls = 0;
  const spawnImpl = (_command, args) => {
    const remote = args.at(-1);
    if (remote.includes('printf "arch=%s')) {
      return completedChild({ stdout: 'arch=x86_64\nos=ubuntu version=24.04\npreflight=ok\n' });
    }
    if (remote.includes('systemctl is-active --quiet rauhwpx-cloud.service')) {
      existingCalls += 1;
      return completedChild();
    }
    if (remote.includes('RAUHWpx_CHANNEL=stable') && remote.endsWith('bash -s')) {
      installerCalls += 1;
      return completedChild({ code: 255, stderr: 'ssh: connection closed before receipt\n' });
    }
    throw new Error(`Unexpected remote command: ${remote}`);
  };
  const provisioner = new CloudProvisioner({
    spawnImpl,
    installerPath: path.join(root, 'install.sh'),
    knownHostsPath: path.join(root, 'known-hosts'),
    retrySleep: async () => {},
  });

  await assert.rejects(
    provisioner.provision(sshConfig(), { transport: 'ssh-tunnel' }),
    /connection closed before receipt/,
  );
  assert.equal(installerCalls, 1);
  assert.equal(existingCalls, 2, 'only the preinstall and reconciliation probes run');
});

test('a definite installer failure is reported without recovery or replay', async (t) => {
  const root = await fixture(t);
  let existingCalls = 0;
  let installerCalls = 0;
  const spawnImpl = (_command, args) => {
    const remote = args.at(-1);
    if (remote.includes('printf "arch=%s')) {
      return completedChild({ stdout: 'arch=x86_64\nos=ubuntu version=24.04\npreflight=ok\n' });
    }
    if (remote.includes('systemctl is-active --quiet rauhwpx-cloud.service')) {
      existingCalls += 1;
      return completedChild();
    }
    if (remote.includes('RAUHWpx_CHANNEL=stable') && remote.endsWith('bash -s')) {
      installerCalls += 1;
      return completedChild({ code: 23, stderr: 'installer validation failed\n' });
    }
    throw new Error(`Unexpected remote command: ${remote}`);
  };
  const provisioner = new CloudProvisioner({
    spawnImpl,
    installerPath: path.join(root, 'install.sh'),
    knownHostsPath: path.join(root, 'known-hosts'),
  });

  await assert.rejects(
    provisioner.provision(sshConfig(), { transport: 'ssh-tunnel' }),
    /installer validation failed/,
  );
  assert.equal(installerCalls, 1);
  assert.equal(existingCalls, 1, 'only the normal preinstall compatibility check runs');
});

test('generated recovery commands are valid shell and cache one pairing receipt per request', () => {
  const requestId = 'a'.repeat(32);
  const commands = [
    provisionerTest.existingInstallRemoteCommand({
      transport: 'ssh-tunnel',
      publicHost: '',
      tailscaleHttpsPort: 443,
      requestId,
    }),
    provisionerTest.existingMacosInstallRemoteCommand({ requestId }),
  ];

  for (const command of commands) {
    const checked = spawnSync('/bin/bash', ['-n', '-c', command], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(command, new RegExp(`${requestId}\\.receipt`));
    assert.ok(command.indexOf('test -s "$RECEIPT_FILE"') < command.indexOf('pairing create'));
    assert.ok(command.indexOf('mv -f "$RECEIPT_FILE.tmp"') < command.lastIndexOf('cat "$RECEIPT_FILE"'));
  }
});
