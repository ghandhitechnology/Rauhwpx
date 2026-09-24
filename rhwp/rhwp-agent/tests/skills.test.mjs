import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry, projectSkillMarkdown } from '../skills.mjs';
import { buildClaudeArgv, formatClaudeExitError } from '../agents/claude.mjs';
import { buildCodexArgv } from '../agents/codex.mjs';
import { buildCodexAppServerArgv } from '../agents/codex-app-server.mjs';

const MARKDOWN = (name, description = 'Use this skill for representative testing.', icon) => `---\nname: ${name}\ndescription: ${description}${icon ? `\nicon: ${icon}` : ''}\n---\n\nFollow the requested workflow.\n`;

async function tempRegistry(t, { bundled = {}, user = {}, ...options } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-skills-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const bundledRoot = path.join(temp, 'bundled');
  const userRoot = path.join(temp, 'user');
  await fs.mkdir(bundledRoot, { recursive: true });
  await writeTree(bundledRoot, bundled);
  await writeTree(userRoot, user);
  const registry = await new SkillRegistry({
    bundledRoot,
    userRoot,
    home: path.join(temp, 'home'),
    ...options,
  }).init();
  return { temp, bundledRoot, userRoot, registry };
}

async function writeTree(root, tree) {
  for (const [name, files] of Object.entries(tree)) {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, name, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
  }
}

function change(registry, raw) {
  return registry.commit(registry.parseChange(raw));
}

test('projectSkillMarkdown reads YAML frontmatter without rewriting bytes', () => {
  assert.equal(projectSkillMarkdown(MARKDOWN('good-skill')).name, 'good-skill');
  assert.equal(projectSkillMarkdown(MARKDOWN('pencil-skill', undefined, 'pencil')).icon, 'pencil');
  const windowsMarkdown = `\uFEFF${MARKDOWN('windows-skill').replace(/\n/g, '\r\n')}`;
  assert.deepEqual(projectSkillMarkdown(windowsMarkdown), {
    name: 'windows-skill',
    description: 'Use this skill for representative testing.',
    icon: null,
  });
  assert.equal(projectSkillMarkdown('---\nname: valid-icon\ndescription: x\nicon: sparkles\n---\n\nDo it.\n').icon, 'sparkles');
  assert.equal(projectSkillMarkdown('---\nname: extra\ndescription: x\nfoo: bar\nmetadata:\n  rhwp:\n    icon: bot\n---\n\nDo it.\n').icon, 'bot');
  assert.throws(() => projectSkillMarkdown(MARKDOWN('skill-create')), /reserved/);
  assert.throws(
    () => projectSkillMarkdown('---\nname: alias-skill\ndescription: &a [x]\nfoo: *a\n---\n\nDo it.\n'),
    /YAML/,
  );
});

