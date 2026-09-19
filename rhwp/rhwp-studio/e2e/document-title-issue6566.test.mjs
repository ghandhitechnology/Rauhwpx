/** #6566: 실제 문서 열기/실패/새 문서/저장과 보조 bridge의 창 제목 소유권. */
import { runTest, assert, createNewDocument } from './helpers.mjs';

async function expectTitle(page, expected) {
  try {
    await page.waitForFunction(value => document.title === value, { timeout: 10000 }, expected);
  } catch {
    throw new Error(`title expected=${expected}, actual=${await page.title()}`);
  }
  assert(await page.title() === expected, `창 제목: ${expected}`);
}

async function fileCommand(page, command) {
  const result = await page.evaluate((cmdId) => {
    const fileItem = [...document.querySelectorAll('#menu-bar .menu-item')]
      .find((el) => (el.textContent || '').includes('파일'));
    const title = fileItem?.querySelector('.menu-title');
    if (!title) return { ok: false, reason: '파일 메뉴 없음' };
    title.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const item = document.querySelector(`.md-item[data-cmd="${cmdId}"]`);
    if (!item) return { ok: false, reason: `${cmdId} 항목 없음` };
    const disabled = item.classList.contains('disabled');
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { ok: true, disabled };
  }, command);
  assert(result.ok, `메뉴 항목 클릭 (${result.reason || command})`);
  assert(!result.disabled, `${command} 항목이 활성이어야 함`);
}

runTest('문서 파일명과 창 제목 (#6566)', async ({ page }) => {
  await expectTitle(page, 'Rauhwpx');

  const failedInitial = await page.evaluate(() => {
    try { window.__wasm.loadDocument(new Uint8Array([1, 2, 3]), '손상.hwp'); }
    catch { return true; }
    return false;
  });
  assert(failedInitial, '손상 파일 로드 실패를 실제 WASM에서 확인');
  await expectTitle(page, 'Rauhwpx');

  const opened = await page.evaluate(async () => {
    const response = await fetch('/samples/para-001.hwp');
    if (!response.ok) throw new Error(`fixture HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const requestId = 'title-6566';
    const done = new Promise(resolve => {
      const off = window.__eventBus.on('open-document-bytes:done', payload => {
        if (payload.requestId !== requestId) return;
        off();
        resolve(payload);
      });
    });
    window.__eventBus.emit('open-document-bytes', {
      bytes, fileName: '검토 <원본> & 001.hwp', fileHandle: null,
      skipUnsavedGuard: true, requestId,
    });
    return done;
  });
  assert(opened.ok, '실제 열기 경로 성공');
  await expectTitle(page, '검토 <원본> & 001.hwp - Rauhwpx');

  const failedNameKeptOutOfTitle = await page.evaluate(() => {
    try { window.__wasm.loadDocument(new Uint8Array([1, 2, 3]), '실패.hwp'); }
    catch { return document.title; }
    return document.title;
  });
  assert(
    !String(failedNameKeptOutOfTitle).includes('실패.hwp'),
    '실패한 파일명이 창 제목에 들어가지 않음',
  );

  const reopened = await page.evaluate(async () => {
    const response = await fetch('/samples/para-001.hwp');
    if (!response.ok) throw new Error(`fixture HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const requestId = 'title-6566-reopen';
    const done = new Promise(resolve => {
      const off = window.__eventBus.on('open-document-bytes:done', payload => {
        if (payload.requestId !== requestId) return;
        off();
        resolve(payload);
      });
    });
    window.__eventBus.emit('open-document-bytes', {
      bytes, fileName: '검토 <원본> & 001.hwp', fileHandle: null,
      skipUnsavedGuard: true, requestId,
    });
    return done;
  });
  assert(reopened.ok, '실패 후 재오픈 성공');
  await expectTitle(page, '검토 <원본> & 001.hwp - Rauhwpx');

  await page.evaluate(async () => {
    const { WasmBridge } = await import('/src/core/wasm-bridge.ts');
    const auxiliary = new WasmBridge();
    await auxiliary.initialize();
    auxiliary.createNewDocument();
    auxiliary.fileName = '비교 전용.hwp';
    auxiliary.releaseDocument();
  });
  await expectTitle(page, '검토 <원본> & 001.hwp - Rauhwpx');

  await page.evaluate(() => {
    window.__titleSaveWritten = false;
    window.showSaveFilePicker = async () => ({
      name: '다른 이름.hwpx',
      createWritable: async () => ({
        write: async blob => { window.__titleSaveWritten = blob.size > 0; },
        close: async () => {},
      }),
    });
  });
  await fileCommand(page, 'file:save-as-hwpx');
  await expectTitle(page, '다른 이름.hwpx - Rauhwpx');
  assert(await page.evaluate(() => window.__titleSaveWritten), '다른 이름 저장이 실제 바이트를 씀');
  await page.evaluate(() => window.rhwpStudio.notifySaved('호스트 저장.hwp'));
  await expectTitle(page, '호스트 저장.hwp - Rauhwpx');

  await createNewDocument(page);
  await expectTitle(page, '새 문서.hwpx - Rauhwpx');
});
