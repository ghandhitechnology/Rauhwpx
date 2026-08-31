import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createHubToken,
  isHubHealthy,
  readHubHealth,
  registerHubSession,
  requestHubShutdown,
  spawnHubProcess,
  stopHubChild,
  waitForHub,
  waitForHubReadyLine,
} from '../../desktop/agent-hub.mjs';
import {
  hasPendingLaunchCleanupSync,
  retainLaunchRootForProcessCleanupSync,
} from '../rhwp-agent/credential-mirror.mjs';

export const AGENT_HUB_ENSURE_PATH = '/__rhwp/ensure-agent-hub';
const DEV_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/** Capability minting is browser-only: require the request's exact transport origin. */
export function isExactSameOriginRequest(req) {
  const originHeader = req?.headers?.origin;
  const hostHeader = req?.headers?.host;
  if (typeof originHeader !== 'string' || typeof hostHeader !== 'string'
    || !originHeader || !hostHeader) return false;
  try {
    const origin = new URL(originHeader);
    // Browser Origin headers contain only the serialized origin. Reject more
    // permissive URL spellings before comparing them to the actual Host.
    if (originHeader !== origin.origin) return false;
    const protocol = req?.socket?.encrypted === true ? 'https:' : 'http:';
    const expected = new URL(`${protocol}//${hostHeader}`);
    if (expected.username || expected.password || expected.pathname !== '/'
      || expected.search || expected.hash) return false;
    return origin.origin === expected.origin;
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

function explicitHubConfig() {
  const hubUrl = process.env.VITE_RHWP_AGENT_URL;
  if (!hubUrl) return null;
  const url = new URL(hubUrl);
  const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
  return {
    hubUrl: hubUrl.replace(/\/$/, ''),
    hubToken: process.env.RHWP_AGENT_TOKEN ?? 'dev',
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

  function removeOwnedWorkRoot(candidate) {
    if (!candidate) return;
    if (hasPendingLaunchCleanupSync(join(candidate, 'work'))) {
      console.warn(`[rhwp-agent] retaining dev hub work for pending cleanup: ${candidate}`);
      return;
    }
    rmSync(candidate, { recursive: true, force: true });
    if (workRoot === candidate) workRoot = null;
  }

  function publicContext(started, ready) {
    return {
      started,
      ready,
      ...(context ? {
        hubUrl: context.hubUrl,
        launchId: context.launchId,
      } : {}),
    };
  }

  async function stopOwnedHub({ removeWork = false } = {}) {
    const current = child;
    const currentContext = context;
    const currentWorkRoot = workRoot;
    context = null;
    let cleanupPrepared = false;
    if (currentContext && current) {
      try {
        const response = await requestHubShutdown({
          port: currentContext.port,
          token,
          launchId,
          timeoutMs: 15_000,
        });
        cleanupPrepared = response?.status === 'prepared'
          && response?.launchId === launchId;
      } catch {}
    }
    // A prepared response proves descendants were disposed. Windows can then
    // wait on the retained child handle without resolving a reusable PID.
    const stopped = await stopHubChild(current, { timeoutMs: 3000, cleanupPrepared });
    if (stopped && child === current) child = null;
    if (removeWork && currentWorkRoot && stopped) removeOwnedWorkRoot(currentWorkRoot);
    if (!stopped) {
      if (currentWorkRoot) {
        try {
          retainLaunchRootForProcessCleanupSync(join(currentWorkRoot, 'work'), { launchId });
        } catch (error) {
          console.warn(`[rhwp-agent] process cleanup retention marker failed: ${error}`);
        }
      }
      throw new Error(`Owned dev hub process tree ${current?.pid ?? 'unknown'} survived shutdown`);
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
        RHWP_OWNER_IPC: '1',
        RHWP_RUNTIME_DIR: join(workRoot, 'runtime'),
        RHWP_WORK_DIR: join(workRoot, 'work'),
        RHWP_OWN_RUNTIME_DIR: '1',
        RHWP_OWN_WORK_DIR: '1',
      },
    }, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      onExit(code, signal) {
        console.warn(`[rhwp-agent] owned dev hub exited (${code ?? signal ?? 'unknown'})`);
        if (child === spawned) {
          context = null;
        }
        // Keep the exited leader and its work root until stopOwnedHub has
        // positively cleaned its process group/task tree.
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
      try {
        await stopOwnedHub({ removeWork: true });
      } catch (cleanupError) {
        console.warn('[rhwp-agent] owned dev hub cleanup failed after startup failed:', cleanupError);
      }
      throw error;
    }
  }

  async function ensureHub() {
    if (ensuring) return ensuring;
    ensuring = (async () => {
      if (skipOwnedHub) {
        if (!external) return publicContext(false, false);
        const health = await readHubHealth(external.port, { token: external.hubToken });
        if (health?.ok === true && typeof health.launchId === 'string') {
          context = { ...external, launchId: health.launchId };
        }
        return publicContext(false, health?.ok === true);
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
      return {
        define: {
          // A hub master token must never be compiled into renderer code. The
          // ensure route exchanges it for audience-scoped capabilities.
          'import.meta.env.VITE_RHWP_AGENT_TOKEN': 'undefined',
          ...(external ? {
            'import.meta.env.VITE_RHWP_AGENT_URL': JSON.stringify(external.hubUrl),
          } : {}),
        },
      };
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        let requestUrl;
        try {
          requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        } catch {
          sendJson(res, 400, { started: false, ready: false, error: 'Malformed request target' });
          return;
        }
        if (requestUrl.pathname !== AGENT_HUB_ENSURE_PATH) {
          next();
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          sendJson(res, 405, { started: false, ready: false, error: 'POST required' });
          return;
        }
        if (!isExactSameOriginRequest(req)) {
          sendJson(res, 403, { started: false, ready: false, error: 'Same-origin request required' });
          return;
        }
        const sessionId = requestUrl.searchParams.get('sessionId');
        if (!sessionId || !DEV_SESSION_ID_PATTERN.test(sessionId)) {
          sendJson(res, 400, { started: false, ready: false, error: 'Valid sessionId is required' });
          return;
        }
        try {
          const result = await ensureHub();
          const capabilities = result.ready
            ? await registerHubSession({
              port: context.port,
              token,
              launchId: context.launchId,
              sessionId,
            })
            : null;
          sendJson(res, 200, {
            ...result,
            ...(capabilities ? {
              hubToken: capabilities.studio,
              referenceToken: capabilities.reference,
              templateToken: capabilities.template,
            } : {}),
          });
        } catch (error) {
          const status = error?.status === 429 ? 429 : 500;
          sendJson(res, status, { started: false, ready: false, error: String(error) });
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
        void stopOwnedHub({ removeWork: true }).catch((error) => {
          console.warn(`[rhwp-agent] owned dev hub cleanup remains pending: ${error}`);
        });
      });
    },
  };
}
