import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

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
    await page.goto(`${origin}/?theme=light&${query}`, {
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
      await clickText('.ag-settings-nav-button', 'AI 연결');
      await page.waitForSelector('.ag-settings-quota-fill[data-health="low"]', { visible: true });
      assert.match(await page.$eval('.ag-settings-balance-card[data-provider="openrouter"] .ag-settings-balance-amount', (el) => el.textContent), /\$18\.50/);
      assert.equal(await page.$eval('.ag-settings-balance-card[data-provider="openrouter"] [role="meter"]', (el) => el.getAttribute('aria-valuenow')), '92.5');
      assert.equal(await page.$$eval('.ag-settings-balance-card[data-provider="grok"] [role="meter"]', (els) => els.length), 0);
      assert.equal(await page.$$eval('.ag-settings-balance-card[data-provider="opencode"] .ag-settings-balance-amount', (els) => els.length), 0);
      assert.match(await page.$eval('.ag-settings-balance-card[data-provider="opencode"]', (el) => el.textContent), /잔액 정보를 사용할 수 없어요/);
      assert.equal(await page.$eval('.ag-settings-quota-card[data-provider="codex"] [role="meter"]', (el) => el.getAttribute('aria-valuenow')), '8');
      assert.equal(await page.$eval('.ag-settings-usage-disclosure', el => el.open), false);
      await page.click('.ag-settings-usage-disclosure > summary');
      await page.click('.ag-settings-usage-block[data-agent="codex"] .ag-settings-usage-toggle');
      assert.equal(await page.$eval('.ag-settings-usage-block[data-agent="codex"] .ag-settings-usage-expanded', el => el.hidden), false);
      await screenshot('local-usage-table');
      await page.click('.ag-settings-usage-block[data-agent="codex"] .ag-settings-usage-toggle');
      assert.equal(await page.$eval('.ag-settings-usage-block[data-agent="codex"] .ag-settings-usage-expanded', el => el.hidden), true);
      await page.click('.ag-settings-usage-disclosure > summary');
      await page.click('[data-action="request-reset"]');
      await page.waitForSelector('[data-action="confirm-reset"]', { visible: true });
      assert.match(await page.$eval('.ag-provider-quotas', (el) => el.textContent), /보관한 리셋 2개/);
      await page.click('[data-action="confirm-reset"]');
      assert.equal(await page.$eval('[data-action="confirm-reset"]', (el) => el.disabled), true);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rhwp-codex-pending-reset')).account), 'preview-codex');
      await page.waitForFunction(() => document.querySelector('.ag-provider-quotas').textContent.includes('한도를 리셋했어요.'));
      assert.match(await page.$eval('.ag-provider-quotas', (el) => el.textContent), /보관한 리셋 1개/);
      assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-codex-pending-reset')), null);
      assert.equal(await page.$eval('.ag-settings-quota-card[data-provider="codex"] [role="meter"]', (el) => el.getAttribute('aria-valuenow')), '100');
      await screenshot('usage');
      await page.click('[data-action="refresh-usage"]');
      assert.equal(await page.$eval('[data-action="refresh-usage"]', (el) => el.disabled), true);
      await page.waitForFunction(() => !document.querySelector('[data-action="refresh-usage"]').disabled);
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
  await step('Provider quota failure and exhausted reset credit', async () => {
    await open('page=settings&quota=pro');
    await clickText('.ag-settings-nav-button', 'AI 연결');
    await page.waitForSelector('.ag-settings-quota-card[data-provider="codex"]');
    assert.equal(await page.$$eval('.ag-settings-quota-card[data-provider="codex"] [role="meter"]', (meters) => meters.length), 1);
    assert.doesNotMatch(await page.$eval('.ag-settings-quota-card[data-provider="codex"]', (el) => el.textContent), /5시간/);
    assert.match(await page.$eval('.ag-settings-quota-card[data-provider="claude"]', (el) => el.textContent), /5시간/);
    await open('page=settings&quota=error');
    await clickText('.ag-settings-nav-button', 'AI 연결');
    await page.waitForSelector('.ag-settings-quota-card[data-state="error"]');
    assert.match(await page.$eval('.ag-provider-quotas', (el) => el.textContent), /제공자가 응답하지 않아요/);
    assert.equal(await page.$eval('.ag-settings-quota-card[data-provider="codex"] [role="meter"]', (el) => el.hasAttribute('aria-valuenow')), false);
    assert.equal(await page.$('[data-action="request-reset"]'), null);
    await open('page=settings&quota=refresh-error');
    await clickText('.ag-settings-nav-button', 'AI 연결');
    await page.waitForFunction(() => !document.querySelector('[data-action="refresh-usage"]').disabled);
    await page.click('[data-action="refresh-usage"]');
    await page.waitForFunction(() => document.querySelector('.ag-settings-body').textContent.includes('연결이 일시적으로 끊겼어요.'));
    await page.click('[data-action="refresh-usage"]');
    await page.waitForFunction(() => !document.querySelector('[data-action="refresh-usage"]').disabled);
    assert.equal(await page.$eval('.ag-settings-body', (el) => el.textContent.includes('연결이 일시적으로 끊겼어요.')), false);
    await open('page=settings&quota=empty');
    await clickText('.ag-settings-nav-button', 'AI 연결');
    await page.waitForSelector('[data-action="request-reset"]');
    assert.equal(await page.$eval('[data-action="request-reset"]', (el) => el.disabled), true);
    await page.evaluate(() => localStorage.setItem('rhwp-codex-pending-reset', JSON.stringify({
      key: 'reset-interrupted-request-123456', account: 'preview-codex',
    })));
    await open('page=settings&quota=empty');
    await clickText('.ag-settings-nav-button', 'AI 연결');
    await page.waitForSelector('[data-action="confirm-reset"]');
    assert.equal(await page.$eval('[data-action="confirm-reset"]', (el) => el.disabled), false,
      'An interrupted reset can be checked again after reload even with zero credits');
    await page.click('[data-action="confirm-reset"]');
    await page.waitForFunction(() => document.querySelector('.ag-provider-quotas').textContent.includes('사용할 리셋 크레딧이 없어요.'));
    assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-codex-pending-reset')), null);
  });
  await step(
    'Unconfigured provider installation and local OAuth placeholder',
    async () => {
      await open('services=setup&page=settings');
      await clickText('.ag-settings-nav-button', 'AI 연결');
      const codexRow = '.ag-settings-provider-row[data-agent="codex"]';
      await page.click(`${codexRow} summary`);
      assert.equal(await page.$eval(codexRow, el => el.open), true);
      await page.click('.ag-settings-provider-row[data-agent="claude"] summary');
      await page.waitForFunction(() => !document.querySelector('.ag-settings-provider-row[data-agent="codex"]').open);
      await page.focus(`${codexRow} summary`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.ag-settings-provider-row[data-agent="codex"]').open);
      await screenshot('connection-accordion');
      await page.click(`${codexRow} .ag-provider-setup-btn`);
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
  await browser?.close();
  await server.close();
}
