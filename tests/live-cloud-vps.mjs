#!/usr/bin/env node

import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { CloudClient, CloudHttpError } from '../desktop/cloud-client.mjs';

const action = process.argv[2] || 'status';
const endpoint = process.env.RAUHWpx_LIVE_ENDPOINT
  || 'https://ishsoutside-vps.tailde5380.ts.net:8443/rauhwpx-cloud';
const address = process.env.RAUHWpx_LIVE_ADDRESS || '';
const vaultPath = path.resolve(process.env.RAUHWpx_LIVE_VAULT || '.rauhwpx-live-vault.json');
const statePath = path.resolve(process.env.RAUHWpx_LIVE_STATE || '.rauhwpx-live-state.json');

class JsonVault {
  constructor(filename, values) {
    this.filename = filename;
    this.values = values;
  }

  static async open(filename) {
    const stored = await fs.readFile(filename, 'utf8').then(JSON.parse).catch((error) => {
      if (error.code === 'ENOENT') return {};
      throw error;
    });
    return new JsonVault(filename, new Map(Object.entries(stored)));
  }

  get(key) { return Promise.resolve(this.values.get(key) ?? null); }

  async set(key, value) {
    this.values.set(key, value);
    await this.persist();
    return true;
  }

  async delete(key) {
    const deleted = this.values.delete(key);
    await this.persist();
    return deleted;
  }

