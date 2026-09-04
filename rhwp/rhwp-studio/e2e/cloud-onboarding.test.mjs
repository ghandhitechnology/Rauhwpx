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
        reject(new Error('Vite 테스트 포트를 할당하지 못했습니다.'));
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
      throw new Error(`Vite가 준비되기 전에 종료되었습니다. code=${child.exitCode ?? child.signalCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error('Vite 준비 시간이 초과되었습니다.');
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

async function buttonByText(page, label) {
  const handles = await page.$$('.ag-cloud-setup-dialog button');
  for (const handle of handles) {
    if (await handle.evaluate((node, expected) => node.textContent?.trim() === expected, label)) return handle;
    await handle.dispose();
  }
  throw new Error(`Cloud 설정 버튼을 찾지 못했습니다. label=${label}`);
}

// 사이드바 화면 전환은 280ms 동안 밀려 들어오고 밀려 나간다. Puppeteer 는 좌표를 먼저
// 재고 그 다음에 마우스를 보내므로, 움직이는 요소는 몇 픽셀 옆을 맞고 조용히 실패한다.
// 두 프레임 연속 같은 사각형일 때만 누른다.
async function settleBox(handle) {
  let previous = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const box = await handle.evaluate((node) => new Promise((resolve) => {
      requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        resolve([rect.x, rect.y, rect.width, rect.height].map(Math.round).join(','));
      });
    }));
    if (box === previous) return;
    previous = box;
  }
  throw new Error('요소 위치가 멎지 않았습니다.');
}

async function clickButton(page, label) {
  const handle = await buttonByText(page, label);
  await settleBox(handle);
  await handle.click();
  await handle.dispose();
}

async function clickStable(page, selector) {
  const handle = await page.waitForSelector(selector, { visible: true, timeout: 15_000 });
  await settleBox(handle);
  await handle.click();
  await handle.dispose();
}

async function inputByLabel(page, label) {
  const handles = await page.$$('.ag-cloud-setup-field');
  for (const handle of handles) {
    const matches = await handle.evaluate((node, expected) =>
      node.querySelector('.ag-cloud-setup-label')?.textContent?.trim() === expected, label);
    if (matches) {
      const input = await handle.$('input, select');
      await handle.dispose();
      if (input) return input;
      break;
    }
    await handle.dispose();
  }
  throw new Error(`Cloud 설정 입력을 찾지 못했습니다. label=${label}`);
}

async function fillInput(page, label, value) {
  const input = await inputByLabel(page, label);
  await input.click({ clickCount: 3 });
  await input.press('Backspace');
  await input.type(value);
  await input.dispose();
}

async function selectInput(page, label, value) {
  const input = await inputByLabel(page, label);
  await input.select(value);
  await input.dispose();
}

async function waitForTitle(page, title) {
  await page.waitForFunction(
    (expected) => document.querySelector('.ag-cloud-setup-title')?.textContent?.trim() === expected,
    { timeout: 10_000 },
    title,
  );
}

async function openSetup(page) {
  await clickStable(page, '#agent-sidebar .ag-cloud-btn');
  await page.waitForSelector('.ag-cloud-panel:not([hidden])');
  const actions = await page.$$('.ag-cloud-panel-actions button');
  const setup = await (async () => {
    for (const action of actions) {
      if (await action.evaluate((node) => node.textContent?.trim().startsWith('Cloud 설정'))) return action;
      await action.dispose();
    }
    return null;
  })();
  if (!setup) throw new Error('Cloud 상태 패널에서 설정 버튼을 찾지 못했습니다.');
  await setup.evaluate((node) => node.click());
  await setup.dispose();
  await page.waitForSelector('.ag-cloud-setup-overlay:not([hidden])');
}

async function openChoice(page) {
  await openSetup(page);
  await waitForTitle(page, 'Cloud 서버 선택');
}

async function chooseMode(page, mode) {
  await clickStable(page, `.ag-cloud-setup-option[data-server-mode="${mode}"]`);
  await page.waitForFunction(
    (value) => document.querySelector(`.ag-cloud-setup-option[data-server-mode="${value}"]`)
      ?.getAttribute('aria-checked') === 'true',
    { timeout: 10_000 },
    mode,
  );
  await clickButton(page, '계속');
}

async function openCloud(page) {
  await openChoice(page);
  await chooseMode(page, 'self-hosted');
  await waitForTitle(page, '내 VPS에서 Cloud 시작하기');
}

async function manageCloud(page) {
  await clickStable(page, '#agent-sidebar .ag-settings-btn');
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.classList.contains('ag-settings-open'));
  await page.waitForFunction(() => !document.body.classList.contains('ag-sidebar-animating'));
  await page.focus('#ag-settings-tab-connections');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('#ag-settings-tab-connections')?.getAttribute('aria-selected') === 'true',
    { timeout: 15_000 },
  );
  await clickStable(page, '.ag-cloud-settings-action');
  await page.waitForSelector('.ag-cloud-setup-overlay:not([hidden])');
}

async function closeSettings(page) {
  await clickStable(page, '#agent-sidebar .ag-settings-close');
  await page.waitForFunction(() => !document.querySelector('#agent-sidebar')?.classList.contains('ag-settings-open'));
}

async function settingsCard(page) {
  return await page.evaluate(() => ({
    status: document.querySelector('.ag-cloud-settings-status')?.textContent?.trim() ?? '',
    detail: document.querySelector('.ag-cloud-settings-detail')?.textContent?.trim() ?? '',
    action: document.querySelector('.ag-cloud-settings-action')?.textContent?.trim() ?? '',
  }));
}

async function assertResponsiveDialog(page, viewport) {
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  await delay(100);
  const geometry = await page.evaluate(() => {
    const overlay = document.querySelector('.ag-cloud-setup-overlay');
    const dialog = document.querySelector('.ag-cloud-setup-dialog');
    const footer = document.querySelector('.ag-cloud-setup-footer');
    const rect = dialog?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      overlayWidth: overlay?.scrollWidth ?? 0,
      dialogWidth: dialog?.scrollWidth ?? 0,
      dialogClientWidth: dialog?.clientWidth ?? 0,
      rect: rect && { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      footer: footerRect && { left: footerRect.left, right: footerRect.right, bottom: footerRect.bottom },
    };
  });
  assert.ok(geometry.rect, 'Cloud 설정 대화상자가 보여야 합니다.');
  assert.ok(geometry.rect.left >= 0 && geometry.rect.right <= geometry.viewport.width + 0.5,
    `${viewport.width}px에서 대화상자가 가로 뷰포트 안에 있어야 합니다. ${JSON.stringify(geometry)}`);
  assert.ok(geometry.rect.top >= 0 && geometry.rect.bottom <= geometry.viewport.height + 0.5,
    `${viewport.height}px에서 대화상자가 세로 뷰포트 안에 있어야 합니다. ${JSON.stringify(geometry)}`);
  assert.ok(geometry.overlayWidth <= geometry.viewport.width,
    `${viewport.width}px에서 오버레이 가로 스크롤이 없어야 합니다.`);
  assert.ok(geometry.dialogWidth <= geometry.dialogClientWidth,
    `${viewport.width}px에서 대화상자 콘텐츠가 넘치지 않아야 합니다.`);
  assert.ok(geometry.footer && geometry.footer.left >= 0
    && geometry.footer.right <= geometry.viewport.width + 0.5
    && geometry.footer.bottom <= geometry.viewport.height + 0.5,
    `${viewport.width}px에서 주요 동작 버튼이 뷰포트 안에 있어야 합니다.`);
}

function cloudMock() {
  const calls = [];
  const railway = { providerId: 'railway', displayName: 'Railway', configured: true, missingConfig: [] };
  let revision = 0;
  let profile = null;
  let sandbox = null;
  let connection = 'unknown';
  let testFailures = 0;
  let testDelays = [];
  let listener = null;
  let providers = [{ ...railway }];
  let preferredMode = null;
  let lifecycle = 'idle';
  let serverMessage = null;
  let spawnFailures = 0;
  let spawnError = 'Railway deployment reports crashed';
  let spawnLeavesSandbox = false;
  let spawnDelayMs = 80;
  let teardownError = null;
  let sandboxUnmanaged = false;
  let sandboxSeq = 0;

  const wait = () => new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
  const profileState = () => {
    if (sandbox) {
      return {
        kind: 'configured',
        mode: 'app-hosted',
        name: sandbox.displayName,
        sandbox: structuredClone(sandbox),
        connection,
        serviceVersion: connection === 'ready' ? '1.0.0-e2e' : null,
        message: null,
      };
    }
    if (profile) {
      return {
        kind: 'configured',
        mode: 'self-hosted',
        profile: structuredClone(profile),
        connection,
        serviceVersion: connection === 'ready' ? '1.0.0-e2e' : null,
        message: null,
      };
    }
    return { kind: 'unconfigured' };
  };
  const snapshot = () => ({
    revision: ++revision,
    profileEpoch: 0,
    available: true,
    profile: profileState(),
    server: {
      mode: sandbox ? 'app-hosted' : profile ? 'self-hosted' : null,
      preferredMode,
      providers: structuredClone(providers),
      lifecycle,
      message: serverMessage,
    },
    lease: { owner: 'local' },
    session: { kind: 'idle' },
    sessions: [],
    queuedMessages: [],
    timeline: null,
    account: {
      signedIn: true,
      account: { id: 'account-e2e', email: 'cloud@example.test', displayName: 'Cloud E2E' },
      quota: null,
      raucloud: { kind: 'available' },
      updatedAt: new Date(1_700_000_000_000 + revision * 1_000).toISOString(),
    },
    updatedAt: new Date(1_700_000_000_000 + revision * 1_000).toISOString(),
  });
  const record = (method, payload) => calls.push({ method, payload: structuredClone(payload ?? null) });
  const publish = () => listener?.({ snapshot: snapshot() });

  window.__cloudHarness = {
    calls,
    clearCalls() {
      calls.length = 0;
    },
    setTestFailures(count) {
      testFailures = count;
    },
    setTestDelays(delays) {
      testDelays = [...delays];
    },
    publishSnapshot() {
      publish();
    },
    setUnconfigured() {
      profile = null;
      sandbox = null;
      connection = 'unknown';
      lifecycle = 'idle';
      serverMessage = null;
      preferredMode = null;
      publish();
    },
    setProviders(next) {
      providers = structuredClone(next);
      publish();
    },
    setSpawnFailures(count, message, { leavesSandbox = false } = {}) {
      spawnFailures = count;
      spawnLeavesSandbox = leavesSandbox;
      if (message) spawnError = message;
    },
    setSpawnDelay(milliseconds) {
      spawnDelayMs = milliseconds;
    },
    setTeardownError(message) {
      teardownError = message;
    },
    /** 이 빌드가 공급자를 모르는 상태. 상태 조회는 실패를 알리고 철거는 연결만 놓는다. */
    setSandboxUnmanaged(host) {
      sandboxUnmanaged = true;
      connection = 'error';
      lifecycle = 'error';
      serverMessage = `This app cannot manage the railway sandbox at ${host}.`
        + ' Release it here, then delete the server in the provider console.';
      publish();
    },
    serverState() {
      return { preferredMode, lifecycle, mode: sandbox ? 'app-hosted' : profile ? 'self-hosted' : null };
    },
  };

  window.rhwpDesktop = {
    platform: 'linux',
    async cloudGetState(payload) {
      record('cloudGetState', payload);
      return { snapshot: snapshot() };
    },
    async cloudSelectServerMode(payload) {
      record('cloudSelectServerMode', payload);
      preferredMode = payload.mode;
      return { snapshot: snapshot() };
    },
    async cloudSpawnSandbox(payload) {
      record('cloudSpawnSandbox', payload);
      if (sandbox) return { snapshot: snapshot() };
      lifecycle = 'provisioning';
      serverMessage = null;
      publish();
      await wait();
      if (spawnFailures > 0) {
        spawnFailures -= 1;
        if (spawnLeavesSandbox) {
          sandboxSeq += 1;
          sandbox = {
            providerId: payload.providerId ?? 'railway',
            sandboxId: `sbx-${sandboxSeq}`,
            displayName: `Raucloud ${sandboxSeq}`,
            region: 'us-west2',
            host: `rauhwpx-${sandboxSeq}.up.railway.app`,
            createdAt: new Date(1_700_000_000_000).toISOString(),
          };
          connection = 'error';
        }
        lifecycle = 'error';
        serverMessage = spawnError;
        publish();
        throw new Error(spawnError);
      }
      sandboxSeq += 1;
      sandbox = {
        providerId: payload.providerId ?? 'railway',
        sandboxId: `sbx-${sandboxSeq}`,
        displayName: `Raucloud ${sandboxSeq}`,
        region: 'us-west2',
        host: `rauhwpx-${sandboxSeq}.up.railway.app`,
        createdAt: new Date(1_700_000_000_000).toISOString(),
      };
      connection = 'ready';
      lifecycle = 'ready';
      serverMessage = null;
      preferredMode = 'app-hosted';
      return { snapshot: snapshot() };
    },
    async cloudSandboxStatus() {
      record('cloudSandboxStatus');
      return { snapshot: snapshot() };
    },
    async cloudTeardownSandbox(payload) {
      record('cloudTeardownSandbox', payload);
      // 진행 중인 작업이 있으면 수명주기를 건드리기 전에 거절한다. 데스크톱 조정자와 같은 순서다.
      if (teardownError && payload.force !== true) {
        const message = teardownError;
        teardownError = null;
        throw new Error(message);
      }
      if (sandboxUnmanaged) {
        sandboxUnmanaged = false;
        sandbox = null;
        connection = 'unknown';
        lifecycle = 'idle';
        serverMessage = null;
        preferredMode = null;
        return { snapshot: { ...snapshot(), sandbox: { ok: true, removed: false, unmanaged: true } } };
      }
      lifecycle = 'tearing-down';
      publish();
      await wait();
      sandbox = null;
      connection = 'unknown';
      lifecycle = 'idle';
      serverMessage = null;
      preferredMode = null;
      return { snapshot: { ...snapshot(), sandbox: { ok: true, removed: true, unmanaged: false } } };
    },
    async cloudSaveProfile(payload) {
      record('cloudSaveProfile', payload);
      await wait();
      profile = structuredClone(payload.profile);
      connection = 'unknown';
      return { snapshot: snapshot() };
    },
    async cloudTestProfile(payload) {
      record('cloudTestProfile', payload);
      await new Promise((resolve) => setTimeout(resolve, testDelays.shift() ?? 80));
      if (testFailures > 0) {
        testFailures -= 1;
        throw new Error('No route to host');
      }
      return { snapshot: snapshot() };
    },
    async cloudProvision(payload) {
      record('cloudProvision', payload);
      await wait();
      if (sandbox) throw new Error('Shut down the app-provided sandbox before connecting your own server.');
      profile = structuredClone(payload.profile);
      connection = 'ready';
      preferredMode = 'self-hosted';
      return { snapshot: snapshot() };
    },
    async cloudPair(payload) {
      record('cloudPair', payload);
      await wait();
      profile = structuredClone(payload.profile);
      connection = 'ready';
      preferredMode = 'self-hosted';
      return { snapshot: snapshot() };
    },
    async cloudSetTransferIntent(payload) {
      record('cloudSetTransferIntent', payload);
      return { snapshot: snapshot() };
    },
    async cloudTransfer(payload) {
      record('cloudTransfer', payload);
      return { snapshot: snapshot() };
    },
    onCloudEvent(callback) {
      record('onCloudEvent');
      listener = callback;
      return () => {
        record('offCloudEvent');
        listener = null;
      };
    },
  };
}

const port = await availablePort();
const viteUrl = `http://127.0.0.1:${port}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rauhwpx-cloud-onboarding-'));
const vite = spawn(
  process.execPath,
  [path.join(studioRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: studioRoot, env: { ...process.env, BROWSER: 'none' }, stdio: ['ignore', 'ignore', 'ignore'] },
);
let browser;

try {
  await waitForHttp(viteUrl, vite);
  assert.ok(chromePath, 'Chrome 또는 Chromium 실행 파일이 있어야 합니다.');
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
  await page.evaluateOnNewDocument(cloudMock);
  await page.goto(viteUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#agent-sidebar .ag-cloud-btn:not([hidden])', { timeout: 60_000 });
  assert.equal(
    await page.evaluate(() => window.__cloudHarness.calls.some((call) => call.method === 'onCloudEvent')),
    true,
  );
  assert.equal(
    await page.evaluate(() => window.__cloudHarness.calls.some((call) => call.method === 'cloudGetState')),
    true,
  );

  console.log('Cloud onboarding E2E');

  assert.deepEqual(await settingsCard(page), {
    status: '설정되지 않음',
    detail: '작업은 계속되고 문서 화면은 실시간으로 열립니다.',
    action: '설정',
  });
  await openChoice(page);
  assert.deepEqual(
    await page.$$eval('.ag-cloud-setup-progress-step', (nodes) => nodes.map((node) => ({
      label: node.textContent?.trim(),
      state: node.dataset.state,
      current: node.getAttribute('aria-current'),
    }))),
    [
      { label: '1서버 선택', state: 'current', current: 'step' },
      { label: '2환경 연결', state: 'upcoming', current: null },
      { label: '3준비 완료', state: 'upcoming', current: null },
    ],
  );
  assert.equal(
    await page.$eval('.ag-cloud-setup-live-copy strong', (node) => node.textContent?.trim()),
    '에이전트가 편집하는 문서를 그대로 봅니다',
  );
  if (process.env.CLOUD_ONBOARDING_SCREENSHOT) {
    await delay(250);
    await page.screenshot({ path: process.env.CLOUD_ONBOARDING_SCREENSHOT, fullPage: true });
  }
  assert.deepEqual(
    await page.$$eval('.ag-cloud-setup-option', (nodes) => nodes.map((node) => ({
      mode: node.dataset.serverMode,
      heading: node.querySelector('strong')?.textContent?.trim(),
      note: node.querySelector('.ag-cloud-setup-option-note')?.textContent?.trim(),
      checked: node.getAttribute('aria-checked'),
    }))),
    [
      { mode: 'app-hosted', heading: 'Raucloud', note: 'Railway 사용 가능', checked: 'true' },
      { mode: 'self-hosted', heading: '내 서버 사용', note: 'SSH와 비밀번호 없는 sudo가 필요합니다', checked: 'false' },
    ],
  );
  assert.equal(await page.$eval('.ag-cloud-setup-options', (node) => node.getAttribute('role')), 'radiogroup');
  await page.focus('.ag-cloud-setup-option[data-server-mode="app-hosted"]');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.ag-cloud-setup-option[data-server-mode="self-hosted"]')?.getAttribute('aria-checked') === 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.serverMode), 'self-hosted');
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.querySelector('.ag-cloud-setup-option[data-server-mode="app-hosted"]')?.getAttribute('aria-checked') === 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.serverMode), 'app-hosted');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  assert.deepEqual(await page.evaluate(() => ({
    dialog: getComputedStyle(document.querySelector('.ag-cloud-setup-dialog')).animationName,
    caret: getComputedStyle(document.querySelector('.ag-cloud-setup-live-caret')).animationName,
  })), { dialog: 'none', caret: 'none' });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.evaluate(() => window.__cloudHarness.clearCalls());
  await clickStable(page, '.ag-cloud-setup-option[data-server-mode="self-hosted"]');
  await page.waitForFunction(() => document.querySelector('.ag-cloud-setup-option[data-server-mode="self-hosted"]')?.getAttribute('aria-checked') === 'true');
  assert.deepEqual(
    await page.evaluate(() => window.__cloudHarness.calls.filter((call) => call.method === 'cloudSelectServerMode').map((call) => call.payload)),
    [{ mode: 'self-hosted' }],
  );
  assert.equal(await page.evaluate(() => window.__cloudHarness.serverState().preferredMode), 'self-hosted');
  await clickButton(page, '취소');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  await page.evaluate(() => window.__cloudHarness.setUnconfigured());
  console.log('  PASS the server choice offers both modes and persists the selection');

  await openCloud(page);
  await clickButton(page, '뒤로');
  await waitForTitle(page, 'Cloud 서버 선택');
  assert.equal(
    await page.$eval('.ag-cloud-setup-option[data-server-mode="self-hosted"]', (node) => node.getAttribute('aria-checked')),
    'true',
  );
  await chooseMode(page, 'self-hosted');
  await waitForTitle(page, '내 VPS에서 Cloud 시작하기');
  assert.match(await page.$eval('.ag-cloud-setup-description', (node) => node.textContent), /앱을 닫아도 작업이 계속/);
  assert.equal(await page.$$eval('.ag-cloud-setup-requirements li', (nodes) => nodes.length), 3);
  console.log('  PASS intro explains the private VPS journey');

  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'VPS 연결');
  await page.evaluate(() => document.querySelector('#agent-sidebar .ag-cloud-btn')?.focus());
  assert.equal(await page.evaluate(() => document.querySelector('.ag-cloud-setup-dialog')?.contains(document.activeElement)), true);
  await page.mouse.click(1100, 700);
  assert.equal(await page.$eval('.ag-cloud-setup-overlay', (node) => !node.hidden), true);
  assert.equal(await page.evaluate(() => document.querySelector('.ag-cloud-setup-dialog')?.contains(document.activeElement)), true);
  console.log('  PASS keyboard and pointer focus stay inside the modal');

  for (const viewport of [
    { width: 375, height: 667 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
  ]) {
    await assertResponsiveDialog(page, viewport);
  }
  console.log('  PASS narrow, default, and wide layouts stay within the viewport');

  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await clickButton(page, 'VPS 연결');
  await waitForTitle(page, 'VPS 연결 정보');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('placeholder')), '100.64.0.1 또는 vps-name.tailnet.ts.net');
  await clickButton(page, '뒤로');
  await waitForTitle(page, '내 VPS에서 Cloud 시작하기');
  await clickButton(page, 'VPS 연결');
  await waitForTitle(page, 'VPS 연결 정보');
  await clickButton(page, '취소');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ag-cloud-btn')), true);
  console.log('  PASS back and cancel preserve context and restore focus');

  await openCloud(page);
  await page.$eval('.ag-cloud-setup-dialog', (node) => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }));
  });
  assert.equal(await page.$eval('.ag-cloud-setup-overlay', (node) => !node.hidden), true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ag-cloud-btn')), true);
  console.log('  PASS Escape closes the modal and restores focus');

  await openCloud(page);
  await clickButton(page, 'VPS 연결');
  await waitForTitle(page, 'VPS 연결 정보');
  await page.click('.ag-cloud-setup-advanced > summary');
  await selectInput(page, '연결 방식', 'https');
  await page.waitForSelector('[data-cloud-field="endpoint"]');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.cloudField), 'transport');
  await fillInput(page, 'Cloud HTTPS 주소', 'https://draft.example.com/rauhwpx-cloud');
  await selectInput(page, '연결 방식', 'tailscale');
  await page.click('.ag-cloud-setup-advanced > summary');
  await selectInput(page, '연결 방식', 'https');
  assert.equal(await page.$eval('[data-cloud-field="endpoint"]', (node) => node.value), 'https://draft.example.com/rauhwpx-cloud');
  await selectInput(page, '연결 방식', 'tailscale');
  await page.click('.ag-cloud-setup-advanced > summary');
  await selectInput(page, 'SSH 인증', 'key-file');
  await page.waitForSelector('[data-cloud-field="keyPath"]');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.cloudField), 'auth');
  await fillInput(page, '개인 키 파일', '/tmp/draft-key');
  await selectInput(page, 'SSH 인증', 'ssh-agent');
  await page.click('.ag-cloud-setup-advanced > summary');
  await selectInput(page, 'SSH 인증', 'key-file');
  assert.equal(await page.$eval('[data-cloud-field="keyPath"]', (node) => node.value), '/tmp/draft-key');
  await selectInput(page, 'SSH 인증', 'ssh-agent');
  await page.evaluate(() => window.__cloudHarness.clearCalls());
  await clickButton(page, '연결 확인');
  await page.waitForSelector('.ag-cloud-setup-input[aria-invalid="true"]');
  assert.match(await page.$eval('.ag-cloud-setup-field-error', (node) => node.textContent), /Tailscale IP 또는 기기 이름/);
  assert.equal(await page.evaluate(() => window.__cloudHarness.calls.some((call) => call.method === 'cloudTestProfile')), false);
  console.log('  PASS invalid fields are rejected before desktop IPC');

  await fillInput(page, 'VPS 주소', 'cloud-vps.tailnet.ts.net');
  await page.evaluate(() => window.__cloudHarness.setTestFailures(1));
  await clickButton(page, '연결 확인');
  await waitForTitle(page, 'VPS 연결을 확인하세요');
  assert.match(await page.$eval('.ag-cloud-setup-callout strong', (node) => node.textContent), /원격 호스트에 연결할 수 없습니다/);
  await clickButton(page, '다시 확인');
  await waitForTitle(page, '연결할 수 있습니다');
  console.log('  PASS preflight failure gives a recoverable retry path');

  await page.evaluate(() => window.__cloudHarness.clearCalls());
  await clickButton(page, 'Cloud 환경 설치');
  await waitForTitle(page, 'Cloud 환경 설치 중');
  await waitForTitle(page, 'Cloud가 준비되었습니다');
  const connectedPrimary = await buttonByText(page, '완료');
  await connectedPrimary.focus();
  await connectedPrimary.dispose();
  await page.evaluate(() => window.__cloudHarness.publishSnapshot());
  await delay(50);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '완료');
  const installCalls = await page.evaluate(() => window.__cloudHarness.calls.map((call) => call.method));
  assert.equal(installCalls.includes('cloudSaveProfile'), false);
  assert.ok(installCalls.includes('cloudProvision'));
  assert.deepEqual(
    await page.evaluate(() => window.__cloudHarness.calls.find((call) => call.method === 'cloudProvision')?.payload),
    {
      installChannel: 'stable',
      profile: {
        name: 'My VPS',
        host: 'cloud-vps.tailnet.ts.net',
        sshUser: 'ubuntu',
        sshPort: 22,
        tailscaleHttpsPort: 443,
        auth: { kind: 'ssh-agent' },
        transport: { kind: 'tailscale' },
      },
    },
  );
  await clickButton(page, '완료');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  console.log('  PASS transactional provisioning receives the draft and the connected CTA exits setup');

  await page.evaluate(() => {
    window.__cloudHarness.setUnconfigured();
    window.__cloudHarness.clearCalls();
  });
  await openCloud(page);
  await clickButton(page, 'VPS 연결');
  await page.click('.ag-cloud-setup-advanced > summary');
  await selectInput(page, '연결 방식', 'ssh-tunnel');
  assert.equal(await page.$eval('[data-cloud-field="host"]', (node) => node.getAttribute('placeholder')), 'mac-mini.local 또는 192.168.1.20');
  await fillInput(page, 'VPS 주소', 'mac-mini.local');
  await fillInput(page, 'SSH 사용자', 'macadmin');
  await clickButton(page, '연결 확인');
  await waitForTitle(page, '연결할 수 있습니다');
  assert.deepEqual(
    await page.evaluate(() => window.__cloudHarness.calls.find((call) => call.method === 'cloudTestProfile')?.payload.profile.transport),
    { kind: 'ssh-tunnel' },
  );
  await clickButton(page, '취소');
  console.log('  PASS ordinary SSH accepts a Mac mini host without Tailscale or public HTTPS');

  await page.evaluate(() => {
    window.__cloudHarness.setUnconfigured();
    window.__cloudHarness.setTestDelays([240, 30]);
  });
  await openCloud(page);
  await clickButton(page, 'VPS 연결');
  await fillInput(page, 'VPS 주소', 'slow-vps.tailnet.ts.net');
  await clickButton(page, '연결 확인');
  await waitForTitle(page, 'VPS 연결 확인');
  await clickButton(page, '취소');
  await openCloud(page);
  await clickButton(page, 'VPS 연결');
  await fillInput(page, 'VPS 주소', 'fast-vps.tailnet.ts.net');
  await clickButton(page, '연결 확인');
  await waitForTitle(page, '연결할 수 있습니다');
  await delay(280);
  assert.match(await page.$eval('.ag-cloud-setup-callout p', (node) => node.textContent), /fast-vps/);
  assert.doesNotMatch(await page.$eval('.ag-cloud-setup-callout p', (node) => node.textContent), /slow-vps/);
  await clickButton(page, '취소');
  console.log('  PASS a late connection check cannot overwrite a reopened VPS draft');

  await page.evaluate(() => {
    window.__cloudHarness.setUnconfigured();
    window.__cloudHarness.clearCalls();
  });
  await openCloud(page);
  await clickButton(page, '이미 설치한 환경 연결');
  await waitForTitle(page, '설치된 환경 연결');
  await clickButton(page, '환경 연결');
  await page.waitForFunction(() => document.querySelectorAll('.ag-cloud-setup-field-error').length >= 3);
  const existingErrors = await page.$$eval('.ag-cloud-setup-field-error', (nodes) => nodes.map((node) => node.textContent));
  assert.ok(existingErrors.some((text) => text?.includes('서버에서 표시한 ID 키')));
  assert.ok(existingErrors.some((text) => text?.includes('XXXX-XXXX-XXXX')));
  assert.equal(await page.evaluate(() => window.__cloudHarness.calls.some((call) => call.method === 'cloudPair')), false);

  await fillInput(page, 'VPS 주소', 'existing-vps.tailnet.ts.net');
  await fillInput(page, '서버 ID 키', `ed25519:${'A'.repeat(59)}`);
  await fillInput(page, '페어링 코드', 'ABCD-EFGH-JKLM');
  await clickButton(page, '환경 연결');
  await waitForTitle(page, 'Cloud가 준비되었습니다');
  const pairCalls = await page.evaluate(() => window.__cloudHarness.calls.map((call) => call.method));
  const pairIndex = pairCalls.indexOf('cloudPair');
  assert.ok(pairIndex >= 0);
  assert.equal(pairCalls.includes('cloudSaveProfile'), false);
  assert.equal(pairCalls.includes('cloudTestProfile'), false);
  assert.deepEqual(
    await page.evaluate(() => window.__cloudHarness.calls.find((call) => call.method === 'cloudPair')?.payload),
    {
      code: 'ABCD-EFGH-JKLM',
      profile: {
        name: 'My VPS',
        host: 'existing-vps.tailnet.ts.net',
        sshUser: 'ubuntu',
        sshPort: 22,
        tailscaleHttpsPort: 443,
        auth: { kind: 'ssh-agent' },
        transport: { kind: 'tailscale' },
        serverPublicKey: `ed25519:${'A'.repeat(59)}`,
      },
    },
  );
  console.log('  PASS existing environments validate identity and activate transactionally');

  await clickButton(page, '완료');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  await page.evaluate(() => {
    window.__cloudHarness.setUnconfigured();
    window.__cloudHarness.setProviders([
      { providerId: 'railway', displayName: 'Railway', configured: false, missingConfig: ['RAILWAY_TOKEN', 'RAILWAY_PROJECT_ID'] },
    ]);
    window.__cloudHarness.clearCalls();
  });
  await openChoice(page);
  assert.equal(
    await page.$eval('.ag-cloud-setup-option[data-server-mode="app-hosted"] .ag-cloud-setup-option-note', (node) => node.textContent.trim()),
    '이 빌드에서는 아직 사용할 수 없습니다',
  );
  assert.equal(
    await page.$eval('.ag-cloud-setup-option[data-server-mode="self-hosted"]', (node) => node.getAttribute('aria-checked')),
    'true',
  );
  await chooseMode(page, 'app-hosted');
  await waitForTitle(page, 'Raucloud를 사용할 수 없습니다');
  assert.match(await page.$eval('.ag-cloud-setup-callout strong', (node) => node.textContent), /Railway 설정 필요/);
  assert.match(await page.$eval('.ag-cloud-setup-callout p', (node) => node.textContent), /RAILWAY_TOKEN, RAILWAY_PROJECT_ID/);
  assert.equal(await page.evaluate(() => window.__cloudHarness.calls.some((call) => call.method === 'cloudSpawnSandbox')), false);
  await clickButton(page, '내 서버 사용');
  await waitForTitle(page, '내 VPS에서 Cloud 시작하기');
  await clickButton(page, '뒤로');
  await waitForTitle(page, 'Cloud 서버 선택');
  await clickButton(page, '취소');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  console.log('  PASS an unconfigured app provider fails loudly and offers the private VPS path');

  await page.evaluate(() => {
    window.__cloudHarness.setProviders([
      { providerId: 'railway', displayName: 'Railway', configured: true, missingConfig: [] },
    ]);
    window.__cloudHarness.setSpawnFailures(1, 'Railway deployment reports crashed');
    window.__cloudHarness.clearCalls();
  });
  await openChoice(page);
  assert.equal(
    await page.$eval('.ag-cloud-setup-option[data-server-mode="app-hosted"]', (node) => node.getAttribute('aria-checked')),
    'true',
  );
  await clickButton(page, '계속');
  await waitForTitle(page, 'Raucloud 사용');
  assert.match(await page.$eval('.ag-cloud-setup-callout strong', (node) => node.textContent), /Railway/);
  await clickButton(page, '뒤로');
  await waitForTitle(page, 'Cloud 서버 선택');
  await clickButton(page, '계속');
  await waitForTitle(page, 'Raucloud 사용');
  await clickButton(page, '서버 만들기');
  await waitForTitle(page, 'Raucloud 준비 중');
  await waitForTitle(page, 'Raucloud를 준비하지 못했습니다');
  assert.match(await page.$eval('.ag-cloud-setup-callout strong', (node) => node.textContent), /샌드박스를 시작하지 못했습니다/);
  assert.match(await page.$eval('.ag-cloud-setup-technical pre', (node) => node.textContent), /reports crashed/);
  assert.deepEqual(
    await page.evaluate(() => window.__cloudHarness.calls.filter((call) => call.method === 'cloudSpawnSandbox').map((call) => call.payload)),
    [{ providerId: 'railway' }],
  );
  console.log('  PASS a failed sandbox spawn reports the provider detail and stays recoverable');

  assert.deepEqual(
    await page.$$eval('.ag-cloud-setup-footer button', (nodes) => nodes.map((node) => node.textContent.trim())),
    ['취소', '내 서버 사용', '다시 시도'],
  );
  await page.evaluate(() => window.__cloudHarness.setSpawnDelay(1_500));
  await clickButton(page, '다시 시도');
  await waitForTitle(page, 'Raucloud 준비 중');
  assert.match(await page.$eval('.ag-cloud-setup-description', (node) => node.textContent), /최대 30분이 걸릴 수 있습니다/);
  assert.match(await page.$eval('.ag-cloud-setup-wait', (node) => node.textContent), /^경과 (?:\d+분 )?\d+초$/);
  assert.deepEqual(await page.$eval('.ag-cloud-setup-live', (node) => ({
    text: node.textContent?.trim(),
    visible: getComputedStyle(node).display !== 'none',
  })), { text: 'Raucloud를 준비하고 있습니다.', visible: true });
  assert.deepEqual(
    await page.$$eval('.ag-cloud-setup-footer button', (nodes) => nodes.map((node) => ({
      label: node.textContent.trim(), disabled: node.disabled,
    }))),
    [{ label: '숨기기', disabled: false }, { label: '준비 중...', disabled: true }],
  );
  const callsBeforeReopen = await page.evaluate(() => ({
    refresh: window.__cloudHarness.calls.filter((call) => call.method === 'cloudGetState').length,
    spawn: window.__cloudHarness.calls.filter((call) => call.method === 'cloudSpawnSandbox').length,
  }));
  await clickButton(page, '숨기기');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  assert.deepEqual(await page.$eval('#agent-sidebar .ag-cloud-btn', (node) => ({
    label: node.querySelector('.ag-cloud-btn-label')?.textContent?.trim(),
    state: node.dataset.state,
  })), { label: '준비 중', state: 'setup' });
  await clickStable(page, '#agent-sidebar .ag-cloud-btn');
  await waitForTitle(page, 'Raucloud 준비 중');
  assert.deepEqual(await page.evaluate(() => ({
    refresh: window.__cloudHarness.calls.filter((call) => call.method === 'cloudGetState').length,
    spawn: window.__cloudHarness.calls.filter((call) => call.method === 'cloudSpawnSandbox').length,
  })), callsBeforeReopen, '진행 보기는 새로고침이나 두 번째 생성을 시작하지 않아야 합니다.');
  await waitForTitle(page, 'Raucloud가 준비되었습니다');
  await page.evaluate(() => window.__cloudHarness.setSpawnDelay(80));
  assert.match(await page.$eval('.ag-cloud-setup-callout p', (node) => node.textContent), /rauhwpx-1\.up\.railway\.app/);
  assert.deepEqual(await settingsCard(page), {
    status: '연결됨',
    detail: 'Raucloud, Raucloud 1, rauhwpx-1.up.railway.app',
    action: '관리',
  });
  await clickStable(page, '.ag-cloud-setup-close');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  await manageCloud(page);
  await waitForTitle(page, 'Raucloud가 준비되었습니다');
  console.log('  PASS retry provisions the sandbox and the stored choice skips the picker');

  await page.evaluate(() => {
    window.__cloudHarness.setTeardownError('Finish or cancel the cloud work on this sandbox before shutting it down.');
    window.__cloudHarness.clearCalls();
  });
  await clickButton(page, '서버 종료');
  await waitForTitle(page, 'Raucloud를 종료하지 못했습니다');
  assert.match(await page.$eval('.ag-cloud-setup-callout strong', (node) => node.textContent), /진행 중인 클라우드 작업이 있습니다/);
  assert.deepEqual(
    await page.evaluate(() => window.__cloudHarness.calls.filter((call) => call.method === 'cloudTeardownSandbox').map((call) => call.payload)),
    [{ force: false }],
  );
  assert.deepEqual(
    await page.$$eval('.ag-cloud-setup-footer button', (nodes) => nodes.map((node) => node.textContent.trim())),
    ['취소', '상태 확인', '다시 종료', '서버 다시 선택'],
  );
  await clickButton(page, '상태 확인');
  await waitForTitle(page, 'Raucloud가 준비되었습니다');
  assert.equal(await page.evaluate(() => window.__cloudHarness.calls.some((call) => call.method === 'cloudSandboxStatus')), true);
  console.log('  PASS a refused teardown keeps the sandbox and the status check restores the ready screen');

  await page.evaluate(() => window.__cloudHarness.clearCalls());
  await clickButton(page, '서버 종료');
  await waitForTitle(page, 'Raucloud 종료 중');
  await waitForTitle(page, 'Cloud 서버 선택');
  assert.deepEqual(await settingsCard(page), {
    status: '설정되지 않음',
    detail: '작업은 계속되고 문서 화면은 실시간으로 열립니다.',
    action: '설정',
  });
  await clickButton(page, '취소');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  await closeSettings(page);
  console.log('  PASS teardown releases the sandbox and returns the user to the server choice');

  await page.evaluate(() => {
    window.__cloudHarness.setSpawnFailures(1, 'App sandbox failed identity verification', { leavesSandbox: true });
    window.__cloudHarness.clearCalls();
  });
  await openChoice(page);
  await chooseMode(page, 'app-hosted');
  await waitForTitle(page, 'Raucloud 사용');
  await clickButton(page, '서버 만들기');
  await waitForTitle(page, 'Raucloud를 준비하지 못했습니다');
  assert.match(await page.$eval('.ag-cloud-setup-callout strong', (node) => node.textContent), /샌드박스 ID를 확인하지 못했습니다/);
  assert.deepEqual(
    await page.$$eval('.ag-cloud-setup-footer button', (nodes) => nodes.map((node) => node.textContent.trim())),
    ['취소', '내 서버 사용', '상태 확인', '서버 종료', '다시 시도'],
  );
  for (const viewport of [{ width: 375, height: 667 }, { width: 1280, height: 800 }]) {
    await assertResponsiveDialog(page, viewport);
  }
  await clickButton(page, '내 서버 사용');
  await waitForTitle(page, '내 VPS에서 Cloud 시작하기');
  await clickButton(page, 'VPS 연결');
  await fillInput(page, 'VPS 주소', 'second-vps.tailnet.ts.net');
  await clickButton(page, '연결 확인');
  await waitForTitle(page, '연결할 수 있습니다');
  await clickButton(page, 'Cloud 환경 설치');
  await waitForTitle(page, 'Cloud 설정을 마치지 못했습니다');
  assert.match(await page.$eval('.ag-cloud-setup-callout strong', (node) => node.textContent), /앱 샌드박스를 먼저 종료하세요/);
  console.log('  PASS a live app sandbox blocks a self-hosted install instead of leaking a paid server');

  await clickStable(page, '.ag-cloud-setup-close');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  await openSetup(page);
  await waitForTitle(page, 'Raucloud를 준비하지 못했습니다');
  await clickButton(page, '서버 종료');
  await waitForTitle(page, 'Raucloud 종료 중');
  await waitForTitle(page, 'Cloud 서버 선택');
  await clickButton(page, '취소');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  console.log('  PASS a stranded sandbox is removable from the failure screen');

  await page.evaluate(() => window.__cloudHarness.clearCalls());
  await openChoice(page);
  await chooseMode(page, 'app-hosted');
  await clickButton(page, '서버 만들기');
  await waitForTitle(page, 'Raucloud가 준비되었습니다');
  await page.evaluate(() => window.__cloudHarness.setSandboxUnmanaged('rauhwpx-4.up.railway.app'));
  await clickButton(page, '상태 확인');
  await waitForTitle(page, 'Raucloud를 준비하지 못했습니다');
  assert.match(
    await page.$eval('.ag-cloud-setup-callout strong', (node) => node.textContent),
    /이 앱이 관리할 수 없는 샌드박스입니다/,
  );
  assert.match(
    await page.$eval('.ag-cloud-setup-callout p', (node) => node.textContent),
    /공급자 콘솔에서 남은 서버를 직접 삭제하세요/,
  );
  await clickButton(page, '서버 종료');
  await waitForTitle(page, 'Cloud 서버 선택');
  // 원격 서버가 남았다는 사실을 숨기면 사용자는 계속 요금을 낸다. 눈에 보여야 한다.
  assert.match(
    await page.$eval('.ag-cloud-setup-callout strong', (node) => node.textContent),
    /남은 서버를 확인하세요/,
  );
  assert.match(
    await page.$eval('.ag-cloud-setup-callout p', (node) => node.textContent),
    /남은 서버는 공급자 콘솔에서 직접 삭제하세요/,
  );
  assert.match(
    await page.$eval('.ag-cloud-setup-live', (node) => node.textContent),
    /남은 서버는 공급자 콘솔에서 직접 삭제하세요/,
  );
  await clickButton(page, '취소');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  console.log('  PASS an unmanageable sandbox is released and the leftover server is disclosed');

  assert.equal(await page.evaluate(() => typeof window.rhwpDesktop.onCloudEvent), 'function');
  assert.deepEqual(pageErrors, [], '온보딩 도중 잡히지 않은 예외가 없어야 한다');
  console.log('  PASS the desktop event bridge remains attached throughout onboarding');
} finally {
  await browser?.close().catch(() => {});
  await stop(vite);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
