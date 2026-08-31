import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATE_METADATA_BYTES,
  MAX_TEMPLATE_RECORDS,
  TemplateStore,
  defaultTemplateDataRoot,
  normalizeTemplateName,
} from '../template-store.mjs';

const HWP = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.from('test-template'),
]);
const HWPX = Buffer.concat([Buffer.from('PK'), Buffer.from('test-template')]);
const HWP_SIGNATURE_LENGTH = 8;

async function fixture(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-template-store-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  return new TemplateStore({ rootDir }).init();
}

async function persistedState(store) {
  return JSON.parse(await fs.readFile(store.metadataPath, 'utf8'));
}

test('template data root follows each platform and supports an override', () => {
  assert.equal(defaultTemplateDataRoot({ RHWP_TEMPLATES_DIR: '/tmp/custom' }, 'linux', '/home/andy'), path.resolve('/tmp/custom'));
  assert.equal(
    defaultTemplateDataRoot({}, 'darwin', '/Users/andy'),
    path.join('/Users/andy', 'Library', 'Application Support', 'rhwp', 'templates'),
  );
  assert.equal(defaultTemplateDataRoot({ APPDATA: 'C:\\Data' }, 'win32', 'C:\\Users\\andy'), path.join('C:\\Data', 'rhwp', 'templates'));
  assert.equal(defaultTemplateDataRoot({ XDG_DATA_HOME: '/data' }, 'linux', '/home/andy'), path.join('/data', 'rhwp', 'templates'));
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

test('concurrent template mutations preserve unique names and every committed record', async (t) => {
  const store = await fixture(t);
  const sameName = await Promise.allSettled([
    store.add({ name: '동시 보고서', originalName: 'first.hwp', bytes: HWP, pageCount: 1, sectionCount: 1 }),
    store.add({ name: '동시 보고서', originalName: 'second.hwp', bytes: HWP, pageCount: 1, sectionCount: 1 }),
  ]);
  assert.equal(sameName.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(sameName.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(sameName.find((result) => result.status === 'rejected').reason.code, 'TEMPLATE_NAME_CONFLICT');

  await Promise.all([
    store.add({ name: '첫째', originalName: 'first.hwpx', bytes: HWPX, pageCount: 1, sectionCount: 1 }),
    store.add({ name: '둘째', originalName: 'second.hwpx', bytes: HWPX, pageCount: 1, sectionCount: 1 }),
  ]);
  const reloaded = await new TemplateStore({ rootDir: store.rootDir }).init();
  assert.deepEqual(
    reloaded.list().templates.map((entry) => entry.name).sort(),
    ['동시 보고서', '둘째', '첫째'].sort(),
  );
});

test('TemplateStore restores Windows metadata left at the replacement gap', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-template-recovery-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new TemplateStore({ rootDir, platform: 'win32' }).init();
  const added = await store.add({
    name: '복구 보고서', originalName: 'report.hwp', bytes: HWP, pageCount: 1, sectionCount: 1,
  });
  await fs.rename(store.metadataPath, `${store.metadataPath}.previous-write`);

  const recovered = await new TemplateStore({ rootDir, platform: 'win32' }).init();
  assert.equal(recovered.get(added.id).name, '복구 보고서');
});

test('metadata loading is bounded and rejects record counts above the fixed cap', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-template-metadata-bound-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootDir, 'files'), { recursive: true });
  const metadataPath = path.join(rootDir, 'metadata.json');

  await fs.writeFile(metadataPath, Buffer.alloc(MAX_TEMPLATE_METADATA_BYTES + 1, 0x20));
  await assert.rejects(
    new TemplateStore({ rootDir }).init(),
    (error) => error.code === 'TEMPLATE_STORE_CORRUPT' && /byte limit/u.test(error.message),
  );

  await fs.writeFile(metadataPath, JSON.stringify({
    schemaVersion: 1,
    catalogRevision: 1,
    templates: Array.from({ length: MAX_TEMPLATE_RECORDS + 1 }, () => null),
  }));
  await assert.rejects(
    new TemplateStore({ rootDir }).init(),
    (error) => error.code === 'TEMPLATE_STORE_CORRUPT' && /record limit/u.test(error.message),
  );
});

