import { Stagehand, browserbase } from '@browserbasehq/stagehand';

import {
  browserbaseJsonResult,
  prepareBrowserbaseJsonValue,
} from './browserbase-result.mjs';

const DEFAULT_MODEL = 'google/gemini-3.5-flash-lite';
const DEFAULT_VIEWPORT = Object.freeze({ width: 1024, height: 768 });
export const BROWSERBASE_CREATE_TIMEOUT_MS = 30_000;
export const BROWSERBASE_CLEANUP_TIMEOUT_MS = 10_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanupUncertainError(cause, lateCleanup = null) {
  const detail = cause ? ` ${errorMessage(cause)}` : '';
  const error = new Error(
    `Browserbase cleanup could not be confirmed.${detail} Restart the Browserbase sidecar before retrying.`,
    cause ? { cause } : undefined,
  );
  error.code = 'BROWSERBASE_CLEANUP_UNCERTAIN';
  error.processCleanupUncertain = true;
  if (lateCleanup) error.lateCleanup = lateCleanup;
  return error;
}

export function compatibleStagehandResult(result) {
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'data')) return result;
  const data = result.data;
  const cacheStatus = result.metadata?.cache?.status;
  if ((cacheStatus === 'HIT' || cacheStatus === 'MISS')
    && data && typeof data === 'object' && !Array.isArray(data)) {
    // Stagehand extraction data is remote-controlled. Bound it before adding
    // compatibility metadata so object spread cannot duplicate an arbitrarily
    // wide result or invoke every attacker-controlled getter.
    const bounded = prepareBrowserbaseJsonValue(data);
    if (bounded && typeof bounded === 'object' && !Array.isArray(bounded)) {
      return { ...bounded, cacheStatus };
    }
    return { data: bounded, cacheStatus };
  }
  return data;
}

function withDeadline(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.code = 'BROWSERBASE_OPERATION_TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function closeSessionParts(session, timeoutMs = BROWSERBASE_CLEANUP_TIMEOUT_MS) {
  if (!session) return;
  const operations = [
    session.stagehand
      ? withDeadline(
        Promise.resolve().then(() => session.stagehand.close()),
        timeoutMs,
        'Stagehand cleanup timed out',
      )
      : null,
    session.browser
      ? withDeadline(
        Promise.resolve().then(() => session.browser.close()),
        timeoutMs,
        'Browserbase cleanup timed out',
      )
      : null,
  ].filter(Boolean);
  const settled = await Promise.allSettled(operations);
  const errors = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Stagehand and Browserbase cleanup both failed');
  }
}

function closeLateResource(rawResource, cleanup, timeoutMs) {
  return Promise.resolve(rawResource).then(
    (resource) => cleanup(resource, timeoutMs).then(() => true, () => false),
    () => true,
  );
}

