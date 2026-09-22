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
    window.__agentTableRevealLayoutReady = false;
    const unsubscribe = window.__eventBus.on('document-layout-refreshed', (event) => {
      if (event?.source !== 'mutation') return;
      window.__agentTableRevealLayoutReady = true;
      unsubscribe();
    });
    // Let the mutation frame own layout instead of racing it with loadDocument.
    window.__eventBus.emit('document-changed');
    return { addr, oldText, newText };
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
  const result = await page.evaluate(async ({ addr, oldText, newText }) => {
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
    pending.endTurn('review');
    const afterTurn = coverCount();
    await Promise.resolve();
    return {
      duringEdit,
      afterTurn,
      afterMicrotask: coverCount(),
      hasPending: pending.hasPending(),
      text: window.__wasm.getTextInCell(0, addr.paraIdx, addr.controlIdx, 0, 0, 0, Array.from(newText).length),
    };
  }, fixture);
  await page.screenshot({ path: path.join(artifacts, 'after-turn.png') });
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ duringEdit: result.duringEdit, afterTurn: result.afterTurn, afterMicrotask: result.afterMicrotask, hasPending: result.hasPending }));
  assert.ok(result.duringEdit > 0, 'the rewrite starts revealing text before the turn finishes');
  assert.equal(result.text, fixture.newText, 'all Korean cell text remains in the document');
  assert.equal(result.hasPending, true, 'finishing animation keeps changes pending for review');
  assert.equal(result.afterTurn, 0, 'completed agent turns leave no white covers hiding table text');
  assert.equal(result.afterMicrotask, 0, 'deferred reveal work keeps completed turns uncovered');
} finally {
  await closeBrowser(browser);
}
