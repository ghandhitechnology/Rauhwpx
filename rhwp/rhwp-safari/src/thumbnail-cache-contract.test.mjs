import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const background = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('./content-script.js', import.meta.url), 'utf8');

for (const source of [background, content]) {
  assert.match(source, /THUMBNAIL_CACHE_MAX_ENTRIES = 32/);
  assert.match(source, /THUMBNAIL_CACHE_MAX_ESTIMATED_BYTES = 32 \* 1024 \* 1024/);
  assert.match(source, /value\.dataUri\.length \* 2/);
  assert.match(source, /estimatedBytes \+ entryBytes > THUMBNAIL_CACHE_MAX_ESTIMATED_BYTES/);
}
assert.match(background, /THUMBNAIL_CACHE\.set\(safeUrl, null\)/);
assert.doesNotMatch(content, /const thumbnailCache = new Map\(/);
assert.doesNotMatch(content, /prefetchQueue|prefetchThumbnails/, 'Safari must not add an uncapped prefetch path');

const router = background.slice(
  background.indexOf('browser.runtime.onMessage.addListener'),
  background.indexOf('// ─── HWP 썸네일 추출'),
);
assert.match(router, /case 'fetch-file':[\s\S]*?code: 'REMOTE_PROXY_UNAVAILABLE'/);
assert.match(router, /case 'extract-thumbnail':[\s\S]*?code: 'REMOTE_PROXY_UNAVAILABLE'/);
assert.match(router, /requirement: 'SERVER_FETCH_REQUIRED'/);
assert.doesNotMatch(router, /await fetch\(|extractThumbnailFromUrl\(/);

console.log('Safari bounded thumbnail-cache contracts passed');
