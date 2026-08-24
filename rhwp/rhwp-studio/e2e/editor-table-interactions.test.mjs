import {
  runTest,
  createNewDocument,
  loadHwpFile,
  assert,
  screenshot,
} from './helpers.mjs';

const wait = (page, ms = 350) => page.evaluate(
  (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  ms,
);

async function createPopulatedTable(page) {
  return await page.evaluate(() => {
    const wasm = window.__wasm;
    const result = wasm.createTable(0, 0, 0, 2, 2);
    const table = typeof result === 'string' ? JSON.parse(result) : result;
    wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, 'AlphaBeta');
    wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, 1, 0, 0, 'Neighbor');
    window.__eventBus.emit('document-changed');
    return { parentParaIndex: table.paraIdx, controlIndex: table.controlIdx };
  });
}

async function firstCellPoint(page, table) {
  return await page.evaluate(({ parentParaIndex, controlIndex }) => {
    const ih = window.__inputHandler;
    const cells = window.__wasm.getTableCellBboxes(0, parentParaIndex, controlIndex, 0);
    const cell = cells.find((candidate) => candidate.cellIdx === 0);
    if (!cell) return null;

    const scrollContent = ih.container.querySelector('#scroll-content');
    const rect = scrollContent.getBoundingClientRect();
    const zoom = ih.viewportManager.getZoom();
    const pageLeft = ih.virtualScroll.getPageLeftResolved(0, scrollContent.clientWidth);
    const pageTop = ih.virtualScroll.getPageOffset(0);
    const clientX = rect.left + pageLeft + (cell.x + Math.min(24, cell.w / 3)) * zoom;
    const clientY = rect.top + pageTop + (cell.y + Math.min(18, cell.h / 2)) * zoom;
    const hit = window.__wasm.hitTest(
      0,
      (clientX - rect.left - pageLeft) / zoom,
      (clientY - rect.top - pageTop) / zoom,
    );
    return { clientX, clientY, hit };
  }, table);
}

function assertCellSelection(selection, table, expectedLength, label) {
  assert(selection?.anchor && selection?.focus, `${label} creates a text selection`);
  assert(
    selection.anchor.parentParaIndex === table.parentParaIndex
      && selection.focus.parentParaIndex === table.parentParaIndex
      && selection.anchor.controlIndex === table.controlIndex
      && selection.focus.controlIndex === table.controlIndex
      && selection.anchor.cellIndex === 0
      && selection.focus.cellIndex === 0,
    `${label} remains inside the first table cell`,
  );
  assert(
    selection.anchor.charOffset === 0 && selection.focus.charOffset === expectedLength,
    `${label} spans all cell text`,
  );
}

