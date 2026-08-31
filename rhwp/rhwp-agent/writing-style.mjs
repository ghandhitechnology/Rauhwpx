import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
  recoverInterruptedFileReplacement,
  removeFileAndReplacementBackup,
  replaceFileAtomically,
} from './harness-update.mjs';
import { readFileBytesBounded, readUtf8FileBounded } from './bounded-file.mjs';

const PROFILE_FILE = 'style.md';
const METADATA_FILE = 'metadata.json';
const STRUCTURED_FILE = 'profile.json';
const ADDITIONAL_INSTRUCTION_FILE = 'additional-instruction.md';
const SOURCES_DIR = 'sources';
const SOURCES_MANIFEST_FILE = 'sources.json';
const COMMIT_JOURNAL_FILE = 'commit-journal.json';
const MAX_ADDITIONAL_INSTRUCTION_CHARS = 4_000;
const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_STRUCTURED_PROFILE_BYTES = 512 * 1024;
const MAX_ADDITIONAL_INSTRUCTION_BYTES = 16 * 1024;
const MAX_SOURCES_MANIFEST_BYTES = 128 * 1024;
const MAX_TRANSACTION_JOURNAL_BYTES = 64 * 1024;
const MAX_SOURCE_FILES = 20;
const MAX_SOURCE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 50 * 1024 * 1024;

export function defaultWritingStyleRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RHWP_WRITING_STYLE_DIR) return path.resolve(env.RHWP_WRITING_STYLE_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'rhwp', 'writing-style');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'rhwp', 'writing-style');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rhwp', 'writing-style');
}

async function readJson(file, fallback, { maxBytes, label, platform }) {
  try {
    return JSON.parse(await readUtf8FileBounded(file, { maxBytes, label, platform }));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function readSourcesManifest(file, platform = process.platform) {
  let text;
  try {
    text = await readUtf8FileBounded(file, {
      maxBytes: MAX_SOURCES_MANIFEST_BYTES,
      label: 'Writing-style source manifest',
      platform,
    });
  }
  catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, files: [] };
    throw corruptSources(error?.message ?? error);
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files)) throw new Error('files must be an array');
    if (parsed.files.length > MAX_SOURCE_FILES) throw new Error(`more than ${MAX_SOURCE_FILES} sources are listed`);
    const ids = new Set();
    const storedNames = new Set();
    let declaredBytes = 0;
    for (const entry of parsed.files) {
      if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9]{64}$/.test(entry.id)
        || entry.sha256 !== entry.id
        || typeof entry.storedName !== 'string' || path.basename(entry.storedName) !== entry.storedName
        || !/^\d{2}-[a-f0-9]{64}(?:\.[a-z0-9]{1,11})?$/.test(entry.storedName)
        || typeof entry.name !== 'string' || entry.name.length < 1 || entry.name.length > 512
        || typeof entry.type !== 'string' || entry.type.length < 1 || entry.type.length > 256
        || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_SOURCE_FILE_BYTES
        || typeof entry.addedAt !== 'string' || entry.addedAt.length > 64
        || ids.has(entry.id) || storedNames.has(entry.storedName)) {
        throw new Error('a source entry is invalid');
      }
      ids.add(entry.id);
      storedNames.add(entry.storedName);
      declaredBytes += entry.size;
      if (declaredBytes > MAX_SOURCE_TOTAL_BYTES) throw new Error('source bytes exceed the corpus limit');
    }
    return parsed;
  } catch (error) {
    const wrapped = new Error(`Saved writing samples are unreadable: ${error?.message ?? error}`);
    wrapped.code = 'STYLE_SOURCES_CORRUPT';
    throw wrapped;
  }
}

