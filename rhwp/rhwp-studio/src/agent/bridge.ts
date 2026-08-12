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
import { PendingRequestRegistry } from './pending-requests.ts';
import { AgentTypewriterReveal } from './typewriter-reveal.ts';
import {
  AGENT_PROTOCOL_VERSION,
  AgentToolError,
  isAgentPhase,
  isAgentWorkflow,
  isStructuredPlan,
} from './types.ts';
import type {
  AgentBridgeDeps,
  AgentBridgeOptions,
  AgentName,
  AgentPhase,
  AgentWorkflow,
  AgentWorkflowState,
  PermissionProfile,
  ProductSkillFile,
  ProviderHealth,
  ProviderStatusMap,
  ProviderUsage,
  StructuredPlan,
  UsageModelBreakdown,
  UsageSummary,
  UsageWindow,
  WritingStyleLanguage,
  WritingStyleUpload,
  AgentStreamEvent,
  SidebarEvent,
} from './types.ts';

export interface AgentBridge {
  readonly pendingEdits: PendingEditManager;
  getConnectionState(): 'connecting' | 'connected' | 'disconnected' | 'replaced';
  getActiveAgent(): AgentName | null;
  isTurnRunning(): boolean;
  getPermissionProfile(): PermissionProfile;
  getWorkflowState(): AgentWorkflowState;
  /** 다른 탭이 연결을 차지한 상태에서 현재 탭이 스튜디오 연결을 다시 가져온다. */
  takeOverConnection(): void;
  /** 예약된 백오프를 취소하고 즉시 다시 연결한다. 이미 연결/연결 중이면 무시. */
  reconnectNow(): void;
  /** 로컬 CLI 설치 상태. refresh=true 면 허브가 새로 프로브한다. */
  requestProviderStatus(refresh?: boolean): Promise<ProviderStatusMap | null>;
  /** 누적 사용량 요약. 응답이 없으면 null. */
  requestUsage(): Promise<UsageSummary | null>;
  /** 요금제를 바꾸고 갱신된 요약을 돌려받는다. */
  setUsagePlan(agent: AgentName, plan: string): Promise<UsageSummary | null>;
  startChat(agent: AgentName, model?: string, effort?: string, force?: boolean, permissionProfile?: PermissionProfile, workflow?: AgentWorkflow): void;
  /** 허브 세션을 폐기하고 새 채팅을 시작할 수 있게 한다. */
  stopChat(): void;
  /** gpt-5.6-luna 로 스레드 제목 생성 요청. */
  requestTitle(threadId: string, preview: string): string;
  sendUserMessage(text: string, skillName?: string): void;
  setWorkflow(workflow: AgentWorkflow): void;
  approvePlan(planId: string): void;
  requestPlanChanges(planId: string, feedback?: string): void;
  setPermissionProfile(profile: PermissionProfile): void;
  listSkills(): void;
  readSkill(name: string): string;
  validateSkill(skill: { name: string; files: ProductSkillFile[] }): string;
  saveSkill(skill: { name: string; files: ProductSkillFile[] }): string;
  setSkillEnabled(name: string, enabled: boolean): string;
  deleteSkill(name: string): string;
  generateSkillDraft(input: { goal: string; triggerExamples?: string; nonTriggerExamples?: string; resourceNotes?: string; existingSkill?: string }): string;
  requestWritingStyleStatus(): string;
  calibrateWritingStyle(input: { language: WritingStyleLanguage; files: WritingStyleUpload[] }): string;
  interrupt(): void;
  onEvent(cb: (e: SidebarEvent) => void): () => void;
  dispose(): void;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';

/** 허브가 다른 스튜디오 탭에게 자리를 내주며 보내는 close code (server.mjs와 동일 값). */
const CLOSE_CODE_REPLACED = 4000;

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

/** 요청/응답 대기 상한 — 넘기면 null 로 안착한다(던지지 않는다). */
const REQUEST_TIMEOUT_MS = 10_000;

function isAgentName(v: unknown): v is AgentName {
  return v === 'claude' || v === 'codex';
}

function readCapabilityEpoch(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readProviderHealth(value: unknown): ProviderHealth {
  const src = (value ?? {}) as Record<string, unknown>;
  return {
    available: src['available'] === true,
    version: typeof src['version'] === 'string' ? src['version'] : null,
    error: typeof src['error'] === 'string' ? src['error'] : null,
    checkedAt: num(src['checkedAt']),
  };
}

/** 허브가 보낸 provider-status 를 항상 두 프로바이더가 있는 형태로 정규화한다. */
function readProviderStatus(value: unknown): ProviderStatusMap {
  const src = (value ?? {}) as Record<string, unknown>;
  return {
    claude: readProviderHealth(src['claude']),
    codex: readProviderHealth(src['codex']),
  };
}

function readUsageWindow(value: unknown): UsageWindow {
  const src = (value ?? {}) as Record<string, unknown>;
  return {
    turns: num(src['turns']),
    inputTokens: num(src['inputTokens']),
    outputTokens: num(src['outputTokens']),
    cacheReadTokens: num(src['cacheReadTokens']),
    cacheCreationTokens: num(src['cacheCreationTokens']),
    weightedTokens: num(src['weightedTokens']),
    percent: nullableNum(src['percent']),
  };
}

function readUsageByModel(value: unknown): Record<string, UsageModelBreakdown> {
  const out: Record<string, UsageModelBreakdown> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    const src = (raw ?? {}) as Record<string, unknown>;
    out[model] = {
      turns: num(src['turns']),
      inputTokens: num(src['inputTokens']),
      outputTokens: num(src['outputTokens']),
      weightedTokens: num(src['weightedTokens']),
    };
  }
  return out;
}

function readProviderUsage(value: unknown): ProviderUsage {
  const src = (value ?? {}) as Record<string, unknown>;
  const limit = (src['limit'] ?? {}) as Record<string, unknown>;
  return {
    session: readUsageWindow(src['session']),
    day: readUsageWindow(src['day']),
    week: readUsageWindow(src['week']),
    byModel: readUsageByModel(src['byModel']),
    limit: {
      session5h: nullableNum(limit['session5h']),
      week: nullableNum(limit['week']),
    },
    updatedAt: nullableNum(src['updatedAt']),
  };
}

function readUsageSummary(value: unknown): UsageSummary | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const plans = (src['plans'] ?? {}) as Record<string, unknown>;
  const providers = (src['providers'] ?? {}) as Record<string, unknown>;
  return {
    plans: {
      claude: typeof plans['claude'] === 'string' ? plans['claude'] : 'pro',
      codex: typeof plans['codex'] === 'string' ? plans['codex'] : 'plus',
    },
    providers: {
      claude: readProviderUsage(providers['claude']),
      codex: readProviderUsage(providers['codex']),
    },
  };
}

