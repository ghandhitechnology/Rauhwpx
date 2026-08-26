import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const nightlyReleaseWorkflow = readFileSync(
  new URL('../../../.github/workflows/nightly-release.yml', import.meta.url),
  'utf8',
);

function workflowJob(jobId: string): string {
  const marker = `  ${jobId}:\n`;
  const start = nightlyReleaseWorkflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing ${jobId} job`);

  const bodyStart = start + marker.length;
  const nextJobOffset = nightlyReleaseWorkflow.slice(bodyStart).search(/^  [a-z][a-z0-9_-]*:\n/m);
  const end = nextJobOffset === -1 ? undefined : bodyStart + nextJobOffset;
  return nightlyReleaseWorkflow.slice(start, end);
}

const macosJob = workflowJob('macos');
const windowsJob = workflowJob('windows');
const publishJob = workflowJob('publish');

test('nightly desktop releases run daily and on demand without cancellation', () => {
  assert.match(nightlyReleaseWorkflow, /cron:\s*['"]0 5 \* \* \*['"]/);
  assert.match(nightlyReleaseWorkflow, /^\s+workflow_dispatch:\s*$/m);
  assert.match(nightlyReleaseWorkflow, /cancel-in-progress:\s*false/);
});

test('nightly desktop releases build the existing macOS and Windows targets', () => {
  assert.match(macosJob, /runs-on:\s*macos-15/);
  assert.match(windowsJob, /runs-on:\s*windows-latest/);
  assert.match(macosJob, /npm run dist:mac/);
  assert.match(windowsJob, /npm run dist:win/);
  assert.match(macosJob, /npm version --no-git-tag-version "\$\{\{ needs\.prepare\.outputs\.version \}\}"/);
  assert.match(
    windowsJob,
    /npm version --no-git-tag-version "\$\{\{ needs\.prepare\.outputs\.version \}\}"/,
  );
  assert.doesNotMatch(nightlyReleaseWorkflow, /dist:linux|electron-builder\s+--linux/);
});

test('nightly macOS releases use the tagged release signing contract', () => {
  assert.match(macosJob, /environment:\s*macos-release/);
  assert.match(macosJob, /CSC_NAME:\s*"TAEWOOK HA \(C8M34MMT8W\)"/);
  assert.match(macosJob, /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.match(macosJob, /xcrun stapler validate/);
});

test('nightly publishing replaces the prerelease only after both builds pass', () => {
  assert.match(publishJob, /needs:\s*\[macos,\s*windows\]/);
  assert.match(publishJob, /if:\s*github\.ref == 'refs\/heads\/main'/);
  assert.match(publishJob, /gh release delete nightly/);
  assert.match(publishJob, /gh release create nightly/);
  assert.match(publishJob, /--prerelease/);
  assert.match(publishJob, /--latest=false/);
  assert.doesNotMatch(publishJob, /if:\s*(?:\$\{\{\s*)?(?:always|failure)\(\)/);
});
