import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  quarantineBookmarkState,
  readBookmarkState,
} from '../../../desktop/bookmark-state.mjs';
import { NativeFileHandleRegistry } from '../../../desktop/native-file-handles.mjs';

function errorWithCode(code: string) {
  return Object.assign(new Error(code), { code });
}

function lockedRename(realRename: typeof rename, { failTimes = Infinity, code = 'EPERM' } = {}) {
  let failures = 0;
  return async (from: string, to: string) => {
    if (failures < failTimes) {
      failures += 1;
      throw errorWithCode(code);
    }
    return realRename(from, to);
  };
}

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

const WINDOWS_LOCK_CODES = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'] as const;

test('win32 bookmark quarantine retries a locked rename then leaves a sibling', async (t) => {
  for (const code of WINDOWS_LOCK_CODES) {
    const root = mkdtempSync(path.join(os.tmpdir(), `rauhwpx-bookmarks-retry-${code.toLowerCase()}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'native-document-bookmarks.json');
    writeFileSync(file, '{not-json');
    const quarantinePath = `${file}.corrupt-test`;
    const quarantined = await quarantineBookmarkState(file, {
      renameImpl: lockedRename(rename, { failTimes: 1, code }),
      suffix: 'test',
      platform: 'win32',
      sleep: async () => {},
    });
    assert.equal(quarantined, quarantinePath);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(quarantinePath, 'utf8'), '{not-json');
  }
});

test('win32 bookmark quarantine surfaces a lock that outlasts the delay budget', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rauhwpx-bookmarks-locked-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'native-document-bookmarks.json');
  writeFileSync(file, '{not-json');
  await assert.rejects(
    quarantineBookmarkState(file, {
      renameImpl: lockedRename(rename, { failTimes: Infinity }),
      suffix: 'test',
      platform: 'win32',
      sleep: async () => {},
    }),
    { code: 'EPERM' },
  );
  assert.equal(readFileSync(file, 'utf8'), '{not-json');
});

test('unix bookmark quarantine does not retry a locked rename', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rauhwpx-bookmarks-unix-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'native-document-bookmarks.json');
  writeFileSync(file, '{not-json');
  await assert.rejects(
    quarantineBookmarkState(file, {
      renameImpl: lockedRename(rename, { failTimes: 1 }),
      suffix: 'test',
      platform: 'linux',
      sleep: async () => {},
    }),
    { code: 'EPERM' },
  );
  assert.equal(readFileSync(file, 'utf8'), '{not-json');
});
