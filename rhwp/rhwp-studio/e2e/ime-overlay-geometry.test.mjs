/**
 * E2E 테스트: 한글 IME 조합 중 네이티브 preedit
 *
 * 배경:
 *   조합 글자를 브라우저 fillText 오버레이로 그리면 서체·메트릭·줄바꿈이
 *   확정 글자와 어긋난다. 조합 중에도 WASM 문서에 넣고 페이지 캔버스가
 *   그리게 한다. 글리프 캔버스/복제 띠는 없어야 한다.
 *
 * 검증:
 *   imeSetComposition 으로 '한' 을 조합하는 동안 문단 텍스트에 '한' 이 있고,
 *   글리프 오버레이 캔버스는 없으며, 확정 후에도 한 번만 남는다.
 *
 * 사전 조건: WASM 빌드(pkg/) + Vite dev server(7700)
 * 실행: node e2e/ime-overlay-geometry.test.mjs --mode=headless
 */
import {
  runTest, createNewDocument, clickEditArea, typeText, moveCursorTo, getParaText, assert,
} from './helpers.mjs';

async function compositionState(page) {
  return page.evaluate(() => {
    const ih = window.__inputHandler;
    const pick = (el) => {
      if (!el) return null;
      return { display: el.style.display, tag: el.tagName };
    };
    return {
      preedit: ih?.imeSession?.preedit ?? '',
      composing: ih?.imeSession?.isComposing === true,
      length: ih?.compositionLength ?? 0,
      glyphCanvas: document.querySelector('#scroll-content canvas.caret-composition'),
      flowCanvas: document.querySelector('#scroll-content .caret-composition-flow'),
      underline: pick(ih?.caret?.underlineEl),
    };
  });
}

runTest('IME 조합 네이티브 preedit', async ({ page }) => {
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

  const mid = await compositionState(page);
  const midText = await getParaText(page, 0, 0, 100);
  assert(mid.preedit === '한', `조합 중 preedit가 '한'이다 (실제 "${mid.preedit}")`);
  assert(mid.composing === true, '조합 세션이 열려 있다');
  assert(mid.length === 1, `조합 길이가 1 scalar 이다 (실제 ${mid.length})`);
  assert(midText.includes('한'), `조합 중 문단 텍스트에 네이티브 preedit이 있다 (실제 ${JSON.stringify(midText)})`);
  assert(!mid.glyphCanvas, '글리프 오버레이 캔버스가 없다');
  assert(!mid.flowCanvas, '줄 꼬리 복제 띠가 없다');

  await page.evaluate(() => window.__canvasView.refreshPages?.());
  await new Promise((r) => setTimeout(r, 300));
  const repaintText = await getParaText(page, 0, 0, 100);
  assert(
    repaintText.includes('한'),
    `강제 재렌더 후에도 문단의 네이티브 preedit이 유지된다 (실제 ${JSON.stringify(repaintText)})`,
  );

  await client.send('Input.insertText', { text: '한' });
  await new Promise((r) => setTimeout(r, 300));
  const done = await compositionState(page);
  const doneText = await getParaText(page, 0, 0, 100);
  assert(done.composing === false, '확정 후 조합 세션이 닫힌다');
  assert(done.underline?.display === 'none' || !done.underline, '확정 후 조합 밑줄이 사라진다');
  const hanCount = [...doneText].filter((ch) => ch === '한').length;
  assert(hanCount === 1, `확정 후 '한' 이 한 번만 남는다 (실제 ${JSON.stringify(doneText)})`);
});
