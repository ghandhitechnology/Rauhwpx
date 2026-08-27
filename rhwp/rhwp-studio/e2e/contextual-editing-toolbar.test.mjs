import {
  runTest,
  createNewDocument,
  assert,
  screenshot,
} from './helpers.mjs';

const wait = (page, ms = 200) => page.evaluate(
  (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  ms,
);

async function toolbarState(page) {
  return page.evaluate(() => {
    const toolbar = document.getElementById('icon-toolbar');
    const visibleMode = Array.from(toolbar.querySelectorAll('[data-toolbar-mode]'))
      .find((element) => getComputedStyle(element).display !== 'none');
    return {
      mode: toolbar.dataset.contextMode,
      visibleMode: visibleMode?.dataset.toolbarMode ?? null,
      visibleCommands: visibleMode
        ? Array.from(visibleMode.querySelectorAll('[data-cmd]')).map((button) => ({
            command: button.dataset.cmd,
            disabled: button.disabled,
          }))
        : [],
      collapsed: toolbar.classList.contains('collapsed'),
    };
  });
}

await runTest('Hancom-style contextual object and table toolbars', async ({ page }) => {
  await createNewDocument(page);
  assert((await toolbarState(page)).mode === 'default', 'new document begins with the default toolbar');

  const picture = await page.evaluate(() => {
    const png = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
      0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
      120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 220, 204, 89, 231, 0, 0, 0,
      0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]);
    const result = window.__wasm.insertPicture(
      0, 0, 0, '[]', png, 9000, 6000, 100, 100, 'png', 'toolbar-e2e', null, null,
    );
    const info = typeof result === 'string' ? JSON.parse(result) : result;
    const shape = window.__wasm.createShapeControl({
      sectionIdx: 0,
      paraIdx: 0,
      charOffset: 0,
      width: 6000,
      height: 4500,
      horzOffset: 12000,
      vertOffset: 100,
      shapeType: 'rectangle',
      textWrap: 'Square',
    });
    window.__inputHandler.cursor.enterPictureObjectSelectionDirect(
      0, info.paraIdx, info.controlIdx, 'image',
    );
    window.__eventBus.emit('picture-object-selection-changed', true);
    return { picture: info, shape };
  });
  await wait(page);

  const objectState = await toolbarState(page);
  assert(objectState.mode === 'object' && objectState.visibleMode === 'object', 'picture selection opens object tools');
  assert(!objectState.collapsed, 'picture selection expands a collapsed toolbar');
  assert(
    objectState.visibleCommands.some(({ command, disabled }) => command === 'insert:arrange-front' && !disabled),
    'object tools expose an enabled layer-order command for pictures',
  );
  assert(
    objectState.visibleCommands.some(({ command }) => command === 'insert:picture-props'),
    'object tools expose object properties',
  );
  assert(
    objectState.visibleCommands.some(({ command, disabled }) => command === 'insert:group-shapes' && disabled),
    'single-picture selection disables unsupported grouping',
  );
  await screenshot(page, 'contextual-toolbar-01-picture');

  const layerOrder = await page.evaluate(({ picture: selected, shape }) => {
    document.querySelector('[data-toolbar-mode="object"] [data-cmd="insert:arrange-front"]')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const controls = window.__wasm.getPageControlLayout(0).controls;
    const pictureControl = controls.find((control) => (
      control.type === 'image'
      && control.paraIdx === selected.paraIdx
      && control.controlIdx === selected.controlIdx
    ));
    const shapeControl = controls.find((control) => (
      control.type === 'shape'
      && control.paraIdx === shape.paraIdx
      && control.controlIdx === shape.controlIdx
    ));
    return { picture: pictureControl?.zOrder, shape: shapeControl?.zOrder };
  }, picture);
  assert(
    layerOrder.picture > layerOrder.shape,
    `picture arrange command crosses a shape layer (${JSON.stringify(layerOrder)})`,
  );

  await page.evaluate(({ picture: selected }) => {
    window.__eventBus.emit('picture-object-selection-changed', false);
    const result = window.__wasm.createTable(0, selected.paraIdx, 0, 2, 2);
    const table = typeof result === 'string' ? JSON.parse(result) : result;
    window.__inputHandler.cursor.enterTableObjectSelectionDirect(0, table.paraIdx, table.controlIdx);
    window.__eventBus.emit('table-object-selection-changed', true);
  }, picture);
  await wait(page);

  const tableState = await toolbarState(page);
  assert(tableState.mode === 'table' && tableState.visibleMode === 'table', 'table selection opens table tools');
  assert(!tableState.collapsed, 'table selection keeps the toolbar expanded');
  assert(
    tableState.visibleCommands.some(({ command }) => command === 'table:cell-props'),
    'table tools expose table and cell properties',
  );
  assert(
    tableState.visibleCommands.some(({ command }) => command === 'table:cell-merge'),
    'table tools expose structural cell editing',
  );
  await screenshot(page, 'contextual-toolbar-02-table');

  await createNewDocument(page);
  const replacementState = await page.evaluate(() => ({
    toolbarMode: document.getElementById('icon-toolbar')?.dataset.contextMode,
    pictureSelected: window.__inputHandler.isInPictureObjectSelection(),
    tableSelected: window.__inputHandler.isInTableObjectSelection(),
  }));
  assert(replacementState.toolbarMode === 'default', 'document replacement restores the default toolbar');
  assert(!replacementState.pictureSelected, 'document replacement clears the cursor picture reference');
  assert(!replacementState.tableSelected, 'document replacement clears the cursor table reference');
});
