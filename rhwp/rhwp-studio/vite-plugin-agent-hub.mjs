/**
 * Vite dev middleware that starts rhwp-agent next to the studio.
 *
 * Studio in the browser cannot spawn Node. Without this, `npm run dev` shows a
 * permanent hub-disconnected banner unless a second terminal runs `npm start`.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const DEFAULT_PORT = 5175;

function skipAutoStart() {
  if (process.env.RHWP_SKIP_AGENT_HUB === '1') return true;
  const custom = process.env.VITE_RHWP_AGENT_URL ?? '';
  if (!custom) return false;
  return !/127\.0\.0\.1:5175|localhost:5175/.test(custom);
}

async function hubAlreadyUp(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

export function rhwpAgentHubPlugin(studioRoot = process.cwd()) {
  let child = null;
  let spawned = false;
  const port = Number(process.env.RHWP_AGENT_PORT ?? DEFAULT_PORT);
  const script = resolve(studioRoot, '..', 'rhwp-agent', 'server.mjs');
  const cwd = resolve(studioRoot, '..', 'rhwp-agent');

  return {
    name: 'rhwp-agent-hub',
    apply: 'serve',
    async configureServer(server) {
      if (skipAutoStart()) return;
      if (await hubAlreadyUp(port)) {
        console.log(`[rhwp-agent] hub already running on 127.0.0.1:${port}`);
        return;
      }
      child = spawn(process.execPath, [script], {
        cwd,
        env: { ...process.env, RHWP_AGENT_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      spawned = true;
      child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
      child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
      child.on('exit', (code, signal) => {
        console.warn(`[rhwp-agent] hub exited (${code ?? signal ?? 'unknown'})`);
        child = null;
      });
      console.log(`[rhwp-agent] starting hub with node ${script}`);
      server.httpServer?.once('close', () => {
        if (spawned && child) {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        }
      });
    },
  };
}
