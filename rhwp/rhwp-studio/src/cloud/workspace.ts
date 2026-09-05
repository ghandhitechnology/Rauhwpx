import type { CloudController } from './desktop-cloud.ts';
import { inferCloudLink } from './link.ts';
import type {
  CloudDisplayFrame,
  CloudLinkState,
  CloudDisplayUnavailableReason,
  CloudSessionScope,
  CloudSessionState,
  CloudSnapshot,
} from './types.ts';

export type WorkspaceMode = 'local' | 'cloud';
export type WorkspaceView = 'local' | 'cloud';

export function canSelectCloudWorkspace(
  mode: WorkspaceMode,
  localTurnRunning: boolean,
  options: { locked?: boolean; emptyThread?: boolean } = {},
): boolean {
  if (options.locked) return false;
  return mode === 'cloud' || !localTurnRunning;
}

export function canSelectLocalWorkspace(locked: boolean): boolean {
  return !locked;
}

export function shouldShowCloudWorkspaceSwitch(
  snapshot: CloudSnapshot,
  scope: Pick<CloudSessionScope, 'threadId' | 'documentId'>,
): boolean {
  if (!snapshot.available) return false;
  if (snapshot.account?.signedIn === true) return true;
  return snapshot.sessions.some((session) => (
    scope.documentId
      ? session.documentId === scope.documentId
      : session.threadId === scope.threadId
  ));
}

export function shouldShowCloudComposerSwitch(
  snapshot: CloudSnapshot,
  options: {
    emptyThread: boolean;
    hasSupportedDocument: boolean;
    browserPaired?: boolean;
  },
): boolean {
  if (!options.hasSupportedDocument || !snapshot.available) return false;
  if (options.browserPaired === false) return false;
  return true;
}

export type WorkspaceExecutionLock =
  | 'session-selection'
  | 'cloud-transfer'
  | 'cloud-message'
  | 'authority-transition';

export interface CloudWorkspaceBinding {
  sessionId: string;
  threadId: string;
  documentId: string | null;
}

export type ComposerTarget =
  | { kind: 'local-ready' }
  | { kind: 'local-blocked'; reason: 'cloud-lease'; message: string }
  | { kind: 'cloud-start-ready' }
  | { kind: 'cloud-ready'; sessionId: string; threadId: string; documentId: string | null; expectedVersion: number }
  | {
      kind: 'cloud-blocked';
      reason: 'not-accepting-messages' | 'timeline-unavailable';
      message: string;
    }
  | { kind: 'workspace-blocked'; reason: WorkspaceExecutionLock; message: string };

export type CloudDisplayState =
  | { kind: 'unavailable'; reason: CloudDisplayUnavailableReason; message: string }
  | { kind: 'connecting'; sessionId: string }
  | { kind: 'live'; sessionId: string; frame: CloudDisplayFrame }
  | { kind: 'stalled'; sessionId: string; lastFrame: CloudDisplayFrame | null }
  | { kind: 'ended'; sessionId: string; lastFrame: CloudDisplayFrame | null };

export interface CloudWorkspace {
  readonly root: HTMLElement;
  setContext(context: { visible: boolean; session: CloudSessionState; link?: CloudLinkState; profileEpoch?: number }): void;
  getState(): CloudDisplayState;
  subscribe(listener: (state: CloudDisplayState) => void): () => void;
  dispose(): void;
}

export interface WorkspaceController {
  mode(): WorkspaceMode;
  select(mode: WorkspaceMode): void;
  lockExecution(): void;
  unlockExecution(): void;
  executionLocked(): boolean;
  workspaceView(): WorkspaceView;
  setWorkspaceView(view: WorkspaceView): void;
  bindCloud(binding: CloudWorkspaceBinding | null): void;
  cloudBinding(): CloudWorkspaceBinding | null;
  lock(reason: WorkspaceExecutionLock): { release(): void };
  composerTarget(): ComposerTarget;
  subscribe(listener: (mode: WorkspaceMode, target: ComposerTarget) => void): () => void;
  dispose(): void;
}

export function disposeCloudDependencies(
  owned: boolean,
  workspace: Pick<WorkspaceController, 'dispose'>,
  controller: Pick<CloudController, 'dispose'>,
): void {
  if (!owned) return;
  workspace.dispose();
  controller.dispose();
}

export type ComposerExecution =
  | { kind: 'local' }
  | { kind: 'cloud-start' }
  | {
      kind: 'cloud';
      sessionId: string;
      threadId: string;
      documentId: string | null;
      expectedVersion: number;
    }
  | { kind: 'blocked'; message: string };

