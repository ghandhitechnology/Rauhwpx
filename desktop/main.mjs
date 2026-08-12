import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  nativeTheme,
  shell,
  utilityProcess,
} from 'electron';
import electronUpdater from 'electron-updater';

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
const AGENT_PORT = Number(process.env.RHWP_AGENT_PORT ?? 5175);
const devUrl = process.env.RHWP_DEV_URL || '';

app.setName('Rauhwpx');

let mainWindow = null;
let studioServer = null;
let studioOrigin = '';
let agentProcess = null;

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

function startAgent() {
  const script = agentScript();
  if (!existsSync(script)) {
    console.warn('[rauhwpx] agent script missing:', script);
    return;
  }
  agentProcess = utilityProcess.fork(script, [], {
    serviceName: 'rhwp-agent',
    stdio: 'pipe',
    env: {
      ...process.env,
      RHWP_AGENT_PORT: String(AGENT_PORT),
    },
  });
  agentProcess.stdout?.on('data', (chunk) => process.stdout.write(chunk));
  agentProcess.stderr?.on('data', (chunk) => process.stderr.write(chunk));
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Rauhwpx',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => {
            if (!app.isPackaged) {
              void shell.openExternal(RELEASES_URL);
              return;
            }
            void autoUpdater.checkForUpdatesAndNotify();
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

async function createWindow() {
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#141416' : '#f5f5f7';
  const window = new BrowserWindow({
    title: 'Rauhwpx',
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const url = devUrl || studioOrigin;
  await window.loadURL(url);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
}

function stopChildren() {
  try {
    agentProcess?.kill();
  } catch {
    /* already gone */
  }
  agentProcess = null;
  studioServer?.close();
  studioServer = null;
}

app.whenReady().then(async () => {
  installMenu();
  if (!devUrl) await startStudioServer();
  startAgent();
  await createWindow();
  if (app.isPackaged) {
    void autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }
  app.on('activate', () => {
    if (!mainWindow) void createWindow();
  });
}).catch((error) => {
  dialog.showErrorBox('Rauhwpx could not open', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopChildren();
});
