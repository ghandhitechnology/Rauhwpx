import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_AGENT_INSTRUCTIONS_CHARS = 30_000;

export const DEFAULT_AGENT_INSTRUCTIONS = `# App agent instructions

These durable instructions apply only inside Rauhwpx. The app keeps this AGENTS.md separate from project and provider instruction files, so other agent harnesses do not load it.

## Maintaining this file

- Read and follow these instructions in every Rauhwpx chat.
- When the user asks to change these instructions, update this file directly through the app's instruction tools.
- You may proactively preserve a clearly durable preference after the user repeats it or corrects you. Keep the change small, specific, and tell the user what you saved.
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
  if (env.RHWP_AGENT_INSTRUCTIONS_DIR) {
    return platformPath.resolve(env.RHWP_AGENT_INSTRUCTIONS_DIR);
  }
  if (platform === 'darwin') {
    return platformPath.join(home, 'Library', 'Application Support', 'rhwp', 'agent-instructions');
  }
  if (platform === 'win32') {
    return platformPath.join(
      env.APPDATA || platformPath.join(home, 'AppData', 'Roaming'),
      'rhwp',
      'agent-instructions',
    );
  }
  return platformPath.join(
    env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share'),
    'rhwp',
    'agent-instructions',
  );
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
  constructor({ rootDir = defaultAgentInstructionsRoot(), now = () => new Date().toISOString() } = {}) {
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, 'AGENTS.md');
    this.now = now;
    this.content = '';
    this.revision = 0;
    this.updatedAt = null;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(this.rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new AgentInstructionsError(
        'INSTRUCTIONS_ROOT_INVALID',
        'The app instruction directory must be a real directory, not a symbolic link.',
      );
    }
    await fs.chmod(this.rootDir, 0o700).catch(() => {});
    try {
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new AgentInstructionsError(
          'INSTRUCTIONS_FILE_INVALID',
          'The app AGENTS.md must be a regular file, not a symbolic link.',
        );
      }
      if (stat.size > MAX_AGENT_INSTRUCTIONS_CHARS * 4) {
        throw new AgentInstructionsError(
          'INSTRUCTIONS_TOO_LARGE',
          `AGENTS.md may not exceed ${MAX_AGENT_INSTRUCTIONS_CHARS.toLocaleString('en-US')} characters.`,
        );
      }
      this.content = normalizeContent(await fs.readFile(this.filePath, 'utf8'));
      this.updatedAt = stat.mtime.toISOString();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.content = normalizeContent(DEFAULT_AGENT_INSTRUCTIONS);
      this.updatedAt = this.now();
      await this.#writeAtomic(this.content);
    }
    this.revision = 1;
    await fs.chmod(this.filePath, 0o600).catch(() => {});
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
      const normalized = normalizeContent(content);
      if (normalized === this.content) return this.snapshot();
      await this.#writeAtomic(normalized);
      this.content = normalized;
      this.revision += 1;
      this.updatedAt = this.now();
      return this.snapshot();
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  promptBlock() {
    return [
      '<app_agents_md trust="user-authored-instructions">',
      JSON.stringify(this.snapshot()),
      '</app_agents_md>',
    ].join('\n');
  }

  async #writeAtomic(content) {
    const tempPath = path.join(this.rootDir, `.AGENTS.md.tmp-${process.pid}-${randomUUID()}`);
    try {
      await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
      await fs.chmod(this.filePath, 0o600).catch(() => {});
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
