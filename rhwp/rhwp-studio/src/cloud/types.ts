import type { AgentName, AgentWorkflow, PermissionProfile } from '../agent/types.ts';
import type { PortableCloudTimelineV1 } from './timeline.ts';

export type CloudTransportDraft =
  | { kind: 'tailscale' }
  | { kind: 'ssh-tunnel' }
  | { kind: 'https'; endpoint: string };

export type CloudSshAuthDraft =
  | { kind: 'ssh-agent' }
  | { kind: 'key-file'; keyPath: string };

export interface CloudProfileDraft {
  name: string;
  host: string;
  sshUser: string;
  sshPort: number;
  tailscaleHttpsPort?: number;
  auth: CloudSshAuthDraft;
  transport: CloudTransportDraft;
  serverPublicKey?: string;
}

export type CloudServerMode = 'self-hosted' | 'app-hosted';
export type CloudConnectionState = 'unknown' | 'testing' | 'ready' | 'error';

/** Live transport to the Cloud server. Missing on older snapshots; infer from profile.connection. */
export type CloudLinkKind = 'ready' | 'reconnecting' | 'recreating' | 'failed';

export interface CloudLinkState {
  kind: CloudLinkKind;
  error: string | null;
  attempt: number;
  canRecreate: boolean;
}

/** Raucloud usage shared by every device on an account. Durations use milliseconds. */
export interface CloudQuotaSnapshot {
  dailyLimitMs: number;
  usedMs: number;
  remainingMs: number;
  debtMs: number;
  graceUsedMs: number;
  resetAt: string;
  timeZone: string;
  activeRun: {
    runId: string;
    deviceId: string;
    deviceName?: string | null;
    startedAt: string;
    controllingThisDevice: boolean;
  } | null;
  coldStarts: {
    usedToday: number;
    dailyLimit: number;
    recent: number;
    recentLimit: number;
  };
  graceEndsAt?: string | null;
}

/** Why the app-hosted Cloud path can or cannot start a new run. Self-hosted ignores this gate. */
export type RaucloudGate =
  | { kind: 'available' }
  | { kind: 'logged-out' }
  | { kind: 'exhausted'; resetAt: string }
  | { kind: 'active-elsewhere'; runId: string; deviceName?: string | null }
  | { kind: 'unavailable'; reason: string };

export interface AccountSnapshot {
  signedIn: boolean;
  account: {
    id: string;
    email: string;
    displayName?: string | null;
  } | null;
  quota: CloudQuotaSnapshot | null;
  raucloud: RaucloudGate;
  updatedAt: string;
}

/** 앱이 제공하는 샌드박스의 수명주기. 사용자가 다음 행동을 고를 수 있는 단위로만 나눈다. */
export type SandboxLifecycle = 'idle' | 'provisioning' | 'ready' | 'error' | 'tearing-down';

export interface CloudSandboxSummary {
  providerId: string;
  sandboxId: string;
  displayName: string;
  region: string;
  host: string;
  createdAt: string;
}

export interface CloudAppServerProvider {
  providerId: string;
  displayName: string;
  configured: boolean;
  missingConfig: string[];
}

export interface CloudServerState {
  mode: CloudServerMode | null;
  preferredMode: CloudServerMode | null;
  providers: CloudAppServerProvider[];
  lifecycle: SandboxLifecycle;
  message: string | null;
}

interface CloudProfileStateBase {
  kind: 'configured';
  connection: CloudConnectionState;
  serviceVersion: string | null;
  message: string | null;
}

export type CloudProfileState =
  | { kind: 'unconfigured' }
  | (CloudProfileStateBase & { mode: 'self-hosted'; profile: CloudProfileDraft })
  | (CloudProfileStateBase & { mode: 'app-hosted'; name: string; sandbox: CloudSandboxSummary });

export interface CloudQueuedMessage {
  id: string;
  text: string;
  queuedAt: string;
  state: 'queued' | 'accepted';
}

export interface CloudProviderSelection {
  agent: AgentName;
  model: string;
  effort: string;
}

export interface CloudSessionBase {
  selection?: CloudProviderSelection;
  configurationPending?: boolean;
  sessionId: string;
  version: number;
  threadId: string;
  documentId: string | null;
  documentName: string;
}

