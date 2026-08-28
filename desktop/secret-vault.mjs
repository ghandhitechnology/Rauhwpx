import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
const LINUX_SECURE_STORAGE_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
]);

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
  const previous = path.join(path.dirname(target), `.${path.basename(target)}.previous-write-${randomUUID()}`);
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
    if (!safeStorage
      || typeof safeStorage.isAsyncEncryptionAvailable !== 'function'
      || !(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable.');
    }
    if (platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend?.();
      if (!LINUX_SECURE_STORAGE_BACKENDS.has(backend)) {
        throw new Error('A Secret Service or KWallet system keyring is required to store API keys securely.');
      }
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
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Keep the unreadable file around instead of letting the next persist() overwrite it.
        const corrupt = `${filePath}.corrupt-${Date.now()}`;
        await fs.rename(filePath, corrupt).catch(() => {});
        console.warn(`[rauhwpx] cloud credential store was unreadable; moved it to ${path.basename(corrupt)}`);
      }
      entries = {};
    }
  }

  function persist() {
    const job = writeChain.then(async () => {
      const directory = path.dirname(filePath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (platform !== 'win32') await fs.chmod(directory, 0o700);
      const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await fs.writeFile(
          temp,
          `${JSON.stringify({ version: 1, secrets: entries }, null, 2)}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
        await replaceFile(temp, filePath, platform);
        if (platform !== 'win32') await fs.chmod(filePath, 0o600);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
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
