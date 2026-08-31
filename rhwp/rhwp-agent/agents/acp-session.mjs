import spawn from 'cross-spawn';
import { Readable, Transform, Writable } from 'node:stream';
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import {
  PROCESS_TREE_CLEANUP_OUTCOME,
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExitOutcome,
  terminateProcessTree,
} from '../process-tree.mjs';

const PASSTHROUGH = { parse: (value) => value };
const MAX_PROVIDER_FRAME_BYTES = 8 * 1024 * 1024;

export function createBoundedNdjsonTransform(maxFrameBytes = MAX_PROVIDER_FRAME_BYTES) {
  let pendingBytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      let segmentStart = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a) continue;
        pendingBytes += index - segmentStart;
        if (pendingBytes > maxFrameBytes) {
          callback(new Error(`ACP provider frame exceeded ${maxFrameBytes} bytes`));
          return;
        }
        pendingBytes = 0;
        segmentStart = index + 1;
      }
      pendingBytes += bytes.length - segmentStart;
      if (pendingBytes > maxFrameBytes) {
        callback(new Error(`ACP provider frame exceeded ${maxFrameBytes} bytes`));
        return;
      }
      callback(null, bytes);
    },
  });
}

/** @typedef {{ method: string, handler: (context: any) => any }} AcpHandler */
/**
 * @typedef {Object} PersistentAcpOptions
 * @property {string} clientName
 * @property {string} command
 * @property {string[]} args
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string|null} [authMethodId]
 * @property {any[]} [mcpServers]
 * @property {string|null} [resumeSessionId]
 * @property {AcpHandler[]} [requestHandlers]
 * @property {AcpHandler[]} [notificationHandlers]
 * @property {string[]} [promptCompletionMethods]
 * @property {string|null} [setModelMethod]
 * @property {boolean} [isolatePrompts] Restart the ACP/MCP process tree after every prompt.
 * @property {() => boolean} [getUnrestricted]
 * @property {(update:any, notification:any) => void} [onSessionUpdate]
 * @property {(text:string) => void} [onStderr]
 * @property {(info:any) => void} [onSessionStarted]
 */

/** Convert the backend MCP runtime description to ACP's stdio-server shape. */
export function acpMcpServer(name, runtime) {
  return {
    name,
    command: String(runtime.command),
    args: (runtime.args ?? []).map(String),
    env: Object.entries(runtime.env ?? {}).map(([key, value]) => ({
      name: key,
      value: String(value),
    })),
  };
}

/** Pick an advertised permission response without inventing an option ID. */
/**
 * @param {any[]} options
 * @param {boolean} unrestricted
 * @returns {import('@agentclientprotocol/sdk').RequestPermissionResponse}
 */
export function acpPermissionResponse(options, unrestricted) {
  const list = Array.isArray(options) ? options : [];
  const preferredKinds = unrestricted
    ? ['allow_always', 'allow_once']
    : ['reject_always', 'reject_once'];
  for (const kind of preferredKinds) {
    const option = list.find((candidate) => candidate?.kind === kind);
    if (option?.optionId) {
      return { outcome: { outcome: 'selected', optionId: String(option.optionId) } };
    }
  }
  return { outcome: { outcome: 'cancelled' } };
}

/** Select a provider-advertised mode without silently inventing support. */
export function selectAcpMode(modes, modeAliases = [], {
  required = false,
  clientName = 'Provider',
} = {}) {
  const aliases = modeAliases.map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  const available = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
  const target = available.find((mode) => (
    aliases.includes(String(mode?.id ?? '').toLowerCase())
    || aliases.includes(String(mode?.name ?? '').toLowerCase())
  ));
  const selectable = target && String(target.id ?? '').trim() ? target : null;
  if (!selectable && required) {
    const requested = aliases.length ? aliases.join(', ') : 'unspecified';
    throw new Error(`${clientName} ACP does not advertise required mode (${requested})`);
  }
  return selectable;
}

/** The hub remains the policy authority for its own MCP tools. In safe/plan
 * modes ACP must still allow those calls to reach phase and revision gates,
 * while unrelated provider tools keep the provider's deny response. */
