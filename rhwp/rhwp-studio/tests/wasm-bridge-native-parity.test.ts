import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_EDIT_SESSION_METHODS,
  MUTATING_METHODS,
} from '../src/core/mutation-method-registry.ts';

const studioDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rhwpDir = dirname(studioDir);

function source(relFromRhwp: string): string {
  return readFileSync(join(rhwpDir, relFromRhwp), 'utf8');
}

function wasmApiJsNames(): Set<string> {
  return new Set(
    [...source('src/wasm_api.rs').matchAll(/#\[wasm_bindgen\(js_name\s*=\s*(\w+)\)\]/g)]
      .map((match) => match[1]),
  );
}

function hwpDocumentMethods(jsSource: string): Set<string> {
  const classMatch = jsSource.match(/export class HwpDocument \{([\s\S]*?)\n\}/);
  assert.ok(classMatch, 'HwpDocument class must be present in wasm-bindgen glue');
  return new Set([...classMatch[1].matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]));
}

test('engine-edit methods are exported from wasm_api.rs', () => {
  const jsNames = wasmApiJsNames();
  const missing = [...MUTATING_METHODS, ...AGENT_EDIT_SESSION_METHODS]
    .filter((method) => !jsNames.has(method));
  assert.deepEqual(
    missing,
    [],
    `Studio advertised engine methods with no wasm_bindgen js_name: ${missing.join(', ')}`,
  );
});

test('pasteDocumentBlock is a native wasm_api export, not a Studio-only wrapper', () => {
  const wasmApi = source('src/wasm_api.rs');
  assert.match(wasmApi, /#\[wasm_bindgen\(js_name = pasteDocumentBlock\)\]/);
  const bridge = readFileSync(join(studioDir, 'src/core/wasm-bridge.ts'), 'utf8');
  assert.match(bridge, /requireNativeDocumentMethod\(this\.doc, 'pasteDocumentBlock'\)/);
  assert.match(bridge, /hasDocumentMethod\(/);
});

test('built pkg glue includes every engine-edit method when pkg/ exists', () => {
  const pkgJs = join(rhwpDir, 'pkg/rhwp.js');
  if (!existsSync(pkgJs)) {
    return;
  }
  const methods = hwpDocumentMethods(readFileSync(pkgJs, 'utf8'));
  const missing = [...MUTATING_METHODS, ...AGENT_EDIT_SESSION_METHODS]
    .filter((method) => !methods.has(method));
  assert.deepEqual(
    missing,
    [],
    `pkg/rhwp.js is missing live HwpDocument methods: ${missing.join(', ')}`,
  );
});
