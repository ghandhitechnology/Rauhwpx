import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeResourceDependencyErrors } from '../src/versioning/merge-validation.ts';

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
