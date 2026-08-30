import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readUtf8FileBounded,
  readUtf8FileBoundedSync,
} from '../bounded-file.mjs';

test('bounded file readers accept a small plain UTF-8 file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-bounded-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, '{"ok":true}');

  assert.equal(await readUtf8FileBounded(file, { maxBytes: 64 }), '{"ok":true}');
  assert.equal(readUtf8FileBoundedSync(file, { maxBytes: 64 }), '{"ok":true}');
});

test('bounded file readers reject oversized files before allocating their contents', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-bounded-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, Buffer.alloc(65));

  await assert.rejects(readUtf8FileBounded(file, { maxBytes: 64 }), {
    code: 'BOUNDED_FILE_TOO_LARGE',
  });
  assert.throws(() => readUtf8FileBoundedSync(file, { maxBytes: 64 }), {
    code: 'BOUNDED_FILE_TOO_LARGE',
  });
});

test('bounded file readers reject symlinks instead of following persistent config aliases', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-bounded-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.json');
  const alias = path.join(root, 'alias.json');
  await fs.writeFile(target, '{"secret":"outside"}');
  try {
    await fs.symlink(target, alias);
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error?.code)) {
      t.skip('This Windows host does not permit unprivileged symlink creation');
      return;
    }
    throw error;
  }

  await assert.rejects(readUtf8FileBounded(alias, { maxBytes: 64 }), {
    code: 'BOUNDED_FILE_UNSAFE',
  });
  assert.throws(() => readUtf8FileBoundedSync(alias, { maxBytes: 64 }), {
    code: 'BOUNDED_FILE_UNSAFE',
  });
});
