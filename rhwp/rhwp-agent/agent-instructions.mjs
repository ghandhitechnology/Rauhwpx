import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_AGENT_INSTRUCTIONS_CHARS = 30_000;
const MAX_AGENT_INSTRUCTIONS_BYTES = MAX_AGENT_INSTRUCTIONS_CHARS * 4;
const MAX_METADATA_BYTES = 4_096;
const METADATA_VERSION = 1;

export const DEFAULT_AGENT_INSTRUCTIONS = `# App agent instructions

These durable instructions apply only inside Rauhwpx. The app keeps this AGENTS.md separate from project and provider instruction files, so other agent harnesses do not load it.

## Maintaining this file

- Read and follow these instructions in every Rauhwpx chat.
- When the user asks to change these instructions, submit the complete revised file through the app's instruction tools. Rauhwpx shows the proposal to the user and saves it only after confirmation.
- You may proactively propose a clearly durable preference after the user repeats it or corrects you. Keep the change small, specific, and tell the user what you proposed.
- Do not save one-off task details, secrets, credentials, or sensitive inferred facts. Ask before making a broad or ambiguous change.
`;

export class AgentInstructionsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'AgentInstructionsError';
  }
}

export function defaultAgentInstructionsRoot(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (env.RHWP_AGENT_INSTRUCTIONS_DIR
    && platformPath.isAbsolute(env.RHWP_AGENT_INSTRUCTIONS_DIR)) {
    return platformPath.resolve(env.RHWP_AGENT_INSTRUCTIONS_DIR);
  }
  if (platform === 'darwin') {
    return platformPath.join(home, 'Library', 'Application Support', 'rhwp', 'agent-instructions');
  }
  if (platform === 'win32') {
    return platformPath.join(
      env.APPDATA && platformPath.isAbsolute(env.APPDATA)
        ? env.APPDATA
        : platformPath.join(home, 'AppData', 'Roaming'),
      'rhwp',
      'agent-instructions',
    );
  }
  return platformPath.join(
    env.XDG_DATA_HOME && platformPath.isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : platformPath.join(home, '.local', 'share'),
    'rhwp',
    'agent-instructions',
  );
}

function contentHash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function metadataFor(content, revision, updatedAt) {
  return `${JSON.stringify({
    version: METADATA_VERSION,
    revision,
    contentHash: contentHash(content),
    updatedAt,
  })}\n`;
}

function readMetadata(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AgentInstructionsError(
      'INSTRUCTIONS_METADATA_INVALID',
      'The app AGENTS.md revision metadata is invalid.',
    );
  }
  if (value?.version !== METADATA_VERSION
    || !Number.isSafeInteger(value?.revision)
    || value.revision < 1
    || typeof value?.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || typeof value?.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new AgentInstructionsError(
      'INSTRUCTIONS_METADATA_INVALID',
      'The app AGENTS.md revision metadata is invalid.',
    );
  }
  return value;
}

function normalizeContent(value) {
  if (typeof value !== 'string') {
    throw new AgentInstructionsError('INSTRUCTIONS_INVALID', 'AGENTS.md content must be text.');
  }
  const normalized = value.replace(/\r\n?/g, '\n');
  if (normalized.length > MAX_AGENT_INSTRUCTIONS_CHARS) {
    throw new AgentInstructionsError(
      'INSTRUCTIONS_TOO_LARGE',
      `AGENTS.md may not exceed ${MAX_AGENT_INSTRUCTIONS_CHARS.toLocaleString('en-US')} characters.`,
    );
  }
  if (normalized.length === 0) return '';
  return normalized.endsWith('\n') || normalized.length === MAX_AGENT_INSTRUCTIONS_CHARS
    ? normalized
    : `${normalized}\n`;
}

