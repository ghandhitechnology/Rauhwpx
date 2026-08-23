import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';

import { imageRootsFromEnv, assertImagePathInsideRoots } from '../image-path-policy.mjs';

function makeWorkspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-image-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('imageRootsFromEnv splits on the platform delimiter and drops empties', () => {
  const joined = ['/tmp/a', '/tmp/b b'].join(path.delimiter);
  assert.deepEqual(imageRootsFromEnv({ RHWP_IMAGE_ROOTS: joined }), ['/tmp/a', '/tmp/b b']);
  assert.deepEqual(imageRootsFromEnv({}), []);
  assert.deepEqual(imageRootsFromEnv({ RHWP_IMAGE_ROOTS: '   ' }), []);
});

test('paths inside an allowed root pass; sibling and parent paths are rejected', async (t) => {
  const parent = makeWorkspace(t);
  const workspace = path.join(parent, 'workspace');
  mkdirSync(path.join(workspace, 'downloads'), { recursive: true });
  const inside = path.join(workspace, 'downloads', 'chart.png');
  writeFileSync(inside, 'png');
  const outside = path.join(parent, 'outside.png');
  writeFileSync(outside, 'png');

  await assertImagePathInsideRoots(inside, [workspace]);

  await assert.rejects(
    () => assertImagePathInsideRoots(outside, [workspace]),
    (error) => error.code === 'INVALID_ARGS',
  );
});

test('symlink escape is caught by realpath containment', async (t) => {
  const workspace = makeWorkspace(t);
  const secretDir = makeWorkspace(t);
  const secret = path.join(secretDir, 'secret.png');
  writeFileSync(secret, 'png');
  const link = path.join(workspace, 'innocent.png');
  symlinkSync(secret, link);

  await assert.rejects(
    () => assertImagePathInsideRoots(link, [workspace]),
    (error) => error.code === 'INVALID_ARGS',
  );
});

test('missing files report FILE_NOT_FOUND instead of policy denial', async (t) => {
  const workspace = makeWorkspace(t);
  await assert.rejects(
    () => assertImagePathInsideRoots(path.join(workspace, 'nope.png'), [workspace]),
    (error) => error.code === 'FILE_NOT_FOUND',
  );
});

test('an empty root list keeps the legacy unrestricted behavior', async () => {
  await assertImagePathInsideRoots('/etc/hosts', []);
});
