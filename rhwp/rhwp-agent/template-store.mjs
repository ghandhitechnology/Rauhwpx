import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  recoverInterruptedFileReplacement,
  replaceFileAtomically,
} from './harness-update.mjs';
import { readFileBytesBounded } from './bounded-file.mjs';

export const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;
export const MAX_TEMPLATE_METADATA_BYTES = 2 * 1024 * 1024;
export const MAX_TEMPLATE_RECORDS = 512;
export const MAX_IN_FLIGHT_TEMPLATE_UPLOAD_BYTES = MAX_TEMPLATE_BYTES;
export const MAX_IN_FLIGHT_TEMPLATE_UPLOADS = 4;

const HWP_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const HWPX_SIGNATURE = Buffer.from([0x50, 0x4b]);
const TEMPLATE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MANAGED_BLOB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-r[1-9]\d*\.(?:hwp|hwpx)$/i;
const MANAGED_BLOB_TEMP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-r[1-9]\d*\.(?:hwp|hwpx)\.tmp-\d+-[0-9a-f-]+$/i;
const TEMPLATE_RECORD_KEYS = [
  'blobName',
  'contentHash',
  'createdAt',
  'format',
  'id',
  'name',
  'originalName',
  'pageCount',
  'revision',
  'sectionCount',
  'size',
  'updatedAt',
];

export class TemplateStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'TemplateStoreError';
  }
}

export function defaultTemplateDataRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RHWP_TEMPLATES_DIR) return path.resolve(env.RHWP_TEMPLATES_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'rhwp', 'templates');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'rhwp', 'templates');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rhwp', 'templates');
}

export function normalizeTemplateName(value) {
  const name = String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new TemplateStoreError('TEMPLATE_NAME_INVALID', 'Template names must contain 1-80 visible characters.');
  }
  return name;
}

function nameKey(value) {
  return normalizeTemplateName(value).toLowerCase();
}

function assertId(id) {
  if (!TEMPLATE_ID_RE.test(String(id ?? ''))) {
    throw new TemplateStoreError('TEMPLATE_ID_INVALID', 'Template id is invalid.');
  }
  return String(id);
}

function detectFormat(bytes, originalName, requestedFormat) {
  const extension = path.extname(String(originalName ?? '')).toLowerCase();
  const format = requestedFormat === 'hwp' || requestedFormat === 'hwpx'
    ? requestedFormat
    : (extension === '.hwp' ? 'hwp' : extension === '.hwpx' ? 'hwpx' : null);
  if (!format) throw new TemplateStoreError('TEMPLATE_TYPE_UNSUPPORTED', 'Templates must use the .hwp or .hwpx extension.');
  const signature = format === 'hwp' ? HWP_SIGNATURE : HWPX_SIGNATURE;
  if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
    throw new TemplateStoreError('TEMPLATE_TYPE_MISMATCH', `The uploaded file is not a valid ${format.toUpperCase()} container.`);
  }
  return format;
}

function safeCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
    throw new TemplateStoreError('TEMPLATE_METADATA_INVALID', `${label} must be a positive integer.`);
  }
  return count;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TemplateStoreError('TEMPLATE_METADATA_INVALID', `${label} must be a positive integer.`);
  }
  return value;
}

