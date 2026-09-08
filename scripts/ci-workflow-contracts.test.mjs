import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { changedPaths, selectChecks } from './ci-changes.mjs';

const readYaml = (path) => yaml.load(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const workflows = Object.fromEntries(
  readdirSync(new URL('../.github/workflows/', import.meta.url))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => [file, readYaml(`.github/workflows/${file}`)]),
);
const enabled = (files) => Object.entries(selectChecks(files)).filter(([, value]) => value).map(([key]) => key).sort();

for (const [description, files, expected] of [
  ['documentation', ['README.md', 'CONTRIBUTING.md', 'docs/releasing.md', 'rhwp/rhwp-agent/README.md'], []],
  ['engine changes', ['rhwp/src/parser/hwp.rs'], ['browser', 'engine']],
  ['corpus changes', ['rhwp/samples/report.hwpx', 'rhwp/pdf/reference.pdf'], ['browser', 'engine']],
  ['native executable', ['rhwp/src/main.rs'], ['browser', 'engine', 'packages']],
  ['Cargo manifest', ['rhwp/Cargo.toml'], ['browser', 'engine', 'packages', 'rustAudit']],
  ['desktop shell', ['desktop/main.mjs'], ['app', 'packages', 'sessions']],
  ['agent hub source', ['rhwp/rhwp-agent/server.mjs'], ['app', 'sessions']],
  ['agent lockfile', ['rhwp/rhwp-agent/package-lock.json'], ['app', 'npm', 'sessions']],
  ['shared package', ['rhwp/rhwp-shared/package.json'], ['app', 'browser', 'npm']],
  ['Studio unit tests', ['rhwp/rhwp-studio/tests/save.test.ts'], ['app', 'browser']],
  ['desktop session tests', ['rhwp/rhwp-studio/tests/desktop-shell.test.ts'], ['app', 'browser', 'sessions']],
  ['Rust lockfile', ['rhwp/Cargo.lock'], ['browser', 'engine', 'rustAudit']],
]) {
  test(`change selection covers ${description}`, () => assert.deepEqual(enabled(files), expected));
}

test('unknown paths and build/CI configuration fail safe to full checks', () => {
  for (const file of ['new-component/index.ts', '.github/workflows/checks.yml', 'scripts/ci-changes.mjs', 'package.json', 'new-fixture.txt']) {
    assert.ok(Object.values(selectChecks([file])).every(Boolean), file);
  }
});

test('deletions and renamed code still select checks', () => {
  const event = { pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } } };
  const paths = changedPaths(event, (args) => {
    assert.deepEqual(args, ['diff', '--name-only', '--no-renames', '-z', 'a'.repeat(40), 'b'.repeat(40), '--']);
    return 'rhwp/src/removed.rs\0docs/removed.md\0';
  });
  assert.deepEqual(enabled(paths), ['browser', 'engine']);
});

test('dispatch and new-branch events request full verification', () => {
  assert.ok(Object.values(selectChecks(changedPaths({}))).every(Boolean));
  assert.ok(Object.values(selectChecks(changedPaths({ before: '0'.repeat(40), after: 'a'.repeat(40) }))).every(Boolean));
  assert.throws(() => changedPaths({ before: '--unsafe', after: 'a'.repeat(40) }), /Invalid event commit SHA/);
});

function ancestors(workflow, id, visited = new Set()) {
  const job = workflow.jobs[id];
  assert.ok(job, `Unknown job dependency: ${id}`);
  const needs = job.needs == null ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
  for (const dependency of needs) {
    assert.notEqual(dependency, id, 'A job cannot depend on itself');
    if (!visited.has(dependency)) {
      visited.add(dependency);
      ancestors(workflow, dependency, visited);
    }
  }
  return visited;
}

test('one PR event owns each existing protected check name', () => {
  const pr = Object.values(workflows).filter((workflow) => Object.hasOwn(workflow.on, 'pull_request'));
  assert.equal(pr.length, 1);
  const names = Object.values(pr[0].jobs).flatMap((job) => {
    if (job.strategy?.matrix?.include) return job.strategy.matrix.include.map((entry) => job.name.replace('${{ matrix.label }}', entry.label).replace('${{ matrix.os }}', entry.os));
    return [job.name];
  });
  for (const name of ['macOS ARM64 package', 'Windows x64 package', 'Session tests (macos-15)', 'Session tests (windows-latest)', 'Production dependency audit', 'Rust production dependency audit', 'Hostile document input boundaries', 'Auth and resource boundary regressions', 'Full IR field round-trip sweep']) {
    assert.equal(names.filter((actual) => actual === name).length, 1, name);
  }
  assert.deepEqual(pr[0].on.push.branches, ['main']);
});

