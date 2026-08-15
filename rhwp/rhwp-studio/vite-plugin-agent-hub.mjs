import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createHubToken,
  isHubHealthy,
  issueHubSessionToken,
  requestHubShutdown,
  spawnHubProcess,
  stopHubChild,
  waitForHub,
  waitForHubChildExit,
  waitForHubReadyLine,
} from '../../desktop/agent-hub.mjs';

export const AGENT_HUB_ENSURE_PATH = '/__rhwp/ensure-agent-hub';

function explicitHubConfig() {
  const hubUrl = process.env.VITE_RHWP_AGENT_URL;
  if (!hubUrl) return null;
  const url = new URL(hubUrl);
  const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
  return {
    hubUrl: hubUrl.replace(/\/$/, ''),
    hubToken: process.env.VITE_RHWP_AGENT_TOKEN ?? process.env.RHWP_AGENT_TOKEN ?? 'dev',
    launchId: process.env.RHWP_LAUNCH_ID ?? 'external-dev-hub',
    port,
  };
}

export function rhwpAgentHubPlugin(studioRoot = process.cwd()) {
  const requestedPort = Number(process.env.RHWP_AGENT_PORT ?? 0);
  const external = explicitHubConfig() ?? (process.env.RHWP_SKIP_AGENT_HUB === '1' ? {
    hubUrl: `ws://127.0.0.1:${requestedPort || 5175}`,
    hubToken: process.env.RHWP_AGENT_TOKEN ?? 'dev',
    launchId: process.env.RHWP_LAUNCH_ID ?? 'external-dev-hub',
    port: requestedPort || 5175,
  } : null);
  const skipOwnedHub = external !== null;
  const token = external?.hubToken ?? process.env.RHWP_AGENT_TOKEN ?? createHubToken();
  const launchId = external?.launchId ?? randomUUID();
  const script = resolve(studioRoot, '..', 'rhwp-agent', 'server.mjs');

  let child = null;
  let context = external;
  let ensuring = null;
  let workRoot = null;

  function publicContext(started, ready) {
    return {
      started,
      ready,
      ...(context ? {
        hubUrl: context.hubUrl,
        hubToken: context.hubToken,
        launchId: context.launchId,
      } : {}),
    };
  }

  async function stopOwnedHub({ removeWork = false } = {}) {
    const current = child;
    const currentContext = context;
    child = null;
    context = null;
    let gracefulShutdownAccepted = false;
    if (currentContext && current) {
      try {
        await requestHubShutdown({
          port: currentContext.port,
          token,
          launchId,
          timeoutMs: 1000,
        });
        gracefulShutdownAccepted = true;
      } catch {}
    }
    const exited = gracefulShutdownAccepted
      ? await waitForHubChildExit(current, { timeoutMs: 3000 })
      : false;
    if (!exited) await stopHubChild(current, { timeoutMs: 3000 });
    if (removeWork && workRoot) {
      rmSync(workRoot, { recursive: true, force: true });
      workRoot = null;
    }
  }

  async function startOwnedHub() {
    if (child && context && await isHubHealthy(context.port, {
      token,
      expectedPid: child.pid,
      expectedLaunchId: launchId,
    })) {
      return publicContext(false, true);
    }
    if (child) await stopOwnedHub({ removeWork: true });

    workRoot = mkdtempSync(join(tmpdir(), 'rauhwpx-vite-hub-'));
    const spawnedWorkRoot = workRoot;
    const spawned = spawnHubProcess({
      command: process.execPath,
      args: [script],
      cwd: workRoot,
      env: {
        ...process.env,
        RHWP_AGENT_PORT: String(requestedPort),
        RHWP_AGENT_TOKEN: token,
        RHWP_AGENT_MODE: 'production',
        RHWP_LAUNCH_ID: launchId,
        RHWP_OWNER_PID: String(process.pid),
        RHWP_RUNTIME_DIR: join(workRoot, 'runtime'),
        RHWP_WORK_DIR: join(workRoot, 'work'),
        RHWP_OWN_RUNTIME_DIR: '1',
        RHWP_OWN_WORK_DIR: '1',
      },
    }, {
      onExit(code, signal) {
        console.warn(`[rhwp-agent] owned dev hub exited (${code ?? signal ?? 'unknown'})`);
        if (child === spawned) {
          child = null;
          context = null;
          rmSync(spawnedWorkRoot, { recursive: true, force: true });
          if (workRoot === spawnedWorkRoot) workRoot = null;
        }
      },
    });
    child = spawned;

    try {
      const readyLine = await waitForHubReadyLine(spawned, { launchId });
      const ready = await waitForHub(readyLine.port, {
        isHealthy: (port, options) => isHubHealthy(port, {
          ...options,
          token,
          expectedPid: spawned.pid,
          expectedLaunchId: launchId,
        }),
      });
      if (!ready) throw new Error('Owned dev hub failed its authenticated health check');
      context = {
        port: readyLine.port,
        hubUrl: `ws://127.0.0.1:${readyLine.port}`,
        hubToken: token,
        launchId,
      };
      return publicContext(true, true);
    } catch (error) {
      await stopOwnedHub({ removeWork: true });
      throw error;
    }
  }

  async function ensureHub() {
    if (ensuring) return ensuring;
    ensuring = (async () => {
      if (skipOwnedHub) {
        if (!external) return publicContext(false, false);
        const ready = await isHubHealthy(external.port, { token: external.hubToken });
        return publicContext(false, ready);
      }
      return startOwnedHub();
    })().finally(() => {
      ensuring = null;
    });
    return ensuring;
  }

  return {
    name: 'rhwp-agent-hub',
    apply: 'serve',
    config() {
      if (!external) return undefined;
      return {
        define: {
          'import.meta.env.VITE_RHWP_AGENT_URL': JSON.stringify(external.hubUrl),
          'import.meta.env.VITE_RHWP_AGENT_TOKEN': JSON.stringify(external.hubToken),
        },
      };
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== AGENT_HUB_ENSURE_PATH) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const result = await ensureHub();
          const sessionId = requestUrl.searchParams.get('sessionId');
          if (result.ready && !sessionId) throw new Error('sessionId is required');
          res.statusCode = 200;
          res.end(JSON.stringify({
            ...result,
            ...(result.ready ? { hubToken: issueHubSessionToken(token, sessionId) } : {}),
          }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ started: false, ready: false, error: String(error) }));
        }
      });

      if (!skipOwnedHub) {
        void ensureHub().then((result) => {
          if (result.ready) console.log(`[rhwp-agent] owned dev hub ready at ${result.hubUrl}`);
        }).catch((error) => {
          console.warn('[rhwp-agent] failed to start owned dev hub:', error);
        });
      }
      server.httpServer?.once('close', () => {
        void stopOwnedHub({ removeWork: true });
      });
    },
  };
}
