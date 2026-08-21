import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ArtifactStore } from '../artifact-store.mjs';

const CFB = await fs.readFile(new URL('../../saved/blank2010.hwp', import.meta.url));

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

test('published bytes are immutable when the agent later rewrites its workspace file', async (t) => {
  const { root, store } = await fixture(t);
  const filePath = path.join(root, 'report.hwp');
  await fs.writeFile(filePath, CFB);
  const published = await store.publish({ filePath });
  const changed = Buffer.from(CFB);
  changed[changed.length - 1] ^= 0xff;
  await fs.writeFile(filePath, changed);
  assert.deepEqual((await store.read(published.artifactId)).bytes, CFB);
});

test('accepts a conforming HWPX and rejects truncated or non-canonical packages', async (t) => {
  const { root, store } = await fixture(t);
  const validBytes = await fs.readFile(new URL('../../saved/blank_hwpx.hwpx', import.meta.url));
  const validPath = path.join(root, 'valid.hwpx');
  await fs.writeFile(validPath, validBytes);
  const published = await store.publish({ filePath: validPath });
  assert.deepEqual((await store.read(published.artifactId)).bytes, validBytes);

  const truncatedPath = path.join(root, 'truncated.hwpx');
  await fs.writeFile(truncatedPath, validBytes.subarray(0, validBytes.length - 12));
  await assert.rejects(
    store.publish({ filePath: truncatedPath }),
    (error) => error.code === 'ARTIFACT_HWPX_INVALID',
  );

  const nonCanonical = await fs.readFile(new URL('../../samples/task2156/width_ladder.hwpx', import.meta.url));
  const nonCanonicalPath = path.join(root, 'mimetype-not-first.hwpx');
  await fs.writeFile(nonCanonicalPath, nonCanonical);
  await assert.rejects(
    store.publish({ filePath: nonCanonicalPath }),
    (error) => error.code === 'ARTIFACT_HWPX_INVALID',
  );
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

  const truncatedHwp = path.join(root, 'truncated.hwp');
  await fs.writeFile(truncatedHwp, CFB.subarray(0, 512));
  await assert.rejects(
    store.publish({ filePath: truncatedHwp }),
    (error) => error.code === 'ARTIFACT_HWP_INVALID',
  );
});
