/**
 * 스튜디오 ↔ rhwp-agent 허브 WebSocket 브리지.
 *
 * role=studio로 허브(ws://127.0.0.1:5175/studio)에 접속해:
 *  - 허브의 tool-request를 AgentToolExecutor로 실행하고 tool-response로 응답
 *  - agent-event 스트림을 사이드바용 SidebarEvent로 중계
 *  - turn-start/turn-end로 PendingEditManager의 change-set 수명주기를 구동
 * 접속이 끊기면 1s → 2s → 5s → 10s 백오프로 무한 재시도한다.
 */
import { RevisionTracker } from './revision.ts';
import { AgentToolExecutor } from './tool-executor.ts';
import { PendingEditManager } from './pending-edits.ts';
import { PendingOverlayRenderer } from './pending-overlay.ts';
import { AGENT_PROTOCOL_VERSION, AgentToolError } from './types.ts';
import type {
  AgentBridgeDeps,
  AgentBridgeOptions,
  AgentName,
  AgentStreamEvent,
  SidebarEvent,
} from './types.ts';

export interface AgentBridge {
  readonly pendingEdits: PendingEditManager;
  getConnectionState(): 'connecting' | 'connected' | 'disconnected' | 'replaced';
  getActiveAgent(): AgentName | null;
  isTurnRunning(): boolean;
  startChat(agent: AgentName, model?: string, effort?: string, force?: boolean): void;
  /** 허브 세션을 폐기하고 새 채팅을 시작할 수 있게 한다. */
  stopChat(): void;
  /** gpt-5.6-luna 로 스레드 제목 생성 요청. */
  requestTitle(threadId: string, preview: string): string;
  sendUserMessage(text: string): void;
  interrupt(): void;
  onEvent(cb: (e: SidebarEvent) => void): () => void;
  dispose(): void;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';

/** 허브가 다른 스튜디오 탭에게 자리를 내주며 보내는 close code (server.mjs와 동일 값). */
const CLOSE_CODE_REPLACED = 4000;

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

function isAgentName(v: unknown): v is AgentName {
  return v === 'claude' || v === 'codex';
}

class AgentBridgeImpl implements AgentBridge {
  readonly pendingEdits: PendingEditManager;

  private revision: RevisionTracker;
  private overlay: PendingOverlayRenderer;
  private executor: AgentToolExecutor;

  private url: string;
  private token: string;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private listeners = new Set<(e: SidebarEvent) => void>();
  private selectedAgent: AgentName = 'claude';
  private selectedModel: string | null = null;
  private selectedEffort: string | null = null;
  private activeAgent: AgentName | null = null;
  private turnRunning = false;
  private pendingChatStart: {
    agent: AgentName;
    model?: string;
    effort?: string;
    force?: boolean;
  } | null = null;
  private queuedMessages: string[] = [];
  private titleRequestSeq = 0;

  constructor(deps: AgentBridgeDeps, opts?: AgentBridgeOptions) {
    this.revision = new RevisionTracker(deps.eventBus);
    this.overlay = new PendingOverlayRenderer({
      canvasView: deps.canvasView,
      wasm: deps.wasm,
      eventBus: deps.eventBus,
    });
    this.pendingEdits = new PendingEditManager({
      wasm: deps.wasm,
      eventBus: deps.eventBus,
      inputHandler: deps.inputHandler,
      canvasView: deps.canvasView,
      overlay: this.overlay,
    });
    this.executor = new AgentToolExecutor({
      wasm: deps.wasm,
      inputHandler: deps.inputHandler,
      documentState: deps.documentState,
      revision: this.revision,
      pending: this.pendingEdits,
    });

    this.url = opts?.url ?? (import.meta as any).env?.VITE_RHWP_AGENT_URL ?? 'ws://127.0.0.1:5175';
    this.token = opts?.token ?? (import.meta as any).env?.VITE_RHWP_AGENT_TOKEN ?? 'dev';
    window.addEventListener('focus', this.onWindowFocus);
    this.connect();
  }

  /** 'replaced' 상태에서 탭이 다시 활성화되면 허브 연결을 되찾는다. */
  private onWindowFocus = (): void => {
    if (this.disposed || this.state !== 'replaced') return;
    this.reconnectAttempt = 0;
    this.connect();
  };

  // ─── connection ───────────────────────────────────────────

