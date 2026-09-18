import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(rootDir, 'index.html'), 'utf8');

test('#6635 숨긴 글자색 input은 Tab 순서에서 제외한다', () => {
  assert.match(html, /id="text-color-picker"[^>]*tabindex="-1"/);
});
