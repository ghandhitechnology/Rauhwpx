import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_EDIT_SESSION_METHODS,
  MUTATING_METHODS,
} from '../src/core/mutation-method-registry.ts';
import {
  ENGINE_EDIT_CAPABILITIES,
  ENGINE_EDIT_TYPE_DEFINITIONS,
} from '../src/agent/engine-edit-capabilities.generated.ts';
import {
  applyEngineEditSession,
  getEngineEditCapabilities,
  getEngineEditMethodNamesByKind,
  getReferencedTypeDefinitions,
  runEngineEdits,
  validateEngineEdits,
} from '../src/agent/engine-edit.ts';
import { AgentToolError } from '../src/agent/types.ts';

test('agent engine-edit catalog covers every mutator and required editor-session operation', () => {
  assert.deepEqual(
    ENGINE_EDIT_CAPABILITIES.map(({ method }) => method).sort(),
    [...MUTATING_METHODS, ...AGENT_EDIT_SESSION_METHODS].sort(),
  );
  for (const capability of ENGINE_EDIT_CAPABILITIES) {
    assert.ok(
      capability.signature.startsWith(`${capability.method}(`),
      `${capability.method} signature does not start with the method name`,
    );
    assert.ok(capability.kind === 'document' || capability.kind === 'session');
    assert.ok(Array.isArray(capability.parameters));
  }
  assert.match(ENGINE_EDIT_TYPE_DEFINITIONS.DocumentPosition, /sectionIndex: number/);
  assert.match(ENGINE_EDIT_TYPE_DEFINITIONS.TableProperties, /captionDirection\?: number/);
  assert.match(ENGINE_EDIT_TYPE_DEFINITIONS.ShapeProperties, /rotationAngle\?: number/);
});

test('opaque engine arguments carry actionable field guides', () => {
  const capabilities = getEngineEditCapabilities();
  const byMethod = new Map(capabilities.map((capability) => [capability.method, capability]));
  for (const capability of capabilities.filter(({ signature }) => signature.includes('Record<string, unknown>'))) {
    assert.ok(
      Object.keys(capability.argumentGuide ?? {}).length > 0,
      `${capability.method} lacks a property argument guide`,
    );
  }
  assert.match(byMethod.get('createShapeControl')?.argumentGuide?.params ?? '', /shapeType/);
  assert.match(byMethod.get('createNumbering')?.argumentGuide?.json ?? '', /levelFormats/);
  assert.match(byMethod.get('createStyle')?.argumentGuide?.json ?? '', /baseCharShapeId/);
  assert.match(byMethod.get('updateStyleShapes')?.argumentGuide?.charModsJson ?? '', /CharProperties/);
});

test('capability results carry only the type definitions their signatures and guides reference', () => {
  const picture = getEngineEditCapabilities('setPictureProperties');
  assert.deepEqual(Object.keys(getReferencedTypeDefinitions(picture)).sort(), ['PictureProperties']);
  const byPath = getEngineEditCapabilities('applyCharFormatInCellByPath');
  assert.deepEqual(
    Object.keys(getReferencedTypeDefinitions(byPath)).sort(),
    ['CellPathEntry', 'CharProperties'],
  );
  const names = getEngineEditMethodNamesByKind();
  assert.equal(
    Object.values(names).reduce((total, list) => total + list.length, 0),
    ENGINE_EDIT_CAPABILITIES.length,
  );
  assert.ok(names['document']?.includes('setPictureProperties'));
});

test('engine-edit batch runs in order and validates its size first', () => {
  const calls: unknown[][] = [];
  const wasm = {
    setPageDef: (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, pageCount: 2 };
    },
  } as unknown as Parameters<typeof runEngineEdits>[0];

  const result = runEngineEdits(wasm, [
    { method: 'setPageDef', args: [0, { width: 100 }] },
    { method: 'setPageDef', args: [1, { width: 200 }] },
  ]);

  assert.deepEqual(calls, [[0, { width: 100 }], [1, { width: 200 }]]);
  assert.deepEqual(result, [{ ok: true, pageCount: 2 }, { ok: true, pageCount: 2 }]);
  assert.throws(
    () => validateEngineEdits([]),
    (error) => error instanceof AgentToolError && error.code === 'INVALID_ARGS',
  );
});

test('session setup methods remain separate from document batches', () => {
  const wasm = { copySelection: () => '{"ok":true}' } as unknown as Parameters<typeof runEngineEdits>[0];
  assert.deepEqual(
    applyEngineEditSession(wasm, { method: 'copySelection', args: [0, 0, 0, 0, 1] }),
    { value: '{"ok":true}', parsedJson: { ok: true } },
  );
  assert.throws(
    () => runEngineEdits(wasm, [{ method: 'copySelection', args: [0, 0, 0, 0, 1] }]),
    (error) => error instanceof AgentToolError && error.code === 'ENGINE_EDIT_NOT_ALLOWED',
  );
});

test('engine-edit batch rejects methods outside the authoritative mutator registry', () => {
  const wasm = { getDocumentInfo: () => ({}) } as unknown as Parameters<typeof runEngineEdits>[0];
  assert.throws(
    () => runEngineEdits(wasm, [{ method: 'getDocumentInfo', args: [] }]),
    (error) => error instanceof AgentToolError && error.code === 'ENGINE_EDIT_NOT_ALLOWED',
  );
});
