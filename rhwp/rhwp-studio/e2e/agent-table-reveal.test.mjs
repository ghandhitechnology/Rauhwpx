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
    const fill = wasm.setCellProperties(0, addr.paraIdx, addr.controlIdx, 0, {
      fillType: 'solid', fillColor: '#ffe0a8',
    });
    const oldText = '가'.repeat(160);
    const newText = '나'.repeat(160);
    wasm.insertTextInCell(0, addr.paraIdx, addr.controlIdx, 0, 0, 0, oldText);
    const equation = wasm.insertEquationInCell(
      0, addr.paraIdx, addr.controlIdx, 0, 0, Array.from(oldText).length, 'a over b', 1000, 0,
    );
    window.__agentTableRevealLayoutReady = false;
    const unsubscribe = window.__eventBus.on('document-layout-refreshed', (event) => {
      if (event?.source !== 'mutation') return;
      window.__agentTableRevealLayoutReady = true;
      unsubscribe();
    });
    // Let the mutation frame own layout instead of racing it with loadDocument.
    window.__eventBus.emit('document-changed');
    return { addr, oldText, newText, equation, fill };
  });
  await page.waitForFunction(({ addr, oldText }) => {
    if (!window.__agentTableRevealLayoutReady) return false;
    const wasm = window.__wasm;
    const pages = window.__canvasView.getVirtualScroll();
    if (!pages.pageCount || pages.pageCount !== wasm.pageCount) return false;
    const caret = wasm.getCursorRectInCell(0, addr.paraIdx, addr.controlIdx, 0, 0, 0);
    const rects = wasm.getSelectionRectsInCell(
      0, addr.paraIdx, addr.controlIdx, 0, 0, 0, 0, Array.from(oldText).length,
    );
    return caret.height > 0 && caret.pageIndex < pages.pageCount && rects.length > 0
      && rects.every((rect) => rect.pageIndex < pages.pageCount
        && rect.width > 0 && rect.height > 0
        && pages.getPageWidth(rect.pageIndex) > 0
        && Number.isFinite(pages.getPageOffset(rect.pageIndex)));
  }, { polling: 'raf', timeout: 10_000 }, fixture);
  const pendingResult = await page.evaluate(async ({ addr, oldText, newText }) => {
    const pending = window.__agentBridge.pendingEdits;
    pending.beginTurn('codex');
    pending.replaceText({
      sectionIdx: 0, startParaIdx: 0, startCharOffset: 0,
      endParaIdx: 0, endCharOffset: Array.from(oldText).length,
      cell: { paraIdx: addr.paraIdx, controlIdx: addr.controlIdx, cellIdx: 0 },
    }, newText, 'codex');
    const coverCount = () => Array.from(document.querySelectorAll('.ag-reveal-cover'))
      .filter(node => node.style.display !== 'none').length;
    // Covers are placed once per edit batch, before the next browser paint.
    await Promise.resolve();
    const duringEdit = coverCount();
    return {
      duringEdit,
      cellProps: window.__wasm.getCellProperties(0, addr.paraIdx, addr.controlIdx, 0),
    };
  }, fixture);
  const duringPath = path.join(artifacts, 'during-turn.png');
  await page.screenshot({ path: duringPath });
  const result = await page.evaluate(({ addr, newText }) => {
    const pending = window.__agentBridge.pendingEdits;
    pending.endTurn('review');
    return {
      afterTurn: Array.from(document.querySelectorAll('.ag-reveal-cover'))
        .filter(node => node.style.display !== 'none').length,
      hasPending: pending.hasPending(),
      text: window.__wasm.getTextInCell(0, addr.paraIdx, addr.controlIdx, 0, 0, 0, Array.from(newText).length),
    };
  }, fixture);
  result.afterMicrotask = await page.evaluate(async () => {
    await Promise.resolve();
    return Array.from(document.querySelectorAll('.ag-reveal-cover'))
      .filter(node => node.style.display !== 'none').length;
  });
  await page.screenshot({ path: path.join(artifacts, 'after-turn.png') });
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ pendingResult, result }, null, 2));
  console.log(JSON.stringify({ duringEdit: pendingResult.duringEdit, afterTurn: result.afterTurn, afterMicrotask: result.afterMicrotask, hasPending: result.hasPending }));
  assert.equal(pendingResult.duringEdit, 0, 'cell edits keep the document visible during the open turn');
  assert.equal(fixture.fill.ok, true, 'the fixture has a colored table cell');
  assert.equal(fixture.equation.ok, true, 'the fixture has an adjacent equation');
  assert.equal(pendingResult.cellProps.fillColor.toLowerCase(), '#ffe0a8');
  assert.equal(result.text, fixture.newText, 'all Korean cell text remains in the document');
  assert.equal(result.hasPending, true, 'ending the turn keeps changes pending for review');
  assert.equal(result.afterTurn, 0, 'completed agent turns leave no white covers hiding table text');
  assert.equal(result.afterMicrotask, 0, 'deferred reveal work keeps completed turns uncovered');
} finally {
  await closeBrowser(browser);
}
