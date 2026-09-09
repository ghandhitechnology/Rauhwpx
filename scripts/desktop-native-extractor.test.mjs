import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  nativeExtractorFileName,
  packagedStagedNativeExtractorPath,
  sourceStagedNativeExtractorPath,
} from '../desktop/native-rhwp-path.mjs';

test('Windows staging and packaged Studio extractor share win32-x64/rhwp.exe', () => {
  assert.equal(nativeExtractorFileName('win32'), 'rhwp.exe');
  assert.equal(
    sourceStagedNativeExtractorPath(join('repo', 'desktop'), 'win32', 'x64'),
    join('repo', 'desktop', 'bin', 'win32-x64', 'rhwp.exe'),
  );
  assert.equal(
    packagedStagedNativeExtractorPath(join('win-unpacked', 'resources'), 'win32', 'x64'),
    join(
      'win-unpacked',
      'resources',
      'app.asar.unpacked',
      'desktop',
      'bin',
      'win32-x64',
      'rhwp.exe',
    ),
  );
});

test('macOS staging keeps the darwin-arm64 extractor name', () => {
  assert.equal(nativeExtractorFileName('darwin'), 'rhwp');
  assert.equal(
    sourceStagedNativeExtractorPath(join('repo', 'desktop'), 'darwin', 'arm64'),
    join('repo', 'desktop', 'bin', 'darwin-arm64', 'rhwp'),
  );
});
