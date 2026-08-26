import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { mergeResourceDependencyErrors } from '../src/versioning/merge-validation.ts';

const bridgeSource = readFileSync(new URL('../src/core/wasm-bridge.ts', import.meta.url), 'utf8');

test('merge resource validation rejects every unloaded external image dependency', () => {
  assert.deepEqual(mergeResourceDependencyErrors([
    { basename: 'present.png', loaded: true },
    { basename: 'missing-a.png', loaded: false },
    { originalPath: '/missing/b.jpg', loaded: false },
    { binDataId: 17, loaded: false },
  ]), [
    'Missing referenced image resource: missing-a.png',
    'Missing referenced image resource: /missing/b.jpg',
    'Missing referenced image resource: BinData 17',
  ]);
});

test('merge resource validation accepts embedded or successfully loaded dependencies', () => {
  assert.deepEqual(mergeResourceDependencyErrors([
    { basename: 'embedded.png', loaded: true },
    { key: 'resolved:4', loaded: true },
  ]), []);
});

test('external image dependency reports distinguish valid emptiness from unavailable data', () => {
  assert.match(bridgeSource, /typeof getReferences !== 'function'[\s\S]*종속성 정보를 사용할 수 없습니다/);
  assert.match(bridgeSource, /typeof raw !== 'string'[\s\S]*종속성 정보 형식이 올바르지 않습니다/);
  assert.match(bridgeSource, /catch \{\s*throw new Error\('문서의 외부 이미지 종속성 정보를 읽지 못했습니다'\);/);
  assert.match(bridgeSource, /if \(!Array\.isArray\(parsed\)\) \{\s*throw new Error\('문서의 외부 이미지 종속성 정보 형식이 올바르지 않습니다'\);/);
  assert.match(bridgeSource, /return parsed\.filter/);
});
