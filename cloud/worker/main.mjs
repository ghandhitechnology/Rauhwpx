import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerClient } from './client.mjs';

process.umask(0o077);

const sessionId = process.env.RAUHWpx_SESSION_ID;
const token = process.env.RAUHWpx_WORKER_TOKEN;
const socketPath = process.env.RAUHWpx_CONTROL_SOCKET;
const workspace = '/workspace';
if (!sessionId || !token || !socketPath) throw new Error('Worker identity is incomplete');

const client = new WorkerClient({ socketPath, token, sessionId });
const heartbeat = setInterval(() => { void client.heartbeat().catch(() => {}); }, 15_000);
heartbeat.unref();

function safeName(name) {
  return path.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180) || 'resource.bin';
}

try {
  await fs.mkdir(path.join(workspace, 'home'), { recursive: true, mode: 0o700 });
  await fs.cp('/provider-auth', path.join(workspace, 'home'), { recursive: true, force: false });
  const manifest = await client.manifest();
  const { credentials } = await client.credentials();
  const inputDirectory = path.join(workspace, 'input');
  await fs.mkdir(inputDirectory, { recursive: true, mode: 0o700 });
  const localResources = [];
  for (const resource of manifest.resources) {
    const filename = path.join(inputDirectory, `${resource.kind}-${safeName(resource.name)}`);
    await client.download(resource.blobId, filename);
    localResources.push({ ...resource, filename });
  }
  if (manifest.latestCheckpoint) {
    const filename = path.join(inputDirectory, `checkpoint-${manifest.latestCheckpoint.revision}.bin`);
    await client.download(manifest.latestCheckpoint.blobId, filename);
    manifest.latestCheckpoint.filename = filename;
  }
  const resolvedManifest = { ...manifest, resources: localResources };
  await fs.writeFile(
    path.join(workspace, 'manifest.json'),
    JSON.stringify(resolvedManifest),
    { mode: 0o600 },
  );
  const runtimePath = process.env.RAUHWpx_DOCUMENT_RUNTIME || '/app/document-runtime/run.mjs';
  const runtime = await import(pathToFileURL(runtimePath).href);
  if (typeof runtime.runSession !== 'function') throw new Error('Document runtime must export runSession');
  const outcome = await runtime.runSession({
    manifest: resolvedManifest,
    workspace,
    credentials,
    client,
  });
  if (outcome?.paused !== true && outcome?.suspended !== true && outcome?.takenOver !== true) {
    if (!outcome?.timelinePath) throw new Error('Document runtime did not return timelinePath');
    if (!outcome?.resultPath) throw new Error('Document runtime did not return resultPath');
    const result = await client.upload(outcome.resultPath, {
      name: outcome.resultName || manifest.resources.find((resource) => resource.kind === 'document')?.name || 'result.hwpx',
      kind: 'result',
    });
    await client.publishResult(result);
  }
} catch (error) {
  await client.suspend(error.code || 'WORKER_FAILED', error.message || String(error)).catch(() => {});
  throw error;
} finally {
  clearInterval(heartbeat);
}
