import { spawnSync } from 'node:child_process';

// High/critical advisories block changes. Nightly also records lower severities.
const report = process.argv.includes('--report');
let failed = false;
for (const directory of ['.', 'rhwp/rhwp-agent', 'rhwp/rhwp-studio']) {
  console.log(`Production dependency audit: ${directory}`);
  const result = spawnSync('npm', ['audit', '--omit=dev', `--audit-level=${report ? 'low' : 'high'}`], {
    cwd: directory,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  failed ||= result.status !== 0;
}
if (report && failed) console.log('Advisory report contains findings; high/critical findings are enforced by audit:production.');
process.exitCode = report ? 0 : Number(failed);
