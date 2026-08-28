import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createStudioHarness } from './studio-harness.mjs';
import { composeTurnPrompt, readTimeline, TimelineRecorder } from './timeline.mjs';

const MAX_TIMELINE_BYTES = 100 * 1024 * 1024;

function runtimeError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function extensionOf(name) {
  const extension = path.extname(String(name ?? '')).toLowerCase();
  if (extension === '.hwp') return { extension, format: 'hwp', mimeType: 'application/x-hwp' };
  if (extension === '.hwpx') return { extension, format: 'hwpx', mimeType: 'application/vnd.hancom.hwpx' };
  if (extension === '.hml') return { extension, format: 'hml', mimeType: 'application/x-hml' };
  throw runtimeError('DOCUMENT_FORMAT_UNSUPPORTED', `Cloud document format is unsupported: ${extension || '(none)'}`);
}

function referenceMimeType(name) {
  return ({
    '.hwp': 'application/x-hwp',
    '.hwpx': 'application/vnd.hancom.hwpx',
    '.hml': 'application/x-hml',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  })[path.extname(String(name ?? '')).toLowerCase()] ?? 'application/octet-stream';
}

async function readJsonBounded(filename, maximum = MAX_TIMELINE_BYTES) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximum) {
    throw runtimeError('TIMELINE_INVALID', 'Portable timeline is missing, unsafe, or oversized');
  }
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    throw runtimeError('TIMELINE_INVALID', 'Portable timeline is not valid JSON', error);
  }
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

function findResource(manifest, kind) {
  return manifest.resources.find((resource) => resource.kind === kind) ?? null;
}

function assertLocalResource(resource, kind) {
  if (!resource || typeof resource.filename !== 'string' || !path.isAbsolute(resource.filename)) {
    throw runtimeError('MANIFEST_INVALID', `Cloud worker manifest has no local ${kind} resource`);
  }
  return resource;
}

async function getQueuedMessages(client) {
  const result = await client.messages();
  return Array.isArray(result?.messages) ? result.messages : [];
}

async function uploadTimeline(client, timelinePath, recorder) {
  await writeJsonAtomic(timelinePath, recorder.export());
  return client.upload(timelinePath, { name: 'timeline.json', kind: 'timeline' });
}

async function stableCheckpoint({ client, harness, workspace, format, extension, turnNumber }) {
  const directory = path.join(workspace, 'checkpoints');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const checkpointPath = path.join(directory, `turn-${String(turnNumber).padStart(4, '0')}${extension}`);
  const receipt = await harness.exportDocument(format, checkpointPath);
  const uploaded = await client.upload(checkpointPath, {
    name: path.basename(checkpointPath),
    kind: 'document',
  });
  return { checkpointPath, receipt, uploaded };
}

async function commitStableBoundary({ client, checkpoint, timeline, turnNumber }) {
  if (typeof client.commitBoundary !== 'function') {
    throw runtimeError('BOUNDARY_PROTOCOL_UNAVAILABLE', 'Worker atomic boundary commit is unavailable');
  }
  const operationId = `turn_${turnNumber}_${checkpoint.receipt.sha256.slice(0, 24)}`;
  const boundary = await client.commitBoundary({
    operationId,
    turnNumber,
    revision: turnNumber,
    checkpoint: { blobId: checkpoint.uploaded.id, size: checkpoint.uploaded.size },
    timeline: { blobId: timeline.id, size: timeline.size },
  });
  if (boundary?.operationId !== operationId
    || boundary?.turnNumber !== turnNumber
    || boundary?.revision !== turnNumber
    || boundary?.checkpoint?.blobId !== checkpoint.uploaded.id
    || boundary?.timeline?.blobId !== timeline.id) {
    throw runtimeError('BOUNDARY_COMMIT_INVALID', 'Worker atomic boundary receipt did not match its uploaded artifacts');
  }
  return boundary;
}

let forwardFailures = 0;

async function forwardEvent(client, event) {
  const type = event?.type === 'agent' ? 'agent.event' : String(event?.type ?? 'runtime.event')
    .toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 64);
  await client.event(type || 'runtime.event', event).catch((error) => {
    // Live activity is lossy by design, but repeated drops still leave a trace.
    forwardFailures += 1;
    if (forwardFailures === 1 || forwardFailures % 100 === 0) {
      console.warn(`[worker] event forwarding failed ${forwardFailures} times: ${error?.message ?? error}`);
    }
  });
}

function resultName(documentName, extension) {
  const stem = path.basename(documentName, path.extname(documentName)).slice(0, 160) || 'document';
  return `${stem}.cloud-result${extension}`;
}

/**
 * Execute a real Rauhwpx Studio session in headless Chromium. Provider CLIs
 * reach exactly the same rhwp-agent hub, MCP definitions, Studio bridge, tool
 * executor and WASM document engine as the desktop app.
 */
