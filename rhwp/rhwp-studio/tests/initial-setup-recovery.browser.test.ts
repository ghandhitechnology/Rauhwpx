import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('Rau 재시도 실패마다 설정 모달을 닫고 재진입을 막는다', { timeout: 20_000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    cacheDir: 'node_modules/.vite-initial-setup-recovery-test',
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({
      executablePath: browserExecutable(), headless: true, args: browserLaunchArgs(),
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
    const attempts = await page.evaluate(async () => {
      const { createInitialSetup } = await import('/src/ui/initial-setup/initial-setup.ts');
      const modal = document.createElement('div');
      modal.hidden = true;
      document.body.appendChild(modal);
      let opened = 0;
      let closed = 0;
      const setup = createInitialSetup({
        storage: null,
        openAgentSetup: () => { opened += 1; modal.hidden = false; },
        closeAgentSetup: () => {
          closed += 1;
          modal.hidden = true;
          // 실제 설정 모달처럼 닫는 도중 취소 이벤트를 다시 보낸다.
          setup.notifySetupAbandoned({ agent: 'rau', code: 'RAU_LOGIN_CANCELLED' });
        },
        openCalibration: () => {},
      });
      setup.open();
      const results = [];
      try {
        for (const code of ['RAU_LOGIN_START_FAILED', 'RAU_CREDITS_TIMEOUT']) {
          setup.element.querySelector<HTMLButtonElement>('[data-agent="rau"] button')!.click();
          setup.handleEvent({ type: 'agent-setup-error', agent: 'rau', code, message: '로그인 실패' });
          results.push({
            opened,
            closed,
            modalHidden: modal.hidden,
            recovery: setup.element.querySelector<HTMLElement>('.rhwp-setup-dialog')!.dataset.recovery,
            byokAvailable: !setup.element.querySelector<HTMLButtonElement>('[data-agent="codex"] button')!.disabled,
          });
        }
        return results;
      } finally {
        setup.dispose();
        modal.remove();
      }
    });
    assert.deepEqual(attempts, [
      { opened: 1, closed: 1, modalHidden: true, recovery: 'true', byokAvailable: true },
      { opened: 2, closed: 2, modalHidden: true, recovery: 'true', byokAvailable: true },
    ]);
  } finally {
    await browser?.close();
    await server.close();
  }
});
