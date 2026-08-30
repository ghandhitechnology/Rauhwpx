import spawn from 'cross-spawn';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { IMAGE_REFERENCE_EXTENSIONS } from './reference-image.mjs';
import {
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExit,
  terminateProcessTree,
} from './process-tree.mjs';

export const MAX_EXTRACTED_CHARS = 5_000_000;
const MAX_REFERENCE_SOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 2_000;
export const MAX_DOCX_ZIP_ENTRIES = 4_096;
export const MAX_DOCX_EXPANDED_BYTES = 128 * 1024 * 1024;
const HWP_EXTENSIONS = new Set(['.hwp', '.hwpx', '.hml']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm',
]);

export const SUPPORTED_REFERENCE_EXTENSIONS = Object.freeze([
  ...TEXT_EXTENSIONS, '.pdf', '.docx', ...HWP_EXTENSIONS, ...IMAGE_REFERENCE_EXTENSIONS,
]);

export class ReferenceExtractionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ReferenceExtractionError';
  }
}

function extensionOf(name) {
  return path.extname(String(name ?? '')).toLowerCase();
}

function capText(text, name) {
  const normalized = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .normalize('NFKC');
  if (!normalized.trim()) {
    throw new ReferenceExtractionError('REFERENCE_EMPTY_TEXT', `${name} contains no searchable text`);
  }
  if (normalized.length > MAX_EXTRACTED_CHARS) {
    throw new ReferenceExtractionError(
      'REFERENCE_TEXT_TOO_LARGE',
      `${name} expands beyond the ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')}-character text limit`,
    );
  }
  return normalized;
}

function decodeUtf8(bytes, name) {
  if (bytes.includes(0)) {
    throw new ReferenceExtractionError('REFERENCE_BINARY_FILE', `${name} is not a plain-text file`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new ReferenceExtractionError('REFERENCE_ENCODING_UNSUPPORTED', `${name} must use UTF-8 text encoding`);
  }
}

const HTML_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
});

function decodeHtmlEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[lower] ?? match;
  });
}

export function markupToText(markup) {
  return decodeHtmlEntities(markup
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function pdfLimitError(name, what) {
  return new ReferenceExtractionError(
    what === 'pages' ? 'REFERENCE_PAGE_LIMIT' : 'REFERENCE_TEXT_TOO_LARGE',
    what === 'pages'
      ? `${name} has more than ${MAX_PDF_PAGES.toLocaleString('en-US')} pages`
      : `${name} expands beyond the ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')}-character text limit`,
  );
}

/** Page-by-page PDF collection with limits applied before strings are joined. */
export async function collectPdfPages(document, name, {
  maxPages = MAX_PDF_PAGES,
  maxChars = MAX_EXTRACTED_CHARS,
} = {}) {
  if (!Number.isSafeInteger(document?.numPages) || document.numPages < 1) {
    throw new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', `${name} has an invalid page count`);
  }
  if (document.numPages > maxPages) throw pdfLimitError(name, 'pages');
  const pages = [];
  let totalChars = 0;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const parts = [];
    let reader = null;
    const appendItems = (items) => {
      for (const item of items ?? []) {
        const text = typeof item?.str === 'string' ? item.str : '';
        if (!text) continue;
        const extra = text.length + (parts.length > 0 ? 1 : 0);
        if (totalChars + extra > maxChars) throw pdfLimitError(name, 'characters');
        if (parts.length > 0) totalChars += 1;
        totalChars += text.length;
        parts.push(text);
      }
    };
    try {
      if (typeof page.streamTextContent === 'function') {
        reader = page.streamTextContent().getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          appendItems(value?.items);
        }
      } else {
        appendItems((await page.getTextContent()).items);
      }
      if (pages.length > 0) {
        if (totalChars + 3 > maxChars) throw pdfLimitError(name, 'characters');
        totalChars += 3;
      }
      pages.push({ page: pageNumber, text: parts.join(' ') });
    } catch (error) {
      try { await reader?.cancel?.(error); } catch {}
      throw error;
    } finally {
      reader?.releaseLock?.();
      try { page.cleanup?.(); } catch {}
    }
  }
  return pages;
}

