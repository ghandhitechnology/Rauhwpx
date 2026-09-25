import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { prepareInsertImageArgs } from '../insert-image-source.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9fngAAAABJRU5ErkJggg==',
  'base64',
);

function jpegHeader(width, height) {
  const bytes = Buffer.alloc(23);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xc0;
  bytes.writeUInt16BE(17, 4);
  bytes[6] = 8;
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[21] = 0xff; bytes[22] = 0xd9;
  return bytes;
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rhwp-insert-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('generated PNG in workspace is sent as bytes with measured size', async (t) => {
  const root = await workspace(t);
  const imagePath = path.join(root, 'generated-image');
  await writeFile(imagePath, PNG);
  const result = await prepareInsertImageArgs({
    imagePath, sectionIdx: 0, paraIdx: 2, charOffset: 0, expectedRevision: 7,
  }, [root]);
  assert.deepEqual(result, {
    sectionIdx: 0, paraIdx: 2, charOffset: 0, expectedRevision: 7,
    imageBase64: PNG.toString('base64'), extension: 'png',
    naturalWidthPx: 1, naturalHeightPx: 1,
  });
});

test('image bytes determine the MIME extension when a generated filename is misleading', async (t) => {
  const root = await workspace(t);
  const imagePath = path.join(root, 'render.jpg');
  await writeFile(imagePath, PNG);
  const result = await prepareInsertImageArgs({ imagePath }, [root]);
  assert.equal(result.extension, 'png');
  const jpegPath = path.join(root, 'render.png');
  await writeFile(jpegPath, jpegHeader(640, 480));
  const jpeg = await prepareInsertImageArgs({ imagePath: jpegPath }, [root]);
  assert.equal(jpeg.extension, 'jpg');
  assert.equal(jpeg.naturalWidthPx, 640);
  assert.equal(jpeg.naturalHeightPx, 480);
});

test('existing GIF and BMP image formats still pass', async (t) => {
  const root = await workspace(t);
  const gif = Buffer.alloc(10);
  gif.write('GIF89a', 0);
  gif.writeUInt16LE(64, 6);
  gif.writeUInt16LE(32, 8);
  const bmp = Buffer.alloc(26);
  bmp.write('BM', 0);
  bmp.writeInt32LE(200, 18);
  bmp.writeInt32LE(-100, 22);
  for (const [name, bytes, extension, width, height] of [
    ['image.gif', gif, 'gif', 64, 32],
    ['image.bmp', bmp, 'bmp', 200, 100],
  ]) {
    const imagePath = path.join(root, name);
    await writeFile(imagePath, bytes);
    const result = await prepareInsertImageArgs({ imagePath }, [root]);
    assert.equal(result.extension, extension);
    assert.equal(result.naturalWidthPx, width);
    assert.equal(result.naturalHeightPx, height);
  }
});

test('outside paths and symlink escapes fail before the image is opened', async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  const secret = path.join(outside, 'secret.png');
  await writeFile(secret, PNG);
  const link = path.join(root, 'link.png');
  try {
    await symlink(secret, link);
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    t.skip(`symlinks are unavailable: ${error.code}`);
    return;
  }
  let opened = 0;
  const openFile = async () => { opened++; throw new Error('unexpected read'); };
  for (const imagePath of [secret, link]) {
    await assert.rejects(
      prepareInsertImageArgs({ imagePath }, [root], { openFile }),
      (error) => error.code === 'INVALID_ARGS',
    );
  }
  assert.equal(opened, 0);
});

test('invalid formats and oversized generated files fail before document insertion', async (t) => {
  const root = await workspace(t);
  const webpPath = path.join(root, 'render.webp');
  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0); webp.write('WEBP', 8);
  await writeFile(webpPath, webp);
  await assert.rejects(
    prepareInsertImageArgs({ imagePath: webpPath }, [root]),
    (error) => error.code === 'INVALID_ARGS' && /WebP/.test(error.message),
  );
  const oversizedPath = path.join(root, 'large.png');
  await writeFile(oversizedPath, Buffer.alloc(5 * 1024 * 1024 + 1));
  await assert.rejects(
    prepareInsertImageArgs({ imagePath: oversizedPath }, [root]),
    (error) => error.code === 'INVALID_ARGS' && /5MB/.test(error.message),
  );
  await assert.rejects(
    prepareInsertImageArgs({ imageBase64: PNG.toString('base64'), extension: 'jpg' }, [root]),
    (error) => error.code === 'INVALID_ARGS' && /does not match/.test(error.message),
  );
});

test('reference images pass through for the hub to read from the reference store', async () => {
  const args = { referenceFileId: 'ref-1', cropPx: { x: 0, y: 0, width: 5, height: 5 }, sectionIdx: 0 };
  assert.deepEqual(await prepareInsertImageArgs(args, []), args);
  await assert.rejects(
    prepareInsertImageArgs({ referenceFileId: 'ref-1', imagePath: '/tmp/a.png' }, []),
    (error) => error.code === 'INVALID_ARGS',
  );
});
