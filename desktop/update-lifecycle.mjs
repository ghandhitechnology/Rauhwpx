// The application approves document closure and stops its services before an
// installer can take over. electron-updater owns the final platform handoff.
export function createUpdateLifecycle({
  app, updater, nativeUpdater, platform, showMessageBox, openReleases,
  cleanupTasks, stopTransport, onQuitRequested, onTeardown, isInteractive = () => false, logger = console,
}) {
  let downloaded = null;
  let prompt = null;
  let installRequested = false;
  let handoffStarted = false;
  let updaterQuitting = false;
  let teardown = null;
  let failureDialog = null;
  const reportedErrors = new WeakSet();

  function cancelQuit() {
    installRequested = false;
    onQuitRequested(false);
  }

  async function reportError(error) {
    logger.warn('[rauhwpx] update failed:', error?.message ?? error);
    if (error && typeof error === 'object') {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    if (failureDialog) return failureDialog;
    const failedInstall = handoffStarted;
    if (!failedInstall && installRequested) cancelQuit();
    failureDialog = (async () => {
      try {
        const { response } = await showMessageBox({
          type: 'warning',
          message: failedInstall ? 'Rauhwpx could not install the update' : 'Rauhwpx could not update',
          detail: `${error?.message ?? String(error)}${failedInstall ? '\nRestart Rauhwpx to try again, or download the latest release.' : '\nChoose Check for Updates to try again.'}`,
          buttons: ['Open releases page', failedInstall ? 'Quit' : 'OK'],
          defaultId: 1,
          cancelId: 1,
        });
        if (response === 0) await openReleases();
      } catch (dialogError) {
        logger.warn('[rauhwpx] update error dialog failed:', dialogError);
      } finally {
        // Services have stopped and MacUpdater may retain a native staging
        // listener after an error. Retry in a fresh process, never a second
        // quitAndInstall call against that listener.
        if (failedInstall) app.exit(1);
        failureDialog = null;
      }
    })();
    return failureDialog;
  }

  function offerInstall() {
    if (!downloaded || installRequested || teardown || failureDialog) return Promise.resolve(false);
    if (prompt) return prompt;
    prompt = (async () => {
      try {
        const { response } = await showMessageBox({
          type: 'info',
          message: `Rauhwpx ${downloaded.version ?? ''} is ready to install`,
          detail: platform === 'win32'
            ? 'Your documents will close before the installer opens. Windows may ask you to confirm the installer. Choose Check for Updates to install later.'
            : 'Rauhwpx will restart after your documents close. Choose Check for Updates to install later.',
          buttons: [platform === 'win32' ? 'Install now' : 'Restart to install', 'Later'],
          defaultId: 1,
          cancelId: 1,
        });
        if (response !== 0 || teardown) return false;
        installRequested = true;
        app.quit();
        return true;
      } catch (error) {
        await reportError(error);
        return false;
      } finally {
        prompt = null;
      }
    })();
    return prompt;
  }

  function configureUpdates() {
    // A plain quit must never start a competing installer before our guards.
    updater.autoInstallOnAppQuit = false;
    updater.on('error', (error) => {
      if (handoffStarted || installRequested || isInteractive()) void reportError(error);
      else logger.warn('[rauhwpx] background update failed:', error?.message ?? error);
    });
    updater.on('update-downloaded', (info) => {
      const alreadyDownloaded = downloaded !== null && downloaded.version === info?.version;
      downloaded = info ?? {};
      if (!alreadyDownloaded) void offerInstall();
    });
  }

  async function finishQuit() {
    const results = await Promise.allSettled(cleanupTasks.map((cleanup) => Promise.resolve().then(cleanup)));
    for (const result of results) {
      if (result.status === 'rejected') logger.warn('[rauhwpx] quit cleanup failed:', result.reason);
    }
    try {
      await stopTransport();
    } catch (error) {
      logger.warn('[rauhwpx] cloud transport cleanup failed:', error);
    }
    if (!installRequested) {
      app.exit(0);
      return;
    }
    handoffStarted = true;
    try {
      // On macOS this waits for Squirrel staging and invokes the native
      // quitAndInstall. Plain app.quit() cannot perform that handoff.
      await updater.quitAndInstall(false, true);
    } catch (error) {
      await reportError(error);
    }
  }

  function start() {
    const allowUpdaterQuit = () => {
      if (handoffStarted) updaterQuitting = true;
    };
    nativeUpdater?.on('before-quit-for-update', allowUpdaterQuit);
    app.on('before-quit', (event) => {
      if (teardown && !updaterQuitting) {
        event.preventDefault();
        return;
      }
      onQuitRequested(true);
    });
    app.on('will-quit', (event) => {
      if (updaterQuitting) return;
      event.preventDefault();
      if (teardown) return;
      onTeardown();
      teardown = Promise.resolve().then(finishQuit);
    });
  }

  return { start, configureUpdates, cancelQuit, offerInstall, reportError, hasDownloadedUpdate: () => downloaded !== null };
}

// A renderer has approved Save/Discard. Cloud ownership and bookmark writes
// must also finish before this window can close or an update can install.
export async function completeWindowClose({ session, allowClose, cancelQuit, persistBookmarks, timeoutMs, onError = () => {} }) {
  if (!allowClose) {
    cancelQuit();
    return false;
  }
  let timer;
  try {
    if (session.cloudTransferPromise) {
      await Promise.race([
        session.cloudTransferPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Cloud transfer close wait timed out')), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    const intent = session.cloudTransferIntent;
    if (intent) {
      const completed = await Promise.race([
        intent.promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!completed) {
        if (session.cloudTransferIntent === intent && !intent.settled) {
          intent.settled = true;
          intent.settle(false);
          session.cloudTransferIntent = null;
        }
        cancelQuit();
        return false;
      }
    }
    await persistBookmarks();
    session.allowCloseOnce = true;
    session.window.close();
    return true;
  } catch (error) {
    cancelQuit();
    await onError(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
