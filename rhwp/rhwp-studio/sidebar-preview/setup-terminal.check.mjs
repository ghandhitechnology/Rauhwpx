import assert from 'node:assert/strict';

export async function checkSetupTerminal(page, origin) {
  for (const width of [320, 640]) {
    await page.goto(`${origin}/?page=settings&destination=ai&surface=provider-setup&provider=claude&services=setup&width=${width}&theme=${width === 320 ? 'light' : 'dark'}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.ag-agent-setup-overlay.ag-open');
    // Fixture install leaves the provider unconfigured for the login step.
    await page.evaluate(async () => { await window.sidebarPreview.bridge.installAgent('claude'); });
    await page.waitForSelector('.ag-agent-auth-card:not([hidden])', { visible: true });
    await page.click('.ag-agent-auth-card');
    await page.waitForSelector('.ag-setup-terminal .xterm-helper-textarea');
    await page.waitForFunction(() => document.querySelector('.ag-setup-terminal').innerText.includes('Claude'));
    assert.equal(await page.$eval('.ag-setup-terminal', el => el.scrollWidth > el.clientWidth), false);
    await page.focus('.ag-setup-terminal .xterm-helper-textarea');
    await page.waitForFunction(() => document.querySelector('.ag-setup-terminal').textContent.includes('❯ Anthropic'));
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.ag-setup-terminal').textContent.includes('❯ OpenAI'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.ag-setup-terminal').textContent.includes('브라우저에서'));
    await page.keyboard.press('Enter');
    // 완료 줄은 Rau 전용이다. 다른 프로바이더는 연결 상태 카드로 로그인을 마친다.
    await page.waitForSelector('.ag-agent-setup-card:not([hidden])', { visible: true });
    assert.equal(await page.$eval('.ag-setup-terminal', el => el.hidden), true);
    // Re-enter login, cancel it, and use the key fallback.
    await page.$$eval('.ag-agent-setup-card button', buttons => buttons.find(b => b.textContent === '로그인 방식 변경').click());
    await page.click('.ag-agent-auth-card');
    await page.waitForSelector('.ag-setup-terminal .xterm-helper-textarea');
    await page.click('.ag-setup-terminal-header button');
    assert.equal(await page.$eval('.ag-setup-terminal', el => el.hidden), true);
    if (await page.$eval('.ag-agent-setup-card', el => !el.hidden)) {
      await page.$$eval('.ag-agent-setup-card button', buttons => buttons.find(b => b.textContent === '로그인 방식 변경').click());
    }
    await page.$$eval('.ag-agent-auth-card', buttons => buttons.find(b => b.textContent.includes('API 키')).click());
    await page.waitForSelector('.ag-agent-key-box:not([hidden]) input', { visible: true });
  }
}
