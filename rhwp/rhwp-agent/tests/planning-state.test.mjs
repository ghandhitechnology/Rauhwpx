import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PlanningState,
  authorizeToolCall,
  buildApprovedPlanPrompt,
  isExplicitImplementationApproval,
} from '../planning-state.mjs';

const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

function plan() {
  return {
    goal: 'Implement feature',
    title: 'Feature plan',
    summary: 'Implement safely.',
    assumptions: [],
    decisions: ['Use hub state as the authority'],
    steps: [{ title: 'Implement', details: 'Make the change.' }],
    files: [],
    validation: ['Run tests'],
    risks: [],
    exclusions: [],
  };
}

function state() {
  let epoch = 10;
  return new PlanningState({
    workflow: 'plan',
    initialCapabilityEpoch: epoch,
    allocateEpoch: () => ++epoch,
    createPlanId: () => 'plan-authoritative',
    now: () => '2026-08-07T00:00:00.000Z',
  });
}

test('plan transition: planning -> awaiting -> switching -> implementing', () => {
  const workflow = state();
  const ready = workflow.present(plan());
  assert.equal(ready.planId, 'plan-authoritative');
  assert.equal(workflow.phase, 'awaiting-approval');
  assert.equal(workflow.capabilityEpoch, 11);
  const approval = workflow.beginApproval({ planId: ready.planId, sessionStatus: 'idle' });
  assert.equal(workflow.phase, 'switching');
  assert.equal(workflow.capabilityEpoch, 12);
  workflow.completeSwitch(ready.planId);
  assert.equal(workflow.phase, 'implementing');
  assert.deepEqual(approval.approvedPlan.plan, {
    ...plan(),
    planId: 'plan-authoritative',
    createdAt: '2026-08-07T00:00:00.000Z',
    epoch: 11,
  });
});

