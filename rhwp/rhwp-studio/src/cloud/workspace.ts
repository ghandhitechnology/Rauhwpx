import type { CloudController } from './desktop-cloud.ts';
import type {
  CloudDisplayFrame,
  CloudDisplayUnavailableReason,
  CloudSessionScope,
  CloudSessionState,
  CloudSnapshot,
} from './types.ts';

export type WorkspaceMode = 'local' | 'cloud';

export function canSelectCloudWorkspace(mode: WorkspaceMode, localTurnRunning: boolean): boolean {
  return mode === 'cloud' || !localTurnRunning;
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
  | { kind: 'cloud-ready'; sessionId: string; threadId: string; documentId: string | null; expectedVersion: number }
  | {
      kind: 'cloud-blocked';
      reason: 'no-session' | 'not-accepting-messages' | 'timeline-unavailable';
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
  setContext(context: { visible: boolean; session: CloudSessionState }): void;
  getState(): CloudDisplayState;
  subscribe(listener: (state: CloudDisplayState) => void): () => void;
  dispose(): void;
}

export interface WorkspaceController {
  mode(): WorkspaceMode;
  select(mode: WorkspaceMode): void;
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
  | {
      kind: 'cloud';
      sessionId: string;
      threadId: string;
      documentId: string | null;
      expectedVersion: number;
    }
  | { kind: 'blocked'; message: string };

export function composerExecution(target: ComposerTarget): ComposerExecution {
  switch (target.kind) {
    case 'local-ready':
      return { kind: 'local' };
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
        : '문서 권한을 전환하는 중입니다.',
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
  if (snapshot.session.kind === 'idle') {
    return {
      kind: 'cloud-blocked',
      reason: 'no-session',
      message: '선택된 Cloud 작업이 없습니다.',
    };
  }
  if (snapshot.session.kind === 'running') {
    if (!cloudBinding
      || cloudBinding.sessionId !== snapshot.session.sessionId
      || cloudBinding.threadId !== snapshot.session.threadId
      || cloudBinding.documentId !== snapshot.session.documentId) {
      return {
        kind: 'cloud-blocked',
        reason: 'timeline-unavailable',
        message: 'Cloud 대화를 연결하는 중입니다.',
      };
    }
    return {
      kind: 'cloud-ready',
      sessionId: snapshot.session.sessionId,
      threadId: snapshot.session.threadId,
      documentId: snapshot.session.documentId,
      expectedVersion: snapshot.session.version,
    };
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
  let mountedCloud: CloudWorkspaceBinding | null = null;
  let disposed = false;
  const locks: Array<{ token: symbol; reason: WorkspaceExecutionLock }> = [];
  let lastNotification = '';
  const listeners = new Set<(mode: WorkspaceMode, target: ComposerTarget) => void>();

  const apply = (): ComposerTarget => {
    const snapshot = cloud.getSnapshot();
    const target = deriveComposerTarget(selectedMode, snapshot, mountedCloud, locks.at(-1)?.reason ?? null);
    setRootVisible(localRoot, selectedMode === 'local');
    setRootVisible(cloudWorkspace.root, selectedMode === 'cloud');
    cloudWorkspace.setContext({ visible: selectedMode === 'cloud', session: snapshot.session });
    const notification = JSON.stringify([selectedMode, target]);
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
      selectedMode = mode;
      apply();
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
      listeners.clear();
      cloudWorkspace.dispose();
    },
  };
}
