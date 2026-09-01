import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function matrixIncludes(workflow) {
  const marker = '      matrix:\n        include:\n';
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, 'workflow matrix include block is missing');
  const end = workflow.indexOf('    runs-on:', start);
  assert.ok(end > start, 'workflow matrix include block is not bounded by runs-on');
  const entries = [];
  let current = null;
  for (const line of workflow.slice(start + marker.length, end).split('\n')) {
    const first = /^          - ([a-z_]+):\s*(\S.*)$/.exec(line);
    if (first) {
      current = { [first[1]]: first[2] };
      entries.push(current);
      continue;
    }
    const next = /^            ([a-z_]+):\s*(\S.*)$/.exec(line);
    if (next && current) current[next[1]] = next[2];
  }
  return entries;
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

test('nightly and tagged releases do not gate packaging on Browserbase live smoke', () => {
  for (const path of ['.github/workflows/nightly-release.yml', '.github/workflows/release.yml']) {
    const workflow = read(path);
    assert.doesNotMatch(workflow, /^  browserbase-live:/m);
    assert.doesNotMatch(workflow, /name: Browserbase Stagehand live smoke/);
    assert.doesNotMatch(workflow, /test:browserbase:live/);
    assert.doesNotMatch(workflow, /BROWSERBASE_API_KEY|BROWSERBASE_PROJECT_ID|GEMINI_API_KEY/);
    assert.doesNotMatch(workflow, /^\s*if:\s*false\s*$/m);
    assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m);
  }

  const release = read('.github/workflows/release.yml');
  assert.match(release, /^  macos:\n[\s\S]*?^    needs: preflight$/m);
  assert.match(release, /^  windows:\n[\s\S]*?^    needs: preflight$/m);
  assert.match(release, /^  publish:\n[\s\S]*?^    needs: \[verification, macos, windows\]$/m);

  const smoke = read('rhwp/rhwp-agent/tests/browserbase-live-smoke.mjs');
  assert.match(smoke, /for \(let cycle = 1; cycle <= 3; cycle \+= 1\)/);
  assert.match(smoke, /const cleaned = await browser\.cleanup\('live smoke finished'\)/);
  assert.match(smoke, /if \(cleaned === true\) return true/);
  assert.match(smoke, /primaryError\.cleanupError = cleanupError/);
  assert.match(smoke, /throw cleanupError/);
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
  assert.match(workflow, /^  macos:\n[\s\S]*?^    needs: prepare$/m);
  assert.match(workflow, /^  windows:\n[\s\S]*?^    needs: prepare$/m);
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

test('full Rust verification runs concurrently without dropping doctests', () => {
  for (const path of ['.github/workflows/nightly.yml', '.github/workflows/release.yml']) {
    const workflow = read(path);
    assert.match(
      workflow,
      /uses: taiki-e\/install-action@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+tool: cargo-nextest@0\.9\.143\n\s+fallback: none/,
    );
    assert.match(workflow, /cargo nextest run --locked --workspace --test-threads 4/);
    assert.match(workflow, /cargo test --locked --workspace --doc/);
    assert.doesNotMatch(workflow, /run: cargo test --locked --workspace\s*$/m);
  }
});

test('the SHA-pinned fuzz action explicitly selects the nightly toolchain', () => {
  const workflow = read('.github/workflows/nightly.yml');
  assert.match(
    workflow,
    /name: Install nightly Rust toolchain\n\s+uses: dtolnay\/rust-toolchain@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+toolchain: nightly/,
  );
});

test('pull requests build and inspect both supported desktop packages', () => {
  const workflow = read('.github/workflows/desktop-packages.yml');
  assert.deepEqual(matrixIncludes(workflow), [
    {
      os: 'macos-15',
      label: 'macOS ARM64 package',
      platform: 'macos',
      architecture: 'arm64',
      node_architecture: 'arm64',
    },
    {
      os: 'windows-latest',
      label: 'Windows x64 package',
      platform: 'windows',
      architecture: 'x64',
      node_architecture: 'x64',
    },
  ]);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /EXPECTED_NODE_ARCH: \$\{\{ matrix\.node_architecture \}\}/);
  assert.match(workflow, /npm run verify:package/);
  assert.match(workflow, /verify-release-artifacts\.mjs/);
  assert.match(workflow, /Build unsigned Windows test installer/);
  assert.match(workflow, /Build unsigned macOS test packages/);
  assert.match(workflow, /Verify Windows installer is unsigned by design/);
  assert.match(
    workflow,
    /name: Verify native Windows atomic replacement\n\s+if: matrix\.platform == 'windows'\n\s+working-directory: rhwp\n\s+run: cargo test --locked --bin rhwp atomic_file::tests -- --nocapture/,
  );
});

test('desktop session jobs preserve protected context names and assert architecture', () => {
  const workflow = read('.github/workflows/desktop-sessions.yml');
  assert.match(workflow, /^    name: Session tests \(\$\{\{ matrix\.os \}\}\)$/m);
  assert.deepEqual(matrixIncludes(workflow), [
    { os: 'macos-15', architecture: 'arm64' },
    { os: 'windows-latest', architecture: 'x64' },
  ]);
  assert.match(workflow, /EXPECTED_NODE_ARCH: \$\{\{ matrix\.architecture \}\}/);
  assert.match(workflow, /uses: actions\/checkout@v5\n\s+with:\n\s+persist-credentials: false/);
});

test('pull-request round-trip code runs without persisted checkout credentials', () => {
  const workflow = read('.github/workflows/roundtrip-sweep.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /uses: actions\/checkout@v5\n\s+with:\n\s+persist-credentials: false/);
});

test('security gate filters prove that each Cargo invocation ran at least one test', () => {
  const workflow = read('.github/workflows/security-gates.yml');
  assert.equal(
    (workflow.match(/test result: ok\\\. \[1-9\]\[0-9\]\* passed;/g) ?? []).length,
    3,
  );
  assert.equal((workflow.match(/did not run any tests\./g) ?? []).length, 3);
  assert.equal((workflow.match(/cargo test[^\n]*2>&1 \| tee "\$\{cargo_test_output\}"/g) ?? []).length, 3);
  assert.doesNotMatch(workflow, /if output="\$\(cargo test/);
});

test('security gates do not persist checkout credentials into tested code', () => {
  const workflow = read('.github/workflows/security-gates.yml');
  assert.equal((workflow.match(/uses: actions\/checkout@v5/g) ?? []).length, 4);
  assert.equal((workflow.match(/persist-credentials:\s*false/g) ?? []).length, 4);
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
