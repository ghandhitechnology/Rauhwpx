import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseSkillMarkdown } from '../skills.mjs';

test('bundled fill-official-form skill fills the live open document', () => {
  const markdown = readFileSync(new URL('../skills/fill-official-form/SKILL.md', import.meta.url), 'utf8');
  const parsed = parseSkillMarkdown(markdown, 'fill-official-form');
  assert.equal(parsed.name, 'fill-official-form');
  assert.match(parsed.description, /공문|품의/);
  assert.match(markdown, /get_fields/);
  assert.match(markdown, /set_field_value/);
  assert.match(markdown, /apply_edits/);
  assert.doesNotMatch(markdown, /extract-replace on a sidecar/);
  assert.match(markdown, /HWPX/);
  assert.doesNotMatch(markdown, /Hancom|한글과컴퓨터|edwardkim/i);
});
