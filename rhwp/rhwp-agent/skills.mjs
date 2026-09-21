import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { providerToolNoteFor } from './agents/backend.mjs';
import { readFileBytesBounded, readUtf8FileBounded } from './bounded-file.mjs';
import {
  recoverInterruptedFileReplacement,
  replaceFileAtomically,
  retryLockedOperation,
} from './harness-update.mjs';
import { humanizerPromptBlock } from './humanizer.mjs';
import { defaultPiRoot } from './pi-manager.mjs';

const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_BYTES = 50 * 1024 * 1024;
const MAX_AGENT_RESOURCE_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_DISABLED_SKILLS = 1_000;
const MAX_CATALOG_SKILLS = 1_000;
const MAX_SKILL_PATH_DEPTH = 32;
const CATALOG_LINE_BUDGET = 8_000;
const DESCRIPTION_LINE_LIMIT = 1_000;
const RESERVED_NAMES = new Set(['skills', 'skill-create', 'skill-edit', 'skill-delete']);
const SEALED_NAME = 'present-plan';
const SKILL_ICONS = new Set(['pencil', 'bot', 'system']);
const HARNESS_IDS = ['claude', 'codex', 'cursor', 'pi'];
const WINDOWS_FORBIDDEN_COMPONENT_RE = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_DEVICE_COMPONENT_RE = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
const TEXT_RESOURCE_RE = /\.(?:md|txt|json|ya?ml|toml|js|mjs|cjs|ts|py|sh|css|html|xml|csv)$/i;
const TRASH_ENTRY_RE = /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(.+)$/i;

const REFUSAL_MESSAGE = Object.freeze({
  STALE: '스킬이 그 사이 바뀌었습니다.',
  EXISTS: '같은 이름의 스킬이 이미 있습니다.',
  LOCAL_EDITS: '사용자 스킬에 로컬 수정이 있습니다.',
  SEALED: '이 스킬은 바꿀 수 없습니다.',
  BUNDLED: '기본 스킬 파일은 지우지 않습니다.',
  INVALID_SKILL: '스킬 형식이 올바르지 않습니다.',
  INVALID_SKILL_NAME: '스킬 이름이 올바르지 않습니다.',
  NAME_MISMATCH: 'SKILL.md의 이름이 폴더와 다릅니다.',
  SKILL_NOT_FOUND: '스킬을 찾지 못했습니다.',
  HARNESS_NOT_FOUND: '가져올 스킬을 찾지 못했습니다.',
  SKILL_TOO_LARGE: '스킬이 너무 큽니다.',
  INVALID_SKILL_FILE: '스킬 파일 경로가 올바르지 않습니다.',
  SKILL_STATE_TOO_LARGE: '비활성화할 수 있는 스킬 수를 넘었습니다.',
});

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

export function defaultRauRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RHWP_RAU_DIR) return path.resolve(env.RHWP_RAU_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'rhwp', 'rau');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'rhwp', 'rau');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rhwp', 'rau');
}

export function projectSkillMarkdown(markdown, expectedName) {
  if (typeof markdown !== 'string') {
    throw new SkillError('INVALID_SKILL', 'SKILL.md must start with YAML frontmatter');
  }
  const source = markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;
  const opening = source.match(/^---\r?\n/);
  if (!opening) throw new SkillError('INVALID_SKILL', 'SKILL.md must start with YAML frontmatter');
  const frontmatterStart = opening[0].length;
  const closing = source.slice(frontmatterStart).match(/\r?\n---\r?\n/);
  if (!closing || closing.index == null) {
    throw new SkillError('INVALID_SKILL', 'SKILL.md frontmatter is not closed');
  }
  const frontmatter = source.slice(frontmatterStart, frontmatterStart + closing.index);
  const body = source.slice(frontmatterStart + closing.index + closing[0].length);
  if (!body.trim()) throw new SkillError('INVALID_SKILL', 'SKILL.md instructions cannot be empty');
  let parsed;
  try {
    parsed = parseYaml(frontmatter, { maxAliasCount: 0 });
  } catch {
    throw new SkillError('INVALID_SKILL', 'SKILL.md frontmatter is not valid YAML');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillError('INVALID_SKILL', 'SKILL.md frontmatter must be a mapping');
  }
  const name = parsed.name;
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name) || RESERVED_NAMES.has(name)) {
    throw new SkillError('INVALID_SKILL_NAME', 'Skill name must be lowercase hyphen-case, under 64 characters, and not reserved');
  }
  if (expectedName && name !== expectedName) {
    throw new SkillError('NAME_MISMATCH', `SKILL.md name "${name}" must match folder "${expectedName}"`);
  }
  if (typeof parsed.description !== 'string' || parsed.description.trim() === '') {
    throw new SkillError('INVALID_SKILL', 'Skill description is required');
  }
  return { name, description: parsed.description, icon: iconFromDocument(parsed) };
}

function iconFromDocument(doc) {
  if (Object.prototype.hasOwnProperty.call(doc, 'icon')) return normalizeIcon(doc.icon);
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const rhwp = metadata.rhwp;
  if (!rhwp || typeof rhwp !== 'object' || Array.isArray(rhwp)) return null;
  if (!Object.prototype.hasOwnProperty.call(rhwp, 'icon')) return null;
  return normalizeIcon(rhwp.icon);
}

