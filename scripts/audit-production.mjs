import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_DIRECTORIES = Object.freeze([
  '.', 'rhwp/rhwp-agent', 'rhwp/rhwp-studio',
  'cloud', 'cloud/install/provider-runtime', 'rhwp/rau-credits',
]);

// High/critical advisories block changes. Nightly also records lower severities.
export function auditProduction({ report = false, run = spawnSync, log = console.log } = {}) {
  let failed = false;
  for (const directory of PRODUCTION_DIRECTORIES) {
    log(`Production dependency audit: ${directory}`);
    const result = run('npm', ['audit', '--omit=dev', `--audit-level=${report ? 'low' : 'high'}`], {
      cwd: directory,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.error) throw result.error;
    failed ||= result.status !== 0;
  }
  if (report && failed) log('Advisory report contains findings; high/critical findings are enforced by audit:production.');
  return report ? 0 : Number(failed);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = auditProduction({ report: process.argv.includes('--report') });
}
