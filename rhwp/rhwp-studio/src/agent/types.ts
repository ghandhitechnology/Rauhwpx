/**
 * Agent bridge shared types (Pair-Editing Phase 1).
 *
 * Normative shapes shared by the studio bridge (bridge.ts / tool-executor.ts /
 * revision.ts), the pending-edit manager (pending-edits.ts / pending-overlay.ts)
 * and the sidebar UI (ui/agent-sidebar/). Wire shapes mirror the rhwp-agent hub
 * protocol v2.
 */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { DocumentDirtyState } from '../core/document-dirty-state.ts';

export const AGENT_PROTOCOL_VERSION = 2;

export type AgentName = 'claude' | 'codex';
export type PermissionProfile = 'safe' | 'unrestricted';
export type WritingStyleLanguage = 'ko' | 'en';
export type AgentWorkflow = 'direct' | 'plan';
export type AgentPhase = 'direct' | 'planning' | 'awaiting-approval' | 'switching' | 'implementing';

/** 에이전트 참고자료의 수명 범위. 파일 본문은 허브가 보관하며 브라우저에는 메타데이터만 둔다. */
export type ReferenceScope = 'chat' | 'document' | 'global';
export type ReferenceFileStatus = 'uploading' | 'extracting' | 'indexing' | 'ready' | 'error';

export interface ReferenceFile {
  id: string;
  scope: ReferenceScope;
  scopeId: string;
  name: string;
  mimeType: string;
  size: number;
  status: ReferenceFileStatus;
  createdAt: string;
  sha256?: string;
  chunkCount?: number;
  error?: string;
}

export interface ReferenceSearchHit {
  referenceId: string;
  name: string;
  scope: ReferenceScope;
  scopeId: string;
  score: number;
  snippet: string;
  chunkIndex?: number;
  chunkId?: string;
  page?: number | null;
}

export interface ReferenceScopeContext {
  threadId: string;
  documentId: string | null;
  documentName?: string | null;
}

export interface StructuredPlanStep {
  title: string;
  details: string;
  files?: string[];
}

/** Server-authored plan. Its epoch is descriptive; capabilityEpoch is the write authority. */
export interface StructuredPlan {
  planId: string;
  title: string;
  goal: string;
  summary: string;
  assumptions: string[];
  decisions: string[];
  steps: StructuredPlanStep[];
  files: string[];
  validation: string[];
  risks: string[];
  exclusions: string[];
  createdAt: string;
  epoch: number;
}

export interface AgentWorkflowState {
  workflow: AgentWorkflow;
  phase: AgentPhase;
  /** null means the server did not provide a usable capability epoch. */
  capabilityEpoch: number | null;
  latestPlan: StructuredPlan | null;
}

export function isAgentWorkflow(value: unknown): value is AgentWorkflow {
  return value === 'direct' || value === 'plan';
}

export function isAgentPhase(value: unknown): value is AgentPhase {
  return value === 'direct'
    || value === 'planning'
    || value === 'awaiting-approval'
    || value === 'switching'
    || value === 'implementing';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isStructuredPlan(value: unknown): value is StructuredPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  return typeof plan['planId'] === 'string'
    && typeof plan['title'] === 'string'
    && typeof plan['goal'] === 'string'
    && typeof plan['summary'] === 'string'
    && isStringArray(plan['assumptions'])
    && isStringArray(plan['decisions'])
    && Array.isArray(plan['steps'])
    && plan['steps'].every((step) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
      const item = step as Record<string, unknown>;
      return typeof item['title'] === 'string'
        && typeof item['details'] === 'string'
        && (item['files'] === undefined || isStringArray(item['files']));
    })
    && isStringArray(plan['files'])
    && isStringArray(plan['validation'])
    && isStringArray(plan['risks'])
    && isStringArray(plan['exclusions'])
    && typeof plan['createdAt'] === 'string'
    && typeof plan['epoch'] === 'number'
    && Number.isSafeInteger(plan['epoch'])
    && plan['epoch'] >= 0;
}

export interface WritingStyleStatus {
  active: boolean;
  language: WritingStyleLanguage;
  updatedAt: string | null;
  sourceCount: number;
  pageEstimate: number;
  summary: string;
}

export interface WritingStyleUpload {
  name: string;
  type: string;
  size: number;
  content: string;
}

export interface ProductSkillFile {
  path: string;
  size?: number;
  encoding?: 'utf8' | 'base64';
  content?: string;
}

