import spawn from 'cross-spawn';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createInflateRaw } from 'node:zlib';

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
const MAX_DOCX_ENTRY_NAME_BYTES = 4_096;
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

function textLimitError(name) {
  return new ReferenceExtractionError(
    'REFERENCE_TEXT_TOO_LARGE',
    `${name} expands beyond the ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')}-character text limit`,
  );
}

function boundedRawText(text, name) {
  const value = String(text ?? '');
  if (value.length > MAX_EXTRACTED_CHARS) throw textLimitError(name);
  return value;
}

function capText(text, name) {
  // Reject before replace/normalization creates several additional full-size
  // strings. Format-specific extractors may return far more than 5M chars.
  const normalized = boundedRawText(text, name)
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .normalize('NFKC');
  if (!normalized.trim()) {
    throw new ReferenceExtractionError('REFERENCE_EMPTY_TEXT', `${name} contains no searchable text`);
  }
  if (normalized.length > MAX_EXTRACTED_CHARS) {
    throw textLimitError(name);
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

const MAX_JSON_NESTING_DEPTH = 512;

function invalidJson(name) {
  return new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', `${name} contains invalid JSON`);
}

/** Validate JSON in linear space without materializing its object graph. */
export function validateJsonTextSyntax(text, name = 'reference JSON') {
  const source = String(text);
  let offset = 0;
  const frames = [{ type: 'root', state: 'value' }];
  const skipWhitespace = () => {
    while (offset < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[offset])) offset += 1;
  };
  const parseString = () => {
    if (source[offset] !== '"') throw invalidJson(name);
    offset += 1;
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      const character = source[offset];
      offset += 1;
      if (character === '"') return;
      if (code <= 0x1f) throw invalidJson(name);
      if (character !== '\\') continue;
      if (offset >= source.length) throw invalidJson(name);
      const escape = source[offset];
      offset += 1;
      if ('"\\/bfnrt'.includes(escape)) continue;
      if (escape !== 'u' || !/^[0-9a-fA-F]{4}$/.test(source.slice(offset, offset + 4))) {
        throw invalidJson(name);
      }
      offset += 4;
    }
    throw invalidJson(name);
  };
  const parseNumber = () => {
    if (source[offset] === '-') offset += 1;
    if (source[offset] === '0') offset += 1;
    else {
      if (!/[1-9]/.test(source[offset] ?? '')) throw invalidJson(name);
      while (/[0-9]/.test(source[offset] ?? '')) offset += 1;
    }
    if (source[offset] === '.') {
      offset += 1;
      if (!/[0-9]/.test(source[offset] ?? '')) throw invalidJson(name);
      while (/[0-9]/.test(source[offset] ?? '')) offset += 1;
    }
    if (source[offset] === 'e' || source[offset] === 'E') {
      offset += 1;
      if (source[offset] === '+' || source[offset] === '-') offset += 1;
      if (!/[0-9]/.test(source[offset] ?? '')) throw invalidJson(name);
      while (/[0-9]/.test(source[offset] ?? '')) offset += 1;
    }
  };
  const completeValue = () => {
    const frame = frames.at(-1);
    if (frame.type === 'root' && frame.state === 'value') frame.state = 'done';
    else if (frame.type === 'object' && frame.state === 'value') frame.state = 'commaOrEnd';
    else if (frame.type === 'array' && (frame.state === 'value' || frame.state === 'valueOrEnd')) {
      frame.state = 'commaOrEnd';
    } else throw invalidJson(name);
  };
  const startValue = () => {
    const character = source[offset];
    if (character === '{' || character === '[') {
      if (frames.length >= MAX_JSON_NESTING_DEPTH) throw invalidJson(name);
      offset += 1;
      frames.push(character === '{'
        ? { type: 'object', state: 'keyOrEnd' }
        : { type: 'array', state: 'valueOrEnd' });
      return;
    }
    if (character === '"') parseString();
    else if (character === '-' || /[0-9]/.test(character ?? '')) parseNumber();
    else if (source.startsWith('true', offset)) offset += 4;
    else if (source.startsWith('false', offset)) offset += 5;
    else if (source.startsWith('null', offset)) offset += 4;
    else throw invalidJson(name);
    completeValue();
  };

  while (frames.length > 0) {
    skipWhitespace();
    const frame = frames.at(-1);
    if (frame.type === 'root') {
      if (frame.state === 'value') startValue();
      else {
        if (offset !== source.length) throw invalidJson(name);
        frames.pop();
      }
      continue;
    }
    if (frame.type === 'object') {
      if (frame.state === 'keyOrEnd' && source[offset] === '}') {
        offset += 1;
        frames.pop();
        completeValue();
      } else if (frame.state === 'keyOrEnd' || frame.state === 'key') {
        parseString();
        frame.state = 'colon';
      } else if (frame.state === 'colon') {
        if (source[offset] !== ':') throw invalidJson(name);
        offset += 1;
        frame.state = 'value';
      } else if (frame.state === 'value') startValue();
      else if (frame.state === 'commaOrEnd' && source[offset] === ',') {
        offset += 1;
        frame.state = 'key';
      } else if (frame.state === 'commaOrEnd' && source[offset] === '}') {
        offset += 1;
        frames.pop();
        completeValue();
      } else throw invalidJson(name);
      continue;
    }
    if (frame.state === 'valueOrEnd' && source[offset] === ']') {
      offset += 1;
      frames.pop();
      completeValue();
    } else if (frame.state === 'valueOrEnd' || frame.state === 'value') startValue();
    else if (frame.state === 'commaOrEnd' && source[offset] === ',') {
      offset += 1;
      frame.state = 'value';
    } else if (frame.state === 'commaOrEnd' && source[offset] === ']') {
      offset += 1;
      frames.pop();
      completeValue();
    } else throw invalidJson(name);
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

export function markupToText(markup, name = 'reference markup') {
  const source = boundedRawText(markup, name);
  return decodeHtmlEntities(source
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

function zip64EntryValues(bytes, extraStart, extraLength, needs) {
  if (!needs.uncompressed && !needs.compressed && !needs.localOffset) return {};
  const end = extraStart + extraLength;
  for (let cursor = extraStart; cursor + 4 <= end;) {
    const tag = bytes.readUInt16LE(cursor);
    const size = bytes.readUInt16LE(cursor + 2);
    const valueStart = cursor + 4;
    if (valueStart + size > end) return null;
    if (tag === 0x0001) {
      let valueCursor = valueStart;
      const values = {};
      for (const key of ['uncompressed', 'compressed', 'localOffset']) {
        if (!needs[key]) continue;
        if (valueCursor + 8 > valueStart + size) return null;
        const value = bytes.readBigUInt64LE(valueCursor);
        values[key] = value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : Number.POSITIVE_INFINITY;
        valueCursor += 8;
      }
      return values;
    }
    cursor = valueStart + size;
  }
  return null;
}

function safeDocxMemberName(entryName, encodedLength) {
  if (!entryName || encodedLength > MAX_DOCX_ENTRY_NAME_BYTES || entryName.includes('\0')
    || entryName.includes('\\') || entryName.startsWith('/') || /^[a-z]:/i.test(entryName)) {
    return false;
  }
  const segments = entryName.split('/');
  if (segments.at(-1) === '') segments.pop();
  return segments.length > 0 && segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function docxExpansionLimitDetail(maxExpandedBytes) {
  const mib = maxExpandedBytes / (1024 * 1024);
  const formatted = Number.isInteger(mib)
    ? `${mib.toLocaleString('en-US')} MiB`
    : `${maxExpandedBytes.toLocaleString('en-US')} bytes`;
  return `expands beyond the ${formatted} DOCX limit`;
}

function inspectDocxArchive(source, name, maxExpandedBytes) {
  if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1
    || maxExpandedBytes > MAX_DOCX_EXPANDED_BYTES) {
    throw new TypeError(`maxExpandedBytes must be between 1 and ${MAX_DOCX_EXPANDED_BYTES}`);
  }
  const bytes = Buffer.isBuffer(source)
    ? source
    : ArrayBuffer.isView(source)
      ? Buffer.from(source.buffer, source.byteOffset, source.byteLength)
      : Buffer.from(source);
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
  if (centralOffset + centralSize > eocd) {
    throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'has a malformed ZIP directory');
  }

  let cursor = centralOffset;
  let expandedBytes = 0;
  let hasContentTypes = false;
  let hasDocumentXml = false;
  const names = new Set();
  const members = [];
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'has a malformed ZIP entry');
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    if ((flags & 0x41) !== 0) {
      throw archiveError('REFERENCE_ARCHIVE_UNSUPPORTED', name, 'contains encrypted ZIP entries');
    }
    if ((flags & ~0x080e) !== 0) {
      throw archiveError('REFERENCE_ARCHIVE_UNSUPPORTED', name, 'contains unsupported ZIP entry flags');
    }
    const compressionMethod = bytes.readUInt16LE(cursor + 10);
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw archiveError('REFERENCE_ARCHIVE_UNSUPPORTED', name, `uses unsupported ZIP compression method ${compressionMethod}`);
    }
    if (bytes.readUInt16LE(cursor + 34) !== 0) {
      throw archiveError('REFERENCE_ARCHIVE_UNSUPPORTED', name, 'uses unsupported multi-disk ZIP entries');
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'has a truncated ZIP entry');
    let entryName;
    try {
      entryName = utf8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      throw archiveError('REFERENCE_ARCHIVE_UNSUPPORTED', name, 'contains a non-UTF-8 ZIP entry name');
    }
    if (!safeDocxMemberName(entryName, nameLength)) {
      throw archiveError('REFERENCE_ARCHIVE_UNSUPPORTED', name, `contains an unsafe ZIP entry name: ${JSON.stringify(entryName)}`);
    }
    if (names.has(entryName)) {
      throw archiveError('REFERENCE_EXTRACTION_FAILED', name, `contains duplicate ZIP entry ${JSON.stringify(entryName)}`);
    }
    names.add(entryName);
    hasContentTypes ||= entryName === '[Content_Types].xml';
    hasDocumentXml ||= entryName === 'word/document.xml';

    let uncompressed = bytes.readUInt32LE(cursor + 24);
    let compressed = bytes.readUInt32LE(cursor + 20);
    let localOffset = bytes.readUInt32LE(cursor + 42);
    const zip64 = zip64EntryValues(bytes, cursor + 46 + nameLength, extraLength, {
      uncompressed: uncompressed === 0xffffffff,
      compressed: compressed === 0xffffffff,
      localOffset: localOffset === 0xffffffff,
    });
    if (zip64 === null) {
      throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'has incomplete ZIP64 entry metadata');
    }
    if (uncompressed === 0xffffffff) uncompressed = zip64.uncompressed;
    if (compressed === 0xffffffff) compressed = zip64.compressed;
    if (localOffset === 0xffffffff) localOffset = zip64.localOffset;
    if (![uncompressed, compressed, localOffset].every(Number.isSafeInteger)) {
      throw archiveError('REFERENCE_ARCHIVE_TOO_LARGE', name, docxExpansionLimitDetail(maxExpandedBytes));
    }
    expandedBytes += uncompressed;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > maxExpandedBytes) {
      throw archiveError('REFERENCE_ARCHIVE_TOO_LARGE', name, docxExpansionLimitDetail(maxExpandedBytes));
    }
    members.push({
      name: entryName,
      flags,
      compressionMethod,
      compressedSize: compressed,
      declaredUncompressedSize: uncompressed,
      localHeaderOffset: localOffset,
    });
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) {
    throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'has inconsistent ZIP directory metadata');
  }
  if (!hasContentTypes || !hasDocumentXml) {
    throw archiveError('REFERENCE_TYPE_MISMATCH', name, 'is a ZIP file but not a DOCX document');
  }
  return { bytes, entries: totalEntries, expandedBytes, centralOffset, members };
}

