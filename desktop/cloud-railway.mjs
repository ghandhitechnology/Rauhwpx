import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerError } from './cloud-app-server.mjs';
import { sandboxCredentialVariables } from './provider-auth.mjs';

export const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
export const RAILWAY_DEFAULT_IMAGE = 'ghcr.io/ghandhitechnology/rauhwpx-cloud:1.1.0-edge.12';
export const SANDBOX_BASE_PATH = '/rauhwpx-cloud';
export const SANDBOX_PORT = 7740;

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DEPLOY_TIMEOUT_MS = 12 * 60_000;
const HEALTH_TIMEOUT_MS = 5 * 60_000;
const QUERY_MAX_ATTEMPTS = 4;
const QUERY_RETRY_BASE_MS = 400;
const QUERY_RETRY_MAX_MS = 5_000;
const RECONCILE_MAX_ATTEMPTS = 10;
const RECONCILE_BASE_MS = 500;
const RECONCILE_MAX_MS = 3_000;

/** Railway 배포 상태를 샌드박스 수명주기로 좁힌다. */
const DEPLOY_STATUS_LIFECYCLE = Object.freeze({
  INITIALIZING: 'provisioning',
  QUEUED: 'provisioning',
  BUILDING: 'provisioning',
  DEPLOYING: 'provisioning',
  WAITING: 'provisioning',
  NEEDS_APPROVAL: 'provisioning',
  SUCCESS: 'ready',
  SLEEPING: 'ready',
  FAILED: 'error',
  CRASHED: 'error',
  REMOVED: 'idle',
  SKIPPED: 'idle',
});

const SERVICE_CREATE = `
mutation RauhwpxServiceCreate($input: ServiceCreateInput!) {
  serviceCreate(input: $input) { id name }
}`;

const SERVICE_DOMAIN_CREATE = `
mutation RauhwpxServiceDomainCreate($input: ServiceDomainCreateInput!) {
  serviceDomainCreate(input: $input) { id domain }
}`;

const SERVICE_DOMAINS = `
query RauhwpxServiceDomains($projectId: String!, $environmentId: String!, $serviceId: String!) {
  domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
    serviceDomains { id domain targetPort }
  }
}`;

const PROJECT_SERVICES = `
query RauhwpxProjectServices($projectId: String!) {
  project(id: $projectId) {
    services { edges { node { id name } } }
  }
}`;

const SERVICE_INSTANCE_UPDATE = `
mutation RauhwpxServiceInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}`;

const SERVICE_DELETE = `
mutation RauhwpxServiceDelete($id: String!, $environmentId: String) {
  serviceDelete(id: $id, environmentId: $environmentId)
}`;

const LATEST_DEPLOYMENT = `
query RauhwpxLatestDeployment($projectId: String!, $environmentId: String!, $serviceId: String!) {
  deployments(
    first: 1
    input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId }
  ) {
    edges { node { id status statusUpdatedAt } }
  }
}`;

const DEPLOYMENT_LOGS = `
query RauhwpxDeploymentLogs($deploymentId: String!) {
  buildLogs(deploymentId: $deploymentId, limit: 30) { message }
  runtimeLogs: deploymentLogs(deploymentId: $deploymentId, limit: 30) { message }
}`;

function trimmed(value, limit = 256) {
  const result = String(value ?? '').trim();
  return result.length > limit ? '' : result;
}

export function railwayConfigFromEnv(environment = process.env) {
  return {
    token: trimmed(environment.RAUHWpx_RAILWAY_TOKEN, 4096),
    projectId: trimmed(environment.RAUHWpx_RAILWAY_PROJECT_ID),
    environmentId: trimmed(environment.RAUHWpx_RAILWAY_ENVIRONMENT_ID),
    image: trimmed(environment.RAUHWpx_RAILWAY_IMAGE, 512) || RAILWAY_DEFAULT_IMAGE,
    region: trimmed(environment.RAUHWpx_RAILWAY_REGION, 64),
    apiUrl: trimmed(environment.RAUHWpx_RAILWAY_API_URL, 2048) || RAILWAY_API_URL,
  };
}

