import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const EXPORT_CHUNK_BYTES = 1024 * 1024;
const KNOWN_CREDENTIALS = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'CURSOR_API_KEY',
]);
const SAFE_HUB_ENVIRONMENT = new Set([
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TZ',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]);

function runtimeError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

async function withTimeout(operation, timeoutMs, code, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(runtimeError(code, message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function mimeType(filename) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  })[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function secretMatches(actual, expected) {
  const first = Buffer.from(String(actual ?? ''));
  const second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
}

async function findPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function isPlainFile(filename) {
  try {
    const stat = await fs.lstat(filename);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function startStudioServer({ studioRoot, resources, bootstrap }) {
  const resolvedRoot = path.resolve(studioRoot);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const resourceMatch = url.pathname.match(/^\/_runtime\/resource\/([a-zA-Z0-9_-]+)$/);
      let filename;
      if (resourceMatch) {
        if (!secretMatches(url.searchParams.get('bootstrap'), bootstrap)) {
          response.writeHead(401, { 'Cache-Control': 'no-store' });
          response.end();
          return;
        }
        filename = resources.get(resourceMatch[1]);
        if (!filename) {
          response.writeHead(404, { 'Cache-Control': 'no-store' });
          response.end();
          return;
        }
      } else {
        let relative;
        try {
          relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        } catch {
          response.writeHead(400);
          response.end();
          return;
        }
        if (relative.split('/').some((part) => part === '..' || part === '.')) {
          response.writeHead(403);
          response.end();
          return;
        }
        filename = path.resolve(resolvedRoot, relative);
        if (!(filename === resolvedRoot || filename.startsWith(`${resolvedRoot}${path.sep}`))) {
          response.writeHead(403);
          response.end();
          return;
        }
      }
      if (!(await isPlainFile(filename))) {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      const bytes = await fs.readFile(filename);
      response.writeHead(200, {
        'Content-Type': mimeType(filename),
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      if (request.method === 'HEAD') response.end();
      else response.end(bytes);
    } catch {
      if (!response.headersSent) response.writeHead(500, { 'Cache-Control': 'no-store' });
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address !== 'object') throw runtimeError('STUDIO_SERVER_FAILED', 'Studio loopback server did not bind');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(4_000)]);
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}

async function waitForHub(port, token, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw runtimeError('AGENT_HUB_FAILED', `Rauhwpx agent hub exited before startup (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz?token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw runtimeError('AGENT_HUB_TIMEOUT', `Rauhwpx agent hub did not become ready: ${lastError?.message ?? 'timeout'}`);
}

async function preparePiRuntime({ workspace, credentials, model, effort }) {
  const piRoot = path.join(workspace, 'pi-runtime');
  await fs.mkdir(path.join(piRoot, 'agent'), { recursive: true, mode: 0o700 });
  const bundledPrefix = process.env.RAUHWpx_PI_PREFIX || '/app/pi-runtime/prefix';
  if (!(await isPlainFile(path.join(bundledPrefix, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')))) {
    throw runtimeError('PROVIDER_RUNTIME_UNAVAILABLE', 'The pinned Pi runtime is missing from the worker image');
  }
  await fs.symlink(bundledPrefix, path.join(piRoot, 'prefix'), 'dir').catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const id = String(model ?? '').replace(/^openrouter\//, '');
  if (!id) throw runtimeError('MODEL_REQUIRED', 'Pi requires the OpenRouter model selected by the originating thread');
  const key = String(credentials.OPENROUTER_API_KEY ?? '').trim();
  if (!key) throw runtimeError('AUTH_REQUIRED', 'Pi requires an OpenRouter API key on this VPS');
  const selectedEffort = ['low', 'medium', 'high'].includes(effort) ? effort : 'medium';
  const config = {
    version: 1,
    installedVersion: null,
    keyTail: key.slice(-4),
    models: [{
      id,
      name: id,
      reasoning: true,
      supportsImages: true,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: selectedEffort,
      contextLength: 128_000,
      pricing: { prompt: 0, completion: 0 },
    }],
    defaultModelId: id,
    setupComplete: true,
  };
  await fs.writeFile(path.join(piRoot, 'config.json'), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(piRoot, 'agent', 'models.json'), `${JSON.stringify({
    providers: {
      openrouter: {
        apiKey: key,
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
        models: [{
          id,
          name: id,
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 128_000,
          maxTokens: 8_192,
          thinkingLevelMap: {
            off: null,
            minimal: 'minimal',
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: null,
            max: null,
          },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  })}\n`, { mode: 0o600 });
  return piRoot;
}

export async function seedCursorRuntime(workspace) {
  const cursorBin = path.join(workspace, 'home', '.local', 'bin', 'cursor-agent');
  const versionsRoot = path.join(workspace, 'home', '.local', 'share', 'cursor-agent', 'versions');
  const [resolvedVersionsRoot, resolvedCursorBin] = await Promise.all([
    fs.realpath(versionsRoot).catch(() => null),
    fs.realpath(cursorBin).catch(() => null),
  ]);
  const relativeBinary = resolvedVersionsRoot && resolvedCursorBin
    ? path.relative(resolvedVersionsRoot, resolvedCursorBin)
    : '';
  if (
    !resolvedVersionsRoot
    || !resolvedCursorBin
    || !relativeBinary
    || relativeBinary.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeBinary)
    || !(await isPlainFile(resolvedCursorBin))
  ) {
    throw runtimeError(
      'PROVIDER_RUNTIME_UNAVAILABLE',
      'Cursor is unavailable in this worker because the VPS did not provide a verified cursor-agent binary',
    );
  }
  const [version] = relativeBinary.split(path.sep);
  if (!version || version === '.' || version === '..') {
    throw runtimeError('PROVIDER_RUNTIME_UNAVAILABLE', 'Cursor runtime version directory is invalid');
  }
  const sourceVersionRoot = path.join(resolvedVersionsRoot, version);
  const relativeWithinVersion = path.relative(sourceVersionRoot, resolvedCursorBin);
  if (!relativeWithinVersion || relativeWithinVersion.startsWith(`..${path.sep}`) || path.isAbsolute(relativeWithinVersion)) {
    throw runtimeError('PROVIDER_RUNTIME_UNAVAILABLE', 'Cursor binary is outside its verified version directory');
  }
  const setupRoot = path.join(workspace, 'provider-cli-state');
  const sourceConfig = path.join(workspace, 'home', '.cursor');
  const targetHome = path.join(setupRoot, 'cursor-home');
  const targetBinDirectory = path.join(targetHome, '.local', 'bin');
  const targetVersionRoot = path.join(targetHome, '.local', 'share', 'cursor-agent', 'versions', version);
  await fs.mkdir(targetBinDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(targetVersionRoot), { recursive: true, mode: 0o700 });
  await fs.cp(sourceVersionRoot, targetVersionRoot, { recursive: true, force: false });
  const targetBinary = path.join(targetVersionRoot, relativeWithinVersion);
  const targetLink = path.join(targetBinDirectory, 'cursor-agent');
  await fs.symlink(path.relative(targetBinDirectory, targetBinary), targetLink);
  if (await fs.lstat(sourceConfig).then((stat) => stat.isDirectory() && !stat.isSymbolicLink()).catch(() => false)) {
    await fs.cp(sourceConfig, path.join(targetHome, '.cursor'), { recursive: true, force: false });
  }
  return { setupRoot, cursorBin: targetLink };
}

function resourceUrl(origin, bootstrap, id) {
  const url = new URL(`/_runtime/resource/${encodeURIComponent(id)}`, origin);
  url.searchParams.set('bootstrap', bootstrap);
  return url.toString();
}

function credentialEnvironment(credentials) {
  const result = {};
  for (const [name, value] of Object.entries(credentials ?? {})) {
    if (KNOWN_CREDENTIALS.has(name) && typeof value === 'string' && value.trim()) result[name] = value.trim();
  }
  return result;
}

export function safeHubBaseEnvironment(environment = process.env) {
  const result = {};
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (SAFE_HUB_ENVIRONMENT.has(name) && typeof value === 'string' && value) result[name] = value;
  }
  return result;
}

export async function uploadRequiredReferences({
  page,
  bootstrap,
  origin,
  references,
  scopeId,
  onEvent,
  timeoutMs = 60_000,
}) {
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    try {
      await withTimeout(
        page.evaluate(async (secret, input) => window.rauhwpxCloudRuntime.uploadReference(secret, input), bootstrap, {
          url: resourceUrl(origin, bootstrap, `reference-${index}`),
          name: reference.name,
          mimeType: reference.mimeType,
          scopeId,
        }),
        timeoutMs,
        'REFERENCE_INDEX_TIMEOUT',
        `Required cloud reference indexing timed out: ${reference.name}`,
      );
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 1_000);
      await onEvent({ type: 'reference.index-failed', name: reference.name, message });
      throw runtimeError('REFERENCE_INDEX_FAILED', `Required cloud reference could not be indexed: ${reference.name}`, error);
    }
  }
}

export async function createStudioHarness({
  manifest,
  workspace,
  credentials,
  document,
  references,
  timeline,
  displayEnv = null,
  onEvent = async () => {},
  studioRoot = process.env.RAUHWpx_STUDIO_DIST || '/app/studio',
  agentRoot = process.env.RAUHWpx_AGENT_ROOT || '/app/rhwp-agent',
  chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  rhwpBin = process.env.RHWP_BIN || '/app/bin/rhwp',
  startupTimeoutMs = 60_000,
}) {
  const { default: puppeteer } = await import('puppeteer-core');
  const bootstrap = randomBytes(32).toString('base64url');
  const hubToken = randomBytes(32).toString('base64url');
  const studioSessionId = `cloud-${manifest.sessionId}`;
  const { issueScopedHubToken } = await import(pathToFileURL(path.join(agentRoot, 'hub-session-registry.mjs')).href);
  const studioToken = issueScopedHubToken(hubToken, studioSessionId);
  const hubPort = await findPort();
  const resourceFiles = new Map([['document', document.filename]]);
  references.forEach((reference, index) => resourceFiles.set(`reference-${index}`, reference.filename));
  const { server: studioServer, origin } = await startStudioServer({ studioRoot, resources: resourceFiles, bootstrap });
  let hub = null;
  let browser = null;
  let page = null;
  let eventSequence = 0;
  let started = false;
  try {
    const thread = timeline.thread;
    const execution = manifest.executionConfig ?? {
      model: thread.model,
      effort: thread.effort,
      workflow: thread.workflow,
      permissionProfile: 'unrestricted',
    };
    if (execution.permissionProfile !== 'unrestricted') {
      throw runtimeError('PERMISSION_PROFILE_INVALID', 'Cloud document sessions require unrestricted permission');
    }
    const env = {
      ...safeHubBaseEnvironment(process.env),
      ...credentialEnvironment(credentials),
      HOME: path.join(workspace, 'home'),
      USERPROFILE: path.join(workspace, 'home'),
      RHWP_AGENT_MODE: 'production',
      RHWP_AGENT_PORT: String(hubPort),
      RHWP_AGENT_TOKEN: hubToken,
      RHWP_BIN: rhwpBin,
      RHWP_WORK_DIR: path.join(workspace, 'agent-work'),
      RHWP_RUNTIME_DIR: agentRoot,
      RHWP_STUDIO_REATTACH_GRACE_MS: '15000',
      PATH: `${path.join(workspace, 'home', '.local', 'bin')}:${path.join(
        process.env.RAUHWpx_PROVIDER_CLI_PREFIX || '/opt/rauhwpx-provider-cli',
        'node_modules',
        '.bin',
      )}:/usr/local/bin:/usr/bin:/bin`,
      ...(displayEnv?.DISPLAY && displayEnv?.XAUTHORITY
        ? {
          DISPLAY: String(displayEnv.DISPLAY),
          XAUTHORITY: String(displayEnv.XAUTHORITY),
          RAUHWpx_SESSION_DISPLAY: String(displayEnv.RAUHWpx_SESSION_DISPLAY || 'ready'),
          ...(displayEnv.RAUHWpx_SCREENSHOT_DIR
            ? { RAUHWpx_SCREENSHOT_DIR: String(displayEnv.RAUHWpx_SCREENSHOT_DIR) }
            : {}),
        }
        : {}),
    };
    if (manifest.provider === 'pi') env.RHWP_PI_DIR = await preparePiRuntime({
      workspace, credentials, model: execution.model, effort: execution.effort,
    });
    if (manifest.provider === 'cursor') {
      const cursor = await seedCursorRuntime(workspace);
      env.RHWP_CLI_DIR = cursor.setupRoot;
      env.PATH = `${path.dirname(cursor.cursorBin)}:${env.PATH}`;
    }
    await fs.mkdir(env.RHWP_WORK_DIR, { recursive: true, mode: 0o700 });
    hub = spawn(process.execPath, [path.join(agentRoot, 'server.mjs')], {
      cwd: agentRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let hubErrorTail = '';
    hub.stderr?.on('data', (chunk) => { hubErrorTail = `${hubErrorTail}${chunk}`.slice(-8_000); });
    hub.stdout?.resume();
    await waitForHub(hubPort, hubToken, hub);

    browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      pipe: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
      ],
    });
    page = await browser.newPage();
    let pageErrorTail = '';
    const appendPageError = (message) => {
      const redacted = String(message)
        .replace(/([?&](?:token|bootstrap)=)[^&\s'\"]+/gi, '$1[redacted]')
        .replaceAll(hubToken, '[redacted]')
        .replaceAll(studioToken, '[redacted]')
        .replaceAll(bootstrap, '[redacted]');
      pageErrorTail = `${pageErrorTail}\n${redacted}`.slice(-4_000);
    };
    page.on('pageerror', (error) => appendPageError(error?.message ?? error));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') appendPageError(message.text());
    });
    await page.evaluateOnNewDocument((context) => {
      Object.defineProperty(window, 'rhwpDesktop', {
        value: Object.freeze({
          ensureAgentHub: async () => ({ started: true, ready: true }),
          getSessionContext: async () => ({ ...context }),
        }),
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }, {
      launchId: `cloud-${manifest.sessionId}`,
      sessionId: studioSessionId,
      hubUrl: `ws://127.0.0.1:${hubPort}`,
      hubToken: studioToken,
    });
    const appUrl = new URL('/', origin);
    appUrl.searchParams.set('cloudRuntime', '1');
    appUrl.searchParams.set('bootstrap', bootstrap);
    await page.goto(appUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await page.waitForFunction(
        (secret) => typeof window.rauhwpxCloudRuntime?.status === 'function'
          && window.rauhwpxCloudRuntime.status(secret).connection === 'connected',
        { timeout: startupTimeoutMs },
        bootstrap,
      );
    } catch (error) {
      const status = await page.evaluate(
        (secret) => typeof window.rauhwpxCloudRuntime?.status === 'function'
          ? window.rauhwpxCloudRuntime.status(secret)
          : { bridgeInstalled: false },
        bootstrap,
      ).catch(() => ({ bridgeInstalled: false }));
      throw runtimeError(
        'STUDIO_RUNTIME_TIMEOUT',
        `Cloud Studio did not connect to its agent hub (${JSON.stringify(status)}): ${pageErrorTail.trim() || 'no browser error'}`,
        error,
      );
    }
    await withTimeout(
      page.evaluate(async (secret, input) => window.rauhwpxCloudRuntime.loadDocument(secret, input), bootstrap, {
        url: resourceUrl(origin, bootstrap, 'document'),
        name: document.name,
        mimeType: document.mimeType,
      }),
      startupTimeoutMs,
      'DOCUMENT_LOAD_TIMEOUT',
      'Cloud Studio document load timed out',
    );
    await uploadRequiredReferences({ page, bootstrap, origin, references, scopeId: thread.id, onEvent });

    return {
      async start({ history }) {
        if (started) return;
        started = true;
        await withTimeout(
          page.evaluate((secret, input) => window.rauhwpxCloudRuntime.startChat(secret, input), bootstrap, {
            agent: manifest.provider,
            model: execution.model,
            effort: execution.effort,
            workflow: execution.workflow,
            permissionProfile: execution.permissionProfile,
            threadId: thread.id,
            documentId: thread.documentId ?? manifest.clientContext?.documentId ?? null,
            documentName: document.name,
            history,
          }),
          startupTimeoutMs,
          'STUDIO_START_TIMEOUT',
          'Cloud Studio chat start timed out',
        );
        await page.waitForFunction(
          (secret, provider) => window.rauhwpxCloudRuntime.status(secret).activeAgent === provider,
          { timeout: 30_000 },
          bootstrap,
          manifest.provider,
        );
      },
      async runTurn(prompt, { timeoutMs }) {
        const sentAt = Date.now();
        await withTimeout(
          page.evaluate((secret, text) => window.rauhwpxCloudRuntime.sendUserMessage(secret, text), bootstrap, prompt),
          30_000,
          'TURN_SEND_TIMEOUT',
          'Cloud Studio did not accept the user message',
        );
        let sawStart = false;
        let planId = null;
        let implementationStarted = execution.workflow !== 'plan';
        let approvalRequested = false;
        while (Date.now() - sentAt < timeoutMs) {
          const entries = await withTimeout(
            page.evaluate(
              (secret, after) => window.rauhwpxCloudRuntime.drainEvents(secret, after),
              bootstrap,
              eventSequence,
            ),
            30_000,
            'EVENT_DRAIN_TIMEOUT',
            'Cloud Studio event drain timed out',
          );
          for (const entry of entries) {
            eventSequence = Math.max(eventSequence, Number(entry.seq) || 0);
            await onEvent(entry.event);
            if (entry.event?.type === 'plan-ready') {
              planId = String(entry.event.plan?.planId ?? entry.event.planId ?? '') || null;
            }
            if (entry.event?.type === 'implementation-started') implementationStarted = true;
            if (entry.event?.type === 'hub-error') {
              throw runtimeError(String(entry.event.code || 'AGENT_HUB_ERROR'), String(entry.event.message || 'Agent hub failed'));
            }
            const agentEvent = entry.event?.type === 'agent' ? entry.event.event : null;
            if (agentEvent?.type === 'turn-start') sawStart = true;
            if (agentEvent?.type === 'turn-end' && sawStart) {
              if (execution.workflow === 'plan' && !implementationStarted) {
                if (!planId) throw runtimeError('PLAN_NOT_PRESENTED', 'Planning workflow ended without a structured implementation plan');
                if (approvalRequested) throw runtimeError('PLAN_APPROVAL_FAILED', 'Planning workflow ended again before implementation started');
                await withTimeout(
                  page.evaluate(
                    (secret, selectedPlanId) => window.rauhwpxCloudRuntime.approvePlan(secret, selectedPlanId),
                    bootstrap,
                    planId,
                  ),
                  30_000,
                  'PLAN_APPROVAL_TIMEOUT',
                  'Cloud Studio plan approval timed out',
                );
                approvalRequested = true;
                sawStart = false;
                continue;
              }
              return agentEvent;
            }
          }
          if (hub.exitCode !== null || hub.signalCode) {
            throw runtimeError('AGENT_HUB_FAILED', `Rauhwpx agent hub exited during the turn: ${hubErrorTail.trim().slice(-2_000)}`);
          }
          await delay(200);
        }
        throw runtimeError('TURN_TIMEOUT', 'Cloud provider turn exceeded the session deadline');
      },
      async exportDocument(format, destination) {
        const metadata = await withTimeout(
          page.evaluate(
            (secret, selectedFormat) => window.rauhwpxCloudRuntime.prepareExport(secret, selectedFormat),
            bootstrap,
            format,
          ),
          120_000,
          'EXPORT_PREPARE_TIMEOUT',
          'Cloud Studio export preparation timed out',
        );
        if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_EXPORT_BYTES) {
          throw runtimeError('RESULT_TOO_LARGE', 'Studio returned an invalid or oversized document result');
        }
        const handle = await fs.open(destination, 'w', 0o600);
        const digest = createHash('sha256');
        try {
          for (let offset = 0; offset < metadata.size; offset += EXPORT_CHUNK_BYTES) {
            const chunk = await withTimeout(
              page.evaluate(
                (secret, start, size) => window.rauhwpxCloudRuntime.readExportChunk(secret, start, size),
                bootstrap,
                offset,
                Math.min(EXPORT_CHUNK_BYTES, metadata.size - offset),
              ),
              60_000,
              'EXPORT_CHUNK_TIMEOUT',
              'Cloud Studio export chunk read timed out',
            );
            const bytes = Buffer.from(chunk.dataBase64, 'base64');
            if (chunk.offset !== offset || chunk.size !== bytes.length || bytes.length < 1) {
              throw runtimeError('RESULT_CORRUPT', 'Studio export chunks were incomplete');
            }
            digest.update(bytes);
            await handle.write(bytes);
          }
        } finally {
          await handle.close();
        }
        const sha256 = digest.digest('hex');
        if (sha256 !== metadata.sha256) {
          await fs.rm(destination, { force: true });
          throw runtimeError('RESULT_CORRUPT', 'Studio export digest did not match its receipt');
        }
        return { ...metadata, sha256 };
      },
      async close() {
        await page?.evaluate((secret) => window.rauhwpxCloudRuntime.stop(secret), bootstrap).catch(() => {});
        await browser?.close().catch(() => {});
        browser = null;
        await stopProcess(hub);
        hub = null;
        await new Promise((resolve) => studioServer.close(resolve));
      },
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    await stopProcess(hub);
    await new Promise((resolve) => studioServer.close(resolve));
    throw error;
  }
}
