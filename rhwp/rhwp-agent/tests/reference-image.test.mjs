import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectReferenceImageMime,
  inspectReferenceImage,
  MAX_IMAGE_REFERENCE_BYTES,
  referenceKindForName,
} from '../reference-image.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF = Buffer.from('GIF89a000000', 'ascii');
const WEBP = Buffer.from('RIFF0000WEBPVP8 ', 'ascii');

test('common raster signatures and reference kinds are detected', () => {
  assert.equal(detectReferenceImageMime(PNG), 'image/png');
  assert.equal(detectReferenceImageMime(JPEG), 'image/jpeg');
  assert.equal(detectReferenceImageMime(GIF), 'image/gif');
  assert.equal(detectReferenceImageMime(WEBP), 'image/webp');
  assert.equal(referenceKindForName('capture.PNG'), 'image');
  assert.equal(referenceKindForName('notes.pdf'), 'document');
});

test('image inspection rejects renamed files and conflicting content types', async () => {
  assert.equal((await inspectReferenceImage({ bytes: PNG, name: 'capture.png', mimeType: 'image/png' })).mimeType, 'image/png');
  await assert.rejects(
    inspectReferenceImage({ bytes: PNG, name: 'capture.jpg', mimeType: 'image/jpeg' }),
    (error) => error.code === 'REFERENCE_TYPE_MISMATCH',
  );
  await assert.rejects(
    inspectReferenceImage({ bytes: PNG, name: 'capture.png', mimeType: 'image/webp' }),
    (error) => error.code === 'REFERENCE_TYPE_MISMATCH',
  );
  await assert.rejects(
    inspectReferenceImage({ bytes: Buffer.alloc(MAX_IMAGE_REFERENCE_BYTES + 1), name: 'huge.png', mimeType: 'image/png' }),
    (error) => error.code === 'REFERENCE_FILE_TOO_LARGE',
  );
});

test('image inspection reports files that change during a bounded read as extraction failures', async (t) => {
  for (const mutation of ['shrinks', 'grows']) {
    await t.test(mutation, async () => {
      let reads = 0;
      let closed = false;
      const handle = {
        async stat() {
          return { isFile: () => true, size: PNG.length };
        },
        async read(target, offset) {
          reads += 1;
          if (mutation === 'shrinks') {
            if (reads > 1) return { bytesRead: 0 };
            const length = Math.floor(PNG.length / 2);
            PNG.copy(target, offset, 0, length);
            return { bytesRead: length };
          }
          if (reads > 1) {
            target[offset] = 0;
            return { bytesRead: 1 };
          }
          PNG.copy(target, offset);
          return { bytesRead: PNG.length };
        },
        async close() {
          closed = true;
        },
      };

      await assert.rejects(
        inspectReferenceImage(
          { filePath: '/fake/capture.png', name: 'capture.png', mimeType: 'image/png' },
          { openFile: async () => handle },
        ),
        (error) => {
          assert.equal(error.code, 'REFERENCE_EXTRACTION_FAILED');
          assert.match(error.message, /changed while it was read/);
          return true;
        },
      );
      assert.equal(closed, true);
    });
  }
});
