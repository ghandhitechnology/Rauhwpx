/** Canonicalize @electron/asar listings into their platform-neutral namespace. */
export function normalizeArchivePath(entry) {
  return String(entry).replaceAll('\\', '/');
}
