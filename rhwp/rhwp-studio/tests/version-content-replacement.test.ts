import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapturedSnapshotCommand } from '../src/engine/captured-snapshot-command.ts';
import type { WasmBridge } from '../src/core/wasm-bridge.ts';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (relativePath: string): string =>
  readFileSync(join(rootDir, relativePath), 'utf8');

test('version content replacement is routed through one callback-capable applied snapshot command', () => {
  const inputHandler = source('src/engine/input-handler.ts');
  const methodStart = inputHandler.indexOf('replaceContentFromBytes(');
  assert.notEqual(methodStart, -1);
  const method = inputHandler.slice(methodStart, inputHandler.indexOf('\n  }', methodStart) + 4);

  assert.match(method, /return this\.executeAppliedSnapshot\(/);
  assert.match(method, /finalizeCompositionBeforeCursorMove\(\)/);
  assert.match(method, /flushDeferredPaginationIfNeeded\('before-version-content-replace', false\)/);
  assert.match(method, /'version:replace_content'/);
  assert.match(method, /const info = wasm\.replaceContentFromBytes\(data\)/);
  assert.ok(
    method.indexOf('wasm.replaceContentFromBytes(data)')
      < method.indexOf('this.clearTableResizeRuntimeCache()'),
  );
  assert.ok(
    method.indexOf('this.clearTableResizeRuntimeCache()')
      < method.indexOf('this.resetDerivedStateAfterHistoryJump()'),
  );
  assert.match(method, /callbacks/);
});

test('captured snapshot callbacks run after their document restore', () => {
  const events: string[] = [];
  const wasm = {
    restoreSnapshot(id: number) { events.push(`restore:${id}`); },
  } as unknown as WasmBridge;
  const command = new CapturedSnapshotCommand(
    'version',
    { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 },
    { sectionIndex: 1, paragraphIndex: 2, charOffset: 3 },
    10,
    20,
    {
      afterUndo() { events.push('branch:old'); },
      afterRedo() { events.push('branch:new'); },
    },
  );

  assert.deepEqual(command.undo(wasm), { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
  assert.deepEqual(command.execute(wasm), { sectionIndex: 1, paragraphIndex: 2, charOffset: 3 });
  assert.deepEqual(events, ['restore:10', 'branch:old', 'restore:20', 'branch:new']);
});

test('WasmBridge replacement preserves the JS file binding fields', () => {
  const bridge = source('src/core/wasm-bridge.ts');
  const methodStart = bridge.indexOf('replaceContentFromBytes(data: Uint8Array): DocumentInfo {');
  assert.notEqual(methodStart, -1);
  const method = bridge.slice(methodStart, bridge.indexOf('\n  }', methodStart) + 4);

  assert.match(method, /const doc = this\.doc;[\s\S]*?doc\.replaceContentFromBytes\(data\)/);
  assert.doesNotMatch(method, /_fileName|_currentFileHandle|_documentDigest|releaseDocument|new HwpDocument/);
});

test('WasmBridge load and replacement populate external images with a document generation guard', () => {
  const bridge = source('src/core/wasm-bridge.ts');
  const loadStart = bridge.indexOf('loadDocument(data: Uint8Array, fileName?: string): DocumentInfo {');
  const loadEnd = bridge.indexOf('\n  replaceContentFromBytes(', loadStart);
  const load = bridge.slice(loadStart, loadEnd);
  const replacementStart = bridge.indexOf('replaceContentFromBytes(data: Uint8Array): DocumentInfo {');
  const replacement = bridge.slice(replacementStart, bridge.indexOf('\n  }', replacementStart) + 4);
  const populationStart = bridge.indexOf('private async populateExternalImagesFromDevServer(');
  const populationEnd = bridge.indexOf('\n  /**', populationStart);
  const population = bridge.slice(populationStart, populationEnd);

  assert.match(load, /populateExternalImagesFromDevServer\(nextDoc, this\.documentGeneration\)/);
  assert.match(replacement, /const generation = \+\+this\.documentGeneration/);
  assert.match(replacement, /populateExternalImagesFromDevServer\(doc, generation\)/);
  assert.match(population, /this\.doc !== doc \|\| this\.documentGeneration !== generation/);
  assert.match(
    population,
    /readResponseBytesWithLimit\([\s\S]*?INSERTED_IMAGE_MAX_BYTES[\s\S]*?this\.doc !== doc/,
  );
  assert.doesNotMatch(population, /res\.arrayBuffer\(\)/);
  assert.match(population, /doc\.injectExternalImage\(/);
  assert.doesNotMatch(population, /this\.doc\.injectExternalImage\(/);
  assert.match(bridge, /restoreSnapshot\(id: number\): void \{[\s\S]*?const generation = \+\+this\.documentGeneration;[\s\S]*?populateExternalImagesFromDevServer\(doc, generation\)/);
});

test('WasmBridge exposes a separate trusted-local constructor path', () => {
  const bridge = source('src/core/wasm-bridge.ts');
  assert.match(
    bridge,
    /loadTrustedLocalFileOnce\(data: Uint8Array, fileName\?: string\): DocumentInfo \{[\s\S]*?fromTrustedLocalFileBytes\(bytes\)/,
  );

  const main = source('src/main.ts');
  assert.match(
    main,
    /consumeExactLocalFileRead\(data, fileHandle\)[\s\S]*?loadTrustedLocalFileOnce\(data, fileName\)/,
  );
});

test('raw replacement stays outside the generic agent mutation catalog', () => {
  const registry = source('src/core/mutation-method-registry.ts');
  const genericStart = registry.indexOf('export const MUTATING_METHODS');
  const genericEnd = registry.indexOf('];', genericStart);
  const routedStart = registry.indexOf('export const EDITOR_ROUTED_MUTATING_METHODS');
  const routedEnd = registry.indexOf('];', routedStart);

  assert.doesNotMatch(registry.slice(genericStart, genericEnd), /replaceContentFromBytes/);
  assert.match(registry.slice(routedStart, routedEnd), /replaceContentFromBytes/);
});
