import { randomUUID } from 'node:crypto';
import { open, rename } from 'node:fs/promises';

export const MAX_BOOKMARK_STATE_BYTES = 4 * 1024 * 1024;

function corrupt(message) {
  return Object.assign(new Error(message), { code: 'BOOKMARK_STATE_CORRUPT' });
}

export async function readBookmarkState(filePath, {
  openImpl = open,
  maxBytes = MAX_BOOKMARK_STATE_BYTES,
} = {}) {
  let handle;
  try {
    handle = await openImpl(filePath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maxBytes) {
      throw corrupt('Native bookmark state is empty, oversized, or not a regular file');
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw corrupt('Native bookmark state changed while it was read');
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead !== 0) {
      throw corrupt('Native bookmark state changed while it was read');
    }
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw corrupt('Native bookmark state is not valid JSON');
    }
    if (!Array.isArray(value)) throw corrupt('Native bookmark state must be an array');
    return value;
  } finally {
    await handle.close();
  }
}

export async function quarantineBookmarkState(filePath, {
  renameImpl = rename,
  suffix = `${Date.now()}-${randomUUID()}`,
} = {}) {
  const quarantinePath = `${filePath}.corrupt-${suffix}`;
  try {
    await renameImpl(filePath, quarantinePath);
    return quarantinePath;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