class AgentBridgeImpl implements AgentBridge {
  readonly pendingEdits: PendingEditManager;

  private revision: RevisionTracker;
  private overlay: PendingOverlayRenderer;
  private reveal: AgentTypewriterReveal;
  private revealUnsub: (() => void) | null = null;
  private executor: AgentToolExecutor;

  private url: string;
  private token: string;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  /** 지금까지 실패한 연결 시도 수. 연결이 열리면 0 으로 돌아간다. */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private requests = new PendingRequestRegistry();
  private disposed = false;

  private listeners = new Set<(e: SidebarEvent) => void>();
  private selectedAgent: AgentName = 'claude';
  private selectedModel: string | null = null;
  private selectedEffort: string | null = null;
  private permissionProfile: PermissionProfile = 'safe';
  private workflow: AgentWorkflow = 'direct';
  private phase: AgentPhase = 'direct';
  private capabilityEpoch: number | null = null;
  private latestPlan: StructuredPlan | null = null;
  private activeAgent: AgentName | null = null;
  private turnRunning = false;
  private pendingTurnOpen = false;
  private pendingChatStart: {
    agent: AgentName;
    model?: string;
    effort?: string;
    permissionProfile?: PermissionProfile;
    workflow: AgentWorkflow;
    force?: boolean;
  } | null = null;
  private queuedMessages: Array<{ text: string; skillName?: string }> = [];
  private titleRequestSeq = 0;
  private requestSeq = 0;

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
    this.reveal = new AgentTypewriterReveal({
      canvasView: deps.canvasView,
      wasm: deps.wasm,
      eventBus: deps.eventBus,
    });
    // 승인/거절/무효화 시 진행 중인 타자기 공개를 즉시 완료한다 — 커버가
    // 사라진 op 위에 남지 않도록.
    this.revealUnsub = this.pendingEdits.onChange((e) => {
      if (e.type === 'approved' || e.type === 'rejected' || e.type === 'invalidated') {
        this.reveal.finishAll();
      }
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

  /** 백오프를 접고 지금 붙는다 — takeover(다른 탭)와 수동 재연결이 공유한다. */
  private connectImmediately(): void {
    if (this.disposed || this.state === 'connected' || this.state === 'connecting') return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.connect();
  }

  takeOverConnection(): void {
    this.connectImmediately();
  }

  reconnectNow(): void {
    this.connectImmediately();
  }

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
      this.reconnectAttempt++;
      this.setState('disconnected');
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
          v: AGENT_PROTOCOL_VERSION,
          type: 'chat-start',
          agent: pending.agent,
          workflow: pending.workflow,
          ...(pending.model ? { model: pending.model } : {}),
          ...(pending.effort ? { effort: pending.effort } : {}),
          ...(pending.permissionProfile ? { permissionProfile: pending.permissionProfile } : {}),
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
      // 응답을 기다리던 요청은 연결과 함께 사라진다 — null 로 닫아 UI 가 멈추지 않게.
      this.requests.cancelAll();
      if (ev.code === CLOSE_CODE_REPLACED) {
        // 다른 탭이 허브를 차지했다. 자동 재접속하면 서로 끝없이 밀어내므로
        // 이 탭이 다시 포커스를 받을 때까지 대기한다(마지막 활성 탭 우선).
        this.setState('replaced');
        return;
      }
      this.reconnectAttempt++;
      this.setState('disconnected');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose가 뒤따르므로 재접속은 거기서 처리한다.
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const step = Math.min(
      Math.max(0, this.reconnectAttempt - 1),
      RECONNECT_DELAYS_MS.length - 1,
    );
    const delay = RECONNECT_DELAYS_MS[step]!;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // 사이드바가 "n초 후 재시도" 를 셀 수 있도록 남은 시간을 함께 알린다.
    this.emitConnection(delay);
  }

  /** 재시도 계기(시도 횟수·남은 시간)를 실은 connection 이벤트. */
  private emitConnection(retryInMs?: number): void {
    this.emit({
      type: 'connection',
      state: this.state,
      attempt: this.reconnectAttempt,
      ...(retryInMs !== undefined ? { retryInMs } : {}),
    });
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitConnection();
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

  private workflowState() {
    return {
      workflow: this.workflow,
      phase: this.phase,
      capabilityEpoch: this.capabilityEpoch,
      latestPlan: this.latestPlan,
    };
  }

  private resetWorkflowState(workflow: AgentWorkflow = 'direct') {
    this.workflow = workflow;
    this.phase = workflow === 'plan' ? 'planning' : 'direct';
    this.capabilityEpoch = null;
    this.latestPlan = null;
  }

  private syncWorkflowState(
    source: Record<string, unknown>,
    fallbackWorkflow: AgentWorkflow,
    fallbackPhase: AgentPhase,
    preservePlan = false,
  ) {
    this.workflow = isAgentWorkflow(source['workflow']) ? source['workflow'] : fallbackWorkflow;
    this.phase = this.workflow === 'direct'
      ? 'direct'
      : (isAgentPhase(source['phase']) ? source['phase'] : fallbackPhase);
    this.capabilityEpoch = readCapabilityEpoch(source['capabilityEpoch']);
    const hasPlan = Object.prototype.hasOwnProperty.call(source, 'latestPlan')
      || Object.prototype.hasOwnProperty.call(source, 'plan');
    if (hasPlan) {
      const candidate = source['latestPlan'] ?? source['plan'];
      this.latestPlan = isStructuredPlan(candidate) ? candidate : null;
    } else if (!preservePlan) {
      this.latestPlan = null;
    }
  }

  private canStagePendingEdits() {
    return this.workflow === 'direct' || this.phase === 'implementing';
  }

  private beginPendingTurn(agent: AgentName) {
    if (this.pendingTurnOpen || !this.canStagePendingEdits()) return;
    this.pendingEdits.beginTurn(agent);
    this.pendingTurnOpen = true;
  }

  private endPendingTurn() {
    if (!this.pendingTurnOpen) return;
    try {
      this.pendingEdits.endTurn();
    } finally {
      this.pendingTurnOpen = false;
    }
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
        v: AGENT_PROTOCOL_VERSION,
        type: 'protocol-error',
        code: 'UNSUPPORTED_VERSION',
        message: `Unsupported protocol version: ${msg.v}`,
        supportedVersions: [AGENT_PROTOCOL_VERSION],
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
        const wasRunning = this.turnRunning;
        if (session && isAgentName(session.agent)) {
          this.activeAgent = session.agent;
          this.turnRunning = session.status === 'running';
          this.permissionProfile = session.permissionProfile === 'unrestricted' ? 'unrestricted' : 'safe';
          this.syncWorkflowState(session, 'direct', 'direct');
          if (this.turnRunning) {
            try {
              this.beginPendingTurn(session.agent);
            } catch (e) {
              console.warn('[AgentBridge] reconnect beginTurn 실패:', e);
            }
          } else if (this.pendingTurnOpen) {
            try {
              this.endPendingTurn();
            } catch (e) {
              console.warn('[AgentBridge] reconnect endTurn 실패:', e);
            }
          }
        } else {
          this.activeAgent = null;
          this.turnRunning = false;
          if (this.pendingTurnOpen) {
            try {
              this.endPendingTurn();
            } catch (e) {
              console.warn('[AgentBridge] reconnect endTurn 실패:', e);
            }
          }
          this.resetWorkflowState();
        }
        this.emit({ type: 'workflow-changed', ...this.workflowState() });
        if (wasRunning && !this.turnRunning) {
          // 연결이 끊긴 사이에 끝난 턴 — 잃어버린 turn-end 를 합성해 UI 를 되돌린다.
          if (this.pendingTurnOpen) {
            try {
              this.endPendingTurn();
            } catch (e) {
              console.warn('[AgentBridge] endTurn 실패:', e);
            }
          }
          // setState 는 상태가 같으면 무시하므로 직접 emit 해 사이드바가
          // isTurnRunning() 으로 재동기화하도록 한다.
          this.emitConnection();
        }
        break;
      }
      case 'chat-started': {
        if (isAgentName(msg.agent)) this.activeAgent = msg.agent;
        if (typeof msg.model === 'string') this.selectedModel = msg.model;
        if (typeof msg.effort === 'string') this.selectedEffort = msg.effort;
        if (msg.permissionProfile === 'safe' || msg.permissionProfile === 'unrestricted') this.permissionProfile = msg.permissionProfile;
        this.syncWorkflowState(msg, 'direct', 'direct');
        this.emit({
          type: 'chat-started',
          agent: isAgentName(msg.agent) ? msg.agent : this.selectedAgent,
          sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
          ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
          ...(typeof msg.effort === 'string' ? { effort: msg.effort } : {}),
          permissionProfile: this.permissionProfile,
          ...this.workflowState(),
        });
        this.flushQueuedMessages();
        break;
      }
      case 'chat-permission-changed': {
        if (msg.permissionProfile === 'safe' || msg.permissionProfile === 'unrestricted') {
          this.permissionProfile = msg.permissionProfile;
          this.emit({ type: 'permission-changed', permissionProfile: this.permissionProfile });
        }
        break;
      }
      case 'workflow-changed': {
        this.syncWorkflowState(msg, 'direct', 'planning');
        this.emit({ type: 'workflow-changed', ...this.workflowState() });
        break;
      }
      case 'plan-ready': {
        if (!isStructuredPlan(msg.plan)) {
          this.emit({ type: 'hub-error', code: 'INVALID_PLAN', message: 'The hub sent an invalid structured plan.' });
          break;
        }
        this.syncWorkflowState(msg, 'plan', 'awaiting-approval');
        this.latestPlan = msg.plan;
        this.emit({ type: 'plan-ready', plan: msg.plan, ...this.workflowState() });
        break;
      }
      case 'plan-approved': {
        this.syncWorkflowState(msg, 'plan', 'switching', true);
        const planId = typeof msg.planId === 'string' ? msg.planId : (this.latestPlan?.planId ?? '');
        this.emit({ type: 'plan-approved', planId, ...this.workflowState() });
        break;
      }
      case 'plan-invalidated': {
        this.syncWorkflowState(msg, 'plan', 'planning', true);
        this.emit({
          type: 'plan-invalidated',
          planId: typeof msg.planId === 'string' ? msg.planId : (this.latestPlan?.planId ?? null),
          ...(typeof msg.reason === 'string' ? { reason: msg.reason } : {}),
          ...this.workflowState(),
        });
        break;
      }
      case 'implementation-started': {
        this.syncWorkflowState(msg, 'plan', 'implementing', true);
        const planId = typeof msg.planId === 'string' ? msg.planId : (this.latestPlan?.planId ?? '');
        this.emit({ type: 'implementation-started', planId, ...this.workflowState() });
        break;
      }
      case 'skills-catalog': {
        this.emit({ type: 'skills-catalog', catalog: { revision: Number(msg.revision ?? 0), skills: Array.isArray(msg.skills) ? msg.skills : [] } });
        break;
      }
      case 'skill-detail':
        this.emit({ type: 'skill-detail', requestId: String(msg.requestId ?? ''), revision: Number(msg.revision ?? 0), skill: msg.skill });
        break;
      case 'skill-saved':
        this.emit({ type: 'skill-saved', requestId: String(msg.requestId ?? ''), revision: Number(msg.revision ?? 0), skill: msg.skill });
        break;
      case 'skill-validated':
        this.emit({ type: 'skill-validated', requestId: String(msg.requestId ?? ''), result: msg.result });
        break;
      case 'skill-deleted':
        this.emit({ type: 'skill-deleted', requestId: String(msg.requestId ?? ''), name: String(msg.name ?? ''), recoverable: Boolean(msg.recoverable) });
        break;
      case 'skill-draft-progress':
        this.emit({ type: 'skill-draft-progress', requestId: String(msg.requestId ?? ''), state: 'generating' });
        break;
      case 'skill-draft-result':
        this.emit({ type: 'skill-draft-result', requestId: String(msg.requestId ?? ''), draft: msg.draft });
        break;
      case 'skills-error':
        this.emit({ type: 'skills-error', requestId: String(msg.requestId ?? ''), code: String(msg.code ?? 'SKILLS_ERROR'), message: String(msg.message ?? 'Skill request failed') });
        break;
      case 'writing-style-status':
        this.emit({ type: 'writing-style-status', requestId: String(msg.requestId ?? ''), status: msg.status });
        break;
      case 'writing-style-progress':
        if (msg.state === 'reading' || msg.state === 'analyzing' || msg.state === 'saving') {
          this.emit({ type: 'writing-style-progress', requestId: String(msg.requestId ?? ''), state: msg.state });
        }
        break;
      case 'writing-style-result':
        this.emit({ type: 'writing-style-result', requestId: String(msg.requestId ?? ''), status: msg.status });
        break;
      case 'writing-style-error':
        this.emit({ type: 'writing-style-error', requestId: String(msg.requestId ?? ''), code: String(msg.code ?? 'CALIBRATION_FAILED'), message: String(msg.message ?? 'Writing-style calibration failed') });
        break;
      case 'provider-status': {
        const providers = readProviderStatus(msg.providers);
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, providers);
        this.emit({ type: 'provider-status', providers });
        break;
      }
      case 'usage-report': {
        const usage = readUsageSummary(msg.usage);
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, usage);
        if (usage) this.emit({ type: 'usage-report', usage });
        break;
      }
      case 'usage-error':
      case 'provider-error': {
        // 사용량·프로브는 부수 정보다 — 실패는 던지지 않고 "모름(null)" 으로 닫는다.
        if (typeof msg.requestId === 'string') this.requests.settle(msg.requestId, null);
        console.warn('[AgentBridge]', msg.type + ':', msg.code, msg.message);
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
          this.beginPendingTurn(event.agent);
        } catch (e) {
          console.warn('[AgentBridge] beginTurn 실패:', e);
        }
        break;
      case 'turn-end':
        this.turnRunning = false;
        if (this.pendingTurnOpen) {
          try {
            this.endPendingTurn();
          } catch (e) {
            console.warn('[AgentBridge] endTurn 실패:', e);
          }
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
      .execute(tool, args, agent, {
        workflow: this.workflow,
        phase: msg.phase,
        capabilityEpoch: msg.capabilityEpoch,
        activePhase: this.phase,
        activeCapabilityEpoch: this.capabilityEpoch,
      })
      .then((result) => {
        this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'tool-response', id, ok: true, result });
      })
      .catch((e: unknown) => {
        const error =
          e instanceof AgentToolError
            ? { code: e.code, message: e.message }
            : { code: 'RPC_ERROR', message: e instanceof Error ? e.message : String(e) };
        this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'tool-response', id, ok: false, error });
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

  getPermissionProfile(): PermissionProfile {
    return this.permissionProfile;
  }

  getWorkflowState() {
    return this.workflowState();
  }

  startChat(
    agent: AgentName,
    model?: string,
    effort?: string,
    force = false,
    permissionProfile: PermissionProfile = this.permissionProfile,
    workflow: AgentWorkflow = 'direct',
  ): void {
    this.selectedAgent = agent;
    if (model) this.selectedModel = model;
    if (effort) this.selectedEffort = effort;
    this.permissionProfile = permissionProfile;
    this.resetWorkflowState(workflow);
    const payload = {
      v: AGENT_PROTOCOL_VERSION,
      type: 'chat-start' as const,
      agent,
      workflow,
      ...(this.selectedModel ? { model: this.selectedModel } : {}),
      ...(this.selectedEffort ? { effort: this.selectedEffort } : {}),
      permissionProfile: this.permissionProfile,
      ...(force ? { force: true } : {}),
    };
    if (this.state === 'connected') {
      this.sendJson(payload);
    } else {
      this.pendingChatStart = {
        agent,
        model: this.selectedModel ?? undefined,
        effort: this.selectedEffort ?? undefined,
        permissionProfile: this.permissionProfile,
        workflow,
        force,
      };
    }
  }

  stopChat(): void {
    this.queuedMessages = [];
    this.pendingChatStart = null;
    this.activeAgent = null;
    this.turnRunning = false;
    // Full access is deliberately scoped to one live chat and never becomes
    // the default for a new or reopened thread.
    this.permissionProfile = 'safe';
    this.resetWorkflowState();
    if (this.state === 'connected') {
      this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-stop' });
    }
    this.emit({ type: 'chat-stopped' });
  }

  requestTitle(threadId: string, preview: string): string {
    const requestId = `title-${++this.titleRequestSeq}`;
    if (this.state === 'connected') {
      this.sendJson({
        v: AGENT_PROTOCOL_VERSION,
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

  sendUserMessage(text: string, skillName?: string): void {
    if (this.activeAgent === null) {
      this.queuedMessages.push({ text, skillName });
      if (this.state === 'connected') {
        this.sendJson({
          v: AGENT_PROTOCOL_VERSION,
          type: 'chat-start',
          agent: this.selectedAgent,
          workflow: this.workflow,
          ...(this.selectedModel ? { model: this.selectedModel } : {}),
          ...(this.selectedEffort ? { effort: this.selectedEffort } : {}),
          permissionProfile: this.permissionProfile,
        });
      } else {
        this.pendingChatStart = {
          agent: this.selectedAgent,
          model: this.selectedModel ?? undefined,
          effort: this.selectedEffort ?? undefined,
          permissionProfile: this.permissionProfile,
          workflow: this.workflow,
        };
      }
      return;
    }
    if (this.queuedMessages.length > 0) {
      this.queuedMessages.push({ text, skillName });
      this.flushQueuedMessages();
      return;
    }
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-user-message', text, ...(skillName ? { skillName } : {}) });
  }

  private flushQueuedMessages(): void {
    if (this.state !== 'connected') return;
    const queued = this.queuedMessages;
    this.queuedMessages = [];
    for (const message of queued) {
      this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-user-message', text: message.text, ...(message.skillName ? { skillName: message.skillName } : {}) });
    }
  }

  setWorkflow(workflow: AgentWorkflow): void {
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-workflow-set', workflow });
  }

  approvePlan(planId: string): void {
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-plan-approve', planId });
  }

  requestPlanChanges(planId: string, feedback?: string): void {
    this.sendJson({
      v: AGENT_PROTOCOL_VERSION,
      type: 'chat-plan-request-changes',
      planId,
      ...(feedback ? { feedback } : {}),
    });
  }

  setPermissionProfile(profile: PermissionProfile): void {
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-permission-set', permissionProfile: profile });
  }

  listSkills(): void {
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skills-list', requestId: `skills-${++this.requestSeq}` });
  }

  readSkill(name: string): string {
    const requestId = `skill-read-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-read', requestId, name });
    return requestId;
  }

  saveSkill(skill: { name: string; files: ProductSkillFile[] }): string {
    const requestId = `skill-save-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-save', requestId, skill });
    return requestId;
  }

  validateSkill(skill: { name: string; files: ProductSkillFile[] }): string {
    const requestId = `skill-validate-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-validate', requestId, skill });
    return requestId;
  }

  setSkillEnabled(name: string, enabled: boolean): string {
    const requestId = `skill-enable-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-enable', requestId, name, enabled });
    return requestId;
  }

  deleteSkill(name: string): string {
    const requestId = `skill-delete-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-delete', requestId, name });
    return requestId;
  }

  generateSkillDraft(input: { goal: string; triggerExamples?: string; nonTriggerExamples?: string; resourceNotes?: string; existingSkill?: string }): string {
    const requestId = `skill-draft-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'skill-draft-request', requestId, agent: this.selectedAgent, model: this.selectedModel, ...input });
    return requestId;
  }

  requestWritingStyleStatus(): string {
    const requestId = `writing-style-status-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'writing-style-status-request', requestId });
    return requestId;
  }

  calibrateWritingStyle(input: { language: WritingStyleLanguage; files: WritingStyleUpload[] }): string {
    const requestId = `writing-style-calibration-${++this.requestSeq}`;
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'writing-style-calibrate', requestId, ...input });
    return requestId;
  }

  interrupt(): void {
    this.sendJson({ v: AGENT_PROTOCOL_VERSION, type: 'chat-interrupt' });
  }

  /**
   * 요청 하나를 대기표에 올리고 보낸다. 오프라인이거나 전송이 실패하면
   * 곧바로 null 로 안착한다 — 호출자는 언제나 값 또는 null 만 본다.
   */
  private request<T>(payload: Record<string, unknown> & { type: string }, prefix: string): Promise<T | null> {
    if (this.state !== 'connected') return Promise.resolve(null);
    const requestId = `${prefix}-${++this.requestSeq}`;
    const promise = this.requests.create<T>(requestId, REQUEST_TIMEOUT_MS);
    const sent = this.sendJson({ v: AGENT_PROTOCOL_VERSION, requestId, ...payload });
    if (!sent) this.requests.settle(requestId, null);
    return promise;
  }

  requestProviderStatus(refresh = false): Promise<ProviderStatusMap | null> {
    return this.request<ProviderStatusMap>(
      { type: 'provider-status-request', ...(refresh ? { refresh: true } : {}) },
      'provider-status',
    );
  }

  requestUsage(): Promise<UsageSummary | null> {
    return this.request<UsageSummary>({ type: 'usage-request' }, 'usage');
  }

  setUsagePlan(agent: AgentName, plan: string): Promise<UsageSummary | null> {
    return this.request<UsageSummary>({ type: 'usage-plan-set', agent, plan }, 'usage-plan');
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
    this.requests.cancelAll();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // 이미 닫힌 소켓은 무시.
    }
    this.listeners.clear();
    this.revealUnsub?.();
    this.revealUnsub = null;
    this.reveal.dispose();
    this.pendingEdits.dispose();
    this.overlay.dispose();
    this.revision.dispose();
  }
}

export function initAgentBridge(deps: AgentBridgeDeps, opts?: AgentBridgeOptions): AgentBridge {
  return new AgentBridgeImpl(deps, opts);
}
