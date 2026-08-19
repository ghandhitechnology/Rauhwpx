import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const PROFILE_FILE = 'style.md';
const METADATA_FILE = 'metadata.json';
const STRUCTURED_FILE = 'profile.json';
const ADDITIONAL_INSTRUCTION_FILE = 'additional-instruction.md';
const SOURCES_DIR = 'sources';
const SOURCES_MANIFEST_FILE = 'sources.json';
const COMMIT_JOURNAL_FILE = 'commit-journal.json';
const MAX_ADDITIONAL_INSTRUCTION_CHARS = 4_000;

export function defaultWritingStyleRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RHWP_WRITING_STYLE_DIR) return path.resolve(env.RHWP_WRITING_STYLE_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'rhwp', 'writing-style');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'rhwp', 'writing-style');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rhwp', 'writing-style');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readSourcesManifest(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, files: [] };
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.files)) throw new Error('files must be an array');
    for (const entry of parsed.files) {
      if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9]{64}$/.test(entry.id)
        || typeof entry.storedName !== 'string' || path.basename(entry.storedName) !== entry.storedName) {
        throw new Error('a source entry is invalid');
      }
    }
    return parsed;
  } catch (error) {
    const wrapped = new Error(`Saved writing samples are unreadable: ${error?.message ?? error}`);
    wrapped.code = 'STYLE_SOURCES_CORRUPT';
    throw wrapped;
  }
}