/** Inspect ZIP central-directory metadata before Mammoth inflates any DOCX entry. */
export function preflightDocxArchive(source, name = 'document.docx', {
  maxExpandedBytes = MAX_DOCX_EXPANDED_BYTES,
} = {}) {
  const inspected = inspectDocxArchive(source, name, maxExpandedBytes);
  return { entries: inspected.entries, expandedBytes: inspected.expandedBytes };
}

function resolveDocxMemberData(inspected, member, documentName) {
  const { bytes, centralOffset } = inspected;
  const cursor = member.localHeaderOffset;
  if (cursor < 0 || cursor + 30 > centralOffset || bytes.readUInt32LE(cursor) !== 0x04034b50) {
    throw archiveError('REFERENCE_EXTRACTION_FAILED', documentName, `has a malformed local header for ${JSON.stringify(member.name)}`);
  }
  const localFlags = bytes.readUInt16LE(cursor + 6);
  const localMethod = bytes.readUInt16LE(cursor + 8);
  const nameLength = bytes.readUInt16LE(cursor + 26);
  const extraLength = bytes.readUInt16LE(cursor + 28);
  const dataStart = cursor + 30 + nameLength + extraLength;
  const dataEnd = dataStart + member.compressedSize;
  if (localFlags !== member.flags || localMethod !== member.compressionMethod
    || !Number.isSafeInteger(dataEnd) || dataStart > centralOffset || dataEnd > centralOffset) {
    throw archiveError('REFERENCE_EXTRACTION_FAILED', documentName, `has inconsistent local metadata for ${JSON.stringify(member.name)}`);
  }
  const expectedName = Buffer.from(member.name, 'utf8');
  const localName = bytes.subarray(cursor + 30, cursor + 30 + nameLength);
  if (nameLength !== expectedName.length || !localName.equals(expectedName)) {
    throw archiveError('REFERENCE_EXTRACTION_FAILED', documentName, `has a mismatched local name for ${JSON.stringify(member.name)}`);
  }
  return {
    compressed: bytes.subarray(dataStart, dataEnd),
    rangeStart: cursor,
    rangeEnd: dataEnd,
  };
}

