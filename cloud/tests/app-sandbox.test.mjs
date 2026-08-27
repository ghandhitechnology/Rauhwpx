import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuthService } from '../src/auth.mjs';
import { BlobStore } from '../src/blob-store.mjs';
import { parseConfig } from '../src/config.mjs';
import { openDatabase } from '../src/database.mjs';
import { createCloudHttpHandler } from '../src/http-server.mjs';
import { LocalRunner } from '../src/local-runner.mjs';
import { SessionStore } from '../src/session-store.mjs';

const BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');

function testIdentity() {
  const pair = generateKeyPairSync('ed25519');
  const encodedKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    serverPublicKey: `ed25519:${encodedKey}`,
    serverId: createHash('sha256').update(encodedKey).digest('hex').slice(0, 24),
  };
}

function publicFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('X-Rauhwpx-Request-Nonce', randomBytes(24).toString('base64url'));
  return fetch(url, { ...options, headers });
}

async function fixture(t, { bootstrapToken = BOOTSTRAP_TOKEN } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-sandbox-'));
  const database = openDatabase(path.join(root, 'cloud.sqlite3'));
  const blobStore = new BlobStore(database, { root: path.join(root, 'objects') });
  const auth = new AuthService(database, { bootstrapToken });
  const sessionStore = new SessionStore(database, blobStore);
  const identity = testIdentity();
  const config = { basePath: '/rauhwpx-cloud', maxRunningSessions: 2, maxQueuedSessions: 20 };
  const server = http.createServer(createCloudHttpHandler({
    auth,
    blobStore,
    sessionStore,
    identity,
    config,
    logger: { error() {} },
    vault: { list: () => [], get: () => null },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/rauhwpx-cloud`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { base, auth, identity };
}

function bootstrap(base, token, deviceName = 'Rauhwpx desktop') {
  return publicFetch(`${base}/v1/pairing/bootstrap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName }),
  });
}