  private connect(): void {
    if (this.disposed) return;
    const base = this.url.replace(/\/$/, '');
    const wsUrl = `${base}/studio?token=${encodeURIComponent(this.token)}`;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[AgentBridge] WebSocket 생성 실패:', e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.disposed || this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.setState('connected');
      if (this.pendingChatStart !== null) {
        const pending = this.pendingChatStart;
        this.pendingChatStart = null;
        this.sendJson({
          v: 1,
          type: 'chat-start',
          agent: pending.agent,
          ...(pending.model ? { model: pending.model } : {}),
          ...(pending.effort ? { effort: pending.effort } : {}),
          ...(pending.force ? { force: true } : {}),
        });
      }
    };
    ws.onmessage = (ev) => {
      if (this.disposed || this.ws !== ws) return;
      this.handleFrame(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.disposed) return;
      if (ev.code === CLOSE_CODE_REPLACED) {
        // 다른 탭이 허브를 차지했다. 자동 재접속하면 서로 끝없이 밀어내므로
        // 이 탭이 다시 포커스를 받을 때까지 대기한다(마지막 활성 탭 우선).
        this.setState('replaced');
        return;
      }
      this.setState('disconnected');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose가 뒤따르므로 재접속은 거기서 처리한다.
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: 'connection', state });
  }

  private sendJson(obj: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch (e) {
        console.warn('[AgentBridge] 전송 실패:', e);
      }
    }
    return false;
  }

  // ─── incoming frames ──────────────────────────────────────

  private handleFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn('[AgentBridge] 잘못된 JSON 프레임 무시');
      return;
    }
    if (msg === null || typeof msg !== 'object') return;
    if (msg.v !== AGENT_PROTOCOL_VERSION) {
      this.sendJson({
        v: 1,
        type: 'protocol-error',
        code: 'UNSUPPORTED_VERSION',
        message: `Unsupported protocol version: ${msg.v}`,
        supportedVersions: [1],
      });
      return;
    }
    try {
      this.handleMessage(msg);
    } catch (e) {
      console.warn('[AgentBridge] 메시지 처리 오류:', e);
    }
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'welcome': {
        const session = msg.session;
        if (session && isAgentName(session.agent)) {
          this.activeAgent = session.agent;
          this.turnRunning = session.status === 'running';
        } else {
          this.activeAgent = null;
          this.turnRunning = false;
        }
        break;
      }
      case 'chat-started': {
        if (isAgentName(msg.agent)) this.activeAgent = msg.agent;
        if (typeof msg.model === 'string') this.selectedModel = msg.model;
        if (typeof msg.effort === 'string') this.selectedEffort = msg.effort;
        this.emit({
          type: 'chat-started',
          agent: isAgentName(msg.agent) ? msg.agent : this.selectedAgent,
          sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
          ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
          ...(typeof msg.effort === 'string' ? { effort: msg.effort } : {}),
        });
        this.flushQueuedMessages();
        break;
      }
      case 'chat-error': {
        this.emit({
          type: 'hub-error',
          code: typeof msg.code === 'string' ? msg.code : 'RPC_ERROR',
          message: typeof msg.message === 'string' ? msg.message : 'Unknown hub error',
        });
        break;
      }
      case 'title-result': {
        this.emit({
          type: 'title-result',
          requestId: typeof msg.requestId === 'string' ? msg.requestId : '',
          threadId: typeof msg.threadId === 'string' ? msg.threadId : '',
          title: typeof msg.title === 'string' ? msg.title : null,
        });
        break;
      }
      case 'agent-event': {
        const event = msg.event as AgentStreamEvent | undefined;
        if (!event || typeof event.type !== 'string') break;
        this.handleAgentEvent(event);
        break;
      }
      case 'tool-request': {
        this.handleToolRequest(msg);
        break;
      }
      default:
        // 알 수 없는 타입은 무시 (전방 호환).
        break;
    }
  }

  private handleAgentEvent(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'turn-start':
        this.turnRunning = true;
        try {
          this.pendingEdits.beginTurn(event.agent);
        } catch (e) {
          console.warn('[AgentBridge] beginTurn 실패:', e);
        }
        break;
      case 'turn-end':
        this.turnRunning = false;
        try {
          this.pendingEdits.endTurn();
        } catch (e) {
          console.warn('[AgentBridge] endTurn 실패:', e);
        }
        break;
      case 'session-info':
        this.activeAgent = event.agent;
        break;
      default:
        break;
    }
    this.emit({ type: 'agent', event });
  }

  private handleToolRequest(msg: any): void {
    const id = msg.id;
    if (typeof id !== 'number') return;
    const tool = typeof msg.tool === 'string' ? msg.tool : '';
    const args = msg.args;
    const agent: AgentName = isAgentName(msg.agent) ? msg.agent : (this.activeAgent ?? 'claude');
    void this.executor
      .execute(tool, args, agent)
      .then((result) => {
        this.sendJson({ v: 1, type: 'tool-response', id, ok: true, result });
      })
      .catch((e: unknown) => {
        const error =
          e instanceof AgentToolError
            ? { code: e.code, message: e.message }
            : { code: 'RPC_ERROR', message: e instanceof Error ? e.message : String(e) };
        this.sendJson({ v: 1, type: 'tool-response', id, ok: false, error });
      });
  }

  // ─── outgoing API ─────────────────────────────────────────

  getConnectionState(): ConnectionState {
    return this.state;
  }

  getActiveAgent(): AgentName | null {
    return this.activeAgent;
  }

  isTurnRunning(): boolean {
    return this.turnRunning;
  }

  startChat(agent: AgentName, model?: string, effort?: string, force = false): void {
    this.selectedAgent = agent;
    if (model) this.selectedModel = model;
    if (effort) this.selectedEffort = effort;
    const payload = {
      v: 1 as const,
      type: 'chat-start' as const,
      agent,
      ...(this.selectedModel ? { model: this.selectedModel } : {}),
      ...(this.selectedEffort ? { effort: this.selectedEffort } : {}),
      ...(force ? { force: true } : {}),
    };
    if (this.state === 'connected') {
      this.sendJson(payload);
    } else {
      this.pendingChatStart = {
        agent,
        model: this.selectedModel ?? undefined,
        effort: this.selectedEffort ?? undefined,
        force,
      };
    }
  }

  stopChat(): void {
    this.queuedMessages = [];
    this.pendingChatStart = null;
    this.activeAgent = null;
    this.turnRunning = false;
    if (this.state === 'connected') {
      this.sendJson({ v: 1, type: 'chat-stop' });
    }
    this.emit({ type: 'chat-stopped' });
  }

  requestTitle(threadId: string, preview: string): string {
    const requestId = `title-${++this.titleRequestSeq}`;
    if (this.state === 'connected') {
      this.sendJson({
        v: 1,
        type: 'title-request',
        requestId,
        threadId,
        preview,
      });
    } else {
      // 오프라인이면 곧바로 폴백을 유도한다.
      queueMicrotask(() => {
        this.emit({ type: 'title-result', requestId, threadId, title: null });
      });
    }
    return requestId;
  }

  sendUserMessage(text: string): void {
    if (this.activeAgent === null) {
      this.queuedMessages.push(text);
      if (this.state === 'connected') {
        this.sendJson({
          v: 1,
          type: 'chat-start',
          agent: this.selectedAgent,
          ...(this.selectedModel ? { model: this.selectedModel } : {}),
          ...(this.selectedEffort ? { effort: this.selectedEffort } : {}),
        });
      } else {
        this.pendingChatStart = {
          agent: this.selectedAgent,
          model: this.selectedModel ?? undefined,
          effort: this.selectedEffort ?? undefined,
        };
      }
      return;
    }
    if (this.queuedMessages.length > 0) {
      this.queuedMessages.push(text);
      this.flushQueuedMessages();
      return;
    }
    this.sendJson({ v: 1, type: 'chat-user-message', text });
  }

  private flushQueuedMessages(): void {
    if (this.state !== 'connected') return;
    const queued = this.queuedMessages;
    this.queuedMessages = [];
    for (const text of queued) {
      this.sendJson({ v: 1, type: 'chat-user-message', text });
    }
  }

  interrupt(): void {
    this.sendJson({ v: 1, type: 'chat-interrupt' });
  }

  onEvent(cb: (e: SidebarEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(e: SidebarEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        console.warn('[AgentBridge] 이벤트 리스너 오류:', err);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('focus', this.onWindowFocus);
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // 이미 닫힌 소켓은 무시.
    }
    this.listeners.clear();
    this.pendingEdits.dispose();
    this.overlay.dispose();
    this.revision.dispose();
  }
}

export function initAgentBridge(deps: AgentBridgeDeps, opts?: AgentBridgeOptions): AgentBridge {
  return new AgentBridgeImpl(deps, opts);
}