async function extractPdf(bytes, name) {
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') {
    throw new ReferenceExtractionError('REFERENCE_TYPE_MISMATCH', `${name} does not have a valid PDF signature`);
  }
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error) {
    throw new ReferenceExtractionError('REFERENCE_EXTRACTOR_UNAVAILABLE', `PDF extraction is unavailable: ${error?.message ?? error}`);
  }
  let document;
  try {
    document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
    const pages = await collectPdfPages(document, name);
    return { text: pages.map((page) => page.text).join('\n\f\n'), pages };
  } catch (error) {
    if (error instanceof ReferenceExtractionError) throw error;
    const message = /password/i.test(String(error?.name ?? error?.message ?? error))
      ? `${name} is password protected`
      : `Could not extract text from ${name}: ${error?.message ?? error}`;
    throw new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', message);
  } finally {
    try { await document?.destroy(); } catch {}
  }
}

function archiveError(code, name, detail) {
  return new ReferenceExtractionError(code, `${name} ${detail}`);
}

function zip64UncompressedSize(bytes, extraStart, extraLength, needsUncompressed) {
  if (!needsUncompressed) return null;
  const end = extraStart + extraLength;
  for (let cursor = extraStart; cursor + 4 <= end;) {
    const tag = bytes.readUInt16LE(cursor);
    const size = bytes.readUInt16LE(cursor + 2);
    const valueStart = cursor + 4;
    if (valueStart + size > end) return null;
    if (tag === 0x0001 && size >= 8) {
      const value = bytes.readBigUInt64LE(valueStart);
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.POSITIVE_INFINITY;
    }
    cursor = valueStart + size;
  }
  return null;
}

/** Inspect ZIP central-directory metadata before Mammoth inflates any DOCX entry. */
export function preflightDocxArchive(source, name = 'document.docx') {
  const bytes = Buffer.from(source);
  const minimum = Math.max(0, bytes.length - (65_535 + 22));
  let eocd = -1;
  for (let cursor = bytes.length - 22; cursor >= minimum; cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50) {
      const commentLength = bytes.readUInt16LE(cursor + 20);
      if (cursor + 22 + commentLength === bytes.length) {
        eocd = cursor;
        break;
      }
    }
  }
  if (eocd < 0) throw archiveError('REFERENCE_TYPE_MISMATCH', name, 'does not have a valid ZIP directory');
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
    || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw archiveError('REFERENCE_ARCHIVE_UNSUPPORTED', name, 'uses unsupported multi-disk or ZIP64 directory metadata');
  }
  if (totalEntries > MAX_DOCX_ZIP_ENTRIES) {
    throw archiveError('REFERENCE_ARCHIVE_TOO_LARGE', name, `has more than ${MAX_DOCX_ZIP_ENTRIES} ZIP entries`);
  }
  if (centralOffset + centralSize > eocd || centralOffset < 0) {
    throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'has a malformed ZIP directory');
  }

  let cursor = centralOffset;
  let expandedBytes = 0;
  let hasContentTypes = false;
  let hasDocumentXml = false;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'has a malformed ZIP entry');
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    if ((flags & 0x1) !== 0) {
      throw archiveError('REFERENCE_ARCHIVE_UNSUPPORTED', name, 'contains encrypted ZIP entries');
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'has a truncated ZIP entry');
    const entryName = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    hasContentTypes ||= entryName === '[Content_Types].xml';
    hasDocumentXml ||= entryName === 'word/document.xml';
    let uncompressed = bytes.readUInt32LE(cursor + 24);
    if (uncompressed === 0xffffffff) {
      uncompressed = zip64UncompressedSize(
        bytes,
        cursor + 46 + nameLength,
        extraLength,
        true,
      );
      if (uncompressed === null) {
        throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'has incomplete ZIP64 entry metadata');
      }
    }
    expandedBytes += uncompressed;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_DOCX_EXPANDED_BYTES) {
      throw archiveError('REFERENCE_ARCHIVE_TOO_LARGE', name, 'expands beyond the 128 MiB DOCX limit');
    }
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) {
    throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'has inconsistent ZIP directory metadata');
  }
  if (!hasContentTypes || !hasDocumentXml) {
    throw archiveError('REFERENCE_TYPE_MISMATCH', name, 'is a ZIP file but not a DOCX document');
  }
  return { entries: totalEntries, expandedBytes };
}