test('bundled present-plan stays sealed and a user directory of that name is quarantined', async (t) => {
  const markdown = readFileSync(new URL('../skills/present-plan/SKILL.md', import.meta.url), 'utf8');
  assert.equal(projectSkillMarkdown(markdown, 'present-plan').name, 'present-plan');
  assert.match(markdown, /present_implementation_plan/);
  assert.match(markdown, /when the user asks for a plan or gives concrete changes to an existing plan/);
  assert.match(markdown, /Do not tell the user the plan is ready/);
  assert.match(markdown, /present the replacement directly/);
  assert.match(markdown, /Applying any version still requires explicit approval/);

  const bundledBody = `${markdown}\nBUNDLED_PRESENT_PLAN_BODY\n`;
  const { userRoot, registry } = await tempRegistry(t, {
    bundled: { 'present-plan': { 'SKILL.md': bundledBody } },
    user: { 'present-plan': { 'SKILL.md': MARKDOWN('present-plan', 'user copy') } },
  });
  assert.equal(await pathExists(path.join(userRoot, 'present-plan')), false);
  const trash = await fs.readdir(path.join(userRoot, '.trash', 'deleted'));
  assert.equal(trash.filter((name) => name.endsWith('-present-plan')).length, 1);
  const again = await new SkillRegistry({
    bundledRoot: path.join(path.dirname(userRoot), 'bundled'),
    userRoot,
    home: path.join(path.dirname(userRoot), 'home'),
  }).init();
  const trashAfter = await fs.readdir(path.join(userRoot, '.trash', 'deleted'));
  assert.equal(trashAfter.filter((name) => name.endsWith('-present-plan')).length, 1);

  const row = (await registry.catalog()).rows.find((item) => item.name === 'present-plan');
  assert.equal(row.kind, 'sealed');
  assert.equal(row.origin, 'sealed');
  assert.equal(row.enabled, true);
  assert.equal(row.digest, null);
  const refused = await change(registry, { action: 'enable', name: 'present-plan', enabled: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'SEALED');
  const planning = await again.promptContext('계획', undefined, { phase: 'planning' });
  assert.match(planning, /BUNDLED_PRESENT_PLAN_BODY/);
  assert.doesNotMatch(planning, /user copy/);
  assert.match(planning, /<activated_product_skill name="present-plan">/);
  assert.doesNotMatch(planning, /root=/);
});

test('promptContext keeps the writing discipline on implementing and omits it while planning', async (t) => {
  const { registry } = await tempRegistry(t);
  const implementing = await registry.promptContext('문장', undefined, { phase: 'implementing' });
  assert.match(implementing, /<korean_writing_discipline>/);
  const planning = await registry.promptContext('문장', undefined, { phase: 'planning' });
  assert.doesNotMatch(planning, /<korean_writing_discipline>/);
});

test('Codex loads bundled document image guidance by default and respects disabling it', async (t) => {
  const markdown = readFileSync(new URL('../skills/document-image-generation/SKILL.md', import.meta.url), 'utf8');
  assert.equal(projectSkillMarkdown(markdown, 'document-image-generation').name, 'document-image-generation');
  const { registry } = await tempRegistry(t, {
    bundled: { 'document-image-generation': { 'SKILL.md': markdown } },
  });

  const codex = await registry.promptContext('Add a small illustration', undefined, { agent: 'codex' });
  assert.match(codex, /<activated_product_skill name="document-image-generation">/);
  assert.match(codex, /insert_image/);
  assert.match(codex, /In planning or question mode, discuss the visual without editing the document/);
  assert.equal(codex.match(/<activated_product_skill name="document-image-generation">/g)?.length, 1);
  const explicit = await registry.promptContext('Add a small illustration', 'document-image-generation', { agent: 'codex' });
  assert.equal(explicit.match(/<activated_product_skill name="document-image-generation">/g)?.length, 1);
  const claude = await registry.promptContext('Add a small illustration', undefined, { agent: 'claude' });
  assert.doesNotMatch(claude, /<activated_product_skill name="document-image-generation">/);

  const disabled = await change(registry, { action: 'enable', name: 'document-image-generation', enabled: false });
  assert.equal(disabled.ok, true);
  const withoutSkill = await registry.promptContext('Add a small illustration', undefined, { agent: 'codex' });
  assert.doesNotMatch(withoutSkill, /<activated_product_skill name="document-image-generation">/);
});

test('Codex enables native image generation for document chat in both launch paths', () => {
  const options = { ...backendOpts, permissionProfile: 'safe' };
  for (const argv of [buildCodexArgv(options, null), buildCodexArgv(options, 'thread'), buildCodexAppServerArgv(options)]) {
    assert.ok(argv.some((arg, index) => arg === '--enable' && argv[index + 1] === 'image_generation'));
  }
  const worker = { ...options, toolProfile: 'copy-layout-worker' };
  for (const argv of [buildCodexArgv(worker, null), buildCodexAppServerArgv(worker)]) {
    assert.ok(argv.some((arg, index) => arg === '--disable' && argv[index + 1] === 'image_generation'));
  }
});

test('SkillRegistry creates, disables, reads, and recoverably deletes user skills', async (t) => {
  const { userRoot, registry } = await tempRegistry(t, {
    bundled: { starter: { 'SKILL.md': MARKDOWN('starter') } },
  });
  const created = await change(registry, {
    action: 'create',
    name: 'my-skill',
    description: 'Use this skill for representative testing.',
    body: 'Follow the requested workflow.',
  });
  assert.equal(created.ok, true);
  const script = await change(registry, {
    action: 'write',
    name: 'my-skill',
    path: 'scripts/check.js',
    content: 'process.stdout.write("ok")',
    base: created.digest,
  });
  assert.equal(script.ok, true);
  const scriptMode = (await fs.stat(path.join(userRoot, 'my-skill', 'scripts', 'check.js'))).mode & 0o777;
  assert.equal(scriptMode, 0o700);
  let catalog = await registry.catalog();
  assert.deepEqual(catalog.rows.map((row) => row.name), ['my-skill', 'starter']);
  assert.equal(catalog.rows.find((row) => row.name === 'my-skill').icon, null);

  const disabled = await change(registry, { action: 'enable', name: 'my-skill', enabled: false });
  assert.equal(disabled.ok, true);
  catalog = await registry.catalog();
  assert.equal(catalog.rows.find((row) => row.name === 'my-skill').enabled, false);
  await assert.rejects(() => registry.readResource('my-skill'), (error) => error.code === 'SKILL_DISABLED');
  const enabled = await change(registry, { action: 'enable', name: 'my-skill', enabled: true });
  assert.equal(enabled.ok, true);
  const resource = await registry.readResource('my-skill');
  assert.match(resource.content, /name: my-skill/);
  assert.equal(resource.digest, enabled.digest);
  assert.deepEqual(resource.files, ['.rhwp-origin.json', 'SKILL.md', 'scripts/check.js']);
  assert.throws(() => registry.parseChange({
    action: 'write',
    name: 'my-skill',
    path: '../outside.txt',
    content: 'no',
    base: enabled.digest,
  }), /escapes its folder/);

  const same = await change(registry, { action: 'enable', name: 'my-skill', enabled: true });
  assert.equal(same.unchanged, true);
  const deleted = await change(registry, { action: 'delete', name: 'my-skill', base: enabled.digest });
  assert.equal(deleted.ok, true);
  assert.equal((await registry.catalog()).rows.some((row) => row.name === 'my-skill'), false);
  assert.ok((await fs.readdir(path.join(userRoot, '.trash', 'deleted'))).some((name) => name.endsWith('-my-skill')));
  const restored = await change(registry, { action: 'restore', name: 'my-skill' });
  assert.equal(restored.ok, true);
  assert.equal((await registry.catalog()).rows.some((row) => row.name === 'my-skill' && row.origin === 'user'), true);
});

test('identical writes are unchanged before the base check and a stale digest leaves the newer bytes', async (t) => {
  const { userRoot, registry } = await tempRegistry(t);
  const created = await change(registry, {
    action: 'create',
    name: 'edit-skill',
    description: 'First',
    body: 'First body.',
  });
  const file = path.join(userRoot, 'edit-skill', 'SKILL.md');
  const current = await fs.readFile(file);
  const before = await fs.stat(file);
  const unchanged = await change(registry, {
    action: 'write',
    name: 'edit-skill',
    path: 'SKILL.md',
    content: current.toString('utf8'),
    base: '0'.repeat(64),
  });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.digest, created.digest);
  const after = await fs.stat(file);
  assert.equal(before.mtimeMs, after.mtimeMs);

  const newer = await change(registry, {
    action: 'body',
    name: 'edit-skill',
    body: 'Second body.',
    base: created.digest,
  });
  assert.equal(newer.ok, true);
  const stale = await change(registry, {
    action: 'body',
    name: 'edit-skill',
    body: 'Third body.',
    base: created.digest,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE');
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /Second body\./);
  assert.doesNotMatch(text, /Third body\./);
});

test('import copies a harness directory verbatim and refuses a real path inside pi skills', async (t) => {
  const folded = [
    '---',
    'name: folded-skill',
    'description: >',
    '  한 주 업무를',
    '  문단으로 정리한다',
    'extra: keep',
    'metadata:',
    '  rhwp:',
    '    icon: pencil',
    '---',
    '',
    '본문입니다.',
    '',
  ].join('\n');
  const { temp, userRoot, registry } = await tempRegistry(t);
  const harness = path.join(temp, 'harness');
  await fs.mkdir(path.join(harness, 'folded-skill'), { recursive: true });
  await fs.writeFile(path.join(harness, 'folded-skill', 'SKILL.md'), folded);
  await fs.writeFile(path.join(harness, 'folded-skill', 'notes.txt'), '같은 바이트\n');
  registry.harnessRoots = { cursor: harness };
  const imported = await change(registry, {
    action: 'import',
    harness: 'cursor',
    name: 'folded-skill',
    mode: 'adopt',
  });
  assert.equal(imported.ok, true);
  assert.equal(await fs.readFile(path.join(userRoot, 'folded-skill', 'SKILL.md'), 'utf8'), folded);
  assert.equal(await fs.readFile(path.join(userRoot, 'folded-skill', 'notes.txt'), 'utf8'), '같은 바이트\n');
  assert.equal(projectSkillMarkdown(folded).icon, 'pencil');
  const again = await change(registry, {
    action: 'import',
    harness: 'cursor',
    name: 'folded-skill',
    mode: 'adopt',
  });
  assert.equal(again.unchanged, true);

  const blocked = path.join(temp, 'agent', 'pi', 'skills', 'hidden-skill');
  await fs.mkdir(blocked, { recursive: true });
  await fs.writeFile(path.join(blocked, 'SKILL.md'), MARKDOWN('hidden-skill'));
  const blockedRegistry = await new SkillRegistry({
    bundledRoot: path.join(temp, 'agent', 'skills'),
    userRoot: path.join(temp, 'blocked-user'),
    home: path.join(temp, 'home'),
    harnessRoots: { cursor: path.join(temp, 'agent', 'pi', 'skills') },
  }).init();
  const refused = await change(blockedRegistry, {
    action: 'import',
    harness: 'cursor',
    name: 'hidden-skill',
    mode: 'adopt',
  });
  assert.equal(refused.ok, false);
  assert.equal(await pathExists(path.join(temp, 'blocked-user', 'hidden-skill')), false);
});

test('SkillRegistry rejects traversal and bundled creates', async (t) => {
  const { bundledRoot, registry } = await tempRegistry(t, {
    bundled: { starter: { 'SKILL.md': MARKDOWN('starter') } },
  });
  assert.throws(() => registry.parseChange({
    action: 'write',
    name: 'escape-test',
    path: '../outside.txt',
    content: 'no',
    base: 'a'.repeat(64),
  }), /escapes its folder/);
  const overwritten = await change(registry, {
    action: 'create',
    name: 'starter',
    description: 'Replacement',
    body: 'Replacement body.',
  });
  assert.equal(overwritten.ok, false);
  assert.equal(overwritten.code, 'EXISTS');
  assert.match(await fs.readFile(path.join(bundledRoot, 'starter', 'SKILL.md'), 'utf8'), /representative testing/);
});

test('init recovers a ready staging directory and restores a backup when staging is incomplete', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-skill-journal-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const userRoot = path.join(temp, 'user');
  const bundledRoot = path.join(temp, 'bundled');
  await fs.mkdir(bundledRoot, { recursive: true });
  const staging = path.join(userRoot, '.staging', 'recover-id');
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, 'SKILL.md'), MARKDOWN('recover-skill', 'Recovered body'));
  await fs.writeFile(`${staging}.ready`, '');
  await fs.mkdir(userRoot, { recursive: true });
  await fs.writeFile(path.join(userRoot, '.commit.json'), `${JSON.stringify({
    name: 'recover-skill',
    staging,
    backup: null,
  })}\n`);
  await new SkillRegistry({ bundledRoot, userRoot, home: path.join(temp, 'home') }).init();
  assert.match(await fs.readFile(path.join(userRoot, 'recover-skill', 'SKILL.md'), 'utf8'), /Recovered body/);
  assert.equal(await pathExists(path.join(userRoot, '.commit.json')), false);

  const backup = path.join(userRoot, '.trash', 'deleted', `1-${'a'.repeat(8)}-4000-8000-8000-${'b'.repeat(12)}-backup-skill`);
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'SKILL.md'), MARKDOWN('backup-skill', 'Backup body'));
  const incomplete = path.join(userRoot, '.staging', 'incomplete');
  await fs.mkdir(incomplete, { recursive: true });
  await fs.writeFile(path.join(userRoot, '.commit.json'), `${JSON.stringify({
    name: 'backup-skill',
    staging: incomplete,
    backup,
  })}\n`);
  await new SkillRegistry({ bundledRoot, userRoot, home: path.join(temp, 'home') }).init();
  assert.match(await fs.readFile(path.join(userRoot, 'backup-skill', 'SKILL.md'), 'utf8'), /Backup body/);
  assert.equal(await pathExists(path.join(userRoot, '.commit.json')), false);
});

