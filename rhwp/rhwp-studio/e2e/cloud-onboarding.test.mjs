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

async function clickButton(page, label) {
  const handle = await buttonByText(page, label);
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

async function openCloud(page) {
  await page.click('#agent-sidebar .ag-cloud-btn');
  await page.waitForSelector('.ag-cloud-setup-overlay:not([hidden])');
  await waitForTitle(page, '내 VPS에서 Cloud 시작하기');
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
  let revision = 0;
  let profile = null;
  let connection = 'unknown';
  let testFailures = 0;
  let testDelays = [];
  let listener = null;

  const wait = () => new Promise((resolve) => setTimeout(resolve, 80));
  const snapshot = () => ({
    revision: ++revision,
    available: true,
    profile: profile
      ? {
          kind: 'configured',
          profile: structuredClone(profile),
          connection,
          serviceVersion: connection === 'ready' ? '1.0.0-e2e' : null,
          message: null,
        }
      : { kind: 'unconfigured' },
    lease: { owner: 'local' },
    session: { kind: 'idle' },
    sessions: [],
    queuedMessages: [],
    timeline: null,
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
      connection = 'unknown';
      publish();
    },
  };

  window.rhwpDesktop = {
    platform: 'linux',
    async cloudGetState(payload) {
      record('cloudGetState', payload);
      return { snapshot: snapshot() };
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
      profile = structuredClone(payload.profile);
      connection = 'ready';
      return { snapshot: snapshot() };
    },
    async cloudPair(payload) {
      record('cloudPair', payload);
      await wait();
      profile = structuredClone(payload.profile);
      connection = 'ready';
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

  await openCloud(page);
  assert.match(await page.$eval('.ag-cloud-setup-description', (node) => node.textContent), /앱을 닫아도 에이전트는 계속 작업/);
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
  assert.match(await page.$eval('.ag-cloud-setup-callout strong', (node) => node.textContent), /VPS에 연결할 수 없습니다/);
  await clickButton(page, '다시 확인');
  await waitForTitle(page, '연결할 수 있습니다');
  console.log('  PASS preflight failure gives a recoverable retry path');

  await page.evaluate(() => window.__cloudHarness.clearCalls());
  await clickButton(page, 'Cloud 환경 설치');
  await waitForTitle(page, 'Cloud 환경 설치 중');
  await waitForTitle(page, 'Cloud가 준비되었습니다');
  const connectedPrimary = await buttonByText(page, 'Cloud로 계속');
  await connectedPrimary.focus();
  await connectedPrimary.dispose();
  await page.evaluate(() => window.__cloudHarness.publishSnapshot());
  await delay(50);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Cloud로 계속');
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
  await clickButton(page, 'Cloud로 계속');
  await page.waitForSelector('.ag-cloud-setup-overlay[hidden]');
  console.log('  PASS transactional provisioning receives the draft and the connected CTA exits setup');

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

  assert.equal(await page.evaluate(() => typeof window.rhwpDesktop.onCloudEvent), 'function');
  console.log('  PASS the desktop event bridge remains attached throughout onboarding');
} finally {
  await browser?.close().catch(() => {});
  await stop(vite);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
