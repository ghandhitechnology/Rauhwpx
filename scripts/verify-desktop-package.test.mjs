import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getMainFileMatchers } from 'app-builder-lib/out/fileMatcher.js';

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

test('packaging an installed development checkout excludes the agent compiler and keeps runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
  const packager = { info: {
    projectDir: root,
    buildResourcesDir: 'build',
    config: manifest.build,
    isPrepackedAppAsar: false,
    debugLogger: { isEnabled: false },
  } };
  const [matcher] = getMainFileMatchers(root, path.join(root, 'release', 'staged'), (value) => value, {}, packager, path.join(root, 'release'), false);
  const filter = matcher.createFilter();
  for (const name of ['typescript', '@typescript/typescript-darwin-arm64', '@typescript/typescript-win32-x64']) {
    assert.equal(filter(path.join(root, 'rhwp/rhwp-agent/node_modules', name, 'package.json'), { isDirectory: () => false }), false, name);
  }
  for (const name of ['tsc', 'tsc.cmd', 'tsc.ps1']) {
    assert.equal(filter(path.join(root, 'rhwp/rhwp-agent/node_modules/.bin', name), { isDirectory: () => false }), false, name);
  }
  for (const name of ['ws', 'cross-spawn', '@agentclientprotocol/sdk', '@browserbasehq/stagehand', '@types/node']) {
    assert.equal(filter(path.join(root, 'rhwp/rhwp-agent/node_modules', name, 'package.json'), { isDirectory: () => false }), true, name);
  }
});