test('requesting plan workflow again after implementation starts a fresh planning cycle', () => {
  assert.match(
    serverSource,
    /const restartCompletedPlan = msg\.workflow === 'plan'[\s\S]*activeSession\.planning\.phase === 'implementing'/,
  );
  assert.match(
    serverSource,
    /activeSession\.planning\.workflow === msg\.workflow && !restartCompletedPlan/,
  );
  assert.match(serverSource, /const nextPlanning = new PlanningState\(\{/);
  assert.match(serverSource, /const phase = msg\.workflow === 'plan' \? 'planning' : 'implementing'/);
});

test('a new Plan chat proves provider planning readiness before chat-started', () => {
  assert.match(
    serverSource,
    /record\.agentSession = \{[\s\S]*if \(workflow === 'plan'\) \{[\s\S]*requireWorkflowSwitchBackend\(record\.agentSession\);[\s\S]*await record\.agentSession\.backend\.setExecutionMode\(providerModeRequest\(record\.agentSession, 'planning'\)\);/,
  );
  assert.ok(
    serverSource.indexOf("if (workflow === 'plan')") < serverSource.indexOf("type: 'chat-started'"),
  );
});

test('explicit invalid workflow values never degrade to Direct', () => {
  assert.match(
    serverSource,
    /if \(value === undefined \|\| value === null\) return 'direct';[\s\S]*if \(value === 'direct' \|\| value === 'plan'\) return value;[\s\S]*workflowError\('INVALID_WORKFLOW'/,
  );
});

test('approval requires idle and the latest authoritative plan id', () => {
  const busy = state();
  busy.present(plan());
  assert.throws(
    () => busy.beginApproval({ planId: 'plan-authoritative', sessionStatus: 'running' }),
    (error) => error.code === 'AGENT_BUSY',
  );
  assert.throws(
    () => busy.beginApproval({ planId: 'older-plan', sessionStatus: 'idle' }),
    (error) => error.code === 'STALE_PLAN_ID',
  );
});

test('request changes returns to planning and invalidates the old capability epoch', () => {
  const workflow = state();
  workflow.present(plan());
  const oldEpoch = workflow.capabilityEpoch;
  workflow.requestChanges({ planId: 'plan-authoritative', sessionStatus: 'idle' });
  assert.equal(workflow.phase, 'planning');
  assert.ok(workflow.capabilityEpoch > oldEpoch);
});

test('failed plan revision restores the authoritative plan and awaiting-approval phase', () => {
  const workflow = state();
  workflow.present(plan());
  workflow.requestChanges({ planId: 'plan-authoritative', sessionStatus: 'idle' });
  const planningEpoch = workflow.capabilityEpoch;
  workflow.failRequestChanges('plan-authoritative');
  assert.equal(workflow.phase, 'awaiting-approval');
  assert.equal(workflow.latestPlan?.planId, 'plan-authoritative');
  assert.ok(workflow.capabilityEpoch > planningEpoch);
});

test('explicit implementation approval accepts only standalone unambiguous commands', () => {
  for (const approval of [
    'implement the plan',
    ' Please implement this plan. ',
    'GO AHEAD AND IMPLEMENT THE PLAN!',
    '계획을 실행해 주세요.',
    '이 계획대로 진행해주세요!',
  ]) {
    assert.equal(isExplicitImplementationApproval(approval), true, approval);
  }
  for (const feedback of [
    "don't implement the plan",
    'should we implement the plan?',
    '"implement the plan"',
    'implement the plan, but change the API first',
    'implement the plan\nand add another test',
    '계획을 실행할까요?',
    '이 계획대로 진행하지 마세요',
    '',
  ]) {
    assert.equal(isExplicitImplementationApproval(feedback), false, feedback);
  }
});

test('awaiting-approval messages serialize approval/revision and attachments cannot approve', () => {
  assert.match(
    serverSource,
    /const hasAttachments = messageAttachments\.length > 0[\s\S]*Array\.isArray\(msg\.stagedReferenceIds\)[\s\S]*!hasAttachments && isExplicitImplementationApproval\(msg\.text\)[\s\S]*enqueueWorkflowTransition\(record, activeSession, \(\) => approveImplementationPlan/,
  );
  assert.match(
    serverSource,
    /enqueueWorkflowTransition\([\s\S]*requestImplementationPlanChanges\(record, sock, \{ planId, feedback: msg\.text \}\)/,
  );
});

test('permission and plan actions share the serialized workflow transition queue', () => {
  assert.match(serverSource, /function enqueueWorkflowTransition\(record, transitionOwner, transitionFn\)/);
  assert.match(
    serverSource,
    /case 'chat-permission-set':[\s\S]*enqueueWorkflowTransition\(record, transitionOwner, \(\) => setChatPermission/,
  );
  assert.match(
    serverSource,
    /await Promise\.resolve\(activeSession\.backend\.setPermissionProfile\(profile\)\);[\s\S]*activeSession\.permissionProfile = profile;[\s\S]*chat-permission-changed/,
  );
  assert.match(
    serverSource,
    /case 'plan-approve':[\s\S]*enqueueWorkflowTransition\(record, transitionOwner, \(\) => approveImplementationPlan/,
  );
  assert.match(
    serverSource,
    /case 'plan-request-changes':[\s\S]*enqueueWorkflowTransition\(record, transitionOwner, \(\) => requestImplementationPlanChanges/,
  );
  assert.match(
    serverSource,
    /transitionOwner\.pendingTransitions \+= 1;[\s\S]*transition\.finally\(\(\) => \{[\s\S]*pendingTransitions - 1/,
  );
  assert.match(
    serverSource,
    /case 'chat-user-message':[\s\S]*record\.agentSession\.pendingTransitions > 0[\s\S]*code: 'WORKFLOW_SWITCHING'/,
  );
});

test('failed provider revision switch rolls back before emitting authoritative state', () => {
  assert.match(
    serverSource,
    /activeSession\.planning\.failRequestChanges\(planId\);[\s\S]*emitWorkflowState\(record, \{ reason: 'provider-switch-failed' \}\)/,
  );
});

test('MCP environment carries workflow, phase, epoch, and a filterable profile', () => {
  const workflow = state();
  assert.deepEqual(workflow.mcpEnvironment(), {
    RHWP_AGENT_WORKFLOW: 'plan',
    RHWP_AGENT_PHASE: 'planning',
    RHWP_CAPABILITY_EPOCH: '10',
    RHWP_TOOL_PROFILE: 'planning',
  });
});

test('plan document writes are blocked until implementing', () => {
  for (const phase of ['planning', 'awaiting-approval']) {
    assert.throws(() => authorizeToolCall({
      category: 'document-write', tool: 'insert_text', workflow: 'plan', phase,
      expectedEpoch: 7, receivedEpoch: 7,
    }), (error) => error.code === 'PLAN_WRITE_BLOCKED');
  }
  assert.equal(authorizeToolCall({
    category: 'document-write', tool: 'insert_text', workflow: 'plan', phase: 'implementing',
    expectedEpoch: 7, receivedEpoch: 7,
  }), true);
  assert.throws(() => authorizeToolCall({
    category: 'instruction-write', tool: 'update_agent_instructions', workflow: 'plan', phase: 'planning',
    expectedEpoch: 7, receivedEpoch: 7,
  }), (error) => error.code === 'PLAN_WRITE_BLOCKED');
  assert.equal(authorizeToolCall({
    category: 'instruction-write', tool: 'update_agent_instructions', workflow: 'plan', phase: 'implementing',
    expectedEpoch: 7, receivedEpoch: 7,
  }), true);
});

test('user interaction is authorized only while planning or implementing', () => {
  for (const phase of ['planning', 'implementing']) {
    assert.equal(authorizeToolCall({
      category: 'user-interaction', tool: 'ask_user_question', workflow: 'plan', phase,
      expectedEpoch: 7, receivedEpoch: 7,
    }), true);
  }
  for (const phase of ['awaiting-approval', 'switching']) {
    assert.throws(() => authorizeToolCall({
      category: 'user-interaction', tool: 'ask_user_question', workflow: 'plan', phase,
      expectedEpoch: 7, receivedEpoch: 7,
    }), (error) => error.code === (phase === 'switching' ? 'WORKFLOW_SWITCHING' : 'INVALID_PLAN_PHASE'));
  }
  assert.equal(authorizeToolCall({
    category: 'user-interaction', tool: 'ask_user_question', workflow: 'direct', phase: null,
    expectedEpoch: 7, receivedEpoch: undefined,
  }), true);
});

test('plan calls fail closed on missing/stale epochs; direct calls keep legacy compatibility', () => {
  assert.throws(() => authorizeToolCall({
    category: 'document-read', tool: 'get_structure', workflow: 'plan', phase: 'planning',
    expectedEpoch: 7, receivedEpoch: undefined,
  }), (error) => error.code === 'CAPABILITY_EPOCH_REQUIRED');
  assert.throws(() => authorizeToolCall({
    category: 'document-read', tool: 'get_structure', workflow: 'plan', phase: 'planning',
    expectedEpoch: 7, receivedEpoch: 6,
  }), (error) => error.code === 'STALE_CAPABILITY_EPOCH');
  assert.equal(authorizeToolCall({
    category: 'document-write', tool: 'insert_text', workflow: 'direct', phase: null,
    expectedEpoch: 7, receivedEpoch: undefined,
  }), true);
});

test('browser/download/control are rejected for direct-origin chats', () => {
  for (const category of ['browser', 'download-write', 'planning-control']) {
    assert.throws(() => authorizeToolCall({
      category, tool: 'special_tool', workflow: 'direct', phase: null,
      expectedEpoch: 7, receivedEpoch: undefined,
    }), (error) => error.code === 'PLAN_WORKFLOW_REQUIRED');
  }
});

test('approved execution prompt contains only the authoritative plan record', () => {
  const prompt = buildApprovedPlanPrompt({ planId: 'plan-1', plan: plan() });
  assert.match(prompt, /Plan ID: plan-1/);
  assert.match(prompt, /Do not re-plan, omit steps, or substitute a different plan/);
  assert.match(prompt, /First re-read the relevant current state/);
  assert.match(prompt, /execute every canonical step thoroughly/);
  assert.match(prompt, /run every listed validation/);
  assert.match(prompt, /distinguish completed, blocked, and deferred items/);
  assert.match(prompt, /never claim partial work is complete/);
  assert.match(prompt, /"goal": "Implement feature"/);
});
