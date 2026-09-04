import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

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
    phase: 'working',
    wait: null,
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
      session: session(activeSessionId),
      sessions: [session(editorSessionId), session(selectedSessionId)],
      queuedMessages: [],
      timeline: {
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
    async cloudCommand(payload) {
      record('cloudCommand', payload);
      activeSessionId = payload.sessionId;
      return { snapshot: snapshot() };
    },
    async cloudDownloadCheckpoint(payload) {
      record('cloudDownloadCheckpoint', payload);
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      return {
        sessionId: activeSessionId,
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
  { cwd: studioRoot, env: { ...process.env, BROWSER: 'none' }, stdio: ['ignore', 'ignore', 'ignore'] },
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
    .filter((call) => call.method === 'cloudDisplayInput').length >= 4);
  const remoteInput = await page.evaluate(() => window.__cloudWorkspaceHarness.calls
    .filter((call) => call.method === 'cloudDisplayInput')
    .map((call) => call.payload.event));
  assert.deepEqual(remoteInput.filter((event) => event.action !== 'move').slice(0, 3), [
    { kind: 'pointer', action: 'down', x: 32, y: 20, button: 'left' },
    { kind: 'pointer', action: 'up', x: 32, y: 20, button: 'left' },
    { kind: 'text', text: 'A' },
  ]);
  if (process.env.CLOUD_WORKSPACE_SCREENSHOT) {
    await page.screenshot({ path: process.env.CLOUD_WORKSPACE_SCREENSHOT, fullPage: true });
  }

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
    scrollLeft: 73,
    scrollTop: 91,
    draft: 'blocked local draft',
    placeholder: 'Cloud 작업이 문서를 사용 중입니다. Cloud로 전환하거나 이 기기에서 이어받으세요.',
    targetMessage: 'Cloud 작업이 문서를 사용 중입니다. Cloud로 전환하거나 이 기기에서 이어받으세요.',
    targetMessageHidden: false,
    commandCount: 1,
    commandCountAfterBlockedSubmit: 1,
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
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ initial, cloudVisual, restored, closeCalls }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await stop(vite);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
