import './cloud-ui.css';
import { canChangeCloudProviderSettings } from '../../cloud/provider-settings.ts';

import type { PortableCloudTimelineV1 } from '../../cloud/timeline.ts';
import type { AgentStreamEvent, AgentWorkflow } from '../../agent/types.ts';
import type { CloudController } from '../../cloud/desktop-cloud.ts';
import { browserCloudSupported } from '../../cloud/browser-cloud.ts';
import type {
  CloudDownloadResult,
  CloudDocumentPayload,
  CloudFollowupAttachment,
  CloudCheckpointPayload,
  CloudResultAction,
  CloudResultResolution,
  CloudSessionScope,
  CloudSnapshot,
  CloudTakeoverPayload,
  CloudTransferReference,
} from '../../cloud/types.ts';
import { cloudLinkNeedsAttention, inferCloudLink } from '../../cloud/link.ts';
import { cloudLeaseBlocksLocal } from '../../cloud/editor-scope.ts';
import {
  shouldOfferAccountForceQuit,
  shouldShowCloudWorkspaceSwitch,
  type CloudWorkspaceBinding,
  type WorkspaceExecutionLock,
} from '../../cloud/workspace.ts';
import {
  runResultAuthorityTransition,
  runTakeoverAuthorityTransition,
} from '../../cloud/authority-transition.ts';
import type {
  PendingResultAuthority,
  PendingTakeoverAuthority,
} from '../../cloud/authority-transition.ts';
import {
  cloudBoundaryOperation,
  cloudPublicationOperation,
  cloudEventMatchesBinding,
  cloudTimelineBinding,
  createSessionSelectionFence,
  runCloudSessionSelection,
} from '../../cloud/session-binding.ts';
import { createCheckpointMirror } from '../../cloud/checkpoint-mirror.ts';
import { createCheckpointPublisher } from '../../cloud/checkpoint-publisher.ts';
import { createCloudOnboarding } from './cloud-onboarding.ts';
import { createCloudDashboard } from './cloud-dashboard.ts';
import { createCloudSyncIcon, createIcon } from './icons.ts';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}시간 ${minutes % 60}분`;
  if (seconds < 60) return `${Math.max(0, seconds)}초`;
  return `${minutes}분`;
}

/** Desktop IPC and the pinned HTTPS PWA transport are valid live sources. */
function cloudCapable(): boolean {
  const desktop = (globalThis as { rhwpDesktop?: { cloudGetState?: unknown } }).rhwpDesktop;
  return typeof desktop?.cloudGetState === 'function' || browserCloudSupported();
}

function sessionIsActive(snapshot: CloudSnapshot): boolean {
  return snapshot.session.kind !== 'idle'
    && snapshot.session.kind !== 'completed'
    && snapshot.session.kind !== 'failed'
    && snapshot.session.kind !== 'cancelled';
}

function cloudOwnsConversation(snapshot: CloudSnapshot): boolean {
  return snapshot.lease.owner === 'cloud';
}

function serverLabel(snapshot: CloudSnapshot): string {
  return snapshot.profile.kind === 'configured' && snapshot.profile.mode === 'app-hosted'
    ? 'Raucloud'
    : '내 서버';
}

function serverIdentity(snapshot: CloudSnapshot): string {
  if (snapshot.profile.kind !== 'configured') return '';
  if (snapshot.profile.mode === 'app-hosted') {
    return `app:${snapshot.profile.sandbox.sandboxId}:${snapshot.profile.sandbox.host}`;
  }
  const profile = snapshot.profile.profile as typeof snapshot.profile.profile & { endpoint?: string };
  const endpoint = profile.endpoint
    ?? (profile.transport.kind === 'https'
      ? profile.transport.endpoint
      : `${profile.transport.kind}:${profile.host}:${profile.tailscaleHttpsPort ?? 443}`);
  return `self:${profile.serverPublicKey ?? ''}:${endpoint}`;
}

function raucloudLock(snapshot: CloudSnapshot): string | null {
  if (snapshot.profile.kind !== 'configured' || snapshot.profile.mode !== 'app-hosted') return null;
  const gate = snapshot.account?.raucloud;
  if (!gate || gate.kind === 'available') return null;
  switch (gate.kind) {
    case 'logged-out': return 'Raucloud를 시작하려면 Rauhwpx 계정으로 로그인하세요.';
    case 'exhausted': return '오늘의 Raucloud 시간을 모두 사용했습니다. 실행 중인 응답까지만 끝낼 수 있습니다.';
    case 'active-elsewhere': return `${gate.deviceName ?? '다른 기기'}에서 Raucloud가 실행 중입니다. 서버 강제 종료로 끊을 수 있습니다.`;
    case 'unavailable': return gate.reason;
  }
}

function sessionKindLabel(kind: CloudSnapshot['session']['kind']): string {
  switch (kind) {
    case 'waiting-local-turn': return '전송 대기';
    case 'transferring': return '전송 중';
    case 'queued': return '실행 대기';
    case 'running': return '작업 중';
    case 'pausing': return '중지 요청';
    case 'suspended': return '중지됨';
    case 'taking-over': return '이어받는 중';
    case 'completed': return '완료';
    case 'failed': return '실패';
    case 'cancelled': return '취소됨';
    default: return '대기';
  }
}

export interface CloudAgentUiDeps {
  controller: CloudController;
  loginAccount?: () => Promise<{ authUrl: string } | null>;
  onRequestTransfer(): void;
  onRestartPrepared?(binding: CloudWorkspaceBinding): Promise<void>;
  onPrepareRestartConversation?(binding: CloudWorkspaceBinding): Promise<CloudTransferReference[]>;
  onRestartConversation?(binding: CloudWorkspaceBinding, document: CloudDocumentPayload, references: CloudTransferReference[]): Promise<void>;
  onCancelPendingTransfer(): void;
  getScope(): CloudSessionScope;
  onWorkspaceSwitchVisibilityChange(visible: boolean): void;
  onCloseSettings(): void;
  onLeaseChange(cloudOwned: boolean, sessionId: string | null): void;
  isCloudMode(): boolean;
  onWorkspaceLock(reason: WorkspaceExecutionLock): { release(): void };
  onBeginAuthorityTransition(): { release(): void };
  onCloudBinding(binding: CloudWorkspaceBinding | null): void;
  onTimeline(binding: CloudWorkspaceBinding, timeline: PortableCloudTimelineV1): boolean;
  onAgentEvent(binding: CloudWorkspaceBinding, event: AgentStreamEvent): void;
  onCheckpointPublished(checkpoint: CloudCheckpointPayload): void | Promise<void>;
  getCloudStartId?(threadId: string, sessionId: string): string | undefined;
  onMergeCheckpoint?(startId: string, checkpoint: CloudCheckpointPayload): Promise<boolean>;
  onResultResolved(result: CloudDownloadResult, resolution: CloudResultResolution): void | Promise<void>;
  onBeforeTakeover(): Promise<boolean>;
  onTakeover(takeover: CloudTakeoverPayload): Promise<{ documentId: string; fileName: string } | null>;
  onTakeoverSettled(
    binding: { documentId: string; fileName: string } | null,
    completed: boolean,
  ): void | Promise<void>;
  onError(message: string): void;
  onComposerSetupChange?(active: boolean): void;
}

type CloudCommandTarget = CloudWorkspaceBinding & { expectedVersion: number };
type TakeoverBinding = { documentId: string; fileName: string };

export interface CloudAgentUi {
  sidebarButton: HTMLButtonElement;
  workspaceButton: HTMLButtonElement;
  mergeButton: HTMLButtonElement;
  statusPanel: HTMLElement;
  optionsElement: HTMLElement;
  queueStrip: HTMLElement;
  recoveryStrip: HTMLElement;
  settingsElement: HTMLElement;
  getSnapshot(): CloudSnapshot;
  isCloudConversation(): boolean;
  setWaitingForLocalTurn(waiting: boolean): void;
  setWorkspaceLocked(locked: boolean): void;
  refreshLeaseScope(): Promise<boolean>;
  bindSelectedTimeline(): Promise<boolean>;
  matchesTarget(target: CloudCommandTarget): boolean;
  configure(
    selection: import('../../cloud/types.ts').CloudProviderSelection,
    target: CloudCommandTarget,
  ): Promise<void>;
  setWorkflow(
    workflow: AgentWorkflow,
    target: CloudCommandTarget,
  ): Promise<CloudCommandTarget>;
  queueMessage(
    text: string,
    messageId: string,
    attachments: CloudFollowupAttachment[] | undefined,
    target: CloudCommandTarget,
  ): Promise<void>;
  openSetup(trigger: HTMLElement): void;
  openSettings(): void;
  handleAccountEvent(event: { signedIn: boolean; error?: string }): void;
  dispose(): void;
}

export function createCloudAgentUi(deps: CloudAgentUiDeps): CloudAgentUi {
  const cloudSetupScopes = new Set<string>();
  let snapshot = deps.controller.getSnapshot();
  let panelOpen = false;
  let localTurnPending = false;
  let busy = false;
  let recoveryBusy: 'reconnecting' | 'recreating' | 'stopping' | null = null;
  let recoveryRenderKey = '';
  let panelRenderKey = '';
  let workspaceLocked = false;
  let downloadedResult: CloudDownloadResult | null = null;
  let pendingTakeover: {
    sessionId: string;
    expectedVersion: number;
    state: PendingTakeoverAuthority<CloudTakeoverPayload, TakeoverBinding>;
  } | null = null;
  let pendingResultReplace: {
    result: CloudDownloadResult;
    state: PendingResultAuthority<CloudResultResolution>;
  } | null = null;
  let appliedTimelineKey = '';
  let selectedSessionId: string | null = null;
  let selectionScope = deps.getScope();
  let mountedBinding: CloudWorkspaceBinding | null = null;
  let pendingSessionSelections = 0;
  const selectionFence = createSessionSelectionFence();
  let panelTrigger: HTMLButtonElement | null = null;
  let setupActive = false;
  const liveSequence = new Map<string, number>();
  type MergeOffer = Pick<CloudCheckpointPayload, 'sessionId' | 'documentId' | 'revision' | 'turn' | 'operationId'> & { startId?: string };
  const mergeOffers = new Map<string, MergeOffer>();
  const reviewedRevisions = new Map<string, number>();
  const mergeButton = el('button', 'ag-cloud-merge-button') as HTMLButtonElement;
  mergeButton.type = 'button';
  mergeButton.hidden = true;
  mergeButton.addEventListener('click', () => { void mergeCheckpoint(); });
  const checkpointMirror = createCheckpointMirror({
    download: (sessionId, operationId) => deps.controller.downloadCheckpoint(sessionId, operationId, !operationId && deps.onMergeCheckpoint ? 'turn' : undefined),
    apply: (checkpoint) => {
      if (checkpoint.kind !== 'turn') return;
      const { sessionId, documentId, revision, turn, operationId } = checkpoint;
      if (revision > (mergeOffers.get(sessionId)?.revision ?? -1)) {
        mergeOffers.set(sessionId, { sessionId, documentId, revision, turn, operationId,
          startId: mergeOffers.get(sessionId)?.startId ?? mergeStartId(sessionId) });
      }
      renderMergeButton();
    },
  });
  const checkpointPublisher = createCheckpointPublisher({
    publish: (sessionId, operationId) => deps.controller.publishCheckpoint(sessionId, operationId),
    apply: deps.onCheckpointPublished,
  });
  let checkpointProfileEpoch = snapshot.profileEpoch;

  const sidebarButton = el('button', 'ag-header-icon-btn ag-cloud-btn') as HTMLButtonElement;
  sidebarButton.type = 'button';
  sidebarButton.setAttribute('aria-label', '클라우드 상태');
  sidebarButton.setAttribute('aria-controls', 'ag-cloud-panel');
  sidebarButton.setAttribute('aria-expanded', 'false');
  sidebarButton.title = '클라우드 상태';
  const sidebarButtonLabel = el('span', 'ag-cloud-btn-label', 'Cloud');
  sidebarButton.append(createIcon('cloud'), sidebarButtonLabel);

  const workspaceButton = el('button', 'ag-workspace-cloud-btn') as HTMLButtonElement;
  workspaceButton.type = 'button';
  workspaceButton.setAttribute('aria-label', '클라우드 상태');
  workspaceButton.setAttribute('aria-controls', 'ag-cloud-panel');
  workspaceButton.setAttribute('aria-expanded', 'false');
  const workspaceButtonLabel = el('span', 'ag-workspace-cloud-label', 'Cloud');
  workspaceButton.append(createIcon('cloud'), workspaceButtonLabel);

  const statusPanel = el('section', 'ag-cloud-panel');
  statusPanel.id = 'ag-cloud-panel';
  statusPanel.hidden = true;
  statusPanel.setAttribute('role', 'dialog');
  statusPanel.setAttribute('aria-modal', 'false');
  statusPanel.setAttribute('aria-labelledby', 'ag-cloud-panel-title');
  const panelHead = el('header', 'ag-cloud-panel-head');
  const panelTitle = el('h2', 'ag-cloud-panel-title', 'Cloud agent');
  panelTitle.id = 'ag-cloud-panel-title';
  const panelClose = el('button', 'ag-cloud-panel-close') as HTMLButtonElement;
  panelClose.type = 'button';
  panelClose.setAttribute('aria-label', '클라우드 상태 닫기');
  panelClose.appendChild(createIcon('close'));
  panelHead.append(panelTitle, panelClose);
  const panelBody = el('div', 'ag-cloud-panel-body');
  const sessionPicker = el('label', 'ag-cloud-session-picker');
  const sessionPickerLabel = el('span', 'ag-cloud-session-picker-label', '클라우드 작업');
  const sessionSelect = el('select', 'ag-cloud-session-select') as HTMLSelectElement;
  sessionPicker.append(sessionPickerLabel, sessionSelect);
  const recovery = el('div', 'ag-cloud-recovery');
  recovery.hidden = true;
  recovery.setAttribute('role', 'status');
  recovery.setAttribute('aria-live', 'polite');
  const recoveryChip = el('span', 'ag-cloud-recovery-chip');
  recoveryChip.setAttribute('aria-hidden', 'true');
  recoveryChip.append(
    createIcon('cloudOff', 'ag-cloud-recovery-icon-off'),
    createCloudSyncIcon('ag-cloud-recovery-icon-work'),
  );
  const recoveryCopy = el('div', 'ag-cloud-recovery-copy');
  const recoveryTitle = el('div', 'ag-cloud-recovery-title');
  const recoveryDetail = el('p', 'ag-cloud-recovery-detail');
  recoveryCopy.append(recoveryTitle, recoveryDetail);
  const recoveryActions = el('div', 'ag-cloud-recovery-actions');
  recovery.append(recoveryChip, recoveryCopy, recoveryActions);
  const panelStatus = el('div', 'ag-cloud-panel-status');
  panelStatus.setAttribute('role', 'status');
  panelStatus.setAttribute('aria-live', 'polite');
  const panelDetail = el('p', 'ag-cloud-panel-detail');
  const progress = el('div', 'ag-cloud-progress');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-valuenow', '0');
  const progressFill = el('span', 'ag-cloud-progress-fill');
  progress.appendChild(progressFill);
  const panelConflict = el('div', 'ag-cloud-conflict');
  panelConflict.hidden = true;
  const optionsElement = el('div', 'ag-cloud-options');
  const panelActions = el('div', 'ag-cloud-panel-actions');
  panelBody.append(optionsElement, recovery, sessionPicker, panelStatus, panelDetail, progress, panelConflict, panelActions);
  statusPanel.append(panelHead, panelBody);

  const queueStrip = el('div', 'ag-cloud-queue-strip');
  queueStrip.hidden = true;
  queueStrip.setAttribute('role', 'status');
  queueStrip.setAttribute('aria-live', 'polite');
  const recoveryStrip = el('div', 'ag-cloud-recovery-strip');
  recoveryStrip.hidden = true;
  recoveryStrip.setAttribute('role', 'status');
  recoveryStrip.setAttribute('aria-live', 'polite');

  const onboarding = createCloudOnboarding({
    controller: deps.controller,
    loginAccount: deps.loginAccount,
    refreshSnapshot: () => deps.controller.refresh(selectedScope()),
    onRequestTransfer: deps.onRequestTransfer,
    onCloseSettings: deps.onCloseSettings,
    onSetupStateChange: (active) => {
      setupActive = active;
      renderButtons();
      deps.onComposerSetupChange?.(active);
    },
  });
  const dashboard = createCloudDashboard({
    loginAccount: deps.loginAccount,
    configuration: onboarding.settingsElement,
    refresh: () => deps.controller.refresh(selectedScope()),
    reconnect: () => deps.controller.reconnectLink(),
    configure: (trigger) => onboarding.open('manage', trigger),
    mutationLocked: () => busy || authorityTransitionActive() || workspaceLocked,
  });
  const settingsElement = dashboard.element;
  const unsubscribeDashboard = deps.controller.subscribe((next) => dashboard.sync(next));

  function setBusy(next: boolean): void {
    busy = next;
    statusPanel.setAttribute('aria-busy', String(next));
    sessionSelect.disabled = next || workspaceLocked || authorityTransitionActive();
    render();
  }

  function authorityTransitionActive(): boolean {
    return pendingTakeover !== null || pendingResultReplace !== null;
  }

  function authorityContext() {
    return { profileEpoch: snapshot.profileEpoch, serverIdentity: serverIdentity(snapshot) };
  }

  function syncAuthorityMutationLock(): void {
    onboarding.setMutationLocked(authorityTransitionActive());
    sessionSelect.disabled = busy || workspaceLocked || authorityTransitionActive();
  }

  function selectedScope(): CloudSessionScope {
    const scope = deps.getScope();
    if (selectionScope.threadId !== scope.threadId || selectionScope.documentId !== scope.documentId) {
      selectedSessionId = null;
      selectionScope = scope;
    }
    return {
      ...scope,
      ...(selectedSessionId ? { selectedSessionId } : {}),
    };
  }

  function bindingMatchesScope(binding: CloudWorkspaceBinding | null): boolean {
    const scope = deps.getScope();
    return Boolean(binding && binding.threadId === scope.threadId
      && binding.documentId === scope.documentId);
  }

  async function operation(run: () => Promise<unknown>): Promise<void> {
    if (busy || recoveryBusy) return;
    setBusy(true);
    try {
      await run();
    } catch (error) {
      deps.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function clearCloudBinding(): void {
    mountedBinding = null;
    appliedTimelineKey = '';
    deps.onCloudBinding(null);
  }

  function snapshotBinding(value = snapshot): CloudWorkspaceBinding | null {
    return cloudTimelineBinding(value.session, value.timeline);
  }

  function mountSnapshotTimeline(value = snapshot): boolean {
    const binding = snapshotBinding(value);
    if (!binding || !value.timeline || value.timeline.thread.id !== binding.threadId) {
      return false;
    }
    if (!deps.onTimeline(binding, value.timeline)) {
      return false;
    }
    mountedBinding = binding;
    appliedTimelineKey = `${binding.sessionId}:${value.timeline.exportedAt}:${value.timeline.thread.updatedAt}`;
    deps.onCloudBinding(binding);
    return true;
  }

  function matchesTarget(target: CloudCommandTarget): boolean {
    const session = snapshot.session;
    return deps.isCloudMode()
      && session.kind === 'running'
      && session.sessionId === target.sessionId
      && session.threadId === target.threadId
      && session.documentId === target.documentId;
  }

  async function selectAndBind(sessionId: string | null, rollbackOnFailure: boolean): Promise<boolean> {
    selectedScope();
    const previous = {
      selectedSessionId,
      snapshot,
      downloadedResult,
      mountedBinding,
      appliedTimelineKey,
    };
    const previousScope: CloudSessionScope = {
      ...deps.getScope(),
      ...(previous.selectedSessionId ? { selectedSessionId: previous.selectedSessionId } : {}),
    };
    pendingSessionSelections += 1;
    try {
      return await runCloudSessionSelection({
        acquire: () => deps.onWorkspaceLock('session-selection'),
        begin: selectionFence.begin,
        select: () => {
          selectedSessionId = sessionId;
        },
        refresh: () => deps.controller.refresh({
          ...deps.getScope(), ...(sessionId ? { selectedSessionId: sessionId } : {}),
        }),
        mount: (next) => {
          const selected = next.session.kind === 'idle' ? null : next.session.sessionId;
          if (sessionId && selected !== sessionId) {
            throw new Error('선택한 Cloud 작업을 불러오지 못했습니다.');
          }
          let mounted = false;
          if (deps.isCloudMode() && next.timeline) {
            if (!snapshotBinding(next) || !mountSnapshotTimeline(next)) {
              throw new Error('선택한 Cloud 대화를 연결하지 못했습니다.');
            }
            mounted = true;
          }
          snapshot = next;
          downloadedResult = null;
          if (!mounted) clearCloudBinding();
          onboarding.sync(next);
          render();
          return mounted;
        },
        rollback: async () => {
          if (rollbackOnFailure) {
            selectedSessionId = previous.selectedSessionId;
            const restored = await deps.controller.refresh(previousScope);
            const expectedSessionId = previous.snapshot.session.kind === 'idle'
              ? null
              : previous.snapshot.session.sessionId;
            const restoredSessionId = restored.session.kind === 'idle' ? null : restored.session.sessionId;
            if (restoredSessionId !== expectedSessionId) {
              throw new Error('이전 Cloud 작업으로 돌아가지 못했습니다.');
            }
            if (previous.mountedBinding) {
              if (!restored.timeline || !deps.onTimeline(previous.mountedBinding, restored.timeline)) {
                throw new Error('이전 Cloud 대화를 다시 연결하지 못했습니다.');
              }
              mountedBinding = previous.mountedBinding;
              appliedTimelineKey = `${previous.mountedBinding.sessionId}:${restored.timeline.exportedAt}:${restored.timeline.thread.updatedAt}`;
            } else {
              mountedBinding = null;
              appliedTimelineKey = '';
            }
            snapshot = restored;
            downloadedResult = previous.downloadedResult;
            deps.onCloudBinding(previous.mountedBinding);
            onboarding.sync(restored);
            render();
          }
        },
      });
    } finally {
      pendingSessionSelections = Math.max(0, pendingSessionSelections - 1);
    }
  }

  function action(label: string, run: (event: MouseEvent) => void, tone = ''): HTMLButtonElement {
    const item = el('button', `ag-cloud-action ${tone}`.trim(), label) as HTMLButtonElement;
    item.type = 'button';
    item.disabled = busy || recoveryBusy !== null;
    item.addEventListener('click', (event) => run(event));
    return item;
  }

  function command(command: 'pause' | 'resume' | 'takeover' | 'cancel' | 'end' | 'retry'): void {
    const session = snapshot.session;
    const retryTakeover = command === 'takeover' ? pendingTakeover : null;
    if (session.kind === 'idle' && !retryTakeover) return;
    void operation(async () => {
      if (command === 'takeover') {
        const sessionId = retryTakeover?.sessionId
          ?? (session.kind === 'idle' ? '' : session.sessionId);
        const expectedVersion = retryTakeover?.expectedVersion
          ?? (session.kind === 'idle' ? 0 : session.version);
        await runTakeoverAuthorityTransition({
          acquire: deps.onBeginAuthorityTransition,
          prepare: deps.onBeforeTakeover,
          request: async () => {
            if (session.kind === 'idle') throw new Error('Cloud 이어받기 작업을 찾지 못했습니다.');
            const next = await deps.controller.command({
              sessionId,
              command,
              expectedVersion,
            });
            if (!next.takeover) throw new Error('Cloud 이어받기 데이터가 준비되지 않았습니다.');
            return next.takeover;
          },
          apply: async (payload) => {
            const binding = await deps.onTakeover(payload);
            if (!binding) throw new Error('Cloud 이어받기 문서에 로컬 문서 ID를 할당하지 못했습니다.');
            return binding;
          },
          complete: async (payload) => {
            await deps.controller.completeTakeover(sessionId, payload.operationId);
          },
          refresh: async () => {
            await deps.controller.refresh(selectedScope());
          },
          settle: deps.onTakeoverSettled,
          pending: retryTakeover?.state ?? null,
          onPendingChange: (state) => {
            pendingTakeover = state ? { sessionId, expectedVersion, state } : null;
            syncAuthorityMutationLock();
            render();
          },
          context: authorityContext,
        });
        return;
      }
      if (session.kind === 'idle') return;
      const next = await deps.controller.command({
        sessionId: session.sessionId,
        command,
        expectedVersion: session.version,
      });
      snapshot = next;
    });
  }

  function resolveWait(waitId: string, actionName: string, feedback?: string): void {
    const session = snapshot.session;
    if (session.kind !== 'running' || session.wait?.id !== waitId) return;
    void operation(async () => {
      await deps.controller.command({
        sessionId: session.sessionId,
        command: 'resolve-wait',
        expectedVersion: session.version,
        payload: {
          waitId,
          action: actionName,
          ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
        },
      });
    });
  }

  function redirectTurn(text: string): void {
    const session = snapshot.session;
    const content = text.trim();
    if (session.kind !== 'running' || session.phase !== 'working' || !content) return;
    const messageId = globalThis.crypto?.randomUUID?.()
      ?? `cloud-redirect-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    void operation(async () => {
      await deps.controller.command({
        sessionId: session.sessionId,
        command: 'redirect',
        expectedVersion: session.version,
        message: content,
        messageId,
      });
    });
  }

  function dismissSession(): void {
    const session = snapshot.session;
    if (session.kind !== 'failed' && session.kind !== 'cancelled') return;
    void operation(async () => {
      await deps.controller.dismissSession(session.sessionId);
    });
  }

  function forceQuitAccount(): void {
    void recoveryOperation('stopping', async () => {
      snapshot = await deps.controller.forceQuitAccount();
      selectedSessionId = snapshot.session.kind === 'idle' ? null : snapshot.session.sessionId;
      if (snapshot.session.kind === 'idle') clearCloudBinding();
    });
  }

  function reconnectLink(): void {
    void recoveryOperation('reconnecting', async () => {
      snapshot = await deps.controller.reconnectLink();
      if (inferCloudLink(snapshot).kind === 'ready' && deps.isCloudMode()
        && (!bindingMatchesScope(snapshotBinding()) || !mountSnapshotTimeline())) {
        snapshot = await deps.controller.refresh(selectedScope());
        mountSnapshotTimeline();
      }
    });
  }

  function recreateLink(): void {
    const binding = mountedBinding ?? (snapshot.session.kind === 'idle' ? null : {
      sessionId: snapshot.session.sessionId,
      threadId: snapshot.session.threadId,
      documentId: snapshot.session.documentId,
    });
    void recoveryOperation('recreating', async () => {
      if (binding && !bindingMatchesScope(binding)) {
        throw new Error('작업을 시작한 문서와 대화에서 서버를 다시 만들어 주세요.');
      }
      const references = binding ? await deps.onPrepareRestartConversation?.(binding) ?? [] : [];
      const document = binding ? await deps.controller.prepareRestartDocument(binding.sessionId) : null;
      if (binding && !bindingMatchesScope(binding)) {
        throw new Error('작업을 시작한 문서와 대화에서 서버를 다시 만들어 주세요.');
      }
      if (binding) {
        await deps.onRestartPrepared?.(binding);
        if (!bindingMatchesScope(binding)) throw new Error('작업을 시작한 문서와 대화에서 서버를 다시 만들어 주세요.');
      }
      snapshot = await deps.controller.recreateLink();
      selectedSessionId = snapshot.session.kind === 'idle' ? null : snapshot.session.sessionId;
      if (inferCloudLink(snapshot).kind === 'ready' && snapshot.session.kind === 'idle' && binding && document) {
        await deps.onRestartConversation?.(binding, document, references);
      }
    });
  }

  async function recoveryOperation(kind: NonNullable<typeof recoveryBusy>, run: () => Promise<void>): Promise<void> {
    if (authorityTransitionActive() || recoveryBusy === 'stopping' || recoveryBusy === 'recreating') return;
    if (recoveryBusy === kind) return;
    // Stop/rebuild can interrupt a reconnect; they must not share its UI lock.
    recoveryBusy = kind;
    render();
    try {
      await run();
    } catch (error) {
      if (recoveryBusy === kind) deps.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (recoveryBusy === kind) recoveryBusy = null;
      render();
    }
  }

  function appendForceQuit(): void {
    if (!shouldOfferAccountForceQuit(snapshot)) return;
    const button = action(recoveryBusy === 'stopping' ? '종료 중…' : '서버 강제 종료', forceQuitAccount, 'ag-danger');
    button.disabled = authorityTransitionActive() || recoveryBusy === 'stopping' || recoveryBusy === 'recreating';
    panelActions.append(button);
  }

  async function download(): Promise<void> {
    const session = snapshot.session;
    if (session.kind !== 'completed') return;
    await operation(async () => {
      downloadedResult = await deps.controller.downloadResult(session.sessionId);
      if (downloadedResult.timeline && deps.isCloudMode()) {
        const binding = cloudTimelineBinding(snapshot.session, downloadedResult.timeline);
        if (binding && downloadedResult.timeline.thread.id === binding.threadId
          && deps.onTimeline(binding, downloadedResult.timeline)) {
          mountedBinding = binding;
          deps.onCloudBinding(binding);
        }
      }
      render();
    });
  }

  function resolveResult(actionName: CloudResultAction): void {
    const retryReplace = actionName === 'replace' ? pendingResultReplace : null;
    const result = retryReplace?.result ?? downloadedResult;
    if (!result) return;
    if (result.conflict === 'external-change' && actionName === 'replace') return;
    if (actionName === 'replace' && !result.timeline) {
      deps.onError('Cloud 결과 대화를 불러오지 못해 문서를 바꾸지 않았습니다.');
      return;
    }
    void operation(async () => {
      await runResultAuthorityTransition({
        replace: actionName === 'replace',
        acquire: deps.onBeginAuthorityTransition,
        resolve: () => deps.controller.resolveResult(result.sessionId, actionName),
        apply: async (resolution) => {
          await deps.onResultResolved({
            ...result,
            bytes: resolution.bytes ?? result.bytes,
            conflict: resolution.conflict,
            preservedCopyName: resolution.preservedCopyName ?? result.preservedCopyName,
          }, resolution);
          downloadedResult = null;
          render();
        },
        refresh: async () => {
          await deps.controller.refresh(selectedScope());
        },
        pending: retryReplace?.state ?? null,
          onPendingChange: (state) => {
            pendingResultReplace = state ? { result, state } : null;
            if (state) downloadedResult = result;
            syncAuthorityMutationLock();
            render();
          },
          context: authorityContext,
      });
    });
  }

  function mergeStartId(sessionId: string): string | undefined {
    const session = snapshot.sessions.find((item) => item.sessionId === sessionId);
    if (!session) return undefined;
    return deps.getCloudStartId?.(session.threadId, sessionId)
      ?? (snapshot.session.kind !== 'idle' && snapshot.session.sessionId === sessionId
        && snapshot.timeline?.thread.id === session.threadId
        ? snapshot.timeline.thread.cloudStartId : undefined);
  }

  function currentMergeOffer(): MergeOffer | undefined {
    const scope = deps.getScope();
    const matching = [...mergeOffers.values()].filter((offer) => offer.documentId === scope.documentId
      && offer.revision > (reviewedRevisions.get(offer.sessionId) ?? -1));
    return matching.find((offer) => snapshot.session.kind !== 'idle' && offer.sessionId === snapshot.session.sessionId)
      ?? matching.at(-1);
  }

  function renderMergeButton(): void {
    const offer = currentMergeOffer();
    mergeButton.hidden = !deps.onMergeCheckpoint || !offer;
    mergeButton.disabled = busy || workspaceLocked || inferCloudLink(snapshot).kind !== 'ready';
    mergeButton.textContent = busy ? 'Cloud 변경 가져오는 중…' : `Cloud 변경 병합${offer ? ` · ${offer.turn}턴` : ''}`;
    mergeButton.title = '완료된 Cloud 변경을 현재 로컬 브랜치에 병합합니다';
    mergeButton.dataset.revision = offer ? String(offer.revision) : '';
  }

  async function mergeCheckpoint(): Promise<void> {
    const offer = currentMergeOffer();
    if (!offer || !deps.onMergeCheckpoint || busy) return;
    const profileEpoch = snapshot.profileEpoch;
    const documentId = deps.getScope().documentId;
    const startId = offer.startId ?? mergeStartId(offer.sessionId);
    if (!startId) return deps.onError('Cloud 시작 대화를 불러온 뒤 다시 병합하세요.');
    await operation(async () => {
      const checkpoint = await deps.controller.downloadCheckpoint(offer.sessionId, offer.operationId);
      if (snapshot.profileEpoch !== profileEpoch || deps.getScope().documentId !== documentId) return;
      if (checkpoint.sessionId !== offer.sessionId || checkpoint.documentId !== documentId
        || checkpoint.kind !== 'turn' || checkpoint.revision !== offer.revision
        || checkpoint.operationId !== offer.operationId) throw new Error('요청한 Cloud 변경과 다운로드한 문서가 다릅니다.');
      const applied = await deps.onMergeCheckpoint!(startId, checkpoint);
      if (applied && snapshot.profileEpoch === profileEpoch) {
        reviewedRevisions.set(offer.sessionId, offer.revision);
      }
    });
  }

  function downloadCheckpointCopy(): void {
    const offer = currentMergeOffer();
    if (!offer || busy) return;
    const profileEpoch = snapshot.profileEpoch;
    const documentId = deps.getScope().documentId;
    void operation(async () => {
      const checkpoint = await deps.controller.downloadCheckpoint(offer.sessionId, offer.operationId);
      if (snapshot.profileEpoch !== profileEpoch || deps.getScope().documentId !== documentId) return;
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', checkpoint.bytes.slice().buffer))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (snapshot.profileEpoch !== profileEpoch || deps.getScope().documentId !== documentId) return;
      if (checkpoint.sessionId !== offer.sessionId || checkpoint.documentId !== documentId
        || checkpoint.kind !== 'turn' || checkpoint.revision !== offer.revision
        || checkpoint.operationId !== offer.operationId || checkpoint.sha256 !== digest
        || checkpoint.byteLength !== checkpoint.bytes.length) throw new Error('Cloud 사본 검증에 실패했습니다. 다시 다운로드하세요.');
      const link = document.createElement('a');
      const url = URL.createObjectURL(new Blob([checkpoint.bytes.slice().buffer], { type: 'application/octet-stream' }));
      link.href = url;
      link.download = checkpoint.fileName.split(/[\\/]/).at(-1)!.replace(/(\.[^.]+)$/, `-cloud-${checkpoint.turn}$1`);
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
  }

  function publishCheckpoint(): void {
    if (deps.onMergeCheckpoint) { void mergeCheckpoint(); return; }
    const session = snapshot.session;
    if (session.kind === 'idle') return;
    void operation(() => checkpointPublisher.publish(session.sessionId));
  }

  function renderPanel(): void {
    const link = inferCloudLink(snapshot);
    // Keep focused/pressed buttons mounted across status and timeline updates.
    const renderKey = JSON.stringify([link.kind === 'ready' ? snapshot.session : null,
      link.kind === 'ready' ? snapshot.sessions : null, snapshot.profile, snapshot.server,
      snapshot.account, link.kind, busy, recoveryBusy, Boolean(pendingTakeover), Boolean(pendingResultReplace),
      Boolean(downloadedResult), localTurnPending, currentMergeOffer()]);
    if (renderKey === panelRenderKey) return;
    panelRenderKey = renderKey;
    const activeSessionId = snapshot.session.kind === 'idle' ? null : snapshot.session.sessionId;
    if (!selectedSessionId && activeSessionId) selectedSessionId = activeSessionId;
    sessionPicker.hidden = snapshot.sessions.length <= 1 || cloudLinkNeedsAttention(link);
    sessionSelect.replaceChildren(...snapshot.sessions.map((session) => {
      const option = document.createElement('option');
      option.value = session.sessionId;
      option.textContent = `${session.documentName} · ${sessionKindLabel(session.kind)}`;
      return option;
    }));
    if (activeSessionId && snapshot.sessions.some((session) => session.sessionId === activeSessionId)) {
      sessionSelect.value = activeSessionId;
    }
    panelActions.replaceChildren();
    progress.hidden = true;
    panelConflict.hidden = true;
    const session = snapshot.session;
    if (cloudLinkNeedsAttention(link)) {
      panelStatus.textContent = '';
      panelDetail.textContent = '';
      if (session.kind === 'idle') {
        panelActions.append(action('Cloud 설정', () => {
          const focusTrigger = panelTrigger ?? sidebarButton;
          closePanel();
          onboarding.open('manage', focusTrigger);
        }));
      }
      appendForceQuit();
      return;
    }
    if (pendingResultReplace) {
      panelStatus.textContent = 'Cloud 결과 반영을 다시 시도할 수 있습니다.';
      panelDetail.textContent = pendingResultReplace.result.fileName;
      panelActions.append(action('원본에 반영', () => resolveResult('replace'), 'ag-primary'));
      appendForceQuit();
      return;
    }
    if (pendingTakeover) {
      panelStatus.textContent = '이어받기를 다시 시도할 수 있습니다.';
      panelDetail.textContent = '준비된 Cloud 경계부터 이어서 적용합니다.';
      panelActions.append(action('안전한 경계에서 이어받기', () => command('takeover'), 'ag-primary'));
      appendForceQuit();
      return;
    }
    if (localTurnPending) {
      panelStatus.textContent = '현재 응답이 끝나면 클라우드로 옮깁니다.';
      panelDetail.textContent = '앱을 닫으면 전송 확인이 끝날 때까지 기다립니다.';
      panelActions.append(action('전송 예약 취소', deps.onCancelPendingTransfer));
      appendForceQuit();
      return;
    }
    switch (session.kind) {
      case 'idle':
        const profileReady = snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'ready';
        const appHosted = snapshot.profile.kind === 'configured' && snapshot.profile.mode === 'app-hosted';
        const appHostedLock = raucloudLock(snapshot);
        if (appHostedLock) {
          panelStatus.textContent = snapshot.account?.raucloud.kind === 'logged-out'
            ? 'Raucloud를 사용하려면 로그인해야 합니다.'
            : snapshot.account?.raucloud.kind === 'active-elsewhere'
              ? '다른 기기의 Cloud 작업이 실행 중입니다.'
              : '새 Raucloud 작업을 시작할 수 없습니다.';
          panelDetail.textContent = appHostedLock;
          panelActions.append(action('Cloud 설정 확인', () => {
            const focusTrigger = panelTrigger ?? sidebarButton;
            closePanel();
            onboarding.open('manage', focusTrigger);
          }));
          break;
        }
        panelStatus.textContent = profileReady
          ? appHosted ? 'Raucloud가 준비되어 있습니다.' : '내 서버가 준비되어 있습니다.'
          : snapshot.profile.kind === 'configured'
            ? appHosted ? 'Raucloud 상태를 확인해야 합니다.' : 'VPS 연결을 확인해야 합니다.'
            : 'Cloud 서버를 선택해야 합니다.';
        panelDetail.textContent = snapshot.profile.kind !== 'configured'
          ? 'Raucloud를 쓰거나 내 서버를 연결하세요.'
          : snapshot.profile.mode === 'app-hosted'
            ? `${snapshot.profile.name} · ${snapshot.profile.sandbox.host || snapshot.profile.sandbox.sandboxId}`
            : `${snapshot.profile.profile.name} · ${snapshot.profile.profile.host}`;
        panelActions.append(action('Cloud 설정', () => {
          const focusTrigger = panelTrigger ?? sidebarButton;
          closePanel();
          onboarding.open('manage', focusTrigger);
        }, profileReady ? undefined : 'ag-primary'));
        break;
      case 'waiting-local-turn':
        panelStatus.textContent = session.message;
        panelDetail.textContent = '현재 턴이 끝나는 즉시 저장하고 전송합니다.';
        panelActions.append(action('취소', () => command('cancel')));
        break;
      case 'transferring': {
        const percent = session.totalBytes > 0
          ? Math.min(100, Math.round(session.completedBytes / session.totalBytes * 100))
          : 0;
        panelStatus.textContent = session.message || '문서와 대화를 전송하는 중입니다.';
        panelDetail.textContent = `${formatBytes(session.completedBytes)} / ${formatBytes(session.totalBytes)}`;
        progress.hidden = false;
        progress.setAttribute('aria-valuenow', String(percent));
        progressFill.style.width = `${percent}%`;
        panelActions.append(action('취소', () => command('cancel')));
        break;
      }
      case 'queued':
        panelStatus.textContent = session.message || '실행 자리를 기다리고 있습니다.';
        panelDetail.textContent = `대기 순서 ${session.position}`;
        panelActions.append(action('취소', () => command('cancel')));
        break;
      case 'running':
        if (session.wait) {
          const wait = session.wait;
          const plan = wait.payload['plan'] && typeof wait.payload['plan'] === 'object'
            ? wait.payload['plan'] as Record<string, unknown>
            : null;
          panelStatus.textContent = wait.kind === 'plan-approval'
            ? '계획 승인을 기다리고 있습니다.'
            : wait.kind === 'question'
              ? '답변을 기다리고 있습니다.'
              : '외부 작업 승인을 기다리고 있습니다.';
          panelDetail.textContent = typeof plan?.['summary'] === 'string'
            ? plan['summary']
            : typeof wait.payload['prompt'] === 'string'
              ? wait.payload['prompt']
              : '결정 전까지 클라우드 대화는 안전하게 열린 상태로 유지됩니다.';
          if (wait.kind === 'plan-approval' || wait.kind === 'question') {
            const feedback = el('textarea', 'ag-cloud-wait-feedback') as HTMLTextAreaElement;
            feedback.rows = 3;
            feedback.maxLength = 64 * 1024;
            feedback.placeholder = wait.kind === 'plan-approval' ? '계획에서 바꿀 점' : '에이전트에게 보낼 답변';
            panelActions.appendChild(feedback);
            if (wait.kind === 'plan-approval') {
              panelActions.append(
                action('계획 승인', () => resolveWait(wait.id, 'approve'), 'ag-primary'),
                action('수정 요청', () => {
                  if (feedback.value.trim()) resolveWait(wait.id, 'changes', feedback.value);
                  else feedback.focus();
                }),
              );
            } else {
              panelActions.append(action('답변 보내기', () => {
                if (feedback.value.trim()) resolveWait(wait.id, 'answer', feedback.value);
                else feedback.focus();
              }, 'ag-primary'));
            }
          } else {
            panelActions.append(action('승인', () => resolveWait(wait.id, 'approve'), 'ag-primary'));
          }
          panelActions.append(
            action('이번 작업 중단', () => resolveWait(wait.id, 'cancel')),
            action('대화 끝내기', () => command('end'), 'ag-danger'),
          );
          break;
        }
        panelStatus.textContent = session.phase === 'waiting'
          ? '다음 메시지를 기다리고 있습니다.'
          : session.phase === 'redirecting'
            ? '안전한 경계에서 방향을 바꾸는 중입니다.'
            : session.currentActivity || `${serverLabel(snapshot)}에서 작업 중입니다.`;
        panelDetail.textContent = `${session.turn}/${session.turnLimit}턴 · ${formatDuration(session.elapsedMs)} / ${formatDuration(session.timeLimitMs)}`;
        if (session.phase === 'waiting' && session.turn > 0 && (!deps.onMergeCheckpoint || currentMergeOffer())) {
          panelActions.append(action(deps.onMergeCheckpoint ? 'Cloud 변경 병합' : '원본에 반영', publishCheckpoint, 'ag-primary'));
        }
        if (session.phase === 'working') {
          const redirect = el('textarea', 'ag-cloud-wait-feedback') as HTMLTextAreaElement;
          redirect.rows = 2;
          redirect.maxLength = 64 * 1024;
          redirect.placeholder = '현재 작업을 안전하게 멈추고 전달할 새 지시';
          panelActions.append(
            redirect,
            action('안전하게 중단하고 전환', () => {
              if (redirect.value.trim()) redirectTurn(redirect.value);
              else redirect.focus();
            }),
          );
        }
        panelActions.append(
          action('일시 중지', () => command('pause')),
          action('이 기기에서 이어받기', () => command('takeover')),
          action('대화 끝내기', () => command('end'), 'ag-danger'),
        );
        break;
      case 'pausing':
        panelStatus.textContent = session.message;
        panelDetail.textContent = '도구 호출이 끝나는 안전한 경계에서 멈춥니다.';
        break;
      case 'suspended':
        panelStatus.textContent = '클라우드 작업이 멈췄습니다.';
        panelDetail.textContent = session.reason;
        if (!deps.onMergeCheckpoint || currentMergeOffer()) {
          panelActions.append(action(deps.onMergeCheckpoint ? 'Cloud 변경 병합' : '원본에 반영', publishCheckpoint));
        }
        if (session.resumable) panelActions.append(action('다시 시작', () => command('resume'), 'ag-primary'));
        panelActions.append(action('이 기기에서 이어받기', () => command('takeover')));
        panelActions.append(action('대화 끝내기', () => command('end'), 'ag-danger'));
        break;
      case 'taking-over':
        panelStatus.textContent = session.message;
        panelDetail.textContent = '최신 안정 체크포인트를 다운로드한 뒤 편집 잠금이 풀립니다.';
        panelActions.append(action('안전한 경계에서 이어받기', () => command('takeover'), 'ag-primary'));
        break;
      case 'completed':
        if (deps.onMergeCheckpoint) {
          panelStatus.textContent = 'Cloud 작업이 끝났습니다.';
          panelDetail.textContent = '완료된 변경을 현재 로컬 브랜치에 병합할 수 있습니다.';
          if (currentMergeOffer()) panelActions.append(action('Cloud 변경 병합', publishCheckpoint, 'ag-primary'));
          break;
        }
        panelStatus.textContent = downloadedResult ? '결과 미리보기가 준비되었습니다.' : '클라우드 작업이 끝났습니다.';
        panelDetail.textContent = `${session.result.fileName} · ${formatBytes(session.result.byteLength)}`;
        if (!downloadedResult) {
          if (!session.result.availableOnThisDevice) {
            panelDetail.textContent = '결과는 작업을 시작한 기기에서만 다운로드할 수 있습니다.';
            break;
          }
          panelActions.append(action('결과 미리보기', () => { void download(); }, 'ag-primary'));
          break;
        }
        if (downloadedResult.conflict === 'external-change') {
          panelConflict.hidden = false;
          panelConflict.textContent = `원본 파일이 바뀌었습니다. 원본과 ${downloadedResult.preservedCopyName ?? '클라우드 결과 사본'}을 모두 보관합니다.`;
          panelActions.append(action('두 파일 보관', () => resolveResult('keep-both'), 'ag-primary'));
        } else {
          panelActions.append(
            action('원본에 반영', () => resolveResult('replace'), 'ag-primary'),
            action('별도 사본으로 보관', () => resolveResult('keep-both')),
          );
        }
        panelActions.append(action('결과 버리기', () => resolveResult('discard'), 'ag-danger'));
        break;
      case 'failed':
        panelStatus.textContent = session.message;
        panelDetail.textContent = session.code;
        if (session.retryable && !raucloudLock(snapshot)) panelActions.append(action('다시 시도', () => command('retry'), 'ag-primary'));
        panelActions.append(action('기록 지우기', dismissSession));
        break;
      case 'cancelled':
        panelStatus.textContent = '클라우드 작업을 취소했습니다.';
        panelDetail.textContent = '문서 편집 권한이 이 기기로 돌아왔습니다.';
        panelActions.append(action('기록 지우기', dismissSession));
        break;
    }
    if (deps.onMergeCheckpoint && currentMergeOffer()) {
      panelActions.append(action('완료 문서 사본 저장', downloadCheckpointCopy, 'ag-cloud-checkpoint-copy'));
    }
    appendForceQuit();
  }

  function renderRecovery(): void {
    const link = inferCloudLink(snapshot);
    const needsAttention = cloudLinkNeedsAttention(link);
    recoveryStrip.hidden = !needsAttention || !deps.isCloudMode();
    const renderKey = JSON.stringify([link.kind, link.canRecreate, busy, recoveryBusy, authorityTransitionActive()]);
    if (renderKey === recoveryRenderKey) return;
    recoveryRenderKey = renderKey;
    statusPanel.dataset.link = link.kind;
    recovery.hidden = !needsAttention;
    recovery.dataset.kind = link.kind;
    recoveryActions.replaceChildren();
    recoveryStrip.replaceChildren();
    recoveryStrip.dataset.kind = link.kind;
    if (!needsAttention) {
      recoveryTitle.textContent = '';
      recoveryDetail.textContent = '';
      return;
    }
    if (link.kind === 'reconnecting') {
      recoveryTitle.textContent = 'Cloud에 다시 연결하는 중';
      recoveryDetail.textContent = '연결되면 이 대화에서 계속할 수 있습니다.';
    } else if (link.kind === 'recreating') {
      recoveryTitle.textContent = '새 Cloud 서버를 준비하는 중';
      recoveryDetail.textContent = '현재 대화와 저장된 문서를 새 서버로 옮깁니다.';
    } else {
      recoveryTitle.textContent = 'Cloud 연결이 끊겼습니다';
      recoveryDetail.textContent = link.canRecreate
        ? '대화 기록은 남아 있습니다. 다시 연결하거나 새 서버에서 이어가세요.'
        : '대화 기록은 남아 있습니다. 서버가 켜져 있는지 확인한 뒤 다시 연결하세요.';
      recoveryActions.append(action('다시 연결', reconnectLink, 'ag-primary'));
      if (link.canRecreate) {
        recoveryActions.append(action('서버 다시 만들기', recreateLink));
      }
    }
    const stripTitle = el('button', 'ag-cloud-recovery-strip-title', recoveryTitle.textContent) as HTMLButtonElement;
    stripTitle.type = 'button';
    stripTitle.setAttribute('aria-haspopup', 'dialog');
    stripTitle.setAttribute('aria-controls', statusPanel.id);
    stripTitle.addEventListener('click', () => openPanel(stripTitle));
    const stripIndicator = el('span', 'ag-cloud-recovery-strip-pulse');
    stripIndicator.setAttribute('aria-hidden', 'true');
    const stripActions = el('div', 'ag-cloud-recovery-strip-actions');
    recoveryStrip.append(stripIndicator, stripTitle, stripActions);
    if (link.kind === 'failed') {
      stripActions.append(action('다시 연결', reconnectLink, 'ag-primary'));
      if (link.canRecreate) stripActions.append(action('서버 다시 만들기', recreateLink));
    }
    if (link.kind === 'reconnecting' && link.canRecreate) {
      recoveryActions.append(action('서버 다시 만들기', recreateLink));
      stripActions.append(action('서버 다시 만들기', recreateLink));
    }
    for (const container of [recoveryActions, recoveryStrip]) {
      for (const button of container.querySelectorAll<HTMLButtonElement>('button')) {
        button.disabled = authorityTransitionActive() || recoveryBusy === 'stopping' || recoveryBusy === 'recreating'
          || button.textContent === '다시 연결' && recoveryBusy === 'reconnecting';
      }
    }
  }

  function renderQueue(): void {
    const queued = snapshot.queuedMessages.filter((message) => message.state === 'queued');
    queueStrip.hidden = queued.length === 0 || !deps.isCloudMode();
    queueStrip.replaceChildren();
    if (!queued.length) return;
    queueStrip.append(el('span', 'ag-cloud-queue-label', `다음 경계에 전달 ${queued.length}`));
    for (const message of queued) {
      const item = el('span', 'ag-cloud-queue-message', message.text);
      item.title = message.text;
      queueStrip.appendChild(item);
    }
  }

  function cloudSetupScopeKey(): string {
    const scope = selectedScope();
    return scope.documentId ?? scope.threadId;
  }

  function renderButtons(): void {
    deps.onWorkspaceSwitchVisibilityChange(
      snapshot.available && (cloudSetupScopes.has(cloudSetupScopeKey())
        || shouldShowCloudWorkspaceSwitch(snapshot, selectedScope())),
    );
    sidebarButton.hidden = !snapshot.available;
    workspaceButton.hidden = !snapshot.available;
    if (!snapshot.available && panelOpen) closePanel(false);
    const active = sessionIsActive(snapshot) || snapshot.session.kind === 'completed' || localTurnPending;
    sidebarButton.classList.toggle('ag-active', active || setupActive);
    workspaceButton.classList.toggle('ag-active', active || setupActive);
    const running = snapshot.session.kind === 'running';
    const link = inferCloudLink(snapshot);
    const buttonState = setupActive
      ? 'setup'
      : link.kind !== 'ready'
        ? link.kind
        : localTurnPending
          ? 'waiting'
          : snapshot.session.kind;
    sidebarButton.dataset.state = buttonState;
    workspaceButton.dataset.state = buttonState;
    sidebarButtonLabel.textContent = setupActive
      ? '준비 중'
      : link.kind === 'reconnecting'
        ? '다시 연결 중'
        : link.kind === 'recreating'
          ? '서버 생성 중'
          : link.kind === 'failed'
            ? '연결 끊김'
            : 'Cloud';
    workspaceButtonLabel.textContent = sidebarButtonLabel.textContent;
    const lock = raucloudLock(snapshot);
    const label = setupActive
      ? 'Cloud 환경 설정 중'
      : link.kind === 'reconnecting'
        ? '연결을 다시 맺는 중입니다'
        : link.kind === 'recreating'
          ? '서버를 다시 만드는 중입니다'
          : link.kind === 'failed'
            ? '연결이 끊겼습니다'
      : running
        ? '클라우드에서 작업 중'
        : active
          ? '클라우드 상태'
          : lock
            ? 'Raucloud 사용 제한'
            : '클라우드 상태';
    sidebarButton.setAttribute('aria-label', label);
    sidebarButton.title = label;
    workspaceButton.setAttribute('aria-label', label);
    workspaceButton.title = label;
  }

  function render(): void {
    renderButtons();
    renderMergeButton();
    renderPanel();
    renderRecovery();
    renderQueue();
    const blocksLocal = cloudLeaseBlocksLocal(snapshot, deps.getScope());
    deps.onLeaseChange(blocksLocal, blocksLocal && snapshot.lease.owner === 'cloud' ? snapshot.lease.sessionId : null);
    if (deps.isCloudMode() && snapshot.timeline) {
      const binding = snapshotBinding();
      const timelineKey = binding
        ? `${binding.sessionId}:${snapshot.timeline.exportedAt}:${snapshot.timeline.thread.updatedAt}`
        : '';
      const scope = deps.getScope();
      const explicitlyMounted = mountedBinding?.sessionId === binding?.sessionId
        && selectionScope.threadId === scope.threadId && selectionScope.documentId === scope.documentId;
      if (binding && (bindingMatchesScope(binding) || explicitlyMounted) && snapshot.timeline.thread.id === binding.threadId
        && timelineKey !== appliedTimelineKey
        && deps.onTimeline(binding, snapshot.timeline)) {
        mountedBinding = binding;
        appliedTimelineKey = timelineKey;
        deps.onCloudBinding(binding);
      }
    }
    if (inferCloudLink(snapshot).kind === 'ready') {
      for (const session of snapshot.sessions) {
        if (session.documentId !== deps.getScope().documentId) continue;
        if ((session.kind === 'running' && session.turn > 0) || session.kind === 'completed' || session.kind === 'suspended') {
          if (!checkpointMirror.hasPending(session.sessionId) && !checkpointMirror.hasRevision(session.sessionId)) {
            mirrorCheckpoint(session.sessionId, 'reconnect');
          }
        }
      }
    }
  }

  function mirrorCheckpoint(sessionId: string, operationId: string): void {
    void checkpointMirror.mirror(sessionId, operationId).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      deps.onError(error instanceof Error ? error.message : String(error));
    });
  }

  function openPanel(trigger: HTMLButtonElement): void {
    panelOpen = true;
    panelTrigger = trigger;
    statusPanel.hidden = false;
    sidebarButton.setAttribute('aria-expanded', 'true');
    workspaceButton.setAttribute('aria-expanded', 'true');
    panelClose.focus();
  }

  function closePanel(restoreFocus = false): void {
    panelOpen = false;
    statusPanel.hidden = true;
    sidebarButton.setAttribute('aria-expanded', 'false');
    workspaceButton.setAttribute('aria-expanded', 'false');
    const trigger = panelTrigger;
    panelTrigger = null;
    if (restoreFocus && trigger?.isConnected && !trigger.hidden) trigger.focus();
  }

  function activate(event: MouseEvent): void {
    const trigger = event.currentTarget as HTMLButtonElement;
    const setupRequested = cloudSetupScopes.has(cloudSetupScopeKey());
    const profileReady = snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'ready';
    cloudSetupScopes.add(cloudSetupScopeKey());
    renderButtons();
    if (setupActive || (snapshot.session.kind === 'idle' && (!setupRequested || !profileReady))) {
      closePanel();
      onboarding.open('transfer', trigger);
      return;
    }
    if (panelOpen) closePanel(true); else openPanel(trigger);
    void deps.controller.refresh(selectedScope()).catch((error) => {
      if (inferCloudLink(snapshot).kind === 'ready') deps.onError(error instanceof Error ? error.message : String(error));
    });
  }

  sidebarButton.addEventListener('click', activate);
  workspaceButton.addEventListener('click', activate);
  panelClose.addEventListener('click', () => closePanel(true));
  statusPanel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePanel(true);
    }
  });
  sessionSelect.addEventListener('change', () => {
    if (workspaceLocked) {
      renderPanel();
      return;
    }
    const nextSessionId = sessionSelect.value || null;
    void operation(() => selectAndBind(nextSessionId, true));
  });
  const unsubscribe = deps.controller.subscribe((next) => {
    const profileChanged = next.profileEpoch !== checkpointProfileEpoch;
    if (profileChanged) {
      checkpointProfileEpoch = next.profileEpoch;
      mergeOffers.clear();
      reviewedRevisions.clear();
      checkpointMirror.reset();
      checkpointPublisher.reset();
      selectionFence.invalidate();
      liveSequence.clear();
      const previousId = snapshot.session.kind === 'idle' ? null : snapshot.session.sessionId;
      const nextId = next.session.kind === 'idle' ? null : next.session.sessionId;
      if (!pendingResultReplace) downloadedResult = null;
      if (previousId && previousId === nextId) {
        selectedSessionId = nextId;
      } else {
        selectedSessionId = nextId;
        if (!nextId) clearCloudBinding();
      }
    }
    if (pendingSessionSelections > 0 && !profileChanged) return;
    snapshot = next;
    onboarding.sync(next);
    syncAuthorityMutationLock();
    render();
  });
  const unsubscribeEvents = deps.controller.subscribeEvents((raw) => {
    const publication = cloudPublicationOperation(raw);
    if (publication) {
      if (deps.onMergeCheckpoint) { mirrorCheckpoint(publication.sessionId, publication.operationId); return; }
      const session = snapshot.sessions.find((entry) => entry.sessionId === publication.sessionId);
      if (!session || session.documentId !== deps.getScope().documentId) return;
      void checkpointPublisher.publish(publication.sessionId, publication.operationId).catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        deps.onError(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    const boundary = cloudBoundaryOperation(raw, deps.onMergeCheckpoint ? 'turn' : undefined);
    if (boundary) {
      mirrorCheckpoint(boundary.sessionId, boundary.operationId);
      return;
    }
    const host = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : null;
    if (host?.type === 'session-stream-error' || host?.type === 'remote-session-stream-error') {
      if (host.retryable === false) {
        deps.onError(typeof host.error === 'string' ? host.error : '클라우드 연결을 확인해 주세요.');
        return;
      }
      const link = inferCloudLink(snapshot);
      if (link.kind === 'ready') reconnectLink();
      return;
    }
    const sessionId = typeof host?.sessionId === 'string' ? host.sessionId : '';
    const selected = snapshot.session.kind === 'idle' ? '' : snapshot.session.sessionId;
    const selectedThreadId = snapshot.session.kind === 'idle' ? '' : snapshot.session.threadId;
    if (!sessionId || sessionId !== selected
      || !cloudEventMatchesBinding(mountedBinding, sessionId, selectedThreadId)) return;
    const envelope = host?.event && typeof host.event === 'object' && !Array.isArray(host.event)
      ? host.event as Record<string, unknown>
      : null;
    if (envelope?.type !== 'agent.event') return;
    const sequence = Number(envelope.seq ?? envelope.sequence);
    if (Number.isSafeInteger(sequence)) {
      const previous = liveSequence.get(sessionId) ?? 0;
      if (sequence <= previous) return;
      liveSequence.set(sessionId, sequence);
    }
    const payload = envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
      ? envelope.payload as Record<string, unknown>
      : null;
    const event = payload?.type === 'agent' && payload.event && typeof payload.event === 'object'
      ? payload.event as AgentStreamEvent
      : null;
    if (event && typeof event.type === 'string') deps.onAgentEvent(mountedBinding, event);
  });
  onboarding.sync(snapshot);
  void deps.controller.refresh(selectedScope()).catch((error) => {
    render();
    // A build without the desktop bridge stays quiet; a real cloud build must
    // not hide a failed first refresh behind a permanently empty panel.
    if (cloudCapable()) {
      deps.onError(error instanceof Error ? error.message : String(error));
    }
  });

  return {
    sidebarButton,
    workspaceButton,
    mergeButton,
    statusPanel,
    optionsElement,
    queueStrip,
    recoveryStrip,
    settingsElement,
    getSnapshot: () => snapshot,
    isCloudConversation: () => cloudOwnsConversation(snapshot),
    setWaitingForLocalTurn(waiting) {
      localTurnPending = waiting;
      render();
    },
    setWorkspaceLocked(locked) {
      workspaceLocked = locked;
      sessionSelect.disabled = busy || locked || authorityTransitionActive();
      renderMergeButton();
      renderRecovery();
      renderQueue();
    },
    async refreshLeaseScope() {
      const scope = deps.getScope();
      const changed = selectionScope.threadId !== scope.threadId || selectionScope.documentId !== scope.documentId;
      selectedScope();
      if (changed) clearCloudBinding();
      // Local conversations do not wait for a remote session lookup. Recompute
      // the retained editor's lock immediately from the known lease owner.
      const lock = deps.isCloudMode() ? deps.onWorkspaceLock('session-selection') : { release() {} };
      if (changed) render();
      const isCurrent = selectionFence.begin();
      try {
        const next = await deps.controller.refresh(selectedScope());
        if (!isCurrent()) return false;
        snapshot = next;
        render();
        return true;
      } catch (error) {
        deps.onError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        lock.release();
      }
    },
    bindSelectedTimeline() {
      const selected = selectedScope().selectedSessionId;
      const active = snapshot.sessions.find((session) => bindingMatchesScope(session));
      return selectAndBind(selected ?? active?.sessionId ?? null, false);
    },
    matchesTarget,
    async configure(selection, target) {
      const session = snapshot.session;
      if (!deps.isCloudMode() || session.kind === 'idle' || !canChangeCloudProviderSettings(session)
        || session.sessionId !== target.sessionId || session.threadId !== target.threadId
        || session.documentId !== target.documentId) throw new Error('선택한 Cloud 대화가 바뀌었습니다.');
      snapshot = await deps.controller.command({
        sessionId: target.sessionId,
        command: 'configure',
        expectedVersion: target.expectedVersion,
        payload: { provider: selection.agent, model: selection.model, effort: selection.effort },
      });
      render();
    },
    async setWorkflow(workflow, target) {
      const session = snapshot.session;
      if (!matchesTarget(target)) {
        throw new Error('클라우드 에이전트가 실행 중이 아닙니다.');
      }
      snapshot = await deps.controller.command({
        sessionId: target.sessionId,
        command: 'workflow',
        expectedVersion: target.expectedVersion,
        payload: { workflow },
      });
      render();
      if (snapshot.session.kind !== 'running' || snapshot.session.sessionId !== target.sessionId
        || snapshot.session.threadId !== target.threadId || snapshot.session.documentId !== target.documentId) {
        throw new Error('클라우드 에이전트가 실행 중이 아닙니다.');
      }
      return { ...target, expectedVersion: snapshot.session.version };
    },
    async queueMessage(text, messageId, attachments = [], target) {
      if (!matchesTarget(target)) {
        throw new Error('선택한 Cloud 대화가 바뀌었습니다.');
      }
      await deps.controller.command({
        sessionId: target.sessionId,
        command: 'queue-message',
        expectedVersion: target.expectedVersion,
        message: text,
        messageId,
        attachments,
      });
    },
    openSetup(trigger: HTMLElement) {
      onboarding.open('manage', trigger);
    },
    openSettings() {
      if (authorityTransitionActive()) {
        deps.onError('Cloud 권한 전환을 마친 뒤 서버 설정을 변경할 수 있습니다.');
        return;
      }
      void deps.controller.refresh(selectedScope()).catch((error) => {
        deps.onError(error instanceof Error ? error.message : String(error));
      });
    },
    handleAccountEvent(event) {
      onboarding.handleAccountEvent(event);
      dashboard.handleAccountEvent(event);
    },
    dispose() {
      pendingTakeover?.state.transition.release();
      pendingTakeover = null;
      pendingResultReplace?.state.transition.release();
      pendingResultReplace = null;
      checkpointMirror.dispose();
      checkpointPublisher.dispose();
      unsubscribe();
      unsubscribeDashboard();
      unsubscribeEvents();
      dashboard.dispose();
      onboarding.dispose();
      closePanel();
    },
  };
}