export class AgentInstructionsStore {
  constructor({
    rootDir = defaultAgentInstructionsRoot(),
    now = () => new Date().toISOString(),
    fsApi = fs,
    platform = process.platform,
  } = {}) {
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, 'AGENTS.md');
    this.metadataPath = path.join(rootDir, '.AGENTS.md.meta.json');
    this.now = now;
    this.fs = fsApi;
    this.platform = platform;
    this.content = '';
    this.revision = 0;
    this.updatedAt = null;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await this.fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const rootStat = await this.fs.lstat(this.rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new AgentInstructionsError(
        'INSTRUCTIONS_ROOT_INVALID',
        'The app instruction directory must be a real directory, not a symbolic link.',
      );
    }
    await this.fs.chmod(this.rootDir, 0o700).catch(() => {});
    try {
      const loaded = await this.#readRegularText(this.filePath, {
        maxBytes: MAX_AGENT_INSTRUCTIONS_BYTES,
        invalidCode: 'INSTRUCTIONS_FILE_INVALID',
        invalidMessage: 'The app AGENTS.md must be a regular file, not a symbolic link.',
        tooLargeCode: 'INSTRUCTIONS_TOO_LARGE',
        tooLargeMessage: `AGENTS.md may not exceed ${MAX_AGENT_INSTRUCTIONS_CHARS.toLocaleString('en-US')} characters.`,
      });
      this.content = normalizeContent(loaded.text);
      const fileUpdatedAt = new Date(Number(loaded.stat.mtimeMs)).toISOString();
      let metadata = null;
      try {
        const loadedMetadata = await this.#readRegularText(this.metadataPath, {
          maxBytes: MAX_METADATA_BYTES,
          invalidCode: 'INSTRUCTIONS_METADATA_INVALID',
          invalidMessage: 'The app AGENTS.md revision metadata must be a regular file, not a symbolic link.',
          tooLargeCode: 'INSTRUCTIONS_METADATA_INVALID',
          tooLargeMessage: 'The app AGENTS.md revision metadata is too large.',
        });
        metadata = readMetadata(loadedMetadata.text);
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'INSTRUCTIONS_METADATA_INVALID') {
          throw error;
        }
        // 손상되었거나 너무 크거나 심볼릭 링크인 메타데이터 때문에 허브 시작이
        // 중단되어서는 안 된다. 없는 것으로 처리하고, 아래의 타임스탬프 기반
        // 시드로 기존의 실질적인 숫자 리비전을 무효화한 뒤 사이드카를 원자적으로 교체한다.
      }

      if (!metadata) {
        // A pre-metadata file may have stale revision-1 drafts in Studio. Seed
        // its revision from the file timestamp so those drafts fail closed.
        this.revision = Math.max(2, Math.floor(Number(loaded.stat.mtimeMs)));
        this.updatedAt = fileUpdatedAt;
        await this.#writeMetadataAtomic(this.content, this.revision, this.updatedAt);
      } else if (metadata.contentHash !== contentHash(this.content)) {
        // A manual edit or a crash between the content and metadata renames is
        // a real new revision. Repair the metadata without ever moving back.
        this.revision = metadata.revision + 1;
        this.updatedAt = fileUpdatedAt;
        await this.#writeStateAtomic(this.content, this.revision, this.updatedAt);
      } else {
        this.revision = metadata.revision;
        this.updatedAt = metadata.updatedAt;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.content = normalizeContent(DEFAULT_AGENT_INSTRUCTIONS);
      this.revision = 1;
      this.updatedAt = this.now();
      await this.#writeStateAtomic(this.content, this.revision, this.updatedAt);
    }
    await this.fs.chmod(this.filePath, 0o600).catch(() => {});
    await this.fs.chmod(this.metadataPath, 0o600).catch(() => {});
    return this;
  }

  snapshot() {
    return {
      fileName: 'AGENTS.md',
      content: this.content,
      revision: this.revision,
      updatedAt: this.updatedAt,
      maxChars: MAX_AGENT_INSTRUCTIONS_CHARS,
      scope: 'rauhwpx-app',
    };
  }

  update(content, { expectedRevision } = {}) {
    const operation = this.writeChain.then(async () => {
      const normalized = this.prepareUpdate(content, { expectedRevision }).content;
      if (normalized === this.content) return this.snapshot();
      const revision = this.revision + 1;
      const updatedAt = this.now();
      await this.#writeStateAtomic(normalized, revision, updatedAt);
      this.content = normalized;
      this.revision = revision;
      this.updatedAt = updatedAt;
      return this.snapshot();
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  prepareUpdate(content, { expectedRevision } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new AgentInstructionsError(
        'INSTRUCTIONS_REVISION_REQUIRED',
        'Read AGENTS.md first and provide its current expectedRevision.',
      );
    }
    if (expectedRevision !== this.revision) {
      throw new AgentInstructionsError(
        'INSTRUCTIONS_REVISION_CONFLICT',
        `AGENTS.md changed from revision ${expectedRevision} to ${this.revision}; read it again before saving.`,
      );
    }
    return {
      content: normalizeContent(content),
      expectedRevision,
    };
  }

  promptBlock() {
    return [
      '<app_agents_md trust="user-authored-instructions">',
      JSON.stringify(this.snapshot()),
      '</app_agents_md>',
    ].join('\n');
  }

  async #readRegularText(filePath, {
    maxBytes,
    invalidCode,
    invalidMessage,
    tooLargeCode,
    tooLargeMessage,
  }) {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const flags = this.platform === 'win32'
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | noFollow;
    let handle;
    try {
      handle = await this.fs.open(filePath, flags);
    } catch (error) {
      if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
        throw new AgentInstructionsError(invalidCode, invalidMessage);
      }
      throw error;
    }
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw new AgentInstructionsError(invalidCode, invalidMessage);
      if (stat.size > BigInt(maxBytes)) {
        throw new AgentInstructionsError(tooLargeCode, tooLargeMessage);
      }
      if (this.platform === 'win32') {
        // Node does not expose FILE_FLAG_OPEN_REPARSE_POINT. Validate that the
        // post-open path is a regular non-reparse entry for the exact file ID
        // held by the handle, then read only through that handle.
        const pathStat = await this.fs.lstat(filePath, { bigint: true });
        if (!pathStat.isFile()
          || pathStat.isSymbolicLink()
          || pathStat.dev !== stat.dev
          || pathStat.ino !== stat.ino) {
          throw new AgentInstructionsError(invalidCode, invalidMessage);
        }
      }
      const bytes = await handle.readFile();
      if (bytes.length > maxBytes) {
        throw new AgentInstructionsError(tooLargeCode, tooLargeMessage);
      }
      return { text: bytes.toString('utf8'), stat };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async #writeStateAtomic(content, revision, updatedAt) {
    // Metadata is renamed first. If the process stops before content is
    // renamed, init() observes the hash mismatch and advances once more; a
    // failed content rename also leaves the live file and in-memory state old.
    await this.#writeMetadataAtomic(content, revision, updatedAt);
    await this.#writeAtomicFile(this.filePath, content);
  }

  async #writeMetadataAtomic(content, revision, updatedAt) {
    await this.#writeAtomicFile(
      this.metadataPath,
      metadataFor(content, revision, updatedAt),
    );
  }

  async #writeAtomicFile(targetPath, content) {
    const tempPath = path.join(
      this.rootDir,
      `.${path.basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`,
    );
    try {
      await this.fs.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
      await this.fs.rename(tempPath, targetPath);
      await this.fs.chmod(targetPath, 0o600).catch(() => {});
    } catch (error) {
      await this.fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
