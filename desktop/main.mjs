import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session as electronSession,
  shell,
} from 'electron';
import electronUpdater from 'electron-updater';
import {
  closeHubSession,
  createHubToken,
  isHubHealthy,
  nextHubRestartDelay,
  packagedRhwpBinary,
  registerHubSession,
  requestHubShutdown,
  resolveHubLaunch,
  spawnHubProcess,
  stopHubChild,
  waitForHub,
  waitForHubReadyLine,
} from './agent-hub.mjs';
import { DocumentLeaseManager } from './document-leases.mjs';
import { quarantineBookmarkState, readBookmarkState } from './bookmark-state.mjs';
import {
  MAX_GENERATED_DOCUMENT_BYTES,
  readGeneratedDocumentResponse,
  resolveGeneratedDocumentArtifact,
} from './generated-document-artifact.mjs';
import { launchRequest } from './launch-routing.mjs';
import {
  NativeFileHandleRegistry,
  validateNativeDocumentBytes,
  writeNativeFileAtomically,
} from './native-file-handles.mjs';
import { SerializedStateWriter } from './serialized-state-writer.mjs';
import { SessionManager } from './session-manager.mjs';
import { safeSuggestedFilename } from './safe-filename.mjs';
import {
  STUDIO_URL,
  installStudioProtocol,
  registerStudioScheme,
  resolveDevelopmentUrl,
} from './studio-protocol.mjs';
import { createSecretVault, handleSecretRequest } from './secret-vault.mjs';
import { CloudClient } from './cloud-client.mjs';
import {
  createRaucloudBrokerProvider,
  raucloudBrokerUrl,
} from './cloud-broker.mjs';
import { CloudCoordinator } from './cloud-coordinator.mjs';
import { CloudDisplayRegistry } from './cloud-display-registry.mjs';
import { CloudHandoffStore } from './cloud-handoff.mjs';
import { collectProviderAuth as collectImportedProviderAuth } from './cloud-provider-auth.mjs';
import { CloudProvisioner } from './cloud-provisioner.mjs';
import { mergeCloudOperationSnapshot } from './cloud-snapshot.mjs';
import { CloudApiTransport, SshTunnelManager } from './cloud-ssh-tunnel.mjs';
import { collectProviderAuth } from './provider-auth.mjs';
import { applyCloudRecovery } from './cloud-result.mjs';
import { isNewerStableVersion, selectDebAsset } from './update-policy.mjs';
import { deliverPlainTextPaste } from './plain-text-paste.mjs';
import {
  hasPendingLaunchCleanupSync,
  retainLaunchRootForProcessCleanupSync,
} from '../rhwp/rhwp-agent/credential-mirror.mjs';
import { createAccountSession } from '../rhwp/rhwp-agent/account-session.mjs';
import { createRauCreditsClient, rauCreditsUrl } from '../rhwp/rhwp-agent/rau-credits-client.mjs';
import {
  launchStoragePaths,
  prepareDevelopmentCaches,
  removeLegacyLaunchDirectories,
  removeStaleLaunchDirectories,
  writeLaunchOwnerMetadata,
} from './runtime-cleanup.mjs';
import { reportUniqueInstall, uniqueInstallsPublicUrl } from './unique-install.mjs';

const { autoUpdater } = electronUpdater;
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RELEASES_URL = 'https://github.com/ghandhitechnology/Rauhwpx/releases/latest';
const RELEASES_API_URL = 'https://api.github.com/repos/ghandhitechnology/Rauhwpx/releases/latest';
const PRELOAD_PATH = join(__dirname, 'preload.cjs');
const devUrl = resolveDevelopmentUrl({
  packaged: app.isPackaged,
  rawUrl: process.env.RHWP_DEV_URL,
});
const launchId = randomUUID();
const hubToken = createHubToken();
const devOrigin = devUrl ? new URL(devUrl).origin : null;

const CLOUD_CLOSE_WAIT_MS = 120_000;
// Vite gives every hot update a new timestamped URL. Reusing Electron's
// persistent HTTP cache across dev runs otherwise leaves one JS/WASM entry per
// edit and per worktree in the production profile.
if (devUrl) app.commandLine.appendSwitch('disable-http-cache');

function isTrustedRendererUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (devOrigin) return url.origin === devOrigin;
    return url.protocol === 'rauhwpx:' && url.host === 'app';
  } catch {
    return false;
  }
}

function sessionForEvent(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedRendererUrl(senderUrl)) throw new Error('Untrusted renderer IPC sender');
  return sessions.sessionForSender(event.sender);
}

app.setName('Rauhwpx');
if (!app.isPackaged) {
  const developmentUserData = process.env.RHWP_DESKTOP_USER_DATA
    ? resolve(process.env.RHWP_DESKTOP_USER_DATA)
    : join(__dirname, '..', '.run', 'desktop-user-data');
  app.setPath('userData', developmentUserData);
}
registerStudioScheme(protocol);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function studioDist() {
  return join(__dirname, '..', 'rhwp', 'rhwp-studio', 'dist');
}

function unpackedPath(path) {
  const unpacked = path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : path;
}

function agentScript() {
  return unpackedPath(join(__dirname, '..', 'rhwp', 'rhwp-agent', 'server.mjs'));
}

function nativeRhwpExecutable() {
  const executable = process.platform === 'win32' ? 'rhwp.exe' : 'rhwp';
  const bundled = unpackedPath(join(__dirname, 'bin', `${process.platform}-${process.arch}`, executable));
  if (existsSync(bundled)) return bundled;
  if (app.isPackaged) throw new Error(`Packaged native document extractor is missing: ${bundled}`);
  const configured = String(process.env.RHWP_BIN ?? '').trim();
  if (configured && existsSync(configured)) return configured;
  const development = join(__dirname, '..', 'rhwp', 'target', 'release', executable);
  return existsSync(development) ? development : null;
}

class AgentHubOwner {
  #child = null;
  #context = null;
  #disposed = false;
  #startPromise = null;
  #stopPromise = null;
  #restartAttempt = 0;
  #restartTimer = null;
  #stoppingChild = null;
  #restartRequired = false;

  constructor({ runtimeDir, workDir }) {
    this.runtimeDir = runtimeDir;
    this.workDir = workDir;
  }

  context() {
    return this.#context;
  }

  clearRestart() {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }

  scheduleRestart() {
    if (this.#disposed || quitting || this.#restartTimer || this.#restartRequired) return;
    const delay = nextHubRestartDelay(this.#restartAttempt++);
    console.warn(`[rauhwpx] owned agent hub exited; restarting in ${delay}ms`);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.ensure().catch((error) => {
        console.warn('[rauhwpx] agent hub restart failed:', error);
        this.scheduleRestart();
      });
    }, delay);
  }

  restartRequiredError() {
    const error = new Error(
      'The agent hub exited before its Windows process tree could be confirmed stopped. Restart Rauhwpx before using the agent hub again.',
    );
    error.code = 'AGENT_HUB_RESTART_REQUIRED';
    return error;
  }

