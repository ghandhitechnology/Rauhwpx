import { randomBytes, randomUUID } from 'node:crypto';

import { createRauCreditsClient } from './rau-credits-client.mjs';

export const ACCOUNT_SESSION_SECRET_ID = 'rhwp.account.session-token';

function accountError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function cancelledError() {
  return accountError('ACCOUNT_LOGIN_CANCELLED', '계정 로그인을 취소했어요.');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

function validToken(value) {
  return typeof value === 'string' && /^rau_account_v1_[A-Za-z0-9_-]{43}$/.test(value);
}

function cleanAccount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const email = typeof value.email === 'string' && value.email.includes('@')
    ? value.email.trim().toLowerCase().slice(0, 320)
    : null;
  return { email };
}

function publicStatus(value, now = Date.now) {
  const signedIn = value?.signedIn === true && value?.state === 'signed-in';
  const state = signedIn
    ? 'signed-in'
    : value?.state === 'pending'
      ? 'pending'
      : value?.state === 'unknown'
        ? 'unknown'
        : 'signed-out';
  return {
    state,
    signedIn,
    account: signedIn ? cleanAccount(value.account) : null,
    updatedAt: new Date(now()).toISOString(),
    ...(state === 'unknown' && typeof value?.error === 'string' ? { error: value.error } : {}),
  };
}

function requireBackend(backend) {
  const methods = [
    'startLogin',
    'redeemLogin',
    'acknowledgeLogin',
    'cancelLogin',
    'readStatus',
    'commitSession',
    'revokeSession',
    'authorizeOwnedBackend',
  ];
  for (const method of methods) {
    if (typeof backend?.[method] !== 'function') {
      throw new TypeError(`account backend adapter requires ${method}()`);
    }
  }
  return backend;
}

/** Production adapter for the owned rau-credits backend. */
function createRauAccountBackendAdapter({
  creditsClient = createRauCreditsClient(),
} = {}) {
  return {
    async startLogin(input = {}) {
      const session = await creditsClient.createAccountDeviceSessionV2(input);
      return {
        handle: {
          deviceId: session.id,
          codeVerifier: session.codeVerifier,
        },
        authUrl: session.loginUrl,
        pairingCode: session.pairingCode,
        expiresAt: session.expiresAt,
      };
    },
    async redeemLogin(handle, proof, { signal } = {}) {
      const result = await creditsClient.redeemDeviceSessionV2(
        handle.deviceId,
        handle.codeVerifier,
        proof,
        { signal },
      );
      if (!validToken(result?.accountToken)) {
        throw accountError('ACCOUNT_LOGIN_SERVER_INCOMPATIBLE', '계정 세션을 받지 못했어요.');
      }
      return { token: result.accountToken, account: cleanAccount(result.account) };
    },
    acknowledgeLogin(handle, proof, { signal } = {}) {
      return creditsClient.acknowledgeDeviceSessionV2(
        handle.deviceId,
        handle.codeVerifier,
        proof,
        { signal },
      );
    },
    cancelLogin(handle, { signal } = {}) {
      return creditsClient.cancelDeviceSessionV2(
        handle.deviceId,
        handle.codeVerifier,
        { signal },
      );
    },
    readStatus(token, { signal } = {}) {
      return creditsClient.readAccountSession(token, { signal });
    },
    commitSession(token, { signal } = {}) {
      return creditsClient.commitAccountSession(token, { signal });
    },
    revokeSession(token, { signal } = {}) {
      return creditsClient.revokeAccountSession(token, { signal });
    },
    authorizeOwnedBackend(token, request, { signal } = {}) {
      return creditsClient.authorizeOwnedBackend(token, request, { signal });
    },
  };
}

