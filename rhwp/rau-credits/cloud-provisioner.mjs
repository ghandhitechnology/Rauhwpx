import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
export const RAILWAY_DEFAULT_IMAGE = 'ghcr.io/ghandhitechnology/rauhwpx-cloud:1.1.0-edge.12';
export const RAUCLOUD_BASE_PATH = '/rauhwpx-cloud';
export const RAUCLOUD_PORT = 7740;

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEPLOY_TIMEOUT_MS = 12 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 5 * 60 * 1000;

const SERVICE_CREATE = `
mutation RaucloudServiceCreate($input: ServiceCreateInput!) {
  serviceCreate(input: $input) { id name }
}`;
const SERVICE_DOMAIN_CREATE = `
mutation RaucloudDomainCreate($input: ServiceDomainCreateInput!) {
  serviceDomainCreate(input: $input) { id domain }
}`;
const LATEST_DEPLOYMENT = `
query RaucloudLatestDeployment($projectId: String!, $environmentId: String!, $serviceId: String!) {
  deployments(first: 1, input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId }) {
    edges { node { id status } }
  }
}`;
const SERVICE_DELETE = `
mutation RaucloudServiceDelete($id: String!, $environmentId: String) {
  serviceDelete(id: $id, environmentId: $environmentId)
}`;
const PROJECT_SERVICES = `
query RaucloudProjectServices($projectId: String!) {
  project(id: $projectId) { services { edges { node { id name createdAt } } } }
}`;

function clean(value, limit = 512) {
  const result = String(value ?? '').trim();
  return result.length <= limit ? result : '';
}

function provisionerError(code, message, cause = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function railwayCloudConfigFromEnv(environment = process.env) {
  return {
    token: clean(environment.RAUHWpx_RAILWAY_TOKEN, 4096),
    projectId: clean(environment.RAUHWpx_RAILWAY_PROJECT_ID),
    environmentId: clean(environment.RAUHWpx_RAILWAY_ENVIRONMENT_ID),
    image: clean(environment.RAUHWpx_RAILWAY_IMAGE, 1024) || RAILWAY_DEFAULT_IMAGE,
    region: clean(environment.RAUHWpx_RAILWAY_REGION, 128),
    apiUrl: clean(environment.RAUHWpx_RAILWAY_API_URL, 2048) || RAILWAY_API_URL,
    brokerUrl: clean(environment.RAU_CREDITS_ORIGIN, 2048),
    legacyMigrationStartedAt: Date.parse(clean(environment.RAUHWpx_LEGACY_MIGRATION_STARTED_AT, 128)) || null,
  };
}

export function railwayCloudConfigured(config) {
  return Boolean(config?.token && config?.projectId && config?.environmentId);
}

async function boundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw provisionerError('PROVIDER_RESPONSE_INVALID', 'Railway returned an oversized response');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) {
    throw provisionerError('PROVIDER_RESPONSE_INVALID', 'Railway returned an oversized response');
  }
  try {
    return bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
  } catch (error) {
    throw provisionerError('PROVIDER_RESPONSE_INVALID', 'Railway returned invalid JSON', error);
  }
}

function safeDomain(value) {
  const domain = clean(value, 253).toLowerCase();
  return /^(?!-)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) ? domain : '';
}

function raucloudServiceName(accountId, runId) {
  return `rauhwpx-raucloud-${createHashSuffix(accountId)}-${createHashSuffix(runId)}`;
}

const LEGACY_RAUCLOUD_SERVICE_PREFIX = 'rauhwpx-managed-'; // raucloud-legacy: keep existing Railway workers reconcilable.

function legacyRaucloudServiceName(accountId, runId) {
  return `${LEGACY_RAUCLOUD_SERVICE_PREFIX}${createHashSuffix(accountId)}-${createHashSuffix(runId)}`;
}

/**
 * Backend-only Railway adapter. Its configuration (especially token) is closed
 * over by this object and never included in broker state or public envelopes.
 */
