import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  peMachine,
  verifyBlockmap,
  verifyReleaseArtifacts,
  verifyUpdateDescriptor,
  verifyWindowsInstaller,
  verifyMacExecutable,
  verifyWindowsExecutable,
} from './verify-release-artifacts.mjs';

function peFixture(machine) {
  const bytes = Buffer.alloc(0x90);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

test('PE architecture reader accepts an x64 executable header', () => {
  assert.equal(peMachine(peFixture(0x8664)), 0x8664);
});

test('PE architecture reader rejects truncated and malformed headers', () => {
  assert.throws(() => peMachine(Buffer.alloc(8)), /DOS header/);

  const invalid = peFixture(0x8664);
  invalid.write('NOPE', 0x80, 'ascii');
  assert.throws(() => peMachine(invalid), /valid PE header/);
});

test('Windows artifact check reads an x64 PE header from disk', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rauhwpx-pe-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, 'Rauhwpx.exe');
  writeFileSync(executable, peFixture(0x8664));
  assert.doesNotThrow(() => verifyWindowsExecutable(executable));

  writeFileSync(executable, peFixture(0xaa64));
  assert.throws(() => verifyWindowsExecutable(executable), /not x64/);
});

test('Windows installer check accepts NSIS bootstrap architectures only', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rauhwpx-installer-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const installer = join(directory, 'Rauhwpx.exe');

  writeFileSync(installer, peFixture(0x014c));
  assert.doesNotThrow(() => verifyWindowsInstaller(installer));
  writeFileSync(installer, peFixture(0x8664));
  assert.doesNotThrow(() => verifyWindowsInstaller(installer));
  writeFileSync(installer, peFixture(0xaa64));
  assert.throws(() => verifyWindowsInstaller(installer), /unexpected PE machine/);
  writeFileSync(installer, 'not an executable');
  assert.throws(() => verifyWindowsInstaller(installer), /DOS header/);
});

function artifactDescriptor(name, bytes, { digest, size } = {}) {
  const sha512 = digest ?? createHash('sha512').update(bytes).digest('base64');
  return [
    'version: 1.2.3',
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size ?? bytes.length}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    'releaseDate: 2026-08-31T00:00:00.000Z',
    '',
  ].join('\n');
}

function blockmapFixture(size) {
  return gzipSync(Buffer.from(JSON.stringify({
    version: '2',
    files: [{
      name: 'file',
      offset: 0,
      checksums: ['fixture-checksum'],
      sizes: [size],
    }],
  })));
}

test('update descriptor digest and size must match the exact artifact entry', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rauhwpx-update-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const name = 'Rauhwpx-1.2.3-x64.exe';
  const bytes = Buffer.from('installer bytes');
  const artifact = join(directory, name);
  const descriptor = join(directory, 'latest.yml');
  writeFileSync(artifact, bytes);
  writeFileSync(descriptor, artifactDescriptor(name, bytes));
  const expectations = {
    expectedVersion: '1.2.3',
    expectedArtifactNames: [name],
  };
  assert.doesNotThrow(() => verifyUpdateDescriptor(descriptor, artifact, expectations));

  const wrongDigest = Buffer.alloc(64, 0xa5).toString('base64');
  writeFileSync(descriptor, artifactDescriptor(name, bytes, { digest: wrongDigest }));
  assert.throws(() => verifyUpdateDescriptor(descriptor, artifact, expectations), /wrong sha512 digest/);

  writeFileSync(descriptor, artifactDescriptor(name, bytes, { size: bytes.length + 1 }));
  assert.throws(() => verifyUpdateDescriptor(descriptor, artifact, expectations), /wrong size/);

  writeFileSync(descriptor, artifactDescriptor(name, bytes).replace(`    size: ${bytes.length}\n`, ''));
  assert.throws(() => verifyUpdateDescriptor(descriptor, artifact, expectations), /wrong size/);

  writeFileSync(descriptor, artifactDescriptor(name, bytes).replace('version: 1.2.3', 'version: 1.2.2'));
  assert.throws(() => verifyUpdateDescriptor(descriptor, artifact, expectations), /version does not match/);

  writeFileSync(descriptor, artifactDescriptor(name, bytes).replace(
    `  - url: ${name}`,
    `  - url: stale-x64.exe\n    sha512: stale\n    size: 1\n  - url: ${name}`,
  ));
  assert.throws(() => verifyUpdateDescriptor(descriptor, artifact, expectations), /exact expected artifact set/);

  writeFileSync(descriptor, [
    'version: 1.2.3',
    `releaseNotes: mentions ${name}`,
    `path: ${name}`,
    `sha512: ${createHash('sha512').update(bytes).digest('base64')}`,
    '',
  ].join('\n'));
  assert.throws(() => verifyUpdateDescriptor(descriptor, artifact), /exactly one files entry/);
});

