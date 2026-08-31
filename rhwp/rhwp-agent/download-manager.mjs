import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_CHAT = 20;
const DEFAULT_MAX_CHAT_BYTES = 512 * 1024 * 1024;
const DEFAULT_FREE_SPACE_RESERVE = 50 * 1024 * 1024;

const blockedIpv6 = new net.BlockList();
for (const [network, prefix] of [
  ['::', 96], // IPv4-compatible addresses, including ::127.0.0.1.
  ['::ffff:0:0', 96], // IPv4-mapped addresses use the ordinary A route instead.
  ['64:ff9b::', 96], // NAT64 can otherwise translate to private IPv4 space.
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32], // Teredo.
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds an IPv4 destination.
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) blockedIpv6.addSubnet(network, prefix, 'ipv6');

function downloadError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPublicIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  return !(a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224);
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  const mappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedDotted) return isPublicIpv4(mappedDotted);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPublicIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return !blockedIpv6.check(normalized, 'ipv6');
}

async function resolvePublicAddress(hostname) {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw downloadError('DOWNLOAD_ADDRESS_BLOCKED', `Downloads cannot access a local, private, or reserved address: ${hostname}`);
  }
  return addresses[0];
}

async function safeNetworkFetch(url, { signal } = {}) {
  const target = new URL(url);
  if (target.username || target.password) {
    throw downloadError('DOWNLOAD_URL_INVALID', 'Download URLs cannot contain embedded credentials');
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const resolved = await resolvePublicAddress(hostname);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const options = {
      protocol: target.protocol,
      hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family),
      ...(target.protocol === 'https:' && net.isIP(hostname) === 0 ? { servername: hostname } : {}),
    };
    const request = transport.request(options, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) headers.append(name, String(item));
        }
      }
      resolve({
        status: response.statusCode ?? 0,
        ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
        headers,
        body: response,
      });
    });
    const abort = () => request.destroy(new DOMException('Download aborted', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    request.once('error', reject);
    request.once('close', () => signal?.removeEventListener('abort', abort));
    request.end();
  });
}

export function sanitizeFilename(value, fallback = 'download') {
  const leaf = path.basename(String(value ?? '').replaceAll('\\', '/'));
  const normalized = leaf.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim();
  let safe = normalized || fallback;
  const stem = path.basename(safe, path.extname(safe));
  if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i.test(stem)) {
    safe = `_${safe}`;
  }
  const ext = path.extname(safe);
  const stemLimit = Math.max(1, 180 - ext.length);
  return `${path.basename(safe, ext).slice(0, stemLimit)}${ext.slice(0, 30)}`;
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function pathsOverlap(first, second) {
  const left = path.resolve(first);
  const right = path.resolve(second);
  if (left === right) return true;
  return isPathInside(left, right) || isPathInside(right, left);
}

function sessionDirectoryName(sessionId) {
  const raw = String(sessionId ?? '');
  if (/^[a-zA-Z0-9_-]{1,100}$/.test(raw)) return raw;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function filenameFromResponse(response, finalUrl) {
  const disposition = response.headers.get('content-disposition') ?? '';
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8); } catch {}
  }
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  const bare = disposition.match(/filename=([^;]+)/i)?.[1]?.trim();
  if (quoted || bare) return quoted ?? bare;
  try {
    const pathname = new URL(finalUrl).pathname;
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
  } catch {
    return 'download';
  }
}

async function ensurePlainDirectory(directory) {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw downloadError('DOWNLOAD_PATH_UNSAFE', `Download directory is not a plain directory: ${directory}`);
  }
}

async function assertDiskCapacity(directory, incomingBytes, reserveBytes) {
  if (typeof fs.statfs !== 'function') return;
  const stats = await fs.statfs(directory);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (Number.isFinite(freeBytes) && freeBytes < incomingBytes + reserveBytes) {
    throw downloadError('DOWNLOAD_DISK_FULL', 'Not enough free disk space to safely store this download');
  }
}

