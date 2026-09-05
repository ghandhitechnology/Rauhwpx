import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';
import { applyDisplayInput } from '../../../cloud/document-runtime/studio-harness.mjs';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && fs.existsSync(candidate));

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Vite test port was not allocated'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`Vite exited before it was ready: ${child.exitCode ?? child.signalCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error('Timed out waiting for Vite');
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    delay(4_000).then(() => {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    }),
  ]);
}

function installDesktopCloudMock() {
  const editorSessionId = 'session-editor-a';
  const selectedSessionId = 'session-cloud-b';
  const calls = [];
  let revision = 0;
  let editorScope = null;
  let activeSessionId = editorSessionId;
  let eventSequence = 0;
  let cloudListener = null;
  let displayListener = null;
  let leaseOwned = false;
  let publicationFailures = 0;
  let transferFailures = 0;
  let idle = false;
  let transferredTimeline = null;
  let mergeCheckpoint = null;
  const selections = new Map();
  let configurationFailure = false;
  let heldConfiguration = null;

  const binding = (sessionId) => sessionId === editorSessionId
    ? {
        threadId: editorScope?.threadId ?? 'thread-editor-a',
        documentId: editorScope?.documentId ?? null,
        documentName: 'editor-a.hwpx',
      }
    : {
        threadId: 'thread-cloud-b',
        documentId: 'document-cloud-b',
        documentName: 'cloud-b.hwpx',
      };
  const session = (sessionId) => ({
    kind: 'running',
    sessionId,
    version: sessionId === editorSessionId ? 9 : 13,
    ...binding(sessionId),
    startedAt: '2026-08-30T00:00:00.000Z',
    turn: 1,
    turnLimit: 20,
    elapsedMs: 2_000,
    timeLimitMs: 120_000,
    currentActivity: 'editing',
    phase: 'waiting',
    wait: null,
    selection: selections.get(sessionId) ?? { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    configurationPending: false,
  });
  const snapshot = () => {
    const activeBinding = binding(activeSessionId);
    return {
      revision: ++revision,
      profileEpoch: 0,
      available: true,
      profile: {
        kind: 'configured',
        mode: 'self-hosted',
        connection: 'ready',
        serviceVersion: '1.1.0-e2e',
        message: null,
        profile: {
          name: 'Cloud workspace E2E',
          host: 'cloud-workspace.tailnet.ts.net',
          sshUser: 'ubuntu',
          sshPort: 22,
          tailscaleHttpsPort: 443,
          auth: { kind: 'ssh-agent' },
          transport: { kind: 'tailscale' },
          serverPublicKey: `ed25519:${'A'.repeat(59)}`,
        },
      },
      server: {
        mode: 'self-hosted',
        preferredMode: 'self-hosted',
        providers: [],
        lifecycle: 'idle',
        message: null,
      },
      lease: leaseOwned
        ? {
            owner: 'cloud',
            sessionId: editorSessionId,
            acquiredAt: '2026-08-30T00:00:00.000Z',
          }
        : { owner: 'local' },
      session: idle ? { kind: 'idle' } : session(activeSessionId),
      sessions: idle ? [] : [session(editorSessionId), session(selectedSessionId)],
      queuedMessages: [],
      timeline: idle ? null : transferredTimeline ?? {
        schema: 'rauhwpx.cloud.timeline',
        version: 1,
        exportedAt: '2026-08-30T00:00:00.000Z',
        thread: {
          id: activeBinding.threadId,
          title: activeSessionId === editorSessionId ? 'Editor A cloud workspace' : 'Selected B cloud workspace',
          titleRequested: true,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_001_000,
          agent: 'codex',
          model: 'gpt-5.6',
          effort: 'high',
          workflow: 'direct',
          docKey: activeBinding.documentName,
          documentId: activeBinding.documentId,
          activeTemplateId: null,
          messages: [{
            role: 'assistant',
            text: activeSessionId === editorSessionId
              ? 'Cloud transcript A mounted'
              : 'Cloud transcript B mounted',
            agent: 'codex',
          }],
        },
      },
      account: {
        signedIn: true,
        account: { id: 'account-e2e', email: 'cloud@example.test', displayName: 'Cloud E2E' },
        quota: null,
        raucloud: { kind: 'available' },
        updatedAt: new Date(1_700_000_000_000 + revision * 1_000).toISOString(),
      },
      updatedAt: new Date(1_700_000_000_000 + revision * 1_000).toISOString(),
    };
  };
  const record = (method, payload) => calls.push({ method, payload: structuredClone(payload ?? null) });

  window.__cloudWorkspaceHarness = {
    calls,
    editorSessionId,
    selectedSessionId,
    failNextConfiguration() { configurationFailure = true; },
    holdNextConfiguration() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      heldConfiguration = { promise, release };
    },
    releaseConfiguration() { heldConfiguration?.release(); heldConfiguration = null; },
    failNextPublication() { publicationFailures += 1; },
    failNextTransfer() { transferFailures += 1; },
    resetIdle() {
      idle = true;
      leaseOwned = false;
      transferredTimeline = null;
      activeSessionId = editorSessionId;
      cloudListener?.({ snapshot: snapshot() });
    },
    getEditorScope() { return structuredClone(editorScope); },
    completeTurn(checkpoint) {
      mergeCheckpoint = checkpoint;
      cloudListener?.({ sessionId: checkpoint.sessionId, event: { type: 'boundary.committed',
        payload: { kind: 'turn', operationId: checkpoint.operationId } } });
    },
    activateLease() {
      leaseOwned = true;
      cloudListener?.({ snapshot: snapshot() });
    },
    emitSelectedAgentEvent(event) {
      cloudListener?.({
        sessionId: activeSessionId,
        documentId: binding(activeSessionId).documentId,
        event: {
          type: 'agent.event',
          seq: ++eventSequence,
          payload: { type: 'agent', event },
        },
      });
    },
    async deliverFrame() {
      const sessionId = activeSessionId;
      const streamId = `stream-${sessionId}`;
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 40;
      const context = canvas.getContext('2d');
      context.fillStyle = '#f2eee4';
      context.fillRect(0, 0, 64, 40);
      context.fillStyle = '#315d7d';
      context.fillRect(8, 8, 48, 7);
      context.fillStyle = '#7c8790';
      context.fillRect(8, 21, 34, 3);
      context.fillRect(8, 28, 42, 3);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      displayListener?.({
        connectionId: `display-${sessionId}`,
        event: {
          kind: 'frame',
          sessionId,
          streamId,
          sequence: 1,
          capturedAt: '2026-08-30T00:00:01.000Z',
          width: 64,
          height: 40,
          mimeType: 'image/jpeg',
          byteLength: bytes.byteLength,
          sha256: 'a'.repeat(64),
          framePath: `/v1/sessions/${sessionId}/display/frames/${streamId}/1`,
          bytes,
        },
      });
    },
    publish() {
      cloudListener?.({ snapshot: snapshot() });
    },
  };

  window.rhwpDesktop = {
    platform: 'linux',
    async cloudGetState(payload) {
      record('cloudGetState', payload);
      editorScope = { threadId: payload.threadId, documentId: payload.documentId };
      if (payload.selectedSessionId) activeSessionId = payload.selectedSessionId;
      return { snapshot: snapshot() };
    },
    async cloudSetTransferIntent(payload) {
      record('cloudSetTransferIntent', payload);
      return { snapshot: snapshot() };
    },
    async cloudTransfer(payload) {
      record('cloudTransfer', payload);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (transferFailures > 0) {
        transferFailures -= 1;
        throw new Error('Cloud upload is temporarily unavailable');
      }
      editorScope = { threadId: payload.threadId, documentId: payload.documentId };
      transferredTimeline = structuredClone(payload.timeline);
      idle = false;
      leaseOwned = true;
      return { snapshot: snapshot() };
    },
    async cloudCommand(payload) {
      record('cloudCommand', payload);
      if (payload.command === 'configure') {
        if (heldConfiguration) await heldConfiguration.promise;
        if (configurationFailure) { configurationFailure = false; throw new Error('Provider is not connected on Cloud'); }
        selections.set(payload.sessionId, { agent: payload.payload.provider, model: payload.payload.model, effort: payload.payload.effort });
      }
      activeSessionId = payload.sessionId;
      return { snapshot: snapshot() };
    },
    async cloudDownloadCheckpoint(payload) {
      record('cloudDownloadCheckpoint', payload);
      if (mergeCheckpoint && payload.sessionId === mergeCheckpoint.sessionId) return structuredClone(mergeCheckpoint);
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      return {
        sessionId: activeSessionId,
        documentId: binding(activeSessionId).documentId,
        kind: 'turn',
        fileName: 'workspace-e2e.hwpx',
        sha256: 'b'.repeat(64),
        operationId: 'reconnect-workspace-e2e',
        byteLength: bytes.byteLength,
        revision: 1,
        turn: 1,
        bytes,
      };
    },
    async cloudPublishCheckpoint(payload) {
      record('cloudPublishCheckpoint', payload);
      if (publicationFailures > 0) {
        publicationFailures -= 1;
        throw new Error('원본 파일을 저장할 수 없습니다.');
      }
      return { ...(await window.rhwpDesktop.cloudDownloadCheckpoint(payload)), publication: 'written' };
    },
    async cloudOpenDisplay(payload) {
      record('cloudOpenDisplay', payload);
      const sessionId = payload.sessionId;
      return {
        connectionId: `display-${sessionId}`,
        capability: {
          kind: 'available',
          protocol: 'rauhwpx-frame-v1',
          sessionId,
          streamId: `stream-${sessionId}`,
          width: 64,
          height: 40,
          maxFrameBytes: 524288,
          maxFps: 12,
          inputProtocol: 'rauhwpx-input-v1',
          maxInputEventsPerSecond: 60,
        },
      };
    },
    async cloudCloseDisplay(payload) {
      record('cloudCloseDisplay', payload);
    },
    async cloudDisplayInput(payload) {
      record('cloudDisplayInput', payload);
      return true;
    },
    onCloudEvent(listener) {
      record('onCloudEvent');
      cloudListener = listener;
      return () => {
        record('offCloudEvent');
        cloudListener = null;
      };
    },
    onCloudDisplayEvent(listener) {
      record('onCloudDisplayEvent');
      displayListener = listener;
      return () => {
        record('offCloudDisplayEvent');
        displayListener = null;
      };
    },
  };
}