function corruptSources(message) {
  const error = new Error(`Saved writing samples are unreadable: ${message}`);
  error.code = 'STYLE_SOURCES_CORRUPT';
  return error;
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
  constructor({ root = defaultWritingStyleRoot() } = {}) {
    this.root = root;
    this.profilePath = path.join(root, PROFILE_FILE);
    this.metadataPath = path.join(root, METADATA_FILE);
    this.structuredPath = path.join(root, STRUCTURED_FILE);
    this.additionalInstructionPath = path.join(root, ADDITIONAL_INSTRUCTION_FILE);
    this.sourcesPath = path.join(root, SOURCES_DIR);
    this.sourcesManifestPath = path.join(root, SOURCES_MANIFEST_FILE);
    this.commitJournalPath = path.join(root, COMMIT_JOURNAL_FILE);
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    await this.recoverInterruptedCommit();
    return this;
  }

  async recoverInterruptedCommit() {
    let journal = null;
    try { journal = JSON.parse(await fs.readFile(this.commitJournalPath, 'utf8')); }
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
        fs.readFile(this.profilePath, 'utf8'),
        readJson(this.metadataPath, {}),
        fs.readFile(this.additionalInstructionPath, 'utf8').catch((error) => {
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
    const value = await readJson(this.structuredPath, null);
    return value && typeof value === 'object' ? value : null;
  }

  /** Persisted sample metadata is safe to expose in status; sample contents are not. */
  async sourceDocuments() {
    const manifest = await readSourcesManifest(this.sourcesManifestPath);
    if (!Array.isArray(manifest?.files)) return [];
    return Promise.all(manifest.files.map(async (entry) => {
      const blobPath = path.join(this.sourcesPath, entry.storedName);
      let stat;
      try { stat = await fs.lstat(blobPath); }
      catch (error) {
        if (error?.code === 'ENOENT') throw corruptSources(`source file is missing: ${entry.name || entry.id}`);
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw corruptSources(`source file is invalid: ${entry.name || entry.id}`);
      return {
        id: entry.id,
        name: String(entry.name || 'sample'),
        type: String(entry.type || 'application/octet-stream'),
        size: Math.max(0, Math.round(Number(entry.size) || 0)),
        addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
      };
    }));
  }

  /** Read the private originals only for an explicit additive recalibration. */
  async sources() {
    const manifest = await readSourcesManifest(this.sourcesManifestPath);
    if (!Array.isArray(manifest?.files)) return [];
    const loaded = await Promise.all(manifest.files.map(async (entry) => {
      if (!entry || typeof entry.storedName !== 'string') return null;
      try {
        const bytes = await fs.readFile(path.join(this.sourcesPath, path.basename(entry.storedName)));
        return {
          name: String(entry.name || 'sample'),
          type: String(entry.type || 'application/octet-stream'),
          size: bytes.length,
          addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
          content: bytes.toString('base64'),
        };
      } catch (error) {
        if (error?.code === 'ENOENT') throw corruptSources(`source file is missing: ${entry.name || entry.id}`);
        throw error;
      }
    }));
    return loaded;
  }

  /** Combine saved originals with new uploads, de-duplicated by their bytes. */
  async calibrationSources(files, { append = false } = {}) {
    const incoming = Array.isArray(files) ? files : [];
    const candidates = append ? [...await this.sources(), ...incoming] : incoming;
    const seen = new Set();
    return candidates.filter((file) => {
      if (!file || typeof file.content !== 'string') return true;
      let digest;
      try { digest = crypto.createHash('sha256').update(Buffer.from(file.content, 'base64')).digest('hex'); }
      catch { return true; }
      if (seen.has(digest)) return false;
      seen.add(digest);
      return true;
    });
  }

  async stageSources(files, transactionId) {
    const entries = [];
    const staging = `${this.sourcesPath}.tmp-${transactionId}`;
    const manifestTemp = `${this.sourcesManifestPath}.tmp-${transactionId}`;
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      for (const [index, file] of (Array.isArray(files) ? files : []).entries()) {
        if (!file || typeof file.content !== 'string') continue;
        const bytes = Buffer.from(file.content, 'base64');
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const extension = path.extname(String(file.name || '')).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
        const storedName = `${String(index + 1).padStart(2, '0')}-${sha256}${extension}`;
        await fs.writeFile(path.join(staging, storedName), bytes, { mode: 0o600 });
        entries.push({
          id: sha256,
          sha256,
          storedName,
          name: String(file.name || `sample-${index + 1}`),
          type: String(file.type || 'application/octet-stream'),
          size: bytes.length,
          addedAt: typeof file.addedAt === 'string' ? file.addedAt : new Date().toISOString(),
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

  async save({ markdown, language, sourceCount, pageEstimate, summary, profile = null, agent = null, model = null }, { sources } = {}) {
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
    const status = await this.status();
    if (!status.active) throw new Error('Calibrate a writing style before adding a tone instruction.');
    const instruction = String(value ?? '').trim();
    if (instruction.length > MAX_ADDITIONAL_INSTRUCTION_CHARS) {
      throw new Error(`The additional instruction must be ${MAX_ADDITIONAL_INSTRUCTION_CHARS} characters or fewer.`);
    }
    if (!instruction) {
      await fs.rm(this.additionalInstructionPath, { force: true });
      return this.status();
    }
    const temp = `${this.additionalInstructionPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, `${instruction}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, this.additionalInstructionPath);
    return this.status();
  }

  async promptBlock() {
    try {
      const [markdown, additionalInstruction] = await Promise.all([
        fs.readFile(this.profilePath, 'utf8'),
        fs.readFile(this.additionalInstructionPath, 'utf8').catch((error) => {
          if (error?.code === 'ENOENT') return '';
          throw error;
        }),
      ]);
      if (!markdown.trim()) return '';
      const instructionBlock = additionalInstruction.trim()
        ? `\n\n<personal_writing_instruction>\nApply this user-authored instruction in addition to the measured profile. It may refine tone and delivery, but it follows the same precedence and factual boundaries as the profile.\n\n${additionalInstruction.trim()}\n</personal_writing_instruction>`
        : '';
      return `<personal_writing_style>
This is the user's own writing profile, measured from documents they confirmed they wrote. It is a specification for producing text, not a checklist for grading it. Compose within it from the first sentence rather than drafting freely and correcting afterwards.

How to read it: the baselines are targets you write toward, not limits you check against. Sections marked as rules carry enough evidence to follow directly. Sections marked advisory are thin — apply them where they fit and drop them where they fight the document.

Precedence: what the open document already does comes first, the genre and recipient come second, this profile third. It never overrides facts, quoted wording, legal or official phrasing, accessibility, or a formality level the user asked for. Do not reuse distinctive passages from the profile as if they were the user's sentences, and do not apply it to ordinary chat replies unless the user asks.

${markdown.trim()}
</personal_writing_style>${instructionBlock}`;
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  }
}
