import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BoundedThumbnailCache,
  THUMBNAIL_CACHE_MAX_ENTRIES,
  THUMBNAIL_CACHE_MAX_ESTIMATED_BYTES,
  estimateThumbnailCacheEntryBytes,
} from './thumbnail-cache.js';

assert.equal(THUMBNAIL_CACHE_MAX_ENTRIES, 32);
assert.equal(THUMBNAIL_CACHE_MAX_ESTIMATED_BYTES, 32 * 1024 * 1024);
assert.equal(
  estimateThumbnailCacheEntryBytes('abcd', { dataUri: '12345' }),
  (4 * 2) + (5 * 2) + 256,
  'data-URI strings must be budgeted conservatively as UTF-16',
);

const byCount = new BoundedThumbnailCache({ maxEntries: 2, maxEstimatedBytes: 4096 });
assert.equal(byCount.set('a', null), true, 'cached failures share the same bounded cache');
assert.equal(byCount.set('b', { dataUri: 'data:b' }), true);
assert.equal(byCount.get('a'), null, 'get refreshes LRU order');
assert.equal(byCount.set('c', { dataUri: 'data:c' }), true);
assert.equal(byCount.get('b'), undefined);
assert.equal(byCount.size, 2);

const byBytes = new BoundedThumbnailCache({ maxEntries: 10, maxEstimatedBytes: 300 });
assert.equal(byBytes.set('a', { dataUri: '1234567890' }), true);
assert.equal(byBytes.set('b', { dataUri: '1234567890' }), true);
assert.equal(byBytes.get('a'), undefined, 'byte budget evicts the oldest entry');
assert.equal(byBytes.size, 1);
assert.equal(byBytes.set('b', { dataUri: 'x'.repeat(100) }), false);
assert.equal(byBytes.size, 0, 'an oversized replacement is not retained');

const content = readFileSync(new URL('../content-script.js', import.meta.url), 'utf8');
assert.match(content, /const PREFETCH_URL_LIMIT = 20/);
assert.match(content, /prefetchedUrls\.size >= PREFETCH_URL_LIMIT/);
assert.match(content, /THUMBNAIL_CACHE_MAX_ESTIMATED_BYTES = 32 \* 1024 \* 1024/);
assert.match(content, /value\.dataUri\.length \* 2/);
assert.doesNotMatch(content, /const thumbnailCache = new Map\(/);

console.log('Chrome bounded thumbnail-cache tests passed');
