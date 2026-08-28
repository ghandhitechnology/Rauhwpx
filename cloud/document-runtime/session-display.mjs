import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_DISPLAY_WIDTH = 1280;
export const DEFAULT_DISPLAY_HEIGHT = 800;
export const DISPLAY_START_TIMEOUT_MS = 8_000;
export const DISPLAY_READY_POLL_MS = 50;

const DISPLAY_STATUSES = new Set(['starting', 'ready', 'stopped', 'error']);

function displayError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function normalizeDisplay(display) {
  const value = String(display ?? '').trim();
  if (!/^:\d{1,3}$/.test(value)) {
    throw displayError('DISPLAY_INVALID', `Session display must look like :10, got ${value || '(empty)'}`);
  }
  return value;
}

function displayNumberOf(display) {
  return Number(normalizeDisplay(display).slice(1));
}

function x11SocketPath(display) {
  return path.join(X11_UNIX_DIR, `X${displayNumberOf(display)}`);
}

const X11_UNIX_DIR = process.env.RAUHWpx_X11_UNIX_DIR || '/tmp/.X11-unix';

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function isDisplayFree(display) {
  if (await pathExists(x11SocketPath(display))) return false;
  if (await pathExists(`/tmp/.X${displayNumberOf(display)}-lock`)) return false;
  return true;
}

/**
 * Pick a free display number starting at base. Prefer :10 as the plan default.
 * @param {number} [base=10]
 */
export async function allocateDisplay(base = 10, { maxAttempts = 80 } = {}) {
  const start = Math.max(1, Number(base) || 10);
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const display = `:${start + offset}`;
    if (await isDisplayFree(display)) return display;
  }
  throw displayError('DISPLAY_EXHAUSTED', `No free X display in :${start}..:${start + maxAttempts - 1}`);
}

async function writeAuthority(authFile, display) {
  const cookie = randomBytes(16).toString('hex');
  await fs.writeFile(authFile, '', { mode: 0o600 });
  await runCommand('xauth', ['-f', authFile, 'add', `${os.hostname()}/unix${display}`, '.', cookie]);
  await runCommand('xauth', ['-f', authFile, 'add', display, '.', cookie]);
  return cookie;
}

