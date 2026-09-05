import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { checkCloudRecovery } from './cloud-recovery.check.mjs';

const studio = resolve(import.meta.dirname, '..');
const artifacts = resolve(import.meta.dirname, 'artifacts');
const executablePath = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
await mkdir(artifacts, { recursive: true });
const sampleFile = resolve(artifacts, 'sample.txt');
await writeFile(sampleFile, '문서 디자인을 위한 샘플 참고자료입니다.');
// Own server + fresh browser profile: checks do not need or alter a running app/preview.
const server = await createServer({
  configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false, hmr: false },
  logLevel: 'error',
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  const errors = [];
  const forbidden = [];
  await page.exposeFunction('reportSidebarRuntimeError', (message) =>
    errors.push(message),
  );
  await page.evaluateOnNewDocument(() => {
    // Exercise the same missing API as an HTTP LAN/Tailscale origin.
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, writable: true, configurable: true });
    window.addEventListener('error', (event) =>
      window.reportSidebarRuntimeError(event.message),
    );
    window.addEventListener('unhandledrejection', (event) =>
      window.reportSidebarRuntimeError(String(event.reason)),
    );
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    const forbiddenPath =
      /\.(wasm)(\?|$)|\/src\/(main\.ts|agent\/(bridge|tool-executor)\.ts|core\/wasm-bridge\.ts)|\/api\//;
    if (
      (url.protocol.startsWith('http') && url.origin !== origin) ||
      forbiddenPath.test(url.pathname)
    ) {
      forbidden.push(request.url());
      void request.abort();
    } else void request.continue();
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => {
    if (!url.startsWith(origin.replace('http:', 'ws:'))) forbidden.push(url);
  });
  async function open(query = '') {
    const params = new URLSearchParams(query);
    if (!params.has('width')) params.set('width', '480');
    await page.goto(`${origin}/?theme=light&${params}`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForFunction(() => window.sidebarPreview);
    if (!query.includes('services=setup'))
      await page.waitForFunction(
        () => !document.querySelector('.ag-input').disabled,
      );
  }
  async function screenshot(name) {
    const sidebar = await page.$('.ag-root');
    await sidebar.screenshot({ path: resolve(artifacts, `${name}.png`) });
  }
  async function clickText(selector, text) {
    const clicked = await page.evaluate(
      (selector, text) => {
        const element = [...document.querySelectorAll(selector)].find(
          (element) =>
            element.textContent.trim() === text && element.checkVisibility(),
        );
        if (!element) return false;
        element.click();
        return true;
      },
      selector,
      text,
    );
    assert(clicked, `Visible ${selector} with text ${text}`);
  }
  async function play(scenario) {
    await open(`scenario=${scenario}`);
    await page.click('#play');
    await page.waitForFunction(() =>
      window.sidebarPreview.bridge.isTurnRunning(),
    );
    if (scenario === 'question')
      await page.waitForSelector('.ag-question-option', { visible: true });
    else
      await page.waitForFunction(
        () =>
          !window.sidebarPreview.bridge.isTurnRunning() &&
          document.querySelector('.ag-msg-user'),
      );
  }
  async function step(name, run) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      await page.screenshot({ path: resolve(artifacts, 'failure.png') });
      throw new Error(`${name}: ${error.message}`, { cause: error });
    }
  }
  await step('Cloud disconnect, reconnect, rebuild, and shutdown recovery',
    () => checkCloudRecovery(page, origin, artifacts));
  await step('Cloud dashboard, usage gaps, conversations, configuration and responsive settings', async () => {
    await open('cloud=1&dashboard=1&page=settings&destination=cloud&controls=0');
    await page.waitForSelector('.ag-cd-quota .ag-cd-stat-value');
    assert.equal(await page.$eval('.ag-cd-quota .ag-cd-stat-value', (node) => node.textContent), '84분');
    assert.deepEqual(await page.$$eval('.ag-cd-stat-label', (nodes) => nodes.map((node) => node.textContent)), ['오늘 남은 Raucloud 시간', '연결된 Cloud 박스']);
    assert.doesNotMatch(await page.$eval('.ag-cd-stats', (node) => node.textContent), /세션 실행 중|앱당 서버/);
    assert.match(await page.$eval('.ag-cd-quota .ag-cd-reset', (node) => node.textContent), /(?:\d+시간(?: \d+분)?|\d+분) 후 초기화|1분 이내 초기화/);
    assert.equal(await page.$eval('.ag-cd-pixel-cloud', (node) => node.complete && node.naturalWidth > 0), true);
    assert.equal(await page.$$eval('.ag-cd-point', (nodes) => nodes.length), 7);
    await page.click('[data-destination="connections"][role="tab"]');
    assert.equal(await page.$eval('.ag-cloud-dashboard', (node) => node.checkVisibility()), false);
    await page.click('[data-destination="cloud"][role="tab"]');
    await clickText('.ag-cd-button', '30일');
    assert.match(await page.$eval('.ag-cd-usage-total', (node) => node.textContent), /30일 중 7일 기록/);
    assert.equal(await page.$$eval('.ag-cd-point', (nodes) => nodes.length), 7, 'missing days must not become zero points');
    await page.click('.ag-cd-data summary');
    assert.equal(await page.$$eval('.ag-cd-data tbody tr', (nodes) => nodes.length), 30);
    await page.click('.ag-cd-data summary');
    await page.click('.ag-cd-segment button');
    assert.equal(await page.$$eval('.ag-cd-chat', (nodes) => nodes.length), 4);
    await page.evaluate(() => window.sidebarPreview.cloud.publish());
    assert.equal(await page.$eval('.ag-cd-segment button[aria-pressed="true"]', (node) => node === document.activeElement), true, 'snapshot refresh preserves range focus');
    await page.click('.ag-cloud-settings-action');
    await page.waitForSelector('.ag-cloud-setup-overlay:not([hidden])');
    await page.click('.ag-cloud-setup-close');
    await page.$eval('#ag-settings-pane-cloud', (node) => node.scrollTo({ top: 0 }));
    await screenshot('cloud-dashboard-sidebar');
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.click('.ag-cd-expand');
    await page.waitForSelector('.ag-fullscreen.ag-settings-open #ag-settings-pane-cloud:not([hidden])');
    assert.equal(await page.$eval('.ag-cd-grid', (node) => getComputedStyle(node).gridTemplateColumns.split(' ').length), 2);
    await screenshot('cloud-dashboard-fullscreen');
    await page.evaluate(() => window.sidebarPreview.cloud.blockRefresh(true));
    const refreshCount = await page.evaluate(() => window.sidebarPreview.cloud.calls.refresh);
    await clickText('.ag-cd-button', '새로고침');
    assert.equal(await page.$eval('.ag-cd-refresh', (node) => node.disabled), true);
    await page.evaluate(() => document.querySelector('.ag-cd-refresh').click());
    assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.refresh), refreshCount + 1);
    const countdowns = await page.evaluate(() => {
      const originalNow = Date.now;
      const resetAt = Date.parse(window.sidebarPreview.cloud.controller.getSnapshot().account.quota.resetAt);
      try {
        return [5_400_000, 3_600_000, 60_000, 0, -60_000].map((remainingMs) => {
          Date.now = () => resetAt - remainingMs;
          // Returning to the tab must update the clock even while a refresh is blocked.
          document.dispatchEvent(new Event('visibilitychange'));
          return {
            eta: document.querySelector('.ag-cd-reset').textContent,
            quota: document.querySelector('.ag-cd-quota .ag-cd-stat-value').textContent,
            meterHidden: document.querySelector('.ag-cd-meter').hidden,
          };
        });
      } finally {
        Date.now = originalNow;
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
    assert.deepEqual(countdowns, [
      { eta: '1시간 30분 후 초기화', quota: '84분', meterHidden: false },
      { eta: '1시간 후 초기화', quota: '84분', meterHidden: false },
      { eta: '1분 이내 초기화', quota: '84분', meterHidden: false },
      { eta: '초기화 확인 중', quota: '—분', meterHidden: true },
      { eta: '초기화 확인 중', quota: '—분', meterHidden: true },
    ]);
    assert.equal(await page.evaluate(() => window.sidebarPreview.cloud.calls.refresh), refreshCount + 1, 'countdown does not depend on a new server response');
    await page.evaluate(() => window.sidebarPreview.cloud.blockRefresh(false));
    await page.waitForFunction(() => !document.querySelector('.ag-cd-refresh').disabled);
    await page.evaluate(() => window.sidebarPreview.cloud.setRefreshFailure(true));
    await clickText('.ag-cd-button', '새로고침');
    await page.waitForSelector('.ag-cd-feedback[data-kind="error"]');
    assert.match(await page.$eval('.ag-cd-quota .ag-cd-stat-value', (node) => node.textContent), /—/);
    await page.evaluate(() => window.sidebarPreview.cloud.setRefreshFailure(false));
    await clickText('.ag-cd-button', '새로고침');
    await page.waitForSelector('.ag-cd-feedback[data-kind="success"]');
    await page.evaluate(() => window.sidebarPreview.cloud.setLink('failed'));
    await page.waitForSelector('.ag-cd-status[data-state="failed"]');
    assert.match(await page.$eval('.ag-cloud-settings-status', (node) => node.textContent), /문제/);
    await page.select('#theme', 'dark');
    await page.$eval('#ag-settings-pane-cloud', (node) => node.scrollTo({ top: 270 }));
    await screenshot('cloud-dashboard-disconnected');
    await page.click('.ag-cd-reconnect');
    await page.waitForSelector('.ag-cd-status[data-state="ready"]');
    await page.evaluate(() => window.sidebarPreview.cloud.setDashboardState('exhausted'));
    assert.equal(await page.$eval('.ag-cd-quota .ag-cd-stat-value', (node) => node.textContent), '0분');
    assert.equal(await page.$eval('.ag-cd-quota', (node) => node.dataset.low), 'true');
    await page.evaluate(() => window.sidebarPreview.cloud.setDashboardState('self-hosted'));
    assert.match(await page.$eval('.ag-cd-server', (node) => node.textContent), /SSH 터널/);
    assert.match(await page.$eval('.ag-cd-config', (node) => node.textContent), /내 서버는 Raucloud 한도 제외/);
    assert.doesNotMatch(await page.$eval('.ag-cd-server', (node) => node.textContent), /시간을 모두 사용/);
    await page.evaluate(() => window.sidebarPreview.cloud.setDashboardState('unknown'));
    assert.equal(await page.$eval('.ag-cd-status', (node) => node.dataset.state), 'unknown');
    await page.evaluate(() => window.sidebarPreview.cloud.setDashboardState('logged-out'));
    assert.equal(await page.$$eval('.ag-cd-point', (nodes) => nodes.length), 0, 'sign-out hides the previous account history');
    assert.match(await page.$eval('.ag-cd-quota', (node) => node.textContent), /로그인하면/);
    assert.equal(await page.$eval('.ag-cd-reset', (node) => node.checkVisibility()), false, 'unknown reset time has no countdown');
    await page.click('.ag-cd-setup');
    await page.waitForSelector('.ag-cloud-setup-overlay:not([hidden])');
    await page.click('.ag-cloud-setup-close');
    await page.evaluate(() => window.sidebarPreview.cloud.setDashboardState('unavailable'));
    assert.equal(await page.$eval('.ag-cd-refresh', (node) => node.disabled), true);
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await open('cloud=1&dashboard=1&page=settings&destination=cloud&width=280&theme=dark&controls=0');
    const overflow = await page.$eval('#ag-settings-pane-cloud', (node) => node.scrollWidth > node.clientWidth);
    assert.equal(overflow, false, 'minimum-width dashboard must not scroll horizontally');
    const clipped = await page.$$eval('.ag-cd-button, .ag-settings-nav-button', (nodes) => nodes.filter((node) => node.checkVisibility() && node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent));
    assert.deepEqual(clipped, []);
    await page.click('[data-destination="cloud"][role="tab"]');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.$eval('[data-destination="connections"][role="tab"]', (node) => node.getAttribute('aria-selected')), 'true');
  });
  await step(
    'Production shell, light/dark themes, resize and collapse',
    async () => {
      await open();
      assert.equal(
        await page.$eval('.ag-root', (element) =>
          Math.round(element.getBoundingClientRect().width),
        ),
        480,
      );
      assert.equal(
        await page.$eval('.ag-root', (element) =>
          Math.round(element.getBoundingClientRect().top),
        ),
        0,
      );
      assert.equal(await page.$('canvas'), null);
      await screenshot('empty-light');
      await page.select('#theme', 'dark');
      await screenshot('empty-dark');
      await page.click('.ag-collapse-tab');
      await page.waitForFunction(
        () => !document.body.classList.contains('ag-sidebar-open'),
      );
      await page.click('.ag-collapse-tab');
      await page.waitForFunction(() =>
        document.body.classList.contains('ag-sidebar-open'),
      );
      await page.click('.ag-fullscreen-btn');
      assert.equal(
        await page.$eval('.ag-root', (element) =>
          element.classList.contains('ag-fullscreen'),
        ),
        false,
      );
      await open('width=360');
      assert.equal(
        await page.$eval('.ag-root', (element) =>
          Math.round(element.getBoundingClientRect().width),
        ),
        360,
      );
      await screenshot('empty-narrow');
      await open('width=480');
    },
  );
  await step(
    'Streaming conversation, stop, and persisted thread library',
    async () => {
      await play('chat');
      await page.waitForFunction(() =>
        document
          .querySelector('.ag-root')
          .innerText.includes('필요한 부분을 선택'),
      );
      await screenshot('chat');
      await page.click('.ag-header .ag-threads-btn');
      await page.waitForSelector('.ag-root.ag-threads-open');
      assert(
        await page.$eval('.ag-threads-page', (element) =>
          element.innerText.includes('이 문서의 핵심'),
        ),
      );
      await screenshot('threads');
      await open();
      await page.click('#play');
      await page.waitForFunction(() =>
        window.sidebarPreview.bridge.isTurnRunning(),
      );
      await page.click('.ag-send');
      await page.waitForFunction(
        () => !window.sidebarPreview.bridge.isTurnRunning(),
      );
    },
  );
  await step('Provider, model and effort changes after the first reply', async () => {
    await play('chat');
    const messageCount = await page.$$eval('.ag-msg-user', (nodes) => nodes.length);
    await page.click('[aria-label="프로바이더 선택"]');
    await page.waitForSelector('.ag-config-panel.ag-open');
    await page.click('.ag-provider-item[data-agent="codex"]');
    await page.click('.ag-llm-item[data-model="gpt-5.6-luna"]');
    await page.click('.ag-llm-item[data-model="gpt-6-astra"]');
    await page.focus('.ag-eslider');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('.ag-effort-name').textContent === 'Max');
    assert.equal(await page.$eval('.ag-llm-name', (node) => node.textContent), 'Astra');
    assert.equal(await page.$$eval('.ag-msg-user', (nodes) => nodes.length), messageCount);
    await screenshot('provider-settings-after-reply');
    await page.click('.ag-provider-item[data-agent="cursor"]');
    assert.equal(await page.$eval('.ag-effort', (node) => node.hidden), true);
    await page.click('.ag-provider-item[data-agent="claude"]');
    await page.click('.ag-llm-item[data-model="haiku"]');
    assert.equal(await page.$eval('.ag-eslider', (node) => node.getAttribute('aria-valuemax')), '2');
    await page.click('.ag-input');
    await page.type('.ag-input', 'Continue the same conversation after changing the model.');
    await page.click('.ag-send');
    await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
    assert.equal(await page.$eval('[aria-label="프로바이더 선택"]', (node) => node.disabled), true);
    await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
    assert.equal(await page.$eval('[aria-label="프로바이더 선택"]', (node) => node.disabled), false);
    assert.equal(await page.$$eval('.ag-msg-user', (nodes) => nodes.length), messageCount + 1);
  });
  await step(
    'Plan approval and document change acceptance/rejection',
    async () => {
      await play('plan');
      await page.waitForSelector('.ag-plan-approve', { visible: true });
      await screenshot('plan');
      await page.click('.ag-plan-approve');
      await page.waitForFunction(
        () => window.sidebarPreview.snapshot().pendingChanges === 1,
      );
      await page.click('.ag-review-card .ag-approve');
      await page.waitForFunction(
        () => window.sidebarPreview.snapshot().pendingChanges === 0,
      );
      await play('review');
      await page.waitForSelector('.ag-review-card .ag-reject', {
        visible: true,
      });
      await screenshot('review');
      await page.click('.ag-review-card .ag-reject');
      await page.waitForFunction(
        () => window.sidebarPreview.snapshot().pendingChanges === 0,
      );
    },
  );
  await step('Question submission and resolution', async () => {
    await play('question');
    await screenshot('question');
    await page.click('.ag-question-option');
    await page.click('.ag-question-next');
    await page.waitForFunction(
      () => !window.sidebarPreview.bridge.getPendingUserQuestion(),
    );
    await page.waitForFunction(() =>
      document.querySelector('.ag-root').innerText.includes('선택한 문체'),
    );
  });
  await step('Subagent fleet, failure, and offline recovery', async () => {
    await play('fleet');
    await page.waitForFunction(() =>
      document.querySelector('.ag-root').innerText.includes('용어를 통일'),
    );
    await screenshot('fleet');
    await play('error');
    await page.waitForFunction(() =>
      document.querySelector('.ag-root').innerText.includes('샘플 연결 오류'),
    );
    assert(
      !(await page.$eval('.ag-root', (element) =>
        element.innerText.includes('작업을 마쳤습니다.'),
      )),
    );
    await page.select('#connection', 'disconnected');
    await screenshot('disconnected');
    await page.evaluate(() => window.sidebarPreview.bridge.reconnectNow());
    await page.waitForFunction(
      () => document.querySelector('#connection').value === 'connected',
    );
  });
  await step('All provider/model catalogs and skill library', async () => {
    await open();
    await page.click('[aria-label="프로바이더 선택"]');
    for (const agent of [
      'rau',
      'claude',
      'codex',
      'pi',
      'grok',
      'cursor',
      'opencode',
    ]) {
      await page.click(`.ag-provider-item[data-agent="${agent}"]`);
      await page.waitForFunction(
        (agent) => window.sidebarPreview.bridge.getActiveAgent() === agent,
        {},
        agent,
      );
      assert(
        await page.$eval(
          '.ag-llm-trigger',
          (element) => element.textContent.trim().length > 0,
        ),
      );
    }
    await page.keyboard.press('Escape');
    await page.click('.ag-skills-btn');
    await page.waitForSelector('.ag-root.ag-skills-open');
    await page.type('.ag-skills-search', 'proofread');
    await page.waitForFunction(
      () => document.querySelectorAll('.ag-skill-copy').length === 1,
    );
    await screenshot('skills');
    await page.click('.ag-skill-toggle');
    await page.waitForFunction(
      () =>
        document.querySelector('.ag-skill-toggle').textContent !== '사용 중',
    );
    await page.click('.ag-skill-copy');
    await page.waitForFunction(
      () =>
        document.querySelector('.ag-skill-name').value === 'proofread-korean',
    );
  });
  await step('Reference upload, search, and deletion', async () => {
    await open();
    await page.click('.ag-references-btn');
    await clickText('.ag-reference-tab', '모든 채팅');
    await page.waitForSelector('.ag-reference-file', { visible: true });
    await screenshot('references');
    const [chooser] = await Promise.all([
      page.waitForFileChooser(),
      page.click('.ag-reference-add'),
    ]);
    await chooser.accept([sampleFile]);
    await page.waitForSelector('[aria-label="sample.txt 참고자료 제거"]', {
      visible: true,
    });
    await page.click('[aria-label="sample.txt 참고자료 제거"]');
    await page.waitForSelector('[aria-label="sample.txt 참고자료 제거"]', {
      hidden: true,
    });
    await page.type('.ag-reference-search', '브랜드');
    await page.waitForSelector('.ag-reference-search-hit', { visible: true });
    await page.evaluate(async () => {
      const bridge = window.sidebarPreview.bridge;
      const file = await bridge.uploadReference(
        'global',
        'global',
        new File(['sample'], 'sample.txt', { type: 'text/plain' }),
      );
      if (
        !(await bridge.listReferences('global', 'global')).some(
          (item) => item.id === file.id,
        )
      )
        throw new Error('Upload missing');
      await bridge.deleteReference(file);
      if (
        (await bridge.listReferences('global', 'global')).some(
          (item) => item.id === file.id,
        )
      )
        throw new Error('Delete failed');
    });
  });
  await step(
    'Settings, fake account login/logout, templates, and writing style',
    async () => {
      await open('page=settings');
      await screenshot('settings');
      await clickText('.ag-settings-nav-button', 'AI 연결');
      await page.waitForFunction(() =>
        document
          .querySelector('.ag-account-session-row')
          .innerText.includes('로그인되지 않음'),
      );
      await page.click('.ag-account-session-row button');
      await page.waitForFunction(
        () => window.sidebarPreview.snapshot().account === 'signed-in',
      );
      await page.waitForFunction(() =>
        document
          .querySelector('.ag-account-session-row')
          .innerText.includes('designer@example.test'),
      );
      await screenshot('connections');
      await page.click('.ag-account-session-row button');
      await page.waitForFunction(
        () => window.sidebarPreview.snapshot().account === 'signed-out',
      );
      await clickText('.ag-settings-nav-button', 'AI 설정');
      await page.waitForSelector('.ag-template-row', { visible: true });
      await screenshot('ai-settings');
      await page.evaluate(async () => {
        const bridge = window.sidebarPreview.bridge;
        const template = await bridge.addTemplate(
          new File(['sample'], 'sample.hwpx'),
          '샘플 양식',
        );
        await bridge.renameTemplate(template.id, '수정 양식');
        if (
          !(await bridge.listTemplates()).templates.some(
            (item) => item.name === '수정 양식',
          )
        )
          throw new Error('Rename missing');
        await bridge.deleteTemplate(template.id);
        const status = await bridge.requestAgentInstructions();
        await bridge.saveAgentInstructions(
          '수정된 지시입니다.',
          status.revision,
        );
        if (
          (await bridge.requestAgentInstructions()).content !==
          '수정된 지시입니다.'
        )
          throw new Error('Instructions not saved');
        await new Promise((resolve) => {
          const unsubscribe = bridge.onEvent((event) => {
            if (event.type === 'writing-style-result') {
              unsubscribe();
              resolve();
            }
          });
          bridge.calibrateWritingStyle({
            language: 'ko',
            files: [
              {
                name: 'sample.txt',
                type: 'text/plain',
                size: 6,
                content: 'sample',
              },
            ],
            agent: 'codex',
            model: 'sample',
            append: false,
          });
        });
      });
    },
  );
  await step(
    'Unconfigured provider installation and local OAuth placeholder',
    async () => {
      await open('services=setup&page=settings');
      await clickText('.ag-settings-nav-button', 'AI 연결');
      await page.click('.ag-settings-provider-row[data-agent="codex"] button');
      await page.waitForSelector(
        '.ag-agent-setup-overlay[aria-hidden="false"]',
      );
      await clickText('.ag-agent-setup-primary', '설치하고 계속');
      await page.waitForFunction(
        async () =>
          (await window.sidebarPreview.bridge.requestAgentSetupStatus()).codex
            .installed,
      );
      await clickText('.ag-settings-btn', '로그인 방식 변경');
      await page.waitForSelector('.ag-agent-auth-card', { visible: true });
      await (
        await page.$('.ag-agent-setup-dialog')
      ).screenshot({ path: resolve(artifacts, 'provider-setup.png') });
      await page.click('.ag-agent-auth-card');
      await page.waitForFunction(
        async () =>
          (await window.sidebarPreview.bridge.requestAgentSetupStatus()).codex
            .connected,
      );
      await page.click('.ag-agent-setup-close');
    },
  );
  await step(
    'Version graph and mutable branches, checkpoints, shelves, tags',
    async () => {
      await open('page=versions');
      await page.waitForSelector('.ag-root.ag-versions-open');
      await screenshot('versions');
      await page.click('[aria-label="새 커밋 만들기"]');
      await page.waitForSelector('.ag-version-prompt-input', { visible: true });
      await page.type(
        '.ag-version-prompt-input',
        '디자인 검토 내용을 저장했습니다.',
      );
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => window.sidebarPreview.versions.getState().commits.length === 4,
      );
      await clickText('.ag-versions-tab', '브랜치');
      await screenshot('branches');
      await page.evaluate(async () => {
        const controller = window.sidebarPreview.versions;
        await controller.createBranch('테스트');
        await controller.switchBranch('테스트');
        await controller.renameBranch('테스트', '디자인');
        await controller.createTag('v1', controller.getState().commits[0].id);
        await controller.createShelf('디자인 초안');
        const shelf = controller.getState().shelves[0];
        await controller.applyShelf(shelf.id, true);
        if (controller.getState().shelves.some((item) => item.id === shelf.id))
          throw new Error('Shelf not removed');
        if (controller.getState().activeBranch !== '디자인')
          throw new Error('Branch not selected');
        await controller.switchBranch('main');
        await controller.deleteBranch('디자인');
      });
    },
  );
  await step('Branch commits keep their graph lane and move the branch label', async () => {
    await open('page=versions&history=branches&theme=dark&width=480');
    await screenshot('versions-dark');
    assert.equal(await page.$$eval('.ag-version-meta, .ag-version-time', (items) => items.length), 0);
    const initialRowHeight = await page.$eval('.ag-version-row', (row) => row.getBoundingClientRect().height);
    await page.hover('.ag-version-row');
    await page.waitForSelector('.ag-version-date-tooltip.ag-visible', { visible: true });
    assert.match(await page.$eval('.ag-version-date-tooltip', (tip) => tip.textContent), /월/);
    assert.equal(await page.$eval('.ag-version-row', (row) => row.getBoundingClientRect().height), initialRowHeight);
    await screenshot('versions-date-hover');
    await page.focus('.ag-version-row');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ag-version-date-tooltip').classList.contains('ag-visible'));
    assert(await page.$eval('.ag-root', (root) => root.classList.contains('ag-versions-open')));
    await page.click('[aria-label="이 커밋에서 브랜치 만들기"]');
    await page.waitForSelector('.ag-version-prompt-input', { visible: true });
    await page.type('.ag-version-prompt-input', '새-디자인');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.sidebarPreview.versions.getState().activeBranch === '새-디자인');
    await page.click('[aria-label="새 커밋 만들기"]');
    await page.waitForSelector('.ag-version-prompt-input', { visible: true });
    await page.type('.ag-version-prompt-input', '새 브랜치에서 만든 커밋');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.sidebarPreview.versions.getState().commits[0].title === '새 브랜치에서 만든 커밋');
    const result = await page.evaluate(() => {
      const state = window.sidebarPreview.versions.getState();
      const head = state.commits[0];
      const branch = state.branches.find((item) => item.name === '새-디자인');
      const main = state.commits.find((item) => item.id === state.branches.find((branch) => branch.isDefault).headId);
      const row = document.querySelector(`[data-commit-id="${head.id}"]`);
      return { branchAtHead: branch.headId === head.id, parent: head.parentIds[0],
        separateLane: head.lane !== main.lane, label: row.innerText.includes('새-디자인'),
        current: head.isHead, selected: row.getAttribute('aria-selected') };
    });
    assert.deepEqual(result, { branchAtHead: true, parent: 'e8f21a0', separateLane: true, label: true, current: true, selected: 'true' });
    await screenshot('versions-branch-commit');
    await open('page=versions&history=branches&width=360');
    await screenshot('versions-light-narrow');
    assert(await page.$eval('.ag-versions-page', (el) => el.scrollWidth <= el.clientWidth), 'Narrow panel overflows');
    await open('width=480');
  });
  await step(
    'Document context, reset, clean canvas, and backend isolation',
    async () => {
      await open();
      await page.select('#document', 'notes');
      await page.waitForFunction(() =>
        document.querySelector('.ag-root').innerText.includes('회의록.hwpx'),
      );
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click('#reset'),
      ]);
      await page.waitForFunction(() => window.sidebarPreview);
      assert.equal(
        await page.evaluate(() => window.sidebarPreview.snapshot().account),
        'signed-out',
      );
      await open('controls=0');
      assert(
        await page.$eval('#preview-controls', (element) => element.hidden),
      );
      assert.equal(
        await page.evaluate(
          async () => (await navigator.serviceWorker.getRegistrations()).length,
        ),
        0,
      );
      assert.deepEqual(
        forbidden,
        [],
        'No remote services, document engine, or application entry point',
      );
      assert.deepEqual(errors, [], 'No browser errors');
    },
  );
  console.log(`Sidebar checks passed. Screenshots: ${artifacts}`);
} finally {
  const browserProcess = browser?.process();
  await browser?.close();
  // Detached Chrome helpers can retain inherited output pipes after its exit.
  browserProcess?.stdout?.destroy();
  browserProcess?.stderr?.destroy();
  await server.close();
}
