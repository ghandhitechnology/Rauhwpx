import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudioHarness, startStudioServer } from './studio-harness.mjs';
import { readTimeline, TIMELINE_SCHEMA, TIMELINE_VERSION } from './timeline.mjs';

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && await fs.access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return candidates.find(Boolean);
}

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const studioRoot = path.resolve(await firstExisting([
  process.env.RAUHWpx_STUDIO_DIST,
  '/app/studio',
  path.join(repositoryRoot, 'cloud', 'runtime-assets', 'studio'),
]));
const agentRoot = path.resolve(await firstExisting([
  process.env.RAUHWpx_AGENT_ROOT,
  '/app/rhwp-agent',
  path.join(repositoryRoot, 'rhwp', 'rhwp-agent'),
]));
const chromiumPath = await firstExisting([
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]);
const rhwpBin = await firstExisting([
  process.env.RHWP_BIN,
  '/app/bin/rhwp',
  path.join(repositoryRoot, 'rhwp', 'target', 'release', 'rhwp'),
]);
const documentPath = path.resolve(process.env.RAUHWpx_SMOKE_DOCUMENT || path.join(studioRoot, 'samples', 'field-01.hwp'));
const referencePath = path.resolve(process.env.RAUHWpx_SMOKE_REFERENCE || documentPath);
const extension = path.extname(documentPath).toLowerCase();
const formats = {
  '.hwp': { format: 'hwp', mimeType: 'application/x-hwp' },
  '.hwpx': { format: 'hwpx', mimeType: 'application/vnd.hancom.hwpx' },
  '.hml': { format: 'hml', mimeType: 'application/x-hml' },
};
const selected = formats[extension];
if (!selected) throw new Error(`Unsupported smoke document extension: ${extension}`);

async function smokeFormPackRoutes() {
  const formPackRoot = path.join(studioRoot, 'form-pack');
  const catalog = JSON.parse(await fs.readFile(path.join(formPackRoot, 'catalog.json'), 'utf8'));
  if (!Array.isArray(catalog.forms) || catalog.forms.length === 0) {
    throw new Error('Studio form-pack catalog is empty');
  }
  const { server, origin } = await startStudioServer({
    studioRoot,
    resources: new Map(),
    bootstrap: 'form-pack-smoke',
  });
  try {
    for (const form of catalog.forms) {
      const filename = form?.file;
      if (typeof filename !== 'string' || filename !== filename.normalize('NFC')) {
        throw new Error(`Studio form-pack catalog filename is not NFC: ${JSON.stringify(filename)}`);
      }
      const expected = await fs.readFile(path.join(formPackRoot, filename));
      const response = await fetch(`${origin}/form-pack/${encodeURIComponent(filename)}`);
      if (!response.ok) throw new Error(`Studio form-pack route failed for ${JSON.stringify(filename)}: HTTP ${response.status}`);
      const actual = Buffer.from(await response.arrayBuffer());
      if (!actual.equals(expected)) throw new Error(`Studio form-pack route returned different bytes for ${JSON.stringify(filename)}`);
    }
    return catalog.forms.length;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const formPackFiles = await smokeFormPackRoutes();

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-studio-'));
const manifest = {
  sessionId: 'studio-runtime-smoke',
  provider: 'codex',
  executionConfig: {
    model: 'gpt-5.6-sol',
    effort: 'high',
    workflow: 'direct',
    permissionProfile: 'unrestricted',
  },
  clientContext: { documentId: 'studio-runtime-smoke-document' },
  resources: [],
};
const timeline = readTimeline({
  schema: TIMELINE_SCHEMA,
  version: TIMELINE_VERSION,
  exportedAt: new Date(0).toISOString(),
  thread: {
    id: 'studio-runtime-smoke-thread',
    title: 'Studio runtime smoke',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 1,
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    workflow: 'direct',
    docKey: path.basename(documentPath),
    documentId: 'studio-runtime-smoke-document',
    activeTemplateId: null,
    messages: [],
  },
}, manifest);
let harness;
try {
  harness = await createStudioHarness({
    manifest,
    workspace,
    credentials: {},
    document: {
      name: path.basename(documentPath),
      filename: documentPath,
      mimeType: selected.mimeType,
    },
    references: [{
      name: `reference-${path.basename(referencePath)}`,
      filename: referencePath,
      mimeType: formats[path.extname(referencePath).toLowerCase()]?.mimeType ?? 'application/octet-stream',
    }],
    timeline,
    studioRoot,
    agentRoot,
    chromiumPath,
    rhwpBin,
  });
  const destination = path.join(workspace, `roundtrip${extension}`);
  const receipt = await harness.exportDocument(selected.format, destination);
  const output = await fs.readFile(destination);
  if (output.length !== receipt.size || output.length < 1) throw new Error('Studio smoke export was incomplete');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    format: selected.format,
    size: output.length,
    sha256: receipt.sha256,
    referenceIndexed: true,
    formPackFiles,
  })}\n`);
} finally {
  await harness?.close();
  await fs.rm(workspace, { recursive: true, force: true });
}
