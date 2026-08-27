import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTopLevelLayerOrderTarget } from '../src/core/object-address.ts';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const insertSrc = readFileSync(join(rootDir, 'src/command/commands/insert.ts'), 'utf8');
const bridgeSrc = readFileSync(join(rootDir, 'src/core/wasm-bridge.ts'), 'utf8');

function commandBlock(id: string, nextId: string): string {
  const start = insertSrc.indexOf(`id: '${id}'`);
  const end = insertSrc.indexOf(`id: '${nextId}'`, start + 1);
  assert.notEqual(start, -1, `${id} command exists`);
  assert.notEqual(end, -1, `${nextId} command follows ${id}`);
  return insertSrc.slice(start, end);
}

test('layer-order target includes supported top-level floating object kinds', () => {
  for (const type of ['shape', 'line', 'group', 'ole', 'image', 'table', 'equation']) {
    assert.equal(isTopLevelLayerOrderTarget({ sec: 0, ppi: 0, ci: 0, type }), true, type);
  }
  const picture = { sec: 0, ppi: 0, ci: 0, type: 'image' };
  assert.equal(isTopLevelLayerOrderTarget({ ...picture, cellPath: [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 0 }] }), false);
  assert.equal(isTopLevelLayerOrderTarget({ ...picture, headerFooter: { kind: 'header' } }), false);
  assert.equal(isTopLevelLayerOrderTarget({ ...picture, noteRef: { kind: 'footnote' } }), false);
  assert.equal(isTopLevelLayerOrderTarget({ ...picture, memoRef: { memoIndex: 0 } }), false);
});

test('all arrange commands route pictures through generalized object z-order API', () => {
  const commands = [
    ['insert:arrange-front', 'insert:arrange-forward', 'front'],
    ['insert:arrange-forward', 'insert:arrange-backward', 'forward'],
    ['insert:arrange-backward', 'insert:arrange-back', 'backward'],
    ['insert:arrange-back', 'insert:picture-delete', 'back'],
  ] as const;

  for (const [id, nextId, operation] of commands) {
    const block = commandBlock(id, nextId);
    assert.match(block, /isTopLevelLayerOrderTarget\(ref\)/, `${id} uses the shared address guard`);
    assert.match(block, /ctx\.canArrangeSelectedObject/, `${id} is disabled before dispatch when unsupported`);
    assert.match(
      block,
      new RegExp(`wasm\\.changeObjectZOrder\\([^)]*'${operation}'\\)`),
      `${id} routes ${operation} through changeObjectZOrder`,
    );
    assert.doesNotMatch(block, /changeShapeZOrder/, `${id} does not use the legacy API`);
  }
});

test('WasmBridge exposes the generalized layer-order method', () => {
  assert.match(
    bridgeSrc,
    /changeObjectZOrder\(sec: number, para: number, ci: number, operation: string\)/,
  );
  assert.match(bridgeSrc, /this\.doc\.changeObjectZOrder\(sec, para, ci, operation\)/);
  assert.doesNotMatch(bridgeSrc, /^ {2}changeShapeZOrder\(/m, 'Studio bridge uses the new API name');
});
