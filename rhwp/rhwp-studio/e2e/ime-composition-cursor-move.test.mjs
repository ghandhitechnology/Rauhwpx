/**
 * E2E 테스트: IME 조합 중 커서 이동 시 옛 anchor 덮어쓰기 회귀 방지
 *
 * 배경:
 *   캔버스 클릭은 숨은 textarea 의 포커스도 selection 도 바꾸지 않는다. 브라우저 입장에서
 *   조합을 끝낼 이유가 없어 compositionend 가 발생하지 않고, `compositionAnchor`(클릭 전
 *   위치)가 그대로 살아남는다. 그 상태로 다음 글자를 치면 클릭한 자리가 아니라 옛 anchor
 *   자리의 글자를 지우고 덮어썼다 — 사용자에게는 글자가 씹히고 엉뚱한 곳에 찍히는 증상.
 *
 *   수정: onClick 이 커서를 옮기기 전에 finalizeCompositionBeforeCursorMove() 로
 *   조합을 확정하고 브라우저 조합 버퍼까지 리셋한다.
 *
 * 참고: 이 테스트는 타이밍이 아니라 '조합이 열린 채 커서가 움직였는가' 라는
 *   결정적 조건만 검증한다. CDP 의 Input.imeSetComposition 은 실제 한글 IME 의
 *   이벤트 순서를 완전히 재현하지 못하므로 입력 속도 기반 단언은 두지 않는다.
 *
 * 사전 조건: WASM 빌드(pkg/) + Vite dev server(7700)
 * 실행: node e2e/ime-composition-cursor-move.test.mjs --mode=headless
 */
import {
  runTest, createNewDocument, clickEditArea, getParaText, assert,
} from './helpers.mjs';

async function compose(client, steps) {
  for (const text of steps) {
    await client.send('Input.imeSetComposition', {
      text, selectionStart: text.length, selectionEnd: text.length,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function commit(client, text) {
  await client.send('Input.insertText', { text });
  await new Promise((r) => setTimeout(r, 200));
}

async function dispatchImeSession(page, updates, finalText, trailingInputType = 'insertFromComposition') {
  await page.evaluate(({ values, finalValue, trailingType }) => {
    const textarea = window.__inputHandler.textarea;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    for (const value of values) {
      textarea.value = value;
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: value }));
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertCompositionText',
        isComposing: true,
      }));
    }
    textarea.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      data: finalValue,
    }));
    textarea.value = finalValue;
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: finalValue,
      inputType: trailingType,
      isComposing: false,
    }));
  }, { values: updates, finalValue: finalText, trailingType: trailingInputType });
}

