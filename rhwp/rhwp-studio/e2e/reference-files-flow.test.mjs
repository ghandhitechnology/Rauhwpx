/**
 * E2E: reference-file upload/search and scope isolation through the real Studio UI and hub.
 *
 * Starts an isolated hub and Vite instance, uploads chat/document/global text files through
 * the browser file input, searches extracted contents, starts a second chat, and confirms
 * through the hub-local MCP tools that chat references do not leak while document/global
 * references remain available.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(studioRoot, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const hubToken = 'reference-e2e';

async function availablePort(start) {
  for (let port = start; port < start + 30; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`No available port from ${start}`);
}

async function waitForHttp(url, label, child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`${label} exited before startup`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(300);
  }
  throw new Error(`${label} startup timed out`);
}

function spawnLogged(command, args, cwd, env, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFile = fs.openSync(logPath, 'w');
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', logFile, logFile],
  });
  child.logFile = logFile;
  return child;
}

async function stop(child) {
  if (!child) return;
  if (child.exitCode === null && !child.signalCode) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  }
  if (child.logFile !== undefined) fs.closeSync(child.logFile);
}

async function chooseScope(page, scope) {
  await page.click('.ag-references-btn');
  await page.waitForSelector('.ag-references-page[aria-hidden="false"]');
  await page.click(`.ag-reference-tab[data-scope="${scope}"]`);
}

async function chooseFile(page, { name, content }) {
  await page.evaluate(({ fileName, fileContent }) => {
    const input = document.querySelector('.ag-reference-file-input');
    if (!(input instanceof HTMLInputElement)) throw new Error('Reference input not found');
    const transfer = new DataTransfer();
    transfer.items.add(new File([fileContent], fileName, { type: 'text/plain' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { fileName: name, fileContent: content });
}

async function uploadFile(page, { scope, name, content }) {
  await chooseScope(page, scope);
  await page.click('.ag-reference-add');
  await chooseFile(page, { name, content });
}

async function stageQuickFile(page, { name, content }) {
  await page.click('.ag-reference-quick-add');
  await chooseFile(page, { name, content });
}

async function waitForCount(page, expected) {
  try {
    await page.waitForFunction(
      (value) => document.querySelector('.ag-references-count')?.textContent === String(value),
      { timeout: 10_000 },
      expected,
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      count: document.querySelector('.ag-references-count')?.textContent,
      status: document.querySelector('.ag-reference-status')?.textContent,
      error: document.querySelector('.ag-reference-error')?.textContent,
      activeScope: document.querySelector('.ag-reference-tab[aria-selected="true"]')?.getAttribute('data-scope'),
      documentDisabled: document.querySelector('.ag-reference-tab[data-scope="document"]')?.hasAttribute('disabled'),
    }));
    throw new Error(`Reference count did not reach ${expected}: ${JSON.stringify(state)}; ${error.message}`);
  }
}

if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(chrome)) process.env.CHROME_PATH = chrome;
}

const hubPort = await availablePort(Number(process.env.RHWP_AGENT_PORT || 5741));
const vitePort = await availablePort(Number(process.env.VITE_PORT || 7741));
const viteUrl = `http://127.0.0.1:${vitePort}`;
const referenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-reference-e2e-'));
const logRoot = path.join(repoRoot, 'target');
let hub;
let vite;
let failed = false;

try {
  hub = spawnLogged(
    process.execPath,
    [path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
    path.join(repoRoot, 'rhwp-agent'),
    {
      RHWP_AGENT_PORT: String(hubPort),
      RHWP_AGENT_TOKEN: hubToken,
      RHWP_REFERENCES_DIR: referenceRoot,
    },
    path.join(logRoot, 'reference-files-e2e-hub.log'),
  );
  await waitForHttp(`http://127.0.0.1:${hubPort}/healthz`, 'hub', hub);

  vite = spawnLogged(
    npmCmd,
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    studioRoot,
    {
      BROWSER: 'none',
      VITE_RHWP_AGENT_URL: `ws://127.0.0.1:${hubPort}`,
      VITE_RHWP_AGENT_TOKEN: hubToken,
    },
    path.join(logRoot, 'reference-files-e2e-vite.log'),
  );
  await waitForHttp(viteUrl, 'Vite', vite);

  process.env.VITE_URL = viteUrl;
  const { runTest, assert, createNewDocument, screenshot } = await import('./helpers.mjs');
  await runTest('참고자료 업로드·검색·범위 격리', async ({ page }) => {
    await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected');
    await createNewDocument(page);
    await page.waitForFunction(() => {
      const tab = document.querySelector('.ag-reference-tab[data-scope="document"]');
      return tab instanceof HTMLButtonElement && !tab.disabled;
    });

    await page.type('.ag-input', 'draft message');
    await stageQuickFile(page, {
      name: 'discarded-draft.txt',
      content: 'THIS_DRAFT_MUST_NOT_REACH_THE_REFERENCE_STACK',
    });
    await page.waitForFunction(() => document.querySelector('.ag-reference-upload-chip-state')?.textContent === '전송 대기');
    const beforeErase = await page.evaluate(async () => ({
      drafts: document.querySelectorAll('.ag-reference-upload-chip').length,
      references: (await window.__agentBridge.listReferences('chat', window.__agentBridge.threadId)).length,
    }));
    await page.evaluate(() => {
      const input = document.querySelector('.ag-input');
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('Composer input not found');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('.ag-reference-upload-chip').length === 0);
    const afterErase = await page.evaluate(async () => (
      await window.__agentBridge.listReferences('chat', window.__agentBridge.threadId)
    ).length);
    assert(beforeErase.drafts === 1 && beforeErase.references === 0 && afterErase === 0,
      'quick attachments stay draft-only and erasing the message discards them');

    await uploadFile(page, {
      scope: 'chat',
      name: 'chat-secret.txt',
      content: 'CHAT_ONLY_MARKER private launch checklist for the first chat.',
    });
    await waitForCount(page, 1);

    await page.type('.ag-reference-search', 'CHAT_ONLY_MARKER');
    await page.waitForFunction(() => document.querySelector('.ag-reference-search-snippet')?.textContent?.includes('CHAT_ONLY_MARKER'));
    assert(true, 'chat-scoped file uploads and content search returns its indexed excerpt');
    await page.click('.ag-references-close');

    await uploadFile(page, {
      scope: 'document',
      name: 'document-guide.txt',
      content: 'DOCUMENT_MARKER instructions shared by chats attached to this document.',
    });
    await waitForCount(page, 2);
    await page.click('.ag-references-close');

    await uploadFile(page, {
      scope: 'global',
      name: 'global-glossary.txt',
      content: 'GLOBAL_MARKER background glossary available in every chat.',
    });
    await waitForCount(page, 3);
    await page.click('.ag-references-close');

    const firstThreadId = await page.evaluate(() => window.__agentBridge.threadId);
    await page.click('button[aria-label="채팅 목록"]');
    await page.waitForSelector('.ag-threads-page[aria-hidden="false"]');
    await page.evaluate(() => document.querySelector('.ag-threads-new')?.click());
    await page.waitForFunction(
      (previous) => document.querySelector('.ag-threads-page')?.getAttribute('aria-hidden') === 'true'
        && window.__agentBridge.threadId !== previous,
      {},
      firstThreadId,
    );
    const scopeState = await page.evaluate(async () => ({
      threadId: window.__agentBridge.threadId,
      documentId: window.__agentBridge.documentId,
      chatFiles: (await window.__agentBridge.listReferences('chat', window.__agentBridge.threadId)).map((file) => file.name),
      documentFiles: (await window.__agentBridge.listReferences('document', window.__agentBridge.documentId)).map((file) => file.name),
      globalFiles: (await window.__agentBridge.listReferences('global', 'global')).map((file) => file.name),
    }));
    console.log(`  [scope] ${JSON.stringify(scopeState)}`);
    await waitForCount(page, 2);

    assert(
      scopeState.chatFiles.length === 0,
      `old chat content is absent from the new chat (${scopeState.chatFiles.join(', ') || 'none'})`,
    );
    assert(
      JSON.stringify(scopeState.documentFiles) === JSON.stringify(['document-guide.txt'])
        && JSON.stringify(scopeState.globalFiles) === JSON.stringify(['global-glossary.txt']),
      'new chat retains document and global reference manifests',
    );
    const retrieval = await page.evaluate(async () => ({
      chat: await window.__agentBridge.searchReferences(
        'CHAT_ONLY_MARKER', 'chat', window.__agentBridge.threadId,
      ),
      document: await window.__agentBridge.searchReferences(
        'DOCUMENT_MARKER', 'document', window.__agentBridge.documentId,
      ),
      global: await window.__agentBridge.searchReferences('GLOBAL_MARKER', 'global', 'global'),
    }));
    assert(retrieval.chat.length === 0, 'old chat content is absent from new-chat retrieval');
    assert(
      retrieval.document.length === 1 && retrieval.global.length === 1,
      'document/global content remains searchable in the new chat',
    );
    await screenshot(page, 'reference-files-scopes');
  });
} catch (error) {
  console.error(`reference-files E2E setup failed: ${error?.stack ?? error}`);
  failed = true;
} finally {
  await stop(vite);
  await stop(hub);
  fs.rmSync(referenceRoot, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
