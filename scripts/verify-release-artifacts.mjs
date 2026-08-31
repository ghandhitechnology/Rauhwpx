import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const MAX_BLOCKMAP_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_BLOCKMAP_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_UPDATE_DESCRIPTOR_BYTES = 4 * 1024 * 1024;

function fail(message) {
  throw new Error(`Release artifact verification failed: ${message}`);
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`${label} is missing: ${path}`);
  }
  if (statSync(path).size === 0) {
    fail(`${label} is empty: ${path}`);
  }
  return path;
}

function matchingFiles(directory, pattern) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => pattern.test(name))
    .map((name) => join(directory, name));
}

function requireOne(directory, pattern, label) {
  const matches = matchingFiles(directory, pattern);
  if (matches.length !== 1) {
    fail(`expected one ${label} in ${directory}, found ${matches.length}`);
  }
  return requireFile(matches[0], label);
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      fail(`invalid double-quoted YAML scalar: ${trimmed}`);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function updateDescriptorFields(descriptor) {
  const topLevel = {};
  const files = [];
  let inFiles = false;
  let currentFile = null;

  for (const line of descriptor.split(/\r?\n/)) {
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;

    if (indentation === 0) {
      currentFile = null;
      inFiles = text === 'files:';
      if (inFiles) continue;
      const field = text.match(/^(version|path|sha512|size):\s*(.+)$/);
      if (field) topLevel[field[1]] = yamlScalar(field[2]);
      continue;
    }

    if (!inFiles) continue;
    const firstField = text.match(/^-\s+url:\s*(.+)$/);
    if (firstField) {
      currentFile = { url: yamlScalar(firstField[1]) };
      files.push(currentFile);
      continue;
    }
    const field = text.match(/^(url|sha512|size):\s*(.+)$/);
    if (currentFile && field) currentFile[field[1]] = yamlScalar(field[2]);
  }

  return { topLevel, files };
}

export function sha512File(path) {
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha512');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    while (true) {
      const read = readSync(descriptor, chunk, 0, chunk.length, offset);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      offset += read;
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('base64');
}

export function verifyUpdateDescriptor(path, artifactPath, {
  primary = true,
  expectedVersion,
  expectedArtifactNames,
} = {}) {
  requireFile(path, 'update descriptor');
  if (statSync(path).size > MAX_UPDATE_DESCRIPTOR_BYTES) {
    fail(`${basename(path)} exceeds the update descriptor size limit`);
  }
  const descriptor = readFileSync(path, 'utf8');
  const artifactName = basename(artifactPath);
  const expectedDigest = sha512File(artifactPath);
  const expectedSize = statSync(artifactPath).size;
  const { topLevel, files } = updateDescriptorFields(descriptor);
  const matchingEntries = files.filter((entry) => entry.url === artifactName);

  if (expectedVersion !== undefined && topLevel.version !== expectedVersion) {
    fail(`${basename(path)} version does not match package version ${expectedVersion}`);
  }
  if (expectedArtifactNames !== undefined) {
    const actualNames = files.map((entry) => entry.url).sort();
    const allowedNames = [...expectedArtifactNames].sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(allowedNames)) {
      fail(`${basename(path)} does not contain the exact expected artifact set`);
    }
  }

  if (matchingEntries.length !== 1) {
    fail(`${basename(path)} must contain exactly one files entry for ${artifactName}`);
  }
  const entry = matchingEntries[0];
  if (entry.sha512 !== expectedDigest) {
    fail(`${basename(path)} files entry has the wrong sha512 digest for ${artifactName}`);
  }
  if (!/^\d+$/.test(String(entry.size)) || Number(entry.size) !== expectedSize) {
    fail(`${basename(path)} files entry has the wrong size for ${artifactName}`);
  }
  if (primary) {
    if (topLevel.path !== artifactName) {
      fail(`${basename(path)} path does not reference ${artifactName}`);
    }
    if (topLevel.sha512 !== expectedDigest) {
      fail(`${basename(path)} has the wrong top-level sha512 digest for ${artifactName}`);
    }
  }
}

