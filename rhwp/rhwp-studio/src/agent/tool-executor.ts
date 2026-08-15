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
import type { CellPathEntry, DocumentPosition } from '../core/types.ts';
import type { RevisionTracker } from './revision.ts';
import type { PendingEditManager } from './pending-edits.ts';
import type { AgentName, AgentPhase, AgentWorkflow, CellAddr, CharFormatProps, DocRange, DocumentTemplate, ObjectOp } from './types.ts';
import { AgentToolError } from './types.ts';
import { renderChartPng, validateChartSpec } from './chart-render.ts';
import type { ChartSpec } from './chart-render.ts';

export interface AgentToolExecutorDeps {
  wasm: WasmBridge;
  inputHandler: InputHandler;
  documentState: DocumentDirtyState;
  revision: RevisionTracker;
  pending: PendingEditManager;
  loadTemplateBytes?: (template: DocumentTemplate) => Promise<Uint8Array>;
}

const DOC_NOT_LOADED_MESSAGE = '문서가 로드되지 않았습니다';
const MAX_SVG_BYTES = 800_000;
const PENDING_NOTE = 'pending until user approves in the sidebar';

/** Every Studio tool that can create or stage a document mutation. */
export const DOCUMENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'insert_text',
  'delete_range',
  'replace_range',
  'apply_char_format',
  'apply_list',
  'set_field_value',
  'create_table',
  'delete_table',
  'edit_table',
  'apply_para_format',
  'apply_style',
  'insert_image',
  'insert_equation',
  'set_page_layout',
  'edit_header_footer',
  'insert_page_break',
  'insert_chart',
  'replace_all',
  'insert_footnote',
  'edit_footnote',
  'set_bookmark',
  'template_apply_section_layout',
  'template_apply_paragraph_format',
  'template_insert_block',
]);

export function isDocumentWriteTool(tool: string) {
  return DOCUMENT_WRITE_TOOLS.has(tool);
}

export interface ToolCapabilityContext {
  workflow: AgentWorkflow;
  /** Phase and epoch carried by this tool-request. Kept unknown so malformed frames fail closed. */
  phase?: unknown;
  capabilityEpoch?: unknown;
  /** Server state last synchronized by the Studio bridge. */
  activePhase?: AgentPhase;
  activeCapabilityEpoch?: number | null;
  template?: DocumentTemplate;
}

/** Enforce plan-mode write authority before dispatch can touch document state. */
export function assertToolCapability(tool: string, capability?: ToolCapabilityContext) {
  if (!isDocumentWriteTool(tool) || capability?.workflow !== 'plan') return;
  if (capability.phase !== 'implementing' || capability.activePhase !== 'implementing') {
    throw new AgentToolError(
      'PLAN_MODE_READ_ONLY',
      'Document-write tools are disabled while a plan workflow is not implementing an approved plan.',
    );
  }
  const requestEpoch = capability.capabilityEpoch;
  const activeEpoch = capability.activeCapabilityEpoch;
  if (typeof requestEpoch !== 'number'
    || !Number.isSafeInteger(requestEpoch)
    || typeof activeEpoch !== 'number'
    || !Number.isSafeInteger(activeEpoch)
    || requestEpoch !== activeEpoch) {
    throw new AgentToolError(
      'STALE_CAPABILITY_EPOCH',
      `Tool capability epoch ${String(requestEpoch)} does not match the active epoch ${String(activeEpoch)}.`,
    );
  }
}

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

/** 96dpi 기준 px → mm (수식 미리보기 메트릭 변환용) */
function pxToMm(px: number): number {
  return Math.round((px * 25.4) / 96 * 100) / 100;
}

/**
 * renderEquationPreview 의 JSON 계약 파서.
 * 신규 wasm 은 `{"svg",widthPx,heightPx,baselinePx,warnings}` JSON 문자열을,
 * 구버전(스테일 pkg)은 SVG 문자열을 그대로 반환한다 → 파싱 실패/svg 키 부재 시
 * raw 를 SVG 로 간주한다 (메트릭 없음, warnings 빈 배열).
 */
interface EquationPreview {
  svg: string;
  widthPx?: number;
  heightPx?: number;
  baselinePx?: number;
  warnings: string[];
}

function parseEquationPreview(raw: string): EquationPreview {
  try {
    const parsed = JSON.parse(raw) as Partial<EquationPreview> | null;
    if (parsed && typeof parsed.svg === 'string') {
      return {
        svg: parsed.svg,
        ...(typeof parsed.widthPx === 'number' ? { widthPx: parsed.widthPx } : {}),
        ...(typeof parsed.heightPx === 'number' ? { heightPx: parsed.heightPx } : {}),
        ...(typeof parsed.baselinePx === 'number' ? { baselinePx: parsed.baselinePx } : {}),
        warnings: Array.isArray(parsed.warnings)
          ? parsed.warnings.filter((w): w is string => typeof w === 'string')
          : [],
      };
    }
  } catch { /* 파싱 실패 = 구버전 wasm — raw 문자열 자체가 SVG */ }
  // JSON 이지만 svg 키가 없으면 구버전(bare SVG) 응답으로 간주한다
  return { svg: raw, warnings: [] };
}

/** PNG 바이트 → base64 (브라우저/Node 공용) */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

interface PngCapture { data: string; widthPx: number; heightPx: number }

/** renderPageToCanvas 가 그린 캔버스 → PNG base64 (OffscreenCanvas/HTMLCanvasElement 모두 지원) */
async function canvasToPngBase64(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<PngCapture> {
  if (typeof (canvas as OffscreenCanvas).convertToBlob === 'function') {
    const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { data: bytesToBase64(bytes), widthPx: canvas.width, heightPx: canvas.height };
  }
  const dataUrl = (canvas as HTMLCanvasElement).toDataURL('image/png');
  return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), widthPx: canvas.width, heightPx: canvas.height };
}

// 번호 유형 코드 — numbering-defaults.ts 의 NumberingType(const enum)과 동일 값.
// const enum 은 node --test strip-only 모드에서 import 되지 않으므로
// numbering-dialog.ts 의 NUM_FMT 처럼 로컬 상수로 둔다.
const LIST_NUM_FMT = {
  DIGIT: 0,        // 1, 2, 3
  CIRCLE_DIGIT: 1, // ①, ②, ③
  ROMAN_UPPER: 2,  // I, II, III
  ROMAN_LOWER: 3,  // i, ii, iii
  ALPHA_UPPER: 4,  // A, B, C
  ALPHA_LOWER: 5,  // a, b, c
  HANGUL: 8,       // 가, 나, 다
  HANGUL_JAMO: 10, // ㄱ, ㄴ, ㄷ
} as const;

/** apply_list format 토큰 → (번호 유형 코드, 레벨 서식 패턴). 패턴의 ^N 은 해당 레벨 번호로 치환된다 */
const LIST_FORMAT_MAP: Record<string, { code: number; pattern: (level: number) => string }> = {
  '1.': { code: LIST_NUM_FMT.DIGIT, pattern: (l) => `^${l + 1}.` },
  '1)': { code: LIST_NUM_FMT.DIGIT, pattern: (l) => `^${l + 1})` },
  '(1)': { code: LIST_NUM_FMT.DIGIT, pattern: (l) => `(^${l + 1})` },
  '①': { code: LIST_NUM_FMT.CIRCLE_DIGIT, pattern: (l) => `^${l + 1}` },
  'a.': { code: LIST_NUM_FMT.ALPHA_LOWER, pattern: (l) => `^${l + 1}.` },
  'a)': { code: LIST_NUM_FMT.ALPHA_LOWER, pattern: (l) => `^${l + 1})` },
  'A.': { code: LIST_NUM_FMT.ALPHA_UPPER, pattern: (l) => `^${l + 1}.` },
  'A)': { code: LIST_NUM_FMT.ALPHA_UPPER, pattern: (l) => `^${l + 1})` },
  'I.': { code: LIST_NUM_FMT.ROMAN_UPPER, pattern: (l) => `^${l + 1}.` },
  'i.': { code: LIST_NUM_FMT.ROMAN_LOWER, pattern: (l) => `^${l + 1}.` },
  'i)': { code: LIST_NUM_FMT.ROMAN_LOWER, pattern: (l) => `^${l + 1})` },
  '가.': { code: LIST_NUM_FMT.HANGUL, pattern: (l) => `^${l + 1}.` },
  'ㄱ.': { code: LIST_NUM_FMT.HANGUL_JAMO, pattern: (l) => `^${l + 1}.` },
};

// 미지정 레벨의 기본 7수준 패턴 — 한컴 기본 "1. 가. 1) 가) (1) (가) ①" (numbering-dialog PRESETS[1]과 동일)
const LIST_DEFAULT_LEVEL_FORMATS = ['^1.', '^2.', '^3)', '^4)', '(^5)', '(^6)', '^7'];
const LIST_DEFAULT_NUMBER_FORMATS: number[] = [
  LIST_NUM_FMT.DIGIT, LIST_NUM_FMT.HANGUL, LIST_NUM_FMT.DIGIT, LIST_NUM_FMT.HANGUL,
  LIST_NUM_FMT.DIGIT, LIST_NUM_FMT.HANGUL, LIST_NUM_FMT.CIRCLE_DIGIT,
];

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
  for (const key of ['paraIdx', 'controlIdx', 'cellIdx'] as const) {
    const val = rec[key];
    if (typeof val !== 'number' || !Number.isSafeInteger(val)) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `cell.${key} must be an integer (got ${JSON.stringify(val)}). cell.paraIdx/controlIdx are the TABLE's body paragraph address — assemble cell from a get_structure tables[] entry (its paraIdx/controlIdx) plus the target cell's cellIdx, or copy a find_text match's cell object verbatim.`,
      );
    }
  }
  return {
    paraIdx: rec['paraIdx'] as number,
    controlIdx: rec['controlIdx'] as number,
    cellIdx: rec['cellIdx'] as number,
  };
}