async function countInflatedEntry(
  compressed,
  documentName,
  memberName,
  maxEntryBytes,
  maxExpandedBytes,
) {
  let actualBytes = 0;
  const counter = new Writable({
    write(chunk, _encoding, callback) {
      if (chunk.length > maxEntryBytes - actualBytes) {
        callback(archiveError(
          'REFERENCE_ARCHIVE_TOO_LARGE',
          documentName,
          docxExpansionLimitDetail(maxExpandedBytes),
        ));
        return;
      }
      actualBytes += chunk.length;
      callback();
    },
  });
  try {
    await pipeline(Readable.from([compressed]), createInflateRaw(), counter);
  } catch (error) {
    if (error instanceof ReferenceExtractionError) throw error;
    throw archiveError(
      'REFERENCE_EXTRACTION_FAILED',
      documentName,
      `contains invalid compressed data for ${JSON.stringify(memberName)}`,
    );
  }
  return actualBytes;
}

/** Count actual output so forged central-directory sizes cannot hide expansion. */
export async function validateDocxExpandedBytes(source, name = 'document.docx', {
  maxExpandedBytes = MAX_DOCX_EXPANDED_BYTES,
} = {}) {
  const inspected = inspectDocxArchive(source, name, maxExpandedBytes);
  const resolvedMembers = inspected.members.map((member) => ({
    member,
    ...resolveDocxMemberData(inspected, member, name),
  }));
  const ranges = [...resolvedMembers].sort((a, b) => a.rangeStart - b.rangeStart);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].rangeStart < ranges[index - 1].rangeEnd) {
      throw archiveError('REFERENCE_EXTRACTION_FAILED', name, 'contains overlapping ZIP member data');
    }
  }
  let actualExpandedBytes = 0;
  for (const { member, compressed } of resolvedMembers) {
    const remaining = maxExpandedBytes - actualExpandedBytes;
    let actual;
    if (member.compressionMethod === 0) {
      actual = compressed.length;
      if (actual > remaining) {
        throw archiveError('REFERENCE_ARCHIVE_TOO_LARGE', name, docxExpansionLimitDetail(maxExpandedBytes));
      }
    } else {
      actual = await countInflatedEntry(
        compressed,
        name,
        member.name,
        remaining,
        maxExpandedBytes,
      );
    }
    actualExpandedBytes += actual;
    if (actual !== member.declaredUncompressedSize) {
      throw archiveError(
        'REFERENCE_EXTRACTION_FAILED',
        name,
        `has an incorrect expanded size for ${JSON.stringify(member.name)}`,
      );
    }
  }
  return { entries: inspected.entries, expandedBytes: actualExpandedBytes };
}