function decodedBase64Size(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function sourceBytes(file) {
  if (Buffer.isBuffer(file?.bytes)) {
    if (file.bytes.length < 1 || file.bytes.length > MAX_SOURCE_FILE_BYTES) {
      throw sourceLimit('A writing sample exceeds its file-size limit.');
    }
    return file.bytes;
  }
  const size = decodedBase64Size(file?.content);
  if (size === null) throw corruptSources('a source has invalid file data');
  if (size < 1 || size > MAX_SOURCE_FILE_BYTES) throw corruptSources('a source exceeds its file-size limit');
  return Buffer.from(file.content, 'base64');
}

function corruptSources(message) {
  const error = new Error(`Saved writing samples are unreadable: ${message}`);
  error.code = 'STYLE_SOURCES_CORRUPT';
  return error;
}

function sourceLimit(message) {
  const error = new Error(message);
  error.code = 'STYLE_SOURCES_LIMIT';
  return error;
}

function normalizedSourceMetadata(file, index) {
  const fallbackName = `sample-${index + 1}`;
  const name = typeof file?.name === 'string' && file.name ? file.name : fallbackName;
  const type = typeof file?.type === 'string' && file.type
    ? file.type
    : 'application/octet-stream';
  const addedAt = typeof file?.addedAt === 'string' ? file.addedAt : new Date().toISOString();
  if (name.length > 512) throw sourceLimit('A writing sample name exceeds 512 characters.');
  if (type.length > 256) throw sourceLimit('A writing sample media type exceeds 256 characters.');
  if (addedAt.length > 64) throw sourceLimit('A writing sample timestamp exceeds 64 characters.');
  return { name, type, addedAt };
}

const TRANSACTION_TARGETS = new Set([
  PROFILE_FILE, METADATA_FILE, STRUCTURED_FILE, SOURCES_DIR, SOURCES_MANIFEST_FILE,
]);

export function assertWritingStyleAppendCompatible(status, { language, baseRevision = null } = {}) {
  if (language !== 'ko' && language !== 'en') {
    const error = new Error('Choose Korean or English.');
    error.code = 'INVALID_LANGUAGE';
    throw error;
  }
  if (status?.active && status.language !== language) {
    const error = new Error(`Saved samples are calibrated as ${status.language}; choose the same language before appending.`);
    error.code = 'CALIBRATION_LANGUAGE_MISMATCH';
    throw error;
  }
  if (typeof baseRevision === 'string' && baseRevision && baseRevision !== status?.updatedAt) {
    const error = new Error('The writing-style profile changed after this calibration screen was opened. Refresh and try again.');
    error.code = 'STYLE_REVISION_CONFLICT';
    throw error;
  }
}

export class WritingStyleStore {
  constructor({ root = defaultWritingStyleRoot(), platform = process.platform } = {}) {
    this.root = root;
    this.platform = platform;
    this.profilePath = path.join(root, PROFILE_FILE);
    this.metadataPath = path.join(root, METADATA_FILE);
    this.structuredPath = path.join(root, STRUCTURED_FILE);
    this.additionalInstructionPath = path.join(root, ADDITIONAL_INSTRUCTION_FILE);
    this.sourcesPath = path.join(root, SOURCES_DIR);
    this.sourcesManifestPath = path.join(root, SOURCES_MANIFEST_FILE);
    this.commitJournalPath = path.join(root, COMMIT_JOURNAL_FILE);
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    await recoverInterruptedFileReplacement(this.additionalInstructionPath, {
      platform: this.platform,
    });
    await this.recoverInterruptedCommit();
    return this;
  }

  async recoverInterruptedCommit() {
    let journal = null;
    try {
      journal = JSON.parse(await readUtf8FileBounded(this.commitJournalPath, {
        maxBytes: MAX_TRANSACTION_JOURNAL_BYTES,
        label: 'Writing-style transaction journal',
        platform: this.platform,
      }));
    }
    catch (error) {
      if (error?.code === 'ENOENT') journal = null;
      else if (error instanceof SyntaxError) {
        const wrapped = new Error('Writing-style transaction journal is corrupt.');
        wrapped.code = 'STYLE_TRANSACTION_CORRUPT';
        throw wrapped;
      } else throw error;
    }
    if (journal) {
      const id = typeof journal.id === 'string' && /^[a-zA-Z0-9-]+$/.test(journal.id) ? journal.id : null;
      const artifacts = Array.isArray(journal.artifacts) ? journal.artifacts : null;
      if (!id || !artifacts || artifacts.some((entry) => (
        !entry || !TRANSACTION_TARGETS.has(entry.target)
        || typeof entry.hadOriginal !== 'boolean'
        || (entry.staged !== null && entry.staged !== `${entry.target}.tmp-${id}`)
      ))) {
        const error = new Error('Writing-style transaction journal is corrupt.');
        error.code = 'STYLE_TRANSACTION_CORRUPT';
        throw error;
      }
      for (const entry of artifacts) {
        const target = path.join(this.root, entry.target);
        const backup = `${target}.old-${id}`;
        try {
          await fs.lstat(backup);
          await fs.rm(target, { recursive: true, force: true });
          await fs.rename(backup, target);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (!entry.hadOriginal) await fs.rm(target, { recursive: true, force: true });
        if (entry.staged) await fs.rm(path.join(this.root, entry.staged), { recursive: true, force: true });
      }
      await fs.rm(this.commitJournalPath, { force: true });
    }

    // Recover transactions from builds predating the journal, then remove
    // abandoned staging files. Scope is limited to known writing-style targets.
    const entries = await fs.readdir(this.root).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const name of entries) {
      const oldMatch = name.match(/^(style\.md|metadata\.json|profile\.json|sources|sources\.json)\.old-[a-zA-Z0-9-]+$/);
      if (oldMatch) {
        const backup = path.join(this.root, name);
        const target = path.join(this.root, oldMatch[1]);
        try { await fs.lstat(target); await fs.rm(backup, { recursive: true, force: true }); }
        catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          await fs.rename(backup, target);
        }
        continue;
      }
      if (/^(style\.md|metadata\.json|profile\.json|sources|sources\.json|commit-journal\.json)\.tmp-[a-zA-Z0-9-]+$/.test(name)) {
        await fs.rm(path.join(this.root, name), { recursive: true, force: true });
      }
    }
  }

  async status() {
    try {
      const [markdown, metadata, additionalInstruction, sourceDocuments] = await Promise.all([
        readUtf8FileBounded(this.profilePath, {
          maxBytes: MAX_PROFILE_BYTES,
          label: 'Writing-style profile',
          platform: this.platform,
        }),
        readJson(this.metadataPath, {}, {
          maxBytes: MAX_METADATA_BYTES,
          label: 'Writing-style metadata',
          platform: this.platform,
        }),
        readUtf8FileBounded(this.additionalInstructionPath, {
          maxBytes: MAX_ADDITIONAL_INSTRUCTION_BYTES,
          label: 'Writing-style additional instruction',
          platform: this.platform,
        }).catch((error) => {
          if (error?.code === 'ENOENT') return '';
          throw error;
        }),
        this.sourceDocuments(),
      ]);
      return {
        active: Boolean(markdown.trim()),
        language: metadata.language === 'en' ? 'en' : 'ko',
        updatedAt: typeof metadata.updatedAt === 'string' ? metadata.updatedAt : null,
        sourceCount: Number.isFinite(metadata.sourceCount) ? metadata.sourceCount : 0,
        pageEstimate: Number.isFinite(metadata.pageEstimate) ? metadata.pageEstimate : 0,
        summary: typeof metadata.summary === 'string' ? metadata.summary : '',
        agent: ['codex', 'claude', 'pi', 'grok', 'cursor'].includes(metadata.agent) ? metadata.agent : null,
        model: typeof metadata.model === 'string' ? metadata.model : null,
        additionalInstruction: additionalInstruction.trim(),
        sourceDocuments,
        sources: sourceDocuments,
        savedSourceCount: sourceDocuments.length,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          active: false,
          language: 'ko',
          updatedAt: null,
          sourceCount: 0,
          pageEstimate: 0,
          summary: '',
          agent: null,
          model: null,
          additionalInstruction: '',
          sourceDocuments: [],
          sources: [],
          savedSourceCount: 0,
        };
      }
      throw error;
    }
  }

  /** 정량 계층. 없으면 null — 구버전 프로필이거나 원고를 추출하지 못한 경우다. */
  async profile() {
    const value = await readJson(this.structuredPath, null, {
      maxBytes: MAX_STRUCTURED_PROFILE_BYTES,
      label: 'Structured writing-style profile',
      platform: this.platform,
    });
    return value && typeof value === 'object' ? value : null;
  }

  /** Persisted sample metadata is safe to expose in status; sample contents are not. */
  async sourceDocuments() {
    const manifest = await readSourcesManifest(this.sourcesManifestPath, this.platform);
    if (!Array.isArray(manifest?.files)) return [];
    const documents = [];
    let totalBytes = 0;
    for (const entry of manifest.files) {
      const blobPath = path.join(this.sourcesPath, entry.storedName);
      let stat;
      try { stat = await fs.lstat(blobPath); }
      catch (error) {
        if (error?.code === 'ENOENT') throw corruptSources(`source file is missing: ${entry.name || entry.id}`);
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw corruptSources(`source file is invalid: ${entry.name || entry.id}`);
      if (stat.size !== entry.size || stat.size > MAX_SOURCE_FILE_BYTES) {
        throw corruptSources(`source file size changed: ${entry.name || entry.id}`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_SOURCE_TOTAL_BYTES) throw corruptSources('source bytes exceed the corpus limit');
      documents.push({
        id: entry.id,
        name: String(entry.name || 'sample'),
        type: String(entry.type || 'application/octet-stream'),
        size: Math.max(0, Math.round(Number(entry.size) || 0)),
        addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
      });
    }
    return documents;
  }

  /** Read the private originals only for an explicit additive recalibration. */
  async sources() {
    const manifest = await readSourcesManifest(this.sourcesManifestPath, this.platform);
    if (!Array.isArray(manifest?.files)) return [];
    const loaded = [];
    let totalBytes = 0;
    for (const entry of manifest.files) {
      try {
        const bytes = await readFileBytesBounded(path.join(this.sourcesPath, entry.storedName), {
          maxBytes: MAX_SOURCE_FILE_BYTES,
          label: `Writing-style source ${entry.name}`,
          platform: this.platform,
        });
        totalBytes += bytes.length;
        if (totalBytes > MAX_SOURCE_TOTAL_BYTES) throw corruptSources('source bytes exceed the corpus limit');
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (bytes.length !== entry.size || digest !== entry.id) {
          throw corruptSources(`source file changed: ${entry.name || entry.id}`);
        }
        loaded.push({
          name: String(entry.name || 'sample'),
          type: String(entry.type || 'application/octet-stream'),
          size: bytes.length,
          addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
          bytes,
        });
      } catch (error) {
        if (error?.code === 'ENOENT') throw corruptSources(`source file is missing: ${entry.name || entry.id}`);
        throw error;
      }
    }
    return loaded;
  }

  /** Combine saved originals with new uploads, de-duplicated by their bytes. */
  async calibrationSources(files, { append = false } = {}) {
    const incoming = Array.isArray(files) ? files : [];
    const candidates = append ? [...await this.sources(), ...incoming] : incoming;
    const seen = new Set();
    const normalized = [];
    let totalBytes = 0;
    for (const [index, file] of candidates.entries()) {
      const existingBytes = Buffer.isBuffer(file?.bytes) ? file.bytes : null;
      const size = existingBytes?.length ?? decodedBase64Size(file?.content);
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SOURCE_FILE_BYTES) {
        throw sourceLimit('A writing sample exceeds its file-size limit or has invalid data.');
      }
      const digest = crypto.createHash('sha256')
        .update(existingBytes ?? file.content, existingBytes ? undefined : 'base64')
        .digest('hex');
      if (seen.has(digest)) continue;
      seen.add(digest);
      if (normalized.length >= MAX_SOURCE_FILES || totalBytes + size > MAX_SOURCE_TOTAL_BYTES) {
        throw sourceLimit(`Writing samples must contain at most ${MAX_SOURCE_FILES} files and ${MAX_SOURCE_TOTAL_BYTES / (1024 * 1024)} MB.`);
      }
      const bytes = existingBytes ?? Buffer.from(file.content, 'base64');
      totalBytes += bytes.length;
      const { content: _content, ...rest } = file ?? {};
      normalized.push({
        ...rest,
        ...normalizedSourceMetadata(file, index),
        bytes,
        size: bytes.length,
      });
    }
    return normalized;
  }

  async stageSources(files, transactionId) {
    const entries = [];
    const staging = `${this.sourcesPath}.tmp-${transactionId}`;
    const manifestTemp = `${this.sourcesManifestPath}.tmp-${transactionId}`;
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const values = Array.isArray(files) ? files : [];
      if (values.length > MAX_SOURCE_FILES) throw sourceLimit(`Writing samples exceed ${MAX_SOURCE_FILES} files.`);
      let totalBytes = 0;
      for (const [index, file] of values.entries()) {
        const bytes = sourceBytes(file);
        const metadata = normalizedSourceMetadata(file, index);
        totalBytes += bytes.length;
        if (totalBytes > MAX_SOURCE_TOTAL_BYTES) throw sourceLimit('Writing samples exceed 50 MB in total.');
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const extension = path.extname(String(file.name || '')).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
        const storedName = `${String(index + 1).padStart(2, '0')}-${sha256}${extension}`;
        await fs.writeFile(path.join(staging, storedName), bytes, { mode: 0o600 });
        entries.push({
          id: sha256,
          sha256,
          storedName,
          name: metadata.name,
          type: metadata.type,
          size: bytes.length,
          addedAt: metadata.addedAt,
        });
      }
      await fs.writeFile(manifestTemp, `${JSON.stringify({ version: 1, files: entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return { staging, manifestTemp };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      await fs.rm(manifestTemp, { force: true });
      throw error;
    }
  }

  async commitArtifacts(artifacts, transactionId) {
    const committed = [];
    const journalTemp = `${this.commitJournalPath}.tmp-${transactionId}`;
    const originalStates = await Promise.all(artifacts.map(async (artifact) => {
      try { await fs.lstat(artifact.target); return true; }
      catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    }));
    const journal = {
      version: 1,
      id: transactionId,
      artifacts: artifacts.map((artifact, index) => ({
        target: path.basename(artifact.target),
        staged: artifact.staged ? path.basename(artifact.staged) : null,
        hadOriginal: originalStates[index],
      })),
    };
    await fs.writeFile(journalTemp, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(journalTemp, this.commitJournalPath);
    try {
      for (const artifact of artifacts) {
        const backup = `${artifact.target}.old-${transactionId}`;
        let hadOriginal = true;
        try { await fs.rename(artifact.target, backup); }
        catch (error) {
          if (error?.code === 'ENOENT') hadOriginal = false;
          else throw error;
        }
        try {
          if (artifact.staged) await fs.rename(artifact.staged, artifact.target);
          committed.push({ ...artifact, backup, hadOriginal });
        } catch (error) {
          if (hadOriginal) await fs.rename(backup, artifact.target).catch(() => {});
          throw error;
        }
      }
    } catch (error) {
      try {
        await this.recoverInterruptedCommit();
      } catch (recoveryError) {
        const wrapped = new Error(`Writing-style save failed and recovery could not finish: ${recoveryError?.message ?? recoveryError}`);
        wrapped.code = 'STYLE_TRANSACTION_RECOVERY_FAILED';
        wrapped.cause = error;
        throw wrapped;
      }
      throw error;
    }
    // Removing the journal commits the transaction. Backup cleanup can then be
    // retried opportunistically without making a completed save look failed.
    await fs.rm(this.commitJournalPath, { force: true });
    await Promise.all(committed.map((artifact) => fs.rm(artifact.backup, { recursive: true, force: true }).catch(() => {})));
  }

  async save(profile, options = {}) {
    return this.#mutate(() => this._save(profile, options));
  }

  async _save({ markdown, language, sourceCount, pageEstimate, summary, profile = null, agent = null, model = null }, { sources } = {}) {
    if (typeof markdown !== 'string' || markdown.trim().length < 200) {
      throw new Error('The generated style guide is incomplete.');
    }
    if (Buffer.byteLength(markdown, 'utf8') > 256 * 1024) {
      throw new Error('The generated style guide is too large.');
    }
    const updatedAt = new Date().toISOString();
    const transactionId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const metadata = {
      language: language === 'en' ? 'en' : 'ko',
      updatedAt,
      sourceCount: Math.max(0, Math.round(Number(sourceCount) || 0)),
      pageEstimate: Math.max(0, Math.round(Number(pageEstimate) || 0)),
      summary: String(summary || '').slice(0, 500),
      agent: ['codex', 'claude', 'pi', 'grok', 'cursor'].includes(agent) ? agent : null,
      model: typeof model === 'string' && model.trim() ? model.trim().slice(0, 200) : null,
    };
    const profileTemp = `${this.profilePath}.tmp-${transactionId}`;
    const metadataTemp = `${this.metadataPath}.tmp-${transactionId}`;
    const artifacts = [
      { target: this.profilePath, staged: profileTemp },
      { target: this.metadataPath, staged: metadataTemp },
    ];
    try {
      await fs.writeFile(profileTemp, `${markdown.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.writeFile(metadataTemp, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      if (profile && typeof profile === 'object') {
        const structuredTemp = `${this.structuredPath}.tmp-${transactionId}`;
        artifacts.push({ target: this.structuredPath, staged: structuredTemp });
        await fs.writeFile(structuredTemp, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      } else {
        // 새 프로필에 정량 계층이 없으면 이전 캘리브레이션의 수치를 남겨 두지 않는다.
        artifacts.push({ target: this.structuredPath, staged: null });
      }
      if (Array.isArray(sources)) {
        const stagedSources = await this.stageSources(sources, transactionId);
        artifacts.push(
          { target: this.sourcesPath, staged: stagedSources.staging },
          { target: this.sourcesManifestPath, staged: stagedSources.manifestTemp },
        );
      }
      await this.commitArtifacts(artifacts, transactionId);
    } catch (error) {
      await Promise.all(artifacts.flatMap((artifact) => artifact.staged
        ? [fs.rm(artifact.staged, { recursive: true, force: true }).catch(() => {})]
        : []));
      throw error;
    }
    return this.status();
  }

  async setAdditionalInstruction(value) {
    return this.#mutate(() => this._setAdditionalInstruction(value));
  }

  async _setAdditionalInstruction(value) {
    const status = await this.status();
    if (!status.active) throw new Error('Calibrate a writing style before adding a tone instruction.');
    const instruction = String(value ?? '').trim();
    if (instruction.length > MAX_ADDITIONAL_INSTRUCTION_CHARS) {
      throw new Error(`The additional instruction must be ${MAX_ADDITIONAL_INSTRUCTION_CHARS} characters or fewer.`);
    }
    if (!instruction) {
      await removeFileAndReplacementBackup(this.additionalInstructionPath, {
        platform: this.platform,
      });
      return this.status();
    }
    const temp = `${this.additionalInstructionPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temp, `${instruction}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await replaceFileAtomically(temp, this.additionalInstructionPath, {
        platform: this.platform,
      });
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
    return this.status();
  }

  #mutate(operation) {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async promptBlock() {
    try {
      const [markdown, additionalInstruction] = await Promise.all([
        readUtf8FileBounded(this.profilePath, {
          maxBytes: MAX_PROFILE_BYTES,
          label: 'Writing-style profile',
          platform: this.platform,
        }),
        readUtf8FileBounded(this.additionalInstructionPath, {
          maxBytes: MAX_ADDITIONAL_INSTRUCTION_BYTES,
          label: 'Writing-style additional instruction',
          platform: this.platform,
        }).catch((error) => {
          if (error?.code === 'ENOENT') return '';
          throw error;
        }),
      ]);
      if (!markdown.trim()) return '';
      const instructionBlock = additionalInstruction.trim()
        ? `\n\n<personal_writing_instruction>\nApply this user-authored instruction in addition to the measured profile. It may refine tone and delivery, but it follows the same precedence and factual boundaries as the profile.\n\n${additionalInstruction.trim()}\n</personal_writing_instruction>`
        : '';
      return `<personal_writing_style>
This is a portrait of how the user writes, drawn from documents they confirmed they wrote. It is a person to inhabit, not a specification to satisfy. If you assemble a sentence to hit a bullet or a measured number, you have already lost the voice.

Write as they would write — with their temperament, their unevenness, their way of caring about a sentence. Draft in that voice from the first line. Do not write generic "good" prose and then dress it in their habits.

How to read it: the portrait is the authority. Axis notes name habits that carry that portrait; inhabit them, do not execute them as a checklist. Measured numbers are a fingerprint you glance at after a paragraph. If every sentence sat at one length and theirs do not, you drifted — rewrite the paragraph as them. Never pad or trim tokens to hit a median.

Do not sand this voice into polished AI prose, and do not replace it with generic anti-AI writing (punchy fragments, numbers-first, zero connectives) unless that is actually them. If they are blunt, stay blunt. If they leave a seam, leave it. If they repeat a word, repeat it. Generic polish is the failure mode.

Precedence: what the open document already does comes first, the genre and recipient come second, this portrait third. It never overrides facts, quoted wording, legal or official phrasing, accessibility, or a formality level the user asked for. Do not reuse distinctive passages from the profile as if they were the user's sentences, and do not apply it to ordinary chat replies unless the user asks.

${markdown.trim()}
</personal_writing_style>${instructionBlock}`;
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  }
}
