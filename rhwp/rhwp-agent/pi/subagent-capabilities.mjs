import crypto from 'node:crypto';

import { filterToolDefinitions } from '../tools.mjs';

export const PI_SUBAGENT_MAX_RUNNING = 4;
export const PI_SUBAGENT_ROLES = Object.freeze(['doc-editor', 'doc-researcher', 'general']);

const CHILD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_PATTERN = /^sa-[1-9][0-9]{0,8}$/;
const ROOT_ONLY_TOOLS = new Set([
  'ask_user_question',
  'delegate_copy_layout',
  'present_implementation_plan',
  'register_copy_layout_template',
  'update_agent_instructions',
]);
const CHILD_DOCUMENT_CATEGORIES = new Set([
  'instruction-read',
  'document-read',
  'document-write',
  'reference-read',
  'template-read',
]);

function capabilityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireActivePiTurn(activeSession) {
  if (!activeSession || !['pi', 'rau'].includes(activeSession.agent)) {
    throw capabilityError('PI_SUBAGENT_ROOT_REQUIRED', 'A Pi or Rau root turn is required');
  }
  if (activeSession.providerRole !== 'chat' || !activeSession.providerCapabilityResource) {
    throw capabilityError('PI_SUBAGENT_ROOT_REQUIRED', 'A root provider capability is required');
  }
  if (activeSession.status !== 'running'
    || activeSession.providerTurnStarted !== true
    || typeof activeSession.turnId !== 'string'
    || activeSession.turnId.length === 0) {
    throw capabilityError('NO_ACTIVE_TURN', 'Pi subagents require an active provider turn');
  }
  return activeSession;
}

function requireChildId(value) {
  const childId = typeof value === 'string' ? value : '';
  if (!CHILD_ID_PATTERN.test(childId)) {
    throw capabilityError('INVALID_PI_SUBAGENT_ID', 'childId must be a UUID');
  }
  return childId.toLowerCase();
}

function requireTaskId(value) {
  const taskId = typeof value === 'string' ? value : '';
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw capabilityError('INVALID_PI_SUBAGENT_TASK', 'taskId must use the sa-N display-id format');
  }
  return taskId;
}

function requireRole(value) {
  if (!PI_SUBAGENT_ROLES.includes(value)) {
    throw capabilityError('INVALID_PI_SUBAGENT_ROLE', `role must be one of ${PI_SUBAGENT_ROLES.join(', ')}`);
  }
  return value;
}

function allowedToolsFor(role, parentProfile) {
  const profile = role === 'doc-researcher' ? 'doc-researcher' : String(parentProfile ?? '');
  if (!profile) {
    throw capabilityError('INVALID_PI_SUBAGENT_PROFILE', 'The parent tool profile is required');
  }
  return new Set(
    filterToolDefinitions(profile)
      .filter((definition) => CHILD_DOCUMENT_CATEGORIES.has(definition.category))
      .map((definition) => definition.name)
      .filter((name) => !ROOT_ONLY_TOOLS.has(name)),
  );
}

export class PiSubagentCapabilityRegistry {
  #registrations = new Map();

  register({ activeSession, childId, taskId, role, parentProfile }) {
    const parent = requireActivePiTurn(activeSession);
    const normalizedChildId = requireChildId(childId);
    const normalizedTaskId = requireTaskId(taskId);
    const normalizedRole = requireRole(role);
    if (this.#registrations.has(normalizedChildId)) {
      throw capabilityError('PI_SUBAGENT_EXISTS', 'This Pi subagent is already registered');
    }
    if (this.#registrations.size >= PI_SUBAGENT_MAX_RUNNING) {
      throw capabilityError(
        'PI_SUBAGENT_LIMIT_REACHED',
        `At most ${PI_SUBAGENT_MAX_RUNNING} Pi subagents may be active`,
      );
    }
    const profile = normalizedRole === 'doc-researcher'
      ? 'doc-researcher'
      : String(parentProfile ?? '');
    const allowedTools = allowedToolsFor(normalizedRole, parentProfile);
    const registration = Object.freeze({
      childId: normalizedChildId,
      taskId: normalizedTaskId,
      role: normalizedRole,
      profile,
      allowedTools,
      catalogProfile: [...allowedTools].join(','),
      agent: parent.agent,
      agentRole: `pi-subagent.${normalizedChildId}.${normalizedRole}`,
      providerGeneration: parent.generation,
      parentTurnId: parent.turnId,
      resource: `pi-subagent.${parent.generation}.${normalizedChildId}.${crypto.randomUUID()}`,
    });
    this.#registrations.set(normalizedChildId, registration);
    return registration;
  }

  get(childId) {
    let normalized;
    try { normalized = requireChildId(childId); } catch { return null; }
    return this.#registrations.get(normalized) ?? null;
  }

  revoke(childId) {
    const registration = this.get(childId);
    if (!registration) return null;
    this.#registrations.delete(registration.childId);
    return registration;
  }

  isCurrent(registration, activeSession) {
    return Boolean(
      registration
      && this.#registrations.get(registration.childId) === registration
      && activeSession
      && activeSession.agent === registration.agent
      && activeSession.generation === registration.providerGeneration
      && activeSession.providerRole === 'chat'
      && activeSession.status === 'running'
      && activeSession.providerTurnStarted === true
      && activeSession.turnId === registration.parentTurnId,
    );
  }

  clearTurn(activeSession) {
    const removed = [];
    for (const registration of this.#registrations.values()) {
      if (registration.agent !== activeSession?.agent
        || registration.providerGeneration !== activeSession?.generation
        || registration.parentTurnId !== activeSession?.turnId) continue;
      this.#registrations.delete(registration.childId);
      removed.push(registration);
    }
    return removed;
  }

  clear() {
    const removed = [...this.#registrations.values()];
    this.#registrations.clear();
    return removed;
  }

  get size() {
    return this.#registrations.size;
  }
}
