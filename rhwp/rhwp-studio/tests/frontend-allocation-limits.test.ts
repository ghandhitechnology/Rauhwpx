import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('extension thumbnail fetches use the 64 MiB bounded stream reader', () => {
  for (const relativePath of [
    '../../rhwp-chrome/sw/thumbnail-extractor.js',
    '../../rhwp-firefox/sw/thumbnail-extractor.js',
  ]) {
    const code = source(relativePath);
    assert.match(code, /readResponseBytesWithLimit\(response, REMOTE_THUMBNAIL_MAX_BYTES\)/);
    assert.doesNotMatch(code, /response\.arrayBuffer\(\)/);
  }

  for (const relativePath of [
    '../../rhwp-chrome/sw/fetch-security.js',
    '../../rhwp-firefox/sw/fetch-security.js',
  ]) {
    assert.match(
      source(relativePath),
      /export const REMOTE_THUMBNAIL_MAX_BYTES = 64 \* 1024 \* 1024/,
    );
  }
});
