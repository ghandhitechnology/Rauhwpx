import assert from 'node:assert/strict';
import test from 'node:test';

import { skillGlyphForName, skillGlyphForSkill, withSkillIconFrontmatter } from '../src/ui/agent-sidebar/skill-presentation.ts';

test('document-writing skills use the pencil glyph', () => {
  for (const name of ['draft-document', 'proofread-korean', 'rewrite-tone']) {
    assert.equal(skillGlyphForName(name), 'skillEdit');
  }
});

test('internal and primarily read-only skills use the minimal bot glyph', () => {
  for (const name of ['skill-creator', 'summarize-document']) {
    assert.equal(skillGlyphForName(name), 'skillBot');
  }
});

test('other skills use the familiar system gear', () => {
  for (const name of ['present-plan', 'my-custom-skill']) {
    assert.equal(skillGlyphForName(name), 'skillSystem');
  }
});

test('every uncategorized skill receives the system gear', () => {
  assert.equal(skillGlyphForName('future-bundled-skill'), 'skillSystem');
  assert.equal(skillGlyphForName('disabled-custom-skill'), 'skillSystem');
});

test('explicit creator icon choices override name-based defaults', () => {
  assert.equal(skillGlyphForSkill({ name: 'draft-document', icon: 'bot' }), 'skillBot');
  assert.equal(skillGlyphForSkill({ name: 'skill-creator', icon: 'pencil' }), 'skillEdit');
  assert.equal(skillGlyphForSkill({ name: 'my-skill', icon: 'system' }), 'skillSystem');
});

test('icon selection is inserted into or updates SKILL.md frontmatter', () => {
  const markdown = '---\nname: my-skill\ndescription: Test\n---\n\nDo it.\n';
  assert.match(withSkillIconFrontmatter(markdown, 'pencil'), /description: Test\nicon: pencil\n---/);
  assert.match(withSkillIconFrontmatter(withSkillIconFrontmatter(markdown, 'pencil'), 'bot'), /icon: bot/);
  const windows = markdown.replace(/\n/g, '\r\n');
  assert.match(withSkillIconFrontmatter(windows, 'system'), /description: Test\r\nicon: system\r\n---/);
  assert.equal(withSkillIconFrontmatter('No frontmatter', 'system'), 'No frontmatter');
});