export function verifyBlockmap(path, artifactPath) {
  requireFile(path, 'blockmap');
  const compressedSize = statSync(path).size;
  if (compressedSize > MAX_BLOCKMAP_COMPRESSED_BYTES) {
    fail(`${basename(path)} exceeds the blockmap size limit`);
  }

  let blockmap;
  try {
    const expanded = gunzipSync(readFileSync(path), {
      maxOutputLength: MAX_BLOCKMAP_EXPANDED_BYTES,
    });
    blockmap = JSON.parse(expanded.toString('utf8'));
  } catch (error) {
    fail(`${basename(path)} is not a valid gzip-compressed JSON blockmap: ${error.message}`);
  }

  const file = blockmap?.version === '2' && Array.isArray(blockmap.files)
    && blockmap.files.length === 1 ? blockmap.files[0] : null;
  if (file?.name !== 'file' || file?.offset !== 0
    || !Array.isArray(file.checksums) || !Array.isArray(file.sizes)
    || file.checksums.length === 0 || file.checksums.length !== file.sizes.length
    || !file.checksums.every((checksum) => typeof checksum === 'string' && checksum.length > 0)
    || !file.sizes.every((size) => Number.isSafeInteger(size) && size > 0)) {
    fail(`${basename(path)} has an invalid blockmap structure`);
  }
  const mappedSize = file.sizes.reduce((total, size) => total + size, 0);
  if (!Number.isSafeInteger(mappedSize) || mappedSize !== statSync(artifactPath).size) {
    fail(`${basename(path)} does not map the complete ${basename(artifactPath)} artifact`);
  }
}

export function peMachine(buffer) {
  if (buffer.length < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    fail('Windows executable has no DOS header');
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset > buffer.length - 6 || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    fail('Windows executable has no valid PE header');
  }
  return buffer.readUInt16LE(peOffset + 4);
}

function peMachineFromFile(path, label) {
  requireFile(path, label);
  const fileSize = statSync(path).size;
  const descriptor = openSync(path, 'r');
  let machine;
  try {
    const dosHeader = Buffer.alloc(0x40);
    if (readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      fail('Windows executable has a truncated DOS header');
    }
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      fail('Windows executable has no DOS header');
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset > fileSize - 6) {
      fail('Windows executable has an out-of-range PE header');
    }
    const peHeader = Buffer.alloc(6);
    if (readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length
      || peHeader.toString('ascii', 0, 4) !== 'PE\0\0') {
      fail('Windows executable has no valid PE header');
    }
    machine = peHeader.readUInt16LE(4);
  } finally {
    closeSync(descriptor);
  }
  return machine;
}

export function verifyWindowsExecutable(path) {
  const machine = peMachineFromFile(path, 'packaged Windows executable');
  if (machine !== 0x8664) {
    fail(`packaged Windows executable is not x64 (PE machine 0x${machine.toString(16)})`);
  }
}

export function verifyWindowsInstaller(path) {
  const machine = peMachineFromFile(path, 'Windows installer');
  // NSIS currently emits an x86 bootstrapper for x64 payloads. Accept a native
  // x64 bootstrapper too, but reject unrelated or malformed executables.
  if (machine !== 0x014c && machine !== 0x8664) {
    fail(`Windows installer has an unexpected PE machine (0x${machine.toString(16)})`);
  }
}

export function verifyMacExecutable(path) {
  requireFile(path, 'packaged macOS executable');
  let architectures;
  try {
    architectures = execFileSync('lipo', ['-archs', path], { encoding: 'utf8' }).trim().split(/\s+/);
  } catch (error) {
    fail(`could not inspect the macOS executable architecture: ${error.message}`);
  }
  if (architectures.length !== 1 || architectures[0] !== 'arm64') {
    fail(`packaged macOS executable must be arm64 only, found ${architectures.join(', ') || 'none'}`);
  }
}

export function verifyMacDistributable(path, kind) {
  requireFile(path, `macOS ${kind}`);
  const command = kind === 'DMG' ? 'hdiutil' : 'unzip';
  const args = kind === 'DMG' ? ['verify', path] : ['-tq', path];
  try {
    execFileSync(command, args, { stdio: 'pipe' });
  } catch (error) {
    fail(`${kind} failed its native integrity check: ${error.message}`);
  }
}

