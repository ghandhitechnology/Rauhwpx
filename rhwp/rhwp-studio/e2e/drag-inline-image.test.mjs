/**
 * E2E 테스트: 인라인(글자처럼 취급) 그림 마우스 드래그 이동
 *
 * tac 그림을 개체 선택한 뒤 본체를 mousedown → mousemove → mouseup 로 드래그하면:
 *  1. 그림 컨트롤이 드롭 지점의 문단으로 이동해야 하고 (movePictureControl)
 *  2. undo 하면 원본 문단·원본 컨트롤 인덱스로 복원되어야 하고
 *  3. redo 하면 다시 이동된 자리에 있어야 한다 (커맨드 재실행 계약).
 *
 * 실행: node e2e/drag-inline-image.test.mjs --mode=headless
 * (dev server 7700 필요. helpers 는 WSL2 Chrome 경로 기본값을 쓰므로 macOS 에서는
 *   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 지정.)
 */
import { runTest, createNewDocument, assert, screenshot } from './helpers.mjs';

process.env.VITE_URL = process.env.VITE_URL || 'http://localhost:7700';

const wait = (page, ms = 350) => page.evaluate(
  (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  ms,
);

// 1x1 투명 PNG
const PNG_1PX = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
  8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255,
  255, 63, 0, 5, 254, 2, 254, 220, 204, 89, 231, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

/** 텍스트 3 문단 + 문단 0 끝에 tac 그림 삽입 (wasm 직접 호출 — 히스토리에 기록하지 않음). */
async function setupDocument(page) {
  return page.evaluate((png) => {
    const wasm = window.__wasm;
    wasm.insertText(0, 0, 0, 'Alpha line for inline picture drag');
    // 문단 끝 split → 새 문단은 항상 p+1 (빈 문서 기준 순차 편집이라 결정적).
    wasm.splitParagraph(0, 0, wasm.getParagraphLength(0, 0));
    wasm.insertText(0, 1, 0, 'Bravo line is the move target');
    wasm.splitParagraph(0, 1, wasm.getParagraphLength(0, 1));
    wasm.insertText(0, 2, 0, 'Charlie line stays below');
    const ret = wasm.insertPicture(0, 0, 0, '[]', new Uint8Array(png), 9000, 6000, 100, 100, 'png', 'drag test', null, null);
    const info = typeof ret === 'string' ? JSON.parse(ret) : ret;
    wasm.setPictureProperties(0, info.paraIdx, info.controlIdx, { treatAsChar: true });
    window.__eventBus.emit('document-changed');
    return { ci: info.controlIdx };
  }, PNG_1PX);
}

/** 페이지 레이아웃에서 tac 그림의 (문단, 컨트롤 인덱스, bbox) 를 찾는다. */
async function collectImage(page) {
  return page.evaluate(() => {
    const wasm = window.__wasm;
    for (let p = 0; p < wasm.pageCount; p += 1) {
      const images = wasm.getPageControlLayout(p).controls.filter((c) => c.type === 'image');
      if (images.length > 0) {
        const img = images[0];
        return { page: p, paraIdx: img.paraIdx, controlIdx: img.controlIdx, x: img.x, y: img.y, w: img.w, h: img.h };
      }
    }
    return null;
  });
}

/** bbox/page 좌표를 스크롤 컨테이너 client 좌표로 바꾼다. */
async function toClient(page, pt) {
  return page.evaluate(({ x, y, pageIndex }) => {
    const ih = window.__inputHandler;
    const scrollContent = ih.container.querySelector('#scroll-content');
    const rect = scrollContent.getBoundingClientRect();
    const zoom = ih.viewportManager.getZoom();
    const pageLeft = ih.virtualScroll.getPageLeftResolved(pageIndex, scrollContent.clientWidth);
    const pageTop = ih.virtualScroll.getPageOffset(pageIndex);
    return { clientX: rect.left + pageLeft + x * zoom, clientY: rect.top + pageTop + y * zoom };
  }, pt);
}

await runTest('인라인 tac 그림 마우스 드래그 이동 + undo/redo', async ({ page }) => {
  await createNewDocument(page);
  await setupDocument(page);
  await wait(page, 800);

  const before = await collectImage(page);
  assert(before, 'tac 그림이 레이아웃에 존재해야 함');
  assert(before.paraIdx === 0, `삽입 문단은 0 이어야 함 (got ${before.paraIdx})`);

  // 1) 클릭으로 개체 선택 (실제 경로 — findPictureAtClick)
  const center = await toClient(page, { x: before.x + before.w / 2, y: before.y + before.h / 2, pageIndex: before.page });
  await page.mouse.click(center.clientX, center.clientY);
  await wait(page, 300);
  assert(JSON.stringify(await collectImage(page)) === JSON.stringify(before),
    '선택 클릭만으로 그림의 위치나 소속 문단이 바뀌면 안 됨');
  assert(
    await page.evaluate(() => window.__inputHandler.isInPictureObjectSelection()),
    '그림 클릭 후 개체 선택 상태여야 함',
  );

  // 2) 문단 2 텍스트 위로 드래그 (mousedown → 이동 → mouseup)
  // 선택 클릭과 다른 지점(bbox 좌측)에서 눌러 detail=2 (더블클릭) 로 해석되지 않게 한다.
  const dragFrom = await toClient(page, { x: before.x + Math.min(8, before.w * 0.2), y: before.y + before.h / 2, pageIndex: before.page });
  const caret = await page.evaluate(() => {
    const rect = window.__wasm.getCursorRect(0, 2, 4);
    return { x: rect.x, y: rect.y, pageIndex: rect.pageIndex };
  });
  const drop = await toClient(page, { x: caret.x, y: caret.y, pageIndex: caret.pageIndex });

  await page.mouse.move(dragFrom.clientX, dragFrom.clientY);
  await page.mouse.down();
  await page.mouse.move(center.clientX + (drop.clientX - center.clientX) * 0.4, center.clientY + (drop.clientY - center.clientY) * 0.4, { steps: 5 });
  await page.mouse.move(center.clientX + (drop.clientX - center.clientX) * 0.7, center.clientY + (drop.clientY - center.clientY) * 0.7, { steps: 5 });
  await page.mouse.move(drop.clientX, drop.clientY, { steps: 5 });
  await page.mouse.up();
  await wait(page, 700);

  const after = await collectImage(page);
  await screenshot(page, 'drag-inline-image-moved');
  assert(after, '이동 후에도 그림이 레이아웃에 존재해야 함');
  assert(
    after.paraIdx === 2,
    `드롭 문단으로 이동해야 함 (expected 2, got ${after.paraIdx})`,
  );

  // 3) undo → 원본 문단·컨트롤 인덱스 복원
  await page.evaluate(() => window.__inputHandler.performUndo());
  await wait(page, 700);
  const undone = await collectImage(page);
  await screenshot(page, 'drag-inline-image-undo');
  assert(undone, 'undo 후 그림이 존재해야 함');
  assert(
    undone.paraIdx === 0 && undone.controlIdx === before.controlIdx,
    `undo 는 원본 (문단 0, ci=${before.controlIdx}) 로 복원해야 함 (got ppi=${undone.paraIdx}, ci=${undone.controlIdx})`,
  );

  // 4) redo → 다시 드롭 문단으로 (커맨드 재실행 계약)
  await page.evaluate(() => window.__inputHandler.performRedo());
  await wait(page, 700);
  const redone = await collectImage(page);
  assert(redone, 'redo 후 그림이 존재해야 함');
  assert(
    redone.paraIdx === 2,
    `redo 는 다시 문단 2 로 이동해야 함 (got ${redone.paraIdx})`,
  );
});
