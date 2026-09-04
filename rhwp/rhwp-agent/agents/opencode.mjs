import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import {
  credentialMirrorHasPendingCopybackSync,
  flushCredentialMirrorSync,
  prepareCredentialMirrorSync,
} from '../credential-mirror.mjs';
import {
  isPlanningRestricted,
  mcpCapabilityEnv,
  mcpRuntimeFor,
  normalizeExecutionMode,
  providerReadOnlyRoots,
  providerInteractionMode,
  redactDiagnosticText,
  systemBriefFor,
  truncate,
  validateExecutionMode,
} from './backend.mjs';
import { isolatedProcessEnv, terminateProcessTree } from '../process-tree.mjs';
import { openCodeRuntimeEnv } from '../opencode-env.mjs';
import { isReusableOpenCodeAuthContent } from '../opencode-auth.mjs';
import { acpMcpServer, createPersistentAcpSession } from './acp-session.mjs';

const AGENT = /** @type {any} */ ('opencode');
const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});
const TOOL_NAMES_BY_KIND = Object.freeze({
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'bash',
  think: 'task',
  fetch: 'webfetch',
  switch_mode: 'switch_mode',
});

const openCodeMirrorsByHome = new Map();

/** OpenCode stores auth below its XDG data directory, not directly in HOME. */
export function openCodeAuthPath(isolatedHome) {
  return path.join(String(isolatedHome), '.local', 'share', 'opencode', 'auth.json');
}

/** Restore the isolated OpenCode auth mirror before a process generation starts. */
export function prepareOpenCodeHome(isolatedHome, sourceAuthPath, deps = {}) {
  const key = path.resolve(String(isolatedHome));
  const target = openCodeAuthPath(key);
  let preserveTarget = false;
  const previous = openCodeMirrorsByHome.get(key);
  if (previous) {
    const result = flushCredentialMirrorSync(previous, {
      platform: deps.platform ?? process.platform,
      validateTarget: isReusableOpenCodeAuthContent,
    });
    if (result.pending) throw Object.assign(new Error(result.errorMessage), { code: result.errorCode });
    preserveTarget = result.conflict === true;
    if (!preserveTarget) rmSync(previous.target, { force: true });
    openCodeMirrorsByHome.delete(key);
  }

  if (preserveTarget) return null;
  if (!sourceAuthPath) {
    rmSync(target, { force: true });
    return null;
  }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const mirror = prepareCredentialMirrorSync(sourceAuthPath, target, {
    platform: deps.platform ?? process.platform,
    ...(deps.symlink ? { symlink: deps.symlink } : {}),
    copyOnly: true,
    validateSource: isReusableOpenCodeAuthContent,
  });
  if (!mirror) rmSync(target, { force: true });
  if (mirror?.mode === 'copy') openCodeMirrorsByHome.set(key, mirror);
  return mirror;
}

/** Copy refreshed credentials back after the owned OpenCode tree is gone. */
export function flushOpenCodeCredentialMirror(isolatedHome) {
  const key = path.resolve(String(isolatedHome));
  const mirror = openCodeMirrorsByHome.get(key);
  if (!mirror) return true;
  try {
    const result = flushCredentialMirrorSync(mirror, {
      validateTarget: isReusableOpenCodeAuthContent,
    });
    if (result.pending) {
      process.stderr.write(`[opencode] credential refresh copyback pending: ${result.errorMessage}\n`);
      return false;
    }
    openCodeMirrorsByHome.delete(key);
    rmSync(mirror.target, { force: true });
    if (result.conflict) {
      process.stderr.write(`[opencode] credential refresh copyback conflicted: ${mirror.source}\n`);
    }
  } catch (error) {
    process.stderr.write(`[opencode] credential refresh copyback failed: ${error?.message ?? error}\n`);
    if (credentialMirrorHasPendingCopybackSync(mirror)) return false;
    openCodeMirrorsByHome.delete(key);
    rmSync(mirror.target, { force: true });
  }
  return true;
}

/**
 * OpenCode permission configuration is ordered. The wildcard establishes the
 * baseline and the specific rules that follow narrow it for the active mode.
 */
