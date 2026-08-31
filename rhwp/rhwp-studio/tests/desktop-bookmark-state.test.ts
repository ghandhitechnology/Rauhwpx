import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  quarantineBookmarkState,
  readBookmarkState,
} from '../../../desktop/bookmark-state.mjs';
import { NativeFileHandleRegistry } from '../../../desktop/native-file-handles.mjs';

test('bookmark state is bounded, strict, and explicitly quarantined when corrupt', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rauhwpx-bookmarks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'native-document-bookmarks.json');
  const entries = [['document-a', '/tmp/report.hwp']];
  writeFileSync(file, JSON.stringify(entries));
  assert.deepEqual(await readBookmarkState(file), entries);

  const registry = new NativeFileHandleRegistry();
  registry.loadBookmarks(entries, { strict: true });
  assert.throws(
    () => registry.loadBookmarks([['document-a', '/tmp/a.hwp'], ['document-a', '/tmp/b.hwp']], { strict: true }),
    /duplicate document id/,
  );

  writeFileSync(file, '{not-json');
  await assert.rejects(readBookmarkState(file), { code: 'BOOKMARK_STATE_CORRUPT' });
  const quarantined = await quarantineBookmarkState(file, { suffix: 'test' });
  assert.equal(quarantined, `${file}.corrupt-test`);
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(quarantined!, 'utf8'), '{not-json');
});

test('bookmark reader rejects declared state beyond its configured budget before allocation', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rauhwpx-bookmarks-size-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'native-document-bookmarks.json');
  writeFileSync(file, '[]');
  await assert.rejects(readBookmarkState(file, { maxBytes: 1 }), { code: 'BOOKMARK_STATE_CORRUPT' });
});
