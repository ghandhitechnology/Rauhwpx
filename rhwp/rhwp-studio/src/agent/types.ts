/**
 * Agent bridge shared types (Pair-Editing Phase 1).
 *
 * Normative shapes shared by the studio bridge (bridge.ts / tool-executor.ts /
 * revision.ts), the pending-edit manager (pending-edits.ts / pending-overlay.ts)
 * and the sidebar UI (ui/agent-sidebar/). Wire shapes mirror the rhwp-agent hub
 * protocol v1.
 */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { CanvasView } from '../view/canvas-view.ts';
import type { DocumentDirtyState } from '../core/document-dirty-state.ts';

export const AGENT_PROTOCOL_VERSION = 1;

export type AgentName = 'claude' | 'codex';

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
    }
  | { type: 'chat-stopped' }
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

export interface DocRange {
  sectionIdx: number;
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
}

export type PendingOp =
  | { kind: 'insert'; id: string; agent: AgentName; range: DocRange; text: string } // applied
  | { kind: 'delete'; id: string; agent: AgentName; range: DocRange; text: string } // marked only
  | {
      kind: 'format';
      id: string;
      agent: AgentName;
      range: DocRange;
      format: CharFormatProps;
      inverse: CharFormatProps;
    } // applied
  | { kind: 'field'; id: string; agent: AgentName; name: string; oldValue: string; newValue: string }; // applied

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
