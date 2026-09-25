import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { launchBrowser, createPage, closeBrowser, loadApp, createNewDocument } from './helpers.mjs';

const artifacts = process.env.REVEAL_ARTIFACTS || '../output/e2e/agent-body-reveal';
fs.mkdirSync(artifacts, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await createPage(browser, 1400, 1000);
  await loadApp(page);
  await page.waitForFunction(() => !!window.__agentBridge?.pendingEdits);
  await createNewDocument(page);
  const fixture = await page.evaluate(() => {
    const wasm = window.__wasm;
    const oldText = '가'.repeat(160);
    const newText = '나'.repeat(160);
    const pageFill = wasm.getPageBorderFill(0);
    const fill = wasm.setPageBorderFill(0, {
      ...pageFill, fillType: 'solid', fillColor: '#ffe0a8', hideFill: false, fillArea: 'paper',
    });
    wasm.insertText(0, 0, 0, oldText);
    window.__agentBodyRevealLayoutReady = false;
    const unsubscribe = window.__eventBus.on('document-layout-refreshed', (event) => {
      if (event?.source !== 'mutation') return;
      window.__agentBodyRevealLayoutReady = true;
      unsubscribe();
    });
    window.__eventBus.emit('document-changed');
    return { oldText, newText, fill };
  });
  await page.waitForFunction(() => window.__agentBodyRevealLayoutReady);
  const beforePath = path.join(artifacts, 'before-turn.png');
  await page.screenshot({ path: beforePath });
  const pendingResult = await page.evaluate(async ({ oldText, newText }) => {
    const pending = window.__agentBridge.pendingEdits;
    pending.beginTurn('codex');
    pending.replaceText({
      sectionIdx: 0, startParaIdx: 0, startCharOffset: 0,
      endParaIdx: 0, endCharOffset: Array.from(oldText).length,
    }, newText, 'codex');
    await new Promise(resolve => setTimeout(resolve, 80));
    return {
      covers: Array.from(document.querySelectorAll('.ag-reveal-cover'))
        .filter(node => node.style.display !== 'none').length,
      inkBoxes: Array.from(document.querySelectorAll('.ag-pending-ink'))
        .map(node => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }),
    };
  }, fixture);
  const duringPath = path.join(artifacts, 'during-turn.png');
  await page.screenshot({ path: duringPath });
  const result = await page.evaluate(({ newText }) => {
    const pending = window.__agentBridge.pendingEdits;
    pending.endTurn('review');
    return {
      hasPending: pending.hasPending(),
      text: window.__wasm.getTextRange(0, 0, 0, Array.from(newText).length),
    };
  }, fixture);
  await page.screenshot({ path: path.join(artifacts, 'after-turn.png') });
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ pendingResult, result }, null, 2));
  console.log(JSON.stringify({ covers: pendingResult.covers }));
  assert.equal(fixture.fill.ok, true);
  assert.equal(pendingResult.covers, 0, 'body edits do not mask page fills or floating objects');
  assert.equal(pendingResult.inkBoxes.length, 0, 'pending text does not blend across the page fill');
  const colorAt = (file, x, y) => {
    const png = PNG.sync.read(fs.readFileSync(file));
    return [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
  };
  assert.deepEqual(colorAt(beforePath, 300, 291), [255, 224, 168]);
  assert.deepEqual(colorAt(duringPath, 300, 291), [255, 224, 168],
    'the background pixel inside the edited line stays the same color');
  assert.equal(result.hasPending, true);
  assert.equal(result.text, fixture.newText);
} finally {
  await closeBrowser(browser);
}
