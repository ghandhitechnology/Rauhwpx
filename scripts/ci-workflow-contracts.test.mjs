import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const pullRequestWorkflows = [
  '.github/workflows/desktop-packages.yml',
  '.github/workflows/desktop-sessions.yml',
  '.github/workflows/roundtrip-sweep.yml',
  '.github/workflows/security-gates.yml',
];

test('pull-request workflows never receive Browserbase live credentials', () => {
  for (const path of pullRequestWorkflows) {
    const workflow = read(path);
    assert.match(workflow, /^\s*pull_request:\s*$/m, `${path} must remain a pull-request check`);
    assert.doesNotMatch(workflow, /BROWSERBASE_API_KEY|BROWSERBASE_PROJECT_ID|GEMINI_API_KEY/);
    assert.doesNotMatch(workflow, /test:browserbase:live/);
  }
});

test('nightly and tagged releases require three fresh Browserbase sessions', () => {
  for (const path of ['.github/workflows/nightly-release.yml', '.github/workflows/release.yml']) {
    const workflow = read(path);
    assert.match(workflow, /name: Browserbase Stagehand live smoke/);
    assert.match(workflow, /name: Require Browserbase live-test secrets/);
    assert.match(workflow, /name: Run three fresh Stagehand sessions/);
    assert.match(workflow, /test:browserbase:live/);
    assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m);
  }

  const smoke = read('rhwp/rhwp-agent/tests/browserbase-live-smoke.mjs');
  assert.match(smoke, /for \(let cycle = 1; cycle <= 3; cycle \+= 1\)/);
});

test('only release publisher jobs receive a write-capable GitHub token', () => {
  for (const path of ['.github/workflows/nightly-release.yml', '.github/workflows/release.yml']) {
    const workflow = read(path);
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.match(
      workflow,
      /^  publish:\n[\s\S]*?^    permissions:\n      contents: write$/m,
      `${path} must grant release writes only to its publish job`,
    );
    assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  }
});

test('nightly replacement does not ignore release deletion failures', () => {
  const workflow = read('.github/workflows/nightly-release.yml');
  assert.match(workflow, /existing_release_id=.*[\s\S]*gh api --method DELETE/);
  assert.doesNotMatch(workflow, /gh release delete nightly[^\n]*\|\| true/);
});

test('nightly packaging requires a successful completed verification for the exact SHA', () => {
  const workflow = read('.github/workflows/nightly-release.yml');
  assert.equal((workflow.match(/actions: read/g) ?? []).length, 1);
  assert.match(
    workflow,
    /^  verification-gate:\n[\s\S]*?^    permissions:\n      actions: read$/m,
  );
  assert.match(workflow, /actions\/workflows\/nightly\.yml\/runs\?head_sha=\$\{GITHUB_SHA\}&status=completed/);
  assert.match(workflow, /\.head_sha == \\\"\$\{GITHUB_SHA\}\\\"/);
  assert.match(workflow, /\.status == \\\"completed\\\"/);
  assert.match(workflow, /\.conclusion == \\\"success\\\"/);
  assert.match(workflow, /^  prepare:\n[\s\S]*?^    needs: verification-gate$/m);
  assert.match(workflow, /^  browserbase-live:\n[\s\S]*?^    needs: prepare$/m);
  assert.match(workflow, /^  macos:\n[\s\S]*?^    needs: \[prepare, browserbase-live\]$/m);
  assert.match(workflow, /^  windows:\n[\s\S]*?^    needs: \[prepare, browserbase-live\]$/m);
});

test('third-party Rust toolchain actions are pinned to immutable commits', () => {
  const workflows = [
    '.github/workflows/desktop-packages.yml',
    '.github/workflows/desktop-sessions.yml',
    '.github/workflows/nightly-release.yml',
    '.github/workflows/nightly.yml',
    '.github/workflows/release.yml',
    '.github/workflows/roundtrip-sweep.yml',
    '.github/workflows/security-gates.yml',
  ];
  for (const path of workflows) {
    const references = [...read(path).matchAll(/uses: dtolnay\/rust-toolchain@([^\s#]+)/g)];
    assert.ok(references.length > 0, `${path} must install Rust through the pinned action`);
    for (const [, reference] of references) assert.match(reference, /^[0-9a-f]{40}$/);
  }
});

test('pull requests build and inspect both supported desktop packages', () => {
  const workflow = read('.github/workflows/desktop-packages.yml');
  assert.match(workflow, /os: macos-15[\s\S]*architecture: arm64/);
  assert.match(workflow, /os: windows-latest[\s\S]*architecture: x64/);
  assert.match(workflow, /npm run verify:package/);
  assert.match(workflow, /verify-release-artifacts\.mjs/);
  assert.match(workflow, /Build unsigned Windows test installer/);
  assert.match(workflow, /Build unsigned macOS test packages/);
  assert.match(workflow, /Verify Windows installer is unsigned by design/);
});

test('Rust audits fail on new warnings while keeping known debt visible', () => {
  const workflows = [
    '.github/workflows/security-gates.yml',
    '.github/workflows/nightly.yml',
    '.github/workflows/nightly-release.yml',
    '.github/workflows/release.yml',
  ];
  const knownWarnings = [
    'RUSTSEC-2026-0192',
    'RUSTSEC-2026-0206',
  ];

  for (const path of workflows) {
    const workflow = read(path);
    assert.match(workflow, /cargo audit\s*$/m);
    assert.match(workflow, /cargo audit --no-fetch -D warnings/);
    for (const advisory of knownWarnings) assert.match(workflow, new RegExp(advisory));
  }
});
