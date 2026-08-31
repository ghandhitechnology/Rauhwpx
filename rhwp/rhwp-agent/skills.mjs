import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { providerToolNoteFor } from './agents/backend.mjs';
import {
  recoverInterruptedFileReplacement,
  replaceFileAtomically,
} from './harness-update.mjs';
import { readFileBytesBounded, readUtf8FileBounded } from './bounded-file.mjs';
import { humanizerPromptBlock } from './humanizer.mjs';

const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_BYTES = 50 * 1024 * 1024;
const MAX_AGENT_RESOURCE_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_DISABLED_SKILLS = 1_000;
const MAX_CATALOG_SKILLS = 1_000;
const MAX_SKILL_PATH_DEPTH = 32;
const RESERVED_NAMES = new Set(['skills', 'skill-create', 'skill-edit', 'skill-delete']);
const REQUIRED_BUNDLED_SKILLS = new Set(['present-plan']);
const SKILL_ICONS = new Set(['pencil', 'bot', 'system']);
const WINDOWS_FORBIDDEN_COMPONENT_RE = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_DEVICE_COMPONENT_RE = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;

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
  if (keys.some((key) => key !== 'name' && key !== 'description' && key !== 'icon')) {
    throw new SkillError('INVALID_SKILL', 'SKILL.md frontmatter may contain only name, description, and icon');
  }
  const name = metadata.name;
  const description = metadata.description;
  const icon = metadata.icon;
  if (!SKILL_NAME_RE.test(name ?? '') || RESERVED_NAMES.has(name)) {
    throw new SkillError('INVALID_SKILL_NAME', 'Skill name must be lowercase hyphen-case, under 64 characters, and not reserved');
  }
  if (expectedName && name !== expectedName) {
    throw new SkillError('INVALID_SKILL', `SKILL.md name "${name}" must match folder "${expectedName}"`);
  }
  if (!description || description.length > 1000) {
    throw new SkillError('INVALID_SKILL', 'Skill description is required and must be at most 1000 characters');
  }
  if (icon !== undefined && !SKILL_ICONS.has(icon)) {
    throw new SkillError('INVALID_SKILL_ICON', 'Skill icon must be pencil, bot, or system');
  }
  const body = source.slice(bodyStart).trim();
  if (!body) throw new SkillError('INVALID_SKILL', 'SKILL.md instructions cannot be empty');
  return { name, description, ...(icon ? { icon } : {}), body };
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\')
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new SkillError('INVALID_SKILL_FILE', `Invalid skill file path: ${String(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new SkillError('INVALID_SKILL_FILE', `Skill file escapes its folder: ${value}`);
  }
  if (value.split('/').includes('..')) {
    throw new SkillError('INVALID_SKILL_FILE', `Skill file path cannot contain traversal: ${value}`);
  }
  if (normalized === '.') {
    throw new SkillError('INVALID_SKILL_FILE', `Invalid skill file path: ${value}`);
  }
  const components = normalized.split('/');
  for (const component of components) {
    if (!component || component.endsWith('.') || component.endsWith(' ')
      || WINDOWS_FORBIDDEN_COMPONENT_RE.test(component)
      || WINDOWS_DEVICE_COMPONENT_RE.test(component)) {
      throw new SkillError('INVALID_SKILL_FILE', `Skill file path is not portable: ${value}`);
    }
  }
  if (components[0].toLowerCase() === '.git') {
    throw new SkillError('INVALID_SKILL_FILE', 'Git metadata is not allowed in a skill');
  }
  return normalized;
}

function portablePathKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function decodeFile(file) {
  const rel = safeRelativePath(file.path);
  const encoding = file.encoding === 'base64' ? 'base64' : 'utf8';
  if (typeof file.content !== 'string') throw new SkillError('INVALID_SKILL_FILE', `${rel} has no content`);
  const bytes = Buffer.from(file.content, encoding);
  if (bytes.length > MAX_FILE_BYTES) throw new SkillError('SKILL_TOO_LARGE', `${rel} exceeds 10 MB`);
  return { path: rel, bytes, encoding };
}

/** Canonical, storage-independent validation shared by generated drafts and saves. */
export function validateSkillPayload(payload, { maxFiles = MAX_FILES } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SkillError('INVALID_REQUEST', 'Missing skill payload');
  }
  const name = payload.name;
  if (!SKILL_NAME_RE.test(name ?? '') || RESERVED_NAMES.has(name)) {
    throw new SkillError('INVALID_SKILL_NAME', 'Invalid or reserved skill name');
  }
  if (!Array.isArray(payload.files) || payload.files.length === 0 || payload.files.length > maxFiles) {
    throw new SkillError('INVALID_SKILL', `A skill must contain 1-${maxFiles} files`);
  }
  const decoded = payload.files.map(decodeFile);
  if (decoded.filter((file) => file.path === 'SKILL.md').length !== 1) {
    throw new SkillError('INVALID_SKILL', 'SKILL.md is required');
  }
  if (new Set(decoded.map((file) => portablePathKey(file.path))).size !== decoded.length) {
    throw new SkillError(
      'INVALID_SKILL_FILE',
      'Duplicate skill file paths (including platform-aliased paths)',
    );
  }
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

async function readCatalogState(file, platform) {
  let text;
  try {
    text = await readUtf8FileBounded(file, {
      maxBytes: MAX_STATE_BYTES,
      label: 'Skill catalog state',
      platform,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return { disabled: [] };
    const wrapped = new SkillError('SKILL_STATE_CORRUPT', `Skill catalog state cannot be read safely: ${error?.message ?? error}`);
    wrapped.cause = error;
    throw wrapped;
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => key !== 'disabled')
      || !Array.isArray(value.disabled) || value.disabled.length > MAX_DISABLED_SKILLS
      || value.disabled.some((name) => !SKILL_NAME_RE.test(name) || RESERVED_NAMES.has(name))
      || new Set(value.disabled).size !== value.disabled.length) {
      throw new Error('invalid state schema');
    }
    return { disabled: [...value.disabled] };
  } catch (error) {
    const wrapped = new SkillError('SKILL_STATE_CORRUPT', 'Skill catalog state is corrupt; disabled skills were not re-enabled.');
    wrapped.cause = error;
    throw wrapped;
  }
}

async function collectFiles(root) {
  const files = [];
  let totalBytes = 0;
  async function walk(dir, prefix = '', depth = 0) {
    if (depth > MAX_SKILL_PATH_DEPTH) throw new SkillError('INVALID_SKILL_FILE', 'Skill folders are nested too deeply');
    const directory = await fs.opendir(dir);
    for await (const entry of directory) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelativePath(rel);
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw new SkillError('INVALID_SKILL_FILE', 'Symlinks are not allowed in skills');
      if (stat.isDirectory()) await walk(full, rel, depth + 1);
      else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) throw new SkillError('SKILL_TOO_LARGE', `${rel} exceeds 10 MB`);
        totalBytes += stat.size;
        files.push({ path: rel, size: stat.size });
        if (files.length > MAX_FILES || totalBytes > MAX_SKILL_BYTES) {
          throw new SkillError('SKILL_TOO_LARGE', 'Persisted skill exceeds its file or byte limit');
        }
      }
    }
  }
  await walk(root);
  return files;
}

export class SkillRegistry {
  constructor({
    bundledRoot,
    userRoot = defaultSkillDataRoot(),
    writingStyleStore = null,
    platform = process.platform,
  }) {
    this.bundledRoot = bundledRoot;
    this.userRoot = userRoot;
    this.writingStyleStore = writingStyleStore;
    this.platform = platform;
    this.statePath = path.join(userRoot, '.catalog-state.json');
    this.trashRoot = path.join(userRoot, '.trash');
    this.revision = 1;
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.userRoot, { recursive: true });
    await fs.mkdir(this.trashRoot, { recursive: true });
    await recoverInterruptedFileReplacement(this.statePath, { platform: this.platform });
    await this._state();
    return this;
  }

  async _state() {
    return readCatalogState(this.statePath, this.platform);
  }

  async _writeState(state) {
    const temp = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await replaceFileAtomically(temp, this.statePath, { platform: this.platform });
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async _scanRoot(root, origin, disabled) {
    let directory;
    try {
      directory = await fs.opendir(root);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const skills = [];
    let entryCount = 0;
    for await (const entry of directory) {
      entryCount += 1;
      if (entryCount > MAX_CATALOG_SKILLS) throw new SkillError('SKILL_CATALOG_TOO_LARGE', 'Skill catalog contains too many entries');
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const skillRoot = path.join(root, entry.name);
      try {
        const markdown = await readUtf8FileBounded(path.join(skillRoot, 'SKILL.md'), {
          maxBytes: MAX_FILE_BYTES,
          label: `${entry.name}/SKILL.md`,
          platform: this.platform,
        });
        const parsed = parseSkillMarkdown(markdown, entry.name);
        const files = await collectFiles(skillRoot);
        const required = origin === 'bundled' && REQUIRED_BUNDLED_SKILLS.has(parsed.name);
        skills.push({
          name: parsed.name,
          description: parsed.description,
          ...(parsed.icon ? { icon: parsed.icon } : {}),
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
    let totalBytes = 0;
    for (const entry of skill.files) {
      const bytes = await readFileBytesBounded(path.join(skill.root, entry.path), {
        maxBytes: MAX_FILE_BYTES,
        label: `${skill.name}/${entry.path}`,
        platform: this.platform,
        allowEmpty: true,
      });
      if (bytes.length !== entry.size) throw new SkillError('SKILL_CHANGED', `${entry.path} changed while the skill was read`);
      totalBytes += bytes.length;
      if (totalBytes > MAX_SKILL_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'Persisted skill exceeds 50 MB');
      const textLike = entry.path === 'SKILL.md' || /\.(?:md|txt|json|ya?ml|toml|js|mjs|cjs|ts|py|sh|css|html|xml|csv)$/i.test(entry.path);
      files.push({ path: entry.path, encoding: textLike ? 'utf8' : 'base64', content: bytes.toString(textLike ? 'utf8' : 'base64'), size: bytes.length });
    }
    return { revision: this.revision, skill: { ...skill, root: undefined, files } };
  }

  async _validatePayload(payload) {
    const checked = validateSkillPayload(payload);
    const { name } = checked;
    const existing = (await this.list()).skills.find((item) => item.name === name);
    if (existing?.origin === 'bundled') throw new SkillError('READ_ONLY_SKILL', 'Bundled skills cannot be overwritten');
    return checked;
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
    return this.#mutate(async () => {
      const { name, decoded } = await this._validatePayload(payload);

      const temp = path.join(this.userRoot, `.tmp-${name}-${process.pid}-${randomUUID()}`);
      const target = path.join(this.userRoot, name);
      const backup = path.join(this.trashRoot, `${Date.now()}-${name}-update-${randomUUID()}`);
      let backedUp = false;
      let installed = false;
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
        installed = true;
        const result = await this.read(name);
        this.revision++;
        return { ...result, revision: this.revision };
      } catch (error) {
        await fs.rm(temp, { recursive: true, force: true });
        let rollbackError = null;
        if (installed) {
          const failedTarget = path.join(
            this.trashRoot,
            `${Date.now()}-${name}-failed-${randomUUID()}`,
          );
          try {
            await fs.rename(target, failedTarget);
          } catch (moveError) {
            if (moveError?.code !== 'ENOENT') rollbackError = moveError;
          }
        }
        if (backedUp) {
          if (!rollbackError) {
            try { await fs.rename(backup, target); }
            catch (restoreError) { rollbackError = restoreError; }
          }
        }
        if (rollbackError) {
          const recoveryError = new SkillError(
            'SKILL_ROLLBACK_FAILED',
            'Skill update failed and the previous version could not be restored automatically',
          );
          recoveryError.cause = new AggregateError([error, rollbackError]);
          throw recoveryError;
        }
        throw error;
      }
    });
  }

  async setEnabled(name, enabled) {
    return this.#mutate(async () => {
      const skill = await this._find(name);
      if (skill.required && !enabled) {
        throw new SkillError('REQUIRED_SKILL', `${name} is required by the planning workflow`);
      }
      const state = await this._state();
      const disabled = new Set(state.disabled);
      if (enabled) {
        disabled.delete(name);
      } else if (!disabled.has(name)) {
        if (disabled.size >= MAX_DISABLED_SKILLS) {
          throw new SkillError(
            'SKILL_STATE_TOO_LARGE',
            `At most ${MAX_DISABLED_SKILLS} skills can be disabled`,
          );
        }
        disabled.add(name);
      }
      await this._writeState({ disabled: [...disabled].sort() });
      this.revision++;
      return this.list();
    });
  }

  async delete(name) {
    return this.#mutate(async () => {
      const skill = await this._find(name);
      if (skill.origin !== 'user') throw new SkillError('READ_ONLY_SKILL', 'Bundled skills cannot be deleted');
      const trashPath = path.join(this.trashRoot, `${Date.now()}-${randomUUID()}-${name}`);
      await fs.rename(skill.root, trashPath);
      try {
        const state = await this._state();
        if (state.disabled.includes(name)) {
          await this._writeState({ disabled: state.disabled.filter((entry) => entry !== name) });
        }
      } catch (error) {
        try {
          await fs.rename(trashPath, skill.root);
        } catch (rollbackError) {
          const recoveryError = new SkillError(
            'SKILL_ROLLBACK_FAILED',
            'Skill deletion failed and the original skill could not be restored automatically',
          );
          recoveryError.cause = new AggregateError([error, rollbackError]);
          throw recoveryError;
        }
        throw error;
      }
      this.revision++;
      return { revision: this.revision, name, recoverable: true };
    });
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
    const content = await readUtf8FileBounded(path.join(skill.root, rel), {
      maxBytes: MAX_AGENT_RESOURCE_BYTES,
      label: `${skill.name}/${rel}`,
      platform: this.platform,
      allowEmpty: true,
    });
    if (Buffer.byteLength(content, 'utf8') !== entry.size) {
      throw new SkillError('SKILL_CHANGED', `${rel} changed while the skill was read`);
    }
    return { name: skill.name, resourcePath: rel, content };
  }

  #mutate(operation) {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async promptContext(text, explicitName, { phase = 'direct', agent = null } = {}) {
    const catalog = await this.list();
    const enabled = catalog.skills.filter((skill) => skill.enabled && !skill.invalid);
    const metadata = enabled.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n').slice(0, 8000);
    let activated = '';
    if (explicitName) {
      const skill = await this._find(explicitName, true);
      const { content: markdown } = await this.readResource(explicitName, 'SKILL.md');
      activated = `\n\n<activated_product_skill name="${skill.name}" root="${skill.root}">\n${markdown}\n</activated_product_skill>`;
      // SKILL.md 는 provider 중립 카탈로그 텍스트다. 스킬이 협업 도구 이름을
      // 언급할 수 있으므로(복사 레이아웃의 wait_agent 등), 활성 시점에 이
      // provider 의 실제 관찰 수단을 한 문장으로 덧붙인다.
      const toolNote = typeof agent === 'string' && agent ? providerToolNoteFor(agent) : '';
      if (toolNote) activated += `\n\n<provider_tool_notes agent="${agent}">\n${toolNote}\n</provider_tool_notes>`;
    }
    const writingStyle = this.writingStyleStore ? await this.writingStyleStore.promptBlock() : '';
    const styleStatus = this.writingStyleStore && writingStyle ? await this.writingStyleStore.status() : null;
    // 문서에 글이 들어가는 단계에서만 작문 규율을 얹는다. 개인 목소리 초상이 먼저 오고,
    // 규율 블록은 그 아래에서 "문서 > 초상 > 규율" 우선순위를 스스로 밝힌다.
    // 프로필이 있으면 리듬 수치는 프로필 쪽 지문만 남기고, 규율이 두 번째 목소리를 얹지 않는다.
    const humanizer = humanizerPromptBlock(phase, {
      language: styleStatus?.language === 'en' ? 'en' : 'ko',
      personalProfile: Boolean(styleStatus?.active),
    });
    return `${writingStyle ? `${writingStyle}\n\n` : ''}${humanizer ? `${humanizer}\n\n` : ''}<rhwp_product_skills revision="${catalog.revision}">\nOnly the skills in this catalog are product skills. If the request clearly matches one, call read_product_skill for its SKILL.md before acting, then read supporting resources progressively. Do not use provider-global skills.\n${metadata || '(no enabled skills)'}\n</rhwp_product_skills>${activated}\n\n<user_request>\n${text}\n</user_request>`;
  }
}
