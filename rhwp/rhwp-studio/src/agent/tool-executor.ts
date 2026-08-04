/**
 * MCP 툴 실행기 — 허브가 전달한 tool-request를 실제 문서 호출로 매핑한다.
 *
 * read 툴은 WasmBridge를 직접 호출하고(원시 doc 접근 금지), write 툴은 전부
 * PendingEditManager로 위임한다(승인 전까지 pending 상태). 모든 read 응답에
 * revision을 포함하고, 모든 write는 expectedRevision을 먼저 검사한다.
 */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { DocumentDirtyState } from '../core/document-dirty-state.ts';
import type { DocumentPosition } from '../core/types.ts';
import type { RevisionTracker } from './revision.ts';
import type { PendingEditManager } from './pending-edits.ts';
import type { AgentName, CellAddr, CharFormatProps, DocRange, ObjectOp } from './types.ts';
import { AgentToolError } from './types.ts';
import { renderChartPng, validateChartSpec } from './chart-render.ts';
import type { ChartSpec } from './chart-render.ts';

export interface AgentToolExecutorDeps {
  wasm: WasmBridge;
  inputHandler: InputHandler;
  documentState: DocumentDirtyState;
  revision: RevisionTracker;
  pending: PendingEditManager;
}

const DOC_NOT_LOADED_MESSAGE = '문서가 로드되지 않았습니다';
const MAX_SVG_BYTES = 800_000;
const PENDING_NOTE = 'pending until user approves in the sidebar';

/** HWPUNIT 변환: 1/7200 inch. 1pt = 100 HU, 1mm ≈ 283.465 HU */
const HU_PER_MM = 7200 / 25.4;
export function mmToHu(mm: number): number { return Math.round(mm * HU_PER_MM); }
export function ptToHu(pt: number): number { return Math.round(pt * 100); }

function hexColorRef(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r | (g << 8) | (b << 16);
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function asRecord(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  throw new AgentToolError('INVALID_ARGS', 'Tool arguments must be an object');
}

function reqInt(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new AgentToolError('INVALID_ARGS', `${key} must be an integer (got ${JSON.stringify(v)})`);
  }
  return v;
}

function optInt(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new AgentToolError('INVALID_ARGS', `${key} must be an integer (got ${JSON.stringify(v)})`);
  }
  return v;
}

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') {
    throw new AgentToolError('INVALID_ARGS', `${key} must be a string`);
  }
  return v;
}

/** 선택적 cell 인자 파싱 — 존재하면 좌표계가 셀 내부 문단 기준으로 바뀐다 */
function optCell(args: Record<string, unknown>): CellAddr | undefined {
  const v = args['cell'];
  if (v === undefined || v === null) return undefined;
  const rec = asRecord(v);
  return {
    paraIdx: reqInt(rec, 'paraIdx'),
    controlIdx: reqInt(rec, 'controlIdx'),
    cellIdx: reqInt(rec, 'cellIdx'),
  };
}

export class AgentToolExecutor {
  private deps: AgentToolExecutorDeps;

  constructor(deps: AgentToolExecutorDeps) {
    this.deps = deps;
  }

  async execute(tool: string, args: unknown, agent: AgentName = 'claude'): Promise<unknown> {
    try {
      // await 필수 — 비동기 툴(insert_chart)의 rejection 도 여기서 에러 코드로 매핑된다
      return await this.dispatch(tool, args, agent);
    } catch (e) {
      if (e instanceof AgentToolError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes(DOC_NOT_LOADED_MESSAGE)) {
        throw new AgentToolError('DOC_NOT_LOADED', 'No document is loaded in the studio; ask the user to open one.');
      }
      throw new AgentToolError('RPC_ERROR', message);
    }
  }

  private dispatch(tool: string, rawArgs: unknown, agent: AgentName): unknown {
    const args = rawArgs === undefined ? {} : asRecord(rawArgs);
    switch (tool) {
      case 'get_structure': return this.getStructure(args);
      case 'get_text_range': return this.getTextRange(args);
      case 'get_selection': return this.getSelection();
      case 'get_fields': return this.getFields();
      case 'get_document_info': return this.getDocumentInfo();
      case 'find_text': return this.findText(args);
      case 'render_page': return this.renderPage(args);
      case 'insert_text': return this.insertText(args, agent);
      case 'delete_range': return this.deleteRange(args, agent);
      case 'replace_range': return this.replaceRange(args, agent);
      case 'apply_char_format': return this.applyCharFormat(args, agent);
      case 'set_field_value': return this.setFieldValue(args, agent);
      case 'create_table': return this.createTable(args, agent);
      case 'edit_table': return this.editTable(args, agent);
      case 'apply_para_format': return this.applyParaFormat(args, agent);
      case 'list_styles': return this.listStyles();
      case 'apply_style': return this.applyStyle(args, agent);
      case 'insert_image': return this.insertImage(args, agent);
      case 'insert_equation': return this.insertEquation(args, agent);
      case 'preview_equation': return this.previewEquation(args);
      case 'set_page_layout': return this.setPageLayout(args, agent);
      case 'edit_header_footer': return this.editHeaderFooter(args, agent);
      case 'insert_page_break': return this.insertPageBreak(args, agent);
      case 'insert_chart': return this.insertChart(args, agent);
      default:
        throw new AgentToolError('UNKNOWN_TOOL', `Unknown tool: ${tool}`);
    }
  }

  private get revision(): number {
    return this.deps.revision.revision;
  }

  private requireDocLoaded(): void {
    if (this.deps.wasm.getSectionCount() === 0) {
      throw new AgentToolError('DOC_NOT_LOADED', 'No document is loaded in the studio; ask the user to open one.');
    }
  }

