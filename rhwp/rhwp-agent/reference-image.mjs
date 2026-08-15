import { promises as fs } from 'node:fs';
import path from 'node:path';

export const IMAGE_REFERENCE_EXTENSIONS = Object.freeze([
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
]);

export const MAX_IMAGE_REFERENCE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
});

function normalizedMime(value) {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

export function referenceKindForName(name) {
  return IMAGE_REFERENCE_EXTENSIONS.includes(path.extname(String(name ?? '')).toLowerCase())
    ? 'image'
    : 'document';
}

export function detectReferenceImageMime(bytes) {
  const source = Buffer.from(bytes ?? []);
  if (source.length >= 8
    && source[0] === 0x89
    && source.toString('ascii', 1, 4) === 'PNG'
    && source[4] === 0x0d && source[5] === 0x0a && source[6] === 0x1a && source[7] === 0x0a) {
    return 'image/png';
  }
  if (source.length >= 3 && source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff) {
    return 'image/jpeg';
  }
  if (source.length >= 6) {
    const signature = source.toString('ascii', 0, 6);
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (source.length >= 12
    && source.toString('ascii', 0, 4) === 'RIFF'
    && source.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export async function inspectReferenceImage({ bytes, filePath, name, mimeType }) {
  const source = bytes ? Buffer.from(bytes) : await fs.readFile(filePath);
  if (source.length === 0) {
    const error = new Error(`${name} is empty`);
    error.code = 'REFERENCE_FILE_EMPTY';
    throw error;
  }
  if (source.length > MAX_IMAGE_REFERENCE_BYTES) {
    const error = new Error(`${name} exceeds the 20 MB image limit`);
    error.code = 'REFERENCE_FILE_TOO_LARGE';
    throw error;
  }
  const extension = path.extname(String(name ?? '')).toLowerCase();
  const expectedMime = MIME_BY_EXTENSION[extension];
  const detectedMime = detectReferenceImageMime(source);
  if (!expectedMime || !detectedMime || expectedMime !== detectedMime) {
    const error = new Error(`${name} does not match its image file extension`);
    error.code = 'REFERENCE_TYPE_MISMATCH';
    throw error;
  }
  const declaredMime = normalizedMime(mimeType);
  if (declaredMime && declaredMime !== 'application/octet-stream' && declaredMime !== detectedMime) {
    const error = new Error(`${name} does not match its declared content type`);
    error.code = 'REFERENCE_TYPE_MISMATCH';
    throw error;
  }
  return { bytes: source, mimeType: detectedMime };
}
