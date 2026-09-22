import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createUpdateLifecycle, completeWindowClose } from '../desktop/update-lifecycle.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

function fixture({ platform = 'darwin', cleanupTasks, stopTransport, install, interactive = true } = {}) {
  const calls = [];
  const dialogs = [];
  const answers = [];
  const updater = new EventEmitter();
  const nativeUpdater = new EventEmitter();
  const app = new EventEmitter();
  let windows = 1;
  let quitRequested = false;
  app.exit = (code) => calls.push(`exit:${code}`);
  app.quit = () => {
    const before = event();
    app.emit('before-quit', before);
    if (before.prevented) { calls.push('quit-blocked'); return; }
    calls.push('quit-request');
    if (windows === 0) {
      const will = event();
      app.emit('will-quit', will);
      if (!will.prevented) calls.push('native-quit');
    }
  };
  updater.quitAndInstall = (...args) => {
    calls.push(['install', ...args]);
    return install?.({ updater, nativeUpdater, app });
  };
  const lifecycle = createUpdateLifecycle({
    app, updater, nativeUpdater, platform,
    isInteractive: () => interactive,
    showMessageBox: (options) => {
      dialogs.push(options);
      return Promise.resolve(answers.shift() ?? { response: 1 });
    },
    openReleases: async () => { calls.push('releases'); },
    cleanupTasks: cleanupTasks ?? [() => calls.push('cleanup')],
    stopTransport: stopTransport ?? (() => calls.push('transport')),
    onQuitRequested: (value) => { quitRequested = value; },
    onTeardown: () => calls.push('teardown'),
    logger: { warn: (...args) => calls.push(['warning', ...args]) },
  });
  lifecycle.start();
  lifecycle.configureUpdates();
  const session = {
    cloudTransferPromise: null, cloudTransferIntent: null, allowCloseOnce: false,
    window: { close: () => { calls.push('window-close'); windows = 0; app.quit(); } },
  };
  const approveClose = (options = {}) => completeWindowClose({
    session, allowClose: true, cancelQuit: lifecycle.cancelQuit,
    persistBookmarks: async () => calls.push('bookmarks'), timeoutMs: 50, ...options,
  });
  const downloaded = async (response = 0) => {
    answers.push({ response });
    updater.emit('update-downloaded', { version: '2.0.2' });
    await tick();
  };
  return { app, updater, nativeUpdater, lifecycle, calls, dialogs, answers, session, approveClose, downloaded,
    quitRequested: () => quitRequested, setInteractive: (value) => { interactive = value; } };
}
const installs = (f) => f.calls.filter((call) => Array.isArray(call) && call[0] === 'install');