test('releases depend on verification within the same workflow run', () => {
  const nightly = workflows['nightly.yml'];
  assert.ok(Object.hasOwn(nightly.on, 'schedule'));
  for (const id of ['prepare', 'macos', 'windows', 'publish']) {
    const dependencies = ancestors(nightly, id);
    for (const verification of ['engine', 'app', 'hostile-input-smoke']) assert.ok(dependencies.has(verification), `${id} requires ${verification}`);
  }
  assert.equal(nightly.jobs.prepare.if, "github.ref == 'refs/heads/main'");
  for (const filename of ['nightly.yml', 'release.yml']) {
    const workflow = workflows[filename];
    for (const platform of ['macos', 'windows']) {
      const checkout = workflow.jobs[platform].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
      assert.equal(checkout.with.ref, '${{ github.sha }}', `${filename} packages the verified commit`);
    }
  }
  assert.ok(ancestors(workflows['release.yml'], 'publish').has('verification'));
});

test('consolidated checks retain Cloud contracts and browser handoff', () => {
  const checks = workflows['checks.yml'];
  const cloudSteps = checks.jobs['cloud-contracts'].steps;
  assert.equal(cloudSteps.find((step) => step.uses?.startsWith('actions/setup-node@')).with['node-version'], 24);
  assert.ok(cloudSteps.some((step) => step.run?.includes('npm run test:cloud')));
  const browserCommands = checks.jobs.browser.steps.map((step) => step.run ?? '').join('\n');
  assert.match(browserCommands, /e2e:cloud-onboarding/);
  assert.match(browserCommands, /e2e:cloud-workspace/);
  assert.match(browserCommands, /e2e:cloud-display/);
});

test('only release and image publishing receive write permissions', () => {
  for (const [filename, workflow] of Object.entries(workflows)) {
    assert.deepEqual(workflow.permissions, { contents: 'read' }, filename);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      for (const [scope, access] of Object.entries(job.permissions ?? {})) {
        if (access === 'write') {
          const allowed = scope === 'contents' && id === 'publish'
            || scope === 'packages' && (
              filename === 'cloud-sandbox-image.yml' && id === 'publish'
              || filename === 'release.yml' && ['cloud', 'cloud-image'].includes(id)
            ) || filename === 'release.yml' && id === 'cloud' && scope === 'id-token';
          assert.ok(allowed, `${filename}/${id}/${scope}`);
        }
      }
      if (id !== 'publish') {
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with?.['persist-credentials'], false, `${filename}/${id}`);
        }
      }
    }
  }
});

test('cloud image publication requires real headed display and input verification', () => {
  for (const steps of [workflows['cloud-sandbox-image.yml'].jobs.publish.steps, workflows['release.yml'].jobs.cloud.steps]) {
    const proofIndex = steps.findIndex((step) => step.run?.includes('RAUHWpx_XVFB_CAPTURE_PROOF=1'));
    const publishIndex = steps.findIndex((step) => step.run?.includes('podman push'));
    assert.ok(proofIndex >= 0 && proofIndex < publishIndex);
    assert.match(steps[proofIndex].run, /--user 1001:1001/);
    assert.match(steps[proofIndex].run, /--test \/app\/tests\/xvfb-studio-capture-proof\.test\.mjs/);
  }
});

test('cloud candidates include tested broker source from the same commit', () => {
  const steps = workflows['cloud-sandbox-image.yml'].jobs.publish.steps;
  const broker = steps.findIndex((step) => step.name === 'Verify and archive matching broker source');
  const publish = steps.findIndex((step) => step.run?.includes('podman push'));
  assert.ok(broker >= 0 && broker < publish);
  assert.match(steps[broker].run, /npm --prefix rhwp\/rau-credits test/);
  assert.match(steps[broker].run, /git archive "\$GITHUB_SHA:rhwp\/rau-credits"/);
  assert.match(steps[broker].run, /sha256sum raucloud-broker-source\.tar\.gz/);
  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  for (const name of ['cloud-image.json', 'raucloud-broker-source.tar.gz', 'raucloud-broker-source.json']) {
    assert.ok(upload.with.path.includes(name), name);
  }
});