export interface CloudConversationWait {
  id: string;
  kind: 'plan-approval' | 'question' | 'external-side-effect' | 'destructive-external';
  payload: Record<string, unknown>;
}

export type CloudSessionState =
  | { kind: 'idle' }
  | (CloudSessionBase & {
      kind: 'waiting-local-turn';
      message: string;
    })
  | (CloudSessionBase & {
      kind: 'transferring';
      stage: 'preparing' | 'uploading' | 'committing' | 'starting';
      completedBytes: number;
      totalBytes: number;
      message: string;
    })
  | (CloudSessionBase & {
      kind: 'queued';
      position: number;
      message: string;
    })
  | (CloudSessionBase & {
      kind: 'running';
      startedAt: string;
      turn: number;
      turnLimit: number;
      elapsedMs: number;
      timeLimitMs: number;
      currentActivity: string;
      phase: 'working' | 'waiting' | 'redirecting' | 'awaiting-plan-approval'
        | 'awaiting-question-answer' | 'awaiting-external-effect-approval';
      wait: CloudConversationWait | null;
    })
  | (CloudSessionBase & {
      kind: 'pausing';
      message: string;
    })
  | (CloudSessionBase & {
      kind: 'suspended';
      reason: string;
      resumable: boolean;
    })
  | (CloudSessionBase & {
      kind: 'taking-over';
      message: string;
    })
  | (CloudSessionBase & {
      kind: 'completed';
      completedAt: string;
      result: CloudResultSummary;
    })
  | (CloudSessionBase & {
      kind: 'failed';
      code: string;
      message: string;
      retryable: boolean;
    })
  | (CloudSessionBase & {
      kind: 'cancelled';
      cancelledAt: string;
    });

export type CloudDocumentLease =
  | { owner: 'local' }
  | { owner: 'cloud'; sessionId: string; acquiredAt: string };

export interface CloudResultSummary {
  fileName: string;
  byteLength: number;
  sha256: string;
  downloaded: boolean;
  availableOnThisDevice: boolean;
  expiresAt: string | null;
  conflict: 'none' | 'external-change';
  preservedCopyName: string | null;
}

/** 철거 결과. 이 빌드가 다룰 수 없는 샌드박스는 연결만 놓고 원격 서버는 남는다. */
export interface CloudSandboxOutcome {
  removed: boolean;
  unmanaged: boolean;
}

export interface CloudSnapshot {
  revision: number;
  profileEpoch: number;
  available: boolean;
  profile: CloudProfileState;
  server: CloudServerState;
  sandbox?: CloudSandboxOutcome;
  lease: CloudDocumentLease;
  session: CloudSessionState;
  sessions: Exclude<CloudSessionState, { kind: 'idle' }>[];
  queuedMessages: CloudQueuedMessage[];
  timeline: PortableCloudTimelineV1 | null;
  updatedAt: string;
  /** Present when the desktop is connected to the Raucloud account broker. */
  account?: AccountSnapshot | null;
  takeover?: CloudTakeoverPayload;
  link?: CloudLinkState;
}

export interface CloudTakeoverPayload {
  operationId: string;
  document: (CloudDocumentPayload & {
    byteLength: number;
    recoveryPath: string;
    revision: number;
    turn: number;
  }) | null;
  timeline: PortableCloudTimelineV1;
}

export interface CloudDocumentPayload {
  originSha256?: string | null;
  bytes: Uint8Array;
  fileName: string;
  sha256: string;
}

export interface CloudCheckpointPayload extends CloudDocumentPayload {
  sessionId: string;
  documentId: string | null;
  kind: 'handoff' | 'operation' | 'turn';
  publication?: 'written' | 'unchanged' | 'conflict' | 'archive-only';
  preservedCopyName?: string | null;
  originOnThisDevice?: boolean;
  expectedOriginSha256?: string;
  byteLength: number;
  revision: number;
  turn: number;
  operationId: string;
}

export interface CloudTransferReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  scope: 'chat' | 'document' | 'global';
  scopeId: string;
  bytes: Uint8Array;
}

export interface CloudInitialMessage {
  id: string;
  text: string;
  attachmentReferenceIds: string[];
}

