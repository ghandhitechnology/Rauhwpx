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
  assert.match(parsed.description, /titles, labels, headers, instructions/);
  assert.match(parsed.description, /user-added content/);
  assert.match(markdown, /scripts\/copy_layout\.py/);
  assert.match(markdown, /Owning chat: delegate immediately/);
  assert.match(markdown, /immediately pass its exact `documentId`, `digest`/);
  assert.match(markdown, /`delegate_copy_layout` starts a fresh independent provider session\/process/);
  assert.match(markdown, /There is no pre-execution confirmation/);
  assert.match(markdown, /main chat stays responsive/);
  assert.match(markdown, /normal session\/fleet task protocol/);
  assert.match(markdown, /not a provider-native subagent/);
  assert.match(markdown, /do not call `wait_agent`, `list_agents`, poll tools/);
  assert.match(markdown, /hub will automatically start a new turn in this same owning chat/);
  assert.match(markdown, /Dedicated worker: immutable source and bounded autonomy/);
  assert.match(markdown, /Always call `materialize_document_snapshot`/);
  assert.match(markdown, /complete paragraph inventory/);
  assert.match(markdown, /every media use/);
  assert.match(markdown, /three collision-free candidates/);
  assert.match(markdown, /verified convergence/);
  assert.match(markdown, /bounded-no-improvement/);
  assert.match(markdown, /native HWP→HWPX→HWP pipeline/);
  assert.match(markdown, /call `get_document_info` once and immediately pass/);
  assert.match(markdown, /Never search the filesystem/);
  assert.match(markdown, /call `materialize_document_snapshot`/);
  assert.match(markdown, /publish exactly one successful final candidate/i);
  assert.match(markdown, /Preview\/PrvText\.txt/);
  assert.match(markdown, /Preview\/PrvImage\.png/);
  assert.match(markdown, /Do not open it automatically/);
  assert.match(markdown, /`\[템플릿 미리보기\]\(<artifact\.downloadUrl>\)`/);
  assert.match(markdown, /only a user click opens the artifact/);
  assert.match(markdown, /ask exactly one final question/);
  assert.match(markdown, /`register_copy_layout_template`/);
  assert.match(markdown, /artifact card remains available/);
  assert.match(markdown, /Hard safety\/readability gates/);
  assert.match(markdown, /publish nothing and complete the job as failed/);
  assert.match(markdown, /safe and readable candidate may complete as `best_effort`/);
  assert.match(markdown, /Never use Bash, a shell, Python/);
  assert.match(markdown, /`run_copy_layout_helper`/);
  assert.match(markdown, /`action: "inspect"`/);
  assert.match(markdown, /`action: "generate"`/);
  assert.match(markdown, /"default": "keep"/);
  assert.match(markdown, /`text_decisions\.kept`/);
  assert.match(markdown, /preserve-by-default policy/);
});

test('copy-layout helper retains safety gates and reports fidelity separately', () => {
  const script = readFileSync(scriptUrl, 'utf8');

  assert.doesNotMatch(script, /\blxml\b/);
  assert.match(script, /xml\.etree\.ElementTree/);
  assert.match(script, /unsafe XML declaration/);
  assert.match(script, /visible text remains/);
  assert.match(script, /layout geometry fingerprint changed/);
  assert.match(script, /refusing to overwrite the source document/);
  assert.match(script, /PAYLOAD_PREFIXES/);
  assert.match(script, /export-hwpx/);
  assert.match(script, /native output introduced or changed generated layout text/);
  assert.match(script, /render-diff/);
  assert.match(script, /fallback_reason/);
  assert.match(script, /"quality": "best_effort" if delivery_warnings else "verified"/);
  assert.match(script, /--rhwp-bin/);
  assert.match(script, /--preserve-guidance/);
  assert.match(script, /--inspect-text/);
  assert.match(script, /--text-plan/);
  assert.match(script, /source_sha256/);
  assert.match(script, /visible text differs from approved guidance/);
  assert.match(script, /LAYOUT_ANCHOR = "\\u2060"/);
  assert.match(script, /zero-width layout anchors/);
  assert.match(script, /PUBLISHABLE_PREVIEW_ENTRIES/);
});

test('copy-layout helper runs without site packages and defers only an intermediate page-count mismatch', (t) => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const availability = spawnSync(python, ['-S', '-c', 'import sys'], { encoding: 'utf8' });
  if (availability.error?.code === 'ENOENT') {
    t.skip('Python is unavailable');
    return;
  }
  assert.equal(availability.status, 0, availability.stderr || availability.stdout);
  const result = spawnSync(python, ['-S', fileURLToPath(helperTestUrl)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran \d+ tests/);
  assert.match(result.stderr, /OK/);
});