export interface ProductSkill {
  name: string;
  description: string;
  origin: 'bundled' | 'user';
  enabled: boolean;
  invalid?: boolean;
  hasScripts: boolean;
  hasAssets: boolean;
  fileCount: number;
  files: ProductSkillFile[];
}

export interface SkillCatalog {
  revision: number;
  skills: ProductSkill[];
}

export class AgentToolError extends Error {
  // 파라미터 프로퍼티 대신 명시적 할당 (node --test strip-only 모드 호환).
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AgentToolError';
  }
}

/** 하위 CLI(claude/codex) JSONL을 허브가 정규화한 단일 이벤트 스트림 (§1.5). */
export type AgentStreamEvent =
  | { type: 'turn-start'; agent: AgentName }
  | { type: 'session-info'; agent: AgentName; sessionId: string; model?: string; mcpStatus?: string }
  | { type: 'text-delta'; agent: AgentName; text: string }
  | { type: 'tool-call'; agent: AgentName; callId: string; tool: string; argsJson: string }
  | { type: 'tool-result'; agent: AgentName; callId: string; ok: boolean; resultPreview: string }
  | { type: 'turn-end'; agent: AgentName; stopReason?: string; errorMessage?: string }
  | { type: 'error'; agent: AgentName; message: string };

export type SidebarEvent =
  | { type: 'connection'; state: 'connecting' | 'connected' | 'disconnected' | 'replaced' }
  | {
      type: 'chat-started';
      agent: AgentName;
      sessionId: string | null;
      model?: string;
      effort?: string;
      permissionProfile?: PermissionProfile;
      threadId?: string;
      documentId?: string | null;
      documentName?: string | null;
      workflow: AgentWorkflow;
      phase: AgentPhase;
      capabilityEpoch: number | null;
      latestPlan: StructuredPlan | null;
    }
  | { type: 'chat-stopped' }
  | { type: 'permission-changed'; permissionProfile: PermissionProfile }
  | ({ type: 'workflow-changed' } & AgentWorkflowState)
  | ({ type: 'plan-ready'; plan: StructuredPlan } & AgentWorkflowState)
  | ({ type: 'plan-approved'; planId: string } & AgentWorkflowState)
  | ({ type: 'plan-invalidated'; planId: string | null; reason?: string } & AgentWorkflowState)
  | ({ type: 'implementation-started'; planId: string } & AgentWorkflowState)
  | { type: 'skills-catalog'; catalog: SkillCatalog }
  | { type: 'skill-detail'; requestId: string; revision: number; skill: ProductSkill }
  | { type: 'skill-saved'; requestId: string; revision: number; skill: ProductSkill }
  | { type: 'skill-validated'; requestId: string; result: { valid: boolean; name: string; warnings: string[]; hasScripts: boolean; hasAssets: boolean; fileCount: number } }
  | { type: 'skill-deleted'; requestId: string; name: string; recoverable: boolean }
  | { type: 'skill-draft-progress'; requestId: string; state: 'generating' }
  | { type: 'skill-draft-result'; requestId: string; draft: { name: string; files: Array<{ path: string; content: string }> } }
  | { type: 'skills-error'; requestId: string; code: string; message: string }
  | { type: 'writing-style-status'; requestId: string; status: WritingStyleStatus }
  | { type: 'writing-style-progress'; requestId: string; state: 'reading' | 'analyzing' | 'saving' }
  | { type: 'writing-style-result'; requestId: string; status: WritingStyleStatus }
  | { type: 'writing-style-error'; requestId: string; code: string; message: string }
  | {
      type: 'title-result';
      requestId: string;
      threadId: string;
      title: string | null;
    }
  | { type: 'agent'; event: AgentStreamEvent }
  | { type: 'hub-error'; code: string; message: string };

export interface AgentBridgeDeps {
  wasm: WasmBridge;
  eventBus: EventBus;
  inputHandler: InputHandler;
  canvasView: CanvasView;
  documentState: DocumentDirtyState;
}

export interface AgentBridgeOptions {
  url?: string;
  token?: string;
}

export interface DocPoint {
  paraIdx: number;
  charOffset: number;
}

/**
 * 표 셀 주소 (최상위 표만 — 중첩 표는 Phase-1 범위 밖).
 * paraIdx = 표 컨트롤을 담은 본문 문단, cellIdx = flat 셀 인덱스.
 */
export interface CellAddr {
  paraIdx: number;
  controlIdx: number;
  cellIdx: number;
}

export function sameCell(a: CellAddr | undefined, b: CellAddr | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.paraIdx === b.paraIdx && a.controlIdx === b.controlIdx && a.cellIdx === b.cellIdx;
}