export function isRhwpAcpPermissionRequest(params) {
  const name = typeof params?.toolCall?.name === 'string' ? params.toolCall.name : '';
  return /^(?:mcp__rhwp__|rhwp(?:__|[.:/]))/i.test(name);
}

function configValues(option) {
  if (option?.type !== 'select' || !Array.isArray(option.options)) return [];
  return option.options.flatMap((entry) => Array.isArray(entry?.options) ? entry.options : [entry]);
}

function matchConfigValue(option, requested) {
  const wanted = String(requested ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const exact = configValues(option).find((entry) => String(entry?.value ?? '').toLowerCase() === wanted);
  if (exact) return String(exact.value);
  const byName = configValues(option).find((entry) => String(entry?.name ?? '').toLowerCase() === wanted);
  return byName ? String(byName.value) : null;
}

function findConfig(options, category, id) {
  return (Array.isArray(options) ? options : []).find((option) => (
    option?.category === category || option?.id === id
  ));
}

function combineSignals(first, second) {
  if (!second) return first;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abort = () => controller.abort(first.reason ?? second.reason);
  if (first.aborted || second.aborted) abort();
  else {
    first.addEventListener('abort', abort, { once: true });
    second.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

/**
 * Long-lived ACP client. It deliberately does not project provider events: adapters retain
 * their established event semantics and receive raw session/update payloads here.
 * @param {PersistentAcpOptions} options
 * @param {{spawnProcess?:Function, terminateProcess?:(child:any)=>unknown}} [dependencies]
 */
export function createPersistentAcpSession({
  clientName,
  command,
  args,
  cwd,
  env,
  authMethodId,
  mcpServers = [],
  resumeSessionId = null,
  requestHandlers = [],
  notificationHandlers = [],
  promptCompletionMethods = [],
  setModelMethod = null,
  isolatePrompts = true,
  getUnrestricted = () => false,
  onSessionUpdate = () => {},
  onStderr = () => {},
  onSessionStarted = () => {},
}, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
} = {}) {
  /** @type {any} */
  let proc = null;
  /** @type {any} */
  let connection = null;
  /** @type {any} */
  let context = null;
  /** @type {any} */
  let initializeResponse = null;
  /** @type {any} */
  let setupResponse = null;
  /** @type {string|null} */
  let sessionId = resumeSessionId ? String(resumeSessionId) : null;
  /** @type {Promise<any>|null} */
  let startPromise = null;
  let promptUpdateSeen = false;
  let promptActive = false;
  /** @type {number|null} */
  let promptGeneration = null;
  /** @type {AbortController|null} */
  let promptController = null;
  let promptSequence = 0;
  /** @type {{promptId:string, resolve:(response:any)=>void}|null} */
  let pendingPromptCompletion = null;
  let connectionGeneration = 0;
  /** @type {{ generation:number, model:string } | null} */
  let selectedModel = null;
  let disposed = false;
  // Once any process-tree proof is unavailable or fails, later no-op disposal
  // must not turn that uncertainty back into success.
  let hadUnprovenCleanup = false;
  /** @type {{ child: any, outcome: 'proven'|'failed'|'unavailable'|null, released: boolean, natural: boolean, completion: Promise<any>|null } | null} */
  let pendingProcessCleanup = null;
  const processLifecycleStates = new WeakMap();
  const completedProcessCleanups = new WeakMap();

  function createGenerationApp(child, generation) {
    const generationIsCurrent = () => proc === child && connectionGeneration === generation;
    const promptIsCurrent = () => generationIsCurrent()
      && promptActive
      && promptGeneration === generation
      && promptController !== null;
    const generationApp = client({ name: clientName });
    generationApp.onRequest(methods.client.session.requestPermission, (ctx) => {
      if (!promptIsCurrent()) throw new Error(`${clientName} ACP request belongs to a stale prompt`);
      return acpPermissionResponse(
        ctx.params?.options,
        getUnrestricted() || isRhwpAcpPermissionRequest(ctx.params),
      );
    });
    // Register this as a custom parser as well as a typed method. Grok has shipped private
    // sessionUpdate variants; a pass-through parser keeps those extensions observable.
    generationApp.onNotification(String(methods.client.session.update), PASSTHROUGH, (ctx) => {
      if (!promptIsCurrent()) return;
      const notification = ctx.params;
      if (!notification || String(notification.sessionId ?? '') !== String(sessionId ?? '')) return;
      // session/load may replay the entire transcript before the next prompt. Adapters already
      // rendered those turns, so only the active prompt is a provider update for this transport.
      promptUpdateSeen = true;
      onSessionUpdate(notification.update, notification);
    });
    for (const entry of requestHandlers) {
      generationApp.onRequest(String(entry.method), PASSTHROUGH, (ctx) => {
        if (!promptIsCurrent()) throw new Error(`${clientName} ACP request belongs to a stale prompt`);
        const controller = promptController;
        if (!controller) throw new Error(`${clientName} ACP prompt is no longer active`);
        return entry.handler({
          ...ctx,
          signal: combineSignals(ctx.signal, controller.signal),
        });
      });
    }
    for (const entry of notificationHandlers) {
      generationApp.onNotification(String(entry.method), PASSTHROUGH, (ctx) => {
        if (!promptIsCurrent()) return;
        return entry.handler(ctx);
      });
    }
    for (const method of promptCompletionMethods) {
      generationApp.onNotification(String(method), PASSTHROUGH, (ctx) => {
        if (!promptIsCurrent()) return;
        const params = ctx.params ?? {};
        const pending = pendingPromptCompletion;
        if (!pending || String(params.sessionId ?? '') !== String(sessionId ?? '')) return;
        if (params.promptId && String(params.promptId) !== pending.promptId) return;
        const allowed = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
        pending.resolve({
          stopReason: allowed.has(params.stopReason) ? params.stopReason : 'end_turn',
          _meta: {
            sessionId,
            promptId: params.promptId ?? pending.promptId,
            ...(params.agentResult !== undefined ? { agentResult: params.agentResult } : {}),
          },
        });
      });
    }
    return generationApp;
  }

  function clearConnection() {
    connection = null;
    context = null;
    initializeResponse = null;
    setupResponse = null;
    startPromise = null;
  }

  function invalidateProcess(child, reason) {
    if (proc !== child) return;
    promptController?.abort(reason);
    const oldConnection = connection;
    clearConnection();
    try { oldConnection?.close(); } catch {}
  }

  function trackProcessLifecycle(child) {
    /** @type {{ exited:boolean, closed:boolean, code:number|null, signal:NodeJS.Signals|null, reason:Error|null, startupCompleted:boolean, promptActiveAtExit:boolean, forcedCleanup:boolean }} */
    const state = {
      exited: false,
      closed: false,
      code: null,
      signal: null,
      reason: null,
      startupCompleted: false,
      promptActiveAtExit: false,
      forcedCleanup: false,
    };
    processLifecycleStates.set(child, state);
    const markExited = (code, signal) => {
      if (state.exited) return;
      state.exited = true;
      state.code = code ?? null;
      state.signal = signal ?? null;
      state.promptActiveAtExit = promptActive;
      state.reason = new Error(
        `${clientName} ACP exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})`,
      );
      const reason = state.reason;
      invalidateProcess(child, reason);
      // `close` can be held indefinitely by a descendant that inherited stdio.
      // Start tree cleanup as soon as the leader exits.
      void beginProcessCleanup(child, false);
    };
    child.once?.('exit', markExited);
    child.once?.('close', (code, signal) => {
      if (!state.exited) markExited(code, signal);
      state.closed = true;
      state.code ??= code ?? null;
      state.signal ??= signal ?? null;
      invalidateProcess(child, new Error(`${clientName} ACP connection closed`));
      void beginProcessCleanup(child, false).then(() => {
        maybeReleaseNaturalClose(child);
      });
    });
    if (child.exitCode != null || child.signalCode != null) {
      markExited(child.exitCode ?? null, child.signalCode ?? null);
    }
    return state;
  }

  function maybeReleaseNaturalClose(child) {
    const state = processLifecycleStates.get(child);
    const cleanup = pendingProcessCleanup;
    if (!state || !cleanup || cleanup.child !== child
      || cleanup.outcome !== PROCESS_TREE_CLEANUP_OUTCOME.UNAVAILABLE
      || !state.closed
      || state.code !== 0
      || !state.startupCompleted
      || state.promptActiveAtExit
      || state.forcedCleanup) return false;
    // A drained successful close can release this dead local reference on
    // Windows, where the expired PID cannot yield a tree proof. The owning ACP
    // session remains quarantined: it cannot start, prompt, configure, or let
    // final disposal delete/reuse the workspace.
    cleanup.released = true;
    cleanup.natural = true;
    if (proc === child) proc = null;
    if (pendingProcessCleanup === cleanup) pendingProcessCleanup = null;
    return true;
  }

  function beginProcessCleanup(child, forced = false) {
    const state = processLifecycleStates.get(child);
    if (state) state.forcedCleanup ||= forced;
    const completed = completedProcessCleanups.get(child);
    if (completed) return Promise.resolve(completed);
    const current = pendingProcessCleanup;
    if (current && current.child === child) {
      return /** @type {Promise<any>} */ (current.completion);
    }
    /** @type {{ child: any, outcome: 'proven'|'failed'|'unavailable'|null, released: boolean, natural: boolean, completion: Promise<any>|null }} */
    const cleanup = {
      child,
      outcome: null,
      released: false,
      natural: false,
      completion: null,
    };
    const completion = terminateAndWaitForProcessTreeExitOutcome(child, { terminateProcess })
      .catch(() => PROCESS_TREE_CLEANUP_OUTCOME.FAILED)
      .then((outcome) => {
        cleanup.outcome = outcome;
        if (outcome !== PROCESS_TREE_CLEANUP_OUTCOME.PROVEN) {
          hadUnprovenCleanup = true;
        }
        cleanup.released = outcome === PROCESS_TREE_CLEANUP_OUTCOME.PROVEN;
        completedProcessCleanups.set(child, cleanup);
        if (!cleanup.released) maybeReleaseNaturalClose(child);
        if (cleanup.released && proc === child) proc = null;
        if (cleanup.released && pendingProcessCleanup === cleanup) pendingProcessCleanup = null;
        return cleanup;
      });
    cleanup.completion = completion;
    pendingProcessCleanup = cleanup;
    return completion;
  }

  async function closeProcess() {
    const oldProc = proc;
    const oldConnection = connection;
    promptController?.abort(new Error(`${clientName} ACP connection closed`));
    clearConnection();
    try { oldConnection?.close(); } catch {}
    if (!oldProc) {
      return { outcome: PROCESS_TREE_CLEANUP_OUTCOME.PROVEN, released: true };
    }
    return beginProcessCleanup(oldProc, true);
  }

  async function startOnce() {
    if (disposed) throw new Error(`${clientName} ACP session is disposed`);
    if (proc) throw new Error(`${clientName} ACP process-tree cleanup is still pending`);
    const child = spawnProcess(command, args, {
      ...processTreeSpawnOptions(),
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc = child;
    const lifecycleState = trackProcessLifecycle(child);
    if (lifecycleState.exited) throw lifecycleState.reason;
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      onStderr(String(chunk));
    });
    const boundedStdout = createBoundedNdjsonTransform();
    boundedStdout.once('error', (error) => {
      onStderr(`${error.message}\n`);
      void beginProcessCleanup(child);
    });
    child.stdout.pipe(boundedStdout);
    const stream = ndJsonStream(
      /** @type {any} */ (Writable.toWeb(child.stdin)),
      /** @type {any} */ (Readable.toWeb(boundedStdout)),
    );
    connectionGeneration += 1;
    const generation = connectionGeneration;
    const generationApp = createGenerationApp(child, generation);
    const connected = generationApp.connect(stream);
    connection = connected;
    const agentContext = connected.agent;
    context = agentContext;
    if (lifecycleState.exited || proc !== child) {
      invalidateProcess(child, lifecycleState.reason ?? new Error(`${clientName} ACP exited during startup`));
      throw lifecycleState.reason ?? new Error(`${clientName} ACP exited during startup`);
    }

    const earlyExit = new Promise((_, reject) => {
      const fail = (error) => {
        // A native request handler may be blocked in requestUserInput while
        // the provider disappears. Abort the prompt-scoped signal immediately
        // so the hub expires the interaction instead of retaining it forever.
        promptController?.abort(error);
        reject(error);
      };
      child.once('error', fail);
      child.once('exit', (code, signal) => {
        const suffix = stderr.trim() ? `\n${stderr.trim()}` : '';
        fail(new Error(`${clientName} ACP exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})${suffix}`));
      });
    });
    const rpc = async (method, params) => {
      if (lifecycleState.exited || proc !== child) {
        throw lifecycleState.reason ?? new Error(`${clientName} ACP exited during startup`);
      }
      return Promise.race([
        agentContext.request(method, params),
        earlyExit,
      ]);
    };

    initializeResponse = await rpc(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: clientName, version: '0.0.0' },
    });
    if (Number(initializeResponse?.protocolVersion) !== Number(PROTOCOL_VERSION)) {
      throw new Error(`${clientName} ACP protocol ${initializeResponse?.protocolVersion ?? 'unknown'} is unsupported`);
    }
    if (isolatePrompts && initializeResponse?.agentCapabilities?.loadSession !== true) {
      throw new Error(`${clientName} ACP cannot isolate prompts without session resume support`);
    }
    if (authMethodId) {
      await rpc(methods.agent.authenticate, { methodId: authMethodId });
    }

    const sessionRequest = { cwd, mcpServers };
    if (sessionId) {
      if (initializeResponse?.agentCapabilities?.loadSession !== true) {
        throw new Error(`${clientName} ACP cannot resume session ${sessionId}`);
      }
      setupResponse = await rpc(methods.agent.session.load, { ...sessionRequest, sessionId });
    } else {
      setupResponse = await rpc(methods.agent.session.new, sessionRequest);
      if (!setupResponse?.sessionId) throw new Error(`${clientName} ACP did not return a session ID`);
      sessionId = String(setupResponse.sessionId);
    }
    lifecycleState.startupCompleted = true;
    onSessionStarted({ sessionId, initializeResponse, setupResponse });
    return { sessionId, initializeResponse, setupResponse };
  }

  async function start() {
    if (hadUnprovenCleanup) {
      throw new Error(`${clientName} ACP process-tree cleanup remains unconfirmed`);
    }
    if (context && sessionId && setupResponse) {
      return { sessionId, initializeResponse, setupResponse };
    }
    if (!startPromise) {
      startPromise = startOnce().catch(async (error) => {
        await closeProcess();
        throw error;
      });
    }
    return startPromise;
  }

  async function setConfig(configId, value) {
    if (hadUnprovenCleanup) {
      throw new Error(`${clientName} ACP process-tree cleanup remains unconfirmed`);
    }
    if (!configId || value === null || value === undefined) return;
    const agentContext = context;
    if (!agentContext) throw new Error(`${clientName} ACP session is not started`);
    const response = await agentContext.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      ...(typeof value === 'boolean' ? { type: 'boolean', value } : { value: String(value) }),
    });
    if (Array.isArray(response?.configOptions) && setupResponse) setupResponse.configOptions = response.configOptions;
  }

  /** @param {{modeAliases?:string[], requireModeMatch?:boolean, model?:string|null, effort?:string|null}} [selection] */
  async function configure({
    modeAliases = [], requireModeMatch = false, model = null, effort = null,
  } = {}) {
    if (hadUnprovenCleanup) {
      throw new Error(`${clientName} ACP process-tree cleanup remains unconfirmed`);
    }
    await start();
    const agentContext = context;
    if (!agentContext) throw new Error(`${clientName} ACP session is not started`);
    const modes = setupResponse?.modes;
    const target = selectAcpMode(modes, modeAliases, { required: requireModeMatch, clientName });
    if (target?.id && target.id !== modes.currentModeId) {
      await agentContext.request(methods.agent.session.setMode, { sessionId, modeId: target.id });
      modes.currentModeId = target.id;
    }
    const configs = setupResponse?.configOptions;
    if (!setModelMethod) {
      const modelOption = findConfig(configs, 'model', 'model');
      const modelValue = matchConfigValue(modelOption, model);
      if (modelValue && modelValue !== modelOption.currentValue) await setConfig(modelOption.id, modelValue);
    }
    const effortOption = findConfig(configs, 'thought_level', 'reasoning');
    const effortValue = matchConfigValue(effortOption, effort);
    if (effortValue && effortValue !== effortOption.currentValue) await setConfig(effortOption.id, effortValue);
    const requestedModel = String(model ?? '').trim();
    if (setModelMethod && requestedModel && (
      selectedModel?.generation !== connectionGeneration
      || selectedModel.model !== requestedModel
    )) {
      const generation = connectionGeneration;
      await agentContext.request(String(setModelMethod), { sessionId, modelId: requestedModel });
      // A restart may invalidate this connection while set_model is in flight.
      // Never let an old response suppress selection on the next generation.
      if (context === agentContext && connectionGeneration === generation) {
        selectedModel = { generation, model: requestedModel };
      }
    }
  }

  async function prompt(text) {
    if (hadUnprovenCleanup) {
      throw new Error(`${clientName} ACP process-tree cleanup remains unconfirmed`);
    }
    if (promptActive) throw new Error(`${clientName} ACP already has an active prompt`);
    await start();
    const agentContext = context;
    if (!agentContext) throw new Error(`${clientName} ACP session is not started`);
    const generation = connectionGeneration;
    promptUpdateSeen = false;
    promptActive = true;
    promptGeneration = generation;
    const controller = new AbortController();
    promptController = controller;
    const promptId = `${clientName}-prompt-${++promptSequence}`;
    const completion = promptCompletionMethods.length > 0
      ? new Promise((resolve) => { pendingPromptCompletion = { promptId, resolve }; })
      : null;
    let response;
    let promptError = null;
    try {
      const rpc = agentContext.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: String(text) }],
        ...(completion ? { _meta: { promptId, requestId: promptId } } : {}),
      });
      response = await (completion ? Promise.race([rpc, completion]) : rpc);
    } catch (error) {
      promptError = error;
    } finally {
      if (promptGeneration === generation && promptController === controller) {
        promptActive = false;
        promptGeneration = null;
        promptController = null;
        pendingPromptCompletion = null;
      }
    }
    if (isolatePrompts) {
      // A terminal ACP response is not proof that the provider's MCP child or
      // background work is quiescent. End this process generation before the
      // adapter can publish turn completion; the next turn resumes the same
      // ACP session in a fresh process tree.
      const cleanup = await closeProcess();
      if (cleanup.outcome !== PROCESS_TREE_CLEANUP_OUTCOME.PROVEN || hadUnprovenCleanup) {
        throw new Error(`${clientName} ACP process-tree cleanup could not be confirmed after the prompt`);
      }
    }
    if (promptError) throw promptError;
    return response;
  }

  async function cancel() {
    if (!context || !sessionId) return;
    promptController?.abort(new Error(`${clientName} ACP prompt cancelled`));
    pendingPromptCompletion?.resolve({ stopReason: 'cancelled' });
    await context.notify(methods.agent.session.cancel, { sessionId });
  }

  async function restart() {
    if (promptActive) throw new Error('ACP transport can only restart between turns');
    if (hadUnprovenCleanup) {
      throw new Error(`${clientName} ACP process-tree cleanup remains unconfirmed`);
    }
    const cleanup = await closeProcess();
    if (!cleanup.released) {
      throw new Error(`${clientName} ACP process-tree cleanup could not be confirmed`);
    }
  }

  async function dispose() {
    disposed = true;
    const cleanup = await closeProcess();
    return cleanup.outcome === PROCESS_TREE_CLEANUP_OUTCOME.PROVEN
      && !hadUnprovenCleanup;
  }

  return {
    start,
    configure,
    prompt,
    cancel,
    restart,
    dispose,
    getSessionId: () => sessionId,
    hasSeenPromptUpdate: () => promptUpdateSeen,
    isCleanupUncertain: () => hadUnprovenCleanup,
    isStarted: () => Boolean(context && setupResponse),
  };
}
