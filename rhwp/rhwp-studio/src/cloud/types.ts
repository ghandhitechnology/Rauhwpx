import type { AgentName, AgentWorkflow, PermissionProfile } from '../agent/types.ts';
import type { PortableCloudTimelineV1 } from './timeline.ts';

export type CloudTransportDraft =
  | { kind: 'tailscale' }
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

export const LOCAL_SESSION_PROVIDERS = ['claude', 'codex', 'grok', 'cursor'] as const;

export interface CloudSandboxCredential {
  provider: string | null;
  stored: boolean;
  localProviders: string[];
}

export interface CloudServerState {
  mode: CloudServerMode | null;
  preferredMode: CloudServerMode | null;
  providers: CloudAppServerProvider[];
  lifecycle: SandboxLifecycle;
  message: string | null;
  credential?: CloudSandboxCredential;
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

export interface CloudSessionBase {
  sessionId: string;
  version: number;
  threadId: string;
  documentId: string | null;
  documentName: string;
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
  takeover?: CloudTakeoverPayload;
}

export interface CloudTakeoverPayload {
  document: (CloudDocumentPayload & {
    byteLength: number;
    recoveryPath: string;
    revision: number;
    turn: number;
  }) | null;
  timeline: PortableCloudTimelineV1;
}

export interface CloudDocumentPayload {
  bytes: Uint8Array;
  fileName: string;
  sha256: string;
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

export interface CloudTransferRequest {
  threadId: string;
  documentId: string | null;
  documentName: string;
  agent: AgentName;
  model: string;
  effort: string;
  workflow: AgentWorkflow;
  permissionProfile: Extract<PermissionProfile, 'unrestricted'>;
  timeline: PortableCloudTimelineV1;
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

export interface CloudTransferIntentRequest extends CloudSessionScope {
  pending: boolean;
}

export type CloudCommand =
  | 'pause'
  | 'resume'
  | 'takeover'
  | 'cancel'
  | 'retry'
  | 'queue-message';

export interface CloudCommandRequest {
  sessionId: string;
  command: CloudCommand;
  expectedVersion: number;
  message?: string;
  messageId?: string;
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
