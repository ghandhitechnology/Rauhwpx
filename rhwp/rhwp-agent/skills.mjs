import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { humanizerPromptBlock } from './humanizer.mjs';

const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_BYTES = 50 * 1024 * 1024;
const MAX_AGENT_RESOURCE_BYTES = 1024 * 1024;
const RESERVED_NAMES = new Set(['skills', 'skill-create', 'skill-edit', 'skill-delete']);
const REQUIRED_BUNDLED_SKILLS = new Set(['present-plan']);

export class SkillError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'SkillError';
  }
}

export function defaultSkillDataRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RHWP_SKILLS_DIR) return path.resolve(env.RHWP_SKILLS_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'rhwp', 'skills');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'rhwp', 'skills');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rhwp', 'skills');
}

export function parseSkillMarkdown(markdown, expectedName) {
  if (typeof markdown !== 'string') {
    throw new SkillError('INVALID_SKILL', 'SKILL.md must start with YAML frontmatter');
  }
  const source = markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;
  const opening = source.match(/^---\r?\n/);
  if (!opening) {
    throw new SkillError('INVALID_SKILL', 'SKILL.md must start with YAML frontmatter');
  }
  const frontmatterStart = opening[0].length;
  const closing = source.slice(frontmatterStart).match(/\r?\n---\r?\n/);
  if (!closing || closing.index == null) {
    throw new SkillError('INVALID_SKILL', 'SKILL.md frontmatter is not closed');
  }
  const frontmatterEnd = frontmatterStart + closing.index;
  const bodyStart = frontmatterEnd + closing[0].length;
  const frontmatter = source.slice(frontmatterStart, frontmatterEnd).split(/\r?\n/);
  const metadata = {};
  for (const line of frontmatter) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (!match) throw new SkillError('INVALID_SKILL', `Invalid frontmatter line: ${line}`);
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    metadata[key] = value;
  }
  const keys = Object.keys(metadata);
  if (keys.some((key) => key !== 'name' && key !== 'description')) {
    throw new SkillError('INVALID_SKILL', 'SKILL.md frontmatter may contain only name and description');
  }
  const name = metadata.name;
  const description = metadata.description;
  if (!SKILL_NAME_RE.test(name ?? '') || RESERVED_NAMES.has(name)) {
    throw new SkillError('INVALID_SKILL_NAME', 'Skill name must be lowercase hyphen-case, under 64 characters, and not reserved');
  }
  if (expectedName && name !== expectedName) {
    throw new SkillError('INVALID_SKILL', `SKILL.md name "${name}" must match folder "${expectedName}"`);
  }
  if (!description || description.length > 1000) {
    throw new SkillError('INVALID_SKILL', 'Skill description is required and must be at most 1000 characters');
  }
  const body = source.slice(bodyStart).trim();
  if (!body) throw new SkillError('INVALID_SKILL', 'SKILL.md instructions cannot be empty');
  return { name, description, body };
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.isAbsolute(value)) {
    throw new SkillError('INVALID_SKILL_FILE', `Invalid skill file path: ${String(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new SkillError('INVALID_SKILL_FILE', `Skill file escapes its folder: ${value}`);
  }
  if (normalized.startsWith('.git/') || normalized === '.git') {
    throw new SkillError('INVALID_SKILL_FILE', 'Git metadata is not allowed in a skill');
  }
  return normalized;
}

function decodeFile(file) {
  const rel = safeRelativePath(file.path);
  const encoding = file.encoding === 'base64' ? 'base64' : 'utf8';
  if (typeof file.content !== 'string') throw new SkillError('INVALID_SKILL_FILE', `${rel} has no content`);
  const bytes = Buffer.from(file.content, encoding);
  if (bytes.length > MAX_FILE_BYTES) throw new SkillError('SKILL_TOO_LARGE', `${rel} exceeds 10 MB`);
  return { path: rel, bytes, encoding };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    return fallback;
  }
}

async function collectFiles(root) {
  const files = [];
  async function walk(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new SkillError('INVALID_SKILL_FILE', 'Symlinks are not allowed in skills');
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const stat = await fs.stat(full);
        files.push({ path: rel, size: stat.size });
      }
    }
  }
  await walk(root);
  return files;
}

export class SkillRegistry {
  constructor({ bundledRoot, userRoot = defaultSkillDataRoot(), writingStyleStore = null }) {
    this.bundledRoot = bundledRoot;
    this.userRoot = userRoot;
    this.writingStyleStore = writingStyleStore;
    this.statePath = path.join(userRoot, '.catalog-state.json');
    this.trashRoot = path.join(userRoot, '.trash');
    this.revision = 1;
  }

  async init() {
    await fs.mkdir(this.userRoot, { recursive: true });
    await fs.mkdir(this.trashRoot, { recursive: true });
    return this;
  }

  async _state() {
    const value = await readJson(this.statePath, { disabled: [] });
    return { disabled: Array.isArray(value.disabled) ? value.disabled.filter((x) => typeof x === 'string') : [] };
  }

  async _writeState(state) {
    const temp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.statePath);
  }

  async _scanRoot(root, origin, disabled) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const skillRoot = path.join(root, entry.name);
      try {
        const markdown = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
        const parsed = parseSkillMarkdown(markdown, entry.name);
        const files = await collectFiles(skillRoot);
        const required = origin === 'bundled' && REQUIRED_BUNDLED_SKILLS.has(parsed.name);
        skills.push({
          name: parsed.name,
          description: parsed.description,
          origin,
          enabled: required || !disabled.has(parsed.name),
          ...(required ? { required: true } : {}),
          hasScripts: files.some((file) => file.path.startsWith('scripts/')),
          hasAssets: files.some((file) => file.path.startsWith('assets/')),
          fileCount: files.length,
          files,
        });
      } catch (error) {
        skills.push({
          name: entry.name,
          description: error instanceof Error ? error.message : String(error),
          origin,
          enabled: false,
          invalid: true,
          hasScripts: false,
          hasAssets: false,
          fileCount: 0,
          files: [],
        });
      }
    }
    return skills;
  }

  async list() {
    const state = await this._state();
    const disabled = new Set(state.disabled);
    const bundled = await this._scanRoot(this.bundledRoot, 'bundled', disabled);
    const users = await this._scanRoot(this.userRoot, 'user', disabled);
    // 같은 이름이면 사용자 스킬이 번들 스킬을 덮어쓴다 — 사용자 스킬이 보이지 않거나 지울 수 없게 되면 안 된다.
    const userNames = new Set(users.map((skill) => skill.name));
    const skills = [...bundled.filter((skill) => !userNames.has(skill.name)), ...users]
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name));
    return { revision: this.revision, skills };
  }

  async _find(name, requireEnabled = false) {
    const catalog = await this.list();
    const skill = catalog.skills.find((item) => item.name === name);
    if (!skill || skill.invalid) throw new SkillError('SKILL_NOT_FOUND', `Skill not found: ${name}`);
    if (requireEnabled && !skill.enabled) throw new SkillError('SKILL_DISABLED', `Skill is disabled: ${name}`);
    const root = skill.origin === 'bundled' ? this.bundledRoot : this.userRoot;
    return { ...skill, root: path.join(root, name) };
  }

  async read(name) {
    const skill = await this._find(name);
    const files = [];
    for (const entry of skill.files) {
      const bytes = await fs.readFile(path.join(skill.root, entry.path));
      const textLike = entry.path === 'SKILL.md' || /\.(?:md|txt|json|ya?ml|toml|js|mjs|cjs|ts|py|sh|css|html|xml|csv)$/i.test(entry.path);
      files.push({ path: entry.path, encoding: textLike ? 'utf8' : 'base64', content: bytes.toString(textLike ? 'utf8' : 'base64'), size: bytes.length });
    }
    return { revision: this.revision, skill: { ...skill, root: undefined, files } };
  }

  async _validatePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new SkillError('INVALID_REQUEST', 'Missing skill payload');
    const name = payload.name;
    if (!SKILL_NAME_RE.test(name ?? '') || RESERVED_NAMES.has(name)) throw new SkillError('INVALID_SKILL_NAME', 'Invalid or reserved skill name');
    const existing = (await this.list()).skills.find((item) => item.name === name);
    if (existing?.origin === 'bundled') throw new SkillError('READ_ONLY_SKILL', 'Bundled skills cannot be overwritten');
    if (!Array.isArray(payload.files) || payload.files.length === 0 || payload.files.length > MAX_FILES) {
      throw new SkillError('INVALID_SKILL', `A skill must contain 1-${MAX_FILES} files`);
    }
    const decoded = payload.files.map(decodeFile);
    if (!decoded.some((file) => file.path === 'SKILL.md')) throw new SkillError('INVALID_SKILL', 'SKILL.md is required');
    if (new Set(decoded.map((file) => file.path)).size !== decoded.length) throw new SkillError('INVALID_SKILL_FILE', 'Duplicate skill file paths');
    const total = decoded.reduce((sum, file) => sum + file.bytes.length, 0);
    if (total > MAX_SKILL_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'Skill exceeds 50 MB');
    const skillFile = decoded.find((file) => file.path === 'SKILL.md');
    parseSkillMarkdown(skillFile.bytes.toString('utf8'), name);
    return {
      name,
      decoded,
      hasScripts: decoded.some((file) => file.path.startsWith('scripts/')),
      hasAssets: decoded.some((file) => file.path.startsWith('assets/')),
    };
  }

  async validate(payload) {
    const checked = await this._validatePayload(payload);
    return {
      valid: true,
      name: checked.name,
      warnings: checked.hasScripts ? ['This skill contains executable scripts. Review every script before saving.'] : [],
      hasScripts: checked.hasScripts,
      hasAssets: checked.hasAssets,
      fileCount: checked.decoded.length,
    };
  }

  async save(payload) {
    const { name, decoded } = await this._validatePayload(payload);

    const temp = path.join(this.userRoot, `.tmp-${name}-${process.pid}-${Date.now()}`);
    const target = path.join(this.userRoot, name);
    const backup = path.join(this.trashRoot, `${Date.now()}-${name}-update`);
    let backedUp = false;
    await fs.mkdir(temp, { recursive: false });
    try {
      for (const file of decoded) {
        const dest = path.join(temp, file.path);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, file.bytes, { mode: file.path.startsWith('scripts/') ? 0o700 : 0o600 });
      }
      try {
        await fs.rename(target, backup);
        backedUp = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await fs.rename(temp, target);
      this.revision++;
      return this.read(name);
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true });
      if (backedUp) {
        try { await fs.rename(backup, target); } catch {}
      }
      throw error;
    }
  }

  async setEnabled(name, enabled) {
    const skill = await this._find(name);
    if (skill.required && !enabled) {
      throw new SkillError('REQUIRED_SKILL', `${name} is required by the planning workflow`);
    }
    const state = await this._state();
    const disabled = new Set(state.disabled);
    if (enabled) disabled.delete(name); else disabled.add(name);
    await this._writeState({ disabled: [...disabled].sort() });
    this.revision++;
    return this.list();
  }

  async delete(name) {
    const skill = await this._find(name);
    if (skill.origin !== 'user') throw new SkillError('READ_ONLY_SKILL', 'Bundled skills cannot be deleted');
    const trashPath = path.join(this.trashRoot, `${Date.now()}-${name}`);
    await fs.rename(skill.root, trashPath);
    this.revision++;
    return { revision: this.revision, name, recoverable: true };
  }

  async readResource(name, resourcePath = 'SKILL.md') {
    const skill = await this._find(name, true);
    const rel = safeRelativePath(resourcePath);
    const entry = skill.files.find((file) => file.path === rel);
    if (!entry) throw new SkillError('SKILL_RESOURCE_NOT_FOUND', `Resource not found in ${name}: ${rel}`);
    if (entry.size > MAX_AGENT_RESOURCE_BYTES) {
      throw new SkillError('SKILL_RESOURCE_TOO_LARGE', `${rel} exceeds the 1 MB agent-read limit`);
    }
    const textLike = rel === 'SKILL.md' || /\.(?:md|txt|json|ya?ml|toml|js|mjs|cjs|ts|py|sh|css|html|xml|csv)$/i.test(rel);
    if (!textLike) throw new SkillError('BINARY_SKILL_RESOURCE', `${rel} is a binary asset and cannot be injected as instructions`);
    const content = await fs.readFile(path.join(skill.root, rel), 'utf8');
    return { name: skill.name, resourcePath: rel, content };
  }

  async promptContext(text, explicitName, { phase = 'direct' } = {}) {
    const catalog = await this.list();
    const enabled = catalog.skills.filter((skill) => skill.enabled && !skill.invalid);
    const metadata = enabled.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n').slice(0, 8000);
    let activated = '';
    if (explicitName) {
      const skill = await this._find(explicitName, true);
      const markdown = await fs.readFile(path.join(skill.root, 'SKILL.md'), 'utf8');
      activated = `\n\n<activated_product_skill name="${skill.name}" root="${skill.root}">\n${markdown}\n</activated_product_skill>`;
    }
    const writingStyle = this.writingStyleStore ? await this.writingStyleStore.promptBlock() : '';
    const styleStatus = this.writingStyleStore && writingStyle ? await this.writingStyleStore.status() : null;
    // 문서에 글이 들어가는 단계에서만 작문 규율을 얹는다. 개인 문체 프로필이 먼저 오고,
    // 규율 블록은 그 아래에서 "문서 > 개인 문체 > 규율" 우선순위를 스스로 밝힌다.
    // 프로필이 있으면 리듬 수치는 프로필 쪽 기준선 하나만 남긴다.
    const humanizer = humanizerPromptBlock(phase, {
      language: styleStatus?.language === 'en' ? 'en' : 'ko',
      personalProfile: Boolean(styleStatus?.active),
    });
    return `${writingStyle ? `${writingStyle}\n\n` : ''}${humanizer ? `${humanizer}\n\n` : ''}<rhwp_product_skills revision="${catalog.revision}">\nOnly the skills in this catalog are product skills. If the request clearly matches one, call read_product_skill for its SKILL.md before acting, then read supporting resources progressively. Do not use provider-global skills.\n${metadata || '(no enabled skills)'}\n</rhwp_product_skills>${activated}\n\n<user_request>\n${text}\n</user_request>`;
  }
}