export class AgentToolExecutor {
  private deps: AgentToolExecutorDeps;
  private templateWasm: WasmBridge | null = null;
  private templateKey: string | null = null;
  private templateInspectionKey: string | null = null;
  private documentInspectionRevision: number | null = null;

  constructor(deps: AgentToolExecutorDeps) {
    this.deps = deps;
  }

  async execute(
    tool: string,
    args: unknown,
    agent: AgentName = 'claude',
    capability?: ToolCapabilityContext,
  ): Promise<unknown> {
    try {
      assertToolCapability(tool, capability);
      // await 필수 — 비동기 툴(insert_chart)의 rejection 도 여기서 에러 코드로 매핑된다
      const result = await this.dispatch(tool, args, agent, capability);
      if (tool === 'get_structure') this.documentInspectionRevision = this.revision;
      return result;
    } catch (e) {
      if (e instanceof AgentToolError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes(DOC_NOT_LOADED_MESSAGE)) {
        throw new AgentToolError('DOC_NOT_LOADED', 'No document is loaded in the studio; ask the user to open one.');
      }
      throw new AgentToolError('RPC_ERROR', message);
    }
  }

  private dispatch(tool: string, rawArgs: unknown, agent: AgentName, capability?: ToolCapabilityContext): unknown {
    const args = rawArgs === undefined ? {} : asRecord(rawArgs);
    switch (tool) {
      case 'get_structure': return this.getStructure(args);
      case 'get_text_range': return this.getTextRange(args);
      case 'get_selection': return this.getSelection();
      case 'get_fields': return this.getFields();
      case 'get_document_info': return this.getDocumentInfo();
      case 'find_text': return this.findText(args);
      case 'render_page': return this.renderPage(args);
      case 'get_para_format': return this.getParaFormat(args);
      case 'get_char_format': return this.getCharFormat(args);
      case 'list_numberings': return this.listNumberings();
      case 'verify_changes': return this.verifyChanges(args);
      case 'template_get_structure': return this.templateRead('get_structure', args, capability, true);
      case 'template_get_text_range': return this.templateRead('get_text_range', args, capability);
      case 'template_get_para_format': return this.templateRead('get_para_format', args, capability);
      case 'template_get_char_format': return this.templateRead('get_char_format', args, capability);
      case 'template_list_styles': return this.templateRead('list_styles', args, capability);
      case 'template_get_page_layout': return this.templateGetPageLayout(args, capability);
      case 'template_render_page': return this.templateRead('render_page', args, capability);
      case 'template_apply_section_layout': return this.templateApplySectionLayout(args, agent, capability);
      case 'template_apply_paragraph_format': return this.templateApplyParagraphFormat(args, agent, capability);
      case 'template_insert_block': return this.templateInsertBlock(args, agent, capability);
      case 'insert_text': return this.insertText(args, agent);
      case 'delete_range': return this.deleteRange(args, agent);
      case 'replace_range': return this.replaceRange(args, agent);
      case 'apply_char_format': return this.applyCharFormat(args, agent);
      case 'apply_list': return this.applyList(args, agent);
      case 'set_field_value': return this.setFieldValue(args, agent);
      case 'create_table': return this.createTable(args, agent);
      case 'delete_table': return this.deleteTable(args, agent);
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
      case 'replace_all': return this.replaceAll(args, agent);
      case 'get_outline': return this.getOutline(args);
      case 'list_footnotes': return this.listFootnotes();
      case 'insert_footnote': return this.insertFootnote(args, agent);
      case 'edit_footnote': return this.editFootnote(args, agent);
      case 'list_bookmarks': return this.listBookmarks();
      case 'set_bookmark': return this.setBookmark(args, agent);
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
    for (const t of this.listTables()) {
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
            // 예산 소진 시에도 표/셀 좌표(주소 지정에 필수)는 계속 내보내고
            // 셀 텍스트 수집만 멈춘다 — 표가 통째로 사라지면 셀 주소를 만들 수 없다.
            if (total >= maxParagraphs) {
              truncated = true;
              break;
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
    // 커서/선택의 charOffset 은 논리 오프셋(텍스트 문자 + 앞선 인라인 컨트롤 1개당 +1)이다.
    // 다른 툴은 텍스트 오프셋을 쓰므로 본문 문단은 logicalToTextOffset 로 변환해 반환한다.
    // (셀 안쪽 문단은 변환 API 가 없어 논리 오프셋 그대로 — 응답 note 참고)
    interface SelPoint {
      sectionIdx: number;
      paraIdx: number;
      charOffset: number;
      cell?: CellAddr;
      /** 중첩 표(깊이 2 이상) — cell 주소를 생략했다는 표시 */
      nested?: boolean;
      /** 진단용 전체 셀 경로 (중첩일 때만) */
      cellPath?: CellPathEntry[];
    }
    const toTextOffset = (sec: number, para: number, logical: number): number => {
      try {
        return wasm.logicalToTextOffset(sec, para, logical);
      } catch {
        return logical; // 구버전 wasm 호환 — 변환 실패 시 원값 유지
      }
    };
    const toIdx = (p: DocumentPosition): SelPoint => {
      if (p.parentParaIndex !== undefined) {
        // 셀 내부: write 툴에 그대로 넘길 수 있는 cell 주소 + 셀 내부 문단 좌표.
        // flat 필드는 최외곽 셀 기준(command.ts:229 참고)이고 cellPath 의 마지막
        // 항목은 최내곽 셀 기준이라 축이 다르다. 중첩 표(깊이 2 이상)에서 둘을
        // 섞으면 엉뚱한 셀에 조용히 기록되므로 cell 주소를 아예 내보내지 않는다.
        const path = p.cellPath ?? [];
        if (path.length > 1) {
          return {
            sectionIdx: p.sectionIndex,
            paraIdx: path[path.length - 1].cellParaIndex,
            charOffset: p.charOffset,
            nested: true,
            cellPath: path,
          };
        }
        const cellParaIdx = path.length > 0
          ? path[path.length - 1].cellParaIndex
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
        charOffset: toTextOffset(p.sectionIndex, p.paragraphIndex, p.charOffset),
      };
    };
    const inCell =
      cursor.parentParaIndex !== undefined ||
      sel?.start.parentParaIndex !== undefined ||
      sel?.end.parentParaIndex !== undefined;
    const cursorPoint = toIdx(cursor);
    const startPoint = sel ? toIdx(sel.start) : null;
    const endPoint = sel ? toIdx(sel.end) : null;
    const nested = cursorPoint.nested === true
      || startPoint?.nested === true
      || endPoint?.nested === true;
    const result: Record<string, unknown> = {
      revision: this.revision,
      hasSelection: sel !== null,
      cursor: cursorPoint,
    };
    if (inCell) {
      result['inCell'] = true;
      result['note'] = 'charOffset inside table cells is a logical offset (text chars + 1 per preceding inline control); body paragraph offsets are converted text offsets';
    }
    if (nested) {
      result['nested'] = true;
      // 중첩 표 좌표는 3필드 cell 인자로 표현할 수 없다 — 에이전트가 flat 주소를
      // 지어내지 않도록 note 로 명시하고 get_structure 재조회를 요구한다.
      const nestedNote = 'cursor is inside a nested table; nested cells cannot be addressed with the 3-field cell argument (paraIdx/controlIdx/cellIdx), so no cell address is returned — re-derive coordinates with get_structure before writing. cellPath is diagnostic only.';
      result['note'] = result['note'] ? `${nestedNote} ${result['note'] as string}` : nestedNote;
    }
    if (sel && startPoint && endPoint) {
      const start = startPoint;
      const end = endPoint;
      const selection: Record<string, unknown> = { start, end };
      if (!inCell && start.sectionIdx === end.sectionIdx && start.paraIdx === end.paraIdx) {
        const count = Math.min(end.charOffset - start.charOffset, 500);
        if (count > 0) {
          try {
            selection['text'] = wasm.getTextRange(start.sectionIdx, start.paraIdx, start.charOffset, count);
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
    const { matches, truncated } = this.collectTextMatches(query, caseSensitive, maxResults);
    return { revision: this.revision, matches, truncated };
  }

  /** 본문+셀 전수 텍스트 검색 — find_text / replace_all 공용 스캐너 */
  private collectTextMatches(query: string, caseSensitive: boolean, maxResults: number): {
    matches: Array<{
      sectionIdx: number; paraIdx: number; charOffset: number; length: number;
      context: string; cell?: CellAddr;
    }>;
    truncated: boolean;
  } {
    const { wasm } = this.deps;
    // 정규식 기반 검색 — toLowerCase 경로는 길이가 바뀔 수 있어(İ 등) 오프셋이 깨진다.
    // 'giu' 플래그로 원본 문자열에서 직접 찾고, charOffset/length 는 wasm 과 같은
    // Unicode scalar 단위로 환산한다 (JS 의 UTF-16 인덱스가 아니다).
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
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
      re.lastIndex = 0;
      for (let hit = re.exec(text); hit !== null; hit = re.exec(text)) {
        if (matches.length >= maxResults) {
          truncated = true;
          return false;
        }
        const m: (typeof matches)[number] = {
          sectionIdx: sec,
          paraIdx: para,
          charOffset: [...text.slice(0, hit.index)].length,
          length: [...hit[0]].length,
          context: text.slice(Math.max(0, hit.index - 30), Math.min(text.length, hit.index + hit[0].length + 30)),
        };
        if (cell) m.cell = cell;
        matches.push(m);
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
    return { matches, truncated };
  }

  /**
   * 문서 전체 찾아 바꾸기 — 매치를 한 번 수집한 뒤 문서 좌표 역순으로
   * pending replace 를 등록한다 (역순이라 앞선 교체가 뒤 매치 좌표를 밀지 않는다).
   * 각 매치는 개별 replace op 으로 리뷰에 표시되고 승인/거절이 한 번에 이뤄진다.
   */
  private replaceAll(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const query = reqString(args, 'query');
    if (query.length < 1) {
      throw new AgentToolError('INVALID_ARGS', 'query must be at least 1 character');
    }
    const replacement = reqString(args, 'replacement');
    if (replacement.length > 1000) {
      throw new AgentToolError('INVALID_ARGS', 'replacement must be at most 1000 chars');
    }
    const caseSensitive = args['caseSensitive'] === true;
    const maxMatches = Math.min(Math.max(optInt(args, 'maxMatches', 100), 1), 200);
    const { matches, truncated } = this.collectTextMatches(query, caseSensitive, maxMatches);
    if (matches.length === 0) {
      return { revision: this.revision, replacedCount: 0, skippedPendingDelete: 0, truncated: false };
    }
    // 컨테이너(본문/셀)별 문서 좌표 내림차순 — 같은 컨테이너 안에서 뒤부터 교체한다
    const cellKey = (c?: CellAddr): string => (c ? `${c.paraIdx}/${c.controlIdx}/${c.cellIdx}` : 'body');
    const ordered = [...matches].sort((a, b) =>
      a.sectionIdx - b.sectionIdx
      || cellKey(a.cell).localeCompare(cellKey(b.cell))
      || b.paraIdx - a.paraIdx
      || b.charOffset - a.charOffset);
    let skippedPendingDelete = 0;
    const items: Array<{ range: DocRange; text: string }> = [];
    for (const m of ordered) {
      const range: DocRange = {
        sectionIdx: m.sectionIdx,
        startParaIdx: m.paraIdx, startCharOffset: m.charOffset,
        endParaIdx: m.paraIdx, endCharOffset: m.charOffset + m.length,
      };
      if (m.cell) range.cell = m.cell;
      // 삭제 마크와 겹치는 매치는 건너뛴다 — 일부만 겹쳐도 마크가 드리프트하거나
      // 승인 시 교체 텍스트가 함께 지워진다 (시작점만 보면 부분 겹침을 놓친다)
      if (this.deps.pending.findDeleteMarkOverlapping?.(range)) {
        skippedPendingDelete++;
        continue;
      }
      items.push({ range, text: replacement });
    }
    // 전부-또는-전무: 중간 실패 시 pending/문서가 배치 이전으로 복원되고 에러가 난다 —
    // 부분 적용된 배치가 리뷰 카드에 남지 않는다.
    let replacedCount = 0;
    let changeSetId: string | null = null;
    if (items.length > 0) {
      changeSetId = this.deps.pending.replaceTextBatch(items, agent).changeSetId;
      replacedCount = items.length;
    }
    return {
      revision: this.revision,
      ...(changeSetId !== null ? { changeSetId } : {}),
      replacedCount,
      skippedPendingDelete,
      truncated,
      ...(truncated ? { note: `only the first ${maxMatches} matches were replaced — call replace_all again with the returned revision to continue. ${PENDING_NOTE}` } : { note: PENDING_NOTE }),
    };
  }

  /** 문서 구조(개요/조문) 트리 — 긴 문서 내비게이션용. 본문은 생략하고 제목만 싣는다. */
  private getOutline(args: Record<string, unknown>): unknown {
    this.requireDocLoaded();
    const rawMode = args['mode'];
    const mode = rawMode === undefined || rawMode === null ? 'auto' : reqString(args, 'mode');
    if (mode !== 'auto' && mode !== 'outline' && mode !== 'clause') {
      throw new AgentToolError('INVALID_ARGS', `mode must be "auto" | "outline" | "clause" (got ${JSON.stringify(mode)})`);
    }
    const doc = this.deps.wasm.getOutlineStructure(mode);
    if (!doc) {
      throw new AgentToolError('RPC_ERROR', 'outline query is unavailable in this engine build');
    }
    const MAX_NODES = 500;
    let total = 0;
    let truncated = false;
    interface OutlineNode {
      level: number; kind: string; marker?: string; heading: string;
      sectionIdx: number; paraIdx: number; children?: OutlineNode[];
    }
    const mapNode = (n: Record<string, unknown>): OutlineNode | null => {
      if (total >= MAX_NODES) { truncated = true; return null; }
      total++;
      const out: OutlineNode = {
        level: Number(n['level'] ?? 0),
        kind: String(n['kind'] ?? ''),
        heading: String(n['heading'] ?? '').slice(0, 200),
        sectionIdx: Number(n['section'] ?? 0),
        paraIdx: Number(n['paragraph'] ?? 0),
      };
      const marker = n['marker'];
      if (typeof marker === 'string' && marker.length > 0) out.marker = marker;
      const children = Array.isArray(n['children'])
        ? (n['children'] as Array<Record<string, unknown>>).map(mapNode).filter((c): c is OutlineNode => c !== null)
        : [];
      if (children.length > 0) out.children = children;
      return out;
    };
    const roots = (doc.roots ?? []).map(mapNode).filter((n): n is OutlineNode => n !== null);
    return {
      revision: this.revision,
      mode: doc.mode,
      nodeCount: doc.node_count,
      roots,
      truncated,
    };
  }

  /** 렌더된 페이지들에서 각주/미주 앵커를 수집한다 (본문 소스만 내용 조회 가능) */
  private listFootnotes(): unknown {
    this.requireDocLoaded();
    const { wasm } = this.deps;
    const seen = new Set<string>();
    const notes: Array<{
      sectionIdx: number; paraIdx: number; controlIdx: number;
      sourceType: string; number?: number; text?: string; paraCount?: number;
    }> = [];
    const pageCount = wasm.pageCount;
    for (let page = 0; page < pageCount; page++) {
      for (let i = 0; i < 200; i++) {
        const info = wasm.getPageFootnoteInfo(page, i);
        if (!info || info.ok !== true) break;
        const key = `${info.sectionIdx}:${info.paraIdx}:${info.controlIdx}:${info.sourceType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry: (typeof notes)[number] = {
          sectionIdx: info.sectionIdx, paraIdx: info.paraIdx, controlIdx: info.controlIdx,
          sourceType: info.sourceType,
        };
        if (info.sourceType === 'body') {
          try {
            const d = wasm.getFootnoteInfo(info.sectionIdx, info.paraIdx, info.controlIdx);
            if (d?.ok === true) {
              entry.number = d.number;
              entry.paraCount = d.paraCount;
              entry.text = d.texts.join('\n').slice(0, 300);
            }
          } catch { /* 내용 조회는 best-effort */ }
        }
        notes.push(entry);
      }
    }
    notes.sort((a, b) => a.sectionIdx - b.sectionIdx || a.paraIdx - b.paraIdx || a.controlIdx - b.controlIdx);
    return { revision: this.revision, notes };
  }

  private insertFootnote(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    const rawKind = args['kind'];
    const kind = rawKind === undefined || rawKind === null ? 'footnote' : reqString(args, 'kind');
    if (kind !== 'footnote' && kind !== 'endnote') {
      throw new AgentToolError('INVALID_ARGS', `kind must be "footnote" or "endnote" (got ${JSON.stringify(kind)})`);
    }
    const text = reqString(args, 'text').replace(/\r\n?/g, '\n');
    if (text.length < 1 || text.length > 2000) {
      throw new AgentToolError('INVALID_ARGS', `text must be 1..2000 chars (got ${text.length})`);
    }
    if (text.includes('\n')) {
      throw new AgentToolError('INVALID_ARGS', 'footnote text must be a single paragraph (no newlines)');
    }
    this.validateAddress(sectionIdx, paraIdx, charOffset);
    const mark = this.deps.pending.findDeleteMarkContaining?.(sectionIdx, paraIdx, charOffset);
    if (mark) {
      throw new AgentToolError('PENDING_DELETE_OVERLAP',
        'insertion point is inside a range already marked for deletion — the marker would be deleted on approval');
    }
    const obj: ObjectOp = { type: 'insertNote', noteKind: kind, sectionIdx, paraIdx, charOffset, text };
    const r = this.deps.pending.addObjectOp(agent, obj);
    const applied = r.obj as Extract<ObjectOp, { type: 'insertNote' }>;
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      note: PENDING_NOTE,
      ...(applied.anchor
        ? { anchor: { paraIdx: applied.anchor.paraIdx, controlIdx: applied.anchor.controlIdx } }
        : {}),
      ...(applied.number !== undefined ? { number: applied.number } : {}),
    };
  }

  private editFootnote(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const controlIdx = reqInt(args, 'controlIdx');
    const text = reqString(args, 'text').replace(/\r\n?/g, '\n');
    if (text.length > 2000) {
      throw new AgentToolError('INVALID_ARGS', `text must be at most 2000 chars (got ${text.length})`);
    }
    if (text.includes('\n')) {
      throw new AgentToolError('INVALID_ARGS', 'footnote text must be a single paragraph (no newlines)');
    }
    const obj: ObjectOp = { type: 'setNoteText', sectionIdx, paraIdx, controlIdx, text };
    const r = this.deps.pending.addObjectOp(agent, obj);
    return { revision: this.revision, changeSetId: r.changeSetId, note: PENDING_NOTE };
  }

  private listBookmarks(): unknown {
    this.requireDocLoaded();
    const bookmarks = this.deps.wasm.getBookmarks().map((b) => ({
      name: b.name, sectionIdx: b.sec, paraIdx: b.para, charOffset: b.charPos, ctrlIdx: b.ctrlIdx,
    }));
    return { revision: this.revision, bookmarks };
  }

  private setBookmark(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const op = reqString(args, 'op');
    if (op !== 'add' && op !== 'delete' && op !== 'rename') {
      throw new AgentToolError('INVALID_ARGS', `op must be "add" | "delete" | "rename" (got ${JSON.stringify(op)})`);
    }
    const name = reqString(args, 'name');
    if (name.length < 1 || name.length > 80) {
      throw new AgentToolError('INVALID_ARGS', 'name must be 1..80 chars');
    }
    if (op === 'add') {
      const sectionIdx = reqInt(args, 'sectionIdx');
      const paraIdx = reqInt(args, 'paraIdx');
      const charOffset = reqInt(args, 'charOffset');
      this.validateAddress(sectionIdx, paraIdx, charOffset);
      if (this.deps.wasm.getBookmarks().some((b) => b.name === name)) {
        throw new AgentToolError('BOOKMARK_FAILED', `a bookmark named "${name}" already exists — bookmark names must be unique`);
      }
      const obj: ObjectOp = { type: 'bookmark', op: 'add', sectionIdx, paraIdx, charOffset, name };
      const r = this.deps.pending.addObjectOp(agent, obj);
      return { revision: this.revision, changeSetId: r.changeSetId, note: PENDING_NOTE };
    }
    // delete / rename — 이름으로 대상 해석
    const target = this.deps.wasm.getBookmarks().find((b) => b.name === name);
    if (!target) {
      throw new AgentToolError('BOOKMARK_NOT_FOUND', `no bookmark named "${name}" — call list_bookmarks for current names`);
    }
    if (op === 'rename') {
      const newName = reqString(args, 'newName');
      if (newName.length < 1 || newName.length > 80) {
        throw new AgentToolError('INVALID_ARGS', 'newName must be 1..80 chars');
      }
      if (this.deps.wasm.getBookmarks().some((b) => b.name === newName)) {
        throw new AgentToolError('BOOKMARK_FAILED', `a bookmark named "${newName}" already exists`);
      }
      const obj: ObjectOp = {
        type: 'bookmark', op: 'rename',
        sectionIdx: target.sec, paraIdx: target.para, ctrlIdx: target.ctrlIdx, name: newName,
      };
      const r = this.deps.pending.addObjectOp(agent, obj);
      return { revision: this.revision, changeSetId: r.changeSetId, note: PENDING_NOTE };
    }
    const obj: ObjectOp = {
      type: 'bookmark', op: 'delete',
      sectionIdx: target.sec, paraIdx: target.para, ctrlIdx: target.ctrlIdx,
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    return { revision: this.revision, changeSetId: r.changeSetId, note: PENDING_NOTE };
  }

  private async renderPage(args: Record<string, unknown>): Promise<unknown> {
    const pageIndex = reqInt(args, 'pageIndex');
    const { wasm } = this.deps;
    const pageCount = wasm.pageCount;
    if (pageCount === 0) {
      throw new AgentToolError('DOC_NOT_LOADED', 'No document is loaded in the studio; ask the user to open one.');
    }
    if (pageIndex < 0 || pageIndex >= pageCount) {
      throw new AgentToolError('INVALID_ARGS', `pageIndex ${pageIndex} out of range (0..${pageCount - 1})`);
    }
    const format = args['format'] === undefined || args['format'] === null ? 'svg' : reqString(args, 'format');
    if (format !== 'svg' && format !== 'png') {
      throw new AgentToolError('INVALID_ARGS', `format must be "svg" or "png" (got ${JSON.stringify(format)})`);
    }
    if (format === 'png') {
      const rawScale = args['scale'];
      if (rawScale !== undefined && rawScale !== null && (typeof rawScale !== 'number' || !Number.isFinite(rawScale))) {
        throw new AgentToolError('INVALID_ARGS', 'scale must be a number (clamped to 0.5..3)');
      }
      const scale = Math.min(3, Math.max(0.5, typeof rawScale === 'number' ? rawScale : 2));
      // 래스터화는 동기(wasm 렌더) — blob 변환만 비동기다
      const canvas = this.renderPageToCanvasElement(pageIndex, scale);
      const png = await canvasToPngBase64(canvas);
      return {
        revision: this.revision,
        pageIndex,
        image: { data: png.data, mimeType: 'image/png' },
        widthPx: png.widthPx,
        heightPx: png.heightPx,
      };
    }
    const svg = wasm.renderPageSvg(pageIndex);
    if (svg.length > MAX_SVG_BYTES) {
      throw new AgentToolError('RESULT_TOO_LARGE', `SVG is ${svg.length} bytes; page too complex to return`);
    }
    return { revision: this.revision, pageIndex, svg };
  }

  /** 래스터화용 캔버스 생성 — 브라우저 document 우선, 아니면 OffscreenCanvas (테스트/비브라우저는 RENDER_UNAVAILABLE) */
  private createRenderCanvas(): HTMLCanvasElement | OffscreenCanvas {
    if (typeof document !== 'undefined') return document.createElement('canvas');
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
    throw new AgentToolError(
      'RENDER_UNAVAILABLE',
      'PNG rendering needs a canvas (browser environment); use format "svg" instead',
    );
  }

  /** 페이지를 캔버스에 그린다 — wasm 이 캔버스 크기를 페이지 크기 × scale 로 설정한다 */
  private renderPageToCanvasElement(pageIndex: number, scale: number): HTMLCanvasElement | OffscreenCanvas {
    const canvas = this.createRenderCanvas();
    this.deps.wasm.renderPageToCanvas(pageIndex, canvas as unknown as HTMLCanvasElement, scale);
    return canvas;
  }

  private listNumberings(): unknown {
    this.requireDocLoaded();
    const { wasm } = this.deps;
    let numberings: Array<{ id: number; levelFormats: string[]; startNumber: number }> = [];
    let bullets: Array<{ id: number; char: string; rawCode: number }> = [];
    try { numberings = wasm.getNumberingList(); } catch { /* 구버전 wasm 호환 */ }
    try { bullets = wasm.getBulletList(); } catch { /* 구버전 wasm 호환 */ }
    return { revision: this.revision, numberings, bullets };
  }

  /**
   * 문단 서식 읽기 — getParaPropertiesAt 은 px(96dpi) 단위라 pt 로 환산해 반환한다
   * (apply_para_format 의 pt 입력과 대칭). headType 은 소문자로 정규화한다.
   */
  private getParaFormat(args: Record<string, unknown>): unknown {
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const cell = optCell(args);
    this.validateAddress(sectionIdx, paraIdx, undefined, cell);
    const { wasm } = this.deps;
    const props = cell
      ? wasm.getCellParaPropertiesAt(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx)
      : wasm.getParaPropertiesAt(sectionIdx, paraIdx);
    const pxToPt = (px: number | undefined): number | undefined =>
      (typeof px === 'number' ? Math.round(px * 72 / 96 * 10) / 10 : undefined);
    return {
      revision: this.revision,
      alignment: props.alignment,
      lineSpacingType: props.lineSpacingType,
      ...(props.lineSpacingType === 'Percent' ? { lineSpacingPercent: Math.round(props.lineSpacing ?? 100) } : {}),
      spaceBeforePt: pxToPt(props.spacingBefore),
      spaceAfterPt: pxToPt(props.spacingAfter),
      indentPt: pxToPt(props.indent),
      marginLeftPt: pxToPt(props.marginLeft),
      marginRightPt: pxToPt(props.marginRight),
      pageBreakBefore: props.pageBreakBefore === true,
      headType: (props.headType ?? 'None').toLowerCase(),
      numberingId: props.numberingId ?? 0,
      paraLevel: props.paraLevel ?? 0,
      paraShapeId: props.paraShapeId,
    };
  }

  /** 글자 서식 읽기 — getCharPropertiesAt 계열 (fontSize HWPUNIT → pt 환산) */
  private getCharFormat(args: Record<string, unknown>): unknown {
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    const cell = optCell(args);
    this.validateAddress(sectionIdx, paraIdx, charOffset, cell);
    const { wasm } = this.deps;
    const props = cell
      ? wasm.getCellCharPropertiesAt(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx, charOffset)
      : wasm.getCharPropertiesAt(sectionIdx, paraIdx, charOffset);
    return {
      revision: this.revision,
      fontFamily: props.fontFamily,
      fontSizePt: typeof props.fontSize === 'number' ? props.fontSize / 100 : undefined,
      bold: props.bold === true,
      italic: props.italic === true,
      underline: props.underline === true,
      strikethrough: props.strikethrough === true,
      superscript: props.superscript === true,
      subscript: props.subscript === true,
      textColor: props.textColor,
      shadeColor: props.shadeColor,
      fontId: props.fontId,
      charShapeId: props.charShapeId,
    };
  }

  /** 편집 직후 영향 문단 다이제스트 (~200자, best-effort — 실패 시 빈 문자열) */
  private readPostEditDigest(sectionIdx: number, paraIdx: number, charOffset: number, cell?: CellAddr): string {
    try {
      const { wasm } = this.deps;
      return cell
        ? wasm.getTextInCell(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx, charOffset, 200)
        : wasm.getTextRange(sectionIdx, paraIdx, charOffset, 200);
    } catch {
      return '';
    }
  }

  /** 문단이 표시되는 페이지 인덱스 (best-effort — 실패 시 null) */
  private pageOfParagraph(sectionIdx: number, paraIdx: number, cell?: CellAddr): number | null {
    const { wasm } = this.deps;
    try {
      const rect = cell
        ? wasm.getCursorRectInCell(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx, 0)
        : wasm.getCursorRect(sectionIdx, paraIdx, 0);
      return rect && typeof rect.pageIndex === 'number' ? rect.pageIndex : null;
    } catch {
      return null;
    }
  }

  /**
   * verify_changes — 에이전트 셀프체크. change set 요약 + 영향 문단의 편집 후 텍스트
   * 다이제스트 + 경고를 반환한다. includeImage 면 첫 영향 페이지를 mark-only op 까지
   * 적용한 상태(승인 후 모습)로 PNG 렌더한다 (withMarkedOpsApplied — 문서에는 흔적 없음).
   */
  private async verifyChanges(args: Record<string, unknown>): Promise<unknown> {
    this.requireDocLoaded();
    const rawId = args['changeSetId'];
    if (rawId !== undefined && rawId !== null && (typeof rawId !== 'string' || rawId.length < 1)) {
      throw new AgentToolError('INVALID_ARGS', 'changeSetId must be a non-empty string');
    }
    const changeSetId = typeof rawId === 'string' ? rawId : undefined;
    const includeImage = args['includeImage'] === true;
    const { pending } = this.deps;
    const summary = pending.describeChangeSet(changeSetId);
    const sets = pending.getChangeSets();
    const set = changeSetId !== undefined
      ? sets.find((s) => s.id === changeSetId)
      : sets[sets.length - 1];

    const warnings: string[] = [];
    if (!set) {
      warnings.push('no pending change set found — edits may have been approved/rejected already, or none were made');
    }

    // op 좌표 → 영향 문단 수집 (dedupe, 상한 8)
    interface AffectedPara { sectionIdx: number; paraIdx: number; cell?: CellAddr }
    const affected: AffectedPara[] = [];
    const seenPara = new Set<string>();
    let hasDeleteMark = false;
    let hasTableStructure = false;
    const templateTransfers: Array<{ label: string; templateRevision: number; affectedSections: number[]; skippedFeatures: string[] }> = [];
    const pushPara = (sectionIdx: number, paraIdx: number, cell?: CellAddr): void => {
      const key = cell
        ? `${sectionIdx}:c${cell.paraIdx}/${cell.controlIdx}/${cell.cellIdx}:${paraIdx}`
        : `${sectionIdx}:b:${paraIdx}`;
      if (seenPara.has(key) || affected.length >= 8) return;
      seenPara.add(key);
      affected.push(cell ? { sectionIdx, paraIdx, cell } : { sectionIdx, paraIdx });
    };
    for (const op of set?.ops ?? []) {
      if (op.kind === 'delete') hasDeleteMark = true;
      if (op.kind === 'object' && (op.obj.type === 'tableStructure' || op.obj.type === 'tableStructureMarked' || op.obj.type === 'deleteTable')) {
        hasTableStructure = true;
      }
      if (op.kind === 'template') {
        warnings.push(...op.report.warnings);
        templateTransfers.push({
          label: op.label,
          templateRevision: op.templateRevision,
          affectedSections: op.report.affectedSections,
          skippedFeatures: op.report.skippedFeatures,
        });
      }
      if (op.kind === 'insert' || op.kind === 'delete' || op.kind === 'replace' || op.kind === 'format') {
        const r = op.range;
        for (let p = r.startParaIdx; p <= Math.min(r.endParaIdx, r.startParaIdx + 2); p++) {
          pushPara(r.sectionIdx, p, r.cell);
        }
      } else if (op.kind === 'object') {
        const o = op.obj;
        switch (o.type) {
          case 'paraFormat':
          case 'applyStyle':
            pushPara(o.sectionIdx, o.paraIdx, o.cell);
            break;
          case 'createTable':
          case 'insertImage':
            if (o.anchor) pushPara(o.sectionIdx, o.anchor.paraIdx);
            break;
          case 'insertEquation':
            if (o.cell) pushPara(o.sectionIdx, o.paraIdx, o.cell);
            else if (o.anchor) pushPara(o.sectionIdx, o.anchor.paraIdx);
            break;
          case 'tableStructure':
          case 'tableStructureMarked':
          case 'deleteTable':
          case 'setCellProps':
          case 'setTableProps':
            pushPara(o.sectionIdx, o.tableParaIdx);
            break;
          default:
            break; // pageLayout/headerFooter — 문단 좌표 없음
        }
      }
    }
    if (hasDeleteMark) {
      warnings.push('deleted text remains visible struck-through until approval — expected, do not fix');
    }
    if (hasTableStructure) {
      warnings.push(
        'a table structure op is pending: cellIdx values of that table renumber only after the user approves — '
        + 'further edits to it are rejected (PENDING_DESTRUCTIVE_OP) until then; re-read get_structure on your next turn',
      );
    }

    // 편집 후 텍스트 다이제스트 (문단당 앞 200자 — 지금 문서에 보이는 그대로)
    const postEditText = affected.map((a) => ({
      sectionIdx: a.sectionIdx,
      paraIdx: a.paraIdx,
      ...(a.cell ? { cell: a.cell } : {}),
      text: this.readPostEditDigest(a.sectionIdx, a.paraIdx, 0, a.cell),
    }));
    const affectedPages: number[] = [];
    for (const a of affected) {
      const page = this.pageOfParagraph(a.sectionIdx, a.paraIdx, a.cell);
      if (page !== null && !affectedPages.includes(page)) affectedPages.push(page);
    }

    const result: Record<string, unknown> = {
      changeSetId: summary.changeSetId,
      status: summary.status,
      agent: summary.agent,
      ops: summary.ops,
      postEditText,
      affectedPages,
      warnings,
      templateTransfers,
      skippedFeatures: [...new Set(templateTransfers.flatMap((transfer) => transfer.skippedFeatures))],
      templateRevision: templateTransfers.at(-1)?.templateRevision,
    };

    if (includeImage) {
      const page = affectedPages[0] ?? 0;
      try {
        // 마크 전용 op 까지 적용한 "승인 후" 상태로 렌더하고 반드시 원복된다
        const canvas = set
          ? pending.withMarkedOpsApplied(set.id, () => this.renderPageToCanvasElement(page, 2))
          : this.renderPageToCanvasElement(page, 2);
        const png = await canvasToPngBase64(canvas);
        result['image'] = { data: png.data, mimeType: 'image/png' };
        result['imagePageIndex'] = page;
      } catch (e) {
        if (e instanceof AgentToolError && e.code !== 'RENDER_UNAVAILABLE') throw e;
        // 캔버스 없는 환경(테스트 등)이나 렌더 실패는 이미지 생략 + 경고로 degrade
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`includeImage requested but the page render is unavailable here — image skipped (${msg.slice(0, 120)})`);
      }
    }
    // withMarkedOpsApplied 가 미리보기 이벤트로 revision 을 올리므로 마지막에 읽는다
    return { revision: this.revision, ...result };
  }

  // ─── template context + structural transfer ─────────────────

  private requireTemplate(capability?: ToolCapabilityContext): DocumentTemplate {
    const template = capability?.template;
    if (!template) throw new AgentToolError('TEMPLATE_UNAVAILABLE', 'No active template is available for this chat.');
    if (!this.deps.loadTemplateBytes) throw new AgentToolError('TEMPLATE_UNAVAILABLE', 'Template loading is unavailable in this Studio.');
    return template;
  }

  private async ensureTemplate(capability?: ToolCapabilityContext): Promise<{ template: DocumentTemplate; wasm: WasmBridge }> {
    const template = this.requireTemplate(capability);
    const key = `${template.id}:${template.revision}`;
    if (this.templateWasm && this.templateKey === key) return { template, wasm: this.templateWasm };
    this.templateWasm?.releaseDocument();
    const { WasmBridge } = await import('../core/wasm-bridge.ts');
    const wasm = new WasmBridge();
    await wasm.initialize();
    const bytes = await this.deps.loadTemplateBytes!(template);
    wasm.loadDocument(bytes, template.originalName);
    this.templateWasm = wasm;
    this.templateKey = key;
    return { template, wasm };
  }

  private templateArgs(args: Record<string, unknown>, template: DocumentTemplate): Record<string, unknown> {
    const requested = reqInt(args, 'templateRevision');
    if (requested !== template.revision) {
      throw new AgentToolError('TEMPLATE_REVISION_MISMATCH', `Template revision ${requested} does not match ${template.revision}; inspect it again.`);
    }
    const { templateRevision: _revision, ...rest } = args;
    return rest;
  }

  private async templateRead(
    tool: string,
    args: Record<string, unknown>,
    capability?: ToolCapabilityContext,
    marksInspection = false,
  ): Promise<unknown> {
    const { template, wasm } = await this.ensureTemplate(capability);
    const nested = new AgentToolExecutor({ ...this.deps, wasm, loadTemplateBytes: undefined });
    const result = await nested.execute(tool, this.templateArgs(args, template));
    if (marksInspection) this.templateInspectionKey = `${template.id}:${template.revision}`;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const { revision: _documentRevision, ...rest } = result as Record<string, unknown>;
      return { templateId: template.id, templateRevision: template.revision, ...rest };
    }
    return { templateId: template.id, templateRevision: template.revision, result };
  }

  private async templateGetPageLayout(args: Record<string, unknown>, capability?: ToolCapabilityContext): Promise<unknown> {
    const { template, wasm } = await this.ensureTemplate(capability);
    this.templateArgs(args, template);
    const sectionIdx = reqInt(args, 'sectionIdx');
    if (sectionIdx >= wasm.getSectionCount()) throw new AgentToolError('INVALID_ARGS', `Template section ${sectionIdx} does not exist.`);
    return {
      templateId: template.id,
      templateRevision: template.revision,
      sectionIdx,
      page: wasm.getPageDef(sectionIdx),
      section: wasm.getSectionDef(sectionIdx),
      columns: wasm.getColumnDef(sectionIdx),
      border: wasm.getPageBorderFill(sectionIdx),
    };
  }

  private requireTemplateMapping(template: DocumentTemplate): void {
    if (this.documentInspectionRevision !== this.revision
      || this.templateInspectionKey !== `${template.id}:${template.revision}`) {
      throw new AgentToolError(
        'TEMPLATE_MAPPING_REQUIRED',
        'Inspect both the current document and the active template structure before transferring template content.',
      );
    }
  }

  private async templateApplySectionLayout(
    args: Record<string, unknown>,
    agent: AgentName,
    capability?: ToolCapabilityContext,
  ): Promise<unknown> {
    this.requireRevision(args);
    const { template, wasm: source } = await this.ensureTemplate(capability);
    this.templateArgs(args, template);
    this.requireTemplateMapping(template);
    const mappings = Array.isArray(args['mappings']) ? args['mappings'].map(asRecord) : [];
    if (mappings.length === 0) throw new AgentToolError('INVALID_ARGS', 'mappings must contain at least one section mapping.');
    const requested = Array.isArray(args['components'])
      ? new Set(args['components'].filter((item): item is string => typeof item === 'string'))
      : new Set(['page', 'columns', 'headersFooters', 'borders', 'sectionDefaults']);
    const target = this.deps.wasm;
    for (const mapping of mappings) {
      const sourceSection = reqInt(mapping, 'templateSectionIdx');
      const targetSection = reqInt(mapping, 'targetSectionIdx');
      if (sourceSection >= source.getSectionCount() || targetSection >= target.getSectionCount()) {
        throw new AgentToolError('INVALID_ARGS', `Invalid section mapping ${sourceSection} -> ${targetSection}.`);
      }
    }
    const pending = this.deps.pending.addTemplateMutation(
      agent,
      `Apply ${template.name} section layout`,
      template.revision,
      () => {
        const warnings: string[] = [];
        const skippedFeatures: string[] = [];
        const affectedSections: number[] = [];
        let transferredHeaderFooters = 0;
        for (const mapping of mappings) {
          const sourceSection = reqInt(mapping, 'templateSectionIdx');
          const targetSection = reqInt(mapping, 'targetSectionIdx');
          if (requested.has('page')) target.setPageDef(targetSection, source.getPageDef(sourceSection));
          if (requested.has('columns')) {
            const column = source.getColumnDef(sourceSection);
            target.setColumnDef(targetSection, column.columnCount, column.columnType, column.sameWidth ? 1 : 0, column.spacing);
          }
          if (requested.has('sectionDefaults')) target.setSectionDef(targetSection, source.getSectionDef(sourceSection));
          if (requested.has('borders')) target.setPageBorderFill(targetSection, source.getPageBorderFill(sourceSection));
          if (requested.has('headersFooters')) {
            for (const isHeader of [true, false]) {
              for (const applyTo of [0, 1, 2]) {
                const sourceBlock = JSON.parse(source.getHeaderFooter(sourceSection, isHeader, applyTo)) as {
                  exists?: boolean; text?: string;
                };
                if (sourceBlock.exists !== true) continue;
                const targetBlock = JSON.parse(target.getHeaderFooter(targetSection, isHeader, applyTo)) as { exists?: boolean };
                if (targetBlock.exists === true) target.deleteHeaderFooter(targetSection, isHeader, applyTo);
                target.createHeaderFooter(targetSection, isHeader, applyTo);
                const lines = String(sourceBlock.text ?? '').split('\n');
                if (lines[0]) target.insertTextInHeaderFooter(targetSection, isHeader, applyTo, 0, 0, lines[0]);
                for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
                  const previousLength = target.getHeaderFooterParaInfo(targetSection, isHeader, applyTo, lineIndex - 1);
                  const parsed = JSON.parse(previousLength) as { charCount?: number };
                  target.splitParagraphInHeaderFooter(
                    targetSection, isHeader, applyTo, lineIndex - 1,
                    Number(parsed.charCount ?? [...(lines[lineIndex - 1] ?? '')].length),
                  );
                  if (lines[lineIndex]) target.insertTextInHeaderFooter(targetSection, isHeader, applyTo, lineIndex, 0, lines[lineIndex]);
                }
                transferredHeaderFooters++;
              }
            }
          }
          if (!affectedSections.includes(targetSection)) affectedSections.push(targetSection);
        }
        if (transferredHeaderFooters > 0) {
          skippedFeatures.push('headerFooterFormattingAndControls');
          warnings.push('Header/footer text and page scope were transferred; rich formatting, fields, and unsupported controls use the target defaults or require a follow-up edit.');
        }
        return { warnings, skippedFeatures, affectedSections };
      },
    );
    return { revision: this.revision, pending: true, ...pending, templateRevision: template.revision, transferredComponents: [...requested] };
  }

  private async templateApplyParagraphFormat(
    args: Record<string, unknown>,
    agent: AgentName,
    capability?: ToolCapabilityContext,
  ): Promise<unknown> {
    this.requireRevision(args);
    const { template, wasm: sourceWasm } = await this.ensureTemplate(capability);
    this.templateArgs(args, template);
    this.requireTemplateMapping(template);
    const source = asRecord(args['source']);
    const sourceSection = reqInt(source, 'sectionIdx');
    const sourcePara = reqInt(source, 'paraIdx');
    const targets = Array.isArray(args['targets']) ? args['targets'].map(asRecord) : [];
    if (targets.length === 0) throw new AgentToolError('INVALID_ARGS', 'targets must contain at least one paragraph.');
    const paraProps = sourceWasm.getParaPropertiesAt(sourceSection, sourcePara);
    const charProps = sourceWasm.getCharPropertiesAt(sourceSection, sourcePara, 0);
    for (const item of targets) this.validateAddress(reqInt(item, 'sectionIdx'), reqInt(item, 'paraIdx'), 0);
    const pending = this.deps.pending.addTemplateMutation(
      agent,
      `Apply ${template.name} paragraph formatting`,
      template.revision,
      () => {
        const affectedSections: number[] = [];
        for (const item of targets) {
          const sectionIdx = reqInt(item, 'sectionIdx');
          const paraIdx = reqInt(item, 'paraIdx');
          this.deps.wasm.applyParaFormat(sectionIdx, paraIdx, JSON.stringify(paraProps));
          const length = this.deps.wasm.getParagraphLength(sectionIdx, paraIdx);
          if (length > 0) this.deps.wasm.applyCharFormat(sectionIdx, paraIdx, 0, length, JSON.stringify(charProps));
          if (!affectedSections.includes(sectionIdx)) affectedSections.push(sectionIdx);
        }
        return {
          warnings: ['Style and numbering identifiers are resolved through the target document formatting APIs; unsupported attributes use the closest supported value.'],
          skippedFeatures: [],
          affectedSections,
        };
      },
    );
    return { revision: this.revision, pending: true, ...pending, templateRevision: template.revision, targetCount: targets.length };
  }

  private async templateInsertBlock(
    args: Record<string, unknown>,
    agent: AgentName,
    capability?: ToolCapabilityContext,
  ): Promise<unknown> {
    this.requireRevision(args);
    const { template, wasm: sourceWasm } = await this.ensureTemplate(capability);
    this.templateArgs(args, template);
    this.requireTemplateMapping(template);
    const source = asRecord(args['source']);
    const target = asRecord(args['target']);
    const sourceSection = reqInt(source, 'sectionIdx');
    const startPara = reqInt(source, 'startParaIdx');
    const endPara = reqInt(source, 'endParaIdx');
    if (endPara < startPara) throw new AgentToolError('INVALID_ARGS', 'Template block range is reversed.');
    const targetSection = reqInt(target, 'sectionIdx');
    const targetPara = reqInt(target, 'paraIdx');
    const targetOffset = reqInt(target, 'charOffset');
    this.validateAddress(targetSection, targetPara, targetOffset);
    const endOffset = sourceWasm.getParagraphLength(sourceSection, endPara);
    const html = sourceWasm.exportSelectionHtml(sourceSection, startPara, 0, endPara, endOffset);
    const pending = this.deps.pending.addTemplateMutation(
      agent,
      `Insert block from ${template.name}`,
      template.revision,
      () => {
        this.deps.wasm.pasteHtml(targetSection, targetPara, targetOffset, html);
        return {
          warnings: ['The block was remapped through the cross-document HTML transfer path; unsupported controls use their closest supported representation.'],
          skippedFeatures: [],
          affectedSections: [targetSection],
        };
      },
    );
    return { revision: this.revision, pending: true, ...pending, templateRevision: template.revision, source: { sectionIdx: sourceSection, startParaIdx: startPara, endParaIdx: endPara } };
  }

  dispose(): void {
    this.templateWasm?.releaseDocument();
    this.templateWasm = null;
    this.templateKey = null;
    this.templateInspectionKey = null;
    this.documentInspectionRevision = null;
  }

  // ─── write tools (PendingEditManager 위임) ─────────────────

  private insertText(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    const cell = optCell(args);
    // \r\n / \r → \n 정규화 (wasm 은 \n 만 문단 분할로 처리한다)
    const text = reqString(args, 'text').replace(/\r\n?/g, '\n');
    if (text.length < 1 || text.length > 10_000) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `text must be 1..10000 chars (got ${text.length}); beyond the limit, split it into multiple insert_text calls, chaining each response's revision into the next call's expectedRevision`,
      );
    }
    this.validateAddress(sectionIdx, paraIdx, charOffset, cell);
    if (cell) this.guardDestructiveMark(sectionIdx, cell.paraIdx, cell.controlIdx);
    const mark = this.deps.pending.findDeleteMarkContaining?.(sectionIdx, paraIdx, charOffset, cell);
    if (mark) {
      throw new AgentToolError(
        'PENDING_DELETE_OVERLAP',
        `insertion point p${paraIdx}:${charOffset} is inside a range already marked for deletion `
        + `(p${mark.range.startParaIdx}:${mark.range.startCharOffset}-p${mark.range.endParaIdx}:${mark.range.endCharOffset}) — `
        + 'text inserted there would be deleted together on approval. Insert at the mark start '
        + `(p${mark.range.startParaIdx}:${mark.range.startCharOffset}) or after its end instead, `
        + 'or use replace_range for delete+insert in one atomic op.',
      );
    }
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
      postEdit: this.readPostEditDigest(sectionIdx, r.insertedRange.startParaIdx, r.insertedRange.startCharOffset, cell),
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
    // 즉시 적용 삭제(빈 교체) — 마크 전용이던 시절엔 원문이 레이아웃에 남아
    // 편집이 많은 턴에서 미리보기 쪽나눔이 최종본과 어긋났다. 삭제된 텍스트는
    // 앵커/팝오버와 사이드바 카드로 검토하고, 거절 시 스냅샷으로 복원된다.
    const r = this.deps.pending.replaceText(range, '', agent);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      deletedText: r.deletedText.slice(0, 300),
      collapsedAt: { paraIdx: range.startParaIdx, charOffset: range.startCharOffset },
      postEdit: this.readPostEditDigest(range.sectionIdx, range.startParaIdx, range.startCharOffset, range.cell),
      note: `text removed from the live preview now; finalized on approval, restored on reject. Coordinates after the range have shifted — use collapsedAt to insert replacement text. ${PENDING_NOTE}`,
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
    const mark = this.deps.pending.findDeleteMarkOverlapping?.(range);
    if (mark) {
      throw new AgentToolError('PENDING_DELETE_OVERLAP',
        `range overlaps a range already marked for deletion `
        + `(p${mark.range.startParaIdx}:${mark.range.startCharOffset}-p${mark.range.endParaIdx}:${mark.range.endCharOffset}) — `
        + 'replacing marked text corrupts the pending delete. Either replace outside the mark, '
        + 'or skip the delete_range and use replace_range alone for that region.');
    }
    // 원자적 교체 (삭제 마크 + 끝 삽입 2-op 조합 폐기) — 서식 보존 + 스냅샷 기반 되돌림
    const r = this.deps.pending.replaceText(range, text, agent);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      insertedRange: {
        startParaIdx: r.insertedRange.startParaIdx,
        startCharOffset: r.insertedRange.startCharOffset,
        endParaIdx: r.insertedRange.endParaIdx,
        endCharOffset: r.insertedRange.endCharOffset,
      },
      postEdit: this.readPostEditDigest(range.sectionIdx, r.insertedRange.startParaIdx, r.insertedRange.startCharOffset, range.cell),
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
    if (endOffset === startOffset) {
      throw new AgentToolError('INVALID_ARGS', 'range is empty (startOffset === endOffset) — formatting needs at least one character');
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

  /**
   * 구조 op 이 걸린 표에 대한 후속 편집 차단 (설계 리뷰 확정 가드).
   * insert_row/col 은 적용 즉시, delete_row/col·merge 는 승인 시 cellIdx 가 재번호
   * 매겨지므로 승인 전에는 같은 표의 어떤 편집도 모호하다. 승인은 턴 사이에서만 일어난다.
   */
  private guardDestructiveMark(sectionIdx: number, tableParaIdx: number, controlIdx: number): void {
    if (this.deps.pending.hasPendingStructureOp(sectionIdx, tableParaIdx, controlIdx)) {
      throw new AgentToolError(
        'PENDING_DESTRUCTIVE_OP',
        'This table has a pending structure edit (insert/delete row/col or merge_cells) whose cellIdx renumbering is not final until the user approves it. Approval can only happen between turns: finish your turn now, the user approves in the sidebar, then re-read get_structure and retry with fresh coordinates on your next turn.',
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
    const optBool = (key: string, fallback: boolean): boolean => {
      const v = args[key];
      if (v === undefined || v === null) return fallback;
      if (typeof v !== 'boolean') throw new AgentToolError('INVALID_ARGS', `${key} must be a boolean`);
      return v;
    };

    switch (op) {
      case 'insert_row': {
        const rowIdx = reqIdx('rowIdx', dims.rowCount);
        const obj: ObjectOp = { type: 'tableStructure', ...base, op: 'insert_row', index: rowIdx, after: optBool('below', true) };
        const r = this.deps.pending.addObjectOp(agent, obj);
        const d = (r.obj as Extract<ObjectOp, { type: 'tableStructure' }>).dims!;
        return { revision: this.revision, changeSetId: r.changeSetId, rowCount: d.rowCount, colCount: d.colCount, note: PENDING_NOTE };
      }
      case 'insert_col': {
        const colIdx = reqIdx('colIdx', dims.colCount);
        const obj: ObjectOp = { type: 'tableStructure', ...base, op: 'insert_col', index: colIdx, after: optBool('right', true) };
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
        return { revision: this.revision, changeSetId: r.changeSetId, note: `cells are NOT merged yet — highlighted until the user approves. Merging renumbers cellIdx only on approval, so re-read get_structure on your next turn before editing this table again. ${PENDING_NOTE}` };
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

  private deleteTable(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const controlIdx = reqInt(args, 'controlIdx');
    const { wasm } = this.deps;
    let dims: { rowCount: number; colCount: number; cellCount: number };
    try {
      dims = wasm.getTableDimensions(sectionIdx, paraIdx, controlIdx);
    } catch {
      throw new AgentToolError('INVALID_ARGS', `No table control at section ${sectionIdx}, paragraph ${paraIdx}, controlIdx ${controlIdx} — use get_structure to list tables`);
    }
    this.guardDestructiveMark(sectionIdx, paraIdx, controlIdx);
    const obj: ObjectOp = {
      type: 'deleteTable',
      sectionIdx,
      tableParaIdx: paraIdx,
      controlIdx,
      dims: { rowCount: dims.rowCount, colCount: dims.colCount },
    };
    const r = this.deps.pending.addObjectOp(agent, obj);
    return {
      ok: true,
      marked: true,
      sectionIdx,
      paraIdx,
      controlIdx,
      revision: this.revision,
      changeSetId: r.changeSetId,
      note: `table is NOT removed yet — highlighted until the user approves. Further edits to this table fail with PENDING_DESTRUCTIVE_OP. ${PENDING_NOTE}`,
    };
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
    // 목록 속성 — Rust parse_para_shape_mods 의 JSON 키("headType": "Outline"|"Number"|"Bullet"|"None" 등)로 매핑
    const headType = args['headType'];
    if (headType !== undefined && headType !== null) {
      const headMap: Record<string, string> = { none: 'None', number: 'Number', bullet: 'Bullet', outline: 'Outline' };
      if (typeof headType !== 'string' || !(headType in headMap)) {
        throw new AgentToolError('INVALID_ARGS', 'headType must be one of none|number|bullet|outline');
      }
      props['headType'] = headMap[headType];
    }
    const numberingId = args['numberingId'];
    if (numberingId !== undefined && numberingId !== null) {
      if (typeof numberingId !== 'number' || !Number.isSafeInteger(numberingId) || numberingId < 0) {
        throw new AgentToolError('INVALID_ARGS', 'numberingId must be a non-negative integer (see list_numberings)');
      }
      props['numberingId'] = numberingId;
    }
    const paraLevel = args['paraLevel'];
    if (paraLevel !== undefined && paraLevel !== null) {
      if (typeof paraLevel !== 'number' || !Number.isSafeInteger(paraLevel) || paraLevel < 0 || paraLevel > 6) {
        throw new AgentToolError('INVALID_ARGS', 'paraLevel must be an integer 0..6');
      }
      props['paraLevel'] = paraLevel;
    }
    const bulletChar = args['bulletChar'];
    if (bulletChar !== undefined && bulletChar !== null) {
      if (typeof bulletChar !== 'string' || bulletChar.length < 1) {
        throw new AgentToolError('INVALID_ARGS', 'bulletChar must be a non-empty string');
      }
      // 글머리표 문자 → 정의 id (없으면 생성). numberingId 를 덮어쓰고 기본 headType 은 Bullet
      props['numberingId'] = this.deps.wasm.ensureDefaultBullet(bulletChar);
      if (props['headType'] === undefined) props['headType'] = 'Bullet';
    }
    if (Object.keys(props).length === 0) {
      throw new AgentToolError('INVALID_ARGS', 'At least one paragraph format key is required (alignment/lineSpacingPercent/spaceBeforePt/spaceAfterPt/indentPt/marginLeftPt/marginRightPt/pageBreakBefore/headType/numberingId/paraLevel/bulletChar)');
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

  /**
   * apply_list — 문단 범위에 실제 HWP 목록(자동 번호/글머리표)을 적용한다.
   * 번호 정의는 같은 레벨 서식의 기존 정의를 재사용하고 없으면 새로 만든다.
   * 각 문단에는 paraFormat op 하나씩 (headType/numberingId/paraLevel) 이 걸린다.
   */
  private applyList(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const startParaIdx = reqInt(args, 'startParaIdx');
    const endParaIdx = reqInt(args, 'endParaIdx');
    this.validateAddress(sectionIdx, startParaIdx);
    this.validateAddress(sectionIdx, endParaIdx);
    if (endParaIdx < startParaIdx) {
      throw new AgentToolError('INVALID_ARGS', 'endParaIdx must be >= startParaIdx');
    }
    const level = optInt(args, 'level', 0);
    if (level < 0 || level > 6) {
      throw new AgentToolError('INVALID_ARGS', `level must be 0..6 (got ${level})`);
    }
    const rawStart = args['startNumber'];
    const startNumber = rawStart === undefined || rawStart === null ? undefined : reqInt(args, 'startNumber');
    if (startNumber !== undefined && startNumber < 1) {
      throw new AgentToolError('INVALID_ARGS', 'startNumber must be >= 1');
    }
    const { wasm } = this.deps;

    let headType: 'Number' | 'Bullet';
    let numberingId: number;
    const bulletChar = args['bulletChar'];
    if (bulletChar !== undefined && bulletChar !== null) {
      if (typeof bulletChar !== 'string' || bulletChar.length < 1) {
        throw new AgentToolError('INVALID_ARGS', 'bulletChar must be a non-empty string');
      }
      headType = 'Bullet';
      numberingId = wasm.ensureDefaultBullet(bulletChar);
    } else {
      headType = 'Number';
      const format = reqString(args, 'format');
      const fmt = LIST_FORMAT_MAP[format];
      if (!fmt) {
        throw new AgentToolError(
          'INVALID_ARGS',
          `format must be one of ${Object.keys(LIST_FORMAT_MAP).join('|')} (got ${JSON.stringify(format)})`,
        );
      }
      // 7수준 정의: 요청 레벨만 요청 형식으로, 나머지는 한컴 기본 패턴으로 채운다
      const levelFormats = LIST_DEFAULT_LEVEL_FORMATS.slice();
      const numberFormats = LIST_DEFAULT_NUMBER_FORMATS.slice();
      levelFormats[level] = fmt.pattern(level);
      numberFormats[level] = fmt.code;
      // 같은 레벨 서식(패턴)과 번호 유형 코드가 모두 일치하는 기존 정의가 있으면
      // 재사용한다 (정의 중복 축적 방지). 패턴은 같아도 유형 코드가 일치하지
      // 않으면 렌더 결과가 달라지므로('1.' 요청에 가,나,다 정의 재사용 등) 재사용하지 않는다.
      // numberFormats 를 반환하지 않는 구버전 wasm 에서는 유형을 검증할 수 없어
      // 재사용을 포기하고 새 정의를 만든다.
      // 시작 번호도 일치해야 재사용한다 — 다르면 문단에 직접 재시작을 쓰는 대신
      // (pending 밖 문서 변경이라 거절/실행 취소로 되돌릴 수 없다) 시작 번호를
      // 품은 새 정의를 만든다.
      const wantStart = startNumber ?? 1;
      let existing: { id: number; levelFormats: string[]; numberFormats?: number[]; startNumber: number } | undefined;
      try {
        existing = wasm.getNumberingList().find(
          (n) => n.levelFormats[level] === levelFormats[level]
            && n.numberFormats?.[level] === numberFormats[level]
            && (n.startNumber ?? 1) === wantStart,
        );
      } catch { /* 구버전 wasm 호환 — 조회 실패 시 새로 생성 */ }
      if (existing) {
        numberingId = existing.id;
      } else {
        numberingId = wasm.createNumbering(JSON.stringify({
          levelFormats, numberFormats, startNumber: startNumber ?? 1,
        }));
      }
    }

    let changeSetId = '';
    for (let p = startParaIdx; p <= endParaIdx; p++) {
      const obj: ObjectOp = {
        type: 'paraFormat', sectionIdx, paraIdx: p,
        propsJson: JSON.stringify({ headType, numberingId, paraLevel: level }),
        prevParaShapeId: -1, charOffset: 0,
        textSample: this.paraTextSample(sectionIdx, p),
      };
      changeSetId = this.deps.pending.addObjectOp(agent, obj).changeSetId;
    }
    return {
      revision: this.revision,
      changeSetId,
      numberingId,
      paragraphs: endParaIdx - startParaIdx + 1,
      note: PENDING_NOTE,
    };
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
    const { script, fontSizeHu, fontSizePt, colorRef, preview } =
      this.validateEquationArgs(args, { sectionIdx, paraIdx, charOffset, ...(cell ? { cell } : {}) });
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
      fontSizePt,
      ...(preview.widthPx !== undefined ? { widthMm: pxToMm(preview.widthPx) } : {}),
      ...(preview.heightPx !== undefined ? { heightMm: pxToMm(preview.heightPx) } : {}),
      ...(preview.baselinePx !== undefined ? { baselineMm: pxToMm(preview.baselinePx) } : {}),
      warnings: preview.warnings,
      note: PENDING_NOTE,
    };
  }

  private previewEquation(args: Record<string, unknown>): unknown {
    this.requireDocLoaded();
    const { preview } = this.validateEquationArgs(args);
    if (preview.svg.length > MAX_SVG_BYTES) {
      throw new AgentToolError('RESULT_TOO_LARGE', `SVG is ${preview.svg.length} bytes`);
    }
    return {
      revision: this.revision,
      svg: preview.svg,
      ...(preview.widthPx !== undefined ? { widthMm: pxToMm(preview.widthPx) } : {}),
      ...(preview.heightPx !== undefined ? { heightMm: pxToMm(preview.heightPx) } : {}),
      ...(preview.baselinePx !== undefined ? { baselineMm: pxToMm(preview.baselinePx) } : {}),
      warnings: preview.warnings,
    };
  }

  /**
   * 수식 스크립트 검증 게이트 — 삽입 전 renderEquationPreview 로 렌더해 보고,
   * 실패하면 INVALID_SCRIPT 로 거부한다 (깨진 수식이 문서에 들어가지 않는다).
   * addr 이 있으면 fontSizePt 생략 시 삽입 지점 앞 문자의 글꼴 크기를 상속한다.
   */
  private validateEquationArgs(
    args: Record<string, unknown>,
    addr?: { sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr },
  ): { script: string; fontSizeHu: number; fontSizePt: number; colorRef: number; preview: EquationPreview } {
    const script = reqString(args, 'script');
    // 직렬화기 u16 길이 필드 보호 — studio MAX_EQUATION_SCRIPT_LEN 과 동일 상한
    if (script.length < 1 || script.length > 8000) {
      throw new AgentToolError('INVALID_ARGS', 'script must be 1..8000 chars');
    }
    let fontSizePt = args['fontSizePt'];
    if (fontSizePt !== undefined && fontSizePt !== null
      && (typeof fontSizePt !== 'number' || !(fontSizePt >= 1) || fontSizePt > 200)) {
      throw new AgentToolError('INVALID_ARGS', 'fontSizePt must be 1..200');
    }
    if ((fontSizePt === undefined || fontSizePt === null) && addr) {
      fontSizePt = this.ambientFontSizePt(addr);
    }
    const pt = typeof fontSizePt === 'number' ? fontSizePt : 10;
    const color = args['color'];
    if (color !== undefined && color !== null && (typeof color !== 'string' || !HEX_COLOR_RE.test(color))) {
      throw new AgentToolError('INVALID_ARGS', 'color must be "#RRGGBB"');
    }
    const fontSizeHu = ptToHu(pt);
    const colorRef = typeof color === 'string' ? hexColorRef(color) : 0;
    let preview: EquationPreview;
    try {
      preview = parseEquationPreview(this.deps.wasm.renderEquationPreview(script, fontSizeHu, colorRef));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new AgentToolError('INVALID_SCRIPT', `equation script failed to render: ${msg.slice(0, 300)}`);
    }
    if (!preview.svg.includes('<svg')) {
      throw new AgentToolError('INVALID_SCRIPT', 'equation script rendered no output — check HWP equation syntax (over, sqrt {}, int _{a} ^{b}, PMATRIX{a & b # c & d}, …)');
    }
    return { script, fontSizeHu, fontSizePt: pt, colorRef, preview };
  }

  /** 삽입 지점 앞 문자의 글꼴 크기(pt) — 삽입 수식은 앞 문자 서식을 따라가므로 (best-effort) */
  private ambientFontSizePt(addr: { sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr }): number | undefined {
    try {
      const probe = addr.charOffset > 0 ? addr.charOffset - 1 : 0;
      const props = addr.cell
        ? this.deps.wasm.getCellCharPropertiesAt(
          addr.sectionIdx, addr.cell.paraIdx, addr.cell.controlIdx, addr.cell.cellIdx, addr.paraIdx, probe,
        )
        : this.deps.wasm.getCharPropertiesAt(addr.sectionIdx, addr.paraIdx, probe);
      return typeof props.fontSize === 'number' && props.fontSize > 0 ? props.fontSize / 100 : undefined;
    } catch {
      return undefined;
    }
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
        if (typeof w !== 'number' || typeof h !== 'number' || w < 30 || h < 30 || w > 1000 || h > 1000) {
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
    const applyTo = 0; // Both — 이 도구는 항상 양쪽 페이지 대상 컨트롤을 쓴다
    let existedBefore = false;
    let oddEvenExists = false;
    try {
      const raw = JSON.parse(wasm.getHeaderFooter(sectionIdx, isHeader, applyTo)) as { exists?: boolean };
      existedBefore = raw?.exists === true;
      // 홀수/짝수 전용 컨트롤(applyTo 1/2)은 교체 대상이 아니므로 따로 조회해
      // "없다"고 잘못 안내한 채 중복 컨트롤을 만드는 일을 막는다.
      for (const scoped of [1, 2]) {
        const r = JSON.parse(wasm.getHeaderFooter(sectionIdx, isHeader, scoped)) as { exists?: boolean };
        if (r?.exists === true) oddEvenExists = true;
      }
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
      note: (oddEvenExists
        ? `this section also has an odd/even-page-only ${which} which this tool does NOT replace — the new both-pages ${which} may render alongside it. `
        : '') + (existedBefore
        ? `existing ${which} will be replaced on approval. ${PENDING_NOTE}`
        : PENDING_NOTE),
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