function missingConfiguration(config) {
  const missing = [];
  if (!config.token) missing.push('RAUHWpx_RAILWAY_TOKEN');
  if (!config.projectId) missing.push('RAUHWpx_RAILWAY_PROJECT_ID');
  if (!config.environmentId) missing.push('RAUHWpx_RAILWAY_ENVIRONMENT_ID');
  return missing;
}

function sandboxName() {
  return `rauhwpx-sandbox-${randomBytes(4).toString('hex')}`;
}

function graphqlMessage(errors) {
  const first = Array.isArray(errors) ? errors[0] : null;
  return trimmed(first?.message, 1024) || 'Railway API returned an error';
}

function notFound(errors) {
  return (Array.isArray(errors) ? errors : []).some((error) => (
    /not found|does not exist|no such/i.test(String(error?.message ?? ''))
  ));
}

function transientGraphqlFailure(errors) {
  return (Array.isArray(errors) ? errors : []).some((error) => {
    const code = String(error?.extensions?.code ?? '').toUpperCase();
    if (['INTERNAL_SERVER_ERROR', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'TOO_MANY_REQUESTS'].includes(code)) {
      return true;
    }
    return /internal server error|rate limit|temporar(?:y|ily) unavailable|timed?\s*out|try again/i
      .test(String(error?.message ?? ''));
  });
}

function transientHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function readResponseText(response, signal) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AppServerError('Railway API response is too large', { code: 'PROVIDER_RESPONSE_INVALID' });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let aborted = signal?.aborted === true;
  const abort = () => {
    aborted = true;
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (aborted) abort();
  try {
    for (;;) {
      if (aborted) throw signal?.reason ?? new Error('Railway API request was cancelled');
      const { done, value } = await reader.read();
      if (aborted) throw signal?.reason ?? new Error('Railway API request was cancelled');
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new AppServerError('Railway API response is too large', { code: 'PROVIDER_RESPONSE_INVALID' });
      }
      chunks.push(chunk);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export function createRailwayServerProvider({
  config = railwayConfigFromEnv(),
  fetchImpl = globalThis.fetch,
  probeHealth,
  acquireReceipt,
  sleep = (ms, options) => delay(ms, undefined, options),
  deployTimeoutMs = DEPLOY_TIMEOUT_MS,
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  queryMaxAttempts = QUERY_MAX_ATTEMPTS,
  retryBaseMs = QUERY_RETRY_BASE_MS,
  reconcileAttempts = RECONCILE_MAX_ATTEMPTS,
  reconcileBaseMs = RECONCILE_BASE_MS,
  random = Math.random,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Railway provider requires fetch');
  if (typeof probeHealth !== 'function') throw new Error('Railway provider requires a health probe');
  if (typeof acquireReceipt !== 'function') throw new Error('Railway provider requires a receipt acquirer');

  const safeQueryAttempts = Math.max(1, Math.min(10, Math.trunc(Number(queryMaxAttempts)) || 1));
  const safeReconcileAttempts = Math.max(1, Math.min(30, Math.trunc(Number(reconcileAttempts)) || 1));

  function retryDelay(attempt) {
    const base = Math.min(QUERY_RETRY_MAX_MS, Math.max(1, Number(retryBaseMs) || 1) * (2 ** attempt));
    const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
    return Math.max(1, Math.round(base * (0.75 + (jitter * 0.5))));
  }

  function reconcileDelay(attempt) {
    return Math.min(RECONCILE_MAX_MS, Math.max(1, Number(reconcileBaseMs) || 1) * (2 ** attempt));
  }

  async function graphqlOnce(document, variables, { signal, allowNotFound = false } = {}) {
    const missing = missingConfiguration(config);
    if (missing.length) {
      throw new AppServerError(
        `App-provided servers are not configured on this build: ${missing.join(', ')}`,
        { code: 'PROVIDER_NOT_CONFIGURED', retryable: false },
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new Error('Railway API request timed out')),
      Math.max(1, Number(requestTimeoutMs) || REQUEST_TIMEOUT_MS),
    );
    let response;
    let text;
    try {
      response = await fetchImpl(config.apiUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ query: document, variables }),
        signal: controller.signal,
        cache: 'no-store',
      });
      text = await readResponseText(response, controller.signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof AppServerError) throw error;
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      throw new AppServerError(`Railway API is unreachable: ${reason?.message ?? error.message}`, {
        code: 'PROVIDER_UNREACHABLE',
        cause: reason ?? error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppServerError('Railway rejected the configured API token', {
        code: 'PROVIDER_UNAUTHORIZED',
        retryable: false,
      });
    }
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch {
      throw new AppServerError('Railway API returned invalid JSON', {
        code: 'PROVIDER_RESPONSE_INVALID',
        retryable: transientHttpStatus(response.status),
      });
    }
    if (payload.errors?.length) {
      if (allowNotFound && notFound(payload.errors)) return null;
      throw new AppServerError(graphqlMessage(payload.errors), {
        code: 'PROVIDER_REJECTED',
        retryable: transientHttpStatus(response.status) || transientGraphqlFailure(payload.errors),
      });
    }
    if (!response.ok) {
      throw new AppServerError(`Railway API failed with HTTP ${response.status}`, {
        code: 'PROVIDER_REJECTED',
        retryable: transientHttpStatus(response.status),
      });
    }
    if (!payload.data || typeof payload.data !== 'object') {
      throw new AppServerError('Railway API returned no data', {
        code: 'PROVIDER_RESPONSE_INVALID',
        retryable: transientHttpStatus(response.status),
      });
    }
    return payload.data;
  }

  async function graphql(document, variables, {
    signal,
    allowNotFound = false,
    retryTransient = false,
    onRetry = null,
  } = {}) {
    const attempts = retryTransient ? safeQueryAttempts : 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await graphqlOnce(document, variables, { signal, allowNotFound });
      } catch (error) {
        lastError = error;
        if (signal?.aborted || error?.retryable !== true || attempt + 1 >= attempts) throw error;
        const delayMs = retryDelay(attempt);
        onRetry?.({ attempt: attempt + 1, delayMs, error });
        await sleep(delayMs, { signal });
      }
    }
    throw lastError;
  }

  function sandboxVariables(bootstrapToken, limits, credentials, selectedProvider = 'codex') {
    return {
      RAUHWpx_HOST: '0.0.0.0',
      RAUHWpx_PORT: String(SANDBOX_PORT),
      PORT: String(SANDBOX_PORT),
      RAUHWpx_BASE_PATH: SANDBOX_BASE_PATH,
      RAUHWpx_BOOTSTRAP_TOKEN: bootstrapToken,
      RAUHWpx_CHANNEL: 'stable',
      RAUHWpx_MAX_RUNNING: String(limits?.maxRunningSessions ?? 2),
      RAUHWpx_MAX_QUEUED: String(limits?.maxQueuedSessions ?? 20),
      RAUHWpx_RUNNER: 'local',
      RAUHWpx_WORKER_UID: '1001',
      RAUHWpx_WORKER_GID: '1001',
      RAUHWpx_WORKER_CONTROL_DIR: '/run/rauhwpx',
      RAUHWpx_WORKSPACE_ROOT: '/var/lib/rauhwpx-workspaces',
      RAUHWpx_DATA_DIR: '/var/lib/rauhwpx-cloud',
      RAUHWpx_SANDBOX_INSTALL_PROVIDER: '0',
      RAUHWpx_SANDBOX_PROVIDER: selectedProvider,
      ...sandboxCredentialVariables(credentials),
    };
  }

  async function latestDeployment(sandbox, { signal, onRetry } = {}) {
    const data = await graphql(LATEST_DEPLOYMENT, {
      projectId: sandbox.projectId || config.projectId,
      environmentId: sandbox.environmentId || config.environmentId,
      serviceId: sandbox.sandboxId,
    }, { signal, allowNotFound: true, retryTransient: true, onRetry });
    if (!data) return null;
    const node = data.deployments?.edges?.[0]?.node;
    return node ? { id: trimmed(node.id), status: trimmed(node.status, 64).toUpperCase() } : null;
  }

  async function deploymentFailureDetail(deployment, { signal } = {}) {
    if (!deployment?.id) return '';
    try {
      const data = await graphql(DEPLOYMENT_LOGS, { deploymentId: deployment.id }, {
        signal,
        allowNotFound: true,
        retryTransient: true,
      });
      const entries = [
        ...(Array.isArray(data?.buildLogs) ? data.buildLogs : []),
        ...(Array.isArray(data?.runtimeLogs) ? data.runtimeLogs : []),
      ];
      const lines = entries.map((entry) => trimmed(entry?.message, 240)).filter(Boolean);
      return lines.slice(-4).join(' ');
    } catch {
      return '';
    }
  }

  async function waitForDeployment(sandbox, { signal, onLine }) {
    const deadline = Date.now() + deployTimeoutMs;
    let attempt = 0;
    let lastStatus = 'PENDING';
    let lastPollError = null;
    for (;;) {
      let deployment = null;
      try {
        deployment = await latestDeployment(sandbox, {
          signal,
          onRetry: ({ error }) => {
            lastPollError = error;
          },
        });
        lastPollError = null;
        lastStatus = deployment?.status ?? lastStatus;
        const lifecycle = deployment ? DEPLOY_STATUS_LIFECYCLE[deployment.status] ?? 'provisioning' : 'provisioning';
        if (lifecycle === 'ready') return deployment;
        if (lifecycle === 'error') {
          const detail = await deploymentFailureDetail(deployment, { signal });
          throw new AppServerError(
            detail
              ? `Railway deployment ended in ${deployment.status}: ${detail}`
              : `Railway deployment ended in ${deployment.status}`,
            { code: 'SANDBOX_DEPLOY_FAILED' },
          );
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (error?.retryable !== true || error?.code === 'SANDBOX_DEPLOY_FAILED') throw error;
        lastPollError = error;
      }
      if (Date.now() >= deadline) {
        const detail = lastPollError
          ? ` Last status check failed: ${trimmed(lastPollError.message, 240)}`
          : ` Last deployment status was ${lastStatus}.`;
        throw new AppServerError(`Railway deployment did not become ready in time.${detail}`, {
          code: 'SANDBOX_DEPLOY_TIMEOUT',
          cause: lastPollError ?? undefined,
        });
      }
      attempt += 1;
      if (lastPollError) {
        onLine(`Railway status is temporarily unavailable (${trimmed(lastPollError.message, 160)}); retrying`);
      } else if (attempt % 4 === 1) {
        onLine(`Waiting for the app sandbox deployment (${deployment?.status ?? lastStatus})`);
      }
      await sleep(Math.min(10_000, 2_000 * attempt), { signal });
    }
  }

  async function waitForHealth(endpoint, { signal, onLine }) {
    const deadline = Date.now() + healthTimeoutMs;
    let attempt = 0;
    let lastError = null;
    for (;;) {
      try {
        const health = await probeHealth(endpoint, { signal });
        if (health?.ok === true && /^ed25519:[A-Za-z0-9_-]{59}$/.test(String(health.serverPublicKey ?? ''))) {
          return health;
        }
        throw new AppServerError('App sandbox returned an invalid health response', {
          code: 'SANDBOX_HEALTH_INVALID',
          retryable: false,
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        // Railway can report deployment success before its generated domain reaches the service.
        if (error?.retryable !== true && error?.status !== 404) throw error;
        lastError = error;
      }
      if (Date.now() >= deadline) {
        throw new AppServerError(
          `App sandbox did not answer its health check: ${lastError?.message ?? 'unknown error'}`,
          { code: 'SANDBOX_UNHEALTHY', cause: lastError ?? undefined },
        );
      }
      attempt += 1;
      if (attempt % 4 === 1) onLine('Waiting for the app sandbox service to answer');
      await sleep(Math.min(8_000, 1_500 * attempt), { signal });
    }
  }

  async function findServiceByName(name, {
    signal,
    onLine = () => {},
    attempts = safeReconcileAttempts,
  } = {}) {
    const maximumAttempts = Math.max(1, Math.min(safeReconcileAttempts, Number(attempts) || 1));
    let lastError = null;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      try {
        const data = await graphql(PROJECT_SERVICES, { projectId: config.projectId }, {
          // This reconciliation loop is already the bounded retry policy. Avoid
          // multiplying the query retry count while Railway is fully offline.
          signal,
          retryTransient: false,
        });
        const service = data.project?.services?.edges
          ?.map((edge) => edge?.node)
          .find((candidate) => candidate?.name === name);
        if (service?.id) return service;
        lastError = null;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        lastError = error;
        if (error?.retryable === false) break;
      }
      if (attempt + 1 < maximumAttempts) {
        if (attempt === 0 || attempt % 3 === 2) {
          onLine(lastError
            ? `Waiting to reconcile the sandbox after a Railway error (${trimmed(lastError.message, 120)})`
            : 'Waiting for Railway to publish the new sandbox service');
        }
        await sleep(reconcileDelay(attempt), signal ? { signal } : {});
      }
    }
    return null;
  }

  async function findServiceById(serviceId, { signal, projectId = config.projectId, attempts = 3 } = {}) {
    const maximumAttempts = Math.max(1, Math.min(safeReconcileAttempts, Number(attempts) || 1));
    let lastError = null;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      try {
        const data = await graphql(PROJECT_SERVICES, { projectId }, {
          signal,
          retryTransient: false,
        });
        lastError = null;
        const service = data.project?.services?.edges
          ?.map((edge) => edge?.node)
          .find((candidate) => candidate?.id === serviceId);
        if (service?.id) return service;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        lastError = error;
        if (error?.retryable === false) throw error;
      }
      if (attempt + 1 < maximumAttempts) await sleep(reconcileDelay(attempt), signal ? { signal } : {});
    }
    // Only a successful final observation may prove absence. A transient error
    // after an earlier empty list leaves the paid service state unknown.
    if (lastError) throw lastError;
    return null;
  }

  function usableDomain(node) {
    const domain = trimmed(node?.domain, 253).toLowerCase();
    if (!domain || !/^(?!-)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) return null;
    return { id: trimmed(node?.id, 128), domain };
  }

  async function findServiceDomain(sandbox, { signal, onLine = () => {} } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < safeReconcileAttempts; attempt += 1) {
      try {
        const data = await graphql(SERVICE_DOMAINS, {
          projectId: sandbox.projectId || config.projectId,
          environmentId: sandbox.environmentId || config.environmentId,
          serviceId: sandbox.sandboxId,
        }, { signal, retryTransient: false });
        const domains = Array.isArray(data.domains?.serviceDomains) ? data.domains.serviceDomains : [];
        const matching = domains.find((candidate) => Number(candidate?.targetPort) === SANDBOX_PORT);
        const recovered = usableDomain(matching);
        if (recovered) return recovered;
        lastError = null;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        lastError = error;
        if (error?.retryable === false) break;
      }
      if (attempt + 1 < safeReconcileAttempts) {
        if (attempt === 0 || attempt % 3 === 2) {
          onLine(lastError
            ? `Waiting to reconcile the sandbox domain after a Railway error (${trimmed(lastError.message, 120)})`
            : 'Waiting for Railway to publish the sandbox domain');
        }
        await sleep(reconcileDelay(attempt), { signal });
      }
    }
    return null;
  }

  async function removeService(sandbox, { signal } = {}) {
    try {
      const data = await graphql(SERVICE_DELETE, {
        id: sandbox.sandboxId,
        environmentId: sandbox.environmentId || config.environmentId || null,
      }, { signal, allowNotFound: true, retryTransient: false });
      return data === null ? 'already-removed' : 'removed';
    } catch (error) {
      // Railway can commit a delete and then return a transport or GraphQL
      // error. Do not replay the mutation; prove the paid service is absent.
      const existing = await findServiceById(sandbox.sandboxId, {
        projectId: sandbox.projectId || config.projectId,
        attempts: Math.min(3, safeReconcileAttempts),
      }).catch((reconcileError) => {
        error.reconcileFailed = reconcileError.message;
        return undefined;
      });
      if (existing === null) return 'removed';
      throw error;
    }
  }

  async function cleanupAmbiguousCreate(serviceName, cancellation, onLine) {
    // Cancellation can race an accepted serviceCreate response. Reconciliation
    // here is deliberately uncancelled and tightly bounded so a user abort
    // cannot strand a billable service that Railway made visible moments later.
    const reconciled = await findServiceByName(serviceName, {
      onLine,
      attempts: Math.min(3, safeReconcileAttempts),
    }).catch((cleanupError) => {
      if (cancellation && typeof cancellation === 'object') cancellation.cleanupFailed = cleanupError.message;
      return null;
    });
    if (!reconciled?.id) return;
    try {
      await removeService({
        sandboxId: reconciled.id,
        environmentId: config.environmentId,
      });
    } catch (cleanupError) {
      if (cancellation && typeof cancellation === 'object') cancellation.cleanupFailed = cleanupError.message;
    }
  }

  return {
    id: 'railway',
    displayName: 'Railway sandbox',
    configuration() {
      const missing = missingConfiguration(config);
      return {
        configured: missing.length === 0,
        missing,
        image: config.image,
        region: config.region,
      };
    },

    async spawn({
      deviceName = 'Rauhwpx desktop',
      limits = null,
      selectedProvider = 'codex',
      credentials = null,
      signal,
      onLine = () => {},
      onSandboxCreated = async () => {},
      onSandboxRemoved = async () => {},
    } = {}) {
      const bootstrapToken = randomBytes(32).toString('base64url');
      const serviceName = sandboxName();
      onLine('Creating an app-provided sandbox');
      let created;
      try {
        created = await graphql(SERVICE_CREATE, {
          input: {
            projectId: config.projectId,
            environmentId: config.environmentId,
            name: serviceName,
            source: { image: config.image },
            variables: sandboxVariables(bootstrapToken, limits, credentials, selectedProvider),
          },
        }, { signal });
      } catch (error) {
        if (signal?.aborted) {
          const cancellation = signal.reason instanceof Error ? signal.reason : error;
          await cleanupAmbiguousCreate(serviceName, cancellation, onLine);
          throw cancellation;
        }
        if (error?.retryable === false) throw error;
        // Never replay serviceCreate after an ambiguous transport/server error:
        // Railway may have committed the mutation before its response was lost.
        let reconciliationError = null;
        const reconciled = await findServiceByName(serviceName, { signal, onLine }).catch((caught) => {
          reconciliationError = caught;
          return null;
        });
        if (signal?.aborted) {
          const cancellation = signal.reason instanceof Error ? signal.reason : reconciliationError ?? error;
          await cleanupAmbiguousCreate(serviceName, cancellation, onLine);
          throw cancellation;
        }
        if (!reconciled) throw error;
        created = { serviceCreate: reconciled };
        onLine('Recovered the sandbox after an interrupted Railway response');
      }
      let serviceId = trimmed(created.serviceCreate?.id, 128);
      if (!serviceId) {
        let reconciliationError = null;
        const reconciled = await findServiceByName(serviceName, { signal, onLine }).catch((caught) => {
          reconciliationError = caught;
          return null;
        });
        if (signal?.aborted) {
          const cancellation = signal.reason instanceof Error ? signal.reason : reconciliationError
            ?? new Error('Sandbox creation was cancelled');
          await cleanupAmbiguousCreate(serviceName, cancellation, onLine);
          throw cancellation;
        }
        serviceId = trimmed(reconciled?.id, 128);
        if (!serviceId) {
          throw new AppServerError('Railway did not return a sandbox service id', {
            code: 'PROVIDER_RESPONSE_INVALID',
          });
        }
        onLine('Recovered the sandbox id after an incomplete Railway response');
      }
      const sandbox = {
        providerId: 'railway',
        sandboxId: serviceId,
        projectId: config.projectId,
        environmentId: config.environmentId,
        domainId: '',
        region: config.region,
        host: '',
        createdAt: new Date().toISOString(),
      };
      try {
        // Persist the billable id before domain/deployment/bootstrap work. If
        // the desktop exits after this boundary, startup can find and remove it.
        await onSandboxCreated(sandbox);
        if (config.region) {
          await graphql(SERVICE_INSTANCE_UPDATE, {
            serviceId,
            environmentId: config.environmentId,
            input: { region: config.region },
          }, { signal });
        }
        onLine('Publishing the sandbox HTTPS domain');
        let domainNode;
        try {
          const domainResult = await graphql(SERVICE_DOMAIN_CREATE, {
            input: {
              environmentId: config.environmentId,
              serviceId,
              targetPort: SANDBOX_PORT,
            },
          }, { signal });
          domainNode = usableDomain(domainResult.serviceDomainCreate);
          if (!domainNode) {
            domainNode = await findServiceDomain(sandbox, { signal, onLine });
            if (domainNode) onLine('Recovered the sandbox domain after an incomplete Railway response');
          }
        } catch (error) {
          if (error?.retryable === false) throw error;
          // serviceDomainCreate is not blindly replayed. The documented domains
          // query lets us distinguish an accepted mutation from a rejected one.
          domainNode = await findServiceDomain(sandbox, { signal, onLine }).catch(() => null);
          if (!domainNode) throw error;
          onLine('Recovered the sandbox domain after an interrupted Railway response');
        }
        if (!domainNode) {
          throw new AppServerError('Railway did not return a usable sandbox domain', {
            code: 'PROVIDER_RESPONSE_INVALID',
          });
        }
        sandbox.host = domainNode.domain;
        sandbox.domainId = domainNode.id;
        const endpoint = `https://${domainNode.domain}${SANDBOX_BASE_PATH}`;
        await waitForDeployment(sandbox, { signal, onLine });
        const health = await waitForHealth(endpoint, { signal, onLine });
        onLine('Pairing this device with the app sandbox');
        const receipt = await acquireReceipt({
          endpoint,
          bootstrapToken,
          deviceName,
          serverPublicKey: health.serverPublicKey,
          signal,
        });
        return {
          sandbox,
          receipt: {
            endpoint,
            serverPublicKey: receipt.serverPublicKey,
            pairingCode: receipt.pairingCode,
          },
        };
      } catch (error) {
        try {
          await removeService(sandbox, {});
          await onSandboxRemoved(sandbox);
        } catch (cleanupError) {
          error.cleanupFailed = cleanupError.message;
        }
        throw error;
      }
    },

    async status(sandbox, { signal } = {}) {
      const deployment = await latestDeployment(sandbox, { signal });
      if (!deployment) {
        // An empty deployment history occurs during propagation and redeploys;
        // it is not evidence that the paid service was deleted. Confirm the
        // service id is absent before letting the coordinator replace it.
        const service = await findServiceById(sandbox.sandboxId, {
          signal,
          projectId: sandbox.projectId || config.projectId,
        });
        if (service) {
          return {
            lifecycle: 'provisioning',
            status: 'NO_DEPLOYMENT',
            message: 'Railway has not published a deployment for this sandbox yet.',
          };
        }
        return { lifecycle: 'idle', status: 'REMOVED', message: 'This sandbox no longer exists.' };
      }
      const lifecycle = DEPLOY_STATUS_LIFECYCLE[deployment.status] ?? 'provisioning';
      return {
        lifecycle,
        status: deployment.status,
        message: lifecycle === 'error' ? `Railway reports ${deployment.status}.` : null,
      };
    },

    async teardown(sandbox, { signal } = {}) {
      const outcome = await removeService(sandbox, { signal });
      return { lifecycle: 'idle', removed: outcome === 'removed' };
    },
  };
}

export const __test = {
  DEPLOY_STATUS_LIFECYCLE,
  missingConfiguration,
  sandboxName,
  notFound,
};
