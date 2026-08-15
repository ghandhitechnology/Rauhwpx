import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_TEMPLATE_BYTES,
  TemplateStore,
  defaultTemplateDataRoot,
  normalizeTemplateName,
} from '../template-store.mjs';

const HWP = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.from('test-template'),
]);
const HWPX = Buffer.concat([Buffer.from('PK'), Buffer.from('test-template')]);

async function fixture(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-template-store-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  return new TemplateStore({ rootDir }).init();
}

test('template data root follows each platform and supports an override', () => {
  assert.equal(defaultTemplateDataRoot({ RHWP_TEMPLATES_DIR: '/tmp/custom' }, 'linux', '/home/andy'), '/tmp/custom');
  assert.equal(defaultTemplateDataRoot({}, 'darwin', '/Users/andy'), '/Users/andy/Library/Application Support/rhwp/templates');
  assert.equal(defaultTemplateDataRoot({ APPDATA: 'C:\\Data' }, 'win32', 'C:\\Users\\andy'), 'C:\\Data/rhwp/templates');
  assert.equal(defaultTemplateDataRoot({ XDG_DATA_HOME: '/data' }, 'linux', '/home/andy'), '/data/rhwp/templates');
});

test('names are normalized and unique without restricting Korean or spaces', async (t) => {
  const store = await fixture(t);
  assert.equal(normalizeTemplateName('  월간   보고서  '), '월간 보고서');
  const added = await store.add({
    name: '월간 보고서', originalName: 'report.hwp', bytes: HWP, format: 'hwp', pageCount: 2, sectionCount: 1,
  });
  assert.equal(added.name, '월간 보고서');
  await assert.rejects(
    store.add({ name: '월간  보고서', originalName: 'other.hwp', bytes: HWP, pageCount: 1, sectionCount: 1 }),
    { code: 'TEMPLATE_NAME_CONFLICT' },
  );
});

test('add, rename, replace, reload, read, and delete preserve a stable id', async (t) => {
  const store = await fixture(t);
  const added = await store.add({
    name: '보고서', originalName: 'report.hwp', bytes: HWP, pageCount: 2, sectionCount: 1,
  });
  const renamed = await store.rename(added.id, '새 보고서');
  assert.equal(renamed.id, added.id);
  const replaced = await store.replace(added.id, {
    originalName: 'report.hwpx', bytes: HWPX, pageCount: 3, sectionCount: 2,
  });
  assert.equal(replaced.id, added.id);
  assert.equal(replaced.revision, 2);
  assert.equal(replaced.format, 'hwpx');

  const reloaded = await new TemplateStore({ rootDir: store.rootDir }).init();
  assert.deepEqual(reloaded.get(added.id), replaced);
  assert.deepEqual((await reloaded.read(added.id)).bytes, HWPX);
  await reloaded.delete(added.id);
  assert.equal(reloaded.list().templates.length, 0);
  await assert.rejects(reloaded.read(added.id), { code: 'TEMPLATE_NOT_FOUND' });
});

test('signature, metadata, and size validation reject invalid uploads', async (t) => {
  const store = await fixture(t);
  await assert.rejects(
    store.add({ name: 'bad', originalName: 'bad.hwp', bytes: Buffer.from('bad'), pageCount: 1, sectionCount: 1 }),
    { code: 'TEMPLATE_TYPE_MISMATCH' },
  );
  await assert.rejects(
    store.add({ name: 'bad', originalName: 'bad.txt', bytes: HWP, pageCount: 1, sectionCount: 1 }),
    { code: 'TEMPLATE_TYPE_UNSUPPORTED' },
  );
  await assert.rejects(
    store.add({ name: 'bad', originalName: 'bad.hwp', bytes: HWP, pageCount: 0, sectionCount: 1 }),
    { code: 'TEMPLATE_METADATA_INVALID' },
  );
  await assert.rejects(
    store.add({ name: 'large', originalName: 'large.hwpx', bytes: Buffer.alloc(MAX_TEMPLATE_BYTES + 1), pageCount: 1, sectionCount: 1 }),
    { code: 'TEMPLATE_FILE_TOO_LARGE' },
  );
});

test('template directories and persisted files use owner-only permissions', async (t) => {
  if (process.platform === 'win32') t.skip('POSIX mode bits are not meaningful on Windows');
  const store = await fixture(t);
  await store.add({ name: 'private', originalName: 'private.hwp', bytes: HWP, pageCount: 1, sectionCount: 1 });
  const [root, blobs, metadata] = await Promise.all([
    fs.stat(store.rootDir),
    fs.stat(path.join(store.rootDir, 'files')),
    fs.stat(path.join(store.rootDir, 'metadata.json')),
  ]);
  const [blobName] = await fs.readdir(path.join(store.rootDir, 'files'));
  const blob = await fs.stat(path.join(store.rootDir, 'files', blobName));
  assert.equal(root.mode & 0o777, 0o700);
  assert.equal(blobs.mode & 0o777, 0o700);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(blob.mode & 0o777, 0o600);
});
