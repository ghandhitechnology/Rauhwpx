import spawn from 'cross-spawn';

const activeTerminations = new WeakMap();

/** Spawn options that make one owned CLI and all of its descendants killable as a unit. */
export function processTreeSpawnOptions(platform = process.platform) {
  return {
    detached: platform !== 'win32',
    windowsHide: true,
  };
}

/** Build an owned-child environment without losing the caller's dynamic settings. */
export function isolatedProcessEnv(opts = {}, sourceEnv = process.env) {
  const env = { ...sourceEnv };
  if (opts.isolatedHome) {
    env.HOME = String(opts.isolatedHome);
    env.USERPROFILE = String(opts.isolatedHome);
  }
  if (opts.sessionId !== undefined && opts.sessionId !== null && String(opts.sessionId)) {
    env.RHWP_SESSION_ID = String(opts.sessionId);
  }
  return env;
}

function validPid(child) {
  const pid = Number(child?.pid);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function ignoreSpawnError(proc) {
  proc?.once?.('error', () => {});
}

/** Wait until an owned child has exited, bounded beyond TERM→KILL escalation. */
export function waitForProcessTreeExit(child, {
  timeoutMs = 4_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimer(() => finish(false), timeoutMs);
    timer?.unref?.();
    child.once?.('exit', onExit);
    child.once?.('close', onExit);
  });
}

/**
 * Terminate an owned process tree. POSIX children must have been spawned with
 * processTreeSpawnOptions(), which gives them a process group whose id is the
 * leader pid. Windows uses taskkill directly with an argv array and no shell.
 */
export function terminateProcessTree(child, {
  platform = process.platform,
  graceMs = 3_000,
  killProcess = process.kill,
  spawnProcess = spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return null;
  const active = activeTerminations.get(child);
  if (active) return active;

  const pid = validPid(child);
  const signal = (name) => {
    if (child.exitCode != null || child.signalCode != null) return;
    if (pid === null) {
      try { child.kill?.(name); } catch {}
      return;
    }
    if (platform === 'win32') {
      const args = ['/PID', String(pid), '/T', ...(name === 'SIGKILL' ? ['/F'] : [])];
      try {
        ignoreSpawnError(spawnProcess('taskkill', args, {
          detached: false,
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        }));
      } catch {}
      return;
    }
    try { killProcess(-pid, name); } catch {}
  };

  let timer;
  const clearEscalation = () => {
    if (timer) clearTimer(timer);
    activeTerminations.delete(child);
  };
  child.once?.('exit', clearEscalation);
  child.once?.('close', clearEscalation);

  signal('SIGTERM');
  timer = setTimer(() => {
    child.off?.('exit', clearEscalation);
    child.off?.('close', clearEscalation);
    signal('SIGKILL');
    activeTerminations.delete(child);
  }, graceMs);
  timer?.unref?.();
  activeTerminations.set(child, timer);
  return timer;
}
