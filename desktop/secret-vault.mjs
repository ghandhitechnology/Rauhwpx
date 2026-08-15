import { promises as fs } from 'node:fs';
import path from 'node:path';

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

async function retryWindows(operation, platform) {
  const delays = [50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (platform !== 'win32' || !LOCK_CODES.has(error?.code) || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function replaceFile(temp, target, platform) {
  if (platform !== 'win32') return fs.rename(temp, target);
  const previous = `${target}.previous-write`;
  await retryWindows(() => fs.rm(previous, { force: true }), platform);
  let moved = false;
  try {
    await retryWindows(() => fs.rename(target, previous), platform);
    moved = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await retryWindows(() => fs.rename(temp, target), platform);
  } catch (error) {
    if (moved) await retryWindows(() => fs.rename(previous, target), platform).catch(() => {});
    throw error;
  }
  if (moved) await retryWindows(() => fs.rm(previous, { force: true }), platform);
}

/** OS-backed encrypted secret storage owned exclusively by Electron main. */
export function createSecretVault({ filePath, safeStorage, platform = process.platform }) {
  let loaded = false;
  let entries = {};
  let writeChain = Promise.resolve();

  async function assertAvailable() {
    if (!safeStorage || !(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable.');
    }
    if (platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('A system keyring is required to store API keys securely.');
    }
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
      entries = raw?.version === 1 && raw?.secrets && typeof raw.secrets === 'object'
        ? { ...raw.secrets }
        : {};
    } catch {}
  }

  function persist() {
    const job = writeChain.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(temp, `${JSON.stringify({ version: 1, secrets: entries }, null, 2)}\n`, 'utf8');
      await replaceFile(temp, filePath, platform);
    });
    writeChain = job.catch(() => {});
    return job;
  }

  function assertKey(key) {
    if (!KEY_RE.test(String(key ?? ''))) throw new Error('Invalid secret identifier.');
    return String(key);
  }

  return {
    async get(key) {
      await assertAvailable();
      await load();
      const id = assertKey(key);
      const encoded = entries[id];
      if (typeof encoded !== 'string' || !encoded) return null;
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encoded, 'base64'));
      if (decrypted.shouldReEncrypt) {
        entries[id] = (await safeStorage.encryptStringAsync(decrypted.result)).toString('base64');
        await persist();
      }
      return decrypted.result;
    },
    async set(key, value) {
      await assertAvailable();
      await load();
      const id = assertKey(key);
      const plain = String(value ?? '');
      if (!plain) throw new Error('Secret value is empty.');
      entries[id] = (await safeStorage.encryptStringAsync(plain)).toString('base64');
      await persist();
      return true;
    },
    async delete(key) {
      await assertAvailable();
      await load();
      const id = assertKey(key);
      if (!(id in entries)) return false;
      delete entries[id];
      await persist();
      return true;
    },
  };
}

export async function handleSecretRequest(vault, message) {
  if (!message || message.type !== 'rhwp-secret-request' || typeof message.id !== 'string') return null;
  const response = { type: 'rhwp-secret-response', id: message.id };
  try {
    if (message.operation === 'get') response.value = await vault.get(message.key);
    else if (message.operation === 'set') response.value = await vault.set(message.key, message.value);
    else if (message.operation === 'delete') response.value = await vault.delete(message.key);
    else throw new Error('Unsupported secret operation.');
    response.ok = true;
  } catch (error) {
    response.ok = false;
    response.error = error instanceof Error ? error.message : String(error);
  }
  return response;
}