async function extractDocx(bytes, name) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ReferenceExtractionError('REFERENCE_TYPE_MISMATCH', `${name} does not have a valid DOCX signature`);
  }
  await validateDocxExpandedBytes(bytes, name);
  let mammoth;
  try {
    mammoth = await import('mammoth');
  } catch (error) {
    if (error instanceof ReferenceExtractionError) throw error;
    throw new ReferenceExtractionError('REFERENCE_EXTRACTOR_UNAVAILABLE', `DOCX extraction is unavailable: ${error?.message ?? error}`);
  }
  try {
    const result = await mammoth.extractRawText({ buffer: bytes });
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
    let stdoutBytes = 0;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
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
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      stdout += stdoutDecoder.write(bytes);
      if (stdoutBytes > 8 * 1024 * 1024) {
        stop(new ReferenceExtractionError('REFERENCE_TEXT_TOO_LARGE', 'HWP text extraction output is too large'));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (!forcedError) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderr = (stderr + stderrDecoder.write(bytes)).slice(-8000);
      }
    });
    child.once('error', (error) => {
      if (!forcedError) finish(() => reject(new ReferenceExtractionError('REFERENCE_EXTRACTOR_UNAVAILABLE', String(error?.message ?? error))));
    });
    // 'close' waits for stderr to drain, so a failure message is never cut off.
    child.once('close', (code) => {
      if (forcedError) return;
      stdout += stdoutDecoder.end();
      stderr = (stderr + stderrDecoder.end()).slice(-8000);
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
    if (source.length === 0) {
      throw new ReferenceExtractionError('REFERENCE_FILE_EMPTY', `${name} is empty`);
    }
    if (source.length > MAX_REFERENCE_SOURCE_BYTES) {
      throw new ReferenceExtractionError('REFERENCE_FILE_TOO_LARGE', `${name} exceeds the reference-file limit`);
    }
    return source;
  }
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_REFERENCE_SOURCE_BYTES) {
      throw new ReferenceExtractionError('REFERENCE_FILE_TOO_LARGE', `${name} exceeds the reference-file limit`);
    }
    if (stat.size === 0) {
      throw new ReferenceExtractionError('REFERENCE_FILE_EMPTY', `${name} is empty`);
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
      text = boundedRawText(text, name);
      validateJsonTextSyntax(text, name);
    } else if (extension === '.html' || extension === '.htm' || extension === '.xml') {
      text = markupToText(text, name);
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