test('macOS waits for approval and cleanup, then delegates staging and native restart exactly once', async () => {
  const cleanup = deferred();
  const f = fixture({ cleanupTasks: [() => cleanup.promise] });
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  await f.downloaded();
  assert.equal(f.dialogs[0].buttons[0], 'Restart to install');
  assert.equal(installs(f).length, 0);
  await f.approveClose();
  assert.equal(installs(f).length, 0);
  f.app.quit();
  cleanup.resolve();
  await tick();
  assert.deepEqual(installs(f), [['install', false, true]]);
  assert.ok(f.calls.indexOf('transport') < f.calls.findIndex(Array.isArray));
  f.app.quit();
  assert.equal(f.calls.includes('native-quit'), false, 'plain quit cannot interrupt Squirrel staging');
  assert.equal(f.calls.some((call) => typeof call === 'string' && call.startsWith('exit:')), false);
  f.nativeUpdater.emit('before-quit-for-update');
  f.app.quit();
  assert.ok(f.calls.includes('native-quit'));
  f.updater.emit('update-downloaded', { version: '2.0.2' });
  await tick();
  assert.equal(installs(f).length, 1);
  assert.equal(f.dialogs.length, 1);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform} starts the installer only after cloud transfer, bookmarks, and cleanup`, async () => {
    const f = fixture({ platform, install: ({ nativeUpdater, app }) => {
      nativeUpdater.emit('before-quit-for-update');
      app.quit();
    } });
    const transfer = deferred();
    f.session.cloudTransferPromise = transfer.promise;
    await f.downloaded();
    const closing = f.approveClose();
    await tick();
    assert.equal(installs(f).length, 0);
    assert.equal(f.session.allowCloseOnce, false);
    transfer.resolve();
    assert.equal(await closing, true);
    await tick();
    assert.deepEqual(f.calls.filter((call) => call !== 'quit-request'), [
      'bookmarks', 'window-close', 'teardown', 'cleanup', 'transport', ['install', false, true], 'native-quit',
    ]);
  });
}

test('Later and duplicate download events preserve an explicit install retry', async () => {
  const f = fixture();
  const answer = deferred();
  f.answers.push(answer.promise);
  f.updater.emit('update-downloaded', { version: '2.0.2' });
  f.updater.emit('update-downloaded', { version: '2.0.2' });
  await tick();
  assert.equal(f.dialogs.length, 1);
  answer.resolve({ response: 1 });
  await tick();
  assert.equal(f.lifecycle.hasDownloadedUpdate(), true);
  assert.equal(f.quitRequested(), false);
  f.answers.push({ response: 0 });
  await f.lifecycle.offerInstall();
  assert.equal(f.dialogs.length, 2);
  assert.equal(f.quitRequested(), true);
  assert.equal(installs(f).length, 0);
});

for (const reason of ['cancel', 'transfer rejection', 'transfer timeout', 'intent cancellation', 'intent timeout', 'bookmark failure']) {
  test(`${reason} cancels update intent, keeps the window open, and permits a later retry`, async () => {
    const f = fixture();
    await f.downloaded();
    const options = {};
    if (reason === 'cancel') options.allowClose = false;
    if (reason === 'transfer rejection') f.session.cloudTransferPromise = Promise.reject(new Error('transfer failed'));
    if (reason === 'transfer timeout') { f.session.cloudTransferPromise = deferred().promise; options.timeoutMs = 1; }
    if (reason.startsWith('intent')) {
      f.session.cloudTransferIntent = {
        promise: reason === 'intent timeout' ? deferred().promise : Promise.resolve(false),
        settled: false, settle: () => {},
      };
      options.timeoutMs = 1;
    }
    if (reason === 'bookmark failure') options.persistBookmarks = async () => { throw new Error('disk full'); };
    assert.equal(await f.approveClose(options), false);
    assert.equal(f.session.allowCloseOnce, false);
    assert.equal(f.quitRequested(), false);
    assert.equal(installs(f).length, 0);
    assert.equal(f.lifecycle.hasDownloadedUpdate(), true);
    f.session.cloudTransferPromise = null;
    f.session.cloudTransferIntent = null;
    f.answers.push({ response: 0 });
    await f.lifecycle.offerInstall();
    await f.approveClose();
    await tick();
    assert.equal(installs(f).length, 1);
  });
}

test('ordinary quit after Later performs cleanup and exits without installing', async () => {
  const f = fixture();
  await f.downloaded(1);
  f.app.quit();
  await f.approveClose();
  await tick();
  assert.equal(installs(f).length, 0);
  assert.deepEqual(f.calls.slice(-4), ['teardown', 'cleanup', 'transport', 'exit:0']);
});

test('cleanup attempts all services and transport, including synchronous errors, before installation', async () => {
  const done = [];
  const f = fixture({ cleanupTasks: [
    () => { throw new Error('display cleanup failed'); },
    async () => { done.push('hub'); },
  ], stopTransport: () => { done.push('transport'); throw new Error('transport cleanup failed'); } });
  await f.downloaded();
  await f.approveClose();
  await tick();
  assert.deepEqual(done, ['hub', 'transport']);
  assert.equal(installs(f).length, 1);
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'warning').length, 2);
});

test('a download error is visible once across the updater event and rejected promise', async () => {
  const f = fixture();
  const error = new Error('download interrupted');
  f.updater.emit('error', error);
  await f.lifecycle.reportError(error);
  await tick();
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].detail, /download interrupted/);
  assert.equal(f.calls.includes('exit:1'), false);
  await f.downloaded();
  await f.approveClose();
  await tick();
  assert.equal(installs(f).length, 1);
});

for (const failure of ['throw', 'reject', 'native error']) {
  test(`install ${failure} displays recovery after teardown and exits without a second native handoff`, async () => {
    const error = new Error('install failed');
    const f = fixture({ install: failure === 'throw' ? () => { throw error; }
      : failure === 'reject' ? () => Promise.reject(error) : undefined });
    await f.downloaded();
    await f.approveClose();
    await tick();
    if (failure === 'native error') f.updater.emit('error', error);
    await tick();
    assert.equal(f.dialogs.length, 2);
    assert.match(f.dialogs[1].message, /could not install/);
    assert.match(f.dialogs[1].detail, /Restart Rauhwpx/);
    assert.ok(f.calls.includes('exit:1'));
    await f.lifecycle.offerInstall();
    f.app.quit();
    assert.equal(installs(f).length, 1);
  });
}


test('background errors stay quiet while interactive checks and native install failures are visible', async () => {
  const f = fixture({ interactive: false });
  f.updater.emit('error', new Error('offline'));
  await tick();
  assert.equal(f.dialogs.length, 0);
  f.setInteractive(true);
  f.updater.emit('error', new Error('interactive check failed'));
  await tick();
  assert.equal(f.dialogs.length, 1);
  f.setInteractive(false);
  await f.downloaded();
  await f.approveClose();
  await tick();
  f.updater.emit('error', new Error('native staging failed'));
  await tick();
  assert.equal(f.dialogs.length, 3);
  assert.match(f.dialogs[2].message, /could not install/);
  assert.ok(f.calls.includes('exit:1'));
});
