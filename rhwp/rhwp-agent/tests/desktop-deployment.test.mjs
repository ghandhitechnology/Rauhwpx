import assert from 'node:assert/strict';
import test from 'node:test';

import { packagedRhwpBinary } from '../../../desktop/agent-hub.mjs';
import { resolveDevelopmentUrl } from '../../../desktop/studio-protocol.mjs';

test('packaged apps ignore inherited development URLs', () => {
  assert.equal(resolveDevelopmentUrl({
    packaged: true,
    rawUrl: 'https://untrusted.example/app',
  }), '');
});

test('development URLs accept only loopback HTTP origins', () => {
  assert.equal(resolveDevelopmentUrl({
    packaged: false,
    rawUrl: ' http://127.0.0.1:7700 ',
  }), 'http://127.0.0.1:7700/');
  assert.throws(
    () => resolveDevelopmentUrl({ packaged: false, rawUrl: 'file:///tmp/index.html' }),
    /must use http or https/,
  );
  assert.throws(
    () => resolveDevelopmentUrl({ packaged: false, rawUrl: 'https://untrusted.example' }),
    /must use a loopback host/,
  );
});

test('packaged apps resolve the bundled extractor for each platform', () => {
  const seen = [];
  const exists = (path) => {
    seen.push(path);
    return true;
  };
  assert.equal(packagedRhwpBinary({
    packaged: true,
    resourcesPath: '/app/resources',
    platform: 'darwin',
    exists,
  }), '/app/resources/bin/rhwp');
  assert.match(packagedRhwpBinary({
    packaged: true,
    resourcesPath: 'C:\\app\\resources',
    platform: 'win32',
    exists,
  }), /bin[/\\]rhwp\.exe$/);
  assert.equal(seen.length, 2);
});

test('packaged apps fail before launch when the extractor is absent', () => {
  assert.throws(
    () => packagedRhwpBinary({
      packaged: true,
      resourcesPath: '/app/resources',
      exists: () => false,
    }),
    /Packaged document extractor is missing/,
  );
  assert.equal(packagedRhwpBinary({
    packaged: false,
    resourcesPath: '/app/resources',
    exists: () => false,
  }), null);
});
