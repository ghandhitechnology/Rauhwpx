import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, createPage, closeBrowser, loadApp, createNewDocument } from './helpers.mjs';

const artifacts = process.env.REVEAL_ARTIFACTS || '../output/e2e/agent-table-reveal';
fs.mkdirSync(artifacts, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await createPage(browser, 1400, 1000);
  await loadApp(page);
  await page.waitForFunction(() => !!window.__agentBridge?.pendingEdits);
  await createNewDocument(page);
  const fixture = await page.evaluate(async () => {
    const wasm = window.__wasm;
    const table = wasm.createTable(0, 0, 0, 1, 1);
    const addr = typeof table === 'string' ? JSON.parse(table) : table;
    const oldText = Array.from({ length: 16 }, (_, i) =>
      `${i + 1}. 장비 세 대의 시각을 맞추고 온도는 2분마다 기록한다. `).join('');
    const newText = Array.from({ length: 16 }, (_, i) =>
      `${i + 1}. 장비 네 대의 시각을 맞추고 온도는 1분마다 측정한다. `).join('');
    wasm.insertTextInCell(0, addr.paraIdx, addr.controlIdx, 0, 0, 0, oldText);
    window.__eventBus.emit('document-changed');
    await window.__canvasView.loadDocument();
    return { addr, oldText, newText };
  });
  const result = await page.evaluate(({ addr, oldText, newText }) => {
    const pending = window.__agentBridge.pendingEdits;
    pending.beginTurn('codex');
    pending.replaceText({
      sectionIdx: 0, startParaIdx: 0, startCharOffset: 0,
      endParaIdx: 0, endCharOffset: Array.from(oldText).length,
      cell: { paraIdx: addr.paraIdx, controlIdx: addr.controlIdx, cellIdx: 0 },
    }, newText, 'codex');
    const coverCount = () => Array.from(document.querySelectorAll('.ag-reveal-cover'))
      .filter(node => node.style.display !== 'none').length;
    const duringEdit = coverCount();
    pending.endTurn('review');
    return {
      duringEdit,
      afterTurn: coverCount(),
      hasPending: pending.hasPending(),
      text: window.__wasm.getTextInCell(0, addr.paraIdx, addr.controlIdx, 0, 0, 0, Array.from(newText).length),
    };
  }, fixture);
  await page.screenshot({ path: path.join(artifacts, 'after-turn.png') });
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ duringEdit: result.duringEdit, afterTurn: result.afterTurn, hasPending: result.hasPending }));
  assert.ok(result.duringEdit > 10, 'the rewrite exercises a queue of scattered text covers');
  assert.equal(result.text, fixture.newText, 'all Korean cell text remains in the document');
  assert.equal(result.hasPending, true, 'finishing animation keeps changes pending for review');
  assert.equal(result.afterTurn, 0, 'completed agent turns leave no white covers hiding table text');
} finally {
  await closeBrowser(browser);
}