function failOnceRename() {
  let failed = false;
  return async (from, to) => {
    if (!failed) {
      failed = true;
      throw Object.assign(new Error('busy'), { code: 'EPERM' });
    }
    return fs.rename(from, to);
  };
}

test('SkillRegistry retries a briefly locked Windows skill replace', async (t) => {
  const { registry } = await tempRegistry(t, { platform: 'win32', lockRetryDelays: [0] });
  const created = await change(registry, {
    action: 'create',
    name: 'locked-skill',
    description: 'Original version',
    body: 'Original body.',
  });
  registry.fileOperations.rename = failOnceRename();
  const replaced = await change(registry, {
    action: 'body',
    name: 'locked-skill',
    body: 'Replacement body.',
    base: created.digest,
  });
  assert.equal(replaced.ok, true);
  assert.match((await registry.readResource('locked-skill')).content, /Replacement body/);
  assert.doesNotMatch((await registry.readResource('locked-skill')).content, /Original body/);
});

test('SkillRegistry retries a briefly locked Windows skill delete', async (t) => {
  const { registry } = await tempRegistry(t, { platform: 'win32', lockRetryDelays: [0] });
  const created = await change(registry, {
    action: 'create',
    name: 'locked-skill',
    description: 'Original version',
    body: 'Original body.',
  });
  registry.fileOperations.rename = failOnceRename();
  const deleted = await change(registry, { action: 'delete', name: 'locked-skill', base: created.digest });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.name, 'locked-skill');
  assert.equal((await registry.catalog()).rows.some((row) => row.name === 'locked-skill'), false);
});

