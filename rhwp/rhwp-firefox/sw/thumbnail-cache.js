export const THUMBNAIL_CACHE_MAX_ENTRIES = 32;
export const THUMBNAIL_CACHE_MAX_ESTIMATED_BYTES = 32 * 1024 * 1024;

export function estimateThumbnailCacheEntryBytes(url, value) {
  const urlBytes = typeof url === 'string' ? url.length * 2 : 0;
  const dataUriBytes = typeof value?.dataUri === 'string' ? value.dataUri.length * 2 : 0;
  return Math.min(Number.MAX_SAFE_INTEGER, urlBytes + dataUriBytes + 256);
}

export class BoundedThumbnailCache {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? THUMBNAIL_CACHE_MAX_ENTRIES;
    this.maxEstimatedBytes = options.maxEstimatedBytes ?? THUMBNAIL_CACHE_MAX_ESTIMATED_BYTES;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new TypeError('maxEntries must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(this.maxEstimatedBytes) || this.maxEstimatedBytes <= 0) {
      throw new TypeError('maxEstimatedBytes must be a positive safe integer.');
    }
    this.entries = new Map();
    this.estimatedBytes = 0;
  }

  get size() {
    return this.entries.size;
  }

  has(url) {
    return this.entries.has(url);
  }

  get(url) {
    const entry = this.entries.get(url);
    if (!entry) return undefined;
    this.entries.delete(url);
    this.entries.set(url, entry);
    return entry.value;
  }

  set(url, value) {
    if (typeof url !== 'string' || url.length === 0) return false;
    const existing = this.entries.get(url);
    if (existing) {
      this.entries.delete(url);
      this.estimatedBytes -= existing.estimatedBytes;
    }

    const estimatedBytes = estimateThumbnailCacheEntryBytes(url, value);
    if (estimatedBytes > this.maxEstimatedBytes) return false;
    while (
      this.entries.size >= this.maxEntries
      || this.estimatedBytes + estimatedBytes > this.maxEstimatedBytes
    ) {
      const oldestUrl = this.entries.keys().next().value;
      if (oldestUrl === undefined) break;
      const oldest = this.entries.get(oldestUrl);
      this.entries.delete(oldestUrl);
      this.estimatedBytes -= oldest.estimatedBytes;
    }
    this.entries.set(url, { value, estimatedBytes });
    this.estimatedBytes += estimatedBytes;
    return true;
  }
}
