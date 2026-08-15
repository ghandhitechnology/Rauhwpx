import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { IMAGE_REFERENCE_EXTENSIONS } from './reference-image.mjs';

const MAX_EXTRACTED_CHARS = 5_000_000;
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
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => typeof item?.str === 'string' ? item.str : '')
        .filter(Boolean)
        .join(' ');
      pages.push({ page: pageNumber, text });
    }
    return { text: pages.map((page) => page.text).join('\n\f\n'), pages };
  } catch (error) {
    const message = /password/i.test(String(error?.name ?? error?.message ?? error))
      ? `${name} is password protected`
      : `Could not extract text from ${name}: ${error?.message ?? error}`;
    throw new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', message);
  } finally {
    try { await document?.destroy(); } catch {}
  }
}

async function extractDocx(bytes, name) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ReferenceExtractionError('REFERENCE_TYPE_MISMATCH', `${name} does not have a valid DOCX signature`);
  }
  let mammoth;
  try {
    mammoth = await import('mammoth');
  } catch (error) {
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

function runRhwpExport(binary, filePath, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['export-text', filePath, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const stop = () => {
      try { child.kill('SIGTERM'); } catch {}
      const killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {}
      }, 5_000);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      stop();
      finish(() => reject(new ReferenceExtractionError('REFERENCE_EXTRACTION_TIMEOUT', 'HWP text extraction timed out')));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) {
        stop();
        finish(() => reject(new ReferenceExtractionError('REFERENCE_TEXT_TOO_LARGE', 'HWP text extraction output is too large')));
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', (error) => finish(() => reject(new ReferenceExtractionError('REFERENCE_EXTRACTOR_UNAVAILABLE', String(error?.message ?? error)))));
    // 'close' waits for stderr to drain, so a failure message is never cut off.
    child.once('close', (code) => finish(() => {
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
    }));
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

/** Extract searchable text without ever treating binary bytes as prose. */
export async function extractReferenceText({ bytes, filePath, name, mimeType, projectRoot }) {
  const extension = extensionOf(name);
  if (!SUPPORTED_REFERENCE_EXTENSIONS.includes(extension)) {
    throw new ReferenceExtractionError('REFERENCE_TYPE_UNSUPPORTED', `${name} is not a supported reference-file type`);
  }
  const source = bytes ?? await fs.readFile(filePath);
  let result;
  if (TEXT_EXTENSIONS.has(extension)) {
    let text = decodeUtf8(source, name);
    if (extension === '.json') {
      try { text = JSON.stringify(JSON.parse(text), null, 2); }
      catch { throw new ReferenceExtractionError('REFERENCE_EXTRACTION_FAILED', `${name} contains invalid JSON`); }
    } else if (extension === '.html' || extension === '.htm' || extension === '.xml') {
      text = markupToText(text);
    }
    result = { text };
  } else if (extension === '.pdf') {
    result = await extractPdf(source, name);
  } else if (extension === '.docx') {
    result = await extractDocx(source, name);
  } else if (HWP_EXTENSIONS.has(extension)) {
    result = await extractHwp(filePath, name, projectRoot);
  } else {
    throw new ReferenceExtractionError('REFERENCE_TYPE_UNSUPPORTED', `${name} is not supported`);
  }
  return {
    text: capText(result.text, name),
    pages: Array.isArray(result.pages)
      ? result.pages.map((page) => ({ page: page.page, text: String(page.text ?? '').normalize('NFKC') }))
      : null,
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
