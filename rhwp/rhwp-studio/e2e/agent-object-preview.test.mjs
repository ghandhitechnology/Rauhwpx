import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchBrowser, createPage, closeBrowser, loadApp, createNewDocument } from './helpers.mjs';
const out = path.resolve('../output/object-preview');
fs.mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await createPage(browser, 1440, 1000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await loadApp(page);
  await page.waitForFunction(() => !!window.__agentBridge?.pendingEdits);
  await createNewDocument(page);
  await page.screenshot({ path:path.join(out,'empty-document.png') });
  const image = await page.evaluate(async () => {
    const pending = window.__agentBridge.pendingEdits;
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f3d087'; ctx.fillRect(0, 0, 120, 80);
    ctx.fillStyle = '#194a8e'; ctx.fillRect(9, 10, 102, 60);
    ctx.fillStyle = '#ff664c'; ctx.fillRect(20, 20, 75, 39);
    const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
    pending.beginTurn('codex');
    const r = pending.addObjectOp('codex', {
      type: 'insertImage', sectionIdx: 0, paraIdx: 0, charOffset: 0,
      bytes, extension: 'png', widthHu: 12000, heightHu: 8000,
      naturalWidthPx: 120, naturalHeightPx: 80, description: 'Preview image',
    });
    pending.endTurn('review');
    await new Promise(r => setTimeout(r, 400));
    return {anchor:r.obj.anchor,markers:Array.from(document.querySelectorAll('.ag-pending-marker')).map(n => ({cls:n.className,rect:n.getBoundingClientRect().toJSON()})),hasPending:pending.hasPending(),pageCount:window.__wasm.pageCount};
  });
  await page.screenshot({ path:path.join(out,'pending-image.png') });
  const equation = await page.evaluate(async () => {
    const pending = window.__agentBridge.pendingEdits;
    pending.beginTurn('codex');
    const r = pending.addObjectOp('codex', {type:'insertEquation',sectionIdx:0,paraIdx:0,charOffset:0,script:'x over y',fontSizeHu:1200,colorRef:0});
    pending.endTurn('review');
    await new Promise(r => setTimeout(r, 400));
    return {anchor:r.obj.anchor,markers:Array.from(document.querySelectorAll('.ag-pending-marker')).map(n => ({cls:n.className,rect:n.getBoundingClientRect().toJSON()}))};
  });
  await page.waitForFunction(() => {
    const image = document.querySelector('.ag-image-preview img');
    return image?.complete && image.naturalWidth > 0
      && !!document.querySelector('.ag-equation-preview svg');
  });
  const reviewPreviews = await page.evaluate(() => {
    const image = document.querySelector('.ag-image-preview img');
    const equation = document.querySelector('.ag-equation-preview svg');
    return {
      imageLoaded: image?.complete && image.naturalWidth > 0,
      imageNaturalSize: image ? [image.naturalWidth, image.naturalHeight] : null,
      equationVisible: !!equation && equation.getBoundingClientRect().width > 0,
      equationContent: equation?.querySelectorAll('path, text, image').length ?? 0,
    };
  });
  await page.screenshot({ path:path.join(out,'pending-image-equation.png') });
  const equationReviewVisible = await page.evaluate(() => {
    const preview = document.querySelector('.ag-equation-preview');
    const review = document.querySelector('.ag-review');
    preview?.scrollIntoView({ block: 'center' });
    if (!preview || !review) return false;
    const box = preview.getBoundingClientRect();
    const viewport = review.getBoundingClientRect();
    return box.top >= viewport.top && box.bottom <= viewport.bottom;
  });
  await page.screenshot({ path:path.join(out,'pending-equation-review.png') });
  assert.equal(image.markers.length, 1, 'the inserted image has an exact pending outline');
  assert.equal(equation.markers.length, 2, 'the inserted equation has its own pending outline');
  assert.ok(equation.markers[1].rect.width < image.markers[0].rect.width / 2, 'the equation has its own narrow outline');
  assert.ok(
    equation.markers[1].rect.left >= image.markers[0].rect.right - 0.5,
    'the equation follows the image without covering its pixels',
  );
  assert.equal(reviewPreviews.imageLoaded, true, 'the review card loads the inserted image');
  assert.equal(reviewPreviews.equationVisible, true, 'the review card shows the rendered equation');
  assert.ok(reviewPreviews.equationContent > 0, 'the equation thumbnail contains rendered marks');
  assert.equal(equationReviewVisible, true, 'the equation review card can be scrolled fully into view');
  for (let remaining = 2; remaining > 0; remaining--) {
    const pendingBefore = await page.evaluate(() => window.__agentBridge.pendingEdits.getChangeSets().length);
    assert.equal(pendingBefore, remaining, 'the expected edits are still pending');
    const clicked = await page.evaluate(() => {
      const button = document.querySelector('.ag-review-card[data-set-id]:not(.ag-review-card-leaving) button.ag-approve:not(:disabled)');
      button?.click();
      return Boolean(button);
    });
    assert.equal(clicked, true, 'the active pending review card exposes an enabled accept button');
    await page.waitForFunction((previous) =>
      window.__agentBridge.pendingEdits.getChangeSets().length === previous - 1, {}, pendingBefore);
  }
  await page.waitForFunction(() => document.querySelectorAll('.ag-pending-marker').length === 0);
  await page.screenshot({ path:path.join(out,'accepted-image-equation.png') });

  await page.evaluate(() => {
    const pending = window.__agentBridge.pendingEdits;
    const canvas = document.createElement('canvas'); canvas.width = 12; canvas.height = 12;
    canvas.getContext('2d').fillRect(0, 0, 12, 12);
    const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
    pending.beginTurn('codex');
    pending.addObjectOp('codex', {
      type: 'insertImage', sectionIdx: 0, paraIdx: 0, charOffset: 0,
      bytes, extension: 'png', widthHu: 1200, heightHu: 1200,
      naturalWidthPx: 12, naturalHeightPx: 12,
    });
    pending.endTurn('review');
  });
  await page.waitForFunction(() =>
    document.querySelector('.ag-review-card[data-set-id]:not(.ag-review-card-leaving) .ag-image-preview img')?.naturalWidth === 12);
  const acceptedImage = await page.evaluate(() => {
    const button = document.querySelector('.ag-review-card[data-set-id]:not(.ag-review-card-leaving) button.ag-approve:not(:disabled)');
    button?.click();
    return Boolean(button);
  });
  assert.equal(acceptedImage, true, 'the later image edit can be accepted');
  await page.waitForFunction(() => window.__agentBridge.pendingEdits.getChangeSets().length === 0);
  await page.waitForFunction(() => {
    const image = document.querySelector('.ag-applied-turn .ag-image-preview img');
    return image?.complete && image.naturalWidth === 12;
  });

  const interleavedReject = await page.evaluate(async () => {
    const wasm = window.__wasm;
    const pending = window.__agentBridge.pendingEdits;
    const controls = () => Array.from({ length: wasm.pageCount }, (_, page) =>
      wasm.getPageControlLayout(page).controls);
    const baseline = controls();
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 20;
    canvas.getContext('2d').fillRect(0, 0, 20, 20);
    const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
    pending.beginTurn('codex');
    const first = pending.addObjectOp('codex', {
      type: 'insertImage', sectionIdx: 0, paraIdx: 0, charOffset: 0,
      bytes, extension: 'png', widthHu: 1500, heightHu: 1500,
      naturalWidthPx: 20, naturalHeightPx: 20,
    });
    pending.endTurn('review');
    pending.beginTurn('codex');
    const second = pending.addObjectOp('codex', {
      type: 'insertEquation', sectionIdx: 0, paraIdx: 0, charOffset: 0,
      script: 'a over b', fontSizeHu: 1200, colorRef: 0,
    });
    pending.endTurn('review');
    pending.reject(first.changeSetId);
    pending.reject(second.changeSetId);
    await new Promise(resolve => setTimeout(resolve, 250));
    return { baseline, after: controls(), pending: pending.hasPending() };
  });
  assert.deepEqual(interleavedReject.after, interleavedReject.baseline,
    'rejecting separate image and equation edits keeps approved objects without resurrecting rejected ones');
  assert.equal(interleavedReject.pending, false, 'both interleaved edits are rejected');

  const cellPage = await createPage(browser, 1440, 1000);
  cellPage.on('pageerror', e => errors.push(String(e)));
  await loadApp(cellPage);
  await cellPage.waitForFunction(() => !!window.__agentBridge?.pendingEdits);
  await createNewDocument(cellPage);
  const cellEquation = await cellPage.evaluate(async () => {
    const wasm = window.__wasm;
    const table = wasm.createTable(0, 0, 0, 1, 1);
    const addr = typeof table === 'string' ? JSON.parse(table) : table;
    window.__eventBus.emit('document-changed');
    await new Promise(r => setTimeout(r, 350));
    const pending = window.__agentBridge.pendingEdits;
    pending.beginTurn('codex');
    const r = pending.addObjectOp('codex', {
      type:'insertEquation',sectionIdx:0,paraIdx:0,charOffset:0,
      cell:{paraIdx:addr.paraIdx,controlIdx:addr.controlIdx,cellIdx:0,
        path:[{controlIndex:addr.controlIdx,cellIndex:0,cellParaIndex:0}]},
      script:'x over y',fontSizeHu:1200,colorRef:0,
    });
    pending.endTurn('review');
    await new Promise(resolve => setTimeout(resolve, 400));
    const markers = Array.from(document.querySelectorAll('.ag-pending-marker')).map(n => ({cls:n.className,rect:n.getBoundingClientRect().toJSON()}));
    const cell = wasm.getTableCellBboxes(0, addr.paraIdx, addr.controlIdx)[0];
    return {anchor:r.obj.anchor,markers,cell};
  });
  await cellPage.screenshot({ path:path.join(out,'pending-cell-equation.png') });
  console.log(JSON.stringify({ image, equation, reviewPreviews, equationReviewVisible, cellEquation, errors }));
  assert.equal(cellEquation.markers.length, 1, 'cell equation has one pending outline');
  assert.ok(cellEquation.markers[0].rect.width < cellEquation.cell.w * 1.6, 'the equation outline is narrower than its cell');
  assert.equal(errors.length, 0, 'no browser page errors');
  const state = {image,equation,reviewPreviews,equationReviewVisible,interleavedReject,cellEquation,errors};
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(state,null,2));
} finally { await closeBrowser(browser); }
