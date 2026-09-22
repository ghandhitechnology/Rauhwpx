import { access, chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  nativeExtractorFileName,
  sourceStagedNativeExtractorPath,
} from './native-rhwp-path.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = nativeExtractorFileName(process.platform);
const source = path.join(repositoryRoot, 'rhwp', 'target', 'release', executable);
const destination = sourceStagedNativeExtractorPath(
  path.join(repositoryRoot, 'desktop'),
  process.platform,
  process.arch,
);

await access(source).catch(() => {
  throw new Error(`Native rhwp executable was not built: ${source}`);
});
await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
if (process.platform !== 'win32') await chmod(destination, 0o755);
const details = await stat(destination);
if (!details.isFile() || details.size === 0) throw new Error('Staged native rhwp executable is empty');
process.stdout.write(`${destination}\n`);