export function buildOpenCodePermissions(opts = {}) {
  const copyLayoutWorker = opts.toolProfile === 'copy-layout-worker';
  const planning = isPlanningRestricted(opts) || copyLayoutWorker;
  const readOnlyGlobs = providerReadOnlyRoots(opts).map((root) => {
    const normalized = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    return `${normalized}/**`;
  });
  const externalDirectory = {
    '*': 'deny',
    ...Object.fromEntries(readOnlyGlobs.map((root) => [root, 'allow'])),
  };
  const edit = {
    '*': planning ? 'deny' : 'allow',
    ...Object.fromEntries(readOnlyGlobs.map((root) => [root, 'deny'])),
  };
  if (planning) {
    return {
      '*': 'allow',
      edit,
      bash: 'deny',
      ...(copyLayoutWorker ? {
        webfetch: 'deny',
        websearch: 'deny',
        task: 'deny',
      } : {}),
      external_directory: externalDirectory,
    };
  }
  if (opts.permissionProfile === 'unrestricted') {
    return {
      '*': 'allow',
      edit,
      external_directory: 'allow',
    };
  }
  return {
    '*': 'allow',
    edit,
    bash: 'ask',
    external_directory: externalDirectory,
  };
}

/** Managed inline config wins over project config for the security-sensitive rules. */
export function buildOpenCodeConfig(opts = {}) {
  const supplied = opts.openCodeConfig;
  const base = supplied && typeof supplied === 'object' && !Array.isArray(supplied)
    ? { ...supplied }
    : {};
  return {
    ...base,
    autoupdate: false,
    permission: buildOpenCodePermissions(opts),
  };
}

/**
 * Keep OpenCode config, database, cache, and credentials inside the session
 * home. Host OpenCode path overrides are removed so an invalid user config
 * cannot prevent the embedded agent from starting.
 */
export function buildOpenCodeEnv(opts, sourceEnv = undefined) {
  if (!opts.isolatedHome) throw new Error('OpenCode sessions require an isolated home.');
  const home = path.resolve(String(opts.isolatedHome));
  const configuredProviderEnv = typeof opts.openCodeProviderEnv === 'function'
    ? opts.openCodeProviderEnv()
    : opts.providerEnv;
  const providerEnv = configuredProviderEnv && typeof configuredProviderEnv === 'object'
    ? configuredProviderEnv
    : null;
  const launchEnv = sourceEnv ?? providerEnv ?? process.env;
  const appOwnedApiKey = providerEnv?.OPENCODE_API_KEY;
  const env = isolatedProcessEnv(opts, openCodeRuntimeEnv(launchEnv, appOwnedApiKey));
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  delete env.OPENCODE_DB;
  delete env.OPENCODE_AUTH_CONTENT;
  delete env.OPENCODE_PERMISSION;
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env.XDG_STATE_HOME = path.join(home, '.local', 'state');
  env.OPENCODE_CONFIG_DIR = path.join(home, '.config', 'opencode');
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildOpenCodeConfig(opts));
  env.OPENCODE_PERMISSION = JSON.stringify(buildOpenCodePermissions(opts));
  env.OPENCODE_DISABLE_CLAUDE_CODE = '1';
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1';
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = '1';
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  env.OPENCODE_DISABLE_LSP_DOWNLOAD = '1';
  return env;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function tokenCount(value) {
  return Math.round(positiveNumber(value));
}

/** ACP uses cachedReadTokens/cachedWriteTokens, unlike the older provider streams. */
export function normalizeOpenCodeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usage = {
    inputTokens: tokenCount(raw.inputTokens ?? raw.input_tokens),
    outputTokens: tokenCount(raw.outputTokens ?? raw.output_tokens),
    cacheReadTokens: tokenCount(
      raw.cachedReadTokens ?? raw.cacheReadTokens ?? raw.cache_read_input_tokens,
    ),
    cacheCreationTokens: tokenCount(
      raw.cachedWriteTokens ?? raw.cacheWriteTokens ?? raw.cache_creation_input_tokens,
    ),
  };
  return Object.values(usage).some((value) => value > 0) ? usage : null;
}

