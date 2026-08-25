import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';

import { issueScopedHubToken } from '../hub-session-registry.mjs';

const TOKEN = 'hub-tenancy-test-token';
const LAUNCH_ID = 'hub-tenancy-test-launch';

function waitForLine(stream, predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error('Timed out waiting for process output'));
    }, timeoutMs);
    lines.on('line', (line) => {
      if (!predicate(line)) return;
      clearTimeout(timer);
      lines.close();
      resolve(line);
    });
  });
}

function openSocket(url, { origin } = {}) {
  const socket = new WebSocket(url, origin ? { origin } : undefined);
  const firstMessage = new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, firstMessage }));
    socket.once('error', reject);
  });
}

function rejectedUpgrade(url, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, origin ? { origin } : undefined);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error('WebSocket upgrade unexpectedly succeeded')));
    socket.once('error', () => {});
  });
}

function waitForMessage(socket, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket message'));
    }, timeoutMs);
    const onMessage = (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

function sendFrame(socket, frame) {
  socket.send(JSON.stringify({ v: 4, ...frame }));
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for process exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve([code, signal]);
    });
  });
}

test('two idle backends route overlapping MCP ids only to their owning Studio', { timeout: 35_000 }, async (t) => {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-tenancy-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RHWP_AGENT_PORT: '0',
      RHWP_AGENT_TOKEN: TOKEN,
      RHWP_LAUNCH_ID: LAUNCH_ID,
      RHWP_WORK_DIR: workRoot,
      RHWP_TEMPLATES_DIR: path.join(workRoot, 'templates'),
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(workRoot, 'agent-instructions'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(workRoot, { recursive: true, force: true });
  });

  const readyLine = await waitForLine(child.stdout, (line) => line.startsWith('RHWP_HUB_READY '));
  const ready = JSON.parse(readyLine.slice('RHWP_HUB_READY '.length));
  assert.equal(ready.pid, child.pid);
  assert.equal(ready.launchId, LAUNCH_ID);
  assert.equal(Number.isInteger(ready.port) && ready.port > 0, true);

  const wsBase = `ws://127.0.0.1:${ready.port}`;
  const alphaToken = issueScopedHubToken(TOKEN, 'alpha');
  const betaToken = issueScopedHubToken(TOKEN, 'beta');
  const httpBase = `http://127.0.0.1:${ready.port}`;
  const studioOrigin = 'rauhwpx://app';
  assert.equal(
    await rejectedUpgrade(`${wsBase}/studio?token=${TOKEN}&sessionId=originless`),
    403,
  );
  assert.equal(
    await rejectedUpgrade(`${wsBase}/studio?token=${TOKEN}&sessionId=alpha`, { origin: studioOrigin }),
    401,
  );
  assert.equal(
    await rejectedUpgrade(`${wsBase}/mcp?token=${alphaToken}&sessionId=alpha`, { origin: studioOrigin }),
    403,
  );
  const { socket: alpha, firstMessage: alphaWelcome } = await openSocket(
    `${wsBase}/studio?token=${alphaToken}&sessionId=alpha`,
    { origin: studioOrigin },
  );
  const { socket: beta, firstMessage: betaWelcome } = await openSocket(
    `${wsBase}/studio?token=${betaToken}&sessionId=beta`,
    { origin: studioOrigin },
  );
  assert.equal((await alphaWelcome).hubSessionId, 'alpha');
  assert.equal((await betaWelcome).hubSessionId, 'beta');

  const instructionsRead = waitForMessage(alpha, (msg) => (
    msg.type === 'agent-instructions' && msg.requestId === 'instructions-read-1'
  ));
  sendFrame(alpha, { type: 'agent-instructions-request', requestId: 'instructions-read-1' });
  const initialInstructions = (await instructionsRead).status;
  assert.equal(initialInstructions.fileName, 'AGENTS.md');
  assert.equal(initialInstructions.scope, 'rauhwpx-app');
  assert.match(initialInstructions.content, /Rauhwpx 안에서만 적용됩니다/);

  const instructionsSaved = waitForMessage(alpha, (msg) => (
    msg.type === 'agent-instructions' && msg.requestId === 'instructions-save-1'
  ));
  const instructionsBroadcast = waitForMessage(beta, (msg) => (
    msg.type === 'agent-instructions' && msg.changedBy === 'user' && msg.status?.revision === 2
  ));
  sendFrame(alpha, {
    type: 'agent-instructions-save',
    requestId: 'instructions-save-1',
    expectedRevision: initialInstructions.revision,
    content: '# 내 지시\n\n- 핵심부터 답하기\n',
  });
  assert.equal((await instructionsSaved).status.revision, 2);
  assert.equal((await instructionsBroadcast).status.content, '# 내 지시\n\n- 핵심부터 답하기\n');
  assert.equal(
    readFileSync(path.join(workRoot, 'agent-instructions', 'AGENTS.md'), 'utf8'),
    '# 내 지시\n\n- 핵심부터 답하기\n',
  );

  const alphaCatalogAdded = waitForMessage(alpha, (msg) => msg.type === 'templates-catalog' && msg.change?.type === 'added');
  const betaCatalogAdded = waitForMessage(beta, (msg) => msg.type === 'templates-catalog' && msg.change?.type === 'added');
  const templateUpload = await fetch(`${httpBase}/templates?sessionId=alpha`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alphaToken}`,
      Origin: studioOrigin,
      'Content-Type': 'application/x-hwp',
      'X-File-Name': 'shared.hwp',
      'X-Template-Name': encodeURIComponent('Shared template'),
      'X-Template-Format': 'hwp',
      'X-Template-Page-Count': '1',
      'X-Template-Section-Count': '1',
    },
    body: Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from('hub-template'),
    ]),
  });
  assert.equal(templateUpload.status, 201, stderr);
  const uploadedTemplate = (await templateUpload.json()).template;
  assert.equal((await alphaCatalogAdded).change.template.id, uploadedTemplate.id);
  assert.equal((await betaCatalogAdded).change.template.id, uploadedTemplate.id);
  const crossSessionTemplateRequest = await fetch(`${httpBase}/templates?sessionId=alpha`, {
    headers: { Authorization: `Bearer ${betaToken}`, Origin: studioOrigin },
  });
  assert.equal(crossSessionTemplateRequest.status, 401);

  const alphaStarted = waitForMessage(alpha, (msg) => msg.type === 'chat-started');
  const betaStarted = waitForMessage(beta, (msg) => msg.type === 'chat-started');
  sendFrame(alpha, { type: 'chat-start', agent: 'claude', threadId: 'thread-alpha', documentId: 'doc-alpha' });
  sendFrame(beta, { type: 'chat-start', agent: 'claude', threadId: 'thread-beta', documentId: 'doc-beta' });
  const [alphaSession, betaSession] = await Promise.all([alphaStarted, betaStarted]);
  assert.equal(alphaSession.status, undefined);
  assert.equal(betaSession.status, undefined);

  const alphaTemplateChanged = waitForMessage(alpha, (msg) => msg.type === 'chat-template-changed');
  sendFrame(alpha, { type: 'chat-template-set', templateId: uploadedTemplate.id });
  assert.equal((await alphaTemplateChanged).template.id, uploadedTemplate.id);

  const { socket: alphaMcp } = await openSocket(`${wsBase}/mcp?token=${alphaToken}&sessionId=alpha&agent=claude`);
  const { socket: betaMcp } = await openSocket(`${wsBase}/mcp?token=${betaToken}&sessionId=beta&agent=claude`);
  const instructionsToolRead = waitForMessage(alphaMcp, (msg) => msg.type === 'tool-result' && msg.id === 4);
  sendFrame(alphaMcp, {
    type: 'tool-call', id: 4, tool: 'read_agent_instructions', args: {},
    workflow: 'direct', capabilityEpoch: alphaSession.capabilityEpoch,
  });
  assert.equal((await instructionsToolRead).result.revision, 2);

  const instructionsToolUpdated = waitForMessage(alphaMcp, (msg) => msg.type === 'tool-result' && msg.id === 5);
  const instructionsDraftProposed = waitForMessage(alpha, (msg) => msg.type === 'agent-instructions-draft');
  sendFrame(alphaMcp, {
    type: 'tool-call', id: 5, tool: 'update_agent_instructions',
    args: {
      content: '# 내 지시\n\n- 핵심부터 답하기\n- 표는 비교에 도움이 될 때만 쓰기\n',
      expectedRevision: 2,
      reason: '반복된 응답 형식 선호를 저장',
    },
    workflow: 'direct', capabilityEpoch: alphaSession.capabilityEpoch,
  });
  const draftToolResult = (await instructionsToolUpdated).result;
  assert.equal(draftToolResult.changed, false);
  assert.equal(draftToolResult.pendingConfirmation, true);
  assert.equal(draftToolResult.revision, 2);
  const proposedDraft = (await instructionsDraftProposed).draft;
  assert.equal(proposedDraft.id, draftToolResult.draftId);
  assert.equal(proposedDraft.expectedRevision, 2);
  assert.equal(typeof proposedDraft.confirmationToken, 'string');
  assert.equal(
    readFileSync(path.join(workRoot, 'agent-instructions', 'AGENTS.md'), 'utf8'),
    '# 내 지시\n\n- 핵심부터 답하기\n',
  );

  const invalidConfirmation = waitForMessage(alpha, (msg) => (
    msg.type === 'agent-instructions-error' && msg.requestId === 'instructions-confirm-invalid-token'
  ));
  sendFrame(alpha, {
    type: 'agent-instructions-draft-confirm',
    requestId: 'instructions-confirm-invalid-token',
    draftId: proposedDraft.id,
    confirmationToken: 'not-the-issued-capability',
  });
  assert.equal((await invalidConfirmation).code, 'INSTRUCTIONS_CONFIRMATION_INVALID');

  const crossSessionConfirmation = waitForMessage(beta, (msg) => (
    msg.type === 'agent-instructions-error' && msg.requestId === 'instructions-confirm-wrong-session'
  ));
  sendFrame(beta, {
    type: 'agent-instructions-draft-confirm',
    requestId: 'instructions-confirm-wrong-session',
    draftId: proposedDraft.id,
    confirmationToken: proposedDraft.confirmationToken,
  });
  assert.equal((await crossSessionConfirmation).code, 'INSTRUCTIONS_CONFIRMATION_INVALID');

  const instructionsConfirmed = waitForMessage(alpha, (msg) => (
    msg.type === 'agent-instructions' && msg.requestId === 'instructions-confirm-1'
  ));
  const instructionsDraftCleared = waitForMessage(alpha, (msg) => (
    msg.type === 'agent-instructions-draft-cleared'
      && msg.draftId === proposedDraft.id
      && msg.outcome === 'confirmed'
  ));
  const agentInstructionsBroadcast = waitForMessage(beta, (msg) => (
    msg.type === 'agent-instructions'
      && msg.changedBy === 'agent-confirmed:claude'
      && msg.status?.revision === 3
  ));
  sendFrame(alpha, {
    type: 'agent-instructions-draft-confirm',
    requestId: 'instructions-confirm-1',
    draftId: proposedDraft.id,
    confirmationToken: proposedDraft.confirmationToken,
  });
  assert.equal((await instructionsConfirmed).status.revision, 3);
  assert.equal((await instructionsDraftCleared).outcome, 'confirmed');
  assert.equal((await agentInstructionsBroadcast).status.revision, 3);
  assert.equal(
    readFileSync(path.join(workRoot, 'agent-instructions', 'AGENTS.md'), 'utf8'),
    '# 내 지시\n\n- 핵심부터 답하기\n- 표는 비교에 도움이 될 때만 쓰기\n',
  );
  const alphaTemplateResult = waitForMessage(alphaMcp, (msg) => msg.type === 'tool-result' && msg.id === 6);
  const betaTemplateResult = waitForMessage(betaMcp, (msg) => msg.type === 'tool-result' && msg.id === 6);
  sendFrame(alphaMcp, { type: 'tool-call', id: 6, tool: 'get_active_template', args: {}, workflow: 'direct', capabilityEpoch: alphaSession.capabilityEpoch });
  sendFrame(betaMcp, { type: 'tool-call', id: 6, tool: 'get_active_template', args: {}, workflow: 'direct', capabilityEpoch: betaSession.capabilityEpoch });
  assert.equal((await alphaTemplateResult).result.template.id, uploadedTemplate.id);
  assert.equal((await betaTemplateResult).error.code, 'TEMPLATE_NOT_SELECTED');

  const betaTemplateChanged = waitForMessage(beta, (msg) => msg.type === 'chat-template-changed');
  sendFrame(beta, { type: 'chat-template-set', templateId: uploadedTemplate.id });
  assert.equal((await betaTemplateChanged).template.id, uploadedTemplate.id);

  const alphaRequest = waitForMessage(alpha, (msg) => msg.type === 'tool-request');
  const betaRequest = waitForMessage(beta, (msg) => msg.type === 'tool-request');
  const alphaResult = waitForMessage(alphaMcp, (msg) => msg.type === 'tool-result');
  const betaResult = waitForMessage(betaMcp, (msg) => msg.type === 'tool-result');
  sendFrame(alphaMcp, { type: 'tool-call', id: 7, tool: 'get_structure', args: {}, workflow: 'direct', capabilityEpoch: alphaSession.capabilityEpoch });
  sendFrame(betaMcp, { type: 'tool-call', id: 7, tool: 'get_structure', args: {}, workflow: 'direct', capabilityEpoch: betaSession.capabilityEpoch });
  const [toAlpha, toBeta] = await Promise.all([alphaRequest, betaRequest]);
  assert.equal(toAlpha.id, 1);
  assert.equal(toBeta.id, 1);
  sendFrame(alpha, { type: 'tool-response', id: toAlpha.id, ok: true, result: { owner: 'alpha' } });
  sendFrame(beta, { type: 'tool-response', id: toBeta.id, ok: true, result: { owner: 'beta' } });
  assert.deepEqual((await alphaResult).result, { owner: 'alpha' });
  assert.deepEqual((await betaResult).result, { owner: 'beta' });

  // Browser documents have no native source path. Studio exports the live bytes,
  // the hub materializes them in alpha's isolated workspace, and the generated
  // result can be published as an authenticated download without leaking to beta.
  const snapshotBytes = readFileSync(new URL('../../saved/blank2010.hwp', import.meta.url));
  const snapshotRequest = waitForMessage(alpha, (msg) => (
    msg.type === 'tool-request' && msg.tool === 'materialize_document_snapshot'
  ));
  const snapshotResult = waitForMessage(alphaMcp, (msg) => msg.type === 'tool-result' && msg.id === 9);
  sendFrame(alphaMcp, {
    type: 'tool-call', id: 9, tool: 'materialize_document_snapshot', args: {},
    workflow: 'direct', capabilityEpoch: alphaSession.capabilityEpoch,
  });
  const toSnapshot = await snapshotRequest;
  sendFrame(alpha, {
    type: 'tool-response', id: toSnapshot.id, ok: true,
    result: {
      sourceFormat: 'hwp', byteLength: snapshotBytes.length,
      dataBase64: snapshotBytes.toString('base64'), revision: 3, dirty: true,
    },
  });
  const materialized = (await snapshotResult).result;
  assert.equal(materialized.documentId, 'doc-alpha');
  assert.equal(materialized.dirty, true);
  assert.equal(existsSync(materialized.path), true);

  const publishResult = waitForMessage(alphaMcp, (msg) => msg.type === 'tool-result' && msg.id === 10);
  sendFrame(alphaMcp, {
    type: 'tool-call', id: 10, tool: 'publish_artifact',
    args: { filePath: materialized.path, fileName: '보고서(팀) - Layout.hwp' },
    workflow: 'direct', capabilityEpoch: alphaSession.capabilityEpoch,
  });
  const published = (await publishResult).result;
  assert.equal(published.fileName, '보고서(팀) - Layout.hwp');
  assert.match(published.downloadUrl, /%28%ED%8C%80%29/);
  assert.doesNotMatch(new URL(published.downloadUrl).pathname, /[()]/);
  const artifactDownload = await fetch(published.downloadUrl, {
    headers: { Origin: studioOrigin },
  });
  assert.equal(artifactDownload.status, 200);
  assert.match(artifactDownload.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal(artifactDownload.headers.get('access-control-allow-origin'), studioOrigin);
  assert.deepEqual(Buffer.from(await artifactDownload.arrayBuffer()), snapshotBytes);

  const crossSessionArtifactUrl = new URL(published.downloadUrl);
  crossSessionArtifactUrl.searchParams.set('sessionId', 'beta');
  crossSessionArtifactUrl.searchParams.set('token', betaToken);
  assert.equal((await fetch(crossSessionArtifactUrl)).status, 404);

  const alphaTemplateCleared = waitForMessage(alpha, (msg) => msg.type === 'chat-template-changed' && msg.reason === 'deleted');
  const betaTemplateCleared = waitForMessage(beta, (msg) => msg.type === 'chat-template-changed' && msg.reason === 'deleted');
  const alphaCatalogDeleted = waitForMessage(alpha, (msg) => msg.type === 'templates-catalog' && msg.change?.type === 'deleted');
  const betaCatalogDeleted = waitForMessage(beta, (msg) => msg.type === 'templates-catalog' && msg.change?.type === 'deleted');
  const templateDelete = await fetch(`${httpBase}/templates/${uploadedTemplate.id}?sessionId=alpha`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${alphaToken}`, Origin: studioOrigin },
  });
  assert.equal(templateDelete.status, 200);
  await Promise.all([alphaTemplateCleared, betaTemplateCleared, alphaCatalogDeleted, betaCatalogDeleted]);

  const recordDirectories = readdirSync(path.join(workRoot, 'sessions'));
  assert.equal(recordDirectories.length, 2);
  assert.equal(recordDirectories.every((directory) => {
    const entries = readdirSync(path.join(workRoot, 'sessions', directory));
    return entries.includes('home') && entries.includes('work');
  }), true);
  const alphaClosed = Promise.all([once(alpha, 'close'), once(alphaMcp, 'close')]);
  const deleted = await fetch(`${httpBase}/sessions/alpha`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-RHWP-Launch-ID': LAUNCH_ID },
  });
  assert.equal(deleted.status, 200);
  await alphaClosed;
  assert.equal(beta.readyState, WebSocket.OPEN);
  assert.equal(betaMcp.readyState, WebSocket.OPEN);
  assert.equal(readdirSync(path.join(workRoot, 'sessions')).length, 1);

  const betaRequestAfterClose = waitForMessage(beta, (msg) => msg.type === 'tool-request');
  const betaResultAfterClose = waitForMessage(betaMcp, (msg) => msg.type === 'tool-result' && msg.id === 8);
  sendFrame(betaMcp, { type: 'tool-call', id: 8, tool: 'get_structure', args: {}, workflow: 'direct', capabilityEpoch: betaSession.capabilityEpoch });
  const stillOwned = await betaRequestAfterClose;
  sendFrame(beta, { type: 'tool-response', id: stillOwned.id, ok: true, result: { owner: 'beta-still' } });
  assert.deepEqual((await betaResultAfterClose).result, { owner: 'beta-still' });

  const healthResponse = await fetch(`${httpBase}/healthz?token=${TOKEN}`);
  const health = await healthResponse.json();
  assert.deepEqual(health.sessions.map(({ sessionId }) => sessionId), ['beta']);
  assert.equal(health.sessions[0].studioConnected, true, stderr);

  await Promise.all([closeSocket(betaMcp), closeSocket(beta)]);
  const shutdown = await fetch(`${httpBase}/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-RHWP-Launch-ID': LAUNCH_ID },
  });
  assert.equal(shutdown.status, 202);
  assert.deepEqual(await shutdown.json(), { status: 'shutting-down', launchId: LAUNCH_ID });
  assert.deepEqual(await waitForExit(child), [0, null]);
});

test('owner watchdog disposes the hub when its desktop owner exits', { timeout: 20_000 }, async (t) => {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-owner-'));
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const hub = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RHWP_AGENT_PORT: '0',
      RHWP_AGENT_TOKEN: TOKEN,
      RHWP_LAUNCH_ID: `${LAUNCH_ID}-owner`,
      RHWP_OWNER_PID: String(owner.pid),
      RHWP_WORK_DIR: workRoot,
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(workRoot, 'agent-instructions'),
      RHWP_OWN_WORK_DIR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (owner.exitCode === null) owner.kill('SIGTERM');
    if (hub.exitCode === null) hub.kill('SIGTERM');
    if (hub.exitCode === null) await waitForExit(hub).catch(() => {});
    rmSync(workRoot, { recursive: true, force: true });
  });

  await waitForLine(hub.stdout, (line) => line.startsWith('RHWP_HUB_READY '));
  owner.kill('SIGTERM');
  await waitForExit(owner);
  const [code, signal] = await waitForExit(hub);
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(existsSync(workRoot), false);
});
