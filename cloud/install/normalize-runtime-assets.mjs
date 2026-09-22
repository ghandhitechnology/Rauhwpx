import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function assertUniqueNfcNames(names, directory = '.') {
  const input = [...names];
  for (const name of input) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Runtime asset name must be non-empty text in ${directory}: ${JSON.stringify(name)}`);
    }
  }
  const originalsByNormalizedName = new Map();
  for (const name of input.sort(bytewise)) {
    const normalized = name.normalize('NFC');
    const original = originalsByNormalizedName.get(normalized);
    if (original !== undefined && original !== name) {
      throw new Error(
        `NFC path collision in ${directory}: ${JSON.stringify(original)} and ${JSON.stringify(name)} both normalize to ${JSON.stringify(normalized)}`,
      );
    }
    originalsByNormalizedName.set(normalized, name);
  }
}

async function buildNormalizationPlan(root) {
  const directories = [];

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => bytewise(left.name, right.name));
    assertUniqueNfcNames(entries.map((entry) => entry.name), path.relative(root, directory) || '.');
    directories.push({
      directory,
      renames: entries
        .filter((entry) => entry.name !== entry.name.normalize('NFC'))
        .map((entry) => ({ source: entry.name, destination: entry.name.normalize('NFC') })),
    });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(path.join(directory, entry.name));
      }
    }
  }

  await visit(root);
  return directories;
}

async function assertTreeIsNfc(root) {
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name !== entry.name.normalize('NFC')) {
        throw new Error(`Runtime asset path is not NFC: ${path.relative(root, path.join(directory, entry.name))}`);
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path.join(directory, entry.name));
    }
  }
  await visit(root);
}

export async function normalizeRuntimeAssetPaths(root) {
  const resolvedRoot = path.resolve(root);
  const details = await fs.lstat(resolvedRoot);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Runtime asset root must be a real directory: ${resolvedRoot}`);
  }

  const directories = await buildNormalizationPlan(resolvedRoot);
  let renamed = 0;
  for (const { directory, renames } of directories.reverse()) {
    for (const { source, destination } of renames) {
      await fs.rename(path.join(directory, source), path.join(directory, destination));
      renamed += 1;
    }
  }
  await assertTreeIsNfc(resolvedRoot);
  return { renamed };
}

function safeCatalogPath(formPackRoot, filename) {
  if (typeof filename !== 'string' || filename.length === 0 || filename !== filename.normalize('NFC')) {
    throw new Error(`Form-pack catalog filename must be non-empty NFC text: ${JSON.stringify(filename)}`);
  }
  const segments = filename.split('/');
  if (path.isAbsolute(filename) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Form-pack catalog filename must be a safe relative path: ${JSON.stringify(filename)}`);
  }
  const resolved = path.resolve(formPackRoot, ...segments);
  if (!resolved.startsWith(`${formPackRoot}${path.sep}`)) {
    throw new Error(`Form-pack catalog filename escapes the pack root: ${JSON.stringify(filename)}`);
  }
  return resolved;
}

export async function verifyFormPackCatalog(studioRoot) {
  const formPackRoot = path.resolve(studioRoot, 'form-pack');
  const catalogPath = path.join(formPackRoot, 'catalog.json');
  const catalog = await fs.readFile(catalogPath, 'utf8').then((raw) => JSON.parse(raw), (error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!catalog) return { files: [] };
  if (!Array.isArray(catalog.forms) || catalog.forms.length === 0) {
    throw new Error('Form-pack catalog must contain at least one form');
  }

  const filenames = catalog.forms.map((form) => form?.file);
  assertUniqueNfcNames(filenames, 'studio/form-pack/catalog.json');
  for (const filename of filenames) {
    const exactPath = safeCatalogPath(formPackRoot, filename);
    const details = await fs.lstat(exactPath).catch((error) => {
      throw new Error(`Form-pack catalog file is missing at its exact path: ${JSON.stringify(filename)}`, { cause: error });
    });
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`Form-pack catalog path is not a plain file: ${JSON.stringify(filename)}`);
    }
  }
  return { files: filenames };
}

export async function normalizeAndVerifyRuntimeAssets(root) {
  const normalized = await normalizeRuntimeAssetPaths(root);
  const catalog = await verifyFormPackCatalog(path.join(path.resolve(root), 'studio'));
  return { ...normalized, catalogFiles: catalog.files.length };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) throw new Error('Usage: node normalize-runtime-assets.mjs <runtime-assets-root>');
  const result = await normalizeAndVerifyRuntimeAssets(root);
  process.stdout.write(
    result.catalogFiles > 0
      ? `Normalized ${result.renamed} runtime asset paths; verified ${result.catalogFiles} form-pack catalog files\n`
      : `Normalized ${result.renamed} runtime asset paths\n`,
  );
}