function normalizeIcon(value) {
  return typeof value === 'string' && SKILL_ICONS.has(value) ? value : null;
}

function catalogLineDescription(description) {
  return description.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_LINE_LIMIT);
}

function brokenReason(error) {
  switch (error?.code) {
    case 'INVALID_SKILL_NAME':
    case 'NAME_MISMATCH':
      return '스킬 이름이 올바르지 않습니다';
    case 'INVALID_SKILL':
      return 'SKILL.md를 읽을 수 없습니다';
    case 'INVALID_SKILL_FILE':
      return '파일 경로가 올바르지 않습니다';
    case 'SKILL_TOO_LARGE':
      return '파일이 너무 큽니다';
    default:
      return '스킬을 읽을 수 없습니다';
  }
}

function refusal(code, digest = null) {
  return { ok: false, code, message: REFUSAL_MESSAGE[code] ?? code, digest };
}

function yamlDoubleQuoted(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

function canonicalMarkdown(name, description, body) {
  const next = String(body).replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return `---\nname: ${name}\ndescription: ${yamlDoubleQuoted(description)}\n---\n\n${next}\n`;
}

function frontmatterSplit(markdown) {
  const source = Buffer.isBuffer(markdown) ? markdown.toString('utf8') : String(markdown);
  const bom = source.startsWith('\uFEFF') ? 1 : 0;
  const logical = source.slice(bom);
  const opening = logical.match(/^---\r?\n/);
  if (!opening) return null;
  const closing = logical.slice(opening[0].length).match(/\r?\n---\r?\n/);
  if (!closing || closing.index == null) return null;
  const fenceEnd = bom + opening[0].length + closing.index + closing[0].length;
  return source.slice(0, fenceEnd);
}

function spliceBody(markdown, body) {
  const front = frontmatterSplit(markdown);
  const next = String(body).replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (!front || !next.trim()) return null;
  return `${front}\n${next}\n`;
}

function digestFiles(files) {
  const hash = createHash('sha256');
  for (const name of [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const bytes = files.get(name);
    hash.update(Buffer.from(name, 'utf8'));
    hash.update(Buffer.from([0]));
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function sameFiles(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (!other || !value.equals(other)) return false;
  }
  return true;
}

function cloneFiles(files) {
  return new Map([...files].map(([key, value]) => [key, Buffer.from(value)]));
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
  if (normalized === '.') throw new SkillError('INVALID_SKILL_FILE', `Invalid skill file path: ${value}`);
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

function putFile(files, rel, bytes) {
  const key = portablePathKey(rel);
  for (const existing of files.keys()) {
    if (portablePathKey(existing) === key) files.delete(existing);
  }
  files.set(rel, bytes);
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function pathExists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function exactKeys(raw, keys) {
  const allowed = new Set(keys);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new SkillError('INVALID_REQUEST', 'Unknown skill change field');
  }
}

function requireName(value) {
  if (typeof value !== 'string' || !SKILL_NAME_RE.test(value)) {
    throw new SkillError('INVALID_REQUEST', 'Invalid skill name');
  }
  return value;
}

function requireDigest(value, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    throw new SkillError('INVALID_REQUEST', 'Skill base digest is invalid');
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string') throw new SkillError('INVALID_REQUEST', `${label} is required`);
  return value;
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
    return { disabled: value.disabled.filter((name) => name !== SEALED_NAME) };
  } catch (error) {
    const wrapped = new SkillError('SKILL_STATE_CORRUPT', 'Skill catalog state is corrupt; disabled skills were not re-enabled.');
    wrapped.cause = error;
    throw wrapped;
  }
}

export class SkillRegistry {
  constructor({
    bundledRoot,
    userRoot = defaultSkillDataRoot(),
    writingStyleStore = null,
    platform = process.platform,
    home = os.homedir(),
    harnessRoots = null,
    fileOperations = {},
    lockRetryDelays,
  }) {
    this.bundledRoot = bundledRoot;
    this.userRoot = userRoot;
    this.writingStyleStore = writingStyleStore;
    this.platform = platform;
    this.home = home;
    this.harnessRoots = harnessRoots;
    this.fileOperations = {
      rename: fileOperations.rename ?? fs.rename,
      rm: fileOperations.rm ?? fs.rm,
    };
    this.lockOptions = lockRetryDelays
      ? { platform, delays: lockRetryDelays }
      : { platform };
    this.statePath = path.join(userRoot, '.catalog-state.json');
    this.trashRoot = path.join(userRoot, '.trash');
    this.journalPath = path.join(userRoot, '.commit.json');
    this.stagingRoot = path.join(userRoot, '.staging');
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.userRoot, { recursive: true });
    await fs.mkdir(path.join(this.trashRoot, 'deleted'), { recursive: true });
    await this._recoverJournal();
    await this._quarantineSealed();
    await recoverInterruptedFileReplacement(this.statePath, { platform: this.platform });
    await this._state();
    return this;
  }

  async catalog() {
    const state = await this._state();
    const disabled = new Set(state.disabled);
    const bundled = await this._scanRoot(this.bundledRoot, 'bundled', disabled);
    const users = await this._scanRoot(this.userRoot, 'user', disabled);
    const sealed = bundled.find((row) => row.name === SEALED_NAME && row.kind === 'skill');
    const rows = [];
    if (sealed) {
      rows.push({
        kind: 'sealed',
        name: SEALED_NAME,
        description: sealed.description,
        enabled: true,
        origin: 'sealed',
        digest: null,
        icon: sealed.icon,
      });
    }
    const hidden = new Set(users.filter((row) => row.name !== SEALED_NAME).map((row) => row.name));
    for (const row of users) {
      if (row.name === SEALED_NAME) continue;
      rows.push(row);
    }
    for (const row of bundled) {
      if (row.name === SEALED_NAME || hidden.has(row.name)) continue;
      rows.push(row);
    }
    rows.sort((a, b) => {
      const rank = (row) => (row.kind === 'sealed' ? 0 : 1);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
    return { rows };
  }

  async harness() {
    const rows = [];
    for (const harness of HARNESS_IDS) {
      let directory;
      try {
        directory = await fs.opendir(this._harnessRoot(harness));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      for await (const entry of directory) {
        if (!SKILL_NAME_RE.test(entry.name) || entry.name.startsWith('.')) continue;
        try {
          const loaded = await this._loadHarnessSkill(harness, entry.name);
          rows.push({
            harness,
            name: loaded.projected.name,
            description: catalogLineDescription(loaded.projected.description),
          });
        } catch {
          continue;
        }
      }
    }
    rows.sort((a, b) => a.harness.localeCompare(b.harness) || a.name.localeCompare(b.name));
    return rows;
  }

  parseChange(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SkillError('INVALID_REQUEST', 'Missing skill change');
    }
    switch (raw.action) {
      case 'create':
        exactKeys(raw, ['action', 'name', 'description', 'body', 'base']);
        return {
          kind: 'create',
          name: requireName(raw.name),
          description: requireText(raw.description, 'Skill description'),
          body: requireText(raw.body, 'Skill body'),
          ...(raw.base === undefined ? {} : { base: requireDigest(raw.base) }),
        };
      case 'write': {
        exactKeys(raw, ['action', 'name', 'path', 'content', 'encoding', 'base']);
        const encoding = raw.encoding === undefined ? 'utf8' : raw.encoding;
        if (encoding !== 'utf8' && encoding !== 'base64') {
          throw new SkillError('INVALID_REQUEST', 'Unknown skill file encoding');
        }
        if (typeof raw.content !== 'string') throw new SkillError('INVALID_REQUEST', 'Skill file has no content');
        return {
          kind: 'write',
          name: requireName(raw.name),
          path: safeRelativePath(raw.path),
          bytes: Buffer.from(raw.content, encoding),
          base: requireDigest(raw.base),
        };
      }
      case 'body':
        exactKeys(raw, ['action', 'name', 'body', 'base']);
        return {
          kind: 'body',
          name: requireName(raw.name),
          body: requireText(raw.body, 'Skill body'),
          base: requireDigest(raw.base),
        };
      case 'enable':
        exactKeys(raw, ['action', 'name', 'enabled']);
        if (typeof raw.enabled !== 'boolean') throw new SkillError('INVALID_REQUEST', 'Skill enabled flag is required');
        return { kind: 'enable', name: requireName(raw.name), enabled: raw.enabled };
      case 'delete':
        exactKeys(raw, ['action', 'name', 'base']);
        return { kind: 'delete', name: requireName(raw.name), base: requireDigest(raw.base) };
      case 'import':
        exactKeys(raw, ['action', 'harness', 'name', 'mode', 'base']);
        if (!HARNESS_IDS.includes(raw.harness)) throw new SkillError('INVALID_REQUEST', 'Unknown skill harness');
        if (raw.mode !== 'adopt' && raw.mode !== 'replace') {
          throw new SkillError('INVALID_REQUEST', 'Unknown skill import mode');
        }
        return {
          kind: 'import',
          harness: raw.harness,
          name: requireName(raw.name),
          mode: raw.mode,
          ...(raw.base === undefined ? {} : { base: requireDigest(raw.base) }),
        };
      case 'restore':
        exactKeys(raw, ['action', 'name']);
        return { kind: 'restore', name: requireName(raw.name) };
      default:
        throw new SkillError('INVALID_REQUEST', 'Unknown skill change');
    }
  }

  async commit(change) {
    return this.#mutate(() => this._commit(change));
  }

  async readResource(name, resourcePath = 'SKILL.md') {
    const rel = safeRelativePath(resourcePath);
    if (name === SEALED_NAME) {
      const entry = await this._loadEntry(this.bundledRoot, SEALED_NAME);
      if (!entry || entry.broken) throw new SkillError('SKILL_NOT_FOUND', `Skill not found: ${name}`);
      return this._resourceFromEntry(entry, name, rel);
    }
    const row = (await this.catalog()).rows.find((item) => item.name === name);
    if (!row || row.kind === 'broken' || row.kind === 'sealed') {
      throw new SkillError('SKILL_NOT_FOUND', `Skill not found: ${name}`);
    }
    if (!row.enabled) throw new SkillError('SKILL_DISABLED', `Skill is disabled: ${name}`);
    const entry = await this._loadEntry(row.origin === 'user' ? this.userRoot : this.bundledRoot, name);
    if (!entry || entry.broken) throw new SkillError('SKILL_NOT_FOUND', `Skill not found: ${name}`);
    return this._resourceFromEntry(entry, name, rel);
  }

  async promptContext(text, explicitName, { phase = 'direct', agent = null } = {}) {
    const catalog = await this.catalog();
    const enabled = catalog.rows.filter((row) => row.enabled && row.kind !== 'broken');
    const sealed = enabled.find((row) => row.kind === 'sealed') ?? null;
    const rest = enabled.filter((row) => row.kind !== 'sealed');
    const lines = [];
    let budget = CATALOG_LINE_BUDGET;
    if (sealed) {
      const line = `- ${sealed.name}: ${sealed.description}`;
      lines.push(line);
      budget -= line.length + 1;
    }
    let omitted = false;
    for (const row of rest) {
      const line = `- ${row.name}: ${row.description}`;
      const cost = line.length + (lines.length ? 1 : 0);
      if (cost > budget) {
        omitted = true;
        break;
      }
      lines.push(line);
      budget -= cost;
    }
    if (omitted) lines.push('(more skills omitted)');
    const metadata = lines.join('\n');
    let activated = '';
    if (phase === 'planning') {
      const markdown = await this._bundledMarkdown(SEALED_NAME);
      if (markdown) {
        activated += `\n\n<activated_product_skill name="${SEALED_NAME}">\n${markdown}\n</activated_product_skill>`;
      }
    }
    const requested = typeof explicitName === 'string' ? explicitName : '';
    const active = requested && requested !== SEALED_NAME
      ? enabled.find((row) => row.name === requested && row.kind === 'skill')
      : null;
    if (active) {
      const markdown = await this._visibleMarkdown(active);
      if (markdown) {
        activated += `\n\n<activated_product_skill name="${active.name}">\n${markdown}\n</activated_product_skill>`;
        const toolNote = typeof agent === 'string' && agent ? providerToolNoteFor(agent) : '';
        if (toolNote) activated += `\n\n<provider_tool_notes agent="${agent}">\n${toolNote}\n</provider_tool_notes>`;
      }
    }
    const writingStyle = this.writingStyleStore ? await this.writingStyleStore.promptBlock() : '';
    const styleStatus = this.writingStyleStore && writingStyle ? await this.writingStyleStore.status() : null;
    const humanizer = humanizerPromptBlock(phase, {
      language: styleStatus?.language === 'en' ? 'en' : 'ko',
      personalProfile: Boolean(styleStatus?.active),
    });
    const skills = `<rhwp_product_skills>\nOnly the skills in this catalog are product skills. If the request clearly matches one, call read_product_skill for its SKILL.md before acting, then read supporting resources progressively. Do not use provider-global skills.\n${metadata || '(no enabled skills)'}\n</rhwp_product_skills>${activated}`;
    return `${writingStyle ? `${writingStyle}\n\n` : ''}${humanizer ? `${humanizer}\n\n` : ''}${skills}\n\n<user_request>\n${text}\n</user_request>`;
  }

  async _commit(change) {
    if (change.name === SEALED_NAME) return refusal('SEALED');
    if (RESERVED_NAMES.has(change.name)) return refusal('INVALID_SKILL_NAME');
    const snapshot = await this._snapshot(change.name);
    switch (change.kind) {
      case 'create':
        return this._commitCreate(change, snapshot);
      case 'write':
        return this._commitWrite(change, snapshot);
      case 'body':
        return this._commitBody(change, snapshot);
      case 'enable':
        return this._commitEnable(change, snapshot);
      case 'delete':
        return this._commitDelete(change, snapshot);
      case 'import':
        return this._commitImport(change, snapshot);
      case 'restore':
        return this._commitRestore(change, snapshot);
      default: {
        const unknown = change.kind;
        throw new SkillError('INVALID_REQUEST', `Unknown skill change: ${unknown}`);
      }
    }
  }

  async _commitCreate(change, snapshot) {
    if (!change.description.trim() || !change.body.trim()) return refusal('INVALID_SKILL');
    let markdown;
    try {
      markdown = canonicalMarkdown(change.name, change.description, change.body);
      projectSkillMarkdown(markdown, change.name);
    } catch (error) {
      return refusal(error?.code === 'INVALID_SKILL_NAME' ? 'INVALID_SKILL_NAME' : 'INVALID_SKILL');
    }
    const files = new Map([['SKILL.md', Buffer.from(markdown, 'utf8')]]);
    if (this._sameVisible(snapshot, files)) return this._unchanged(change.name, snapshot);
    if (snapshot.user?.broken) {
      if (change.base !== undefined && change.base !== snapshot.user.digest) {
        return refusal('STALE', snapshot.user.digest);
      }
      await this._install(change.name, files);
      return this._accepted(change.name, false);
    }
    if (snapshot.visible === 'skill') return refusal('EXISTS', this._visibleDigest(snapshot));
    await this._install(change.name, files);
    return this._accepted(change.name, false);
  }

  async _commitWrite(change, snapshot) {
    if (change.bytes.length > MAX_FILE_BYTES) return refusal('SKILL_TOO_LARGE', this._visibleDigest(snapshot));
    const base = this._editableFiles(snapshot);
    if (!base) return refusal('SKILL_NOT_FOUND');
    if (snapshot.user?.structural) return refusal('INVALID_SKILL_FILE', snapshot.user.digest);
    const files = cloneFiles(base.files);
    putFile(files, change.path, Buffer.from(change.bytes));
    const projected = this._projectedFiles(change.name, files);
    if (!projected.ok) return refusal(projected.code, this._visibleDigest(snapshot));
    if (this._sameVisible(snapshot, files)) return this._unchanged(change.name, snapshot);
    if (base.digest !== change.base) return refusal('STALE', base.digest);
    await this._install(change.name, files);
    return this._accepted(change.name, false);
  }

  async _commitBody(change, snapshot) {
    const base = this._editableFiles(snapshot);
    if (!base) return refusal('SKILL_NOT_FOUND');
    if (snapshot.user?.structural) return refusal('INVALID_SKILL_FILE', snapshot.user.digest);
    const current = base.files.get('SKILL.md');
    const markdown = current ? spliceBody(current, change.body) : null;
    if (!markdown) return refusal('INVALID_SKILL', this._visibleDigest(snapshot));
    const files = cloneFiles(base.files);
    putFile(files, 'SKILL.md', Buffer.from(markdown, 'utf8'));
    const projected = this._projectedFiles(change.name, files);
    if (!projected.ok) return refusal(projected.code, this._visibleDigest(snapshot));
    if (this._sameVisible(snapshot, files)) return this._unchanged(change.name, snapshot);
    if (base.digest !== change.base) return refusal('STALE', base.digest);
    await this._install(change.name, files);
    return this._accepted(change.name, false);
  }

  async _commitEnable(change, snapshot) {
    if (snapshot.visible === 'broken') return refusal('INVALID_SKILL', snapshot.user?.digest ?? null);
    if (snapshot.visible !== 'skill') return refusal('SKILL_NOT_FOUND');
    const state = await this._state();
    const disabled = new Set(state.disabled);
    const enabled = !disabled.has(change.name);
    if (enabled === change.enabled) return this._unchanged(change.name, snapshot);
    if (!change.enabled) {
      if (disabled.size >= MAX_DISABLED_SKILLS) return refusal('SKILL_STATE_TOO_LARGE', this._visibleDigest(snapshot));
      disabled.add(change.name);
    } else {
      disabled.delete(change.name);
    }
    await this._writeState({ disabled: [...disabled].sort() });
    return this._accepted(change.name, false);
  }

  async _commitDelete(change, snapshot) {
    if (!snapshot.user) return this._unchanged(change.name, snapshot);
    if (change.base !== snapshot.user.digest) return refusal('STALE', snapshot.user.digest);
    const target = path.join(this.userRoot, change.name);
    const trashPath = path.join(this.trashRoot, 'deleted', `${Date.now()}-${randomUUID()}-${change.name}`);
    await fs.mkdir(path.dirname(trashPath), { recursive: true });
    await this._renameLocked(target, trashPath);
    try {
      const state = await this._state();
      if (state.disabled.includes(change.name)) {
        await this._writeState({ disabled: state.disabled.filter((entry) => entry !== change.name) });
      }
    } catch (error) {
      try {
        await this._renameLocked(trashPath, target);
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
    return this._accepted(change.name, false, snapshot.user.digest);
  }

  async _commitImport(change, snapshot) {
    let source;
    try {
      source = await this._loadHarnessSkill(change.harness, change.name);
    } catch (error) {
      if (error instanceof SkillError && error.code === 'HARNESS_NOT_FOUND') return refusal('HARNESS_NOT_FOUND');
      if (error instanceof SkillError) return refusal(error.code === 'SKILL_TOO_LARGE' ? 'SKILL_TOO_LARGE' : 'INVALID_SKILL');
      throw error;
    }
    if (snapshot.user && !snapshot.user.structural && sameFiles(snapshot.user.files, source.files)) {
      return this._unchanged(change.name, snapshot);
    }
    if (change.mode === 'adopt') {
      if (!snapshot.user) {
        await this._install(change.name, source.files);
        return this._accepted(change.name, false);
      }
      return refusal('LOCAL_EDITS', snapshot.user.digest);
    }
    if (!snapshot.user || change.base !== snapshot.user.digest) {
      return refusal('STALE', snapshot.user?.digest ?? null);
    }
    await this._install(change.name, source.files);
    return this._accepted(change.name, false);
  }

  async _commitRestore(change, snapshot) {
    if (snapshot.user) return this._unchanged(change.name, snapshot);
    const trash = await this._newestTrash(change.name);
    if (!trash) return this._unchanged(change.name, snapshot);
    await this._renameLocked(trash, path.join(this.userRoot, change.name));
    return this._accepted(change.name, false);
  }

  _sameVisible(snapshot, files) {
    if (snapshot.user?.structural) return false;
    if (snapshot.user && !snapshot.user.broken && sameFiles(snapshot.user.files, files)) return true;
    if (!snapshot.user && snapshot.bundled && sameFiles(snapshot.bundled.files, files)) return true;
    return false;
  }

  _editableFiles(snapshot) {
    if (snapshot.user) return snapshot.user;
    if (snapshot.bundled) return snapshot.bundled;
    return null;
  }

  _visibleDigest(snapshot) {
    return snapshot.user?.digest ?? snapshot.bundled?.digest ?? null;
  }

  _projectedFiles(name, files) {
    const total = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    if (files.size > MAX_FILES || total > MAX_SKILL_BYTES) return { ok: false, code: 'SKILL_TOO_LARGE' };
    const keys = [...files.keys()];
    if (new Set(keys.map(portablePathKey)).size !== keys.length) return { ok: false, code: 'INVALID_SKILL_FILE' };
    const skill = files.get('SKILL.md');
    if (!skill) return { ok: false, code: 'INVALID_SKILL' };
    try {
      projectSkillMarkdown(skill.toString('utf8'), name);
    } catch (error) {
      const code = error?.code === 'NAME_MISMATCH' || error?.code === 'INVALID_SKILL_NAME'
        ? error.code
        : 'INVALID_SKILL';
      return { ok: false, code };
    }
    return { ok: true };
  }

  async _unchanged(name, snapshot) {
    const catalog = await this.catalog();
    return {
      ok: true,
      name,
      digest: this._visibleDigest(snapshot) ?? digestFiles(new Map()),
      unchanged: true,
      notice: null,
      catalog,
    };
  }

  async _accepted(name, unchanged, digest = null) {
    const catalog = await this.catalog();
    const row = catalog.rows.find((item) => item.name === name);
    return {
      ok: true,
      name,
      digest: digest ?? row?.digest ?? digestFiles(new Map()),
      unchanged,
      notice: null,
      catalog,
    };
  }

  async _snapshot(name) {
    const user = await this._loadEntry(this.userRoot, name);
    const bundled = name === SEALED_NAME ? null : await this._loadEntry(this.bundledRoot, name);
    let visible = 'absent';
    if (user?.broken) visible = 'broken';
    else if (user?.projected) visible = 'skill';
    else if (bundled?.projected) visible = 'skill';
    return { user, bundled, visible };
  }

  async _scanRoot(root, origin, disabled) {
    let directory;
    try {
      directory = await fs.opendir(root);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const rows = [];
    let entryCount = 0;
    for await (const entry of directory) {
      entryCount += 1;
      if (entryCount > MAX_CATALOG_SKILLS) {
        throw new SkillError('SKILL_CATALOG_TOO_LARGE', 'Skill catalog contains too many entries');
      }
      if (!entry.isDirectory() || entry.name.startsWith('.') || !SKILL_NAME_RE.test(entry.name)) continue;
      if (origin === 'bundled' && RESERVED_NAMES.has(entry.name)) continue;
      const loaded = await this._loadEntry(root, entry.name);
      if (!loaded) continue;
      if (origin === 'bundled') {
        if (!loaded.projected) continue;
        rows.push({
          kind: 'skill',
          name: loaded.projected.name,
          description: catalogLineDescription(loaded.projected.description),
          enabled: !disabled.has(loaded.projected.name),
          origin,
          digest: loaded.digest,
          icon: loaded.projected.icon,
        });
        continue;
      }
      if (loaded.broken || !loaded.projected) {
        rows.push({
          kind: 'broken',
          name: entry.name,
          description: loaded.broken ?? '스킬을 읽을 수 없습니다',
          enabled: false,
          origin: 'user',
          digest: loaded.digest,
          icon: null,
        });
        continue;
      }
      rows.push({
        kind: 'skill',
        name: loaded.projected.name,
        description: catalogLineDescription(loaded.projected.description),
        enabled: !disabled.has(loaded.projected.name),
        origin: 'user',
        digest: loaded.digest,
        icon: loaded.projected.icon,
      });
    }
    return rows;
  }

  async _loadEntry(root, name) {
    const dir = path.join(root, name);
    let stat;
    try {
      stat = await fs.lstat(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      return {
        files: new Map(),
        digest: digestFiles(new Map([[name, Buffer.from('symlink')]])),
        projected: null,
        broken: '심볼릭 링크가 있습니다',
        structural: true,
      };
    }
    if (!stat.isDirectory()) return null;
    const loaded = await this._readTree(dir);
    if (loaded.broken) {
      return { ...loaded, projected: null };
    }
    const skill = loaded.files.get('SKILL.md');
    if (!skill) {
      return { ...loaded, projected: null, broken: 'SKILL.md가 없습니다', structural: false };
    }
    try {
      return { ...loaded, projected: projectSkillMarkdown(skill.toString('utf8'), name), broken: null };
    } catch (error) {
      return { ...loaded, projected: null, broken: brokenReason(error), structural: false };
    }
  }

  async _readTree(root) {
    const files = new Map();
    const digestMap = new Map();
    let broken = null;
    let structural = false;
    let total = 0;
    const mark = (message, isStructural) => {
      if (!broken) broken = message;
      structural = structural || isStructural;
    };
    const walk = async (dir, prefix, depth) => {
      if (depth > MAX_SKILL_PATH_DEPTH) {
        mark('폴더가 너무 깊습니다', true);
        return;
      }
      let directory;
      try {
        directory = await fs.opendir(dir);
      } catch {
        mark('스킬 폴더를 열 수 없습니다', true);
        return;
      }
      for await (const entry of directory) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        let safe;
        try {
          safe = safeRelativePath(rel);
        } catch {
          mark('파일 경로가 올바르지 않습니다', true);
          continue;
        }
        const full = path.join(dir, entry.name);
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) {
          mark('심볼릭 링크가 있습니다', true);
          digestMap.set(safe, Buffer.from('symlink'));
          continue;
        }
        if (stat.isDirectory()) {
          await walk(full, safe, depth + 1);
          continue;
        }
        if (!stat.isFile()) {
          mark('스킬 파일을 읽을 수 없습니다', true);
          continue;
        }
        if (stat.size > MAX_FILE_BYTES || files.size >= MAX_FILES || total + stat.size > MAX_SKILL_BYTES) {
          mark('파일이 너무 큽니다', true);
          return;
        }
        try {
          const bytes = await readFileBytesBounded(full, {
            maxBytes: MAX_FILE_BYTES,
            label: safe,
            platform: this.platform,
            allowEmpty: true,
          });
          total += bytes.length;
          putFile(files, safe, bytes);
          putFile(digestMap, safe, bytes);
        } catch {
          mark('스킬 파일을 읽을 수 없습니다', true);
        }
      }
    };
    await walk(root, '', 0);
    return { files, digest: digestFiles(digestMap), broken, structural, projected: null };
  }

  async _resourceFromEntry(entry, name, rel) {
    const bytes = entry.files.get(rel);
    if (!bytes) throw new SkillError('SKILL_RESOURCE_NOT_FOUND', `Resource not found in ${name}: ${rel}`);
    if (bytes.length > MAX_AGENT_RESOURCE_BYTES) {
      throw new SkillError('SKILL_RESOURCE_TOO_LARGE', `${rel} exceeds the 1 MB agent-read limit`);
    }
    const textLike = rel === 'SKILL.md' || TEXT_RESOURCE_RE.test(rel);
    if (!textLike) throw new SkillError('BINARY_SKILL_RESOURCE', `${rel} is a binary asset and cannot be injected as instructions`);
    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new SkillError('INVALID_SKILL_FILE', `${rel} is not valid UTF-8`);
    }
    return {
      name,
      resourcePath: rel,
      content,
      digest: entry.digest,
      files: [...entry.files.keys()].sort(),
    };
  }

  async _bundledMarkdown(name) {
    const entry = await this._loadEntry(this.bundledRoot, name);
    const bytes = entry?.files.get('SKILL.md');
    if (!bytes) return '';
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return '';
    }
  }

  async _visibleMarkdown(row) {
    const root = row.origin === 'user' ? this.userRoot : this.bundledRoot;
    const entry = await this._loadEntry(root, row.name);
    const bytes = entry?.files.get('SKILL.md');
    if (!bytes) return '';
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return '';
    }
  }

  _harnessRoot(harness) {
    if (this.harnessRoots && Object.prototype.hasOwnProperty.call(this.harnessRoots, harness)) {
      return this.harnessRoots[harness];
    }
    switch (harness) {
      case 'claude':
        return path.join(this.home, '.claude', 'skills');
      case 'codex':
        return path.join(this.home, '.codex', 'skills');
      case 'cursor':
        return path.join(this.home, '.cursor', 'skills');
      case 'pi':
        return path.join(this.home, '.pi', 'agent', 'skills');
      default: {
        const unknown = harness;
        throw new SkillError('INVALID_REQUEST', `Unknown skill harness: ${unknown}`);
      }
    }
  }

  _blockedRoots() {
    return [
      this.bundledRoot,
      this.userRoot,
      path.resolve(this.bundledRoot, '..', 'pi', 'skills'),
      path.join(defaultPiRoot(process.env, this.platform, this.home), 'agent'),
      path.join(defaultRauRoot(process.env, this.platform, this.home), 'agent'),
    ];
  }

  async _loadHarnessSkill(harness, name) {
    const folder = path.join(this._harnessRoot(harness), name);
    let stat;
    try {
      stat = await fs.lstat(folder);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new SkillError('HARNESS_NOT_FOUND', `Harness skill not found: ${name}`);
      throw error;
    }
    let realDir = folder;
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(folder);
      const target = path.resolve(path.dirname(folder), link);
      const targetStat = await fs.lstat(target);
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        throw new SkillError('INVALID_SKILL_FILE', '심볼릭 링크는 한 번만 따라갑니다');
      }
      realDir = target;
    } else if (!stat.isDirectory()) {
      throw new SkillError('HARNESS_NOT_FOUND', `Harness skill not found: ${name}`);
    }
    const resolved = await fs.realpath(realDir);
    for (const root of this._blockedRoots()) {
      let blocked = path.resolve(root);
      try {
        blocked = await fs.realpath(root);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (isInside(blocked, resolved)) {
        throw new SkillError('INVALID_SKILL', '가져올 수 없는 위치입니다');
      }
    }
    const loaded = await this._readTree(resolved);
    if (loaded.broken) {
      throw new SkillError(loaded.structural ? 'INVALID_SKILL_FILE' : 'INVALID_SKILL', loaded.broken);
    }
    const skill = loaded.files.get('SKILL.md');
    if (!skill) throw new SkillError('INVALID_SKILL', 'SKILL.md가 없습니다');
    const projected = projectSkillMarkdown(skill.toString('utf8'), name);
    return { files: loaded.files, projected };
  }

  async _install(name, files) {
    const id = randomUUID();
    const staging = path.join(this.stagingRoot, id);
    const ready = `${staging}.ready`;
    const target = path.join(this.userRoot, name);
    await fs.mkdir(staging, { recursive: true });
    let journalWritten = false;
    try {
      for (const rel of [...files.keys()].sort()) {
        const dest = path.join(staging, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, files.get(rel), { mode: rel.startsWith('scripts/') ? 0o700 : 0o600 });
      }
      await fs.writeFile(ready, '', { mode: 0o600 });
      const backup = await pathExists(target)
        ? path.join(this.trashRoot, 'deleted', `${Date.now()}-${randomUUID()}-${name}`)
        : null;
      if (backup) await fs.mkdir(path.dirname(backup), { recursive: true });
      await this._writeJournal({ name, staging, backup });
      journalWritten = true;
      if (backup) await this._renameLocked(target, backup);
      await this._renameLocked(staging, target);
      await fs.rm(ready, { force: true });
      await this._dropJournal();
    } catch (error) {
      if (journalWritten) {
        const journal = await this._readJournal().catch(() => null);
        if (journal?.backup && !await pathExists(target) && await pathExists(journal.backup)) {
          try {
            await this._renameLocked(journal.backup, target);
          } catch (rollbackError) {
            const recoveryError = new SkillError(
              'SKILL_ROLLBACK_FAILED',
              'Skill update failed and the previous version could not be restored automatically',
            );
            recoveryError.cause = new AggregateError([error, rollbackError]);
            throw recoveryError;
          }
        }
        await this._dropJournal().catch(() => {});
      }
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      await fs.rm(ready, { force: true }).catch(() => {});
      throw error;
    }
  }

  async _newestTrash(name) {
    const dir = path.join(this.trashRoot, 'deleted');
    let directory;
    try {
      directory = await fs.opendir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let best = null;
    for await (const entry of directory) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const match = TRASH_ENTRY_RE.exec(entry.name);
      if (!match || match[2] !== name) continue;
      const stamp = Number(match[1]);
      if (!best || stamp >= best.stamp) best = { stamp, name: entry.name };
    }
    return best ? path.join(dir, best.name) : null;
  }

  async _recoverJournal() {
    const journal = await this._readJournal();
    if (!journal) {
      await fs.rm(this.stagingRoot, { recursive: true, force: true });
      return;
    }
    const target = path.join(this.userRoot, journal.name);
    const ready = `${journal.staging}.ready`;
    const targetExists = await pathExists(target);
    const stagingExists = await pathExists(journal.staging);
    const readyExists = await pathExists(ready);
    const backupExists = journal.backup ? await pathExists(journal.backup) : false;
    if (targetExists && !stagingExists) {
      await this._dropJournal();
      return;
    }
    if (!targetExists && stagingExists && readyExists) {
      await this._renameLocked(journal.staging, target);
      await fs.rm(ready, { force: true });
      await this._dropJournal();
      return;
    }
    if (!targetExists && (!stagingExists || !readyExists) && backupExists) {
      await this._renameLocked(journal.backup, target);
      await fs.rm(journal.staging, { recursive: true, force: true });
      await fs.rm(ready, { force: true });
      await this._dropJournal();
      return;
    }
    if (targetExists && stagingExists && readyExists && journal.backup && !backupExists) {
      await fs.mkdir(path.dirname(journal.backup), { recursive: true });
      await this._renameLocked(target, journal.backup);
      await this._renameLocked(journal.staging, target);
      await fs.rm(ready, { force: true });
      await this._dropJournal();
      return;
    }
    if (targetExists) {
      await fs.rm(journal.staging, { recursive: true, force: true });
      await fs.rm(ready, { force: true });
      await this._dropJournal();
      return;
    }
    throw new SkillError('SKILL_STATE_CORRUPT', 'Skill commit journal cannot be recovered');
  }

  async _quarantineSealed() {
    const target = path.join(this.userRoot, SEALED_NAME);
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) return;
    const dest = path.join(this.trashRoot, 'deleted', `${Date.now()}-${randomUUID()}-${SEALED_NAME}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await this._renameLocked(target, dest);
  }

  async _readJournal() {
    let text;
    try {
      text = await readUtf8FileBounded(this.journalPath, {
        maxBytes: MAX_STATE_BYTES,
        label: 'Skill commit journal',
        platform: this.platform,
      });
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      const wrapped = new SkillError('SKILL_STATE_CORRUPT', 'Skill commit journal cannot be read safely');
      wrapped.cause = error;
      throw wrapped;
    }
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.name !== 'string' || !SKILL_NAME_RE.test(value.name)
        || typeof value.staging !== 'string'
        || (value.backup !== null && typeof value.backup !== 'string')
        || !isInside(this.stagingRoot, value.staging)
        || (value.backup && !isInside(this.trashRoot, value.backup))) {
        throw new Error('invalid journal schema');
      }
      return { name: value.name, staging: value.staging, backup: value.backup ?? null };
    } catch (error) {
      const wrapped = new SkillError('SKILL_STATE_CORRUPT', 'Skill commit journal is corrupt');
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async _writeJournal(journal) {
    const temp = `${this.journalPath}.tmp-${process.pid}-${randomUUID()}`;
    await fs.writeFile(temp, `${JSON.stringify(journal)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await this._renameLocked(temp, this.journalPath);
  }

  async _dropJournal() {
    await fs.rm(this.journalPath, { force: true });
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

  _renameLocked(from, to) {
    return retryLockedOperation(() => this.fileOperations.rename(from, to), this.lockOptions);
  }

  _rmLocked(target, options) {
    return retryLockedOperation(() => this.fileOperations.rm(target, options), this.lockOptions);
  }

  #mutate(operation) {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
