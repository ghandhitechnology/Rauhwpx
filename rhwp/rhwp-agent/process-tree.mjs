import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let crossSpawn = null;

function spawn(command, argv, options) {
  crossSpawn ??= require('cross-spawn');
  return crossSpawn(command, argv, options);
}

/** Terminate a command and all of its descendants. */
export function terminateProcessTree(child, {
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  if (!child?.pid) {
    try { child?.kill?.('SIGKILL'); } catch {}
    return Promise.resolve();
  }
  if (platform !== 'win32') {
    try { child.kill('SIGKILL'); } catch {}
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const killer = spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once?.('error', () => {
        try { child.kill('SIGKILL'); } catch {}
        finish();
      });
      killer.once?.('close', finish);
      killer.once?.('exit', finish);
    } catch {
      try { child.kill('SIGKILL'); } catch {}
      finish();
    }
  });
}