export function createRailwayCloudProvisioner({
  config = railwayCloudConfigFromEnv(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => delay(ms),
} = {}) {
  if (!railwayCloudConfigured(config)) return null;
  if (typeof fetchImpl !== 'function') throw new Error('Railway Cloud provisioner requires fetch');

  async function graphql(query, variables, { timeoutMs = 30_000, allowNotFound = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(config.apiUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      throw provisionerError('PROVIDER_UNREACHABLE', 'Railway is temporarily unreachable', error);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      throw provisionerError('PROVIDER_UNAUTHORIZED', 'Railway rejected the broker credential');
    }
    const payload = await boundedJson(response);
    if (payload.errors?.length) {
      const message = clean(payload.errors[0]?.message, 1000) || 'Railway rejected the request';
      if (allowNotFound && /not found|does not exist/i.test(message)) return null;
      throw provisionerError('PROVIDER_REJECTED', message);
    }
    if (!response.ok || !payload.data) {
      throw provisionerError('PROVIDER_REJECTED', `Railway failed with HTTP ${response.status}`);
    }
    return payload.data;
  }

  async function waitForDeployment(remote) {
    const deadline = now() + DEPLOY_TIMEOUT_MS;
    while (now() < deadline) {
      const data = await graphql(LATEST_DEPLOYMENT, {
        projectId: remote.projectId,
        environmentId: remote.environmentId,
        serviceId: remote.serviceId,
      });
      const status = clean(data.deployments?.edges?.[0]?.node?.status, 64).toUpperCase();
      if (status === 'SUCCESS' || status === 'SLEEPING') return;
      if (status === 'FAILED' || status === 'CRASHED') {
        throw provisionerError('SANDBOX_DEPLOY_FAILED', `Railway deployment ended in ${status}`);
      }
      await sleep(2_000);
    }
    throw provisionerError('SANDBOX_DEPLOY_TIMEOUT', 'Railway deployment did not become ready in time');
  }

  async function waitForReceipt(endpoint, bootstrapToken, deviceName) {
    const deadline = now() + HEALTH_TIMEOUT_MS;
    let publicKey = '';
    while (now() < deadline) {
      try {
        const health = await fetchImpl(`${endpoint}/v1/health`, { headers: { accept: 'application/json' } });
        const body = await boundedJson(health);
        publicKey = clean(body.serverPublicKey, 512);
        if (health.ok && /^ed25519:[A-Za-z0-9_-]{40,}$/.test(publicKey)) break;
      } catch {}
      await sleep(1_500);
    }
    if (!publicKey) throw provisionerError('SANDBOX_UNHEALTHY', 'Raucloud worker did not answer its health check');
    const paired = await fetchImpl(`${endpoint}/v1/pairing/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bootstrapToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-rauhwpx-request-nonce': randomBytes(24).toString('base64url'),
      },
      body: JSON.stringify({ deviceName: String(deviceName ?? '').slice(0, 120) }),
    });
    const body = await boundedJson(paired);
    const pairingCode = clean(body.code, 64);
    if (!paired.ok || !/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pairingCode)
      || clean(body.serverPublicKey, 512) !== publicKey) {
      throw provisionerError('BOOTSTRAP_RECEIPT_INVALID', 'Raucloud worker returned an invalid pairing receipt');
    }
    return { endpoint, serverPublicKey: publicKey, pairingCode };
  }

  async function projectServices() {
    const data = await graphql(PROJECT_SERVICES, { projectId: config.projectId });
    return (data.project?.services?.edges ?? []).map((edge) => edge?.node).filter((node) => node?.id);
  }

  return {
    id: 'railway',

    serviceName({ accountId, runId }) {
      return raucloudServiceName(accountId, runId);
    },

    legacyServiceName({ accountId, runId }) {
      return legacyRaucloudServiceName(accountId, runId);
    },

    async provision({ runId, accountId, deviceId, workerToken, onRemoteCreated = async () => {} }) {
      const bootstrapToken = randomBytes(32).toString('base64url');
      const serviceName = raucloudServiceName(accountId, runId);
      const createInput = {
        projectId: config.projectId,
        environmentId: config.environmentId,
        name: serviceName,
        source: { image: config.image },
        variables: {
            RAUHWpx_HOST: '0.0.0.0',
            RAUHWpx_PORT: String(RAUCLOUD_PORT),
            PORT: String(RAUCLOUD_PORT),
            RAUHWpx_BASE_PATH: RAUCLOUD_BASE_PATH,
            RAUHWpx_BOOTSTRAP_TOKEN: bootstrapToken,
            RAUHWpx_CHANNEL: 'stable',
            RAUHWpx_MAX_RUNNING: '1',
            RAUHWpx_MAX_QUEUED: '1',
            RAUHWpx_RUNNER: 'local',
            RAUHWpx_WORKER_UID: '1001',
            RAUHWpx_WORKER_GID: '1001',
            RAUHWpx_WORKER_CONTROL_DIR: '/run/rauhwpx',
            RAUHWpx_WORKSPACE_ROOT: '/var/lib/rauhwpx-workspaces',
            RAUHWpx_DATA_DIR: '/var/lib/rauhwpx-cloud',
            RAUHWpx_SANDBOX_INSTALL_PROVIDER: '0',
            ...(config.brokerUrl ? {
              RAUHWpx_RAUCLOUD_BROKER_URL: config.brokerUrl,
              RAUHWpx_RAUCLOUD_RUN_ID: runId,
              RAUHWpx_RAUCLOUD_WORKER_TOKEN: workerToken,
            } : {}),
        },
      };
      let created;
      try {
        created = await graphql(SERVICE_CREATE, { input: createInput });
      } catch (createError) {
        // Never replay an ambiguous create. Railway may have accepted it before
        // the response was lost; reconcile the deterministic name instead.
        let recovered = null;
        for (let attempt = 0; attempt < 10 && !recovered; attempt += 1) {
          try {
            recovered = (await projectServices()).find((service) => service.name === serviceName) ?? null;
          } catch {}
          if (!recovered) await sleep(Math.min(3_000, 500 * (attempt + 1)));
        }
        if (!recovered) throw createError;
        created = { serviceCreate: recovered };
      }
      const serviceId = clean(created.serviceCreate?.id, 160);
      if (!serviceId) throw provisionerError('PROVIDER_RESPONSE_INVALID', 'Railway did not return a service id');
      const remote = {
        providerId: 'railway',
        serviceId,
        projectId: config.projectId,
        environmentId: config.environmentId,
        runId,
        createdAt: now(),
      };
      try {
        await onRemoteCreated(remote);
        const domainData = await graphql(SERVICE_DOMAIN_CREATE, {
          input: { environmentId: config.environmentId, serviceId, targetPort: RAUCLOUD_PORT },
        });
        const domain = safeDomain(domainData.serviceDomainCreate?.domain);
        if (!domain) throw provisionerError('PROVIDER_RESPONSE_INVALID', 'Railway did not return a usable domain');
        remote.domainId = clean(domainData.serviceDomainCreate?.id, 160);
        remote.domain = domain;
        await onRemoteCreated(remote);
        await waitForDeployment(remote);
        const endpoint = `https://${domain}${RAUCLOUD_BASE_PATH}`;
        const receipt = await waitForReceipt(endpoint, bootstrapToken, `Rauhwpx ${clean(deviceId, 60)}`);
        return { remote, receipt };
      } catch (error) {
        await this.teardown(remote).catch((cleanupError) => { error.cleanupError = cleanupError.message; });
        throw error;
      }
    },

    async teardown(remote) {
      if (!remote?.serviceId) return { removed: false };
      try {
        await graphql(SERVICE_DELETE, {
          id: remote.serviceId,
          environmentId: remote.environmentId || config.environmentId,
        }, { allowNotFound: true });
      } catch (error) {
        const exists = (await projectServices()).some((service) => service.id === remote.serviceId);
        if (exists) throw error;
      }
      const exists = (await projectServices()).some((service) => service.id === remote.serviceId);
      if (exists) throw provisionerError('PROVIDER_DELETE_UNCONFIRMED', 'Railway has not confirmed worker deletion');
      return { removed: true };
    },

    async reconcileRaucloud({ keepServiceNames = [], limit = 100 } = {}) {
      const keep = new Set(keepServiceNames.map((name) => clean(name, 160)).filter(Boolean));
      const orphans = (await projectServices())
        .filter((service) => {
          const name = String(service.name ?? '');
          return name.startsWith('rauhwpx-raucloud-') || name.startsWith(LEGACY_RAUCLOUD_SERVICE_PREFIX);
        })
        .filter((service) => !keep.has(String(service.name ?? '')))
        .slice(0, Math.max(1, Math.min(100, Number(limit) || 100)));
      const failed = [];
      let removed = 0;
      for (const service of orphans) {
        try {
          await this.teardown({
            providerId: 'railway',
            serviceId: service.id,
            projectId: config.projectId,
            environmentId: config.environmentId,
          });
          removed += 1;
        } catch (error) {
          failed.push({ serviceId: service.id, error: String(error?.message ?? error).slice(0, 300) });
        }
      }
      return { found: orphans.length, removed, failed };
    },

    async reconcileLegacy({ checkpointWindowMs = 72 * 60 * 60 * 1000, limit = 100 } = {}) {
      if (!config.legacyMigrationStartedAt) return { enabled: false, found: 0, removed: 0 };
      const checkpointUntil = config.legacyMigrationStartedAt + checkpointWindowMs;
      const legacy = (await projectServices())
        .filter((service) => String(service.name ?? '').startsWith('rauhwpx-sandbox-'))
        .slice(0, Math.max(1, Math.min(100, Number(limit) || 100)));
      if (now() < checkpointUntil) {
        return { enabled: true, checkpointUntil, found: legacy.length, removed: 0 };
      }
      let removed = 0;
      const failed = [];
      for (const service of legacy) {
        try {
          await this.teardown({
            providerId: 'railway',
            serviceId: service.id,
            projectId: config.projectId,
            environmentId: config.environmentId,
          });
          removed += 1;
        } catch (error) {
          failed.push({ serviceId: service.id, error: String(error?.message ?? error).slice(0, 300) });
        }
      }
      return { enabled: true, checkpointUntil, found: legacy.length, removed, failed };
    },
  };
}

function createHashSuffix(value) {
  let hash = 2166136261;
  for (const byte of Buffer.from(String(value ?? ''))) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 8);
}
