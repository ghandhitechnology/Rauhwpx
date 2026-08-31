import { access, chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = process.platform === 'win32' ? 'rhwp.exe' : 'rhwp';
const source = path.join(repositoryRoot, 'rhwp', 'target', 'release', executable);
const destinationDirectory = path.join(
  repositoryRoot,
  'desktop',
  'bin',
  `${process.platform}-${process.arch}`,
);
const destination = path.join(destinationDirectory, executable);

await access(source).catch(() => {
  throw new Error(`Native rhwp executable was not built: ${source}`);
});
await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
if (process.platform !== 'win32') await chmod(destination, 0o755);
const details = await stat(destination);
if (!details.isFile() || details.size === 0) throw new Error('Staged native rhwp executable is empty');
process.stdout.write(`${destination}\n`);
