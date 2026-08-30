import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('external picture files use the shared 64 MiB pre-allocation guard', () => {
  for (const relativePath of [
    '../src/engine/input-handler-picture.ts',
    '../src/engine/input-handler-keyboard.ts',
    '../src/command/commands/insert.ts',
    '../src/versioning/controller.ts',
  ]) {
    const code = source(relativePath);
    assert.match(code, /readBlobBytesWithLimit\(file, INSERTED_IMAGE_MAX_BYTES/);
    assert.doesNotMatch(code, /file\.arrayBuffer\(\)/);
  }
});

test('smaller upload policies remain enforced at the actual read', () => {
  const manualConflict = source('../src/merge/manual-conflict-editor.ts');
  assert.match(manualConflict, /readBlobBytesWithLimit\(file, MAX_IMAGE_UPLOAD_BYTES/);
  assert.doesNotMatch(manualConflict, /file\.arrayBuffer\(\)/);

  const calibration = source('../src/ui/agent-sidebar/writing-style-calibration.ts');
  assert.match(calibration, /readBlobBytesWithLimit\(file, MAX_FILE_BYTES/);
  assert.doesNotMatch(calibration, /file\.arrayBuffer\(\)/);

  const compare = source('../src/ui/compare-dialog.ts');
  assert.match(compare, /readBlobBytesWithLimit\(selected, UNTRUSTED_DOCUMENT_MAX_BYTES/);
  assert.doesNotMatch(compare, /selected\.arrayBuffer\(\)/);
});

test('save identity and dev external images have allocation bounds', () => {
  const main = source('../src/main.ts');
  assert.match(
    main,
    /const targetBytes = await readBlobBytesWithLimit\([\s\S]*?EXACT_LOCAL_DOCUMENT_MAX_BYTES/,
  );
  assert.doesNotMatch(main, /target\.arrayBuffer\(\)/);

  const bridge = source('../src/core/wasm-bridge.ts');
  assert.match(
    bridge,
    /readResponseBytesWithLimit\([\s\S]*?INSERTED_IMAGE_MAX_BYTES[\s\S]*?doc\.injectExternalImage/,
  );
  assert.doesNotMatch(bridge, /res\.arrayBuffer\(\)/);
});

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

test('portable history keeps archive views, copies only at storage, and adopts one parse', () => {
  const portable = source('../src/versioning/portable-bundle.ts');
  assert.match(portable, /bytes:\s*payload/);
  assert.doesNotMatch(portable, /bytes:\s*new Uint8Array\(payload\)/);
  assert.match(portable, /currentDocumentBytes:\s*current\.bytes/);

  const store = source('../src/versioning/store.ts');
  assert.match(store, /sortedRepositorySnapshot\(input, \{ copyBlobBytes: false \}\)/);
  assert.match(store, /assertStoredBlob\(blob, \{ copyBytes: false \}\)/);
  assert.match(store, /await tx\.put\('blobs', assertStoredBlob\(blob\)\)/);

  const main = source('../src/main.ts');
  assert.doesNotMatch(main, /const probe = new WasmBridge\(\)/);
  assert.match(main, /preparedDocument = wasm\.prepareDocument\(/);
  assert.match(main, /wasm\.adoptPreparedDocument\(options\.preparedDocument\)/);

  const bridge = source('../src/core/wasm-bridge.ts');
  assert.match(bridge, /prepareDocument\(data: Uint8Array/);
  assert.match(bridge, /adoptPreparedDocument\(prepared: PreparedWasmDocument\)/);
});
