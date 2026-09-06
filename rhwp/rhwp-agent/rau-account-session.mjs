import { storeRauApiKey } from './rau-credits-client.mjs';

export const RAU_ACCOUNT_LINK_SECRET_ID = 'rhwp.rau.account-linked';
const PROVIDER_ERROR = 'RAU_ACCOUNT_PROVIDER_UNAVAILABLE';

function cancelledError() {
  return Object.assign(new Error('계정 로그인을 취소했어요.'), { code: 'ACCOUNT_LOGIN_CANCELLED' });
}

/** Account identity owns Rau credentials; the generic session alone handles account tokens. */
export function createRauAccountSession({
  accountSession,
  rauManager,
  secretStore,
  installProvider = null,
  onProviderChanged = null,
  beforeProviderChange = null,
  log = () => {},
} = {}) {
  let chain = Promise.resolve();
  let generation = 0;
  let activeLink = null;
  let explicitSync = null;
  let attemptedIdentity;
  let provider = { state: 'idle' };
  const loginIds = new Set();
  const completing = new Map();

  function serialize(operation) {
    const result = chain.then(operation, operation);
    chain = result.catch(() => {});
    return result;
  }

  function invalidate() {
    generation += 1;
    activeLink?.abort.abort();
    attemptedIdentity = undefined;
    return generation;
  }

  function result(account) {
    return { ...account, provider: { ...provider } };
  }

  async function changed(status, error = null) {
    // Observers cannot roll back an already committed credential transaction.
    try { await onProviderChanged?.(status, { error }); }
    catch { log('Rau account provider observer failed.'); }
  }

  async function failed() {
    provider = { state: 'error', error: PROVIDER_ERROR };
    log('Rau account provider synchronization failed.');
    const status = await rauManager.status().catch(() => null);
    await changed(status, PROVIDER_ERROR);
  }

  async function clearProvider({ keepMarker = false } = {}) {
    // Existing processes retain their environment credentials until they stop.
    // This is a transaction prerequisite; a failure must block the key change.
    await beforeProviderChange?.();
    const status = await rauManager.clearApiKey();
    if (!keepMarker) await secretStore.delete(RAU_ACCOUNT_LINK_SECRET_ID);
    provider = { state: 'signed-out' };
    await changed(status);
  }

  async function link(account, { signal, loginId, install = false, epoch = generation, prepared = false } = {}) {
    const abort = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    activeLink = { abort, loginId };
    const current = () => epoch === generation && !operationSignal.aborted;
    try {
      if (!current()) return;
      // Clear before provisioning: a failed account switch must never retain the old key.
      if (!prepared) await clearProvider();
      if (!current()) return;
      await secretStore.set(RAU_ACCOUNT_LINK_SECRET_ID, 'linked');
      const credentials = await accountSession.authorizeOwnedBackend({
        pathname: '/v2/account-session/provider',
        method: 'POST',
      }, { signal: operationSignal });
      if (!current()) return;
      if (typeof credentials?.apiKey !== 'string' || !credentials.apiKey.trim()) {
        throw new Error(PROVIDER_ERROR);
      }
      const status = await storeRauApiKey(rauManager.setApiKey.bind(rauManager), credentials.apiKey, {
        account: account.account?.email ?? credentials.email ?? null,
        signal: operationSignal,
      });
      if (!current()) {
        await clearProvider();
        return;
      }
      provider = { state: 'ready' };
      await changed(status);
      if (install && !status.installed && installProvider && current()) {
        await installProvider({ signal: operationSignal });
      }
    } catch {
      if (current()) await failed();
    } finally {
      if (activeLink?.abort === abort) activeLink = null;
    }
  }

  async function reconcile(account, { force = false, epoch = generation, ...options } = {}) {
    try {
      if (epoch !== generation || options.signal?.aborted) return result(account);
      const marker = await secretStore.get(RAU_ACCOUNT_LINK_SECRET_ID);
      if (epoch !== generation || options.signal?.aborted) return result(account);
      if (account.state === 'signed-out') {
        attemptedIdentity = undefined;
        if (marker) await clearProvider();
        else provider = { state: 'signed-out' };
      } else if (account.signedIn && account.state === 'signed-in') {
        if (marker === 'logout-pending' && !force) {
          provider = { state: 'signed-out' };
          return result(account);
        }
        const identity = account.account?.email ?? '';
        if (force || attemptedIdentity !== identity) {
          attemptedIdentity = identity;
          await link(account, { ...options, epoch });
        }
      }
    } catch {
      await failed();
    }
    return result(account);
  }

  return {
    status(options = {}) {
      const epoch = generation;
      return serialize(async () => reconcile(await accountSession.status(options), { ...options, epoch, install: true }));
    },

    startLogin(options = {}) {
      const epoch = generation;
      return serialize(async () => {
        const started = await accountSession.startLogin(options);
        if (epoch !== generation) {
          await accountSession.cancelLogin(started.loginId);
          throw cancelledError();
        }
        loginIds.add(started.loginId);
        return started;
      });
    },

    completeLogin(loginId, proof, options = {}) {
      const epoch = invalidate();
      const abort = new AbortController();
      completing.set(loginId, abort);
      const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
      return serialize(async () => {
        if (epoch !== generation || signal.aborted) {
          completing.delete(loginId);
          throw cancelledError();
        }
        let keepAttempt = false;
        try {
          const account = await accountSession.completeLogin(loginId, proof, {
            ...options,
            signal,
            async onCommitted() {
              // A clear failure lets the generic account transaction restore the old identity.
              if (epoch !== generation || signal.aborted) {
                throw cancelledError();
              }
              await clearProvider();
              await secretStore.set(RAU_ACCOUNT_LINK_SECRET_ID, 'linked');
              if (epoch !== generation || signal.aborted) throw cancelledError();
              await options.onCommitted?.();
              if (epoch !== generation || signal.aborted) throw cancelledError();
            },
          });
          if (epoch !== generation) return result(account);
          return reconcile(account, { ...options, signal, epoch, loginId, force: true, install: true, prepared: true });
        } catch (error) {
          keepAttempt = error?.code === 'DEVICE_PROOF_INVALID' && !signal.aborted;
          throw error;
        } finally {
          if (!keepAttempt) loginIds.delete(loginId);
          completing.delete(loginId);
        }
      });
    },

    async cancelLogin(loginId) {
      completing.get(loginId)?.abort();
      if (activeLink?.loginId === loginId) {
        generation += 1;
        activeLink.abort.abort();
      }
      loginIds.delete(loginId);
      return accountSession.cancelLogin(loginId);
    },

    logout(options = {}) {
      invalidate();
      for (const abort of completing.values()) abort.abort();
      // Cancellation must reach a redeem already running ahead of this serialized logout.
      const cancellations = [...loginIds].map((id) => accountSession.cancelLogin(id));
      loginIds.clear();
      return serialize(async () => {
        await Promise.allSettled(cancellations);
        await secretStore.set(RAU_ACCOUNT_LINK_SECRET_ID, 'logout-pending');
        await clearProvider({ keepMarker: true });
        const account = await accountSession.logout(options);
        await secretStore.delete(RAU_ACCOUNT_LINK_SECRET_ID);
        return result(account);
      });
    },

    synchronizeProvider(options = {}) {
      if (!explicitSync) {
        const epoch = generation;
        explicitSync = serialize(async () => reconcile(await accountSession.status(options), {
          ...options, epoch, force: true, install: true,
        })).finally(() => { explicitSync = null; });
      }
      return explicitSync;
    },

    authorizeOwnedBackend(request, options) {
      return accountSession.authorizeOwnedBackend(request, options);
    },
  };
}
