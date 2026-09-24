/**
 * Real WASM corpus check for agent edits in table cells.
 *
 * Run with a studio Vite server:
 *   VITE_URL=http://127.0.0.1:7701 CHROME_PATH=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *     node e2e/agent-preview-integrity.test.mjs --mode=headless
 * Use --discover to inventory candidates, --only=<sample-relative-path> for a tight repro,
 * or --limit=N while developing. Artifacts are written outside the source tree by default.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, createPage, closeBrowser, loadApp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesRoot = path.resolve(here, '../../samples');
const artifactRoot = path.resolve(here, process.env.PREVIEW_INTEGRITY_ARTIFACTS || '../../../output/e2e/agent-preview-integrity');
const corpus = JSON.parse(fs.readFileSync(path.join(here, 'agent-preview-corpus.json'), 'utf8'));
assert.equal(corpus.samples.length, 20, 'corpus manifest has 20 documents');
assert.equal(new Set(corpus.samples.map(item => item.path)).size, 20, 'corpus document paths are distinct');
for (const item of corpus.samples) assert.ok(fs.existsSync(path.join(samplesRoot, item.path)), `missing corpus sample ${item.path}`);
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
const after = process.argv.find(arg => arg.startsWith('--after='))?.slice(8);
const targeted = process.argv.includes('--targeted');
const baselineOnly = process.argv.includes('--baseline-only');
const limit = Number(process.argv.find(arg => arg.startsWith('--limit='))?.slice(8)
  || (only ? 1 : targeted ? corpus.targetedSamples.length : 20));
const discover = process.argv.includes('--discover');
const candidates = [
  'table-complex.hwp', 'hwpers_test4_complex_table.hwp', 'multi-table-001.hwp',
  'multi-table-002.hwp', 'hwp_table_test.hwp', 'hwp_table_test-m.hwp',
  'table-001.hwp', 'table-004.hwp', 'inner-table-01.hwp',
  'form-01.hwp', 'form-02.hwp', 'issue-986-receipt.hwp',
  'pic-in-table-01.hwp', 'pic-in-table-with-toggle.hwp', 'issue2004_cell_image_stack.hwp',
  'task1716/table_scattered_header_rowbreak.hwpx', 'table_scattered_header_rowbreak.hwp',
  'task2105/rowbreak_table_declared_fits.hwpx', 'task2146/21761835_jeonjik_exemption_table.hwp',
  'task2319/20544835_jinan_apt_form.hwp', 'task2322/20862337_cheongyang_voucher_form.hwp',
  'task2322/19439117_gokseong_voucher_form.hwp', 'issue2808_single_table_form_physical_ladder.hwpx',
  'hwpx/basic-table-01.hwpx', 'hwpx/form-01.hwpx', 'hwpx/form-002.hwpx',
  'rendering-fidelity/02-table-merged-padding-valign.hwpx',
  'rendering-fidelity/03-table-nested.hwpx', 'rendering-fidelity/07-image-inline-crop.hwpx',
  'tac-img-02.hwp', 'tac-img-02.hwpx', 'exam_math.hwp', 'exam_math_8.hwp',
  'issue-505-equations.hwp', 'math-001.hwp', 'hwpx/math-001.hwpx',
  '21868765_별표2_보건소_분장사무.hwp',
];

function sampleUrl(name) {
  return `/samples/${name.split('/').map(encodeURIComponent).join('/')}`;
}

function safeName(name) {
  return name.replace(/[^\p{L}\p{N}.-]+/gu, '_');
}

async function openSample(page, name) {
  const url = sampleUrl(name);
  const loaded = await page.evaluate(async ({ url, name }) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const requestId = `preview-integrity-${Date.now()}`;
    const opened = new Promise((resolve, reject) => {
      const off = window.__eventBus.on('open-document-bytes:done', result => {
        if (result.requestId !== requestId) return;
        off();
        if (result.ok) resolve();
        else reject(new Error(result.error || 'open-document-bytes failed'));
      });
    });
    window.__eventBus.emit('open-document-bytes', {
      bytes, fileName: name, requestId, suppressDialogs: true, skipUnsavedGuard: true,
    });
    await opened;
    return { pages: window.__wasm.pageCount, bytes: bytes.length };
  }, { url, name });
  await page.waitForFunction(() => window.__wasm.pageCount > 0 && !!document.querySelector('#scroll-content canvas'), { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.welcome-dialog, .open-document-dialog, .start-screen'),
    { timeout: 2000 }).catch(() => {});
  return loaded;
}

// All measurements use the live WASM document. The all-cell text snapshot catches
// collateral edits in other cells, while page control types catch lost image/equation objects.
async function inspect(page) {
  return page.evaluate(() => {
    const wasm = window.__wasm;
    const controls = [];
    const textLayouts = [];
    const pageInfos = [];
    const tables = [];
    const seen = new Set();
    for (let page = 0; page < wasm.pageCount; page++) {
      const { width, height, marginBottom } = wasm.getPageInfo(page);
      pageInfos.push({ width, height, marginBottom });
      textLayouts.push(JSON.parse(wasm.doc.getPageTextLayout(page)));
      const layout = wasm.getPageControlLayout(page);
      for (const control of layout.controls ?? []) {
        const { type, secIdx, paraIdx, controlIdx, outerTableControlIdx, noteRef, headerFooter,
          cellIdx, cellParaIdx, innerControlIdx, x, y, w, h } = control;
        controls.push({ page, type, secIdx, paraIdx, controlIdx, outerTableControlIdx,
          cellIdx, cellParaIdx, innerControlIdx, x, y, w, h });
        if (type !== 'table' || noteRef || headerFooter || outerTableControlIdx !== undefined) continue;
        const key = `${secIdx}:${paraIdx}:${controlIdx}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let dims;
        try { dims = wasm.getTableDimensions(secIdx, paraIdx, controlIdx); } catch { continue; }
        const cells = [];
        for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx++) {
          const info = wasm.getCellInfo(secIdx, paraIdx, controlIdx, cellIdx);
          const count = wasm.getCellParagraphCount(secIdx, paraIdx, controlIdx, cellIdx);
          const paragraphs = [];
          for (let cp = 0; cp < count; cp++) {
            const length = wasm.getCellParagraphLength(secIdx, paraIdx, controlIdx, cellIdx, cp);
            paragraphs.push({ length, text: wasm.getTextInCell(secIdx, paraIdx, controlIdx, cellIdx, cp, 0, length) });
          }
          cells.push({ row: info.row, col: info.col, rowSpan: info.rowSpan, colSpan: info.colSpan, paragraphs });
        }
        let bbox = null;
        try { bbox = wasm.getTableBBox(secIdx, paraIdx, controlIdx); } catch { /* offscreen table */ }
        tables.push({ key, secIdx, paraIdx, controlIdx, ...dims, cells, bbox });
      }
    }
    const target = tables.flatMap((table, tableIdx) => table.cells.flatMap((cell, cellIdx) =>
      cell.paragraphs.map((paragraph, cp) => ({ tableIdx, cellIdx, cp, text: paragraph.text, length: paragraph.length }))))
      .find(item => item.length >= 2 && item.text.trim().length >= 2 && !item.text.includes('\n'));
    return {
      pageCount: wasm.pageCount,
      sectionCount: wasm.getSectionCount(),
      paragraphCounts: Array.from({ length: wasm.getSectionCount() }, (_, sec) => wasm.getParagraphCount(sec)),
      controls,
      pageInfos,
      textLayouts,
      tables,
      target: target || null,
      pendingSets: window.__agentBridge.pendingEdits.getChangeSets().length,
    };
  });
}

