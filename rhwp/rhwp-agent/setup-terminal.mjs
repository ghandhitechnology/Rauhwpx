import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { terminateAndWaitForProcessTreeExit } from './process-tree.mjs';

const require = createRequire(import.meta.url);
const failure = (code, message) => Object.assign(new Error(message), { code });

/** A fixed login command, never a shell. Input/output belongs to its owning auth run. */
export function createSetupTerminal({ command, argv, env, cwd, onOutput, signal,
  timeoutMs = 10 * 60_000, spawnPty = (...args) => require('node-pty').spawn(...args),
  terminate = terminateAndWaitForProcessTreeExit,
}) {
  if (signal?.aborted) throw failure('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.');
  let terminal;
  try {
    const launch = process.platform === 'win32'
      ? require('cross-spawn/lib/parse')(command, argv, { env })
      : { command, args: argv, options: {} };
    const args = launch.options.windowsVerbatimArguments ? launch.args.join(' ') : launch.args;
    terminal = spawnPty(launch.command, args, { name: 'xterm-256color', cols: 80, rows: 18, cwd,
      env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')) });
  } catch {
    throw failure('AGENT_AUTH_TERMINAL_UNAVAILABLE', '로그인 창을 열지 못했어요. API 키로 연결해 주세요.');
  }
  const child = new EventEmitter();
  child.pid = terminal.pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => terminal.kill(signal);
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  let rejectCleanup;
  const cleanupFailed = new Promise((_, reject) => { rejectCleanup = reject; });
  let cancelPromise;
  let stopped = false;
  let outputBytes = 0;
  let snapshot = ''; 
  let failureReason = null;
  const cancel = (reason = failure('AGENT_AUTH_CANCELLED', '로그인을 취소했어요.')) => {
    if (cancelPromise) return cancelPromise;
    failureReason = reason;
    cancelPromise = terminate(child).then(cleaned => {
      if (!cleaned) throw Object.assign(failure('AGENT_SETUP_CLEANUP_UNCERTAIN', '로그인 종료를 확인하지 못했어요. 앱을 다시 시작해 주세요.'), { processCleanupUncertain: true });
      return true;
    }).catch(error => { rejectCleanup(error); throw error; });
    return cancelPromise;
  };
  const abort = () => { void cancel().catch(() => {}); };
  const outputSubscription = terminal.onData(data => {
    if (stopped || failureReason) return;
    outputBytes += Buffer.byteLength(data);
    snapshot = (snapshot + data).slice(-65536);
    if (outputBytes > 2 * 1024 * 1024) {
      void cancel(failure('AGENT_AUTH_OUTPUT_LIMIT', '로그인 출력이 너무 많아요. 다시 시도하거나 API 키로 연결해 주세요.')).catch(() => {});
      return;
    }
    for (let i = 0; i < data.length; i += 8192) onOutput(data.slice(i, i + 8192));
  });
  const exitSubscription = terminal.onExit(({ exitCode, signal }) => {
    stopped = true;
    child.exitCode = exitCode;
    child.signalCode = signal ?? null;
    child.emit('exit', exitCode, signal);
    child.emit('close', exitCode, signal);
    resolveExit(exitCode);
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => {
    void cancel(failure('AGENT_AUTH_TIMEOUT', '로그인 시간이 만료됐어요. 다시 시도해 주세요.')).catch(() => {});
  }, timeoutMs);
  const done = (async () => {
    try {
      const code = await Promise.race([exited, cleanupFailed]);
      if (cancelPromise) await cancelPromise;
      if (failureReason) throw failureReason;
      return { code, stdout: '', stderr: '' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      outputSubscription.dispose();
      exitSubscription.dispose();
    }
  })();
  return {
    done, cancel,
    snapshot: () => snapshot,
    write(data) {
      if (stopped || failureReason || typeof data !== 'string' || Buffer.byteLength(data) > 4096) return;
      terminal.write(data);
    },
    resize(cols, rows) {
      if (stopped || failureReason || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
      terminal.resize(Math.max(20, Math.min(240, cols)), Math.max(4, Math.min(80, rows)));
    },
  };
}
