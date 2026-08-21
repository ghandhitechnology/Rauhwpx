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
  }));
  assert(afterBlocked.boxVisible, '전송 실패 시 상자가 열린 채 남아야 함');
  assert(afterBlocked.error === '게이트 차단 테스트',
    `전송 실패 이유가 표시되어야 함 (현재: '${afterBlocked.error}')`);
  await screenshot(page, 'inline-prompt-send-blocked');

  // 실제 사이드바 경로는 허브가 연결된 경우에만 검증한다. 진짜 에이전트 턴이
  // 돌지 않도록 bridge.sendUserMessage 를 기록 스텁으로 바꾼다.
  const connected = await page.evaluate(
    () => window.__agentBridge?.getConnectionState?.() === 'connected',
  );
  if (connected) {
    setTestCase('전송 성공 시 사이드바에 선택 인용과 지시가 기록된다');
    console.log('\n[5] 사이드바 경로 전송 (sendUserMessage 스텁)...');
    await page.evaluate(() => {
      const controller = window.__inlinePrompt;
      controller.deps.submit = window.__origSubmit;
      window.__sentWire = [];
      window.__agentBridge.sendUserMessage = (text) => {
        window.__sentWire.push(text);
        return Promise.resolve(null);
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
    console.log('\n[5] 허브 미연결 — 사이드바 전송 경로는 건너뜀');
    await page.keyboard.press('Escape');
  }

  setTestCase('상자가 닫힌 상태로 마무리된다');
  await page.evaluate(() => new Promise(r => setTimeout(r, 200)));
  const closed = await page.evaluate(() => {
    const box = document.querySelector('.ag-inline-box');
    return !box || box.hidden;
  });
  assert(closed, '마무리 시 상자가 닫혀 있어야 함');

  console.log('\n테스트 완료');
});