export interface DocRange {
  sectionIdx: number;
  /** 존재하면 startParaIdx/endParaIdx 는 이 셀 내부 문단 인덱스다 */
  cell?: CellAddr;
  startParaIdx: number;
  startCharOffset: number;
  endParaIdx: number;
  endCharOffset: number;
}

export interface CharFormatProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** pt*100 (HwpUnit) */
  fontSize?: number;
  /** '#RRGGBB' */
  textColor?: string;
  /** findOrCreateFontId 로 해석된 숫자 id (fontFamily 는 executor 에서 변환) */
  fontId?: number;
}

/** 표 등 컨트롤 앵커 — replay 후 재바인딩된다 */
export interface ObjectAnchor {
  paraIdx: number;
  controlIdx: number;
  /** 앵커 문단 내 삽입 지점 (shiftPoint 통과용; 모르면 0) */
  charOffset: number;
}

/**
 * 객체 연산 (Pair-Editing Phase 2). 데이터 전용 — apply/revert/verify 는
 * pending-edits 의 switch 가 수행한다.
 *
 * 분류(설계 리뷰 확정):
 * - applied-now(즉시 적용, reject 시 역연산): createTable(treatAsChar 경로),
 *   insertImage, insertEquation, tableStructure(insert_row/col), paraFormat, pageLayout,
 *   headerFooter(신규 생성일 때)
 * - mark-only(approve 시 적용): tableStructure(delete_row/col/merge_cells),
 *   setCellProps, setTableProps, applyStyle, headerFooter(기존 HF 수정)
 */
export type ObjectOp =
  | {
      type: 'createTable';
      sectionIdx: number; paraIdx: number; charOffset: number;
      rows: number; cols: number;
      colWidthsHu?: number[];
      headerRow: boolean; headerBold: boolean; headerFill?: string;
      cells?: string[][];
      anchor?: ObjectAnchor;
      /** 드리프트 프로브 기준 크기 — 같은 pending 상태의 구조 op 이 적용/되돌려질 때 갱신 */
      expectedRows?: number;
      expectedCols?: number;
    }
  | {
      type: 'insertImage';
      sectionIdx: number; paraIdx: number; charOffset: number;
      bytes: Uint8Array; extension: string;
      widthHu: number; heightHu: number;
      naturalWidthPx: number; naturalHeightPx: number;
      description: string;
      anchor?: ObjectAnchor;
    }
  | {
      type: 'insertEquation';
      sectionIdx: number; paraIdx: number; charOffset: number;
      /** 존재하면 paraIdx 는 이 셀 내부 문단 인덱스, anchor.controlIdx 는 셀 문단 내 수식 인덱스 */
      cell?: CellAddr;
      script: string; fontSizeHu: number; colorRef: number;
      anchor?: ObjectAnchor;
    }
  | {
      type: 'tableStructure';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      op: 'insert_row' | 'insert_col';
      index: number; after: boolean;
      /** 적용 후 역연산용 삽입 결과 인덱스 (after ? index+1 : index) */
      insertedIndex?: number;
      /** 드리프트 프로브용 적용 직후 크기 */
      dims?: { rowCount: number; colCount: number };
    }
  | {
      type: 'tableStructureMarked';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      op: 'delete_row' | 'delete_col' | 'merge_cells';
      rowIdx?: number; colIdx?: number;
      startRow?: number; startCol?: number; endRow?: number; endCol?: number;
      /** 마크 시점 크기 — 드리프트 프로브 */
      dims: { rowCount: number; colCount: number };
    }
  | {
      type: 'setCellProps';
      sectionIdx: number; tableParaIdx: number; controlIdx: number; cellIdx: number;
      props: Record<string, unknown>;
      dims: { rowCount: number; colCount: number };
    }
  | {
      type: 'setTableProps';
      sectionIdx: number; tableParaIdx: number; controlIdx: number;
      props: Record<string, unknown>;
      dims: { rowCount: number; colCount: number };
    }
  | {
      type: 'paraFormat';
      sectionIdx: number; paraIdx: number; cell?: CellAddr;
      propsJson: string;
      /** applied-now 역연산: 문단별 이전 para_shape_id */
      prevParaShapeId: number;
      charOffset: number;
      /** 드리프트 프로브용 문단 텍스트 지문 (등록 시점 앞 24자) */
      textSample?: string;
    }
  | {
      type: 'applyStyle';
      sectionIdx: number; paraIdx: number; cell?: CellAddr;
      styleId: number;
      charOffset: number;
      /** 드리프트 프로브용 문단 텍스트 지문 (등록 시점 앞 24자) */
      textSample?: string;
    }
  | {
      type: 'pageLayout';
      sectionIdx: number;
      pageDef?: { next: Record<string, unknown>; prev: Record<string, unknown> };
      columns?: {
        next: { columnCount: number; columnType: number; sameWidth: number; spacing: number };
        prev: { columnCount: number; columnType: number; sameWidth: number; spacing: number };
      };
    }
  | {
      type: 'headerFooter';
      sectionIdx: number; isHeader: boolean; applyTo: number;
      text: string;
      /** 'left'|'center'|'right' 위치의 쪽 번호 필드 추가 */
      pageNumber?: string;
      /** false = 이 op 이 HF 를 생성했다 (reject 시 삭제) */
      existedBefore: boolean;
    };

