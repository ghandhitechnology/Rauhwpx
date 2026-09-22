import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CloudProvisioner, __test as provisionerTest } from '../desktop/cloud-provisioner.mjs';
import { SshTunnelManager, __test as tunnelTest } from '../desktop/cloud-ssh-tunnel.mjs';

function tunnelProfile() {
  return {
    endpoint: 'http://127.0.0.1:7740/rauhwpx-cloud',
    transport: 'ssh-tunnel',
    ssh: {
      host: 'cloud-host.example',
      user: 'cloud-user',
      port: 22,
      useTailscaleSsh: false,
    },
    api: {
      kind: 'ssh-tunnel',
      remoteHost: '127.0.0.1',
      remotePort: 7740,
      basePath: '/rauhwpx-cloud',
    },
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = null;
  return child;
}

test('SSH installer streaming rejects EPIPE instead of crashing the process', async () => {
  const spawnImpl = (_command, _args, options) => spawn(process.execPath, [
    '-e',
    'process.stdin.destroy(); setTimeout(() => process.exit(23), 500);',
  ], options);

  await assert.rejects(
    provisionerTest.runProcess(spawnImpl, 'ssh', [], {
      input: Buffer.alloc(16 * 1024 * 1024, 0x41),
      timeoutMs: 3_000,
    }),
    (error) => error.code === 'EPIPE' && /input failed/i.test(error.message),
  );
});

test('concurrent tunnel acquisition across a stop boundary starts exactly one SSH child', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-tunnel-single-flight-'));
  let spawnCount = 0;
  let healthRequests = 0;
  const servers = new Set();
  const spawnImpl = (_command, args) => {
    spawnCount += 1;
    const forwarding = args[args.indexOf('-L') + 1];
    const localPort = Number(forwarding.match(/^127\.0\.0\.1:(\d+):/)?.[1]);
    assert.equal(Number.isSafeInteger(localPort), true);

    const server = http.createServer((request, response) => {
      healthRequests += 1;
      assert.equal(request.url, '/rauhwpx-cloud/v1/health');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, protocolVersion: 1 }));
    });
    servers.add(server);
    server.listen(localPort, '127.0.0.1');

    const child = fakeChild();
    child.kill = (signal = 'SIGTERM') => {
      if (child.exitCode !== null) return false;
      child.exitCode = signal === 'SIGKILL' ? 137 : 143;
      const closed = () => {
        child.stderr.end();
        child.emit('close', null, signal);
      };
      const closeServer = () => {
        servers.delete(server);
        server.closeAllConnections?.();
        server.close(() => {});
        queueMicrotask(closed);
      };
      if (server.listening) closeServer();
      else server.once('listening', closeServer);
      return true;
    };
    return child;
  };

  const manager = new SshTunnelManager({
    spawnImpl,
    knownHostsPath: path.join(root, 'known-hosts'),
  });
  t.after(async () => {
    await manager.stop();
    await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
    await rm(root, { recursive: true, force: true });
  });

  const stopping = manager.stop();
  const acquisitions = Array.from({ length: 12 }, () => manager.acquire(tunnelProfile()));
  await stopping;
  const leases = await Promise.all(acquisitions);

  assert.equal(spawnCount, 1);
  assert.ok(healthRequests >= 1);
  assert.equal(new Set(leases.map((lease) => lease.baseUrl)).size, 1);
  assert.deepEqual(new Set(leases.map((lease) => lease.generation)), new Set([1]));
});

test('a listener that accepts locally without forwarding Cloud health never becomes ready', async (t) => {
  let accepted = 0;
  const sockets = new Set();
  const listener = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.end();
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    listener.close(resolve);
  }));

  const child = fakeChild();
  child.kill = () => true;
  const port = listener.address().port;
  await assert.rejects(
    tunnelTest.waitForForward(child, port, 350, { probeTimeoutMs: 75 }),
    /did not reach the Cloud health endpoint/i,
  );
  assert.ok(accepted >= 1, 'the local listener accepted probes but never returned protocol health');
});

test('preflight retries one transient real SSH-process failure and carries keepalives', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-preflight-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requested = [];
  const lines = [];
  let attempt = 0;
  const spawnImpl = (command, args, options) => {
    requested.push({ command, args });
    attempt += 1;
    if (attempt === 1) {
      return spawn(process.execPath, [
        '-e',
        'console.error("ssh: connect to host cloud-host.example: Connection reset by peer"); process.exit(255);',
      ], options);
    }
    return spawn(process.execPath, [
      '-e',
      'console.log("arch=x86_64\\nos=ubuntu version=24.04\\npreflight=ok");',
    ], options);
  };
  const provisioner = new CloudProvisioner({
    spawnImpl,
    installerPath: path.join(root, 'install.sh'),
    knownHostsPath: path.join(root, 'known-hosts'),
    retrySleep: async () => {},
  });

  const result = await provisioner.preflight({
    host: 'cloud-host.example',
    user: 'cloud-user',
    port: 22,
  }, { onLine: (line) => lines.push(line) });

  assert.deepEqual(result, {
    platform: 'linux',
    os: 'ubuntu',
    version: '24.04',
    arch: 'x86_64',
  });
  assert.equal(requested.length, 2);
  for (const call of requested) {
    assert.equal(call.command, 'ssh');
    assert.ok(call.args.includes('ServerAliveInterval=15'));
    assert.ok(call.args.includes('ServerAliveCountMax=3'));
  }
  assert.ok(lines.some((line) => /retrying \(2\/3\)/.test(line)));
});
