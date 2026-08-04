/**
 * 진단: 에이전트 사이드바 inset 과 용지 가운데 정렬.
 *
 * 핵심 재현: 사이드바 inset 이 적용된 직후(ResizeObserver 콜백 전) 문서를 로드하면
 * CanvasView 가 stale viewport 폭으로 가운데 정렬을 계산해 용지가 어긋난다.
 *
 * 실행:
 *   VITE_URL=http://127.0.0.1:7701 \
 *   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *   node e2e/agent-sidebar-center.check.mjs --mode=headless
 */
import { runTest, createNewDocument } from './helpers.mjs';

async function measure(page) {
  return await page.evaluate(() => {
    const container = document.getElementById('scroll-container');
    const canvas = document.querySelector('#scroll-content canvas');
    const cr = container.getBoundingClientRect();
    const kr = canvas.getBoundingClientRect();
    return {
      offset: (kr.left + kr.width / 2) - (cr.left + cr.width / 2),
      containerWidth: cr.width,
      canvasWidth: kr.width,
      styleLeft: canvas.style.left,
      scrollLeft: Math.round(container.scrollLeft),
    };
  });
}

const fmt = (m) => `off=${m.offset.toFixed(1)} vp=${m.containerWidth} page=${m.canvasWidth.toFixed(0)} left=${m.styleLeft} sl=${m.scrollLeft}`;

await runTest('agent sidebar center diagnostic', async ({ page }) => {
  await page.setViewport({ width: 1680, height: 1000, deviceScaleFactor: 1 });
  await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
  await createNewDocument(page);

  console.log(`\n[settled, sidebar open] ${fmt(await measure(page))}`);

  // ── 재현 A: inset 변경과 같은 태스크에서 문서 재로드 (ResizeObserver 이전) ──
  await page.evaluate(async () => {
    document.body.classList.remove('ag-sidebar-open'); // 편집 영역 넓힘
    await window.__canvasView.loadDocument();          // stale 폭으로 중앙 계산
  });
  await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
  const raceWide = await measure(page);
  console.log(`[race: inset 제거 직후 로드] ${fmt(raceWide)}`);

  // ── 재현 B: 반대 방향 (좁아지는 즉시 로드) ──
  await page.evaluate(async () => {
    document.body.classList.add('ag-sidebar-open'); // 편집 영역 좁힘
    await window.__canvasView.loadDocument();
  });
  await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
  const raceNarrow = await measure(page);
  console.log(`[race: inset 추가 직후 로드] ${fmt(raceNarrow)}`);

  // ── 토글 경로 (정상 동작 확인용) ──
  await page.click('.ag-collapse-tab');
  await page.evaluate(() => new Promise(r => setTimeout(r, 900)));
  const closed = await measure(page);
  console.log(`[toggle closed] ${fmt(closed)}`);
  await page.click('.ag-collapse-tab');
  await page.evaluate(() => new Promise(r => setTimeout(r, 900)));
  const reopened = await measure(page);
  console.log(`[toggle reopened] ${fmt(reopened)}`);

  console.log('\n=== |offset| > 1px 이면 어긋남 ===');
  for (const [label, m] of [
    ['race wide', raceWide],
    ['race narrow', raceNarrow],
    ['toggle closed', closed],
    ['toggle reopened', reopened],
  ]) {
    const bad = Math.abs(m.offset) > 1;
    console.log(`   ${bad ? 'FAIL' : 'ok  '} ${label}: ${m.offset.toFixed(1)}`);
  }
});
