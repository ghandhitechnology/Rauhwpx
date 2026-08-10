import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILE_FILE = 'style.md';
const METADATA_FILE = 'metadata.json';
const STRUCTURED_FILE = 'profile.json';

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
    this.structuredPath = path.join(root, STRUCTURED_FILE);
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

  /** 정량 계층. 없으면 null — 구버전 프로필이거나 원고를 추출하지 못한 경우다. */
  async profile() {
    const value = await readJson(this.structuredPath, null);
    return value && typeof value === 'object' ? value : null;
  }

  async save({ markdown, language, sourceCount, pageEstimate, summary, profile = null }) {
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
    if (profile && typeof profile === 'object') {
      const structuredTemp = `${this.structuredPath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(structuredTemp, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(structuredTemp, this.structuredPath);
    } else {
      // 새 프로필에 정량 계층이 없으면 이전 캘리브레이션의 수치를 남겨 두지 않는다.
      await fs.rm(this.structuredPath, { force: true });
    }
    return this.status();
  }

  async promptBlock() {
    try {
      const markdown = await fs.readFile(this.profilePath, 'utf8');
      if (!markdown.trim()) return '';
      return `<personal_writing_style>
This is the user's own writing profile, measured from documents they confirmed they wrote. It is a specification for producing text, not a checklist for grading it. Compose within it from the first sentence rather than drafting freely and correcting afterwards.

How to read it: the baselines are targets you write toward, not limits you check against. Sections marked as rules carry enough evidence to follow directly. Sections marked advisory are thin — apply them where they fit and drop them where they fight the document.

Precedence: what the open document already does comes first, the genre and recipient come second, this profile third. It never overrides facts, quoted wording, legal or official phrasing, accessibility, or a formality level the user asked for. Do not reuse distinctive passages from the profile as if they were the user's sentences, and do not apply it to ordinary chat replies unless the user asks.

${markdown.trim()}
</personal_writing_style>`;
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  }
}