export async function runSession({
  manifest,
  workspace,
  credentials,
  client,
  createHarness = createStudioHarness,
  sessionDisplay = null,
}) {
  if (!manifest || typeof manifest !== 'object' || !manifest.sessionId || !manifest.provider) {
    throw runtimeError('MANIFEST_INVALID', 'Cloud worker manifest identity is incomplete');
  }
  const origin = assertLocalResource(findResource(manifest, 'document'), 'document');
  const timelineResource = assertLocalResource(findResource(manifest, 'timeline'), 'timeline');
  const fileType = extensionOf(origin.name);
  const stableRecovery = manifest.latestCheckpoint?.stable === true
    && typeof manifest.latestCheckpoint.filename === 'string'
    ? manifest.latestCheckpoint
    : null;
  const document = {
    name: origin.name,
    filename: stableRecovery?.filename ?? origin.filename,
    mimeType: fileType.mimeType,
  };
  const references = manifest.resources
    .filter((resource) => resource.kind === 'reference')
    .map((resource) => ({
      name: resource.name,
      filename: assertLocalResource(resource, 'reference').filename,
      mimeType: referenceMimeType(resource.name),
    }));
  const timeline = readTimeline(await readJsonBounded(timelineResource.filename), manifest);
  const recorder = new TimelineRecorder(timeline);
  const timelinePath = path.join(workspace, 'timeline.json');
  const deadline = Date.now() + Math.max(60_000, Number(manifest.limits?.maxDurationSeconds) * 1_000 || 8 * 60 * 60 * 1_000);
  const maxTurns = Math.max(1, Number(manifest.limits?.maxTurns) || 100);
  let turnNumber = Math.max(0, Number(manifest.limits?.turnsUsed) || stableRecovery?.turnNumber || 0);
  let latestCheckpoint = null;
  let harness;
  await client.event('runtime.started', {
    provider: manifest.provider,
    recovered: Boolean(stableRecovery),
    referenceCount: references.length,
    turnNumber,
  });
  try {
    const initialGoal = String(manifest.goal ?? '').trim();
    let messages = [];
    let finishReady = false;
    const acknowledgeTakeover = async (operationId) => {
      if (typeof client.takeoverAck !== 'function') {
        throw runtimeError('TAKEOVER_PROTOCOL_UNAVAILABLE', 'Worker takeover acknowledgement is unavailable');
      }
      if (typeof operationId !== 'string' || !operationId) {
        throw runtimeError('TAKEOVER_BOUNDARY_UNAVAILABLE', 'Worker takeover has no committed stable boundary');
      }
      await client.event('runtime.takeover_ready', { turnNumber, operationId });
      // takeover-ack revokes this worker's control token. It must be the final
      // control-plane call made by the runtime.
      await client.takeoverAck();
      return { takenOver: true, timelinePath };
    };
    const acknowledgePause = async () => {
      if (typeof client.pauseAck !== 'function') {
        throw runtimeError('PAUSE_PROTOCOL_UNAVAILABLE', 'Worker pause acknowledgement is unavailable');
      }
      await client.event('runtime.paused', { turnNumber });
      // pause-ack revokes this worker's control token. It must be the final
      // control-plane call made by the runtime.
      await client.pauseAck();
      return { paused: true, timelinePath };
    };
    const claimFinish = async () => {
      if (typeof client.finishClaim !== 'function') {
        throw runtimeError('FINISH_PROTOCOL_UNAVAILABLE', 'Worker atomic finish claim is unavailable');
      }
      const claim = await client.finishClaim();
      if (claim?.takeoverRequested === true) {
        return { outcome: await acknowledgeTakeover(latestCheckpoint?.boundary?.operationId ?? stableRecovery?.operationId) };
      }
      if (claim?.pauseRequested === true) {
        return { outcome: await acknowledgePause() };
      }
      if (claim?.ready === true) return { ready: true, messages: [] };
      if (!Array.isArray(claim?.messages) || claim.messages.length === 0) {
        throw runtimeError('FINISH_PROTOCOL_INVALID', 'Worker atomic finish claim returned no decision');
      }
      return { ready: false, messages: claim.messages };
    };
    const publishStableRecovery = async () => {
      if (!stableRecovery) {
        throw runtimeError('STABLE_RECOVERY_UNAVAILABLE', 'Stable recovery artifacts are unavailable');
      }
      if (path.resolve(timelineResource.filename) !== path.resolve(timelinePath)) {
        await fs.copyFile(timelineResource.filename, timelinePath);
      }
      await fs.chmod(timelinePath, 0o600);
      const name = resultName(origin.name, fileType.extension);
      const resultPath = path.join(workspace, name);
      await fs.copyFile(stableRecovery.filename, resultPath);
      await fs.chmod(resultPath, 0o600);
      await client.event('runtime.completed', { turnNumber, resultName: name });
      return { timelinePath, resultPath, resultName: name };
    };

    if (stableRecovery) {
      // Resolve the atomic message/control gate before starting Chromium. Most
      // pause/resume recoveries have no new work and can publish the exact
      // durable boundary without loading the document runtime at all.
      const decision = await claimFinish();
      if (decision.outcome) return decision.outcome;
      if (decision.ready) return await publishStableRecovery();
      if (turnNumber >= maxTurns) {
        throw runtimeError(
          'TURN_LIMIT_PENDING_MESSAGES',
          'Cloud session reached its turn limit before queued messages could be processed',
        );
      }
      messages = decision.messages;
    } else {
      messages = [{ id: null, content: initialGoal, initial: true }];
    }

    harness = await createHarness({
      manifest,
      workspace,
      credentials: credentials ?? {},
      document,
      references,
      timeline,
      displayEnv: sessionDisplay?.environment ?? null,
      onEvent: async (event) => {
        if (event?.type?.startsWith?.('environment.')) recorder.recordEnvironmentEvent(event);
        recorder.consume(event);
        await forwardEvent(client, event);
      },
    });
    if (sessionDisplay?.snapshot) {
      recorder.recordEnvironmentEvent({
        type: sessionDisplay.status === 'ready' ? 'environment.display_ready' : `environment.display_${sessionDisplay.status}`,
        ...sessionDisplay.snapshot(),
      });
    }
    await harness.start({ history: recorder.history({ excludeTrailingUserText: stableRecovery ? null : initialGoal }) });

    while (!finishReady && turnNumber < maxTurns && Date.now() < deadline) {
      if (sessionDisplay && sessionDisplay.status === 'error') {
        const restarted = await sessionDisplay.restart({ reason: 'health-loop' });
        recorder.recordEnvironmentEvent({
          type: restarted.status === 'ready' ? 'environment.display_restarted' : 'environment.display_failed',
          ...restarted,
        });
        await forwardEvent(client, {
          type: restarted.status === 'ready' ? 'environment.display_restarted' : 'environment.display_failed',
          ...restarted,
        });
      }
      for (const message of messages) {
        if (turnNumber >= maxTurns || Date.now() >= deadline) break;
        const content = String(message.content ?? '').trim();
        if (!content) continue;
        recorder.acceptUserMessage(content, { messageId: message.id ?? null, initial: message.initial === true });
        await client.event('turn.dispatched', { turnNumber: turnNumber + 1, messageId: message.id ?? null });
        const outcome = await harness.runTurn(composeTurnPrompt(content, references), {
          timeoutMs: Math.max(1_000, deadline - Date.now()),
        });
        if (outcome?.errorMessage || !['end_turn', 'completed', 'success'].includes(outcome?.stopReason)) {
          throw runtimeError('PROVIDER_TURN_FAILED', outcome?.errorMessage || `Provider stopped with ${outcome?.stopReason ?? 'unknown reason'}`);
        }
        turnNumber += 1;
        const checkpoint = await stableCheckpoint({
          client,
          harness,
          workspace,
          format: fileType.format,
          extension: fileType.extension,
          turnNumber,
        });
        const timelineUpload = await uploadTimeline(client, timelinePath, recorder);
        const boundary = await commitStableBoundary({
          client,
          checkpoint,
          timeline: timelineUpload,
          turnNumber,
        });
        latestCheckpoint = { ...checkpoint, boundary };
        const completed = await client.completeTurn();
        if (completed?.status === 'suspended') {
          return { suspended: true, timelinePath };
        }
        const control = typeof client.control === 'function' ? await client.control() : {};
        if (control?.takeoverRequested === true) {
          return await acknowledgeTakeover(boundary.operationId);
        }
        if (control?.pauseRequested === true) {
          return await acknowledgePause();
        }
      }
      messages = await getQueuedMessages(client);
      if (messages.length) continue;
      const decision = await claimFinish();
      if (decision.outcome) return decision.outcome;
      if (decision.ready) {
        finishReady = true;
        continue;
      }
      messages = decision.messages;
    }

    if (Date.now() >= deadline) throw runtimeError('DURATION_LIMIT', 'Cloud session reached its duration limit');
    if (turnNumber >= maxTurns && !latestCheckpoint && !stableRecovery) {
      throw runtimeError('TURN_LIMIT', 'Cloud session reached its turn limit before producing a checkpoint');
    }
    if (!latestCheckpoint && stableRecovery) {
      return await publishStableRecovery();
    }
    if (!latestCheckpoint) {
      const checkpointTurn = Math.max(1, turnNumber || stableRecovery?.turnNumber || 1);
      latestCheckpoint = await stableCheckpoint({
        client,
        harness,
        workspace,
        format: fileType.format,
        extension: fileType.extension,
        turnNumber: checkpointTurn,
      });
      const timelineUpload = await uploadTimeline(client, timelinePath, recorder);
      const boundary = await commitStableBoundary({
        client,
        checkpoint: latestCheckpoint,
        timeline: timelineUpload,
        turnNumber: checkpointTurn,
      });
      latestCheckpoint = { ...latestCheckpoint, boundary };
    }
    const name = resultName(origin.name, fileType.extension);
    const resultPath = path.join(workspace, name);
    await fs.copyFile(latestCheckpoint.checkpointPath, resultPath);
    await fs.chmod(resultPath, 0o600);
    await client.event('runtime.completed', { turnNumber, resultName: name });
    return { timelinePath, resultPath, resultName: name };
  } finally {
    await harness?.close().catch(() => {});
  }
}
