import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import { auditProduction, PRODUCTION_DIRECTORIES } from './audit-production.mjs';

for (const affected of ['cloud', 'cloud/install/provider-runtime', 'rhwp/rau-credits']) {
  test(`production audit fails when ${affected} has a blocking advisory`, () => {
    const visited = [];
    assert.equal(auditProduction({
      log() {},
      run(command, args, options) {
        assert.equal(command, 'npm');
        assert.deepEqual(args, ['audit', '--omit=dev', '--audit-level=high']);
        visited.push(options.cwd);
        return { status: options.cwd === affected ? 1 : 0 };
      },
    }), 1);
    assert.deepEqual(visited, PRODUCTION_DIRECTORIES, 'one finding must not skip remaining package audits');
  });
}

test('nightly audits every production dependency tree', () => {
  const workflow = yaml.load(readFileSync(new URL('../.github/workflows/nightly.yml', import.meta.url), 'utf8'));
  assert.ok(workflow.jobs.app.steps.some((step) => step.run === 'npm run audit:production'));
});