test('SkillRegistry serializes concurrent catalog mutations and recovers Windows state', async (t) => {
  const { registry, bundledRoot, userRoot } = await tempRegistry(t, { platform: 'win32' });
  await Promise.all([
    change(registry, { action: 'create', name: 'first-skill', description: 'First', body: 'First body.' }),
    change(registry, { action: 'create', name: 'second-skill', description: 'Second', body: 'Second body.' }),
  ]);
  await Promise.all([
    change(registry, { action: 'enable', name: 'first-skill', enabled: false }),
    change(registry, { action: 'enable', name: 'second-skill', enabled: false }),
  ]);
  let catalog = await registry.catalog();
  assert.equal(catalog.rows.find((row) => row.name === 'first-skill').enabled, false);
  assert.equal(catalog.rows.find((row) => row.name === 'second-skill').enabled, false);

  await fs.rename(registry.statePath, `${registry.statePath}.previous-write`);
  const recovered = await new SkillRegistry({ bundledRoot, userRoot, platform: 'win32', home: path.join(path.dirname(userRoot), 'home') }).init();
  catalog = await recovered.catalog();
  assert.equal(catalog.rows.find((row) => row.name === 'first-skill').enabled, false);
  assert.equal(catalog.rows.find((row) => row.name === 'second-skill').enabled, false);
});

