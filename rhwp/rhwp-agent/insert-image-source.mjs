import { open } from 'node:fs/promises';
import { assertImagePathInsideRoots } from './image-path-policy.mjs';

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTS = new Set(['png', 'jpg', 'gif', 'bmp']);

function imageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function imageDetails(bytes) {
  if (bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { extension: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    return { extension: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') {
    return { extension: 'bmp', width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (length < 7) break;
        return { extension: 'jpg', width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

async function readImageFile(imagePath, openFile) {
  let handle;
  try {
    handle = await openFile(imagePath, 'r');
  } catch (error) {
    throw imageError(error?.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'INVALID_ARGS', `cannot read image file: ${error?.message ?? error}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw imageError('INVALID_ARGS', 'image path must name a regular file');
    if (stat.size < 1) throw imageError('INVALID_ARGS', 'image file is empty');
    if (stat.size > IMAGE_MAX_BYTES) throw imageError('INVALID_ARGS', 'image is larger than 5MB');
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw imageError('INVALID_ARGS', 'image file changed while it was read');
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead !== 0) {
      throw imageError('INVALID_ARGS', 'image file changed while it was read');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Read a bounded local image and prepare the browser document tool's byte payload. */
export async function prepareInsertImageArgs(args, allowedRoots, { openFile = open } = {}) {
  const { imagePath, imageBase64, extension, ...rest } = args ?? {};
  let bytes;
  let fromBase64 = false;
  if (typeof imagePath === 'string' && imagePath.length > 0) {
    const readablePath = await assertImagePathInsideRoots(imagePath, allowedRoots);
    bytes = await readImageFile(readablePath, openFile);
  } else if (typeof imageBase64 === 'string' && imageBase64.length > 0) {
    fromBase64 = true;
    if (typeof extension !== 'string' || !IMAGE_EXTS.has(extension.toLowerCase().replace('jpeg', 'jpg'))) {
      throw imageError('INVALID_ARGS', 'extension must be png/jpg/gif/bmp with imageBase64');
    }
    bytes = Buffer.from(imageBase64, 'base64');
    if (bytes.length < 1) throw imageError('INVALID_ARGS', 'image file is empty');
    if (bytes.length > IMAGE_MAX_BYTES) throw imageError('INVALID_ARGS', 'image is larger than 5MB');
  } else {
    throw imageError('INVALID_ARGS', 'either imagePath or imageBase64 is required');
  }
  const details = imageDetails(bytes);
  if (!details || details.width < 1 || details.height < 1) {
    const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP';
    throw imageError('INVALID_ARGS', webp
      ? 'WebP cannot be inserted into a document; save the image as PNG or JPEG'
      : 'could not read image dimensions; use a valid PNG/JPEG/GIF/BMP image');
  }
  if (fromBase64 && details.extension !== extension.toLowerCase().replace('jpeg', 'jpg')) {
    throw imageError('INVALID_ARGS', 'extension does not match image data');
  }
  return {
    ...rest,
    imageBase64: bytes.toString('base64'),
    extension: details.extension,
    naturalWidthPx: details.width,
    naturalHeightPx: details.height,
  };
}
