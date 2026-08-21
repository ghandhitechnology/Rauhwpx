import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseSkillMarkdown } from '../skills.mjs';

const markdownUrl = new URL('../skills/copy-layout/SKILL.md', import.meta.url);
const scriptUrl = new URL('../skills/copy-layout/scripts/copy_layout.py', import.meta.url);

test('bundled copy-layout skill is a valid explicit slash-command skill', () => {
  const markdown = readFileSync(markdownUrl, 'utf8');
  const parsed = parseSkillMarkdown(markdown, 'copy-layout');

  assert.equal(parsed.name, 'copy-layout');
  assert.match(parsed.description, /HWP or HWPX/);
  assert.match(parsed.description, /content-free template/);
  assert.match(markdown, /scripts\/copy_layout\.py/);
  assert.match(markdown, /<source stem> - Layout\.hwp/);
  assert.match(markdown, /native HWP→HWPX→HWP pipeline/);
  assert.match(markdown, /call `get_document_info` first/);
  assert.match(markdown, /never search the filesystem/);
  assert.match(markdown, /When `sourcePath` is non-null, use it directly/);
  assert.match(markdown, /do not ask the user to attach or identify the file again/);
});

test('copy-layout helper retains its privacy and geometry verification gates', () => {
  const script = readFileSync(scriptUrl, 'utf8');

  assert.match(script, /visible text remains/);
  assert.match(script, /layout geometry fingerprint changed/);
  assert.match(script, /refusing to overwrite the source document/);
  assert.match(script, /PAYLOAD_PREFIXES/);
  assert.match(script, /export-hwpx/);
  assert.match(script, /native output introduced or changed generated layout text/);
  assert.match(script, /render-diff/);
  assert.match(script, /fallback_reason/);
  assert.match(script, /--rhwp-bin/);
});
