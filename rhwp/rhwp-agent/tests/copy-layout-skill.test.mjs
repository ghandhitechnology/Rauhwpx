import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseSkillMarkdown } from '../skills.mjs';

const markdownUrl = new URL('../skills/copy-layout/SKILL.md', import.meta.url);
const scriptUrl = new URL('../skills/copy-layout/scripts/copy_layout.py', import.meta.url);
const helperTestUrl = new URL('./copy-layout-helper.test.py', import.meta.url);

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
  assert.match(markdown, /When `sourcePath` is non-null and `dirty` is false, use it directly/);
  assert.match(markdown, /call `materialize_document_snapshot`/);
  assert.match(markdown, /Never tell the user to save merely because `sourcePath` is null/);
  assert.match(markdown, /call `publish_artifact`/);
  assert.match(markdown, /`downloadUrl` as a Markdown download link/);
  assert.match(markdown, /do not ask the user to attach or identify the file again/);
  assert.match(markdown, /intermediate page-count mismatch is diagnostic/);
  assert.match(markdown, /not evidence that the wrong document is open/);
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

test('copy-layout helper defers only an intermediate page-count mismatch', (t) => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const dependency = spawnSync(python, ['-c', 'import lxml'], { encoding: 'utf8' });
  if (dependency.error?.code === 'ENOENT' || dependency.status !== 0) {
    t.skip('Python with lxml is unavailable');
    return;
  }
  const result = spawnSync(python, [fileURLToPath(helperTestUrl)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 2 tests/);
  assert.match(result.stderr, /OK/);
});
