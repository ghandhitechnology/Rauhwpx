/**
 * E2E 테스트: 인라인 프롬프트 — 텍스트 선택 → 칩 → 입력 상자 → 사이드바 전송 게이트
 */
import {
  runTest, createNewDocument, screenshot, assert, typeText, clickEditArea, setTestCase,
} from './helpers.mjs';

runTest('인라인 프롬프트 선택 칩/입력 상자 테스트', async ({ page }) => {
  console.log('[1] 새 문서 생성 및 문장 입력...');
  await createNewDocument(page);
  await clickEditArea(page);
  await typeText(page, '인라인 프롬프트 선택 검증 문장입니다');

  setTestCase('선택 없이 칩이 나타나지 않는다');
  await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
  let chipVisible = await page.evaluate(() => {
    const chip = document.querySelector('.ag-inline-chip');
    return !!chip && !chip.hidden;
  });
  assert(!chipVisible, '선택이 없으면 칩이 보이지 않아야 함');

  setTestCase('드래그 선택 후 칩이 나타난다');
  console.log('\n[2] 문장 앞부분을 드래그 선택...');
  const drag = await page.evaluate(() => {
    const scrollContent = document.getElementById('scroll-content');
    const canvasView = window.__canvasView;
    const wasm = window.__wasm;
    const zoom = canvasView.getZoom?.() ?? 1;
    const vs = canvasView.virtualScroll;
    const toClient = (rect) => {
      const contentRect = scrollContent.getBoundingClientRect();
      const pageLeft = (scrollContent.clientWidth - vs.getPageWidth(rect.pageIndex)) / 2;
      return {
        x: contentRect.left + pageLeft + rect.x * zoom,
        y: contentRect.top + vs.getPageOffset(rect.pageIndex) + rect.y * zoom + (rect.height * zoom) / 2,
      };
    };
    return { from: toClient(wasm.getCursorRect(0, 0, 0)), to: toClient(wasm.getCursorRect(0, 0, 10)) };
  });
  await page.mouse.move(drag.from.x + 1, drag.from.y);
  await page.mouse.down();
  await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => new Promise(r => setTimeout(r, 600)));

  chipVisible = await page.evaluate(() => {
    const chip = document.querySelector('.ag-inline-chip');
    return !!chip && !chip.hidden;
  });
  assert(chipVisible, '드래그 선택이 끝나면 칩이 보여야 함');
  await screenshot(page, 'inline-prompt-chip');

  setTestCase('사이드바를 숨기면 칩이 다시 나타나지 않는다');
  console.log('\n[2b] 상단 토글로 사이드바 숨긴 뒤 다시 선택...');
  await page.click('.ag-collapse-tab');
  await page.evaluate(() => new Promise(r => setTimeout(r, 500)));
  const sidebarGone = await page.evaluate(() => ({
    collapsed: document.getElementById('agent-sidebar')?.classList.contains('ag-collapsed') === true,
    open: document.body.classList.contains('ag-sidebar-open'),
  }));
  assert(sidebarGone.collapsed && !sidebarGone.open, '사이드바가 완전히 숨겨져야 함');
  await page.mouse.move(drag.from.x + 1, drag.from.y);
  await page.mouse.down();
  await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
  chipVisible = await page.evaluate(() => {
    const chip = document.querySelector('.ag-inline-chip');
    const style = chip ? getComputedStyle(chip) : null;
    return !!chip && !chip.hidden && style?.display !== 'none';
  });
  assert(!chipVisible, '사이드바가 숨겨진 동안 칩이 보이면 안 됨');
  await screenshot(page, 'inline-prompt-chip-sidebar-collapsed');

  await page.click('.ag-collapse-tab');
  await page.evaluate(() => new Promise(r => setTimeout(r, 500)));
  await page.mouse.move(drag.from.x + 1, drag.from.y);
  await page.mouse.down();
  await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
  chipVisible = await page.evaluate(() => {
    const chip = document.querySelector('.ag-inline-chip');
    return !!chip && !chip.hidden;
  });
  assert(chipVisible, '사이드바를 다시 열면 칩이 보여야 함');

  setTestCase('칩 클릭으로 입력 상자가 열리고 선택이 유지된다');
  console.log('\n[3] 칩 클릭 → 입력 상자...');
  await page.click('.ag-inline-chip');
  await page.evaluate(() => new Promise(r => setTimeout(r, 200)));
  const boxState = await page.evaluate(() => {
    const box = document.querySelector('.ag-inline-box');
    return {
      visible: !!box && !box.hidden,
      focused: document.activeElement?.classList?.contains('ag-inline-input') ?? false,
      hasSelection: window.__inputHandler?.hasSelection() ?? false,
      permission: document.querySelector('.ag-inline-permission')?.textContent ?? '',
    };
  });
  assert(boxState.visible, '입력 상자가 열려야 함');
  assert(boxState.focused, '입력 상자의 텍스트 영역에 포커스가 있어야 함');
  assert(boxState.hasSelection, '입력 상자가 열려도 문서 선택이 유지되어야 함');
  assert(boxState.permission === '안전' || boxState.permission === '전체',
    `권한 표시가 있어야 함 (현재: ${boxState.permission})`);
  await screenshot(page, 'inline-prompt-box');

  setTestCase('전송 실패 이유가 상자에 표시된다');
  console.log('\n[4] 게이트 실패 시 이유 표시...');
  await page.evaluate(() => {
    const controller = window.__inlinePrompt;
    window.__origSubmit = controller.deps.submit;
    controller.deps.submit = () => ({ ok: false, reason: '게이트 차단 테스트' });
  });
  await page.keyboard.type('이 문장을 더 간결하게 고쳐줘', { delay: 10 });
  await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise(r => setTimeout(r, 200)));
  const afterBlocked = await page.evaluate(() => ({
    boxVisible: !document.querySelector('.ag-inline-box')?.hidden,
    error: document.querySelector('.ag-inline-error')?.textContent ?? '',
    draft: document.querySelector('.ag-inline-input')?.value ?? '',
    itemCount: window.__inlinePrompt?.captured?.items?.length ?? 0,
  }));
  assert(afterBlocked.boxVisible, '전송 실패 시 상자가 열린 채 남아야 함');
  assert(afterBlocked.error === '게이트 차단 테스트',
    `전송 실패 이유가 표시되어야 함 (현재: '${afterBlocked.error}')`);
  assert(afterBlocked.draft === '이 문장을 더 간결하게 고쳐줘' && afterBlocked.itemCount === 1,
    '전송 실패 시 초안과 typed 선택을 보존해야 함');

  setTestCase('비동기 전송 거부 뒤에도 같은 초안으로 재시도할 수 있다');
  await page.evaluate(() => {
    window.__inlinePrompt.deps.submit = () => Promise.reject(new Error('전송 거부 테스트'));
  });
  await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise(r => setTimeout(r, 100)));
  const afterRejected = await page.evaluate(() => ({
    boxVisible: !document.querySelector('.ag-inline-box')?.hidden,
    error: document.querySelector('.ag-inline-error')?.textContent ?? '',
    draft: document.querySelector('.ag-inline-input')?.value ?? '',
    itemCount: window.__inlinePrompt?.captured?.items?.length ?? 0,
  }));
  assert(afterRejected.boxVisible && afterRejected.error === '전송 거부 테스트',
    '비동기 전송 거부 이유를 열린 상자에 표시해야 함');
  assert(afterRejected.draft === '이 문장을 더 간결하게 고쳐줘' && afterRejected.itemCount === 1,
    '비동기 전송 거부 뒤에도 초안과 선택을 보존해야 함');
  await screenshot(page, 'inline-prompt-send-blocked');

  // 실제 사이드바 경로는 허브가 연결된 경우에만 검증한다. 진짜 에이전트 턴이
  // 돌지 않도록 bridge.sendUserMessage 를 기록 스텁으로 바꾼다.
  const sendRouteReady = await page.evaluate(() =>
    window.__agentBridge?.getConnectionState?.() === 'connected'
      && !document.querySelector('.ag-input')?.placeholder?.includes('연결 필요'),
  );
  if (sendRouteReady) {
    setTestCase('전송 성공 시 사이드바에 선택 인용과 지시가 기록된다');
    console.log('\n[5] 사이드바 경로 전송 (sendUserMessage 스텁)...');
    await page.evaluate(() => {
      const controller = window.__inlinePrompt;
      controller.deps.submit = window.__origSubmit;
      window.__sentWire = [];
      window.__agentBridge.sendUserMessage = (text) => {
        window.__sentWire.push(text);
        return Promise.resolve('inline-prompt-test-message');
      };
    });
    await page.keyboard.press('Enter');
    await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
    const afterSend = await page.evaluate(() => ({
      boxHidden: document.querySelector('.ag-inline-box')?.hidden ?? true,
      wire: window.__sentWire,
      quoteLabel: document.querySelector('.ag-msg-selection-label')?.textContent ?? '',
      bubbleText: [...document.querySelectorAll('.ag-msg-user-text')].at(-1)?.textContent ?? '',
    }));
    assert(afterSend.boxHidden, '전송 성공 시 상자가 닫혀야 함');
    assert(afterSend.wire.length === 1, '메시지가 한 번 전송되어야 함');
    assert(afterSend.wire[0].includes('[선택 컨텍스트]'), '전송 텍스트에 선택 컨텍스트 블록이 있어야 함');
    assert(afterSend.wire[0].includes('이 문장을 더 간결하게 고쳐줘'), '전송 텍스트에 지시가 있어야 함');
    assert(afterSend.quoteLabel === '문단 1', `말풍선 선택 인용 라벨 (현재: '${afterSend.quoteLabel}')`);
    assert(afterSend.bubbleText === '이 문장을 더 간결하게 고쳐줘', '말풍선에는 지시만 보여야 함');
    await screenshot(page, 'inline-prompt-sent');
  } else {
    console.log('\n[5] 허브/선택 에이전트 미준비 — 사이드바 전송 경로는 건너뜀');
    await page.keyboard.press('Escape');
  }

  setTestCase('상자가 닫힌 상태로 마무리된다');
  await page.evaluate(() => new Promise(r => setTimeout(r, 200)));
  const closed = await page.evaluate(() => {
    const box = document.querySelector('.ag-inline-box');
    return !box || box.hidden;
  });
  assert(closed, '마무리 시 상자가 닫혀 있어야 함');

  setTestCase('이미지 선택은 정확한 주소와 실제 PNG 첨부를 캡처한다');
  await createNewDocument(page);
  const insertedImage = await page.evaluate(() => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const raw = atob(base64);
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    const result = window.__wasm.insertPicture(
      0, 0, 0, '[]', bytes, 7200, 3600, 1, 1, 'png', '선택 이미지', undefined, undefined, 'inline',
    );
    window.__eventBus.emit('document-mutated', 'inline-prompt-image-test');
    window.__inputHandler.selectPictureObject(0, result.paraIdx, result.controlIdx, 'image');
    return result;
  });
  await page.evaluate(() => new Promise(r => setTimeout(r, 700)));
  chipVisible = await page.evaluate(() => {
    const chip = document.querySelector('.ag-inline-chip');
    return !!chip && !chip.hidden;
  });
  assert(chipVisible, '이미지를 선택하면 인라인 프롬프트 칩이 보여야 함');
  await page.click('.ag-inline-chip');
  await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
  const imageCapture = await page.evaluate(() => {
    const captured = window.__inlinePrompt?.captured;
    const item = captured?.items?.[0];
    const attachment = captured?.attachments?.[0];
    return {
      kind: item?.kind,
      objectType: item?.objectType,
      controlIdx: item?.address?.controlIdx,
      description: item?.description,
      attachmentName: item?.attachmentName,
      attachmentType: attachment?.type,
      attachmentSize: attachment?.size ?? 0,
      revision: captured?.revision,
    };
  });
  assert(imageCapture.kind === 'object' && imageCapture.objectType === 'image', '이미지 typed item을 캡처해야 함');
  assert(imageCapture.controlIdx === insertedImage.controlIdx, '선택 이미지의 정확한 controlIdx를 보존해야 함');
  assert(imageCapture.description === '선택 이미지', '이미지 설명을 보존해야 함');
  assert(imageCapture.attachmentName === 'selected-image-1.png', '이미지 item과 첨부 이름을 연결해야 함');
  assert(imageCapture.attachmentType === 'image/png' && imageCapture.attachmentSize > 0,
    '선택 이미지의 실제 PNG 내용이 첨부되어야 함');
  assert(Number.isInteger(imageCapture.revision), '선택 캡처에 문서 revision이 있어야 함');
  const imageChip = await page.evaluate(() => ({
    text: document.querySelector('.ag-inline-selection-item-label')?.textContent ?? '',
    hasPreview: Boolean(document.querySelector('.ag-inline-selection-item img')),
  }));
  assert(imageChip.text === '이미지' && imageChip.hasPreview, '이미지 칩에 축소 미리보기를 표시해야 함');
  await page.keyboard.press('Escape');

  setTestCase('이미지 미리보기 캡처 실패는 전송을 막고 재시도를 안내한다');
  await page.evaluate(({ paraIdx, controlIdx }) => {
    const controller = window.__inlinePrompt;
    window.__origRenderObjectCrop = controller.renderObjectCrop;
    controller.renderObjectCrop = async () => null;
    window.__inputHandler.selectPictureObject(0, paraIdx, controlIdx, 'image');
  }, insertedImage);
  await page.evaluate(() => new Promise(r => setTimeout(r, 700)));
  await page.click('.ag-inline-chip');
  await page.evaluate(() => new Promise(r => setTimeout(r, 200)));
  const failedImageCapture = await page.evaluate(() => ({
    boxVisible: !document.querySelector('.ag-inline-box')?.hidden,
    error: document.querySelector('.ag-inline-error')?.textContent ?? '',
    sendDisabled: document.querySelector('.ag-inline-send')?.disabled ?? false,
    captured: window.__inlinePrompt?.captured ?? null,
  }));
  assert(failedImageCapture.boxVisible && failedImageCapture.error.includes('미리보기'),
    '캡처 실패 이유를 열린 상자에 표시해야 함');
  assert(failedImageCapture.sendDisabled && failedImageCapture.captured === null,
    '시각 자료 없이 이미지 선택을 전송할 수 없어야 함');
  await page.evaluate(() => {
    window.__inlinePrompt.renderObjectCrop = window.__origRenderObjectCrop;
  });
  await page.keyboard.press('Escape');

  setTestCase('수식 선택은 정확한 주소·스크립트·미리보기를 캡처한다');
  await createNewDocument(page);
  const insertedEquation = await page.evaluate(() => {
    const result = window.__wasm.insertEquation(0, 0, 0, 'x^2 + y^2', 1100, 0);
    window.__eventBus.emit('document-mutated', 'inline-prompt-equation-test');
    window.__inputHandler.cursor.enterPictureObjectSelectionDirect(0, result.paraIdx, result.controlIdx, 'equation');
    window.__eventBus.emit('picture-object-selection-changed', true);
    return result;
  });
  await page.evaluate(() => new Promise(r => setTimeout(r, 700)));
  await page.click('.ag-inline-chip');
  await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
  const equationCapture = await page.evaluate(() => {
    const item = window.__inlinePrompt?.captured?.items?.[0];
    return {
      kind: item?.kind,
      controlIdx: item?.address?.controlIdx,
      script: item?.script,
      attachmentName: item?.attachmentName,
      chipText: document.querySelector('.ag-inline-selection-item-label')?.textContent ?? '',
      hasPreview: Boolean(document.querySelector('.ag-inline-selection-item img')),
    };
  });
  assert(equationCapture.kind === 'equation' && equationCapture.controlIdx === insertedEquation.controlIdx,
    '수식 typed item에 정확한 controlIdx를 보존해야 함');
  assert(equationCapture.script === 'x^2 + y^2' && equationCapture.attachmentName,
    '수식 스크립트와 렌더링 첨부를 캡처해야 함');
  assert(equationCapture.chipText.includes('x^2 + y^2') && equationCapture.hasPreview,
    '수식 칩에 스크립트와 축소 미리보기를 표시해야 함');
  await page.keyboard.press('Escape');

  setTestCase('표 선택은 셀 구조와 전체 표 범위를 구분해 캡처한다');
  await createNewDocument(page);
  const insertedTable = await page.evaluate(() => {
    const result = window.__wasm.createTable(0, 0, 0, 2, 2);
    window.__eventBus.emit('document-mutated', 'inline-prompt-table-test');
    window.__inputHandler.cursor.enterTableObjectSelectionDirect(0, result.paraIdx, result.controlIdx);
    window.__eventBus.emit('table-object-selection-changed', true);
    return result;
  });
  await page.evaluate(() => new Promise(r => setTimeout(r, 700)));
  chipVisible = await page.evaluate(() => {
    const chip = document.querySelector('.ag-inline-chip');
    return !!chip && !chip.hidden;
  });
  assert(chipVisible, '표를 선택하면 인라인 프롬프트 칩이 보여야 함');
  await page.click('.ag-inline-chip');
  await page.evaluate(() => new Promise(r => setTimeout(r, 200)));
  const tableCapture = await page.evaluate(() => {
    const item = window.__inlinePrompt?.captured?.items?.[0];
    return {
      kind: item?.kind,
      controlIdx: item?.address?.controlIdx,
      rowCount: item?.rowCount,
      colCount: item?.colCount,
      cellCount: item?.cells?.length,
      selectedRange: item?.selectedRange,
    };
  });
  assert(tableCapture.kind === 'table', '표 typed item을 캡처해야 함');
  assert(tableCapture.controlIdx === insertedTable.controlIdx, '선택 표의 정확한 controlIdx를 보존해야 함');
  assert(tableCapture.rowCount === 2 && tableCapture.colCount === 2 && tableCapture.cellCount === 4,
    '표 크기와 셀 구조를 캡처해야 함');
  assert(tableCapture.selectedRange === undefined, '표 객체 선택을 셀 범위 선택으로 잘못 표시하면 안 됨');
  await page.keyboard.press('Escape');

  setTestCase('셀 범위 선택은 정확한 행·열 범위와 표 크기를 캡처한다');
  const selectedCells = await page.evaluate(async ({ paraIdx, controlIdx }) => {
    const ih = window.__inputHandler;
    const bboxes = window.__wasm.getTableCellBboxes(0, paraIdx, controlIdx, 0) || [];
    const cell = bboxes.find((box) => box.row === 1 && box.col === 1);
    ih.cursor.exitTableObjectSelection();
    ih.cursor.moveToCellByIndex(0, paraIdx, controlIdx, undefined, cell.cellIdx, 'start');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    ih.cursor.enterCellSelectionMode();
    ih.cursor.advanceCellSelectionPhase();
    ih.cursor.expandCellSelection(0, -1);
    window.__eventBus.emit('table-object-selection-changed', true);
    return ih.cursor.getSelectedCellRange();
  }, insertedTable);
  assert(selectedCells.startRow === 1 && selectedCells.endRow === 1
    && selectedCells.startCol === 0 && selectedCells.endCol === 1, '테스트 셀 범위를 준비해야 함');
  await page.evaluate(() => new Promise(r => setTimeout(r, 700)));
  chipVisible = await page.evaluate(() => !document.querySelector('.ag-inline-chip')?.hidden);
  assert(chipVisible, '셀 범위를 선택하면 인라인 프롬프트 칩이 보여야 함');
  await page.click('.ag-inline-chip');
  await page.evaluate(() => new Promise(r => setTimeout(r, 200)));
  const cellRangeCapture = await page.evaluate(() => {
    const item = window.__inlinePrompt?.captured?.items?.[0];
    return {
      selectedRange: item?.selectedRange,
      chipText: document.querySelector('.ag-inline-selection-item-label')?.textContent ?? '',
    };
  });
  assert(JSON.stringify(cellRangeCapture.selectedRange) === JSON.stringify(selectedCells),
    'typed table item에 정확한 셀 범위를 보존해야 함');
  assert(cellRangeCapture.chipText === '표 2×2 · 2–2행, 1–2열', '표 칩에 크기와 셀 범위를 표시해야 함');

  setTestCase('캡처 뒤 revision 변경은 전송하지 않고 재선택을 요구한다');
  await page.type('.ag-inline-input', '이 셀들을 요약해 줘');
  await page.evaluate(() => {
    window.__staleSubmitCalls = 0;
    window.__inlinePrompt.deps.submit = () => {
      window.__staleSubmitCalls++;
      return Promise.resolve({ ok: true });
    };
    window.__eventBus.emit('document-mutated', 'inline-prompt-stale-test');
  });
  await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise(r => setTimeout(r, 100)));
  const staleState = await page.evaluate(() => ({
    calls: window.__staleSubmitCalls,
    draft: document.querySelector('.ag-inline-input')?.value ?? '',
    error: document.querySelector('.ag-inline-error')?.textContent ?? '',
    itemCount: window.__inlinePrompt?.captured?.items?.length ?? 0,
  }));
  assert(staleState.calls === 0 && staleState.error.includes('다시 선택'),
    'stale revision은 transport 호출 전에 차단해야 함');
  assert(staleState.draft === '이 셀들을 요약해 줘' && staleState.itemCount === 1,
    `stale revision에서도 초안과 typed 선택을 보존해야 함 (${JSON.stringify(staleState)})`);
  await page.keyboard.press('Escape');

  console.log('\n테스트 완료');
});
