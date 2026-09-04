import { promises as fs } from 'node:fs';
import path from 'node:path';

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const LINUX_SECURE_STORAGE_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
]);
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
const MAX_VAULT_BYTES = 8 * 1024 * 1024;
const MAX_SECRET_ENTRIES = 256;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const MAX_ENCODED_SECRET_CHARS = 128 * 1024;

async function retryWindows(operation, platform) {
  const delays = [50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (platform !== 'win32' || !LOCK_CODES.has(error?.code) || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function replaceFile(temp, target, platform, operations) {
  if (platform !== 'win32') {
    await operations.rename(temp, target);
    return null;
  }
  const previous = `${target}.previous-write`;
  await retryWindows(() => operations.rm(previous, { force: true }), platform);
  let moved = false;
  try {
    await retryWindows(() => operations.rename(target, previous), platform);
    moved = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await retryWindows(() => operations.rename(temp, target), platform);
  } catch (error) {
    if (moved) {
      const restored = await retryWindows(
        () => operations.rename(previous, target),
        platform,
      ).then(() => true, () => false);
      if (!restored) {
        throw Object.assign(new Error('Secure secret storage rollback failed.'), {
          code: 'SECRET_VAULT_COMMIT_UNCERTAIN',
          cause: error,
          vaultStateUncertain: true,
        });
      }
    }
    throw error;
  }
  return moved ? previous : null;
}

/** OS-backed encrypted secret storage owned exclusively by Electron main. */
export function createSecretVault({
  filePath,
  safeStorage,
  platform = process.platform,
  fileOperations = {},
}) {
  const operations = {
    rename: fileOperations.rename ?? fs.rename,
    rm: fileOperations.rm ?? fs.rm,
    syncDirectory: fileOperations.syncDirectory ?? (async (directory) => {
      const handle = await fs.open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }),
  };
  let loadPromise = null;
  let entries = {};
  let mutationChain = Promise.resolve();
  let corruptError = null;
  const previousWritePath = `${filePath}.previous-write`;

  async function ensureVaultDirectory() {
    await fs.mkdir(path.dirname(filePath), {
      recursive: true,
      ...(platform === 'win32' ? {} : { mode: 0o700 }),
    });
  }

  async function readVault(vaultPath) {
    let handle;
    let bytes;
    try {
      handle = await fs.open(vaultPath, 'r');
      const info = await handle.stat();
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1
        || info.size > MAX_VAULT_BYTES) {
        throw new Error('Secure secret storage exceeds its size limit.');
      }
      bytes = Buffer.allocUnsafe(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new Error('Secure secret storage changed while it was being read.');
        offset += bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
        throw new Error('Secure secret storage changed while it was being read.');
      }
    } finally {
      await handle?.close().catch(() => {});
    }
    const raw = JSON.parse(bytes.toString('utf8'));
    const secretEntries = raw?.secrets && typeof raw.secrets === 'object'
      ? Object.entries(raw.secrets)
      : [];
    if (raw?.version !== 1 || !raw.secrets || typeof raw.secrets !== 'object'
      || Array.isArray(raw.secrets)
      || secretEntries.length > MAX_SECRET_ENTRIES
      || secretEntries.some(([key, value]) => (
        !KEY_RE.test(key) || typeof value !== 'string' || !value
        || value.length > MAX_ENCODED_SECRET_CHARS
      ))) {
      throw new Error('Secure secret storage has an invalid format.');
    }
    return { ...raw.secrets };
  }

  async function assertAvailable() {
    if (!safeStorage || !(await safeStorage.isAsyncEncryptionAvailable())) {
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
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          try {
            entries = await readVault(filePath);
            if (platform === 'win32') {
              // The committed primary is authoritative. Antivirus/indexer
              // locks on a stale backup must not relabel valid credentials as
              // corrupt; a later write or startup can retry this cleanup.
              await retryWindows(
                () => operations.rm(previousWritePath, { force: true }),
                platform,
              ).catch(() => {});
            }
          } catch (error) {
            if (platform !== 'win32' || error?.code !== 'ENOENT') throw error;
            try {
              entries = await readVault(previousWritePath);
            } catch (backupError) {
              if (backupError?.code === 'ENOENT') {
                entries = {};
                return;
              }
              throw backupError;
            }
            await ensureVaultDirectory();
            await retryWindows(() => operations.rename(previousWritePath, filePath), platform);
          }
        } catch (error) {
          if (error?.code === 'ENOENT') {
            entries = {};
            return;
          }
          corruptError = Object.assign(
            new Error('Secure secret storage is unreadable. Reset it before saving new credentials.'),
            { code: 'SECRET_VAULT_CORRUPT', cause: error },
          );
          throw corruptError;
        }
      })();
    }
    return loadPromise;
  }

  async function persist(nextEntries) {
    const items = Object.entries(nextEntries);
    if (items.length > MAX_SECRET_ENTRIES || items.some(([key, value]) => (
      !KEY_RE.test(key) || typeof value !== 'string' || !value
      || value.length > MAX_ENCODED_SECRET_CHARS
    ))) {
      throw new Error('Secure secret storage exceeds its entry or value limit.');
    }
    await ensureVaultDirectory();
    const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const serialized = `${JSON.stringify({ version: 1, secrets: nextEntries }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_VAULT_BYTES) {
      throw new Error('Secure secret storage exceeds its size limit.');
    }
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const staleBackup = await replaceFile(temp, filePath, platform, operations);
      // Rename is the commit boundary. Keep the cache aligned with the file even
      // if a later directory sync fails, or the next mutation could erase this write.
      entries = { ...nextEntries };
      if (staleBackup) {
        // The target already contains the new vault. Startup also removes this
        // backup, so antivirus locks during cleanup must not fail the committed write.
        await retryWindows(() => operations.rm(staleBackup, { force: true }), platform).catch(() => {});
      }
      if (platform !== 'win32') {
        await operations.syncDirectory(path.dirname(filePath));
      }
    } catch (error) {
      await operations.rm(temp, { force: true }).catch(() => {});
      if (error?.vaultStateUncertain) {
        corruptError = Object.assign(
          new Error('Secure secret storage replacement could not be recovered. Restart or reset the vault.'),
          { code: 'SECRET_VAULT_COMMIT_UNCERTAIN', cause: error },
        );
        throw corruptError;
      }
      throw error;
    }
  }

  function enqueue(operation) {
    const job = mutationChain.then(operation);
    mutationChain = job.then(() => undefined, () => undefined);
    return job;
  }

  function mutate(operation) {
    return enqueue(async () => {
      await assertAvailable();
      await load();
      if (corruptError) throw corruptError;
      const { next, value } = await operation({ ...entries });
      await persist(next);
      return value;
    });
  }

  function assertKey(key) {
    if (!KEY_RE.test(String(key ?? ''))) throw new Error('Invalid secret identifier.');
    return String(key);
  }

  return {
    async get(key) {
      const id = assertKey(key);
      return enqueue(async () => {
        await assertAvailable();
        await load();
        if (corruptError) throw corruptError;
        const encoded = entries[id];
        if (typeof encoded !== 'string' || !encoded) return null;
        let decrypted;
        try {
          decrypted = await safeStorage.decryptStringAsync(Buffer.from(encoded, 'base64'));
        } catch (error) {
          throw Object.assign(new Error('A stored credential cannot be decrypted. Reset the vault to continue.'), {
            code: 'SECRET_VAULT_DECRYPT_FAILED',
            cause: error,
          });
        }
        if (decrypted.shouldReEncrypt) {
          const replacement = (await safeStorage.encryptStringAsync(decrypted.result)).toString('base64');
          const next = { ...entries, [id]: replacement };
          await persist(next);
        }
        return decrypted.result;
      });
    },
    async set(key, value) {
      const id = assertKey(key);
      const plain = String(value ?? '');
      if (!plain) throw new Error('Secret value is empty.');
      if (Buffer.byteLength(plain, 'utf8') > MAX_SECRET_VALUE_BYTES) {
        throw new Error('Secret value exceeds the 64 KiB limit.');
      }
      return mutate(async (current) => ({
        next: {
          ...current,
          [id]: (await safeStorage.encryptStringAsync(plain)).toString('base64'),
        },
        value: true,
      }));
    },
    async delete(key) {
      const id = assertKey(key);
      return mutate(async (current) => {
        if (!(id in current)) return { next: current, value: false };
        delete current[id];
        return { next: current, value: true };
      });
    },
    async reset() {
      return enqueue(async () => {
        await assertAvailable();
        const stamp = Date.now();
        for (const [candidate, suffix] of [
          [filePath, ''],
          [previousWritePath, '-previous-write'],
        ]) {
          try {
            await retryWindows(
              () => operations.rename(candidate, `${filePath}.reset-${stamp}${suffix}`),
              platform,
            );
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
        entries = {};
        corruptError = null;
        loadPromise = Promise.resolve();
        await persist(entries);
        return true;
      });
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
    else if (message.operation === 'reset') response.value = await vault.reset();
    else throw new Error('Unsupported secret operation.');
    response.ok = true;
  } catch (error) {
    response.ok = false;
    response.error = error instanceof Error ? error.message : String(error);
    response.code = error?.code ?? 'SECRET_STORE_FAILED';
  }
  return response;
}