await runTest('table selection and paste without formatting', async ({ page }) => {
  const viewports = [
    { name: 'narrow', width: 1024, height: 768 },
    { name: 'default', width: 1280, height: 900 },
    { name: 'wide', width: 1680, height: 1000 },
  ];

  for (const viewport of viewports) {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => {
      const sidebar = document.querySelector('#agent-sidebar');
      if (sidebar && !sidebar.classList.contains('ag-collapsed')) {
        sidebar.querySelector('.ag-collapse-tab')?.click();
      }
    });
    await wait(page, 250);
    await createNewDocument(page);
    const table = await createPopulatedTable(page);
    await wait(page);

    const point = await firstCellPoint(page, table);
    assert(point?.hit?.cellIndex === 0, `${viewport.name} resolves an editable first-cell click target`);

    await page.mouse.move(point.clientX, point.clientY);
    await page.mouse.down({ clickCount: 3 });
    await page.mouse.up({ clickCount: 3 });
    await wait(page, 150);
    const tripleSelection = await page.evaluate(() => window.__inputHandler.cursor.getSelection());
    assertCellSelection(tripleSelection, table, 9, `${viewport.name} triple-click`);

    await page.mouse.click(point.clientX, point.clientY);
    await page.evaluate(() => window.__inputHandler.textarea.focus());
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await wait(page, 100);
    const shortcutSelection = await page.evaluate(() => window.__inputHandler.cursor.getSelection());
    assertCellSelection(shortcutSelection, table, 9, `${viewport.name} Ctrl+A`);

    await screenshot(page, `editor-table-selection-${viewport.name}`);
  }

  await createNewDocument(page);
  const table = await createPopulatedTable(page);
  await wait(page);
  const pasteResult = await page.evaluate(({ parentParaIndex, controlIndex }) => {
    const ih = window.__inputHandler;
    const wasm = window.__wasm;
    ih.cursor.clearSelection();
    ih.cursor.moveTo({
      sectionIndex: 0,
      paragraphIndex: 0,
      charOffset: 0,
      parentParaIndex,
      controlIndex,
      cellIndex: 1,
      cellParaIndex: 0,
      cellPath: [{ controlIndex, cellIndex: 1, cellParaIndex: 0 }],
    });
    ih.cursor.setAnchor();
    ih.cursor.moveTo({
      sectionIndex: 0,
      paragraphIndex: 0,
      charOffset: 8,
      parentParaIndex,
      controlIndex,
      cellIndex: 1,
      cellParaIndex: 0,
      cellPath: [{ controlIndex, cellIndex: 1, cellParaIndex: 0 }],
    });
    ih.active = true;
    ih.textarea.focus();

    let htmlPasteCalls = 0;
    const originalPasteHtml = wasm.pasteHtml;
    wasm.pasteHtml = (...args) => {
      htmlPasteCalls += 1;
      return originalPasteHtml.apply(wasm, args);
    };

    ih.textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    const data = new DataTransfer();
    data.setData('text/plain', 'Plain\rNext');
    data.setData('text/html', '<p><span style="font-family: serif; font-size: 36pt">Styled</span></p>');
    ih.textarea.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    }));
    wasm.pasteHtml = originalPasteHtml;

    const readCell = () => ({
      paraCount: wasm.getCellParagraphCount(0, parentParaIndex, controlIndex, 1),
      first: wasm.getTextInCell(0, parentParaIndex, controlIndex, 1, 0, 0, 100),
      second: wasm.getCellParagraphCount(0, parentParaIndex, controlIndex, 1) > 1
        ? wasm.getTextInCell(0, parentParaIndex, controlIndex, 1, 1, 0, 100)
        : '',
    });
    const pasted = readCell();
    ih.performUndo();
    const undone = readCell();
    ih.performRedo();
    const redone = readCell();
    return {
      htmlPasteCalls,
      pasted,
      undone,
      redone,
    };
  }, table);

  assert(pasteResult.htmlPasteCalls === 0, 'Ctrl+Shift+V bypasses the formatted HTML paste path');
  assert(pasteResult.pasted.paraCount === 2, 'plain multiline paste preserves cell paragraph boundaries');
  assert(pasteResult.pasted.first.includes('Plain'), 'plain paste replaces the selected text with the first line');
  assert(!pasteResult.pasted.first.includes('Neighbor'), 'plain paste removes the selected destination text');
  assert(pasteResult.pasted.second.includes('Next'), 'plain paste inserts the second line in a new cell paragraph');
  assert(
    pasteResult.undone.paraCount === 1 && pasteResult.undone.first.includes('Neighbor'),
    'one Undo restores the complete selection and all pasted paragraphs',
  );
  assert(
    pasteResult.redone.paraCount === 2
      && pasteResult.redone.first.includes('Plain')
      && pasteResult.redone.second.includes('Next'),
    'one Redo restores the complete plain-text paste',
  );
});