/** In-memory adapter that exercises the same seam without network or disk. */
export function createMemoryAccountBackendAdapter({
  account = { email: 'andy@example.com' },
  initialSessions = [],
  authorize = async (_identity, request) => ({ ok: true, request }),
} = {}) {
  const sessions = new Map();
  const logins = new Map();
  for (const entry of initialSessions) {
    if (!validToken(entry?.token)) throw new TypeError('initial account token is invalid');
    sessions.set(entry.token, {
      status: entry.status === 'revoked' || entry.status === 'pending' ? entry.status : 'active',
      account: cleanAccount(entry.account ?? account),
      replaces: null,
    });
  }

  function snapshot(token) {
    const entry = sessions.get(token);
    return entry?.status === 'active'
      ? { state: 'signed-in', signedIn: true, account: entry.account }
      : entry?.status === 'pending'
        ? { state: 'pending', signedIn: false, account: null }
        : { state: 'signed-out', signedIn: false, account: null };
  }

  return {
    async startLogin({ currentToken = null } = {}) {
      const id = randomUUID();
      logins.set(id, {
        currentToken: sessions.get(currentToken)?.status === 'active' ? currentToken : null,
      });
      return {
        handle: { id },
        authUrl: `https://accounts.rau.test/login/${id}`,
        pairingCode: 'RAU-123',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      };
    },
    async redeemLogin(handle) {
      const login = logins.get(handle?.id);
      if (!login) throw accountError('ACCOUNT_LOGIN_NOT_FOUND', '계정 로그인이 만료됐어요.');
      const token = `rau_account_v1_${randomBytes(32).toString('base64url')}`;
      sessions.set(token, {
        status: 'pending',
        account: cleanAccount(account),
        replaces: login.currentToken,
      });
      login.issuedToken = token;
      return { token, account: cleanAccount(account) };
    },
    async acknowledgeLogin(handle) {
      logins.delete(handle?.id);
      return { status: 'redeemed' };
    },
    async cancelLogin(handle) {
      const login = logins.get(handle?.id);
      const issued = login?.issuedToken ? sessions.get(login.issuedToken) : null;
      if (issued?.status === 'pending') issued.status = 'revoked';
      logins.delete(handle?.id);
    },
    async readStatus(token) {
      return snapshot(token);
    },
    async commitSession(token) {
      const entry = sessions.get(token);
      if (!entry || entry.status === 'revoked') {
        throw accountError('ACCOUNT_SESSION_INVALID', '계정 세션을 확인할 수 없어요.');
      }
      entry.status = 'active';
      if (entry.replaces && sessions.has(entry.replaces)) {
        sessions.get(entry.replaces).status = 'revoked';
      }
      return snapshot(token);
    },
    async revokeSession(token) {
      const entry = sessions.get(token);
      if (entry) entry.status = 'revoked';
      return { state: 'signed-out', signedIn: false, account: null };
    },
    async authorizeOwnedBackend(token, request) {
      const entry = sessions.get(token);
      if (!entry || entry.status !== 'active') {
        throw accountError('ACCOUNT_SESSION_UNAUTHORIZED', '계정 로그인이 필요해요.');
      }
      return authorize({ account: entry.account }, request);
    },
    inspect() {
      return {
        sessions: new Map([...sessions].map(([token, entry]) => [token, structuredClone(entry)])),
        logins: new Map([...logins].map(([id, entry]) => [id, structuredClone(entry)])),
      };
    },
  };
}

/**
 * Account identity and credential lifecycle behind one small interface.
 * Tokens never cross this interface; callers receive only sanitized status.
 */
