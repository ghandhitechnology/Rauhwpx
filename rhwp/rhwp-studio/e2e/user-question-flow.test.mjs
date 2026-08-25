/**
 * E2E: provider-blocking ask_user_question -> Studio draft -> reload -> answer.
 *
 * A fake Pi process keeps one real hub turn open while a mock MCP provider
 * issues a two-card question. The browser answers part of it, reloads, verifies
 * draft reconstruction, and submits through the original blocked call.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { issueScopedHubToken } from '../../rhwp-agent/hub-session-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(studioRoot, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const HUB_TOKEN = 'question-e2e';

async function availablePort(start) {
  for (let port = start; port < start + 30; port += 1) {
    const open = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (open) return port;
  }
  throw new Error(`No available port from ${start}`);
}

async function waitForHttp(url, label, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode)) {
      throw new Error(`${label} exited before becoming ready`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(300);
  }
  throw new Error(`${label} readiness timeout`);
}

function spawnLogged(command, args, cwd, env, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'w');
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', log, log],
  });
  child._log = log;
  return child;
}

async function stop(child) {
  if (!child) return;
  if (child.exitCode === null && !child.signalCode) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(4_000)]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  }
  if (child._log !== undefined) fs.closeSync(child._log);
}

function prepareFakePi() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-question-pi-'));
  const packageDir = path.join(root, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const binDir = path.join(root, 'prefix', 'node_modules', '.bin');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-e2e' }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    version: 1,
    installedVersion: '0.0.0-e2e',
    keyTail: null,
    models: [{
      id: 'mock-model', name: 'Mock model', reasoning: false, supportsImages: false,
      efforts: [], defaultEffort: null, contextLength: 8_192,
      pricing: { prompt: 0, completion: 0 },
    }],
    defaultModelId: 'mock-model',
    setupComplete: true,
  }));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: { openrouter: { apiKey: 'e2e-placeholder-key' } },
  }));
  const fake = path.join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  if (process.platform === 'win32') {
    fs.writeFileSync(fake, '@echo off\r\nnode -e "setInterval(() =^> {}, 1000)"\r\n');
  } else {
    fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" -e 'setInterval(() => {}, 1000)'\n`, { mode: 0o755 });
  }
  return root;
}

function connectQuestionProvider(hubPort, token, sessionId) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(token)}`
      + `&sessionId=${encodeURIComponent(sessionId)}&agent=pi&role=chat`,
  );
  let nextId = 1;
  const inflight = new Map();
  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message?.type !== 'tool-result') return;
    const pending = inflight.get(message.id);
    if (!pending) return;
    inflight.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message);
  });
  ws.addEventListener('close', () => {
    for (const [id, pending] of inflight) {
      clearTimeout(pending.timer);
      pending.resolve({
        v: 4, type: 'tool-result', id, ok: false,
        error: { code: 'SOCKET_CLOSED', message: 'mock provider socket closed' },
      });
    }
    inflight.clear();
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('mock provider socket failed')), { once: true });
  });
  return {
    ws,
    opened,
    call(tool, args, context = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          inflight.delete(id);
          reject(new Error(`blocked provider call timed out: ${tool}`));
        }, 90_000);
        inflight.set(id, { resolve, timer });
        ws.send(JSON.stringify({ v: 4, type: 'tool-call', id, tool, args, ...context }));
      });
    },
  };
}

async function startScreencast(page, directory) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const cdp = await page.createCDPSession();
  const writes = [];
  let index = 0;
  cdp.on('Page.screencastFrame', (frame) => {
    const filename = path.join(directory, `frame-${String(index++).padStart(5, '0')}.jpg`);
    writes.push(fs.promises.writeFile(filename, Buffer.from(frame.data, 'base64')));
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 78, everyNthFrame: 1 });
  return async (outputPath) => {
    await cdp.send('Page.stopScreencast');
    await Promise.all(writes);
    await cdp.detach();
    if (index === 0) return false;
    const result = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', '8',
      '-i', path.join(directory, 'frame-%05d.jpg'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath,
    ]);
    return result.status === 0;
  };
}

if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(chrome)) process.env.CHROME_PATH = chrome;
}

const hubPort = await availablePort(Number(process.env.RHWP_AGENT_PORT || 5791));
const vitePort = await availablePort(Number(process.env.VITE_PORT || 7791));
const viteUrl = `http://127.0.0.1:${vitePort}`;
const piRoot = prepareFakePi();
const targetDir = path.join(repoRoot, 'target', 'user-question-e2e');
fs.mkdirSync(targetDir, { recursive: true });

const hub = spawnLogged(
  process.execPath,
  [path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
  path.join(repoRoot, 'rhwp-agent'),
  { RHWP_AGENT_PORT: String(hubPort), RHWP_AGENT_TOKEN: HUB_TOKEN, RHWP_PI_DIR: piRoot },
  path.join(targetDir, 'hub.log'),
);
let vite;
let provider;
try {
  await waitForHttp(`http://127.0.0.1:${hubPort}/healthz?token=${HUB_TOKEN}`, 'hub', hub);
  vite = spawnLogged(
    npmCmd,
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    studioRoot,
    {
      BROWSER: 'none',
      VITE_RHWP_AGENT_URL: `ws://127.0.0.1:${hubPort}`,
      VITE_RHWP_AGENT_TOKEN: HUB_TOKEN,
    },
    path.join(targetDir, 'vite.log'),
  );
  await waitForHttp(viteUrl, 'Vite', vite);
  process.env.VITE_URL = viteUrl;
  const { runTest, assert, screenshot } = await import('./helpers.mjs');

  await runTest('ask_user_question reload and resume', async ({ page }) => {
    page.on('console', (message) => console.log(`  [browser:${message.type()}] ${message.text()}`));
    page.on('response', (response) => {
      if (response.status() >= 400) console.log(`  [browser:http ${response.status()}] ${response.url()}`);
    });
    await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 20_000 });
    await screenshot(page, 'ask-user-question-before');
    await page.evaluate(() => document.querySelector('.ag-threads-new')?.click());
    await page.waitForFunction(() => window.__agentBridge?.getActiveAgent?.() !== null, { timeout: 10_000 });
    await page.evaluate(() => window.__agentBridge.startChat(
      'pi', 'mock-model', undefined, false, 'safe', 'direct',
    ));
    try {
      await page.waitForFunction(() => window.__agentBridge?.getActiveAgent?.() === 'pi', { timeout: 20_000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        connection: window.__agentBridge?.getConnectionState?.(),
        active: window.__agentBridge?.getActiveAgent?.(),
        selected: window.__agentBridge?.getSelectedAgent?.(),
        text: document.querySelector('#agent-sidebar')?.textContent?.slice(0, 1_000),
      }));
      throw new Error(`${error.message}; bridge=${JSON.stringify(state)}`);
    }
    await page.type('.ag-input', 'Begin the mock blocking turn.');
    await page.click('.ag-send');
    await page.waitForFunction(() => window.__agentBridge?.isTurnRunning?.() === true, { timeout: 10_000 });

    const health = await (await fetch(`http://127.0.0.1:${hubPort}/healthz?token=${HUB_TOKEN}`)).json();
    const sessionId = health.sessions?.[0]?.sessionId;
    assert(Boolean(sessionId), 'Studio session registered with the hub');
    provider = connectQuestionProvider(hubPort, issueScopedHubToken(HUB_TOKEN, sessionId), sessionId);
    await provider.opened;

    const providerResult = provider.call('ask_user_question', {
      questions: [
        {
          id: 'surface', header: 'Surface', multiSelect: true,
          question: 'Which surfaces should be verified together?',
          options: [
            { label: 'Drawer', description: 'Verify the composer-attached question drawer.' },
            { label: 'History', description: 'Verify the immutable resolved history card.' },
            { label: 'Reconnect', description: 'Verify reload and reconnect reconstruction.' },
          ],
        },
        {
          id: 'detail', header: 'Details', allowOther: true,
          question: 'Choose the follow-up, including enough deliberately long plain text to verify wrapping without clipping at the narrowest supported sidebar width.',
          options: [
            { label: 'Accessibility', description: 'Inspect keyboard order, disclosure state, and the polite live region.' },
            { label: 'Persistence', description: 'Inspect draft restoration in the same blocked provider turn.' },
          ],
        },
      ],
    });

    await page.waitForSelector('.ag-user-question[data-inactive="false"] .ag-question-option', { timeout: 10_000 });
    assert(await page.$eval('.ag-question-count', (node) => node.textContent === '1 / 2'), 'First card is active');
    // The prompt receives focus when a card opens, so number shortcuts must
    // select options without stealing an editable control's keystrokes.
    await page.keyboard.press('1');
    await page.keyboard.press('2');
    await page.click('.ag-question-next');
    await page.waitForFunction(() => document.querySelector('.ag-question-count')?.textContent === '2 / 2');
    await page.click('.ag-question-other');
    await page.type('.ag-input', 'Keep my reconnect');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.type('.ag-input', 'draft');
    await delay(400);

    const videoDir = path.join(targetDir, 'reconnect-frames');
    const stopScreencast = await startScreencast(page, videoDir);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__agentBridge?.getConnectionState?.() === 'connected'
        && document.querySelector('.ag-question-count')?.textContent === '2 / 2',
      { timeout: 30_000 },
    );
    await delay(500);
    const restored = await page.$eval('.ag-input', (input) => ({
      value: input.value,
      label: input.getAttribute('aria-label'),
      maxLength: input.maxLength,
    }));
    assert(restored.value === 'Keep my reconnect\ndraft', 'Other draft and Shift+Enter newline restored after reload');
    assert(restored.label === '현재 질문의 직접 답변' && restored.maxLength === 2_000, 'Other composer semantics restored');

    await page.click('.ag-question-back');
    const selectedAfterReload = await page.$$eval(
      '.ag-question-option[data-selected="true"]',
      (nodes) => nodes.map((node) => node.querySelector('.ag-question-option-label')?.textContent),
    );
    assert(selectedAfterReload.join(',') === 'Drawer,History', 'Multi-select draft restored atomically');
    await page.click('.ag-question-next');

    for (const [width, height] of [[320, 600], [420, 900], [600, 900]]) {
      await page.setViewport({ width: Math.max(720, width + 120), height });
      await page.evaluate((value) => document.documentElement.style.setProperty('--ag-sidebar-width', `${value}px`), width);
      await delay(100);
      const layout = await page.$eval('.ag-user-question', (node) => ({
        width: Math.round(node.getBoundingClientRect().width),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }));
      assert(layout.scrollWidth <= layout.clientWidth + 1, `${width}px drawer has no horizontal overflow`);
      await screenshot(page, `ask-user-question-${width}x${height}`);
    }

    const a11y = await page.$eval('.ag-user-question', (node) => ({
      disclosureExpanded: node.querySelector('.ag-question-disclosure')?.getAttribute('aria-expanded'),
      live: node.querySelector('[aria-live="polite"]')?.getAttribute('aria-atomic'),
      optionPressed: node.querySelector('.ag-question-other')?.getAttribute('aria-pressed'),
      promptIsHtmlSafe: !node.querySelector('script, iframe, object'),
    }));
    assert(a11y.disclosureExpanded === 'true' && a11y.live === 'true', 'Disclosure and live-region semantics present');
    assert(a11y.optionPressed === 'true' && a11y.promptIsHtmlSafe, 'Selected Other and plain-text provider content are accessible');

    await page.click('.ag-question-disclosure');
    assert(await page.$eval('.ag-question-disclosure', (node) => node.getAttribute('aria-expanded') === 'false'), 'Drawer collapses without cancelling');
    await page.click('.ag-question-disclosure');
    // Drop the Studio socket at submit time. Enter must still route through
    // the question composer, buffer one response ID, and resume after reconnect.
    await page.click('.ag-input');
    const closed = await page.evaluate(() => {
      const socket = window.__agentBridge?.ws;
      if (!socket) return false;
      socket.close(4001, 'question-e2e-retry');
      return socket.readyState !== WebSocket.OPEN;
    });
    assert(closed, 'Studio socket entered closing state before the reconnect submission');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.ag-question-next')?.textContent === '제출 중…');

    const response = await providerResult;
    assert(response.ok === true && response.result?.status === 'answered', 'Original provider call resumed after submission');
    assert(
      response.result.answers.surface.selected.join(',') === 'Drawer,History'
        && response.result.answers.detail.otherText === 'Keep my reconnect\ndraft',
      'Provider received selections and Other text on the original call',
    );
    await page.waitForSelector('.ag-question-history');
    assert(await page.$eval('.ag-question-history', (node) => node.textContent.includes('답변 완료')), 'Resolved question remains in history');
    await screenshot(page, 'ask-user-question-resolved-history');

    const recordingPath = path.join(targetDir, 'ask-user-question-reconnect.mp4');
    const recorded = await stopScreencast(recordingPath);
    console.log(recorded ? `  Recording: ${recordingPath}` : '  Recording skipped (ffmpeg unavailable)');

    async function beginTurn(workflow, text) {
      await page.evaluate((nextWorkflow) => window.__agentBridge.startChat(
        'pi', 'mock-model', undefined, false, 'safe', nextWorkflow,
      ), workflow);
      await page.waitForFunction(
        (nextWorkflow) => window.__agentBridge?.getActiveAgent?.() === 'pi'
          && window.__agentBridge?.getWorkflowState?.().workflow === nextWorkflow,
        { timeout: 20_000 },
        workflow,
      );
      await page.type('.ag-input', text);
      await page.click('.ag-send');
      await page.waitForFunction(() => window.__agentBridge?.isTurnRunning?.() === true, { timeout: 10_000 });
    }

    // The fake provider intentionally keeps turns open after a tool result.
    // End the answered turn, then verify the drawer's own Stop path.
    await page.click('.ag-send');
    await page.waitForFunction(() => window.__agentBridge?.isTurnRunning?.() === false, { timeout: 10_000 });
    await beginTurn('direct', 'Begin a second turn that will be stopped from the question drawer.');
    const stoppedProviderResult = provider.call('ask_user_question', {
      questions: [{
        id: 'stop', header: 'Stop', question: 'Should this blocked turn be stopped?', allowOther: false,
        options: [
          { label: 'Continue', description: 'Keep the provider turn running.' },
          { label: 'Stop now', description: 'Cancel the provider turn from the drawer.' },
        ],
      }],
    });
    await page.waitForSelector('.ag-user-question[data-inactive="false"] .ag-question-stop');
    // WebSocket.send 성공은 허브 처리 확인이 아니다. 첫 interrupt를 성공한 것처럼
    // 돌려주되 실제로는 소켓을 닫아, 재연결 취소 마커가 원래 호출을 끝내는지 검증한다.
    const cancellationDropArmed = await page.evaluate(() => {
      const bridge = window.__agentBridge;
      if (!bridge || typeof bridge.sendJson !== 'function') return false;
      const sendJson = bridge.sendJson.bind(bridge);
      window.__questionCancellationDropCount = 0;
      bridge.sendJson = (frame) => {
        if (frame?.type === 'chat-interrupt') {
          if (window.__questionCancellationDropCount === 0) {
            window.__questionCancellationDropCount += 1;
            bridge.ws?.close(4002, 'question-e2e-cancellation-drop');
          }
          // 이 페이지의 후속 재시도도 성공한 것처럼 버려, 새로고침 뒤 복원된
          // 새 브리지만 허브에 취소를 전달할 수 있게 한다.
          return true;
        }
        return sendJson(frame);
      };
      return true;
    });
    assert(cancellationDropArmed, 'Question cancellation disconnect window armed');
    await page.click('.ag-question-stop');
    await page.waitForFunction(
      () => window.__questionCancellationDropCount === 1
        && window.__agentBridge?.getConnectionState?.() === 'connected',
      { timeout: 20_000 },
    );
    assert(
      await page.evaluate(() => Boolean(window.__agentBridge?.pendingQuestionCancellation)),
      'Cancellation marker remains pending after an apparently accepted drop',
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__agentBridge?.getConnectionState?.() === 'connected',
      { timeout: 30_000 },
    );
    const stoppedResponse = await stoppedProviderResult;
    assert(stoppedResponse.ok === false && stoppedResponse.error?.code === 'USER_QUESTION_CANCELLED', 'Drawer Stop cancels the original provider call');
    assert(!await page.evaluate(() => Boolean(window.__agentBridge?.pendingQuestionCancellation)), 'Reloaded bridge clears the cancellation marker after hub resolution');
    await page.waitForFunction(
      () => window.__agentBridge?.isTurnRunning?.() === false
        && !document.querySelector('.ag-user-question[data-inactive="false"]'),
      { timeout: 10_000 },
    );
    assert(
      !await page.$('.ag-user-question[data-inactive="false"]'),
      'Reload does not replay the cancelled question',
    );
    await screenshot(page, 'ask-user-question-cancelled-reload');
    // 새로고침된 UI가 고른 스레드와 브리지의 이전 허브 스레드를 다시 맞춘 뒤
    // 나머지 계획/프로바이더 손실 시나리오를 독립된 채팅에서 계속한다.
    await page.evaluate(() => document.querySelector('.ag-threads-new')?.click());

    // Planning uses the same indefinite Pi fallback but a different capability
    // profile. Supply the hub epoch exactly as the real MCP shim does.
    await beginTurn('plan', 'Begin a planning turn that asks one blocking question.');
    const planningState = await page.evaluate(() => window.__agentBridge.getWorkflowState());
    assert(planningState.workflow === 'plan' && planningState.phase === 'planning', 'Planning phase is active');
    const planningProviderResult = provider.call('ask_user_question', {
      questions: [{
        id: 'plan', header: 'Plan', question: 'Which planning direction should be used?', allowOther: false,
        options: [
          { label: 'Focused', description: 'Keep the plan narrowly scoped.' },
          { label: 'Broad', description: 'Explore a broader plan.' },
        ],
      }],
    }, {
      workflow: planningState.workflow,
      capabilityEpoch: planningState.capabilityEpoch,
    });
    await page.waitForSelector('.ag-user-question[data-inactive="false"] .ag-question-option');
    await page.keyboard.press('1');
    await page.click('.ag-question-next');
    const planningResponse = await planningProviderResult;
    assert(planningResponse.ok === true && planningResponse.result?.answers?.plan?.selected?.[0] === 'Focused', 'Pi fallback answers within the planning turn');
    await page.click('.ag-send');
    await page.waitForFunction(() => window.__agentBridge?.isTurnRunning?.() === false, { timeout: 10_000 });

    // Finally, sever the provider MCP transport while a question is live. The
    // drawer must settle as expired with no idle timeout or stuck editing lease.
    await beginTurn('direct', 'Begin a final turn whose provider connection will be lost.');
    const lostProviderResult = provider.call('ask_user_question', {
      questions: [{
        id: 'loss', header: 'Loss', question: 'This request will lose its provider connection.', allowOther: false,
        options: [
          { label: 'One', description: 'First placeholder choice.' },
          { label: 'Two', description: 'Second placeholder choice.' },
        ],
      }],
    });
    await page.waitForSelector('.ag-user-question[data-inactive="false"] .ag-question-option');
    provider.ws.close();
    const lostResponse = await lostProviderResult;
    assert(lostResponse.error?.code === 'SOCKET_CLOSED', 'Mock provider observed the connection loss');
    await page.waitForFunction(() => [...document.querySelectorAll('.ag-question-history')]
      .some((node) => node.textContent?.includes('만료')));
    assert(await page.$eval('.ag-user-question', (node) => node.dataset.inactive === 'true'), 'Provider loss removes the live drawer');
    await screenshot(page, 'ask-user-question-provider-loss-history');
    await page.click('.ag-send');
  });
} finally {
  provider?.ws?.close();
  await stop(vite);
  await stop(hub);
  fs.rmSync(piRoot, { recursive: true, force: true });
}