await runTest('image move and rotation use cursor-following previews', async ({ page }) => {
  await loadHwpFile(page, 'ta-pic-001-r.hwp');
  const result = await page.evaluate(async () => {
    const wasm = window.__wasm;
    const ih = window.__inputHandler;
    const cursor = ih.cursor;
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sameGeometry = (a, b) => (
      a.horzOffset === b.horzOffset
      && a.vertOffset === b.vertOffset
      && a.rotationAngle === b.rotationAngle
    );
    const findTarget = () => {
      for (let pageIndex = 0; pageIndex < wasm.pageCount; pageIndex += 1) {
        const control = wasm.getPageControlLayout(pageIndex).controls.find((candidate) => (
          candidate.type === 'image'
          && candidate.cellPath?.[0]?.controlIndex === 2
          && candidate.cellPath?.[0]?.cellIndex === 2
        ));
        if (control) return { pageIndex, control };
      }
      return null;
    };
    const target = findTarget();
    if (!target) return { error: 'rotated table-cell image not found' };

    const select = () => {
      cursor.enterPictureObjectSelectionDirect(
        0,
        0,
        0,
        'image',
        target.control.cellIdx,
        target.control.cellParaIdx,
        undefined,
        target.control.outerTableControlIdx,
        target.control.cellPath,
      );
      ih.renderPictureObjectSelection();
    };
    const props = () => wasm.getCellPicturePropertiesByPath(0, 0, target.control.cellPath, 0);
    const clientPoint = (pageIndex, pageX, pageY) => {
      const scrollContent = ih.container.querySelector('#scroll-content');
      const rect = scrollContent.getBoundingClientRect();
      const zoom = ih.viewportManager.getZoom();
      return {
        x: rect.left + ih.virtualScroll.getPageLeftResolved(pageIndex, scrollContent.clientWidth) + pageX * zoom,
        y: rect.top + ih.virtualScroll.getPageOffset(pageIndex) + pageY * zoom,
      };
    };
    const dispatch = (targetNode, type, x, y) => targetNode.dispatchEvent(new MouseEvent(type, {
      button: 0,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }));

    select();
    const moveBefore = props();
    const bbox = findTarget().control;
    const moveStart = clientPoint(target.pageIndex, bbox.x + bbox.w / 2, bbox.y + bbox.h / 2);
    dispatch(ih.container, 'mousedown', moveStart.x, moveStart.y);
    dispatch(document, 'mousemove', moveStart.x + 24, moveStart.y + 18);
    await nextFrame();
    const firstMovePreview = ih.pictureObjectRenderer.previewEl;
    const moveMid = props();
    dispatch(document, 'mousemove', moveStart.x + 42, moveStart.y + 28);
    await nextFrame();
    const movePreviewReused = firstMovePreview === ih.pictureObjectRenderer.previewEl;
    const movePreviewLeft = ih.pictureObjectRenderer.previewEl?.style.left ?? '';
    dispatch(document, 'mouseup', moveStart.x + 42, moveStart.y + 28);
    await nextFrame();
    const moveAfter = props();
    ih.handleUndo();
    await nextFrame();
    const moveUndo = props();

    select();
    const rotateBefore = props();
    const rotateHandle = ih.pictureObjectRenderer.handles.find((handle) => handle.dir === 'rotate');
    if (!rotateHandle) return { error: 'rotation handle not found' };
    const scrollContent = ih.container.querySelector('#scroll-content');
    const scrollRect = scrollContent.getBoundingClientRect();
    const rotateStart = { x: scrollRect.left + rotateHandle.cx, y: scrollRect.top + rotateHandle.cy };
    dispatch(ih.container, 'mousedown', rotateStart.x, rotateStart.y);
    const rotateState = ih.pictureRotateState;
    if (!rotateState) return { error: 'rotation drag did not start' };
    const rotateEnd = {
      x: scrollRect.left + rotateState.centerX + 70,
      y: scrollRect.top + rotateState.centerY,
    };
    dispatch(document, 'mousemove', rotateEnd.x, rotateEnd.y);
    await nextFrame();
    const rotateMid = props();
    const rotatePreviewTransform = ih.pictureObjectRenderer.previewEl?.style.transform ?? '';
    dispatch(document, 'mouseup', rotateEnd.x, rotateEnd.y);
    await nextFrame();
    const rotateAfter = props();
    ih.handleUndo();
    await nextFrame();
    const rotateUndo = props();

    return {
      moveMidUnchanged: sameGeometry(moveBefore, moveMid),
      moveChangedOnRelease: !sameGeometry(moveBefore, moveAfter),
      moveUndoRestored: sameGeometry(moveBefore, moveUndo),
      movePreviewReused,
      movePreviewLeft,
      rotateMidUnchanged: sameGeometry(rotateBefore, rotateMid),
      rotateChangedOnRelease: rotateAfter.rotationAngle !== rotateBefore.rotationAngle,
      rotateUndoRestored: rotateUndo.rotationAngle === rotateBefore.rotationAngle,
      rotatePreviewTransform,
    };
  });

  assert(!result.error, result.error || 'image interaction setup succeeds');
  assert(result.moveMidUnchanged, 'image move does not mutate document geometry during pointer motion');
  assert(result.movePreviewReused, 'image move reuses one preview element across pointer frames');
  assert(result.movePreviewLeft, 'image move preview follows the pointer');
  assert(result.moveChangedOnRelease, 'image move applies final geometry on mouseup');
  assert(result.moveUndoRestored, 'image move remains undoable');
  assert(result.rotateMidUnchanged, 'image rotation does not mutate document geometry during pointer motion');
  assert(result.rotatePreviewTransform.includes('rotate('), 'image rotation preview follows the pointer angle');
  assert(result.rotateChangedOnRelease, 'image rotation applies the final angle on mouseup');
  assert(result.rotateUndoRestored, 'image rotation remains undoable');
  await screenshot(page, 'editor-image-preview-interactions');
});
