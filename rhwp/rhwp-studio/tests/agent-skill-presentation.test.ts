import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { skillGlyphForName } from '../src/ui/agent-sidebar/skill-presentation.ts';

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
    assert.equal(skillGlyphForName(name), 'gear');
  }
});

test('pencil, bot, and system gear are native stroke icons', () => {
  assert.match(icons, /skillEdit:/);
  assert.match(icons, /skillBot:\s*'M2\.1 3h7\.8v6H2\.1zM4 6h\.6M7\.4 6H8'/);
  assert.match(icons, /gear:/);
});

test('the skill glyph appears in every skill surface', () => {
  assert.match(sidebar, /copyIcon\.appendChild\(createIcon\(skillGlyphForName\(skill\.name\)\)\)/);
  assert.match(sidebar, /composerSkillIcon\.appendChild\(createIcon\(skillGlyphForName\(skill\.name\)\)\)/);
  assert.match(sidebar, /ag-slash-skill-icon[\s\S]*createIcon\(skillGlyphForName\(option\.skillName\)\)/);
  assert.match(sidebar, /ag-skill-token-icon[\s\S]*createIcon\(skillGlyphForName\(message\.skillName\)\)/);
});
