/** Production clipboard events must preserve nested content, objects, and history. */
import assert from 'node:assert/strict';
import { runTest, createNewDocument, screenshot } from './helpers.mjs';

const settle = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));

async function position(page, path, offset = 0, end) {
  await page.evaluate(({ path, offset, end }) => {
    const ih = window.__inputHandler;
    const make = (entries, charOffset) => {
      if (!entries.length) return { sectionIndex: 0, paragraphIndex: 2, charOffset };
      const first = entries[0], last = entries.at(-1);
      return {
        sectionIndex: 0, parentParaIndex: 0, paragraphIndex: last.cellParaIndex,
        controlIndex: first.controlIndex, cellIndex: first.cellIndex,
        cellParaIndex: first.cellParaIndex, cellPath: entries, charOffset,
      };
    };
    ih.activateWithCaretPosition();
    ih.cursor.clearSelection();
    ih.cursor.moveTo(make(path, offset));
    if (end) { ih.cursor.setAnchor(); ih.cursor.moveTo(make(end.path, end.offset)); }
    ih.textarea.focus();
    ih.updateCaret();
  }, { path, offset, end });
}

async function copy(page) {
  return page.evaluate(() => {
    const data = new DataTransfer();
    window.__inputHandler.textarea.dispatchEvent(new ClipboardEvent('copy', {
      clipboardData: data, bubbles: true, cancelable: true,
    }));
    return { text: data.getData('text/plain'), html: data.getData('text/html') };
  });
}

async function paste(page, payload) {
  await page.evaluate(({ text, html }) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    if (html) data.setData('text/html', html);
    window.__inputHandler.textarea.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    }));
  }, payload);
  await settle(page);
}

async function cellText(page, path) {
  return page.evaluate(path => {
    const w = window.__wasm;
    const count = w.getCellParagraphCountByPath(0, 0, JSON.stringify(path));
    return Array.from({ length: count }, (_, index) => {
      const p = path.map(entry => ({ ...entry })); p.at(-1).cellParaIndex = index;
      return w.getTextInCellByPath(0, 0, JSON.stringify(p), 0, 10000);
    });
  }, path);
}

