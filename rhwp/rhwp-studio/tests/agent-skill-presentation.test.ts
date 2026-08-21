import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  skillGlyphForName,
  skillGlyphForSkill,
  withSkillIconFrontmatter,
} from '../src/ui/agent-sidebar/skill-presentation.ts';

const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const icons = readFileSync(new URL('../src/ui/agent-sidebar/icons.ts', import.meta.url), 'utf8');

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

test('pencil, bot, and system gear are native stroke icons', () => {
  assert.match(icons, /skillEdit:/);
  assert.match(icons, /skillBot:\s*'M2\.1 3h7\.8v6H2\.1zM4 6h\.6M7\.4 6H8'/);
  assert.match(icons, /skillSystem:/);
  assert.match(icons, /name === 'skillSystem' \? '1\.35' : '1\.25'/);
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

test('the skill glyph appears in every skill surface', () => {
  assert.match(sidebar, /copyIcon\.appendChild\(createIcon\(skillGlyphForSkill\(skill\)\)\)/);
  assert.match(sidebar, /composerSkillIcon\.appendChild\(createIcon\(skillGlyphForSkill\(skill\)\)\)/);
  assert.match(sidebar, /ag-slash-skill-icon[\s\S]*skillGlyphForSkill\(\{ name: option\.skillName, icon: option\.skillIcon \}\)/);
  assert.match(sidebar, /ag-skill-token-icon[\s\S]*skillGlyphForSkill\(\{ name: message\.skillName, icon: message\.skillIcon \}\)/);
});