test('bootstrap pairing hands the first device a code and then closes for good', async (t) => {
  const { base, identity } = await fixture(t);
  const issued = await bootstrap(base, BOOTSTRAP_TOKEN);
  assert.equal(issued.status, 201);
  const receipt = await issued.json();
  assert.match(receipt.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(receipt.serverPublicKey, identity.serverPublicKey);
  assert.equal(receipt.serverId, identity.serverId);

  // 페어링 전에는 재시도가 가능해야 한다. 배포 직후 첫 요청이 네트워크로 사라질 수 있다.
  const retried = await bootstrap(base, BOOTSTRAP_TOKEN);
  assert.equal(retried.status, 201);
  const second = await retried.json();
  assert.notEqual(second.code, receipt.code);

  const redeemed = await publicFetch(`${base}/v1/pairing/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: second.code, deviceName: 'Rauhwpx desktop' }),
  });
  assert.equal(redeemed.status, 200);

  const closed = await bootstrap(base, BOOTSTRAP_TOKEN);
  assert.equal(closed.status, 409);
  assert.equal((await closed.json()).error.code, 'BOOTSTRAP_CLOSED');
});

test('bootstrap pairing rejects wrong tokens and stays off without one', async (t) => {
  const { base } = await fixture(t);
  const wrong = await bootstrap(base, randomBytes(32).toString('base64url'));
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'BOOTSTRAP_TOKEN_INVALID');
  const empty = await publicFetch(`${base}/v1/pairing/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 401);

  const disabled = await fixture(t, { bootstrapToken: '' });
  const off = await bootstrap(disabled.base, BOOTSTRAP_TOKEN);
  assert.equal(off.status, 404);
  assert.equal((await off.json()).error.code, 'BOOTSTRAP_DISABLED');
});

test('config gates the local runner and keeps the control socket outside the data directory', () => {
  const base = {
    RAUHWpx_DATA_DIR: '/tmp/rauhwpx-data',
    RAUHWpx_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
  };
  const podman = parseConfig(base);
  assert.equal(podman.runner, 'podman');
  assert.equal(podman.workerControlSocket, '/tmp/rauhwpx-data/worker-control/control.sock');
  assert.equal(podman.bootstrapToken, BOOTSTRAP_TOKEN);

  const local = parseConfig({
    ...base,
    RAUHWpx_RUNNER: 'local',
    RAUHWpx_WORKER_UID: '1001',
    RAUHWpx_WORKER_CONTROL_DIR: '/run/rauhwpx',
  });
  assert.equal(local.runner, 'local');
  assert.equal(local.workerUid, 1001);
  assert.equal(local.workerGid, 1001);
  assert.equal(local.workerControlSocket, '/run/rauhwpx/control.sock');
  assert.equal(local.workspaceRoot, '/tmp/rauhwpx-data/workspaces');

  assert.throws(() => parseConfig({ ...base, RAUHWpx_RUNNER: 'docker' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => parseConfig({ ...base, RAUHWpx_BOOTSTRAP_TOKEN: 'short' }), { code: 'CONFIG_INVALID' });
  assert.throws(
    () => parseConfig({ ...base, RAUHWpx_RUNNER: 'local', RAUHWpx_WORKER_UID: '0' }),
    { code: 'CONFIG_INVALID' },
  );
});

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.unref = () => {};
  child.kill = (signal) => { child.killed = signal; child.emit('exit', 0, signal); };
  child.stderr = { unref() {} };
  return child;
}

test('local runner isolates each session workspace and cleans it up on stop', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-local-runner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    workspaceRoot: path.join(root, 'workspaces'),
    providerAuthDirectory: path.join(root, 'provider-auth'),
    workerUid: null,
    workerGid: null,
  };
  await fs.mkdir(path.join(config.providerAuthDirectory, 'codex', '.codex'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(config.providerAuthDirectory, 'codex', '.codex', 'auth.json'), '{"token":"x"}');
  const spawned = [];
  const runner = new LocalRunner(config, {
    workerEntry: '/app/worker/main.mjs',
    spawnProcess: (executable, args, options) => {
      const child = fakeChild();
      spawned.push({ executable, args, options, child });
      return child;
    },
  });

  const first = await runner.start({ id: 'session-one', provider: 'codex' }, {
    workerToken: 'ra_wt_first',
    controlSocket: '/run/rauhwpx/control.sock',
  });
  const second = await runner.start({ id: 'session-two', provider: 'codex' }, {
    workerToken: 'ra_wt_second',
    controlSocket: '/run/rauhwpx/control.sock',
  });
  assert.notEqual(first, second);
  assert.deepEqual((await runner.list()).map((entry) => entry.sessionId).sort(), ['session-one', 'session-two']);

  const [start] = spawned;
  assert.deepEqual(start.args, ['/app/worker/main.mjs']);
  assert.equal(start.options.detached, true);
  assert.equal(start.options.env.RAUHWpx_SESSION_ID, 'session-one');
  assert.equal(start.options.env.RAUHWpx_WORKER_TOKEN, 'ra_wt_first');
  assert.equal(start.options.env.RAUHWpx_CONTROL_SOCKET, '/run/rauhwpx/control.sock');
  assert.equal(start.options.env.RAUHWpx_WORKSPACE, path.join(config.workspaceRoot, first));
  assert.equal(start.options.env.HOME, path.join(config.workspaceRoot, first, 'home'));
  assert.notEqual(start.options.env.RAUHWpx_WORKSPACE, spawned[1].options.env.RAUHWpx_WORKSPACE);

  const copied = path.join(start.options.env.RAUHWpx_PROVIDER_AUTH, '.codex', 'auth.json');
  assert.equal(await fs.readFile(copied, 'utf8'), '{"token":"x"}');
  assert.ok(start.options.env.RAUHWpx_PROVIDER_AUTH.startsWith(path.join(config.workspaceRoot, first)));

  await runner.stop(first);
  assert.equal(start.child.killed, 'SIGTERM');
  assert.equal(await fs.access(path.join(config.workspaceRoot, first)).then(() => true, () => false), false);
  assert.deepEqual((await runner.list()).map((entry) => entry.sessionId), ['session-two']);

  await runner.stop(first);
  await runner.stop('local-missing');
  await runner.stop(second);
  assert.deepEqual(await runner.list(), []);
});

test('local runner reports a failed spawn instead of attaching a dead sandbox', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-local-runner-fail-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    workspaceRoot: path.join(root, 'workspaces'),
    providerAuthDirectory: path.join(root, 'provider-auth'),
    workerUid: null,
    workerGid: null,
  };
  const runner = new LocalRunner(config, {
    spawnProcess: () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    },
  });
  await assert.rejects(
    runner.start({ id: 'session-one', provider: 'codex' }, { workerToken: 'ra_wt', controlSocket: '/run/x.sock' }),
    { code: 'WORKER_SPAWN_FAILED' },
  );
  assert.deepEqual(await runner.list(), []);
  assert.deepEqual(await fs.readdir(config.workspaceRoot), []);
});

test('the app sandbox image runs the control plane with the local runner and a bootstrap token', async () => {
  const root = new URL('../', import.meta.url);
  const containerfile = await fs.readFile(new URL('install/Containerfile.sandbox', root), 'utf8');
  assert.match(containerfile, /RAUHWpx_RUNNER=local/);
  assert.match(containerfile, /RAUHWpx_WORKER_UID=1001/);
  assert.match(containerfile, /RAUHWpx_WORKER_CONTROL_DIR=\/run\/rauhwpx/);
  assert.match(containerfile, /COPY src \/app\/src/);
  assert.match(containerfile, /COPY worker \/app\/worker/);
  assert.match(containerfile, /COPY document-runtime \/app\/document-runtime/);
  assert.match(containerfile, /useradd --system --uid 1001/);
  assert.match(containerfile, /ENTRYPOINT \["\/app\/install\/sandbox-entrypoint\.sh"\]/);
  assert.doesNotMatch(containerfile, /^USER /m);

  const entrypoint = await fs.readFile(new URL('install/sandbox-entrypoint.sh', root), 'utf8');
  assert.match(entrypoint, /RAUHWpx_BOOTSTRAP_TOKEN is required/);
  assert.match(entrypoint, /exec node "\$CLOUD_ROOT\/src\/main\.mjs"/);
  assert.match(entrypoint, /export RAUHWpx_PORT="\$PORT"/);
  assert.match(entrypoint, /provider login "\$provider" --api-key-stdin/);
  // 자격 증명은 stdin으로만 넘긴다. 명령줄 인자는 컨테이너 안에서 ps로 보인다.
  assert.doesNotMatch(entrypoint, /--api-key[= ]\$/);
});