const port = await availablePort();
const viteUrl = `http://127.0.0.1:${port}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rauhwpx-cloud-workspace-'));
const vite = spawn(
  process.execPath,
  [path.join(studioRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '0.0.0.0', '--port', String(port), '--strictPort'],
  { cwd: studioRoot, env: { ...process.env, BROWSER: 'none', VITE_RHWP_CLOUD_RUNTIME: '1' }, stdio: ['ignore', 'ignore', 'ignore'] },
);
let browser;

try {
  await waitForHttp(viteUrl, vite);
  assert.ok(chromePath, 'Chrome or Chromium is required');
  browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    userDataDir: tempDir,
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(installDesktopCloudMock);
  await page.goto(viteUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__wasm && window.__canvasView), { timeout: 60_000 });
  const documentLoaded = await page.evaluate(async () => {
    const response = await fetch('/samples/hwpx/form-002.hwpx');
    if (!response.ok) return `HTTP ${response.status}`;
    const info = window.__wasm?.loadDocument(new Uint8Array(await response.arrayBuffer()), 'form-002.hwpx');
    await window.__canvasView?.loadDocument?.();
    window.__eventBus?.emit('document-context-changed');
    return info ? null : 'loadDocument returned no document';
  });
  assert.equal(documentLoaded, null);
  await page.evaluate(() => window.__cloudWorkspaceHarness.activateLease());
  await page.waitForSelector('#agent-sidebar [data-workspace-mode="cloud"]', { timeout: 60_000 });
  await page.evaluate(() => window.__eventBus?.emit('document-context-changed'));
  await page.waitForFunction(
    () => document.querySelector('#agent-sidebar .ag-workspace-mode-switch')?.hidden === false,
    { timeout: 60_000 },
  );

  const initial = await page.evaluate(() => {
    const editor = document.querySelector('#editor-area');
    const scroll = document.querySelector('#scroll-container');
    const content = document.querySelector('#scroll-content');
    const horizontalRuler = document.querySelector('#h-ruler');
    const verticalRuler = document.querySelector('#v-ruler');
    const editorInput = document.querySelector('[aria-label="문서 편집 입력"]');
    const statusBar = document.querySelector('#status-bar');
    const transcript = document.querySelector('.ag-messages');
    const composer = document.querySelector('.ag-composer');
    const input = composer?.querySelector('textarea');
    if (!editor || !scroll || !content || !horizontalRuler || !verticalRuler || !editorInput
      || !statusBar || !transcript || !composer || !input) throw new Error('Workspace DOM is incomplete');
    content.style.minWidth = '1800px';
    content.style.minHeight = '1600px';
    scroll.scrollLeft = 73;
    scroll.scrollTop = 91;
    input.value = 'draft before switching';
    window.__workspaceIdentity = {
      editor,
      scroll,
      content,
      horizontalRuler,
      verticalRuler,
      editorInput,
      statusBar,
      transcript,
      composer,
      input,
    };
    return {
      scrollLeft: scroll.scrollLeft,
      scrollTop: scroll.scrollTop,
      editorParent: editor.parentElement?.id,
      statusParent: document.querySelector('#status-bar')?.parentElement?.id,
    };
  });
  assert.deepEqual(initial, {
    scrollLeft: 73,
    scrollTop: 91,
    editorParent: 'workspace-stack',
    statusParent: 'studio-root',
  });

  await page.$eval('[data-workspace-mode="cloud"]', (node) => node.click());
  await page.waitForFunction(() => document.querySelector('#cloud-workspace')?.getAttribute('aria-hidden') === 'false');
  await page.waitForFunction(() => document.querySelector('.ag-messages')?.textContent?.includes('Cloud transcript A mounted'));
  await page.waitForFunction(() => window.__cloudWorkspaceHarness.calls.some((call) => call.method === 'cloudOpenDisplay'));
  await page.evaluate(() => window.__cloudWorkspaceHarness.deliverFrame());
  await page.waitForFunction(() => {
    const image = document.querySelector('.cloud-workspace-image');
    return image instanceof HTMLImageElement && image.naturalWidth === 64 && image.naturalHeight === 40;
  });

  const cloudVisual = await page.evaluate(() => ({
    state: document.querySelector('#cloud-workspace')?.dataset.displayState,
    status: document.querySelector('.cloud-workspace-status')?.textContent,
    editorHidden: document.querySelector('#editor-area')?.getAttribute('aria-hidden'),
    editorInert: document.querySelector('#editor-area')?.inert,
    editorVisibility: document.querySelector('#editor-area')?.style.visibility,
    editorPointerEvents: document.querySelector('#editor-area')?.style.pointerEvents,
    cloudInert: document.querySelector('#cloud-workspace')?.inert,
    imageSize: [
      document.querySelector('.cloud-workspace-image')?.naturalWidth,
      document.querySelector('.cloud-workspace-image')?.naturalHeight,
    ],
  }));
  assert.deepEqual(cloudVisual, {
    state: 'live',
    status: 'Cloud 화면 연결됨 · 클릭하여 제어',
    editorHidden: 'true',
    editorInert: true,
    editorVisibility: 'hidden',
    editorPointerEvents: 'none',
    cloudInert: false,
    imageSize: [64, 40],
  });
  await page.click('.cloud-workspace-canvas');
  await page.keyboard.type('A');
  await page.waitForFunction(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudDisplayInput' && call.payload.event.action !== 'move').length >= 3);
  const remoteInput = await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudDisplayInput')
    .map((call) => call.payload.event));
  assert.deepEqual(remoteInput.filter((event) => event.action !== 'move').slice(0, 3), [
    { kind: 'pointer', action: 'down', x: 32, y: 20, button: 'left', clickCount: 1 },
    { kind: 'pointer', action: 'up', x: 32, y: 20, button: 'left', clickCount: 1 },
    { kind: 'text', text: 'A' },
  ]);
  // Real Chromium PointerEvent.detail is zero. Exercise the viewer's fallback tracker,
  // then replay its exact payloads through the production remote dispatcher.
  await delay(550);
  const beforeClicks = await page.evaluate(() => window.__cloudWorkspaceHarness.calls.length);
  await page.click('.cloud-workspace-canvas');
  await page.click('.cloud-workspace-canvas');
  await page.waitForFunction((start) => window.__cloudWorkspaceHarness.calls.slice(start)
    .filter((call) => call.method === 'cloudDisplayInput' && call.payload.event.action === 'up').length === 2, {}, beforeClicks);
  const clickInputs = await page.evaluate((start) => window.__cloudWorkspaceHarness.calls.slice(start)
    .filter((call) => call.method === 'cloudDisplayInput').map((call) => call.payload.event), beforeClicks);
  assert.deepEqual(clickInputs.filter((event) => event.action === 'down').map((event) => event.clickCount), [1, 2]);
  assert.deepEqual(clickInputs.filter((event) => event.action === 'up').map((event) => event.clickCount), [1, 2]);
  const remotePage = await browser.newPage();
  try {
    await remotePage.setContent('<button style="position:absolute;left:0;top:0;width:100px;height:100px">Remote editor target</button>');
    await remotePage.evaluate(() => {
      window.remoteDoubleClicks = [];
      document.querySelector('button').addEventListener('dblclick', (event) => window.remoteDoubleClicks.push(event.detail));
    });
    const pressed = { displayPressedKeys: new Set(), displayPressedButtons: new Set() };
    for (const input of clickInputs) await applyDisplayInput(remotePage, input, pressed);
    assert.deepEqual(await remotePage.evaluate(() => window.remoteDoubleClicks), [2]);
  } finally {
    await remotePage.close();
    await page.bringToFront();
  }
  if (process.env.CLOUD_WORKSPACE_SCREENSHOT) {
    await page.screenshot({ path: process.env.CLOUD_WORKSPACE_SCREENSHOT, fullPage: true });
  }

  assert.equal(await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudPublishCheckpoint').length), 0);
  await page.$eval('.ag-workspace-cloud-btn', (node) => node.click());
  await page.waitForFunction(() => !document.querySelector('#ag-cloud-panel')?.hidden);
  // A session predating local branch capture must never replace the origin.
  await page.evaluate(() => [...document.querySelectorAll('#ag-cloud-panel button')]
    .find((button) => button.textContent === 'Cloud 변경 병합').click());
  await page.waitForFunction(() => document.body.textContent.includes('Cloud 시작 대화를 불러온 뒤'));
  assert.equal(await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudPublishCheckpoint').length), 0);
  assert.equal(await page.evaluate(() => window.__inputHandler.isReadOnly()), false);
  await page.$eval('.ag-cloud-panel-close', (node) => node.click());

  await page.select('.ag-cloud-session-select', 'session-cloud-b');
  await page.waitForFunction(() => document.querySelector('.ag-messages')?.textContent?.includes('Cloud transcript B mounted'));
  await page.waitForFunction(() => window.__cloudWorkspaceHarness.calls.some((call) =>
    call.method === 'cloudGetState' && call.payload.selectedSessionId === 'session-cloud-b'));
  await page.waitForFunction(() => window.__cloudWorkspaceHarness.calls.some((call) =>
    call.method === 'cloudOpenDisplay' && call.payload.sessionId === 'session-cloud-b'));
  await page.evaluate(() => {
    window.__cloudWorkspaceHarness.emitSelectedAgentEvent({ type: 'turn-start', agent: 'codex' });
    window.__cloudWorkspaceHarness.emitSelectedAgentEvent({ type: 'text-delta', agent: 'codex', text: 'Live event B' });
    window.__cloudWorkspaceHarness.emitSelectedAgentEvent({ type: 'turn-end', agent: 'codex' });
  });
  await page.waitForFunction(() => document.querySelector('.ag-messages')?.textContent?.includes('Live event B'));

  await page.evaluate(() => {
    const input = window.__workspaceIdentity.input;
    input.value = 'queue through selected cloud session';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.__workspaceIdentity.composer.requestSubmit();
  });
  await page.waitForFunction(() => window.__cloudWorkspaceHarness.calls.some((call) =>
    call.method === 'cloudCommand' && call.payload.command === 'queue-message'));
  const queued = await page.evaluate(() => window.__cloudWorkspaceHarness.calls.find((call) =>
    call.method === 'cloudCommand' && call.payload.command === 'queue-message').payload);
  assert.equal(queued.sessionId, 'session-cloud-b');
  assert.equal(queued.expectedVersion, 13);
  assert.equal(queued.message, 'queue through selected cloud session');

  // Settings target the mounted Cloud room and preserve its unsent draft/history.
  const beforeSettings = await page.evaluate(() => {
    const input = document.querySelector('.ag-input');
    input.value = 'Keep this unsent draft while changing providers.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('.ag-messages').textContent;
  });
  await page.click('[aria-label="프로바이더 선택"]');
  await page.waitForSelector('.ag-config-panel.ag-open');
  assert.equal(await page.$eval('.ag-provider-item[data-agent="opencode"]', (node) => node.checkVisibility()), false);
  // Even a synthetic click on hidden local-only providers must stop before effects.
  await page.$eval('.ag-provider-item[data-agent="opencode"]', (node) => node.click());
  await page.$eval('.ag-provider-item[data-agent="rau"]', (node) => node.click());
  assert.equal(await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudCommand' && call.payload.command === 'configure').length), 0);
  await page.evaluate(() => window.__cloudWorkspaceHarness.holdNextConfiguration());
  await page.$eval('.ag-provider-item[data-agent="claude"]', (node) => node.click());
  await page.waitForFunction(() => document.querySelector('[aria-label="프로바이더 선택"]').disabled);
  assert.equal(await page.$eval('.ag-input', (node) => node.value), 'Keep this unsent draft while changing providers.');
  await page.$eval('.ag-provider-item[data-agent="grok"]', (node) => node.click());
  assert.equal(await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudCommand' && call.payload.command === 'configure').length), 1);
  await page.evaluate(() => window.__cloudWorkspaceHarness.releaseConfiguration());
  await page.waitForFunction(() => document.querySelector('.ag-root').dataset.agent === 'claude'
    && !document.querySelector('[aria-label="프로바이더 선택"]').disabled);
  await page.click('[aria-label="모델 선택"]');
  await page.$eval('.ag-llm-item[data-model="haiku"]', (node) => node.click());
  await page.waitForFunction(() => document.querySelector('.ag-llm-name').textContent === 'Haiku 4.5'
    && !document.querySelector('[aria-label="모델 선택"]').disabled);
  await page.click('[aria-label="추론 강도 선택"]');
  await page.focus('.ag-eslider');
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.querySelector('.ag-effort-name').textContent === 'Low'
    && !document.querySelector('[aria-label="추론 강도 선택"]').disabled);
  const configured = await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudCommand' && call.payload.command === 'configure').map((call) => call.payload));
  assert.equal(configured.length, 3);
  assert.ok(configured.every((call) => call.sessionId === 'session-cloud-b' && call.expectedVersion === 13));
  assert.deepEqual(configured.at(-1).payload, { provider: 'claude', model: 'haiku', effort: 'low' });
  assert.equal(await page.$eval('.ag-input', (node) => node.value), 'Keep this unsent draft while changing providers.');
  assert.equal(await page.$eval('.ag-messages', (node) => node.textContent), beforeSettings);
  assert.deepEqual(await page.evaluate(async () => {
    const { getThread } = await import('/src/agent/threads.ts');
    const thread = getThread('thread-cloud-b');
    return { agent: thread.agent, model: thread.model, effort: thread.effort };
  }), { agent: 'claude', model: 'haiku', effort: 'low' }, 'confirmed settings must be saved with the existing conversation');
  await page.evaluate(() => window.__cloudWorkspaceHarness.failNextConfiguration());
  await page.click('[aria-label="프로바이더 선택"]');
  await page.$eval('.ag-provider-item[data-agent="grok"]', (node) => node.click());
  await page.waitForFunction(() => document.querySelector('.ag-messages').textContent.includes('Provider is not connected on Cloud'));
  assert.equal(await page.$eval('.ag-root', (node) => node.dataset.agent), 'claude');
  assert.equal(await page.$eval('.ag-llm-name', (node) => node.textContent), 'Haiku 4.5');
  assert.equal(await page.$eval('.ag-effort-name', (node) => node.textContent), 'Low');
  assert.equal(await page.$eval('[aria-label="프로바이더 선택"]', (node) => node.disabled), false);
  assert.equal(await page.$eval('.ag-input', (node) => node.value), 'Keep this unsent draft while changing providers.');
  await page.click('[aria-label="모델 선택"]');
  if (process.env.CLOUD_CONFIGURATION_SCREENSHOT) {
    await page.$eval('.ag-config-panel', async (node) => {
      await Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
    });
    await (await page.$('#agent-sidebar')).screenshot({ path: process.env.CLOUD_CONFIGURATION_SCREENSHOT });
  }
  await page.click('.ag-input');

  const scrollBeforeReturn = await page.$eval('#scroll-container', (node) => node.scrollLeft);
  await page.click('[data-workspace-mode="local"]');
  await page.waitForFunction(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudCloseDisplay').length === 2);
  const restored = await page.evaluate(() => {
    const identity = window.__workspaceIdentity;
    const leaseScopes = window.__cloudWorkspaceHarness.calls
      .filter((call) => call.method === 'cloudGetState')
      .map((call) => call.payload);
    const initialLeaseScope = leaseScopes[0];
    const commandCount = window.__cloudWorkspaceHarness.calls.filter((call) => call.method === 'cloudCommand').length;
    identity.input.value = 'blocked local draft';
    identity.composer.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return {
      sameEditor: identity.editor === document.querySelector('#editor-area'),
      sameScroll: identity.scroll === document.querySelector('#scroll-container'),
      sameContent: identity.content === document.querySelector('#scroll-content'),
      sameHorizontalRuler: identity.horizontalRuler === document.querySelector('#h-ruler'),
      sameVerticalRuler: identity.verticalRuler === document.querySelector('#v-ruler'),
      sameEditorInput: identity.editorInput === document.querySelector('[aria-label="문서 편집 입력"]'),
      sameStatusBar: identity.statusBar === document.querySelector('#status-bar'),
      sameTranscript: identity.transcript === document.querySelector('.ag-messages'),
      sameComposer: identity.composer === document.querySelector('.ag-composer'),
      sameInput: identity.input === document.querySelector('.ag-composer textarea'),
      scrollLeft: identity.scroll.scrollLeft,
      scrollTop: identity.scroll.scrollTop,
      draft: identity.input.value,
      placeholder: identity.input.placeholder,
      targetMessage: document.querySelector('.ag-composer-target-message')?.textContent,
      targetMessageHidden: document.querySelector('.ag-composer-target-message')?.hidden,
      commandCount,
      commandCountAfterBlockedSubmit: window.__cloudWorkspaceHarness.calls
        .filter((call) => call.method === 'cloudCommand').length,
      editorHidden: identity.editor.getAttribute('aria-hidden'),
      cloudHidden: document.querySelector('#cloud-workspace')?.getAttribute('aria-hidden'),
      editorInert: identity.editor.inert,
      cloudInert: document.querySelector('#cloud-workspace')?.inert,
      cloudVisibility: document.querySelector('#cloud-workspace')?.style.visibility,
      cloudPointerEvents: document.querySelector('#cloud-workspace')?.style.pointerEvents,
      editorThreadARestored: identity.transcript.textContent.includes('Cloud transcript A mounted'),
      selectedCloudBRestoredLocally: identity.transcript.textContent.includes('Cloud transcript B mounted')
        || identity.transcript.textContent.includes('Live event B'),
      cloudTranscriptNeverOwnedLease: leaseScopes.length > 1
        && initialLeaseScope.threadId !== 'thread-cloud-b'
        && leaseScopes.every((scope) => scope.threadId !== 'thread-cloud-b'),
    };
  });
  assert.deepEqual(restored, {
    sameEditor: true,
    sameScroll: true,
    sameContent: true,
    sameHorizontalRuler: true,
    sameVerticalRuler: true,
    sameEditorInput: true,
    sameStatusBar: true,
    sameTranscript: true,
    sameComposer: true,
    sameInput: true,
    scrollLeft: scrollBeforeReturn,
    scrollTop: 91,
    draft: 'blocked local draft',
    placeholder: 'Cloud 작업이 문서를 사용 중입니다. Cloud로 전환하거나 이 기기에서 이어받으세요.',
    targetMessage: 'Cloud 작업이 문서를 사용 중입니다. Cloud로 전환하거나 이 기기에서 이어받으세요.',
    targetMessageHidden: false,
    commandCount: 5,
    commandCountAfterBlockedSubmit: 5,
    editorHidden: 'false',
    cloudHidden: 'true',
    editorInert: false,
    cloudInert: true,
    cloudVisibility: 'hidden',
    cloudPointerEvents: 'none',
    editorThreadARestored: true,
    selectedCloudBRestoredLocally: false,
    cloudTranscriptNeverOwnedLease: true,
  });

  const closeCalls = await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudCloseDisplay'));
  assert.deepEqual(closeCalls, [{
    method: 'cloudCloseDisplay',
    payload: { connectionId: 'display-session-editor-a' },
  }, {
    method: 'cloudCloseDisplay',
    payload: { connectionId: 'display-session-cloud-b' },
  }]);
  // Restore a real saved local conversation, then hand it off through the composer.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__wasm && window.__canvasView && window.__agentBridge));
  await page.evaluate(async () => {
    window.__cloudWorkspaceHarness.resetIdle();
    const response = await fetch('/samples/hwpx/form-002.hwpx');
    window.__eventBus.emit('open-document-bytes', {
      bytes: new Uint8Array(await response.arrayBuffer()), fileName: 'form-002.hwpx',
      suppressDialogs: true, skipUnsavedGuard: true,
    });
  });
  await page.waitForFunction(() => Boolean(window.__cloudWorkspaceHarness.getEditorScope()?.documentId));
  await page.evaluate(async () => {
    const { createEmptyThread, upsertThread } = await import('/src/agent/threads.ts');
    const scope = window.__cloudWorkspaceHarness.getEditorScope();
    const thread = createEmptyThread({
      agent: 'codex', model: 'gpt-5.6', effort: 'high', serviceTier: 'standard',
      docKey: 'form-002.hwpx', documentId: scope.documentId,
    });
    thread.title = 'Local handoff regression';
    thread.workflow = 'question';
    thread.messages = [
      { role: 'user', text: 'Keep the document unchanged while we discuss.', messageId: 'local-history-1' },
      { role: 'assistant', text: 'We can revise the heading after agreeing on the wording.', agent: 'codex' },
    ];
    upsertThread({ ...thread, id: `${thread.id}-opencode`, title: 'Local OpenCode regression',
      agent: 'opencode', model: 'opencode/big-pickle' });
    upsertThread(thread);
  });
  await page.$eval('#agent-sidebar .ag-threads-btn', (node) => node.click());
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-threads-item')]
    .some((node) => node.textContent.includes('Local handoff regression')));
  await page.evaluate(() => [...document.querySelectorAll('.ag-threads-item')]
    .find((node) => node.textContent.includes('Local OpenCode regression')).click());
  await page.waitForFunction(() => !document.querySelector('[data-workspace-mode="cloud"]').disabled);
  await page.$eval('[data-workspace-mode="cloud"]', (node) => node.click());
  await page.waitForFunction(() => document.querySelector('.ag-messages').textContent.includes('OpenCode는 아직 Cloud에서 사용할 수 없습니다'));
  assert.equal(await page.$eval('[data-workspace-mode="local"]', (node) => node.getAttribute('aria-pressed')), 'true');
  assert.equal(await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudTransfer').length), 0);
  await page.evaluate(() => [...document.querySelectorAll('.ag-threads-item')]
    .find((node) => node.textContent.includes('Local handoff regression')).click());
  await page.waitForFunction(() => document.querySelector('.ag-cloud-handoff')?.hidden === false);
  const beforeHandoff = await page.evaluate(async () => {
    const input = document.querySelector('.ag-composer textarea');
    const originBytes = await (await fetch('/samples/hwpx/form-002.hwpx')).arrayBuffer();
    const origin = new File([originBytes], 'form-002.hwpx');
    window.__handoffOrigin = { file: origin, writes: 0 };
    window.__wasm.currentFileHandle = {
      kind: 'file', name: origin.name,
      getFile: async () => window.__handoffOrigin.file,
      queryPermission: async () => 'granted',
      createWritable: async () => {
        window.__handoffOrigin.writes += 1;
        throw new Error('Cloud handoff must not write the local origin');
      },
    };
    window.__wasm.insertText(0, 0, 0, 'UNSAVED_CLOUD_HANDOFF ');
    window.__eventBus.emit('document-mutated', 'cloud-handoff-e2e');
    input.value = 'Use the wording we agreed on in the cloud.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return Array.from(window.__wasm.exportHwp()).join(",");
  });
  // Selecting an execution location must preserve the draft without starting work.
  await page.$eval('[data-workspace-mode="cloud"]', (node) => node.click());
  assert.equal(await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudTransfer').length), 0);
  await page.$eval('[data-workspace-mode="local"]', (node) => node.click());
  await page.evaluate(() => window.__cloudWorkspaceHarness.failNextTransfer());
  await page.$eval('.ag-cloud-handoff', (node) => { node.click(); node.click(); });
  await page.waitForFunction(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudTransfer').length === 1, { timeout: 10_000 }).catch(async (error) => {
      throw new Error(`Cloud handoff failed: ${JSON.stringify(await page.evaluate(() => ({
        messages: document.querySelector('.ag-messages')?.textContent,
        version: window.__versionController.getState(),
        dirty: window.__documentState.isDirty(),
      })))}`, { cause: error });
    });
  await page.waitForSelector('.ag-cloud-start-retry');
  await page.waitForFunction(() => document.documentElement.dataset.documentReadOnly === 'false');
  assert.deepEqual(await page.evaluate(() => ({
    editable: !window.__inputHandler.isReadOnly(),
    dirty: window.__documentState.isDirty(),
    originWrites: window.__handoffOrigin.writes,
    text: Array.from(window.__wasm.exportHwp()).join(','),
  })), { editable: true, dirty: true, originWrites: 0, text: beforeHandoff });
  await page.$eval('.ag-cloud-start-retry', (node) => node.click());
  await page.waitForFunction(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudTransfer').length === 2);
  await page.waitForFunction(() => !document.querySelector('.ag-composer textarea')?.disabled);
  const handoff = await page.evaluate(() => {
    const request = window.__cloudWorkspaceHarness.calls.find((call) => call.method === 'cloudTransfer').payload;
    return {
      history: request.timeline.thread.messages.filter((message) => message.role !== 'system').map((message) => message.text),
      workflow: request.workflow,
      initialMessage: request.initialMessage,
      draft: document.querySelector('.ag-composer textarea').value,
      text: Array.from(window.__wasm.exportHwp()).join(","),
      readOnly: document.documentElement.dataset.documentReadOnly,
      dirty: window.__documentState.isDirty(),
      snapshotMatchesDirtyEditor: Array.from(request.document.bytes).join(',') === Array.from(window.__wasm.exportHwpx()).join(','),
      transferredFileName: request.document.fileName,
      originWrites: window.__handoffOrigin.writes,
      originSha256: request.document.originSha256,
      snapshotSha256: request.document.sha256,
    };
  });
  assert.deepEqual(handoff.history, [
    'Keep the document unchanged while we discuss.',
    'We can revise the heading after agreeing on the wording.',
    'Use the wording we agreed on in the cloud.',
  ]);
  assert.equal(handoff.workflow, 'question');
  assert.equal(handoff.initialMessage.text, handoff.history.at(-1));
  assert.notEqual(handoff.initialMessage.id, 'local-history-1');
  assert.equal(handoff.draft, '');
  assert.equal(handoff.text, beforeHandoff);
  assert.equal(handoff.readOnly, 'false');
  assert.equal(handoff.dirty, true, 'handoff must not mark unsaved edits as saved');
  assert.deepEqual(await page.evaluate(async () => {
    await window.__autosaveManager.flushNow('cloud-owned-regression');
    return { writes: window.__handoffOrigin.writes, dirty: window.__documentState.isDirty() };
  }), { writes: 0, dirty: true }, 'recovery autosave must not write the Cloud-owned origin or clear dirty state');
  assert.equal(handoff.snapshotMatchesDirtyEditor, true);
  assert.equal(handoff.transferredFileName, 'form-002.hwpx');
  assert.equal(handoff.originWrites, 0);
  assert.match(handoff.originSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(handoff.originSha256, handoff.snapshotSha256);
  assert.equal(await page.evaluate(async () => {
    const originBytes = new Uint8Array(await window.__handoffOrigin.file.arrayBuffer());
    const snapshot = window.__cloudWorkspaceHarness.calls.find((call) => call.method === 'cloudTransfer').payload.document.bytes;
    return Array.from(originBytes).join(',') !== Array.from(snapshot).join(',');
  }), true, 'the original saved bytes must remain separate from the dirty Cloud snapshot');
  // Slash-menu selection must change the Cloud workflow without requiring a local provider connection.
  for (const workflow of ['build', 'question']) {
    await page.$eval('.ag-composer textarea', (node, workflow) => {
      node.value = `/${workflow}`;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }, workflow);
    await page.waitForFunction((expected) => {
      const input = document.querySelector('.ag-composer textarea');
      return input && !input.disabled && document.querySelector('#agent-sidebar').dataset.workflow === expected;
    }, {}, workflow === 'build' ? 'direct' : workflow);
  }
  assert.deepEqual(await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudCommand' && call.payload.command === 'workflow')
    .map((call) => call.payload.payload.workflow)), ['direct', 'question']);
  const priorCommands = await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudCommand' && call.payload.command === 'queue-message').length);
  for (const text of ['Keep the original formatting.', 'Also revise the second heading.']) {
    await page.$eval('.ag-composer textarea', (node, text) => {
      node.value = text;
      node.closest('form').requestSubmit();
    }, text);
    await page.waitForFunction(() => {
      const input = document.querySelector('.ag-composer textarea');
      return input && !input.disabled && input.value === '';
    });
  }
  const followups = await page.evaluate((priorCommands) => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudCommand' && call.payload.command === 'queue-message')
    .slice(priorCommands).map((call) => call.payload), priorCommands);
  assert.deepEqual(followups.map((request) => request.message), [
    'Keep the original formatting.', 'Also revise the second heading.',
  ]);
  assert.equal(new Set(followups.map((request) => request.messageId)).size, 2);
  assert.ok(followups.every((request) => request.sessionId === 'session-editor-a'));
  assert.equal(await page.evaluate(() => Array.from(window.__wasm.exportHwp()).join(",")), beforeHandoff);
  console.log('PASS existing conversation handoff, double-click protection, read-only question workflow, multi-turn cloud messages, and unchanged local document');
  // Edit through the real local input while the Cloud conversation remains selected.
  await page.click('[data-document-view="local"]');
  await page.evaluate(() => window.__inputHandler.moveCursorTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }));
  await page.keyboard.type('LOCAL_DURING_CLOUD ');
  await page.waitForFunction(async () => {
    const { captureVersionSnapshot } = await import('/src/versioning/snapshot.ts');
    return captureVersionSnapshot(window.__wasm).compareSnapshot.paragraphs.some((p) => p.text.includes('LOCAL_DURING_CLOUD'));
  });
  assert.equal(await page.$eval('.ag-composer-mode-switch', (node) => node.dataset.mode), 'cloud');
  const savedHead = await page.evaluate(() => window.__versionController.getState().branches.find((branch) => branch.isActive).headId);
  await page.evaluate(() => {
    window.__wasm.currentFileHandle.createWritable = async () => {
      let content;
      return {
        write: async (bytes) => { content = bytes; },
        close: async () => {
          window.__handoffOrigin.file = new File([content], 'form-002.hwpx');
          window.__handoffOrigin.writes++;
        },
        abort: async () => {},
      };
    };
  });
  await page.keyboard.down('Control');
  await page.keyboard.press('s');
  await page.keyboard.up('Control');
  await page.waitForFunction(() => window.__handoffOrigin.writes === 1 && !window.__documentState.isDirty());
  await page.evaluate(() => window.__versionController.whenIdle());
  assert.deepEqual(await page.evaluate(() => {
    const state = window.__versionController.getState();
    return { dirty: state.dirty, head: state.branches.find((branch) => branch.isActive).headId };
  }), { dirty: true, head: savedHead });

  await page.evaluate(async () => {
    const { WasmBridge } = await import('/src/core/wasm-bridge.ts');
    const handoff = window.__cloudWorkspaceHarness.calls.find((call) => call.method === 'cloudTransfer').payload;
    const remote = new WasmBridge();
    await remote.initialize();
    remote.loadDocument(handoff.document.bytes, handoff.document.fileName);
    remote.insertText(0, 0, remote.getParagraphLength(0, 0), ' CLOUD_FINISHED');
    const bytes = remote.exportHwpx();
    remote.releaseDocument();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    window.__cloudWorkspaceHarness.completeTurn({ bytes, byteLength: bytes.length, sha256,
      fileName: handoff.document.fileName, sessionId: 'session-editor-a', documentId: handoff.documentId,
      kind: 'turn', revision: 2, turn: 2, operationId: 'completed-e2e-turn-2' });
  });
  await page.waitForFunction(() => document.querySelector('.ag-cloud-merge-button')?.dataset.revision === '2');
  const downloads = path.join(tempDir, 'downloads');
  fs.mkdirSync(downloads);
  const downloadClient = await browser.target().createCDPSession();
  await downloadClient.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  const downloadComplete = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Cloud copy download timed out')), 10_000);
    downloadClient.on('Browser.downloadProgress', (event) => {
      if (event.state === 'completed') { clearTimeout(timeout); resolve(); }
      if (event.state === 'canceled') { clearTimeout(timeout); reject(new Error('Cloud copy download canceled')); }
    });
  });
  await page.click('.ag-cloud-btn');
  await page.click('.ag-cloud-checkpoint-copy');
  await downloadComplete;
  await downloadClient.detach();
  const copied = fs.readdirSync(downloads);
  assert.deepEqual(copied, ['form-002-cloud-2.hwpx']);
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(downloads, copied[0]))).digest('hex'),
    await page.evaluate(async () => (await window.rhwpDesktop.cloudDownloadCheckpoint({ sessionId: 'session-editor-a', operationId: 'completed-e2e-turn-2' })).sha256));
  assert.equal(await page.evaluate(() => window.__handoffOrigin.writes), 1);
  await page.click('.ag-cloud-panel-close');
  // Dismiss the expected earlier transfer-failure toast before inspecting review controls.
  await page.$$eval('#rhwp-toast-container button[aria-label="닫기"]', (buttons) => buttons.forEach((button) => button.click()));
  await page.click('.ag-cloud-merge-button');
  await page.waitForSelector('.version-merge-preparation');
  await page.click('.version-merge-preparation input[value="commit"]');
  await page.click('.version-merge-preparation button[type="submit"]');
  await page.waitForSelector('.merge-resolver-window');
  if (process.env.CLOUD_MERGE_SCREENSHOT) await page.screenshot({ path: process.env.CLOUD_MERGE_SCREENSHOT, fullPage: true });
  // The shared unsaved handoff and table layout can both require review.
  while (await page.$('.merge-conflict-item:not(.is-resolved)')) {
    await page.click('.merge-conflict-item:not(.is-resolved)');
    await page.evaluate(() => {
      const choices = [...document.querySelectorAll('.merge-resolution-button')];
      const both = choices.find((button) => button.textContent.startsWith('둘 다 유지: 현재 변경 먼저'));
      (both ?? choices.find((button) => button.textContent.startsWith('현재 변경 사용'))).click();
    });
  }
  await page.waitForFunction(() => !document.querySelector('.merge-resolver-footer .merge-primary-button').disabled, { timeout: 5000 }).catch(async (error) => {
    throw new Error(`Merge review: ${JSON.stringify(await page.evaluate(() => ({
      status: document.querySelector('.merge-validation-label')?.textContent,
      editor: document.querySelector('.merge-conflict-editor')?.textContent,
      conflicts: document.querySelector('.merge-conflict-list')?.textContent,
    })))}`, { cause: error });
  });
  if (process.env.CLOUD_MERGE_SCREENSHOT) await page.screenshot({ path: process.env.CLOUD_MERGE_SCREENSHOT, fullPage: true });
  await page.click('.merge-resolver-footer .merge-primary-button');
  await page.waitForSelector('.merge-resolver-window', { hidden: true });
  const mergedText = await page.evaluate(async () => {
    const { captureVersionSnapshot } = await import('/src/versioning/snapshot.ts');
    return captureVersionSnapshot(window.__wasm).compareSnapshot.paragraphs.map((p) => p.text).join('\n');
  });
  assert.match(mergedText, /LOCAL_DURING_CLOUD/);
  assert.match(mergedText, /CLOUD_FINISHED/);
  assert.match(mergedText, /UNSAVED_CLOUD_HANDOFF/);
  assert.equal(await page.evaluate(() => window.__handoffOrigin.writes), 1);
  assert.equal(await page.evaluate(() => window.__cloudWorkspaceHarness.calls.filter((call) => call.method === 'cloudPublishCheckpoint').length), 0);
  console.log('PASS live local typing during Cloud execution and completed-turn branch merge preserves both edits');
  const localBeforeWorker = await page.evaluate(() => Array.from(window.__wasm.exportHwp()).join(','));
  // An authenticated worker exposes the editor and bridge without a second chat UI.
  const workerPage = await browser.newPage();
  const bootstrap = 'cloud-workspace-bootstrap-'.padEnd(43, 'x');
  await workerPage.setViewport({ width: 1280, height: 800 });
  await workerPage.goto(`${viteUrl}/?cloudRuntime=1&bootstrap=${bootstrap}`, { waitUntil: 'domcontentloaded' });
  await workerPage.waitForFunction(() => Boolean(window.rauhwpxCloudRuntime && window.__agentBridge && window.__canvasView));
  await workerPage.evaluate(async () => {
    const response = await fetch('/samples/hwpx/form-002.hwpx');
    await new Promise((resolve, reject) => {
      const requestId = 'worker-layout-document';
      const off = window.__eventBus.on('open-document-bytes:done', (result) => {
        if (result.requestId !== requestId) return;
        off();
        if (result.ok) resolve();
        else reject(new Error(result.error));
      });
      void response.arrayBuffer().then((buffer) => window.__eventBus.emit('open-document-bytes', {
        bytes: new Uint8Array(buffer), fileName: 'form-002.hwpx',
        requestId, suppressDialogs: true, skipUnsavedGuard: true,
      }));
    });
  });
  const workerState = await workerPage.evaluate((bootstrap) => {
    const runtime = window.rauhwpxCloudRuntime;
    let startRequest = null;
    window.__agentBridge.startChat = (...args) => { startRequest = args; };
    runtime.startChat(bootstrap, {
      agent: 'codex', model: 'gpt-6-astra', effort: 'high', workflow: 'question',
      permissionProfile: 'unrestricted', threadId: 'worker-editor-thread',
      history: [{ role: 'user', content: 'Preserve the conversation history.' }],
    });
    return {
      status: runtime.status(bootstrap),
      sidebar: Boolean(document.querySelector('#agent-sidebar')),
      setup: Boolean(document.querySelector('.ag-cloud-setup-overlay')),
      sidebarInset: document.body.classList.contains('ag-sidebar-open'),
      editorRight: document.querySelector('#editor-area').getBoundingClientRect().right,
      width: window.innerWidth,
      startRequest,
    };
  }, bootstrap);
  assert.equal(workerState.status.documentLoaded, true);
  assert.equal(workerState.sidebar, false);
  assert.equal(workerState.setup, false);
  assert.equal(workerState.sidebarInset, false);
  assert.equal(workerState.editorRight, workerState.width);
  assert.equal(workerState.startRequest[0], 'codex');
  assert.equal(workerState.startRequest[5], 'question');
  assert.deepEqual(workerState.startRequest[9], [{ role: 'user', content: 'Preserve the conversation history.' }]);
  // The authenticated worker accepts native user input while the provider owns
  // its turn. Both actors share the real WASM document and revision guard.
  const alongsideBefore = await workerPage.evaluate(async () => {
    const bridge = window.__agentBridge;
    bridge.permissionProfile = 'unrestricted';
    bridge.workflow = 'direct';
    bridge.phase = 'direct';
    bridge.handleAgentEvent({ type: 'turn-start', agent: 'codex', turnId: 'alongside-test' });
    const structure = await bridge.executor.execute('get_structure', {}, 'codex');
    return { revision: structure.revision, lease: bridge.getEditingLease(),
      inputLocked: window.__inputHandler.isUserEditingLocked() };
  });
  assert.equal(alongsideBefore.lease.active, true, 'provider retains its busy/document-replacement lease');
  assert.equal(alongsideBefore.inputLocked, false, 'native worker input remains editable during the turn');
  const alongsidePressed = { displayPressedKeys: new Set(), displayPressedButtons: new Set() };
  await workerPage.evaluate(() => window.__inputHandler.focus());
  for (const input of [
    { kind: 'key', action: 'down', key: 'Control' },
    { kind: 'key', action: 'down', key: 'End' },
    { kind: 'key', action: 'up', key: 'End' },
    { kind: 'key', action: 'up', key: 'Control' },
    { kind: 'key', action: 'down', key: 'Enter' },
    { kind: 'key', action: 'up', key: 'Enter' },
    { kind: 'text', text: '함께 편집 PR188_ALONGSIDE_USER' },
  ]) await applyDisplayInput(workerPage, input, alongsidePressed);
  const alongsideResult = await workerPage.evaluate(async ({ revision, bootstrap }) => {
    const bridge = window.__agentBridge;
    const wasm = window.__wasm;
    const readText = () => Array.from({ length: wasm.getSectionCount() }, (_, sectionIdx) =>
      Array.from({ length: wasm.getParagraphCount(sectionIdx) }, (_, paraIdx) =>
        wasm.getTextRange(sectionIdx, paraIdx, 0, 100000)).join('\n')).join('\n');
    const afterUser = await bridge.executor.execute('get_structure', {}, 'codex');
    let staleCode = null;
    try {
      await bridge.executor.execute('insert_text', { expectedRevision: revision,
        sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'STALE_AGENT_WRITE' }, 'codex');
    } catch (error) { staleCode = error.code; }
    const section = afterUser.sections.at(-1);
    const paraIdx = section.paragraphCount - 1;
    await bridge.executor.execute('insert_text', { expectedRevision: afterUser.revision,
      sectionIdx: afterUser.sections.length - 1, paraIdx,
      charOffset: section.paragraphs[paraIdx]?.length ?? 0, text: '\nPR188_ALONGSIDE_AGENT' }, 'codex');
    await bridge.executor.execute('verify_changes', { includeImage: false }, 'codex');
    const during = readText();
    bridge.handleAgentEvent({ type: 'turn-end', agent: 'codex', turnId: 'alongside-test', stopReason: 'completed' });
    const committed = readText();
    const exported = await window.rauhwpxCloudRuntime.prepareExport(bootstrap, 'hwpx');
    const bytes = new Uint8Array(exported.size);
    for (let offset = 0; offset < exported.size;) {
      const chunk = window.rauhwpxCloudRuntime.readExportChunk(bootstrap, offset, 1024 * 1024);
      bytes.set(Uint8Array.from(atob(chunk.dataBase64), (char) => char.charCodeAt(0)), offset);
      offset += chunk.size;
    }
    await new Promise((resolve, reject) => {
      const requestId = 'worker-concurrent-export-reopen';
      const off = window.__eventBus.on('open-document-bytes:done', (result) => {
        if (result.requestId !== requestId) return;
        off();
        if (result.ok) resolve(); else reject(new Error(result.error));
      });
      window.__eventBus.emit('open-document-bytes', { bytes, fileName: 'worker-concurrent.hwpx',
        requestId, suppressDialogs: true, skipUnsavedGuard: true });
    });
    return { userRevision: afterUser.revision, staleCode, during, committed, reopened: readText(),
      exportSize: exported.size, lease: bridge.getEditingLease() };
  }, { revision: alongsideBefore.revision, bootstrap });
  assert.ok(alongsideResult.userRevision > alongsideBefore.revision, 'native edit advances the shared revision');
  assert.equal(alongsideResult.staleCode, 'REVISION_MISMATCH');
  for (const text of [alongsideResult.during, alongsideResult.committed, alongsideResult.reopened]) {
    for (const marker of ['함께 편집 PR188_ALONGSIDE_USER', 'PR188_ALONGSIDE_AGENT']) {
      assert.equal(text.split(marker).length - 1, 1, `exactly one ${marker}`);
    }
    assert.equal(text.includes('STALE_AGENT_WRITE'), false);
  }
  assert.ok(alongsideResult.exportSize > 0);
  assert.equal(alongsideResult.lease.active, false);
  // Failed and interrupted turns roll back only their own staged insertion.
  // Cover native edits both before and after that insertion.
  for (const [userFirst, stopReason] of [[true, 'error'], [false, 'cancelled']]) {
    const suffix = userFirst ? 'BEFORE' : 'AFTER';
    const userMarker = `사용자 유지 PR188_ROLLBACK_USER_${suffix}`;
    const agentMarker = `PR188_ROLLBACK_AGENT_${suffix}`;
    await workerPage.evaluate((turnId) => {
      window.__agentBridge.handleAgentEvent({ type: 'turn-start', agent: 'codex', turnId });
    }, `rollback-${suffix}`);
    const userInput = async () => {
      await workerPage.evaluate(() => window.__inputHandler.focus());
      for (const input of [
        { kind: 'key', action: 'down', key: 'Control' },
        { kind: 'key', action: 'down', key: 'End' },
        { kind: 'key', action: 'up', key: 'End' },
        { kind: 'key', action: 'up', key: 'Control' },
        { kind: 'key', action: 'down', key: 'Enter' },
        { kind: 'key', action: 'up', key: 'Enter' },
        { kind: 'text', text: userMarker },
      ]) await applyDisplayInput(workerPage, input, alongsidePressed);
    };
    if (userFirst) await userInput();
    await workerPage.evaluate(async (marker) => {
      const executor = window.__agentBridge.executor;
      const structure = await executor.execute('get_structure', {}, 'codex');
      const section = structure.sections.at(-1);
      const paraIdx = section.paragraphCount - 1;
      await executor.execute('insert_text', { expectedRevision: structure.revision,
        sectionIdx: structure.sections.length - 1, paraIdx,
        charOffset: section.paragraphs[paraIdx]?.length ?? 0, text: `\n${marker}` }, 'codex');
    }, agentMarker);
    if (!userFirst) await userInput();
    const rolledBack = await workerPage.evaluate(({ turnId, stopReason }) => {
      window.__agentBridge.handleAgentEvent({ type: 'turn-end', agent: 'codex', turnId, stopReason });
      const wasm = window.__wasm;
      return Array.from({ length: wasm.getSectionCount() }, (_, sectionIdx) =>
        Array.from({ length: wasm.getParagraphCount(sectionIdx) }, (_, paraIdx) =>
          wasm.getTextRange(sectionIdx, paraIdx, 0, 100000)).join('\n')).join('\n');
    }, { turnId: `rollback-${suffix}`, stopReason });
    for (const marker of ['함께 편집 PR188_ALONGSIDE_USER', 'PR188_ALONGSIDE_AGENT', userMarker]) {
      assert.equal(rolledBack.split(marker).length - 1, 1, `rollback preserves ${marker}`);
    }
    assert.equal(rolledBack.includes(agentMarker), false, 'failed/interrupted agent insertion is removed');
  }
  assert.equal(await page.evaluate(() => Array.from(window.__wasm.exportHwp()).join(',')), localBeforeWorker,
    'concurrent edits stay in the worker document and leave the original local document unchanged');
  console.log('PASS active worker turn accepts Korean input, rejects stale agent writes, and preserves both edits through commit/export');
  if (process.env.CLOUD_WORKER_SCREENSHOT) {
    await workerPage.screenshot({ path: process.env.CLOUD_WORKER_SCREENSHOT, fullPage: true });
  }
  await workerPage.close();
  console.log('PASS authenticated worker keeps the editor and provider bridge without duplicate chat or onboarding');
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ initial, cloudVisual, restored, closeCalls }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await stop(vite);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
