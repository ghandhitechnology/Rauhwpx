import crypto from 'node:crypto';

export function createIpcSecretStore({ processRef = process, timeoutMs = 10_000 } = {}) {
  const pending = new Map();
  const available = processRef.env?.RHWP_SECRET_BROKER === 'ipc' && typeof processRef.send === 'function';

  processRef.on?.('message', (message) => {
    if (!message || message.type !== 'rhwp-secret-response' || typeof message.id !== 'string') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.value ?? null);
    else request.reject(Object.assign(new Error(message.error || 'Secure secret storage failed.'), {
      code: 'SECRET_STORE_FAILED',
    }));
  });

  function request(operation, key, value) {
    if (!available) {
      return Promise.reject(Object.assign(new Error('Secure secret storage requires the Rauhwpx desktop app.'), {
        code: 'SECRET_STORE_UNAVAILABLE',
      }));
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('Secure secret storage did not respond.'), { code: 'SECRET_STORE_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      processRef.send({ type: 'rhwp-secret-request', id, operation, key, ...(value ? { value } : {}) }, (error) => {
        if (!error) return;
        const current = pending.get(id);
        if (!current) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(Object.assign(error, { code: 'SECRET_STORE_FAILED' }));
      });
    });
  }

  return {
    available,
    get: (key) => request('get', key),
    set: (key, value) => request('set', key, value),
    delete: (key) => request('delete', key),
  };
}

export function createMemorySecretStore(initial = {}) {
  const secrets = new Map(Object.entries(initial));
  return {
    available: true,
    async get(key) { return secrets.get(key) ?? null; },
    async set(key, value) { secrets.set(key, String(value)); return true; },
    async delete(key) { return secrets.delete(key); },
  };
}
