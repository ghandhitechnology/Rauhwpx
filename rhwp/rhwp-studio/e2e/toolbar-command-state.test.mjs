import { runTest, createNewDocument, clickEditArea, assert } from './helpers.mjs';

process.env.VITE_URL = process.env.VITE_URL || 'http://localhost:7700';

runTest('기본 도구 모음 명령 상태', async ({ page }) => {
  await createNewDocument(page);
  const state = async (command) => page.$eval(
    `#icon-toolbar .tb-group:not(.tb-mode-group) .tb-btn[data-cmd="${command}"]`,
    button => button.disabled,
  );

  assert(await state('edit:undo'), '새 문서에서 되돌리기는 비활성');
  assert(await state('edit:cut'), '선택이 없으면 오려두기는 비활성');

  await clickEditArea(page);
  await page.keyboard.type('가');
  await page.waitForFunction(() =>
    !document.querySelector('#icon-toolbar .tb-btn[data-cmd="edit:undo"]')?.disabled,
  );
  assert(!(await state('edit:undo')), '입력 후 되돌리기는 활성');
});
