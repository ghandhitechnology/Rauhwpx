import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerError } from './cloud-app-server.mjs';

export const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
export const RAILWAY_DEFAULT_IMAGE = 'ghcr.io/ghandhitechnology/rauhwpx-cloud:stable';
export const SANDBOX_BASE_PATH = '/rauhwpx-cloud';
export const SANDBOX_PORT = 7740;

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DEPLOY_TIMEOUT_MS = 12 * 60_000;
const HEALTH_TIMEOUT_MS = 5 * 60_000;

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

export function createRailwayServerProvider({
  config = railwayConfigFromEnv(),
  fetchImpl = globalThis.fetch,
  probeHealth,
  acquireReceipt,
  sleep = (ms, options) => delay(ms, undefined, options),
  deployTimeoutMs = DEPLOY_TIMEOUT_MS,
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Railway provider requires fetch');
  if (typeof probeHealth !== 'function') throw new Error('Railway provider requires a health probe');
  if (typeof acquireReceipt !== 'function') throw new Error('Railway provider requires a receipt acquirer');

  async function graphql(document, variables, { signal, allowNotFound = false } = {}) {
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
    const timer = setTimeout(() => controller.abort(new Error('Railway API request timed out')), REQUEST_TIMEOUT_MS);
    let response;
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
    } catch (error) {
      throw new AppServerError(`Railway API is unreachable: ${error.message}`, {
        code: 'PROVIDER_UNREACHABLE',
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new AppServerError('Railway API response is too large', { code: 'PROVIDER_RESPONSE_INVALID' });
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new AppServerError('Railway API response is too large', { code: 'PROVIDER_RESPONSE_INVALID' });
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppServerError('Railway rejected the configured API token', {
        code: 'PROVIDER_UNAUTHORIZED',
        retryable: false,
      });
    }
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch {
      throw new AppServerError('Railway API returned invalid JSON', { code: 'PROVIDER_RESPONSE_INVALID' });
    }
    if (payload.errors?.length) {
      if (allowNotFound && notFound(payload.errors)) return null;
      throw new AppServerError(graphqlMessage(payload.errors), {
        code: 'PROVIDER_REJECTED',
        retryable: response.status >= 500,
      });
    }
    if (!response.ok) {
      throw new AppServerError(`Railway API failed with HTTP ${response.status}`, {
        code: 'PROVIDER_REJECTED',
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    if (!payload.data || typeof payload.data !== 'object') {
      throw new AppServerError('Railway API returned no data', { code: 'PROVIDER_RESPONSE_INVALID' });
    }
    return payload.data;
  }

  function sandboxVariables(bootstrapToken, limits) {
    return {
      RAUHWpx_HOST: '0.0.0.0',
      RAUHWpx_PORT: String(SANDBOX_PORT),
      PORT: String(SANDBOX_PORT),
      RAUHWpx_BASE_PATH: SANDBOX_BASE_PATH,
      RAUHWpx_BOOTSTRAP_TOKEN: bootstrapToken,
      RAUHWpx_CHANNEL: 'stable',
      RAUHWpx_MAX_RUNNING: String(limits?.maxRunningSessions ?? 2),
      RAUHWpx_MAX_QUEUED: String(limits?.maxQueuedSessions ?? 20),
    };
  }

  async function latestDeployment(sandbox, { signal } = {}) {
    const data = await graphql(LATEST_DEPLOYMENT, {
      projectId: sandbox.projectId || config.projectId,
      environmentId: sandbox.environmentId || config.environmentId,
      serviceId: sandbox.sandboxId,
    }, { signal, allowNotFound: true });
    if (!data) return null;
    const node = data.deployments?.edges?.[0]?.node;
    return node ? { id: trimmed(node.id), status: trimmed(node.status, 64).toUpperCase() } : null;
  }

  async function waitForDeployment(sandbox, { signal, onLine }) {
    const deadline = Date.now() + deployTimeoutMs;
    let attempt = 0;
    for (;;) {
      const deployment = await latestDeployment(sandbox, { signal });
      const lifecycle = deployment ? DEPLOY_STATUS_LIFECYCLE[deployment.status] ?? 'provisioning' : 'provisioning';
      if (lifecycle === 'ready') return deployment;
      if (lifecycle === 'error') {
        throw new AppServerError(`Railway deployment ended in ${deployment.status}`, {
          code: 'SANDBOX_DEPLOY_FAILED',
        });
      }
      if (Date.now() >= deadline) {
        throw new AppServerError('Railway deployment did not become ready in time', {
          code: 'SANDBOX_DEPLOY_TIMEOUT',
        });
      }
      attempt += 1;
      if (attempt % 4 === 1) onLine(`Waiting for the app sandbox deployment (${deployment?.status ?? 'PENDING'})`);
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
        lastError = new Error('sandbox health response is incomplete');
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        throw new AppServerError(
          `App sandbox did not answer its health check: ${lastError?.message ?? 'unknown error'}`,
          { code: 'SANDBOX_UNHEALTHY' },
        );
      }
      attempt += 1;
      if (attempt % 4 === 1) onLine('Waiting for the app sandbox service to answer');
      await sleep(Math.min(8_000, 1_500 * attempt), { signal });
    }
  }

  async function removeService(sandbox, { signal } = {}) {
    const data = await graphql(SERVICE_DELETE, {
      id: sandbox.sandboxId,
      environmentId: sandbox.environmentId || config.environmentId || null,
    }, { signal, allowNotFound: true });
    return data === null ? 'already-removed' : 'removed';
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

    async spawn({ deviceName = 'Rauhwpx desktop', limits = null, signal, onLine = () => {} } = {}) {
      const bootstrapToken = randomBytes(32).toString('base64url');
      onLine('Creating an app-provided sandbox');
      const created = await graphql(SERVICE_CREATE, {
        input: {
          projectId: config.projectId,
          environmentId: config.environmentId,
          name: sandboxName(),
          source: { image: config.image },
          variables: sandboxVariables(bootstrapToken, limits),
        },
      }, { signal });
      const serviceId = trimmed(created.serviceCreate?.id, 128);
      if (!serviceId) {
        throw new AppServerError('Railway did not return a sandbox service id', {
          code: 'PROVIDER_RESPONSE_INVALID',
        });
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
        if (config.region) {
          await graphql(SERVICE_INSTANCE_UPDATE, {
            serviceId,
            environmentId: config.environmentId,
            input: { region: config.region },
          }, { signal });
        }
        onLine('Publishing the sandbox HTTPS domain');
        const domainResult = await graphql(SERVICE_DOMAIN_CREATE, {
          input: {
            environmentId: config.environmentId,
            serviceId,
            targetPort: SANDBOX_PORT,
          },
        }, { signal });
        const domain = trimmed(domainResult.serviceDomainCreate?.domain, 253).toLowerCase();
        if (!domain || !/^(?!-)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) {
          throw new AppServerError('Railway did not return a usable sandbox domain', {
            code: 'PROVIDER_RESPONSE_INVALID',
          });
        }
        sandbox.host = domain;
        sandbox.domainId = trimmed(domainResult.serviceDomainCreate?.id, 128);
        const endpoint = `https://${domain}${SANDBOX_BASE_PATH}`;
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
        await removeService(sandbox, {}).catch(() => {});
        throw error;
      }
    },

    async status(sandbox, { signal } = {}) {
      const deployment = await latestDeployment(sandbox, { signal });
      if (!deployment) return { lifecycle: 'idle', status: 'REMOVED', message: 'This sandbox no longer exists.' };
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
