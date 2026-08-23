import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startStudioServer } from '../document-runtime/studio-harness.mjs';
import {
  assertUniqueNfcNames,
  normalizeAndVerifyRuntimeAssets,
  normalizeRuntimeAssetPaths,
} from '../install/normalize-runtime-assets.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const sourceCatalogPath = path.join(repositoryRoot, 'rhwp', 'form-pack', 'catalog.json');

test('NFC collision detection rejects canonically equivalent path names', () => {
  const filename = '공문.hwpx';
  assert.throws(
    () => assertUniqueNfcNames([filename, filename.normalize('NFD')], 'studio/form-pack'),
    /NFC path collision.*studio\/form-pack/,
  );
});

test('runtime staging normalizes every path and serves every catalog form by its exact URL', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-runtime-nfc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const studioRoot = path.join(root, 'studio');
  const formPackRoot = path.join(studioRoot, 'form-pack');
  const nestedRoot = path.join(root, 'nested-' + '품의'.normalize('NFD'));
  await fs.mkdir(formPackRoot, { recursive: true });
  await fs.mkdir(nestedRoot, { recursive: true });
  await fs.writeFile(path.join(studioRoot, 'index.html'), '<!doctype html>');
  await fs.writeFile(path.join(nestedRoot, '공문'.normalize('NFD') + '.txt'), 'nested');

  const catalog = JSON.parse(await fs.readFile(sourceCatalogPath, 'utf8'));
  await fs.writeFile(path.join(formPackRoot, 'catalog.json'), JSON.stringify(catalog));
  for (const [index, form] of catalog.forms.entries()) {
    await fs.writeFile(path.join(formPackRoot, form.file.normalize('NFD')), `form-${index}`);
  }

  const result = await normalizeAndVerifyRuntimeAssets(root);
  assert.equal(result.catalogFiles, catalog.forms.length);
  assert.ok(result.renamed >= catalog.forms.length + 2);

  const stagedNames = await fs.readdir(formPackRoot);
  for (const form of catalog.forms) {
    assert.equal(form.file, form.file.normalize('NFC'));
    assert.ok(stagedNames.includes(form.file), form.file);
    if (process.platform === 'linux') {
      await assert.rejects(fs.access(path.join(formPackRoot, form.file.normalize('NFD'))), { code: 'ENOENT' });
    }
  }
  for (const relative of await fs.readdir(root)) assert.equal(relative, relative.normalize('NFC'));

  const { server, origin } = await startStudioServer({
    studioRoot,
    resources: new Map(),
    bootstrap: 'runtime-nfc-test',
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const [index, form] of catalog.forms.entries()) {
    const response = await fetch(`${origin}/form-pack/${encodeURIComponent(form.file)}`);
    assert.equal(response.status, 200, form.file);
    assert.equal(await response.text(), `form-${index}`, form.file);
  }
});

test('runtime staging detects all collisions before renaming any path', {
  skip: process.platform !== 'linux' && 'requires a normalization-sensitive filesystem',
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-runtime-collision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = '공문.hwpx';
  const unrelated = '품의'.normalize('NFD') + '.txt';
  await fs.writeFile(path.join(root, filename), 'nfc');
  await fs.writeFile(path.join(root, filename.normalize('NFD')), 'nfd');
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested', unrelated), 'unchanged');

  await assert.rejects(normalizeRuntimeAssetPaths(root), /NFC path collision/);
  assert.deepEqual(
    (await fs.readdir(root)).sort(),
    [filename, filename.normalize('NFD'), 'nested'].sort(),
  );
  assert.ok((await fs.readdir(path.join(root, 'nested'))).includes(unrelated));
});
