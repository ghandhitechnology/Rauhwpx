import { join } from 'node:path';

export function nativeExtractorFileName(platform) {
  return platform === 'win32' ? 'rhwp.exe' : 'rhwp';
}

export function sourceStagedNativeExtractorPath(desktopDir, platform, arch) {
  return join(desktopDir, 'bin', `${platform}-${arch}`, nativeExtractorFileName(platform));
}

export function packagedStagedNativeExtractorPath(resourcesDir, platform, arch) {
  return join(
    resourcesDir,
    'app.asar.unpacked',
    'desktop',
    'bin',
    `${platform}-${arch}`,
    nativeExtractorFileName(platform),
  );
}
