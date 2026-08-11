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
});
