import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rhwpRoot = path.dirname(studioRoot);
const targetRoot = path.join(rhwpRoot, 'target');
const wasmSource = path.join(targetRoot, 'dx', 'rhwp-subsecond', 'debug', 'web', 'public', 'wasm');
const wasmTarget = path.join(targetRoot, 'rhwp-subsecond-vite');

async function syncWasm() {
  await fs.mkdir(wasmTarget, { recursive: true });
  await Promise.all([
    'rhwp-subsecond.js',
    'rhwp-subsecond_bg.wasm',
  ].map((name) => fs.copyFile(path.join(wasmSource, name), path.join(wasmTarget, name))));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}

const operation = process.argv[2];
if (operation === 'sync') {
  await syncWasm();
} else if (operation === 'serve') {
  const dx = path.join(targetRoot, 'dioxus-cli', 'bin', process.platform === 'win32' ? 'dx.exe' : 'dx');
  await run(dx, [
    'serve', '--web', '--package', 'rhwp-subsecond', '--features', 'subsecond-dev',
    '--hot-patch', '--port', '7711', '--addr', '127.0.0.1', '--open', 'false',
    '--interactive', 'false', '--inject-loading-scripts', 'false',
  ], { cwd: rhwpRoot });
} else if (operation === 'dev') {
  await syncWasm();
  const vite = path.join(studioRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  await run(process.execPath, [vite], {
    cwd: studioRoot,
    env: { ...process.env, RHWP_SUBSECOND: '1' },
  });
} else {
  throw new Error(`Unknown subsecond operation: ${String(operation)}`);
}
