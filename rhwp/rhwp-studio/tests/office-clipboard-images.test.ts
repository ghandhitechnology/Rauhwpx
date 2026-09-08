import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEmfDibs, extractRtfPictures } from '../src/engine/office-clipboard-images.ts';

test('잘린 EMF 비트맵 레코드는 RangeError 없이 건너뛴다', () => {
  const emf = new Uint8Array(50);
  const view = new DataView(emf.buffer);
  view.setUint32(0, 81, true);
  view.setUint32(4, 32, true);
  assert.doesNotThrow(() => extractEmfDibs(emf));
  assert.equal(extractEmfDibs(emf).dibs.length, 0);
});

test('중첩 blipuid 그룹이 있어도 pict hex 를 모은다', () => {
  const pngHex =
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    + '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082';
  const rtf = `{\\pict{\\*\\blipuid abcdef0123456789abcdef0123456789}\\pngblip ${pngHex}}`;
  const pictures = extractRtfPictures(rtf);
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].mime, 'image/png');
  assert.ok(pictures[0].bytes.byteLength > 16, 'blipuid 만 읽고 끊으면 안 된다');
});