function normalizeOriginalName(value, fallback) {
  const candidate = String(value ?? fallback).normalize('NFKC').trim();
  const name = path.win32.basename(candidate);
  if (
    !name
    || name === '.'
    || name === '..'
    || name.length > 255
    || /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new TemplateStoreError('TEMPLATE_METADATA_INVALID', 'The original file name is invalid.');
  }
  return name;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function monotonicTimestamp(now, previous = null) {
  const wallClock = Number(now());
  if (!Number.isFinite(wallClock)) {
    throw new TemplateStoreError('TEMPLATE_METADATA_INVALID', 'The system clock cannot produce a valid template timestamp.');
  }
  const floor = previous === null
    ? Number.NEGATIVE_INFINITY
    : Math.max(Date.parse(previous.createdAt), Date.parse(previous.updatedAt));
  const date = new Date(Math.max(wallClock, floor));
  if (!Number.isFinite(date.getTime())) {
    throw new TemplateStoreError('TEMPLATE_METADATA_INVALID', 'The system clock cannot produce a valid template timestamp.');
  }
  const timestamp = date.toISOString();
  if (!isCanonicalTimestamp(timestamp)) {
    throw new TemplateStoreError('TEMPLATE_METADATA_INVALID', 'The system clock cannot produce a valid template timestamp.');
  }
  return timestamp;
}

function metadataCorrupt(message) {
  return new TemplateStoreError('TEMPLATE_STORE_CORRUPT', message);
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw metadataCorrupt('Template metadata contains a non-object record.');
  }
  const keys = Object.keys(record).sort();
  if (keys.length !== TEMPLATE_RECORD_KEYS.length || keys.some((key, index) => key !== TEMPLATE_RECORD_KEYS[index])) {
    throw metadataCorrupt('Template metadata contains an unexpected record shape.');
  }
  if (typeof record.id !== 'string' || !TEMPLATE_ID_RE.test(record.id)) {
    throw metadataCorrupt('Template metadata contains an invalid id.');
  }
  let normalizedName;
  let originalName;
  try {
    normalizedName = normalizeTemplateName(record.name);
    originalName = normalizeOriginalName(record.originalName);
  } catch {
    throw metadataCorrupt('Template metadata contains an invalid name.');
  }
  if (record.name !== normalizedName || record.originalName !== originalName) {
    throw metadataCorrupt('Template metadata contains a non-canonical name.');
  }
  if (record.format !== 'hwp' && record.format !== 'hwpx') {
    throw metadataCorrupt('Template metadata contains an invalid format.');
  }
  if (!Number.isSafeInteger(record.size) || record.size < 1 || record.size > MAX_TEMPLATE_BYTES) {
    throw metadataCorrupt('Template metadata contains an invalid file size.');
  }
  if (
    !Number.isSafeInteger(record.pageCount)
    || record.pageCount < 1
    || record.pageCount > 100_000
    || !Number.isSafeInteger(record.sectionCount)
    || record.sectionCount < 1
    || record.sectionCount > 100_000
  ) {
    throw metadataCorrupt('Template metadata contains an invalid count or revision.');
  }
  try {
    positiveSafeInteger(record.revision, 'revision');
  } catch {
    throw metadataCorrupt('Template metadata contains an invalid count or revision.');
  }
  if (typeof record.contentHash !== 'string' || !CONTENT_HASH_RE.test(record.contentHash)) {
    throw metadataCorrupt('Template metadata contains an invalid content hash.');
  }
  if (!isCanonicalTimestamp(record.createdAt) || !isCanonicalTimestamp(record.updatedAt)) {
    throw metadataCorrupt('Template metadata contains an invalid timestamp.');
  }
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    throw metadataCorrupt('Template metadata was updated before it was created.');
  }
  const expectedBlobName = `${record.id}-r${record.revision}.${record.format}`;
  if (
    typeof record.blobName !== 'string'
    || record.blobName !== expectedBlobName
    || path.basename(record.blobName) !== record.blobName
    || !MANAGED_BLOB_RE.test(record.blobName)
  ) {
    throw metadataCorrupt('Template metadata contains an invalid blob name.');
  }
  return { ...record };
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw metadataCorrupt('Template metadata must be an object.');
  }
  const stateKeys = Object.keys(state).sort();
  if (
    stateKeys.length !== 3
    || stateKeys[0] !== 'catalogRevision'
    || stateKeys[1] !== 'schemaVersion'
    || stateKeys[2] !== 'templates'
    || state.schemaVersion !== 1
    || !Number.isSafeInteger(state.catalogRevision)
    || state.catalogRevision < 1
    || !Array.isArray(state.templates)
  ) {
    throw metadataCorrupt('Template metadata has an unsupported schema.');
  }
  if (state.templates.length > MAX_TEMPLATE_RECORDS) {
    throw metadataCorrupt(`Template metadata exceeds the ${MAX_TEMPLATE_RECORDS}-record limit.`);
  }
  const records = state.templates.map(validateRecord);
  const ids = new Set();
  const names = new Set();
  const blobs = new Set();
  for (const record of records) {
    const key = nameKey(record.name);
    if (ids.has(record.id) || names.has(key) || blobs.has(record.blobName)) {
      throw metadataCorrupt('Template metadata contains duplicate ids, names, or blob names.');
    }
    ids.add(record.id);
    names.add(key);
    blobs.add(record.blobName);
  }
  return { catalogRevision: state.catalogRevision, records };
}

