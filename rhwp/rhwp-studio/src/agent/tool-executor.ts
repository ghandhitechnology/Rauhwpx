/**
 * MCP 툴 실행기 — 허브가 전달한 tool-request를 실제 문서 호출로 매핑한다.
 *
 * read 툴은 WasmBridge를 직접 호출한다. 고수준 write 툴은 PendingEditManager에
 * staging한 뒤 턴 성공 시 권한 프로필에 따라 자동 커밋(전체)하거나 검토 대기(안전)로
 * 남기고, 전체 엔진 표면은 원자적 스냅샷 배치로 실행한다(전체 프로필 전용). 모든 read 응답에
 * revision을 포함하고, 모든 write는 expectedRevision을 먼저 검사한다.
 */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { DocumentDirtyState } from '../core/document-dirty-state.ts';
import type { CellPathEntry, ControlLayoutItem, DocumentPosition, LineLayoutItem, ParaProperties, SelectionRect } from '../core/types.ts';
import type { RevisionTracker } from './revision.ts';
import type { PendingEditManager } from './pending-edits.ts';
import type { AgentName, AgentPhase, AgentWorkflow, CellAddr, CharFormatProps, DocRange, DocumentTemplate, ObjectOp, PendingOp, PermissionProfile } from './types.ts';
import { AgentToolError } from './types.ts';
import { EditJournal, type EditJournalEntry } from './edit-journal.ts';
import { renderChartPng, validateChartSpec } from './chart-render.ts';
import { cropImageOnCanvas, REFERENCE_READ_MAX_PIXELS, type ImageCropper, type PixelBox } from './image-crop.ts';
import { describeObject, EDIT_OBJECT_ARG_KEYS, planInsertShape, planObjectEdit, type ObjectKind } from './object-edit-args.ts';
import type { ChartSpec } from './chart-render.ts';
import {
  runEngineEdits,
  validateEngineEdits,
  applyEngineEditSession,
  getEngineEditCapabilities,
  getEngineEditCapabilityCount,
  getEngineEditMethodNamesByKind,
  getReferencedTypeDefinitions,
  type EngineEditOperation,
} from './engine-edit.ts';
import { inferExportFormat } from '../command/save-target.ts';
import { fatalEquationDiagnostics, parseEquationPreview, type EquationPreview } from '../core/equation-preview.ts';
import {
  AFTER_MAX_PAGES,
  AFTER_MAX_PARAGRAPHS,
  AFTER_TEXT_CHARS,
  AFTER_WINDOW_LEAD,
  PAGE_START_SCAN_LIMIT,
  RENDER_MAX_PAGES,
  RENDER_STACK_GAP_PX,
  movedParagraphRuns,
  movedRunWarnings,
  planCropRegions,
  planStack,
  type CropRegion,
  type PageFrame,
  type PageStart,
  type SectionEdit,
} from './write-report.ts';

export interface AgentToolExecutorDeps {
  wasm: WasmBridge;
  inputHandler: InputHandler;
  documentState: DocumentDirtyState;
  revision: RevisionTracker;
  pending: PendingEditManager;
  loadTemplateBytes?: (template: DocumentTemplate) => Promise<Uint8Array>;
  getDocumentSourcePath?: () => Promise<string | null>;
  isReadOnly?: () => boolean;
  canPublishCloudDocument?: () => boolean;
  /** 참조 이미지 잘라내기 — 기본은 브라우저 캔버스 (테스트가 주입한다) */
  cropImage?: ImageCropper;
}

const DOC_NOT_LOADED_MESSAGE = '문서가 로드되지 않았습니다';
/** 중첩 표 탐침에서 훑을 셀 문단 컨트롤 수 — 셀 문단의 컨트롤은 보통 한둘이다 */
const NESTED_TABLE_PROBE_CONTROLS = 4;

const MAX_SVG_BYTES = 800_000;
// WebSocket text frames cap at 100 MiB. Base64 expands by 4/3, so 64 MiB
// leaves room for the protocol envelope while still covering normal HWP/HWPX files.
const MAX_DOCUMENT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** get_structure compact 텍스트의 범례 — 결과 머리에 한 번만 싣는다. */
const STRUCTURE_LEGEND = 'Lines: "s<sec> p<paraIdx> (<length>) <text>"; … = preview cut, ⇥ = tab, "pA-pB empty" = empty paragraphs. '
  + 'Each table follows its anchor paragraph as "table s<sec> p<paraIdx> c<controlIdx> <rows>x<cols>" plus "r<row> [cellIdx] text | …" lines; '
  + 'rsN/csN = span when not 1, ⏎ = next cell paragraph (cellParaIdx 0,1,…), ⊞ = cell paragraph holding a nested table (use find_text/get_selection). '
  + 'cell = {paraIdx: table p, controlIdx: table c, cellIdx}. format:"json" gives JSON.';

interface StructureParagraph { paraIdx: number; length: number; text: string }
interface StructureCellParagraph { cellParaIdx: number; length: number; text: string }
interface StructureTable {
  paraIdx: number;
  controlIdx: number;
  rowCount: number;
  colCount: number;
  cellCount: number;
  cells: Array<{
    cellIdx: number; row: number; col: number; rowSpan: number; colSpan: number;
    paragraphs: StructureCellParagraph[];
  }>;
  /** 문단 예산이 이 표의 셀 텍스트 수집 도중/이전에 소진됐다 (JSON 출력에는 싣지 않는다) */
  textCut: boolean;
}
/** get_structure range 인자 — 파싱·검증 후 수집을 이 본문 문단 범위로 좁힌다. */
interface StructureRange { sectionIdx: number; fromPara: number; toPara: number }
interface StructureData {
  sectionCount: number;
  pageCount: number;
  truncated: boolean;
  range?: StructureRange;
  sections: Array<{ sectionIdx: number; paragraphCount: number; paragraphs: StructureParagraph[] }>;
  tablesBySection: Map<number, StructureTable[]>;
}

/** get_structure(sinceRevision) 한 변경 구간 — 현재 좌표 범위 + 대체된 from-시점 범위 + 그 구간의 문단/표. */
interface StructureDeltaChange {
  sectionIdx: number;
  paraStart: number;
  paraEnd: number;
  wasRanges: Array<[number, number]>;
  paragraphs: StructureParagraph[];
  tables: StructureTable[];
}

/** compact 구조 텍스트용 치환 — 탭/개행을 한 줄에 실을 수 있는 문자로 바꾼다. */
function cleanStructureText(text: string): string {
  return text.replace(/\t/g, '⇥').replace(/\r?\n|\r/g, '⏎');
}
function previewStructureText(text: string, length: number): string {
  return cleanStructureText(text) + (text.length < length ? '…' : '');
}

/** anchor.within 의 검색 범위 — collectTextMatches 의 선택적 scope 인자와 같은 모양. */
interface AnchorScope {
  sectionIdx?: number;
  /** [startParaIdx, endParaIdx] 본문 문단 범위(포함) — 셀 매치는 표의 본문 문단으로 판정한다. */
  paraRange?: [number, number];
  /** 이 최상위 셀(안의 중첩 표까지) 안의 매치만 본다. */
  cell?: { paraIdx: number; controlIdx: number; cellIdx: number };
}

/** collectTextMatches 매치 하나가 앵커로 확정된 모양 + 호출자가 준 position. */
interface ResolvedAnchor {
  sectionIdx: number;
  paraIdx: number;
  charOffset: number;
  length: number;
  cell?: CellAddr;
  position?: 'before' | 'after' | 'replace';
}

/** anchor 와 숫자 좌표를 섞어 보낼 때 걸러내는 좌표 인자 목록 (optAnchor 가 사용). */
const ANCHOR_COORD_KEYS = [
  'sectionIdx', 'paraIdx', 'charOffset',
  'startParaIdx', 'startCharOffset', 'endParaIdx', 'endCharOffset',
  'startOffset', 'endOffset',
  'cell', 'cellPath',
];


/** Every Studio tool that can create or stage a document mutation. */
export const DOCUMENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'publish_cloud_document',
  'apply_edits',
  'insert_text',
  'delete_range',
  'replace_range',
  'apply_char_format',
  'apply_list',
  'set_field_value',
  'create_table',
  'delete_table',
  'edit_table',
  'set_table_props',
  'set_cell_props',
  'set_zone_borders',
  'apply_para_format',
  'apply_style',
  'insert_image',
  'insert_equation',
  'edit_object',
  'insert_shape',
  'set_page_layout',
  'edit_header_footer',
  'insert_page_break',
  'insert_chart',
  'replace_all',
  'insert_footnote',
  'edit_footnote',
  'set_bookmark',
  'apply_engine_edits',
  'prepare_engine_edit_session',
  'template_apply_section_layout',
  'template_apply_paragraph_format',
  'template_insert_block',
]);

export function isDocumentWriteTool(tool: string) {
  return DOCUMENT_WRITE_TOOLS.has(tool);
}

/** 엔진 배치 도구 — 스테이징되지만 after 보고/render 는 semantic 쓰기에만 붙는다. */
const ENGINE_WRITE_TOOLS: ReadonlySet<string> = new Set(['apply_engine_edits', 'prepare_engine_edit_session']);

/**
 * apply_edits 배치에 넣을 수 있는 staged semantic write — 전부 동기 dispatch 여야
 * 한다 (runAtomicBatch 의 fn 은 동기). insert_image/insert_chart 는 비동기이거나
 * mcp-stdio 의 로컬 파일 전처리에 의존해 제외한다.
 */
const BATCHABLE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'insert_text',
  'delete_range',
  'replace_range',
  'apply_char_format',
  'apply_para_format',
  'apply_style',
  'apply_list',
  'set_field_value',
  'insert_page_break',
  'insert_footnote',
  'edit_footnote',
  'set_bookmark',
  'edit_header_footer',
  'set_page_layout',
  'create_table',
  'edit_table',
  'set_table_props',
  'set_cell_props',
  'set_zone_borders',
  'delete_table',
  'insert_equation',
  'edit_object',
  'insert_shape',
]);

/**
 * read_batch 에 넣을 수 있는 읽기 전용 문서 도구 — 허브의 BATCHABLE_READ_TOOL_NAMES
 * 와 일치해야 한다 (agent-write-tools-guard 소스 가드). render_page 와
 * materialize_document_snapshot 은 이미지/바이트 결과가 중첩 JSON 으로 의미를 잃어
 * 제외하고, 템플릿 읽기는 다른 문서를 여는 도구라 제외한다. 목록 밖의 이름은 항목
 * 오류로 개별 보고된다.
 */
const BATCHABLE_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_structure',
  'get_text_range',
  'get_selection',
  'get_fields',
  'get_document_info',
  'find_text',
  'get_page_geometry',
  'get_para_format',
  'get_char_format',
  'get_table_properties',
  'get_table_layout',
  'get_engine_edit_capabilities',
  'list_styles',
  'list_numberings',
  'get_outline',
  'list_footnotes',
  'list_bookmarks',
  'preview_equation',
  'verify_changes',
]);

export interface ToolCapabilityContext {
  workflow: AgentWorkflow;
  /** Phase and epoch carried by this tool-request. Kept unknown so malformed frames fail closed. */
  phase?: unknown;
  capabilityEpoch?: unknown;
  /** Server state last synchronized by the Studio bridge. */
  activePhase?: AgentPhase;
  activeCapabilityEpoch?: number | null;
  /** 현재 채팅의 권한 프로필 — 안전 모드에서는 클라우드 게시를 막는다. */
  permissionProfile?: PermissionProfile;
  template?: DocumentTemplate;
  /** Exact hub turn/cancellation fence captured for this request. */
  requestIsActive?: () => boolean;
}

export function assertToolRequestActive(capability?: ToolCapabilityContext): void {
  if (capability?.requestIsActive && !capability.requestIsActive()) {
    throw new AgentToolError(
      'NO_ACTIVE_TURN',
      'The provider tool request no longer belongs to the active turn.',
    );
  }
}

/** Enforce plan-mode write authority before dispatch can touch document state. */
export function assertToolCapability(tool: string, capability?: ToolCapabilityContext) {
  if (!isDocumentWriteTool(tool)) return;
  if (capability?.workflow === 'question') {
    throw new AgentToolError(
      'QUESTION_MODE_READ_ONLY',
      'Document-write tools are disabled in question mode. Switch to /plan to brainstorm or /build to edit.',
    );
  }
  if (capability?.workflow !== 'plan') return;
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
export function huToMm(hu: number): number { return Math.round((hu / HU_PER_MM) * 100) / 100; }
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

/** 96dpi 기준 px → mm, 0.1mm 반올림 (get_page_geometry 의 압축 좌표용) */
function pxToMm1(px: number): number {
  return Math.round((px * 25.4) / 96 * 10) / 10;
}

/** mm 사각형 {x,y,width,height} (regionMm) */
interface MmRect { x: number; y: number; width: number; height: number }

/** 선택적 regionMm 파싱 — 폭/높이는 양수여야 한다 */
function optRegionMm(args: Record<string, unknown>): MmRect | undefined {
  const v = args['regionMm'];
  if (v === undefined || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const nums = ['x', 'y', 'width', 'height'].map((k) => r?.[k]);
  if (typeof v !== 'object' || nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new AgentToolError('INVALID_ARGS', 'regionMm must be {x, y, width, height} in mm');
  }
  const [x, y, width, height] = nums as number[];
  if (width <= 0 || height <= 0) {
    throw new AgentToolError('INVALID_ARGS', 'regionMm width and height must be positive');
  }
  return { x, y, width, height };
}

const GEOMETRY_PARTS = ['lines', 'runs', 'objects'] as const;
type GeometryPart = typeof GEOMETRY_PARTS[number];

/** getPageControlLayout 항목에서 그대로 옮기는 주소 필드 */
const GEOMETRY_OBJECT_ADDRESS_KEYS = [
  'secIdx', 'paraIdx', 'controlIdx', 'parentParaIdx', 'cellIdx', 'cellParaIdx',
  'innerControlIdx', 'outerTableControlIdx', 'cellPath',
] as const;

/**
 * renderEquationPreview 의 JSON 계약 파서.
 * 신규 wasm 은 `{"svg",widthPx,heightPx,baselinePx,warnings}` JSON 문자열을,
 * 구버전(스테일 pkg)은 SVG 문자열을 그대로 반환한다 → 파싱 실패/svg 키 부재 시
 * raw 를 SVG 로 간주한다 (메트릭 없음, warnings 빈 배열).
 */
/** PNG 바이트 → base64 (브라우저/Node 공용) */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

interface PngCapture { data: string; widthPx: number; heightPx: number }

/** base64 → 바이트. 잘못된 문자열은 INVALID_ARGS */
function decodeBase64(b64: string, key: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    throw new AgentToolError('INVALID_ARGS', `${key} is not valid base64`);
  }
  if (bytes.length === 0) throw new AgentToolError('INVALID_ARGS', 'image data is empty');
  return bytes;
}

// 문서에 그대로 넣을 수 있는 그림 형식 (그 밖의 원본은 캔버스로 PNG 재인코딩)
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
};
// 원본 5MB ≈ base64 6.9M 문자 (설계 리스크 레지스터). 잘라낼 원본은 참조 상한 20MB 까지 받는다.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MAX_B64 = 7_200_000;
const CROP_SOURCE_MAX_B64 = 28_000_000;

/** 선택적 cropPx {x,y,width,height} (원본 px) */
function optCropPx(args: Record<string, unknown>): PixelBox | undefined {
  const v = args['cropPx'];
  if (v === undefined || v === null) return undefined;
  const r = asRecord(v);
  const nums = (['x', 'y', 'width', 'height'] as const).map((k) => r[k]);
  if (nums.some((n) => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) {
    throw new AgentToolError('INVALID_ARGS', 'cropPx must be {x, y, width, height} in whole source pixels');
  }
  const [x, y, width, height] = nums as number[];
  if (width < 1 || height < 1) throw new AgentToolError('INVALID_ARGS', 'cropPx width and height must be positive');
  return { x, y, width, height };
}

const FLOAT_REL_TO: Record<string, { horz: string; vert: string }> = {
  paper: { horz: 'Paper', vert: 'Paper' },
  page: { horz: 'Page', vert: 'Page' },
  paragraph: { horz: 'Para', vert: 'Para' },
};
const FLOAT_WRAP: Record<string, string> = {
  square: 'Square', topAndBottom: 'TopAndBottom', behindText: 'BehindText', inFrontOfText: 'InFrontOfText',
};

/** insert_image 떠 있는 배치 → setPictureProperties 속성 (inline 이면 undefined) */
function imageFloatingProps(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const mode = args['positionMode'] ?? 'inline';
  if (mode !== 'inline' && mode !== 'floating') {
    throw new AgentToolError('INVALID_ARGS', 'positionMode must be "inline" or "floating"');
  }
  if (mode === 'inline') {
    const stray = ['xMm', 'yMm', 'relativeTo', 'wrap'].filter((k) => args[k] !== undefined && args[k] !== null);
    if (stray.length > 0) throw new AgentToolError('INVALID_ARGS', `${stray.join('/')} need positionMode "floating"`);
    return undefined;
  }
  const offset = (key: 'xMm' | 'yMm'): number => {
    const v = args[key] ?? 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 500) {
      throw new AgentToolError('INVALID_ARGS', `${key} must be a number within ±500`);
    }
    return mmToHu(v);
  };
  const rel = FLOAT_REL_TO[String(args['relativeTo'] ?? 'paragraph')];
  if (!rel) throw new AgentToolError('INVALID_ARGS', 'relativeTo must be paper|page|paragraph');
  const wrap = FLOAT_WRAP[String(args['wrap'] ?? 'square')];
  if (!wrap) throw new AgentToolError('INVALID_ARGS', 'wrap must be square|topAndBottom|behindText|inFrontOfText');
  return {
    treatAsChar: false,
    horzRelTo: rel.horz, vertRelTo: rel.vert,
    horzAlign: 'Left', vertAlign: 'Top',
    horzOffset: offset('xMm'), vertOffset: offset('yMm'),
    textWrap: wrap,
  };
}

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

/**
 * 0 이상이어야 하는 최상위 주소 인자. 스키마는 크기 한도 때문에 범위를 싣지 않으므로
 * dispatch 입구에서 한 번에 검사한다 — apply_edits/read_batch 항목도 같은 길을 지난다.
 */
const NON_NEGATIVE_ADDRESS_KEYS = [
  'sectionIdx', 'paraIdx', 'charOffset', 'controlIdx', 'cellIdx',
  'startParaIdx', 'endParaIdx', 'startCharOffset', 'endCharOffset', 'startOffset', 'endOffset',
  'pageIndex', 'styleId',
] as const;

function assertNonNegativeAddress(args: Record<string, unknown>): void {
  for (const key of NON_NEGATIVE_ADDRESS_KEYS) {
    const v = args[key];
    if (typeof v === 'number' && v < 0) {
      throw new AgentToolError('INVALID_ARGS', `${key} must be >= 0 (got ${v})`);
    }
  }
}

type WriteRenderMode = 'crop' | 'page';

/** 스테이징 쓰기의 render 인자 — 쓰기를 적용하기 전에 검사한다. */
function optRenderMode(rawArgs: unknown): WriteRenderMode | undefined {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return undefined;
  const v = (rawArgs as Record<string, unknown>)['render'];
  if (v === undefined || v === null) return undefined;
  if (v === 'crop' || v === 'page') return v;
  throw new AgentToolError('INVALID_ARGS', `render must be "crop" or "page" (got ${JSON.stringify(v)})`);
}

/** 쓰기 직전 상태 — after 보고가 새 op 과 쪽 변화를 가려내는 기준. */
interface WriteBaseline {
  opIds: Set<string>;
  pageCount: number;
  paraCounts: number[];
  pageStarts: PageStart[] | null;
}

/** 쓰기 결과 보고에 모은 대상 — 문단 텍스트, 표, 구역별 편집 범위, 경고. */
interface WriteTargets {
  paras: Array<{ sectionIdx: number; paraIdx: number; cell?: CellAddr; from: number }>;
  tables: Array<{ sectionIdx: number; paraIdx: number; controlIdx: number }>;
  bodyRanges: Map<number, { lo: number; hi: number }>;
  wholeSections: Set<number>;
  warnings: string[];
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
  if (v === undefined || v === null) {
    if (args['cellPath'] !== undefined) {
      throw new AgentToolError('INVALID_ARGS', 'cellPath requires the outer table cell address in cell');
    }
    return undefined;
  }
  const rec = asRecord(v);
  for (const key of ['paraIdx', 'controlIdx', 'cellIdx'] as const) {
    const val = rec[key];
    if (typeof val !== 'number' || !Number.isSafeInteger(val)) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `cell.${key} must be an integer (got ${JSON.stringify(val)}). cell.paraIdx/controlIdx are the TABLE's body paragraph address — assemble cell from the get_structure table line ("table s0 p5 c0" → paraIdx 5, controlIdx 0) plus the target cell's [cellIdx], or copy a find_text match's cell object verbatim.`,
      );
    }
  }
  const cell: CellAddr = {
    paraIdx: rec['paraIdx'] as number,
    controlIdx: rec['controlIdx'] as number,
    cellIdx: rec['cellIdx'] as number,
  };
  if (args['cellPath'] !== undefined) {
    const rawPath = args['cellPath'];
    if (!Array.isArray(rawPath) || rawPath.length < 1 || rawPath.length > 8) {
      throw new AgentToolError('INVALID_ARGS', 'cellPath must contain 1..8 table cell entries');
    }
    cell.path = rawPath.map((entry, index) => {
      const segment = asRecord(entry);
      for (const key of ['controlIndex', 'cellIndex', 'cellParaIndex'] as const) {
        if (typeof segment[key] !== 'number' || !Number.isSafeInteger(segment[key]) || (segment[key] as number) < 0) {
          throw new AgentToolError('INVALID_ARGS', `cellPath[${index}].${key} must be a nonnegative integer`);
        }
      }
      return {
        controlIndex: segment['controlIndex'] as number,
        cellIndex: segment['cellIndex'] as number,
        cellParaIndex: segment['cellParaIndex'] as number,
      };
    });
    if (cell.path[0].controlIndex !== cell.controlIdx || cell.path[0].cellIndex !== cell.cellIdx) {
      throw new AgentToolError('INVALID_ARGS', 'cellPath starts at a different table cell than cell');
    }
  }
  return cell;
}

/** 셀 안 개체의 엔진 경로 — 한 칸 셀 주소도 경로로 바꾸고 마지막 cellParaIndex 는 개체 문단이다 */
function objectCellPath(cell: CellAddr, paraIdx: number): CellPathEntry[] {
  const path = cell.path?.map((entry) => ({ ...entry }))
    ?? [{ controlIndex: cell.controlIdx, cellIndex: cell.cellIdx, cellParaIndex: 0 }];
  path[path.length - 1].cellParaIndex = paraIdx;
  return path;
}

function cellPathAt(cell: CellAddr, paraIdx: number): string {
  const path = cell.path?.map((entry) => ({ ...entry }));
  if (!path?.length) throw new AgentToolError('INVALID_ARGS', 'cellPath is required for nested cell access');
  path[path.length - 1].cellParaIndex = paraIdx;
  return JSON.stringify(path);
}

/**
 * 범위형 쓰기(delete_range/replace_range)의 리베이스 대상 본문 문단 범위.
 * 셀 편집은 표 컨트롤 문단 하나를 대상으로 삼는다 — 같은 표는 통째로 한 소유자.
 */
function rangeRebaseAnchor(args: Record<string, unknown>): [number, number, number] {
  const cell = optCell(args);
  const sectionIdx = reqInt(args, 'sectionIdx');
  if (cell) return [sectionIdx, cell.paraIdx, cell.paraIdx];
  return [sectionIdx, reqInt(args, 'startParaIdx'), reqInt(args, 'endParaIdx')];
}

/** get_document_info fontQuery — 문자열 하나 또는 1..16개 배열 */
function parseFontQuery(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list) || list.length > 16
    || list.some((q) => typeof q !== 'string' || q.trim().length === 0 || q.length > 64)) {
    throw new AgentToolError('INVALID_ARGS', 'fontQuery must be a font name or an array of 1..16 non-empty names');
  }
  return list as string[];
}

const FONT_MATCH_LIMIT = 8;

/**
 * 질의한 폰트 이름별 등록 폰트 후보. 대소문자·공백을 무시한 정확 일치, 접두어 일치("맑은" →
 * "맑은 고딕"), 부분 일치("바탕" → "한컴바탕") 순으로 질의당 8개까지 돌려준다.
 */
function matchRegisteredFonts(queries: string[], registered: string[]): Record<string, string[]> {
  const norm = (name: string): string => name.toLowerCase().replace(/\s+/g, '');
  const out: Record<string, string[]> = {};
  for (const query of queries) {
    const q = norm(query);
    const exact = registered.filter((name) => norm(name) === q);
    const prefix = registered.filter((name) => norm(name) !== q && norm(name).startsWith(q));
    const inner = registered.filter((name) => !norm(name).startsWith(q) && norm(name).includes(q));
    out[query] = [...exact, ...prefix, ...inner].slice(0, FONT_MATCH_LIMIT);
  }
  return out;
}

/**
 * 서식 읽기 결과에서 기본값을 걷어 낸다 — false, 0, '', null/undefined, 그리고 그렇게 비워진
 * 중첩 객체. keep 에 든 최상위 키는 값이 0/false 여도 남긴다 (undefined 는 항상 뺀다).
 */
function omitDefaults(value: Record<string, unknown>, keep: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    if (keep.includes(key)) {
      out[key] = raw;
      continue;
    }
    if (raw === null || raw === false || raw === 0 || raw === '') continue;
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const inner = omitDefaults(raw as Record<string, unknown>);
      if (Object.keys(inner).length > 0) out[key] = inner;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

function isColor(value: unknown, hex: string): boolean {
  return typeof value !== 'string' || value.length === 0 || value.toLowerCase() === hex;
}

// ─── 타이포그래피 패스스루 매핑 상수 ─────────────────────────
// 내부 슬롯/코드 계약은 rust 측과 고정이다:
// - 글자 ratios/spacings 는 언어 슬롯 7개 (한/영/한자/일/외/기/사)
// - 탭 type 은 0 left / 1 right / 2 center / 3 decimal
// - 문단 테두리 width 는 BORDER_WIDTHS(src/model/style.rs) 인덱스
/** 스칼라 → 7슬롯 복제, 7-배열 → 슬롯별 값 (per-script override). */
function langSlotArray(key: string, v: unknown, min: number, max: number): number[] {
  const check = (n: unknown): number => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
      throw new AgentToolError('INVALID_ARGS', `${key} must be a number in ${min}..${max}`);
    }
    return Math.round(n);
  };
  if (Array.isArray(v)) {
    if (v.length !== 7) {
      throw new AgentToolError('INVALID_ARGS', `${key} array must have exactly 7 script slots`);
    }
    return v.map(check);
  }
  return new Array<number>(7).fill(check(v));
}

/** 읽기 측: 전 슬롯 동일 → 스칼라, 슬롯별 상이 → 배열 그대로. */
function slotReadout(arr: number[] | undefined): number | number[] | undefined {
  if (!arr || arr.length === 0) return undefined;
  return arr.every((v) => v === arr[0]) ? arr[0] : arr.slice();
}

const LINE_SPACING_TYPE_IN: Record<string, string> = {
  percent: 'Percent', fixed: 'Fixed', atLeast: 'Minimum', spaceOnly: 'SpaceOnly',
};
const LINE_SPACING_TYPE_OUT: Record<string, string> = {
  Percent: 'percent', Fixed: 'fixed', Minimum: 'atLeast', SpaceOnly: 'spaceOnly',
};
const TAB_TYPE_IN: Record<string, number> = { left: 0, right: 1, center: 2, decimal: 3 };
const TAB_TYPE_OUT = ['left', 'right', 'center', 'decimal'];

/** rust BORDER_WIDTHS — 문단 테두리 굵기 인덱스 ↔ mm */
const BORDER_WIDTH_MM = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
function borderWidthIndex(mm: number): number {
  let best = 0;
  for (let i = 1; i < BORDER_WIDTH_MM.length; i++) {
    if (Math.abs(BORDER_WIDTH_MM[i] - mm) < Math.abs(BORDER_WIDTH_MM[best] - mm)) best = i;
  }
  return best;
}
function borderWidthMm(index: number): number {
  return BORDER_WIDTH_MM[Math.min(Math.max(index, 0), BORDER_WIDTH_MM.length - 1)];
}

interface ParaBorderSpec { type: number; width: number; color: string }

/** 읽기 측 테두리: width 인덱스 → widthMm. type 0 (없음) 도 그대로 돌려준다. */
function borderSpecOut(b: ParaBorderSpec | undefined): { type: number; widthMm: number; color: string } | undefined {
  if (b === undefined) return undefined;
  return { type: b.type, widthMm: borderWidthMm(b.width), color: b.color };
}