async function chatUsage(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const stat = await fs.lstat(candidate);
    if (!entry.isFile() || stat.isSymbolicLink()) {
      throw downloadError('DOWNLOAD_PATH_UNSAFE', 'Download chat directory contains a non-plain file');
    }
    files += 1;
    bytes += stat.size;
    if (!Number.isSafeInteger(bytes)) {
      throw downloadError('DOWNLOAD_QUOTA_EXCEEDED', 'Download chat storage accounting overflowed');
    }
  }
  return { files, bytes };
}

async function openUniqueFile(directory, requestedName) {
  const safeName = sanitizeFilename(requestedName);
  const ext = path.extname(safeName);
  const stem = path.basename(safeName, ext);
  for (let index = 0; index < 10_000; index++) {
    const name = index === 0 ? safeName : `${stem} (${index})${ext}`;
    const candidate = path.resolve(directory, name);
    if (!isPathInside(directory, candidate)) throw downloadError('DOWNLOAD_PATH_ESCAPE', 'Resolved download path escaped its chat directory');
    try {
      const handle = await fs.open(candidate, 'wx', 0o600);
      return { handle, path: candidate };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw downloadError('DOWNLOAD_NAME_EXHAUSTED', 'Could not allocate a unique download filename');
}

async function cancelResponseBody(response) {
  try {
    if (typeof response?.body?.cancel === 'function') await response.body.cancel();
    else response?.body?.destroy?.();
  } catch {}
}

async function fetchWithRedirects(url, { signal, maxRedirects, fetchImpl }) {
  let current = new URL(url);
  for (let count = 0; count <= maxRedirects; count++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw downloadError('DOWNLOAD_URL_INVALID', 'Downloads must use http or https');
    }
    const response = await fetchImpl(current, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current.href };
    if (count === maxRedirects) {
      await cancelResponseBody(response);
      throw downloadError('DOWNLOAD_REDIRECT_LIMIT', `Download exceeded ${maxRedirects} redirects`);
    }
    const location = response.headers.get('location');
    if (!location) {
      await cancelResponseBody(response);
      throw downloadError('DOWNLOAD_REDIRECT_INVALID', 'Redirect response did not include a Location header');
    }
    await cancelResponseBody(response);
    current = new URL(location, current);
  }
  throw downloadError('DOWNLOAD_REDIRECT_LIMIT', `Download exceeded ${maxRedirects} redirects`);
}

export class DownloadManager {
  /**
   * @param {{rootDir: string, timeoutMs?: number, maxRedirects?: number, maxBytes?: number,
   *   maxFilesPerChat?: number, maxChatBytes?: number, freeSpaceReserve?: number,
   *   writableRoot?: string, fetchImpl?: typeof fetch}} options
   */
  constructor(options) {
    if (!options?.rootDir) throw new Error('DownloadManager requires a hub-owned rootDir');
    if (options.writableRoot && pathsOverlap(options.rootDir, options.writableRoot)) {
      throw new Error('DownloadManager storage must not overlap the provider-writable root');
    }
    this.agentDir = path.resolve(options.rootDir, '.rhwp-agent');
    this.baseDir = path.resolve(this.agentDir, 'downloads');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFilesPerChat = options.maxFilesPerChat ?? DEFAULT_MAX_FILES_PER_CHAT;
    this.maxChatBytes = options.maxChatBytes ?? DEFAULT_MAX_CHAT_BYTES;
    this.freeSpaceReserve = options.freeSpaceReserve ?? DEFAULT_FREE_SPACE_RESERVE;
    this.fetchImpl = options.fetchImpl ?? safeNetworkFetch;
    this.chatQueues = new Map();
  }

  chatDirectory(sessionId) {
    const directory = path.resolve(this.baseDir, sessionDirectoryName(sessionId));
    if (!isPathInside(this.baseDir, directory)) throw downloadError('DOWNLOAD_PATH_ESCAPE', 'Invalid chat download directory');
    return directory;
  }

  download(args) {
    const queueKey = sessionDirectoryName(args.sessionId);
    const previous = this.chatQueues.get(queueKey) ?? Promise.resolve();
    const running = previous.then(() => this.downloadSerial(args), () => this.downloadSerial(args));
    const tail = running.catch(() => {});
    this.chatQueues.set(queueKey, tail);
    return running.finally(() => {
      if (this.chatQueues.get(queueKey) === tail) this.chatQueues.delete(queueKey);
    });
  }

  async downloadSerial({ sessionId, url, filename }) {
    const originalUrl = new URL(url);
    if (originalUrl.protocol !== 'http:' && originalUrl.protocol !== 'https:') {
      throw downloadError('DOWNLOAD_URL_INVALID', 'Downloads must use http or https');
    }
    const directory = this.chatDirectory(sessionId);
    await ensurePlainDirectory(this.agentDir);
    await ensurePlainDirectory(this.baseDir);
    await ensurePlainDirectory(directory);
    const existing = await chatUsage(directory);
    if (existing.files >= this.maxFilesPerChat) {
      throw downloadError('DOWNLOAD_FILE_LIMIT', `A chat can keep at most ${this.maxFilesPerChat} downloads`);
    }
    await assertDiskCapacity(directory, this.maxBytes, this.freeSpaceReserve);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let destination = null;
    let handle = null;
    let response = null;
    let responseBodyFinished = false;
    try {
      const fetched = await fetchWithRedirects(originalUrl, {
        signal: controller.signal,
        maxRedirects: this.maxRedirects,
        fetchImpl: this.fetchImpl,
      });
      ({ response } = fetched);
      const { finalUrl } = fetched;
      if (!response.ok) throw downloadError('DOWNLOAD_HTTP_ERROR', `Download failed with HTTP ${response.status}`);
      if (!response.body) throw downloadError('DOWNLOAD_EMPTY_RESPONSE', 'Download response had no body');
      const declaredSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > this.maxBytes) {
        throw downloadError('DOWNLOAD_TOO_LARGE', `Download exceeds the ${this.maxBytes}-byte safety limit`);
      }
      if (Number.isFinite(declaredSize) && declaredSize >= 0
        && existing.bytes + declaredSize > this.maxChatBytes) {
        throw downloadError('DOWNLOAD_CHAT_QUOTA', `Downloads exceed the ${this.maxChatBytes}-byte chat limit`);
      }
      if (Number.isFinite(declaredSize) && declaredSize >= 0) {
        await assertDiskCapacity(directory, declaredSize, this.freeSpaceReserve);
      }

      const requestedName = filename ?? filenameFromResponse(response, finalUrl);
      ({ handle, path: destination } = await openUniqueFile(directory, requestedName));
      const hash = crypto.createHash('sha256');
      let size = 0;
      for await (const rawChunk of response.body) {
        const chunk = Buffer.from(rawChunk);
        size += chunk.length;
        if (size > this.maxBytes) throw downloadError('DOWNLOAD_TOO_LARGE', `Download exceeds the ${this.maxBytes}-byte safety limit`);
        if (existing.bytes + size > this.maxChatBytes) {
          throw downloadError('DOWNLOAD_CHAT_QUOTA', `Downloads exceed the ${this.maxChatBytes}-byte chat limit`);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      responseBodyFinished = true;
      await handle.sync();
      await handle.close();
      handle = null;
      return {
        path: destination,
        mime: response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream',
        size,
        source: originalUrl.href,
        finalUrl,
        checksum: `sha256:${hash.digest('hex')}`,
      };
    } catch (error) {
      try { await handle?.close(); } catch {}
      if (destination) {
        try { await fs.unlink(destination); } catch {}
      }
      if (error?.name === 'AbortError') throw downloadError('DOWNLOAD_TIMEOUT', `Download timed out after ${this.timeoutMs}ms`);
      if (error?.code) throw error;
      throw downloadError('DOWNLOAD_FAILED', String(error?.message ?? error));
    } finally {
      clearTimeout(timer);
      if (!responseBodyFinished) await cancelResponseBody(response);
    }
  }
}
