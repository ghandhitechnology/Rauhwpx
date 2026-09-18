import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} source range must exist`);
  return main.slice(start, end);
}

test('cloud runtime document loads bypass guards and dialogs without changing ordinary loads', () => {
  const cloudRuntime = sourceBetween(
    'function installCloudDocumentRuntimeApi',
    '\nasync function applyCloudResult',
  );
  const loadFile = sourceBetween('async function loadFile(', '\nfunction prepareCanvasRendererDocument');
  const fileInput = sourceBetween('function setupFileInput()', '\nfunction setupZoomControls');

  assert.match(
    cloudRuntime,
    /loadFile\(file, \{ skipUnsavedGuard: true, suppressDialogs: true \}\)/,
    'the authenticated headless runtime must not wait for an unsaved guard or modal dialog',
  );
  assert.match(loadFile, /suppressDialogs\?: boolean/);
  assert.match(loadFile, /suppressDialogs: options\.suppressDialogs/);

  assert.match(fileInput, /loadFile\(file, \{ skipUnsavedGuard, fileHandle: fileHandle \?\? undefined \}\)/);
  assert.match(fileInput, /loadFile\(file, \{ fileHandle, untrustedSource: true \}\)/);
  assert.doesNotMatch(
    fileInput,
    /suppressDialogs/,
    'interactive file-picker and drop loads must retain normal dialog behavior',
  );
});
