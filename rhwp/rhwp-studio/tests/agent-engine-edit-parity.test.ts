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
  applyEngineEdits,
  applyEngineEditSession,
  getEngineEditCapabilities,
} from '../src/agent/engine-edit.ts';
import type { InputHandler } from '../src/engine/input-handler.ts';
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
      Object.keys(capability.argumentGuide).length > 0,
      `${capability.method} lacks a property argument guide`,
    );
  }
  assert.match(byMethod.get('createShapeControl')?.argumentGuide.params ?? '', /shapeType/);
  assert.match(byMethod.get('createNumbering')?.argumentGuide.json ?? '', /levelFormats/);
  assert.match(byMethod.get('createStyle')?.argumentGuide.json ?? '', /baseCharShapeId/);
  assert.match(byMethod.get('updateStyleShapes')?.argumentGuide.charModsJson ?? '', /CharProperties/);
});

test('engine-edit batch uses the atomic editor snapshot path and preserves order', () => {
  const calls: unknown[][] = [];
  const wasm = {
    setPageDef: (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, pageCount: 2 };
    },
  };
  const inputHandler = {
    executeAppliedSnapshot(operationType: string, apply: (target: unknown) => unknown) {
      assert.equal(operationType, 'agent:apply_engine_edits');
      return apply(wasm);
    },
  } as unknown as InputHandler;

  const result = applyEngineEdits(inputHandler, [
    { method: 'setPageDef', args: [0, { width: 100 }] },
    { method: 'setPageDef', args: [1, { width: 200 }] },
  ]);

  assert.deepEqual(calls, [[0, { width: 100 }], [1, { width: 200 }]]);
  assert.deepEqual(result, [{ ok: true, pageCount: 2 }, { ok: true, pageCount: 2 }]);
});

test('session setup methods remain separate from atomic document batches', () => {
  const wasm = { copySelection: () => '{"ok":true}' };
  assert.deepEqual(
    applyEngineEditSession(
      wasm as unknown as Parameters<typeof applyEngineEditSession>[0],
      { method: 'copySelection', args: [0, 0, 0, 0, 1] },
    ),
    { value: '{"ok":true}', parsedJson: { ok: true } },
  );
  const inputHandler = {
    executeAppliedSnapshot(_operationType: string, apply: (target: unknown) => unknown) {
      return apply(wasm);
    },
  } as unknown as InputHandler;
  assert.throws(
    () => applyEngineEdits(inputHandler, [{ method: 'copySelection', args: [0, 0, 0, 0, 1] }]),
    (error) => error instanceof AgentToolError && error.code === 'ENGINE_EDIT_NOT_ALLOWED',
  );
});

test('engine-edit batch rejects methods outside the authoritative mutator registry', () => {
  const inputHandler = {
    executeAppliedSnapshot(_operationType: string, apply: (target: unknown) => unknown) {
      return apply({ getDocumentInfo: () => ({}) });
    },
  } as unknown as InputHandler;

  assert.throws(
    () => applyEngineEdits(inputHandler, [{ method: 'getDocumentInfo', args: [] }]),
    (error) => error instanceof AgentToolError && error.code === 'ENGINE_EDIT_NOT_ALLOWED',
  );
});

test('engine-edit batch rejects registered methods missing from the live WASM document', () => {
  const inputHandler = {
    executeAppliedSnapshot(_operationType: string, apply: (target: unknown) => unknown) {
      return apply({
        pasteDocumentBlock: () => '{"ok":true}',
        hasDocumentMethod: () => false,
      });
    },
  } as unknown as InputHandler;

  assert.throws(
    () => applyEngineEdits(inputHandler, [{
      method: 'pasteDocumentBlock',
      args: [{ $base64: 'YQ==' }, 0, 0, 0, 0, 0, 0],
    }]),
    (error) => error instanceof AgentToolError && error.code === 'ENGINE_EDIT_UNAVAILABLE',
  );
});
