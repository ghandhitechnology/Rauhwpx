import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry, parseSkillMarkdown } from '../skills.mjs';
import { buildClaudeArgv, formatClaudeExitError } from '../agents/claude.mjs';
import { buildCodexArgv } from '../agents/codex.mjs';

const MARKDOWN = (name, description = 'Use this skill for representative testing.') => `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow the requested workflow.\n`;

test('parseSkillMarkdown accepts portable frontmatter and rejects extra keys', () => {
  assert.equal(parseSkillMarkdown(MARKDOWN('good-skill')).name, 'good-skill');
  const windowsMarkdown = `\uFEFF${MARKDOWN('windows-skill').replace(/\n/g, '\r\n')}`;
  assert.deepEqual(parseSkillMarkdown(windowsMarkdown), {
    name: 'windows-skill',
    description: 'Use this skill for representative testing.',
    body: 'Follow the requested workflow.',
  });
  assert.throws(() => parseSkillMarkdown('---\nname: bad\ndescription: x\nfoo: bar\n---\n\nDo it.\n'), /only name and description/);
  assert.throws(() => parseSkillMarkdown(MARKDOWN('skill-create')), /reserved/);
});

test('bundled present-plan skill ends planning through the structured presentation tool', async (t) => {
  const markdown = readFileSync(new URL('../skills/present-plan/SKILL.md', import.meta.url), 'utf8');
  assert.equal(parseSkillMarkdown(markdown, 'present-plan').name, 'present-plan');
  assert.match(markdown, /present_implementation_plan/);
  assert.match(markdown, /chat action that opens the plan review sidebar/);

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-required-skill-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const bundledRoot = path.join(temp, 'bundled');
  await fs.mkdir(path.join(bundledRoot, 'present-plan'), { recursive: true });
  await fs.writeFile(path.join(bundledRoot, 'present-plan', 'SKILL.md'), markdown);
  const registry = await new SkillRegistry({ bundledRoot, userRoot: path.join(temp, 'user') }).init();
  const skill = (await registry.list()).skills.find((item) => item.name === 'present-plan');
  assert.equal(skill.required, true);
  assert.equal(skill.enabled, true);
  await assert.rejects(() => registry.setEnabled('present-plan', false), /required by the planning workflow/);
});

test('SkillRegistry saves, disables, reads, and recoverably deletes user skills', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-skills-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const bundledRoot = path.join(temp, 'bundled');
  const userRoot = path.join(temp, 'user');
  await fs.mkdir(path.join(bundledRoot, 'starter'), { recursive: true });
  await fs.writeFile(path.join(bundledRoot, 'starter', 'SKILL.md'), MARKDOWN('starter'));
  const registry = await new SkillRegistry({ bundledRoot, userRoot }).init();

  const payload = { name: 'my-skill', files: [
    { path: 'SKILL.md', content: MARKDOWN('my-skill') },
    { path: 'scripts/check.js', content: 'process.stdout.write("ok")' },
  ] };
  const validation = await registry.validate(payload);
  assert.equal(validation.valid, true);
  assert.equal(validation.hasScripts, true);
  assert.equal(validation.warnings.length, 1);
  await registry.save(payload);
  let catalog = await registry.list();
  assert.deepEqual(catalog.skills.map((skill) => skill.name), ['starter', 'my-skill']);
  assert.equal(catalog.skills.find((skill) => skill.name === 'my-skill').hasScripts, true);

  await registry.setEnabled('my-skill', false);
  catalog = await registry.list();
  assert.equal(catalog.skills.find((skill) => skill.name === 'my-skill').enabled, false);
  const detail = await registry.read('my-skill');
  assert.equal(detail.skill.files.find((file) => file.path === 'SKILL.md').encoding, 'utf8');
  await assert.rejects(() => registry.readResource('my-skill'), /disabled/);
  await registry.setEnabled('my-skill', true);
  assert.match((await registry.readResource('my-skill')).content, /name: my-skill/);
  await assert.rejects(() => registry.readResource('my-skill', '../outside.txt'), /escapes its folder/);

  const deleted = await registry.delete('my-skill');
  assert.equal(deleted.recoverable, true);
  assert.equal((await registry.list()).skills.some((skill) => skill.name === 'my-skill'), false);
  assert.ok((await fs.readdir(path.join(userRoot, '.trash'))).some((name) => name.endsWith('-my-skill')));
});

test('SkillRegistry rejects traversal and bundled overwrites', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-skills-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const bundledRoot = path.join(temp, 'bundled');
  await fs.mkdir(path.join(bundledRoot, 'starter'), { recursive: true });
  await fs.writeFile(path.join(bundledRoot, 'starter', 'SKILL.md'), MARKDOWN('starter'));
  const registry = await new SkillRegistry({ bundledRoot, userRoot: path.join(temp, 'user') }).init();
  await assert.rejects(() => registry.save({ name: 'escape-test', files: [
    { path: 'SKILL.md', content: MARKDOWN('escape-test') },
    { path: '../outside.txt', content: 'no' },
  ] }), /escapes its folder/);
  await assert.rejects(() => registry.save({ name: 'starter', files: [{ path: 'SKILL.md', content: MARKDOWN('starter') }] }), /cannot be overwritten/);
});

const backendOpts = {
  rootDir: '/tmp/rhwp', isolatedHome: '/tmp/rhwp-home',
  mcpScriptPath: '/tmp/mcp-stdio.mjs', hubPort: 5175, token: 'token', model: 'test', effort: 'high', onEvent() {},
};

test('Claude safe profile exposes core tools with sandbox and disables native skills', () => {
  const argv = buildClaudeArgv({ ...backendOpts, permissionProfile: 'safe' }, '00000000-0000-4000-8000-000000000000', false);
  assert.ok(argv.includes('Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch'));
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
});

test('Claude sandbox startup errors are surfaced without leaking the hub token', () => {
  const message = formatClaudeExitError('sandbox unavailable for token', 1, null, 'token');
  assert.match(message, /sandbox unavailable/);
  assert.doesNotMatch(message, /for token/);
  assert.match(message, /\[redacted\]/);
});
