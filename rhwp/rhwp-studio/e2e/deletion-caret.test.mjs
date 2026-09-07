/**
 * 삭제 결과와 캐럿은 첫 프레임부터 같은 위치에 있어야 한다.
 * 실행: node e2e/deletion-caret.test.mjs --mode=headless
 */
import {
  runTest, createNewDocument, getParaText, getParagraphCount, screenshot, assert,
} from './helpers.mjs';

async function frames(page, count = 5) {
  await page.evaluate(count => new Promise(resolve => {
    const next = () => --count > 0 ? requestAnimationFrame(next) : resolve();
    requestAnimationFrame(next);
  }), count);
}

async function prepare(page, text) {
  await createNewDocument(page);
  await page.evaluate(() => window.__inputHandler.focus());
  await page.keyboard.sendCharacter(text);
  await frames(page);
  assert(await getParaText(page, 0, 0, 1000) === text, '삭제 전 입력한 문자열이 정확하다');
  await page.evaluate(() => { window.__deletionSamples = []; });
}

async function assertCaretAligned(page, label) {
  await frames(page);
  const samples = await page.evaluate(() => window.__deletionSamples);
  assert(samples.length > 0, `${label}: 삭제 키 이후 표시 프레임을 관측했다`);
  const lag = Math.max(...samples.map(sample => sample.lag));
  assert(lag < 0.01, `${label}: 캐럿이 즉시 도착한다 (최대 오차 ${lag.toFixed(4)}px)`);
  assert(samples.every(sample => sample.transition === '0s'), `${label}: 삭제 이동 보간이 없다`);
  assert(samples.every(sample => sample.opacity === '1'), `${label}: 삭제 중 캐럿이 깜박이지 않는다`);
}

async function chord(page, key) {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
}

await runTest('삭제 캐럿 프레임 정합', async ({ page }) => {
  await page.evaluate(() => {
    window.__deletionSamples = [];
    // 실제 화면 transform과 입력 핸들러가 지정한 최종 위치를 비교한다.
    document.addEventListener('keydown', event => {
      if (!['Backspace', 'Delete'].includes(event.key)) return;
      let remaining = 3;
      const sample = () => {
        const caret = document.querySelector('.caret');
        const style = getComputedStyle(caret);
        const actual = new DOMMatrix(style.transform);
        const target = new DOMMatrix(caret.style.transform);
        window.__deletionSamples.push({
          lag: Math.hypot(actual.m41 - target.m41, actual.m42 - target.m42),
          transition: style.transitionDuration,
          opacity: style.opacity,
        });
        if (--remaining > 0) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, true);
  });

  for (const width of [768, 1280, 1600]) {
    await page.setViewport({ width, height: 900 });
    for (const text of ['English deletion', '한글 지우기', 'English 한글삭제']) {
      await prepare(page, text);
      // 키를 놓지 않고 반복 전송하면 실제 repeat keydown이 발생한다.
      for (let i = 0; i < 5; i++) {
        await page.keyboard.down('Backspace');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      await page.keyboard.up('Backspace');
      assert(await getParaText(page, 0, 0, 1000) === text.slice(0, -5), `${width}px: 연속 삭제 결과가 정확하다`);
      await assertCaretAligned(page, `${width}px ${text}`);
      await chord(page, 'z');
      assert(await getParaText(page, 0, 0, 1000) === text, '연속 삭제를 한 번에 undo한다');
      await chord(page, 'y');
      assert(await getParaText(page, 0, 0, 1000) === text.slice(0, -5), 'redo가 같은 삭제 결과를 복원한다');
    }
  }

  await prepare(page, '앞 문단 English');
  await page.keyboard.press('Enter');
  await frames(page);
  await page.keyboard.press('Backspace');
  assert(await getParagraphCount(page) === 1, 'Backspace가 빈 다음 문단을 병합한다');
  await assertCaretAligned(page, '문단 병합');
  await screenshot(page, 'paragraph-merge');

  await prepare(page, '한글 English');
  await page.keyboard.press('Home');
  await frames(page);
  await page.keyboard.press('Delete');
  assert(await getParaText(page, 0, 0, 1000) === '글 English', 'Delete가 현재 위치의 글자를 지운다');
  await assertCaretAligned(page, '앞으로 삭제');

  await prepare(page, '한글 English');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Home');
  await page.keyboard.up('Shift');
  await frames(page);
  await page.keyboard.press('Backspace');
  assert(await getParaText(page, 0, 0, 1000) === '', '선택한 한글과 영어를 함께 삭제한다');
  await assertCaretAligned(page, '선택 삭제');
  await page.keyboard.sendCharacter('다시 입력');
  assert(await getParaText(page, 0, 0, 1000) === '다시 입력', '삭제 직후 입력이 정상 위치에 들어간다');

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await prepare(page, '동작 줄이기 English');
  await page.keyboard.press('Backspace');
  await assertCaretAligned(page, '동작 줄이기');
  await screenshot(page, 'reduced-motion');
});