  private requireRevision(args: Record<string, unknown>): void {
    const expected = args['expectedRevision'];
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) {
      throw new AgentToolError('INVALID_ARGS', 'expectedRevision (integer) is required for write tools');
    }
    const current = this.revision;
    if (expected !== current) {
      throw new AgentToolError(
        'REVISION_MISMATCH',
        `Document is now at revision ${current}; you expected ${expected}. ` +
          'Re-read with get_structure or get_text_range and retry with fresh coordinates.',
      );
    }
  }

  /** cell 이 있으면 셀 내부 문단 좌표로, 없으면 본문 문단 좌표로 검증한다 */
  private validateAddress(sectionIdx: number, paraIdx: number, charOffset?: number, cell?: CellAddr): number {
    const { wasm } = this.deps;
    const sectionCount = wasm.getSectionCount();
    if (sectionIdx < 0 || sectionIdx >= sectionCount) {
      throw new AgentToolError('INVALID_ARGS', `sectionIdx ${sectionIdx} out of range (0..${sectionCount - 1})`);
    }
    if (cell) {
      this.validateCell(sectionIdx, cell);
      const cellParaCount = wasm.getCellParagraphCount(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx);
      if (paraIdx < 0 || paraIdx >= cellParaCount) {
        throw new AgentToolError(
          'INVALID_ARGS',
          `paraIdx ${paraIdx} out of range for cell ${cell.cellIdx} (0..${cellParaCount - 1})`,
        );
      }
      const len = wasm.getCellParagraphLength(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx);
      if (charOffset !== undefined && (charOffset < 0 || charOffset > len)) {
        throw new AgentToolError(
          'INVALID_ARGS',
          `charOffset ${charOffset} out of range for cell paragraph ${paraIdx} (0..${len})`,
        );
      }
      return len;
    }
    const paraCount = wasm.getParagraphCount(sectionIdx);
    if (paraIdx < 0 || paraIdx >= paraCount) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `paraIdx ${paraIdx} out of range for section ${sectionIdx} (0..${paraCount - 1})`,
      );
    }
    const len = wasm.getParagraphLength(sectionIdx, paraIdx);
    if (charOffset !== undefined && (charOffset < 0 || charOffset > len)) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `charOffset ${charOffset} out of range for paragraph ${sectionIdx}/${paraIdx} (0..${len})`,
      );
    }
    return len;
  }

  /** 부모 문단에 표 컨트롤이 실제로 있는지 + cellIdx 범위를 검증한다 */
  private validateCell(sectionIdx: number, cell: CellAddr): void {
    const { wasm } = this.deps;
    const paraCount = wasm.getParagraphCount(sectionIdx);
    if (cell.paraIdx < 0 || cell.paraIdx >= paraCount) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `cell.paraIdx ${cell.paraIdx} out of range for section ${sectionIdx} (0..${paraCount - 1})`,
      );
    }
    let cellCount: number;
    try {
      cellCount = wasm.getTableDimensions(sectionIdx, cell.paraIdx, cell.controlIdx).cellCount;
    } catch {
      throw new AgentToolError(
        'INVALID_ARGS',
        `No table control at section ${sectionIdx}, paragraph ${cell.paraIdx}, controlIdx ${cell.controlIdx} — use get_structure to list tables`,
      );
    }
    if (cell.cellIdx < 0 || cell.cellIdx >= cellCount) {
      throw new AgentToolError('INVALID_ARGS', `cell.cellIdx ${cell.cellIdx} out of range (0..${cellCount - 1})`);
    }
  }

  private validateRange(args: Record<string, unknown>): DocRange {
    const cell = optCell(args);
    const range: DocRange = {
      sectionIdx: reqInt(args, 'sectionIdx'),
      startParaIdx: reqInt(args, 'startParaIdx'),
      startCharOffset: reqInt(args, 'startCharOffset'),
      endParaIdx: reqInt(args, 'endParaIdx'),
      endCharOffset: reqInt(args, 'endCharOffset'),
    };
    if (cell) range.cell = cell;
    this.validateAddress(range.sectionIdx, range.startParaIdx, range.startCharOffset, cell);
    this.validateAddress(range.sectionIdx, range.endParaIdx, range.endCharOffset, cell);
    if (
      range.endParaIdx < range.startParaIdx ||
      (range.endParaIdx === range.startParaIdx && range.endCharOffset < range.startCharOffset)
    ) {
      throw new AgentToolError('INVALID_ARGS', 'Range end must not precede range start');
    }
    return range;
  }

  /**
   * 본문 최상위 표 컨트롤 열거 — 페이지 컨트롤 레이아웃에서 수집한다.
   * (중첩 표·머리말/각주 내부 표는 Phase-1 범위 밖이라 제외)
   */
  private listTables(): Array<{ sectionIdx: number; paraIdx: number; controlIdx: number }> {
    const { wasm } = this.deps;
    const seen = new Set<string>();
    const out: Array<{ sectionIdx: number; paraIdx: number; controlIdx: number }> = [];
    const pageCount = wasm.pageCount;
    for (let page = 0; page < pageCount; page++) {
      let layout: { controls: Array<Record<string, unknown>> };
      try {
        layout = wasm.getPageControlLayout(page) as unknown as { controls: Array<Record<string, unknown>> };
      } catch {
        continue;
      }
      for (const item of layout.controls ?? []) {
        if (item['type'] !== 'table') continue;
        const sec = item['secIdx'];
        const para = item['paraIdx'];
        const ctrl = item['controlIdx'];
        if (typeof sec !== 'number' || typeof para !== 'number' || typeof ctrl !== 'number') continue;
        if (item['noteRef'] || item['headerFooter'] || item['outerTableControlIdx'] !== undefined) continue;
        const key = `${sec}:${para}:${ctrl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ sectionIdx: sec, paraIdx: para, controlIdx: ctrl });
      }
    }
    out.sort((a, b) => a.sectionIdx - b.sectionIdx || a.paraIdx - b.paraIdx || a.controlIdx - b.controlIdx);
    return out;
  }

  // ─── read tools ───────────────────────────────────────────

  private getStructure(args: Record<string, unknown>): unknown {
    this.requireDocLoaded();
    const maxPreviewChars = Math.min(Math.max(optInt(args, 'maxPreviewChars', 120), 0), 500);
    const maxParagraphs = Math.min(Math.max(optInt(args, 'maxParagraphs', 500), 1), 2000);
    const { wasm } = this.deps;
    const sectionCount = wasm.getSectionCount();
    const sections: Array<{
      sectionIdx: number;
      paragraphCount: number;
      paragraphs: Array<{ paraIdx: number; length: number; text: string }>;
    }> = [];
    let total = 0;
    let truncated = false;
    for (let sec = 0; sec < sectionCount; sec++) {
      const paragraphCount = wasm.getParagraphCount(sec);
      const paragraphs: Array<{ paraIdx: number; length: number; text: string }> = [];
      for (let para = 0; para < paragraphCount; para++) {
        if (total >= maxParagraphs) {
          truncated = true;
          break;
        }
        const length = wasm.getParagraphLength(sec, para);
        const previewLen = Math.min(length, maxPreviewChars);
        const text = previewLen > 0 ? wasm.getTextRange(sec, para, 0, previewLen) : '';
        paragraphs.push({ paraIdx: para, length, text });
        total++;
      }
      sections.push({ sectionIdx: sec, paragraphCount, paragraphs });
      if (truncated) break;
    }

    // 표: 섹션별 tables[] 로 셀 주소 + 셀 텍스트를 노출한다 (문단 예산 공유).
    interface StructTable {
      paraIdx: number;
      controlIdx: number;
      rowCount: number;
      colCount: number;
      cellCount: number;
      cells: Array<{
        cellIdx: number; row: number; col: number; rowSpan: number; colSpan: number;
        paragraphs: Array<{ cellParaIdx: number; length: number; text: string }>;
      }>;
    }
    const tablesBySection = new Map<number, StructTable[]>();
    outer: for (const t of this.listTables()) {
      let table: StructTable;
      try {
        const dims = wasm.getTableDimensions(t.sectionIdx, t.paraIdx, t.controlIdx);
        table = {
          paraIdx: t.paraIdx, controlIdx: t.controlIdx,
          rowCount: dims.rowCount, colCount: dims.colCount, cellCount: dims.cellCount,
          cells: [],
        };
        for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx++) {
          const info = wasm.getCellInfo(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx);
          const cellParaCount = wasm.getCellParagraphCount(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx);
          const cellParas: Array<{ cellParaIdx: number; length: number; text: string }> = [];
          for (let cp = 0; cp < cellParaCount; cp++) {
            if (total >= maxParagraphs) {
              truncated = true;
              break outer;
            }
            const length = wasm.getCellParagraphLength(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx, cp);
            const previewLen = Math.min(length, maxPreviewChars);
            const text = previewLen > 0
              ? wasm.getTextInCell(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx, cp, 0, previewLen)
              : '';
            cellParas.push({ cellParaIdx: cp, length, text });
            total++;
          }
          table.cells.push({
            cellIdx, row: info.row, col: info.col, rowSpan: info.rowSpan, colSpan: info.colSpan,
            paragraphs: cellParas,
          });
        }
      } catch {
        continue; // 접근 실패한 표는 건너뛴다 (best-effort)
      }
      const list = tablesBySection.get(t.sectionIdx) ?? [];
      list.push(table);
      tablesBySection.set(t.sectionIdx, list);
    }
    const sectionsOut = sections.map((s) => {
      const tables = tablesBySection.get(s.sectionIdx);
      return tables && tables.length > 0 ? { ...s, tables } : s;
    });

    return {
      revision: this.revision,
      sectionCount,
      pageCount: wasm.pageCount,
      truncated,
      sections: sectionsOut,
    };
  }

  private getTextRange(args: Record<string, unknown>): unknown {
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = optInt(args, 'charOffset', 0);
    const cell = optCell(args);
    const paraLength = this.validateAddress(sectionIdx, paraIdx, charOffset, cell);
    const remaining = paraLength - charOffset;
    const rawCount = optInt(args, 'count', remaining);
    if (rawCount < 0) {
      throw new AgentToolError('INVALID_ARGS', `count must be >= 0 (got ${rawCount})`);
    }
    const count = Math.min(rawCount, remaining);
    // getTextRange/getTextInCell 은 원시 문자열을 반환한다 (JSON 아님).
    const text = count > 0
      ? (cell
        ? this.deps.wasm.getTextInCell(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx, charOffset, count)
        : this.deps.wasm.getTextRange(sectionIdx, paraIdx, charOffset, count))
      : '';
    return { revision: this.revision, text, paraLength };
  }

  private getSelection(): unknown {
    this.requireDocLoaded();
    const { inputHandler, wasm } = this.deps;
    const cursor = inputHandler.getCursorPosition();
    const sel = inputHandler.getSelection();
    const toIdx = (p: DocumentPosition) => {
      if (p.parentParaIndex !== undefined) {
        // 셀 내부: write 툴에 그대로 넘길 수 있는 cell 주소 + 셀 내부 문단 좌표.
        // flat 필드는 최외곽 셀 기준(command.ts:229 참고) — 중첩 표에서는 근사값이다.
        const cellParaIdx = p.cellPath && p.cellPath.length > 0
          ? p.cellPath[p.cellPath.length - 1].cellParaIndex
          : p.cellParaIndex ?? 0;
        return {
          sectionIdx: p.sectionIndex,
          cell: {
            paraIdx: p.parentParaIndex,
            controlIdx: p.controlIndex ?? 0,
            cellIdx: p.cellIndex ?? 0,
          },
          paraIdx: cellParaIdx,
          charOffset: p.charOffset,
        };
      }
      return {
        sectionIdx: p.sectionIndex,
        paraIdx: p.paragraphIndex,
        charOffset: p.charOffset,
      };
    };
    const inCell =
      cursor.parentParaIndex !== undefined ||
      sel?.start.parentParaIndex !== undefined ||
      sel?.end.parentParaIndex !== undefined;
    const result: Record<string, unknown> = {
      revision: this.revision,
      hasSelection: sel !== null,
      cursor: toIdx(cursor),
    };
    if (inCell) result['inCell'] = true;
    if (sel) {
      const selection: Record<string, unknown> = { start: toIdx(sel.start), end: toIdx(sel.end) };
      if (
        !inCell &&
        sel.start.sectionIndex === sel.end.sectionIndex &&
        sel.start.paragraphIndex === sel.end.paragraphIndex
      ) {
        const count = Math.min(sel.end.charOffset - sel.start.charOffset, 500);
        if (count > 0) {
          try {
            selection['text'] = wasm.getTextRange(
              sel.start.sectionIndex,
              sel.start.paragraphIndex,
              sel.start.charOffset,
              count,
            );
          } catch {
            // 선택 텍스트는 best-effort — 실패해도 좌표는 반환한다.
          }
        } else {
          selection['text'] = '';
        }
      }
      result['selection'] = selection;
    }
    return result;
  }

  private getFields(): unknown {
    const fields = this.deps.wasm.getFieldList().map((f) => ({
      fieldId: f.fieldId,
      fieldType: f.fieldType,
      name: f.name,
      guide: f.guide,
      value: f.value,
      location: { sectionIdx: f.location.sectionIndex, paraIdx: f.location.paraIndex },
    }));
    return { revision: this.revision, fields };
  }

  private getDocumentInfo(): unknown {
    this.requireDocLoaded();
    const { wasm, documentState } = this.deps;
    let fontsUsed: string[] = [];
    let fallbackFont = '';
    let registeredFonts: string[] = [];
    try {
      const info = wasm.getDocumentInfo();
      fontsUsed = info.fontsUsed ?? [];
      fallbackFont = info.fallbackFont ?? '';
    } catch { /* 폰트 정보는 best-effort */ }
    try {
      // 원본 등록 이름 — apply_char_format fontFamily 에 그대로 쓸 수 있다
      registeredFonts = [...new Set(wasm.getFontList().map((f) => f.name))];
    } catch { /* 구버전 wasm 호환 */ }
    return {
      revision: this.revision,
      sectionCount: wasm.getSectionCount(),
      pageCount: wasm.pageCount,
      sourceFormat: wasm.getSourceFormat(),
      digest: wasm.documentDigest,
      dirty: documentState.isDirty(),
      fontsUsed,
      fallbackFont,
      registeredFonts,
    };
  }

  private findText(args: Record<string, unknown>): unknown {
    this.requireDocLoaded();
    const query = reqString(args, 'query');
    if (query.length < 1) {
      throw new AgentToolError('INVALID_ARGS', 'query must be at least 1 character');
    }
    const caseSensitive = args['caseSensitive'] === true;
    const maxResults = Math.min(Math.max(optInt(args, 'maxResults', 50), 1), 200);
    const { wasm } = this.deps;
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: Array<{
      sectionIdx: number;
      paraIdx: number;
      charOffset: number;
      length: number;
      context: string;
      cell?: CellAddr;
    }> = [];
    let truncated = false;
    const pushMatches = (sec: number, para: number, text: string, cell?: CellAddr): boolean => {
      const haystack = caseSensitive ? text : text.toLowerCase();
      let from = 0;
      while (from <= haystack.length - needle.length) {
        const idx = haystack.indexOf(needle, from);
        if (idx === -1) break;
        if (matches.length >= maxResults) {
          truncated = true;
          return false;
        }
        const m: (typeof matches)[number] = {
          sectionIdx: sec,
          paraIdx: para,
          charOffset: idx,
          length: query.length,
          context: text.slice(Math.max(0, idx - 30), Math.min(text.length, idx + query.length + 30)),
        };
        if (cell) m.cell = cell;
        matches.push(m);
        from = idx + Math.max(needle.length, 1);
      }
      return true;
    };
    const sectionCount = wasm.getSectionCount();
    outer: for (let sec = 0; sec < sectionCount; sec++) {
      const paraCount = wasm.getParagraphCount(sec);
      for (let para = 0; para < paraCount; para++) {
        const len = wasm.getParagraphLength(sec, para);
        if (len === 0) continue;
        const text = wasm.getTextRange(sec, para, 0, len);
        if (!pushMatches(sec, para, text)) break outer;
      }
    }
    // 표 셀 내부 텍스트도 검색한다 — 매치에는 write 툴에 그대로 넘길 수 있는 cell 주소가 실린다.
    if (!truncated) {
      cellScan: for (const t of this.listTables()) {
        try {
          const dims = wasm.getTableDimensions(t.sectionIdx, t.paraIdx, t.controlIdx);
          for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx++) {
            const cell: CellAddr = { paraIdx: t.paraIdx, controlIdx: t.controlIdx, cellIdx };
            const cellParaCount = wasm.getCellParagraphCount(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx);
            for (let cp = 0; cp < cellParaCount; cp++) {
              const len = wasm.getCellParagraphLength(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx, cp);
              if (len === 0) continue;
              const text = wasm.getTextInCell(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx, cp, 0, len);
              if (!pushMatches(t.sectionIdx, cp, text, cell)) break cellScan;
            }
          }
        } catch {
          continue; // 접근 실패한 표는 건너뛴다 (best-effort)
        }
      }
    }
    return { revision: this.revision, matches, truncated };
  }

  private renderPage(args: Record<string, unknown>): unknown {
    const pageIndex = reqInt(args, 'pageIndex');
    const { wasm } = this.deps;
    const pageCount = wasm.pageCount;
    if (pageCount === 0) {
      throw new AgentToolError('DOC_NOT_LOADED', 'No document is loaded in the studio; ask the user to open one.');
    }
    if (pageIndex < 0 || pageIndex >= pageCount) {
      throw new AgentToolError('INVALID_ARGS', `pageIndex ${pageIndex} out of range (0..${pageCount - 1})`);
    }
    const svg = wasm.renderPageSvg(pageIndex);
    if (svg.length > MAX_SVG_BYTES) {
      throw new AgentToolError('RESULT_TOO_LARGE', `SVG is ${svg.length} bytes; page too complex to return`);
    }
    return { revision: this.revision, pageIndex, svg };
  }

  // ─── write tools (PendingEditManager 위임) ─────────────────

  private insertText(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    const cell = optCell(args);
    const text = reqString(args, 'text');
    if (text.length < 1 || text.length > 10_000) {
      throw new AgentToolError('INVALID_ARGS', `text must be 1..10000 chars (got ${text.length})`);
    }
    this.validateAddress(sectionIdx, paraIdx, charOffset, cell);
    if (cell) this.guardDestructiveMark(sectionIdx, cell.paraIdx, cell.controlIdx);
    const addr: { sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr } =
      { sectionIdx, paraIdx, charOffset };
    if (cell) addr.cell = cell;
    const r = this.deps.pending.insertText(agent, addr, text);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      insertedRange: {
        startParaIdx: r.insertedRange.startParaIdx,
        startCharOffset: r.insertedRange.startCharOffset,
        endParaIdx: r.insertedRange.endParaIdx,
        endCharOffset: r.insertedRange.endCharOffset,
      },
      note: PENDING_NOTE,
    };
  }

  private deleteRange(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const range = this.validateRange(args);
    if (range.cell) this.guardDestructiveMark(range.sectionIdx, range.cell.paraIdx, range.cell.controlIdx);
    if (range.startParaIdx === range.endParaIdx && range.startCharOffset === range.endCharOffset) {
      throw new AgentToolError('INVALID_ARGS', 'Range is empty; nothing to delete');
    }
    const r = this.deps.pending.markDelete(agent, range);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      markedText: r.markedText,
      note: PENDING_NOTE,
    };
  }

  private replaceRange(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const range = this.validateRange(args);
    if (range.cell) this.guardDestructiveMark(range.sectionIdx, range.cell.paraIdx, range.cell.controlIdx);
    if (range.startParaIdx === range.endParaIdx && range.startCharOffset === range.endCharOffset) {
      throw new AgentToolError('INVALID_ARGS', 'Range is empty; use insert_text instead');
    }
    const text = reqString(args, 'text');
    if (text.length < 1 || text.length > 10_000) {
      throw new AgentToolError('INVALID_ARGS', `text must be 1..10000 chars (got ${text.length})`);
    }
    const del = this.deps.pending.markDelete(agent, range);
    const insAddr: { sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr } =
      { sectionIdx: range.sectionIdx, paraIdx: range.endParaIdx, charOffset: range.endCharOffset };
    if (range.cell) insAddr.cell = range.cell;
    const ins = this.deps.pending.insertText(agent, insAddr, text);
    return {
      revision: this.revision,
      changeSetId: ins.changeSetId,
      markedText: del.markedText,
      insertedRange: {
        startParaIdx: ins.insertedRange.startParaIdx,
        startCharOffset: ins.insertedRange.startCharOffset,
        endParaIdx: ins.insertedRange.endParaIdx,
        endCharOffset: ins.insertedRange.endCharOffset,
      },
      note: PENDING_NOTE,
    };
  }

  private applyCharFormat(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const startOffset = reqInt(args, 'startOffset');
    const endOffset = reqInt(args, 'endOffset');
    const cell = optCell(args);
    this.validateAddress(sectionIdx, paraIdx, startOffset, cell);
    this.validateAddress(sectionIdx, paraIdx, endOffset, cell);
    if (endOffset < startOffset) {
      throw new AgentToolError('INVALID_ARGS', 'endOffset must be >= startOffset');
    }
    // props_json 키 인코딩은 hwpctl/actions/format.ts charShapeSetToJson 및
    // core/types.ts CharProperties와 동일: fontSize = pt*100, textColor = '#RRGGBB'.
    const format: CharFormatProps = {};
    for (const key of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
      const v = args[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'boolean') {
        throw new AgentToolError('INVALID_ARGS', `${key} must be a boolean`);
      }
      format[key] = v;
    }
    const fontSizePt = args['fontSizePt'];
    if (fontSizePt !== undefined && fontSizePt !== null) {
      if (typeof fontSizePt !== 'number' || !Number.isFinite(fontSizePt) || fontSizePt <= 0) {
        throw new AgentToolError('INVALID_ARGS', 'fontSizePt must be a positive number');
      }
      format.fontSize = Math.round(fontSizePt * 100);
    }
    const textColor = args['textColor'];
    if (textColor !== undefined && textColor !== null) {
      if (typeof textColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(textColor)) {
        throw new AgentToolError('INVALID_ARGS', 'textColor must be "#RRGGBB"');
      }
      format.textColor = textColor;
    }
    const fontFamily = args['fontFamily'];
    if (fontFamily !== undefined && fontFamily !== null) {
      if (typeof fontFamily !== 'string' || fontFamily.length < 1 || fontFamily.length > 64) {
        throw new AgentToolError('INVALID_ARGS', 'fontFamily must be a font name (1..64 chars)');
      }
      // write 측은 숫자 fontId 만 받는다 — 이름은 여기서 해석 (없으면 7개 언어 슬롯에 등록)
      const fontId = this.deps.wasm.findOrCreateFontId(fontFamily);
      if (fontId < 0) {
        throw new AgentToolError('INVALID_ARGS', `font "${fontFamily}" could not be registered`);
      }
      format.fontId = fontId;
    }
    if (Object.keys(format).length === 0) {
      throw new AgentToolError(
        'INVALID_ARGS',
        'At least one format key is required (bold/italic/underline/strikethrough/fontSizePt/textColor/fontFamily)',
      );
    }
    if (cell) this.guardDestructiveMark(sectionIdx, cell.paraIdx, cell.controlIdx);
    const range: DocRange = {
      sectionIdx,
      startParaIdx: paraIdx,
      startCharOffset: startOffset,
      endParaIdx: paraIdx,
      endCharOffset: endOffset,
    };
    if (cell) range.cell = cell;
    const r = this.deps.pending.applyCharFormat(agent, range, format);
    return { revision: this.revision, changeSetId: r.changeSetId, applied: true, note: PENDING_NOTE };
  }

  private setFieldValue(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const name = reqString(args, 'name');
    if (name.length < 1) {
      throw new AgentToolError('INVALID_ARGS', 'name must be at least 1 character');
    }
    const value = reqString(args, 'value');
    const r = this.deps.pending.setFieldValue(agent, name, value);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      fieldId: r.fieldId,
      oldValue: r.oldValue,
      newValue: r.newValue,
      note: PENDING_NOTE,
    };
  }

  // ─── 객체 툴 (Phase 2: 표/서식/스타일) ─────────────────────

  /** 문단 텍스트 지문 (앞 24자) — paraFormat/applyStyle 드리프트 프로브용 */
  private paraTextSample(sectionIdx: number, paraIdx: number, cell?: CellAddr): string {
    try {
      const { wasm } = this.deps;
      const len = cell
        ? wasm.getCellParagraphLength(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx)
        : wasm.getParagraphLength(sectionIdx, paraIdx);
      const n = Math.min(len, 24);
      if (n === 0) return '';
      return cell
        ? wasm.getTextInCell(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx, 0, n)
        : wasm.getTextRange(sectionIdx, paraIdx, 0, n);
    } catch {
      return '';
    }
  }

  /** 파괴적 마크가 걸린 표에 대한 후속 편집 차단 (설계 리뷰 확정 가드) */
  private guardDestructiveMark(sectionIdx: number, tableParaIdx: number, controlIdx: number): void {
    if (this.deps.pending.hasDestructiveTableMark(sectionIdx, tableParaIdx, controlIdx)) {
      throw new AgentToolError(
        'PENDING_DESTRUCTIVE_OP',
        'This table has a pending destructive edit (delete_row/delete_col/merge_cells) that is not applied until the user approves it. Wait for approval before further edits to this table.',
      );
    }
  }

  private createTable(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    this.validateAddress(sectionIdx, paraIdx, charOffset);

    const rawCells = args['cells'];
    let cells: string[][] | undefined;
    if (rawCells !== undefined && rawCells !== null) {
      if (!Array.isArray(rawCells) || rawCells.some((r) => !Array.isArray(r) || r.some((c) => typeof c !== 'string'))) {
        throw new AgentToolError('INVALID_ARGS', 'cells must be a string[][] grid');
      }
      cells = rawCells as string[][];
      if (cells.length === 0) throw new AgentToolError('INVALID_ARGS', 'cells must have at least one row');
    }
    // rows/cols 는 cells 에서 유도 가능 (설계 리뷰: rows/cols-vs-cells 불일치 오류군 제거)
    const rows = optInt(args, 'rows', cells ? cells.length : 0);
    const cols = optInt(args, 'cols', cells ? Math.max(...cells.map((r) => r.length)) : 0);
    if (rows < 1 || rows > 200 || cols < 1 || cols > 64) {
      throw new AgentToolError('INVALID_ARGS', `rows must be 1..200 and cols 1..64 (got ${rows}x${cols}); provide rows/cols or a cells grid`);
    }
    if (cells) {
      if (cells.length > rows) {
        throw new AgentToolError('INVALID_ARGS', `cells has ${cells.length} rows but rows=${rows}`);
      }
      for (let r = 0; r < cells.length; r++) {
        if (cells[r].length > cols) {
          throw new AgentToolError('INVALID_ARGS', `cells[${r}] has ${cells[r].length} columns but cols=${cols}`);
        }
        for (const text of cells[r]) {
          if (text.length > 5000) {
            throw new AgentToolError('INVALID_ARGS', `cell text must be <= 5000 chars (row ${r})`);
          }
        }
      }
    }
    const rawWidths = args['colWidthsMm'];
    let colWidthsHu: number[] | undefined;
    if (rawWidths !== undefined && rawWidths !== null) {
      if (!Array.isArray(rawWidths) || rawWidths.some((w) => typeof w !== 'number' || !(w > 0))) {
        throw new AgentToolError('INVALID_ARGS', 'colWidthsMm must be an array of positive numbers');
      }
      if (rawWidths.length !== cols) {
        throw new AgentToolError('INVALID_ARGS', `colWidthsMm has ${rawWidths.length} entries but cols=${cols}`);
      }
      colWidthsHu = (rawWidths as number[]).map(mmToHu);
    }
    const headerFill = args['headerFill'];
    if (headerFill !== undefined && headerFill !== null && (typeof headerFill !== 'string' || !HEX_COLOR_RE.test(headerFill))) {
      throw new AgentToolError('INVALID_ARGS', 'headerFill must be "#RRGGBB"');
    }
    const obj: ObjectOp = {
      type: 'createTable',
      sectionIdx, paraIdx, charOffset, rows, cols,
      ...(colWidthsHu ? { colWidthsHu } : {}),
      headerRow: args['headerRow'] === true,
      headerBold: args['headerBold'] !== false,
      ...(typeof headerFill === 'string' ? { headerFill } : {}),
      ...(cells ? { cells } : {}),
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    const anchor = (r.obj as Extract<ObjectOp, { type: 'createTable' }>).anchor!;
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      table: { paraIdx: anchor.paraIdx, controlIdx: anchor.controlIdx, rowCount: rows, colCount: cols },
      note: `${PENDING_NOTE}; cells are addressed row-major: cellIdx = row*${cols}+col`,
    };
  }

  private editTable(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const controlIdx = reqInt(args, 'controlIdx');
    const op = reqString(args, 'op');
    const { wasm } = this.deps;
    let dims: { rowCount: number; colCount: number; cellCount: number };
    try {
      dims = wasm.getTableDimensions(sectionIdx, paraIdx, controlIdx);
    } catch {
      throw new AgentToolError('INVALID_ARGS', `No table control at section ${sectionIdx}, paragraph ${paraIdx}, controlIdx ${controlIdx} — use get_structure to list tables`);
    }
    this.guardDestructiveMark(sectionIdx, paraIdx, controlIdx);
    const base = { sectionIdx, tableParaIdx: paraIdx, controlIdx };
    const dimsNow = { rowCount: dims.rowCount, colCount: dims.colCount };

    const reqIdx = (key: string, max: number): number => {
      const v = reqInt(args, key);
      if (v < 0 || v >= max) throw new AgentToolError('INVALID_ARGS', `${key} ${v} out of range (0..${max - 1})`);
      return v;
    };

    switch (op) {
      case 'insert_row': {
        const rowIdx = reqIdx('rowIdx', dims.rowCount);
        const obj: ObjectOp = { type: 'tableStructure', ...base, op: 'insert_row', index: rowIdx, after: args['below'] !== false };
        const r = this.deps.pending.addObjectOp(agent, obj);
        const d = (r.obj as Extract<ObjectOp, { type: 'tableStructure' }>).dims!;
        return { revision: this.revision, changeSetId: r.changeSetId, rowCount: d.rowCount, colCount: d.colCount, note: PENDING_NOTE };
      }
      case 'insert_col': {
        const colIdx = reqIdx('colIdx', dims.colCount);
        const obj: ObjectOp = { type: 'tableStructure', ...base, op: 'insert_col', index: colIdx, after: args['right'] !== false };
        const r = this.deps.pending.addObjectOp(agent, obj);
        const d = (r.obj as Extract<ObjectOp, { type: 'tableStructure' }>).dims!;
        return { revision: this.revision, changeSetId: r.changeSetId, rowCount: d.rowCount, colCount: d.colCount, note: PENDING_NOTE };
      }
      case 'delete_row': {
        const rowIdx = reqIdx('rowIdx', dims.rowCount);
        if (dims.rowCount <= 1) throw new AgentToolError('INVALID_ARGS', 'cannot delete the only row');
        const obj: ObjectOp = { type: 'tableStructureMarked', ...base, op: 'delete_row', rowIdx, dims: dimsNow };
        const r = this.deps.pending.addObjectOp(agent, obj);
        return { revision: this.revision, changeSetId: r.changeSetId, note: `row is NOT removed yet — struck through until the user approves. ${PENDING_NOTE}` };
      }
      case 'delete_col': {
        const colIdx = reqIdx('colIdx', dims.colCount);
        if (dims.colCount <= 1) throw new AgentToolError('INVALID_ARGS', 'cannot delete the only column');
        const obj: ObjectOp = { type: 'tableStructureMarked', ...base, op: 'delete_col', colIdx, dims: dimsNow };
        const r = this.deps.pending.addObjectOp(agent, obj);
        return { revision: this.revision, changeSetId: r.changeSetId, note: `column is NOT removed yet — struck through until the user approves. ${PENDING_NOTE}` };
      }
      case 'merge_cells': {
        const startRow = reqIdx('startRow', dims.rowCount);
        const startCol = reqIdx('startCol', dims.colCount);
        const endRow = reqIdx('endRow', dims.rowCount);
        const endCol = reqIdx('endCol', dims.colCount);
        if (endRow < startRow || endCol < startCol || (startRow === endRow && startCol === endCol)) {
          throw new AgentToolError('INVALID_ARGS', 'merge range must cover at least two cells and end must not precede start');
        }
        const obj: ObjectOp = { type: 'tableStructureMarked', ...base, op: 'merge_cells', startRow, startCol, endRow, endCol, dims: dimsNow };
        const r = this.deps.pending.addObjectOp(agent, obj);
        return { revision: this.revision, changeSetId: r.changeSetId, note: `cells are NOT merged yet — highlighted until the user approves. Merging renumbers cellIdx: re-read get_structure afterwards. ${PENDING_NOTE}` };
      }
      case 'set_cell_props': {
        const cellIdx = reqIdx('cellIdx', dims.cellCount);
        const props = this.parseCellProps(asRecord(args['props'] ?? {}));
        const obj: ObjectOp = { type: 'setCellProps', ...base, cellIdx, props, dims: dimsNow };
        const r = this.deps.pending.addObjectOp(agent, obj);
        return { revision: this.revision, changeSetId: r.changeSetId, note: `applied on approval. ${PENDING_NOTE}` };
      }
      case 'set_table_props': {
        const props = this.parseTableProps(asRecord(args['props'] ?? {}));
        const obj: ObjectOp = { type: 'setTableProps', ...base, props, dims: dimsNow };
        const r = this.deps.pending.addObjectOp(agent, obj);
        return { revision: this.revision, changeSetId: r.changeSetId, note: `applied on approval. ${PENDING_NOTE}` };
      }
      default:
        throw new AgentToolError('INVALID_ARGS', `op must be one of insert_row|insert_col|delete_row|delete_col|merge_cells|set_cell_props|set_table_props (got ${JSON.stringify(op)})`);
    }
  }

  /** set_cell_props 허용 키 → wasm setCellProperties JSON */
  private parseCellProps(raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const fill = raw['fillColor'];
    if (fill !== undefined && fill !== null) {
      if (typeof fill !== 'string' || !HEX_COLOR_RE.test(fill)) {
        throw new AgentToolError('INVALID_ARGS', 'props.fillColor must be "#RRGGBB"');
      }
      out['fillType'] = 'solid';
      out['fillColor'] = fill;
    }
    const va = raw['verticalAlign'];
    if (va !== undefined && va !== null) {
      const map: Record<string, number> = { top: 0, center: 1, bottom: 2 };
      if (typeof va !== 'string' || !(va in map)) {
        throw new AgentToolError('INVALID_ARGS', 'props.verticalAlign must be "top"|"center"|"bottom"');
      }
      out['verticalAlign'] = map[va];
    }
    if (raw['isHeader'] !== undefined && raw['isHeader'] !== null) {
      if (typeof raw['isHeader'] !== 'boolean') throw new AgentToolError('INVALID_ARGS', 'props.isHeader must be a boolean');
      out['isHeader'] = raw['isHeader'];
    }
    for (const [mmKey, huKey] of [['widthMm', 'width'], ['heightMm', 'height']] as const) {
      const v = raw[mmKey];
      if (v !== undefined && v !== null) {
        if (typeof v !== 'number' || !(v > 0)) throw new AgentToolError('INVALID_ARGS', `props.${mmKey} must be a positive number`);
        out[huKey] = mmToHu(v);
      }
    }
    if (Object.keys(out).length === 0) {
      throw new AgentToolError('INVALID_ARGS', 'props requires at least one of fillColor/verticalAlign/isHeader/widthMm/heightMm');
    }
    return out;
  }

  /** set_table_props 허용 키 */
  private parseTableProps(raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (raw['repeatHeader'] !== undefined && raw['repeatHeader'] !== null) {
      if (typeof raw['repeatHeader'] !== 'boolean') throw new AgentToolError('INVALID_ARGS', 'props.repeatHeader must be a boolean');
      out['repeatHeader'] = raw['repeatHeader'];
    }
    if (Object.keys(out).length === 0) {
      throw new AgentToolError('INVALID_ARGS', 'props requires at least one of: repeatHeader');
    }
    return out;
  }

  private applyParaFormat(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const cell = optCell(args);
    this.validateAddress(sectionIdx, paraIdx, undefined, cell);
    if (cell) this.guardDestructiveMark(sectionIdx, cell.paraIdx, cell.controlIdx);

    const props: Record<string, unknown> = {};
    const alignment = args['alignment'];
    if (alignment !== undefined && alignment !== null) {
      const allowed = ['left', 'center', 'right', 'justify', 'distribute'];
      if (typeof alignment !== 'string' || !allowed.includes(alignment)) {
        throw new AgentToolError('INVALID_ARGS', `alignment must be one of ${allowed.join('|')}`);
      }
      props['alignment'] = alignment;
    }
    const lsp = args['lineSpacingPercent'];
    if (lsp !== undefined && lsp !== null) {
      if (typeof lsp !== 'number' || lsp < 50 || lsp > 500) {
        throw new AgentToolError('INVALID_ARGS', 'lineSpacingPercent must be 50..500');
      }
      props['lineSpacing'] = Math.round(lsp);
      props['lineSpacingType'] = 'Percent';
    }
    // 저장 스케일 주의: spacing 은 1x(pt*100), 여백/들여쓰기는 2x(pt*200)
    // — para-shape-dialog.ts ptToRaw/ptToRaw2x 와 동일 규칙 (리뷰 확정 결함 수정).
    for (const [ptKey, huKey, scale] of [
      ['spaceBeforePt', 'spacingBefore', 1], ['spaceAfterPt', 'spacingAfter', 1],
      ['indentPt', 'indent', 2], ['marginLeftPt', 'marginLeft', 2], ['marginRightPt', 'marginRight', 2],
    ] as const) {
      const v = args[ptKey];
      if (v !== undefined && v !== null) {
        if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 500) {
          throw new AgentToolError('INVALID_ARGS', `${ptKey} must be a number within ±500`);
        }
        props[huKey] = ptToHu(v) * scale;
      }
    }
    if (args['pageBreakBefore'] !== undefined && args['pageBreakBefore'] !== null) {
      if (typeof args['pageBreakBefore'] !== 'boolean') {
        throw new AgentToolError('INVALID_ARGS', 'pageBreakBefore must be a boolean');
      }
      props['pageBreakBefore'] = args['pageBreakBefore'];
    }
    if (Object.keys(props).length === 0) {
      throw new AgentToolError('INVALID_ARGS', 'At least one paragraph format key is required (alignment/lineSpacingPercent/spaceBeforePt/spaceAfterPt/indentPt/marginLeftPt/marginRightPt/pageBreakBefore)');
    }
    const obj: ObjectOp = {
      type: 'paraFormat', sectionIdx, paraIdx,
      ...(cell ? { cell } : {}),
      propsJson: JSON.stringify(props), prevParaShapeId: -1, charOffset: 0,
      textSample: this.paraTextSample(sectionIdx, paraIdx, cell),
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    return { revision: this.revision, changeSetId: r.changeSetId, applied: true, note: PENDING_NOTE };
  }

  // ─── 객체 툴 (Phase 2: 그림/수식) ──────────────────────────

  private insertImage(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    this.validateAddress(sectionIdx, paraIdx, charOffset);

    const b64 = reqString(args, 'imageBase64');
    // 5MB 원본 ≈ base64 6.9M 문자 상한 (설계 리스크 레지스터)
    if (b64.length > 7_200_000) {
      throw new AgentToolError('INVALID_ARGS', 'image too large — max 5MB');
    }
    const extension = reqString(args, 'extension').toLowerCase().replace('jpeg', 'jpg');
    if (!['png', 'jpg', 'gif', 'bmp'].includes(extension)) {
      throw new AgentToolError('INVALID_ARGS', 'extension must be png|jpg|gif|bmp');
    }
    const naturalWidthPx = reqInt(args, 'naturalWidthPx');
    const naturalHeightPx = reqInt(args, 'naturalHeightPx');
    if (naturalWidthPx < 1 || naturalHeightPx < 1) {
      throw new AgentToolError('INVALID_ARGS', 'naturalWidthPx/naturalHeightPx must be positive');
    }
    let bytes: Uint8Array;
    try {
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      throw new AgentToolError('INVALID_ARGS', 'imageBase64 is not valid base64');
    }
    if (bytes.length === 0) throw new AgentToolError('INVALID_ARGS', 'image data is empty');

    // 크기 결정: mm 지정 > 자연 크기(96dpi, 1px = 75HU), 본문 폭 초과 시 축소
    const widthMm = args['widthMm'];
    const heightMm = args['heightMm'];
    for (const [k, v] of [['widthMm', widthMm], ['heightMm', heightMm]] as const) {
      if (v !== undefined && v !== null && (typeof v !== 'number' || !(v > 0) || v > 500)) {
        throw new AgentToolError('INVALID_ARGS', `${k} must be a positive number <= 500`);
      }
    }
    const ratio = naturalHeightPx / naturalWidthPx;
    let widthHu: number;
    let heightHu: number;
    if (typeof widthMm === 'number' && typeof heightMm === 'number') {
      widthHu = mmToHu(widthMm);
      heightHu = mmToHu(heightMm);
    } else if (typeof widthMm === 'number') {
      widthHu = mmToHu(widthMm);
      heightHu = Math.round(widthHu * ratio);
    } else if (typeof heightMm === 'number') {
      heightHu = mmToHu(heightMm);
      widthHu = Math.round(heightHu / ratio);
    } else {
      widthHu = naturalWidthPx * 75;
      heightHu = naturalHeightPx * 75;
      let bodyHu = 42_520; // A4 기본 여백 근사 fallback
      try {
        const pd = this.deps.wasm.getPageDef(sectionIdx);
        bodyHu = pd.width - pd.marginLeft - pd.marginRight;
      } catch { /* fallback 유지 */ }
      if (widthHu > bodyHu) {
        heightHu = Math.round(heightHu * (bodyHu / widthHu));
        widthHu = bodyHu;
      }
    }
    const description = typeof args['description'] === 'string' ? args['description'] : '';
    const obj: ObjectOp = {
      type: 'insertImage', sectionIdx, paraIdx, charOffset,
      bytes, extension, widthHu, heightHu, naturalWidthPx, naturalHeightPx, description,
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    const anchor = (r.obj as Extract<ObjectOp, { type: 'insertImage' }>).anchor!;
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      image: {
        paraIdx: anchor.paraIdx, controlIdx: anchor.controlIdx,
        widthMm: Math.round((widthHu / HU_PER_MM) * 10) / 10,
        heightMm: Math.round((heightHu / HU_PER_MM) * 10) / 10,
      },
      note: PENDING_NOTE,
    };
  }

  private insertEquation(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    const cell = optCell(args);
    this.validateAddress(sectionIdx, paraIdx, charOffset, cell);
    if (cell) this.guardDestructiveMark(sectionIdx, cell.paraIdx, cell.controlIdx);
    const { script, fontSizeHu, colorRef } = this.validateEquationArgs(args);
    const obj: ObjectOp = {
      type: 'insertEquation', sectionIdx, paraIdx, charOffset,
      ...(cell ? { cell } : {}),
      script, fontSizeHu, colorRef,
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    const anchor = (r.obj as Extract<ObjectOp, { type: 'insertEquation' }>).anchor!;
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      equation: { paraIdx: anchor.paraIdx, controlIdx: anchor.controlIdx },
      note: PENDING_NOTE,
    };
  }

  private previewEquation(args: Record<string, unknown>): unknown {
    this.requireDocLoaded();
    const { svg } = this.validateEquationArgs(args);
    if (svg.length > MAX_SVG_BYTES) {
      throw new AgentToolError('RESULT_TOO_LARGE', `SVG is ${svg.length} bytes`);
    }
    return { revision: this.revision, svg };
  }

  /**
   * 수식 스크립트 검증 게이트 — 삽입 전 renderEquationPreview 로 렌더해 보고,
   * 실패하면 INVALID_SCRIPT 로 거부한다 (깨진 수식이 문서에 들어가지 않는다).
   */
  private validateEquationArgs(args: Record<string, unknown>):
      { script: string; fontSizeHu: number; colorRef: number; svg: string } {
    const script = reqString(args, 'script');
    // 직렬화기 u16 길이 필드 보호 — studio MAX_EQUATION_SCRIPT_LEN 과 동일 상한
    if (script.length < 1 || script.length > 8000) {
      throw new AgentToolError('INVALID_ARGS', 'script must be 1..8000 chars');
    }
    const fontSizePt = args['fontSizePt'];
    if (fontSizePt !== undefined && fontSizePt !== null
      && (typeof fontSizePt !== 'number' || !(fontSizePt >= 1) || fontSizePt > 200)) {
      throw new AgentToolError('INVALID_ARGS', 'fontSizePt must be 1..200');
    }
    const color = args['color'];
    if (color !== undefined && color !== null && (typeof color !== 'string' || !HEX_COLOR_RE.test(color))) {
      throw new AgentToolError('INVALID_ARGS', 'color must be "#RRGGBB"');
    }
    const fontSizeHu = ptToHu(typeof fontSizePt === 'number' ? fontSizePt : 10);
    const colorRef = typeof color === 'string' ? hexColorRef(color) : 0;
    let svg: string;
    try {
      svg = this.deps.wasm.renderEquationPreview(script, fontSizeHu, colorRef);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new AgentToolError('INVALID_SCRIPT', `equation script failed to render: ${msg.slice(0, 300)}`);
    }
    if (typeof svg !== 'string' || !svg.includes('<svg')) {
      throw new AgentToolError('INVALID_SCRIPT', 'equation script rendered no output — check HWP equation syntax (over, sqrt {}, int _{a} ^{b}, PMATRIX{a & b # c & d}, …)');
    }
    return { script, fontSizeHu, colorRef, svg };
  }

  /**
   * 차트 삽입 (Phase 3, image 경로) — spec 을 studio 쪽 canvas 로 PNG 렌더 후
   * insertImage 객체 op 을 재사용한다. OLE 차트 저작은 범위 밖 (설계 확정).
   */
  private async insertChart(args: Record<string, unknown>, agent: AgentName): Promise<unknown> {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    this.validateAddress(sectionIdx, paraIdx, charOffset);

    const spec = asRecord(args['spec']) as unknown as ChartSpec;
    try {
      validateChartSpec(spec);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new AgentToolError('INVALID_ARGS', `invalid chart spec: ${msg}`);
    }
    const widthMm = typeof args['widthMm'] === 'number' ? (args['widthMm'] as number) : 120;
    const heightMm = typeof args['heightMm'] === 'number' ? (args['heightMm'] as number) : 80;
    if (!(widthMm >= 20) || widthMm > 500 || !(heightMm >= 20) || heightMm > 500) {
      throw new AgentToolError('INVALID_ARGS', 'widthMm/heightMm must be 20..500');
    }
    // 96dpi 기준 px 로 렌더 (renderChartPng 내부에서 2배 스케일)
    const widthPx = Math.round(widthMm * (96 / 25.4));
    const heightPx = Math.round(heightMm * (96 / 25.4));
    let bytes: Uint8Array;
    try {
      bytes = await renderChartPng(spec, widthPx, heightPx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new AgentToolError('CHART_RENDER_FAILED', `chart rendering failed: ${msg}`);
    }
    // await 동안 사용자가 편집했을 수 있다 — 삽입 직전 revision/주소를 재검증한다 (리뷰 확정 결함 수정)
    this.requireRevision(args);
    this.validateAddress(sectionIdx, paraIdx, charOffset);
    const obj: ObjectOp = {
      type: 'insertImage', sectionIdx, paraIdx, charOffset,
      bytes, extension: 'png',
      widthHu: mmToHu(widthMm), heightHu: mmToHu(heightMm),
      naturalWidthPx: widthPx * 2, naturalHeightPx: heightPx * 2,
      description: spec.title ? `차트: ${spec.title}` : '차트',
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    const anchor = (r.obj as Extract<ObjectOp, { type: 'insertImage' }>).anchor!;
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      chart: { paraIdx: anchor.paraIdx, controlIdx: anchor.controlIdx, widthMm, heightMm },
      note: PENDING_NOTE,
    };
  }

  // ─── 객체 툴 (Phase 2: 쪽/문서 설계) ───────────────────────

  private static readonly PAPERS: Record<string, { wMm: number; hMm: number }> = {
    A4: { wMm: 210, hMm: 297 },
    A3: { wMm: 297, hMm: 420 },
    B5: { wMm: 182, hMm: 257 },
    Letter: { wMm: 215.9, hMm: 279.4 },
  };

  private setPageLayout(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const { wasm } = this.deps;
    if (sectionIdx < 0 || sectionIdx >= wasm.getSectionCount()) {
      throw new AgentToolError('INVALID_ARGS', `sectionIdx ${sectionIdx} out of range`);
    }
    const prevDef = wasm.getPageDef(sectionIdx) as unknown as Record<string, unknown>;
    const next: Record<string, unknown> = { ...prevDef };
    let touched = false;

    const paper = args['paper'];
    if (paper !== undefined && paper !== null) {
      let wMm: number; let hMm: number;
      if (typeof paper === 'string') {
        const p = AgentToolExecutor.PAPERS[paper];
        if (!p) throw new AgentToolError('INVALID_ARGS', `paper must be one of ${Object.keys(AgentToolExecutor.PAPERS).join('|')} or {widthMm,heightMm}`);
        wMm = p.wMm; hMm = p.hMm;
      } else {
        const rec = asRecord(paper);
        const w = rec['widthMm']; const h = rec['heightMm'];
        if (typeof w !== 'number' || typeof h !== 'number' || !(w > 30) || !(h > 30) || w > 1000 || h > 1000) {
          throw new AgentToolError('INVALID_ARGS', 'paper.widthMm/heightMm must be 30..1000');
        }
        wMm = w; hMm = h;
      }
      next['width'] = mmToHu(wMm);
      next['height'] = mmToHu(hMm);
      touched = true;
    }
    const landscape = args['landscape'];
    if (landscape !== undefined && landscape !== null) {
      if (typeof landscape !== 'boolean') throw new AgentToolError('INVALID_ARGS', 'landscape must be a boolean');
      const w = next['width'] as number; const h = next['height'] as number;
      if (landscape !== (prevDef['landscape'] === true) || paper !== undefined) {
        // 용지 방향: landscape 면 긴 변이 가로가 되도록 스왑
        if ((landscape && h > w) || (!landscape && w > h)) {
          next['width'] = h;
          next['height'] = w;
        }
      }
      next['landscape'] = landscape;
      touched = true;
    }
    const margins = args['marginsMm'];
    if (margins !== undefined && margins !== null) {
      const rec = asRecord(margins);
      for (const [mmKey, defKey] of [
        ['left', 'marginLeft'], ['right', 'marginRight'], ['top', 'marginTop'],
        ['bottom', 'marginBottom'], ['header', 'marginHeader'], ['footer', 'marginFooter'],
      ] as const) {
        const v = rec[mmKey];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'number' || v < 0 || v > 100) {
          throw new AgentToolError('INVALID_ARGS', `marginsMm.${mmKey} must be 0..100`);
        }
        next[defKey] = mmToHu(v);
        touched = true;
      }
    }

    let columns: { next: { columnCount: number; columnType: number; sameWidth: number; spacing: number }; prev: { columnCount: number; columnType: number; sameWidth: boolean | number; spacing: number } } | undefined;
    const colArg = args['columns'];
    if (colArg !== undefined && colArg !== null) {
      const rec = asRecord(colArg);
      const count = reqInt(rec, 'count');
      if (count < 1 || count > 8) throw new AgentToolError('INVALID_ARGS', 'columns.count must be 1..8');
      const spacingMm = rec['spacingMm'];
      if (spacingMm !== undefined && spacingMm !== null && (typeof spacingMm !== 'number' || spacingMm < 0 || spacingMm > 50)) {
        throw new AgentToolError('INVALID_ARGS', 'columns.spacingMm must be 0..50');
      }
      const prevCol = this.deps.wasm.getColumnDef(sectionIdx);
      columns = {
        next: {
          columnCount: count,
          columnType: prevCol.columnType,
          sameWidth: 1,
          spacing: spacingMm !== undefined && spacingMm !== null ? mmToHu(spacingMm as number) : prevCol.spacing,
        },
        prev: prevCol,
      };
    }
    if (!touched && !columns) {
      throw new AgentToolError('INVALID_ARGS', 'At least one of paper/landscape/marginsMm/columns is required');
    }
    const obj: ObjectOp = {
      type: 'pageLayout', sectionIdx,
      ...(touched ? { pageDef: { next, prev: prevDef } } : {}),
      ...(columns ? {
        columns: {
          next: columns.next,
          prev: {
            columnCount: columns.prev.columnCount,
            columnType: columns.prev.columnType,
            sameWidth: columns.prev.sameWidth ? 1 : 0,
            spacing: columns.prev.spacing,
          },
        },
      } : {}),
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    return { revision: this.revision, changeSetId: r.changeSetId, applied: true, pageCount: this.deps.wasm.pageCount, note: PENDING_NOTE };
  }

  private editHeaderFooter(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const { wasm } = this.deps;
    if (sectionIdx < 0 || sectionIdx >= wasm.getSectionCount()) {
      throw new AgentToolError('INVALID_ARGS', `sectionIdx ${sectionIdx} out of range`);
    }
    const which = reqString(args, 'which');
    if (which !== 'header' && which !== 'footer') {
      throw new AgentToolError('INVALID_ARGS', 'which must be "header" or "footer"');
    }
    const text = reqString(args, 'text');
    if (text.length > 500 || text.includes('\n')) {
      throw new AgentToolError('INVALID_ARGS', 'text must be a single line of at most 500 chars');
    }
    const pageNumber = args['pageNumber'];
    if (pageNumber !== undefined && pageNumber !== null
      && (typeof pageNumber !== 'string' || !['left', 'center', 'right'].includes(pageNumber))) {
      throw new AgentToolError('INVALID_ARGS', 'pageNumber must be "left"|"center"|"right"');
    }
    if (text.length === 0 && !pageNumber) {
      throw new AgentToolError('INVALID_ARGS', 'text or pageNumber is required');
    }
    const isHeader = which === 'header';
    const applyTo = 0; // Both
    let existedBefore = false;
    try {
      const raw = JSON.parse(wasm.getHeaderFooter(sectionIdx, isHeader, applyTo)) as { exists?: boolean };
      existedBefore = raw?.exists === true;
    } catch { /* 조회 실패 시 신규 취급 */ }
    const obj: ObjectOp = {
      type: 'headerFooter', sectionIdx, isHeader, applyTo, text,
      ...(typeof pageNumber === 'string' ? { pageNumber } : {}),
      existedBefore,
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      note: existedBefore
        ? `existing ${which} will be replaced on approval. ${PENDING_NOTE}`
        : PENDING_NOTE,
    };
  }

  /**
   * 쪽 나누기 — 설계 리뷰 확정: 문단 분할형 insertPageBreak 대신
   * pageBreakBefore ParaShape 속성을 쓴다 (문단 수 불변, setParaShapeId 역연산).
   */
  private insertPageBreak(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    this.validateAddress(sectionIdx, paraIdx);
    const obj: ObjectOp = {
      type: 'paraFormat', sectionIdx, paraIdx,
      propsJson: JSON.stringify({ pageBreakBefore: true }),
      prevParaShapeId: -1, charOffset: 0,
      textSample: this.paraTextSample(sectionIdx, paraIdx),
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      pageCount: this.deps.wasm.pageCount,
      note: `page now breaks before paragraph ${paraIdx}. ${PENDING_NOTE}`,
    };
  }

  private listStyles(): unknown {
    this.requireDocLoaded();
    const styles = this.deps.wasm.getStyleList().map((s) => ({
      id: s.id, name: s.name, englishName: s.englishName, type: s.type,
    }));
    return { revision: this.revision, styles };
  }

  private applyStyle(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const styleId = reqInt(args, 'styleId');
    const cell = optCell(args);
    this.validateAddress(sectionIdx, paraIdx, undefined, cell);
    if (cell) this.guardDestructiveMark(sectionIdx, cell.paraIdx, cell.controlIdx);
    if (!this.deps.wasm.getStyleList().some((s) => s.id === styleId)) {
      throw new AgentToolError('INVALID_ARGS', `styleId ${styleId} not found — use list_styles`);
    }
    const obj: ObjectOp = {
      type: 'applyStyle', sectionIdx, paraIdx, ...(cell ? { cell } : {}), styleId, charOffset: 0,
      textSample: this.paraTextSample(sectionIdx, paraIdx, cell),
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    return { revision: this.revision, changeSetId: r.changeSetId, note: `applied on approval. ${PENDING_NOTE}` };
  }
}
