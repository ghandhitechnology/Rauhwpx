/**
 * E2E: staged 개체 편집이 실제로 한 일을 overlay 로 표시한다.
 *
 * - delete_row/delete_col/delete_table → 지워진 자리의 빨간 앵커 + 호버 팝오버(삭제된 내용)
 * - 셀 속성/머리말/쪽 설정 변경 → 취소선 없는 연한 modify 틴트 (밴드·쪽 마커 포함)
 * - 새 표 → insert 외곽선
 * - 리뷰 카드는 '·' 설명 줄과 '−' 삭제 내용 줄을 함께 보여 준다
 *
 * 스크린샷은 /tmp 에만 쓴다 (커밋 금지).
 * 실행: npm run e2e:agent-overlay-kinds  (VITE_URL dev server + CHROME_PATH 필요)
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchBrowser, createPage, closeBrowser, loadApp, createNewDocument } from './helpers.mjs';

const outDir = process.env.E2E_SHOT_DIR || '/tmp/rw/p12-overlay';
fs.mkdirSync(outDir, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(outDir, name) });

// browser.close() 가 이 환경에서 멈출 수 있어 결과를 낸 뒤 스스로 끝낸다.
const watchdog = setTimeout(() => {
  console.error('[agent-overlay-kinds] watchdog timeout');
  process.exit(2);
}, 180_000);

const browser = await launchBrowser();
try {
  const page = await createPage(browser, 1440, 1000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await loadApp(page);
  await page.waitForFunction(() => !!window.__agentBridge?.pendingEdits);
  await createNewDocument(page);

  // 실제 도구 경로로 문서를 만들고 즉시 승인한다 — 본문 + 3×3 + 2×2 + 기존 머리말.
  await page.evaluate(() => {
    const bridge = window.__agentBridge;
    window.__ovk = {
      run(tool, args = {}) {
        return bridge.executor.execute(tool, { ...args, expectedRevision: bridge.revision.revision }, 'claude');
      },
      async stage(calls) {
        bridge.pendingEdits.beginTurn('claude');
        const results = [];
        try {
          for (const [tool, args] of calls) results.push(await this.run(tool, args));
        } finally {
          bridge.pendingEdits.endTurn('review');
        }
        return results;
      },
      async commit(calls) {
        const results = await this.stage(calls);
        const setId = bridge.pendingEdits.getChangeSets().at(-1)?.id;
        bridge.pendingEdits.approve(setId);
        return results;
      },
      async context() {
        const structure = await this.run('get_structure', { format: 'json', maxPreviewChars: 40 });
        const paragraphs = structure.sections[0].paragraphs;
        const tables = structure.sections[0].tables ?? [];
        return {
          p: (prefix) => paragraphs.find((para) => para.text.startsWith(prefix)).paraIdx,
          len: (prefix) => paragraphs.find((para) => para.text.startsWith(prefix)).length,
          tables,
        };
      },
    };
  });

  await page.evaluate(async () => {
    const ovk = window.__ovk;
    await ovk.commit([['insert_text', {
      sectionIdx: 0, paraIdx: 0, charOffset: 0,
      text: 'Heading\nBody one.\nTable A follows:\nBody two.\nTable B follows:\nEnd.',
    }]]);
    let c = await ovk.context();
    await ovk.commit([
      ['create_table', {
        sectionIdx: 0, paraIdx: c.p('Table A follows:'), charOffset: c.len('Table A follows:'),
        cells: [['a1', 'a2', 'a3'], ['b1', 'b2', 'b3'], ['c1', 'c2', 'c3']],
      }],
      ['create_table', {
        sectionIdx: 0, paraIdx: c.p('Table B follows:'), charOffset: c.len('Table B follows:'),
        cells: [['x1', 'x2'], ['y1', 'y2']],
      }],
      ['edit_header_footer', { sectionIdx: 0, which: 'header', text: 'Doc header' }],
    ]);
  });

  // 한 턴에 삭제·수정·삽입을 섞어 마커 종류를 한 화면에서 확인한다.
  await page.evaluate(async () => {
    const ovk = window.__ovk;
    const c = await ovk.context();
    const [tableA, tableB] = c.tables;
    const at = (t) => ({ sectionIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx });
    const results = await ovk.stage([
      ['insert_text', { sectionIdx: 0, paraIdx: c.p('Body one.'), charOffset: c.len('Body one.'), text: ' added' }],
      ['edit_table', { ...at(tableA), op: 'delete_row', rowIdx: 1 }],
      ['edit_table', { ...at(tableA), op: 'delete_col', colIdx: 0 }],
      ['edit_table', { ...at(tableA), op: 'set_cell_props', cellIdx: 0, props: { fillColor: '#FFEEAA' } }],
      ['delete_table', at(tableB)],
      ['edit_header_footer', { sectionIdx: 0, which: 'header', text: 'Changed header' }],
      ['set_page_layout', { sectionIdx: 0, marginsMm: { left: 30, right: 30 } }],
      ['create_table', {
        sectionIdx: 0, paraIdx: c.p('End.'), charOffset: c.len('End.'),
        cells: [['n1', 'n2'], ['n3', 'n4']],
      }],
    ]);
    if (results.some((r) => r?.error)) throw new Error(`stage failed: ${JSON.stringify(results)}`);
  });

  // 앵커·틴트가 실제로 레이아웃될 때까지 기다린다.
  await page.waitForFunction(() =>
    document.querySelectorAll('.ag-exact-anchor.ag-exact-anchor-delete').length === 3
    && document.querySelectorAll('.ag-pending-marker.ag-modify').length >= 3
    && document.querySelectorAll('.ag-pending-marker.ag-pending-band.ag-modify').length >= 1
    && document.querySelectorAll('.ag-pending-marker.ag-pending-page.ag-modify').length >= 1
    && document.querySelectorAll('.ag-pending-marker.ag-pending-structure.ag-insert').length >= 1,
    { timeout: 15000 });

  const marks = await page.evaluate(() => {
    const list = (sel) => Array.from(document.querySelectorAll(sel)).map((n) => ({
      cls: n.className,
      rect: n.getBoundingClientRect().toJSON(),
    }));
    return {
      anchors: list('.ag-exact-anchor.ag-exact-anchor-delete'),
      modify: list('.ag-pending-marker.ag-modify'),
      band: list('.ag-pending-band'),
      pageMarks: list('.ag-pending-page'),
      inserts: list('.ag-pending-marker.ag-insert, .ag-exact-anchor.ag-exact-anchor-insert'),
      legacyDeleteRects: list('.ag-pending-marker.ag-delete'),
    };
  });
  assert.equal(marks.anchors.length, 3, '행·열·표 삭제마다 빨간 앵커 하나');
  assert.equal(marks.legacyDeleteRects.length, 0, 'remove 는 취소선 범위가 아니라 앵커다');
  assert.ok(marks.modify.length >= 3, '셀 변경 + 머리말 밴드 + 쪽 마커 = modify 틴트');
  assert.ok(marks.band.length >= 1, '기존 머리말 수정에 머리말 밴드 마커');
  assert.ok(marks.pageMarks.length >= 1, '쪽 설정 변경에 쪽 전체 마커');
  assert.ok(marks.inserts.length >= 1, '새 표·새 텍스트는 insert');
  await shot(page, 'pending-kinds.png');

  // 삭제 앵커에 호버하면 삭제 전 내용이 팝오버로 뜬다 — 앵커 순서 = op 순서(행, 열, 표).
  const anchorRect = marks.anchors[0].rect;
  await page.mouse.move(anchorRect.x + anchorRect.width / 2, anchorRect.y + anchorRect.height / 2, { steps: 4 });
  await page.waitForFunction(() => !document.querySelector('.ag-exact-popover')?.hidden, { timeout: 5000 });
  const rowPopover = await page.evaluate(() => ({
    label: document.querySelector('.ag-exact-popover-label')?.textContent,
    text: document.querySelector('.ag-exact-popover-text')?.textContent,
  }));
  assert.equal(rowPopover.label, '삭제된 내용');
  assert.equal(rowPopover.text, 'b1 | b2 | b3', '지워진 행의 원래 내용이 팝오버에 뜬다');
  await shot(page, 'remove-row-popover.png');

  const tableAnchorRect = marks.anchors[2].rect;
  await page.mouse.move(tableAnchorRect.x + tableAnchorRect.width / 2, tableAnchorRect.y + tableAnchorRect.height / 2, { steps: 4 });
  await page.waitForFunction(() =>
    document.querySelector('.ag-exact-popover-text')?.textContent === 'x1 | x2\ny1 | y2',
    { timeout: 5000 });
  await shot(page, 'remove-table-popover.png');

  // 리뷰 카드: '·' 설명 + '−' 삭제 내용 줄이 함께 보인다.
  const review = await page.evaluate(() => ({
    neutral: Array.from(document.querySelectorAll('.ag-changes-line-neutral')).map((n) => n.textContent),
    deleted: Array.from(document.querySelectorAll('.ag-changes-line-del')).map((n) => n.textContent),
  }));
  assert.ok(review.neutral.some((t) => t.includes('행 삭제')), '리뷰 카드에 행 삭제 설명');
  assert.ok(review.neutral.some((t) => t.includes('열 삭제')), '리뷰 카드에 열 삭제 설명');
  assert.ok(review.neutral.some((t) => t.includes('표 삭제')), '리뷰 카드에 표 삭제 설명');
  assert.ok(review.neutral.some((t) => t.includes('머리말 변경')), '리뷰 카드에 머리말 변경 설명');
  assert.ok(review.neutral.some((t) => t.includes('쪽 설정 변경')), '리뷰 카드에 쪽 설정 변경 설명');
  assert.ok(review.deleted.some((t) => t.includes('b1 | b2 | b3')), '리뷰 카드에 삭제된 행 내용');
  assert.ok(review.deleted.some((t) => t.includes('x1 | x2')), '리뷰 카드에 삭제된 표 내용');
  await shot(page, 'review-card.png');

  // 거절하면 마커가 모두 지워지고 표가 원상복구된다.
  const restored = await page.evaluate(async () => {
    const bridge = window.__agentBridge;
    const setId = bridge.pendingEdits.getChangeSets().at(-1)?.id;
    bridge.pendingEdits.reject(setId);
    await new Promise((r) => setTimeout(r, 300));
    const tables = (await window.__ovk.context()).tables;
    return {
      pending: bridge.pendingEdits.hasPending(),
      anchors: document.querySelectorAll('.ag-exact-anchor').length,
      markers: document.querySelectorAll('.ag-pending-marker').length,
      tableDims: tables.map((t) => `${t.rowCount}x${t.colCount}`),
      header: JSON.parse(window.__wasm.getHeaderFooter(0, true, 0))?.text ?? null,
    };
  });
  assert.equal(restored.pending, false, 'reject 후 pending 없음');
  assert.equal(restored.anchors + restored.markers, 0, 'reject 후 마커 없음');
  assert.deepEqual(restored.tableDims, ['3x3', '2x2'], 'reject 후 두 표 모두 복구');
  assert.equal(restored.header, 'Doc header', 'reject 후 머리말 원문 복구');
  await shot(page, 'rejected.png');

  assert.equal(errors.length, 0, `page errors: ${errors.join('; ')}`);
  console.log('[agent-overlay-kinds] ok', JSON.stringify({
    anchors: marks.anchors.length, modify: marks.modify.length,
    band: marks.band.length, page: marks.pageMarks.length,
    rowPopover: rowPopover.text, restored,
  }));
} finally {
  clearTimeout(watchdog);
  await closeBrowser(browser);
}
