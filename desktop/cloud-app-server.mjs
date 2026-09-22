import { SANDBOX_LIFECYCLES } from './cloud-profile.mjs';

export { SANDBOX_LIFECYCLES };

/** 앱이 제공하는 서버 공급자가 실패를 사용자가 처리할 수 있는 형태로 전달한다. */
export class AppServerError extends Error {
  constructor(message, { code = 'APP_SERVER_FAILED', retryable = true, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppServerError';
    this.code = code;
    this.retryable = retryable;
  }
}

const REQUIRED_METHODS = Object.freeze(['configuration', 'spawn', 'status', 'teardown']);

function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new Error('App server provider must be an object');
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(String(provider.id ?? ''))) {
    throw new Error('App server provider requires a lowercase id');
  }
  if (!String(provider.displayName ?? '').trim()) {
    throw new Error(`App server provider ${provider.id} requires a display name`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`App server provider ${provider.id} must implement ${method}()`);
    }
  }
  return provider;
}

export function normalizeLifecycle(value, fallback = 'idle') {
  return SANDBOX_LIFECYCLES.includes(value) ? value : fallback;
}

/**
 * 앱이 제공하는 서버 공급자 레지스트리. Railway는 이 계약의 한 구현이며,
 * 다른 공급자를 추가할 때 이 파일 밖을 바꾸지 않는다.
 */
export function createAppServerRegistry(providers = []) {
  const entries = new Map();
  for (const provider of providers) {
    assertProvider(provider);
    if (entries.has(provider.id)) throw new Error(`Duplicate app server provider: ${provider.id}`);
    entries.set(provider.id, provider);
  }
  const describe = (provider) => {
    const configuration = provider.configuration();
    return {
      providerId: provider.id,
      displayName: provider.displayName,
      configured: configuration.configured === true,
      missingConfig: [...(configuration.missing ?? [])].map(String),
    };
  };
  return {
    get size() { return entries.size; },
    list() { return [...entries.values()].map(describe); },
    has(providerId) { return entries.has(String(providerId ?? '')); },
    get(providerId) {
      const provider = entries.get(String(providerId ?? ''));
      if (!provider) {
        throw new AppServerError(`Unknown app server provider: ${providerId}`, {
          code: 'PROVIDER_UNKNOWN',
          retryable: false,
        });
      }
      return provider;
    },
    /** 설정이 끝난 공급자를 우선 고르고, 없으면 첫 공급자를 돌려 설정 안내를 노출한다. */
    preferred() {
      const all = [...entries.values()];
      return all.find((provider) => provider.configuration().configured === true) ?? all[0] ?? null;
    },
    describe(providerId) { return describe(this.get(providerId)); },
  };
}
