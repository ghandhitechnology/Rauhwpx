import './cloud-ui.css';

import type { PortableCloudTimelineV1 } from '../../cloud/timeline.ts';
import type { CloudController } from '../../cloud/desktop-cloud.ts';
import type {
  CloudDownloadResult,
  CloudResultAction,
  CloudResultResolution,
  CloudSessionScope,
  CloudSnapshot,
  CloudTakeoverPayload,
} from '../../cloud/types.ts';
import { createCloudOnboarding } from './cloud-onboarding.ts';
import { createIcon } from './icons.ts';

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
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}시간 ${minutes % 60}분`;
  return `${Math.max(1, minutes)}분`;
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
  onRequestTransfer(): void;
  onCancelPendingTransfer(): void;
  getScope(): CloudSessionScope;
  onCloseSettings(): void;
  onLeaseChange(cloudOwned: boolean, sessionId: string | null): void;
  onTimeline(timeline: PortableCloudTimelineV1): void;
  onResultResolved(result: CloudDownloadResult, resolution: CloudResultResolution): void;
  onBeforeTakeover(): Promise<boolean>;
  onTakeover(takeover: CloudTakeoverPayload): Promise<void>;
  onError(message: string): void;
}

export interface CloudAgentUi {
  sidebarButton: HTMLButtonElement;
  workspaceButton: HTMLButtonElement;
  statusPanel: HTMLElement;
  queueStrip: HTMLElement;
  settingsElement: HTMLElement;
  getSnapshot(): CloudSnapshot;
  isCloudConversation(): boolean;
  isRunning(): boolean;
  setWaitingForLocalTurn(waiting: boolean): void;
  refreshScope(): void;
  queueMessage(text: string, messageId: string): Promise<void>;
  openSettings(): void;
  dispose(): void;
}

export function createCloudAgentUi(deps: CloudAgentUiDeps): CloudAgentUi {
  let snapshot = deps.controller.getSnapshot();
  let panelOpen = false;
  let localTurnPending = false;
  let busy = false;
  let downloadedResult: CloudDownloadResult | null = null;
  let appliedTimelineKey = '';
  let selectedSessionId: string | null = null;
  let panelTrigger: HTMLButtonElement | null = null;
  let setupActive = false;

  const sidebarButton = el('button', 'ag-header-icon-btn ag-cloud-btn') as HTMLButtonElement;
  sidebarButton.type = 'button';
  sidebarButton.setAttribute('aria-label', '클라우드로 계속');
  sidebarButton.setAttribute('aria-controls', 'ag-cloud-panel');
  sidebarButton.setAttribute('aria-expanded', 'false');
  sidebarButton.title = '클라우드로 계속';
  sidebarButton.append(createIcon('cloud'), el('span', 'ag-cloud-btn-label', 'Cloud'));

  const workspaceButton = el('button', 'ag-workspace-cloud-btn') as HTMLButtonElement;
  workspaceButton.type = 'button';
  workspaceButton.setAttribute('aria-label', '클라우드로 계속');
  workspaceButton.setAttribute('aria-controls', 'ag-cloud-panel');
  workspaceButton.setAttribute('aria-expanded', 'false');
  workspaceButton.append(createIcon('cloud'), el('span', 'ag-workspace-cloud-label', 'Cloud'));

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
  const sessionPickerLabel = el('span', 'ag-cloud-session-picker-label', 'VPS 작업');
  const sessionSelect = el('select', 'ag-cloud-session-select') as HTMLSelectElement;
  sessionPicker.append(sessionPickerLabel, sessionSelect);
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
  const panelActions = el('div', 'ag-cloud-panel-actions');
  panelBody.append(sessionPicker, panelStatus, panelDetail, progress, panelConflict, panelActions);
  statusPanel.append(panelHead, panelBody);

  const queueStrip = el('div', 'ag-cloud-queue-strip');
  queueStrip.hidden = true;
  queueStrip.setAttribute('role', 'status');
  queueStrip.setAttribute('aria-live', 'polite');

  const onboarding = createCloudOnboarding({
    controller: deps.controller,
    onRequestTransfer: deps.onRequestTransfer,
    onCloseSettings: deps.onCloseSettings,
    onSetupStateChange: (active) => {
      setupActive = active;
      renderButtons();
    },
  });
  const settingsElement = onboarding.settingsElement;

  function setBusy(next: boolean): void {
    busy = next;
    statusPanel.setAttribute('aria-busy', String(next));
    sessionSelect.disabled = next;
  }

  function selectedScope(): CloudSessionScope {
    return {
      ...deps.getScope(),
      ...(selectedSessionId ? { selectedSessionId } : {}),
    };
  }

  async function operation(run: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await run();
    } catch (error) {
      deps.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function action(label: string, run: (event: MouseEvent) => void, tone = ''): HTMLButtonElement {
    const item = el('button', `ag-cloud-action ${tone}`.trim(), label) as HTMLButtonElement;
    item.type = 'button';
    item.addEventListener('click', (event) => run(event));
    return item;
  }

  function command(command: 'pause' | 'resume' | 'takeover' | 'cancel' | 'retry'): void {
    const session = snapshot.session;
    if (session.kind === 'idle') return;
    void operation(async () => {
      if (command === 'takeover' && !await deps.onBeforeTakeover()) return;
      const next = await deps.controller.command({
        sessionId: session.sessionId,
        command,
        expectedVersion: session.version,
      });
      if (command === 'takeover' && next.takeover) {
        await deps.onTakeover(next.takeover);
        await deps.controller.completeTakeover(session.sessionId);
      }
    });
  }

  async function download(): Promise<void> {
    const session = snapshot.session;
    if (session.kind !== 'completed') return;
    await operation(async () => {
      downloadedResult = await deps.controller.downloadResult(session.sessionId);
      if (downloadedResult.timeline) deps.onTimeline(downloadedResult.timeline);
      render();
    });
  }

  function resolveResult(actionName: CloudResultAction): void {
    if (!downloadedResult) return;
    if (downloadedResult.conflict === 'external-change' && actionName === 'replace') return;
    const result = downloadedResult;
    void operation(async () => {
      const resolution = await deps.controller.resolveResult(result.sessionId, actionName);
      downloadedResult = null;
      deps.onResultResolved({
        ...result,
        bytes: resolution.bytes ?? result.bytes,
        conflict: resolution.conflict,
        preservedCopyName: resolution.preservedCopyName ?? result.preservedCopyName,
      }, resolution);
      render();
    });
  }

  function renderPanel(): void {
    const activeSessionId = snapshot.session.kind === 'idle' ? null : snapshot.session.sessionId;
    if (!selectedSessionId && activeSessionId) selectedSessionId = activeSessionId;
    sessionPicker.hidden = snapshot.sessions.length <= 1;
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
    if (localTurnPending) {
      panelStatus.textContent = '현재 응답이 끝나면 클라우드로 옮깁니다.';
      panelDetail.textContent = '앱을 닫으면 전송 확인이 끝날 때까지 기다립니다.';
      panelActions.append(action('전송 예약 취소', deps.onCancelPendingTransfer));
      return;
    }
    switch (session.kind) {
      case 'idle':
        const profileReady = snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'ready';
        panelStatus.textContent = profileReady
          ? 'VPS가 준비되어 있습니다.'
          : snapshot.profile.kind === 'configured'
            ? 'VPS 연결을 확인해야 합니다.'
            : 'VPS 설정이 필요합니다.';
        panelDetail.textContent = snapshot.profile.kind === 'configured'
          ? `${snapshot.profile.profile.name} · ${snapshot.profile.profile.host}`
          : 'SSH와 Tailscale 연결을 설정하세요.';
        panelActions.append(action(profileReady ? '클라우드로 계속' : 'Cloud 설정', () => {
          const focusTrigger = panelTrigger ?? sidebarButton;
          closePanel();
          if (profileReady) deps.onRequestTransfer();
          else onboarding.open('transfer', focusTrigger);
        }, 'ag-primary'));
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
        panelStatus.textContent = session.currentActivity || 'VPS에서 작업 중입니다.';
        panelDetail.textContent = `${session.turn}/${session.turnLimit}턴 · ${formatDuration(session.elapsedMs)} / ${formatDuration(session.timeLimitMs)}`;
        panelActions.append(
          action('일시 중지', () => command('pause')),
          action('이 기기에서 이어받기', () => command('takeover')),
          action('취소', () => command('cancel'), 'ag-danger'),
        );
        break;
      case 'pausing':
        panelStatus.textContent = session.message;
        panelDetail.textContent = '도구 호출이 끝나는 안전한 경계에서 멈춥니다.';
        break;
      case 'suspended':
        panelStatus.textContent = '클라우드 작업이 멈췄습니다.';
        panelDetail.textContent = session.reason;
        if (session.resumable) panelActions.append(action('다시 시작', () => command('resume'), 'ag-primary'));
        panelActions.append(action('이 기기에서 이어받기', () => command('takeover')));
        break;
      case 'taking-over':
        panelStatus.textContent = session.message;
        panelDetail.textContent = '최신 안정 체크포인트를 다운로드한 뒤 편집 잠금이 풀립니다.';
        panelActions.append(action('안전한 경계에서 이어받기', () => command('takeover'), 'ag-primary'));
        break;
      case 'completed':
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
        if (session.retryable) panelActions.append(action('새 클라우드 작업으로 다시 전송', deps.onRequestTransfer, 'ag-primary'));
        break;
      case 'cancelled':
        panelStatus.textContent = '클라우드 작업을 취소했습니다.';
        panelDetail.textContent = '문서 편집 권한이 이 기기로 돌아왔습니다.';
        break;
    }
  }

  function renderQueue(): void {
    const queued = snapshot.queuedMessages.filter((message) => message.state === 'queued');
    queueStrip.hidden = queued.length === 0;
    queueStrip.replaceChildren();
    if (!queued.length) return;
    queueStrip.append(el('span', 'ag-cloud-queue-label', `다음 경계에 전달 ${queued.length}`));
    for (const message of queued) {
      const item = el('span', 'ag-cloud-queue-message', message.text);
      item.title = message.text;
      queueStrip.appendChild(item);
    }
  }

  function renderButtons(): void {
    sidebarButton.hidden = !snapshot.available;
    workspaceButton.hidden = !snapshot.available;
    if (!snapshot.available && panelOpen) closePanel(false);
    const active = sessionIsActive(snapshot) || snapshot.session.kind === 'completed' || localTurnPending;
    sidebarButton.classList.toggle('ag-active', active || setupActive);
    workspaceButton.classList.toggle('ag-active', active || setupActive);
    const running = snapshot.session.kind === 'running';
    sidebarButton.dataset.state = setupActive ? 'setup' : localTurnPending ? 'waiting' : snapshot.session.kind;
    workspaceButton.dataset.state = setupActive ? 'setup' : localTurnPending ? 'waiting' : snapshot.session.kind;
    const label = setupActive ? 'Cloud 환경 설정 중' : running ? '클라우드에서 작업 중' : active ? '클라우드 상태' : '클라우드로 계속';
    sidebarButton.setAttribute('aria-label', label);
    sidebarButton.title = label;
    workspaceButton.setAttribute('aria-label', label);
    workspaceButton.title = label;
  }

  function render(): void {
    renderButtons();
    renderPanel();
    renderQueue();
    deps.onLeaseChange(snapshot.lease.owner === 'cloud', snapshot.lease.owner === 'cloud' ? snapshot.lease.sessionId : null);
    if (snapshot.timeline) {
      const timelineKey = `${snapshot.timeline.exportedAt}:${snapshot.timeline.thread.updatedAt}`;
      if (timelineKey !== appliedTimelineKey) {
        appliedTimelineKey = timelineKey;
        deps.onTimeline(snapshot.timeline);
      }
    }
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
    void deps.controller.refresh(selectedScope()).then(() => {
      if (snapshot.session.kind === 'idle' && !localTurnPending) {
        if (snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'ready') deps.onRequestTransfer();
        else onboarding.open('transfer', trigger);
        return;
      }
      if (panelOpen) closePanel(true); else openPanel(trigger);
    }).catch((error) => deps.onError(error instanceof Error ? error.message : String(error)));
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
    selectedSessionId = sessionSelect.value || null;
    downloadedResult = null;
    void operation(() => deps.controller.refresh(selectedScope()));
  });
  const unsubscribe = deps.controller.subscribe((next) => {
    snapshot = next;
    onboarding.sync(next);
    render();
  });
  onboarding.sync(snapshot);
  void deps.controller.refresh(selectedScope()).catch(() => { render(); });

  return {
    sidebarButton,
    workspaceButton,
    statusPanel,
    queueStrip,
    settingsElement,
    getSnapshot: () => snapshot,
    isCloudConversation: () => cloudOwnsConversation(snapshot),
    isRunning: () => snapshot.session.kind === 'running',
    setWaitingForLocalTurn(waiting) {
      localTurnPending = waiting;
      render();
    },
    refreshScope() {
      selectedSessionId = null;
      downloadedResult = null;
      void deps.controller.refresh(selectedScope()).catch((error) => {
        deps.onError(error instanceof Error ? error.message : String(error));
      });
    },
    async queueMessage(text, messageId) {
      const session = snapshot.session;
      if (session.kind !== 'running') throw new Error('클라우드 에이전트가 실행 중이 아닙니다.');
      await deps.controller.command({
        sessionId: session.sessionId,
        command: 'queue-message',
        expectedVersion: session.version,
        message: text,
        messageId,
      });
    },
    openSettings() {
      void deps.controller.refresh(selectedScope()).catch((error) => {
        deps.onError(error instanceof Error ? error.message : String(error));
      });
    },
    dispose() {
      unsubscribe();
      onboarding.dispose();
      deps.controller.dispose();
      closePanel();
    },
  };
}
