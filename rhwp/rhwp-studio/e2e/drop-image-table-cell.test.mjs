/**
 * E2E 테스트: 표 셀 위 이미지 파일 드롭 (#1151 floating sibling 정합)
 *
 * 표 셀 위에 이미지 파일을 drop 하면:
 *  1. 그림이 페이지 레이아웃에서 사라지지 않고 실제로 렌더 대상으로 존재해야 하고
 *  2. 놓은 셀 영역 위에 배치되며 (floating sibling, #1151)
 *  3. tac=false · wrap=Square 유지되어야 한다 — drop 경로가 pasteImageFile 경로와
 *     다르게 treatAsChar 를 강제하면 그림이 레이아웃에서 사라지는 결함의 회귀 게이트.
 * 본문 (표 밖) drop 은 기존 동작 (글자처럼 취급, tac=true) 을 유지한다.
 *
 * 실행: npm run e2e:drop-table-picture   (dev server 7700 필요, headless)
 */
import { runTest, createNewDocument, assert, screenshot } from './helpers.mjs';

process.env.VITE_URL = process.env.VITE_URL || 'http://localhost:7700';

const wait = (page, ms = 350) => page.evaluate(
  (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  ms,
);

/** 2×2 표 + 첫 셀 텍스트. */
async function createPopulatedTable(page) {
  return await page.evaluate(() => {
    const wasm = window.__wasm;
    const result = wasm.createTable(0, 0, 0, 2, 2);
    const table = typeof result === 'string' ? JSON.parse(result) : result;
    wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, 'AlphaBeta');
    window.__eventBus.emit('document-changed');
    return { parentParaIndex: table.paraIdx, controlIndex: table.controlIdx };
  });
}

/** 빨간 8×8 PNG File 이 담긴 DataTransfer 를 drop 이벤트로 #scroll-container 에 합성. */
async function dispatchImageDrop(page, clientX, clientY) {
  await page.evaluate(({ clientX, clientY }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 8, 8);
    const bin = atob(canvas.toDataURL('image/png').split(',')[1]);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const container = document.getElementById('scroll-container');
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperty(over, 'dataTransfer', { value: dt });
    container.dispatchEvent(over);
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    container.dispatchEvent(ev);
  }, { clientX, clientY });
}

/** [#1439] drop 확인 대화상자 [열기] 클릭. */
async function confirmDropDialog(page) {
  await page.waitForFunction(() => Boolean(document.querySelector('.modal-overlay')), { timeout: 3000 });
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('.modal-overlay .dialog-btn'));
    const button = buttons.find((btn) => (btn.textContent || '').trim() === '열기');
    if (!button) throw new Error('열기 버튼을 찾을 수 없습니다');
    button.click();
  });
  await page.waitForFunction(() => !document.querySelector('.modal-overlay'), { timeout: 3000 });
}

/** 셀/표 geometry 와 이미지 컨트롤 레이아웃 + 그림 속성을 수집한다. */
async function collectState(page) {
  return await page.evaluate(() => {
    const wasm = window.__wasm;
    const layout = wasm.getPageControlLayout(0).controls;
    const images = layout.filter((c) => c.type === 'image');
    const tables = layout.filter((c) => c.type === 'table');
    const props = images.length > 0
      ? wasm.getPictureProperties(0, images[0].paraIdx, images[0].controlIdx)
      : null;
    return { images, tables, props };
  });
}

