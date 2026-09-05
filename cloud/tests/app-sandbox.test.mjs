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
import { LocalRunner, workerEnvironment } from '../src/local-runner.mjs';
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
    RAUHWpx_MAX_RUNNING: '8',
  });
  assert.equal(local.runner, 'local');
  assert.equal(local.workerUid, 1001);
  assert.equal(local.workerGid, 1001);
  assert.equal(local.workerControlSocket, '/run/rauhwpx/control.sock');
  assert.equal(local.maxRunningSessions, 1);
  assert.equal(parseConfig({ ...base, RAUHWpx_MAX_RUNNING: '8' }).maxRunningSessions, 8);
  assert.deepEqual(local.startupProviders, ['claude', 'codex', 'pi', 'grok', 'cursor']);
  assert.deepEqual(local.browserOrigins, []);
  assert.deepEqual(parseConfig({
    ...base,
    RAUHWpx_BROWSER_ORIGINS: 'https://studio.example.com, https://office.example.com',
  }).browserOrigins, ['https://studio.example.com', 'https://office.example.com']);
  assert.deepEqual(parseConfig({ ...base, RAUHWpx_SANDBOX_PROVIDER: 'codex' }).startupProviders, ['codex']);
  // 데이터 디렉터리는 0700이라 워커 uid가 통과할 수 없다. 작업 디렉터리는 그 밖에 있어야 한다.
  assert.equal(local.workspaceRoot, '/var/lib/rauhwpx-workspaces');
  assert.equal(podman.workspaceRoot, '/tmp/rauhwpx-data/workspaces');
  assert.equal(
    parseConfig({ ...base, RAUHWpx_RUNNER: 'local', RAUHWpx_WORKER_UID: '1001', RAUHWpx_WORKSPACE_ROOT: '/srv/work' }).workspaceRoot,
    '/srv/work',
  );
  assert.throws(
    () => parseConfig({
      ...base,
      RAUHWpx_RUNNER: 'local',
      RAUHWpx_WORKER_UID: '1001',
      RAUHWpx_WORKSPACE_ROOT: '/tmp/rauhwpx-data/workspaces',
    }),
    { code: 'CONFIG_INVALID' },
  );

  assert.throws(() => parseConfig({ ...base, RAUHWpx_RUNNER: 'docker' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => parseConfig({ ...base, RAUHWpx_BOOTSTRAP_TOKEN: 'short' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => parseConfig({ ...base, RAUHWpx_SANDBOX_PROVIDER: 'unknown' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => parseConfig({ ...base, RAUHWpx_BROWSER_ORIGINS: 'http://studio.example.com' }), { code: 'CONFIG_INVALID' });
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

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

test('local runner isolates each session workspace and cleans it up on stop', async (t) => {
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid !== -4242) return kill(pid, signal);
    throw Object.assign(new Error('Fake child has no process group'), { code: 'ESRCH' });
  });
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
  assert.equal(runner.maxRunningSessions, 1);

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

  // Chromium's singleton Unix socket must stay below the platform path limit.
  const temporaryDirectory = start.options.env.TMPDIR;
  assert.match(temporaryDirectory, /^\/tmp\/rw-[a-f0-9]{12}$/);
  assert.ok(Buffer.byteLength(path.join(temporaryDirectory, 'org.chromium.Chromium.XXXXXX', 'SingletonSocket')) < 108);
  assert.equal(temporaryDirectory.startsWith(path.join(config.workspaceRoot, first)), false);
  assert.equal(await fs.access(temporaryDirectory).then(() => true, () => false), true);

  await runner.stop(first);
  assert.equal(start.child.killed, 'SIGTERM');
  assert.equal(await fs.access(path.join(config.workspaceRoot, first)).then(() => true, () => false), false);
  assert.equal(await fs.access(temporaryDirectory).then(() => true, () => false), false);
  assert.deepEqual((await runner.list()).map((entry) => entry.sessionId), ['session-two']);

  await runner.stop(first);
  await runner.stop('local-missing');
  await runner.stop(second);
  assert.deepEqual(await runner.list(), []);
});

test('local runner reaps a detached process group when its worker exits spontaneously', {
  skip: process.platform === 'win32' ? 'POSIX process groups are unavailable on Windows' : false,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-local-runner-exit-'));
  const config = {
    workspaceRoot: path.join(root, 'workspaces'),
    providerAuthDirectory: path.join(root, 'provider-auth'),
    workerUid: null,
    workerGid: null,
  };
  await fs.mkdir(path.join(config.providerAuthDirectory, 'codex'), { recursive: true });
  const workerEntry = path.join(root, 'worker.mjs');
  await fs.writeFile(workerEntry, `
    import { spawn } from 'node:child_process';
    import { promises as fs } from 'node:fs';
    import path from 'node:path';
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    grandchild.unref();
    // Publish the complete PID; a newly created empty file parses as PID 0.
    const pidPath = path.join(process.env.RAUHWpx_WORKSPACE, 'grandchild.pid');
    await fs.writeFile(pidPath + '.tmp', String(grandchild.pid));
    await fs.rename(pidPath + '.tmp', pidPath);
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.exit(7);
  `);
  const runner = new LocalRunner(config, { workerEntry });
  let grandchildPid;
  let groupId;
  t.after(async () => {
    if (groupId) {
      try { process.kill(-groupId, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    if (grandchildPid) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const sandboxId = await runner.start({ id: 'session-exit', provider: 'codex' }, {
    workerToken: 'ra_wt_exit',
    controlSocket: '/run/rauhwpx/control.sock',
  });
  groupId = runner.children.get(sandboxId).child.pid;
  const workspace = path.join(config.workspaceRoot, sandboxId);
  const temporaryDirectory = path.join('/tmp', `rw-${sandboxId.slice(-12)}`);
  await waitFor(async () => {
    try {
      grandchildPid = Number(await fs.readFile(path.join(workspace, 'grandchild.pid'), 'utf8'));
      return Number.isSafeInteger(grandchildPid) && grandchildPid > 0;
    } catch {
      return false;
    }
  }, 'grandchild PID');
  await waitFor(() => runner.list().then((entries) => entries.length === 0), 'worker exit');
  await waitFor(async () => {
    const pathsGone = await Promise.all([workspace, temporaryDirectory].map(
      (target) => fs.access(target).then(() => false, () => true),
    ));
    return pathsGone.every(Boolean);
  }, 'workspace cleanup');
  await waitFor(() => {
    try {
      process.kill(grandchildPid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }, 'grandchild process exit');
});

test('the local worker cannot inherit the control plane environment', () => {
  const filtered = workerEnvironment({
    PATH: '/app/bin:/usr/bin',
    LANG: 'C.UTF-8',
    HTTPS_PROXY: 'http://proxy.internal',
    PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
    RAUHWpx_STUDIO_DIST: '/app/studio',
    RAUHWpx_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    RAUHWpx_PROVIDER_KEY_CODEX: 'operator-openai-key',
    RAILWAY_TOKEN: 'railway-secret',
    RAUHWpx_DATA_DIR: '/var/lib/rauhwpx-cloud',
    NODE_OPTIONS: '--require=/tmp/inject.cjs',
    DISPLAY: ':0',
    XAUTHORITY: '/root/.Xauthority',
  }, { RAUHWpx_SESSION_ID: 'session-one', RAUHWpx_WORKER_TOKEN: 'ra_wt_first' });

  // 워커와 provider CLI 는 같은 uid 로 돈다. 워커 환경에 남은 비밀은 에이전트가 읽을 수 있다.
  assert.equal(filtered.RAUHWpx_BOOTSTRAP_TOKEN, undefined);
  assert.equal(filtered.RAUHWpx_PROVIDER_KEY_CODEX, undefined);
  assert.equal(filtered.RAILWAY_TOKEN, undefined);
  assert.equal(filtered.RAUHWpx_DATA_DIR, undefined);
  assert.equal(filtered.NODE_OPTIONS, undefined);
  assert.equal(filtered.DISPLAY, undefined);
  assert.equal(filtered.XAUTHORITY, undefined);
  assert.deepEqual(filtered, {
    PATH: '/app/bin:/usr/bin',
    LANG: 'C.UTF-8',
    HTTPS_PROXY: 'http://proxy.internal',
    PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
    RAUHWpx_STUDIO_DIST: '/app/studio',
    RAUHWpx_SESSION_ID: 'session-one',
    RAUHWpx_WORKER_TOKEN: 'ra_wt_first',
  });
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
  assert.match(containerfile, /RAUHWpx_WORKSPACE_ROOT=\/var\/lib\/rauhwpx-workspaces/);
  assert.match(containerfile, /chmod 0711 \/run\/rauhwpx \/var\/lib\/rauhwpx-workspaces/);
  assert.match(containerfile, /COPY src \/app\/src/);
  assert.match(containerfile, /COPY worker \/app\/worker/);
  assert.match(containerfile, /COPY document-runtime \/app\/document-runtime/);
  assert.match(containerfile, /useradd --system --uid 1001/);
  assert.match(containerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/app\/install\/sandbox-entrypoint\.sh"\]/);
  assert.match(containerfile, /\bxvfb\b/);
  assert.match(containerfile, /\bxauth\b/);
  assert.match(containerfile, /\bx11-utils\b/);
  assert.match(containerfile, /\bx11-apps\b/);
  assert.match(containerfile, /matchbox-window-manager/);
  assert.match(containerfile, /tini="\$TINI_VERSION"/);
  assert.match(containerfile, /ffmpeg="\$FFMPEG_VERSION"/);
  assert.match(containerfile, /ffmpeg -hide_banner -devices 2>&1 \| grep -q 'x11grab'/);
  assert.doesNotMatch(containerfile, /^USER /m);

  const entrypoint = await fs.readFile(new URL('install/sandbox-entrypoint.sh', root), 'utf8');
  assert.match(entrypoint, /RAUHWpx_BOOTSTRAP_TOKEN is required/);
  assert.match(entrypoint, /exec node "\$CLOUD_ROOT\/src\/main\.mjs"/);
  assert.match(entrypoint, /export RAUHWpx_PORT="\$PORT"/);
  assert.match(entrypoint, /provider login "\$provider" --api-key-stdin/);
  assert.match(entrypoint, /provider seed-session/);
  assert.match(entrypoint, /sandbox\.provider_session_seeded/);
  assert.match(entrypoint, /sandbox\.provider_login_failed/);
  assert.match(entrypoint, /sandbox\.provider_install_failed/);
  assert.match(entrypoint, /chmod 0700 "\$DATA_DIR"/);
  assert.match(entrypoint, /chmod 0711 "\$CONTROL_DIR" "\$WORKSPACE_ROOT"/);
  // 자격 증명은 stdin으로만 넘긴다. 명령줄 인자는 컨테이너 안에서 ps로 보인다.
  assert.doesNotMatch(entrypoint, /--api-key[= ]\$/);

  // 릴리스가 이미지를 만들지 않으면 앱 제공 경로는 배포되지 않은 이미지를 가리킨다.
  const workflow = await fs.readFile(new URL('../.github/workflows/release.yml', root), 'utf8');
  assert.match(workflow, /podman build --tag rauhwpx-cloud-sandbox-release --file cloud\/install\/Containerfile\.sandbox cloud/);
  assert.match(workflow, /sandbox image must use the local runner/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /podman push "\$image:stable-\$ASSET_ARCH"/);
  assert.match(workflow, /podman manifest push --all "\$image:stable"/);

  const edgeWorkflow = await fs.readFile(new URL('../.github/workflows/cloud-sandbox-image.yml', root), 'utf8');
  assert.match(edgeWorkflow, /packages: write/);
  assert.match(edgeWorkflow, /podman push "\$image:edge"/);
  assert.doesNotMatch(edgeWorkflow, /api\.github\.com\/user\/packages/);
});