/** applied-now 인지 mark-only 인지 — 분류는 op 데이터에서 유도된다 */
export function isObjectOpApplied(obj: ObjectOp): boolean {
  switch (obj.type) {
    case 'createTable':
    case 'insertImage':
    case 'insertEquation':
    case 'tableStructure':
    case 'paraFormat':
    case 'pageLayout':
      return true;
    case 'headerFooter':
      return !obj.existedBefore;
    default:
      return false;
  }
}

/** 이 객체 op 이 해당 표에 대한 파괴적 마크인가 (executor 가드용) */
export function isDestructiveTableMark(
  obj: ObjectOp, sectionIdx: number, tableParaIdx: number, controlIdx: number,
): boolean {
  return obj.type === 'tableStructureMarked'
    && obj.sectionIdx === sectionIdx
    && obj.tableParaIdx === tableParaIdx
    && obj.controlIdx === controlIdx;
}

export type PendingOp =
  | {
      kind: 'insert'; id: string; agent: AgentName; range: DocRange; text: string;
      /** 전역 등록 순번 — 중첩 검증·스냅샷 되돌림 안전 판별용 (pending-edits 가 부여) */
      seq?: number;
    } // applied
  | {
      kind: 'delete'; id: string; agent: AgentName; range: DocRange; text: string;
      seq?: number;
    } // marked only
  | {
      /** 원자적 교체 — 삭제+삽입을 하나의 op 로 즉시 적용 (live preview) */
      kind: 'replace';
      id: string;
      agent: AgentName;
      /** 삽입된 새 텍스트가 차지하는 범위 (shift 로 추적된다) */
      range: DocRange;
      /** 새 텍스트 */
      text: string;
      /** 원본 텍스트 — 되돌림 복원/검증 기준 */
      deletedText: string;
      /** 원본 시작 지점 글자 모양 id (삽입 서식 + 폴백 되돌림용) */
      charShapeId: number | null;
      /** 원본 문단별 paraShapeId (폴백 되돌림용, -1 = 캡처 실패) */
      paraShapeIds: number[];
      /** 변이 직전 스냅샷 — 되돌림 시 원본을 정확히 복원하는 소스 */
      snapshotId: number | null;
      /**
       * 스냅샷을 찍은 시점의 사용자(비-에이전트) 편집 카운터. 되돌림 시점 값과
       * 다르면 스냅샷 복원이 그 사용자 편집을 지우므로 역연산 폴백을 쓴다.
       */
      userEditSeqAtSnapshot?: number;
      seq?: number;
    } // applied
  | {
      kind: 'format';
      id: string;
      agent: AgentName;
      range: DocRange;
      format: CharFormatProps;
      inverse: CharFormatProps;
      /** 되돌림 전 드리프트 프로브용 등록 시점 범위 텍스트 (캡처 실패 시 생략) */
      text?: string;
      seq?: number;
    } // applied
  | {
      kind: 'field'; id: string; agent: AgentName; name: string; oldValue: string; newValue: string;
      seq?: number;
    } // applied
  | { kind: 'object'; id: string; agent: AgentName; obj: ObjectOp; seq?: number }; // applied 여부는 isObjectOpApplied(obj)

export type ChangeSetStatus = 'open' | 'awaiting-review';

export interface PendingChangeSet {
  id: string;
  agent: AgentName;
  status: ChangeSetStatus;
  ops: PendingOp[];
  createdAt: number;
}

export type PendingEditsChangeEvent =
  | { type: 'ops-changed' }
  | { type: 'set-finalized'; changeSetId: string }
  | { type: 'approved'; changeSetId: string }
  | { type: 'rejected'; changeSetId: string }
  | { type: 'invalidated'; reason: string };