for (const scenario of [
  { name: 'feature candidate', requested: '', edge: false, refType: 'branch', refName: 'feat/cloud' },
  { name: 'named candidate', requested: 'cloud-review-1', edge: false, refType: 'branch', refName: 'feat/cloud' },
  { name: 'explicit edge promotion', requested: 'cloud-review-2', edge: true, refType: 'branch', refName: 'feat/cloud' },
  { name: 'cloud release tag', requested: '', edge: false, refType: 'tag', refName: 'cloud-sandbox-v2.1.0' },
]) {
  test(`cloud image publication records the verified digest for ${scenario.name}`, { skip: process.platform === 'win32' }, (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'cloud-image-publication-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const callsPath = path.join(directory, 'calls');
    const commit = 'a'.repeat(40);
    const digest = 'd'.repeat(64);
    const run = workflows['cloud-sandbox-image.yml'].jobs.publish.steps
      .find((step) => step.name === 'Publish candidate and optional edge images').run;
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `
      podman() {
        printf '%s\\n' "$*" >> "$RAU_IMAGE_TEST_CALLS"
        if [[ "$1" == login ]]; then read -r ignored || true; fi
        if [[ "$1" == push && "$2" == --digestfile ]]; then
          printf 'sha256:%s\\n' "$RAU_IMAGE_TEST_DIGEST" > "$3"
        fi
      }
      ${run}
    `], { encoding: 'utf8', timeout: 5_000, cwd: directory, env: {
      ...process.env, RAU_IMAGE_TEST_CALLS: callsPath, RAU_IMAGE_TEST_DIGEST: digest,
      GHCR_TOKEN: 'test-token', GITHUB_ACTOR: 'test-user', GITHUB_REPOSITORY_OWNER: 'TestOrg',
      GITHUB_REPOSITORY: 'TestOrg/Rauhwpx', GITHUB_SHA: commit, GITHUB_RUN_ID: '42',
      GITHUB_REF_TYPE: scenario.refType, GITHUB_REF_NAME: scenario.refName,
      GITHUB_STEP_SUMMARY: path.join(directory, 'summary'), REQUESTED_TAG: scenario.requested,
      PUBLISH_EDGE: String(scenario.edge),
    } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const tag = scenario.refType === 'tag' ? '2.1.0' : scenario.requested || `sha-${commit}`;
    const image = 'ghcr.io/testorg/rauhwpx-cloud';
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'cloud-image.json'), 'utf8')), {
      image: `${image}@sha256:${digest}`, tag, commit,
      run: 'https://github.com/TestOrg/Rauhwpx/actions/runs/42',
    });
    const calls = readFileSync(callsPath, 'utf8');
    assert.ok(calls.includes(`push --digestfile cloud-image-digest.txt ${image}:${tag}`));
    assert.equal(calls.includes(`push ${image}:edge\n`), scenario.edge || scenario.refType === 'tag');
    assert.equal(calls.includes(`${image}:stable`), false);
    assert.equal(calls.includes('test-token'), false);
  });
}

test('candidate publication rejects shared and malformed tags before registry login', { skip: process.platform === 'win32' }, () => {
  const run = workflows['cloud-sandbox-image.yml'].jobs.publish.steps
    .find((step) => step.name === 'Publish candidate and optional edge images').run;
  for (const requested of ['edge', 'stable', 'invalid/tag']) {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `podman() { echo 'UNEXPECTED_REGISTRY_ACCESS'; }; ${run}`], {
      encoding: 'utf8', timeout: 5_000, env: {
        ...process.env, REQUESTED_TAG: requested, GITHUB_REPOSITORY_OWNER: 'test',
        GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'feat/cloud',
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid candidate image tag/);
    assert.equal(result.stdout.includes('UNEXPECTED_REGISTRY_ACCESS'), false);
  }
});

for (const ready of [true, false]) {
  test(`cloud image startup ${ready ? 'waits for initialization after HTTP becomes healthy' : 'fails when initialization never finishes'}`, {
    skip: process.platform === 'win32',
  }, (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'cloud-image-startup-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const counter = path.join(directory, 'log-reads');
    writeFileSync(counter, '0');
    const run = workflows['cloud-sandbox-image.yml'].jobs.publish.steps
      .find((step) => step.name === 'Build and smoke-test sandbox image').run;
    const startup = run.slice(run.indexOf('healthy=0'));
    // Run the actual workflow loop against a server whose HTTP listener opens
    // before provider probing and scheduler initialization finish.
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `
      curl() { return 0; }
      sleep() { return 0; }
      podman() {
        case "$1" in
          logs)
            local count
            read -r count < "$RAU_IMAGE_PROBE_COUNT_FILE" || true
            count=$((count + 1))
            printf '%s\\n' "$count" > "$RAU_IMAGE_PROBE_COUNT_FILE"
            if [[ "$RAU_IMAGE_PROBE_READY" == 1 && "$count" -ge 3 ]]; then
              printf '%s\\n' '{"event":"cloud.started"}'
            fi
            ;;
          inspect) printf '%s\\n' true ;;
          *) return 2 ;;
        esac
      }
      sandbox_id=fixture
      ${startup}
    `], { encoding: 'utf8', timeout: 5_000, env: {
      ...process.env, RAU_IMAGE_PROBE_COUNT_FILE: counter, RAU_IMAGE_PROBE_READY: ready ? '1' : '0',
    } });
    assert.ifError(result.error);
    assert.equal(result.status, ready ? 0 : 1, result.stderr);
    assert.ok(Number(readFileSync(counter, 'utf8')) >= (ready ? 3 : 60));
  });
}

test('third-party Rust toolchain and installer actions are immutable', () => {
  const actions = ['setup-rust', 'package-desktop'].map((name) => readYaml(`.github/actions/${name}/action.yml`));
  const steps = [
    ...Object.values(workflows).flatMap((workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])),
    ...actions.flatMap((action) => action.runs.steps),
  ];
  for (const step of steps) {
    if (/^(dtolnay\/rust-toolchain|taiki-e\/install-action)@/.test(step.uses ?? '')) assert.match(step.uses.split('@')[1], /^[a-f0-9]{40}$/);
  }
});
