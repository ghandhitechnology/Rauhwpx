import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
} from 'electron';
import electronUpdater from 'electron-updater';
import {
  DEFAULT_HUB_PORT,
  ensureAgentHub,
  isHubHealthy,
  nextHubRestartDelay,
  resolveHubLaunch,
  spawnHubProcess,
  stopHubChild,
} from './agent-hub.mjs';

const { autoUpdater } = electronUpdater;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RELEASES_URL = 'https://github.com/ghandhitechnology/Rauhwpx/releases/latest';
const AGENT_PORT = Number(process.env.RHWP_AGENT_PORT ?? DEFAULT_HUB_PORT);
const PRELOAD_PATH = join(__dirname, 'preload.cjs');
const devUrl = process.env.RHWP_DEV_URL || '';

app.setName('Rauhwpx');

let mainWindow = null;
let studioServer = null;
let studioOrigin = '';
let agentProcess = null;
let agentChain = Promise.resolve();
let agentRestartTimer = null;
let agentRestartAttempt = 0;
let quitting = false;

function studioDist() {
  return join(__dirname, '..', 'rhwp', 'rhwp-studio', 'dist');
}

function agentScript() {
  const packed = join(__dirname, '..', 'rhwp', 'rhwp-agent', 'server.mjs');
  const unpacked = packed.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : packed;
}

function startStudioServer() {
  const root = studioDist();
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error(`Studio build is missing (${root}). Run npm run build:studio first.`);
  }
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let relative = decodeURIComponent(url.pathname);
      if (relative === '/') relative = '/index.html';
      const file = normalize(join(root, relative));
      if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': mime['.html'] });
        res.end(readFileSync(join(root, 'index.html')));
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      studioServer = server;
      studioOrigin = `http://127.0.0.1:${address.port}`;
      resolve(studioOrigin);
    });
  });
}

function clearAgentRestart() {
  if (agentRestartTimer !== null) {
    clearTimeout(agentRestartTimer);
    agentRestartTimer = null;
  }
}

function scheduleAgentRestart() {
  if (quitting || agentRestartTimer !== null) return;
  const delay = nextHubRestartDelay(agentRestartAttempt);
  agentRestartAttempt += 1;
  console.warn(`[rauhwpx] agent hub exited; restarting in ${delay}ms`);
  agentRestartTimer = setTimeout(() => {
    agentRestartTimer = null;
    void ensureAgent();
  }, delay);
}

function startAgent() {
  if (agentProcess) return true;
  const script = agentScript();
  const launch = resolveHubLaunch({
    packaged: app.isPackaged,
    execPath: process.execPath,
    scriptPath: script,
    agentDir: dirname(script),
    home: app.getPath('home'),
    extraDirs: [join(__dirname, '..', 'node_modules', '.bin')],
    env: {
      ...process.env,
      RHWP_AGENT_PORT: String(AGENT_PORT),
    },
  });
  if (!launch) {
    console.warn('[rauhwpx] agent hub launch command not found:', script);
    return false;
  }
  console.log(`[rauhwpx] starting agent hub via ${launch.via}: ${launch.command} ${launch.args.join(' ')}`);
  const child = spawnHubProcess(launch, {
    onError: (error) => {
      console.warn('[rauhwpx] agent hub spawn error:', error);
      if (agentProcess !== child) return;
      agentProcess = null;
      if (!quitting) scheduleAgentRestart();
    },
    onExit: (code, signal) => {
      console.warn('[rauhwpx] agent hub process exit:', code, signal ?? '');
      if (agentProcess !== child) return;
      agentProcess = null;
      if (!quitting) scheduleAgentRestart();
    },
  });
  agentProcess = child;
  return true;
}

function stopAgent() {
  const child = agentProcess;
  agentProcess = null;
  clearAgentRestart();
  return stopHubChild(child);
}

async function runEnsure({ restartUnhealthy = false } = {}) {
  const result = await ensureAgentHub({
    port: AGENT_PORT,
    processAlive: Boolean(agentProcess),
    restartUnhealthy,
    stop: stopAgent,
    start: startAgent,
  });
  if (result.ready) {
    agentRestartAttempt = 0;
    clearAgentRestart();
  }
  return result;
}

function ensureAgent(opts = {}) {
  const job = agentChain.then(
    () => runEnsure(opts),
    () => runEnsure(opts),
  );
  agentChain = job.then(() => undefined, () => undefined);
  return job;
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
      void autoUpdater.checkForUpdatesAndNotify();
    },
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    isMac
      ? {
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
      }
      : {
        label: 'File',
        submenu: [
          checkForUpdates,
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(isMac ? [] : [{ role: 'help', submenu: [{ role: 'about' }] }]),
  ]));
}

async function createWindow() {
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#141416' : '#f5f5f7';
  const isMac = process.platform === 'darwin';
  const window = new BrowserWindow({
    title: 'Rauhwpx',
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor,
    // macOS: hide the native title bar so the studio owns the top row. The
    // renderer reserves a matching 38px title-bar row and keeps every control
    // outside the traffic-light hit area.
    ...(isMac ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 12 },
    } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = window;
  // Let the renderer drop the traffic-light inset while in native fullscreen.
  window.on('enter-full-screen', () => {
    if (!window.isDestroyed()) window.webContents.send('window:fullscreen-changed', true);
  });
  window.on('leave-full-screen', () => {
    if (!window.isDestroyed()) window.webContents.send('window:fullscreen-changed', false);
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.warn('[rauhwpx] preload error', preloadPath, error);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const url = devUrl || studioOrigin;
  // Attach before loadURL. ready-to-show often fires during load, so a
  // listener registered afterwards leaves the hidden window stuck.
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  await window.loadURL(url);
  if (!window.isDestroyed() && !window.isVisible()) window.show();
}

function stopChildren() {
  clearAgentRestart();
  try {
    agentProcess?.kill();
  } catch {
    /* already gone */
  }
  agentProcess = null;
  studioServer?.close();
  studioServer = null;
}

ipcMain.handle('window:is-fullscreen', () => Boolean(mainWindow?.isFullScreen()));

ipcMain.handle('agent-hub:ensure', async () => {
  if (quitting) return { started: false, ready: false };
  if (await isHubHealthy(AGENT_PORT)) {
    agentRestartAttempt = 0;
    return { started: false, ready: true };
  }
  return ensureAgent({ restartUnhealthy: true });
});

app.whenReady().then(async () => {
  installMenu();
  if (!devUrl) await startStudioServer();
  // Bring the hub up before the window so the first WebSocket is not refused.
  await ensureAgent();
  await createWindow();
  if (app.isPackaged) {
    setTimeout(() => {
      void autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 4000);
  }
  app.on('activate', () => {
    if (!mainWindow) {
      void ensureAgent().then(() => createWindow());
      return;
    }
    void ensureAgent();
  });
}).catch((error) => {
  dialog.showErrorBox('Rauhwpx could not open', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  stopChildren();
});
