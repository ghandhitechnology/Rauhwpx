import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listPackage } from '@electron/asar';

const releaseDir = resolve(process.argv[2] ?? 'release');
const resourcesDir = process.platform === 'darwin'
  ? join(releaseDir, 'mac-arm64', 'Rauhwpx.app', 'Contents', 'Resources')
  : join(releaseDir, 'win-unpacked', 'resources');
const unpackedAgent = join(resourcesDir, 'app.asar.unpacked', 'rhwp', 'rhwp-agent');
const extractor = join(resourcesDir, 'bin', process.platform === 'win32' ? 'rhwp.exe' : 'rhwp');

const archive = join(resourcesDir, 'app.asar');
const required = [
  archive,
  join(unpackedAgent, 'server.mjs'),
  join(unpackedAgent, 'copy-layout-runner.mjs'),
  join(unpackedAgent, 'skills', 'copy-layout', 'scripts', 'copy_layout.py'),
  join(unpackedAgent, 'browserbase-sidecar.mjs'),
  join(unpackedAgent, 'browserbase-sidecar-runtime.mjs'),
  join(unpackedAgent, 'browserbase-result.mjs'),
  join(unpackedAgent, 'package.json'),
  join(unpackedAgent, 'node_modules', '@browserbasehq', 'stagehand', 'package.json'),
  join(unpackedAgent, 'node_modules', '@browserbasehq', 'stagehand', 'dist', 'assets', 'stagehand-extension.zip'),
  join(unpackedAgent, 'node_modules', 'ws', 'package.json'),
  extractor,
];
for (const path of required) {
  if (!existsSync(path)) throw new Error(`Packaged file is missing: ${path}`);
}

const forbidden = [
  join(unpackedAgent, 'README.md'),
  join(unpackedAgent, 'package-lock.json'),
  join(unpackedAgent, 'tsconfig.agents.json'),
  join(unpackedAgent, 'tests'),
];
for (const path of forbidden) {
  if (existsSync(path)) throw new Error(`Development-only file was packaged: ${path}`);
}

const archivedFiles = listPackage(archive);
const requiredArchiveFiles = [
  '/desktop/main.mjs',
  '/rhwp/rhwp-studio/dist/index.html',
];
for (const path of requiredArchiveFiles) {
  if (!archivedFiles.includes(path)) throw new Error(`Packaged archive file is missing: ${path}`);
}
if (!archivedFiles.some((path) => /^\/rhwp\/rhwp-studio\/dist\/assets\/rhwp_bg-.*\.wasm$/.test(path))) {
  throw new Error('Packaged archive is missing the Studio WASM engine');
}
const forbiddenArchiveFiles = [
  '/rhwp/rhwp-studio/dist/rhwp.js',
  '/rhwp/rhwp-studio/dist/rhwp.d.ts',
  '/rhwp/rhwp-studio/dist/rhwp_bg.wasm.d.ts',
];
for (const path of forbiddenArchiveFiles) {
  if (archivedFiles.includes(path)) throw new Error(`Stale generated file was packaged: ${path}`);
}
const forbiddenArchivePrefixes = [
  '/rhwp/rhwp-studio/dist/samples/',
  '/rhwp/rhwp-agent/tests/',
];
for (const prefix of forbiddenArchivePrefixes) {
  if (archivedFiles.some((path) => path.startsWith(prefix))) {
    throw new Error(`Development-only archive path was packaged: ${prefix}`);
  }
}

if (process.platform !== 'win32' && (statSync(extractor).mode & 0o111) === 0) {
  throw new Error(`Packaged document extractor is not executable: ${extractor}`);
}

console.log(`Verified desktop package resources at ${resourcesDir}`);