  async persist() {
    const temporary = `${this.filename}.tmp-${process.pid}`;
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, `${JSON.stringify(Object.fromEntries(this.values))}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filename);
    await fs.chmod(this.filename, 0o600);
  }
}

function resolvedFetch(input, init = {}) {
  const url = new URL(input);
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    const request = https.request(url, {
      method: init.method || 'GET',
      headers,
      signal: init.signal,
      servername: url.hostname,
      ...(address ? {
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
      } : {}),
    }, (response) => {
      const abortResponse = () => response.destroy(new DOMException('The operation was aborted', 'AbortError'));
      init.signal?.addEventListener('abort', abortResponse, { once: true });
      response.once('close', () => init.signal?.removeEventListener('abort', abortResponse));
      const responseHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      }
      const body = [204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(response);
      resolve(new Response(body, {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }));
    });
    request.once('error', reject);
    if (init.body == null) request.end();
    else if (typeof init.body === 'string' || Buffer.isBuffer(init.body)) request.end(init.body);
    else if (ArrayBuffer.isView(init.body)) request.end(Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength));
    else reject(new Error('Live smoke fetch received an unsupported request body'));
  });
}

async function readState() {
  return fs.readFile(statePath, 'utf8').then(JSON.parse);
}

async function writeState(value) {
  const temporary = `${statePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, statePath);
  await fs.chmod(statePath, 0o600);
}

function publicProfile(value) {
  return {
    server: value.server,
    limits: value.limits,
    providers: value.providers,
    devices: value.devices?.map((device) => ({ id: device.id, name: device.name, revokedAt: device.revokedAt })),
  };
}

const vault = await JsonVault.open(vaultPath);
const client = new CloudClient({ vault, fetchImpl: resolvedFetch });

if (action === 'pair') {
  const pairingFile = process.env.RAUHWpx_LIVE_PAIRING_FILE;
  if (!pairingFile) throw new Error('RAUHWpx_LIVE_PAIRING_FILE is required');
  const pairing = JSON.parse(await fs.readFile(pairingFile, 'utf8'));
  await client.saveProfile({
    endpoint,
    transport: 'tailscale',
    tailscaleHttpsPort: Number(new URL(endpoint).port || 443),
    serverPublicKey: pairing.serverPublicKey,
    ssh: { host: address || new URL(endpoint).hostname, user: 'root', useTailscaleSsh: true },
  });
  const health = await client.health();
  const redeemed = await client.redeemPairingCode(pairing.code, process.env.RAUHWpx_LIVE_DEVICE_NAME || 'Live verifier');
  const profile = await client.profile();
  console.log(JSON.stringify({ health, redeemed, profile: publicProfile(profile) }, null, 2));
} else if (action === 'status') {
  const [health, profile, sessions] = await Promise.all([client.health(), client.profile(), client.sessions()]);
  console.log(JSON.stringify({ health, profile: publicProfile(profile), sessions }, null, 2));
} else if (action === 'create-pairing') {
  const output = path.resolve(process.env.RAUHWpx_LIVE_PAIRING_OUTPUT || '.rauhwpx-live-pairing.json');
  const [health, pairing] = await Promise.all([
    client.health(),
    client.createPairingCode(process.env.RAUHWpx_LIVE_DEVICE_NAME || 'Secondary live verifier'),
  ]);
  await fs.writeFile(output, `${JSON.stringify({ ...pairing, serverPublicKey: health.serverPublicKey })}\n`, { mode: 0o600 });
  await fs.chmod(output, 0o600);
  console.log(JSON.stringify({ created: true, expiresAt: pairing.expiresAt, output }, null, 2));
} else if (action === 'transfer') {
  const documentPath = path.resolve(process.env.RAUHWpx_LIVE_DOCUMENT || 'rhwp/samples/KTX.hwp');
  const provider = process.env.RAUHWpx_LIVE_PROVIDER || 'codex';
  const model = process.env.RAUHWpx_LIVE_MODEL || 'gpt-5.6-sol';
  const effort = process.env.RAUHWpx_LIVE_EFFORT || 'high';
  const goal = process.env.RAUHWpx_LIVE_GOAL || 'Add a short verification line to the document and verify the edit.';
  const now = Date.now();
  const sessionId = process.env.RAUHWpx_LIVE_SESSION_ID || `live_${now}_${randomUUID().slice(0, 8)}`;
  const threadId = `thread_${sessionId}`;
  const documentId = `document_${sessionId}`;
  const timeline = {
    schema: 'rauhwpx.cloud.timeline',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    thread: {
      id: threadId,
      title: 'Live VPS verification',
      createdAt: now,
      updatedAt: now,
      agent: provider,
      model,
      effort,
      workflow: 'direct',
      messages: [],
    },
  };
  const progress = [];
  const session = await client.transfer({
    sessionId,
    threadId,
    documentId,
    provider,
    executionConfig: { model, effort, workflow: 'direct', permissionProfile: 'unrestricted' },
    goal,
    documentName: path.basename(documentPath),
    documentBytes: await fs.readFile(documentPath),
    timeline,
    limits: { maxDurationSeconds: 15 * 60, maxTurns: Number(process.env.RAUHWpx_LIVE_MAX_TURNS || 3) },
    onProgress: (event) => { progress.push(event.phase); },
  });
  await writeState({ sessionId, documentPath, provider, goal, createdAt: new Date().toISOString() });
  console.log(JSON.stringify({ session, progress: [...new Set(progress)], statePath }, null, 2));
} else if (action === 'poll') {
  const { sessionId } = await readState();
  const deadline = Date.now() + Number(process.env.RAUHWpx_LIVE_POLL_SECONDS || 300) * 1_000;
  const states = [];
  let session;
  while (Date.now() < deadline) {
    session = await client.session(sessionId);
    if (states.at(-1) !== session.status) states.push(session.status);
    if (['completed', 'failed', 'cancelled', 'purged', 'suspended'].includes(session.status)) break;
    await delay(2_000);
  }
  console.log(JSON.stringify({ session, states }, null, 2));
} else if (action === 'wait') {
  const { sessionId } = await readState();
  const wanted = new Set(String(process.env.RAUHWpx_LIVE_WAIT_FOR || 'running').split(',').map((value) => value.trim()).filter(Boolean));
  const deadline = Date.now() + Number(process.env.RAUHWpx_LIVE_POLL_SECONDS || 300) * 1_000;
  const states = [];
  let session;
  while (Date.now() < deadline) {
    session = await client.session(sessionId);
    if (states.at(-1) !== session.status) states.push(session.status);
    if (wanted.has(session.status)) break;
    if (['completed', 'failed', 'cancelled', 'purged'].includes(session.status)) break;
    await delay(500);
  }
  if (!session || !wanted.has(session.status)) {
    throw new Error(`Session did not reach ${[...wanted].join(',')} (last status: ${session?.status || 'unknown'})`);
  }
  console.log(JSON.stringify({ session, states }, null, 2));
} else if (action === 'events') {
  const { sessionId } = await readState();
  const events = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.RAUHWpx_LIVE_EVENTS_MS || 5_000));
  try {
    await client.readEvents(sessionId, Number(process.env.RAUHWpx_LIVE_AFTER || 0), {
      signal: controller.signal,
      onEvent: (event) => { events.push(event); },
    });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timeout);
  }
  console.log(JSON.stringify({ sessionId, events }, null, 2));
} else if (action === 'command') {
  const { sessionId } = await readState();
  const type = process.env.RAUHWpx_LIVE_COMMAND;
  if (!type) throw new Error('RAUHWpx_LIVE_COMMAND is required');
  const session = await client.session(sessionId);
  const payload = type === 'message.queue'
    ? { content: process.env.RAUHWpx_LIVE_MESSAGE || 'Continue and verify the requested edit.' }
    : { expectedVersion: session.stateVersion };
  const result = await client.command(sessionId, type, payload, `live_${type.replaceAll('.', '_')}_${randomUUID()}`);
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'takeover') {
  const { sessionId } = await readState();
  const state = await client.takeoverState(sessionId);
  const checkpoint = await client.downloadCheckpoint(sessionId);
  const timeline = await client.downloadTimeline(sessionId);
  const checkpointOutput = process.env.RAUHWpx_LIVE_CHECKPOINT
    ? path.resolve(process.env.RAUHWpx_LIVE_CHECKPOINT)
    : null;
  const timelineOutput = process.env.RAUHWpx_LIVE_TIMELINE
    ? path.resolve(process.env.RAUHWpx_LIVE_TIMELINE)
    : null;
  if (checkpointOutput) await fs.writeFile(checkpointOutput, checkpoint.bytes, { mode: 0o600 });
  if (timelineOutput) await fs.writeFile(timelineOutput, timeline.bytes, { mode: 0o600 });
  console.log(JSON.stringify({
    state,
    checkpoint: {
      sha256: checkpoint.sha256,
      size: checkpoint.size,
      revision: checkpoint.revision,
      turn: checkpoint.turn,
      boundaryOperation: checkpoint.boundaryOperation,
    },
    timeline: {
      sha256: timeline.sha256,
      size: timeline.size,
      boundaryOperation: timeline.boundaryOperation,
      revision: timeline.revision,
      turn: timeline.turn,
    },
    checkpointOutput,
    timelineOutput,
  }, null, 2));
} else if (action === 'checkpoint') {
  const { sessionId } = await readState();
  const checkpoint = await client.downloadCheckpoint(sessionId);
  const timeline = await client.downloadTimeline(sessionId);
  const checkpointOutput = path.resolve(process.env.RAUHWpx_LIVE_CHECKPOINT || '.rauhwpx-live-checkpoint.bin');
  const timelineOutput = path.resolve(process.env.RAUHWpx_LIVE_TIMELINE || '.rauhwpx-live-checkpoint-timeline.json');
  await fs.writeFile(checkpointOutput, checkpoint.bytes, { mode: 0o600 });
  await fs.writeFile(timelineOutput, timeline.bytes, { mode: 0o600 });
  console.log(JSON.stringify({
    checkpoint: {
      sha256: checkpoint.sha256,
      size: checkpoint.size,
      revision: checkpoint.revision,
      turn: checkpoint.turn,
      boundaryOperation: checkpoint.boundaryOperation,
    },
    timeline: {
      sha256: timeline.sha256,
      size: timeline.size,
      boundaryOperation: timeline.boundaryOperation,
    },
    checkpointOutput,
    timelineOutput,
  }, null, 2));
} else if (action === 'download') {
  const state = await readState();
  const result = await client.downloadResult(state.sessionId);
  const timeline = await client.downloadTimeline(state.sessionId);
  const output = path.resolve(process.env.RAUHWpx_LIVE_RESULT || `${state.documentPath}.cloud-result${path.extname(state.documentPath)}`);
  const timelineOutput = process.env.RAUHWpx_LIVE_TIMELINE
    ? path.resolve(process.env.RAUHWpx_LIVE_TIMELINE)
    : null;
  await fs.writeFile(output, result.bytes, { mode: 0o600 });
  if (timelineOutput) await fs.writeFile(timelineOutput, timeline.bytes, { mode: 0o600 });
  const confirmed = process.env.RAUHWpx_LIVE_CONFIRM === '1'
    ? await client.confirmResultDownloaded(state.sessionId, { sha256: result.sha256, size: result.size })
    : null;
  console.log(JSON.stringify({
    result: { ...result, bytes: undefined },
    timeline: { sha256: timeline.sha256, size: timeline.size, boundaryOperation: timeline.boundaryOperation },
    output,
    timelineOutput,
    confirmed,
  }, null, 2));
} else {
  throw new Error(`Unknown action: ${action}`);
}

process.on('unhandledRejection', (error) => {
  if (error instanceof CloudHttpError) console.error(JSON.stringify({ status: error.status, code: error.code, message: error.message }));
  else console.error(error);
  process.exitCode = 1;
});
