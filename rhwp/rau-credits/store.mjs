import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_STORE_BYTES = 8 * 1024 * 1024;

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set([
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
]);

const WINDOWS_DIRECTORY_OPEN_ERRORS = new Set([
  'EACCES',
  'EISDIR',
  'EPERM',
]);

function emptyState() {
  return { users: {}, sessions: {} };
}

export function createMemoryStore(initial = emptyState()) {
  let state = structuredClone(initial);
  return {
    async load() {
      return structuredClone(state);
    },
    async save(next) {
      state = structuredClone(next);
    },
  };
}

/**
 * Flush a directory entry after an atomic rename. Some platforms report a
 * specific "not supported" error for directory handles. Disk and I/O errors
 * still reject the save because they can mean the rename is not durable.
 */
export async function syncDirectory(directory, {
  openImpl = fs.open,
  platform = process.platform,
} = {}) {
  let handle;
  try {
    handle = await openImpl(directory, 'r');
    await handle.sync();
  } catch (error) {
    const unsupported = UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(error?.code)
      || (platform === 'win32' && WINDOWS_DIRECTORY_OPEN_ERRORS.has(error?.code));
    if (!unsupported) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function createFileStore(filePath, {
  syncDirectoryImpl = syncDirectory,
} = {}) {
  let chain = Promise.resolve();

  async function readState() {
    let handle;
    try {
      handle = await fs.open(filePath, 'r');
      const info = await handle.stat();
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1
        || info.size > MAX_STORE_BYTES) {
        throw new Error('Rau credits state is empty, oversized, or not a regular file');
      }
      const bytes = Buffer.allocUnsafe(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new Error('Rau credits state changed while it was being read');
        offset += bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
        throw new Error('Rau credits state changed while it was being read');
      }
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function writeState(serialized) {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temp, filePath);
      await syncDirectoryImpl(directory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    async load() {
      // A caller that observed a failed save may safely retry from the last
      // durable file; never race a read against a still-running rename.
      await chain.catch(() => {});
      return readState();
    },
    async save(next) {
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
        throw new Error('Rau credits state exceeds the 8 MiB safety limit');
      }
      chain = chain.then(
        () => writeState(serialized),
        () => writeState(serialized),
      );
      return chain;
    },
  };
}