await runTest('표 셀 위 이미지 드롭 — floating sibling 유지', async ({ page }) => {
  // TC-1: 셀 위 drop → 그림이 레이아웃에 존재 + 셀 영역 위 배치 + tac=false · wrap=Square
  await createNewDocument(page);
  const table = await createPopulatedTable(page);
  await wait(page);

  const point = await page.evaluate(({ parentParaIndex, controlIndex }) => {
    const ih = window.__inputHandler;
    const wasm = window.__wasm;
    const cells = wasm.getTableCellBboxes(0, parentParaIndex, controlIndex, 0);
    const cell = cells.find((c) => c.cellIdx === 0);
    if (!cell) return null;
    const scrollContent = ih.container.querySelector('#scroll-content');
    const rect = scrollContent.getBoundingClientRect();
    const zoom = ih.viewportManager.getZoom();
    const pageLeft = ih.virtualScroll.getPageLeftResolved(0, scrollContent.clientWidth);
    const pageTop = ih.virtualScroll.getPageOffset(0);
    return {
      clientX: rect.left + pageLeft + (cell.x + Math.min(24, cell.w / 3)) * zoom,
      clientY: rect.top + pageTop + (cell.y + Math.min(18, cell.h / 2)) * zoom,
      cellBbox: { x: cell.x, y: cell.y, w: cell.w, h: cell.h },
    };
  }, table);
  assert(point, '첫 셀 위 drop 지점을 계산할 수 있어야 함');

  await dispatchImageDrop(page, point.clientX, point.clientY);
  await confirmDropDialog(page);
  await wait(page, 1500);

  const cellDrop = await collectState(page);
  await screenshot(page, 'drop-image-table-cell');
  assert(cellDrop.images.length === 1, `셀 drop 뒤 그림이 레이아웃에 존재해야 함 (got ${cellDrop.images.length})`);
  const pic = cellDrop.images[0];
  const inCell =
    pic.x >= point.cellBbox.x - 1
    && pic.y >= point.cellBbox.y - 1
    && pic.x + pic.w <= point.cellBbox.x + point.cellBbox.w + 1
    && pic.y + pic.h <= point.cellBbox.y + point.cellBbox.h + 1;
  assert(inCell, `놓은 셀 영역 위에 배치되어야 함 (pic=(${pic.x},${pic.y},${pic.w},${pic.h}), cell=${JSON.stringify(point.cellBbox)})`);
  assert(cellDrop.props, '그림 속성을 읽을 수 있어야 함');
  assert(cellDrop.props.treatAsChar === false, `셀 그림은 글자처럼 취급하지 않아야 함 (tac=${cellDrop.props.treatAsChar})`);
  assert(cellDrop.props.textWrap === 'Square', `셀 그림 wrap=Square 이어야 함 (got ${cellDrop.props.textWrap})`);

  // TC-2: undo → 셀 drop 그림 제거 (snapshot 기록)
  await page.evaluate(() => window.__inputHandler.performUndo());
  await wait(page, 800);
  const afterUndo = await collectState(page);
  assert(afterUndo.images.length === 0, 'undo 후 셀 drop 그림이 제거되어야 함');

  // TC-3: 본문 (표 밖) drop → 기존 동작 유지 (그림 존재, tac=true)
  await createNewDocument(page);
  const bodyPoint = await page.evaluate(() => {
    const ih = window.__inputHandler;
    const scrollContent = ih.container.querySelector('#scroll-content');
    const rect = scrollContent.getBoundingClientRect();
    const zoom = ih.viewportManager.getZoom();
    const pageLeft = ih.virtualScroll.getPageLeftResolved(0, scrollContent.clientWidth);
    const pageTop = ih.virtualScroll.getPageOffset(0);
    return {
      clientX: rect.left + pageLeft + 120 * zoom,
      clientY: rect.top + pageTop + 150 * zoom,
    };
  });
  await dispatchImageDrop(page, bodyPoint.clientX, bodyPoint.clientY);
  await confirmDropDialog(page);
  await wait(page, 1500);
  const bodyDrop = await collectState(page);
  await screenshot(page, 'drop-image-body');
  assert(bodyDrop.images.length === 1, `본문 drop 뒤 그림이 존재해야 함 (got ${bodyDrop.images.length})`);
  assert(bodyDrop.props.treatAsChar === true, `본문 drop 그림은 글자처럼 취급 (tac=${bodyDrop.props.treatAsChar})`);
});
