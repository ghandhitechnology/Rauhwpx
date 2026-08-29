import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AGENT_EDIT_SESSION_METHODS,
  EDITOR_ROUTED_MUTATING_METHODS,
  EXCLUDED_NON_DOCUMENT,
  MUTATING_METHODS,
} from '../src/core/mutation-method-registry.ts';

const rust = readFileSync(new URL('../../src/wasm_api.rs', import.meta.url), 'utf8');
const agentMethods = new Set([...MUTATING_METHODS, ...AGENT_EDIT_SESSION_METHODS]);
const excludedBridgeMethods = new Set(EXCLUDED_NON_DOCUMENT);
const editorRoutedMethods = new Set(EDITOR_ROUTED_MUTATING_METHODS);

const MUTATING_EXPORT_VERB = /^(insert|delete|create|apply|add|remove|move|resize|merge|split|update|toggle|replace|paste|assign|group|ungroup|change|clear|evaluate|transpose|ensure|findOrCreate|reflow|refresh|setPage|setSection|setColumn|setCell|setTable|setPicture|setShape|setEquation|setNote|setChar|setPara|setField|setForm|setNumbering|setHeaderFooter|setActiveField|renameBookmark)/;

const SEMANTIC_ALIASES: Readonly<Record<string, string>> = {
  changeShapeZOrder: 'changeObjectZOrder',
  insertClickHereFieldInCell: 'insertClickHereField',
  insertClickHereFieldInCellEx: 'insertClickHereField',
  insertClickHereFieldByPath: 'insertClickHereField',
  insertClickHereFieldByPathEx: 'insertClickHereField',
  removeFieldAtInCell: 'removeFieldAt',
  removeFieldAtInCellEx: 'removeFieldAt',
};

const NON_EDIT_EXPORTS = new Set([
  'createEmpty',
  'createBlankDocument',
  'moveVerticalEx',
  'setActiveFieldInCell',
  'setActiveFieldInCellEx',
  'setActiveFieldByPath',
  'clearClipboard',
  'updateViewport',
]);

test('every mutation-like Rust export has an agent edit path or explicit non-edit classification', () => {
  const exports = [...rust.matchAll(/#\[wasm_bindgen\(js_name\s*=\s*([A-Za-z0-9_]+)\)\]/g)]
    .map((match) => match[1])
    .filter((name) => MUTATING_EXPORT_VERB.test(name));

  const uncovered = exports.filter((name) => {
    if (agentMethods.has(name) || editorRoutedMethods.has(name)
      || excludedBridgeMethods.has(name) || NON_EDIT_EXPORTS.has(name)) return false;
    const alias = SEMANTIC_ALIASES[name];
    if (alias && agentMethods.has(alias)) return false;
    if (name.endsWith('Ex') && agentMethods.has(name.slice(0, -2))) return false;
    return true;
  });

  assert.deepEqual(
    uncovered,
    [],
    `Rust engine mutations missing an agent path: ${uncovered.join(', ')}`,
  );
  for (const target of Object.values(SEMANTIC_ALIASES)) {
    assert.ok(agentMethods.has(target), `stale semantic alias target: ${target}`);
  }
});