/** The live Cloud session is the conversation handle. A missing mounted binding is not a new start. */
export function shouldOfferAccountForceQuit(snapshot: CloudSnapshot): boolean {
  if (snapshot.account?.raucloud.kind === 'active-elsewhere') return true;
  if (snapshot.account?.quota?.activeRun) return true;
  if (snapshot.profile.kind === 'configured' && snapshot.profile.mode === 'app-hosted') return true;
  if (snapshot.session.kind !== 'idle' && snapshot.session.kind !== 'completed') return true;
  return snapshot.sessions.some((session) => (
    session.kind !== 'completed' && session.kind !== 'failed' && session.kind !== 'cancelled'
  ));
}

export function liveCloudHandle(
  session: CloudSessionState,
): (CloudWorkspaceBinding & { expectedVersion: number }) | null {
  if (session.kind !== 'running') return null;
  return {
    sessionId: session.sessionId,
    threadId: session.threadId,
    documentId: session.documentId,
    expectedVersion: session.version,
  };
}

export function composerExecution(target: ComposerTarget): ComposerExecution {
  switch (target.kind) {
    case 'local-ready':
      return { kind: 'local' };
    case 'cloud-start-ready':
      return { kind: 'cloud-start' };
    case 'cloud-ready':
      return {
        kind: 'cloud',
        sessionId: target.sessionId,
        threadId: target.threadId,
        documentId: target.documentId,
        expectedVersion: target.expectedVersion,
      };
    default:
      return { kind: 'blocked', message: target.message };
  }
}

export function deriveComposerTarget(
  mode: WorkspaceMode,
  snapshot: ReturnType<CloudController['getSnapshot']>,
  cloudBinding: CloudWorkspaceBinding | null = null,
  lock: WorkspaceExecutionLock | null = null,
): ComposerTarget {
  if (lock) {
    return {
      kind: 'workspace-blocked',
      reason: lock,
      message: lock === 'session-selection'
        ? 'Cloud 작업을 연결하는 중입니다.'
        : lock === 'cloud-message'
          ? 'Cloud 메시지를 보내는 중입니다.'
        : lock === 'cloud-transfer'
          ? 'Cloud를 시작하는 중입니다.'
        : '문서 권한을 전환하는 중입니다.',
    };
  }
  if (inferCloudLink(snapshot).kind === 'recreating') {
    return {
      kind: 'workspace-blocked',
      reason: 'cloud-transfer',
      message: 'Cloud 서버를 다시 만드는 중입니다.',
    };
  }
  if (mode === 'local') {
    return snapshot.lease.owner === 'local'
      ? { kind: 'local-ready' }
      : {
          kind: 'local-blocked',
          reason: 'cloud-lease',
          message: 'Cloud 작업이 문서를 사용 중입니다. Cloud로 전환하거나 이 기기에서 이어받으세요.',
        };
  }
  if (inferCloudLink(snapshot).kind !== 'ready') {
    return {
      kind: 'cloud-blocked',
      reason: 'not-accepting-messages',
      message: 'Cloud 연결을 복구하면 이 대화에서 계속할 수 있습니다.',
    };
  }
  const live = liveCloudHandle(snapshot.session);
  if (!cloudBinding) {
    if (snapshot.session.kind === 'transferring' || snapshot.session.kind === 'queued'
      || snapshot.session.kind === 'waiting-local-turn') {
      return {
        kind: 'workspace-blocked',
        reason: 'cloud-transfer',
        message: 'Cloud를 시작하는 중입니다.',
      };
    }
    if (live) {
      return { kind: 'cloud-ready', ...live };
    }
    if (snapshot.session.kind === 'idle') {
      return { kind: 'cloud-start-ready' };
    }
    return {
      kind: 'cloud-blocked',
      reason: 'not-accepting-messages',
      message: '현재 Cloud 작업은 새 메시지를 받을 수 없습니다.',
    };
  }
  if (snapshot.session.kind === 'idle') {
    return { kind: 'cloud-start-ready' };
  }
  if (snapshot.session.kind === 'transferring' || snapshot.session.kind === 'queued'
    || snapshot.session.kind === 'waiting-local-turn') {
    return {
      kind: 'workspace-blocked',
      reason: 'cloud-transfer',
      message: 'Cloud를 시작하는 중입니다.',
    };
  }
  if (live) {
    if (cloudBinding.sessionId !== live.sessionId
      || cloudBinding.threadId !== live.threadId
      || cloudBinding.documentId !== live.documentId) {
      return {
        kind: 'cloud-blocked',
        reason: 'timeline-unavailable',
        message: 'Cloud 대화를 연결하는 중입니다.',
      };
    }
    return { kind: 'cloud-ready', ...live };
  }
  return {
    kind: 'cloud-blocked',
    reason: 'not-accepting-messages',
    message: '현재 Cloud 작업은 새 메시지를 받을 수 없습니다.',
  };
}

function setRootVisible(root: HTMLElement, visible: boolean): void {
  root.inert = !visible;
  root.setAttribute('aria-hidden', visible ? 'false' : 'true');
  root.style.visibility = visible ? 'visible' : 'hidden';
  root.style.pointerEvents = visible ? 'auto' : 'none';
  root.dataset.workspaceVisible = visible ? 'true' : 'false';
}

