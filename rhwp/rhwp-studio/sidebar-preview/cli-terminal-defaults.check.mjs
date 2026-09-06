import assert from 'node:assert/strict';

export async function checkCliTerminalDefaults(page, origin) {
  for (const provider of ['claude', 'codex', 'grok', 'cursor']) {
    await page.goto(`${origin}/?page=settings&destination=connections&surface=provider-setup&provider=${provider}&services=setup`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.ag-agent-setup-overlay.ag-open');
    await page.$$eval('.ag-agent-setup-primary', buttons => buttons.find(b => b.textContent === '설치하고 계속').click());
    await page.waitForSelector('.ag-setup-terminal .xterm-helper-textarea');
    assert.match(await page.$eval('.ag-setup-terminal-header', el => el.textContent.toLowerCase()), new RegExp(provider));
    await page.focus('.ag-setup-terminal .xterm-helper-textarea');
    await page.waitForFunction(() => document.querySelector('.ag-setup-terminal').textContent.includes('Enter'));
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ag-agent-setup-done:not([hidden])', { visible: true });
  }
  await page.goto(`${origin}/?page=settings&destination=connections&surface=provider-setup&provider=claude&services=setup`, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    const setups = await window.sidebarPreview.bridge.requestAgentSetupStatus();
    setups.claude.terminalAuthSupported = false;
    window.sidebarPreview.setServices(false);
  });
  await page.$$eval('.ag-agent-setup-primary', buttons => buttons.find(b => b.textContent === '설치하고 계속').click());
  await page.waitForSelector('.ag-agent-key-box:not([hidden]) input', { visible: true });
  assert.equal(await page.$eval('.ag-setup-terminal', el => el.hidden), true);
}
