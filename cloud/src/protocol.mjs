export const PROTOCOL_VERSION = 1;
export const PROVIDERS = Object.freeze(['claude', 'codex', 'pi', 'grok', 'cursor']);
export const SESSION_STATES = Object.freeze([
  'staged',
  'queued',
  'running',
  'suspended',
  'completed',
  'failed',
  'cancelled',
  'purged',
]);
export const COMMAND_TYPES = Object.freeze([
  'session.activate',
  'session.cancel',
  'session.takeover',
  'session.pause',
  'session.resume',
  'message.queue',
]);

export const DEFAULT_LIMITS = Object.freeze({
  maxRunningSessions: 2,
  maxQueuedSessions: 20,
  maxDurationSeconds: 8 * 60 * 60,
  maxTurns: 100,
  cpuCount: 2,
  memoryBytes: 2 * 1024 ** 3,
  pids: 512,
  workspaceBytes: 2 * 1024 ** 3,
});

export const TRANSFER_LIMITS = Object.freeze({
  maxDocumentBytes: 64 * 1024 ** 2,
  maxReferenceBytes: 128 * 1024 ** 2,
  maxTransferBytes: 512 * 1024 ** 2,
  maxTimelineBytes: 100 * 1024 ** 2,
  chunkBytes: 4 * 1024 ** 2,
});

export const EXECUTION_WORKFLOWS = Object.freeze(['direct', 'plan']);

export class CloudError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CloudError('INVALID_REQUEST', `${label} must be an object`);
  }
  return value;
}

function string(value, label, { min = 1, max = 512, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    throw new CloudError('INVALID_REQUEST', `${label} is invalid`);
  }
  return value;
}