export interface CloudTransferRequest {
  startId: string;
  threadId: string;
  documentId: string | null;
  documentName: string;
  agent: AgentName;
  model: string;
  effort: string;
  workflow: AgentWorkflow;
  permissionProfile: Extract<PermissionProfile, 'unrestricted'>;
  timeline: PortableCloudTimelineV1;
  initialMessage: CloudInitialMessage;
  document: CloudDocumentPayload;
  references: CloudTransferReference[];
  limits: {
    maxDurationMs: number;
    maxTurns: number;
  };
}

export interface CloudSessionScope {
  threadId: string;
  documentId: string | null;
  selectedSessionId?: string | null;
}

export type CloudDisplayUnavailableReason =
  | 'server-unsupported'
  | 'session-not-running'
  | 'stream-unavailable'
  | 'client-unsupported';

export interface CloudDisplayAvailableCapability {
  kind: 'available';
  protocol: 'rauhwpx-frame-v1';
  sessionId: string;
  streamId: string;
  width: number;
  height: number;
  maxFrameBytes: 524288;
  maxFps: 12;
  inputProtocol: 'rauhwpx-input-v1';
  maxInputEventsPerSecond: 60;
  supportsClickCount?: boolean;
  inputBatchSize?: 32;
}

export interface CloudDisplayUnavailableCapability {
  kind: 'unavailable';
  sessionId: string;
  reason: CloudDisplayUnavailableReason;
  message: string;
  retryable: boolean;
}

export type CloudDisplayCapability =
  | CloudDisplayAvailableCapability
  | CloudDisplayUnavailableCapability;

export interface CloudDisplayFrameMetadata {
  sessionId: string;
  streamId: string;
  sequence: number;
  capturedAt: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg';
  byteLength: number;
  sha256: string;
  framePath: string;
}

export interface CloudDisplayFrame extends CloudDisplayFrameMetadata {
  kind: 'frame';
  bytes: Uint8Array;
}

export type CloudDisplayConnectionState =
  | {
      kind: 'connection';
      state: 'connecting';
      sessionId: string;
      streamId: null;
      retryable: true;
    }
  | {
      kind: 'connection';
      state: 'connected';
      sessionId: string;
      streamId: string;
      retryable: true;
      capability: CloudDisplayAvailableCapability;
    }
  | {
      kind: 'connection';
      state: 'reconnecting';
      sessionId: string;
      streamId: string | null;
      retryable: true;
      attempt: number;
      message: string;
    }
  | {
      kind: 'connection';
      state: 'failed';
      sessionId: string;
      streamId: string | null;
      retryable: false;
      code: string;
      message: string;
    };

export type CloudDisplayEvent =
  | CloudDisplayFrame
  | CloudDisplayUnavailableCapability
  | CloudDisplayConnectionState;

export type CloudDisplayInputEvent =
  | { kind: 'pointer'; action: 'move'; x: number; y: number }
  | { kind: 'pointer'; action: 'down' | 'up'; x: number; y: number; button: 'left' | 'middle' | 'right' | 'back' | 'forward'; clickCount?: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; action: 'down' | 'up'; key: string }
  | { kind: 'text'; text: string };

export interface CloudDisplayConnection {
  readonly capability: CloudDisplayCapability;
  sendInput(event: CloudDisplayInputEvent): Promise<void>;
  close(): Promise<void>;
}

export interface CloudTransferIntentRequest extends CloudSessionScope {
  pending: boolean;
}

export type CloudCommand =
  | 'pause'
  | 'resume'
  | 'takeover'
  | 'cancel'
  | 'end'
  | 'retry'
  | 'resolve-wait'
  | 'redirect'
  | 'workflow'
  | 'configure'
  | 'queue-message';

export interface CloudFollowupAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

export interface CloudCommandRequest {
  sessionId: string;
  command: CloudCommand;
  expectedVersion: number;
  message?: string;
  messageId?: string;
  payload?: Record<string, unknown>;
  attachments?: CloudFollowupAttachment[];
}

export interface CloudDownloadResult {
  sessionId: string;
  fileName: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  recoveryPath: string;
  previewOpened: boolean;
  conflict: 'none' | 'external-change';
  preservedCopyName: string | null;
  timeline: PortableCloudTimelineV1 | null;
}

export type CloudResultAction = 'replace' | 'keep-both' | 'discard';

export interface CloudResultResolution {
  action: CloudResultAction;
  path: string | null;
  bytes: Uint8Array | null;
  conflict: 'none' | 'external-change';
  preservedCopyName: string | null;
  snapshot: CloudSnapshot;
}
