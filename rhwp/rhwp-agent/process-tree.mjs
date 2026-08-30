import spawn from 'cross-spawn';

const activeTerminations = new WeakMap();
const completedTerminations = new WeakMap();

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

function posixProcessGroupAlive(pid, killProcess) {
  try {
    killProcess(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function waitForActiveTermination(child) {
  const active = activeTerminations.get(child);
  if (active) return active.completion;
  if (completedTerminations.has(child)) {
    return Promise.resolve(completedTerminations.get(child));
  }
  return Promise.resolve(true);
}

/** Wait until an owned child has exited, bounded beyond TERM→KILL escalation. */
export function waitForProcessTreeExit(child, {
  timeoutMs = 4_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  terminateProcess = terminateProcessTree,
} = {}) {
  if (!child) return Promise.resolve(true);
  if (child.exitCode != null || child.signalCode != null) {
    if (!activeTerminations.has(child) && !completedTerminations.has(child) && validPid(child) !== null) {
      // `exit` can precede `close` while descendants still own the pipes. The
      // leader's numeric exit code is therefore not proof that its group/tree
      // is gone; begin the same bounded cleanup a live leader would receive.
      try { terminateProcess(child); } catch {}
    }
    return waitForActiveTermination(child);
  }
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
    const onExit = () => {
      // terminateProcessTree is commonly called immediately after this waiter
      // is created. Defer the lookup so even a synchronous fake exit observes
      // the termination state registered by that call.
      queueMicrotask(() => {
        void waitForActiveTermination(child).then(finish);
      });
    };
    const timer = setTimer(() => finish(false), timeoutMs);
    child.once?.('exit', onExit);
    child.once?.('close', onExit);
  });
}

/**
 * Start tree termination and wait for both the termination command and the
 * bounded tree-exit proof. The waiter is installed first for live children so
 * synchronous test doubles and fast processes cannot lose their exit event.
 *
 * @param {any} child
 * @param {{
 *   timeoutMs?: number,
 *   terminateProcess?: (child: any, options?: any) => any,
 *   terminateOptions?: any,
 * }} [options]
 * @returns {Promise<boolean>}
 */
export async function terminateAndWaitForProcessTreeExit(child, {
  timeoutMs = 4_000,
  terminateProcess = terminateProcessTree,
  terminateOptions,
} = {}) {
  if (!child) return true;
  // Let callers publish the returned promise before termination can emit a
  // synchronous fake `exit`/`close` event and re-enter their cleanup handler.
  await Promise.resolve();

  /** @type {Promise<any> | null} */
  let termination = null;
  const startTermination = () => {
    if (termination) return termination;
    try {
      termination = Promise.resolve(terminateProcess(child, terminateOptions));
    } catch {
      termination = Promise.resolve(false);
    }
    return termination;
  };

  const exited = waitForProcessTreeExit(child, {
    timeoutMs,
    terminateProcess: startTermination,
  });
  startTermination();
  const [terminationResult, exitResult] = await Promise.all([termination, exited]);
  return terminationResult !== false && exitResult;
}

/**
 * Terminate an owned process tree. POSIX children must have been spawned with
 * processTreeSpawnOptions(), which gives them a process group whose id is the
 * leader pid. Windows uses taskkill directly with an argv array and no shell.
 * @param {any} child
 * @param {{
 *   platform?: NodeJS.Platform,
 *   graceMs?: number,
 *   finalGraceMs?: number,
 *   killProcess?: typeof process.kill,
 *   spawnProcess?: typeof spawn,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 *   processGroupAlive?: (() => boolean),
 * }} [options]
 */
export function terminateProcessTree(child, {
  platform = process.platform,
  graceMs = 3_000,
  finalGraceMs = 500,
  killProcess = process.kill,
  spawnProcess = spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  processGroupAlive,
} = {}) {
  if (!child) return null;
  const active = activeTerminations.get(child);
  if (active) return active.completion;
  if (completedTerminations.has(child)) {
    return Promise.resolve(completedTerminations.get(child));
  }

  const pid = validPid(child);
  if (platform === 'win32' && pid !== null
    && (child.exitCode != null || child.signalCode != null)) {
    // Windows does not retain a killable tree identity after the leader has
    // exited. Calling taskkill with this numeric pid can either report
    // process-not-found while descendants survive or target a reused pid.
    // Callers that need a positive proof must start cleanup while their owned
    // leader is still alive (the structured copy-layout runner does this).
    completedTerminations.set(child, false);
    return Promise.resolve(false);
  }
  if (pid === null && (child.exitCode != null || child.signalCode != null)) return null;
  const signal = (name) => {
    if (pid === null) {
      if (child.exitCode != null || child.signalCode != null) return;
      try { child.kill?.(name); } catch {}
      return;
    }
    if (platform === 'win32') {
      const args = ['/PID', String(pid), '/T', ...(name === 'SIGKILL' ? ['/F'] : [])];
      try {
        return spawnProcess('taskkill', args, {
          detached: false,
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        return null;
      }
    }
    try {
      killProcess(-pid, name);
      return true;
    } catch {
      return false;
    }
  };

  /** @type {(cleaned: boolean) => void} */
  let resolveCompletion = () => {};
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  /** @type {{ completion: Promise<boolean>, finished: boolean, timer: ReturnType<typeof setTimeout> | null }} */
  const state = {
    completion,
    finished: false,
    timer: null,
  };
  const finish = (cleaned) => {
    if (state.finished) return;
    state.finished = true;
    if (state.timer) clearTimer(state.timer);
    activeTerminations.delete(child);
    completedTerminations.set(child, cleaned);
    resolveCompletion(cleaned);
  };
  activeTerminations.set(child, state);

  // Without a stable tree identity, leader exit is the only safe point to
  // cancel escalation. Owned POSIX groups and Windows trees can retain live
  // descendants after the leader exits, so their force step must still run.
  if (pid === null) {
    child.once?.('exit', () => finish(true));
    child.once?.('close', () => finish(true));
  }

  let initialTaskkillSucceeded = false;
  let forceTaskkillSucceeded = false;
  let leaderExited = child.exitCode != null || child.signalCode != null;
  const groupAlive = () => {
    try {
      return (processGroupAlive
        ?? (() => posixProcessGroupAlive(pid, killProcess)))();
    } catch {
      // A failed liveness probe cannot prove the descendant group is gone.
      return true;
    }
  };
  const noteLeaderExit = () => {
    leaderExited = true;
    if (pid === null) {
      finish(true);
    } else if (platform !== 'win32') {
      if (!groupAlive()) finish(true);
    } else if (initialTaskkillSucceeded || forceTaskkillSucceeded) {
      finish(true);
    }
  };
  if (pid !== null) {
    child.once?.('exit', noteLeaderExit);
    child.once?.('close', noteLeaderExit);
  }
  const watchTaskkill = (proc, onResult) => {
    if (!proc?.once) {
      onResult(false);
      return;
    }
    let commandSettled = false;
    const commandFinished = (succeeded) => {
      if (commandSettled) return;
      commandSettled = true;
      onResult(succeeded);
    };
    proc.once('error', () => commandFinished(false));
    proc.once('exit', (code) => commandFinished(code === 0));
    proc.once('close', (code) => commandFinished(code === 0));
  };

  const initialSignal = signal('SIGTERM');
  if (platform === 'win32') {
    watchTaskkill(initialSignal, (succeeded) => {
      initialTaskkillSucceeded ||= succeeded;
      if (leaderExited && initialTaskkillSucceeded) finish(true);
    });
  } else if (pid !== null && leaderExited && !groupAlive()) {
    finish(true);
    return completion;
  }

  if (state.finished) return completion;
  state.timer = setTimer(() => {
    if (pid === null) {
      signal('SIGKILL');
      finish(child.exitCode != null || child.signalCode != null);
      return;
    }

    if (platform !== 'win32') {
      const shouldEscalate = groupAlive();
      if (!shouldEscalate) {
        finish(true);
        return;
      }
      signal('SIGKILL');
      state.timer = setTimer(() => {
        finish(!groupAlive());
      }, finalGraceMs);
      return;
    }

    const forcedTaskkill = signal('SIGKILL');
    watchTaskkill(forcedTaskkill, (succeeded) => {
      forceTaskkillSucceeded ||= succeeded;
      if (leaderExited && (initialTaskkillSucceeded || forceTaskkillSucceeded)) finish(true);
    });
    if (!state.finished) {
      state.timer = setTimer(
        () => finish(leaderExited && (initialTaskkillSucceeded || forceTaskkillSucceeded)),
        finalGraceMs,
      );
    }
  }, graceMs);
  return completion;
}