function publicRecord(record) {
  const { blobName: _blobName, ...metadata } = record;
  return metadata;
}

async function readBoundedRegularFile(file, maxBytes) {
  try {
    return await readFileBytesBounded(file, {
      maxBytes,
      label: 'Template storage file',
      allowEmpty: true,
    });
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof TemplateStoreError) throw error;
    if (error?.code === 'BOUNDED_FILE_TOO_LARGE') {
      throw metadataCorrupt(`Template storage file exceeds its ${maxBytes}-byte limit.`);
    }
    if (error?.code === 'BOUNDED_FILE_UNSAFE') {
      throw metadataCorrupt('Template storage file is not a plain file.');
    }
    if (error?.code === 'BOUNDED_FILE_CHANGED') {
      throw metadataCorrupt('Template storage file changed while it was being read.');
    }
    throw metadataCorrupt(`Could not safely read template storage: ${error?.message ?? error}`);
  }
}

async function readJson(file, fallback) {
  try {
    const bytes = await readBoundedRegularFile(file, MAX_TEMPLATE_METADATA_BYTES);
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (error instanceof TemplateStoreError) throw error;
    throw new TemplateStoreError('TEMPLATE_STORE_CORRUPT', `Could not read template metadata: ${error?.message ?? error}`);
  }
}

function parseContentLength(contentLength) {
  if (contentLength == null) return null;
  const text = typeof contentLength === 'string' ? contentLength.trim() : null;
  const declared = typeof contentLength === 'number'
    ? contentLength
    : (text && /^\d+$/.test(text) ? Number(text) : Number.NaN);
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_TEMPLATE_BYTES) {
    throw new TemplateStoreError('TEMPLATE_FILE_TOO_LARGE', 'Template files must be between 1 byte and 20 MB.');
  }
  return declared;
}

function sourceByteLength(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  throw new TemplateStoreError('TEMPLATE_METADATA_INVALID', 'Template bytes must be binary data.');
}

function copySourceBytes(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  return Buffer.from(value);
}

async function readRequestBytes(stream, declared) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const chunkLength = sourceByteLength(chunk);
    if (chunkLength > MAX_TEMPLATE_BYTES - size) {
      throw new TemplateStoreError('TEMPLATE_FILE_TOO_LARGE', 'Template files may not exceed 20 MB.');
    }
    if (declared !== null && chunkLength > declared - size) {
      throw new TemplateStoreError('TEMPLATE_SIZE_MISMATCH', 'Template upload exceeded Content-Length.');
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    chunks.push(bytes);
  }
  if (size === 0) throw new TemplateStoreError('TEMPLATE_FILE_EMPTY', 'Template file is empty.');
  if (declared !== null && declared !== size) {
    throw new TemplateStoreError('TEMPLATE_SIZE_MISMATCH', 'Template upload length did not match Content-Length.');
  }
  return Buffer.concat(chunks, size);
}

