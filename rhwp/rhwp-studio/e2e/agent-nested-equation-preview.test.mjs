import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, createPage, closeBrowser, loadApp } from './helpers.mjs';

const sample = fs.readFileSync(path.resolve('../samples/rendering-fidelity/03-table-nested.hwpx'));
const artifacts = path.resolve('../output/e2e/agent-nested-equation-preview');
fs.mkdirSync(artifacts, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await createPage(browser, 1440, 1000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await loadApp(page);
  await page.waitForFunction(() => !!window.__agentBridge?.pendingEdits);
  const state = await page.evaluate(async bytes => {
    const wasm = window.__wasm;
    const requestId = 'nested-equation-preview';
    const opened = new Promise((resolve, reject) => {
      const off = window.__eventBus.on('open-document-bytes:done', result => {
        if (result.requestId !== requestId) return;
        off();
        if (result.ok) resolve();
        else reject(new Error(result.error));
      });
    });
    window.__eventBus.emit('open-document-bytes', {
      bytes: new Uint8Array(bytes), fileName: '03-table-nested.hwpx', requestId,
      suppressDialogs: true, skipUnsavedGuard: true,
    });
    await opened;
    const siblingPath = [
      { controlIndex: 0, cellIndex: 1, cellParaIndex: 0 },
      { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
    ];
    const targetPath = [
      { controlIndex: 0, cellIndex: 1, cellParaIndex: 0 },
      { controlIndex: 0, cellIndex: 1, cellParaIndex: 0 },
    ];
    const sibling = wasm.insertEquationInCellByPath(0, 1, siblingPath, 0, 'a over b', 1000, 0);
    window.__eventBus.emit('document-changed');
    await new Promise(resolve => setTimeout(resolve, 350));
    const pending = window.__agentBridge.pendingEdits;
    pending.beginTurn('codex');
    const result = pending.addObjectOp('codex', {
      type: 'insertEquation', sectionIdx: 0, paraIdx: 0, charOffset: 0,
      cell: { paraIdx: 1, controlIdx: 0, cellIdx: 1, path: targetPath },
      script: 'x over y', fontSizeHu: 1200, colorRef: 0,
    });
    pending.endTurn('review');
    await new Promise(resolve => setTimeout(resolve, 450));
    const markers = Array.from(document.querySelectorAll('.ag-pending-marker'))
      .map(node => ({ rect: node.getBoundingClientRect().toJSON(),
        left: Number.parseFloat(node.style.left), top: Number.parseFloat(node.style.top),
        width: Number.parseFloat(node.style.width), height: Number.parseFloat(node.style.height) }));
    const siblingBBox = wasm.getObjectBBox('equation', 0, 1, 0, 1, 0, sibling.controlIdx, siblingPath);
    const targetBBox = wasm.getObjectBBox('equation', 0, 1, 0, 1, 0, result.obj.anchor.controlIdx, targetPath);
    const view = window.__canvasView;
    const vs = view.getVirtualScroll();
    const zoom = view.getViewportManager().getZoom();
    const contentWidth = document.getElementById('scroll-content').clientWidth;
    const pageLeft = vs.getPageLeft(targetBBox.pageIndex);
    const expected = {
      left: (pageLeft >= 0 ? pageLeft : (contentWidth - vs.getPageWidth(targetBBox.pageIndex)) / 2) + targetBBox.x * zoom,
      top: vs.getPageOffset(targetBBox.pageIndex) + targetBBox.y * zoom,
      width: targetBBox.width * zoom,
      height: targetBBox.height * zoom,
    };
    return { sibling, anchor: result.obj.anchor, changeSetId: result.changeSetId,
      markers, siblingPath, targetPath, siblingBBox, targetBBox, expected };
  }, Array.from(sample));
  await page.screenshot({ path: path.join(artifacts, 'pending-nested-equation.png') });
  assert.equal(state.sibling.ok, true, 'sibling equation fixture inserts');
  assert.equal(state.markers.length, 1, 'nested equation has one pending outline');
  assert.ok(state.targetBBox.x > state.siblingBBox.x, 'the target is in the neighboring nested cell');
  for (const key of ['left', 'top', 'width', 'height']) {
    assert.ok(Math.abs(state.markers[0][key] - state.expected[key]) < 1,
      `pending outline ${key} follows the exact nested equation bbox`);
  }
  const afterReject = await page.evaluate(async state => {
    window.__agentBridge.pendingEdits.reject(state.changeSetId);
    await new Promise(resolve => setTimeout(resolve, 250));
    return {
      markers: document.querySelectorAll('.ag-pending-marker').length,
      sibling: window.__wasm.getEquationPropertiesByPath(0, 1, state.siblingPath, state.sibling.controlIdx),
    };
  }, state);
  await page.screenshot({ path: path.join(artifacts, 'rejected-nested-equation.png') });
  assert.equal(afterReject.markers, 0, 'reject clears the nested marker');
  assert.equal(afterReject.sibling.script, 'a over b', 'reject preserves sibling equation');
  assert.deepEqual(errors, [], 'no browser errors');
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ state, afterReject, errors }, null, 2));
} finally {
  await closeBrowser(browser);
}
