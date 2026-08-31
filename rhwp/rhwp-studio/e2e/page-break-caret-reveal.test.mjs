/**
 * Cmd/Ctrl+Enter 쪽 나누기 뒤 새 쪽 캐럿과 편집 영역 viewport가 함께 이동하는 회귀.
 *
 * Rauhwpx 캐럿은 style.top 이 아니라 transform translate3d 로 배치된다.
 * 기존 helpers.mjs runTest 하네스를 쓰며, 전용 vite 러너는 추가하지 않는다.
 */
import {
  runTest,
  createNewDocument,
  clickEditArea,
  typeText,
  assert,
} from './helpers.mjs';

async function pressCommandEnter(page) {
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
}

runTest('쪽 나누기 캐럿·viewport 추종', async ({ page }) => {
  await createNewDocument(page);
  await clickEditArea(page);
  await typeText(page, '쪽 나누기 앞');

  const prepared = await page.evaluate(() => {
    const input = window.__inputHandler;
    const container = document.getElementById('scroll-container');
    const length = window.__wasm?.getParagraphLength(0, 0) ?? 0;
    input.viewportManager.setZoom(1.5);
    input.viewportManager.setScrollTop(0);
    const moved = input.moveCursorTo({
      sectionIndex: 0,
      paragraphIndex: 0,
      charOffset: length,
    });
    return {
      moved,
      wasmPageCount: window.__wasm?.pageCount ?? 0,
      virtualPageCount: input.virtualScroll.pageCount,
      scrollTop: container?.scrollTop ?? -1,
    };
  });
  assert(prepared.moved, '쪽 나누기 전 첫 문단 끝에 커서 배치');
  assert(prepared.wasmPageCount === 1 && prepared.virtualPageCount === 1,
    `한 쪽 fixture 준비 (${prepared.wasmPageCount}/${prepared.virtualPageCount})`);

  await pressCommandEnter(page);

  await page.waitForFunction(() => {
    const input = window.__inputHandler;
    const rect = input?.cursor?.getRect?.();
    const container = document.getElementById('scroll-container');
    const pageOffset = typeof rect?.pageIndex === 'number'
      ? input?.virtualScroll?.getPageOffset?.(rect.pageIndex) ?? 0
      : 0;
    return (window.__wasm?.pageCount ?? 0) === 2
      && input?.virtualScroll?.pageCount === 2
      && rect?.pageIndex === 1
      && pageOffset > 0
      && (container?.scrollTop ?? 0) > 0;
  }, { timeout: 10_000 });

  const state = await page.evaluate(() => {
    const input = window.__inputHandler;
    const rect = input.cursor.getRect();
    const pos = input.cursor.getPosition();
    const zoom = input.viewportManager.getZoom();
    const pageOffset = input.virtualScroll.getPageOffset(rect.pageIndex);
    const container = document.getElementById('scroll-container');
    const caret = document.querySelector('#scroll-content .caret');
    const transform = caret?.style.transform ?? '';
    const match = transform.match(/translate3d\(\s*[^,]+,\s*([^,]+)px/i);
    const caretTop = match ? Number.parseFloat(match[1]) : Number.NaN;
    const caretHeight = Number.parseFloat(caret?.style.height ?? 'NaN');
    return {
      pos,
      rect,
      pageOffset,
      caretTop,
      caretHeight,
      expectedCaretTop: pageOffset + rect.y * zoom,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      caretViewportTop: caretTop - container.scrollTop,
      caretViewportBottom: caretTop + caretHeight - container.scrollTop,
    };
  });

  assert(state.pos.paragraphIndex === 1 && state.pos.charOffset === 0,
    `커서가 새 문단 첫 위치로 이동 (${JSON.stringify(state.pos)})`);
  assert(state.rect.pageIndex === 1 && state.pageOffset > 0,
    `커서가 새 쪽 좌표를 소유 (page=${state.rect.pageIndex}, offset=${state.pageOffset})`);
  assert(Math.abs(state.caretTop - state.expectedCaretTop) < 1,
    `캐럿 DOM이 새 쪽 offset으로 재배치 (${state.caretTop} ≈ ${state.expectedCaretTop})`);
  assert(state.scrollTop > 0, `편집 영역이 새 쪽으로 스크롤 (${state.scrollTop})`);
  assert(state.caretViewportTop >= 19 && state.caretViewportBottom <= state.clientHeight - 19,
    `캐럿이 viewport 여백 안에 표시 (${state.caretViewportTop}..${state.caretViewportBottom}/${state.clientHeight})`);
});