export class TemplateStore {
  constructor({
    rootDir = defaultTemplateDataRoot(),
    platform = process.platform,
    now = Date.now,
    maxInFlightUploadBytes = MAX_IN_FLIGHT_TEMPLATE_UPLOAD_BYTES,
    maxInFlightUploads = MAX_IN_FLIGHT_TEMPLATE_UPLOADS,
  } = {}) {
    if (!Number.isSafeInteger(maxInFlightUploadBytes) || maxInFlightUploadBytes < 1) {
      throw new TypeError('maxInFlightUploadBytes must be a positive integer');
    }
    if (!Number.isSafeInteger(maxInFlightUploads) || maxInFlightUploads < 1) {
      throw new TypeError('maxInFlightUploads must be a positive integer');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.rootDir = rootDir;
    this.blobDir = path.join(rootDir, 'files');
    this.metadataPath = path.join(rootDir, 'metadata.json');
    this.platform = platform;
    this.now = now;
    this.maxInFlightUploadBytes = maxInFlightUploadBytes;
    this.maxInFlightUploads = maxInFlightUploads;
    this.catalogRevision = 1;
    this.records = [];
    this.inFlightUploadBytes = 0;
    this.inFlightUploads = 0;
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.blobDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700).catch(() => {});
    await fs.chmod(this.blobDir, 0o700).catch(() => {});
    await recoverInterruptedFileReplacement(this.metadataPath, { platform: this.platform });
    const state = await readJson(this.metadataPath, { schemaVersion: 1, catalogRevision: 1, templates: [] });
    const validated = validateState(state);
    this.catalogRevision = validated.catalogRevision;
    this.records = validated.records;
    await this.#reconcileOrphans();
    for (const record of this.records) {
      await this.#assertBlobStat(record);
      await fs.chmod(this.#blobPath(record), 0o600).catch(() => {});
    }
    await fs.chmod(this.metadataPath, 0o600).catch(() => {});
    return this;
  }

  list() {
    return {
      revision: this.catalogRevision,
      templates: this.records.map(publicRecord).sort((a, b) => a.name.localeCompare(b.name, ['ko', 'en'])),
    };
  }

  get(id) {
    const safeId = assertId(id);
    const record = this.records.find((entry) => entry.id === safeId);
    if (!record) throw new TemplateStoreError('TEMPLATE_NOT_FOUND', 'Template was not found.');
    return publicRecord(record);
  }

  async read(id) {
    const safeId = assertId(id);
    const record = this.records.find((entry) => entry.id === safeId);
    if (!record) throw new TemplateStoreError('TEMPLATE_NOT_FOUND', 'Template was not found.');
    try {
      await this.#assertBlobStat(record);
      const bytes = await readBoundedRegularFile(this.#blobPath(record), MAX_TEMPLATE_BYTES);
      if (bytes.length !== record.size) {
        throw metadataCorrupt('Template file size does not match its metadata.');
      }
      const contentHash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
      if (contentHash !== record.contentHash) {
        throw metadataCorrupt('Template file hash does not match its metadata.');
      }
      try {
        detectFormat(bytes, record.originalName, record.format);
      } catch {
        throw metadataCorrupt('Template file signature does not match its metadata.');
      }
      return { metadata: publicRecord(record), bytes };
    } catch (error) {
      if (error?.code === 'ENOENT') throw new TemplateStoreError('TEMPLATE_BLOB_MISSING', 'Template file is missing from local storage.');
      throw error;
    }
  }

  async addStream(input) {
    const declared = parseContentLength(input.contentLength);
    const release = this.#reserveUpload(declared ?? MAX_TEMPLATE_BYTES);
    try {
      const bytes = await readRequestBytes(input.stream, declared);
      return await this.#addBuffered(input, bytes);
    } finally {
      release();
    }
  }

  async add({ name, originalName, format, pageCount, sectionCount, bytes }) {
    const length = sourceByteLength(bytes);
    this.#assertSourceLength(length);
    const release = this.#reserveUpload(length);
    try {
      const source = copySourceBytes(bytes);
      return await this.#addBuffered({ name, originalName, format, pageCount, sectionCount }, source);
    } finally {
      release();
    }
  }

  async #addBuffered({ name, originalName, format, pageCount, sectionCount }, source) {
    return this.#mutate(async () => {
      if (this.records.length >= MAX_TEMPLATE_RECORDS) {
        throw new TemplateStoreError('TEMPLATE_LIMIT_EXCEEDED', `No more than ${MAX_TEMPLATE_RECORDS} templates may be stored.`);
      }
      const normalizedName = normalizeTemplateName(name);
      this.#assertUniqueName(normalizedName);
      const detectedFormat = detectFormat(source, originalName, format);
      const safeOriginalName = normalizeOriginalName(originalName, `template.${detectedFormat}`);
      const id = crypto.randomUUID();
      const revision = 1;
      const now = monotonicTimestamp(this.now);
      const blobName = `${id}-r${revision}.${detectedFormat}`;
      const record = {
        id,
        name: normalizedName,
        originalName: safeOriginalName,
        format: detectedFormat,
        size: source.length,
        pageCount: safeCount(pageCount, 'pageCount'),
        sectionCount: safeCount(sectionCount, 'sectionCount'),
        contentHash: `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`,
        revision,
        createdAt: now,
        updatedAt: now,
        blobName,
      };
      await this.#writeBlob(blobName, source);
      try {
        await this.#commit([...this.records, record]);
      } catch (error) {
        await fs.unlink(path.join(this.blobDir, blobName)).catch(() => {});
        throw error;
      }
      return publicRecord(record);
    });
  }

  async rename(id, name) {
    return this.#mutate(async () => {
      const record = this.#record(id);
      const normalizedName = normalizeTemplateName(name);
      this.#assertUniqueName(normalizedName, record.id);
      const renamed = {
        ...record,
        name: normalizedName,
        updatedAt: monotonicTimestamp(this.now, record),
      };
      await this.#commit(this.records.map((entry) => entry === record ? renamed : entry));
      return publicRecord(renamed);
    });
  }

  async replaceStream(id, input) {
    assertId(id);
    const declared = parseContentLength(input.contentLength);
    const release = this.#reserveUpload(declared ?? MAX_TEMPLATE_BYTES);
    try {
      const bytes = await readRequestBytes(input.stream, declared);
      return await this.#replaceBuffered(id, input, bytes);
    } finally {
      release();
    }
  }

  async replace(id, { originalName, format, pageCount, sectionCount, bytes }) {
    const length = sourceByteLength(bytes);
    this.#assertSourceLength(length);
    const release = this.#reserveUpload(length);
    try {
      const source = copySourceBytes(bytes);
      return await this.#replaceBuffered(id, { originalName, format, pageCount, sectionCount }, source);
    } finally {
      release();
    }
  }

  async #replaceBuffered(id, { originalName, format, pageCount, sectionCount }, source) {
    return this.#mutate(async () => {
      const record = this.#record(id);
      const detectedFormat = detectFormat(source, originalName, format);
      const safeOriginalName = normalizeOriginalName(originalName, `template.${detectedFormat}`);
      const nextRevision = positiveSafeInteger(record.revision + 1, 'revision');
      const nextBlobName = `${record.id}-r${nextRevision}.${detectedFormat}`;
      const replacement = {
        ...record,
        originalName: safeOriginalName,
        format: detectedFormat,
        size: source.length,
        pageCount: safeCount(pageCount, 'pageCount'),
        sectionCount: safeCount(sectionCount, 'sectionCount'),
        contentHash: `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`,
        revision: nextRevision,
        updatedAt: monotonicTimestamp(this.now, record),
        blobName: nextBlobName,
      };
      await this.#writeBlob(nextBlobName, source);
      try {
        await this.#commit(this.records.map((entry) => entry === record ? replacement : entry));
      } catch (error) {
        await fs.unlink(path.join(this.blobDir, nextBlobName)).catch(() => {});
        throw error;
      }
      await fs.unlink(path.join(this.blobDir, record.blobName)).catch(() => {});
      return publicRecord(replacement);
    });
  }

  async delete(id) {
    return this.#mutate(async () => {
      const record = this.#record(id);
      await this.#commit(this.records.filter((entry) => entry !== record));
      await fs.unlink(this.#blobPath(record)).catch(() => {});
      return publicRecord(record);
    });
  }

  #assertSourceLength(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TEMPLATE_BYTES) {
      throw new TemplateStoreError('TEMPLATE_FILE_TOO_LARGE', 'Template files must be between 1 byte and 20 MB.');
    }
    if (length === 0) {
      throw new TemplateStoreError('TEMPLATE_FILE_EMPTY', 'Template file is empty.');
    }
  }

  #reserveUpload(bytes) {
    if (
      this.inFlightUploads >= this.maxInFlightUploads
      || bytes > this.maxInFlightUploadBytes - this.inFlightUploadBytes
    ) {
      throw new TemplateStoreError(
        'TEMPLATE_UPLOAD_BUSY',
        'Too many template upload bytes are already buffered. Wait for an active upload to finish.',
      );
    }
    this.inFlightUploads += 1;
    this.inFlightUploadBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlightUploads -= 1;
      this.inFlightUploadBytes -= bytes;
    };
  }

  #record(id) {
    const safeId = assertId(id);
    const record = this.records.find((entry) => entry.id === safeId);
    if (!record) throw new TemplateStoreError('TEMPLATE_NOT_FOUND', 'Template was not found.');
    return record;
  }

  #assertUniqueName(name, exceptId = null) {
    const key = nameKey(name);
    if (this.records.some((entry) => entry.id !== exceptId && nameKey(entry.name) === key)) {
      throw new TemplateStoreError('TEMPLATE_NAME_CONFLICT', `A template named "${name}" already exists.`);
    }
  }

  #blobPath(record) {
    const expected = `${record.id}-r${record.revision}.${record.format}`;
    if (
      record.blobName !== expected
      || path.basename(record.blobName) !== record.blobName
      || !MANAGED_BLOB_RE.test(record.blobName)
    ) {
      throw metadataCorrupt('Template metadata contains an invalid blob path.');
    }
    return path.join(this.blobDir, record.blobName);
  }

  async #assertBlobStat(record) {
    let stat;
    try {
      stat = await fs.lstat(this.#blobPath(record));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new TemplateStoreError('TEMPLATE_BLOB_MISSING', 'Template file is missing from local storage.');
      }
      throw error;
    }
    if (!stat.isFile()) {
      throw metadataCorrupt('Template blob is not a regular file.');
    }
    if (!Number.isSafeInteger(stat.size) || stat.size !== record.size || stat.size > MAX_TEMPLATE_BYTES) {
      throw metadataCorrupt('Template file size does not match its metadata.');
    }
  }

  async #reconcileOrphans() {
    const referenced = new Set(this.records.map((record) => record.blobName));
    const directory = await fs.opendir(this.blobDir);
    for await (const entry of directory) {
      const isOrphanBlob = MANAGED_BLOB_RE.test(entry.name) && !referenced.has(entry.name);
      if (!isOrphanBlob && !MANAGED_BLOB_TEMP_RE.test(entry.name)) continue;
      try {
        await fs.rm(path.join(this.blobDir, entry.name), { force: true });
      } catch (error) {
        throw metadataCorrupt(`Could not remove orphaned template blob: ${error?.message ?? error}`);
      }
    }

    const root = await fs.opendir(this.rootDir);
    for await (const entry of root) {
      if (!/^metadata\.json\.tmp-\d+-[0-9a-f-]+$/i.test(entry.name)) continue;
      try {
        await fs.rm(path.join(this.rootDir, entry.name), { force: true });
      } catch (error) {
        throw metadataCorrupt(`Could not remove orphaned template metadata: ${error?.message ?? error}`);
      }
    }
  }

  async #writeBlob(blobName, bytes) {
    if (!MANAGED_BLOB_RE.test(blobName) || path.basename(blobName) !== blobName) {
      throw metadataCorrupt('Refusing to write an invalid template blob path.');
    }
    const destination = path.join(this.blobDir, blobName);
    const temp = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, destination);
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
    }
  }

  async #commit(nextRecords) {
    if (nextRecords.length > MAX_TEMPLATE_RECORDS) {
      throw new TemplateStoreError('TEMPLATE_LIMIT_EXCEEDED', `No more than ${MAX_TEMPLATE_RECORDS} templates may be stored.`);
    }
    const nextRevision = positiveSafeInteger(this.catalogRevision + 1, 'catalogRevision');
    const temp = `${this.metadataPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const state = { schemaVersion: 1, catalogRevision: nextRevision, templates: nextRecords };
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_TEMPLATE_METADATA_BYTES) {
      throw new TemplateStoreError(
        'TEMPLATE_LIMIT_EXCEEDED',
        `Template metadata exceeds the ${MAX_TEMPLATE_METADATA_BYTES}-byte limit.`,
      );
    }
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await replaceFileAtomically(temp, this.metadataPath, { platform: this.platform });
      this.catalogRevision = nextRevision;
      this.records = nextRecords;
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
    }
  }

  #mutate(operation) {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
