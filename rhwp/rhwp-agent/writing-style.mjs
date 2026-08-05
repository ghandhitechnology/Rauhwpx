import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILE_FILE = 'style.md';
const METADATA_FILE = 'metadata.json';

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

export class WritingStyleStore {
  constructor({ root = defaultWritingStyleRoot() } = {}) {
    this.root = root;
    this.profilePath = path.join(root, PROFILE_FILE);
    this.metadataPath = path.join(root, METADATA_FILE);
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    return this;
  }

  async status() {
    try {
      const [markdown, metadata] = await Promise.all([
        fs.readFile(this.profilePath, 'utf8'),
        readJson(this.metadataPath, {}),
      ]);
      return {
        active: Boolean(markdown.trim()),
        language: metadata.language === 'en' ? 'en' : 'ko',
        updatedAt: typeof metadata.updatedAt === 'string' ? metadata.updatedAt : null,
        sourceCount: Number.isFinite(metadata.sourceCount) ? metadata.sourceCount : 0,
        pageEstimate: Number.isFinite(metadata.pageEstimate) ? metadata.pageEstimate : 0,
        summary: typeof metadata.summary === 'string' ? metadata.summary : '',
      };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { active: false, language: 'ko', updatedAt: null, sourceCount: 0, pageEstimate: 0, summary: '' };
      }
      throw error;
    }
  }

  async save({ markdown, language, sourceCount, pageEstimate, summary }) {
    if (typeof markdown !== 'string' || markdown.trim().length < 200) {
      throw new Error('The generated style guide is incomplete.');
    }
    if (Buffer.byteLength(markdown, 'utf8') > 256 * 1024) {
      throw new Error('The generated style guide is too large.');
    }
    const updatedAt = new Date().toISOString();
    const metadata = {
      language: language === 'en' ? 'en' : 'ko',
      updatedAt,
      sourceCount: Math.max(0, Math.round(Number(sourceCount) || 0)),
      pageEstimate: Math.max(0, Math.round(Number(pageEstimate) || 0)),
      summary: String(summary || '').slice(0, 500),
    };
    const profileTemp = `${this.profilePath}.tmp-${process.pid}-${Date.now()}`;
    const metadataTemp = `${this.metadataPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(profileTemp, `${markdown.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.writeFile(metadataTemp, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(profileTemp, this.profilePath);
    await fs.rename(metadataTemp, this.metadataPath);
    return this.status();
  }

  async promptBlock() {
    try {
      const markdown = await fs.readFile(this.profilePath, 'utf8');
      if (!markdown.trim()) return '';
      return `<personal_writing_style>\nThe following style guide was derived from writing the user confirmed as their own. Apply it when drafting or rewriting a document for the user. Do not imitate mechanically, reuse distinctive passages, or let style override facts, recipient expectations, genre conventions, accessibility, or the requested level of formality. Adapt the guide to the situation. Do not apply it to routine chat unless the user asks.\n\n${markdown.trim()}\n</personal_writing_style>`;
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  }
}
