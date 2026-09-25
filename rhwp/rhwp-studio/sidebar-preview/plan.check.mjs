import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkPlanPreview(page, origin, artifacts) {
  const open = async (query = '') => {
    const params = new URLSearchParams(query);
    if (!params.has('theme')) params.set('theme', 'light');
    if (!params.has('scenario')) params.set('scenario', 'plan');
    if (!params.has('width')) params.set('width', '480');
    await page.goto(`${origin}/?${params}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
  };
  const submit = async (text) => {
    await page.$eval('.ag-input', (input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.click('.ag-send');
  };
  const latest = () => page.evaluate(() => window.sidebarPreview.bridge.getWorkflowState().latestPlan);

  await open();
  await page.click('#play');
  await page.waitForSelector('.ag-plan-approve:not(:disabled)', { visible: true });
  const original = await latest();
  assert.equal(original.revision, 1);
  assert.equal(original.execution, undefined);
  assert.equal(await page.$$eval('.ag-plan-step[data-status="completed"]', nodes => nodes.length), 0);
  assert.equal(await page.$$eval('.ag-plan-source', nodes => nodes.length), 2);
  await page.$eval('.ag-plan-step-summary', node => node.click());
  assert.match(await page.$eval('.ag-plan-step-content', node => node.textContent), /목적과 기대 효과/);
  assert.match(await page.$eval('.ag-plan-step-summary', node => node.textContent), /사업 개요/);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'plan-initial.png') });
  await page.$eval('.ag-plan-card-slot', node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('.ag-plan-card-slot').scrollTop > 0);
  assert.equal(await page.$eval('.ag-plan-approve', node => node.checkVisibility()), true);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'plan-actions.png') });
  await page.$eval('.ag-plan-card-slot', node => { node.scrollTop = 0; });

  await submit('첫 단계에서 무엇을 확인하나요?');
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  assert.equal((await latest()).planId, original.planId, 'ordinary plan conversation must preserve the approvable plan');
  await page.click('.ag-plan-revise');
  await submit('일정을 먼저 검토하고 담당자도 확인해 주세요.');
  await page.waitForFunction(id => window.sidebarPreview.bridge.getWorkflowState().latestPlan?.planId !== id
    && window.sidebarPreview.bridge.getWorkflowState().phase === 'awaiting-approval', {}, original.planId);
  const revised = await latest();
  assert.equal(revised.revision, 2);
  assert.equal(revised.previousPlanId, original.planId);
  assert.match(revised.changeSummary, /일정/);
  assert.equal(revised.steps[0].id, 'step-1');
  assert.equal(revised.steps[0].title, '일정 검토');
  assert.match(await page.$eval('.ag-plan-revision', node => node.textContent), /2차 초안/);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'plan-revised.png') });

  await page.evaluate(() => {
    window.planEvents = [];
    window.planDomStates = [];
    new MutationObserver(() => {
      const statuses = [...document.querySelectorAll('.ag-plan-step')].map(node => node.dataset.status);
      if (statuses.length) window.planDomStates.push(statuses);
    }).observe(document.querySelector('.ag-root'), { childList: true, subtree: true, attributes: true, attributeFilter: ['data-status'] });
    window.sidebarPreview.bridge.onEvent(event => {
      if (event.type === 'plan-progress') window.planEvents.push(event.latestPlan?.execution);
    });
  });
  await page.click('.ag-plan-approve');
  await page.waitForFunction(() => {
    const steps = [...document.querySelectorAll('.ag-plan-step')];
    return steps.length === 2 && steps.every(node => node.dataset.status === 'pending')
      && document.querySelector('.ag-plan-step-count');
  });
  await page.$eval('.ag-plan-step-summary', node => {
    node.closest('details').open = true;
    node.focus();
  });
  await page.waitForSelector('.ag-plan-step[data-status="in-progress"]');
  assert.equal(await page.$eval('.ag-plan-step-details', node => node.open), true,
    'step disclosure must stay open as progress arrives');
  assert.equal(await page.$eval('.ag-plan-step-summary', node => node === document.activeElement), true,
    'progress must keep focus on the active step');
  await page.waitForFunction(() => document.querySelectorAll('.ag-plan-step[data-status="in-progress"]')[0]?.dataset.stepId === 'step-2');
  await new Promise(resolve => setTimeout(resolve, 350));
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'plan-running.png') });
  await page.waitForFunction(() => window.sidebarPreview.snapshot().pendingChanges === 1);
  const execution = (await latest()).execution;
  assert.equal(execution.status, 'awaiting-review');
  assert.deepEqual(execution.steps.map(step => step.status), ['completed', 'completed']);
  const events = await page.evaluate(() => window.planEvents);
  assert(events.some(event => event.status === 'running' && event.steps.every(step => step.status === 'pending')),
    'checklist must start with pending steps');
  assert(events.some(event => event.steps.some(step => step.status === 'in-progress')),
    'checklist must show work in progress');
  const domStates = await page.evaluate(() => window.planDomStates);
  assert(domStates.some(states => states.length === 2 && states.every(status => status === 'pending')));
  assert(domStates.some(states => states.includes('in-progress')));
  assert.deepEqual(await page.$$eval('.ag-plan-step', nodes => nodes.map(node => node.dataset.status)), ['completed', 'completed']);
  assert.equal(await page.$$eval('.ag-review-card .ag-approve', nodes => nodes.length), 1);
  await page.click('.ag-review-card .ag-approve');
  await page.waitForFunction(() => window.sidebarPreview.bridge.getWorkflowState().latestPlan?.execution?.status === 'completed');
  assert.match(await page.$eval('.ag-plan-phase', node => node.textContent), /완료/);

  await open('theme=dark&width=280');
  await page.click('#play');
  await page.waitForSelector('.ag-plan-card', { visible: true });
  assert.equal(await page.$eval('#theme', node => node.value), 'dark');
  assert(await page.$eval('.ag-root', node => node.getBoundingClientRect().width <= 360));
  assert.equal(await page.$eval('.ag-root', node => node.scrollWidth > node.clientWidth), false);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'plan-narrow-dark.png') });
}
