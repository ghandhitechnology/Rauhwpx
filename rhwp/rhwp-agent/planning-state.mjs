import crypto from 'node:crypto';

import { humanizerPromptBlock } from './humanizer.mjs';

export const WORKFLOWS = Object.freeze(['direct', 'plan']);
export const PLAN_PHASES = Object.freeze(['planning', 'awaiting-approval', 'switching', 'implementing']);

export function workflowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** @param {'planning'|'awaiting-approval'|'switching'|'implementing'|null} phase */
export function toolProfileForPhase(phase) {
  if (phase === 'implementing' || phase === 'switching') return 'implementing';
  if (phase === 'awaiting-approval') return 'awaiting-approval';
  return 'planning';
}

/**
 * Hub-authoritative workflow state. The capability epoch changes whenever the
 * effective phase/capabilities change, invalidating MCP processes from an old
 * provider configuration.
 */
export class PlanningState {
  /**
   * @param {{workflow?: 'direct'|'plan', initialCapabilityEpoch?: number, allocateEpoch?: () => number, createPlanId?: () => string, now?: () => string}} [options]
   */
  constructor(options = {}) {
    const workflow = options.workflow ?? 'direct';
    if (!WORKFLOWS.includes(workflow)) throw workflowError('INVALID_WORKFLOW', `Unknown workflow: ${workflow}`);
    this.workflow = workflow;
    this.phase = workflow === 'plan' ? 'planning' : null;
    this.capabilityEpoch = options.initialCapabilityEpoch ?? 1;
    this.allocateEpoch = options.allocateEpoch ?? (() => this.capabilityEpoch + 1);
    this.createPlanId = options.createPlanId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    /** @type {Readonly<{planId: string, plan: any}> | null} */
    this.latestPlan = null;
  }

  bumpEpoch() {
    const next = this.allocateEpoch();
    if (!Number.isSafeInteger(next) || next <= this.capabilityEpoch) {
      throw workflowError('INVALID_CAPABILITY_EPOCH', 'Capability epoch allocator must return a larger safe integer');
    }
    this.capabilityEpoch = next;
    return next;
  }

  snapshot() {
    return {
      workflow: this.workflow,
      phase: this.workflow === 'direct' ? 'direct' : this.phase,
      capabilityEpoch: this.capabilityEpoch,
      planId: this.latestPlan?.planId ?? null,
      latestPlan: this.latestPlan ? clone(this.latestPlan.plan) : null,
    };
  }

  mcpEnvironment() {
    return {
      RHWP_AGENT_WORKFLOW: this.workflow,
      RHWP_AGENT_PHASE: this.workflow === 'direct' ? 'implementing' : this.phase,
      RHWP_CAPABILITY_EPOCH: String(this.capabilityEpoch),
      RHWP_TOOL_PROFILE: this.workflow === 'direct' ? 'direct' : toolProfileForPhase(this.phase),
    };
  }

  present(plan) {
    if (this.workflow !== 'plan') throw workflowError('PLAN_WORKFLOW_REQUIRED', 'Plans can only be presented from the plan workflow');
    if (this.phase !== 'planning') throw workflowError('INVALID_PLAN_PHASE', `A plan can only be presented while planning (current phase: ${this.phase})`);
    const planId = this.createPlanId();
    this.phase = 'awaiting-approval';
    this.bumpEpoch();
    const canonical = deepFreeze({
      ...clone(plan),
      planId,
      createdAt: this.now(),
      epoch: this.capabilityEpoch,
    });
    const record = deepFreeze({ planId, plan: canonical });
    this.latestPlan = record;
    return clone(record);
  }

  assertLatest(planId) {
    if (!this.latestPlan || planId !== this.latestPlan.planId) {
      throw workflowError('STALE_PLAN_ID', 'The planId is not the latest plan; refresh the plan before acting');
    }
  }