export function verifyReleaseArtifacts({
  platform,
  architecture,
  releaseDir = 'release',
  hostPlatform = process.platform,
  expectedVersion,
}) {
  const directory = resolve(releaseDir);
  let releaseVersion = expectedVersion;
  if (releaseVersion === undefined) {
    try {
      releaseVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
    } catch (error) {
      fail(`could not read the package version: ${error.message}`);
    }
  }
  if (typeof releaseVersion !== 'string' || releaseVersion.length === 0) {
    fail('package version is missing');
  }

  if (platform === 'macos') {
    if (architecture !== 'arm64') fail(`unsupported macOS architecture: ${architecture}`);
    if (hostPlatform !== 'darwin') fail('macOS artifacts must be checked on macOS');

    const dmg = requireOne(directory, /-arm64\.dmg$/, 'arm64 DMG');
    const zip = requireOne(directory, /-arm64\.zip$/, 'arm64 ZIP');
    if (basename(dmg) !== `Rauhwpx-${releaseVersion}-arm64.dmg`
      || basename(zip) !== `Rauhwpx-${releaseVersion}-arm64.zip`) {
      fail(`macOS artifact names do not match package version ${releaseVersion}`);
    }
    verifyMacDistributable(dmg, 'DMG');
    verifyMacDistributable(zip, 'ZIP');
    verifyBlockmap(`${zip}.blockmap`, zip);
    const updateDescriptor = join(directory, 'latest-mac.yml');
    const expectedArtifactNames = [basename(zip), basename(dmg)];
    verifyUpdateDescriptor(updateDescriptor, zip, { expectedVersion: releaseVersion, expectedArtifactNames });
    verifyUpdateDescriptor(updateDescriptor, dmg, {
      primary: false,
      expectedVersion: releaseVersion,
      expectedArtifactNames,
    });
    const appDirectory = join(
      directory,
      'mac-arm64',
      'Rauhwpx.app',
      'Contents',
    );
    verifyMacExecutable(join(
      appDirectory,
      'MacOS',
      'Rauhwpx',
    ));
    verifyMacExecutable(join(appDirectory, 'Resources', 'bin', 'rhwp'));
    return { artifacts: [dmg, zip, `${zip}.blockmap`, updateDescriptor] };
  }

  if (platform === 'windows') {
    if (architecture !== 'x64') fail(`unsupported Windows architecture: ${architecture}`);
    if (hostPlatform !== 'win32') fail('Windows artifacts must be checked on Windows');

    const installer = requireOne(directory, /-x64\.exe$/, 'x64 NSIS installer');
    if (basename(installer) !== `Rauhwpx-${releaseVersion}-x64.exe`) {
      fail(`Windows artifact name does not match package version ${releaseVersion}`);
    }
    verifyWindowsInstaller(installer);
    verifyBlockmap(`${installer}.blockmap`, installer);
    verifyUpdateDescriptor(join(directory, 'latest.yml'), installer, {
      expectedVersion: releaseVersion,
      expectedArtifactNames: [basename(installer)],
    });
    const unpackedDirectory = join(directory, 'win-unpacked');
    verifyWindowsExecutable(join(unpackedDirectory, 'Rauhwpx.exe'));
    verifyWindowsExecutable(join(unpackedDirectory, 'resources', 'bin', 'rhwp.exe'));
    return { artifacts: [installer, `${installer}.blockmap`, join(directory, 'latest.yml')] };
  }

  fail(`unsupported platform: ${platform}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const [platform, architecture, releaseDir] = process.argv.slice(2);
  if (!platform || !architecture) {
    fail('usage: node scripts/verify-release-artifacts.mjs <macos|windows> <arm64|x64> [release-dir]');
  }
  const result = verifyReleaseArtifacts({ platform, architecture, releaseDir });
  console.log(`Verified ${result.artifacts.length} ${platform} ${architecture} release artifacts.`);
}