await runTest('IME 조합 중 커서 이동', async ({ page }) => {
  const client = await page.createCDPSession();

  // ── 1) 조합을 연 채로 클릭하면 조합분이 확정되고, 조합 자모가 남지 않는다
  await createNewDocument(page);
  await clickEditArea(page);

  await compose(client, ['ㄱ', '가']);
  // 조합이 열린 상태에서 편집 영역을 다시 클릭 (커서 이동)
  await clickEditArea(page);
  await new Promise((r) => setTimeout(r, 300));

  const afterClick = await getParaText(page, 0, 0, 100);
  assert(
    !/[ㄱ-ㅎㅏ-ㅣ]/.test(afterClick),
    `클릭 후 조합 자모가 문서에 남지 않는다 (실제 ${JSON.stringify(afterClick)})`,
  );
  assert(
    afterClick.includes('가'),
    `조합 중이던 글자는 확정되어 보존된다 (실제 ${JSON.stringify(afterClick)})`,
  );

  // ── 2) 클릭 후 이어친 글자가 앞 글자를 지우지 않는다
  const beforeSecond = await getParaText(page, 0, 0, 100);
  await compose(client, ['ㄴ', '나']);
  await commit(client, '나');
  const afterSecond = await getParaText(page, 0, 0, 100);

  assert(
    afterSecond.length > beforeSecond.length,
    `이어친 글자가 앞 글자를 덮어쓰지 않는다 (${beforeSecond.length} → ${afterSecond.length})`,
  );
  assert(
    afterSecond.includes('가') && afterSecond.includes('나'),
    `두 글자가 모두 남는다 (실제 ${JSON.stringify(afterSecond)})`,
  );

  // ── 3) 조합 중 Enter 가 문단에 리터럴 개행을 남기지 않는다
  await createNewDocument(page);
  await clickEditArea(page);
  await compose(client, ['ㄷ', '다']);
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 400));

  const paraText = await getParaText(page, 0, 0, 100);
  assert(
    !paraText.includes('\n') && !paraText.includes('\r'),
    `문단 텍스트에 리터럴 개행이 들어가지 않는다 (실제 ${JSON.stringify(paraText)})`,
  );

  // ── 4) 빠른 전체 문구 + trailing input도 세션당 한 번만 커밋한다
  await createNewDocument(page);
  await clickEditArea(page);
  await dispatchImeSession(
    page,
    ['ㅇ', '아', '안', '안ㄴ', '안녀', '안녕', '안녕하', '안녕하세', '안녕하세요'],
    '안녕하세요',
  );
  const greeting = await getParaText(page, 0, 0, 100);
  assert(greeting === '안녕하세요', `빠른 문구가 정확히 한 번 들어간다 (실제 ${JSON.stringify(greeting)})`);

  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  const afterUndo = await getParaText(page, 0, 0, 100);
  assert(afterUndo === '', `한 조합 세션은 한 번의 undo로 제거된다 (실제 ${JSON.stringify(afterUndo)})`);

  // ── 5) 같은 음절의 인접 세션과 최종 후보 변환을 시간 간격 없이 보존한다
  await dispatchImeSession(page, ['ㄱ', '가'], '가', 'insertText');
  await dispatchImeSession(page, ['ㄱ', '가'], '가', 'insertText');
  await dispatchImeSession(page, ['서'], '書');
  const repeated = await getParaText(page, 0, 0, 100);
  assert(repeated === '가가書', `같은 글자와 후보 확정이 씹히거나 중복되지 않는다 (실제 ${JSON.stringify(repeated)})`);

  // ── 6) Chrome 실제 IME 처럼 커밋 텍스트가 textarea 에 누적되는 흐름
  //
  // 실제 Chrome 한글 IME 는 커밋한 음절을 textarea value 에 남긴 채 다음 음절의
  // 조합을 이어 붙인다. 핸들러가 커밋 시점에 value 를 비우면 진행 중인 다음
  // 조합이 파기되어 글자가 씹히므로, 핸들러는 value 를 건드리지 않고 consumed
  // prefix 만 전진시켜야 한다. 여기서는 그 누적 value 의미론으로 세 음절을
  // 연속 커밋하고, 문서와 value 양쪽이 온전한지 확인한다.
  await createNewDocument(page);
  await clickEditArea(page);
  const chromeFlow = await page.evaluate(() => {
    const textarea = window.__inputHandler.textarea;
    const dispatchSyllable = (prefix, updates, finalText) => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      for (const u of updates) {
        textarea.value = prefix + u;
        textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: u }));
        textarea.dispatchEvent(new InputEvent('input', {
          bubbles: true, data: u, inputType: 'insertCompositionText', isComposing: true,
        }));
      }
      // Chrome: 커밋 input(insertCompositionText, isComposing:true) → compositionend 순서,
      // 이후 trailing input 없음. 커밋 텍스트는 value 에 그대로 남는다.
      textarea.value = prefix + finalText;
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true, data: finalText, inputType: 'insertCompositionText', isComposing: true,
      }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: finalText }));
      return prefix + finalText;
    };
    let prefix = '';
    prefix = dispatchSyllable(prefix, ['ㅎ', '하', '한'], '한');
    prefix = dispatchSyllable(prefix, ['ㄱ', '그', '글'], '글');
    prefix = dispatchSyllable(prefix, ['ㅁ', '마', '맛'], '맛');
    return { value: textarea.value };
  });
  await new Promise((r) => setTimeout(r, 300));
  const accumulated = await getParaText(page, 0, 0, 100);
  assert(
    accumulated === '한글맛',
    `누적 value 흐름에서 세 음절이 모두 정확히 한 번씩 커밋된다 (실제 ${JSON.stringify(accumulated)})`,
  );
  assert(
    chromeFlow.value === '한글맛',
    `커밋 경로가 textarea value 를 파기하지 않는다 (실제 ${JSON.stringify(chromeFlow.value)})`,
  );
});
