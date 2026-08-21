import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ArtifactStore } from '../artifact-store.mjs';

const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-artifact-store-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-artifact-outside-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  return {
    root,
    outside,
    store: new ArtifactStore({ rootDir: root, createId: () => 'artifact_token_1234567890' }),
  };
}

test('publishes and rereads a generated HWP inside the chat workspace', async (t) => {
  const { root, store } = await fixture(t);
  const filePath = path.join(root, 'layout', 'report.hwp');
  await fs.mkdir(path.dirname(filePath));
  await fs.writeFile(filePath, CFB);
  const published = await store.publish({ filePath, fileName: '../보고서 - Layout.hwp' });
  assert.equal(published.artifactId, 'artifact_token_1234567890');
  assert.equal(published.fileName, '보고서 - Layout.hwp');
  assert.match(published.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual((await store.read(published.artifactId)).bytes, CFB);
});

test('rejects paths outside the workspace, symlinks, and mismatched formats', async (t) => {
  const { root, outside, store } = await fixture(t);
  const outsideFile = path.join(outside, 'outside.hwp');
  await fs.writeFile(outsideFile, CFB);
  await assert.rejects(
    store.publish({ filePath: outsideFile }),
    (error) => error.code === 'ARTIFACT_PATH_OUTSIDE_WORKSPACE',
  );

  const link = path.join(root, 'linked.hwp');
  await fs.symlink(outsideFile, link);
  await assert.rejects(
    store.publish({ filePath: link }),
    (error) => error.code === 'ARTIFACT_PATH_INVALID',
  );

  const wrong = path.join(root, 'wrong.hwpx');
  await fs.writeFile(wrong, CFB);
  await assert.rejects(
    store.publish({ filePath: wrong }),
    (error) => error.code === 'ARTIFACT_FORMAT_MISMATCH',
  );
});