function runCommand(command, args, { env = process.env, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(displayError('COMMAND_TIMEOUT', `${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(displayError('COMMAND_SPAWN_FAILED', `${command} failed to start`, error));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(displayError(
          'COMMAND_FAILED',
          `${command} exited ${signal ? `from ${signal}` : `with ${code}`}: ${stderr.trim() || stdout.trim() || '(no output)'}`,
        ));
      }
    });
  });
}

function waitForUnixSocket(socketPath, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection(socketPath);
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          reject(displayError('DISPLAY_SOCKET_TIMEOUT', `X socket did not appear: ${socketPath}`));
          return;
        }
        // Keep the timer referenced so start() cannot outlive the event loop.
        setTimeout(attempt, DISPLAY_READY_POLL_MS);
      });
    };
    attempt();
  });
}

async function probeDisplay(display, authFile, timeoutMs = 2_000) {
  const env = {
    ...process.env,
    DISPLAY: display,
    XAUTHORITY: authFile,
  };
  await runCommand('xdpyinfo', ['-display', display], { env, timeoutMs });
}

/**
 * One cloud session owns one virtual desktop. Status is a state machine, not flags.
 *
 *   starting → ready → stopped
 *                 ↘ error → starting   (one automatic restart)
 *
 * Display death must not kill document tools. Callers treat start failures as soft.
 */
export class SessionDisplay {
  /**
   * @param {object} options
   * @param {string} options.workspace
   * @param {number} [options.width]
   * @param {number} [options.height]
   * @param {string} [options.display] fixed display like `:10`
   * @param {number} [options.baseDisplay=10]
   * @param {typeof spawn} [options.spawnProcess]
   * @param {(event: object) => void} [options.onEvent]
   * @param {boolean} [options.startWindowManager=true]
   * @param {string} [options.xvfbBin='Xvfb']
   * @param {string} [options.windowManagerBin='matchbox-window-manager']
   */
  constructor({
    workspace,
    width = DEFAULT_DISPLAY_WIDTH,
    height = DEFAULT_DISPLAY_HEIGHT,
    display = null,
    baseDisplay = 10,
    spawnProcess = spawn,
    onEvent = () => {},
    startWindowManager = true,
    xvfbBin = 'Xvfb',
    windowManagerBin = 'matchbox-window-manager',
    startTimeoutMs = DISPLAY_START_TIMEOUT_MS,
  } = {}) {
    if (typeof workspace !== 'string' || !workspace.trim()) {
      throw displayError('WORKSPACE_REQUIRED', 'SessionDisplay requires a workspace directory');
    }
    this.workspace = workspace;
    this.width = Math.max(640, Number(width) || DEFAULT_DISPLAY_WIDTH);
    this.height = Math.max(480, Number(height) || DEFAULT_DISPLAY_HEIGHT);
    this.preferredDisplay = display ? normalizeDisplay(display) : null;
    this.baseDisplay = baseDisplay;
    this.spawnProcess = spawnProcess;
    this.onEvent = onEvent;
    this.startWindowManager = startWindowManager;
    this.xvfbBin = xvfbBin;
    this.windowManagerBin = windowManagerBin;
    this.startTimeoutMs = startTimeoutMs;

    this.status = 'stopped';
    this.display = null;
    this.pid = null;
    this.screenshotDir = path.join(workspace, 'screens');
    this.logPath = path.join(workspace, 'display.log');
    this.authFile = path.join(workspace, 'home', '.Xauthority');
    this._child = null;
    this._wm = null;
    this._restartBudget = 1;
    this._stopping = false;
    this._stderrTail = '';
    this._exitPromise = Promise.resolve();
    this.lastError = null;
  }

  get environment() {
    if (this.status !== 'ready' || !this.display) return null;
    return {
      DISPLAY: this.display,
      XAUTHORITY: this.authFile,
      RAUHWpx_SESSION_DISPLAY: 'ready',
      RAUHWpx_SCREENSHOT_DIR: this.screenshotDir,
    };
  }

  snapshot() {
    return {
      status: this.status,
      display: this.display,
      width: this.width,
      height: this.height,
      pid: this.pid,
      screenshotDir: this.screenshotDir,
      logPath: this.logPath,
      restartBudget: this._restartBudget,
      lastError: this.lastError,
    };
  }

  emit(type, extra = {}) {
    const event = {
      type,
      at: new Date().toISOString(),
      ...this.snapshot(),
      ...extra,
    };
    try {
      this.onEvent(event);
    } catch {
      // Event sinks are lossy by design.
    }
    return event;
  }

  /**
   * Start Xvfb. Failures leave status=`error` and return the snapshot so the
   * document session can continue without a screen.
   */
  async start() {
    if (this.status === 'ready') return this.snapshot();
    if (this.status === 'starting') {
      throw displayError('DISPLAY_BUSY', 'Session display is already starting');
    }
    this._stopping = false;
    this.status = 'starting';
    this.lastError = null;
    this.emit('environment.display_starting');
    try {
      await fs.mkdir(path.dirname(this.authFile), { recursive: true, mode: 0o700 });
      await fs.mkdir(this.screenshotDir, { recursive: true, mode: 0o700 });
      this.display = this.preferredDisplay ?? await allocateDisplay(this.baseDisplay);
      await writeAuthority(this.authFile, this.display);
      await this._spawnXvfb();
      await waitForUnixSocket(x11SocketPath(this.display), this.startTimeoutMs);
      await probeDisplay(this.display, this.authFile, Math.min(2_000, this.startTimeoutMs));
      if (this.startWindowManager) await this._spawnWindowManager();
      this.status = 'ready';
      this.emit('environment.display_ready');
      return this.snapshot();
    } catch (error) {
      this.lastError = String(error?.message ?? error).slice(0, 1_000);
      this.status = 'error';
      this.emit('environment.display_failed', { message: this.lastError, code: error?.code ?? null });
      await this._killChildren();
      return this.snapshot();
    }
  }

  async stop() {
    this._stopping = true;
    this._restartBudget = 0;
    await this._killChildren();
    this.pid = null;
    this.status = 'stopped';
    this.emit('environment.display_stopped');
    return this.snapshot();
  }

  /**
   * Restart once after a crash. Subsequent calls refuse until the budget is reset.
   * Returns the snapshot; status stays `error` when the budget is spent or start fails.
   */
  async restart({ reason = 'crash' } = {}) {
    if (this._stopping) return this.snapshot();
    if (this._restartBudget <= 0) {
      this.status = 'error';
      this.lastError = 'Session display restart budget exhausted';
      this.emit('environment.display_failed', { message: this.lastError, reason });
      return this.snapshot();
    }
    this._restartBudget -= 1;
    await this._killChildren();
    this.status = 'error';
    const started = await this.start();
    if (started.status === 'ready') {
      this.emit('environment.display_restarted', { reason });
    }
    return this.snapshot();
  }

  async _spawnXvfb() {
    const args = [
      this.display,
      '-screen', '0', `${this.width}x${this.height}x24`,
      '-nolisten', 'tcp',
      '-auth', this.authFile,
      '+extension', 'RANDR',
    ];
    await fs.appendFile(
      this.logPath,
      `\n[${new Date().toISOString()}] starting ${this.xvfbBin} ${args.join(' ')}\n`,
      { mode: 0o600 },
    ).catch(() => {});
    const child = this.spawnProcess(this.xvfbBin, args, {
      env: {
        ...process.env,
        DISPLAY: this.display,
        XAUTHORITY: this.authFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._child = child;
    this.pid = child.pid ?? null;
    this._stderrTail = '';
    child.stdout?.resume();
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      this._stderrTail = `${this._stderrTail}${text}`.slice(-8_000);
      fs.appendFile(this.logPath, text).catch(() => {});
    });
    this._exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        if (this._child === child) {
          this._child = null;
          this.pid = null;
        }
        resolve({ code, signal });
        if (!this._stopping && this.status === 'ready') {
          this.status = 'error';
          this.lastError = `Xvfb exited ${signal ? `from ${signal}` : `with ${code}`}`;
          this.emit('environment.display_failed', {
            message: this.lastError,
            stderrTail: this._stderrTail.slice(-500),
          });
          void this.restart({ reason: 'xvfb-exit' });
        }
      });
    });
    child.once('error', (error) => {
      this.lastError = String(error?.message ?? error);
      fs.appendFile(this.logPath, `spawn error: ${this.lastError}\n`).catch(() => {});
    });
  }

  async _spawnWindowManager() {
    try {
      const wm = this.spawnProcess(this.windowManagerBin, ['-use_titlebar', 'no'], {
        env: {
          ...process.env,
          DISPLAY: this.display,
          XAUTHORITY: this.authFile,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this._wm = wm;
      let settled = false;
      await Promise.race([
        delay(200).then(() => { settled = true; }),
        new Promise((resolve) => {
          wm.once('exit', () => resolve());
          wm.once('error', () => resolve());
        }),
      ]);
      if (!settled || wm.exitCode != null || wm.signalCode != null) {
        this._wm = null;
        await fs.appendFile(
          this.logPath,
          `window manager unavailable (${this.windowManagerBin}); continuing on raw Xvfb\n`,
        ).catch(() => {});
      }
    } catch (error) {
      this._wm = null;
      await fs.appendFile(
        this.logPath,
        `window manager spawn failed: ${error?.message ?? error}\n`,
      ).catch(() => {});
    }
  }

  async _killChildren() {
    const targets = [this._wm, this._child].filter(Boolean);
    this._wm = null;
    this._child = null;
    for (const child of targets) {
      if (child.killed || child.exitCode != null || child.signalCode != null) continue;
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    await Promise.race([
      Promise.all(targets.map((child) => new Promise((resolve) => {
        if (child.exitCode != null || child.signalCode != null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      }))),
      delay(2_000),
    ]);
    for (const child of targets) {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }
}

export function createSessionDisplay(options) {
  return new SessionDisplay(options);
}

export function isDisplayStatus(value) {
  return DISPLAY_STATUSES.has(value);
}
