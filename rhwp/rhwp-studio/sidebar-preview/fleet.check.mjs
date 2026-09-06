import assert from 'node:assert/strict';

export async function checkFleetPreview(page, origin) {
  for (const width of [280, 480]) {
    await page.goto(`${origin}/?scenario=fleet&play=1&hold=1&width=${width}&theme=${width === 280 ? 'light' : 'dark'}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.ag-fleet-task');
    assert.equal(await page.$eval('.ag-fleet-dock-pill', el => el.getAttribute('aria-expanded')), 'false');
    await page.click('.ag-fleet-dock-pill');
    assert.equal(await page.$$eval('.ag-fleet-task', rows => rows.length), 3);
    assert.equal(await page.$$eval('.ag-fleet-task.ag-open', rows => rows.length), 0);
    assert(await page.$eval('.ag-fleet-head', el => el.getBoundingClientRect().height < 50));
    await page.click('.ag-fleet-task .ag-fleet-head');
    await page.waitForFunction(() => document.querySelector('.ag-fleet-task.ag-open .ag-fleet-preview').textContent.includes('문서의 문장'));
    const before = await page.$eval('.ag-fleet-task.ag-open .ag-fleet-preview', el => el.textContent);
    await page.waitForFunction(text => document.querySelector('.ag-fleet-task.ag-open .ag-fleet-preview').textContent !== text, {}, before);
    // Keyboard selection switches the preview; hidden tool buttons remain inert.
    await page.focus('.ag-fleet-task:nth-child(2) .ag-fleet-head');
    await page.keyboard.press('Enter');
    assert.equal(await page.$$eval('.ag-fleet-task.ag-open', rows => rows.length), 1);
    assert.equal(await page.$eval('.ag-fleet-task:first-child .ag-fleet-reveal', el => el.inert), true);
    await page.click('.ag-fleet-task.ag-open .ag-tool-head');
    assert.match(await page.$eval('.ag-fleet-task.ag-open .ag-tool-result', el => el.textContent), /표 3개/);
    assert(await page.$eval('.ag-fleet-popup', el => el.scrollWidth <= el.clientWidth + 1));
    await page.keyboard.press('Enter');
    await page.click('.ag-fleet-task:nth-child(3) .ag-fleet-head');
    assert.match(await page.$eval('.ag-fleet-task.ag-open .ag-fleet-preview', el => el.textContent), /접근할 수 없어/);
  }
}
