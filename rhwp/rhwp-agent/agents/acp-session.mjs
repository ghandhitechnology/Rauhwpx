import spawn from 'cross-spawn';
import { Readable, Writable } from 'node:stream';
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import {
  processTreeSpawnOptions,
  terminateProcessTree,
} from '../process-tree.mjs';

const PASSTHROUGH = { parse: (value) => value };

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
  /** @type {AbortController|null} */
  let promptController = null;
  let promptSequence = 0;
  /** @type {{promptId:string, resolve:(response:any)=>void}|null} */
  let pendingPromptCompletion = null;
  /** @type {string|null} */
  let selectedModel = null;
  let disposed = false;

  const app = client({ name: clientName });
  app.onRequest(methods.client.session.requestPermission, (ctx) => (
    acpPermissionResponse(
      ctx.params?.options,
      getUnrestricted() || isRhwpAcpPermissionRequest(ctx.params),
    )
  ));
  // Register this as a custom parser as well as a typed method. Grok has shipped private
  // sessionUpdate variants; a pass-through parser keeps those extensions observable.
  app.onNotification(String(methods.client.session.update), PASSTHROUGH, (ctx) => {
    const notification = ctx.params;
    if (!notification || String(notification.sessionId ?? '') !== String(sessionId ?? '')) return;
    // session/load may replay the entire transcript before the next prompt. Adapters already
    // rendered those turns, so only the active prompt is a provider update for this transport.
    if (!promptActive) return;
    promptUpdateSeen = true;
    onSessionUpdate(notification.update, notification);
  });
  for (const entry of requestHandlers) {
    app.onRequest(String(entry.method), PASSTHROUGH, (ctx) => entry.handler({
      ...ctx,
      signal: combineSignals(ctx.signal, promptController?.signal),
    }));
  }
  for (const entry of notificationHandlers) {
    app.onNotification(String(entry.method), PASSTHROUGH, (ctx) => entry.handler(ctx));
  }
  for (const method of promptCompletionMethods) {
    app.onNotification(String(method), PASSTHROUGH, (ctx) => {
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

  function clearConnection() {
    connection = null;
    context = null;
    initializeResponse = null;
    setupResponse = null;
    startPromise = null;
    proc = null;
  }

  async function closeProcess() {
    const oldProc = proc;
    const oldConnection = connection;
    promptController?.abort(new Error(`${clientName} ACP connection closed`));
    clearConnection();
    try { oldConnection?.close(); } catch {}
    if (!oldProc) return;
    try {
      if (oldProc.exitCode === null && oldProc.signalCode === null) {
        await terminateProcess(oldProc);
      }
    } catch {}
  }

  async function startOnce() {
    if (disposed) throw new Error(`${clientName} ACP session is disposed`);
    const child = spawnProcess(command, args, {
      ...processTreeSpawnOptions(),
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc = child;
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      onStderr(String(chunk));
    });
    const stream = ndJsonStream(
      /** @type {any} */ (Writable.toWeb(child.stdin)),
      /** @type {any} */ (Readable.toWeb(child.stdout)),
    );
    const connected = app.connect(stream);
    connection = connected;
    const agentContext = connected.agent;
    context = agentContext;

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
    const rpc = async (method, params) => Promise.race([
      agentContext.request(method, params),
      earlyExit,
    ]);

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
    onSessionStarted({ sessionId, initializeResponse, setupResponse });
    return { sessionId, initializeResponse, setupResponse };
  }

  async function start() {
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

  /** @param {{modeAliases?:string[], model?:string|null, effort?:string|null}} [selection] */
  async function configure({ modeAliases = [], model = null, effort = null } = {}) {
    await start();
    const agentContext = context;
    if (!agentContext) throw new Error(`${clientName} ACP session is not started`);
    const modes = setupResponse?.modes;
    if (Array.isArray(modes?.availableModes) && modeAliases.length > 0) {
      const aliases = modeAliases.map((value) => String(value).toLowerCase());
      const target = modes.availableModes.find((mode) => (
        aliases.includes(String(mode?.id ?? '').toLowerCase())
        || aliases.includes(String(mode?.name ?? '').toLowerCase())
      ));
      if (target?.id && target.id !== modes.currentModeId) {
        await agentContext.request(methods.agent.session.setMode, { sessionId, modeId: target.id });
        modes.currentModeId = target.id;
      }
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
    if (setModelMethod && requestedModel && requestedModel !== selectedModel) {
      await agentContext.request(String(setModelMethod), { sessionId, modelId: requestedModel });
      selectedModel = requestedModel;
    }
  }

  async function prompt(text) {
    await start();
    const agentContext = context;
    if (!agentContext) throw new Error(`${clientName} ACP session is not started`);
    promptUpdateSeen = false;
    promptActive = true;
    promptController = new AbortController();
    const promptId = `${clientName}-prompt-${++promptSequence}`;
    const completion = promptCompletionMethods.length > 0
      ? new Promise((resolve) => { pendingPromptCompletion = { promptId, resolve }; })
      : null;
    try {
      const rpc = agentContext.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: String(text) }],
        ...(completion ? { _meta: { promptId, requestId: promptId } } : {}),
      });
      return await (completion ? Promise.race([rpc, completion]) : rpc);
    } finally {
      promptActive = false;
      promptController = null;
      pendingPromptCompletion = null;
    }
  }

  async function cancel() {
    if (!context || !sessionId) return;
    promptController?.abort(new Error(`${clientName} ACP prompt cancelled`));
    pendingPromptCompletion?.resolve({ stopReason: 'cancelled' });
    await context.notify(methods.agent.session.cancel, { sessionId });
  }

  async function restart() {
    if (promptActive) throw new Error('ACP transport can only restart between turns');
    await closeProcess();
  }

  async function dispose() {
    disposed = true;
    await closeProcess();
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
    isStarted: () => Boolean(context && setupResponse),
  };
}