runTest('Table clipboard content and history', async ({ page }) => {
  await createNewDocument(page);
  const fixture = await page.evaluate(() => {
    const w = window.__wasm;
    const outer = w.createTable(0, 0, 0, 2, 2);
    for (const [cell, text] of ['Host', 'TARGET', 'SIBLING', 'LAST CELL'].entries()) {
      w.insertTextInCell(0, outer.paraIdx, outer.controlIdx, cell, 0, 0, text);
    }
    const inner = w.createTableEx({ sectionIdx: 0, paraIdx: 1, charOffset: 0,
      rowCount: 1, colCount: 1, treatAsChar: true, colWidths: [14000] });
    w.insertTextInCell(0, inner.paraIdx, inner.controlIdx, 0, 0, 0, 'Nested first');
    w.copyControl(0, inner.paraIdx, inner.controlIdx);
    const host = [{ controlIndex: outer.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
    w.pasteInternalInCellByPath(0, 0, JSON.stringify(host), 0);
    const nested = [...host, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }];
    for (const [index, text] of ['Nested first', 'Nested second', 'Nested tail'].entries()) {
      if (!index) continue;
      const previous = nested.map(p => ({ ...p })); previous.at(-1).cellParaIndex = index - 1;
      w.splitParagraphInCellByPath(0, 0, JSON.stringify(previous),
        w.getCellParagraphLengthByPath(0, 0, JSON.stringify(previous)));
      const next = nested.map(p => ({ ...p })); next.at(-1).cellParaIndex = index;
      w.insertTextInCellByPath(0, 0, JSON.stringify(next), 0, text);
    }
    // Body paragraph 2 is the source/destination outside all tables.
    w.splitParagraph(0, 1, 1);
    w.insertText(0, 2, 0, 'BODY');
    window.__eventBus.emit('document-changed');
    window.__inputHandler.history.clear(w);
    return { nested, target: [{ controlIndex: outer.controlIdx, cellIndex: 1, cellParaIndex: 0 }],
      sibling: [{ controlIndex: outer.controlIdx, cellIndex: 2, cellParaIndex: 0 }] };
  });
  await settle(page);
  const nestedAt = index => fixture.nested.map((p, i) => i === fixture.nested.length - 1 ? { ...p, cellParaIndex: index } : p);
  await position(page, fixture.nested, 0, { path: fixture.nested, offset: 6 });
  const word = await copy(page);
  assert.equal(word.text, 'Nested');
  assert.ok(!word.html.includes('<table'), 'text selection must not copy the enclosing table');
  await position(page, fixture.target, 0);
  await paste(page, word);
  assert.deepEqual(await cellText(page, fixture.target), ['NestedTARGET']);
  await page.evaluate(() => window.__inputHandler.performUndo());
  assert.deepEqual(await cellText(page, fixture.target), ['TARGET']);
  await page.evaluate(() => window.__inputHandler.performRedo());
  assert.deepEqual(await cellText(page, fixture.target), ['NestedTARGET']);
  await page.evaluate(() => window.__inputHandler.performUndo());

  await position(page, fixture.nested, 0, { path: nestedAt(1), offset: 13 });
  const multiline = await copy(page);
  assert.equal(multiline.text, 'Nested first\nNested second');
  await position(page, nestedAt(2), 0);
  await paste(page, multiline);
  assert.deepEqual(await cellText(page, fixture.nested), ['Nested first', 'Nested second', 'Nested first', 'Nested secondNested tail']);
  await page.evaluate(() => window.__inputHandler.performUndo());
  assert.deepEqual(await cellText(page, fixture.nested), ['Nested first', 'Nested second', 'Nested tail']);

  // Body text and external HTML must enter the intended cell without consuming siblings.
  await position(page, [], 0, { path: [], offset: 4 });
  const body = await copy(page);
  assert.equal(body.text, 'BODY');
  await position(page, fixture.nested, 0);
  await paste(page, body);
  assert.equal((await cellText(page, fixture.nested))[0], 'BODYNested first');
  await page.evaluate(() => window.__inputHandler.performUndo());
  await position(page, fixture.nested, 0);
  await paste(page, { text: 'External\nHTML', html: '<p><strong>External</strong></p><p>HTML</p>' });
  assert.deepEqual(await cellText(page, fixture.nested), ['External', 'HTMLNested first', 'Nested second', 'Nested tail']);
  assert.deepEqual(await cellText(page, fixture.sibling), ['SIBLING']);
  await page.evaluate(() => window.__inputHandler.performUndo());

  // A selected range containing both an equation and image stays a range on paste.
  const imageBytes = await page.evaluate(path => {
    const w = window.__wasm;
    const eq = w.insertEquationInCellByPath(0, 0, path, 6, 'x^2 + y^2', 1000, 0);
    if (!eq.ok) throw Error('equation setup failed');
    const lastPath = path.map(entry => ({ ...entry })); lastPath.at(-1).cellParaIndex = 2;
    if (!w.insertEquationInCellByPath(0, 0, lastPath, 6, 'z^2', 1000, 0).ok) throw Error('last paragraph equation setup failed');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 12;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#287cbb'; ctx.fillRect(0, 0, 12, 12);
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const pic = w.insertPicture(0, 0, 7, JSON.stringify(path), bytes, 1400, 1400, 12, 12, 'png', 'clipboard identity', undefined, undefined, 'inline');
    if (!pic.ok) throw Error('image setup failed');
    window.__eventBus.emit('document-changed');
    window.__inputHandler.history.clear(w);
    return Array.from(bytes);
  }, fixture.nested);
  await position(page, fixture.nested, 0);
  assert.equal(await page.evaluate(() => window.__inputHandler.cursor.selectAllInCurrentCell()), true);
  const wholeCell = await copy(page);
  assert.equal(wholeCell.text, 'Nested first\nNested second\nNested tail', 'select all includes text after inline objects in the last paragraph');
  await position(page, fixture.nested, 0, { path: nestedAt(1), offset: 13 });
  const mixed = await copy(page);
  assert.equal(mixed.text, 'Nested first\nNested second');
  await position(page, fixture.target, 0);
  await paste(page, mixed);
  assert.deepEqual(await cellText(page, fixture.target), ['Nested first', 'Nested secondTARGET']);
  const objects = await page.evaluate(path => {
    const w = window.__wasm;
    return { equation: w.getEquationPropertiesByPath(0, 0, path, 0),
      image: Array.from(w.getControlImageData(0, 0, 1, JSON.stringify(path))) };
  }, fixture.target);
  assert.equal(objects.equation.script, 'x^2 + y^2');
  assert.deepEqual(objects.image, imageBytes);
  assert.deepEqual(await cellText(page, fixture.sibling), ['SIBLING']);
  await screenshot(page, 'table-clipboard-mixed-paste');
  await page.evaluate(() => window.__inputHandler.performUndo());
  assert.deepEqual(await cellText(page, fixture.target), ['TARGET']);
  await page.evaluate(() => window.__inputHandler.performRedo());
  assert.deepEqual(await cellText(page, fixture.target), ['Nested first', 'Nested secondTARGET']);

  // The same mixed selection must retain the second paragraph when pasted into body.
  await position(page, [], 0);
  await paste(page, mixed);
  const bodyAfter = await page.evaluate(() => Array.from({ length: window.__wasm.getParagraphCount(0) }, (_, i) => window.__wasm.getTextRange(0, i, 0, 10000)));
  assert.ok(bodyAfter.includes('Nested first'));
  assert.ok(bodyAfter.includes('Nested secondBODY'));
  await page.evaluate(() => window.__inputHandler.performUndo());
  await page.evaluate(() => window.__inputHandler.performUndo());
  assert.deepEqual(await cellText(page, fixture.target), ['TARGET']);

  // Copy the selected nested table itself, rather than its outer 2 x 2 table.
  console.log('Checking selected nested table');
  await position(page, fixture.nested, 0);
  const tablePayload = await page.evaluate(() => {
    const ih = window.__inputHandler;
    if (!ih.cursor.enterTableObjectSelection()) throw Error('table selection failed');
    ih.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    ih.cursor.exitTableObjectSelection();
    return { text: window.__wasm.getClipboardText(), html: `<!--rhwp-studio-clipboard:${ih.rhwpClipboardToken}-->` };
  });
  assert.equal(tablePayload.text, '[표]');
  await position(page, fixture.target, 0);
  await paste(page, tablePayload);
  assert.deepEqual(await cellText(page, [...fixture.target, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }]), ['Nested first', 'Nested second', 'Nested tail']);
  assert.deepEqual(await cellText(page, fixture.target), ['TARGET']);
  assert.deepEqual(await cellText(page, fixture.sibling), ['SIBLING']);
  await page.evaluate(() => window.__inputHandler.performUndo());

  console.log('Selected nested table passed');
  for (const [type, controlIndex] of [['image', 1], ['equation', 0]]) {
    await position(page, fixture.nested, 0);
    await page.evaluate(({ path, type, controlIndex }) => {
      window.__inputHandler.cursor.enterPictureObjectSelectionRef({ sec: 0, ppi: 0, ci: controlIndex, type, cellPath: path });
    }, { path: fixture.nested, type, controlIndex });
    const objectPayload = await copy(page);
    await page.evaluate(() => window.__inputHandler.cursor.moveOutOfSelectedPicture());
    await position(page, fixture.target, 0);
    await paste(page, objectPayload);
    const value = await page.evaluate(({ path, type }) => {
      const w = window.__wasm;
      return type === 'image' ? Array.from(w.getControlImageData(0, 0, 0, JSON.stringify(path)))
        : w.getEquationPropertiesByPath(0, 0, path, 0).script;
    }, { path: fixture.target, type });
    assert.deepEqual(value, type === 'image' ? imageBytes : 'x^2 + y^2');
    assert.deepEqual(await cellText(page, fixture.target), ['TARGET']);
    await page.evaluate(() => window.__inputHandler.performUndo());
  }
  await position(page, fixture.nested, 0);
  await page.evaluate(path => window.__inputHandler.cursor.enterPictureObjectSelectionRef({
    sec: 0, ppi: 0, ci: 0, type: 'equation', cellPath: path,
  }), fixture.nested);
  const equationPayload = await copy(page);
  await page.evaluate(() => window.__inputHandler.cursor.moveOutOfSelectedPicture());
  const paragraphCount = await page.evaluate(() => window.__wasm.getParagraphCount(0));
  await position(page, [], 2);
  await paste(page, equationPayload);
  assert.equal(await page.evaluate(() => window.__wasm.getTextRange(0, 2, 0, 10000)), 'BODY');
  assert.equal(await page.evaluate(() => window.__wasm.getParagraphCount(0)), paragraphCount);
  assert.equal(await page.evaluate(() => window.__wasm.getEquationProperties(0, 2, 0).script), 'x^2 + y^2');
  const tailHit = await page.evaluate(() => {
    const w = window.__wasm;
    const runs = [];
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'textRun') runs.push(node);
      for (const child of Object.values(node)) walk(child);
    };
    walk(w.getPageLayerTreeObject(0).root);
    const tail = runs.find(run => run.text === 'DY');
    if (!tail) throw Error('inline equation suffix did not render');
    return w.hitTest(0, tail.bbox.x + 1, tail.bbox.y + tail.bbox.height / 2);
  });
  await position(page, [], tailHit.charOffset, { path: [], offset: tailHit.charOffset + 2 });
  const tail = await copy(page);
  assert.equal(tail.text, 'DY', 'copy after an inline object uses the same offsets as hit testing');
  await position(page, fixture.target, 0);
  await paste(page, tail);
  assert.deepEqual(await cellText(page, fixture.target), ['DYTARGET']);
  console.log('PASS nested objects, nested text, multiline, body-to-cell, HTML, equations/images, cell-to-body, undo/redo');
});
