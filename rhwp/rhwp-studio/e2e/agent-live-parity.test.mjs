/**
 * E2E: 에이전트 staged 편집의 라이브 렌더 동치성.
 *
 * 모든 staged 쓰기 도구는 호출 즉시 엔진에 적용된다 — 미리보기가 곧 승인 결과다.
 * 도구마다 window.__agentBridge.executor.execute 로 실제 도구 경로를 구동하고 쪽 수와
 * 쪽별 SVG 해시를 기록한 뒤 두 가지를 확인한다:
 *   1. reject → 턴 이전 해시와 같다 (되돌림이 정확하다)
 *   2. 같은 편집을 다시 staged → approve → staged 직후 해시와 같다 (승인은 채택만 한다)
 *   3. 승인 undo → 턴 이전 해시, redo → 승인 결과 해시
 *
 * 실행: npm run e2e:agent-live-parity
 *   (VITE_URL 의 dev server 와 CHROME_PATH 가 필요하다 — e2e/README.md)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { launchBrowser, createPage, closeBrowser, loadApp, createNewDocument } from './helpers.mjs';

// browser.close() 가 이 환경에서 멈출 수 있어 결과를 낸 뒤 스스로 끝낸다.
const watchdog = setTimeout(() => {
  console.error('[agent-live-parity] watchdog timeout');
  process.exit(2);
}, 300_000);

function pngBase64(width, height) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = (i * 7) % 255;
    png.data[i * 4 + 1] = 90;
    png.data[i * 4 + 2] = 160;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png).toString('base64');
}

const browser = await launchBrowser();
let failed = false;
try {
  const page = await createPage(browser, 1280, 900);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await loadApp(page);
  await page.waitForFunction(() => !!window.__agentBridge?.pendingEdits);
  await createNewDocument(page);

  await page.evaluate(() => {
    const bridge = window.__agentBridge;
    const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
    window.__parity = {
      svgs: {},
      async pages(label) {
        const wasm = window.__wasm;
        const hashes = [];
        const svgs = [];
        for (let page = 0; page < wasm.pageCount; page++) {
          // 누적 순서만 다른 부동소수 잡음(220.4 vs 220.40000000000003)은 같은 렌더로 본다.
          const svg = wasm.renderPageSvg(page)
            .replace(/-?\d+\.\d+/g, (value) => String(Math.round(Number(value) * 100) / 100));
          svgs.push(svg);
          hashes.push(hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(svg))));
        }
        if (label) window.__parity.svgs[label] = svgs;
        return { pageCount: wasm.pageCount, hashes };
      },
      async read(tool, args = {}) {
        return bridge.executor.execute(tool, args, 'claude');
      },
      async stage(calls) {
        bridge.pendingEdits.beginTurn('claude');
        const results = [];
        try {
          for (const [tool, args] of calls) {
            results.push(await bridge.executor.execute(tool, { ...args, expectedRevision: bridge.revision.revision }, 'claude'));
          }
        } finally {
          bridge.pendingEdits.endTurn('review');
        }
        const sets = bridge.pendingEdits.getChangeSets();
        return { setId: sets.at(-1)?.id ?? null, results, pendingSets: sets.length };
      },
      approve(id) { return bridge.pendingEdits.approve(id); },
      reject(id) { bridge.pendingEdits.reject(id); },
      pendingCount() { return bridge.pendingEdits.getChangeSets().length; },
      drops: [],
    };
    bridge.pendingEdits.onChange((event) => {
      if (event.type === 'invalidated') window.__parity.drops.push(event);
    });
  });

  const pages = (label) => page.evaluate((l) => window.__parity.pages(l), label);
  const outDir = path.resolve('../output/agent-live-parity');
  /** 쪽 해시가 다르면 두 상태의 SVG 를 남겨 원인을 바로 볼 수 있게 한다 */
  async function expectPages(label, expectedLabel, expected, message) {
    const actual = await pages(label);
    try {
      assert.deepEqual(actual, expected, message);
    } catch (error) {
      const svgs = await page.evaluate(() => window.__parity.svgs);
      fs.mkdirSync(outDir, { recursive: true });
      for (const [name, list] of Object.entries(svgs)) {
        if (name !== label && name !== expectedLabel) continue;
        list.forEach((svg, index) => fs.writeFileSync(path.join(outDir, `${name}-${index}.svg`), svg));
      }
      throw error;
    }
  }
  const stage = (calls) => page.evaluate((c) => window.__parity.stage(c), calls);
  const read = (tool, args) => page.evaluate((t, a) => window.__parity.read(t, a), tool, args);

  /** 현재 문서 좌표 — 문단은 텍스트 접두어로, 표는 get_structure tables[] 첫 항목으로 찾는다 */
  async function context() {
    const structure = await read('get_structure', { format: 'json', maxPreviewChars: 80 });
    const paragraphs = structure.sections[0].paragraphs;
    const tables = structure.sections[0].tables ?? [];
    const notes = (await read('list_footnotes')).notes;
    const styles = (await read('list_styles')).styles;
    return {
      p(prefix) {
        const found = paragraphs.find((para) => para.text.startsWith(prefix));
        assert.ok(found, `paragraph starting with "${prefix}"`);
        return found.paraIdx;
      },
      len(prefix) { return paragraphs.find((para) => para.text.startsWith(prefix)).length; },
      lenAt(paraIdx) { return paragraphs.find((para) => para.paraIdx === paraIdx).length; },
      table: tables[0] ?? null,
      tables,
      note: notes[0] ?? null,
      styleId: (styles.find((style) => style.id !== 0) ?? styles[0]).id,
      lastPara: paragraphs.at(-1).paraIdx,
    };
  }

  const at = (table) => ({ sectionIdx: 0, paraIdx: table.paraIdx, controlIdx: table.controlIdx });
  const cellOf = (table, cellIdx) => ({ paraIdx: table.paraIdx, controlIdx: table.controlIdx, cellIdx });

  async function commit(calls) {
    const staged = await stage(calls);
    assert.equal(await page.evaluate((id) => window.__parity.approve(id), staged.setId), true);
    return staged.results;
  }

  // 기준 문서: 문단 다섯 개 + 문단 3 끝의 글자처럼 취급하는 3×3 표 + 각주 + 머리말
  await commit([['insert_text', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0,
    text: 'Parity heading\nFirst body paragraph with words.\nSecond body paragraph for lists.\nThird paragraph holds a table:\nClosing paragraph.',
  }]]);
  {
    const ctx = await context();
    await commit([['create_table', {
      sectionIdx: 0, paraIdx: ctx.p('Third'), charOffset: ctx.len('Third'),
      cells: [['a', 'b', 'c'], ['1', '2', '3'], ['x', 'y', 'z']],
    }]]);
    await commit([
      ['insert_footnote', { sectionIdx: 0, paraIdx: ctx.p('First'), charOffset: 5, text: 'A note.' }],
      ['edit_header_footer', { sectionIdx: 0, which: 'header', lines: ['Parity header'] }],
    ]);
  }

  const image = pngBase64(24, 16);
  const cases = [
    ['insert_text', (c) => [['insert_text', { sectionIdx: 0, paraIdx: c.p('First'), charOffset: 5, text: ' inserted' }]]],
    ['insert_text splits the table paragraph', (c) => [['insert_text', { sectionIdx: 0, paraIdx: c.p('Third'), charOffset: 5, text: ' A\nB ' }]]],
    ['delete_range', (c) => [['delete_range', { sectionIdx: 0, startParaIdx: c.p('Second'), startCharOffset: 0, endParaIdx: c.p('Second'), endCharOffset: 7 }]]],
    ['replace_range', (c) => [['replace_range', { sectionIdx: 0, startParaIdx: c.p('First'), startCharOffset: 0, endParaIdx: c.p('First'), endCharOffset: 5, text: 'Opening' }]]],
    ['apply_char_format', (c) => [['apply_char_format', { sectionIdx: 0, paraIdx: c.p('Parity'), startOffset: 0, endOffset: 6, bold: true, fontSizePt: 16 }]]],
    ['apply_para_format', (c) => [['apply_para_format', { sectionIdx: 0, paraIdx: c.p('Parity'), alignment: 'center', spaceAfterPt: 8 }]]],
    ['apply_style', (c) => [['apply_style', { sectionIdx: 0, paraIdx: c.p('Closing'), styleId: c.styleId }]]],
    ['apply_list', (c) => [['apply_list', { sectionIdx: 0, startParaIdx: c.p('Opening'), endParaIdx: c.p('Opening') + 1, format: '1.' }]]],
    ['insert_page_break', (c) => [['insert_page_break', { sectionIdx: 0, paraIdx: c.p('Closing') }]]],
    ['insert_footnote', (c) => [['insert_footnote', { sectionIdx: 0, paraIdx: c.p('Closing'), charOffset: 3, text: 'Second note.' }]]],
    ['edit_footnote', (c) => [['edit_footnote', { sectionIdx: 0, paraIdx: c.note.paraIdx, controlIdx: c.note.controlIdx, text: 'Edited note.' }]]],
    ['set_bookmark', (c) => [['set_bookmark', { op: 'add', name: 'parity', sectionIdx: 0, paraIdx: c.p('Closing'), charOffset: 1 }]]],
    ['edit_header_footer existing', () => [['edit_header_footer', { sectionIdx: 0, which: 'header', lines: ['Replaced header', 'second line'] }]]],
    ['edit_header_footer new', () => [['edit_header_footer', {
      sectionIdx: 0, which: 'footer', pageNumber: { template: 'Page {n}', align: 'right' },
    }]]],
    // 바깥쪽 쪽번호 + 시작 번호: 홀수-오른쪽/짝수-왼쪽 꼬리말 쌍과 SectionDef.pageNum 이 한 세트로 스테이징된다
    ['edit_header_footer outside + startPageNumber', () => [['edit_header_footer', {
      sectionIdx: 0, which: 'footer', pageNumber: { template: '- {n} -', align: 'outside' }, startPageNumber: 3,
    }]]],
    ['set_page_layout', () => [['set_page_layout', { sectionIdx: 0, marginsMm: { left: 25, right: 25 } }]]],
    ['insert_equation', (c) => [['insert_equation', { sectionIdx: 0, paraIdx: c.p('Closing'), charOffset: 2, script: 'x over y' }]]],
    ['insert_image', (c) => [['insert_image', {
      sectionIdx: 0, paraIdx: c.p('Closing'), charOffset: 0, imageBase64: image, extension: 'png',
      naturalWidthPx: 24, naturalHeightPx: 16, widthMm: 12,
    }]]],
    ['replace_all', () => [['replace_all', { query: 'paragraph', replacement: 'para' }]]],
    ['create_table', (c) => [['create_table', { sectionIdx: 0, paraIdx: c.lastPara, charOffset: 0, cells: [['k', 'v'], ['1', '2']] }]]],
    ['edit_table insert_row', (c) => [['edit_table', { ...at(c.table), op: 'insert_row', rowIdx: 0 }]]],
    ['edit_table insert_col', (c) => [['edit_table', { ...at(c.table), op: 'insert_col', colIdx: 1 }]]],
    ['edit_table delete_row', (c) => [['edit_table', { ...at(c.table), op: 'delete_row', rowIdx: 1 }]]],
    ['edit_table delete_col', (c) => [['edit_table', { ...at(c.table), op: 'delete_col', colIdx: 0 }]]],
    ['edit_table merge_cells', (c) => [['edit_table', { ...at(c.table), op: 'merge_cells', startRow: 0, startCol: 0, endRow: 0, endCol: 1 }]]],
    ['edit_table split_cell', (c) => [['edit_table', { ...at(c.table), op: 'split_cell', rowIdx: 1, colIdx: 0, splitRows: 2, splitCols: 1 }]]],
    ['edit_table set_cell_props', (c) => [['edit_table', { ...at(c.table), op: 'set_cell_props', cellIdx: 0, props: { fillColor: '#FFEEAA', verticalAlign: 'center' } }]]],
    ['edit_table set_table_props', (c) => [['edit_table', { ...at(c.table), op: 'set_table_props', props: { cellPaddingMm: { left: 2, right: 2 } } }]]],
    ['edit_table set_column_widths', (c) => [['edit_table', { ...at(c.table), op: 'set_column_widths', columnWidthsMm: Array.from({ length: c.table.colCount }, (_, i) => 30 + i * 10) }]]],
    ['edit_table fit_to_page', (c) => [
      ['edit_table', { ...at(c.table), op: 'set_column_widths', columnWidthsMm: Array.from({ length: c.table.colCount }, () => 120) }],
      ['edit_table', { ...at(c.table), op: 'fit_to_page' }],
    ]],
    ['edit_table set_zone_borders', (c) => [['edit_table', {
      ...at(c.table), op: 'set_zone_borders', startCell: { row: 0, col: 0 }, endCell: { row: 1, col: 1 },
      borderTop: { type: 1, width: 3, color: '#223344' }, fillColor: '#EEEEEE',
    }]]],
    ['edit_table apply_formula', (c) => [
      ['insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '7', cell: cellOf(c.table, c.table.cellCount - 2) }],
      ['edit_table', { ...at(c.table), op: 'apply_formula', row: c.table.rowCount - 1, col: c.table.colCount - 1, formula: '=SUM(left)' }],
    ]],
    ['edit_table set_caption', (c) => [['edit_table', { ...at(c.table), op: 'set_caption', text: 'Parity caption' }]]],
    ['apply_edits keeps the table editable after a structure op', (c) => [['apply_edits', { edits: [
      { tool: 'edit_table', args: { ...at(c.table), op: 'delete_row', rowIdx: 0 } },
      { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'after ', cell: cellOf(c.table, 0) } },
      { tool: 'edit_table', args: { ...at(c.table), op: 'set_cell_props', cellIdx: 0, props: { fillColor: '#DDEEFF' } } },
    ] }]]],
    // 개체를 가진 문단이 나뉘거나 합쳐지면 엔진이 옮긴 개체 주소를 따라가야 되돌림이 제자리에 떨어진다
    ['a line break before a staged table op', (c) => [
      ['edit_table', { ...at(c.table), op: 'set_cell_props', cellIdx: 0, props: { fillColor: '#CCE5FF' } }],
      ['insert_text', { sectionIdx: 0, paraIdx: c.table.paraIdx, charOffset: 1, text: 'X\nY' }],
    ]],
    ['merging a table paragraph after a staged table op', (c) => [
      ['edit_table', { ...at(c.table), op: 'set_cell_props', cellIdx: 1, props: { fillColor: '#E5FFCC' } }],
      ['delete_range', {
        sectionIdx: 0, startParaIdx: c.table.paraIdx - 1, startCharOffset: c.lenAt(c.table.paraIdx - 1),
        endParaIdx: c.table.paraIdx, endCharOffset: 0,
      }],
    ]],
    ['a line break before a staged image', (c) => [
      ['insert_image', {
        sectionIdx: 0, paraIdx: c.p('Closing'), charOffset: 6, imageBase64: image, extension: 'png',
        naturalWidthPx: 24, naturalHeightPx: 16, widthMm: 10,
      }],
      ['insert_text', { sectionIdx: 0, paraIdx: c.p('Closing'), charOffset: 1, text: 'X\nY' }],
    ]],
    // 한 턴에 섞인 편집 — 되돌림은 역순으로 각자의 적용 직후 상태를 거쳐야 한다
    ['style, character format and replace in one paragraph', (c) => [
      ['apply_style', { sectionIdx: 0, paraIdx: c.p('Parity'), styleId: c.styleId }],
      ['apply_char_format', { sectionIdx: 0, paraIdx: c.p('Parity'), startOffset: 0, endOffset: 6, italic: true }],
      ['replace_range', { sectionIdx: 0, startParaIdx: c.p('Parity'), startCharOffset: 0, endParaIdx: c.p('Parity'), endCharOffset: 6, text: 'Parity!' }],
    ]],
    ['cell text around table structure ops', (c) => [
      ['insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'q', cell: cellOf(c.table, 0) }],
      ['edit_table', { ...at(c.table), op: 'insert_row', rowIdx: 0, below: false }],
      ['edit_table', { ...at(c.table), op: 'merge_cells', startRow: 0, startCol: 0, endRow: 0, endCol: 1 }],
      ['insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'm', cell: cellOf(c.table, 0) }],
      ['edit_table', { ...at(c.table), op: 'set_column_widths', columnWidthsMm: Array.from({ length: c.table.colCount }, () => 25) }],
    ]],
    ['a new table built up in one turn', (c) => {
      const table = { sectionIdx: 0, paraIdx: c.p('body'), controlIdx: 0 };
      return [
        ['create_table', { sectionIdx: 0, paraIdx: c.p('body'), charOffset: 4, cells: [['h1', 'h2'], ['v1', 'v2']] }],
        ['edit_table', { ...table, op: 'insert_row', rowIdx: 1 }],
        ['insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'new', cell: { paraIdx: table.paraIdx, controlIdx: 0, cellIdx: 4 } }],
        ['edit_table', { ...table, op: 'merge_cells', startRow: 2, startCol: 0, endRow: 2, endCol: 1 }],
        ['edit_table', { ...table, op: 'set_cell_props', cellIdx: 0, props: { fillColor: '#FFE0E0' } }],
      ];
    }],
    ['a footnote and a line break before it', (c) => [
      ['insert_footnote', { sectionIdx: 0, paraIdx: c.p('Opening'), charOffset: 10, text: 'Split note.' }],
      ['insert_text', { sectionIdx: 0, paraIdx: c.p('Opening'), charOffset: 2, text: 'X\nY' }],
    ]],
    ['delete_table', (c) => [['delete_table', at(c.table)]]],
  ];

  const report = [];
  for (const [name, build] of cases) {
    const before = await pages('before');
    const first = await stage(build(await context()));
    assert.ok(first.setId, `${name}: a change set is staged`);
    const staged = await pages('staged');
    await page.evaluate((id) => window.__parity.reject(id), first.setId);
    await expectPages('rejected', 'before', before, `${name}: reject restores the pre-turn pages`);

    const second = await stage(build(await context()));
    await expectPages('restaged', 'staged', staged, `${name}: staging the same edit again renders the same pages`);
    assert.equal(await page.evaluate((id) => window.__parity.approve(id), second.setId), true, `${name}: approve succeeds`);
    await expectPages('approved', 'staged', staged, `${name}: approve keeps the live preview unchanged`);
    assert.equal(await page.evaluate(() => window.__parity.pendingCount()), 0, `${name}: nothing stays pending`);
    // 승인이 만든 undo 항목은 턴 이전 문서로, redo 는 승인 결과로 돌아간다
    await page.evaluate(() => window.__inputHandler.performUndo());
    await expectPages('undone', 'before', before, `${name}: undo of the approved turn restores the pre-turn pages`);
    await page.evaluate(() => window.__inputHandler.performRedo());
    await expectPages('redone', 'staged', staged, `${name}: redo restores the approved pages`);
    report.push({ name, pages: staged.pageCount, changed: JSON.stringify(staged) !== JSON.stringify(before) });
  }

  const drops = await page.evaluate(() => window.__parity.drops);
  assert.deepEqual(drops, [], 'no staged edit was dropped or left behind');
  assert.deepEqual(pageErrors, [], 'no page errors');
  const unchanged = report.filter((entry) => !entry.changed).map((entry) => entry.name);
  console.log(`[agent-live-parity] ${report.length} staged tools: reject, approve and undo match the live preview`);
  if (unchanged.length > 0) console.log(`[agent-live-parity] render-neutral edits: ${unchanged.join(', ')}`);
} catch (error) {
  failed = true;
  console.error('[agent-live-parity] FAIL', error);
} finally {
  clearTimeout(watchdog);
  await Promise.race([closeBrowser(browser), new Promise((resolve) => setTimeout(resolve, 5000))]);
  process.exit(failed ? 1 : 0);
}