function integer(value, label, { min, max } = {}) {
  if (!Number.isSafeInteger(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw new CloudError('INVALID_REQUEST', `${label} is invalid`);
  }
  return value;
}

function optionalString(value, label, options) {
  return value === undefined || value === null ? null : string(value, label, options);
}

function sha256(value, label = 'sha256') {
  return string(value, label, { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
}

export function parsePairingRedeem(value) {
  const input = object(value, 'body');
  return {
    code: string(input.code, 'code', { min: 8, max: 128 }),
    deviceName: string(input.deviceName, 'deviceName', { min: 1, max: 120 }),
  };
}

export function parsePairingCreate(value) {
  const input = object(value, 'body');
  return { deviceName: optionalString(input.deviceName, 'deviceName', { min: 1, max: 120 }) };
}

export function parseRefresh(value) {
  const input = object(value, 'body');
  return { refreshToken: string(input.refreshToken, 'refreshToken', { min: 32, max: 1024 }) };
}

function parseResource(value, index) {
  const input = object(value, `resources[${index}]`);
  return {
    blobId: sha256(input.blobId ?? input.sha256, `resources[${index}].blobId`),
    size: integer(input.size, `resources[${index}].size`, { min: 0, max: TRANSFER_LIMITS.maxReferenceBytes }),
    name: string(input.name, `resources[${index}].name`, { min: 1, max: 255 }),
    kind: string(input.kind, `resources[${index}].kind`, { min: 1, max: 32, pattern: /^(document|reference|timeline|result)$/ }),
  };
}

export function parseSessionCreate(value) {
  const input = object(value, 'body');
  const origin = object(input.originDocument, 'originDocument');
  const limits = input.limits === undefined ? {} : object(input.limits, 'limits');
  const resources = input.resources === undefined ? [] : input.resources;
  const clientContext = input.clientContext === undefined ? null : object(input.clientContext, 'clientContext');
  const executionConfig = input.executionConfig === undefined ? null : object(input.executionConfig, 'executionConfig');
  if (!Array.isArray(resources) || resources.length > 200) {
    throw new CloudError('INVALID_REQUEST', 'resources is invalid');
  }
  const provider = string(input.provider, 'provider', { max: 32 });
  if (!PROVIDERS.includes(provider)) throw new CloudError('INVALID_PROVIDER', 'provider is not supported');
  return {
    sessionId: optionalString(input.sessionId, 'sessionId', { min: 8, max: 128, pattern: /^[a-zA-Z0-9_-]+$/ }),
    provider,
    goal: string(input.goal, 'goal', { min: 1, max: 64 * 1024 }),
    clientContext: clientContext ? {
      threadId: string(clientContext.threadId, 'clientContext.threadId', { min: 1, max: 256 }),
      documentId: optionalString(clientContext.documentId, 'clientContext.documentId', { min: 1, max: 256 }),
    } : null,
    executionConfig: executionConfig ? (() => {
      const workflow = string(executionConfig.workflow, 'executionConfig.workflow', { min: 1, max: 32 });
      if (!EXECUTION_WORKFLOWS.includes(workflow)) {
        throw new CloudError('INVALID_REQUEST', 'executionConfig.workflow is invalid');
      }
      const permissionProfile = string(
        executionConfig.permissionProfile,
        'executionConfig.permissionProfile',
        { min: 1, max: 32 },
      );
      if (permissionProfile !== 'unrestricted') {
        throw new CloudError('INVALID_REQUEST', 'Cloud sessions require the unrestricted permission profile');
      }
      return {
        model: string(executionConfig.model, 'executionConfig.model', { min: 1, max: 256 }),
        effort: string(executionConfig.effort, 'executionConfig.effort', { min: 1, max: 64 }),
        workflow,
        permissionProfile,
      };
    })() : null,
    originDocument: {
      name: string(origin.name, 'originDocument.name', { min: 1, max: 255 }),
      blobId: sha256(origin.blobId ?? origin.sha256, 'originDocument.blobId'),
      size: integer(origin.size, 'originDocument.size', { min: 1, max: TRANSFER_LIMITS.maxDocumentBytes }),
    },
    resources: resources.map(parseResource),
    timeline: input.timeline === undefined ? null : (() => {
      const timeline = object(input.timeline, 'timeline');
      return {
        blobId: sha256(timeline.blobId ?? timeline.sha256, 'timeline.blobId'),
        size: integer(timeline.size, 'timeline.size', { min: 0, max: TRANSFER_LIMITS.maxTimelineBytes }),
      };
    })(),
    limits: {
      maxDurationSeconds: limits.maxDurationSeconds === undefined
        ? DEFAULT_LIMITS.maxDurationSeconds
        : integer(limits.maxDurationSeconds, 'limits.maxDurationSeconds', { min: 15 * 60, max: 24 * 60 * 60 }),
      maxTurns: limits.maxTurns === undefined
        ? DEFAULT_LIMITS.maxTurns
        : integer(limits.maxTurns, 'limits.maxTurns', { min: 1, max: 500 }),
    },
  };
}

export function parseCommand(value) {
  const input = object(value, 'body');
  const type = string(input.type, 'type', { max: 64 });
  if (!COMMAND_TYPES.includes(type)) throw new CloudError('INVALID_COMMAND', 'command type is not supported');
  return {
    commandId: string(input.commandId, 'commandId', { min: 8, max: 128, pattern: /^[a-zA-Z0-9_-]+$/ }),
    type,
    payload: input.payload === undefined ? {} : object(input.payload, 'payload'),
  };
}

export function parseUploadInit(value) {
  const input = object(value, 'body');
  const kind = string(input.kind, 'kind', { min: 1, max: 32, pattern: /^(document|reference|resource|timeline|result)$/ });
  const maximum = kind === 'document' || kind === 'result' ? TRANSFER_LIMITS.maxDocumentBytes
    : kind === 'reference' || kind === 'resource' ? TRANSFER_LIMITS.maxReferenceBytes
      : kind === 'timeline' ? TRANSFER_LIMITS.maxTimelineBytes
        : TRANSFER_LIMITS.maxTransferBytes;
  return {
    sha256: sha256(input.sha256),
    size: integer(input.size, 'size', { min: 0, max: maximum }),
    name: string(input.name, 'name', { min: 1, max: 255 }),
    kind,
    sessionId: optionalString(input.sessionId, 'sessionId', { min: 8, max: 128, pattern: /^[a-zA-Z0-9_-]+$/ }),
  };
}

export function parseDownloadConfirmation(value) {
  const input = object(value, 'body');
  return {
    sha256: sha256(input.sha256),
    size: integer(input.size, 'size', { min: 0, max: TRANSFER_LIMITS.maxTransferBytes }),
  };
}

export function publicSession(row) {
  return {
    id: row.id,
    provider: row.provider,
    goal: row.goal,
    status: row.status,
    stateVersion: row.state_version,
    originDeviceId: row.origin_device_id,
    clientContext: row.client_thread_id
      ? { threadId: row.client_thread_id, documentId: row.client_document_id }
      : null,
    executionConfig: row.execution_config_json ? JSON.parse(row.execution_config_json) : null,
    originDocument: {
      name: row.origin_name,
      sha256: row.origin_sha256,
      size: row.origin_size,
    },
    limits: {
      maxDurationSeconds: row.max_duration_seconds,
      maxTurns: row.max_turns,
    },
    turnsUsed: row.turns_used,
    pauseRequested: Boolean(row.pause_requested_at),
    takeoverRequested: Boolean(row.takeover_requested_at),
    takeoverReady: Boolean(row.frozen_checkpoint_operation_id),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    suspendedReason: row.suspended_reason ? JSON.parse(row.suspended_reason) : null,
    result: row.result_sha256 ? { sha256: row.result_sha256, size: row.result_size } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