export function createAccountSession({
  secretStore,
  backend = null,
  creditsClient = null,
  secretId = ACCOUNT_SESSION_SECRET_ID,
  now = Date.now,
  createLoginId = randomUUID,
} = {}) {
  if (!secretStore || typeof secretStore.get !== 'function'
    || typeof secretStore.set !== 'function' || typeof secretStore.delete !== 'function') {
    throw new TypeError('account session requires a secret store');
  }
  const ownedBackend = requireBackend(backend ?? createRauAccountBackendAdapter({
    ...(creditsClient ? { creditsClient } : {}),
  }));
  const attempts = new Map();
  let mutationChain = Promise.resolve();

  function serialize(operation) {
    const running = mutationChain.then(operation, operation);
    mutationChain = running.catch(() => {});
    return running;
  }

  async function localToken() {
    const token = await secretStore.get(secretId);
    if (token == null) return null;
    if (!validToken(token)) {
      await secretStore.delete(secretId);
      return null;
    }
    return token;
  }

  async function restoreToken(previousToken) {
    if (previousToken) await secretStore.set(secretId, previousToken);
    else await secretStore.delete(secretId);
  }

  async function rollbackPublishedToken(previousToken, newToken, cause) {
    try {
      await restoreToken(previousToken);
      await ownedBackend.revokeSession(newToken).catch(() => {});
    } catch (rollbackError) {
      throw Object.assign(new AggregateError(
        [cause, rollbackError],
        'The account credential could not be rolled back safely.',
        { cause },
      ), { code: 'ACCOUNT_SESSION_RECOVERY_REQUIRED' });
    }
  }

  async function statusWithinMutation({ signal } = {}) {
    let token;
    try {
      token = await localToken();
    } catch (error) {
      return publicStatus({
        state: 'unknown',
        error: error?.code ?? 'ACCOUNT_SESSION_LOCAL_STORE_UNAVAILABLE',
      }, now);
    }
    if (!token) return publicStatus({ state: 'signed-out' }, now);
    throwIfAborted(signal);
    try {
      let remote = await ownedBackend.readStatus(token, { signal });
      if (remote?.state === 'pending') {
        remote = await ownedBackend.commitSession(token, { signal });
      }
      if (remote?.signedIn === true && remote?.state === 'signed-in') {
        return publicStatus(remote, now);
      }
      await secretStore.delete(secretId);
      return publicStatus({ state: 'signed-out' }, now);
    } catch (error) {
      if (['ACCOUNT_SESSION_INVALID', 'ACCOUNT_SESSION_UNAUTHORIZED'].includes(error?.code)) {
        await secretStore.delete(secretId);
        return publicStatus({ state: 'signed-out' }, now);
      }
      return publicStatus({ state: 'unknown', error: error?.code ?? 'ACCOUNT_SESSION_UNAVAILABLE' }, now);
    }
  }

  return {
    status(options = {}) {
      return serialize(() => statusWithinMutation(options));
    },

    startLogin(options = {}) {
      return serialize(async () => {
        throwIfAborted(options.signal);
        const previousToken = await localToken();
        const started = await ownedBackend.startLogin({
          ...options,
          currentToken: previousToken,
        });
        throwIfAborted(options.signal);
        const loginId = createLoginId();
        const attempt = {
          handle: started.handle,
          previousToken,
          abort: new AbortController(),
          sourceSignal: options.signal ?? null,
          abortFromSource: null,
        };
        attempt.abortFromSource = () => {
          if (attempts.get(loginId) !== attempt) return;
          attempts.delete(loginId);
          attempt.abort.abort();
          void ownedBackend.cancelLogin(attempt.handle).catch(() => {});
        };
        options.signal?.addEventListener('abort', attempt.abortFromSource, { once: true });
        attempts.set(loginId, attempt);
        return {
          loginId,
          authUrl: typeof started.authUrl === 'string' ? started.authUrl : null,
          pairingCode: typeof started.pairingCode === 'string' ? started.pairingCode : null,
          expiresAt: typeof started.expiresAt === 'string' ? started.expiresAt : null,
        };
      });
    },

    completeLogin(loginId, proof, {
      signal,
      onCommitted = null,
    } = {}) {
      return serialize(async () => {
        const attempt = attempts.get(loginId);
        if (!attempt) throw accountError('ACCOUNT_LOGIN_NOT_FOUND', '계정 로그인이 만료됐어요.');
        const abortFromCaller = () => attempt.abort.abort();
        if (signal?.aborted) abortFromCaller();
        else signal?.addEventListener('abort', abortFromCaller, { once: true });
        const operationSignal = attempt.abort.signal;
        let newToken = null;
        let published = false;
        let ownershipCommitted = false;
        let keepAttempt = false;
        try {
          throwIfAborted(operationSignal);
          const redeemed = await ownedBackend.redeemLogin(attempt.handle, proof, {
            signal: operationSignal,
          });
          if (!validToken(redeemed?.token)) {
            throw accountError('ACCOUNT_LOGIN_SERVER_INCOMPATIBLE', '계정 세션을 받지 못했어요.');
          }
          newToken = redeemed.token;
          throwIfAborted(operationSignal);
          await secretStore.set(secretId, newToken);
          published = true;
          throwIfAborted(operationSignal);
          if (typeof onCommitted === 'function') await onCommitted();
          ownershipCommitted = true;

          let committed;
          try {
            committed = await ownedBackend.commitSession(newToken, { signal: operationSignal });
            if (committed?.signedIn !== true || committed?.state !== 'signed-in') {
              const error = accountError(
                'ACCOUNT_SESSION_COMMIT_REJECTED',
                '계정 세션을 활성화하지 못했어요.',
              );
              error.fromCreditsService = true;
              throw error;
            }
          } catch (error) {
            const observed = await ownedBackend.readStatus(newToken, {
              signal: operationSignal,
            }).catch(() => null);
            if (observed?.signedIn === true && observed?.state === 'signed-in') {
              committed = observed;
            } else if (observed?.state === 'pending' || error?.fromCreditsService === true) {
              await rollbackPublishedToken(attempt.previousToken, newToken, error);
              published = false;
              throw error;
            } else {
              throw accountError(
                'ACCOUNT_SESSION_COMMIT_UNCERTAIN',
                '계정 세션 확인이 지연되고 있어요. 연결되면 자동으로 다시 확인합니다.',
                error,
              );
            }
          }
          await ownedBackend.acknowledgeLogin(attempt.handle, proof, {
            signal: operationSignal,
          }).catch(() => {});
          return publicStatus(committed, now);
        } catch (error) {
          keepAttempt = error?.code === 'DEVICE_PROOF_INVALID' && !operationSignal.aborted;
          if (newToken && (!published || !ownershipCommitted)) {
            if (published) await rollbackPublishedToken(attempt.previousToken, newToken, error);
            else await ownedBackend.revokeSession(newToken).catch(() => {});
          }
          if (operationSignal.aborted
            && !['ACCOUNT_LOGIN_CANCELLED', 'AGENT_AUTH_CANCELLED'].includes(error?.code)) {
            throw cancelledError();
          }
          throw error;
        } finally {
          if (!keepAttempt) {
            attempts.delete(loginId);
            attempt.sourceSignal?.removeEventListener('abort', attempt.abortFromSource);
          }
          signal?.removeEventListener('abort', abortFromCaller);
        }
      });
    },

    async cancelLogin(loginId) {
      const attempt = attempts.get(loginId);
      if (!attempt) return false;
      attempts.delete(loginId);
      attempt.sourceSignal?.removeEventListener('abort', attempt.abortFromSource);
      attempt.abort.abort();
      await ownedBackend.cancelLogin(attempt.handle).catch(() => {});
      return true;
    },

    logout({ signal } = {}) {
      return serialize(async () => {
        const token = await localToken();
        if (!token) return publicStatus({ state: 'signed-out' }, now);
        throwIfAborted(signal);
        try {
          await ownedBackend.revokeSession(token, { signal });
          await secretStore.delete(secretId);
          return publicStatus({ state: 'signed-out' }, now);
        } catch (error) {
          const observed = await ownedBackend.readStatus(token, { signal }).catch(() => null);
          if (observed && observed.state !== 'signed-in' && observed.state !== 'pending') {
            await secretStore.delete(secretId);
            return publicStatus({ state: 'signed-out' }, now);
          }
          throw error;
        }
      });
    },

    async authorizeOwnedBackend(request, { signal } = {}) {
      const token = await serialize(() => localToken());
      if (!token) throw accountError('ACCOUNT_SESSION_UNAUTHORIZED', '계정 로그인이 필요해요.');
      throwIfAborted(signal);
      return ownedBackend.authorizeOwnedBackend(token, request, { signal });
    },
  };
}