test('metadata loading rejects symbolic links instead of following them', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Creating symbolic links is privilege-dependent on Windows');
    return;
  }
  const store = await fixture(t);
  await store.add({
    name: '링크 검증', originalName: 'report.hwp', bytes: HWP, pageCount: 1, sectionCount: 1,
  });
  const target = path.join(store.rootDir, 'metadata.real.json');
  await fs.rename(store.metadataPath, target);
  await fs.symlink(target, store.metadataPath);

  await assert.rejects(
    new TemplateStore({ rootDir: store.rootDir }).init(),
    (error) => error.code === 'TEMPLATE_STORE_CORRUPT' && /plain file/u.test(error.message),
  );
});

test('metadata validation rejects traversal, non-canonical fields, and unexpected fields', async (t) => {
  const store = await fixture(t);
  await store.add({
    name: '검증 보고서', originalName: 'report.hwp', bytes: HWP, pageCount: 1, sectionCount: 1,
  });
  const original = await persistedState(store);
  const victim = path.join(store.rootDir, 'victim.hwp');
  await fs.writeFile(victim, HWP);

  const cases = [
    ['traversal blob', (record) => { record.blobName = '../victim.hwp'; }],
    ['string count', (record) => { record.pageCount = '1'; }],
    ['non-canonical name', (record) => { record.name = ` ${record.name}`; }],
    ['path-bearing source name', (record) => { record.originalName = '../report.hwp'; }],
    ['invalid hash', (record) => { record.contentHash = 'sha256:nope'; }],
    ['invalid timestamp', (record) => { record.updatedAt = '2026-01-01'; }],
    ['unexpected field', (record) => { record.extra = true; }],
  ];
  for (const [label, mutate] of cases) {
    const state = structuredClone(original);
    mutate(state.templates[0]);
    await fs.writeFile(store.metadataPath, JSON.stringify(state));
    await assert.rejects(
      new TemplateStore({ rootDir: store.rootDir }).init(),
      (error) => error.code === 'TEMPLATE_STORE_CORRUPT',
      label,
    );
  }
  assert.deepEqual(await fs.readFile(victim), HWP, 'a traversal record must not touch a file outside files/');
});

test('startup removes app-owned orphan blobs and interrupted temp files', async (t) => {
  const store = await fixture(t);
  const added = await store.add({
    name: '보존 보고서', originalName: 'report.hwp', bytes: HWP, pageCount: 1, sectionCount: 1,
  });
  const state = await persistedState(store);
  const referencedBlob = state.templates[0].blobName;
  const orphanBlob = `${crypto.randomUUID()}-r1.hwp`;
  const orphanTemp = `${crypto.randomUUID()}-r1.hwpx.tmp-4321-${crypto.randomUUID()}`;
  const metadataTemp = `metadata.json.tmp-4321-${crypto.randomUUID()}`;
  await Promise.all([
    fs.writeFile(path.join(store.blobDir, orphanBlob), HWP),
    fs.writeFile(path.join(store.blobDir, orphanTemp), HWPX),
    fs.writeFile(path.join(store.rootDir, metadataTemp), '{}'),
  ]);

  const restarted = await new TemplateStore({ rootDir: store.rootDir }).init();
  assert.deepEqual(await fs.readdir(store.blobDir), [referencedBlob]);
  await assert.rejects(fs.access(path.join(store.rootDir, metadataTemp)), { code: 'ENOENT' });
  assert.deepEqual((await restarted.read(added.id)).bytes, HWP);
});

