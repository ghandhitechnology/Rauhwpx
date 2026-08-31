/**
 * Secondary check against GitHub release assets. Never the unique-install
 * source of truth: updater yml/blockmap traffic, checksum files, and the
 * macOS zip+dmg pair would inflate GitHub download_count.
 */

const UPDATER_OR_CHECKSUM = /\.(yml|blockmap)$/i;
const CHECKSUM_NAME = /sha256sums/i;

export function isOfficialInstallerAsset(name) {
  const fileName = String(name ?? '');
  if (!fileName || UPDATER_OR_CHECKSUM.test(fileName) || CHECKSUM_NAME.test(fileName)) {
    return false;
  }
  return /\.dmg$/i.test(fileName) || /\.exe$/i.test(fileName);
}

export function secondaryInstallerDownloadCount(assets = []) {
  let macDmg = 0;
  let winExe = 0;
  for (const asset of assets) {
    const name = asset?.name;
    if (!isOfficialInstallerAsset(name)) continue;
    const count = Number(asset?.download_count);
    if (!Number.isFinite(count) || count < 0) continue;
    if (/\.dmg$/i.test(name)) macDmg += count;
    else if (/\.exe$/i.test(name)) winExe += count;
  }
  return {
    macDmg,
    winExe,
    total: macDmg + winExe,
  };
}