test('corrupt or oversized catalog state fails closed without re-enabling or rewriting skills', async (t) => {
  const { registry, userRoot } = await tempRegistry(t, {
    user: {
      'scripted-skill': {
        'SKILL.md': MARKDOWN('scripted-skill'),
        'scripts/run.js': 'process.exit(0)',
      },
    },
  });
  const statePath = path.join(userRoot, '.catalog-state.json');
  await fs.writeFile(statePath, '{"disabled":["scripted-skill"]}\n');
  assert.equal((await registry.catalog()).rows.find((row) => row.name === 'scripted-skill').enabled, false);

  const corrupt = '{"disabled":';
  await fs.writeFile(statePath, corrupt);
  await assert.rejects(() => registry.catalog(), (error) => error.code === 'SKILL_STATE_CORRUPT');
  await assert.rejects(
    () => change(registry, { action: 'enable', name: 'scripted-skill', enabled: true }),
    (error) => error.code === 'SKILL_STATE_CORRUPT',
  );
  assert.equal(await fs.readFile(statePath, 'utf8'), corrupt);

  await fs.writeFile(statePath, JSON.stringify({ disabled: ['scripted-skill'], padding: 'x'.repeat(70 * 1024) }));
  await assert.rejects(
    () => new SkillRegistry({
      bundledRoot: path.join(path.dirname(userRoot), 'bundled'),
      userRoot,
      home: path.join(path.dirname(userRoot), 'home'),
    }).init(),
    (error) => error.code === 'SKILL_STATE_CORRUPT',
  );
});

