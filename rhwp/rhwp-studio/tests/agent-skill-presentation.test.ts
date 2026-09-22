import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  skillGlyphForName,
  skillGlyphForSkill,
} from '../src/ui/agent-sidebar/skill-presentation.ts';

const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const shelf = readFileSync(new URL('../src/ui/agent-sidebar/skills-shelf.ts', import.meta.url), 'utf8');
const presentation = readFileSync(new URL('../src/ui/agent-sidebar/skill-presentation.ts', import.meta.url), 'utf8');
const icons = readFileSync(new URL('../src/ui/agent-sidebar/icons.ts', import.meta.url), 'utf8');

test('document-writing skills use the pencil glyph', () => {
  for (const name of ['draft-document', 'proofread-korean', 'rewrite-tone']) {
    assert.equal(skillGlyphForName(name), 'pencil');
  }
});

test('internal and primarily read-only skills use the minimal bot glyph', () => {
  for (const name of ['skill-creator', 'summarize-document']) {
    assert.equal(skillGlyphForName(name), 'bot');
  }
});

test('other skills use the familiar system gear', () => {
  for (const name of ['present-plan', 'my-custom-skill']) {
    assert.equal(skillGlyphForName(name), 'system');
  }
});

test('pencil, bot, and system gear are native stroke icons', () => {
  assert.match(icons, /pencil:/);
  assert.match(icons, /bot:\s*'M2\.1 3h7\.8v6H2\.1zM4 6h\.6M7\.4 6H8'/);
  assert.match(icons, /system:/);
  assert.match(icons, /name === 'skillSystem' \? '1\.35' : '1\.25'/);
});

test('every uncategorized skill receives the system gear', () => {
  assert.equal(skillGlyphForName('future-bundled-skill'), 'system');
  assert.equal(skillGlyphForName('disabled-custom-skill'), 'system');
});

test('explicit creator icon choices override name-based defaults', () => {
  assert.equal(skillGlyphForSkill({ name: 'draft-document', icon: 'bot' }), 'bot');
  assert.equal(skillGlyphForSkill({ name: 'skill-creator', icon: 'pencil' }), 'pencil');
  assert.equal(skillGlyphForSkill({ name: 'my-skill', icon: 'system' }), 'system');
});

test('the shelf does not rewrite SKILL.md frontmatter for an icon', () => {
  assert.doesNotMatch(presentation, /function withSkillIconFrontmatter/);
  assert.doesNotMatch(sidebar, /withSkillIconFrontmatter/);
  assert.doesNotMatch(shelf, /withSkillIconFrontmatter/);
});

test('the skill glyph appears in every skill surface', () => {
  assert.match(shelf, /copyIcon\.appendChild\(createIcon\(skillGlyphForSkill\(skill\)\)\)/);
  assert.match(sidebar, /composerSkillIcon\.appendChild\(createIcon\(skillGlyphForSkill\(skill\)\)\)/);
  assert.match(sidebar, /ag-slash-skill-icon[\s\S]*skillGlyphForSkill\(\{ name: option\.skillName, icon: option\.skillIcon \}\)/);
  assert.match(sidebar, /ag-skill-token-icon[\s\S]*skillGlyphForSkill\(\{ name: message\.skillName, icon: message\.skillIcon \}\)/);
});
