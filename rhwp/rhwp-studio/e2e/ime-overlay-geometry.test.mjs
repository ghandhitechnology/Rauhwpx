/**
 * E2E 테스트: IME 조합 오버레이 기하 회귀 방지
 *
 * 배경:
 *   조합 띠(compFlowEl)는 #scroll-content 에 붙는 <canvas> 라서
 *   `#scroll-content canvas` 의 페이지 중앙 정렬 규칙(left:50% +
 *   translateX(-50%) + 용지 배경/그림자)을 그대로 물려받았다. 인라인
 *   left 는 이겼지만 transform 은 남아, 조합할 때마다 띠가 자기 폭의
 *   절반만큼 왼쪽으로 밀린 거대한 흰 막대로 그려졌다.
 *
 *   수정: caret-renderer.ts 가 compFlowEl 인라인 스타일로
 *   transform/background/box-shadow 를 무효화한다.
 *
 * 검증:
 *   조합 중 compEl(조합 글자 상자)과 compFlowEl(줄 꼬리 복제 띠)의
 *   왼쪽 모서리가 일치하고, 상자 높이가 줄 높이를 벗어나지 않으며,
 *   확정 후 두 요소가 모두 사라진다.
 *
 * 사전 조건: WASM 빌드(pkg/) + Vite dev server(7700)
 * 실행: node e2e/ime-overlay-geometry.test.mjs --mode=headless
 */
import {
  runTest, createNewDocument, clickEditArea, typeText, moveCursorTo, assert,
} from './helpers.mjs';

async function overlayState(page) {
  return page.evaluate(() => {
    const ih = window.__inputHandler;
    const pick = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        display: el.style.display,
        bcr: { x: r.x, y: r.y, w: r.width, h: r.height },
        transform: cs.transform,
        background: cs.backgroundColor,
      };
    };
    return {
      preedit: ih?.imeSession?.preedit ?? '',
      cursorRect: ih?.cursor?.getRect?.() ?? null,
      compEl: pick(ih?.caret?.compEl),
      compFlowEl: pick(ih?.caret?.compFlowEl),
    };
  });
}

runTest('IME 조합 오버레이 기하', async ({ page }) => {
  await createNewDocument(page);
  await clickEditArea(page);
  await typeText(page, 'test line abcdef');
  await new Promise((r) => setTimeout(r, 300));
  await moveCursorTo(page, 0, 0, 5);
  await page.evaluate(() => window.__inputHandler.textarea.focus());

  const client = await page.createCDPSession();
  for (const text of ['ㅎ', '하', '한']) {
    await client.send('Input.imeSetComposition', {
      text, selectionStart: text.length, selectionEnd: text.length,
    });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 200));

  const mid = await overlayState(page);
  assert(mid.preedit === '한', `조합 중 preedit가 '한'이다 (실제 "${mid.preedit}")`);
  assert(mid.compEl?.display === 'block', '조합 상자가 표시된다');
  assert(mid.compFlowEl?.display === 'block', '줄 꼬리 복제 띠가 표시된다');
  assert(
    Math.abs(mid.compFlowEl.bcr.x - mid.compEl.bcr.x) < 1,
    `조합 상자와 복제 띠의 왼쪽 모서리가 일치한다 (comp=${mid.compEl.bcr.x.toFixed(1)}, flow=${mid.compFlowEl.bcr.x.toFixed(1)})`,
  );
  assert(
    mid.compFlowEl.transform === 'none',
    `복제 띠에 페이지 중앙 정렬 transform이 걸리지 않는다 (실제 "${mid.compFlowEl.transform}")`,
  );
  assert(
    mid.compFlowEl.background === 'rgba(0, 0, 0, 0)',
    `복제 띠 배경이 투명하다 (실제 "${mid.compFlowEl.background}")`,
  );
  const lineH = mid.cursorRect?.height ?? 0;
  assert(
    lineH > 0 && mid.compEl.bcr.h <= lineH * 1.5 + 2,
    `조합 상자 높이가 줄 높이 수준이다 (상자=${mid.compEl.bcr.h.toFixed(1)}, 줄=${lineH.toFixed(1)})`,
  );

  // 조합 중 캔버스 강제 재렌더 뒤에도 기하가 유지된다
  await page.evaluate(() => window.__canvasView.refreshPages?.());
  await new Promise((r) => setTimeout(r, 300));
  const repaint = await overlayState(page);
  assert(
    repaint.compFlowEl?.display === 'block'
      && Math.abs(repaint.compFlowEl.bcr.x - repaint.compEl.bcr.x) < 1,
    '강제 재렌더 후에도 오버레이 정렬이 유지된다',
  );

  await client.send('Input.insertText', { text: '한' });
  await new Promise((r) => setTimeout(r, 300));
  const done = await overlayState(page);
  assert(done.compEl?.display === 'none', '확정 후 조합 상자가 사라진다');
  assert(done.compFlowEl?.display === 'none', '확정 후 복제 띠가 사라진다');
});