test('disabled-skill state never writes past its cap and deletion removes stale state', async (t) => {
  const { registry } = await tempRegistry(t);
  const created = await change(registry, {
    action: 'create',
    name: 'cap-target',
    description: 'Cap',
    body: 'Cap body.',
  });
  const disabled = Array.from({ length: 1_000 }, (_, index) => `ghost-${String(index).padStart(4, '0')}`);
  const originalState = `${JSON.stringify({ disabled }, null, 2)}\n`;
  await fs.writeFile(registry.statePath, originalState);

  const capped = await change(registry, { action: 'enable', name: 'cap-target', enabled: false });
  assert.equal(capped.ok, false);
  assert.equal(capped.code, 'SKILL_STATE_TOO_LARGE');
  assert.equal(await fs.readFile(registry.statePath, 'utf8'), originalState);

  await fs.writeFile(registry.statePath, '{"disabled":["cap-target"]}\n');
  const deleted = await change(registry, { action: 'delete', name: 'cap-target', base: created.digest });
  assert.equal(deleted.ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(registry.statePath, 'utf8')), { disabled: [] });
  assert.equal((await registry.catalog()).rows.some((row) => row.name === 'cap-target'), false);
});

test('promptContext appends provider tool notes only for a known activated agent', async (t) => {
  const { registry } = await tempRegistry(t, {
    bundled: { starter: { 'SKILL.md': MARKDOWN('starter') } },
  });

  const claude = await registry.promptContext('복사', 'starter', { agent: 'claude' });
  assert.match(claude, /<provider_tool_notes agent="claude">/);
  assert.match(claude, /never poll or wait for them/);
  assert.match(claude, /<activated_product_skill name="starter"/);
  assert.doesNotMatch(claude, /<rhwp_product_skills[^>]*revision=/);

  const pi = await registry.promptContext('복사', 'starter', { agent: 'pi' });
  assert.match(pi, /<provider_tool_notes agent="pi">/);
  assert.match(pi, /subagent_spawn\/subagent_wait\/subagent_check\/subagent_list\/subagent_cancel/);
  assert.match(pi, /Background hub jobs .* are not collaboration agents/);

  const noSkill = await registry.promptContext('복사', undefined, { agent: 'claude' });
  assert.doesNotMatch(noSkill, /provider_tool_notes/);
  const neutral = await registry.promptContext('복사', 'starter');
  assert.doesNotMatch(neutral, /provider_tool_notes/);
  const unknown = await registry.promptContext('복사', 'starter', { agent: 'mystery' });
  assert.doesNotMatch(unknown, /provider_tool_notes/);
});

async function pathExists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

const backendOpts = {
  rootDir: '/tmp/rhwp', isolatedHome: '/tmp/rhwp-home',
  mcpScriptPath: '/tmp/mcp-stdio.mjs', hubPort: 5175, token: 'token', model: 'test', effort: 'high', onEvent() {},
};

test('Claude safe profile exposes core tools with sandbox and disables native skills', () => {
  const argv = buildClaudeArgv({ ...backendOpts, permissionProfile: 'safe' }, '00000000-0000-4000-8000-000000000000', false);
  assert.ok(argv.includes('Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch,Agent,Workflow'));
  assert.ok(argv.includes('--disable-slash-commands'));
  assert.ok(argv.includes('--setting-sources'));
  assert.ok(argv.includes('dontAsk'));
  const settings = argv[argv.indexOf('--settings') + 1];
  assert.match(settings, /"enabled":true/);
  assert.match(settings, /"Bash"/);
  assert.match(settings, /Write/);
});

