import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeArchivePath } from './desktop-package-paths.mjs';

test('ASAR listings use one archive namespace on Windows and POSIX', () => {
  assert.equal(normalizeArchivePath('\\desktop\\main.mjs'), '/desktop/main.mjs');
  assert.equal(
    normalizeArchivePath('\\rhwp\\rhwp-studio\\dist\\assets\\rhwp_bg-test.wasm'),
    '/rhwp/rhwp-studio/dist/assets/rhwp_bg-test.wasm',
  );
  assert.equal(normalizeArchivePath('/desktop/main.mjs'), '/desktop/main.mjs');
});

test('the credits model catalogue is unpacked beside the packaged agent hub', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.build.files.includes('rhwp/rau-credits/catalog.mjs'));
  assert.ok(manifest.build.asarUnpack.includes('rhwp/rau-credits/catalog.mjs'));
});