function coreStructure(state) {
  return {
    sectionCount: state.sectionCount,
    paragraphCounts: state.paragraphCounts,
    tableCount: state.tables.length,
    tables: state.tables.map(t => ({ key: t.key, rowCount: t.rowCount, colCount: t.colCount,
      cellCount: t.cellCount, cells: t.cells.map(c => ({ row: c.row, col: c.col, rowSpan: c.rowSpan,
        colSpan: c.colSpan, paragraphCount: c.paragraphs.length })) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    // A control may repeat on each rendered page. Compare object identities, not page placement.
    objectKeys: [...new Set(state.controls.filter(c => c.type !== 'table')
      .map(c => `${c.type}:${c.secIdx}:${c.paraIdx}:${c.controlIdx}:${c.outerTableControlIdx ?? ''}`))].sort(),
  };
}

function cellTexts(state) {
  return state.tables.map(t => t.cells.map(c => c.paragraphs.map(p => p.text)));
}

function cellTextsByKey(state) {
  return Object.fromEntries(state.tables.map(t => [t.key,
    t.cells.map(c => c.paragraphs.map(p => p.text))]));
}

function tableCellStructure(state) {
  return state.tables.map(t => ({ key: t.key, rowCount: t.rowCount, colCount: t.colCount,
    cellCount: t.cellCount, cells: t.cells.map(c => ({ row: c.row, col: c.col,
      rowSpan: c.rowSpan, colSpan: c.colSpan, paragraphs: c.paragraphs.length })) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function siblingTableOverlaps(state) {
  const pairs = {};
  const known = new Set(state.tables.map(table => table.key));
  const fragments = state.controls.filter(control => control.type === 'table'
    && control.outerTableControlIdx === undefined
    && known.has(`${control.secIdx}:${control.paraIdx}:${control.controlIdx}`));
  for (let i = 0; i < fragments.length; i++) {
    const a = fragments[i];
    for (let j = i + 1; j < fragments.length; j++) {
      const b = fragments[j];
      if (a.page !== b.page) continue;
      const aId = `${a.secIdx}:${a.paraIdx}:${a.controlIdx}`;
      const bId = `${b.secIdx}:${b.paraIdx}:${b.controlIdx}`;
      if (aId === bId) continue;
      const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (width <= 0.5 || height <= 0.5) continue;
      const key = `${a.page}|${[aId, bId].sort().join('|')}`;
      pairs[key] = Math.max(pairs[key] ?? 0, width * height);
    }
  }
  return pairs;
}

function assertNoNewSiblingTableOverlap(state, baseline, label) {
  const before = siblingTableOverlaps(baseline);
  const after = siblingTableOverlaps(state);
  const growth = Object.entries(after).filter(([key, area]) => area > (before[key] ?? 0) + 2)
    .map(([key, area]) => ({ pair: key, baselineArea: before[key] ?? 0, pendingArea: area }));
  sameJson(growth, [], `${label} adds no sibling table overlap`);
}

function tablePageOverflow(state) {
  const reaches = {};
  const known = new Set(state.tables.map(table => table.key));
  for (const control of state.controls) {
    if (control.type !== 'table' || control.outerTableControlIdx !== undefined) continue;
    const id = `${control.secIdx}:${control.paraIdx}:${control.controlIdx}`;
    if (!known.has(id)) continue;
    const page = state.pageInfos[control.page];
    if (!page) continue;
    const key = `${control.page}|${id}`;
    const reachesNow = {
      left: Math.max(0, -control.x),
      right: Math.max(0, control.x + control.w - page.width),
      top: Math.max(0, -control.y),
      bottom: Math.max(0, control.y + control.h - page.height),
      contentBottom: Math.max(0, control.y + control.h - (page.height - page.marginBottom)),
    };
    const prev = reaches[key];
    reaches[key] = prev ? Object.fromEntries(Object.keys(reachesNow)
      .map(side => [side, Math.max(prev[side], reachesNow[side])])) : reachesNow;
  }
  return reaches;
}

function assertNoNewTablePageOverflow(state, baseline, label) {
  const before = tablePageOverflow(baseline);
  const after = tablePageOverflow(state);
  const growth = Object.entries(after).flatMap(([key, sides]) => Object.entries(sides)
    .filter(([side, extent]) => extent > (before[key]?.[side] ?? 0) + 0.5)
    .map(([side, extent]) => ({ fragment: key, side,
      baseline: before[key]?.[side] ?? 0, pending: extent })));
  sameJson(growth, [], `${label} adds no table overflow beyond page or content bounds`);
}

function bodyObjectTableOverlaps(state, baseline, insertedImageAnchor = null) {
  const pairs = {};
  const normalizedIdx = control => insertedImageAnchor && control.secIdx === 0
    && control.paraIdx === insertedImageAnchor.paraIdx
    && control.controlIdx > insertedImageAnchor.controlIdx
      ? control.controlIdx - 1 : control.controlIdx;
  const tableId = control => `${control.secIdx}:${control.paraIdx}:${normalizedIdx(control)}`;
  const objectId = control => `${control.type}:${control.secIdx}:${control.paraIdx}:${normalizedIdx(control)}`;
  const knownTables = new Set(baseline.tables.map(table => table.key));
  const knownObjects = new Set(baseline.controls.filter(control =>
    (control.type === 'image' || control.type === 'equation' || control.type === 'shape')
      && control.outerTableControlIdx === undefined && control.cellIdx === undefined)
    .map(control => `${control.type}:${control.secIdx}:${control.paraIdx}:${control.controlIdx}`));
  const tables = state.controls.filter(control => control.type === 'table'
    && control.outerTableControlIdx === undefined
    && knownTables.has(tableId(control)));
  const objects = state.controls.filter(control => knownObjects.has(objectId(control))
    && !(insertedImageAnchor && control.type === 'image' && control.secIdx === 0
      && control.paraIdx === insertedImageAnchor.paraIdx
      && control.controlIdx === insertedImageAnchor.controlIdx)
    && control.outerTableControlIdx === undefined && control.cellIdx === undefined);
  for (const table of tables) for (const object of objects) {
    if (table.page !== object.page) continue;
    const width = Math.min(table.x + table.w, object.x + object.w) - Math.max(table.x, object.x);
    const height = Math.min(table.y + table.h, object.y + object.h) - Math.max(table.y, object.y);
    if (width <= 0.5 || height <= 0.5) continue;
    const key = `${table.page}|${tableId(table)}|${objectId(object)}`;
    pairs[key] = Math.max(pairs[key] ?? 0, width * height);
  }
  return pairs;
}

function assertNoNewBodyObjectTableOverlap(state, baseline, label, insertedImageAnchor = null) {
  const before = bodyObjectTableOverlaps(baseline, baseline);
  const after = bodyObjectTableOverlaps(state, baseline, insertedImageAnchor);
  const growth = Object.entries(after).filter(([key, area]) => area > (before[key] ?? 0) + 2)
    .map(([key, area]) => ({ pair: key, baselineArea: before[key] ?? 0, pendingArea: area }));
  sameJson(growth, [], `${label} adds no overlap with an existing body image, equation, or shape`);
}

async function targetCharShapes(page, table, target) {
  return page.evaluate(({ table, target }) => {
    const wasm = window.__wasm;
    return Array.from({ length: target.length }, (_, offset) =>
      wasm.getCellCharPropertiesAt(table.secIdx, table.paraIdx, table.controlIdx,
        target.cellIdx, target.cp, offset).charShapeId);
  }, { table, target });
}

function geometry(state, includeTextLayout = false) {
  return { pageCount: state.pageCount, pageInfos: state.pageInfos,
    tables: state.tables.map(t => t.bbox),
    // getPageControlLayout has one entry per rendered fragment, including objects
    // inside table cells. Keep every page and rectangle, not only the first table bbox.
    renderedControls: state.controls,
    // Full text layouts are compared separately; keep their digest in artifacts.
    ...(includeTextLayout ? { textLayout: {
      runs: state.textLayouts.reduce((n, layout) => n + (layout.runs?.length ?? 0), 0),
      sha256: createHash('sha256').update(JSON.stringify(state.textLayouts)).digest('hex'),
    } } : {}) };
}

function unrelatedTextRuns(state, table, target, paintedOnly = true) {
  return state.textLayouts.flatMap((layout, page) => (layout.runs ?? [])
    .filter(run => !(run.secIdx === table.secIdx
      && run.parentParaIdx === table.paraIdx
      && run.controlIdx === table.controlIdx
      && run.cellIdx === target.cellIdx
      && run.cellParaIdx === target.cp))
    // Empty runs and spaces carry caret geometry without painted ink. Track their
    // digest in artifacts, while requiring all visible glyph runs to stay exact.
    .filter(run => !paintedOnly || run.text.trim().length > 0)
    .map(run => ({ page, ...run })));
}

function objectCounts(state) {
  const counts = {};
  for (const key of coreStructure(state).objectKeys) {
    const [type, secIdx, paraIdx, , outerTableControlIdx] = key.split(':');
    const origin = `${type}:${secIdx}:${paraIdx}:${outerTableControlIdx}`;
    counts[origin] = (counts[origin] ?? 0) + 1;
  }
  return counts;
}

function targetTextRunCount(state, table, target) {
  return state.textLayouts.reduce((count, layout) => count + (layout.runs ?? []).filter(run =>
    run.secIdx === table.secIdx && run.parentParaIdx === table.paraIdx
    && run.controlIdx === table.controlIdx && run.cellIdx === target.cellIdx
    && run.cellParaIdx === target.cp).length, 0);
}

function targetTextRunStyles(state, table, target) {
  return state.textLayouts.flatMap(layout => (layout.runs ?? []).filter(run =>
    run.secIdx === table.secIdx && run.parentParaIdx === table.paraIdx
    && run.controlIdx === table.controlIdx && run.cellIdx === target.cellIdx
    && run.cellParaIdx === target.cp).map(run => ({
      charShapeId: run.charShapeId, paraShapeId: run.paraShapeId,
      fontFamily: run.fontFamily, fontSize: run.fontSize, bold: run.bold,
      italic: run.italic, ratio: run.ratio, letterSpacing: run.letterSpacing,
      underline: run.underline, strikethrough: run.strikethrough, textColor: run.textColor,
    })));
}

function sameJson(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
}

async function replaceCell(page, table, target, replacement, options = {}) {
  return page.evaluate(({ table, target, replacement, options }) => {
    const pending = window.__agentBridge.pendingEdits;
    pending.beginTurn('codex');
    const result = pending.replaceText({
      sectionIdx: table.secIdx, startParaIdx: target.cp, startCharOffset: 0,
      endParaIdx: target.cp, endCharOffset: target.length,
      cell: { paraIdx: table.paraIdx, controlIdx: table.controlIdx, cellIdx: target.cellIdx },
    }, replacement, 'codex', options);
    return { changeSetId: result.changeSetId, pending: pending.hasPending(),
      setCount: pending.getChangeSets().length };
  }, { table, target, replacement, options });
}

async function endTurn(page) {
  await page.evaluate(() => window.__agentBridge.pendingEdits.endTurn('review'));
}

async function insertCellEquation(page, table, target) {
  return page.evaluate(({ table, target }) => {
    const pending = window.__agentBridge.pendingEdits;
    pending.beginTurn('codex');
    const result = pending.addObjectOp('codex', {
      type: 'insertEquation', sectionIdx: table.secIdx, paraIdx: target.cp, charOffset: 0,
      cell: { paraIdx: table.paraIdx, controlIdx: table.controlIdx, cellIdx: target.cellIdx,
        path: [{ controlIndex: table.controlIdx, cellIndex: target.cellIdx, cellParaIndex: target.cp }] },
      script: 'x over y', fontSizeHu: 1200, colorRef: 0,
    });
    pending.endTurn('review');
    return { changeSetId: result.changeSetId, anchor: result.obj.anchor };
  }, { table, target });
}

async function insertBodyImage(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#194a8e'; ctx.fillRect(0, 0, 120, 80);
    ctx.fillStyle = '#ff664c'; ctx.fillRect(12, 12, 96, 56);
    const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
    const pending = window.__agentBridge.pendingEdits;
    pending.beginTurn('codex');
    const result = pending.addObjectOp('codex', {
      type: 'insertImage', sectionIdx: 0, paraIdx: 0, charOffset: 0,
      bytes, extension: 'png', widthHu: 4500, heightHu: 3000,
      naturalWidthPx: 120, naturalHeightPx: 80, description: 'Preview integrity image',
    });
    pending.endTurn('review');
    return { changeSetId: result.changeSetId, anchor: result.obj.anchor };
  });
}

async function pendingMarkers(page) {
  return page.evaluate(() => [...document.querySelectorAll('.ag-pending-marker')].map(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
}

function controlCount(state, type) {
  return state.controls.filter(control => control.type === type).length;
}

function equationOrigins(state) {
  return new Set(state.controls.filter(control => control.type === 'equation').map(control =>
    `${control.secIdx}:${control.paraIdx}:${control.controlIdx}:${control.cellIdx ?? ''}:`
      + `${control.cellParaIdx ?? ''}:${control.innerControlIdx ?? ''}`));
}

function assertMarker(markers, label) {
  assert.ok(markers.some(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0), `${label} has a finite visible pending marker`);
}

async function focusTarget(page, table, target) {
  return page.evaluate(async ({ table, target }) => {
    const wasm = window.__wasm;
    const input = window.__inputHandler;
    const rect = wasm.getCursorRectInCell(table.secIdx, table.paraIdx,
      table.controlIdx, target.cellIdx, target.cp, 0);
    const virtualScroll = input.virtualScroll;
    const pageWidth = wasm.getPageInfo(rect.pageIndex).width;
    const availableWidth = input.container.clientWidth - 40;
    const initialZoom = input.viewportManager.getZoom();
    if (pageWidth * initialZoom > availableWidth && availableWidth > 0) {
      input.viewportManager.setZoom(availableWidth / pageWidth);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const zoom = input.viewportManager.getZoom();
    input.container.scrollLeft = 0;
    input.container.scrollTop = Math.max(0, virtualScroll.getPageOffset(rect.pageIndex) + rect.y * zoom - 220);
    return { pageIndex: rect.pageIndex, x: rect.x, y: rect.y, zoom, pageWidth };
  }, { table, target });
}

async function settleFrames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function topLevelTableFragments(page) {
  return page.evaluate(() => {
    const wasm = window.__wasm;
    return Array.from({ length: wasm.pageCount }, (_, pageIndex) =>
      (wasm.getPageControlLayout(pageIndex).controls ?? [])
        .filter(control => control.type === 'table' && control.outerTableControlIdx === undefined)
        .map(control => ({ page: pageIndex,
          key: `${control.secIdx}:${control.paraIdx}:${control.controlIdx}`,
          x: control.x, y: control.y, w: control.w, h: control.h,
          rowCount: control.rowCount, colCount: control.colCount,
          cells: (control.cells ?? []).map(cell => ({ row: cell.row, col: cell.col,
            rowSpan: cell.rowSpan, colSpan: cell.colSpan,
            x: cell.x, y: cell.y, w: cell.w, h: cell.h })) })));
  });
}

async function newEquationPlacements(page, originalOrigins) {
  return page.evaluate(originalOrigins => {
    const seen = new Set(originalOrigins);
    const wasm = window.__wasm;
    const placements = [];
    for (let pageIndex = 0; pageIndex < wasm.pageCount; pageIndex++) {
      const controls = wasm.getPageControlLayout(pageIndex).controls ?? [];
      for (const equation of controls.filter(control => control.type === 'equation')) {
        const origin = `${equation.secIdx}:${equation.paraIdx}:${equation.controlIdx}:`
          + `${equation.cellIdx ?? ''}:${equation.cellParaIdx ?? ''}:${equation.innerControlIdx ?? ''}`;
        if (seen.has(origin)) continue;
        const table = controls.find(control => control.type === 'table'
          && control.secIdx === equation.secIdx && control.paraIdx === equation.paraIdx
          && control.controlIdx === equation.controlIdx);
        const cell = table?.cells?.find(item => item.cellIdx === equation.cellIdx);
        placements.push({ page: pageIndex, origin,
          equation: { x: equation.x, y: equation.y, w: equation.w, h: equation.h },
          cell: cell ? { x: cell.x, y: cell.y, w: cell.w, h: cell.h } : null });
      }
    }
    return placements;
  }, [...originalOrigins]);
}

function assertFragmentCellCoverage(fragments, state, label) {
  const byKey = new Map();
  for (const fragment of fragments.flat()) {
    const list = byKey.get(fragment.key) ?? [];
    list.push(fragment);
    byKey.set(fragment.key, list);
    for (const cell of fragment.cells) {
      assert.ok([cell.x, cell.y, cell.w, cell.h].every(Number.isFinite)
        && cell.w > 0 && cell.h > 0, `${label} has a finite positive cell box`);
      assert.ok(cell.x >= fragment.x - 0.6 && cell.y >= fragment.y - 0.6
        && cell.x + cell.w <= fragment.x + fragment.w + 0.6
        && cell.y + cell.h <= fragment.y + fragment.h + 0.6,
      `${label} cell row ${cell.row} stays inside its rendered table fragment`);
    }
  }
  for (const table of state.tables) {
    const fragmentsForTable = byKey.get(table.key) ?? [];
    assert.ok(fragmentsForTable.length > 0, `${label} renders table ${table.key}`);
    const covered = new Set(fragmentsForTable.flatMap(fragment => fragment.cells.flatMap(cell =>
      Array.from({ length: cell.rowSpan }, (_, offset) => cell.row + offset))));
    for (let row = 0; row < table.rowCount; row++) {
      assert.ok(covered.has(row), `${label} renders row ${row} of table ${table.key}`);
    }
  }
}

async function captureContinuationPage(page, dirname, stage, pageIndex) {
  await page.evaluate(pageIndex => {
    const input = window.__inputHandler;
    input.container.scrollLeft = 0;
    input.container.scrollTop = input.virtualScroll.getPageOffset(pageIndex) + 30;
  }, pageIndex);
  await settleFrames(page);
  await page.screenshot({ path: path.join(dirname, `${stage}-page-${pageIndex + 1}.png`) });
}

async function capturePageBottom(page, dirname, stage, pageIndex) {
  await page.evaluate(pageIndex => {
    const input = window.__inputHandler;
    const height = window.__wasm.getPageInfo(pageIndex).height * input.viewportManager.getZoom();
    input.container.scrollLeft = 0;
    input.container.scrollTop = Math.max(0,
      input.virtualScroll.getPageOffset(pageIndex) + height - input.container.clientHeight + 40);
  }, pageIndex);
  await settleFrames(page);
  await page.screenshot({ path: path.join(dirname, `${stage}-page-${pageIndex + 1}-bottom.png`) });
}

async function runCase(page, name, baseline, index) {
  const dirname = path.join(artifactRoot, `${String(index + 1).padStart(2, '0')}-${safeName(name)}`);
  fs.rmSync(dirname, { recursive: true, force: true });
  fs.mkdirSync(dirname, { recursive: true });
  const target = baseline.target;
  const table = baseline.tables[target.tableIdx];
  const original = target.text;
  const chars = [...original];
  const changedAt = chars.findLastIndex(char => /[가-힣0-9]/u.test(char));
  const editAt = changedAt >= 0 ? changedAt : chars.length - 1;
  const beforeChar = chars[editAt];
  chars[editAt] = /[0-9]/u.test(beforeChar) ? (beforeChar === '8' ? '7' : '8')
    : /[가-힣]/u.test(beforeChar) ? (beforeChar === '가' ? '나' : '가')
      : beforeChar === 'A' ? 'B' : 'A';
  const replacement = chars.join('');
  const longer = `${replacement} ${'추가 내용 '.repeat(12)}`;
  const record = { sample: name, bytes: fs.statSync(path.join(samplesRoot, name)).size,
    pageCount: baseline.pageCount, tableCount: baseline.tables.length,
    cellCount: baseline.tables.reduce((n, t) => n + t.cellCount, 0),
    objectTypes: [...new Set(baseline.controls.map(c => c.type))].sort(),
    target: { table: table.key, cellIdx: target.cellIdx, paragraph: target.cp, original,
      sameLengthReplacement: replacement, changedAt: editAt }, stages: {} };
  const capture = async (stage, state) => {
    const viewport = await focusTarget(page, table, target);
    await settleFrames(page);
    record.stages[stage] = { geometry: geometry(state, true), viewport,
      pendingSets: state.pendingSets };
    await page.screenshot({ path: path.join(dirname, `${stage}.png`) });
  };
  try {
    record.target.viewport = await focusTarget(page, table, target);
    await settleFrames(page);
    await capture('baseline', baseline);
    record.target.renderedTextRuns = targetTextRunCount(baseline, table, target);
    assert.ok(record.target.renderedTextRuns > 0, 'target cell has rendered text runs to audit');
    record.target.paragraphStyleIds = [...new Set(targetTextRunStyles(baseline, table, target)
      .map(run => run.paraShapeId))];
    const originalShapes = await targetCharShapes(page, table, target);
    record.target.charShapeIds = [...new Set(originalShapes)];
    if (record.target.charShapeIds.length > 1) {
      const noOp = await replaceCell(page, table, target, original);
      await endTurn(page);
      await settleFrames(page);
      const noOpPending = await inspect(page);
      await capture('mixed-format-pending', noOpPending);
      sameJson(coreStructure(noOpPending), coreStructure(baseline), 'identical-text preview preserves structure');
      sameJson(geometry(noOpPending), geometry(baseline), 'identical-text preview preserves geometry');
      sameJson(cellTexts(noOpPending), cellTexts(baseline), 'identical-text preview preserves all text');
      sameJson(noOpPending.textLayouts, baseline.textLayouts,
        'identical-text preview preserves every rendered text run');
      sameJson(await targetCharShapes(page, table, target), originalShapes,
        'identical-text preview preserves mixed character formatting');
      await page.evaluate(id => window.__agentBridge.pendingEdits.reject(id), noOp.changeSetId);
      await settleFrames(page);
      const noOpRejected = await inspect(page);
      sameJson(cellTexts(noOpRejected), cellTexts(baseline), 'reject restores mixed-format text');
      sameJson(noOpRejected.textLayouts, baseline.textLayouts,
        'reject restores every rendered text run after identical replacement');
      sameJson(await targetCharShapes(page, table, target), originalShapes,
        'reject restores mixed character formatting');
    }
    const edit = await replaceCell(page, table, target, replacement);
    assert.equal(edit.pending, true, 'real pending edit exists');
    await settleFrames(page);
    const streaming = await inspect(page);
    await capture('streaming', streaming);
    record.stages.streaming.revealCovers = await page.evaluate(() =>
      [...document.querySelectorAll('.ag-reveal-cover')].filter(node => node.style.display !== 'none').length);
    sameJson(cellTexts(streaming).map((cells, ti) => ti === target.tableIdx ? cells[target.cellIdx][target.cp] : null)
      .filter(value => value !== null), [replacement], 'streaming turn has live cell edit');
    sameJson(unrelatedTextRuns(streaming, table, target), unrelatedTextRuns(baseline, table, target),
      'streaming edit preserves every unrelated rendered text run');
    await endTurn(page);
    await settleFrames(page);
    const pending = await inspect(page);
    await capture('pending', pending);
    sameJson(coreStructure(pending), coreStructure(baseline), 'same-length edit preserves table cells and other objects');
    sameJson(geometry(pending), geometry(baseline), 'same-length edit preserves page and table geometry');
    const expectedTexts = cellTexts(baseline);
    expectedTexts[target.tableIdx][target.cellIdx][target.cp] = replacement;
    sameJson(cellTexts(pending), expectedTexts, 'pending edit changes only the target cell');
    sameJson(unrelatedTextRuns(pending, table, target), unrelatedTextRuns(baseline, table, target),
      'same-length preview preserves every unrelated rendered text run');
    sameJson(targetTextRunStyles(pending, table, target), targetTextRunStyles(baseline, table, target),
      'same-length preview preserves target character and paragraph styles');
    record.stages.pending.unpaintedTextLayoutChanged =
      JSON.stringify(unrelatedTextRuns(pending, table, target, false))
        !== JSON.stringify(unrelatedTextRuns(baseline, table, target, false));
    if (record.target.charShapeIds.length > 1) {
      sameJson(await targetCharShapes(page, table, target), originalShapes,
        'same-length text change preserves all character formatting runs');
    }
    assert.equal(pending.pendingSets, 1, 'exactly one pending change set');
    assert.equal(await page.evaluate(id => window.__agentBridge.pendingEdits.approve(id), edit.changeSetId), true);
    await settleFrames(page);
    const approved = await inspect(page);
    await capture('approved', approved);
    sameJson(coreStructure(approved), coreStructure(pending), 'approve retains structure');
    sameJson(geometry(approved), geometry(pending), 'approve retains preview geometry');
    sameJson(cellTexts(approved), cellTexts(pending), 'approve retains preview text');
    sameJson(approved.textLayouts, pending.textLayouts,
      'approve retains every preview rendered text run');
    sameJson(targetTextRunStyles(approved, table, target), targetTextRunStyles(baseline, table, target),
      'approve preserves target character and paragraph styles');
    if (record.target.charShapeIds.length > 1) {
      sameJson(await targetCharShapes(page, table, target), originalShapes,
        'approve retains unchanged character formatting runs');
    }
    assert.equal(approved.pendingSets, 0, 'approve clears pending set');

    const longerEdit = await replaceCell(page, table, { ...target, length: [...replacement].length },
      longer, { retainSnapshot: false });
    assert.equal(longerEdit.pending, true);
    await endTurn(page);
    await settleFrames(page);
    const longPending = await inspect(page);
    await capture('long-pending', longPending);
    if (name === 'table-complex.hwp' || name === 'table-ipc.hwp'
      || name === 'task2146/21761835_jeonjik_exemption_table.hwp'
      || name === 'task2319/20544835_jinan_apt_form.hwp') {
      record.stages['long-pending'].tableFragments = await topLevelTableFragments(page);
      const continuationPages = name === 'table-complex.hwp' || name === 'table-ipc.hwp'
        ? [1] : Array.from({ length: longPending.pageCount - 1 }, (_, index) => index + 1);
      record.stages['long-pending'].continuationPages = [...new Set(continuationPages)].sort((a, b) => a - b);
      for (const pageIndex of record.stages['long-pending'].continuationPages) {
        await captureContinuationPage(page, dirname, 'long-pending', pageIndex);
      }
      if (name === 'task2146/21761835_jeonjik_exemption_table.hwp') {
        const lastPage = longPending.pageCount - 1;
        record.stages['long-pending'].bottomPage = lastPage;
        await capturePageBottom(page, dirname, 'long-pending', lastPage);
      }
      assertFragmentCellCoverage(record.stages['long-pending'].tableFragments, longPending,
        `${name} long preview`);
    }
    sameJson(coreStructure(longPending), coreStructure(approved), 'long preview preserves table cells and objects');
    assertNoNewSiblingTableOverlap(longPending, approved, 'long cell preview');
    assertNoNewTablePageOverflow(longPending, approved, 'long cell preview');
    assertNoNewBodyObjectTableOverlap(longPending, approved, 'long cell preview');
    const longExpectedTexts = cellTextsByKey(approved);
    longExpectedTexts[table.key][target.cellIdx][target.cp] = longer;
    sameJson(cellTextsByKey(longPending), longExpectedTexts, 'long preview changes only target cell');
    await page.evaluate(id => window.__agentBridge.pendingEdits.reject(id), longerEdit.changeSetId);
    await settleFrames(page);
    const rejected = await inspect(page);
    await capture('rejected', rejected);
    sameJson(coreStructure(rejected), coreStructure(approved), 'reject restores structure');
    sameJson(geometry(rejected), geometry(approved), 'reject restores approved geometry');
    sameJson(cellTexts(rejected), cellTexts(approved), 'reject restores approved text exactly');
    sameJson(rejected.textLayouts, approved.textLayouts,
      'long edit reject restores every rendered text run');
    if (record.target.charShapeIds.length > 1) {
      sameJson(await targetCharShapes(page, table, target), originalShapes,
        'fallback reject restores mixed character formatting without a snapshot');
    }
    assert.equal(rejected.pendingSets, 0, 'reject clears pending set');
    if (name === 'table-complex.hwp') {
      const multiline = `${replacement}\n후속 문장`;
      const multiEdit = await replaceCell(page, table, { ...target, length: [...replacement].length }, multiline);
      assert.equal(multiEdit.pending, true, 'multiline cell edit creates a pending set');
      await endTurn(page);
      await settleFrames(page);
      const multiPending = await inspect(page);
      await capture('multiline-pending', multiPending);
      const pendingTexts = cellTextsByKey(multiPending);
      const approvedTexts = cellTextsByKey(approved);
      sameJson(pendingTexts[table.key][target.cellIdx].slice(target.cp, target.cp + 2),
        [replacement, '후속 문장'], 'multiline preview creates two cell paragraphs');
      pendingTexts[table.key][target.cellIdx].splice(target.cp, 2, replacement);
      sameJson(pendingTexts, approvedTexts, 'multiline preview leaves every other cell untouched');
      sameJson(coreStructure(multiPending).tables.map(t => ({ ...t,
        cells: t.cells.map(c => ({ ...c, paragraphCount: undefined })) })),
      coreStructure(approved).tables.map(t => ({ ...t,
        cells: t.cells.map(c => ({ ...c, paragraphCount: undefined })) })),
      'multiline preview retains table and cell layout structure');
      sameJson(coreStructure(multiPending).objectKeys, coreStructure(approved).objectKeys,
        'multiline preview retains every preexisting object origin');
      assertNoNewSiblingTableOverlap(multiPending, approved, 'multiline cell preview');
      assertNoNewTablePageOverflow(multiPending, approved, 'multiline cell preview');
      assertNoNewBodyObjectTableOverlap(multiPending, approved, 'multiline cell preview');
      await page.evaluate(id => window.__agentBridge.pendingEdits.reject(id), multiEdit.changeSetId);
      await settleFrames(page);
      const multiRejected = await inspect(page);
      await capture('multiline-rejected', multiRejected);
      sameJson(coreStructure(multiRejected), coreStructure(approved), 'multiline reject restores structure');
      sameJson(geometry(multiRejected), geometry(approved), 'multiline reject restores geometry');
      sameJson(cellTexts(multiRejected), cellTexts(approved), 'multiline reject restores every cell');
      sameJson(multiRejected.textLayouts, approved.textLayouts,
        'multiline reject restores every rendered text run');
    }
    const equationEdit = await insertCellEquation(page, table, target);
    await settleFrames(page);
    const equationPending = await inspect(page);
    await capture('equation-pending', equationPending);
    record.stages['equation-pending'].anchor = equationEdit.anchor;
    const equationPlacements = await newEquationPlacements(page, equationOrigins(approved));
    record.stages['equation-pending'].placements = equationPlacements;
    const equationMarkers = await pendingMarkers(page);
    record.stages['equation-pending'].markers = equationMarkers;
    assert.equal(equationOrigins(equationPending).size, equationOrigins(approved).size + 1,
      'cell equation has one new object origin, possibly repeated across table pages');
    assert.ok(controlCount(equationPending, 'equation') > controlCount(approved, 'equation'),
      'cell equation renders on at least one page');
    assert.ok(equationPlacements.length > 0, 'new cell equation has a rendered placement');
    for (const { page: equationPage, equation, cell } of equationPlacements) {
      assert.ok(cell, `new equation on page ${equationPage} has its own cell box`);
      assert.ok(equation.x >= cell.x - 0.6 && equation.y >= cell.y - 0.6
        && equation.x + equation.w <= cell.x + cell.w + 0.6
        && equation.y + equation.h <= cell.y + cell.h + 0.6,
      `new equation on page ${equationPage} fits its own cell box`);
    }
    assertMarker(equationMarkers, 'cell equation');
    sameJson(tableCellStructure(equationPending), tableCellStructure(approved),
      'equation preview preserves every table and cell');
    assertNoNewSiblingTableOverlap(equationPending, approved, 'equation preview');
    assertNoNewTablePageOverflow(equationPending, approved, 'equation preview');
    assertNoNewBodyObjectTableOverlap(equationPending, approved, 'equation preview');
    sameJson(cellTextsByKey(equationPending), cellTextsByKey(approved),
      'equation preview leaves all cell text unchanged');
    for (const key of coreStructure(approved).objectKeys) {
      assert.ok(coreStructure(equationPending).objectKeys.includes(key), `existing object retained: ${key}`);
    }
    await page.evaluate(id => window.__agentBridge.pendingEdits.reject(id), equationEdit.changeSetId);
    await settleFrames(page);
    const equationRejected = await inspect(page);
    await capture('equation-rejected', equationRejected);
    sameJson(coreStructure(equationRejected), coreStructure(approved), 'equation reject restores structure and objects');
    sameJson(geometry(equationRejected), geometry(approved), 'equation reject restores every control rectangle');
    sameJson(cellTexts(equationRejected), cellTexts(approved), 'equation reject restores all cell text');
    sameJson(equationRejected.textLayouts, approved.textLayouts,
      'equation reject restores every rendered text run');
    if (name === 'pic-in-table-01.hwp' || name === 'exam_math.hwp') {
      const imageEdit = await insertBodyImage(page);
      await settleFrames(page);
      const imagePending = await inspect(page);
      await capture('image-pending', imagePending);
      record.stages['image-pending'].anchor = imageEdit.anchor;
      const imageMarkers = await pendingMarkers(page);
      record.stages['image-pending'].markers = imageMarkers;
      assert.ok(imagePending.controls.some(control => control.type === 'image'
        && control.secIdx === 0 && control.paraIdx === imageEdit.anchor.paraIdx
        && control.controlIdx === imageEdit.anchor.controlIdx
        && control.outerTableControlIdx === undefined
        && [control.x, control.y, control.w, control.h].every(Number.isFinite)
        && control.w > 0 && control.h > 0),
      'inserted image has a finite rendered rectangle at its anchor');
      const expectedObjects = objectCounts(approved);
      const imageOrigin = `image:0:${imageEdit.anchor.paraIdx}:`;
      expectedObjects[imageOrigin] = (expectedObjects[imageOrigin] ?? 0) + 1;
      sameJson(objectCounts(imagePending), expectedObjects,
        'image preview retains all existing objects by type and paragraph');
      sameJson(tableCellStructure(imagePending), tableCellStructure(approved),
        'image preview preserves every table and cell');
      assertNoNewSiblingTableOverlap(imagePending, approved, 'image preview');
      assertNoNewTablePageOverflow(imagePending, approved, 'image preview');
      assertNoNewBodyObjectTableOverlap(imagePending, approved, 'image preview', imageEdit.anchor);
      sameJson(cellTexts(imagePending), cellTexts(approved),
        'image preview leaves all cell text unchanged');
      assertMarker(imageMarkers, 'inserted image');
      await page.evaluate(id => window.__agentBridge.pendingEdits.reject(id), imageEdit.changeSetId);
      await settleFrames(page);
      const imageRejected = await inspect(page);
      await capture('image-rejected', imageRejected);
      sameJson(coreStructure(imageRejected), coreStructure(approved), 'image reject restores structure and objects');
      sameJson(geometry(imageRejected), geometry(approved), 'image reject restores every control rectangle');
      sameJson(cellTexts(imageRejected), cellTexts(approved), 'image reject restores all cell text');
      sameJson(imageRejected.textLayouts, approved.textLayouts,
        'image reject restores every rendered text run');
    }
    record.result = 'pass';
  } catch (error) {
    record.result = 'fail';
    record.error = error.stack || String(error);
    try { await page.screenshot({ path: path.join(dirname, 'failure.png') }); } catch { /* page may be gone */ }
    try {
      const beforeRefresh = await inspect(page);
      fs.writeFileSync(path.join(dirname, 'text-layout-baseline.json'), JSON.stringify(baseline.textLayouts));
      fs.writeFileSync(path.join(dirname, 'text-layout-failure.json'), JSON.stringify(beforeRefresh.textLayouts));
      const overflowPages = [...new Set(beforeRefresh.controls.filter(control => {
        const info = beforeRefresh.pageInfos[control.page];
        return control.type === 'table' && control.outerTableControlIdx === undefined
          && info && control.y + control.h > info.height - info.marginBottom + 0.5;
      }).map(control => control.page))].slice(0, 3);
      for (const pageIndex of overflowPages) {
        await captureContinuationPage(page, dirname, 'failure-overflow', pageIndex);
      }
      await page.evaluate(() => window.__wasm.refreshLayout());
      const afterRefresh = await inspect(page);
      record.failureProbe = { beforeRefresh: geometry(beforeRefresh, true), afterRefresh: geometry(afterRefresh, true),
        refreshChangedGeometry: JSON.stringify(geometry(beforeRefresh, true)) !== JSON.stringify(geometry(afterRefresh, true)),
        overflowPages };
      const ids = await page.evaluate(() => window.__agentBridge.pendingEdits.getChangeSets().map(set => set.id));
      for (const id of ids) await page.evaluate(value => window.__agentBridge.pendingEdits.reject(value), id);
      await settleFrames(page);
      const afterReject = await inspect(page);
      record.failureProbe.afterReject = geometry(afterReject, true);
      record.failureProbe.rejectRestoredBaseline = JSON.stringify(geometry(afterReject, true)) === JSON.stringify(geometry(baseline, true));
      record.failureProbe.rejectRestoredTextLayout = JSON.stringify(afterReject.textLayouts) === JSON.stringify(baseline.textLayouts);
      await page.screenshot({ path: path.join(dirname, 'failure-after-reject.png') });
    } catch (probeError) {
      record.failureProbe = { error: probeError.stack || String(probeError) };
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(dirname, 'result.json'), JSON.stringify(record, null, 2));
  }
  return record;
}

fs.mkdirSync(artifactRoot, { recursive: true });
if (!only && !discover && !process.argv.includes('--in-process')) {
  const inventory = [];
  const results = [];
  const failures = [];
  const baselines = {};
  for (const item of (targeted ? corpus.targetedSamples : corpus.samples).slice(0, limit)) {
    console.log(`RUN ${item.path}`);
    const child = spawn(process.execPath,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter(arg => !arg.startsWith('--limit=')),
        `--only=${item.path}`],
      { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 150_000);
    const code = await new Promise(resolve => child.once('exit', resolve));
    clearTimeout(timer);
    let childReport = null;
    try { childReport = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'report.json'), 'utf8')); } catch { /* child failed early */ }
    const row = childReport?.inventory?.find(entry => entry.sample === item.path);
    if (row) inventory.push(row);
    if (code === 0 && baselineOnly && childReport?.baselines?.[item.path]) {
      baselines[item.path] = childReport.baselines[item.path];
    } else if (code === 0 && childReport?.results?.some(entry => entry.sample === item.path)) {
      results.push(childReport.results.find(entry => entry.sample === item.path));
    } else {
      failures.push({ sample: item.path, error: timedOut ? 'Case exceeded 150 seconds'
        : childReport?.failures?.find(entry => entry.sample === item.path)?.error || `Case exited ${code}` });
    }
  }
  const report = { generatedAt: new Date().toISOString(), mode: baselineOnly ? 'baseline' : 'verify', requested: null,
    limit, targeted, inventory, results, failures, baselines,
    totals: { passed: results.length, failed: failures.length,
      tables: inventory.reduce((n, item) => n + item.tables, 0),
      cells: inventory.reduce((n, item) => n + item.cells, 0) } };
  fs.writeFileSync(path.join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
} else {
const browser = await launchBrowser();
const results = [];
const failures = [];
const inventory = [];
const baselines = {};
try {
  let page = await createPage(browser, 1400, 1000);
  await loadApp(page);
  await page.waitForFunction(() => !!window.__agentBridge?.pendingEdits, { timeout: 15000 });
  const names = only ? [only] : discover ? (after ? candidates.slice(candidates.indexOf(after) + 1) : candidates)
    : (targeted ? corpus.targetedSamples : corpus.samples).map(item => item.path);
  for (const name of names) {
    if (!discover && inventory.length >= limit) break;
    try {
      await openSample(page, name);
      const state = await inspect(page);
      const row = { sample: name, pages: state.pageCount, tables: state.tables.length,
        cells: state.tables.reduce((n, t) => n + t.cellCount, 0),
        types: [...new Set(state.controls.map(c => c.type))].sort(), editable: !!state.target };
      inventory.push(row);
      console.log(JSON.stringify(row));
      if (baselineOnly) {
        baselines[name] = geometry(state, true);
        continue;
      }
      if (!discover) {
        const expected = [...corpus.samples, ...corpus.targetedSamples].find(item => item.path === name);
        if (expected) {
          assert.equal(row.tables, expected.tables, 'manifest table count');
          assert.equal(row.cells, expected.cells, 'manifest cell count');
          for (const type of expected.requiredTypes) assert.ok(row.types.includes(type), `missing ${type} object`);
        }
      }
      if (discover || !state.target || state.tables.length < 1 || results.length >= limit) continue;
      const result = await runCase(page, name, state, results.length);
      results.push({ sample: name, result: result.result, tableCount: result.tableCount, cellCount: result.cellCount });
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push({ sample: name, error: error.stack || String(error) });
      console.error(`FAIL ${name}: ${error.message || error}`);
      if (only) break;
      try {
        await page.close();
        page = await createPage(browser, 1400, 1000);
        await loadApp(page);
      } catch (restartError) {
        console.error(`Cannot restart after ${name}: ${restartError.stack || restartError}`);
        break;
      }
    }
  }
} finally {
  const report = { generatedAt: new Date().toISOString(), mode: discover ? 'discover' : baselineOnly ? 'baseline' : 'verify',
    requested: only || null, limit, inventory, results, failures, baselines,
    totals: { passed: results.length, failed: failures.length,
      tables: inventory.reduce((n, item) => n + item.tables, 0),
      cells: inventory.reduce((n, item) => n + item.cells, 0) } };
  fs.writeFileSync(path.join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2));
  await closeBrowser(browser);
}
if (failures.length) process.exitCode = 1;
else if (!discover && !baselineOnly) assert.equal(results.length, limit, `expected ${limit} distinct table documents`);
}