test('blob reads reject size changes and same-size hash corruption', async (t) => {
  const store = await fixture(t);
  const added = await store.add({
    name: '무결성 보고서', originalName: 'report.hwp', bytes: HWP, pageCount: 1, sectionCount: 1,
  });
  const state = await persistedState(store);
  const blobPath = path.join(store.blobDir, state.templates[0].blobName);

  const changed = Buffer.from(HWP);
  changed[changed.length - 1] ^= 0xff;
  await fs.writeFile(blobPath, changed);
  await assert.rejects(
    store.read(added.id),
    (error) => error.code === 'TEMPLATE_STORE_CORRUPT' && /hash/u.test(error.message),
  );

  await fs.writeFile(blobPath, Buffer.concat([HWP, Buffer.from([0])]));
  await assert.rejects(
    new TemplateStore({ rootDir: store.rootDir }).init(),
    (error) => error.code === 'TEMPLATE_STORE_CORRUPT' && /size/u.test(error.message),
  );
});

test('upload reservations reject excess concurrency before consuming another stream', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-template-upload-bound-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new TemplateStore({
    rootDir,
    maxInFlightUploadBytes: HWP.length,
    maxInFlightUploads: 1,
  }).init();
  let releaseFirst;
  let markStarted;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  async function* heldUpload() {
    yield HWP.subarray(0, HWP_SIGNATURE_LENGTH);
    markStarted();
    await gate;
    yield HWP.subarray(HWP_SIGNATURE_LENGTH);
  }
  const first = store.addStream({
    name: '첫 업로드',
    originalName: 'first.hwp',
    pageCount: 1,
    sectionCount: 1,
    contentLength: HWP.length,
    stream: heldUpload(),
  });
  await started;

  let secondConsumed = false;
  async function* secondUpload() {
    secondConsumed = true;
    yield HWP;
  }
  await assert.rejects(
    store.addStream({
      name: '둘째 업로드',
      originalName: 'second.hwp',
      pageCount: 1,
      sectionCount: 1,
      contentLength: HWP.length,
      stream: secondUpload(),
    }),
    (error) => error.code === 'TEMPLATE_UPLOAD_BUSY',
  );
  assert.equal(secondConsumed, false);

  releaseFirst();
  await first;
  async function* abortedUpload() {
    yield HWP.subarray(0, HWP_SIGNATURE_LENGTH);
    throw new Error('client aborted');
  }
  await assert.rejects(
    store.addStream({
      name: '중단 업로드',
      originalName: 'aborted.hwp',
      pageCount: 1,
      sectionCount: 1,
      contentLength: HWP.length,
      stream: abortedUpload(),
    }),
    /client aborted/u,
  );
  await store.addStream({
    name: '둘째 업로드',
    originalName: 'second.hwp',
    pageCount: 1,
    sectionCount: 1,
    contentLength: HWP.length,
    stream: secondUpload(),
  });
  assert.equal(store.list().templates.length, 2);
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

test('rename and replace keep timestamps valid when the system clock moves backward', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-template-clock-rollback-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let wallClock = Date.parse('2026-08-31T12:00:00.000Z');
  const store = await new TemplateStore({ rootDir, now: () => wallClock }).init();
  const added = await store.add({
    name: '시계 보고서', originalName: 'report.hwp', bytes: HWP, pageCount: 1, sectionCount: 1,
  });
  wallClock -= 24 * 60 * 60 * 1000;

  const renamed = await store.rename(added.id, '시계 복구 보고서');
  const replaced = await store.replace(added.id, {
    originalName: 'report.hwpx', bytes: HWPX, pageCount: 2, sectionCount: 1,
  });

  assert.equal(renamed.updatedAt, added.createdAt);
  assert.equal(replaced.updatedAt, added.createdAt);
  const restarted = await new TemplateStore({ rootDir }).init();
  assert.deepEqual(restarted.get(added.id), replaced);
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
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not meaningful on Windows');
    return;
  }
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