export function requireBrowserbaseCredentials(env = process.env) {
  const missing = ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'GEMINI_API_KEY']
    .filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Browserbase is not configured. Set ${missing.join(', ')} in the rhwp-agent environment and restart the hub.`);
  }
  return {
    apiKey: String(env.BROWSERBASE_API_KEY),
    projectId: String(env.BROWSERBASE_PROJECT_ID),
    modelApiKey: String(env.GEMINI_API_KEY),
    modelName: String(env.BROWSERBASE_MODEL_NAME || DEFAULT_MODEL),
  };
}

export async function createStagehandSession({
  env = process.env,
  createTimeoutMs = BROWSERBASE_CREATE_TIMEOUT_MS,
  cleanupTimeoutMs = BROWSERBASE_CLEANUP_TIMEOUT_MS,
  launchBrowser = (options) => browserbase.launch(options),
  createStagehand = (options) => Stagehand.create(options),
} = {}) {
  const credentials = requireBrowserbaseCredentials(env);
  const rawLaunch = launchBrowser({
    apiKey: credentials.apiKey,
    projectId: credentials.projectId,
    keepAlive: false,
    browserSettings: {
      viewport: DEFAULT_VIEWPORT,
    },
    userMetadata: {
      mcp: 'true',
      client: 'rauhwpx',
    },
  });
  let browser;
  try {
    browser = await withDeadline(rawLaunch, createTimeoutMs, 'Browserbase launch timed out');
  } catch (error) {
    if (error?.code === 'BROWSERBASE_OPERATION_TIMEOUT') {
      const lateCleanup = closeLateResource(
        rawLaunch,
        (lateBrowser, timeoutMs) => closeSessionParts({ browser: lateBrowser }, timeoutMs),
        cleanupTimeoutMs,
      );
      throw cleanupUncertainError(error, lateCleanup);
    }
    throw error;
  }
  try {
    const rawStagehand = createStagehand({
      browser,
      model: {
        modelName: credentials.modelName,
        apiKey: credentials.modelApiKey,
      },
      logging: { level: 'off', format: 'json' },
    });
    let stagehand;
    try {
      stagehand = await withDeadline(rawStagehand, createTimeoutMs, 'Stagehand creation timed out');
    } catch (error) {
      if (error?.code === 'BROWSERBASE_OPERATION_TIMEOUT') {
        const lateCleanup = closeLateResource(
          rawStagehand,
          (lateStagehand, timeoutMs) => closeSessionParts({ stagehand: lateStagehand }, timeoutMs),
          cleanupTimeoutMs,
        );
        throw cleanupUncertainError(error, lateCleanup);
      }
      throw error;
    }
    return { browser, stagehand };
  } catch (error) {
    try {
      await closeSessionParts({ browser }, cleanupTimeoutMs);
    } catch (cleanupError) {
      throw cleanupUncertainError(
        new AggregateError(
          [error, cleanupError],
          'Stagehand startup failed and the Browserbase session could not be released',
          { cause: error },
        ),
        error?.lateCleanup ?? null,
      );
    }
    throw error;
  }
}

/** One remote browser session owned by the stdio sidecar. */
export class BrowserbaseSidecarRuntime {
  /** @param {{env?: NodeJS.ProcessEnv, createSession?: () => Promise<{browser: object, stagehand: object}>}} [options] */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.createTimeoutMs = options.createTimeoutMs ?? BROWSERBASE_CREATE_TIMEOUT_MS;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? BROWSERBASE_CLEANUP_TIMEOUT_MS;
    this.createSession = options.createSession ?? (() => createStagehandSession({
      env: this.env,
      createTimeoutMs: this.createTimeoutMs,
      cleanupTimeoutMs: this.cleanupTimeoutMs,
    }));
    this.session = null;
    this.creating = null;
    this.closing = null;
    this.poisoned = null;
    this.lateCleanups = new Set();
  }

  poison(error, lateCleanup = error?.lateCleanup ?? null) {
    if (lateCleanup) {
      const tracked = Promise.resolve(lateCleanup).then(
        (cleaned) => cleaned === true,
        () => false,
      );
      this.lateCleanups.add(tracked);
      void tracked.then(() => this.lateCleanups.delete(tracked));
    }
    this.poisoned ??= error?.code === 'BROWSERBASE_CLEANUP_UNCERTAIN'
      ? error
      : cleanupUncertainError(error, lateCleanup);
    return this.poisoned;
  }

  async ensureSession() {
    if (this.closing) await this.closing;
    if (this.poisoned) throw this.poisoned;
    if (this.session) return this.session;
    if (this.creating) return this.creating;
    this.creating = (async () => {
      const rawCreation = Promise.resolve().then(() => this.createSession());
      let session;
      try {
        session = await withDeadline(
          rawCreation,
          this.createTimeoutMs,
          'Browserbase session creation timed out',
        );
      } catch (error) {
        if (error?.code === 'BROWSERBASE_OPERATION_TIMEOUT') {
          const lateCleanup = closeLateResource(
            rawCreation,
            (lateSession, timeoutMs) => closeSessionParts(lateSession, timeoutMs),
            this.cleanupTimeoutMs,
          );
          throw this.poison(error, lateCleanup);
        }
        if (error?.code === 'BROWSERBASE_CLEANUP_UNCERTAIN') throw this.poison(error);
        throw error;
      }
      if (!session?.browser || !session?.stagehand || !session.browser.sessionId) {
        try {
          await closeSessionParts(session, this.cleanupTimeoutMs);
        } catch (error) {
          throw this.poison(error);
        }
        throw new Error('Stagehand did not return a valid Browserbase session');
      }
      this.session = session;
      return session;
    })();
    try {
      return await this.creating;
    } finally {
      this.creating = null;
    }
  }

  async activePage(session) {
    const context = session.browser.context;
    return await context.activePage() ?? await context.newPage();
  }

  async run(prefix, operation) {
    try {
      const session = await this.ensureSession();
      return await operation(session);
    } catch (error) {
      try {
        await this.close();
      } catch (cleanupError) {
        if (cleanupError?.code === 'BROWSERBASE_CLEANUP_UNCERTAIN') throw cleanupError;
        throw new AggregateError(
          [error, cleanupError],
          `${prefix}: ${errorMessage(error)}; cleanup also failed: ${errorMessage(cleanupError)}`,
          { cause: error },
        );
      }
      if (error?.code === 'BROWSERBASE_CLEANUP_UNCERTAIN') throw error;
      throw new Error(`${prefix}: ${errorMessage(error)}`, { cause: error });
    }
  }

  async start() {
    return this.run('Failed to create Browserbase session', async (session) => browserbaseJsonResult({
      success: true,
      data: { sessionId: session.browser.sessionId },
    }));
  }

  async end() {
    try {
      await this.close();
      return browserbaseJsonResult({ success: true });
    } catch (error) {
      if (error?.code === 'BROWSERBASE_CLEANUP_UNCERTAIN') throw error;
      throw new Error(`Failed to close session: ${errorMessage(error)}`, { cause: error });
    }
  }

  async navigate({ url }) {
    return this.run('Failed to navigate', async (session) => {
      const page = await this.activePage(session);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return browserbaseJsonResult({ success: true, data: { url } });
    });
  }

  async act({ action }) {
    return this.run('Failed to perform action', async (session) => {
      const result = await session.stagehand.act(action);
      return browserbaseJsonResult({ success: true, data: compatibleStagehandResult(result) });
    });
  }

  async observe({ instruction }) {
    return this.run('Failed to observe', async (session) => {
      const result = await session.stagehand.observe(instruction);
      return browserbaseJsonResult({ success: true, data: compatibleStagehandResult(result) });
    });
  }

  async extract({ instruction } = {}) {
    return this.run('Failed to extract content', async (session) => {
      let result;
      if (instruction) {
        result = compatibleStagehandResult(await session.stagehand.extract(instruction));
      } else {
        const page = await this.activePage(session);
        result = await page.snapshot({ includeIframes: true });
      }
      return browserbaseJsonResult({ success: true, data: result });
    });
  }

  async close() {
    if (this.closing) return this.closing;
    const closing = (async () => {
      if (this.creating) {
        try {
          await this.creating;
        } catch {
          // Startup owns cleanup until it either returns a session or rejects.
        }
      }
      const session = this.session;
      this.session = null;
      try {
        await closeSessionParts(session, this.cleanupTimeoutMs);
      } catch (error) {
        throw this.poison(error);
      }
      if (this.lateCleanups.size > 0) {
        const pending = [...this.lateCleanups];
        let settled;
        try {
          settled = await withDeadline(
            Promise.all(pending),
            this.cleanupTimeoutMs,
            'Late Browserbase cleanup timed out',
          );
        } catch (error) {
          throw this.poison(error);
        }
        if (settled.some((cleaned) => cleaned !== true)) {
          throw this.poison(new Error('Late Browserbase cleanup failed'));
        }
      }
      if (this.poisoned) throw this.poisoned;
    })();
    this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.closing === closing) this.closing = null;
    }
  }
}
