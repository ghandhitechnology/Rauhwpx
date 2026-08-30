export type ManagedCloudRunStatus =
  | 'allocating'
  | 'ready'
  | 'active'
  | 'checkpointed'
  | 'completed'
  | 'stopped'
  | 'failed';

export interface RauAccountSnapshot {
  id: string;
  email: string | null;
  loggedIn: true;
  timezone: string | null;
  pendingTimezone: string | null;
  timezoneEffectiveAt: number | null;
  timezoneChangeAvailableAt: number | null;
}

export interface CloudQuotaSnapshot {
  limitMs: 3_600_000;
  usedMs: number;
  debtAppliedMs: number;
  remainingMs: number;
  resetsAt: number | null;
  timezone: string | null;
  grace: {
    active: boolean;
    usedMs: number;
    limitMs: 1_800_000;
    remainingMs: number;
    debtMs: number;
  };
  coldStarts: {
    usedToday: number;
    dailyLimit: 12;
    recent: number;
    recentLimit: 3;
  };
}

export interface ManagedCloudReceipt {
  endpoint: string;
  serverPublicKey: string;
  pairingCode: string;
}

export interface CloudRunSummary {
  id: string;
  status: ManagedCloudRunStatus;
  ownerDeviceId: string;
  createdAt: number;
  allocatedAt: number | null;
  completedAt: number | null;
  checkpointId: string | null;
  inputBlocked: boolean;
  graceDeadlineAt: number | null;
  /** Present only when the requesting token is bound to ownerDeviceId. */
  receipt: ManagedCloudReceipt | null;
}

export interface ManagedCloudGate {
  state: 'ready' | 'timezone_required' | 'quota_exhausted' | 'owned_elsewhere' | 'grace_active' | 'unavailable';
  canStart: boolean;
  canTakeover: boolean;
  reason: string | null;
}

export interface CloudStatusEnvelope {
  account: RauAccountSnapshot;
  quota: CloudQuotaSnapshot;
  worker: null | {
    id: string;
    status: string;
    ownerDeviceId: string;
    runId: string;
    warmUntil: number | null;
    receipt: ManagedCloudReceipt | null;
  };
  activeRun: CloudRunSummary | null;
  takeoverRun: CloudRunSummary | null;
  gate: ManagedCloudGate;
}

export interface CloudRunEnvelope extends CloudStatusEnvelope {
  run: CloudRunSummary;
  coldStart?: boolean;
}
