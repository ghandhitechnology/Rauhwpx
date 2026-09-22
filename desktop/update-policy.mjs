function versionParts(value) {
  const match = String(value ?? '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ?? null,
  };
}

export function isNewerStableVersion(candidate, current) {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  if (!next || !installed || next.prerelease) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next.numbers[index] !== installed.numbers[index]) {
      return next.numbers[index] > installed.numbers[index];
    }
  }
  return Boolean(installed.prerelease);
}

export function selectDebAsset(assets, arch) {
  if (!Array.isArray(assets)) return null;
  const architecture = arch === 'arm64'
    ? /(?:^|[-_.])(?:arm64|aarch64)(?:[-_.]|\.deb$)/i
    : /(?:^|[-_.])(?:amd64|x64|x86_64)(?:[-_.]|\.deb$)/i;
  return assets.find((asset) => (
    asset
    && typeof asset.name === 'string'
    && asset.name.toLowerCase().endsWith('.deb')
    && architecture.test(asset.name)
    && typeof asset.browser_download_url === 'string'
    && asset.browser_download_url.startsWith('https://github.com/')
  )) ?? null;
}

export const __test = { versionParts };
