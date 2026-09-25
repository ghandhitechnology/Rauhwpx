import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveRenderSavePath, writeRenderPng } from '../render-save.mjs';

const PNG_BASE64 = Buffer.from('\x89PNG\r\n\x1a\nfake', 'latin1').toString('base64');

async function withWorkDir(fn) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rhwp-render-save-')));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('savePath 는 작업 폴더 안의 .png 로만 풀린다', async () => {
  await withWorkDir(async (workDir) => {
    assert.equal(resolveRenderSavePath(workDir, 'renders/p1.png'), path.join(workDir, 'renders', 'p1.png'));
    assert.equal(resolveRenderSavePath(workDir, 'p1'), path.join(workDir, 'p1.png'));
    for (const bad of ['../escape.png', '/tmp/abs.png', 'a/../../x.png', 'shot.jpg', '', '.']) {
      assert.throws(() => resolveRenderSavePath(workDir, bad), { code: 'INVALID_ARGS' }, bad);
    }
  });
});

test('writeRenderPng 는 PNG 를 쓰고 심볼릭 링크 폴더로 새지 않는다', async () => {
  await withWorkDir(async (workDir) => {
    const target = resolveRenderSavePath(workDir, 'renders/p1.png');
    const saved = await writeRenderPng({ workDir, target, data: PNG_BASE64 });
    assert.equal(saved.imagePath, target);
    assert.deepEqual(await readFile(target), Buffer.from(PNG_BASE64, 'base64'));
    // 같은 이름으로 다시 쓰면 덮어쓴다
    await writeRenderPng({ workDir, target, data: PNG_BASE64 });

    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rhwp-render-out-')));
    try {
      await symlink(outside, path.join(workDir, 'link'));
      const linked = resolveRenderSavePath(workDir, 'link/p.png');
      await assert.rejects(writeRenderPng({ workDir, target: linked, data: PNG_BASE64 }), { code: 'INVALID_ARGS' });
      // 링크 너머에 하위 폴더를 만들지 않는다
      const deep = resolveRenderSavePath(workDir, 'link/sub/p.png');
      await assert.rejects(writeRenderPng({ workDir, target: deep, data: PNG_BASE64 }), { code: 'INVALID_ARGS' });
      await assert.rejects(stat(path.join(outside, 'sub')), { code: 'ENOENT' });

      await mkdir(path.join(workDir, 'files'));
      await symlink(path.join(outside, 'victim.png'), path.join(workDir, 'files', 'v.png'));
      const fileLink = resolveRenderSavePath(workDir, 'files/v.png');
      await assert.rejects(writeRenderPng({ workDir, target: fileLink, data: PNG_BASE64 }));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
