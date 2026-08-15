import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;

const HWP_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const HWPX_SIGNATURE = Buffer.from([0x50, 0x4b]);
const TEMPLATE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function publicRecord(record) {
  const { blobName: _blobName, ...metadata } = record;
  return metadata;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new TemplateStoreError('TEMPLATE_STORE_CORRUPT', `Could not read template metadata: ${error?.message ?? error}`);
  }
}

async function readRequestBytes(stream, contentLength) {
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && (declared < 1 || declared > MAX_TEMPLATE_BYTES)) {
    throw new TemplateStoreError('TEMPLATE_FILE_TOO_LARGE', 'Template files must be between 1 byte and 20 MB.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_TEMPLATE_BYTES) throw new TemplateStoreError('TEMPLATE_FILE_TOO_LARGE', 'Template files may not exceed 20 MB.');
    chunks.push(bytes);
  }
  if (size === 0) throw new TemplateStoreError('TEMPLATE_FILE_EMPTY', 'Template file is empty.');
  if (Number.isFinite(declared) && declared !== size) {
    throw new TemplateStoreError('TEMPLATE_SIZE_MISMATCH', 'Template upload length did not match Content-Length.');
  }
  return Buffer.concat(chunks, size);
}

export class TemplateStore {
  constructor({ rootDir = defaultTemplateDataRoot() } = {}) {
    this.rootDir = rootDir;
    this.blobDir = path.join(rootDir, 'files');
    this.metadataPath = path.join(rootDir, 'metadata.json');
    this.catalogRevision = 1;
    this.records = [];
  }

  async init() {
    await fs.mkdir(this.blobDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700).catch(() => {});
    await fs.chmod(this.blobDir, 0o700).catch(() => {});
    const state = await readJson(this.metadataPath, { schemaVersion: 1, catalogRevision: 1, templates: [] });
    if (state?.schemaVersion !== 1 || !Array.isArray(state.templates)) {
      throw new TemplateStoreError('TEMPLATE_STORE_CORRUPT', 'Template metadata has an unsupported schema.');
    }
    this.catalogRevision = Number.isSafeInteger(state.catalogRevision) ? state.catalogRevision : 1;
    this.records = state.templates.filter((record) => record && TEMPLATE_ID_RE.test(record.id) && typeof record.blobName === 'string');
    await fs.chmod(this.metadataPath, 0o600).catch(() => {});
    await Promise.all(this.records.map((record) => fs.chmod(path.join(this.blobDir, record.blobName), 0o600).catch(() => {})));
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
      return { metadata: publicRecord(record), bytes: await fs.readFile(path.join(this.blobDir, record.blobName)) };
    } catch (error) {
      if (error?.code === 'ENOENT') throw new TemplateStoreError('TEMPLATE_BLOB_MISSING', 'Template file is missing from local storage.');
      throw error;
    }
  }

  async addStream(input) {
    const bytes = await readRequestBytes(input.stream, input.contentLength);
    return this.add({ ...input, bytes });
  }

  async add({ name, originalName, format, pageCount, sectionCount, bytes }) {
    const normalizedName = normalizeTemplateName(name);
    this.#assertUniqueName(normalizedName);
    const source = Buffer.from(bytes);
    if (source.length < 1 || source.length > MAX_TEMPLATE_BYTES) {
      throw new TemplateStoreError('TEMPLATE_FILE_TOO_LARGE', 'Template files must be between 1 byte and 20 MB.');
    }
    const detectedFormat = detectFormat(source, originalName, format);
    const id = crypto.randomUUID();
    const revision = 1;
    const now = new Date().toISOString();
    const blobName = `${id}-r${revision}.${detectedFormat}`;
    const record = {
      id,
      name: normalizedName,
      originalName: path.basename(String(originalName ?? `template.${detectedFormat}`)),
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
    this.records.push(record);
    try {
      await this.#commit();
    } catch (error) {
      this.records = this.records.filter((entry) => entry !== record);
      await fs.unlink(path.join(this.blobDir, blobName)).catch(() => {});
      throw error;
    }
    return publicRecord(record);
  }

  async rename(id, name) {
    const record = this.#record(id);
    const normalizedName = normalizeTemplateName(name);
    this.#assertUniqueName(normalizedName, record.id);
    const previous = { name: record.name, updatedAt: record.updatedAt };
    record.name = normalizedName;
    record.updatedAt = new Date().toISOString();
    try {
      await this.#commit();
    } catch (error) {
      Object.assign(record, previous);
      throw error;
    }
    return publicRecord(record);
  }

  async replaceStream(id, input) {
    const bytes = await readRequestBytes(input.stream, input.contentLength);
    return this.replace(id, { ...input, bytes });
  }

  async replace(id, { originalName, format, pageCount, sectionCount, bytes }) {
    const record = this.#record(id);
    const source = Buffer.from(bytes);
    if (source.length < 1 || source.length > MAX_TEMPLATE_BYTES) {
      throw new TemplateStoreError('TEMPLATE_FILE_TOO_LARGE', 'Template files must be between 1 byte and 20 MB.');
    }
    const detectedFormat = detectFormat(source, originalName, format);
    const nextRevision = record.revision + 1;
    const nextBlobName = `${record.id}-r${nextRevision}.${detectedFormat}`;
    const previous = { ...record };
    await this.#writeBlob(nextBlobName, source);
    Object.assign(record, {
      originalName: path.basename(String(originalName ?? `template.${detectedFormat}`)),
      format: detectedFormat,
      size: source.length,
      pageCount: safeCount(pageCount, 'pageCount'),
      sectionCount: safeCount(sectionCount, 'sectionCount'),
      contentHash: `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`,
      revision: nextRevision,
      updatedAt: new Date().toISOString(),
      blobName: nextBlobName,
    });
    try {
      await this.#commit();
      await fs.unlink(path.join(this.blobDir, previous.blobName)).catch(() => {});
    } catch (error) {
      Object.assign(record, previous);
      await fs.unlink(path.join(this.blobDir, nextBlobName)).catch(() => {});
      throw error;
    }
    return publicRecord(record);
  }

  async delete(id) {
    const record = this.#record(id);
    this.records = this.records.filter((entry) => entry !== record);
    try {
      await this.#commit();
      await fs.unlink(path.join(this.blobDir, record.blobName)).catch(() => {});
    } catch (error) {
      this.records.push(record);
      throw error;
    }
    return publicRecord(record);
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
      throw new TemplateStoreError('TEMPLATE_NAME_CONFLICT', `A template named “${name}” already exists.`);
    }
  }

  async #writeBlob(blobName, bytes) {
    const destination = path.join(this.blobDir, blobName);
    const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, destination);
  }

  async #commit() {
    this.catalogRevision += 1;
    const temp = `${this.metadataPath}.tmp-${process.pid}-${Date.now()}`;
    const state = { schemaVersion: 1, catalogRevision: this.catalogRevision, templates: this.records };
    try {
      await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temp, this.metadataPath);
    } catch (error) {
      this.catalogRevision -= 1;
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }
}