test('Claude unrestricted and Codex profiles change only the permission boundary', () => {
  const claude = buildClaudeArgv({ ...backendOpts, permissionProfile: 'unrestricted' }, '00000000-0000-4000-8000-000000000000', true);
  assert.ok(claude.includes('bypassPermissions'));
  assert.ok(claude.includes('--dangerously-skip-permissions'));
  const safeCodex = buildCodexArgv({ ...backendOpts, permissionProfile: 'safe' }, null);
  const fullCodex = buildCodexArgv({ ...backendOpts, permissionProfile: 'unrestricted' }, 'thread');
  assert.ok(safeCodex.includes('sandbox_mode="workspace-write"'));
  assert.ok(safeCodex.includes('mcp_servers.rhwp.default_tools_approval_mode="auto"'));
  assert.ok(fullCodex.includes('sandbox_mode="danger-full-access"'));
  assert.ok(fullCodex.includes('mcp_servers.rhwp.default_tools_approval_mode="auto"'));
  assert.ok(safeCodex.includes('--ignore-user-config'));
  assert.ok(safeCodex.includes('skill_search'));
  assert.equal(safeCodex.includes('service_tier="fast"'), false);
  const fastCodex = buildCodexArgv({ ...backendOpts, permissionProfile: 'safe', serviceTier: 'fast' }, null);
  assert.ok(fastCodex.includes('service_tier="fast"'));
});

test('Claude sandbox startup errors are surfaced without leaking the hub token', () => {
  const message = formatClaudeExitError('sandbox unavailable for token', 1, null, 'token');
  assert.match(message, /sandbox unavailable/);
  assert.doesNotMatch(message, /for token/);
  assert.match(message, /\[redacted\]/);
});


test('inline skill editing preserves metadata and rejects stale saves and read-only skills', async (t) => {
  const { registry, userRoot } = await tempRegistry(t, {
    bundled: { bundled: { 'SKILL.md': MARKDOWN('bundled') } },
    user: { legacy: { 'SKILL.md': MARKDOWN('legacy') } },
  });
  const created = await change(registry, {
    action: 'create', name: 'editable', description: 'Keep this description.',
    body: 'Original instructions.', icon: 'book',
  });
  assert.equal(created.ok, true);
  const before = await registry.readEditor('editable');
  assert.equal(before.body, 'Original instructions.');
  const saved = await registry.saveEditor('editable', 'Updated instructions.', before.digest);
  assert.equal(saved.ok, true);
  assert.equal((await registry.readEditor('editable')).body, 'Updated instructions.');
  const markdown = await fs.readFile(path.join(userRoot, 'editable', 'SKILL.md'), 'utf8');
  assert.deepEqual(projectSkillMarkdown(markdown), {
    name: 'editable', description: 'Keep this description.', icon: 'book',
  });
  const stale = await registry.saveEditor('editable', 'Stale overwrite.', before.digest);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE');
  assert.equal((await registry.readEditor('editable')).body, 'Updated instructions.');
  for (const name of ['bundled', 'legacy']) {
    await assert.rejects(() => registry.readEditor(name), { code: 'SKILL_NOT_EDITABLE' });
    assert.equal((await registry.saveEditor(name, 'Forbidden overwrite.', before.digest)).ok, false);
  }
});

test('changing a skill icon preserves its body and checks the current digest', async (t) => {
  const { registry } = await tempRegistry(t);
  const created = await change(registry, {
    action: 'create', name: 'icon-skill', description: 'An icon test.', body: 'Keep these instructions.',
  });
  const changed = await change(registry, {
    action: 'icon', name: 'icon-skill', icon: 'shield', base: created.digest,
  });
  assert.equal(changed.ok, true);
  assert.equal((await registry.catalog()).rows.find((row) => row.name === 'icon-skill').icon, 'shield');
  assert.equal((await registry.readEditor('icon-skill')).body, 'Keep these instructions.');
  const stale = await change(registry, {
    action: 'icon', name: 'icon-skill', icon: 'heart', base: created.digest,
  });
  assert.equal(stale.code, 'STALE');
});
