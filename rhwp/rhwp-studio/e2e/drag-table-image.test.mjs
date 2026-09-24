/** Real mouse drag of a picture between table cells, including history. */
import { runTest, createNewDocument, assert, screenshot } from './helpers.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

process.env.VITE_URL = process.env.VITE_URL || 'http://localhost:7700';

const pause = (page, ms = 300) => page.evaluate(
  (duration) => new Promise((resolve) => setTimeout(resolve, duration)), ms,
);

async function setupTable(page) {
  return page.evaluate(() => {
    const wasm = window.__wasm;
    const table = wasm.createTable(0, 0, 0, 2, 2);
    for (const [cell, text] of ['Alpha', 'Bravo', 'Charlie', 'Delta'].entries()) {
      wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, cell, 0, 0, text);
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const context = canvas.getContext('2d');
    context.fillStyle = '#d92525';
    context.fillRect(0, 0, 16, 16);
    const binary = atob(canvas.toDataURL('image/png').split(',')[1]);
    const png = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const cellPath = [{ controlIndex: table.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
    const inserted = wasm.insertPicture(
      0, table.paraIdx, 0, JSON.stringify(cellPath), png,
      9000, 6000, 16, 16, 'png', 'table drag identity',
      undefined, undefined, 'inline',
    );
    if (!inserted.ok) throw new Error(`picture insert failed: ${JSON.stringify(inserted)}`);
    window.__eventBus.emit('document-changed');
    return table;
  });
}

async function collectState(page, table) {
  return page.evaluate(({ paraIdx, controlIdx }) => {
    const wasm = window.__wasm;
    const images = [];
    for (let page = 0; page < wasm.pageCount; page += 1) {
      for (const control of wasm.getPageControlLayout(page).controls) {
        if (control.type !== 'image') continue;
        const data = wasm.getControlImageData(0, paraIdx, control.controlIdx, JSON.stringify(control.cellPath));
        images.push({
          page, x: control.x, y: control.y, w: control.w, h: control.h,
          cellPath: control.cellPath, bytes: Array.from(data),
        });
      }
    }
    const texts = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((_, cell) => {
      const length = wasm.getCellParagraphLength(0, paraIdx, controlIdx, cell, 0);
      return wasm.getTextInCell(0, paraIdx, controlIdx, cell, 0, 0, length);
    });
    const cells = wasm.getTableCellBboxes(0, paraIdx, controlIdx, 0);
    return { images, texts, cells };
  }, table);
}

async function clientPoint(page, point) {
  return page.evaluate(({ pageIndex, x, y }) => {
    const ih = window.__inputHandler;
    const content = ih.container.querySelector('#scroll-content');
    const rect = content.getBoundingClientRect();
    const zoom = ih.viewportManager.getZoom();
    return {
      x: rect.left + ih.virtualScroll.getPageLeftResolved(pageIndex, content.clientWidth) + x * zoom,
      y: rect.top + ih.virtualScroll.getPageOffset(pageIndex) + y * zoom,
    };
  }, point);
}

async function dragToCell(page, table, image, targetCell) {
  // Press the picture directly; a preliminary selection click must not be required.
  const from = await clientPoint(page, {
    pageIndex: image.page, x: image.x + image.w / 2, y: image.y + image.h / 2,
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Selecting a picture can reveal the contextual toolbar and shift the editor.
  // Aim at the cell center in its visible position after that shift.
  await pause(page, 80);
  const cell = await page.evaluate(({ paraIdx, controlIdx, targetCell }) => (
    window.__wasm.getTableCellBboxes(0, paraIdx, controlIdx, 0)
      .find((candidate) => candidate.cellIdx === targetCell)
  ), { ...table, targetCell });
  assert(cell, `cell ${targetCell} has a visible bbox`);
  const to = await clientPoint(page, {
    pageIndex: 0, x: cell.x + cell.w / 2, y: cell.y + cell.h / 2,
  });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  const pointerInCell = await page.evaluate(({ table, targetCell, to }) => {
    const ih = window.__inputHandler;
    const content = ih.container.querySelector('#scroll-content');
    const rect = content.getBoundingClientRect();
    const zoom = ih.viewportManager.getZoom();
    const x = (to.x - rect.left - ih.virtualScroll.getPageLeftResolved(0, content.clientWidth)) / zoom;
    const y = (to.y - rect.top - ih.virtualScroll.getPageOffset(0)) / zoom;
    const box = window.__wasm.getTableCellBboxes(0, table.paraIdx, table.controlIdx, 0)
      .find((candidate) => candidate.cellIdx === targetCell);
    return { x, y, box, inside: !!box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h };
  }, { table, targetCell, to });
  assert(pointerInCell.inside,
    `drop pointer stays inside visible cell ${targetCell} before release (${JSON.stringify(pointerInCell)})`);
  await page.mouse.up();
  await pause(page, 350);
}

function expectImageInCell(state, cell, expectedBytes, label) {
  assert(state.images.length === 1, `${label}: exactly one image remains (got ${state.images.length})`);
  assert(state.images[0].cellPath?.[0]?.cellIndex === cell,
    `${label}: expected cell ${cell}, got ${JSON.stringify(state.images[0].cellPath)}`);
  const box = state.cells.find((candidate) => candidate.cellIdx === cell);
  assert(box, `${label}: owning cell has a bbox`);
  if (box) {
    const image = state.images[0];
    const contained = image.x >= box.x - 1 && image.y >= box.y - 1
      && image.x + image.w <= box.x + box.w + 1
      && image.y + image.h <= box.y + box.h + 1;
    const bounds = (({ x, y, w, h }) => ({ x, y, w, h }));
    assert(contained, `${label}: image bbox lies within cell ${cell} (image=${JSON.stringify(bounds(image))}, cell=${JSON.stringify(bounds(box))})`);
  }
  assert(JSON.stringify(state.images[0].bytes) === JSON.stringify(expectedBytes),
    `${label}: the original PNG bytes remain attached to the image`);
  assert(JSON.stringify(state.texts) === JSON.stringify(['Alpha', 'Bravo', 'Charlie', 'Delta']),
    `${label}: all table cell text remains intact (got ${JSON.stringify(state.texts)})`);
}

async function recordDrag(page, label, drag) {
  const dir = process.env.DRAG_TABLE_IMAGE_RECORD_DIR;
  if (!dir) return drag();
  const frames = path.join(dir, `${label}-frames`);
  await mkdir(frames, { recursive: true });
  const cdp = await page.createCDPSession();
  const writes = [];
  const frameTimes = [];
  let index = 0;
  cdp.on('Page.screencastFrame', (frame) => {
    const filename = path.join(frames, `frame-${String(index++).padStart(5, '0')}.jpg`);
    frameTimes.push(frame.metadata.timestamp);
    writes.push(writeFile(filename, Buffer.from(frame.data, 'base64')));
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 78, everyNthFrame: 1 });
  try {
    await drag();
  } finally {
    await cdp.send('Page.stopScreencast');
    await Promise.all(writes);
    await cdp.detach();
    if (index > 0) {
      const output = path.join(dir, `${label}.mp4`);
      const manifest = path.join(frames, 'frames.txt');
      const entries = frameTimes.map((time, i) => {
        const filename = `frame-${String(i).padStart(5, '0')}.jpg`;
        const duration = Math.max(0.025, (frameTimes[i + 1] ?? time + 0.125) - time);
        return `file '${filename}'\nduration ${duration.toFixed(6)}`;
      });
      entries.push(`file 'frame-${String(index - 1).padStart(5, '0')}.jpg'`);
      await writeFile(manifest, `${entries.join('\n')}\n`);
      const encode = spawnSync('ffmpeg', [
        '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
        '-i', manifest, '-fps_mode', 'vfr',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output,
      ]);
      if (encode.status !== 0) throw new Error(`video encode failed: ${encode.stderr}`);
      console.log(`  Video: ${output}`);
    }
  }
}

await runTest('table image drag between cells and undo/redo', async ({ page }) => {
  await createNewDocument(page);
  const table = await setupTable(page);
  await pause(page, 500);
  const original = await collectState(page, table);
  assert(original.images.length === 1, 'setup image is rendered');
  const bytes = original.images[0].bytes;
  expectImageInCell(original, 0, bytes, 'setup');
  await screenshot(page, 'drag-table-image-before');

  await recordDrag(page, 'drag-table-image', () => dragToCell(page, table, original.images[0], 1));
  const moved = await collectState(page, table);
  await screenshot(page, 'drag-table-image-after');
  expectImageInCell(moved, 1, bytes, 'first drag');

  await page.evaluate(() => window.__inputHandler.performUndo());
  await pause(page);
  expectImageInCell(await collectState(page, table), 0, bytes, 'undo');

  await page.evaluate(() => window.__inputHandler.performRedo());
  await pause(page);
  const redone = await collectState(page, table);
  expectImageInCell(redone, 1, bytes, 'redo');

  await dragToCell(page, table, redone.images[0], 2);
  expectImageInCell(await collectState(page, table), 2, bytes, 'second-row drag');
});
