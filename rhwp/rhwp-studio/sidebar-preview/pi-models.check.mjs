import assert from 'node:assert/strict';

export async function checkPiModels(page, origin) {
  await page.goto(`${origin}/?page=settings&destination=ai&services=ready&width=480&reset=1`, { waitUntil: 'networkidle0' });
  await page.click('#ag-settings-model-tab-pi');
  await page.waitForSelector('.ag-settings-model-list .ag-settings-model-row');
  const rows = '.ag-settings-model-list .ag-settings-model-row';
  assert.equal(await page.$eval(`${rows}[data-model-id="anthropic/claude-sonnet-4.6"]`, node => node.getAttribute('aria-pressed')), 'true');
  while (await page.$(`${rows}[aria-pressed="true"]`)) await page.click(`${rows}[aria-pressed="true"]`);
  const ids = await page.$$eval(rows, nodes => nodes.slice(0, 4).map(node => node.dataset.modelId));
  assert.equal(ids.length, 4);
  for (const id of ids) await page.click(`${rows}[data-model-id="${id}"]`);
  assert.equal(await page.$$eval(`${rows}[aria-pressed="true"]`, nodes => nodes.length), 3);
  assert.match(await page.$eval('.ag-settings-model-status', node => node.textContent), /최대 3/);
  await page.type('.ag-settings-model-search-input', ids[0]);
  assert.equal(await page.$$eval(rows, nodes => nodes.length), 1);
  await page.waitForFunction(() => !document.querySelector('.ag-agent-setup-overlay'));
  await page.$$eval('.ag-settings-pi-actions button', buttons => buttons.find(node => node.textContent === '다음').click());
  await page.waitForSelector('.ag-agent-setup-overlay.ag-open .ag-pi-naming input', { visible: true });
  await page.$eval('.ag-pi-naming input', node => { node.value = 'My Pi model'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.select('.ag-pi-naming select', 'high');
  await page.$$eval('.ag-pi-step button', buttons => buttons.find(node => node.checkVisibility() && node.textContent === '뒤로').click());
  await page.waitForFunction(() => !document.querySelector('.ag-agent-setup-overlay'));
  await page.$$eval('.ag-settings-pi-actions button', buttons => buttons.find(node => node.textContent === '다음').click());
  await page.waitForSelector('.ag-agent-setup-overlay.ag-open .ag-pi-naming input', { visible: true });
  assert.equal(await page.$eval('.ag-pi-naming input', node => node.value), 'My Pi model');
  assert.equal(await page.$eval('.ag-pi-naming select', node => node.value), 'high');
  await page.$$eval('.ag-pi-naming-actions button, .ag-pi-step button', buttons => buttons.find(node => node.checkVisibility() && node.textContent === '저장').click());
  await page.waitForFunction(() => document.querySelector('.ag-pi-summary-models')?.textContent.includes('My Pi model'));
  await page.$$eval('.ag-pi-step button', buttons => buttons.find(node => node.textContent === '모델 다시 고르기').click());
  await page.waitForFunction(() => document.querySelector('.ag-agent-setup-overlay')?.getAttribute('aria-hidden') !== 'false');
  assert.equal(await page.$$eval(`${rows}[aria-pressed="true"]`, nodes => nodes.length), 3);
  assert.match(await page.$eval('.ag-pi-chips', node => node.textContent), /My Pi model/);
  await page.focus('#ag-settings-model-tab-pi');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.$eval('#ag-settings-model-tab-claude', node => node.getAttribute('aria-selected')), 'true');
  assert.equal(await page.$eval('.ag-settings-pi-actions', node => !node.checkVisibility()), true);
}