function mountWorkspaceStack(localRoot: HTMLElement, cloudRoot: HTMLElement): HTMLElement {
  const existing = localRoot.parentElement;
  if (existing?.id === 'workspace-stack') {
    if (cloudRoot.parentElement !== existing) existing.appendChild(cloudRoot);
    return existing;
  }
  const parent = localRoot.parentNode;
  if (!parent) throw new Error('Local workspace root must be mounted');
  const stack = localRoot.ownerDocument.createElement('div');
  stack.id = 'workspace-stack';
  parent.insertBefore(stack, localRoot);
  stack.append(localRoot, cloudRoot);
  return stack;
}

export function createWorkspaceController({
  localRoot,
  cloudWorkspace,
  cloud,
  initialMode = 'local',
}: {
  localRoot: HTMLElement;
  cloudWorkspace: CloudWorkspace;
  cloud: Pick<CloudController, 'getSnapshot' | 'subscribe'>;
  initialMode?: WorkspaceMode;
}): WorkspaceController {
  mountWorkspaceStack(localRoot, cloudWorkspace.root);
  let selectedMode = initialMode;
  let view: WorkspaceView = 'local';
  let executionLocked = false;
  let mountedCloud: CloudWorkspaceBinding | null = null;
  let localScrollPosition: { left: number; top: number } | null = null;
  let disposed = false;
  const locks: Array<{ token: symbol; reason: WorkspaceExecutionLock }> = [];
  let lastNotification = '';
  const listeners = new Set<(mode: WorkspaceMode, target: ComposerTarget) => void>();

  const apply = (): ComposerTarget => {
    const snapshot = cloud.getSnapshot();
    const target = deriveComposerTarget(selectedMode, snapshot, mountedCloud, locks.at(-1)?.reason ?? null);
    setRootVisible(localRoot, view === 'local');
    setRootVisible(cloudWorkspace.root, view === 'cloud');
    cloudWorkspace.setContext({
      visible: view === 'cloud', session: snapshot.session,
      link: inferCloudLink(snapshot), profileEpoch: snapshot.profileEpoch,
    });
    const notification = JSON.stringify([selectedMode, view, target, executionLocked]);
    if (notification !== lastNotification) {
      lastNotification = notification;
      for (const listener of listeners) listener(selectedMode, target);
    }
    return target;
  };

  apply();
  const unsubscribeCloud = cloud.subscribe(() => {
    if (!disposed) apply();
  });

  return {
    mode: () => selectedMode,
    select(mode) {
      if (disposed || mode === selectedMode) return;
      if (executionLocked && mode !== selectedMode) return;
      selectedMode = mode;
      apply();
    },
    lockExecution() {
      if (disposed) return;
      executionLocked = true;
      apply();
    },
    unlockExecution() {
      if (disposed) return;
      executionLocked = false;
      apply();
    },
    executionLocked: () => executionLocked,
    workspaceView: () => view,
    setWorkspaceView(next) {
      if (disposed || next === view) return;
      const scrollContainer = typeof localRoot.querySelector === 'function'
        ? localRoot.querySelector<HTMLElement>('#scroll-container')
        : null;
      if (view === 'local' && next === 'cloud' && scrollContainer) {
        localScrollPosition = {
          left: scrollContainer.scrollLeft,
          top: scrollContainer.scrollTop,
        };
      }
      view = next;
      apply();
      if (next === 'local' && scrollContainer && localScrollPosition) {
        scrollContainer.scrollLeft = localScrollPosition.left;
        scrollContainer.scrollTop = localScrollPosition.top;
      }
    },
    bindCloud(binding) {
      if (disposed) return;
      if (JSON.stringify(binding) === JSON.stringify(mountedCloud)) return;
      mountedCloud = binding;
      apply();
    },
    cloudBinding: () => mountedCloud,
    lock(reason) {
      if (disposed) return { release() {} };
      const entry = { token: Symbol(reason), reason };
      locks.push(entry);
      apply();
      let released = false;
      return {
        release() {
          if (released || disposed) return;
          released = true;
          const index = locks.findIndex((candidate) => candidate.token === entry.token);
          if (index >= 0) locks.splice(index, 1);
          apply();
        },
      };
    },
    composerTarget: () => deriveComposerTarget(
      selectedMode,
      cloud.getSnapshot(),
      mountedCloud,
      locks.at(-1)?.reason ?? null,
    ),
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(selectedMode, deriveComposerTarget(
        selectedMode,
        cloud.getSnapshot(),
        mountedCloud,
        locks.at(-1)?.reason ?? null,
      ));
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeCloud();
      locks.length = 0;
      mountedCloud = null;
      executionLocked = false;
      view = 'local';
      listeners.clear();
      cloudWorkspace.dispose();
    },
  };
}