function stripRhwpPrefix(value) {
  return String(value ?? '')
    .replace(/^mcp__rhwp__/, '')
    .replace(/^rhwp__/, '')
    .replace(/^rhwp[_:./]/, '');
}

/** Recover a stable tool label from both current and older ACP tool payloads. */
export function openCodeToolName(update) {
  if (Array.isArray(update?.rawInput?.questions)) return 'ask_user_question';
  const explicit = String(update?.name ?? '').trim();
  if (explicit) return stripRhwpPrefix(explicit);
  const kind = String(update?.kind ?? '').trim();
  if (kind === 'other') {
    const title = String(update?.title ?? '').trim();
    return stripRhwpPrefix(title || 'tool');
  }
  return TOOL_NAMES_BY_KIND[kind] ?? stripRhwpPrefix(update?.title || kind || 'tool');
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function toolContentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => entry?.content?.type === 'text' ? String(entry.content.text ?? '') : '')
    .filter(Boolean)
    .join('\n');
}

/** Prefer the provider's text result while keeping arbitrary structured results bounded. */
export function openCodeResultPreview(update) {
  const raw = update?.rawOutput;
  const text = typeof raw === 'string'
    ? raw
    : typeof raw?.output === 'string'
      ? raw.output
      : typeof raw?.error === 'string'
        ? raw.error
        : toolContentText(update?.content);
  return truncate(text || safeJson(raw ?? update?.content ?? null));
}