test('macOS descriptor authenticates a secondary DMG without making it primary', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rauhwpx-mac-update-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const zipName = 'Rauhwpx-1.2.3-arm64.zip';
  const dmgName = 'Rauhwpx-1.2.3-arm64.dmg';
  const zipBytes = Buffer.from('zip bytes');
  const dmgBytes = Buffer.from('dmg bytes');
  const zip = join(directory, zipName);
  const dmg = join(directory, dmgName);
  const descriptor = join(directory, 'latest-mac.yml');
  const zipDigest = createHash('sha512').update(zipBytes).digest('base64');
  const dmgDigest = createHash('sha512').update(dmgBytes).digest('base64');
  writeFileSync(zip, zipBytes);
  writeFileSync(dmg, dmgBytes);
  writeFileSync(descriptor, [
    'version: 1.2.3',
    'files:',
    `  - url: ${zipName}`,
    `    sha512: ${zipDigest}`,
    `    size: ${zipBytes.length}`,
    `  - url: ${dmgName}`,
    `    sha512: ${dmgDigest}`,
    `    size: ${dmgBytes.length}`,
    `path: ${zipName}`,
    `sha512: ${zipDigest}`,
    '',
  ].join('\n'));

  assert.doesNotThrow(() => verifyUpdateDescriptor(descriptor, zip));
  assert.doesNotThrow(() => verifyUpdateDescriptor(descriptor, dmg, { primary: false }));

  writeFileSync(dmg, 'changed dmg bytes');
  assert.throws(
    () => verifyUpdateDescriptor(descriptor, dmg, { primary: false }),
    /wrong sha512 digest/,
  );
});

test('blockmap must be valid gzip JSON covering the complete artifact', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rauhwpx-blockmap-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifact = join(directory, 'Rauhwpx.zip');
  const blockmap = `${artifact}.blockmap`;
  writeFileSync(artifact, 'artifact');
  writeFileSync(blockmap, blockmapFixture(8));
  assert.doesNotThrow(() => verifyBlockmap(blockmap, artifact));

  writeFileSync(blockmap, blockmapFixture(7));
  assert.throws(() => verifyBlockmap(blockmap, artifact), /does not map the complete/);
  writeFileSync(blockmap, 'not gzip');
  assert.throws(() => verifyBlockmap(blockmap, artifact), /not a valid gzip-compressed JSON/);
});

test('full Windows release check rejects a wrong-architecture native engine', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rauhwpx-win-release-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const installerName = 'Rauhwpx-1.2.3-x64.exe';
  const installer = join(directory, installerName);
  const installerBytes = peFixture(0x014c);
  writeFileSync(installer, installerBytes);
  writeFileSync(`${installer}.blockmap`, blockmapFixture(installerBytes.length));
  writeFileSync(join(directory, 'latest.yml'), artifactDescriptor(installerName, installerBytes));

  const app = join(directory, 'win-unpacked', 'Rauhwpx.exe');
  const engine = join(directory, 'win-unpacked', 'resources', 'bin', 'rhwp.exe');
  mkdirSync(join(directory, 'win-unpacked', 'resources', 'bin'), { recursive: true });
  writeFileSync(app, peFixture(0x8664));
  writeFileSync(engine, peFixture(0xaa64));

  assert.throws(
    () => verifyReleaseArtifacts({
      platform: 'windows',
      architecture: 'x64',
      releaseDir: directory,
      hostPlatform: 'win32',
      expectedVersion: '1.2.3',
    }),
    /not x64/,
  );

  writeFileSync(engine, peFixture(0x8664));
  assert.doesNotThrow(() => verifyReleaseArtifacts({
    platform: 'windows',
    architecture: 'x64',
    releaseDir: directory,
    hostPlatform: 'win32',
    expectedVersion: '1.2.3',
  }));
});

test('macOS artifact check accepts the native arm64 Node executable', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, () => {
  assert.doesNotThrow(() => verifyMacExecutable(process.execPath));
});