  quarantineUnexpectedWindowsExit() {
    if (this.#restartRequired) return;
    this.#restartRequired = true;
    this.clearRestart();
    try {
      retainLaunchRootForProcessCleanupSync(this.workDir, { launchId });
    } catch (error) {
      console.warn('[rauhwpx] process cleanup retention marker failed:', error);
    }
    console.warn(
      '[rauhwpx] owned agent hub exited unexpectedly on Windows; retaining launch work and requiring an app restart:',
      this.workDir,
    );
  }

  async stopCurrent() {
    const child = this.#child;
    const context = this.#context;
    this.#context = null;
    this.#stoppingChild = child;
    let cleanupPrepared = false;
    try {
      if (this.#restartRequired && (child?.exitCode != null || child?.signalCode != null)) {
        throw this.restartRequiredError();
      }
      if (context) {
        try {
          const response = await requestHubShutdown({
            port: context.port,
            token: hubToken,
            launchId,
            timeoutMs: 15_000,
          });
          cleanupPrepared = response?.status === 'prepared'
            && response?.launchId === launchId;
        } catch (error) {
          console.warn('[rauhwpx] graceful agent hub shutdown failed:', error);
        }
      }
      // A prepared response proves descendants were disposed. Windows can then
      // wait on the retained child handle without resolving a reusable PID.
      const stopped = await stopHubChild(child, { timeoutMs: 5000, cleanupPrepared });
      if (!stopped) {
        // Preserve the exited leader's PID/tree identity and make every outer
        // cleanup layer retain the launch root until a reboot proves safety.
        try {
          retainLaunchRootForProcessCleanupSync(this.workDir, { launchId });
        } catch (error) {
          console.warn('[rauhwpx] process cleanup retention marker failed:', error);
        }
        if (!this.#child || this.#child === child) this.#child = child;
        throw new Error(`Agent hub process tree ${child?.pid ?? 'unknown'} survived shutdown`);
      }
      if (this.#child === child) this.#child = null;
    } finally {
      if (this.#stoppingChild === child) this.#stoppingChild = null;
    }
  }

  async start() {
    if (this.#disposed) throw new Error('Agent hub owner has been disposed');
    if (this.#restartRequired) throw this.restartRequiredError();
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.startOwnedChild();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async startOwnedChild() {
    mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    if (this.#child && this.#context) {
      const healthy = await isHubHealthy(this.#context.port, {
        token: hubToken,
        launchId,
        expectedPid: this.#child.pid,
        expectedLaunchId: launchId,
      });
      if (healthy) return { started: false, ready: true, context: this.#context };
      await this.stopCurrent();
    } else if (this.#child) {
      await this.stopCurrent();
    }

    const server = agentScript();
    const rhwpExecutable = nativeRhwpExecutable();
    const rhwpBinary = packagedRhwpBinary({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    const launch = resolveHubLaunch({
      packaged: app.isPackaged,
      execPath: process.execPath,
      scriptPath: server,
      agentDir: dirname(server),
      home: app.getPath('home'),
      extraDirs: [join(__dirname, '..', 'node_modules', '.bin')],
      allowNpm: false,
      env: {
        ...process.env,
        RHWP_AGENT_PORT: '0',
        RHWP_AGENT_TOKEN: hubToken,
        RHWP_AGENT_MODE: 'production',
        ...(rhwpBinary ? { RHWP_BIN: rhwpBinary } : {}),
        RHWP_LAUNCH_ID: launchId,
        RHWP_OWNER_PID: String(process.pid),
        RHWP_OWNER_IPC: '1',
        RHWP_RUNTIME_DIR: this.runtimeDir,
        RHWP_WORK_DIR: this.workDir,
        RHWP_AGENT_INSTRUCTIONS_DIR: join(app.getPath('userData'), 'agent-instructions'),
        RHWP_OWN_RUNTIME_DIR: '1',
        RHWP_OWN_WORK_DIR: '1',
        RHWP_SECRET_BROKER: 'ipc',
        ...(rhwpExecutable ? { RHWP_BIN: rhwpExecutable } : {}),
      },
    });
    if (!launch) throw new Error(`Agent hub launch command not found: ${server}`);
    launch.cwd = this.workDir;

    console.log(`[rauhwpx] starting owned agent hub via ${launch.via}`);
    const child = spawnHubProcess(launch, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      onMessage: (message, source) => {
        if (!secretVault) return;
        void handleSecretRequest(secretVault, message).then((response) => {
          if (response && source.connected) source.send(response);
        });
      },
      onError: (error) => {
        console.warn('[rauhwpx] agent hub spawn error:', error);
      },
      onExit: (code, signal) => {
        console.warn('[rauhwpx] agent hub process exit:', code, signal ?? '');
        if (this.#child !== child) return;
        this.#context = null;
        // `exit` only proves the leader died. Retain the ChildProcess/PID until
        // stopCurrent has probed and escalated the complete owned tree.
        if (this.#stoppingChild === child) return;
        if (process.platform === 'win32') {
          this.quarantineUnexpectedWindowsExit();
          return;
        }
        this.scheduleRestart();
      },
    });
    this.#child = child;

    try {
      const ready = await waitForHubReadyLine(child, { launchId });
      if (ready.pid !== child.pid) throw new Error('Agent hub ready line did not match the owned child');
      const healthy = await waitForHub(ready.port, {
        isHealthy: () => isHubHealthy(ready.port, {
          token: hubToken,
          launchId,
          expectedPid: child.pid,
          expectedLaunchId: launchId,
        }),
      });
      if (!healthy) throw new Error('Owned agent hub failed authenticated health checks');
      this.#context = Object.freeze({
        port: ready.port,
        hubUrl: `ws://127.0.0.1:${ready.port}`,
        hubToken,
      });
      this.#restartAttempt = 0;
      this.clearRestart();
      return { started: true, ready: true, context: this.#context };
    } catch (error) {
      if (this.#child === child) await this.stopCurrent();
      throw error;
    }
  }

  async ensure() {
    return this.start();
  }

  teardown() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#disposed = true;
    this.clearRestart();
    this.#stopPromise = (async () => {
      await this.#startPromise?.catch(() => {});
      await this.stopCurrent();
      await rm(this.runtimeDir, { recursive: true, force: true });
      if (hasPendingLaunchCleanupSync(this.workDir)) {
        console.warn('[rauhwpx] retaining launch work for pending cleanup:', this.workDir);
      } else {
        await rm(this.workDir, { recursive: true, force: true });
      }
    })();
    return this.#stopPromise;
  }
}

let quitting = false;
let quitRequested = false;
let desktopReady = false;
let secretVault = null;
let cloudAccountSession = null;
let cloudCoordinator = null;
let cloudTransport = null;
const cloudDisplayConnections = new CloudDisplayRegistry({
  openDisplay: (sessionId, listener, options) => requireCloudCoordinator().openDisplay(
    sessionId,
    listener,
    options,
  ),
});
let cloudBroadcastChain = Promise.resolve();
const CLOUD_BROADCAST_COALESCE_MS = 100;
let cloudBroadcastTimer = null;
let cloudBroadcastPending = [];
const pendingLaunches = [launchRequest({ argv: process.argv, source: 'initial' })];
const launchStorage = launchStoragePaths({
  tempDir: app.getPath('temp'),
  userDataDir: app.getPath('userData'),
  launchId,
});
const {
  profileId: userDataProfileId,
  runtimeRoot,
  workRoot,
  runtimeDir,
  workDir,
  legacyRuntimeRoot,
  legacyWorkRoot,
} = launchStorage;
const hubOwner = new AgentHubOwner({ runtimeDir, workDir });
const sessions = new SessionManager({
  launchId,
  getHubContext: async () => (await hubOwner.ensure()).context,
  getSessionCapabilities: (sessionId, hub) => registerHubSession({
    port: hub.port,
    token: hubToken,
    launchId,
    sessionId,
  }),
});
const documentLeases = new DocumentLeaseManager();
const nativeFiles = new NativeFileHandleRegistry();
const nativeBookmarkFile = join(app.getPath('userData'), 'native-document-bookmarks.json');
let uniqueInstallSnapshot = {
  uniqueInstalls: null,
  publicUrl: uniqueInstallsPublicUrl(),
  recorded: false,
};
let resolveUniqueInstallSync = () => {};
const uniqueInstallSync = new Promise((resolve) => {
  resolveUniqueInstallSync = resolve;
});

async function syncUniqueInstallMetric() {
  uniqueInstallSnapshot = await reportUniqueInstall({
    userDataDir: app.getPath('userData'),
    packaged: app.isPackaged,
    devUrl,
    appVersion: app.getVersion(),
    os: process.platform,
    arch: process.arch,
    baseUrl: rauCreditsUrl(),
  });
}

async function finishUniqueInstallMetric() {
  try {
    await syncUniqueInstallMetric();
  } catch (error) {
    console.warn('[rauhwpx] unique install ping failed:', error);
  } finally {
    resolveUniqueInstallSync();
  }
}
const nativeBookmarkWriter = new SerializedStateWriter({
  write: (snapshot) => writeNativeFileAtomically(nativeBookmarkFile, Buffer.from(snapshot, 'utf8')),
  onError: (error) => console.warn('[rauhwpx] native bookmark persist failed:', error),
});

function normalizeCloudScope(payload = {}) {
  const threadId = typeof payload.threadId === 'string' && payload.threadId.length <= 256
    ? payload.threadId
    : '';
  const documentId = payload.documentId === null
    ? null
    : typeof payload.documentId === 'string' && payload.documentId.length <= 256
      ? payload.documentId
      : null;
  const selectedSessionId = typeof payload.selectedSessionId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(payload.selectedSessionId)
    ? payload.selectedSessionId
    : null;
  return { threadId, documentId, selectedSessionId };
}

function applyCloudSnapshot(session, snapshot) {
  session.cloudLocked = snapshot?.lease?.owner === 'cloud';
  session.cloudHandoffId = snapshot?.session?.kind === 'idle' ? null : snapshot?.session?.sessionId ?? null;
  return snapshot;
}

async function scopedCloudSnapshot(session, operation = null, { refresh = false } = {}) {
  const scope = session.cloudScope ?? { threadId: '', documentId: null };
  const options = {
    originSessionId: session.sessionId,
    documentId: scope.documentId,
    selectedSessionId: scope.selectedSessionId,
  };
  const scoped = refresh
    ? await requireCloudCoordinator().refresh(options)
    : await requireCloudCoordinator().snapshot(options);
  const snapshot = mergeCloudOperationSnapshot(operation, scoped);
  return applyCloudSnapshot(session, snapshot);
}

async function broadcastCloudEvent(payload) {
  await Promise.all(sessions.windows().map(async (window) => {
    if (window.isDestroyed()) return;
    const session = sessions.sessionForSender(window.webContents);
    const snapshot = await scopedCloudSnapshot(session).catch(() => null);
    if (!snapshot || window.isDestroyed()) return;
    window.webContents.send('cloud:event', { ...payload, snapshot });
  }));
}

function queueCloudBroadcast(payload) {
  // Build one snapshot per burst, but never collapse ordered agent deltas.
  // The renderer reconciles them with the stable timeline at each boundary.
  cloudBroadcastPending.push(payload);
  if (cloudBroadcastTimer) return;
  cloudBroadcastTimer = setTimeout(() => {
    cloudBroadcastTimer = null;
    const events = cloudBroadcastPending;
    cloudBroadcastPending = [];
    if (!events.length) return;
    cloudBroadcastChain = cloudBroadcastChain
      .then(() => broadcastCloudEvent({ type: 'cloud-event-batch', events }))
      .catch((error) => console.warn('[rauhwpx] cloud event broadcast failed:', error));
  }, CLOUD_BROADCAST_COALESCE_MS);
  cloudBroadcastTimer.unref?.();
}

function requireCloudCoordinator() {
  if (!cloudCoordinator) throw new Error('Cloud service is not ready');
  return cloudCoordinator;
}

const RAUCLOUD_DEVICE_SECRET = 'cloud.managed-device-id';

async function raucloudDeviceIdentity() {
  let id = String(await secretVault.get(RAUCLOUD_DEVICE_SECRET).catch(() => '') ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id)) {
    id = randomUUID();
    await secretVault.set(RAUCLOUD_DEVICE_SECRET, id);
  }
  return { id, name: app.getName() };
}

async function loadNativeBookmarks() {
  try {
    const raw = await readBookmarkState(nativeBookmarkFile);
    if (raw === null) return;
    try {
      nativeFiles.loadBookmarks(raw, { strict: true });
    } catch (error) {
      error.code = 'BOOKMARK_STATE_CORRUPT';
      throw error;
    }
  } catch (error) {
    if (error?.code !== 'BOOKMARK_STATE_CORRUPT') throw error;
    const quarantined = await quarantineBookmarkState(nativeBookmarkFile);
    console.warn('[rauhwpx] corrupt native bookmark state quarantined:', quarantined);
  }
}

function persistNativeBookmarks() {
  return nativeBookmarkWriter.enqueue(JSON.stringify(nativeFiles.dumpBookmarks()));
}

async function bestEffortStartupCleanup(label, cleanup) {
  try {
    await cleanup;
  } catch (error) {
    console.warn(`[rauhwpx] ${label} cleanup failed:`, error);
  }
}

let updateDownloadReady = false;
let manualUpdateCheck = false;
let updateCheckPromise = null;

async function showUpToDate() {
  await dialog.showMessageBox({
    type: 'info',
    message: 'Rauhwpx is up to date',
    detail: `Version ${app.getVersion()} is the latest release.`,
    buttons: ['OK'],
  });
}

async function checkForDebUpdates({ manual }) {
  const response = await net.fetch(RELEASES_API_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) {
    throw new Error('GitHub release metadata is too large');
  }
  const release = await response.json();
  if (!isNewerStableVersion(release?.tag_name, app.getVersion())) {
    if (manual) await showUpToDate();
    return null;
  }
  const asset = selectDebAsset(release?.assets, process.arch);
  const { response: choice } = await dialog.showMessageBox({
    type: 'info',
    message: `Rauhwpx ${String(release.tag_name).replace(/^v/i, '')} is available`,
    detail: `You are running version ${app.getVersion()}. Download the signed Debian package and install it with your system package manager.`,
    buttons: ['Open download page', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) void shell.openExternal(asset?.browser_download_url ?? release?.html_url ?? RELEASES_URL);
  return release;
}

function configureAutoUpdater() {
  autoUpdater.logger = console;
  const linuxAppImage = process.platform === 'linux' && Boolean(process.env.APPIMAGE);
  // macOS and AppImage builds can stage compatible updates. Debian packages
  // stay under the system package manager and only link to the signed release.
  autoUpdater.autoDownload = process.platform === 'darwin' || linuxAppImage;
  autoUpdater.on('error', (error) => {
    console.warn('[rauhwpx] update check failed:', error?.message ?? error);
  });
  autoUpdater.on('update-not-available', () => {
    if (!manualUpdateCheck) return;
    void showUpToDate();
  });
  autoUpdater.on('update-available', (info) => {
    const linuxDeb = process.platform === 'linux' && !process.env.APPIMAGE;
    if (autoUpdater.autoDownload || (!manualUpdateCheck && !linuxDeb)) return;
    void dialog.showMessageBox({
      type: 'info',
      message: `Rauhwpx ${info?.version ?? ''} is available`,
      detail: linuxDeb
        ? `You are running version ${app.getVersion()}. Download the signed Debian package from Releases.`
        : `You are running version ${app.getVersion()}. Download the installer now?`,
      buttons: linuxDeb ? ['Open download page', 'Cancel'] : ['Download', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response !== 0) return;
      if (linuxDeb) {
        void shell.openExternal(RELEASES_URL);
      } else {
        void autoUpdater.downloadUpdate().catch((error) => {
          console.warn('[rauhwpx] update download failed:', error?.message ?? error);
        });
      }
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (updateDownloadReady) return;
    updateDownloadReady = true;
    const version = info?.version ?? '';
    const isMac = process.platform === 'darwin';
    const isLinuxAppImage = process.platform === 'linux' && Boolean(process.env.APPIMAGE);
    const buttons = isMac
      ? ['Quit to install', 'Later']
      : isLinuxAppImage ? ['Restart to install', 'Later'] : ['Install now', 'Later'];
    void dialog.showMessageBox({
      type: 'info',
      message: `Rauhwpx ${version} is ready to install`,
      detail: isMac
        ? 'It will be installed when Rauhwpx quits.'
        : isLinuxAppImage
          ? 'Restart Rauhwpx to replace this AppImage with the verified update.'
          : 'The installer opens after Rauhwpx closes; Windows may ask you to confirm it because it is not signed yet.',
      buttons,
      defaultId: 1,
      cancelId: 1,
    }).then(({ response }) => {
      if (response !== 0) return;
      if (isMac) {
        app.quit();
        return;
      }
      updateDownloadReady = false;
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    });
  });
}

async function checkForAppUpdates({ manual = true } = {}) {
  if (updateCheckPromise) {
    if (manual) manualUpdateCheck = true;
    return updateCheckPromise;
  }
  manualUpdateCheck = manual;
  updateCheckPromise = (async () => {
    try {
      if (process.platform === 'linux' && !process.env.APPIMAGE) {
        return await checkForDebUpdates({ manual: manualUpdateCheck });
      }
      return await autoUpdater.checkForUpdates();
    } catch (error) {
      console.warn('[rauhwpx] update check failed:', error?.message ?? error);
      if (!manualUpdateCheck) return null;
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: 'Rauhwpx could not check for updates',
        detail: error?.message ?? String(error),
        buttons: ['Open releases page', 'OK'],
        defaultId: 1,
      });
      if (response === 0) void shell.openExternal(RELEASES_URL);
      return null;
    } finally {
      manualUpdateCheck = false;
      updateCheckPromise = null;
    }
  })();
  return updateCheckPromise;
}

function installMenu() {
  const isMac = process.platform === 'darwin';
  const checkForUpdates = {
    label: 'Check for Updates…',
    click: () => {
      if (!app.isPackaged) {
        void shell.openExternal(RELEASES_URL);
        return;
      }
      void checkForAppUpdates();
    },
  };
  const newWindow = {
    label: 'New Window',
    accelerator: 'CmdOrCtrl+Shift+N',
    click: () => queueLaunch(launchRequest({ source: 'new-window' })),
  };
  const pasteWithoutFormatting = {
    id: 'edit-paste-without-formatting',
    label: 'Paste Without Formatting',
    accelerator: 'CmdOrCtrl+Shift+V',
    click: (_menuItem, browserWindow) => {
      deliverPlainTextPaste(
        browserWindow ?? BrowserWindow.getFocusedWindow(),
        () => clipboard.readText(),
      );
    },
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{
      label: 'Rauhwpx',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        checkForUpdates,
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        newWindow,
        { type: 'separator' },
        ...(!isMac ? [checkForUpdates, { type: 'separator' }] : []),
        { role: isMac ? 'close' : 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        pasteWithoutFormatting,
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(isMac ? [] : [{ role: 'help', submenu: [{ role: 'about' }] }]),
  ]));
}

function cascadedWindowPosition() {
  const source = BrowserWindow.getFocusedWindow() ?? sessions.windows().at(-1);
  if (!source || source.isDestroyed()) return {};
  const bounds = source.getBounds();
  return { x: bounds.x + 28, y: bounds.y + 28 };
}

async function createWindow(launch = launchRequest(), { generatedDocument = null } = {}) {
  await hubOwner.ensure();
  const closeHubContext = hubOwner.context();
  if (!closeHubContext) throw new Error('Agent hub context is unavailable');
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#141416' : '#f5f5f7';
  const isMac = process.platform === 'darwin';
  const window = new BrowserWindow({
    ...cascadedWindowPosition(),
    title: 'Rauhwpx',
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor,
    ...(isMac ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 12 },
    } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      // 프리로드는 contextBridge/ipcRenderer/webUtils 만 쓰므로 샌드박스 렌더러에서도 동작한다.
      sandbox: true,
    },
  });
  const displayOwnerId = window.webContents.id;
  const closeDisplayConnection = () => {
    void cloudDisplayConnections.close(displayOwnerId);
  };
  const session = sessions.addWindow(window, { source: launch.source, openFiles: [] });
  session.generatedDocument = generatedDocument
    ? { launchDocumentId: randomUUID(), ...generatedDocument }
    : null;
  session.allowCloseOnce = false;
  session.pendingCloseRequestId = null;
  session.cloudLocked = false;
  session.cloudHandoffId = null;
  session.cloudTransferPromise = null;
  session.cloudScope = { threadId: '', documentId: null };
  session.cloudTransferIntent = null;
  window.on('close', (event) => {
    if (session.allowCloseOnce) return;
    // A dead renderer can never answer the Save–Discard–Cancel prompt.
    // Blocking the close here would leave an unclosable window that also
    // stalls quit, so let the close proceed instead.
    if (window.webContents.isDestroyed() || window.webContents.isCrashed()) return;
    event.preventDefault();
    if (session.pendingCloseRequestId) return;
    session.pendingCloseRequestId = randomUUID();
    window.webContents.send('desktop:close-requested', {
      requestId: session.pendingCloseRequestId,
      reason: quitRequested ? 'quit' : 'close',
    });
  });
  window.on('closed', () => {
    closeDisplayConnection();
    documentLeases.releaseSession(session.sessionId);
    nativeFiles.releaseSession(session.sessionId);
    sessions.removeWindow(window);
    if (quitRequested) setImmediate(() => {
      if (quitRequested) app.quit();
    });
    const hub = hubOwner.context() ?? closeHubContext;
    void closeHubSession({
      port: hub.port,
      token: hubToken,
      launchId,
      sessionId: session.sessionId,
    }).catch((error) => {
      if (error?.status !== 404) console.warn('[rauhwpx] hub session close failed:', error);
    });
  });
  const launchFiles = [];
  try {
    for (const filePath of launch.openFiles) {
      const result = await nativeFiles.create(session.sessionId, filePath);
      if (!result.ok) {
        sessions.focusSession(result.ownerSessionId);
        window.destroy();
        return null;
      }
      launchFiles.push(result.descriptor);
    }
  } catch (error) {
    window.destroy();
    throw error;
  }

  window.on('enter-full-screen', () => {
    if (!window.isDestroyed()) window.webContents.send('window:fullscreen-changed', true);
  });
  window.on('leave-full-screen', () => {
    if (!window.isDestroyed()) window.webContents.send('window:fullscreen-changed', false);
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.warn('[rauhwpx] preload error', preloadPath, error);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.warn('[rauhwpx] renderer process gone:', details?.reason);
    closeDisplayConnection();
    // An unanswered close prompt died with the renderer; clear it so the
    // window can close (the close handler skips the prompt for dead renderers).
    session.pendingCloseRequestId = null;
  });
  window.webContents.once('destroyed', closeDisplayConnection);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  for (const eventName of ['will-navigate', 'will-redirect']) {
    window.webContents.on(eventName, (event, url) => {
      if (!isTrustedRendererUrl(url)) event.preventDefault();
    });
  }
  window.webContents.on('did-finish-load', () => {
    if (launchFiles.length > 0 && !window.isDestroyed()) {
      window.webContents.send('desktop:open-files', launchFiles);
    }
    if (session.generatedDocument && !window.isDestroyed()) {
      window.webContents.send('desktop:open-generated-document', session.generatedDocument);
    }
  });
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });
  await window.loadURL(devUrl || STUDIO_URL);
  if (!window.isDestroyed() && !window.isVisible()) window.show();
  return window;
}

async function openLaunch(request) {
  if (request.openFiles.length === 0) {
    await createWindow(request);
    return;
  }
  for (const filePath of request.openFiles) {
    const ownerSessionId = await nativeFiles.ownerForPath(filePath).catch(() => null);
    if (ownerSessionId) {
      sessions.focusSession(ownerSessionId);
      continue;
    }
    await createWindow(launchRequest({ openFiles: [filePath], source: request.source }));
  }
}

function queueLaunch(request) {
  if (!desktopReady) {
    pendingLaunches.push(request);
    return;
  }
  void openLaunch(request).catch(showLaunchError);
}

function showLaunchError(error) {
  dialog.showErrorBox('Rauhwpx could not open', error instanceof Error ? error.message : String(error));
}

ipcMain.handle('desktop:get-unique-installs', async (event) => {
  sessionForEvent(event);
  await uniqueInstallSync;
  return uniqueInstallSnapshot;
});
ipcMain.handle('desktop:get-session-context', (event) => {
  sessionForEvent(event);
  return sessions.contextForSender(event.sender);
});
ipcMain.handle('desktop:get-launch-files', (event) => {
  const session = sessionForEvent(event);
  return nativeFiles.descriptorsForSession(session.sessionId);
});
ipcMain.handle('desktop:get-launch-generated-document', (event) => {
  const session = sessionForEvent(event);
  return session.generatedDocument;
});
ipcMain.handle('desktop:open-generated-document-window', async (event, payload = {}) => {
  const session = sessionForEvent(event);
  const hub = hubOwner.context();
  if (!hub) throw new Error('Agent hub is unavailable');
  const artifact = resolveGeneratedDocumentArtifact(payload, {
    hubUrl: hub.hubUrl,
    sessionId: session.sessionId,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let bytes;
  try {
    const response = await net.fetch(artifact.downloadUrl, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel?.('generated-document-http-error').catch(() => {});
      throw new Error(`Generated document request failed with HTTP ${response.status}`);
    }
    bytes = await readGeneratedDocumentResponse(response, MAX_GENERATED_DOCUMENT_BYTES);
  } finally {
    clearTimeout(timeout);
  }
  validateNativeDocumentBytes(artifact.fileName, bytes);
  const opened = await createWindow(
    launchRequest({ source: 'chat-artifact' }),
    { generatedDocument: { fileName: artifact.fileName, bytes, readOnly: artifact.readOnly } },
  );
  return Boolean(opened);
});
ipcMain.handle('desktop:pick-native-open-file', async (event, options = {}) => {
  const session = sessionForEvent(event);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('Open picker sender window is unavailable');
  const suggestedName = typeof options?.suggestedName === 'string'
    ? safeSuggestedFilename(options.suggestedName, 'document.hwp')
    : '';
  const documentId = typeof options?.documentId === 'string' ? options.documentId : '';
  const bookmarked = documentId ? nativeFiles.bookmarkPathFor(documentId) : null;
  let defaultPath;
  if (bookmarked) {
    defaultPath = suggestedName ? join(dirname(bookmarked), suggestedName) : bookmarked;
  } else if (suggestedName) {
    defaultPath = suggestedName;
  }
  const picked = await dialog.showOpenDialog(window, {
    ...(defaultPath ? { defaultPath } : {}),
    filters: [{ name: 'HWP/HWPX/HML documents and RauHWPX history', extensions: ['hwp', 'hwpx', 'hml', 'rhwpx'] }],
    properties: ['openFile'],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const result = await nativeFiles.create(session.sessionId, picked.filePaths[0]);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:pick-legacy-history-folder', async (event) => {
  const session = sessionForEvent(event);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('Legacy history import sender window is unavailable');
  const picked = await dialog.showOpenDialog(window, {
    title: 'Import legacy RauHWPX history folder',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const folderPath = picked.filePaths[0];
  if (extname(folderPath).toLowerCase() !== '.rhwpx') {
    throw new Error('Legacy history folders must use the .rhwpx extension');
  }
  const result = await nativeFiles.create(session.sessionId, folderPath);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  if (!result.descriptor.legacyPortableHistoryFolder) {
    nativeFiles.releaseHandle(session.sessionId, result.descriptor.handleId);
    throw new Error('The selected RHWPX item is a file, not a legacy history folder');
  }
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:claim-native-dropped-file', async (event, filePath) => {
  const session = sessionForEvent(event);
  const result = await nativeFiles.create(session.sessionId, filePath);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:pick-native-save-file', async (event, options = {}) => {
  const session = sessionForEvent(event);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('Save picker sender window is unavailable');
  const extension = String(options.extension ?? '').toLowerCase();
  if (!['hwp', 'hwpx', 'hml', 'rhwpx'].includes(extension)) throw new Error('Unsupported save format');
  const suggestedName = safeSuggestedFilename(
    options.suggestedName,
    `document.${extension}`,
  );
  const picked = await dialog.showSaveDialog(window, {
    defaultPath: suggestedName,
    filters: [{
      name: extension === 'rhwpx' ? 'RauHWPX history archive' : `${extension.toUpperCase()} document`,
      extensions: [extension],
    }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePath) return null;
  const filePath = extname(picked.filePath) ? picked.filePath : `${picked.filePath}.${extension}`;
  if (extname(filePath).toLowerCase() !== `.${extension}`) {
    throw new Error(`Save target must use the .${extension} extension`);
  }
  const result = await nativeFiles.createSaveTarget(session.sessionId, filePath);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:release-native-file', (event, handleId) => {
  const session = sessionForEvent(event);
  nativeFiles.releaseHandle(session.sessionId, handleId);
});
ipcMain.handle('desktop:native-file-read', (event, handleId) => {
  const session = sessionForEvent(event);
  return nativeFiles.read(session.sessionId, handleId);
});
ipcMain.handle('desktop:native-file-source-path', (event, handleId) => {
  const session = sessionForEvent(event);
  return nativeFiles.sourcePathForSender(session.sessionId, handleId);
});
ipcMain.handle('desktop:native-file-validate-save', (event, handleId, identity) => {
  const session = sessionForEvent(event);
  if (session.cloudLocked) throw new Error('The cloud agent currently owns this document');
  return nativeFiles.validateSave(session.sessionId, handleId, identity, documentLeases);
});
ipcMain.handle('desktop:native-file-write', (event, handleId, bytes, identity) => {
  const session = sessionForEvent(event);
  if (session.cloudLocked) throw new Error('The cloud agent currently owns this document');
  return nativeFiles.write(session.sessionId, handleId, bytes, identity, documentLeases);
});
ipcMain.handle('desktop:native-file-is-same', (event, firstHandleId, secondHandleId) => {
  const session = sessionForEvent(event);
  return nativeFiles.isSameEntry(session.sessionId, firstHandleId, secondHandleId);
});
ipcMain.handle('desktop:remember-native-document', async (event, documentId, handleId, digest) => {
  const session = sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) throw new Error('documentId required');
  if (typeof handleId !== 'string' || !handleId) throw new Error('handleId required');
  nativeFiles.rememberDocument(documentId, session.sessionId, handleId, digest);
  await persistNativeBookmarks();
});
ipcMain.handle('desktop:reopen-native-document', async (event, documentId) => {
  const session = sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) return null;
  const result = await nativeFiles.reopenDocument(session.sessionId, documentId);
  if (!result) return null;
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:search-nearby-native-document', async (event, documentId, options = {}) => {
  const session = sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) return [];
  return nativeFiles.searchNearby(session.sessionId, documentId, {
    basenameHint: typeof options?.basenameHint === 'string' ? options.basenameHint : '',
  });
});
ipcMain.handle('desktop:native-probe-read', (event, probeId) => {
  const session = sessionForEvent(event);
  if (typeof probeId !== 'string' || !probeId) throw new Error('probeId required');
  return nativeFiles.readProbe(session.sessionId, probeId);
});
ipcMain.handle('desktop:native-probe-claim', async (event, probeId) => {
  const session = sessionForEvent(event);
  if (typeof probeId !== 'string' || !probeId) return null;
  const result = await nativeFiles.claimProbe(session.sessionId, probeId);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    return { owned: true };
  }
  return { ...result.descriptor, saveTargetCreated: result.created };
});
ipcMain.handle('desktop:verify-native-pick', (event, documentId, handleId) => {
  const session = sessionForEvent(event);
  if (typeof documentId !== 'string' || !documentId) return false;
  if (typeof handleId !== 'string' || !handleId) return false;
  return nativeFiles.verifyPick(session.sessionId, documentId, handleId);
});
ipcMain.handle('desktop:document-reserve', (event, identity, nativeHandleId) => {
  const session = sessionForEvent(event);
  const canonicalPath = nativeHandleId
    ? nativeFiles.pathForSender(session.sessionId, nativeHandleId)
    : null;
  const result = documentLeases.reserve(session.sessionId, identity, canonicalPath);
  if (!result.ok) {
    sessions.focusSession(result.ownerSessionId);
    if (nativeHandleId && !documentLeases.leaseForSession(session.sessionId)) {
      setImmediate(() => {
        if (!session.window.isDestroyed()) session.window.destroy();
      });
    }
    return { ok: false, reason: 'owned' };
  }
  return result;
});
ipcMain.handle('desktop:document-commit', (event, reservationId) => {
  const session = sessionForEvent(event);
  documentLeases.commit(session.sessionId, reservationId);
});
ipcMain.handle('desktop:document-cancel', (event, reservationId) => {
  const session = sessionForEvent(event);
  documentLeases.cancel(session.sessionId, reservationId);
});
ipcMain.handle('desktop:document-release', (event) => {
  const session = sessionForEvent(event);
  documentLeases.releaseSession(session.sessionId);
});
ipcMain.handle('cloud:get-state', async (event, payload = {}) => {
  const session = sessionForEvent(event);
  session.cloudScope = normalizeCloudScope(payload);
  return scopedCloudSnapshot(session, null, { refresh: true });
});
ipcMain.handle('cloud:save-profile', async (event, payload) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().saveProfile(payload));
});
ipcMain.handle('cloud:test-profile', async (event, payload) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().testProfile(payload));
});
ipcMain.handle('cloud:provision', async (event, payload) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().provision(payload));
});
ipcMain.handle('cloud:pair', async (event, payload) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().pair(payload));
});
ipcMain.handle('cloud:select-server-mode', async (event, payload = {}) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().selectServerMode(payload?.mode));
});
ipcMain.handle('cloud:spawn-sandbox', async (event, payload = {}) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().spawnAppServer({
    providerId: payload?.providerId ?? null,
  }));
});
ipcMain.handle('cloud:sandbox-status', async (event) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().appServerStatus());
});
ipcMain.handle('cloud:force-quit-account', async (event) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().forceQuitAccountCloud());
});
ipcMain.handle('cloud:reconnect-link', async (event) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().reconnectCloud());
});
ipcMain.handle('cloud:recreate-link', async (event) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().recreateCloud());
});
ipcMain.handle('cloud:teardown-sandbox', async (event, payload = {}) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().teardownAppServer({
    force: payload?.force === true,
  }));
});
ipcMain.handle('cloud:takeover-sandbox', async (event) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().takeoverAppServer());
});
ipcMain.handle('cloud:account-logout', async (event) => {
  const session = sessionForEvent(event);
  return scopedCloudSnapshot(session, await requireCloudCoordinator().logoutRaucloud());
});
ipcMain.handle('cloud:transfer-intent', async (event, payload = {}) => {
  const session = sessionForEvent(event);
  const scope = normalizeCloudScope(payload);
  session.cloudScope = scope;
  if (payload.pending === true) {
    if (!session.cloudTransferIntent) {
      let settle;
      const promise = new Promise((resolve) => { settle = resolve; });
      session.cloudTransferIntent = { ...scope, promise, settle, settled: false };
    }
  } else if (session.cloudTransferIntent) {
    if (!session.cloudTransferIntent.settled) {
      session.cloudTransferIntent.settled = true;
      session.cloudTransferIntent.settle(false);
    }
    session.cloudTransferIntent = null;
  }
  return scopedCloudSnapshot(session);
});
ipcMain.handle('cloud:read-reference', async (event, payload = {}) => {
  sessionForEvent(event);
  const id = String(payload.id ?? '');
  const scope = String(payload.scope ?? '');
  const scopeId = scope === 'global' ? 'global' : String(payload.scopeId ?? '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Reference id is invalid');
  if (!['chat', 'document', 'global'].includes(scope)) throw new Error('Reference scope is invalid');
  if (!scopeId || scopeId.length > 256 || /[\u0000-\u001f\u007f]/.test(scopeId)) {
    throw new Error('Reference scope id is invalid');
  }
  const context = await sessions.contextForSender(event.sender);
  const url = new URL(context.hubUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = `/reference-files/${encodeURIComponent(id)}`;
  url.searchParams.set('scope', scope);
  url.searchParams.set('scopeId', scopeId);
  url.searchParams.set('sessionId', context.sessionId);
  const response = await net.fetch(url.toString(), {
    headers: { authorization: `Bearer ${context.hubToken}` },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Reference export failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 128 * 1024 * 1024) {
    throw new Error('Reference export exceeds 128 MiB');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 128 * 1024 * 1024) throw new Error('Reference export size is invalid');
  const expectedDigest = response.headers.get('x-content-sha256');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!expectedDigest || expectedDigest !== digest) throw new Error('Reference export failed integrity verification');
  return { bytes: new Uint8Array(bytes), sha256: digest, size: bytes.length };
});
ipcMain.handle('cloud:transfer', async (event, payload) => {
  const session = sessionForEvent(event);
  session.cloudScope = normalizeCloudScope(payload);
  if (payload?.permissionProfile !== 'unrestricted') {
    throw new Error('Cloud agents require Full access');
  }
  if (session.cloudLocked) throw new Error('This document is already owned by a cloud session');
  if (session.cloudTransferPromise) return scopedCloudSnapshot(session, await session.cloudTransferPromise);
  const lease = documentLeases.leaseForSession(session.sessionId);
  const transfer = requireCloudCoordinator().transfer(payload, {
    originSessionId: session.sessionId,
    originPath: lease?.canonicalPath ?? null,
    originDigest: nativeFiles.originDigestForSessionPath(session.sessionId, lease?.canonicalPath),
  });
  session.cloudTransferPromise = transfer;
  try {
    const snapshot = await transfer;
    const scoped = await scopedCloudSnapshot(session, snapshot);
    if (session.cloudTransferIntent && !session.cloudTransferIntent.settled) {
      session.cloudTransferIntent.settled = true;
      session.cloudTransferIntent.settle(true);
    }
    return scoped;
  } catch (error) {
    if (session.cloudTransferIntent && !session.cloudTransferIntent.settled) {
      session.cloudTransferIntent.settled = true;
      session.cloudTransferIntent.settle(false);
    }
    throw error;
  } finally {
    session.cloudTransferPromise = null;
  }
});
ipcMain.handle('cloud:command', async (event, payload) => {
  const session = sessionForEvent(event);
  const operation = await requireCloudCoordinator().command(payload);
  return scopedCloudSnapshot(session, operation);
});
ipcMain.handle('cloud:dismiss-session', async (event, payload) => {
  const session = sessionForEvent(event);
  const operation = await requireCloudCoordinator().dismissSession(payload);
  return scopedCloudSnapshot(session, operation);
});
ipcMain.handle('cloud:complete-takeover', async (event, payload) => {
  const session = sessionForEvent(event);
  const operation = await requireCloudCoordinator().completeTakeover(payload);
  return scopedCloudSnapshot(session, operation);
});
ipcMain.handle('cloud:download-result', async (event, payload) => {
  const session = sessionForEvent(event);
  const coordinator = requireCloudCoordinator();
  return coordinator.withActiveHandoff(payload.sessionId, async () => {
    const result = await coordinator.downloadResult(payload);
    const handoff = await coordinator.handoffForSession(payload?.sessionId);
    let conflict = 'none';
    if (handoff?.originPath && handoff.documentDigest) {
      try {
        const current = await readFile(handoff.originPath);
        if (createHash('sha256').update(current).digest('hex') !== (Object.hasOwn(handoff, 'originDigest') ? handoff.originDigest : handoff.documentDigest)) {
          conflict = 'external-change';
        }
      } catch {
        conflict = 'external-change';
      }
    }
    const preview = await createWindow(
      launchRequest({ source: 'cloud-result-preview' }),
      { generatedDocument: { fileName: result.fileName, bytes: result.bytes, readOnly: true } },
    );
    return {
      ...result,
      snapshot: await scopedCloudSnapshot(session, result.snapshot),
      previewOpened: Boolean(preview),
      conflict,
    };
  });
});
ipcMain.handle('cloud:download-checkpoint', async (event, payload) => {
  sessionForEvent(event);
  const sessionId = String(payload?.sessionId ?? '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw new Error('Invalid cloud session id');
  const operationId = payload?.operationId == null ? null : String(payload.operationId);
  if (operationId !== null && !/^[A-Za-z0-9._:-]{1,160}$/.test(operationId)) {
    throw new Error('Invalid cloud checkpoint operation id');
  }
  return requireCloudCoordinator().downloadCheckpoint({ sessionId, operationId });
});
ipcMain.handle('cloud:publish-checkpoint', async (event, payload) => {
  const session = sessionForEvent(event);
  const sessionId = String(payload?.sessionId ?? '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw new Error('Invalid cloud session id');
  const operationId = payload?.operationId == null ? null : String(payload.operationId);
  if (operationId !== null && !/^[A-Za-z0-9._:-]{1,160}$/.test(operationId)) {
    throw new Error('Invalid cloud checkpoint operation id');
  }
  const coordinator = requireCloudCoordinator();
  return coordinator.withActiveHandoff(sessionId, async (handoff) => {
    const lease = documentLeases.leaseForSession(session.sessionId);
    if (!handoff || !lease || lease.identity.documentId !== handoff.originDocumentId
      || lease.canonicalPath !== handoff.originPath) {
      throw new Error('Open the origin document on its origin device before publishing it');
    }
    return coordinator.publishCheckpoint({ sessionId, operationId });
  });
});
ipcMain.handle('cloud:display-open', async (event, payload = {}) => {
  sessionForEvent(event);
  const sessionId = String(payload?.sessionId ?? '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw new Error('Invalid cloud session id');
  const sender = event.sender;
  return cloudDisplayConnections.open(sender.id, sessionId, (displayEvent, connectionId) => {
    if (!sender.isDestroyed()) sender.send('cloud:display-event', { connectionId, event: displayEvent });
  });
});
ipcMain.handle('cloud:display-close', async (event, payload = {}) => {
  sessionForEvent(event);
  const connectionId = typeof payload?.connectionId === 'string' ? payload.connectionId : '';
  if (!connectionId) return false;
  return cloudDisplayConnections.close(event.sender.id, connectionId);
});
ipcMain.handle('cloud:display-input', async (event, payload = {}) => {
  sessionForEvent(event);
  const connectionId = typeof payload?.connectionId === 'string' ? payload.connectionId : '';
  if (!connectionId) throw new Error('Invalid cloud display connection id');
  return cloudDisplayConnections.sendInput(event.sender.id, connectionId, payload.event);
});
ipcMain.handle('cloud:resolve-result', async (event, payload = {}) => {
  const session = sessionForEvent(event);
  const coordinator = requireCloudCoordinator();
  return coordinator.withActiveHandoff(payload.sessionId, async (handoff) => {
    if (!handoff?.recoveryPath || !handoff.resultDigest) throw new Error('Verified cloud recovery is unavailable');
    const action = String(payload.action ?? '');
    if (action === 'replace') {
      const lease = documentLeases.leaseForSession(session.sessionId);
      if (
        !lease
        || lease.identity.documentId !== handoff.originDocumentId
        || lease.canonicalPath !== handoff.originPath
      ) {
        throw new Error('Open the origin document on its origin device before replacing it');
      }
    }
    if (action === 'replace' || action === 'keep-both') {
      const recoveryBytes = await readFile(handoff.recoveryPath);
      validateNativeDocumentBytes(handoff.originPath || handoff.recoveryPath, recoveryBytes);
    }
    const resolution = await applyCloudRecovery({
      recoveryPath: handoff.recoveryPath,
      resultDigest: handoff.resultDigest,
      originalPath: handoff.originPath,
      originalDigest: Object.hasOwn(handoff, 'originDigest') ? handoff.originDigest : handoff.documentDigest,
      action,
      resolutionId: handoff.id,
    });
    for (const candidate of sessions.windows()) {
      const candidateSession = sessions.sessionForSender(candidate.webContents);
      const lease = documentLeases.leaseForSession(candidateSession.sessionId);
      if (lease?.identity.documentId === handoff.originDocumentId) candidateSession.cloudLocked = false;
    }
    const snapshot = await scopedCloudSnapshot(session, await coordinator.recordResolution(handoff.id, resolution));
    return {
      ...resolution,
      conflict: resolution.conflict ? 'external-change' : 'none',
      preservedCopyName: resolution.action === 'keep-both' && resolution.path
        ? basename(resolution.path)
        : null,
      snapshot,
    };
  });
});
ipcMain.handle('window:is-fullscreen', (event) => sessionForEvent(event).window.isFullScreen());
ipcMain.handle('desktop:close-response', async (event, requestId, allowClose) => {
  const session = sessionForEvent(event);
  if (session.pendingCloseRequestId !== requestId) return false;
  session.pendingCloseRequestId = null;
  if (!allowClose) {
    quitRequested = false;
    return false;
  }
  if (session.cloudTransferPromise) {
    let timer;
    try {
      await Promise.race([
        session.cloudTransferPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Cloud transfer close wait timed out')), CLOUD_CLOSE_WAIT_MS);
        }),
      ]);
    } catch {
      quitRequested = false;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  if (session.cloudTransferIntent) {
    let timer;
    const result = await Promise.race([
      session.cloudTransferIntent.promise.then((completed) => ({ completed })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ completed: false, timeout: true }), CLOUD_CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (result.timeout && session.cloudTransferIntent && !session.cloudTransferIntent.settled) {
      session.cloudTransferIntent.settled = true;
      session.cloudTransferIntent.settle(false);
      session.cloudTransferIntent = null;
    }
    if (!result.completed) {
      quitRequested = false;
      return false;
    }
  }
  await persistNativeBookmarks();
  session.allowCloseOnce = true;
  session.window.close();
  return true;
});
ipcMain.handle('agent-hub:ensure', async (event) => {
  sessionForEvent(event);
  if (quitting) return { started: false, ready: false };
  const result = await hubOwner.ensure();
  return { started: result.started, ready: result.ready };
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('before-quit', () => {
    quitRequested = true;
  });

  app.on('second-instance', (_event, argv, workingDirectory) => {
    queueLaunch(launchRequest({ argv, cwd: workingDirectory, source: 'second-instance' }));
  });

  app.on('open-file', (event, path) => {
    event.preventDefault();
    const request = launchRequest({ openFiles: [path], source: 'open-file' });
    const initial = pendingLaunches[0];
    if (!desktopReady && pendingLaunches.length === 1 && initial.source === 'initial' && initial.openFiles.length === 0) {
      pendingLaunches[0] = request;
      return;
    }
    queueLaunch(request);
  });

  app.whenReady().then(async () => {
    const owner = { launchId, profileId: userDataProfileId, pid: process.pid };
    await Promise.all([
      writeLaunchOwnerMetadata(runtimeDir, owner),
      writeLaunchOwnerMetadata(workDir, owner),
    ]);
    await Promise.all([
      bestEffortStartupCleanup(
        'stale runtime',
        removeStaleLaunchDirectories(runtimeRoot, launchId, {
          expectedProfileId: userDataProfileId,
        }),
      ),
      bestEffortStartupCleanup(
        'stale launch workspace',
        removeStaleLaunchDirectories(workRoot, launchId, {
          expectedProfileId: userDataProfileId,
        }),
      ),
      bestEffortStartupCleanup(
        'legacy runtime',
        removeLegacyLaunchDirectories(legacyRuntimeRoot, launchId),
      ),
      bestEffortStartupCleanup(
        'legacy launch workspace',
        removeLegacyLaunchDirectories(legacyWorkRoot, launchId),
      ),
      ...(devUrl ? [bestEffortStartupCleanup(
        'development browser cache',
        prepareDevelopmentCaches(
          electronSession.defaultSession,
          join(runtimeDir, 'code-cache'),
        ),
      )] : []),
    ]);
    secretVault = createSecretVault({
      filePath: join(app.getPath('userData'), 'secrets.json'),
      safeStorage,
    });
    cloudAccountSession = createAccountSession({
      secretStore: secretVault,
      creditsClient: createRauCreditsClient({
        baseUrl: raucloudBrokerUrl(),
        fetchImpl: (...args) => net.fetch(...args),
        // Per-operation deadlines are owned by the Cloud broker and abort this request.
        timeoutMs: 4 * 60_000 + 30_000,
      }),
    });
    const knownHostsPath = join(app.getPath('userData'), 'cloud', 'ssh-known-hosts');
    cloudTransport = new CloudApiTransport({
      tunnelManager: new SshTunnelManager({ knownHostsPath }),
    });
    const cloudClient = new CloudClient({
      vault: secretVault,
      fetchImpl: (...args) => net.fetch(...args),
      transport: cloudTransport,
    });
    cloudCoordinator = new CloudCoordinator({
      client: cloudClient,
      store: new CloudHandoffStore({
        filePath: join(app.getPath('userData'), 'cloud', 'handoffs.json'),
      }),
      provisioner: new CloudProvisioner({
        installerPath: unpackedPath(join(__dirname, '..', 'cloud', 'install', 'install.sh')),
        bootstrapDir: unpackedPath(join(__dirname, '..', 'cloud', 'release')),
        appVersion: app.getVersion(),
        knownHostsPath,
      }),
      recoveryDir: join(app.getPath('userData'), 'cloud', 'recovery'),
      appServers: [createRaucloudBrokerProvider({
        authorizeOwnedBackend: (request, options) => (
          cloudAccountSession.authorizeOwnedBackend(request, options)
        ),
        getDeviceIdentity: raucloudDeviceIdentity,
      })],
      collectProviderAuth: (provider) => collectProviderAuth(provider, {
        vault: secretVault,
        homeDir: homedir(),
      }),
      collectImportedAuth: (provider) => collectImportedProviderAuth(provider, {
        homeDir: homedir(),
        env: process.env,
        readSecret: (key) => secretVault.get(key),
        readFileImpl: readFile,
      }),
    });
    cloudCoordinator.on('event', queueCloudBroadcast);
    await cloudCoordinator.start();
    configureAutoUpdater();
    await loadNativeBookmarks();
    installMenu();
    if (!devUrl) installStudioProtocol({ protocol, net, root: studioDist() });
    await hubOwner.ensure();
    desktopReady = true;
    const launches = pendingLaunches.splice(0);
    let failedLaunches = 0;
    for (const request of launches) {
      // One unreadable file must not abort the other startup launches.
      await openLaunch(request).catch((error) => {
        failedLaunches += 1;
        showLaunchError(error);
      });
    }
    if (failedLaunches > 0 && sessions.windows().length === 0) {
      resolveUniqueInstallSync();
      app.quit();
      return;
    }
    void finishUniqueInstallMetric();
    if (app.isPackaged && ['darwin', 'linux'].includes(process.platform)) {
      setTimeout(() => {
        void checkForAppUpdates({ manual: false });
      }, 4000);
    }
  }).catch((error) => {
    resolveUniqueInstallSync();
    showLaunchError(error);
    app.quit();
  });

  app.on('activate', () => {
    const windows = sessions.windows();
    if (windows.length === 0) {
      queueLaunch(launchRequest({ source: 'activate' }));
      return;
    }
    const window = windows.at(-1);
    if (window?.isMinimized()) window.restore();
    window?.focus();
    void hubOwner.ensure();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let teardownStarted = false;
  let teardownFinished = false;
  app.on('will-quit', (event) => {
    if (teardownFinished) return;
    event.preventDefault();
    if (teardownStarted) return;
    teardownStarted = true;
    quitting = true;
    void Promise.allSettled([
      cloudDisplayConnections.closeAll(),
      cloudCoordinator?.stop(),
      hubOwner.teardown().catch((error) => {
        console.warn('[rauhwpx] agent hub teardown did not finish:', error);
      }),
    ]).then(() => cloudTransport?.stop()).finally(() => {
      teardownFinished = true;
      app.exit(0);
    });
  });
}