export class AgentToolExecutor {
  private deps: AgentToolExecutorDeps;
  private templateWasm: WasmBridge | null = null;
  private templateBytes: Uint8Array | null = null;
  private templateKey: string | null = null;
  private templateInspectionKey: string | null = null;
  private documentInspectionRevision: number | null = null;
  // 병렬 서브에이전트 리베이스용 편집 저널 — 정밀 기록된 핵심 텍스트 쓰기만 담고,
  // 기록되지 않은 revision bump 는 자동으로 '불명'(리베이스 불가) 취급된다.
  private journal = new EditJournal();
  // apply_edits 안쪽의 개별 쓰기가 쌓는 저널 엔트리 — runAtomicBatch 가 bump 를
  // 한 번으로 묶으므로 항목별 기록을 여기 모았다가 배치이 끝난 revision 에 전부
  // 귀속시킨다 (안 모으면 배치이 델타/리베이스 커버리지 구멍으로 보인다).
  private journalBatch: EditJournalEntry[] | null = null;
  // verify_changes 증분 커서 — `${agent}:${changeSetId}` 별로 이번 턴에 이미 보고한 op id.
  private verifiedOpIds = new Map<string, Set<string>>();

  constructor(deps: AgentToolExecutorDeps) {
    this.deps = deps;
  }

  beginTurn(): void {
    this.verifiedOpIds.clear();
  }

  endTurn(): void {
    this.verifiedOpIds.clear();
  }

