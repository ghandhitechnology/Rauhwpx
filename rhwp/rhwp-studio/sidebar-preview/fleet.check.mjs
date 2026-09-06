import assert from 'node:assert/strict';

export async function checkFleetPreview(page, origin) {
  for (const width of [280, 480]) {
    await page.goto(`${origin}/?scenario=fleet&play=1&hold=1&width=${width}&theme=${width === 280 ? 'light' : 'dark'}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.ag-fleet-task');
    assert.equal(await page.$eval('.ag-fleet-dock-pill', el => el.getAttribute('aria-expanded')), 'false');
    await page.click('.ag-fleet-dock-pill');
    assert.equal(await page.$eval('.ag-fleet-dock-pill', el => el.checkVisibility()), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('.ag-fleet-dock-pill', el => el === document.activeElement && el.checkVisibility()), true);
    await page.click('.ag-fleet-dock-pill');
    await page.click('.ag-fleet-toggle');
    assert.equal(await page.$eval('.ag-fleet-popup', el => el.hidden), true);
    await page.click('.ag-fleet-dock-pill');
    assert.equal(await page.$$eval('.ag-fleet-task', rows => rows.length), 3);
    assert.equal(await page.$$eval('.ag-fleet-task.ag-open', rows => rows.length), 0);
    assert(await page.$eval('.ag-fleet-head', el => el.getBoundingClientRect().height < 50));
    await page.click('.ag-fleet-task .ag-fleet-head');
    await page.waitForFunction(() => document.querySelector('.ag-fleet-task.ag-open .ag-fleet-preview').textContent.includes('문서의 문장'));
    const before = await page.$eval('.ag-fleet-task.ag-open .ag-fleet-preview', el => el.textContent);
    await page.waitForFunction(text => document.querySelector('.ag-fleet-task.ag-open .ag-fleet-preview').textContent !== text, {}, before);
    assert.equal(await page.$eval('.ag-fleet-task:nth-child(2)', el => el.checkVisibility()), false);
    assert(await page.$eval('.ag-fleet-task.ag-open .ag-fleet-detail', el => el.clientHeight > 180));
    await page.$eval('.ag-fleet-task.ag-open .ag-fleet-preview', el => { el.textContent += '\n'.repeat(80) + '스크롤 확인'; });
    await page.$eval('.ag-fleet-task.ag-open .ag-fleet-detail', el => { el.scrollTop = 0; });
    await page.waitForFunction(() => {
      const el = document.querySelector('.ag-fleet-task.ag-open .ag-fleet-detail');
      return el.scrollHeight - el.clientHeight - el.scrollTop < 2;
    });
    await page.click('.ag-fleet-task.ag-open .ag-fleet-back');
    // Return to the list before selecting another agent by keyboard.
    await page.focus('.ag-fleet-task:nth-child(2) .ag-fleet-head');
    await page.keyboard.press('Enter');
    assert.equal(await page.$$eval('.ag-fleet-task.ag-open', rows => rows.length), 1);
    assert.equal(await page.$eval('.ag-fleet-task:first-child .ag-fleet-reveal', el => el.inert), true);
    await page.click('.ag-fleet-task.ag-open .ag-tool-head');
    assert.match(await page.$eval('.ag-fleet-task.ag-open .ag-tool-result', el => el.textContent), /표 3개/);
    assert(await page.$eval('.ag-fleet-popup', el => el.scrollWidth <= el.clientWidth + 1));
    await page.keyboard.press('Enter');
    await page.click('.ag-fleet-task.ag-open .ag-fleet-back');
    await page.click('.ag-fleet-task:nth-child(3) .ag-fleet-head');
    assert.match(await page.$eval('.ag-fleet-task.ag-open .ag-fleet-preview', el => el.textContent), /접근할 수 없어/);
  }
}
