/** 빈 문서, 툴바 포커스, IME, 데스크톱 메뉴의 단축키 경로를 검증한다. */
import { runTest, loadApp, screenshot, assert, typeText } from './helpers.mjs';

async function press(page, ...keys) {
  for (const key of keys.slice(0, -1)) await page.keyboard.down(key);
  await page.keyboard.press(keys.at(-1));
  for (const key of keys.slice(0, -1).reverse()) await page.keyboard.up(key);
}

runTest('전역 및 데스크톱 편집 단축키', async ({ page }) => {
  await page.evaluateOnNewDocument(() => {
    window.rhwpDesktop = {
      onEditCommand: (listener) => { window.__desktopEditCommand = listener; },
    };
  });
  await loadApp(page);
  assert(await page.evaluate(() => window.__wasm.pageCount) === 0, '초기 상태 문서 없음');
  await press(page, 'Alt', 'n');
  await page.waitForFunction(() => window.__wasm.pageCount > 0);
  await screenshot(page, 'global-02-new-doc');
  await page.evaluate(() => window.__inputHandler.focus());
  await typeText(page, 'shortcut text');
  const countHits = () => page.evaluate(() => window.__wasm.searchAllText('shortcut text', false, true).length);
  assert(await countHits() === 1, '실제 키 입력으로 문서 작성');
  for (const width of [700, 1280, 1720]) {
    await page.setViewport({ width, height: 900 });
    await page.click('#sb-zoom-fit');
    await press(page, 'Control', 'z');
    assert(await countHits() === 0, `툴바 포커스에서 undo (${width}px)`);
    await press(page, 'Control', 'Shift', 'z');
    assert(await countHits() === 1, `문서 포커스로 복귀 후 redo (${width}px)`);
  }
  // Electron 메뉴/accelerator가 보내는 동일한 preload 콜백 경로.
  await page.evaluate(() => window.__desktopEditCommand('undo'));
  assert(await countHits() === 0, '데스크톱 Undo가 문서 모델에 적용');
  await page.evaluate(() => window.__desktopEditCommand('redo'));
  assert(await countHits() === 1, '데스크톱 Redo가 문서 모델에 적용');
  await page.evaluate(() => window.__desktopEditCommand('select-all'));
  assert(await page.evaluate(() => window.__inputHandler.hasSelection()), '데스크톱 Select All이 문서 선택');
  await page.evaluate(() => {
    const field = document.createElement('textarea');
    field.id = 'shortcut-field';
    field.setAttribute('aria-label', 'Shortcut field fixture');
    document.body.append(field);
    field.focus();
  });
  await page.keyboard.type('local input');
  await page.evaluate(() => window.__desktopEditCommand('select-all'));
  assert(await page.$eval('#shortcut-field', (field) => field.selectionEnd - field.selectionStart) === 11,
    '별도 입력에서는 네이티브 전체 선택');
  await page.evaluate(() => window.__desktopEditCommand('undo'));
  assert(await countHits() === 1, '별도 입력 undo가 문서를 변경하지 않음');
  await page.$eval('#shortcut-field', (field) => field.remove());
  await page.evaluate(() => {
    window.__inputHandler.focus();
    window.__inputHandler.cursor.clearSelection();
  });
  const prevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'Process', code: 'KeyZ', keyCode: 229, ctrlKey: true,
      bubbles: true, cancelable: true,
    });
    document.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert(prevented && await countHits() === 0, '한글 IME Process undo 처리');
  await press(page, 'Control', 'Shift', 'z');
  assert(await countHits() === 1, '한글 단축키 후 redo 복원');
  await page.evaluate(() => {
    const textarea = document.activeElement;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.value = '한';
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '한' }));
    window.__desktopEditCommand('undo');
  });
  assert(await countHits() === 1, '조합 중 데스크톱 undo는 기존 문서를 보존');
  assert(await page.evaluate(() => !window.__inputHandler.imeSession.isComposing), '메뉴 실행 전에 IME 조합 확정');
  await page.evaluate(() => window.__desktopEditCommand('redo'));
  assert(await page.evaluate(() => window.__wasm.searchAllText('한', false, true).length) === 1,
    '조합 문자는 redo로 정확히 한 번 복구');
  const beforeZoom = await page.evaluate(() => window.__inputHandler.viewportManager.getZoom());
  await press(page, 'Control', '-');
  await page.waitForFunction((zoom) => Math.abs(window.__inputHandler.viewportManager.getZoom() - (zoom - 0.1)) < 0.001, {}, beforeZoom);
  assert(true, '단일 키 입력으로 줌 한 단계 변경');
  for (const lock of ['setReadOnly', 'setUserEditingLocked']) {
    await page.evaluate((method) => window.__inputHandler[method](true), lock);
    const zoom = await page.evaluate(() => window.__inputHandler.viewportManager.getZoom());
    await press(page, 'Control', '-');
    await page.waitForFunction((before) => Math.abs(window.__inputHandler.viewportManager.getZoom() - (before - 0.1)) < 0.001, {}, zoom);
    assert(true, `${lock} 문서에서도 줌 단축키 사용`);
    await page.evaluate((method) => window.__inputHandler[method](false), lock);
  }
  await screenshot(page, 'global-03-shortcuts-restored');
}, { skipLoadApp: true });
