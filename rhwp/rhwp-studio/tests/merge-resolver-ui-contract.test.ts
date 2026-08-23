import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/merge/merge-resolver-window.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/merge/merge-resolver.css', import.meta.url), 'utf8');

test('resolver exposes all four mandatory previews and unambiguous merge direction', () => {
  assert.match(source, /\['base', 'current', 'incoming', 'result'\]/);
  assert.match(source, /sourceBranch} → \${options\.currentBranch/);
  assert.match(source, /All clean changes are included/);
});

test('resolver contract includes keyboard, accessibility, validation and explicit discard safeguards', () => {
  assert.match(source, /aria-live/);
  assert.match(source, /event\.key\.toLowerCase\(\) === 'z'/);
  assert.match(source, /window\.confirm\('Discard this merge draft/);
  assert.match(source, /this\.validation\?\.valid/);
  assert.match(source, /conflict\.supportsBoth/);
  assert.match(source, /Unresolved only/);
  assert.match(source, /Filter conflicts by path or type/);
  assert.match(source, /aria-controls/);
  assert.match(source, /configureTabPanel/);
  assert.match(source, /details\.append\(summary, groupActions\)/);
  assert.doesNotMatch(source, /summary\.appendChild\(groupActions\)/);
  assert.match(source, /base64 image bytes/);
  assert.match(source, /This value is atomic/);
});

test('completion applies before prompting and retries only source finalization', () => {
  const start = source.indexOf('private async confirmCompletion');
  const end = source.indexOf('private requestSourceDisposition', start);
  const completion = source.slice(start, end);
  assert.ok(completion.indexOf('complete(application!') < completion.indexOf('requestSourceDisposition()'));
  assert.ok(completion.indexOf('requestSourceDisposition()') < completion.indexOf('finalizeSourceDisposition'));
  assert.match(completion, /this\.completion\.ensureApplied/);
  assert.match(completion, /this\.completion\.finalize/);
  assert.match(source, /Safely finalizing the applied merge/);
  assert.match(source, /finish\('keep'\)/);
  assert.match(source, /resolverRoot\.inert = true/);
  assert.match(source, /resolverRoot\.inert = false/);
});

test('narrow layouts switch from the grid to preview tabs', () => {
  assert.match(css, /@media \(max-width: 1180px\)/);
  assert.match(css, /\.merge-preview-pane\.is-active/);
  assert.match(css, /grid-template: repeat\(2, minmax\(0, 1fr\)\) \/ repeat\(2/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.merge-resolver-body\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.doesNotMatch(css, /(?:^|\n)button:disabled\s*\{/);
});
