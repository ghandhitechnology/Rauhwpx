import assert from 'node:assert/strict';
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
