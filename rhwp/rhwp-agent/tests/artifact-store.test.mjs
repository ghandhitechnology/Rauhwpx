import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ArtifactStore, validateHwpxPackage } from '../artifact-store.mjs';

const CFB = await fs.readFile(new URL('../../saved/blank2010.hwp', import.meta.url));
const BLANK_HWPX = fileURLToPath(new URL('../../saved/blank_hwpx.hwpx', import.meta.url));
const COPY_LAYOUT = fileURLToPath(new URL('../skills/copy-layout/scripts/copy_layout.py', import.meta.url));

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

function zipCentralEntries(bytes) {
  const endOffset = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endOffset >= 0, 'fixture must contain a ZIP end record');
  const count = bytes.readUInt16LE(endOffset + 10);
  let cursor = bytes.readUInt32LE(endOffset + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    entries.set(name, cursor);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
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

test('publishes hub-private snapshot inputs without trusting adjacent private paths', async (t) => {
  const recordRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-artifact-private-input-'));
  t.after(() => fs.rm(recordRoot, { recursive: true, force: true }));
  const workspace = path.join(recordRoot, 'work');
  const snapshots = path.join(recordRoot, 'hub-storage', 'document-snapshots');
  const privateSibling = path.join(recordRoot, 'hub-storage', 'private-sibling');
  await Promise.all([
    fs.mkdir(workspace),
    fs.mkdir(snapshots, { recursive: true }),
    fs.mkdir(privateSibling, { recursive: true }),
  ]);
  const snapshotPath = path.join(snapshots, 'snapshot.hwp');
  const siblingPath = path.join(privateSibling, 'sibling.hwp');
  await Promise.all([fs.writeFile(snapshotPath, CFB), fs.writeFile(siblingPath, CFB)]);
  const store = new ArtifactStore({
    rootDir: workspace,
    trustedReadRoots: [snapshots],
    createId: () => 'private_snapshot_1234567890',
  });

  const published = await store.publish({ filePath: snapshotPath });
  assert.deepEqual((await store.read(published.artifactId)).bytes, CFB);
  await assert.rejects(
    store.publish({ filePath: siblingPath }),
    (error) => error.code === 'ARTIFACT_PATH_OUTSIDE_WORKSPACE',
  );
});

test('published bytes are immutable when the agent later rewrites its workspace file', async (t) => {
  const { root, store } = await fixture(t);
  const filePath = path.join(root, 'report.hwp');
  await fs.writeFile(filePath, CFB);
  const published = await store.publish({ filePath });
  const changed = Buffer.from(CFB);
  changed[changed.length - 1] ^= 0xff;
  await fs.writeFile(filePath, changed);
  const firstRead = (await store.read(published.artifactId)).bytes;
  const secondRead = (await store.read(published.artifactId)).bytes;
  assert.strictEqual(firstRead, secondRead, 'reads should borrow the single store-owned snapshot');
  assert.deepEqual(firstRead, CFB);
});

test('serializes file reads and HWPX expansion across concurrent inspections', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-artifact-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = await Promise.all(['one.hwp', 'two.hwp', 'three.hwp'].map(async (name) => {
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, CFB);
    return filePath;
  }));
  const releases = [];
  let activeReads = 0;
  let maximumActiveReads = 0;
  const store = new ArtifactStore({
    rootDir: root,
    readExactFileImpl: async () => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await new Promise((resolve) => releases.push(resolve));
      activeReads -= 1;
      return Buffer.from(CFB);
    },
  });
  const waitForRelease = async () => {
    for (let attempt = 0; attempt < 100 && releases.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(releases.length, 1, 'exactly one inspection should reach the allocating reader');
  };

  const inspections = paths.map((filePath) => store.inspectFile(filePath));
  for (let completed = 0; completed < inspections.length; completed += 1) {
    await waitForRelease();
    releases.shift()();
  }
  await Promise.all(inspections);
  assert.equal(maximumActiveReads, 1);
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

test('rejects HWPX metadata claiming more than 4096 entries before walking it', async () => {
  const bytes = Buffer.from(await fs.readFile(new URL('../../saved/blank_hwpx.hwpx', import.meta.url)));
  const endOffset = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endOffset >= 0);
  bytes.writeUInt16LE(4097, endOffset + 8);
  bytes.writeUInt16LE(4097, endOffset + 10);

  await assert.rejects(
    validateHwpxPackage(bytes),
    (error) => error.code === 'ARTIFACT_HWPX_INVALID' && /4096/.test(error.message),
  );
});

test('rejects oversized HWPX members from central metadata before decompression', async () => {
  const source = await fs.readFile(new URL('../../saved/blank_hwpx.hwpx', import.meta.url));

  const oversizedMember = Buffer.from(source);
  const memberEntries = zipCentralEntries(oversizedMember);
  oversizedMember.writeUInt32LE((64 * 1024 * 1024) + 1, memberEntries.get('Preview/PrvImage.png') + 24);
  await assert.rejects(
    validateHwpxPackage(oversizedMember),
    (error) => error.code === 'ARTIFACT_HWPX_INVALID'
      && /67108864-byte member limit/.test(error.message)
      && /Preview\/PrvImage\.png/.test(error.message),
  );

  const oversizedManifest = Buffer.from(source);
  const manifestEntries = zipCentralEntries(oversizedManifest);
  oversizedManifest.writeUInt32LE((8 * 1024 * 1024) + 1, manifestEntries.get('Contents/content.hpf') + 24);
  await assert.rejects(
    validateHwpxPackage(oversizedManifest),
    (error) => error.code === 'ARTIFACT_HWPX_INVALID'
      && /8388608-byte member limit/.test(error.message)
      && /Contents\/content\.hpf/.test(error.message),
  );
});

test('rejects aggregate HWPX expansion metadata before inflating entries', async () => {
  const bytes = Buffer.from(await fs.readFile(new URL('../../saved/blank_hwpx.hwpx', import.meta.url)));
  const entries = zipCentralEntries(bytes);
  for (const name of [
    'version.xml',
    'Contents/header.xml',
    'Contents/section0.xml',
    'Preview/PrvText.txt',
    'Preview/PrvImage.png',
  ]) {
    bytes.writeUInt32LE(55 * 1024 * 1024, entries.get(name) + 24);
  }

  await assert.rejects(
    validateHwpxPackage(bytes),
    (error) => error.code === 'ARTIFACT_HWPX_INVALID' && /256 MiB safety limit/.test(error.message),
  );
});

test('publishes copy-layout HWPX output without agent-side package repair', async (t) => {
  const { root, store } = await fixture(t);
  const output = path.join(root, 'layout', 'blank - Layout.hwpx');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['-S', COPY_LAYOUT, BLANK_HWPX, '-o', output], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    t.skip('Python is unavailable');
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.delivery.ready, true);
  assert.deepEqual(report.generated_preview_entries, [
    'Preview/PrvImage.png',
    'Preview/PrvText.txt',
  ]);

  const published = await store.publish({ filePath: output });
  assert.equal(published.fileName, 'blank - Layout.hwpx');
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
