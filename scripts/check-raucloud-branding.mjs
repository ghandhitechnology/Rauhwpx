import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const joinedBrand = ['managed', 'cloud'].join('');
const separatedBrand = ['managed', 'cloud'].join('[\\s_-]+');
const productLease = ['managed', 'lease'].join('');
const productBroker = ['managed', 'broker'].join('[_-]');
const workerEnvironment = ['RAUHWpx', 'MANAGED'].join('_');
const railwayPrefix = ['rauhwpx', 'managed'].join('-');
const retired = new RegExp(
  `${joinedBrand}|${separatedBrand}|${productLease}|${productBroker}|${workerEnvironment}|${railwayPrefix}`,
  'i',
);
const ignoredFiles = new Set(['package-lock.json', 'desktop/packaged-railway.json']);
const ignoredPrefixes = ['hobbies/'];
const failures = [];

for (const file of tracked) {
  if (!existsSync(file)) continue;
  if (ignoredFiles.has(file)
    || file.endsWith('/package-lock.json')
    || ignoredPrefixes.some((prefix) => file.startsWith(prefix))) continue;
  if (retired.test(file)) failures.push(`${file}: retired Raucloud path`);

  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (source.includes('\0')) continue;

  source.split(/\r?\n/u).forEach((line, index) => {
    if (line.includes('raucloud-legacy')) return;
    if (retired.test(line)) failures.push(`${file}:${index + 1}: ${line.trim()}`);
  });
}

if (failures.length) {
  process.stderr.write(`Retired Raucloud branding found:\n${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Raucloud branding audit passed.\n');
}