  async execute(
    tool: string,
    args: unknown,
    agent: AgentName = 'claude',
    capability?: ToolCapabilityContext,
  ): Promise<unknown> {
    try {
      assertToolRequestActive(capability);
      assertToolCapability(tool, capability);
      if (isDocumentWriteTool(tool) && this.deps.isReadOnly?.()) {
        throw new AgentToolError(
          'READ_ONLY_TEMPLATE_PREVIEW',
          'This published template preview is read-only and cannot accept document-write tools.',
        );
      }
      if (isDocumentWriteTool(tool)
        && !tool.startsWith('template_')
        && this.deps.pending.hasTemplateMutation()) {
        throw new AgentToolError(
          'TEMPLATE_PENDING_CONFLICT',
          'Review the pending template transfer before making other document edits.',
        );
      }
      // 스테이징 쓰기는 결과에 after 보고(와 요청 시 변경 영역 PNG)를 붙인다 —
      // render 인자는 쓰기를 적용하기 전에 검사하고, 쓰기 직전 상태를 떠 둔다.
      const staged = isDocumentWriteTool(tool)
        && tool !== 'publish_cloud_document'
        && !ENGINE_WRITE_TOOLS.has(tool);
      const render = staged ? optRenderMode(args) : undefined;
      const baseline = staged ? this.captureWriteBaseline() : null;
      // await 필수 — 비동기 툴(insert_chart)의 rejection 도 여기서 에러 코드로 매핑된다
      const result = await this.dispatch(tool, args, agent, capability);
      assertToolRequestActive(capability);
      return baseline ? await this.attachWriteReport(result, baseline, render) : result;
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
    assertNonNegativeAddress(args);
    switch (tool) {
      case 'get_structure': return this.getStructure(args);
      case 'get_text_range': return this.getTextRange(args);
      case 'get_selection': return this.getSelection();
      case 'get_fields': return this.getFields();
      case 'get_document_info': return this.getDocumentInfo(args);
      case 'materialize_document_snapshot': return this.materializeDocumentSnapshot();
      case 'publish_cloud_document': {
        this.requireDocLoaded();
        if (!this.deps.canPublishCloudDocument?.()) {
          throw new AgentToolError('CLOUD_RUNTIME_REQUIRED', 'Document publication is available only inside a Cloud conversation.');
        }
        if (capability?.permissionProfile === 'safe') {
          throw new AgentToolError('SAFE_MODE_PUBLISH', 'Cloud publication requires the unrestricted permission profile.');
        }
        return { revision: this.revision, requested: true, publishAfterSuccessfulTurn: true };
      }
      case 'find_text': return this.findText(args);
      case 'render_page': return this.renderPage(args);
      case 'get_page_geometry': return this.getPageGeometry(args);
      case 'get_para_format': return this.getParaFormat(args);
      case 'get_char_format': return this.getCharFormat(args);
      case 'get_table_properties': return this.getTableProperties(args);
      case 'get_table_layout': return this.getTableLayout(args);
      case 'get_engine_edit_capabilities': return this.getEngineEditCapabilities(args);
      case 'list_numberings': return this.listNumberings();
      case 'verify_changes': return this.verifyChanges(args, agent);
      case 'template_get_structure': return this.templateGetStructure(args, capability);
      case 'template_get_text_range': return this.templateRead('get_text_range', args, capability);
      case 'template_get_para_format': return this.templateRead('get_para_format', args, capability);
      case 'template_get_char_format': return this.templateRead('get_char_format', args, capability);
      case 'template_list_styles': return this.templateRead('list_styles', args, capability);
      case 'template_get_page_layout': return this.templateGetPageLayout(args, capability);
      case 'template_render_page': return this.templateRead('render_page', args, capability);
      case 'template_apply_section_layout': return this.templateApplySectionLayout(args, agent, capability);
      case 'template_apply_paragraph_format': return this.templateApplyParagraphFormat(args, agent, capability);
      case 'template_insert_block': return this.templateInsertBlock(args, agent, capability);
      case 'apply_edits': return this.applyEdits(args, agent);
      case 'read_batch': return this.readBatch(args, agent, capability);
      case 'insert_text': return this.insertText(args, agent);
      case 'delete_range': return this.deleteRange(args, agent);
      case 'replace_range': return this.replaceRange(args, agent);
      case 'apply_char_format': return this.applyCharFormat(args, agent);
      case 'apply_list': return this.applyList(args, agent);
      case 'set_field_value': return this.setFieldValue(args, agent);
      case 'create_table': return this.createTable(args, agent);
      case 'delete_table': return this.deleteTable(args, agent);
      case 'edit_table': return this.editTable(args, agent);
      // 표 속성·셀 속성·영역 테두리는 도구 정의 크기 때문에 별도 도구로 나뉘었다. 실행은 edit_table 과 같은 경로다.
      case 'set_table_props':
      case 'set_cell_props':
      case 'set_zone_borders': return this.editTable({ ...args, op: tool }, agent);
      case 'apply_para_format': return this.applyParaFormat(args, agent);
      case 'list_styles': return this.listStyles();
      case 'apply_style': return this.applyStyle(args, agent);
      case 'insert_image': return this.insertImage(args, agent, capability);
      case 'read_reference_image': return this.readReferenceImage(args);
      case 'insert_equation': return this.insertEquation(args, agent);
      case 'edit_object': return this.editObject(args, agent);
      case 'insert_shape': return this.insertShape(args, agent);
      case 'preview_equation': return this.previewEquation(args);
      case 'set_page_layout': return this.setPageLayout(args, agent);
      case 'edit_header_footer': return this.editHeaderFooter(args, agent);
      case 'insert_page_break': return this.insertPageBreak(args, agent);
      case 'insert_chart': return this.insertChart(args, agent, capability);
      case 'replace_all': return this.replaceAll(args, agent);
      case 'get_outline': return this.getOutline(args);
      case 'list_footnotes': return this.listFootnotes();
      case 'insert_footnote': return this.insertFootnote(args, agent);
      case 'edit_footnote': return this.editFootnote(args, agent);
      case 'list_bookmarks': return this.listBookmarks();
      case 'set_bookmark': return this.setBookmark(args, agent);
      case 'apply_engine_edits': return this.applyEngineEdits(args, agent);
      case 'prepare_engine_edit_session': return this.prepareEngineEditSession(args);
      default:
        throw new AgentToolError('UNKNOWN_TOOL', `Unknown tool: ${tool}`);
    }
  }

  private get revision(): number {
    return this.deps.revision.revision;
  }

  /**
   * 기본(쿼리 없음)은 kind 별 메서드 이름만 돌려준다. query 나 detail:true 면 시그니처와
   * argumentGuide 를 싣고, typeDefinitions 는 돌려주는 capability 가 참조하는 타입만 담는다.
   */
  private getEngineEditCapabilities(args: Record<string, unknown>) {
    this.requireDocLoaded();
    const query = args['query'];
    if (query !== undefined && typeof query !== 'string') {
      throw new AgentToolError('INVALID_ARGS', 'query must be a string');
    }
    const detail = args['detail'] === true || (typeof query === 'string' && query.trim().length > 0);
    if (!detail) {
      return {
        revision: this.revision,
        capabilityCount: getEngineEditCapabilityCount(),
        methods: getEngineEditMethodNamesByKind(),
        note: 'names only; pass query (method or signature text) or detail:true for signatures and argument types',
      };
    }
    const capabilities = getEngineEditCapabilities(query ?? '');
    const usesBinary = capabilities.some((capability) => capability.signature.includes('Uint8Array'));
    return {
      revision: this.revision,
      capabilityCount: getEngineEditCapabilityCount(),
      capabilities,
      typeDefinitions: getReferencedTypeDefinitions(capabilities),
      ...(usesBinary ? { binaryArgument: { $base64: 'base64-encoded bytes' } } : {}),
    };
  }

  /**
   * 엔진 배치는 하나의 스테이징 op 으로 들어간다 — 호출 시점에 적용되고(미리보기 = 승인
   * 결과), 같은 턴의 semantic 쓰기와 섞여 한 change set 으로 검토·확정·거절된다.
   */
  private applyEngineEdits(args: Record<string, unknown>, agent: AgentName) {
    this.requireDocLoaded();
    this.requireRevision(args);
    const rawOperations = args['operations'];
    if (!Array.isArray(rawOperations)) {
      throw new AgentToolError('INVALID_ARGS', 'operations must be an array');
    }
    const operations: EngineEditOperation[] = rawOperations.map((raw, index) => {
      const operation = asRecord(raw);
      const method = operation['method'];
      const methodArgs = operation['args'];
      if (typeof method !== 'string' || !Array.isArray(methodArgs)) {
        throw new AgentToolError('INVALID_ARGS', `operations[${index}] requires method and args[]`);
      }
      return { method, args: methodArgs };
    });
    validateEngineEdits(operations);
    const previousRevision = this.revision;
    const staged = this.deps.pending.addEngineBatch(
      agent, operations.map((operation) => operation.method),
      () => runEngineEdits(this.deps.wasm, operations),
    );
    return {
      previousRevision,
      revision: this.revision,
      changeSetId: staged.changeSetId,
      applied: operations.length,
      results: staged.result,
      ...(staged.touched.length > 0 ? { changedParagraphs: staged.touched } : {}),
    };
  }

  private prepareEngineEditSession(args: Record<string, unknown>) {
    this.requireDocLoaded();
    this.requireRevision(args);
    const method = args['method'];
    const methodArgs = args['args'];
    if (typeof method !== 'string' || !Array.isArray(methodArgs)) {
      throw new AgentToolError('INVALID_ARGS', 'method and args[] are required');
    }
    const result = applyEngineEditSession(this.deps.wasm, { method, args: methodArgs });
    return { revision: this.revision, method, result, status: 'session prepared' };
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
          `Retry directly with expectedRevision=${current} ONLY if you know what changed the document AND it cannot have shifted this call's coordinates ` +
          '(e.g. your own preceding edit was at a later position, or you already recomputed offsets from its response). ' +
          'Otherwise — including any chance the user edited — re-read the affected range with get_text_range and retry with fresh coordinates.',
      );
    }
  }

  /**
   * 핵심 텍스트 쓰기용 revision 검사 — expectedRevision 이 뒤처져 있어도 그 사이
   * 편집이 전부 저널에 있고 대상 문단 범위와 서로소면 좌표 이동량(shift)을 돌려준다.
   * 병렬 서브에이전트가 서로 다른 문단 범위를 편집할 때 재조회 왕복을 없애는 경로.
   * 셀 편집은 표가 놓인 본문 문단 하나를 대상 범위로 삼는다.
   */
  private requireRevisionRebasable(
    args: Record<string, unknown>,
    sectionIdx: number,
    paraStart: number,
    paraEnd: number,
  ): number {
    const expected = args['expectedRevision'];
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) {
      throw new AgentToolError('INVALID_ARGS', 'expectedRevision (integer) is required for write tools');
    }
    const current = this.revision;
    if (expected === current) return 0;
    if (expected < current) {
      // apply_edits 안에서는 앞 항목이 문단 수를 바꿨을 수 있다 — 항목 좌표와 옛 읽기 좌표가
      // 그만큼 어긋나므로, 그 폭 안의 형제 편집은 앞/뒤 판정이 모호해 충돌로 본다.
      const slack = this.journalBatch?.reduce((sum, entry) => sum + Math.abs(entry.paraDelta), 0) ?? 0;
      const rebase = this.journal.rebase(expected, current, sectionIdx, paraStart - slack, paraEnd + slack);
      if (rebase.ok) return rebase.shift;
      if (rebase.reason === 'overlap') {
        throw new AgentToolError(
          'REVISION_MISMATCH',
          `Document is now at revision ${current}; you expected ${expected}, and a concurrent edit touched your target paragraphs. ` +
            'Re-read with get_structure or get_text_range and retry with fresh coordinates.',
        );
      }
    }
    throw new AgentToolError(
      'REVISION_MISMATCH',
      `Document is now at revision ${current}; you expected ${expected}. ` +
        `Retry directly with expectedRevision=${current} ONLY if you know what changed the document AND it cannot have shifted this call's coordinates. ` +
        'Otherwise re-read with get_structure or get_text_range and retry with fresh coordinates.',
    );
  }

  /** 방금 수행한 쓰기를 편집 저널에 정밀 기록한다 — (revBefore, 현재 revision] 전체 귀속. apply_edits 안이면 버퍼에 쌓아 배치 끝 revision 에 일괄 귀속한다. */
  private recordJournal(revBefore: number, sectionIdx: number, paraStart: number, paraEnd: number, paraDelta: number): void {
    if (this.journalBatch) {
      this.journalBatch.push({ sectionIdx, paraStart, paraEnd, paraDelta });
      return;
    }
    this.journal.record(revBefore, this.revision, { sectionIdx, paraStart, paraEnd, paraDelta });
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
      const cellParaCount = cell.path
        ? wasm.getCellParagraphCountByPath(sectionIdx, cell.paraIdx, cellPathAt(cell, paraIdx))
        : wasm.getCellParagraphCount(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx);
      if (paraIdx < 0 || paraIdx >= cellParaCount) {
        throw new AgentToolError(
          'INVALID_ARGS',
          `paraIdx ${paraIdx} out of range for cell ${cell.cellIdx} (0..${cellParaCount - 1})`,
        );
      }
      const len = cell.path
        ? wasm.getCellParagraphLengthByPath(sectionIdx, cell.paraIdx, cellPathAt(cell, paraIdx))
        : wasm.getCellParagraphLength(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx);
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
      // 글상자는 한 칸짜리 셀처럼 경로(cellIndex 0)로만 짚는다 (insert_shape textBox 주소)
      if (cell.path && cell.cellIdx === 0 && this.isTextBoxPath(sectionIdx, cell)) return;
      throw new AgentToolError(
        'INVALID_ARGS',
        `No table control at section ${sectionIdx}, paragraph ${cell.paraIdx}, controlIdx ${cell.controlIdx} — use get_structure to list tables`,
      );
    }
    if (cell.cellIdx < 0 || cell.cellIdx >= cellCount) {
      throw new AgentToolError('INVALID_ARGS', `cell.cellIdx ${cell.cellIdx} out of range (0..${cellCount - 1})`);
    }
    if (cell.path) {
      try {
        wasm.getCellParagraphCountByPath(sectionIdx, cell.paraIdx, JSON.stringify(cell.path));
      } catch {
        throw new AgentToolError('INVALID_ARGS', 'cellPath does not resolve to a table cell');
      }
    }
  }

  private isTextBoxPath(sectionIdx: number, cell: CellAddr): boolean {
    try {
      this.deps.wasm.getCellParagraphCountByPath(sectionIdx, cell.paraIdx, JSON.stringify(cell.path));
      return true;
    } catch {
      return false;
    }
  }

  /** paraShift: 편집 저널 리베이스가 돌려준 문단 이동량 — 검증 전에 좌표에 반영한다. */
  private validateRange(args: Record<string, unknown>, paraShift = 0): DocRange {
    const cell = optCell(args);
    if (cell) cell.paraIdx += paraShift;
    const bodyShift = cell ? 0 : paraShift;
    const range: DocRange = {
      sectionIdx: reqInt(args, 'sectionIdx'),
      startParaIdx: reqInt(args, 'startParaIdx') + bodyShift,
      startCharOffset: reqInt(args, 'startCharOffset'),
      endParaIdx: reqInt(args, 'endParaIdx') + bodyShift,
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

  /**
   * get_structure — 기본은 한 줄씩의 compact 텍스트(범례 한 줄 + 문단/표 줄), format:'json' 은
   * 예전 JSON 모양을 그대로 돌려준다. revisionLabel 은 머리 줄에 쓰인다 (템플릿은 템플릿 revision).
   */
  private getStructure(args: Record<string, unknown>, revisionLabel?: string): unknown {
    this.requireDocLoaded();
    const format = args['format'] ?? 'text';
    if (format !== 'text' && format !== 'json') {
      throw new AgentToolError('INVALID_ARGS', `format must be 'text' or 'json' (got ${JSON.stringify(format)})`);
    }
    // sinceRevision 델타는 라이브 문서 저널에만 의미가 있다 — 템플릿 읽기는
    // revisionLabel 경로로 들어오므로 여기서 걸러진다.
    if (args['sinceRevision'] !== undefined && args['sinceRevision'] !== null && revisionLabel === undefined) {
      return this.getStructureDelta(args, format as 'text' | 'json');
    }
    const data = this.collectStructure(args);
    // 템플릿 매핑 게이트의 "문서를 봤다" 표시는 전체 읽기만 세운다 — range/sinceRevision
    // 부분 읽기로는 구조 전체를 검토했다고 볼 수 없다.
    if (!data.range) this.documentInspectionRevision = this.revision;
    if (format === 'json') {
      const sectionsOut = data.sections.map((s) => {
        const tables = data.tablesBySection.get(s.sectionIdx);
        return tables && tables.length > 0
          ? { ...s, tables: tables.map(({ textCut: _cut, ...table }) => table) }
          : s;
      });
      return {
        revision: this.revision,
        sectionCount: data.sectionCount,
        pageCount: data.pageCount,
        truncated: data.truncated,
        ...(data.range ? { range: data.range } : {}),
        sections: sectionsOut,
      };
    }
    const text = this.renderCompactStructure(data, revisionLabel ?? `revision ${this.revision}`);
    return {
      revision: this.revision,
      pageCount: data.pageCount,
      truncated: data.truncated,
      mcpContent: [{ type: 'text', text }],
    };
  }

  /** get_structure 의 문단·표 수집 — 본문 문단이 먼저 예산(maxParagraphs)을 쓰고 표 셀 문단이 나머지를 쓴다. range 가 있으면 그 범위만 읽는다. */
  private collectStructure(args: Record<string, unknown>): StructureData {
    const maxPreviewChars = Math.min(Math.max(optInt(args, 'maxPreviewChars', 120), 0), 500);
    const maxParagraphs = Math.min(Math.max(optInt(args, 'maxParagraphs', 500), 1), 2000);
    const range = this.parseStructureRange(args);
    const { wasm } = this.deps;
    const sectionCount = wasm.getSectionCount();
    const sections: StructureData['sections'] = [];
    const budget = { count: 0 };
    let truncated = false;
    for (let sec = 0; sec < sectionCount; sec++) {
      if (range && sec !== range.sectionIdx) continue;
      const paragraphCount = wasm.getParagraphCount(sec);
      const span = this.collectStructureSpan(
        sec, range ? range.fromPara : 0, range ? range.toPara : paragraphCount - 1,
        maxPreviewChars, maxParagraphs, budget,
      );
      truncated ||= span.truncated;
      sections.push({ sectionIdx: sec, paragraphCount, paragraphs: span.paragraphs });
      if (truncated) break;
    }

    // 표: 섹션별 tables[] 로 셀 주소 + 셀 텍스트를 노출한다 (문단 예산 공유).
    const tablesBySection = new Map<number, StructureTable[]>();
    for (let sec = 0; sec < sectionCount; sec++) {
      if (range && sec !== range.sectionIdx) continue;
      const paraCount = wasm.getParagraphCount(sec);
      const collected = this.collectStructureTables(
        sec, range ? range.fromPara : 0, range ? range.toPara : paraCount - 1,
        maxPreviewChars, maxParagraphs, budget,
      );
      truncated ||= collected.truncated;
      for (const table of collected.tables) {
        const list = tablesBySection.get(sec) ?? [];
        list.push(table);
        tablesBySection.set(sec, list);
      }
    }
    return { sectionCount, pageCount: wasm.pageCount, truncated, range, sections, tablesBySection };
  }

  private collectStructureSpan(
    sectionIdx: number,
    fromPara: number,
    toPara: number,
    maxPreviewChars: number,
    maxParagraphs: number,
    budget: { count: number },
  ): { paragraphs: StructureParagraph[]; truncated: boolean } {
    const { wasm } = this.deps;
    const paragraphs: StructureParagraph[] = [];
    let truncated = false;
    for (let para = fromPara; para <= toPara; para++) {
      if (budget.count >= maxParagraphs) {
        truncated = true;
        break;
      }
      const length = wasm.getParagraphLength(sectionIdx, para);
      const previewLen = Math.min(length, maxPreviewChars);
      const text = previewLen > 0 ? wasm.getTextRange(sectionIdx, para, 0, previewLen) : '';
      paragraphs.push({ paraIdx: para, length, text });
      budget.count++;
    }
    return { paragraphs, truncated };
  }

  /** sectionIdx 의 fromPara..toPara 본문 문단에 앵커된 표를 수집한다 — 셀 주소/텍스트, 문단 예산 공유. */
  private collectStructureTables(
    sectionIdx: number,
    fromPara: number,
    toPara: number,
    maxPreviewChars: number,
    maxParagraphs: number,
    budget: { count: number },
  ): { tables: StructureTable[]; truncated: boolean } {
    const { wasm } = this.deps;
    const tables: StructureTable[] = [];
    let tablesTruncated = false;
    for (const t of this.listTables()) {
      if (t.sectionIdx !== sectionIdx || t.paraIdx < fromPara || t.paraIdx > toPara) continue;
      let table: StructureTable;
      try {
        const dims = wasm.getTableDimensions(t.sectionIdx, t.paraIdx, t.controlIdx);
        table = {
          paraIdx: t.paraIdx, controlIdx: t.controlIdx,
          rowCount: dims.rowCount, colCount: dims.colCount, cellCount: dims.cellCount,
          cells: [],
          textCut: false,
        };
        for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx++) {
          const info = wasm.getCellInfo(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx);
          const cellParaCount = wasm.getCellParagraphCount(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx);
          const cellParas: StructureCellParagraph[] = [];
          for (let cp = 0; cp < cellParaCount; cp++) {
            // 예산 소진 시에도 표/셀 좌표(주소 지정에 필수)는 계속 내보내고
            // 셀 텍스트 수집만 멈춘다 — 표가 통째로 사라지면 셀 주소를 만들 수 없다.
            if (budget.count >= maxParagraphs) {
              tablesTruncated = true;
              table.textCut = true;
              break;
            }
            const length = wasm.getCellParagraphLength(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx, cp);
            const previewLen = Math.min(length, maxPreviewChars);
            const text = previewLen > 0
              ? wasm.getTextInCell(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx, cp, 0, previewLen)
              : '';
            cellParas.push({ cellParaIdx: cp, length, text });
            budget.count++;
          }
          table.cells.push({
            cellIdx, row: info.row, col: info.col, rowSpan: info.rowSpan, colSpan: info.colSpan,
            paragraphs: cellParas,
          });
        }
      } catch {
        continue; // 접근 실패한 표는 건너뛴다 (best-effort)
      }
      tables.push(table);
    }
    return { tables, truncated: tablesTruncated };
  }

  /** get_structure range 인자 파싱 — sectionIdx/fromPara/toPara 경계를 지금 문서에서 검증한다. */
  private parseStructureRange(args: Record<string, unknown>): StructureRange | undefined {
    const raw = args['range'];
    if (raw === undefined || raw === null) return undefined;
    const rec = asRecord(raw);
    const sectionIdx = reqInt(rec, 'sectionIdx');
    const fromPara = reqInt(rec, 'fromPara');
    const toPara = reqInt(rec, 'toPara');
    const { wasm } = this.deps;
    const sectionCount = wasm.getSectionCount();
    if (sectionIdx < 0 || sectionIdx >= sectionCount) {
      throw new AgentToolError('INVALID_ARGS', `range.sectionIdx ${sectionIdx} out of range (0..${sectionCount - 1})`);
    }
    const paraCount = wasm.getParagraphCount(sectionIdx);
    if (fromPara < 0 || fromPara > toPara) {
      throw new AgentToolError('INVALID_ARGS', `range.fromPara ${fromPara} must satisfy 0 <= fromPara <= toPara`);
    }
    if (toPara >= paraCount) {
      throw new AgentToolError('INVALID_ARGS', `range.toPara ${toPara} out of range for section ${sectionIdx} (0..${paraCount - 1})`);
    }
    return { sectionIdx, fromPara, toPara };
  }

  /**
   * get_structure(sinceRevision) — 저널이 (since, 현재] 구간을 덮으면 바뀐 문단만
   * 싣고, 덮지 못하면 FULL_REFRESH_REQUIRED 를 던진다 (저널 보존 한도를 넘은
   * revision 이거나 사용자 편집·비저널 bump 가 끼어 있다).
   */
  private getStructureDelta(args: Record<string, unknown>, format: 'text' | 'json'): unknown {
    const since = args['sinceRevision'];
    if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0) {
      throw new AgentToolError('INVALID_ARGS', `sinceRevision must be a nonnegative integer (got ${JSON.stringify(since)})`);
    }
    const current = this.revision;
    if (since > current) {
      throw new AgentToolError('INVALID_ARGS', `sinceRevision ${since} is ahead of the current revision ${current}`);
    }
    const delta = this.journal.diff(since, current, (sec) => this.deps.wasm.getParagraphCount(sec));
    if (delta === null) {
      throw new AgentToolError(
        'FULL_REFRESH_REQUIRED',
        `No usable edit history between revisions ${since} and ${current} — the journal only retains recent agent writes (older entries age out, and user edits leave gaps). `
          + 'Re-read with get_structure without sinceRevision and keep the returned revision.',
      );
    }
    const range = this.parseStructureRange(args);
    const maxPreviewChars = Math.min(Math.max(optInt(args, 'maxPreviewChars', 120), 0), 500);
    const maxParagraphs = Math.min(Math.max(optInt(args, 'maxParagraphs', 500), 1), 2000);
    const budget = { count: 0 };
    const changes: StructureDeltaChange[] = [];
    let truncated = false;
    outer:
    for (const [sec, sectionDelta] of delta) {
      for (const ch of sectionDelta.changes) {
        let lo = ch.paraStart;
        let hi = ch.paraEnd;
        if (range) {
          if (sec !== range.sectionIdx) continue;
          lo = Math.max(lo, range.fromPara);
          hi = Math.min(hi, range.toPara);
          if (lo > hi) continue;
        }
        const paraCount = this.deps.wasm.getParagraphCount(sec);
        lo = Math.max(0, Math.min(lo, paraCount - 1));
        hi = Math.max(lo, Math.min(hi, paraCount - 1));
        const span = this.collectStructureSpan(sec, lo, hi, maxPreviewChars, maxParagraphs, budget);
        const tables = this.collectStructureTables(sec, lo, hi, maxPreviewChars, maxParagraphs, budget);
        truncated ||= span.truncated || tables.truncated;
        changes.push({
          sectionIdx: sec, paraStart: lo, paraEnd: hi, wasRanges: ch.wasRanges,
          paragraphs: span.paragraphs, tables: tables.tables,
        });
        if (truncated) break outer;
      }
    }
    const indexShifts: Array<{ sectionIdx: number; at: number; delta: number }> = [];
    for (const [sec, sectionDelta] of delta) {
      if (range && sec !== range.sectionIdx) continue;
      for (const s of sectionDelta.indexShifts) indexShifts.push({ sectionIdx: sec, at: s.at, delta: s.delta });
    }
    const pageCount = this.deps.wasm.pageCount;
    if (format === 'json') {
      return {
        revision: current,
        sinceRevision: since,
        pageCount,
        truncated,
        changes: changes.map((c) => ({
          ...c,
          tables: c.tables.map(({ textCut: _cut, ...table }) => table),
        })),
        indexShifts,
      };
    }
    const text = this.renderStructureDelta(since, pageCount, truncated, changes, indexShifts);
    return { revision: current, sinceRevision: since, pageCount, truncated, mcpContent: [{ type: 'text', text }] };
  }

  /**
   * sinceRevision 델타의 compact 텍스트 — 바뀐 현재 문단 구간 + 그 구간이 대체한
   * from-시점 문단 범위(was) + 저장 인덱스의 누적 이동 경계(shift).
   */
  private renderStructureDelta(
    since: number,
    pageCount: number,
    truncated: boolean,
    changes: StructureDeltaChange[],
    indexShifts: Array<{ sectionIdx: number; at: number; delta: number }>,
  ): string {
    const lines: string[] = [];
    lines.push(`revision ${this.revision} · ${pageCount} pages · changes since revision ${since}`
      + (truncated ? ' · TRUNCATED by maxParagraphs (raise it or use find_text)' : ''));
    lines.push(STRUCTURE_LEGEND);
    lines.push(
      `Delta: "s<sec> changed pA[-pB] (was pX[-pY],…)" = paragraphs that changed since revision ${since}, in current indexes; `
      + '"was" = that revision\'s indexes this range replaced ("was new" = all created since) — saved indexes inside a was are stale, re-read them. '
      + '"s<sec> shift pA+ → N" = a saved paraIdx >= A outside every was is now at A+N.',
    );
    const secs = [...new Set([
      ...changes.map((c) => c.sectionIdx),
      ...indexShifts.map((s) => s.sectionIdx),
    ])].sort((a, b) => a - b);
    for (const sec of secs) {
      for (const change of changes) {
        if (change.sectionIdx !== sec) continue;
        const spanText = change.paraStart === change.paraEnd
          ? `p${change.paraStart}`
          : `p${change.paraStart}-p${change.paraEnd}`;
        const wasText = change.wasRanges.length === 0
          ? 'new'
          : change.wasRanges.map(([a, b]) => (a === b ? `p${a}` : `p${a}-p${b}`)).join(', ');
        lines.push(`s${sec} changed ${spanText} (was ${wasText}):`);
        // 델타 구간 안에서는 빈 문단도 접지 않는다 — 에이전트는 바뀐 문단만 다시 본다.
        for (const para of change.paragraphs) {
          lines.push(`s${sec} p${para.paraIdx} (${para.length})${para.length > 0 ? ` ${previewStructureText(para.text, para.length)}` : ''}`);
        }
        for (const table of change.tables) {
          this.emitStructureTable(lines, sec, table);
        }
      }
      for (const shift of indexShifts) {
        if (shift.sectionIdx !== sec) continue;
        lines.push(`s${sec} shift p${shift.at}+ → ${shift.delta >= 0 ? '+' : ''}${shift.delta}`);
      }
    }
    if (changes.length === 0 && indexShifts.length === 0) {
      lines.push('(no recorded paragraph changes)');
    }
    return lines.join('\n');
  }

  /** compact 구조 텍스트의 표 블록 — "  table s0 p5 c0 3x4" 머리 + 행마다 "[cellIdx] text | …". */
  private emitStructureTable(lines: string[], sec: number, table: StructureTable): void {
    lines.push(`  table s${sec} p${table.paraIdx} c${table.controlIdx} ${table.rowCount}x${table.colCount}`
      + (table.textCut ? ' (cell text cut by maxParagraphs)' : ''));
    const rows = new Map<number, string[]>();
    for (const cell of table.cells) {
      const spans = `${cell.rowSpan !== 1 ? ` rs${cell.rowSpan}` : ''}${cell.colSpan !== 1 ? ` cs${cell.colSpan}` : ''}`;
      const body = cell.paragraphs.map((p) => {
        if (p.length === 0) {
          const nested = this.cellParaHostsNestedTable(
            sec, { paraIdx: table.paraIdx, controlIdx: table.controlIdx, cellIdx: cell.cellIdx }, p.cellParaIdx,
          );
          return nested ? '⊞' : '';
        }
        const cut = p.text.length < p.length;
        return cleanStructureText(p.text) + (cut ? `…(${p.length})` : '');
      }).join('⏎');
      const row = rows.get(cell.row) ?? [];
      row.push(`[${cell.cellIdx}${spans}]${body ? ` ${body}` : ''}`);
      rows.set(cell.row, row);
    }
    for (const [row, cells] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`  r${row} ${cells.join(' | ')}`);
    }
  }

  /**
   * compact 구조 텍스트. 문단 한 줄 "s0 p12 (40) text…", 빈 문단 연속은 "s0 p13-p17 empty" 로 접고,
   * 표는 앵커 문단 바로 뒤에 "table s0 p5 c0 3x4" + 행마다 "[cellIdx] text | …" 로 적는다.
   * 스팬은 1 이 아닐 때만 rs/cs 로, 셀 문단 경계는 ⏎, 중첩 표를 품은 셀 문단은 ⊞ 로 표시한다.
   */
  private renderCompactStructure(data: StructureData, revisionLabel: string): string {
    const lines: string[] = [];
    const sectionWord = data.sectionCount === 1 ? 'section' : 'sections';
    lines.push(`${revisionLabel} · ${data.pageCount} pages · ${data.sectionCount} ${sectionWord}`
      + (data.range ? ` · range s${data.range.sectionIdx} p${data.range.fromPara}-p${data.range.toPara}` : '')
      + (data.truncated ? ' · TRUNCATED by maxParagraphs (raise it or use find_text)' : ''));
    lines.push(STRUCTURE_LEGEND);
    for (const section of data.sections) {
      const sec = section.sectionIdx;
      lines.push(`s${sec} · ${section.paragraphCount} paragraphs`);
      const tables = [...(data.tablesBySection.get(sec) ?? [])];
      const emitTable = (table: StructureTable): void => this.emitStructureTable(lines, sec, table);
      let emptyStart = -1;
      let emptyEnd = -1;
      const flushEmpty = (): void => {
        if (emptyStart < 0) return;
        lines.push(emptyStart === emptyEnd
          ? `s${sec} p${emptyStart} empty`
          : `s${sec} p${emptyStart}-p${emptyEnd} empty`);
        emptyStart = -1;
      };
      for (const para of section.paragraphs) {
        const anchored = tables.filter((t) => t.paraIdx === para.paraIdx);
        if (para.length === 0 && anchored.length === 0) {
          if (emptyStart < 0) emptyStart = para.paraIdx;
          emptyEnd = para.paraIdx;
          continue;
        }
        flushEmpty();
        lines.push(`s${sec} p${para.paraIdx} (${para.length})${para.length > 0 ? ` ${previewStructureText(para.text, para.length)}` : ''}`);
        for (const table of anchored) {
          emitTable(table);
          tables.splice(tables.indexOf(table), 1);
        }
      }
      flushEmpty();
      // 예산이 끊긴 뒤의 표는 좌표라도 남긴다 (셀 주소 지정에 필수).
      for (const table of tables) emitTable(table);
    }
    return lines.join('\n');
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
      ? (cell?.path
        ? this.deps.wasm.getTextInCellByPath(sectionIdx, cell.paraIdx, cellPathAt(cell, paraIdx), charOffset, count)
        : cell
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
    // 다른 툴은 텍스트 오프셋을 쓰므로 본문·셀 문단 모두 텍스트 오프셋으로 변환해 반환한다.
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
    const toCellTextOffset = (
      sec: number,
      parentPara: number,
      path: CellPathEntry[],
      logical: number,
    ): number => {
      try {
        return wasm.logicalToTextOffsetInCellByPath(sec, parentPara, JSON.stringify(path), logical);
      } catch {
        return logical; // 구버전 wasm 호환 — 변환 실패 시 원값 유지
      }
    };
    const toIdx = (p: DocumentPosition): SelPoint => {
      if (p.parentParaIndex !== undefined) {
        // 셀 내부: write 툴에 그대로 넘길 수 있는 cell 주소 + 셀 내부 문단 좌표.
        // flat 필드는 최외곽 셀 기준이고 cellPath 마지막 항목은 최내곽 셀 기준이다.
        // 쓰기 도구에는 둘을 함께 전달해야 중첩 셀을 정확히 지정할 수 있다.
        const path = p.cellPath ?? [];
        if (path.length > 1) {
          return {
            sectionIdx: p.sectionIndex,
            cell: {
              paraIdx: p.parentParaIndex,
              controlIdx: p.controlIndex ?? path[0].controlIndex,
              cellIdx: p.cellIndex ?? path[0].cellIndex,
            },
            paraIdx: path[path.length - 1].cellParaIndex,
            charOffset: toCellTextOffset(p.sectionIndex, p.parentParaIndex, path, p.charOffset),
            nested: true,
            cellPath: path,
          };
        }
        const cellParaIdx = path.length > 0
          ? path[path.length - 1].cellParaIndex
          : p.cellParaIndex ?? 0;
        const cellPath = path.length > 0 ? path : [{
          controlIndex: p.controlIndex ?? 0,
          cellIndex: p.cellIndex ?? 0,
          cellParaIndex: cellParaIdx,
        }];
        return {
          sectionIdx: p.sectionIndex,
          cell: {
            paraIdx: p.parentParaIndex,
            controlIdx: p.controlIndex ?? 0,
            cellIdx: p.cellIndex ?? 0,
          },
          paraIdx: cellParaIdx,
          charOffset: toCellTextOffset(p.sectionIndex, p.parentParaIndex, cellPath, p.charOffset),
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
    }
    if (nested) {
      result['nested'] = true;
      const nestedNote = 'cursor is inside a nested table; copy both cell and cellPath from the cursor or selection point into staged text tools. Paragraph indexes and offsets refer to the innermost cell.';
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

  /**
   * 문서 메타데이터 + 폰트 요약. 등록 폰트 전체 목록은 싣지 않고 개수만 준다 —
   * fontQuery 로 물은 이름만 등록 여부(정규화한 접두어 일치)를 돌려준다.
   */
  private async getDocumentInfo(args: Record<string, unknown>): Promise<unknown> {
    this.requireDocLoaded();
    const fontQueries = parseFontQuery(args['fontQuery']);
    const { wasm, documentState } = this.deps;
    // Snapshot every document field before the async desktop-path lookup so a
    // tab/document switch cannot combine one handle's path with another doc's metadata.
    const revision = this.revision;
    const sectionCount = wasm.getSectionCount();
    const pageCount = wasm.pageCount;
    const sourceFormat = wasm.getSourceFormat();
    const digest = wasm.documentDigest;
    const dirty = documentState.isDirty();
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
    let sourcePath: string | null = null;
    try {
      sourcePath = await this.deps.getDocumentSourcePath?.() ?? null;
    } catch { /* 브라우저 문서와 해제된 데스크톱 핸들은 실제 경로가 없다 */ }
    return {
      revision,
      sectionCount,
      pageCount,
      sourceFormat,
      digest,
      dirty,
      sourcePath,
      fontsUsed,
      fallbackFont,
      registeredFontCount: registeredFonts.length,
      ...(fontQueries.length > 0 ? { fontMatches: matchRegisteredFonts(fontQueries, registeredFonts) } : {}),
    };
  }

  private materializeDocumentSnapshot(): unknown {
    this.requireDocLoaded();
    const { wasm, documentState } = this.deps;
    const sourceFormat = wasm.getSourceFormat().toLowerCase();
    if (sourceFormat !== 'hwp' && sourceFormat !== 'hwpx') {
      throw new AgentToolError(
        'SNAPSHOT_FORMAT_UNSUPPORTED',
        `Current document format ${sourceFormat || 'unknown'} cannot be materialized as an HWP/HWPX snapshot. Save it as HWP or HWPX first.`,
      );
    }
    const revision = this.revision;
    const exportFormat = inferExportFormat(
      sourceFormat,
      wasm.fileName ?? '',
      null,
      wasm.fileName ?? '',
    );
    const snapshotFormat = exportFormat === 'hwpx' ? 'hwpx' : 'hwp';
    const bytes = snapshotFormat === 'hwpx' ? wasm.exportHwpx() : wasm.exportHwp();
    if (bytes.byteLength === 0) {
      throw new AgentToolError('SNAPSHOT_EMPTY', 'The current document exported an empty snapshot.');
    }
    if (bytes.byteLength > MAX_DOCUMENT_SNAPSHOT_BYTES) {
      throw new AgentToolError(
        'SNAPSHOT_TOO_LARGE',
        `The current document is ${(bytes.byteLength / 1048576).toFixed(1)} MiB; the snapshot limit is 64 MiB.`,
      );
    }
    return {
      revision,
      sourceFormat: snapshotFormat,
      digest: wasm.documentDigest,
      dirty: documentState.isDirty(),
      byteLength: bytes.byteLength,
      dataBase64: bytesToBase64(bytes),
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
    return {
      revision: this.revision,
      matches: matches.map((match) => match.cell?.path
        ? { ...match, cell: {
          paraIdx: match.cell.paraIdx,
          controlIdx: match.cell.controlIdx,
          cellIdx: match.cell.cellIdx,
        } }
        : match),
      truncated,
    };
  }

  /**
   * 본문+셀 전수 텍스트 검색 — find_text / replace_all / 텍스트 앵커 해석의 공용 스캐너.
   * scope(anchor.within)가 있으면 범위 밖 문단/표는 아예 건너뛴다 — 걸러 낸 뒤의
   * 매치 수가 정확해야 모호함 판별이 맞기 때문이다. 셀 매치의 범위 좌표는 표가 놓인
   * 본문 문단(paraIdx) 기준이다.
   */
  private collectTextMatches(query: string, caseSensitive: boolean, maxResults: number, scope?: AnchorScope): {
    matches: Array<{
      sectionIdx: number; paraIdx: number; charOffset: number; length: number;
      context: string; cell?: CellAddr; cellPath?: CellPathEntry[];
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
      cellPath?: CellPathEntry[];
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
        if (cell) {
          m.cell = cell;
          if (cell.path) m.cellPath = cell.path;
        }
        matches.push(m);
      }
      return true;
    };
    // scope 의 본문 좌표 필터. within.cell 이 있으면 본문 매치는 전부 제외되고
    // 셀 매치에는 표가 놓인 본문 문단 번호를 대입한다.
    const paraInScope = (sec: number, bodyPara: number): boolean =>
      scope?.cell === undefined
      && (scope?.sectionIdx === undefined || sec === scope.sectionIdx)
      && (scope?.paraRange === undefined
        || (bodyPara >= scope.paraRange[0] && bodyPara <= scope.paraRange[1]));
    // 표 스캔 필터 — cell 스코프일 때는 그 표만 살리고 paraRange/sectionIdx 도 같이 건다.
    const tableInScope = (sec: number, tablePara: number, controlIdx: number): boolean =>
      (scope?.sectionIdx === undefined || sec === scope.sectionIdx)
      && (scope?.paraRange === undefined
        || (tablePara >= scope.paraRange[0] && tablePara <= scope.paraRange[1]))
      && (scope?.cell === undefined
        || (tablePara === scope.cell.paraIdx && controlIdx === scope.cell.controlIdx));
    const sectionCount = wasm.getSectionCount();
    outer: for (let sec = 0; sec < sectionCount; sec++) {
      const paraCount = wasm.getParagraphCount(sec);
      for (let para = 0; para < paraCount; para++) {
        if (!paraInScope(sec, para)) continue;
        const len = wasm.getParagraphLength(sec, para);
        if (len === 0) continue;
        const text = wasm.getTextRange(sec, para, 0, len);
        if (!pushMatches(sec, para, text)) break outer;
      }
    }
    // 표 셀 내부 텍스트도 검색한다 — 매치에는 write 툴에 그대로 넘길 수 있는 cell 주소가 실린다.
    if (!truncated) {
      const MAX_NESTED_DEPTH = 4;
      const MAX_NESTED_PROBES = 4096;
      const MAX_NESTED_PARAGRAPHS = 5000;
      let probes = 0;
      let nestedParagraphs = 0;
      const scanNested = (sectionIdx: number, tableParaIdx: number, outer: CellAddr,
        hostPath: CellPathEntry[], depth: number): void => {
        if (truncated || depth >= MAX_NESTED_DEPTH) return;
        for (let controlIndex = 0; controlIndex < NESTED_TABLE_PROBE_CONTROLS; controlIndex++) {
          if (++probes > MAX_NESTED_PROBES) { truncated = true; return; }
          const tablePath = [...hostPath, { controlIndex, cellIndex: 0, cellParaIndex: 0 }];
          let cellCount: number;
          try {
            cellCount = wasm.getTableDimensionsByPath(sectionIdx, tableParaIdx, JSON.stringify(tablePath)).cellCount;
          } catch { continue; }
          for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
            const path = [...hostPath, { controlIndex, cellIndex, cellParaIndex: 0 }];
            let paragraphCount: number;
            try {
              paragraphCount = wasm.getCellParagraphCountByPath(sectionIdx, tableParaIdx, JSON.stringify(path));
            } catch { continue; }
            for (let cp = 0; cp < paragraphCount; cp++) {
              if (++nestedParagraphs > MAX_NESTED_PARAGRAPHS) { truncated = true; return; }
              path[path.length - 1] = { controlIndex, cellIndex, cellParaIndex: cp };
              const pathJson = JSON.stringify(path);
              try {
                const len = wasm.getCellParagraphLengthByPath(sectionIdx, tableParaIdx, pathJson);
                if (len > 0) {
                  const text = wasm.getTextInCellByPath(sectionIdx, tableParaIdx, pathJson, 0, len);
                  if (!pushMatches(sectionIdx, cp, text, { ...outer, path: [...path] })) return;
                }
              } catch { /* 접근 실패한 셀 문단은 건너뛴다 */ }
              scanNested(sectionIdx, tableParaIdx, outer, path, depth + 1);
              if (truncated) return;
            }
          }
        }
      };
      cellScan: for (const t of this.listTables()) {
        if (!tableInScope(t.sectionIdx, t.paraIdx, t.controlIdx)) continue;
        try {
          const dims = wasm.getTableDimensions(t.sectionIdx, t.paraIdx, t.controlIdx);
          for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx++) {
            if (scope?.cell && cellIdx !== scope.cell.cellIdx) continue;
            const cell: CellAddr = { paraIdx: t.paraIdx, controlIdx: t.controlIdx, cellIdx };
            const cellParaCount = wasm.getCellParagraphCount(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx);
            for (let cp = 0; cp < cellParaCount; cp++) {
              const len = wasm.getCellParagraphLength(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx, cp);
              if (len === 0) continue;
              const text = wasm.getTextInCell(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx, cp, 0, len);
              if (!pushMatches(t.sectionIdx, cp, text, cell)) break cellScan;
            }
            for (let cp = 0; cp < cellParaCount; cp++) {
              scanNested(t.sectionIdx, t.paraIdx, cell,
                [{ controlIndex: t.controlIdx, cellIndex: cellIdx, cellParaIndex: cp }], 1);
              if (truncated) break cellScan;
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
      return { revision: this.revision, replacedCount: 0, truncated: false };
    }
    // 컨테이너(본문/셀)별 문서 좌표 내림차순 — 같은 컨테이너 안에서 뒤부터 교체한다
    const cellKey = (c?: CellAddr): string => (c ? `${c.paraIdx}/${c.controlIdx}/${c.cellIdx}` : 'body');
    const ordered = [...matches].sort((a, b) =>
      a.sectionIdx - b.sectionIdx
      || cellKey(a.cell).localeCompare(cellKey(b.cell))
      || b.paraIdx - a.paraIdx
      || b.charOffset - a.charOffset);
    const items: Array<{ range: DocRange; text: string }> = ordered.map((m) => {
      const range: DocRange = {
        sectionIdx: m.sectionIdx,
        startParaIdx: m.paraIdx, startCharOffset: m.charOffset,
        endParaIdx: m.paraIdx, endCharOffset: m.charOffset + m.length,
      };
      if (m.cell) range.cell = m.cell;
      return { range, text: replacement };
    });
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
      truncated,
      ...(truncated ? { note: `only the first ${maxMatches} matches were replaced — call replace_all again with the returned revision to continue.` } : {}),
    };
  }

  // ─── 텍스트 앵커 (anchor) ────────────────────────────────

  /**
   * anchor {text, occurrence?, within?, position?} 를 실행 시점 문서의 실제 매치로
   * 해석한다. 매치는 collectTextMatches 로 찾고 within 스코프는 스캔 자체에 건다.
   * 매치 0건·occurrence 없는 다매치·범위 밖 occurrence 는 후보 주소를 담아
   * INVALID_ARGS 로 실패한다. apply_edits 항목도 이 경로를 타므로 앞 항목이 바꾼
   * 문서 기준으로 해석된다.
   */
  private optAnchor(args: Record<string, unknown>): ResolvedAnchor | null {
    const raw = args['anchor'];
    if (raw === undefined || raw === null) return null;
    const clash = ANCHOR_COORD_KEYS.filter((k) => args[k] !== undefined && args[k] !== null);
    if (clash.length > 0) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `pass either anchor or numeric coordinates, not both (got ${clash.join('/')}) — anchor.within scopes the search instead`,
      );
    }
    const a = asRecord(raw);
    const unknown = Object.keys(a).filter((k) => !['text', 'occurrence', 'within', 'position'].includes(k));
    if (unknown.length > 0) {
      throw new AgentToolError('INVALID_ARGS', `unknown anchor key ${unknown.join('/')} — valid keys: text, occurrence, within, position`);
    }
    const text = reqString(a, 'text');
    if (text.length < 1) {
      throw new AgentToolError('INVALID_ARGS', 'anchor.text must be a non-empty string');
    }
    const rawOccurrence = a['occurrence'];
    const occurrence = rawOccurrence === undefined || rawOccurrence === null
      ? undefined
      : reqInt(a, 'occurrence');
    if (occurrence !== undefined && occurrence < 1) {
      throw new AgentToolError('INVALID_ARGS', 'anchor.occurrence is 1-based (must be >= 1)');
    }
    if (occurrence !== undefined && occurrence > 64) {
      throw new AgentToolError('INVALID_ARGS', 'anchor.occurrence > 64 — narrow the search with anchor.within instead');
    }
    const rawPos = a['position'];
    if (rawPos !== undefined && rawPos !== null && rawPos !== 'before' && rawPos !== 'after' && rawPos !== 'replace') {
      throw new AgentToolError('INVALID_ARGS', `anchor.position must be "before" | "after" | "replace" (got ${JSON.stringify(rawPos)})`);
    }
    const scope = this.rebaseAnchorScope(args, this.anchorScope(a['within']));
    // occurrence 번째까지는 읽어야 하고, 없으면 단일/다매치 판별용 소수만 본다.
    const cap = Math.min(Math.max(occurrence ?? 0, 8), 64);
    const { matches } = this.collectTextMatches(text, false, cap, scope);
    if (matches.length === 0) {
      if (scope) {
        const outside = this.collectTextMatches(text, false, 6).matches;
        if (outside.length > 0) {
          throw new AgentToolError(
            'INVALID_ARGS',
            `anchor ${JSON.stringify(this.truncateForMessage(text))} matched nothing inside anchor.within — ${outside.length} hit(s) exist outside it: ${this.anchorCandidates(outside)}`,
          );
        }
      }
      throw new AgentToolError(
        'INVALID_ARGS',
        `anchor ${JSON.stringify(this.truncateForMessage(text))} matched nothing in the document — check the exact wording with find_text`,
      );
    }
    let picked = matches[0];
    if (occurrence !== undefined) {
      if (occurrence > matches.length) {
        throw new AgentToolError(
          'INVALID_ARGS',
          `anchor occurrence ${occurrence} but only ${matches.length} match(es) for ${JSON.stringify(this.truncateForMessage(text))}: ${this.anchorCandidates(matches)}`,
        );
      }
      picked = matches[occurrence - 1];
    } else if (matches.length > 1) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `anchor ${JSON.stringify(this.truncateForMessage(text))} is ambiguous — ${matches.length} matches; pass occurrence (1-based). Candidates: ${this.anchorCandidates(matches)}`,
      );
    }
    return {
      sectionIdx: picked.sectionIdx,
      paraIdx: picked.paraIdx,
      charOffset: picked.charOffset,
      length: picked.length,
      ...(picked.cell ? { cell: picked.cell } : {}),
      position: rawPos as ResolvedAnchor['position'],
    };
  }

  /** anchor.within {sectionIdx?, paraRange?, cell?} → AnchorScope (빈 객체/모르는 키는 INVALID_ARGS). */
  private anchorScope(raw: unknown): AnchorScope | undefined {
    if (raw === undefined || raw === null) return undefined;
    const w = asRecord(raw);
    const unknown = Object.keys(w).filter((k) => !['sectionIdx', 'paraRange', 'cell'].includes(k));
    if (unknown.length > 0) {
      throw new AgentToolError('INVALID_ARGS', `unknown anchor.within key ${unknown.join('/')} — valid keys: sectionIdx, paraRange, cell`);
    }
    const scope: AnchorScope = {};
    const sectionIdx = w['sectionIdx'];
    if (sectionIdx !== undefined && sectionIdx !== null) {
      if (typeof sectionIdx !== 'number' || !Number.isSafeInteger(sectionIdx) || sectionIdx < 0) {
        throw new AgentToolError('INVALID_ARGS', 'anchor.within.sectionIdx must be a nonnegative integer');
      }
      scope.sectionIdx = sectionIdx;
    }
    const paraRange = w['paraRange'];
    if (paraRange !== undefined && paraRange !== null) {
      if (!Array.isArray(paraRange) || paraRange.length !== 2
        || paraRange.some((n) => typeof n !== 'number' || !Number.isSafeInteger(n) || (n as number) < 0)) {
        throw new AgentToolError('INVALID_ARGS', 'anchor.within.paraRange must be [startParaIdx, endParaIdx] (inclusive, 0-based)');
      }
      if ((paraRange[1] as number) < (paraRange[0] as number)) {
        throw new AgentToolError('INVALID_ARGS', 'anchor.within.paraRange is reversed');
      }
      scope.paraRange = [paraRange[0] as number, paraRange[1] as number];
    }
    const cell = w['cell'];
    if (cell !== undefined && cell !== null) {
      const c = asRecord(cell);
      for (const key of ['paraIdx', 'controlIdx', 'cellIdx'] as const) {
        const v = c[key];
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
          throw new AgentToolError('INVALID_ARGS', `anchor.within.cell.${key} must be a nonnegative integer — paraIdx/controlIdx name the table's body paragraph, cellIdx the cell`);
        }
      }
      scope.cell = { paraIdx: c['paraIdx'] as number, controlIdx: c['controlIdx'] as number, cellIdx: c['cellIdx'] as number };
    }
    if (Object.keys(scope).length === 0) {
      throw new AgentToolError('INVALID_ARGS', 'anchor.within needs at least one of sectionIdx, paraRange, cell');
    }
    return scope;
  }

  /**
   * anchor.within 의 paraRange / cell.paraIdx 는 에이전트가 읽은 revision 의 본문 좌표다.
   * 뒤처진 revision 이 저널로 덮이면 좌표 쓰기처럼 리베이스하고, 그 사이 편집이 범위와
   * 겹치면 엉뚱한 범위에서 찾지 않도록 REVISION_MISMATCH 로 떨어진다. 저널 공백이면 그대로
   * 두고 requireRevisionAnchored 가 거절한다.
   */
  private rebaseAnchorScope(args: Record<string, unknown>, scope: AnchorScope | undefined): AnchorScope | undefined {
    const expected = args['expectedRevision'];
    const current = this.revision;
    if (!scope || (!scope.paraRange && !scope.cell) || typeof expected !== 'number' || expected >= current
      || !this.journal.covers(expected, current)) {
      return scope;
    }
    const sections = scope.sectionIdx !== undefined
      ? [scope.sectionIdx]
      : Array.from({ length: this.deps.wasm.getSectionCount() }, (_, i) => i);
    const slack = this.journalBatch?.reduce((sum, entry) => sum + Math.abs(entry.paraDelta), 0) ?? 0;
    const shiftOf = (start: number, end: number): number => {
      let shift: number | null = null;
      for (const sec of sections) {
        const r = this.journal.rebase(expected, current, sec, start - slack, end + slack);
        if (!r.ok || (shift !== null && shift !== r.shift)) {
          throw new AgentToolError(
            'REVISION_MISMATCH',
            `Document is now at revision ${current}; you expected ${expected}, and a concurrent edit touched the paragraphs in anchor.within. ` +
              'Re-read with get_structure and retry with a fresh within range.',
          );
        }
        shift = r.shift;
      }
      return shift ?? 0;
    };
    const next: AnchorScope = { ...scope };
    if (scope.paraRange) {
      const shift = shiftOf(scope.paraRange[0], scope.paraRange[1]);
      next.paraRange = [scope.paraRange[0] + shift, scope.paraRange[1] + shift];
    }
    if (scope.cell) {
      const shift = shiftOf(scope.cell.paraIdx, scope.cell.paraIdx);
      next.cell = { ...scope.cell, paraIdx: scope.cell.paraIdx + shift };
    }
    return next;
  }

  /** 앵커 오류에 싣는 후보 목록 (최대 5개) — get_structure 줄 표기에 맞춘 주소 + 문맥. */
  private anchorCandidates(matches: Array<{
    sectionIdx: number; paraIdx: number; charOffset: number; context: string; cell?: CellAddr;
  }>): string {
    return matches.slice(0, 5).map((m, i) => {
      const where = m.cell
        ? `s${m.sectionIdx} cell(p${m.cell.paraIdx} c${m.cell.controlIdx} [${m.cell.cellIdx}]) p${m.paraIdx}@${m.charOffset}`
        : `s${m.sectionIdx} p${m.paraIdx}@${m.charOffset}`;
      return `${i + 1}) ${where} "${m.context.replace(/\n/g, '⏎')}"`;
    }).join('; ');
  }

  private truncateForMessage(text: string): string {
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  /** 앵커 해석된 주소를 write 결과에 그대로 싣는다 (anchor 필드). */
  private anchorEcho(m: ResolvedAnchor): Record<string, unknown> {
    const echo: Record<string, unknown> = {
      sectionIdx: m.sectionIdx,
      paraIdx: m.paraIdx,
      charOffset: m.charOffset,
      endCharOffset: m.charOffset + m.length,
    };
    if (m.cell) {
      echo['cell'] = { paraIdx: m.cell.paraIdx, controlIdx: m.cell.controlIdx, cellIdx: m.cell.cellIdx };
      if (m.cell.path) echo['cellPath'] = m.cell.path;
    }
    return echo;
  }

  /** 범위형 도구의 position 검사 — 매치 자체가 범위이므로 'replace' 만 허용한다. */
  private anchorPositionOrReplace(m: ResolvedAnchor, tool: string): void {
    const position = m.position ?? 'replace';
    if (position !== 'replace') {
      throw new AgentToolError(
        'INVALID_ARGS',
        `anchor.position must be "replace" for ${tool} — the match itself is the range (got ${JSON.stringify(m.position)})`,
      );
    }
  }

  /** 앵커 매치를 범위형 쓰기(delete_range/replace_range)의 숫자 인자로 옮긴 args 사본. */
  private anchorRangeArgs(args: Record<string, unknown>, m: ResolvedAnchor): Record<string, unknown> {
    const out: Record<string, unknown> = {
      ...args,
      anchor: undefined, cell: undefined, cellPath: undefined,
      sectionIdx: m.sectionIdx,
      startParaIdx: m.paraIdx, startCharOffset: m.charOffset,
      endParaIdx: m.paraIdx, endCharOffset: m.charOffset + m.length,
    };
    if (m.cell) {
      out['cell'] = { paraIdx: m.cell.paraIdx, controlIdx: m.cell.controlIdx, cellIdx: m.cell.cellIdx };
      if (m.cell.path) out['cellPath'] = m.cell.path;
    }
    return out;
  }

  /**
   * 앵커 쓰기의 revision 검사. 좌표는 실행 시점 매치에서 왔으므로 리베이스할 좌표가
   * 없다 — expected 와 current 사이의 bump 가 전부 저널에 있으면(정밀 쓰기뿐) 그대로
   * 통과시키고, 아니면 "같은 호출 재전송" 안내와 함께 REVISION_MISMATCH 로 떨어진다.
   */
  private requireRevisionAnchored(args: Record<string, unknown>): void {
    const expected = args['expectedRevision'];
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) {
      throw new AgentToolError('INVALID_ARGS', 'expectedRevision (integer) is required for write tools');
    }
    const current = this.revision;
    if (expected === current) return;
    if (expected < current && this.journal.covers(expected, current)) return;
    const within = asRecord(asRecord(args['anchor'])['within'] ?? {});
    const scoped = within['paraRange'] !== undefined || within['cell'] !== undefined;
    throw new AgentToolError(
      'REVISION_MISMATCH',
      scoped
        ? `Document is now at revision ${current}; you expected ${expected}. anchor.within paragraph indexes may have moved — re-read with get_structure, then resend with expectedRevision=${current} and a fresh within range.`
        : `Document is now at revision ${current}; you expected ${expected}. The anchor re-resolves on retry — resend the same call with expectedRevision=${current}; no re-read needed.`,
    );
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
    const obj: ObjectOp = { type: 'insertNote', noteKind: kind, sectionIdx, paraIdx, charOffset, text };
    const r = this.stageObjectOp(agent, obj, sectionIdx, paraIdx);
    const applied = r.obj as Extract<ObjectOp, { type: 'insertNote' }>;
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
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
    const r = this.stageObjectOp(agent, obj, sectionIdx, paraIdx);
    return { revision: this.revision, changeSetId: r.changeSetId };
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
      const r = this.stageObjectOp(agent, obj, sectionIdx, paraIdx);
      return { revision: this.revision, changeSetId: r.changeSetId };
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
      const r = this.stageObjectOp(agent, obj, target.sec, target.para);
      return { revision: this.revision, changeSetId: r.changeSetId };
    }
    const obj: ObjectOp = {
      type: 'bookmark', op: 'delete',
      sectionIdx: target.sec, paraIdx: target.para, ctrlIdx: target.ctrlIdx,
    };
    const r = this.stageObjectOp(agent, obj, target.sec, target.para);
    return { revision: this.revision, changeSetId: r.changeSetId };
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
    const format = args['format'] === undefined || args['format'] === null ? 'png' : reqString(args, 'format');
    if (format !== 'svg' && format !== 'png') {
      throw new AgentToolError('INVALID_ARGS', `format must be "svg" or "png" (got ${JSON.stringify(format)})`);
    }
    const region = optRegionMm(args);
    if (format === 'svg') {
      // savePath 는 허브가 PNG 바이트를 쓰는 경로라 svg 와 함께 쓸 수 없다
      if (region || args['savePath'] !== undefined) {
        throw new AgentToolError('INVALID_ARGS', 'regionMm and savePath need format "png"');
      }
      const svg = wasm.renderPageSvg(pageIndex);
      if (svg.length > MAX_SVG_BYTES) {
        throw new AgentToolError('RESULT_TOO_LARGE', `SVG is ${svg.length} bytes; page too complex to return`);
      }
      return { revision: this.revision, pageIndex, svg };
    }
    const rawScale = args['scale'];
    if (rawScale !== undefined && rawScale !== null && (typeof rawScale !== 'number' || !Number.isFinite(rawScale))) {
      throw new AgentToolError('INVALID_ARGS', 'scale must be a number (clamped to 0.5..3)');
    }
    const scale = Math.min(3, Math.max(0.5, typeof rawScale === 'number' ? rawScale : 1.25));
    // 래스터화는 동기(wasm 렌더) — blob 변환만 비동기다
    let canvas = this.renderPageToCanvasElement(pageIndex, scale);
    let regionOut: { x: number; y: number; width: number; height: number } | undefined;
    if (region) {
      // mm → 캔버스 px (쪽 px × scale). 쪽 밖은 잘라낸다.
      const k = (96 / 25.4) * scale;
      const x0 = Math.max(0, Math.floor(region.x * k));
      const y0 = Math.max(0, Math.floor(region.y * k));
      const x1 = Math.min(canvas.width, Math.ceil((region.x + region.width) * k));
      const y1 = Math.min(canvas.height, Math.ceil((region.y + region.height) * k));
      if (x1 - x0 < 1 || y1 - y0 < 1) {
        throw new AgentToolError('INVALID_ARGS', 'regionMm lies outside the page');
      }
      const crop = this.createRenderCanvas();
      crop.width = x1 - x0;
      crop.height = y1 - y0;
      const ctx = crop.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) throw new AgentToolError('RENDER_UNAVAILABLE', 'Canvas 2D context is unavailable');
      ctx.drawImage(canvas as CanvasImageSource, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
      canvas = crop;
      const mm = (px: number) => Math.round((px / k) * 10) / 10;
      regionOut = { x: mm(x0), y: mm(y0), width: mm(crop.width), height: mm(crop.height) };
    }
    const png = await canvasToPngBase64(canvas);
    return {
      revision: this.revision,
      pageIndex,
      image: { data: png.data, mimeType: 'image/png' },
      widthPx: png.widthPx,
      heightPx: png.heightPx,
      scale,
      ...(regionOut ? { regionMm: regionOut } : {}),
    };
  }

  /**
   * 쪽 측정 — 줄 상자·베이스라인·런 x 범위·개체 상자를 mm 로 돌려준다.
   * 줄/런은 반복 키 없이 배열로 압축하고 lineFields/runFields 로 열 순서를 한 번만 알린다.
   */
  private getPageGeometry(args: Record<string, unknown>): unknown {
    const pageIndex = reqInt(args, 'pageIndex');
    const { wasm } = this.deps;
    const pageCount = wasm.pageCount;
    if (pageCount === 0) {
      throw new AgentToolError('DOC_NOT_LOADED', 'No document is loaded in the studio; ask the user to open one.');
    }
    if (pageIndex < 0 || pageIndex >= pageCount) {
      throw new AgentToolError('INVALID_ARGS', `pageIndex ${pageIndex} out of range (0..${pageCount - 1})`);
    }
    const rawInclude = args['include'];
    let include: Set<GeometryPart>;
    if (rawInclude === undefined || rawInclude === null) {
      include = new Set<GeometryPart>(['lines', 'objects']);
    } else {
      if (!Array.isArray(rawInclude) || rawInclude.some((p) => !GEOMETRY_PARTS.includes(p as GeometryPart))) {
        throw new AgentToolError('INVALID_ARGS', `include must list any of ${GEOMETRY_PARTS.join(', ')}`);
      }
      include = new Set(rawInclude as GeometryPart[]);
      // 런은 lines[] 인덱스를 가리키므로 줄도 함께 싣는다
      if (include.has('runs')) include.add('lines');
    }
    const region = optRegionMm(args);
    const mm = pxToMm1;
    const hits = (x: number, y: number, w: number, h: number): boolean => !region || (
      mm(x) < region.x + region.width && mm(x + w) > region.x
      && mm(y) < region.y + region.height && mm(y + h) > region.y
    );

    const result: Record<string, unknown> = { revision: this.revision, pageIndex };
    try {
      const info = wasm.getPageInfo(pageIndex);
      result['pageMm'] = [mm(info.width), mm(info.height)];
      const top = info.marginTop + info.marginHeader;
      const bottom = info.height - info.marginBottom - info.marginFooter;
      result['bodyMm'] = [mm(info.marginLeft), mm(top), mm(info.width - info.marginLeft - info.marginRight), mm(bottom - top)];
    } catch { /* 쪽 정보 실패 시 생략 */ }
    if (region) result['regionMm'] = region;

    if (include.has('lines')) {
      let raw: LineLayoutItem[];
      try {
        raw = wasm.getPageLineLayout(pageIndex).lines ?? [];
      } catch {
        throw new AgentToolError('RENDER_UNAVAILABLE', 'Line layout is unavailable in this engine build');
      }
      const lines: unknown[] = [];
      const runs: unknown[] = [];
      for (const line of raw) {
        if (!hits(line.x, line.y, line.w, line.h)) continue;
        const path = line.cell?.path ?? [];
        const paraIdx = path.length > 0 ? path[path.length - 1][2] : line.para ?? null;
        const row: unknown[] = [
          mm(line.x), mm(line.y), mm(line.w), mm(line.h), mm(line.bl),
          line.tx0 !== undefined ? mm(line.tx0) : null,
          line.tx1 !== undefined ? mm(line.tx1) : null,
          line.sec ?? null, paraIdx, line.cs ?? null, line.ce ?? null,
        ];
        const extra: Record<string, unknown> = {};
        if (line.cell && path.length > 0) {
          extra['cell'] = { paraIdx: line.cell.pp, controlIdx: path[0][0], cellIdx: path[0][1] };
          if (path.length > 1) {
            extra['cellPath'] = path.map(([controlIndex, cellIndex, cellParaIndex]) => ({ controlIndex, cellIndex, cellParaIndex }));
          }
        }
        if (line.area) extra['area'] = line.area;
        if (Object.keys(extra).length > 0) row.push(extra);
        if (include.has('runs')) {
          for (const [x, w, cs, ce] of line.runs ?? []) runs.push([lines.length, mm(x), mm(x + w), cs, ce]);
        }
        lines.push(row);
      }
      result['lineFields'] = 'x,y,w,h,baseline,textX0,textX1,sectionIdx,paraIdx,charStart,charEnd[,{cell,cellPath,area}]';
      result['lines'] = lines;
      if (include.has('runs')) {
        result['runFields'] = 'line,x0,x1,charStart,charEnd';
        result['runs'] = runs;
      }
    }

    if (include.has('objects')) {
      let controls: ControlLayoutItem[] = [];
      try {
        controls = wasm.getPageControlLayout(pageIndex).controls ?? [];
      } catch { /* 개체 레이아웃 실패 시 빈 목록 */ }
      const objects: unknown[] = [];
      for (const c of controls) {
        if (!hits(c.x, c.y, c.w, c.h)) continue;
        const item = c as unknown as Record<string, unknown>;
        const obj: Record<string, unknown> = { type: c.type, box: [mm(c.x), mm(c.y), mm(c.w), mm(c.h)] };
        for (const key of GEOMETRY_OBJECT_ADDRESS_KEYS) {
          if (item[key] !== undefined) obj[key] = item[key];
        }
        if (c.type === 'table') {
          obj['rows'] = item['rowCount'];
          obj['cols'] = item['colCount'];
        }
        if (c.wrap) obj['wrap'] = c.wrap;
        if (typeof c.zOrder === 'number') obj['z'] = c.zOrder;
        if (c.headerFooter) obj['area'] = c.headerFooter.kind;
        else if (c.noteRef) obj['area'] = 'note';
        if (c.missing) obj['missing'] = true;
        objects.push(obj);
      }
      result['objects'] = objects;
    }
    return result;
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

  /** 문단 속성 읽기 — cell.path 가 있으면 중첩 셀 경로로 내려간다 */
  private paraPropsAt(sectionIdx: number, paraIdx: number, cell?: CellAddr): ParaProperties {
    const { wasm } = this.deps;
    return cell?.path
      ? wasm.getCellParaPropertiesAtByPath(sectionIdx, cell.paraIdx, cellPathAt(cell, paraIdx))
      : cell
        ? wasm.getCellParaPropertiesAt(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx)
        : wasm.getParaPropertiesAt(sectionIdx, paraIdx);
  }

  /**
   * 문단 서식 읽기 — getParaPropertiesAt 은 px(96dpi) 단위라 pt 로 환산해 반환한다
   * (apply_para_format 의 pt 입력과 대칭). headType/lineSpacingType/tab type/koreanBreakUnit
   * 은 공개 enum 소문자로 정규화하고, 탭·테두리 단위는 mm 로 바꾼다.
   */
  private getParaFormat(args: Record<string, unknown>): unknown {
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const cell = optCell(args);
    this.validateAddress(sectionIdx, paraIdx, undefined, cell);
    const props = this.paraPropsAt(sectionIdx, paraIdx, cell);
    const pxToPt = (px: number | undefined): number | undefined =>
      (typeof px === 'number' ? Math.round(px * 72 / 96 * 10) / 10 : undefined);
    const headType = (props.headType ?? 'None').toLowerCase();
    const lsTypeRaw = props.lineSpacingType ?? 'Percent';
    const lineSpacingType = LINE_SPACING_TYPE_OUT[lsTypeRaw] ?? 'percent';
    const tabStops = (props.tabStops ?? []).map((t) => ({
      positionMm: huToMm(t.position / 2), // TabItem.position 은 2x HWPUNIT (style_resolver /2 와 대칭)
      type: TAB_TYPE_OUT[t.type] ?? t.type,
      fill: t.fill,
    }));
    const borderSpacing = props.borderSpacing ?? [0, 0, 0, 0];
    const format = {
      alignment: props.alignment,
      lineSpacingType,
      ...(lsTypeRaw === 'Percent'
        ? { lineSpacingPercent: Math.round(props.lineSpacing ?? 100) }
        : { lineSpacingPt: pxToPt(props.lineSpacing) }),
      spaceBeforePt: pxToPt(props.spacingBefore),
      spaceAfterPt: pxToPt(props.spacingAfter),
      indentPt: pxToPt(props.indent),
      marginLeftPt: pxToPt(props.marginLeft),
      marginRightPt: pxToPt(props.marginRight),
      pageBreakBefore: props.pageBreakBefore === true,
      headType,
      numberingId: props.numberingId ?? 0,
      paraLevel: props.paraLevel ?? 0,
      paraShapeId: props.paraShapeId,
      tabStops,
      borders: {
        left: borderSpecOut(props.borderLeft),
        right: borderSpecOut(props.borderRight),
        top: borderSpecOut(props.borderTop),
        bottom: borderSpecOut(props.borderBottom),
      },
      borderSpacingMm: {
        left: huToMm(borderSpacing[0] ?? 0), right: huToMm(borderSpacing[1] ?? 0),
        top: huToMm(borderSpacing[2] ?? 0), bottom: huToMm(borderSpacing[3] ?? 0),
      },
      koreanBreakUnit: props.koreanBreakUnit === 1 ? 'char' : 'word',
    };
    if (args['full'] === true) return { revision: this.revision, ...format };
    // 기본값(0pt 간격·여백, false, 탭/테두리 없음, 어절 줄나눔)은 생략한다.
    // 목록 문단이면 numberingId/paraLevel 은 0 이어도 의미가 있으므로 남긴다.
    const isList = headType !== 'none';
    const nonDefaultBorders = Object.fromEntries(
      Object.entries(format.borders).filter(([, b]) => b !== undefined && b.type !== 0),
    );
    return {
      revision: this.revision,
      ...omitDefaults({
        ...format,
        headType: isList ? headType : undefined,
        lineSpacingType: lineSpacingType === 'percent' ? undefined : lineSpacingType,
        tabStops: tabStops.length ? tabStops : undefined,
        borders: Object.keys(nonDefaultBorders).length ? nonDefaultBorders : undefined,
        koreanBreakUnit: format.koreanBreakUnit === 'word' ? undefined : 'char',
      }, isList ? ['numberingId', 'paraLevel'] : []),
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
    const props = cell?.path
      ? wasm.getCellCharPropertiesAtByPath(sectionIdx, cell.paraIdx, cellPathAt(cell, paraIdx), charOffset)
      : cell
        ? wasm.getCellCharPropertiesAt(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx, charOffset)
        : wasm.getCharPropertiesAt(sectionIdx, paraIdx, charOffset);
    const format = {
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
      // 장평/자간 — 슬롯 전부 동일하면 스칼라, 다르면 7-배열
      widthPercent: slotReadout(props.ratios) ?? 100,
      letterSpacingPercent: slotReadout(props.spacings) ?? 0,
    };
    if (args['full'] === true) return { revision: this.revision, ...format };
    // 기본값(false 속성, 검정 글자, 흰/없음 음영, 장평 100/자간 0)은 생략한다.
    return {
      revision: this.revision,
      ...omitDefaults({
        ...format,
        textColor: isColor(format.textColor, '#000000') ? undefined : format.textColor,
        shadeColor: isColor(format.shadeColor, '#ffffff') ? undefined : format.shadeColor,
        widthPercent: format.widthPercent === 100 ? undefined : format.widthPercent,
      }),
    };
  }

  /** 표/셀 속성을 MCP 친화적인 enum/mm 단위로 조회한다. */
  private getTableProperties(args: Record<string, unknown>): unknown {
    this.requireDocLoaded();
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const controlIdx = reqInt(args, 'controlIdx');
    const { wasm } = this.deps;
    let dims: { rowCount: number; colCount: number; cellCount: number };
    let props: Record<string, unknown>;
    try {
      dims = wasm.getTableDimensions(sectionIdx, paraIdx, controlIdx);
      props = wasm.getTableProperties(sectionIdx, paraIdx, controlIdx) as unknown as Record<string, unknown>;
    } catch {
      throw new AgentToolError('INVALID_ARGS', `No table control at section ${sectionIdx}, paragraph ${paraIdx}, controlIdx ${controlIdx} — use get_structure to list tables`);
    }
    const mm = (key: string): number | undefined =>
      typeof props[key] === 'number' ? huToMm(props[key] as number) : undefined;
    const lower = (key: string): string | undefined =>
      typeof props[key] === 'string' ? (props[key] as string).replace(/^Para$/, 'Paragraph').replace(/^[A-Z]/, (c) => c.toLowerCase()) : undefined;
    const pageBreak = props['pageBreak'] === 1 ? 'cell' : props['pageBreak'] === 2 ? 'row' : 'none';
    const table = {
      repeatHeader: props['repeatHeader'] === true,
      pageBreak,
      cellSpacingMm: mm('cellSpacing'),
      cellPaddingMm: { left: mm('paddingLeft'), right: mm('paddingRight'), top: mm('paddingTop'), bottom: mm('paddingBottom') },
      sizeMm: { width: mm('tableWidth'), height: mm('tableHeight') },
      outerMarginMm: { left: mm('outerLeft'), right: mm('outerRight'), top: mm('outerTop'), bottom: mm('outerBottom') },
      positionMode: props['treatAsChar'] === true ? 'inline' : 'floating',
      textWrap: lower('textWrap'),
      horizontal: { relativeTo: lower('horzRelTo'), align: lower('horzAlign'), offsetMm: mm('horzOffset') },
      vertical: { relativeTo: lower('vertRelTo'), align: lower('vertAlign'), offsetMm: mm('vertOffset') },
      restrictInPage: props['restrictInPage'] === true,
      allowOverlap: props['allowOverlap'] === true,
      keepWithAnchor: props['keepWithAnchor'] === true,
      caption: {
        enabled: props['hasCaption'] === true,
        direction: ['left', 'right', 'top', 'bottom'][Number(props['captionDirection'] ?? 3)] ?? 'bottom',
        verticalAlign: ['top', 'center', 'bottom'][Number(props['captionVertAlign'] ?? 0)] ?? 'top',
        widthMm: mm('captionWidth'),
        spacingMm: mm('captionSpacing'),
      },
      fillColor: props['fillColor'],
    };

    const full = args['full'] === true;
    // 기본 응답은 기본값(false, 0mm, 'none', 꺼진 캡션)을 생략한다. 글자처럼 취급하는(inline) 표는
    // 개체 배치 필드가 의미 없으므로 함께 생략한다.
    const inline = table.positionMode === 'inline';
    const tableOut = full ? table : omitDefaults({
      ...table,
      pageBreak: table.pageBreak === 'none' ? undefined : table.pageBreak,
      textWrap: inline ? undefined : table.textWrap,
      horizontal: inline ? undefined : table.horizontal,
      vertical: inline ? undefined : table.vertical,
      caption: table.caption.enabled ? table.caption : undefined,
    }, ['sizeMm']);
    const rawCellIdx = args['cellIdx'];
    if (rawCellIdx === undefined || rawCellIdx === null) {
      return { revision: this.revision, sectionIdx, paraIdx, controlIdx, dimensions: dims, table: tableOut };
    }
    const cellIdx = reqInt(args, 'cellIdx');
    if (cellIdx < 0 || cellIdx >= dims.cellCount) {
      throw new AgentToolError('INVALID_ARGS', `cellIdx ${cellIdx} out of range (0..${dims.cellCount - 1})`);
    }
    const cellProps = wasm.getCellProperties(sectionIdx, paraIdx, controlIdx, cellIdx) as unknown as Record<string, unknown>;
    const cellMm = (key: string): number | undefined =>
      typeof cellProps[key] === 'number' ? huToMm(cellProps[key] as number) : undefined;
    const cell = {
      cellIdx,
      sizeMm: { width: cellMm('width'), height: cellMm('height') },
      paddingMm: { left: cellMm('paddingLeft'), right: cellMm('paddingRight'), top: cellMm('paddingTop'), bottom: cellMm('paddingBottom') },
      applyInnerMargin: cellProps['applyInnerMargin'] === true,
      verticalAlign: ['top', 'center', 'bottom'][Number(cellProps['verticalAlign'] ?? 0)] ?? 'top',
      textDirection: Number(cellProps['textDirection'] ?? 0) === 1 ? 'vertical' : 'horizontal',
      isHeader: cellProps['isHeader'] === true,
      protected: cellProps['cellProtect'] === true,
      editableInForm: cellProps['editableInForm'] === true,
      fieldName: typeof cellProps['fieldName'] === 'string' ? cellProps['fieldName'] : '',
      fillColor: cellProps['fillColor'],
    };
    const cellOut = full ? cell : omitDefaults({
      ...cell,
      textDirection: cell.textDirection === 'horizontal' ? undefined : cell.textDirection,
    }, ['cellIdx', 'sizeMm']);
    return { revision: this.revision, sectionIdx, paraIdx, controlIdx, dimensions: dims, table: tableOut, cell: cellOut };
  }

  /**
   * 표가 실제로 어느 쪽 어디에 놓였는지 조회한다 — 쪽별 조각(fragment)과 본문 영역 넘침 여부.
   * bbox 는 96dpi px 페이지 좌표라 mm 로 환산해 돌려준다.
   */
  private getTableLayout(args: Record<string, unknown>): unknown {
    this.requireDocLoaded();
    const sectionIdx = optInt(args, 'sectionIdx', 0);
    const paraIdx = reqInt(args, 'paraIdx');
    const controlIdx = reqInt(args, 'controlIdx');
    return { revision: this.revision, ...this.measureTableLayout(sectionIdx, paraIdx, controlIdx) };
  }

  /** 표의 쪽별 조각과 본문 넘침 판정 — get_table_layout 과 쓰기 결과 보고가 함께 쓴다. */
  private measureTableLayout(sectionIdx: number, paraIdx: number, controlIdx: number) {
    const { wasm } = this.deps;
    let dims: { rowCount: number; colCount: number; cellCount: number };
    let props: Record<string, unknown>;
    let first: { pageIndex: number; x: number; y: number; width: number; height: number };
    try {
      dims = wasm.getTableDimensions(sectionIdx, paraIdx, controlIdx);
      props = wasm.getTableProperties(sectionIdx, paraIdx, controlIdx) as unknown as Record<string, unknown>;
      first = wasm.getTableBBox(sectionIdx, paraIdx, controlIdx);
    } catch {
      throw new AgentToolError('INVALID_ARGS', `No table control at section ${sectionIdx}, paragraph ${paraIdx}, controlIdx ${controlIdx} — use get_structure to list tables`);
    }

    // 첫 조각의 쪽부터 앞으로 훑어 조각이 끊기는 지점까지 모은다 (셀/행 단위 나눔 대응).
    const raw: { pageIndex: number; x: number; y: number; width: number; height: number }[] = [first];
    for (let page = first.pageIndex + 1; page < wasm.pageCount; page++) {
      let box: { pageIndex: number; x: number; y: number; width: number; height: number };
      try {
        box = wasm.getTableBBoxAtPage(sectionIdx, paraIdx, controlIdx, page);
      } catch {
        break;
      }
      raw.push(box);
    }

    // 본문 영역: 쪽 좌표(px) 기준 상하좌우 여백(머리말/꼬리말 포함)을 뺀 사각형.
    const TOLERANCE_PX = 0.5;
    let overflowsBody = false;
    let overflowsBodyWidth = false;
    let bodyAreaMm: { xMm: number; yMm: number; widthMm: number; heightMm: number } | undefined;
    const fragments = raw.map((box) => {
      let body: { left: number; top: number; right: number; bottom: number } | null = null;
      try {
        const info = wasm.getPageInfo(box.pageIndex);
        body = {
          left: info.marginLeft,
          top: info.marginTop + info.marginHeader,
          right: info.width - info.marginRight,
          bottom: info.height - info.marginBottom - info.marginFooter,
        };
      } catch { /* 쪽 정보 실패 시 넘침 판정을 생략한다 */ }
      const belowBody = body !== null && box.y + box.height > body.bottom + TOLERANCE_PX;
      const pastRight = body !== null && box.x + box.width > body.right + TOLERANCE_PX;
      if (belowBody) overflowsBody = true;
      if (pastRight) overflowsBodyWidth = true;
      if (body && !bodyAreaMm) {
        bodyAreaMm = {
          xMm: pxToMm(body.left),
          yMm: pxToMm(body.top),
          widthMm: pxToMm(body.right - body.left),
          heightMm: pxToMm(body.bottom - body.top),
        };
      }
      return {
        pageIndex: box.pageIndex,
        xMm: pxToMm(box.x),
        yMm: pxToMm(box.y),
        widthMm: pxToMm(box.width),
        heightMm: pxToMm(box.height),
        overflowsBodyBottom: belowBody,
        overflowsBodyRight: pastRight,
      };
    });

    const pageBreak = Number(props['pageBreak'] ?? 0);
    return {
      sectionIdx,
      paraIdx,
      controlIdx,
      dimensions: dims,
      fragments,
      ...(bodyAreaMm ? { bodyAreaMm } : {}),
      overflowsBody,
      overflowsBodyWidth,
      pageBreak,
      pageBreakName: pageBreak === 1 ? 'cell' : pageBreak === 2 ? 'row' : 'none',
      repeatHeader: props['repeatHeader'] === true,
    };
  }

  /** 편집 직후 영향 문단 다이제스트 (~200자, best-effort — 실패 시 빈 문자열) */
  private readPostEditDigest(sectionIdx: number, paraIdx: number, charOffset: number, cell?: CellAddr): string {
    try {
      const { wasm } = this.deps;
      return cell?.path
        ? wasm.getTextInCellByPath(sectionIdx, cell.paraIdx, cellPathAt(cell, paraIdx), charOffset, 200)
        : cell
          ? wasm.getTextInCell(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx, charOffset, 200)
          : wasm.getTextRange(sectionIdx, paraIdx, charOffset, 200);
    } catch {
      return '';
    }
  }

  /** 문단이 표시되는 페이지 인덱스 (best-effort — 실패 시 null) */
  private pageOfParagraph(sectionIdx: number, paraIdx: number, cell?: CellAddr): number | null {
    return this.caretRect(sectionIdx, paraIdx, 0, cell)?.pageIndex ?? null;
  }

  /** 한 지점의 캐럿 rect (쪽 px, 폭 0) — best-effort, 실패 시 null */
  private caretRect(sectionIdx: number, paraIdx: number, charOffset: number, cell?: CellAddr): SelectionRect | null {
    const { wasm } = this.deps;
    try {
      const rect = cell?.path
        ? wasm.getCursorRectByPath(sectionIdx, cell.paraIdx, cellPathAt(cell, paraIdx), charOffset)
        : cell
          ? wasm.getCursorRectInCell(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx, charOffset)
          : wasm.getCursorRect(sectionIdx, paraIdx, charOffset);
      if (!rect || typeof rect.pageIndex !== 'number') return null;
      return { pageIndex: rect.pageIndex, x: rect.x, y: rect.y, width: 0, height: rect.height };
    } catch {
      return null;
    }
  }

  /**
   * verify_changes — 에이전트 셀프체크. 이번 턴에 앞서 verify_changes 를 부른 뒤로 새로 쌓인
   * op 만 요약·다이제스트·경고로 돌려주고 전체는 counts 로만 알린다 (full:true 면 change set 전체).
   * 모든 op 이 이미 적용돼 있으므로 includeImage 는 첫 영향 페이지를 지금 그대로 PNG 렌더한다
   * (= 승인 후 모습).
   */
  private async verifyChanges(args: Record<string, unknown>, agent: AgentName): Promise<unknown> {
    this.requireDocLoaded();
    const rawId = args['changeSetId'];
    if (rawId !== undefined && rawId !== null && (typeof rawId !== 'string' || rawId.length < 1)) {
      throw new AgentToolError('INVALID_ARGS', 'changeSetId must be a non-empty string');
    }
    const changeSetId = typeof rawId === 'string' ? rawId : undefined;
    const includeImage = args['includeImage'] === true;
    const full = args['full'] === true;
    const { pending } = this.deps;
    const summary = pending.describeChangeSet(changeSetId);
    const sets = pending.getChangeSets();
    const set = changeSetId !== undefined
      ? sets.find((s) => s.id === changeSetId)
      : sets[sets.length - 1];

    const allOps = set?.ops ?? [];
    const seenKey = `${agent}:${set?.id ?? ''}`;
    const seen = this.verifiedOpIds.get(seenKey) ?? new Set<string>();
    const reportOps = full ? allOps : allOps.filter((op) => !seen.has(op.id));
    const reportIds = new Set(reportOps.map((op) => op.id));
    if (set) this.verifiedOpIds.set(seenKey, new Set(allOps.map((op) => op.id)));

    const warnings: string[] = [];
    if (!set) {
      warnings.push('no pending change set found — edits may have been committed/rolled back already, or none were made');
    }
    const report = this.collectVerifyTargets(reportOps);
    warnings.push(...report.warnings);

    // 편집 후 텍스트 다이제스트 (문단당 앞 200자 — 지금 문서에 보이는 그대로)
    const postEditText = report.affected.map((a) => ({
      sectionIdx: a.sectionIdx,
      paraIdx: a.paraIdx,
      ...(a.cell ? { cell: a.cell } : {}),
      text: this.readPostEditDigest(a.sectionIdx, a.paraIdx, 0, a.cell),
    }));
    const affectedPages = this.pagesOfTargets(report);
    const summaryOps = summary.ops.filter((op) => reportIds.has(op.id));

    const result: Record<string, unknown> = {
      changeSetId: summary.changeSetId,
      status: summary.status,
      agent: summary.agent,
      counts: {
        total: summary.ops.length,
      },
      ops: summaryOps,
      postEditText,
      affectedPages,
      warnings,
      ...(!full && set && summaryOps.length < summary.ops.length
        ? { note: summaryOps.length === 0
          ? 'no new ops since your last verify_changes this turn; full:true lists the whole change set'
          : 'only ops since your last verify_changes this turn; full:true lists the whole change set' }
        : {}),
      ...(report.templateTransfers.length > 0 ? {
        templateTransfers: report.templateTransfers,
        skippedFeatures: [...new Set(report.templateTransfers.flatMap((transfer) => transfer.skippedFeatures))],
        templateRevision: report.templateTransfers.at(-1)?.templateRevision,
      } : {}),
    };

    if (includeImage) {
      // 새 op 이 없으면 change set 전체의 첫 영향 페이지를 그린다.
      const page = affectedPages[0]
        ?? (reportOps.length < allOps.length ? this.pagesOfTargets(this.collectVerifyTargets(allOps))[0] : undefined)
        ?? 0;
      try {
        // 모든 op 이 이미 문서에 적용돼 있으므로 지금 상태를 그대로 그리면 승인 후 모습이다.
        const canvas = this.renderPageToCanvasElement(page, 2);
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
    return { revision: this.revision, ...result };
  }

  /** verify_changes 대상 op 들의 영향 문단(dedupe, 상한 8)·상태 경고·템플릿 전송 요약 */
  private collectVerifyTargets(ops: readonly PendingOp[]): {
    affected: Array<{ sectionIdx: number; paraIdx: number; cell?: CellAddr }>;
    warnings: string[];
    templateTransfers: Array<{ label: string; templateRevision: number; affectedSections: number[]; skippedFeatures: string[] }>;
  } {
    const affected: Array<{ sectionIdx: number; paraIdx: number; cell?: CellAddr }> = [];
    const warnings: string[] = [];
    const seenPara = new Set<string>();
    const templateTransfers: Array<{ label: string; templateRevision: number; affectedSections: number[]; skippedFeatures: string[] }> = [];
    const pushPara = (sectionIdx: number, paraIdx: number, cell?: CellAddr): void => {
      const key = cell
        ? `${sectionIdx}:c${cell.paraIdx}/${cell.controlIdx}/${cell.cellIdx}:${paraIdx}`
        : `${sectionIdx}:b:${paraIdx}`;
      if (seenPara.has(key) || affected.length >= 8) return;
      seenPara.add(key);
      affected.push(cell ? { sectionIdx, paraIdx, cell } : { sectionIdx, paraIdx });
    };
    for (const op of ops) {
      if (op.kind === 'template') {
        warnings.push(...op.report.warnings);
        templateTransfers.push({
          label: op.label,
          templateRevision: op.templateRevision,
          affectedSections: op.report.affectedSections,
          skippedFeatures: op.report.skippedFeatures,
        });
      }
      if (op.kind === 'insert' || op.kind === 'replace' || op.kind === 'format') {
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
          case 'insertNote':
          case 'insertShape':
            if (o.anchor) pushPara(o.sectionIdx, o.anchor.paraIdx);
            break;
          case 'editObject':
          case 'deleteObject':
            pushPara(o.sectionIdx, o.cell ? o.cell.paraIdx : o.paraIdx);
            break;
          case 'insertEquation':
            if (o.cell) pushPara(o.sectionIdx, o.paraIdx, o.cell);
            else if (o.anchor) pushPara(o.sectionIdx, o.anchor.paraIdx);
            break;
          case 'tableStructure':
          case 'deleteTable':
          case 'setCellProps':
          case 'setTableProps':
          case 'setColumnWidths':
          case 'fitToPage':
          case 'setZoneProps':
          case 'applyFormula':
          case 'setCaption':
            pushPara(o.sectionIdx, o.tableParaIdx);
            break;
          case 'engineBatch':
            for (const span of o.touched) {
              for (let p = span.paraStart; p <= Math.min(span.paraEnd, span.paraStart + 2); p++) pushPara(span.sectionIdx, p);
            }
            break;
          default:
            break; // pageLayout/headerFooter — 문단 좌표 없음
        }
      }
    }
    return { affected, warnings, templateTransfers };
  }

  private pagesOfTargets(report: ReturnType<AgentToolExecutor['collectVerifyTargets']>): number[] {
    const pages: number[] = [];
    for (const a of report.affected) {
      const page = this.pageOfParagraph(a.sectionIdx, a.paraIdx, a.cell);
      if (page !== null && !pages.includes(page)) pages.push(page);
    }
    for (const sectionIdx of new Set(report.templateTransfers.flatMap((transfer) => transfer.affectedSections))) {
      const page = this.pageOfParagraph(sectionIdx, 0);
      if (page !== null && !pages.includes(page)) pages.push(page);
    }
    return pages;
  }

  // ─── 쓰기 결과 보고 (after / render) ─────────────────────────

  /** 쓰기 직전 상태를 뜬다 — 실패한 항목은 비워 두고 보고에서 그 판정만 건너뛴다. */
  private captureWriteBaseline(): WriteBaseline {
    const { wasm, pending } = this.deps;
    const opIds = new Set<string>();
    try {
      for (const set of pending.getChangeSets()) for (const op of set.ops) opIds.add(op.id);
    } catch { /* 테스트 더블 — 보고가 새 op 을 못 찾을 뿐이다 */ }
    let pageCount = 0;
    try { pageCount = wasm.pageCount; } catch { /* 문서 없음 — dispatch 가 오류를 낸다 */ }
    return {
      opIds,
      pageCount,
      paraCounts: this.paragraphCounts(),
      pageStarts: this.capturePageStarts(pageCount),
    };
  }

  private paragraphCounts(): number[] {
    const { wasm } = this.deps;
    try {
      const counts: number[] = [];
      const sections = wasm.getSectionCount();
      for (let s = 0; s < sections; s++) counts.push(wasm.getParagraphCount(s));
      return counts;
    } catch {
      return [];
    }
  }

  /** 쪽마다 첫 본문 문단 — 쪽을 옮겨 간 문단 판정의 기준. 긴 문서나 옛 WASM 은 null. */
  private capturePageStarts(pageCount: number): PageStart[] | null {
    if (pageCount < 1 || pageCount > PAGE_START_SCAN_LIMIT) return null;
    const { wasm } = this.deps;
    if (typeof wasm.getPositionOfPage !== 'function') return null;
    try {
      const starts: PageStart[] = [];
      for (let p = 0; p < pageCount; p++) {
        const pos = wasm.getPositionOfPage(p);
        if (!pos.ok || typeof pos.sec !== 'number' || typeof pos.para !== 'number') return null;
        starts.push({ sec: pos.sec, para: pos.para });
      }
      return starts;
    } catch {
      return null;
    }
  }

  /**
   * 스테이징 쓰기 결과에 after 보고를 붙인다 — 보고는 best-effort 라 실패해도 이미 적용된
   * 쓰기 결과는 그대로 돌려준다. render 는 PNG 를 image 로 싣고, 그릴 수 없으면 renderError.
   */
  private async attachWriteReport(
    result: unknown,
    baseline: WriteBaseline,
    render: WriteRenderMode | undefined,
  ): Promise<unknown> {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    let report: ReturnType<AgentToolExecutor['buildWriteReport']>;
    try {
      report = this.buildWriteReport(baseline);
    } catch {
      return result;
    }
    const out: Record<string, unknown> = { ...(result as Record<string, unknown>), after: report.after };
    // after.paragraphs 가 같은 문단을 더 넓게 보여 준다 — 중복 다이제스트는 뺀다.
    if (report.after.paragraphs.length > 0) delete out['postEdit'];
    if (render) {
      try {
        Object.assign(out, await this.renderWriteImage(report.rects, report.pages, render));
      } catch (e) {
        if (e instanceof AgentToolError && e.code !== 'RENDER_UNAVAILABLE') throw e;
        const msg = e instanceof Error ? e.message : String(e);
        out['renderError'] = `render unavailable here — image skipped (${msg.slice(0, 120)})`;
      }
    }
    return out;
  }

  /**
   * 이번 호출이 만든 op 들로 after 보고를 만든다: 바뀐 문단 텍스트(8개 × 200자), 쪽 수
   * 전후, 바뀐 쪽, 레이아웃 경고(표 본문 넘침, 편집 밖 문단의 쪽 이동, 템플릿 경고).
   */
  private buildWriteReport(baseline: WriteBaseline) {
    const { wasm, pending } = this.deps;
    const newOps = pending.getChangeSets().flatMap((set) => set.ops).filter((op) => !baseline.opIds.has(op.id));
    const targets = this.collectWriteTargets(newOps);

    const paragraphs = targets.paras.map((p) => ({
      sectionIdx: p.sectionIdx,
      paraIdx: p.paraIdx,
      ...(p.cell ? { cell: p.cell } : {}),
      ...(p.from > 0 ? { from: p.from } : {}),
      text: this.readPostEditDigest(p.sectionIdx, p.paraIdx, p.from, p.cell),
    }));

    // 변경 영역 rect — 오버레이와 같은 해석, 못 구하면 op 의 캐럿 줄로 대신한다.
    const rects: SelectionRect[] = [];
    for (const op of newOps) {
      let opRects: SelectionRect[] = [];
      try { opRects = pending.opPageRects(op); } catch { /* 아래 캐럿 폴백 */ }
      if (opRects.length === 0) {
        const caret = this.opCaretRect(op);
        if (caret) opRects = [caret];
      }
      rects.push(...opRects);
    }
    const pageSet = new Set<number>();
    for (const r of rects) if (Number.isInteger(r.pageIndex) && r.pageIndex >= 0) pageSet.add(r.pageIndex);

    const warnings = [...targets.warnings];
    for (const t of targets.tables.slice(0, 4)) {
      let layout: ReturnType<AgentToolExecutor['measureTableLayout']>;
      try {
        layout = this.measureTableLayout(t.sectionIdx, t.paraIdx, t.controlIdx);
      } catch {
        continue; // 표가 지워졌거나 주소가 바뀌었다
      }
      for (const f of layout.fragments) pageSet.add(f.pageIndex);
      const label = `table s${t.sectionIdx} p${t.paraIdx} c${t.controlIdx}`;
      const over = layout.fragments.find((f) => f.overflowsBodyBottom);
      if (layout.overflowsBody) {
        warnings.push(layout.pageBreak === 0
          ? `${label} runs past the body bottom on page ${over?.pageIndex ?? '?'} and cannot split — set_table_props {pageBreak:"row"}`
          : `${label} runs past the body bottom on page ${over?.pageIndex ?? '?'}`);
      }
      if (layout.overflowsBodyWidth) {
        warnings.push(`${label} is wider than the body — edit_table fit_to_page or set_column_widths`);
      }
    }
    for (const p of targets.paras) {
      const page = this.pageOfParagraph(p.sectionIdx, p.paraIdx, p.cell);
      if (page !== null) pageSet.add(page);
    }

    let pageCount = baseline.pageCount;
    try { pageCount = wasm.pageCount; } catch { /* 이전 값 유지 */ }
    if (baseline.pageStarts) {
      const after = this.capturePageStarts(pageCount);
      const paraCounts = this.paragraphCounts();
      if (after && paraCounts.length === baseline.paraCounts.length) {
        const edits = new Map<number, SectionEdit>();
        for (let s = 0; s < paraCounts.length; s++) {
          const delta = paraCounts[s] - baseline.paraCounts[s];
          const range = targets.bodyRanges.get(s);
          if (targets.wholeSections.has(s) || (!range && delta !== 0)) {
            // 편집 위치를 모르는 문단 수 변화 — 이 구역의 문단 대응을 믿을 수 없다
            edits.set(s, 'all');
          } else if (range) {
            edits.set(s, { lo: range.lo, hi: Math.max(range.hi, range.lo + delta), delta });
          }
        }
        warnings.push(...movedRunWarnings(movedParagraphRuns(baseline.pageStarts, after, paraCounts, edits)));
      }
    }

    const pages = [...pageSet].sort((a, b) => a - b);
    return {
      after: {
        paragraphs,
        pageCountBefore: baseline.pageCount,
        pageCount,
        pages: pages.slice(0, AFTER_MAX_PAGES),
        ...(pages.length > AFTER_MAX_PAGES ? { morePages: pages.length - AFTER_MAX_PAGES } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      rects,
      pages,
    };
  }

  /** 새 op 들 → 보고 대상. 좌표는 모두 편집 후(라이브 shift 반영) 값이다. */
  private collectWriteTargets(ops: readonly PendingOp[]): WriteTargets {
    const targets: WriteTargets = { paras: [], tables: [], bodyRanges: new Map(), wholeSections: new Set(), warnings: [] };
    const seenPara = new Set<string>();
    const seenTable = new Set<string>();
    const pushPara = (sectionIdx: number, paraIdx: number, cell?: CellAddr, from = 0): void => {
      const key = cell
        ? `${sectionIdx}:c${cell.paraIdx}/${cell.controlIdx}/${cell.cellIdx}/${JSON.stringify(cell.path ?? [])}:${paraIdx}`
        : `${sectionIdx}:b:${paraIdx}`;
      if (seenPara.has(key) || targets.paras.length >= AFTER_MAX_PARAGRAPHS) return;
      seenPara.add(key);
      targets.paras.push(cell ? { sectionIdx, paraIdx, cell, from } : { sectionIdx, paraIdx, from });
    };
    const pushTable = (sectionIdx: number, paraIdx: number, controlIdx: number): void => {
      const key = `${sectionIdx}:${paraIdx}:${controlIdx}`;
      if (seenTable.has(key)) return;
      seenTable.add(key);
      targets.tables.push({ sectionIdx, paraIdx, controlIdx });
    };
    const touchBody = (sectionIdx: number, lo: number, hi = lo): void => {
      const cur = targets.bodyRanges.get(sectionIdx);
      targets.bodyRanges.set(sectionIdx, cur
        ? { lo: Math.min(cur.lo, lo), hi: Math.max(cur.hi, hi) }
        : { lo, hi });
    };
    for (const op of ops) {
      if (op.kind === 'template') {
        targets.warnings.push(...op.report.warnings);
        for (const s of op.report.affectedSections) targets.wholeSections.add(s);
        continue;
      }
      if (op.kind === 'insert' || op.kind === 'replace' || op.kind === 'format') {
        const r = op.range;
        // 긴 문단의 뒤쪽 편집은 문단 앞 대신 편집 지점 조금 앞부터 보여 준다
        const from = r.startCharOffset > AFTER_TEXT_CHARS - AFTER_WINDOW_LEAD
          ? r.startCharOffset - AFTER_WINDOW_LEAD
          : 0;
        for (let p = r.startParaIdx; p <= Math.min(r.endParaIdx, r.startParaIdx + 2); p++) {
          pushPara(r.sectionIdx, p, r.cell, p === r.startParaIdx ? from : 0);
        }
        if (r.cell) {
          pushTable(r.sectionIdx, r.cell.paraIdx, r.cell.controlIdx);
          touchBody(r.sectionIdx, r.cell.paraIdx);
        } else {
          touchBody(r.sectionIdx, r.startParaIdx, r.endParaIdx);
        }
        continue;
      }
      if (op.kind !== 'object') continue;
      const o = op.obj;
      switch (o.type) {
        case 'paraFormat':
        case 'applyStyle':
          pushPara(o.sectionIdx, o.paraIdx, o.cell);
          touchBody(o.sectionIdx, o.cell ? o.cell.paraIdx : o.paraIdx);
          break;
        case 'createTable':
          if (o.anchor) {
            pushTable(o.sectionIdx, o.anchor.paraIdx, o.anchor.controlIdx);
            touchBody(o.sectionIdx, o.anchor.paraIdx);
          }
          break;
        case 'insertImage':
        case 'insertEquation':
          if (o.cell) {
            pushPara(o.sectionIdx, o.paraIdx, o.cell);
            pushTable(o.sectionIdx, o.cell.paraIdx, o.cell.controlIdx);
            touchBody(o.sectionIdx, o.cell.paraIdx);
          } else if (o.anchor) {
            pushPara(o.sectionIdx, o.anchor.paraIdx);
            touchBody(o.sectionIdx, o.anchor.paraIdx);
          }
          break;
        case 'insertNote':
          if (o.anchor) {
            pushPara(o.sectionIdx, o.anchor.paraIdx);
            touchBody(o.sectionIdx, o.anchor.paraIdx);
          }
          break;
        case 'setNoteText':
        case 'bookmark':
          touchBody(o.sectionIdx, o.paraIdx);
          break;
        case 'tableStructure':
        case 'setCellProps':
        case 'setTableProps':
        case 'setColumnWidths':
        case 'fitToPage':
        case 'setZoneProps':
        case 'applyFormula':
        case 'setCaption':
          pushTable(o.sectionIdx, o.tableParaIdx, o.controlIdx);
          touchBody(o.sectionIdx, o.tableParaIdx);
          break;
        case 'deleteTable':
          touchBody(o.sectionIdx, o.tableParaIdx);
          break;
        case 'editObject':
        case 'deleteObject':
          // 그림·도형은 문단 텍스트를 바꾸지 않는다 — 품은 문단(셀이면 표)만 편집 범위로 둔다
          if (o.cell) {
            pushTable(o.sectionIdx, o.cell.paraIdx, o.cell.controlIdx);
            touchBody(o.sectionIdx, o.cell.paraIdx);
          } else {
            touchBody(o.sectionIdx, o.paraIdx);
          }
          break;
        case 'insertShape':
          touchBody(o.sectionIdx, o.anchor?.paraIdx ?? o.paraIdx);
          break;
        case 'pageLayout':
          targets.wholeSections.add(o.sectionIdx);
          break;
        default:
          break; // headerFooter — 본문 문단 좌표 없음
      }
    }
    return targets;
  }

  /** 오버레이 rect 를 못 구한 op 의 위치 — 범위 시작 또는 앵커 문단 앞의 캐럿 줄. */
  private opCaretRect(op: PendingOp): SelectionRect | null {
    if (op.kind === 'insert' || op.kind === 'replace' || op.kind === 'format') {
      const r = op.range;
      return this.caretRect(r.sectionIdx, r.startParaIdx, r.startCharOffset, r.cell);
    }
    if (op.kind !== 'object') return null;
    const o = op.obj;
    switch (o.type) {
      case 'paraFormat':
      case 'applyStyle':
        return this.caretRect(o.sectionIdx, o.paraIdx, 0, o.cell);
      case 'setNoteText':
      case 'bookmark':
        return this.caretRect(o.sectionIdx, o.paraIdx, 0);
      case 'insertNote':
      case 'createTable':
        return o.anchor ? this.caretRect(o.sectionIdx, o.anchor.paraIdx, 0) : null;
      case 'insertImage':
      case 'insertEquation':
        return o.cell
          ? this.caretRect(o.sectionIdx, o.paraIdx, 0, o.cell)
          : o.anchor ? this.caretRect(o.sectionIdx, o.anchor.paraIdx, 0) : null;
      case 'deleteTable':
        return this.caretRect(o.sectionIdx, o.tableParaIdx, 0);
      default:
        return null;
    }
  }

  /** 쪽 크기와 본문 좌우 (쪽 px) — 자르기 영역을 본문 폭으로 넓히는 기준. */
  private pageFrame(pageIndex: number): PageFrame | null {
    try {
      const info = this.deps.wasm.getPageInfo(pageIndex);
      return {
        width: info.width,
        height: info.height,
        bodyLeft: info.bodyLeft ?? info.marginLeft,
        bodyRight: info.bodyRight ?? info.width - info.marginRight,
      };
    } catch {
      return null;
    }
  }

  /**
   * 변경 영역(crop) 또는 바뀐 쪽(page)을 위에서 아래로 쌓은 PNG 한 장 — 1.25배에서
   * 시작해 ~1.15MP 안에 들도록 줄인다. 영역마다 쪽과 세로 위치(mm)를 함께 알린다.
   */
  private async renderWriteImage(
    rects: readonly SelectionRect[],
    pages: readonly number[],
    mode: WriteRenderMode,
  ): Promise<Record<string, unknown>> {
    const frames = new Map<number, PageFrame | null>();
    const frameOf = (p: number): PageFrame | null => {
      if (!frames.has(p)) frames.set(p, this.pageFrame(p));
      return frames.get(p)!;
    };
    const fullPage = (p: number): CropRegion | null => {
      const f = frameOf(p);
      return f ? { pageIndex: p, x: 0, y: 0, width: f.width, height: f.height } : null;
    };
    let regions: CropRegion[] = mode === 'crop' ? planCropRegions(rects, frameOf) : [];
    if (regions.length === 0) {
      // page 모드, 또는 영역을 못 구한 crop — 바뀐 쪽 전체로 대신한다
      regions = pages.slice(0, RENDER_MAX_PAGES)
        .map(fullPage)
        .filter((r): r is CropRegion => r !== null);
    }
    if (regions.length === 0) {
      return { renderError: 'no changed area to render' };
    }
    const plan = planStack(regions);
    const s = plan.scale;
    const rendered = new Map<number, HTMLCanvasElement | OffscreenCanvas>();
    const pieces = plan.regions.map((r) => {
      let src = rendered.get(r.pageIndex);
      if (!src) {
        src = this.renderPageToCanvasElement(r.pageIndex, s);
        rendered.set(r.pageIndex, src);
      }
      const sx = Math.max(0, Math.floor(r.x * s));
      const sy = Math.max(0, Math.floor(r.y * s));
      const sw = Math.max(1, Math.min(src.width - sx, Math.ceil(r.width * s)));
      const sh = Math.max(1, Math.min(src.height - sy, Math.ceil(r.height * s)));
      return { r, src, sx, sy, sw, sh };
    });
    const out = this.createRenderCanvas();
    out.width = Math.max(...pieces.map((p) => p.sw));
    out.height = pieces.reduce((sum, p) => sum + p.sh, 0) + RENDER_STACK_GAP_PX * (pieces.length - 1);
    const ctx = out.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new AgentToolError('RENDER_UNAVAILABLE', 'Canvas 2D context is unavailable');
    ctx.fillStyle = '#9e9e9e'; // 영역 사이 구분 띠
    ctx.fillRect(0, 0, out.width, out.height);
    let y = 0;
    for (const p of pieces) {
      ctx.drawImage(p.src as CanvasImageSource, p.sx, p.sy, p.sw, p.sh, 0, y, p.sw, p.sh);
      y += p.sh + RENDER_STACK_GAP_PX;
    }
    const png = await canvasToPngBase64(out);
    return {
      image: { data: png.data, mimeType: 'image/png' },
      renderRegions: plan.regions.map((r) => ({ pageIndex: r.pageIndex, yMm: pxToMm1(r.y), heightMm: pxToMm1(r.height) })),
      ...(plan.omitted > 0 ? { renderOmitted: plan.omitted } : {}),
      ...(plan.clipped ? { renderClipped: true } : {}),
    };
  }

  // ─── template context + structural transfer ─────────────────

  private requireTemplate(capability?: ToolCapabilityContext): DocumentTemplate {
    const template = capability?.template;
    if (!template) throw new AgentToolError('TEMPLATE_UNAVAILABLE', 'No active template is available for this chat.');
    if (!this.deps.loadTemplateBytes) throw new AgentToolError('TEMPLATE_UNAVAILABLE', 'Template loading is unavailable in this Studio.');
    return template;
  }

  private async ensureTemplate(capability?: ToolCapabilityContext): Promise<{ template: DocumentTemplate; wasm: WasmBridge; bytes: Uint8Array }> {
    const template = this.requireTemplate(capability);
    const loadTemplateBytes = this.deps.loadTemplateBytes;
    if (!loadTemplateBytes) throw new AgentToolError('TEMPLATE_UNAVAILABLE', 'Template loading is unavailable in this Studio.');
    const key = `${template.id}:${template.revision}`;
    if (this.templateWasm && this.templateBytes && this.templateKey === key) {
      return { template, wasm: this.templateWasm, bytes: this.templateBytes };
    }
    this.templateWasm?.releaseDocument();
    this.templateBytes = null;
    const { WasmBridge } = await import('../core/wasm-bridge.ts');
    const wasm = new WasmBridge();
    await wasm.initialize();
    const bytes = await loadTemplateBytes(template);
    const exactSourceBytes = bytes.slice();
    wasm.loadDocument(bytes, template.originalName);
    this.templateWasm = wasm;
    this.templateBytes = exactSourceBytes;
    this.templateKey = key;
    return { template, wasm, bytes: this.templateBytes };
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
    assertToolRequestActive(capability);
    if (marksInspection) this.templateInspectionKey = `${template.id}:${template.revision}`;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const { revision: _documentRevision, ...rest } = result as Record<string, unknown>;
      return { templateId: template.id, templateRevision: template.revision, ...rest };
    }
    return { templateId: template.id, templateRevision: template.revision, result };
  }

  /**
   * template_get_structure — get_structure 와 같은 모양(기본 compact 텍스트, format:'json' 은 JSON)을
   * 템플릿 문서로 만든다. compact 머리 줄에는 문서 revision 대신 템플릿 revision 을 쓴다.
   */
  private async templateGetStructure(args: Record<string, unknown>, capability?: ToolCapabilityContext): Promise<unknown> {
    const { template, wasm } = await this.ensureTemplate(capability);
    const rest = this.templateArgs(args, template);
    const nested = new AgentToolExecutor({ ...this.deps, wasm, loadTemplateBytes: undefined });
    const result = asRecord(nested.getStructure(rest, `template ${template.id} revision ${template.revision}`));
    assertToolRequestActive(capability);
    this.templateInspectionKey = `${template.id}:${template.revision}`;
    const { revision: _documentRevision, ...out } = result;
    return { templateId: template.id, templateRevision: template.revision, ...out };
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
    assertToolRequestActive(capability);
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
    assertToolRequestActive(capability);
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
    const { template, wasm: sourceWasm, bytes: templateBytes } = await this.ensureTemplate(capability);
    assertToolRequestActive(capability);
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
    sourceWasm.getParagraphLength(sourceSection, startPara);
    sourceWasm.getParagraphLength(sourceSection, endPara);
    // Keep the exact approved source bytes. Re-serializing the inspection document
    // can normalize package parts before the native importer sees them.
    const sourceBytes = templateBytes.slice();
    const pending = this.deps.pending.addTemplateMutation(
      agent,
      `Insert block from ${template.name}`,
      template.revision,
      () => {
        const transfer = JSON.parse(this.deps.wasm.pasteDocumentBlock(
          sourceBytes,
          sourceSection,
          startPara,
          endPara,
          targetSection,
          targetPara,
          targetOffset,
        )) as {
          ok?: boolean;
          warnings?: string[];
          skippedFeatures?: string[];
          insertedParagraphCount?: number;
          controlCounts?: Record<string, number>;
        };
        if (transfer.ok !== true) {
          throw new AgentToolError('TEMPLATE_TRANSFER_FAILED', 'The native template block importer did not complete.');
        }
        return {
          warnings: transfer.warnings ?? [],
          skippedFeatures: transfer.skippedFeatures ?? [],
          affectedSections: [targetSection],
          insertedParagraphCount: transfer.insertedParagraphCount ?? 0,
          controlCounts: transfer.controlCounts ?? {},
        };
      },
    );
    return { revision: this.revision, pending: true, ...pending, templateRevision: template.revision, source: { sectionIdx: sourceSection, startParaIdx: startPara, endParaIdx: endPara } };
  }

  dispose(): void {
    this.templateWasm?.releaseDocument();
    this.templateWasm = null;
    this.templateBytes = null;
    this.templateKey = null;
    this.templateInspectionKey = null;
    this.documentInspectionRevision = null;
  }

  // ─── write tools (PendingEditManager 위임) ─────────────────

  /**
   * 배치 스테이징 편집 — expectedRevision 하나로 최대 32개 semantic write 를
   * 한 호출에 순차 적용한다. 항목별 좌표는 앞 항목이 적용된 뒤의 문서 기준이고,
   * 중간 실패 시 배치 전체가 롤백된다 (runAtomicBatch). 항목 사이에는 문서
   * 이벤트가 bulk 로 모이므로 revision 이 변하지 않는다 — 항목별 revision 재검사는
   * 진입 시 한 번의 requireRevision 으로 대체한다.
   */
  private applyEdits(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireDocLoaded();
    // 뒤처진 revision 도 그 사이 쓰기가 전부 저널에 있으면 받는다 — 항목마다 좌표 쓰기는
    // 리베이스(겹치면 REVISION_MISMATCH), 앵커 쓰기는 실행 시점 재해석으로 처리하고,
    // 리베이스를 모르는 항목은 옛 revision 으로 실패해 배치 전체가 되돌아간다.
    const expectedRaw = args['expectedRevision'];
    const itemRevision = typeof expectedRaw === 'number' && Number.isSafeInteger(expectedRaw)
      && expectedRaw < this.revision && this.journal.covers(expectedRaw, this.revision)
      ? expectedRaw
      : (this.requireRevision(args), this.revision);
    const rawEdits = args['edits'];
    if (!Array.isArray(rawEdits) || rawEdits.length < 1 || rawEdits.length > 32) {
      throw new AgentToolError('INVALID_ARGS', 'edits must be an array of 1..32 operations');
    }
    const edits = rawEdits.map((raw, index) => {
      const rec = asRecord(raw);
      const tool = rec['tool'];
      if (typeof tool !== 'string' || !BATCHABLE_EDIT_TOOLS.has(tool)) {
        throw new AgentToolError(
          'INVALID_ARGS',
          `edits[${index}].tool must be one of ${[...BATCHABLE_EDIT_TOOLS].join('|')} (got ${JSON.stringify(tool)})`,
        );
      }
      return { tool, args: rec['args'] === undefined ? {} : asRecord(rec['args']) };
    });
    const results: unknown[] = [];
    // runAtomicBatch 안에서는 revision 이 배치 시작 값에 멈춰 있어 개별 record 가
    // 빈 구간에 버려진다 — 항목별 저널 엔트리를 모았다가 성공 시 최종 revision 에 귀속한다.
    const revBeforeBatch = this.revision;
    const buffered: EditJournalEntry[] = [];
    // 저널을 남기지 않는 항목(필드 값·머리말 등)이 하나라도 있으면 배치 구간 전체를 기록하지
    // 않는다 — 일부만 기록하면 구간이 "정밀 기록됨"으로 보여 그 변경이 델타·리베이스에서 빠진다.
    let unjournaled = false;
    this.journalBatch = buffered;
    try {
      this.deps.pending.runAtomicBatch(() => {
        edits.forEach((edit, index) => {
          let itemResult: unknown;
          const journaledBefore = buffered.length;
          try {
            // 배치 안에서는 revision 이 멈춰 있다 — 움직이더라도 앞 항목 몫만큼 따라간다.
            const expectedRevision = itemRevision + (this.revision - revBeforeBatch);
            itemResult = this.dispatch(edit.tool, { ...edit.args, expectedRevision }, agent);
          } catch (e) {
            const code = e instanceof AgentToolError ? e.code : 'RPC_ERROR';
            const message = e instanceof Error ? e.message : String(e);
            throw new AgentToolError(
              code,
              `edits[${index}] (${edit.tool}) failed — the whole batch was rolled back, nothing was applied: ${message}`,
            );
          }
          // 항목별 revision 은 배치 중간 값이라 오해를 부른다 — 최상위 값만 유효하다.
          // note 는 edit_header_footer 처럼 런타임 경고를 담을 때만 오므로 그대로 둔다.
          const { revision: _r, ...rest } = asRecord(itemResult);
          results.push({ tool: edit.tool, ...rest });
          if (buffered.length === journaledBefore) unjournaled = true;
        });
      });
    } finally {
      this.journalBatch = null;
    }
    if (!unjournaled) {
      for (const entry of buffered) {
        this.journal.record(revBeforeBatch, this.revision, entry);
      }
    }
    // 한 턴의 항목은 모두 같은 change set 에 쌓인다 — 항목마다 반복하지 않고 한 번만 싣는다.
    const changeSetIds = new Set(results.map((item) => asRecord(item)['changeSetId']));
    const sharedChangeSetId = changeSetIds.size === 1 ? [...changeSetIds][0] : undefined;
    return {
      revision: this.revision,
      ...(typeof sharedChangeSetId === 'string' ? { changeSetId: sharedChangeSetId } : {}),
      applied: edits.length,
      results: typeof sharedChangeSetId === 'string'
        ? results.map((item) => {
          const { changeSetId: _id, ...rest } = asRecord(item);
          return rest;
        })
        : results,
    };
  }

  /**
   * read_batch — 1..16 개의 읽기 전용 도구를 순서대로 실행한다. apply_edits 와 달리
   * 원자성은 없다 (읽기라 부작용이 없다): 항목마다 성공 결과 또는
   * {error:{code,message}} 를 모으므로 한 항목의 실패가 배치를 멈추지 않는다.
   * 최상위 revision 은 배치이 끝난 시점의 문서 리비전이다.
   */
  private async readBatch(args: Record<string, unknown>, agent: AgentName, capability?: ToolCapabilityContext): Promise<unknown> {
    this.requireDocLoaded();
    const rawReads = args['reads'];
    if (!Array.isArray(rawReads) || rawReads.length < 1 || rawReads.length > 16) {
      throw new AgentToolError('INVALID_ARGS', 'reads must be an array of 1..16 {tool, args} items');
    }
    const results: unknown[] = [];
    for (const raw of rawReads) {
      results.push(await this.readBatchItem(raw, agent, capability));
    }
    return { revision: this.revision, results };
  }

  private async readBatchItem(raw: unknown, agent: AgentName, capability?: ToolCapabilityContext): Promise<unknown> {
    let tool: string | null = null;
    try {
      const rec = asRecord(raw);
      const t = rec['tool'];
      tool = typeof t === 'string' ? t : null;
      if (!tool || !BATCHABLE_READ_TOOLS.has(tool)) {
        throw new AgentToolError(
          'INVALID_ARGS',
          `read item tool must be one of ${[...BATCHABLE_READ_TOOLS].join('|')} (got ${JSON.stringify(t)})`,
        );
      }
      const itemArgs = rec['args'] === undefined ? {} : asRecord(rec['args']);
      assertToolRequestActive(capability);
      assertToolCapability(tool, capability);
      const rawResult = await this.dispatch(tool, itemArgs, agent, capability);
      // 항목별 revision 은 읽는 순서대로 문서가 바뀔 수 있어 오해를 부른다 —
      // 최상위 revision 만 유효하다.
      const { revision: _r, ...rest } = asRecord(rawResult);
      // mcpContent 텍스트 블록은 중첩 JSON 에서 꺼내기 어려우니 text 필드로 푼다.
      const content = rest['mcpContent'];
      if (Array.isArray(content)) {
        delete rest['mcpContent'];
        rest['text'] = content
          .map((block) => asRecord(block)['text'])
          .filter((s): s is string => typeof s === 'string')
          .join('');
      }
      return { tool, ...rest };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = e instanceof AgentToolError
        ? e.code
        : message.includes(DOC_NOT_LOADED_MESSAGE) ? 'DOC_NOT_LOADED' : 'RPC_ERROR';
      return { tool, error: { code, message } };
    }
  }

  private insertText(args: Record<string, unknown>, agent: AgentName): unknown {
    const anchor = this.optAnchor(args);
    if (anchor) {
      if ((anchor.position ?? 'after') === 'replace') {
        // 앵커 매치를 통째로 새 텍스트로 바꾼다 — replace_range 와 같은 원자 경로.
        this.requireRevisionAnchored(args);
        const res = asRecord(this.replaceRangeChecked(this.anchorRangeArgs(args, anchor), agent, 0));
        res['anchor'] = this.anchorEcho(anchor);
        return res;
      }
      this.requireRevisionAnchored(args);
      const cell = anchor.cell ? { ...anchor.cell } : undefined;
      const charOffset = anchor.position === 'before'
        ? anchor.charOffset
        : anchor.charOffset + anchor.length;
      return this.insertTextAt(args, agent, anchor.sectionIdx, anchor.paraIdx, charOffset, cell, 0, anchor);
    }
    const sectionIdx = reqInt(args, 'sectionIdx');
    let paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    const cell = optCell(args);
    const shift = this.requireRevisionRebasable(args, sectionIdx, cell ? cell.paraIdx : paraIdx, cell ? cell.paraIdx : paraIdx);
    if (cell) cell.paraIdx += shift;
    else paraIdx += shift;
    return this.insertTextAt(args, agent, sectionIdx, paraIdx, charOffset, cell, shift, null);
  }

  /** insert_text 본체 — 좌표는 이미 확정(숫자 인자+리베이스 또는 실행 시점 앵커)된 값. */
  private insertTextAt(
    args: Record<string, unknown>,
    agent: AgentName,
    sectionIdx: number,
    paraIdx: number,
    charOffset: number,
    cell: CellAddr | undefined,
    shift: number,
    anchor: ResolvedAnchor | null,
  ): unknown {
    // \r\n / \r → \n 정규화 (wasm 은 \n 만 문단 분할로 처리한다)
    const text = reqString(args, 'text').replace(/\r\n?/g, '\n');
    if (text.length < 1 || text.length > 10_000) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `text must be 1..10000 chars (got ${text.length}); beyond the limit, split it into multiple insert_text calls, chaining each response's revision into the next call's expectedRevision`,
      );
    }
    this.validateAddress(sectionIdx, paraIdx, charOffset, cell);
    const addr: { sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr } =
      { sectionIdx, paraIdx, charOffset };
    if (cell) addr.cell = cell;
    const revBefore = this.revision;
    const r = this.deps.pending.insertText(agent, addr, text);
    const anchorPara = cell ? cell.paraIdx : paraIdx;
    this.recordJournal(
      revBefore, sectionIdx, anchorPara, anchorPara,
      cell ? 0 : r.insertedRange.endParaIdx - r.insertedRange.startParaIdx,
    );
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
      ...(shift !== 0 ? { rebasedParaShift: shift } : {}),
      ...(anchor ? { anchor: this.anchorEcho(anchor) } : {}),
    };
  }

  /**
   * 셀 문단 cellParaIdx 가 중첩 표를 품고 있는지 탐침한다.
   *
   * 경로 API 는 마지막 경로 항목이 실제 표일 때만 성공하므로, 성공 = 그 셀 문단에
   * 표가 있다는 뜻이다. 경로 키 이름은 Rust parse_cell_path 와 같다
   * (controlIndex/cellIndex/cellParaIndex). 표가 몇 번째 컨트롤인지 모르니 앞쪽
   * 컨트롤 몇 개만 훑는다 — 셀 문단의 컨트롤 수는 원래 한둘이다.
   */
  private cellParaHostsNestedTable(sectionIdx: number, cell: CellAddr, cellParaIdx: number): boolean {
    const { wasm } = this.deps;
    if (typeof wasm.getTableDimensionsByPath !== 'function') return false;
    for (let ctrl = 0; ctrl < NESTED_TABLE_PROBE_CONTROLS; ctrl++) {
      const parentPath = cell.path?.map((entry) => ({ ...entry }))
        ?? [{ controlIndex: cell.controlIdx, cellIndex: cell.cellIdx, cellParaIndex: cellParaIdx }];
      parentPath[parentPath.length - 1].cellParaIndex = cellParaIdx;
      const pathJson = JSON.stringify([
        ...parentPath,
        { controlIndex: ctrl, cellIndex: 0, cellParaIndex: 0 },
      ]);
      try {
        wasm.getTableDimensionsByPath(sectionIdx, cell.paraIdx, pathJson);
        return true;
      } catch { /* 그 인덱스엔 표가 없다 — 다음 컨트롤 */ }
    }
    return false;
  }

  /**
   * 셀 범위 삭제/교체가 중첩 표를 품은 문단을 통째로 지우는지 검사한다.
   *
   * 시작/끝 문단은 남은 조각끼리 병합되므로 그 안의 컨트롤은 살아남는다. 완전히
   * 사라지는 건 사이 문단뿐이라 그 구간만 본다. 중첩 표가 든 셀 문단은 텍스트
   * 길이 0 으로 읽혀서 에이전트도 검토 카드도 무엇이 사라지는지 볼 수 없다.
   */
  private guardNestedTableInCellRange(range: DocRange): void {
    const cell = range.cell;
    if (!cell || range.endParaIdx <= range.startParaIdx + 1) return;
    for (let p = range.startParaIdx + 1; p < range.endParaIdx; p++) {
      if (!this.cellParaHostsNestedTable(range.sectionIdx, cell, p)) continue;
      throw new AgentToolError(
        'NESTED_TABLE_IN_RANGE',
        `The range crosses cell paragraph ${p}, which hosts a nested table. Removing that paragraph destroys the nested table and everything in it, and the review card cannot show what was lost. `
        + `Split the edit so paragraph ${p} stays intact (p${range.startParaIdx}:${range.startCharOffset}-p${p - 1} and p${p + 1}:0-p${range.endParaIdx}:${range.endCharOffset} as separate calls), `
        + 'or target text inside the nested table with cell and cellPath from get_selection.',
      );
    }
  }

  /** 본문 다문단 범위가 통째로 삼키는 최상위 표 수 */
  private tablesInsideBodyRange(range: DocRange): number {
    if (range.cell || range.endParaIdx <= range.startParaIdx + 1) return 0;
    try {
      return this.listTables().filter((t) => t.sectionIdx === range.sectionIdx
        && t.paraIdx > range.startParaIdx && t.paraIdx < range.endParaIdx).length;
    } catch {
      return 0;
    }
  }

  private guardTablesInsideBodyRange(range: DocRange): void {
    if (this.tablesInsideBodyRange(range) === 0) return;
    throw new AgentToolError(
      'TABLE_IN_BODY_RANGE',
      'The body text range crosses a table and would remove it. Use cell (and cellPath for a nested table) to edit text inside a cell. Use delete_table only when the table itself should be removed.',
    );
  }

  private deleteRange(args: Record<string, unknown>, agent: AgentName): unknown {
    const anchor = this.optAnchor(args);
    if (anchor) {
      this.anchorPositionOrReplace(anchor, 'delete_range');
      this.requireRevisionAnchored(args);
      const res = asRecord(this.deleteRangeChecked(this.anchorRangeArgs(args, anchor), agent, 0));
      res['anchor'] = this.anchorEcho(anchor);
      return res;
    }
    const shift = this.requireRevisionRebasable(args, ...rangeRebaseAnchor(args));
    return this.deleteRangeChecked(args, agent, shift);
  }

  private deleteRangeChecked(args: Record<string, unknown>, agent: AgentName, shift: number): unknown {
    const range = this.validateRange(args, shift);
    if (range.cell) this.guardNestedTableInCellRange(range);
    if (range.startParaIdx === range.endParaIdx && range.startCharOffset === range.endCharOffset) {
      throw new AgentToolError('INVALID_ARGS', 'Range is empty; nothing to delete');
    }
    this.guardTablesInsideBodyRange(range);
    // 즉시 적용 삭제(빈 교체) — 마크 전용이던 시절엔 원문이 레이아웃에 남아
    // 편집이 많은 턴에서 미리보기 쪽나눔이 최종본과 어긋났다. 삭제된 텍스트는
    // 앵커/팝오버와 사이드바 카드로 검토하고, 거절 시 스냅샷으로 복원된다.
    const revBefore = this.revision;
    const r = this.deps.pending.replaceText(range, '', agent);
    this.recordJournal(
      revBefore, range.sectionIdx,
      range.cell ? range.cell.paraIdx : range.startParaIdx,
      range.cell ? range.cell.paraIdx : range.endParaIdx,
      range.cell ? 0 : -(range.endParaIdx - range.startParaIdx),
    );
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      deletedText: r.deletedText.slice(0, 300),
      collapsedAt: { paraIdx: range.startParaIdx, charOffset: range.startCharOffset },
      postEdit: this.readPostEditDigest(range.sectionIdx, range.startParaIdx, range.startCharOffset, range.cell),
      ...(shift !== 0 ? { rebasedParaShift: shift } : {}),
      note: 'coordinates after the range have shifted; use collapsedAt to insert replacement text.',
    };
  }

  private replaceRange(args: Record<string, unknown>, agent: AgentName): unknown {
    const anchor = this.optAnchor(args);
    if (anchor) {
      this.anchorPositionOrReplace(anchor, 'replace_range');
      this.requireRevisionAnchored(args);
      const res = asRecord(this.replaceRangeChecked(this.anchorRangeArgs(args, anchor), agent, 0));
      res['anchor'] = this.anchorEcho(anchor);
      return res;
    }
    const shift = this.requireRevisionRebasable(args, ...rangeRebaseAnchor(args));
    return this.replaceRangeChecked(args, agent, shift);
  }

  private replaceRangeChecked(args: Record<string, unknown>, agent: AgentName, shift: number): unknown {
    const range = this.validateRange(args, shift);
    if (range.cell) this.guardNestedTableInCellRange(range);
    if (range.startParaIdx === range.endParaIdx && range.startCharOffset === range.endCharOffset) {
      throw new AgentToolError('INVALID_ARGS', 'Range is empty; use insert_text instead');
    }
    this.guardTablesInsideBodyRange(range);
    const text = reqString(args, 'text');
    if (text.length < 1 || text.length > 10_000) {
      throw new AgentToolError('INVALID_ARGS', `text must be 1..10000 chars (got ${text.length})`);
    }
    // 원자적 교체 (삭제 마크 + 끝 삽입 2-op 조합 폐기) — 서식 보존 + 스냅샷 기반 되돌림
    const revBefore = this.revision;
    const r = this.deps.pending.replaceText(range, text, agent);
    this.recordJournal(
      revBefore, range.sectionIdx,
      range.cell ? range.cell.paraIdx : range.startParaIdx,
      range.cell ? range.cell.paraIdx : range.endParaIdx,
      range.cell
        ? 0
        : (r.insertedRange.endParaIdx - r.insertedRange.startParaIdx) - (range.endParaIdx - range.startParaIdx),
    );
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
      ...(shift !== 0 ? { rebasedParaShift: shift } : {}),
    };
  }

  private applyCharFormat(args: Record<string, unknown>, agent: AgentName): unknown {
    const anchor = this.optAnchor(args);
    let sectionIdx: number;
    let paraIdx: number;
    let startOffset: number;
    let endOffset: number;
    let cell: CellAddr | undefined;
    let shift = 0;
    if (anchor) {
      this.anchorPositionOrReplace(anchor, 'apply_char_format');
      this.requireRevisionAnchored(args);
      sectionIdx = anchor.sectionIdx;
      paraIdx = anchor.paraIdx;
      startOffset = anchor.charOffset;
      endOffset = anchor.charOffset + anchor.length;
      cell = anchor.cell ? { ...anchor.cell } : undefined;
    } else {
      sectionIdx = reqInt(args, 'sectionIdx');
      paraIdx = reqInt(args, 'paraIdx');
      startOffset = reqInt(args, 'startOffset');
      endOffset = reqInt(args, 'endOffset');
      cell = optCell(args);
      shift = this.requireRevisionRebasable(args, sectionIdx, cell ? cell.paraIdx : paraIdx, cell ? cell.paraIdx : paraIdx);
      if (cell) cell.paraIdx += shift;
      else paraIdx += shift;
    }
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
    // 장평/자간 — 엔진은 7개 언어 슬롯 배열만 받는다 (parse_char_shape_mods).
    // 스칼라는 전 슬롯, 7-배열은 슬롯별 값으로 통과시킨다.
    const widthPercent = args['widthPercent'];
    if (widthPercent !== undefined && widthPercent !== null) {
      format.ratios = langSlotArray('widthPercent', widthPercent, 50, 200);
    }
    const letterSpacingPercent = args['letterSpacingPercent'];
    if (letterSpacingPercent !== undefined && letterSpacingPercent !== null) {
      format.spacings = langSlotArray('letterSpacingPercent', letterSpacingPercent, -50, 50);
    }
    if (Object.keys(format).length === 0) {
      throw new AgentToolError(
        'INVALID_ARGS',
        'At least one format key is required (bold/italic/underline/strikethrough/fontSizePt/textColor/fontFamily/widthPercent/letterSpacingPercent)',
      );
    }
    const range: DocRange = {
      sectionIdx,
      startParaIdx: paraIdx,
      startCharOffset: startOffset,
      endParaIdx: paraIdx,
      endCharOffset: endOffset,
    };
    if (cell) range.cell = cell;
    const revBefore = this.revision;
    const r = this.deps.pending.applyCharFormat(agent, range, format);
    const anchorPara = cell ? cell.paraIdx : paraIdx;
    this.recordJournal(revBefore, sectionIdx, anchorPara, anchorPara, 0);
    return {
      revision: this.revision, changeSetId: r.changeSetId, applied: true,
      ...(shift !== 0 ? { rebasedParaShift: shift } : {}),
      ...(anchor ? { anchor: this.anchorEcho(anchor) } : {}),
    };
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
    };
  }

  // ─── 객체 툴 (Phase 2: 표/서식/스타일) ─────────────────────

  /** 문단 텍스트 지문 (앞 24자) — paraFormat/applyStyle 드리프트 프로브용 */
  private paraTextSample(sectionIdx: number, paraIdx: number, cell?: CellAddr): string {
    try {
      const { wasm } = this.deps;
      const len = cell?.path
        ? wasm.getCellParagraphLengthByPath(sectionIdx, cell.paraIdx, cellPathAt(cell, paraIdx))
        : cell
          ? wasm.getCellParagraphLength(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx)
          : wasm.getParagraphLength(sectionIdx, paraIdx);
      const n = Math.min(len, 24);
      if (n === 0) return '';
      return cell?.path
        ? wasm.getTextInCellByPath(sectionIdx, cell.paraIdx, cellPathAt(cell, paraIdx), 0, n)
        : cell
          ? wasm.getTextInCell(sectionIdx, cell.paraIdx, cell.controlIdx, cell.cellIdx, paraIdx, 0, n)
          : wasm.getTextRange(sectionIdx, paraIdx, 0, n);
    } catch {
      return '';
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
    const r = this.stageObjectOp(agent, obj, sectionIdx, paraIdx);
    const anchor = (r.obj as Extract<ObjectOp, { type: 'createTable' }>).anchor!;
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      table: { paraIdx: anchor.paraIdx, controlIdx: anchor.controlIdx, rowCount: rows, colCount: cols },
      note: `cells are addressed row-major: cellIdx = row*${cols}+col`,
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

    // 모든 표 op 은 호출 즉시 적용된다 — 결과의 행/열/셀 수가 곧 다음 호출의 좌표계다.
    const stage = (obj: ObjectOp, note?: string): Record<string, unknown> => {
      const r = this.stageObjectOp(agent, obj, sectionIdx, paraIdx);
      const after = wasm.getTableDimensions(sectionIdx, paraIdx, controlIdx);
      return {
        revision: this.revision, changeSetId: r.changeSetId,
        rowCount: after.rowCount, colCount: after.colCount, cellCount: after.cellCount,
        ...(note ? { note } : {}),
      };
    };
    const RENUMBERED = 'cellIdx values after the change are renumbered — use the returned counts or re-read get_structure before addressing this table\'s cells again.';

    switch (op) {
      case 'insert_row': {
        const rowIdx = reqIdx('rowIdx', dims.rowCount);
        return stage({ type: 'tableStructure', ...base, op: 'insert_row', index: rowIdx, after: optBool('below', true) },
          RENUMBERED);
      }
      case 'insert_col': {
        const colIdx = reqIdx('colIdx', dims.colCount);
        return stage({ type: 'tableStructure', ...base, op: 'insert_col', index: colIdx, after: optBool('right', true) },
          RENUMBERED);
      }
      case 'delete_row': {
        const rowIdx = reqIdx('rowIdx', dims.rowCount);
        if (dims.rowCount <= 1) throw new AgentToolError('INVALID_ARGS', 'cannot delete the only row');
        return stage({ type: 'tableStructure', ...base, op: 'delete_row', rowIdx }, RENUMBERED);
      }
      case 'delete_col': {
        const colIdx = reqIdx('colIdx', dims.colCount);
        if (dims.colCount <= 1) throw new AgentToolError('INVALID_ARGS', 'cannot delete the only column');
        return stage({ type: 'tableStructure', ...base, op: 'delete_col', colIdx }, RENUMBERED);
      }
      case 'merge_cells': {
        const startRow = reqIdx('startRow', dims.rowCount);
        const startCol = reqIdx('startCol', dims.colCount);
        const endRow = reqIdx('endRow', dims.rowCount);
        const endCol = reqIdx('endCol', dims.colCount);
        if (endRow < startRow || endCol < startCol || (startRow === endRow && startCol === endCol)) {
          throw new AgentToolError('INVALID_ARGS', 'merge range must cover at least two cells and end must not precede start');
        }
        return stage({ type: 'tableStructure', ...base, op: 'merge_cells', startRow, startCol, endRow, endCol },
          RENUMBERED);
      }
      case 'split_cell': {
        const rowIdx = reqIdx('rowIdx', dims.rowCount);
        const colIdx = reqIdx('colIdx', dims.colCount);
        const splitRows = reqInt(args, 'splitRows');
        const splitCols = reqInt(args, 'splitCols');
        if (splitRows < 1 || splitRows > 64 || splitCols < 1 || splitCols > 64 || (splitRows === 1 && splitCols === 1)) {
          throw new AgentToolError('INVALID_ARGS', 'splitRows/splitCols must be 1..64 and at least one must be greater than 1');
        }
        // getTableDimensions 범위만으로는 병합 셀의 덮인 좌표도 통과한다. 엔진은
        // 실제 앵커(row/col)만 나눌 수 있으므로 get_structure 그리드와 같은 원점을 강제한다.
        let isCellOrigin = false;
        for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx++) {
          const info = wasm.getCellInfo(sectionIdx, paraIdx, controlIdx, cellIdx);
          if (info.row === rowIdx && info.col === colIdx) {
            isCellOrigin = true;
            break;
          }
        }
        if (!isCellOrigin) {
          throw new AgentToolError('INVALID_ARGS', `No cell starts at row ${rowIdx}, col ${colIdx} — use the r<row> line and column position from the get_structure grid (covered coordinates inside merged cells are not valid split targets)`);
        }
        return stage({ type: 'tableStructure', ...base, op: 'split_cell', rowIdx, colIdx, splitRows, splitCols },
          RENUMBERED);
      }
      case 'set_cell_props': {
        const cellIdx = reqIdx('cellIdx', dims.cellCount);
        // props 는 edit_table op 시절의 옛 이름 — 한 릴리스 동안 받아 준다.
        const props = this.parseCellProps(asRecord(args['cellProps'] ?? args['props'] ?? {}));
        return stage({ type: 'setCellProps', ...base, cellIdx, props, dims: dimsNow });
      }
      case 'set_table_props': {
        const props = this.parseTableProps(asRecord(args['tableProps'] ?? args['props'] ?? {}));
        return stage({ type: 'setTableProps', ...base, props, dims: dimsNow });
      }
      case 'set_column_widths': {
        const raw = args['columnWidthsMm'];
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new AgentToolError('INVALID_ARGS', 'columnWidthsMm must be a non-empty array of mm widths');
        }
        if (raw.length !== dims.colCount) {
          throw new AgentToolError('INVALID_ARGS', `columnWidthsMm has ${raw.length} entries but the table has ${dims.colCount} columns`);
        }
        const widthsHu = raw.map((value, index) => {
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 500) {
            throw new AgentToolError('INVALID_ARGS', `columnWidthsMm[${index}] must be a positive number up to 500mm`);
          }
          return mmToHu(value);
        });
        return stage({ type: 'setColumnWidths', ...base, widthsHu, dims: dimsNow });
      }
      case 'fit_to_page':
        return stage({ type: 'fitToPage', ...base, dims: dimsNow },
          'columns shrink proportionally to the body width; a table that already fits is unchanged.');
      case 'set_zone_borders': {
        const corner = (key: string): { row: number; col: number } => {
          const value = args[key];
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new AgentToolError('INVALID_ARGS', `${key} must be an object {row, col}`);
          }
          const rec = value as Record<string, unknown>;
          const row = reqInt(rec, 'row');
          const col = reqInt(rec, 'col');
          if (row < 0 || row >= dims.rowCount) throw new AgentToolError('INVALID_ARGS', `${key}.row ${row} out of range (0..${dims.rowCount - 1})`);
          if (col < 0 || col >= dims.colCount) throw new AgentToolError('INVALID_ARGS', `${key}.col ${col} out of range (0..${dims.colCount - 1})`);
          return { row, col };
        };
        const start = corner('startCell');
        const end = corner('endCell');
        if (end.row < start.row || end.col < start.col) {
          throw new AgentToolError('INVALID_ARGS', 'endCell must not precede startCell');
        }
        const props = this.parseZoneProps(args);
        return stage({
          type: 'setZoneProps', ...base,
          range: { startRow: start.row, startCol: start.col, endRow: end.row, endCol: end.col },
          props, dims: dimsNow,
        }, 'borders/fill land on the zone outline.');
      }
      case 'apply_formula': {
        const row = reqIdx('row', dims.rowCount);
        const col = reqIdx('col', dims.colCount);
        const formula = reqString(args, 'formula');
        if (formula.length > 1000) throw new AgentToolError('INVALID_ARGS', 'formula must be at most 1000 chars');
        const format = this.parseFormulaFormat(args['format']);
        // 오버레이 대상 셀 — 병합 셀도 포함하도록 앵커가 아닌 덮는 셀을 찾는다.
        let cellIdx: number | undefined;
        for (let idx = 0; idx < dims.cellCount; idx++) {
          const info = wasm.getCellInfo(sectionIdx, paraIdx, controlIdx, idx);
          if (info.row <= row && row < info.row + info.rowSpan
            && info.col <= col && col < info.col + info.colSpan) {
            cellIdx = idx;
            break;
          }
        }
        const result = stage({
          type: 'applyFormula', ...base, row, col, formula,
          ...(format ? { format } : {}),
          ...(cellIdx !== undefined ? { cellIdx } : {}),
          dims: dimsNow,
        });
        return cellIdx === undefined ? result : { ...result, cellText: this.readCellText(sectionIdx, paraIdx, controlIdx, cellIdx) };
      }
      case 'set_caption': {
        const text = reqString(args, 'text');
        if (text.length > 5000) throw new AgentToolError('INVALID_ARGS', 'text must be at most 5000 chars');
        const withNumber = optBool('withNumber', true);
        return stage({ type: 'setCaption', ...base, text, withNumber, dims: dimsNow },
          'the caption is created if missing.');
      }
      default:
        throw new AgentToolError('INVALID_ARGS', `op must be one of insert_row|insert_col|delete_row|delete_col|merge_cells|split_cell|set_column_widths|fit_to_page|apply_formula|set_caption (got ${JSON.stringify(op)}); table, cell and zone properties use set_table_props, set_cell_props and set_zone_borders`);
    }
  }

  /** 셀 전체 텍스트 (apply_formula 결과 보고용, 최대 200자) */
  private readCellText(sectionIdx: number, paraIdx: number, controlIdx: number, cellIdx: number): string {
    const { wasm } = this.deps;
    try {
      const parts: string[] = [];
      const count = wasm.getCellParagraphCount(sectionIdx, paraIdx, controlIdx, cellIdx);
      for (let p = 0; p < count; p++) {
        const len = wasm.getCellParagraphLength(sectionIdx, paraIdx, controlIdx, cellIdx, p);
        parts.push(len > 0 ? wasm.getTextInCell(sectionIdx, paraIdx, controlIdx, cellIdx, p, 0, len) : '');
      }
      return parts.join('\n').slice(0, 200);
    } catch {
      return '';
    }
  }

  /**
   * 객체 op 등록 + 편집 저널 기록. 문단 수 변화까지 그대로 남겨 병렬 서브에이전트의
   * 다른 문단 쓰기가 재조회 없이 리베이스되게 한다 (anchorPara 가 없으면 기록하지 않는다).
   */
  private stageObjectOp(agent: AgentName, obj: ObjectOp, sectionIdx: number, anchorPara: number | null) {
    const { wasm } = this.deps;
    const revBefore = this.revision;
    const parasBefore = wasm.getParagraphCount(sectionIdx);
    const r = this.deps.pending.addObjectOp(agent, obj);
    if (anchorPara !== null) {
      this.recordJournal(revBefore, sectionIdx, anchorPara, anchorPara, wasm.getParagraphCount(sectionIdx) - parasBefore);
    }
    return r;
  }

  /** set_zone_borders 인자 → wasm setCellZoneProperties JSON */
  private parseZoneProps(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const side of ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'] as const) {
      const value = args[side];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new AgentToolError('INVALID_ARGS', `${side} must be an object {type, width, color}`);
      }
      const rec = value as Record<string, unknown>;
      const type = reqInt(rec, 'type');
      const width = reqInt(rec, 'width');
      const color = reqString(rec, 'color');
      if (type < 0 || type > 15) throw new AgentToolError('INVALID_ARGS', `${side}.type must be 0..15`);
      if (width < 0 || width > 6) throw new AgentToolError('INVALID_ARGS', `${side}.width must be 0..6`);
      if (!HEX_COLOR_RE.test(color)) throw new AgentToolError('INVALID_ARGS', `${side}.color must be "#RRGGBB"`);
      out[side] = { type, width, color };
    }
    const fill = args['fillColor'];
    if (fill !== undefined && fill !== null) {
      if (typeof fill !== 'string' || !HEX_COLOR_RE.test(fill)) {
        throw new AgentToolError('INVALID_ARGS', 'fillColor must be "#RRGGBB"');
      }
      out['fillType'] = 'solid';
      out['fillColor'] = fill;
    }
    for (const [key, max] of [['diagonalLine', 15], ['diagonalSlash', 7], ['diagonalBackSlash', 7], ['diagonalWidth', 6]] as const) {
      const value = args[key];
      if (value === undefined || value === null) continue;
      const num = reqInt(args, key);
      if (num < 0 || num > max) throw new AgentToolError('INVALID_ARGS', `${key} must be 0..${max}`);
      out[key] = num;
    }
    const diagonalColor = args['diagonalColor'];
    if (diagonalColor !== undefined && diagonalColor !== null) {
      if (typeof diagonalColor !== 'string' || !HEX_COLOR_RE.test(diagonalColor)) {
        throw new AgentToolError('INVALID_ARGS', 'diagonalColor must be "#RRGGBB"');
      }
      out['diagonalColor'] = diagonalColor;
    }
    const centerLine = args['centerLine'];
    if (centerLine !== undefined && centerLine !== null) {
      const allowed = ['NONE', 'VERTICAL', 'HORIZONTAL', 'CROSS'];
      if (typeof centerLine !== 'string' || !allowed.includes(centerLine)) {
        throw new AgentToolError('INVALID_ARGS', `centerLine must be one of ${allowed.join('|')}`);
      }
      out['centerLine'] = centerLine;
    }
    if (Object.keys(out).length === 0) {
      throw new AgentToolError('INVALID_ARGS', 'set_zone_borders requires at least one of borderLeft/borderRight/borderTop/borderBottom/fillColor/diagonalLine/centerLine');
    }
    return out;
  }

  /** apply_formula 의 표시 형식 인자 검증 */
  private parseFormulaFormat(raw: unknown): {
    decimalPlaces?: number; thousandsSeparator?: boolean; prefix?: string; suffix?: string;
  } | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AgentToolError('INVALID_ARGS', 'format must be an object');
    }
    const rec = raw as Record<string, unknown>;
    const allowed = ['decimalPlaces', 'thousandsSeparator', 'prefix', 'suffix'];
    const unknownKeys = Object.keys(rec).filter((key) => !allowed.includes(key));
    if (unknownKeys.length > 0) throw new AgentToolError('INVALID_ARGS', `Unsupported format keys: ${unknownKeys.join(', ')}`);

    const out: { decimalPlaces?: number; thousandsSeparator?: boolean; prefix?: string; suffix?: string } = {};
    if (rec['decimalPlaces'] !== undefined && rec['decimalPlaces'] !== null) {
      const places = reqInt(rec, 'decimalPlaces');
      if (places < 0 || places > 10) throw new AgentToolError('INVALID_ARGS', 'format.decimalPlaces must be 0..10');
      out.decimalPlaces = places;
    }
    if (rec['thousandsSeparator'] !== undefined && rec['thousandsSeparator'] !== null) {
      if (typeof rec['thousandsSeparator'] !== 'boolean') {
        throw new AgentToolError('INVALID_ARGS', 'format.thousandsSeparator must be a boolean');
      }
      out.thousandsSeparator = rec['thousandsSeparator'];
    }
    for (const key of ['prefix', 'suffix'] as const) {
      const value = rec[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.length > 16) {
        throw new AgentToolError('INVALID_ARGS', `format.${key} must be a string up to 16 chars`);
      }
      out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
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
    const obj: ObjectOp = {
      type: 'deleteTable',
      sectionIdx,
      tableParaIdx: paraIdx,
      controlIdx,
      dims: { rowCount: dims.rowCount, colCount: dims.colCount },
    };
    const r = this.stageObjectOp(agent, obj, sectionIdx, paraIdx);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      deleted: { sectionIdx, paraIdx, controlIdx },
      note: `the table is removed now; later tables in paragraph ${paraIdx} moved down one controlIdx.`,
    };
  }

  /** set_cell_props 허용 키 → wasm setCellProperties JSON */
  private parseCellProps(raw: Record<string, unknown>): Record<string, unknown> {
    const allowed = new Set([
      'fillColor', 'verticalAlign', 'isHeader', 'widthMm', 'heightMm', 'paddingMm',
      'applyInnerMargin', 'textDirection', 'protected', 'editableInForm', 'fieldName',
    ]);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new AgentToolError('INVALID_ARGS', `Unsupported cellProps keys: ${unknown.join(', ')}. Valid keys: ${[...allowed].join(', ')}`);
    }

    const out: Record<string, unknown> = {};
    const fill = raw['fillColor'];
    if (fill !== undefined && fill !== null) {
      if (typeof fill !== 'string' || !HEX_COLOR_RE.test(fill)) {
        throw new AgentToolError('INVALID_ARGS', 'cellProps.fillColor must be "#RRGGBB"');
      }
      out['fillType'] = 'solid';
      out['fillColor'] = fill;
    }
    const va = raw['verticalAlign'];
    if (va !== undefined && va !== null) {
      const map: Record<string, number> = { top: 0, center: 1, bottom: 2 };
      if (typeof va !== 'string' || !(va in map)) {
        throw new AgentToolError('INVALID_ARGS', 'cellProps.verticalAlign must be "top"|"center"|"bottom"');
      }
      out['verticalAlign'] = map[va];
    }
    for (const [publicKey, internalKey] of [
      ['isHeader', 'isHeader'], ['applyInnerMargin', 'applyInnerMargin'],
      ['protected', 'cellProtect'], ['editableInForm', 'editableInForm'],
    ] as const) {
      const value = raw[publicKey];
      if (value !== undefined && value !== null) {
        if (typeof value !== 'boolean') throw new AgentToolError('INVALID_ARGS', `cellProps.${publicKey} must be a boolean`);
        out[internalKey] = value;
      }
    }
    const direction = raw['textDirection'];
    if (direction !== undefined && direction !== null) {
      if (direction !== 'horizontal' && direction !== 'vertical') {
        throw new AgentToolError('INVALID_ARGS', 'cellProps.textDirection must be "horizontal"|"vertical"');
      }
      out['textDirection'] = direction === 'vertical' ? 1 : 0;
    }
    const fieldName = raw['fieldName'];
    if (fieldName !== undefined && fieldName !== null) {
      if (typeof fieldName !== 'string' || fieldName.length > 255) {
        throw new AgentToolError('INVALID_ARGS', 'cellProps.fieldName must be a string up to 255 chars (empty clears it)');
      }
      out['fieldName'] = fieldName;
    }
    for (const [mmKey, huKey] of [['widthMm', 'width'], ['heightMm', 'height']] as const) {
      const value = raw[mmKey];
      if (value !== undefined && value !== null) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 500) {
          throw new AgentToolError('INVALID_ARGS', `cellProps.${mmKey} must be a positive number up to 500mm`);
        }
        out[huKey] = mmToHu(value);
      }
    }
    const padding = raw['paddingMm'];
    if (padding !== undefined && padding !== null) {
      if (typeof padding !== 'object' || Array.isArray(padding)) {
        throw new AgentToolError('INVALID_ARGS', 'cellProps.paddingMm must be an object with left/right/top/bottom');
      }
      const sides = padding as Record<string, unknown>;
      const badSides = Object.keys(sides).filter((key) => !['left', 'right', 'top', 'bottom'].includes(key));
      if (badSides.length > 0) throw new AgentToolError('INVALID_ARGS', `Unsupported paddingMm keys: ${badSides.join(', ')}`);
      for (const side of ['left', 'right', 'top', 'bottom'] as const) {
        const value = sides[side];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
          throw new AgentToolError('INVALID_ARGS', `cellProps.paddingMm.${side} must be 0..100mm`);
        }
        out[`padding${side[0].toUpperCase()}${side.slice(1)}`] = mmToHu(value);
      }
      if (out['applyInnerMargin'] === undefined) out['applyInnerMargin'] = true;
    }
    if (Object.keys(out).length === 0) {
      throw new AgentToolError('INVALID_ARGS', `cellProps needs at least one of: ${[...allowed].join(', ')}`);
    }
    return out;
  }

  /** set_table_props 허용 키 → wasm setTableProperties JSON */
  private parseTableProps(raw: Record<string, unknown>): Record<string, unknown> {
    const allowed = new Set([
      'repeatHeader', 'pageBreak', 'cellSpacingMm', 'cellPaddingMm', 'outerMarginMm',
      'positionMode', 'textWrap', 'horizontalRelativeTo', 'horizontalAlign',
      'horizontalOffsetMm', 'verticalRelativeTo', 'verticalAlign', 'verticalOffsetMm',
      'restrictInPage', 'allowOverlap', 'keepWithAnchor', 'captionEnabled',
      'captionDirection', 'captionWidthMm', 'captionSpacingMm', 'captionVerticalAlign',
    ]);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new AgentToolError('INVALID_ARGS', `Unsupported tableProps keys: ${unknown.join(', ')}. Valid keys: ${[...allowed].join(', ')}`);
    }

    const out: Record<string, unknown> = {};
    for (const [publicKey, internalKey] of [
      ['repeatHeader', 'repeatHeader'], ['restrictInPage', 'restrictInPage'],
      ['allowOverlap', 'allowOverlap'], ['keepWithAnchor', 'keepWithAnchor'],
      ['captionEnabled', 'hasCaption'],
    ] as const) {
      const value = raw[publicKey];
      if (value !== undefined && value !== null) {
        if (typeof value !== 'boolean') throw new AgentToolError('INVALID_ARGS', `tableProps.${publicKey} must be a boolean`);
        out[internalKey] = value;
      }
    }
    const enumProp = (
      publicKey: string, internalKey: string, map: Record<string, string | number>,
    ): void => {
      const value = raw[publicKey];
      if (value === undefined || value === null) return;
      if (typeof value !== 'string' || !(value in map)) {
        throw new AgentToolError('INVALID_ARGS', `tableProps.${publicKey} must be one of ${Object.keys(map).join('|')}`);
      }
      out[internalKey] = map[value];
    };
    enumProp('pageBreak', 'pageBreak', { none: 0, cell: 1, row: 2 });
    enumProp('textWrap', 'textWrap', {
      square: 'Square', topAndBottom: 'TopAndBottom', behindText: 'BehindText', inFrontOfText: 'InFrontOfText',
    });
    enumProp('horizontalRelativeTo', 'horzRelTo', { paper: 'Paper', page: 'Page', column: 'Column', paragraph: 'Para' });
    enumProp('horizontalAlign', 'horzAlign', { left: 'Left', center: 'Center', right: 'Right', inside: 'Inside', outside: 'Outside' });
    enumProp('verticalRelativeTo', 'vertRelTo', { paper: 'Paper', page: 'Page', paragraph: 'Para' });
    enumProp('verticalAlign', 'vertAlign', { top: 'Top', center: 'Center', bottom: 'Bottom', inside: 'Inside', outside: 'Outside' });
    enumProp('captionDirection', 'captionDirection', { left: 0, right: 1, top: 2, bottom: 3 });
    enumProp('captionVerticalAlign', 'captionVertAlign', { top: 0, center: 1, bottom: 2 });

    const mode = raw['positionMode'];
    if (mode !== undefined && mode !== null) {
      if (mode !== 'inline' && mode !== 'floating') {
        throw new AgentToolError('INVALID_ARGS', 'tableProps.positionMode must be "inline"|"floating"');
      }
      out['treatAsChar'] = mode === 'inline';
    }
    const floatingKeys = [
      'textWrap', 'horizontalRelativeTo', 'horizontalAlign', 'horizontalOffsetMm',
      'verticalRelativeTo', 'verticalAlign', 'verticalOffsetMm', 'restrictInPage',
      'allowOverlap', 'keepWithAnchor', 'outerMarginMm',
    ];
    if (mode === undefined && floatingKeys.some((key) => raw[key] !== undefined && raw[key] !== null)) {
      out['treatAsChar'] = false;
    }
    // 에이전트 편의 정렬 — 한컴의 통상 동작("단 기준 + offset 0")에 맞춘다.
    const horizontalAlign = raw['horizontalAlign'];
    if (horizontalAlign !== undefined && horizontalAlign !== null) {
      if (raw['horizontalRelativeTo'] === undefined || raw['horizontalRelativeTo'] === null) {
        out['horzRelTo'] = ['inside', 'outside'].includes(String(horizontalAlign)) ? 'Page' : 'Column';
      }
      if (raw['horizontalOffsetMm'] === undefined || raw['horizontalOffsetMm'] === null) {
        out['horzOffset'] = 0;
      }
    }

    const boundedMm = (publicKey: string, internalKey: string, min: number, max: number): void => {
      const value = raw[publicKey];
      if (value === undefined || value === null) return;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new AgentToolError('INVALID_ARGS', `tableProps.${publicKey} must be ${min}..${max}mm`);
      }
      out[internalKey] = mmToHu(value);
    };
    boundedMm('cellSpacingMm', 'cellSpacing', 0, 100);
    boundedMm('horizontalOffsetMm', 'horzOffset', -1000, 1000);
    boundedMm('verticalOffsetMm', 'vertOffset', -1000, 1000);
    boundedMm('captionWidthMm', 'captionWidth', 0, 500);
    boundedMm('captionSpacingMm', 'captionSpacing', 0, 100);

    for (const [groupKey, prefix] of [['cellPaddingMm', 'padding'], ['outerMarginMm', 'outer']] as const) {
      const group = raw[groupKey];
      if (group === undefined || group === null) continue;
      if (typeof group !== 'object' || Array.isArray(group)) {
        throw new AgentToolError('INVALID_ARGS', `tableProps.${groupKey} must be an object with left/right/top/bottom`);
      }
      const sides = group as Record<string, unknown>;
      const badSides = Object.keys(sides).filter((key) => !['left', 'right', 'top', 'bottom'].includes(key));
      if (badSides.length > 0) throw new AgentToolError('INVALID_ARGS', `Unsupported ${groupKey} keys: ${badSides.join(', ')}`);
      for (const side of ['left', 'right', 'top', 'bottom'] as const) {
        const value = sides[side];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
          throw new AgentToolError('INVALID_ARGS', `tableProps.${groupKey}.${side} must be 0..100mm`);
        }
        out[`${prefix}${side[0].toUpperCase()}${side.slice(1)}`] = mmToHu(value);
      }
    }
    if (Object.keys(out).length === 0) {
      throw new AgentToolError('INVALID_ARGS', `tableProps needs at least one of: ${[...allowed].join(', ')}`);
    }
    return out;
  }

  private applyParaFormat(args: Record<string, unknown>, agent: AgentName): unknown {
    const anchor = this.optAnchor(args);
    let sectionIdx: number;
    let paraIdx: number;
    let cell: CellAddr | undefined;
    let paraShift = 0;
    if (anchor) {
      this.requireRevisionAnchored(args);
      if (anchor.cell?.path) {
        // paraFormat 의 중첩 셀 ByPath 엔진 경로가 없다 — 숫자 인자 쪽과 같은 한계.
        throw new AgentToolError(
          'INVALID_ARGS',
          'anchor resolved inside a nested cell — apply_para_format reaches only top-level cells',
        );
      }
      sectionIdx = anchor.sectionIdx;
      // position: replace(기본) 는 매치 문단, before/after 는 그 이웃 문단.
      if (anchor.position === 'before') paraIdx = anchor.paraIdx - 1;
      else if (anchor.position === 'after') paraIdx = anchor.paraIdx + 1;
      else paraIdx = anchor.paraIdx;
      cell = anchor.cell ? { ...anchor.cell } : undefined;
      if (paraIdx < 0) {
        throw new AgentToolError(
          'INVALID_ARGS',
          'anchor.position "before" but the match sits in the first paragraph — nothing before it',
        );
      }
    } else {
      sectionIdx = reqInt(args, 'sectionIdx');
      paraIdx = reqInt(args, 'paraIdx');
      cell = optCell(args);
      paraShift = this.requireRevisionRebasable(args, sectionIdx, cell ? cell.paraIdx : paraIdx, cell ? cell.paraIdx : paraIdx);
      if (cell) cell.paraIdx += paraShift;
      else paraIdx += paraShift;
    }
    this.validateAddress(sectionIdx, paraIdx, undefined, cell);

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
    // 줄 간격 두 형태: lineSpacingPercent(percent 단축키) 또는 lineSpacingType+lineSpacingPt.
    // NonPercent 저장값은 2x HWPUNIT — rust style_resolver 가 px = raw*96/7200/2 로 해소한다.
    const lsTypeRaw = args['lineSpacingType'];
    const lsInternal = (lsTypeRaw === undefined || lsTypeRaw === null)
      ? undefined
      : LINE_SPACING_TYPE_IN[lsTypeRaw as string];
    if (lsTypeRaw !== undefined && lsTypeRaw !== null && lsInternal === undefined) {
      throw new AgentToolError('INVALID_ARGS', 'lineSpacingType must be one of percent|fixed|atLeast|spaceOnly');
    }
    const lsPt = args['lineSpacingPt'];
    if (lsp !== undefined && lsp !== null && lsPt !== undefined && lsPt !== null) {
      throw new AgentToolError('INVALID_ARGS', 'send either lineSpacingPercent or lineSpacingType+lineSpacingPt, not both');
    }
    if (lsp !== undefined && lsp !== null) {
      if (typeof lsp !== 'number' || lsp < 50 || lsp > 500) {
        throw new AgentToolError('INVALID_ARGS', 'lineSpacingPercent must be 50..500');
      }
      props['lineSpacing'] = Math.round(lsp);
      props['lineSpacingType'] = 'Percent';
    }
    if (lsPt !== undefined && lsPt !== null) {
      if (typeof lsPt !== 'number' || !Number.isFinite(lsPt) || lsPt <= 0 || lsPt > 1000) {
        throw new AgentToolError('INVALID_ARGS', 'lineSpacingPt must be a number in 0..1000');
      }
      if (lsInternal === undefined || lsInternal === 'Percent') {
        throw new AgentToolError('INVALID_ARGS', 'lineSpacingPt pairs with lineSpacingType fixed|atLeast|spaceOnly');
      }
      props['lineSpacing'] = Math.round(lsPt * 200);
      props['lineSpacingType'] = lsInternal;
    } else if (lsInternal !== undefined) {
      if (lsInternal === 'Percent') {
        if (lsp === undefined || lsp === null) {
          throw new AgentToolError('INVALID_ARGS', 'lineSpacingType "percent" requires lineSpacingPercent');
        }
      } else {
        throw new AgentToolError('INVALID_ARGS', `lineSpacingType "${lsTypeRaw}" requires lineSpacingPt`);
      }
    }
    // 탭 정지 — 내부 TabItem.position 은 2x HWPUNIT (mmToHu * 2), type 은 숫자 코드.
    // 내면 목록 전체를 교체한다 (빈 배열 = 전부 제거).
    const tabStops = args['tabStops'];
    if (tabStops !== undefined && tabStops !== null) {
      if (!Array.isArray(tabStops) || tabStops.length > 40) {
        throw new AgentToolError('INVALID_ARGS', 'tabStops must be an array of up to 40 stops');
      }
      props['tabStops'] = tabStops.map((entry, i) => {
        const t = asRecord(entry);
        const pos = t['positionMm'];
        if (typeof pos !== 'number' || !Number.isFinite(pos) || pos <= 0 || pos > 300) {
          throw new AgentToolError('INVALID_ARGS', `tabStops[${i}].positionMm must be a number in 0..300`);
        }
        const typeCode = TAB_TYPE_IN[(t['type'] ?? 'left') as string];
        if (typeCode === undefined) {
          throw new AgentToolError('INVALID_ARGS', `tabStops[${i}].type must be one of left|right|center|decimal`);
        }
        const fill = t['fill'] ?? 0;
        if (typeof fill !== 'number' || !Number.isSafeInteger(fill) || fill < 0 || fill > 5) {
          throw new AgentToolError('INVALID_ARGS', `tabStops[${i}].fill must be an integer 0..5`);
        }
        return { position: Math.round(mmToHu(pos) * 2), type: typeCode, fill };
      });
    }
    // 문단 테두리 — rust create_border_fill_from_json 이 borderFillId 부터 복제하므로
    // 기존 borderFillId 와 전 변을 함께 보내 지정하지 않은 변을 보존한다.
    const borderKeys = ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'] as const;
    const borderSideKey: Record<string, (typeof borderKeys)[number]> = {
      left: 'borderLeft', right: 'borderRight', top: 'borderTop', bottom: 'borderBottom',
    };
    const borderSpecs: Partial<Record<(typeof borderKeys)[number], ParaBorderSpec>> = {};
    let anyBorder = false;
    const bordersArg = args['borders'];
    if (bordersArg !== undefined && bordersArg !== null) {
      for (const [side, v] of Object.entries(asRecord(bordersArg))) {
        const key = borderSideKey[side];
        if (!key) {
          throw new AgentToolError('INVALID_ARGS', `borders.${side}: side must be left|right|top|bottom`);
        }
        const b = asRecord(v);
        const type = b['type'];
        if (typeof type !== 'number' || !Number.isSafeInteger(type) || type < 0 || type > 17) {
          throw new AgentToolError('INVALID_ARGS', `borders.${side}.type must be an integer 0..17 (0 none, 1 solid, 2 dashed, 3 dotted)`);
        }
        if (type === 0) {
          borderSpecs[key] = { type: 0, width: 0, color: '#000000' };
          anyBorder = true;
          continue;
        }
        const widthMm = b['widthMm'];
        if (typeof widthMm !== 'number' || !Number.isFinite(widthMm) || widthMm < 0.05 || widthMm > 5) {
          throw new AgentToolError('INVALID_ARGS', `borders.${side}.widthMm is required (0.1..5.0 mm, snapped to the nearest HWP width)`);
        }
        const color = b['color'];
        if (typeof color !== 'string' || !HEX_COLOR_RE.test(color)) {
          throw new AgentToolError('INVALID_ARGS', `borders.${side}.color must be "#RRGGBB"`);
        }
        borderSpecs[key] = { type, width: borderWidthIndex(widthMm), color };
        anyBorder = true;
      }
    }
    const borderSpacingMm = args['borderSpacingMm'];
    let currentProps: ParaProperties | undefined;
    if (anyBorder || (borderSpacingMm !== undefined && borderSpacingMm !== null)) {
      currentProps = this.paraPropsAt(sectionIdx, paraIdx, cell);
    }
    if (anyBorder) {
      if (currentProps?.borderFillId) props['borderFillId'] = currentProps.borderFillId;
      for (const key of borderKeys) {
        const spec = borderSpecs[key] ?? (currentProps?.[key] as ParaBorderSpec | undefined);
        if (spec) props[key] = spec;
      }
    }
    // 테두리 여백 — 내부 배열 순서는 [left, right, top, bottom] (HWPUNIT), 생략된 변은 현재값 유지
    if (borderSpacingMm !== undefined && borderSpacingMm !== null) {
      const s = asRecord(borderSpacingMm);
      const cur = currentProps?.borderSpacing ?? [0, 0, 0, 0];
      const out = [cur[0] ?? 0, cur[1] ?? 0, cur[2] ?? 0, cur[3] ?? 0];
      const sideIdx = { left: 0, right: 1, top: 2, bottom: 3 } as const;
      for (const [side, idx] of Object.entries(sideIdx)) {
        const v = s[side];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 100) {
          throw new AgentToolError('INVALID_ARGS', `borderSpacingMm.${side} must be a number within ±100`);
        }
        out[idx] = mmToHu(v);
      }
      props['borderSpacing'] = out;
    }
    const kbu = args['koreanBreakUnit'];
    if (kbu !== undefined && kbu !== null) {
      const v = ({ word: 0, char: 1 } as Record<string, number>)[kbu as string];
      if (v === undefined) {
        throw new AgentToolError('INVALID_ARGS', 'koreanBreakUnit must be word|char');
      }
      props['koreanBreakUnit'] = v;
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
      throw new AgentToolError('INVALID_ARGS', 'At least one paragraph format key is required (alignment/lineSpacingPercent/lineSpacingType+lineSpacingPt/spaceBeforePt/spaceAfterPt/indentPt/marginLeftPt/marginRightPt/pageBreakBefore/tabStops/borders/borderSpacingMm/koreanBreakUnit/headType/numberingId/paraLevel/bulletChar)');
    }
    const obj: ObjectOp = {
      type: 'paraFormat', sectionIdx, paraIdx,
      ...(cell ? { cell } : {}),
      propsJson: JSON.stringify(props), prevParaShapeId: -1, charOffset: 0,
      textSample: this.paraTextSample(sectionIdx, paraIdx, cell),
    };
    const revBefore = this.revision;
    const r = this.deps.pending.addObjectOp(agent, obj);
    const anchorPara = cell ? cell.paraIdx : paraIdx;
    this.recordJournal(revBefore, sectionIdx, anchorPara, anchorPara, 0);
    return {
      revision: this.revision, changeSetId: r.changeSetId, applied: true,
      ...(paraShift !== 0 ? { rebasedParaShift: paraShift } : {}),
      // 앵커 쓰기는 해석된 대상 문단 주소를 돌려준다 (position 은 이미 반영됨).
      ...(anchor ? { anchor: { sectionIdx, paraIdx, ...(cell ? { cell: { paraIdx: cell.paraIdx, controlIdx: cell.controlIdx, cellIdx: cell.cellIdx } } : {}) } } : {}),
    };
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

    // 문단마다 전체 재조판이 돌지 않도록 배치로 묶는다 — 조판/이벤트/오버레이는
    // 구간 종료 시 한 번씩, 중간 실패 시 문단 일부만 적용된 상태가 남지 않는다.
    let changeSetId = '';
    const revBefore = this.revision;
    this.deps.pending.runAtomicBatch(() => {
      for (let p = startParaIdx; p <= endParaIdx; p++) {
        const obj: ObjectOp = {
          type: 'paraFormat', sectionIdx, paraIdx: p,
          propsJson: JSON.stringify({ headType, numberingId, paraLevel: level }),
          prevParaShapeId: -1, charOffset: 0,
          textSample: this.paraTextSample(sectionIdx, p),
        };
        changeSetId = this.deps.pending.addObjectOp(agent, obj).changeSetId;
      }
    });
    this.recordJournal(revBefore, sectionIdx, startParaIdx, endParaIdx, 0);
    return {
      revision: this.revision,
      changeSetId,
      numberingId,
      paragraphs: endParaIdx - startParaIdx + 1,
    };
  }

  // ─── 객체 툴 (Phase 2: 그림/수식) ──────────────────────────

  private insertImage(
    args: Record<string, unknown>, agent: AgentName, capability?: ToolCapabilityContext,
  ): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    const cell = optCell(args);
    this.validateAddress(sectionIdx, paraIdx, charOffset, cell);
    const floating = imageFloatingProps(args);
    const afterObjects = args['afterObjects'] === true;
    for (const k of ['widthMm', 'heightMm'] as const) {
      const v = args[k];
      if (v !== undefined && v !== null && (typeof v !== 'number' || !(v > 0) || v > 500)) {
        throw new AgentToolError('INVALID_ARGS', `${k} must be a positive number <= 500`);
      }
    }
    const cropPx = optCropPx(args);
    const b64 = reqString(args, 'imageBase64');
    const rawExt = typeof args['extension'] === 'string' ? args['extension'].toLowerCase().replace('jpeg', 'jpg') : undefined;
    if (rawExt !== undefined && !IMAGE_MIME_BY_EXTENSION[rawExt]) {
      throw new AgentToolError('INVALID_ARGS', 'extension must be png|jpg|gif|bmp');
    }
    const sourceMime = typeof args['mimeType'] === 'string'
      ? args['mimeType']
      : rawExt ? IMAGE_MIME_BY_EXTENSION[rawExt] : undefined;
    if (!sourceMime) throw new AgentToolError('INVALID_ARGS', 'extension is required with imageBase64');
    // 잘라내기나 삽입 불가 형식(WebP 참조)은 캔버스로 다시 인코딩한다
    const viaCanvas = cropPx !== undefined || rawExt === undefined;
    if (b64.length > (viaCanvas ? CROP_SOURCE_MAX_B64 : IMAGE_MAX_B64)) {
      throw new AgentToolError('INVALID_ARGS', 'image too large — max 5MB');
    }
    const bytes = decodeBase64(b64, 'imageBase64');
    const place = { sectionIdx, paraIdx, charOffset, cell, floating, afterObjects };
    if (!viaCanvas) {
      const naturalWidthPx = reqInt(args, 'naturalWidthPx');
      const naturalHeightPx = reqInt(args, 'naturalHeightPx');
      if (naturalWidthPx < 1 || naturalHeightPx < 1) {
        throw new AgentToolError('INVALID_ARGS', 'naturalWidthPx/naturalHeightPx must be positive');
      }
      return this.stageImage(args, agent, place, { bytes, extension: rawExt!, naturalWidthPx, naturalHeightPx });
    }
    const crop = this.deps.cropImage ?? cropImageOnCanvas;
    return (async () => {
      const out = await crop({
        bytes, mimeType: sourceMime, cropPx,
        output: sourceMime === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      });
      if (out.bytes.length > IMAGE_MAX_BYTES) {
        throw new AgentToolError('INVALID_ARGS', 'the cropped image is larger than 5MB; crop a smaller region');
      }
      assertToolRequestActive(capability);
      // await 동안 사용자가 편집했을 수 있다 — 삽입 직전 revision/주소를 재검증한다
      this.requireRevision(args);
      this.validateAddress(sectionIdx, paraIdx, charOffset, cell);
      return this.stageImage(args, agent, place, {
        bytes: out.bytes,
        extension: out.mimeType === 'image/jpeg' ? 'jpg' : 'png',
        naturalWidthPx: out.widthPx,
        naturalHeightPx: out.heightPx,
        cropPx: out.crop,
      });
    })();
  }

  /** 크기 결정 + insertImage 객체 op 등록 (insert_image 의 동기/잘라내기 경로 공통) */
  private stageImage(
    args: Record<string, unknown>,
    agent: AgentName,
    place: {
      sectionIdx: number; paraIdx: number; charOffset: number; cell?: CellAddr;
      floating?: Record<string, unknown>; afterObjects: boolean;
    },
    image: { bytes: Uint8Array; extension: string; naturalWidthPx: number; naturalHeightPx: number; cropPx?: PixelBox },
  ): unknown {
    const { sectionIdx, paraIdx, charOffset, cell, floating, afterObjects } = place;
    const { naturalWidthPx, naturalHeightPx } = image;
    // 크기 결정: mm 지정 > 자연 크기(96dpi, 1px = 75HU), 본문 폭 초과 시 축소 (셀은 엔진이 셀 폭으로 다시 줄인다)
    const widthMm = args['widthMm'];
    const heightMm = args['heightMm'];
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
      ...(cell ? { cell } : {}),
      bytes: image.bytes, extension: image.extension,
      widthHu, heightHu, naturalWidthPx, naturalHeightPx, description,
      ...(afterObjects ? { afterObjects } : {}),
      ...(floating ? { floating } : {}),
    };
    const r = this.stageObjectOp(agent, obj, sectionIdx, paraIdx);
    const staged = r.obj as Extract<ObjectOp, { type: 'insertImage' }>;
    const anchor = staged.anchor!;
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      image: {
        paraIdx: cell ? paraIdx : anchor.paraIdx,
        controlIdx: anchor.controlIdx,
        widthMm: Math.round((staged.widthHu / HU_PER_MM) * 10) / 10,
        heightMm: Math.round((staged.heightHu / HU_PER_MM) * 10) / 10,
        ...(floating ? { positionMode: 'floating' } : {}),
      },
      ...(image.cropPx ? { cropPx: image.cropPx } : {}),
    };
  }

  /** read_reference_image cropPx/zoom — 허브가 넘긴 원본을 잘라 확대한다 (1.15MP 이내) */
  private async readReferenceImage(args: Record<string, unknown>): Promise<unknown> {
    const b64 = reqString(args, 'imageBase64');
    if (b64.length > CROP_SOURCE_MAX_B64) throw new AgentToolError('INVALID_ARGS', 'reference image is too large');
    const mimeType = reqString(args, 'mimeType');
    const zoom = args['zoom'] ?? 1;
    if (typeof zoom !== 'number' || !(zoom >= 1) || zoom > 4) {
      throw new AgentToolError('INVALID_ARGS', 'zoom must be 1..4');
    }
    const crop = this.deps.cropImage ?? cropImageOnCanvas;
    const out = await crop({
      bytes: decodeBase64(b64, 'imageBase64'), mimeType, cropPx: optCropPx(args), zoom,
      maxPixels: REFERENCE_READ_MAX_PIXELS,
      output: mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    });
    return {
      ...(typeof args['fileId'] === 'string' ? { fileId: args['fileId'] } : {}),
      ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
      image: { data: bytesToBase64(out.bytes), mimeType: out.mimeType },
      widthPx: out.widthPx,
      heightPx: out.heightPx,
      cropPx: out.crop,
      zoom: out.scale,
    };
  }

  private insertEquation(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    const cell = optCell(args);
    this.validateAddress(sectionIdx, paraIdx, charOffset, cell);
    const { script, fontSizeHu, fontSizePt, colorRef, preview } =
      this.validateEquationArgs(args, { sectionIdx, paraIdx, charOffset, ...(cell ? { cell } : {}) });
    const obj: ObjectOp = {
      type: 'insertEquation', sectionIdx, paraIdx, charOffset,
      ...(cell ? { cell } : {}),
      script, fontSizeHu, colorRef,
    };
    const r = this.stageObjectOp(agent, obj, sectionIdx, cell ? cell.paraIdx : paraIdx);
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
      diagnostics: preview.diagnostics,
    };
  }

  /**
   * 그림/도형의 종류와 현재 속성. 셀 안 개체는 셀 문단 좌표(paraIdx)와 그 문단 안
   * 인덱스(controlIdx)로 가리키고 경로 API 로 읽는다.
   */
  private readEditableObject(
    sectionIdx: number, paraIdx: number, controlIdx: number, cell?: CellAddr,
  ): { kind: ObjectKind; props: Record<string, unknown> } {
    const { wasm } = this.deps;
    const path = cell ? objectCellPath(cell, paraIdx) : null;
    const read = (kind: ObjectKind): Record<string, unknown> => (path
      ? kind === 'picture'
        ? wasm.getCellPicturePropertiesByPath(sectionIdx, cell!.paraIdx, path, controlIdx)
        : wasm.getCellShapePropertiesByPath(sectionIdx, cell!.paraIdx, path, controlIdx)
      : kind === 'picture'
        ? wasm.getPictureProperties(sectionIdx, paraIdx, controlIdx)
        : wasm.getShapeProperties(sectionIdx, paraIdx, controlIdx)) as unknown as Record<string, unknown>;
    for (const kind of ['picture', 'shape'] as const) {
      try {
        return { kind, props: read(kind) };
      } catch { /* 다음 종류로 */ }
    }
    throw new AgentToolError(
      'INVALID_ARGS',
      `No picture or shape at section ${sectionIdx}, paragraph ${paraIdx}, controlIdx ${controlIdx}${cell ? ' in that cell' : ''} — get_page_geometry objects carry their addresses`,
    );
  }

  private editObject(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const controlIdx = reqInt(args, 'controlIdx');
    const cell = optCell(args);
    this.validateAddress(sectionIdx, paraIdx, undefined, cell);
    const { kind, props: current } = this.readEditableObject(sectionIdx, paraIdx, controlIdx, cell);
    const at = { sectionIdx, paraIdx, controlIdx, ...(cell ? { cell } : {}) };
    const hostPara = cell ? cell.paraIdx : paraIdx;
    if (args['delete'] !== undefined && args['delete'] !== null) {
      if (args['delete'] !== true) throw new AgentToolError('INVALID_ARGS', 'delete must be true');
      const extra = EDIT_OBJECT_ARG_KEYS.filter((key) => args[key] !== undefined && args[key] !== null);
      if (extra.length > 0) throw new AgentToolError('INVALID_ARGS', `delete cannot be combined with ${extra.join('/')}`);
      if (cell && kind === 'shape') throw new AgentToolError('INVALID_ARGS', 'shapes inside table cells cannot be deleted');
      const description = typeof current['description'] === 'string' ? current['description'] : '';
      const obj: ObjectOp = {
        type: 'deleteObject', kind, ...at,
        removedText: description || (kind === 'picture' ? '그림' : '도형'),
      };
      const r = this.stageObjectOp(agent, obj, sectionIdx, hostPara);
      return {
        revision: this.revision,
        changeSetId: r.changeSetId,
        deleted: { kind, sectionIdx, paraIdx, controlIdx },
        note: 'later objects in the same paragraph moved down one controlIdx.',
      };
    }
    const plan = planObjectEdit(args, kind, current);
    if (plan.zOrder && (cell || (plan.props['treatAsChar'] ?? current['treatAsChar']) === true)) {
      throw new AgentToolError('INVALID_ARGS', 'zOrder applies to floating objects in the body — make it floating first');
    }
    const obj: ObjectOp = {
      type: 'editObject', kind, ...at,
      props: plan.props, prevProps: plan.prevProps,
      ...(plan.zOrder ? { zOrder: plan.zOrder } : {}),
    };
    const r = this.stageObjectOp(agent, obj, sectionIdx, hostPara);
    const staged = r.obj as Extract<ObjectOp, { type: 'editObject' }>;
    let after = current;
    try {
      after = this.readEditableObject(sectionIdx, staged.paraIdx, staged.controlIdx, staged.cell).props;
    } catch { /* 적용 전 값으로 보고한다 */ }
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      object: { sectionIdx, paraIdx: staged.paraIdx, controlIdx: staged.controlIdx, ...describeObject(kind, after) },
    };
  }

  private insertShape(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = optInt(args, 'charOffset', 0);
    if (args['cell'] !== undefined || args['cellPath'] !== undefined) {
      throw new AgentToolError('INVALID_ARGS', 'insert_shape places shapes in body paragraphs only');
    }
    this.validateAddress(sectionIdx, paraIdx, charOffset);
    const plan = planInsertShape(args, { sectionIdx, paraIdx, charOffset });
    const obj: ObjectOp = {
      type: 'insertShape', shape: plan.shape, sectionIdx, paraIdx, charOffset,
      create: plan.create, props: plan.props,
    };
    const r = this.stageObjectOp(agent, obj, sectionIdx, paraIdx);
    const anchor = (r.obj as Extract<ObjectOp, { type: 'insertShape' }>).anchor!;
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      shape: { sectionIdx, paraIdx: anchor.paraIdx, controlIdx: anchor.controlIdx },
      // 글상자 글은 셀 주소로 쓴다 — 안쪽 문단은 paraIdx 0 부터
      ...(plan.shape === 'textBox' ? {
        textBox: {
          cell: { paraIdx: anchor.paraIdx, controlIdx: anchor.controlIdx, cellIdx: 0 },
          cellPath: [{ controlIndex: anchor.controlIdx, cellIndex: 0, cellParaIndex: 0 }],
        },
      } : {}),
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
    const fatal = fatalEquationDiagnostics(preview);
    if (fatal.length > 0) {
      throw new AgentToolError('INVALID_SCRIPT', fatal.map(diagnostic => diagnostic.message).join('; '));
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
  private async insertChart(
    args: Record<string, unknown>,
    agent: AgentName,
    capability?: ToolCapabilityContext,
  ): Promise<unknown> {
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
    assertToolRequestActive(capability);
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
    const r = this.stageObjectOp(agent, obj, sectionIdx, paraIdx);
    const anchor = (r.obj as Extract<ObjectOp, { type: 'insertImage' }>).anchor!;
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      chart: { paraIdx: anchor.paraIdx, controlIdx: anchor.controlIdx, widthMm, heightMm },
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
    return { revision: this.revision, changeSetId: r.changeSetId, applied: true, pageCount: this.deps.wasm.pageCount };
  }

  private editHeaderFooter(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const { wasm } = this.deps;
    if (sectionIdx < 0 || sectionIdx >= wasm.getSectionCount()) {
      throw new AgentToolError('INVALID_ARGS', `sectionIdx ${sectionIdx} out of range`);
    }

    // 내용 인자: lines[] (한 항목 = 한 문단). 구형 `text` 는 한 줄짜리 lines 로 읽는다.
    let lines: string[] | undefined;
    const linesArg = args['lines'];
    if (linesArg !== undefined && linesArg !== null) {
      if (!Array.isArray(linesArg) || linesArg.length > 32
        || linesArg.some((l) => typeof l !== 'string' || l.length > 500 || /[\r\n]/.test(l as string))) {
        throw new AgentToolError('INVALID_ARGS', 'lines must be an array of up to 32 single-line strings of at most 500 chars');
      }
      lines = linesArg as string[];
    } else if (typeof args['text'] === 'string') {
      const text = args['text'];
      if (text.length > 500 || /[\r\n]/.test(text)) {
        throw new AgentToolError('INVALID_ARGS', 'text must be a single line of at most 500 chars');
      }
      lines = [text];
    }

    // 쪽번호 문단: {template, align}. 구형 문자열 'left'|'center'|'right' 도 받는다.
    let pageNumber: { template: string; align: 'left' | 'center' | 'right' | 'outside' } | undefined;
    const pnArg = args['pageNumber'];
    if (typeof pnArg === 'string') {
      if (!['left', 'center', 'right'].includes(pnArg)) {
        throw new AgentToolError('INVALID_ARGS', 'pageNumber must be {template, align} or "left"|"center"|"right"');
      }
      pageNumber = { template: '{n}', align: pnArg as 'left' | 'center' | 'right' };
    } else if (pnArg !== undefined && pnArg !== null) {
      const rec = asRecord(pnArg);
      const template = rec['template'] ?? '{n}';
      const align = rec['align'] ?? 'center';
      if (typeof template !== 'string' || template.length > 500 || /[\r\n]/.test(template)) {
        throw new AgentToolError('INVALID_ARGS', 'pageNumber.template must be a single line of at most 500 chars');
      }
      if (!template.includes('{n}') && !template.includes('{total}')) {
        throw new AgentToolError('INVALID_ARGS', 'pageNumber.template must contain {n} (and may contain {total})');
      }
      if (!['left', 'center', 'right', 'outside'].includes(align as string)) {
        throw new AgentToolError('INVALID_ARGS', 'pageNumber.align must be "left"|"center"|"right"|"outside"');
      }
      pageNumber = { template, align: align as 'left' | 'center' | 'right' | 'outside' };
    }

    const startPageNumber = args['startPageNumber'];
    if (startPageNumber !== undefined && startPageNumber !== null
      && (typeof startPageNumber !== 'number' || !Number.isSafeInteger(startPageNumber)
        || startPageNumber < 0 || startPageNumber > 32767)) {
      throw new AgentToolError('INVALID_ARGS', 'startPageNumber must be an integer 0..32767 (0 = continue)');
    }

    const hasHfContent = lines !== undefined || pageNumber !== undefined;
    if (!hasHfContent && startPageNumber === undefined) {
      throw new AgentToolError('INVALID_ARGS', 'at least one of lines, pageNumber or startPageNumber is required');
    }

    const isHeader = args['which'] === undefined ? undefined : reqString(args, 'which') === 'header';
    if (hasHfContent) {
      if (args['which'] !== 'header' && args['which'] !== 'footer') {
        throw new AgentToolError('INVALID_ARGS', 'which must be "header" or "footer"');
      }
    }
    const applyToArg = args['applyTo'] ?? 'both';
    if (applyToArg !== 'both' && applyToArg !== 'odd' && applyToArg !== 'even') {
      throw new AgentToolError('INVALID_ARGS', 'applyTo must be "both"|"odd"|"even"');
    }

    // 엔진 HeaderFooterApply: 0=Both, 1=Even, 2=Odd
    const ENGINE_APPLY = { both: 0, even: 1, odd: 2 } as const;
    const outside = pageNumber?.align === 'outside';
    const alignFor = (scope: 'both' | 'odd' | 'even'): 'left' | 'center' | 'right' => {
      const a = pageNumber?.align ?? 'center';
      if (a !== 'outside') return a;
      return scope === 'even' ? 'left' : 'right'; // 바깥쪽: 홀수=오른쪽, 짝수=왼쪽
    };
    // 'outside' 는 양쪽 스코프 쌍으로만 표현할 수 있다 — 홀수 오른쪽 + 짝수 왼쪽
    const scopes: Array<'both' | 'odd' | 'even'> = outside && applyToArg === 'both'
      ? ['odd', 'even']
      : [applyToArg as 'both' | 'odd' | 'even'];

    const hfExists = (isHdr: boolean, apply: number): boolean => {
      try {
        const raw = JSON.parse(wasm.getHeaderFooter(sectionIdx, isHdr, apply)) as { exists?: boolean };
        return raw?.exists === true;
      } catch {
        return false;
      }
    };

    const ops: ObjectOp[] = [];
    const notes: string[] = [];
    if (hasHfContent) {
      const isHdr = isHeader === true;
      for (const scope of scopes) {
        const applyTo = ENGINE_APPLY[scope];
        const existedBefore = hfExists(isHdr, applyTo);
        const align = alignFor(scope);
        ops.push({
          type: 'headerFooter', sectionIdx, isHeader: isHdr, applyTo,
          lines: lines ?? [],
          ...(pageNumber ? { pageNumber: { template: pageNumber.template, align } } : {}),
          existedBefore,
        });
        if (existedBefore) notes.push(`the existing ${scope === 'both' ? '' : `${scope}-page `}${isHdr ? 'header' : 'footer'} was replaced.`);
      }
      // 형제 스코프 컨트롤이 남아 있으면 엔진 우선순위(홀/짝 전용 > 양쪽)로 나란히 그려진다
      const written = new Set(scopes.map((s) => ENGINE_APPLY[s]));
      const siblings = ([0, 1, 2] as const).filter((a) => !written.has(a) && hfExists(isHdr, a));
      if (siblings.length > 0) {
        const names = siblings.map((a) => a === 0 ? 'both-pages' : a === 1 ? 'even-page' : 'odd-page').join('/');
        notes.push(`this section also has a ${names} ${isHdr ? 'header' : 'footer'} that stays — odd/even-specific controls win over both-pages ones on their pages.`);
      }
    }
    if (startPageNumber !== undefined && startPageNumber !== null) {
      const prev = wasm.getSectionDef(sectionIdx) as unknown as Record<string, unknown>;
      ops.push({
        type: 'pageLayout', sectionIdx,
        sectionDef: { prev, next: { ...prev, pageNum: startPageNumber } },
      });
      notes.push(`page numbering now starts at ${startPageNumber}.`);
    }

    const stage = () => {
      let changeSetId = '';
      for (const obj of ops) changeSetId = this.deps.pending.addObjectOp(agent, obj).changeSetId;
      return changeSetId;
    };
    const changeSetId = ops.length === 1
      ? stage()
      : this.deps.pending.runAtomicBatch(stage);
    return {
      revision: this.revision,
      changeSetId,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
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
    const r = this.stageObjectOp(agent, obj, sectionIdx, paraIdx);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      pageCount: this.deps.wasm.pageCount,
      note: `page now breaks before paragraph ${paraIdx}.`,
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
    const sectionIdx = reqInt(args, 'sectionIdx');
    let paraIdx = reqInt(args, 'paraIdx');
    const styleId = reqInt(args, 'styleId');
    const cell = optCell(args);
    const shift = this.requireRevisionRebasable(args, sectionIdx, cell ? cell.paraIdx : paraIdx, cell ? cell.paraIdx : paraIdx);
    if (cell) cell.paraIdx += shift;
    else paraIdx += shift;
    this.validateAddress(sectionIdx, paraIdx, undefined, cell);
    if (!this.deps.wasm.getStyleList().some((s) => s.id === styleId)) {
      throw new AgentToolError('INVALID_ARGS', `styleId ${styleId} not found — use list_styles`);
    }
    const obj: ObjectOp = {
      type: 'applyStyle', sectionIdx, paraIdx, ...(cell ? { cell } : {}), styleId, charOffset: 0,
      textSample: this.paraTextSample(sectionIdx, paraIdx, cell),
    };
    const revBefore = this.revision;
    const r = this.deps.pending.addObjectOp(agent, obj);
    const anchorPara = cell ? cell.paraIdx : paraIdx;
    this.recordJournal(revBefore, sectionIdx, anchorPara, anchorPara, 0);
    return {
      revision: this.revision, changeSetId: r.changeSetId,
      ...(shift !== 0 ? { rebasedParaShift: shift } : {}),
    };
  }
}
