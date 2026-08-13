/**
 * Vite dev middleware that starts rhwp-agent next to the studio.
 *
 * Studio in the browser cannot spawn Node. Without this, `npm run dev` shows a
 * permanent hub-disconnected banner unless the hub is already running
 * (`npm start` at the repo root starts it in the background).
 * `/__rhwp/ensure-agent-hub` lets the "지금 다시 연결" button restart a dead hub.
 */
import { resolve } from 'node:path';
import {
  ensureAgentHub,
  isHubHealthy,
  spawnHubProcess,
  stopHubChild,
} from '../../desktop/agent-hub.mjs';

const DEFAULT_PORT = 5175;
export const AGENT_HUB_ENSURE_PATH = '/__rhwp/ensure-agent-hub';

function skipAutoStart() {
  if (process.env.RHWP_SKIP_AGENT_HUB === '1') return true;
  const custom = process.env.VITE_RHWP_AGENT_URL ?? '';
  if (!custom) return false;
  return !/127\.0\.0\.1:5175|localhost:5175/.test(custom);
}

export function rhwpAgentHubPlugin(studioRoot = process.cwd()) {
  let child = null;
  let ensuring = null;
  const port = Number(process.env.RHWP_AGENT_PORT ?? DEFAULT_PORT);
  const script = resolve(studioRoot, '..', 'rhwp-agent', 'server.mjs');
  const cwd = resolve(studioRoot, '..', 'rhwp-agent');

  function startHub() {
    if (child) return true;
    const spawned = spawnHubProcess({
      command: process.execPath,
      args: [script],
      cwd,
      env: { ...process.env, RHWP_AGENT_PORT: String(port) },
    }, {
      onExit: (code, signal) => {
        console.warn(`[rhwp-agent] hub exited (${code ?? signal ?? 'unknown'})`);
        if (child === spawned) child = null;
      },
    });
    child = spawned;
    return true;
  }

  function stopHub() {
    const current = child;
    child = null;
    return stopHubChild(current);
  }

  function ensureHub({ restartUnhealthy = false } = {}) {
    if (ensuring) return ensuring;
    ensuring = ensureAgentHub({
      port,
      processAlive: Boolean(child),
      restartUnhealthy,
      stop: stopHub,
      start: startHub,
      log: console,
    }).finally(() => {
      ensuring = null;
    });
    return ensuring;
  }

  return {
    name: 'rhwp-agent-hub',
    apply: 'serve',
    async configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url !== AGENT_HUB_ENSURE_PATH) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const result = skipAutoStart()
            ? { started: false, ready: await isHubHealthy(port) }
            : await ensureHub({ restartUnhealthy: true });
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ started: false, ready: false, error: String(error) }));
        }
      });

      if (skipAutoStart()) return;
      const already = await isHubHealthy(port);
      if (already) {
        console.log(`[rhwp-agent] hub already running on 127.0.0.1:${port}`);
        return;
      }
      startHub();
      console.log(`[rhwp-agent] starting hub with node ${script}`);
      server.httpServer?.once('close', () => {
        void stopHub();
      });
    },
  };
}