async function extractDocx(bytes, name) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ReferenceExtractionError('REFERENCE_TYPE_MISMATCH', `${name} does not have a valid DOCX signature`);
  }
  preflightDocxArchive(bytes, name);
  let mammoth;
  try {
    mammoth = await import('mammoth');
  } catch (error) {
    if (error instanceof ReferenceExtractionError) throw error;
    throw new ReferenceExtractionError('REFERENCE_EXTRACTOR_UNAVAILABLE', `DOCX extraction is unavailable: ${error?.message ?? error}`);
  }
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { text: result.value, warnings: result.messages?.map((item) => String(item.message ?? item)) ?? [] };
  } catch (error) {
    throw new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', `Could not extract text from ${name}: ${error?.message ?? error}`);
  }
}

async function isExecutable(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveRhwpBinary(projectRoot, env = process.env) {
  const candidates = [];
  if (typeof env.RHWP_BIN === 'string' && env.RHWP_BIN.trim()) {
    candidates.push(path.resolve(env.RHWP_BIN));
  }
  if (projectRoot) {
    for (const rel of ['target/release/rhwp', 'target/debug/rhwp', 'target/release/rhwp.exe', 'target/debug/rhwp.exe']) {
      candidates.push(path.resolve(projectRoot, rel));
    }
  }
  const names = process.platform === 'win32' ? ['rhwp.exe', 'rhwp'] : ['rhwp'];
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) candidates.push(path.join(dir, name));
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Deployment probe: the rhwp binary used for .hwp/.hwpx/.hml text extraction, or null. */
export function resolveHwpExtractor(projectRoot, env = process.env) {
  return resolveRhwpBinary(projectRoot, env);
}

export function runRhwpExport(binary, filePath, timeoutMs = 30_000, {
  spawnProcess = spawn,
  terminateProcess = terminateProcessTree,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, ['export-text', filePath, '--json'], {
      ...processTreeSpawnOptions(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let forcedError = null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const stop = (error) => {
      if (settled || forcedError) return;
      forcedError = error;
      clearTimeout(timer);
      void terminateAndWaitForProcessTreeExit(child, {
        timeoutMs: 7_000,
        terminateProcess,
        terminateOptions: { graceMs: 5_000 },
      }).catch(() => false).then((cleaned) => {
        if (!cleaned) error.processCleanupUncertain = true;
        finish(() => reject(error));
      });
    };
    const timer = setTimeout(() => {
      stop(new ReferenceExtractionError('REFERENCE_EXTRACTION_TIMEOUT', 'HWP text extraction timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (forcedError) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) {
        stop(new ReferenceExtractionError('REFERENCE_TEXT_TOO_LARGE', 'HWP text extraction output is too large'));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (!forcedError) stderr = (stderr + chunk).slice(-8000);
    });
    child.once('error', (error) => {
      if (!forcedError) finish(() => reject(new ReferenceExtractionError('REFERENCE_EXTRACTOR_UNAVAILABLE', String(error?.message ?? error))));
    });
    // 'close' waits for stderr to drain, so a failure message is never cut off.
    child.once('close', (code) => {
      if (forcedError) return;
      finish(() => {
      if (code !== 0) {
        reject(new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', stderr.trim() || `rhwp exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const pages = Array.isArray(parsed.pages)
          ? parsed.pages.map((page, index) => ({ page: Number(page.page ?? index) + 1, text: String(page.text ?? '') }))
          : [];
        resolve({ text: pages.map((page) => page.text).join('\n\f\n'), pages });
      } catch {
        reject(new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', 'rhwp returned invalid text-extraction JSON'));
      }
      });
    });
  });
}

async function extractHwp(filePath, name, projectRoot) {
  if (!filePath) throw new ReferenceExtractionError('REFERENCE_EXTRACTOR_UNAVAILABLE', 'HWP extraction requires a staged local file');
  const binary = await resolveRhwpBinary(projectRoot);
  if (!binary) {
    throw new ReferenceExtractionError(
      'REFERENCE_EXTRACTOR_UNAVAILABLE',
      `HWP/HWPX/HML text extraction is unavailable for ${name}; build target/release/rhwp or set RHWP_BIN`,
    );
  }
  return runRhwpExport(binary, filePath);
}

async function boundedReferenceSource(bytes, filePath, name) {
  if (bytes !== undefined && bytes !== null) {
    const source = Buffer.from(bytes);
    if (source.length > MAX_REFERENCE_SOURCE_BYTES) {
      throw new ReferenceExtractionError('REFERENCE_FILE_TOO_LARGE', `${name} exceeds the reference-file limit`);
    }
    return source;
  }
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_REFERENCE_SOURCE_BYTES) {
      throw new ReferenceExtractionError('REFERENCE_FILE_TOO_LARGE', `${name} exceeds the reference-file limit`);
    }
    const source = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < source.length) {
      const { bytesRead } = await handle.read(source, offset, source.length - offset, offset);
      if (bytesRead === 0) {
        throw new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', `${name} changed while it was read`);
      }
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, source.length)).bytesRead !== 0) {
      throw new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', `${name} changed while it was read`);
    }
    return source;
  } finally {
    await handle.close();
  }
}

/** Extract searchable text without ever treating binary bytes as prose. */
export async function extractReferenceText({ bytes, filePath, name, mimeType, projectRoot }) {
  const extension = extensionOf(name);
  if (!SUPPORTED_REFERENCE_EXTENSIONS.includes(extension)) {
    throw new ReferenceExtractionError('REFERENCE_TYPE_UNSUPPORTED', `${name} is not a supported reference-file type`);
  }
  let result;
  if (TEXT_EXTENSIONS.has(extension)) {
    const source = await boundedReferenceSource(bytes, filePath, name);
    let text = decodeUtf8(source, name);
    if (extension === '.json') {
      try { text = JSON.stringify(JSON.parse(text), null, 2); }
      catch { throw new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', `${name} contains invalid JSON`); }
    } else if (extension === '.html' || extension === '.htm' || extension === '.xml') {
      text = markupToText(text);
    }
    result = { text };
  } else if (extension === '.pdf') {
    const source = await boundedReferenceSource(bytes, filePath, name);
    result = await extractPdf(source, name);
  } else if (extension === '.docx') {
    const source = await boundedReferenceSource(bytes, filePath, name);
    result = await extractDocx(source, name);
  } else if (HWP_EXTENSIONS.has(extension)) {
    result = await extractHwp(filePath, name, projectRoot);
  } else {
    throw new ReferenceExtractionError('REFERENCE_TYPE_UNSUPPORTED', `${name} is not supported`);
  }
  const text = capText(result.text, name);
  let pages = null;
  if (Array.isArray(result.pages)) {
    let normalizedChars = 0;
    pages = result.pages.map((page, index) => {
      const pageText = String(page.text ?? '').normalize('NFKC');
      normalizedChars += pageText.length + (index > 0 ? 3 : 0);
      if (normalizedChars > MAX_EXTRACTED_CHARS) throw pdfLimitError(name, 'characters');
      return { page: page.page, text: pageText };
    });
  }
  return {
    text,
    pages,
    warnings: result.warnings ?? [],
    mimeType: String(mimeType || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase(),
  };
}

function chooseChunkEnd(text, start, desiredEnd) {
  if (desiredEnd >= text.length) return text.length;
  const floor = Math.max(start + 400, desiredEnd - 200);
  for (let index = desiredEnd; index >= floor; index -= 1) {
    if (/\s/.test(text[index] ?? '')) return index;
  }
  return desiredEnd;
}

/** Stable bounded chunks used by both the index and citations. */
export function chunkReferenceText(extracted, { chunkChars = 1_200, overlapChars = 180 } = {}) {
  const sources = extracted.pages?.length
    ? extracted.pages.map((page) => ({ page: page.page, text: page.text }))
    : [{ page: null, text: extracted.text }];
  const chunks = [];
  let ordinal = 0;
  for (const source of sources) {
    const text = source.text.trim();
    let start = 0;
    while (start < text.length) {
      const end = chooseChunkEnd(text, start, Math.min(text.length, start + chunkChars));
      const chunkText = text.slice(start, end).trim();
      if (chunkText) {
        chunks.push({ id: `c${ordinal++}`, page: source.page, start, end, text: chunkText });
      }
      if (end >= text.length) break;
      start = Math.max(start + 1, end - overlapChars);
    }
  }
  return chunks;
}
