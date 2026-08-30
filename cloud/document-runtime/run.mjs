import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionDisplayMode } from './session-display.mjs';
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

function safeAttachmentFilename(name, fallback) {
  const base = path.basename(String(name ?? '')).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180);
  return base && base !== '.' && base !== '..' ? base : fallback;
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

async function uploadTimeline(client, timelinePath, recorder) {
  await writeJsonAtomic(timelinePath, recorder.export());
  return client.upload(timelinePath, { name: 'timeline.json', kind: 'timeline' });
}

async function stableCheckpoint({ client, harness, workspace, format, extension, turnNumber, revision, kind }) {
  const directory = path.join(workspace, 'checkpoints');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const checkpointPath = path.join(
    directory,
    `${kind}-${String(turnNumber).padStart(4, '0')}-r${String(revision).padStart(6, '0')}${extension}`,
  );
  const receipt = await harness.exportDocument(format, checkpointPath);
  const uploaded = await client.upload(checkpointPath, {
    name: path.basename(checkpointPath),
    kind: 'document',
  });
  return { checkpointPath, receipt, uploaded };
}

async function commitStableBoundary({ client, checkpoint, timeline, turnNumber, revision, kind }) {
  if (typeof client.commitBoundary !== 'function') {
    throw runtimeError('BOUNDARY_PROTOCOL_UNAVAILABLE', 'Worker atomic boundary commit is unavailable');
  }
  const operationId = kind === 'turn'
    ? `turn_${turnNumber}_${checkpoint.receipt.sha256.slice(0, 24)}`
    : `${kind}_${turnNumber}_${revision}_${checkpoint.receipt.sha256.slice(0, 24)}`;
  const boundary = await client.commitBoundary({
    operationId,
    turnNumber,
    revision,
    kind,
    checkpoint: { blobId: checkpoint.uploaded.id, size: checkpoint.uploaded.size },
    timeline: { blobId: timeline.id, size: timeline.size },
  });
  if (boundary?.operationId !== operationId
    || boundary?.turnNumber !== turnNumber
    || boundary?.revision !== revision
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
 * Execute a real Rauhwpx Studio session in Chromium. Production Xvfb sessions
 * run headed so the live viewer sees the same Studio surface. Provider CLIs
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
  displayMode = createSessionDisplayMode(sessionDisplay),
  onStudioReady = () => {},
  onStudioUnavailable = () => {},
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
  const recoveredCompletedTurn = stableRecovery?.kind === 'turn'
    ? Number(stableRecovery.turnNumber) || 0
    : 0;
  let turnNumber = Math.max(0, Number(manifest.limits?.turnsUsed) || 0, recoveredCompletedTurn);
  let revision = Math.max(0, Number(stableRecovery?.revision) || 0);
  let activeWorkflow = manifest.executionConfig?.workflow === 'plan' ? 'plan' : 'direct';
  let latestCheckpoint = null;
  let harness;
  let studioUnavailable = false;
  const clearStudioReadiness = async () => {
    if (studioUnavailable) return;
    studioUnavailable = true;
    try { await onStudioUnavailable(); } catch { /* Worker teardown remains authoritative. */ }
  };
  let assertRuntimeHealthy = async () => {};
  await client.event('runtime.started', {
    provider: manifest.provider,
    recovered: Boolean(stableRecovery),
    referenceCount: references.length,
    turnNumber,
  });
  try {
    assertRuntimeHealthy = async () => {
      if (displayMode.kind === 'headed') {
        const snapshot = sessionDisplay?.snapshot?.();
        const currentDisplay = snapshot?.display ?? sessionDisplay?.display ?? sessionDisplay?.environment?.DISPLAY;
        if (snapshot?.status !== 'ready' || currentDisplay !== displayMode.display) {
          await clearStudioReadiness();
          throw runtimeError(
            'DISPLAY_LOST',
            `Cloud Studio session display ${displayMode.display} is no longer available`,
          );
        }
      }
      try {
        await harness?.assertHealthy?.();
      } catch (error) {
        await clearStudioReadiness();
        throw error;
      }
    };
    const waitForHealthyOperation = async (operation) => {
      await assertRuntimeHealthy();
      const controller = new AbortController();
      const settled = Promise.resolve()
        .then(() => operation(controller.signal))
        .then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        );
      try {
        while (true) {
          let timer;
          const outcome = await Promise.race([
            settled,
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), 250); }),
          ]);
          clearTimeout(timer);
          if (outcome) {
            if (outcome.error) throw outcome.error;
            return outcome.value;
          }
          await assertRuntimeHealthy();
          if (Date.now() >= deadline) throw runtimeError('DURATION_LIMIT', 'Cloud session reached its duration limit');
        }
      } finally {
        controller.abort();
      }
    };
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
    const acknowledgeSleep = async () => {
      if (typeof client.sleepAck !== 'function') {
        throw runtimeError('SLEEP_PROTOCOL_UNAVAILABLE', 'Worker sleep acknowledgement is unavailable');
      }
      await client.event('runtime.sleeping', { turnNumber });
      const acknowledged = await client.sleepAck();
      if (acknowledged?.status === 'running') return { sleepCancelled: true };
      return { sleeping: true, timelinePath };
    };
    const claimFinish = async () => {
      if (typeof client.finishClaim !== 'function') {
        throw runtimeError('FINISH_PROTOCOL_UNAVAILABLE', 'Worker atomic finish claim is unavailable');
      }
      const claim = await waitForHealthyOperation((signal) => client.finishClaim({ signal }));
      if (claim?.workflow === 'direct' || claim?.workflow === 'plan') activeWorkflow = claim.workflow;
      if (claim?.takeoverRequested === true) {
        return { outcome: await acknowledgeTakeover(latestCheckpoint?.boundary?.operationId ?? stableRecovery?.operationId) };
      }
      if (claim?.pauseRequested === true) {
        return { outcome: await acknowledgePause() };
      }
      if (claim?.sleepRequested === true) {
        const sleep = await acknowledgeSleep();
        if (sleep.sleepCancelled) return { ready: false, waiting: true, messages: [] };
        return { outcome: sleep };
      }
      if (claim?.ready === true) return { ready: true, messages: [] };
      if (claim?.waiting === true) return { ready: false, waiting: true, messages: [] };
      if (!Array.isArray(claim?.messages) || claim.messages.length === 0) {
        throw runtimeError('FINISH_PROTOCOL_INVALID', 'Worker atomic finish claim returned no decision');
      }
      return { ready: false, messages: claim.messages };
    };
    const awaitConversationInput = async (decision) => {
      let current = decision;
      while (current?.waiting === true && Date.now() < deadline) {
        await assertRuntimeHealthy();
        await delay(250);
        current = await claimFinish();
      }
      return current;
    };
    const publishRecovery = async (sourceFilename) => {
      if (path.resolve(timelineResource.filename) !== path.resolve(timelinePath)) {
        await fs.copyFile(timelineResource.filename, timelinePath);
      }
      await fs.chmod(timelinePath, 0o600);
      const name = resultName(origin.name, fileType.extension);
      const resultPath = path.join(workspace, name);
      await fs.copyFile(sourceFilename, resultPath);
      await fs.chmod(resultPath, 0o600);
      await client.event('runtime.completed', { turnNumber, resultName: name });
      return { timelinePath, resultPath, resultName: name };
    };

    if (manifest.endRequested === true) {
      const decision = await claimFinish();
      if (decision.outcome) return decision.outcome;
      if (!decision.ready) throw runtimeError('END_PROTOCOL_INVALID', 'Ended conversation did not open its result gate');
      return await publishRecovery(stableRecovery?.filename ?? origin.filename);
    }

    if (stableRecovery) {
      // Resolve the atomic message/control gate before starting Chromium. Most
      // pause/resume recoveries have no new work and can publish the exact
      // durable boundary without loading the document runtime at all.
      const decision = await awaitConversationInput(await claimFinish());
      if (decision.outcome) return decision.outcome;
      if (decision.ready) return await publishRecovery(stableRecovery.filename);
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

    await assertRuntimeHealthy();
    harness = await createHarness({
      manifest,
      workspace,
      credentials: credentials ?? {},
      document,
      references,
      timeline,
      displayEnv: displayMode.environment,
      displayGeometry: displayMode.geometry,
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
    await assertRuntimeHealthy();
    await onStudioReady();
    await harness.setWorkflow?.(activeWorkflow);

    const materializeAttachments = async (message) => {
      if (!Array.isArray(message.attachments) || message.attachments.length === 0) return [];
      if (typeof client.download !== 'function' || typeof harness.addReferences !== 'function') {
        throw runtimeError('ATTACHMENT_PROTOCOL_UNAVAILABLE', 'Worker follow-up attachment protocol is unavailable');
      }
      const messageDirectory = String(message.id ?? 'initial').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'message';
      const directory = path.join(workspace, 'follow-up-attachments', messageDirectory);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const additions = [];
      for (let index = 0; index < message.attachments.length; index += 1) {
        const attachment = message.attachments[index];
        if (!attachment || typeof attachment.blobId !== 'string' || !/^[a-f0-9]{64}$/.test(attachment.blobId)) {
          throw runtimeError('ATTACHMENT_MANIFEST_INVALID', 'Queued attachment identity is invalid');
        }
        const name = safeAttachmentFilename(attachment.name, `attachment-${index + 1}.bin`);
        const filename = path.join(directory, `${String(index).padStart(2, '0')}-${name}`);
        await client.download(attachment.blobId, filename);
        const stat = await fs.stat(filename);
        if (!stat.isFile() || stat.size !== attachment.size) {
          throw runtimeError('ATTACHMENT_CORRUPT', `Queued attachment failed verification: ${name}`);
        }
        additions.push({
          name,
          filename,
          mimeType: attachment.mimeType || referenceMimeType(name),
          attachmentId: attachment.attachmentId,
          version: attachment.version,
        });
      }
      await harness.addReferences(additions);
      references.push(...additions);
      return additions;
    };

    while (!finishReady && turnNumber < maxTurns && Date.now() < deadline) {
      await assertRuntimeHealthy();
      for (const message of messages) {
        if (turnNumber >= maxTurns || Date.now() >= deadline) break;
        const content = String(message.content ?? '').trim();
        if (!content) continue;
        const nextTurnNumber = turnNumber + 1;
        await harness.setWorkflow?.(activeWorkflow);
        await materializeAttachments(message);
        recorder.acceptUserMessage(content, { messageId: message.id ?? null, initial: message.initial === true });
        if (manifest.persistent && typeof client.beginTurn === 'function') {
          await client.beginTurn({
            turnNumber: nextTurnNumber,
            messageId: message.id ?? null,
            mode: activeWorkflow,
          });
        }
        await client.event('turn.dispatched', { turnNumber: nextTurnNumber, messageId: message.id ?? null });
        const checkpointBoundary = async (kind) => {
          revision += 1;
          const checkpoint = await stableCheckpoint({
            client,
            harness,
            workspace,
            format: fileType.format,
            extension: fileType.extension,
            turnNumber: nextTurnNumber,
            revision,
            kind,
          });
          const timelineUpload = await uploadTimeline(client, timelinePath, recorder);
          const boundary = await commitStableBoundary({
            client,
            checkpoint,
            timeline: timelineUpload,
            turnNumber: nextTurnNumber,
            revision,
            kind,
          });
          latestCheckpoint = { ...checkpoint, boundary };
          return boundary;
        };
        const runProvider = (resume = null) => harness.runTurn(
          resume ? '' : composeTurnPrompt(content, references),
          {
            timeoutMs: Math.max(1_000, deadline - Date.now()),
            resume,
            readControl: typeof client.control === 'function' ? () => client.control() : null,
            onSafeBoundary: () => checkpointBoundary('operation'),
          },
        );
        let outcome = await runProvider();
        let endedDuringWait = false;
        while (outcome?.wait) {
          if (typeof client.createWait !== 'function' || typeof client.wait !== 'function') {
            throw runtimeError('WAIT_PROTOCOL_UNAVAILABLE', 'Worker durable wait protocol is unavailable');
          }
          const wait = await waitForHealthyOperation((signal) => client.createWait({
            turnNumber: nextTurnNumber,
            kind: outcome.wait.kind,
            payload: outcome.wait.payload,
          }, { signal }));
          let waitState = wait;
          while (waitState?.status === 'pending' && Date.now() < deadline) {
            await assertRuntimeHealthy();
            await delay(250);
            waitState = await waitForHealthyOperation((signal) => client.wait(wait.id, { signal }));
          }
          if (Date.now() >= deadline) throw runtimeError('DURATION_LIMIT', 'Cloud session reached its duration limit');
          const resolution = waitState?.resolution;
          if (waitState?.status === 'cancelled' || resolution?.action === 'cancel') {
            endedDuringWait = true;
            outcome = { stopReason: 'interrupted', redirected: false };
            break;
          }
          const waitKind = String(outcome.wait.kind ?? '');
          const planId = String(outcome.wait.payload?.planId ?? '');
          if (waitKind === 'plan-approval' && resolution?.action === 'approve') {
            outcome = await runProvider({ action: 'approve', planId });
          } else if (waitKind === 'plan-approval' && resolution?.action === 'changes') {
            outcome = await runProvider({
              action: 'changes',
              planId,
              feedback: String(resolution.feedback ?? '').trim() || 'Please revise the plan.',
            });
          } else if (waitKind === 'question' && resolution?.action === 'answer') {
            const feedback = String(resolution.feedback ?? '').trim();
            if (!feedback) throw runtimeError('WAIT_RESOLUTION_INVALID', 'Question wait requires a non-empty answer');
            outcome = await runProvider({ action: 'answer', feedback });
          } else if (['external-side-effect', 'destructive-external'].includes(waitKind)
            && resolution?.action === 'approve') {
            outcome = await runProvider({
              action: 'external-effect',
              kind: waitKind,
              feedback: String(resolution.feedback ?? '').trim(),
            });
          } else {
            throw runtimeError('WAIT_RESOLUTION_INVALID', 'Durable wait returned an unsupported resolution');
          }
        }
        const redirected = outcome?.redirected === true;
        if (outcome?.errorMessage
          || (!endedDuringWait && !redirected && !['end_turn', 'completed', 'success'].includes(outcome?.stopReason))) {
          throw runtimeError('PROVIDER_TURN_FAILED', outcome?.errorMessage || `Provider stopped with ${outcome?.stopReason ?? 'unknown reason'}`);
        }
        turnNumber = nextTurnNumber;
        const boundary = await checkpointBoundary('turn');
        const completed = await client.completeTurn({
          outcome: redirected ? 'redirected' : endedDuringWait ? 'stopped' : 'completed',
          boundaryOperationId: boundary.operationId,
        });
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
      const decision = await awaitConversationInput(await claimFinish());
      if (decision.outcome) return decision.outcome;
      if (decision.ready) {
        finishReady = true;
        continue;
      }
      messages = decision.messages;
    }

    await assertRuntimeHealthy();
    if (Date.now() >= deadline) throw runtimeError('DURATION_LIMIT', 'Cloud session reached its duration limit');
    if (turnNumber >= maxTurns && !latestCheckpoint && !stableRecovery) {
      throw runtimeError('TURN_LIMIT', 'Cloud session reached its turn limit before producing a checkpoint');
    }
    if (!latestCheckpoint && stableRecovery) {
      return await publishRecovery(stableRecovery.filename);
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
        revision: ++revision,
        kind: 'turn',
      });
      const timelineUpload = await uploadTimeline(client, timelinePath, recorder);
      const boundary = await commitStableBoundary({
        client,
        checkpoint: latestCheckpoint,
        timeline: timelineUpload,
        turnNumber: checkpointTurn,
        revision,
        kind: 'turn',
      });
      latestCheckpoint = { ...latestCheckpoint, boundary };
    }
    const name = resultName(origin.name, fileType.extension);
    const resultPath = path.join(workspace, name);
    await fs.copyFile(latestCheckpoint.checkpointPath, resultPath);
    await fs.chmod(resultPath, 0o600);
    await client.event('runtime.completed', { turnNumber, resultName: name });
    return { timelinePath, resultPath, resultName: name };
  } catch (error) {
    await assertRuntimeHealthy();
    throw error;
  } finally {
    await clearStudioReadiness();
    await harness?.close().catch(() => {});
  }
}