  requestChanges({ planId, sessionStatus }) {
    if (this.workflow !== 'plan' || this.phase !== 'awaiting-approval') {
      throw workflowError('INVALID_PLAN_PHASE', `Plan changes can only be requested while awaiting approval (current phase: ${this.phase ?? 'direct'})`);
    }
    if (sessionStatus !== 'idle') throw workflowError('AGENT_BUSY', 'Plan changes can only be requested while the agent is idle');
    this.assertLatest(planId);
    this.phase = 'planning';
    this.bumpEpoch();
    return this.snapshot();
  }

  beginApproval({ planId, sessionStatus }) {
    if (this.workflow !== 'plan' || this.phase !== 'awaiting-approval') {
      throw workflowError('INVALID_PLAN_PHASE', `A plan can only be approved while awaiting approval (current phase: ${this.phase ?? 'direct'})`);
    }
    if (sessionStatus !== 'idle') throw workflowError('AGENT_BUSY', 'A plan can only be approved while the agent is idle');
    this.assertLatest(planId);
    this.phase = 'switching';
    this.bumpEpoch();
    return { ...this.snapshot(), approvedPlan: clone(this.latestPlan) };
  }

  completeSwitch(planId) {
    if (this.phase !== 'switching') throw workflowError('INVALID_PLAN_PHASE', `Cannot finish a mode switch from phase ${this.phase ?? 'direct'}`);
    this.assertLatest(planId);
    this.phase = 'implementing';
    return this.snapshot();
  }

  failSwitch(planId) {
    if (this.phase !== 'switching') return this.snapshot();
    this.assertLatest(planId);
    this.phase = 'awaiting-approval';
    this.bumpEpoch();
    return this.snapshot();
  }
}

/**
 * Hub-side gate. MCP visibility is advisory; every call is checked here.
 * @param {{category: string, tool: string, workflow: 'direct'|'plan', phase: string|null, expectedEpoch: number, receivedEpoch: unknown}} input
 */
export function authorizeToolCall(input) {
  const received = input.receivedEpoch === undefined || input.receivedEpoch === null || input.receivedEpoch === ''
    ? null
    : Number(input.receivedEpoch);
  if (input.workflow === 'plan' && received === null) {
    throw workflowError('CAPABILITY_EPOCH_REQUIRED', 'Plan-workflow MCP calls must include RHWP_CAPABILITY_EPOCH; restart the provider in the current workflow mode');
  }
  if (received !== null && (!Number.isSafeInteger(received) || received !== input.expectedEpoch)) {
    throw workflowError('STALE_CAPABILITY_EPOCH', `Stale MCP capability epoch for ${input.tool}; restart the provider with epoch ${input.expectedEpoch}`);
  }
  if (input.category === 'browser' || input.category === 'download-write' || input.category === 'planning-control') {
    if (input.workflow !== 'plan') {
      throw workflowError('PLAN_WORKFLOW_REQUIRED', `${input.tool} is available only to chats that originated in the plan workflow`);
    }
  }
  if (input.workflow !== 'plan') return true;
  if (input.phase === 'switching') {
    throw workflowError('WORKFLOW_SWITCHING', 'Provider capabilities are switching; retry after the implementing phase begins');
  }
  if (input.category === 'document-write' && input.phase !== 'implementing') {
    throw workflowError('PLAN_WRITE_BLOCKED', `Document writes are blocked during the ${input.phase} phase`);
  }
  if (input.category === 'planning-control' && input.phase !== 'planning') {
    throw workflowError('INVALID_PLAN_PHASE', `${input.tool} is only available during the planning phase`);
  }
  return true;
}

/** @param {{planId: string, plan: any}} approved */
export function buildApprovedPlanPrompt(approved) {
  return [
    'The user approved the following hub-authoritative implementation plan.',
    `Plan ID: ${approved.planId}`,
    'Implement this canonical plan now. Do not re-plan or substitute a different plan. Respect the current permission profile and report any blocker.',
    // 승인 메시지는 promptContext 를 거치지 않는다 — 구현 단계 첫 턴이 규율 없이 시작하지 않도록 여기서 얹는다.
    humanizerPromptBlock('implementing'),
    JSON.stringify(approved.plan, null, 2),
  ].filter(Boolean).join('\n\n');
}