/** @param {import('./backend.mjs').BackendOptions & Record<string, any>} opts */
export function createOpenCodeSession(opts, {
  createAcpSession = createPersistentAcpSession,
  terminateProcess = terminateProcessTree,
  prepareHome = prepareOpenCodeHome,
  flushCredentialMirror = flushOpenCodeCredentialMirror,
} = {}) {
  const onEvent = opts.onEvent;
  /** @type {string|null} */
  let providerSessionId = opts.openCodeSessionId ? String(opts.openCodeSessionId) : null;
  /** @type {string|null} */
  let currentModel = opts.model && opts.model !== 'auto' ? opts.model : null;
  /** @type {ReturnType<typeof createPersistentAcpSession>|null} */
  let transport = null;
  let disposed = false;
  let turnOpen = false;
  let queued = false;
  let turnSequence = 0;
  /** @type {Promise<void>|null} */
  let activeCompletion = null;
  let emittedSessionKey = '';
  let briefRequired = true;
  let lastSessionCost = 0;
  /** @type {number|null} */
  let pendingSessionCost = null;
  let cleanupUncertain = false;
  let credentialRefreshPending = false;
  /** @type {Promise<boolean>|null} */
  let disposalPromise = null;
  /** @type {Map<string, Record<string, any>>} */
  const tools = new Map();
  /** @type {WeakMap<object, Promise<boolean>>} */
  const cleanupByTransport = new WeakMap();
  /** @type {Set<Promise<boolean>>} */
  const transportCleanups = new Set();

  function credentialSource() {
    return typeof opts.openCodeAuthPath === 'function'
      ? opts.openCodeAuthPath()
      : opts.openCodeAuthPath;
  }

  function prepareCredentialGeneration() {
    prepareHome(opts.isolatedHome, credentialSource());
    credentialRefreshPending = false;
  }

  function applyCredentialRefreshIfIdle() {
    if (!credentialRefreshPending || disposed || cleanupUncertain || turnOpen || queued
      || activeCompletion || transportCleanups.size > 0) return;
    try {
      prepareCredentialGeneration();
    } catch (error) {
      cleanupUncertain = true;
      process.stderr.write(`[opencode] credential refresh failed: ${error?.message ?? error}\n`);
    }
  }

  function emitSessionInfo() {
    if (!providerSessionId) return;
    const key = `${providerSessionId}\u0000${currentModel ?? ''}`;
    if (key === emittedSessionKey) return;
    emittedSessionKey = key;
    onEvent({
      type: 'session-info',
      agent: AGENT,
      sessionId: providerSessionId,
      ...(currentModel ? { model: currentModel } : {}),
      mcpStatus: 'connected',
    });
  }

  function handleUpdate(update) {
    const kind = String(update?.sessionUpdate ?? '');
    if (kind === 'agent_message_chunk') {
      const text = update?.content?.type === 'text' ? String(update.content.text ?? '') : '';
      if (text) onEvent({ type: 'text-delta', agent: AGENT, text });
      return;
    }
    if (kind === 'usage_update') {
      const amount = positiveNumber(update?.cost?.amount);
      if (amount > 0 && String(update?.cost?.currency ?? 'USD').toUpperCase() === 'USD') {
        pendingSessionCost = amount;
      }
      return;
    }
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return;

    const callId = String(update?.toolCallId ?? '');
    if (!callId) return;
    const previous = tools.get(callId) ?? {};
    const merged = { ...previous, ...update };
    tools.set(callId, merged);
    const status = String(merged.status ?? '');
    const rawInput = merged.rawInput && typeof merged.rawInput === 'object'
      && !Array.isArray(merged.rawInput)
      ? merged.rawInput
      : {};
    const terminal = status === 'completed' || status === 'failed';
    // OpenCode can announce a pending call before its arguments arrive. Wait
    // for the common in_progress update so the UI and question gate receive
    // the real payload, but never suppress a terminal-only call.
    if (!previous.emitted && (Object.keys(rawInput).length > 0 || terminal)) {
      merged.emitted = true;
      onEvent({
        type: 'tool-call',
        agent: AGENT,
        callId,
        tool: openCodeToolName(merged),
        argsJson: safeJson(rawInput),
      });
    }
    if (terminal && !previous.finished) {
      merged.finished = true;
      onEvent({
        type: 'tool-result',
        agent: AGENT,
        callId,
        ok: status === 'completed',
        resultPreview: openCodeResultPreview(merged),
      });
    }
  }

  function makeTransport() {
    const runtime = mcpRuntimeFor(opts);
    return createAcpSession({
      clientName: 'rhwp-opencode',
      command: opts.openCodeBin ?? 'opencode',
      args: ['acp', '--pure'],
      cwd: opts.rootDir,
      env: () => buildOpenCodeEnv(opts),
      isolatePrompts: true,
      mcpServers: [acpMcpServer('rhwp', {
        ...runtime,
        env: {
          ...runtime.env,
          RHWP_WS_URL: `ws://127.0.0.1:${opts.hubPort}/mcp`,
          RHWP_AGENT_TOKEN: opts.token,
          RHWP_AGENT_NAME: 'opencode',
          ...mcpCapabilityEnv(opts),
        },
      })],
      resumeSessionId: providerSessionId,
      getUnrestricted: () => opts.permissionProfile === 'unrestricted' && !isPlanningRestricted(opts),
      onSessionStarted(info) {
        const nextId = String(info.sessionId);
        if (providerSessionId && providerSessionId !== nextId) {
          lastSessionCost = 0;
          briefRequired = true;
        }
        providerSessionId = nextId;
        const modelOption = (info.setupResponse?.configOptions ?? []).find((option) => (
          option?.category === 'model' || option?.id === 'model'
        ));
        if (!currentModel && modelOption?.currentValue) currentModel = String(modelOption.currentValue);
      },
      onSessionUpdate: handleUpdate,
    }, { terminateProcess });
  }

  function costForTurn() {
    if (pendingSessionCost === null) return 0;
    const total = pendingSessionCost;
    pendingSessionCost = null;
    const delta = total >= lastSessionCost ? total - lastSessionCost : total;
    lastSessionCost = total;
    return positiveNumber(delta);
  }

  function finishTurn(token, event) {
    if (token !== turnSequence || !turnOpen) return;
    turnOpen = false;
    onEvent(event);
  }

  async function runTurn(text, token) {
    /** @type {ReturnType<typeof createPersistentAcpSession>|null} */
    let session = null;
    try {
      // isolatePrompts proves the preceding child tree dead before a turn
      // completes. Seed a freshly validated snapshot for every OS generation.
      prepareCredentialGeneration();
      if (!transport) transport = makeTransport();
      session = transport;
      const mode = providerInteractionMode(opts) === 'plan' ? 'plan' : 'build';
      await session.configure({
        modeAliases: [mode],
        requireModeMatch: true,
        model: opts.model === 'auto' ? null : opts.model,
        requireModelMatch: opts.model !== 'auto',
        effort: opts.effort,
      });
      if (token !== turnSequence || disposed || !turnOpen) return;
      providerSessionId = session.getSessionId() ?? providerSessionId;
      currentModel = opts.model && opts.model !== 'auto' ? opts.model : currentModel;
      emitSessionInfo();
      const includeBrief = briefRequired || normalizeExecutionMode(opts).workflow !== 'direct';
      const prompt = includeBrief ? `${systemBriefFor(opts, 'opencode')}\n\n${text}` : text;
      if (includeBrief) briefRequired = false;
      const response = await session.prompt(prompt);
      if (session.isCleanupUncertain?.() === true) cleanupUncertain = true;
      if (token !== turnSequence || disposed || !turnOpen) return;
      const usage = normalizeOpenCodeUsage(response?.usage);
      const costUsd = costForTurn();
      if (usage || costUsd > 0) {
        onEvent({
          type: 'usage',
          agent: AGENT,
          model: currentModel,
          usage: usage ?? { ...EMPTY_USAGE },
          ...(costUsd > 0 ? { costUsd } : {}),
        });
      }
      const stopReason = response?.stopReason ?? 'end_turn';
      finishTurn(token, {
        type: 'turn-end',
        agent: AGENT,
        stopReason: stopReason === 'cancelled' ? 'interrupted' : stopReason,
        ...(stopReason === 'refusal' ? { errorMessage: 'OpenCode refused the request.' } : {}),
      });
    } catch (error) {
      // configure() can fail after starting the child. Do not publish failure
      // or allow another credential snapshot until that process tree is gone.
      if (session) await beginTransportCleanup(session);
      if (session?.isCleanupUncertain?.() === true) cleanupUncertain = true;
      if (token !== turnSequence || disposed || !turnOpen) return;
      const message = redactDiagnosticText(error?.message ?? error, [opts.token]);
      onEvent({ type: 'error', agent: AGENT, message });
      finishTurn(token, {
        type: 'turn-end', agent: AGENT, stopReason: 'failed', errorMessage: message,
      });
    }
  }

  function beginTransportCleanup(session, before = Promise.resolve()) {
    if (!session) return Promise.resolve(true);
    const existing = cleanupByTransport.get(session);
    if (existing) return existing;
    if (transport === session) transport = null;
    /** @type {Promise<boolean>} */
    let cleanup;
    cleanup = Promise.resolve(before)
      .catch(() => {})
      .then(() => session.dispose())
      .then(
        (result) => {
          const cleaned = result === true;
          if (!cleaned) cleanupUncertain = true;
          return cleaned;
        },
        () => {
          cleanupUncertain = true;
          return false;
        },
      )
      .finally(() => {
        transportCleanups.delete(cleanup);
        applyCredentialRefreshIfIdle();
      });
    cleanupByTransport.set(session, cleanup);
    transportCleanups.add(cleanup);
    return cleanup;
  }

  async function waitForTransportCleanups() {
    let cleaned = true;
    while (transportCleanups.size > 0) {
      const results = await Promise.all([...transportCleanups]);
      cleaned = results.every(Boolean) && cleaned;
    }
    return cleaned && !cleanupUncertain;
  }

  async function replaceTransport() {
    const previous = transport;
    if (!previous) return waitForTransportCleanups();
    return beginTransportCleanup(previous);
  }

  return {
    agent: AGENT,
    refreshCredentials() {
      credentialRefreshPending = true;
      applyCredentialRefreshIfIdle();
    },
    getSessionId() {
      return providerSessionId;
    },
    sendUserMessage(text) {
      if (disposed) return;
      if (turnOpen || queued) throw new Error('OpenCode already has a turn in progress');
      const token = ++turnSequence;
      const activate = () => {
        queued = false;
        if (disposed || token !== turnSequence) return;
        if (cleanupUncertain) {
          onEvent({
            type: 'error', agent: AGENT,
            message: 'OpenCode ACP process-tree cleanup remains unconfirmed',
          });
          onEvent({ type: 'turn-end', agent: AGENT, stopReason: 'failed' });
          return;
        }
        tools.clear();
        pendingSessionCost = null;
        turnOpen = true;
        onEvent({ type: 'turn-start', agent: AGENT });
        const completion = runTurn(String(text), token);
        activeCompletion = completion;
        void completion.finally(() => {
          if (activeCompletion === completion) {
            activeCompletion = null;
            applyCredentialRefreshIfIdle();
          }
        }).catch(() => {});
      };
      if (activeCompletion || transportCleanups.size > 0) {
        queued = true;
        const turn = activeCompletion ?? Promise.resolve();
        void Promise.allSettled([turn, waitForTransportCleanups()]).then(activate);
      } else {
        activate();
      }
    },
    async setPermissionProfile(profile) {
      if (turnOpen || queued) throw new Error('Permission profile can only change between turns');
      if (cleanupUncertain) throw new Error('OpenCode process-tree cleanup remains unconfirmed');
      if (profile !== 'safe' && profile !== 'unrestricted') {
        throw new Error(`Unknown permission profile: ${profile}`);
      }
      if (activeCompletion) await activeCompletion;
      if (!await waitForTransportCleanups()) {
        throw new Error('OpenCode process-tree cleanup remains unconfirmed');
      }
      const previous = opts.permissionProfile;
      opts.permissionProfile = profile;
      if (await replaceTransport()) {
        briefRequired = true;
        return;
      }
      opts.permissionProfile = previous;
      throw new Error('OpenCode process-tree cleanup could not be confirmed for the permission change');
    },
    async setExecutionMode(mode) {
      if (turnOpen || queued) throw new Error('Execution mode can only change between turns');
      if (cleanupUncertain) throw new Error('OpenCode process-tree cleanup remains unconfirmed');
      validateExecutionMode(mode);
      if (activeCompletion) await activeCompletion;
      if (!await waitForTransportCleanups()) {
        throw new Error('OpenCode process-tree cleanup remains unconfirmed');
      }
      const previous = normalizeExecutionMode(opts);
      opts.workflow = mode.workflow;
      opts.phase = mode.phase;
      opts.capabilityEpoch = mode.capabilityEpoch;
      if (await replaceTransport()) {
        briefRequired = true;
        return;
      }
      opts.workflow = previous.workflow;
      opts.phase = previous.phase;
      opts.capabilityEpoch = previous.capabilityEpoch;
      throw new Error('OpenCode process-tree cleanup could not be confirmed for the mode change');
    },
    interrupt() {
      if (queued) {
        queued = false;
        turnSequence += 1;
        onEvent({ type: 'turn-end', agent: AGENT, stopReason: 'interrupted' });
        return;
      }
      if (!turnOpen) return;
      turnSequence += 1;
      turnOpen = false;
      onEvent({ type: 'turn-end', agent: AGENT, stopReason: 'interrupted' });
      const interrupted = transport;
      if (!interrupted) return;
      const cancelled = interrupted.cancel().catch(() => {});
      void beginTransportCleanup(interrupted, cancelled);
    },
    dispose() {
      if (disposalPromise) return disposalPromise;
      disposed = true;
      credentialRefreshPending = false;
      queued = false;
      turnSequence += 1;
      const current = transport;
      let cancelled = Promise.resolve();
      if (turnOpen) {
        turnOpen = false;
        cancelled = current?.cancel().catch(() => {}) ?? cancelled;
      }
      const completion = activeCompletion;
      void beginTransportCleanup(current, cancelled);
      disposalPromise = (async () => {
        if (completion) await completion.catch(() => {});
        await waitForTransportCleanups();
        if (!cleanupUncertain && opts.isolatedHome) {
          if (!flushCredentialMirror(opts.isolatedHome)) cleanupUncertain = true;
        }
        return !cleanupUncertain;
      })();
      return disposalPromise;
    },
  };
}
