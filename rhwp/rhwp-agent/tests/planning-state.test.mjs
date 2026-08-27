import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PlanningState,
  authorizeToolCall,
  buildApprovedPlanPrompt,
  buildPlanningDocumentSavedPrompt,
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

test('document-saved follow-up asks the planner to re-read live state', () => {
  const prompt = buildPlanningDocumentSavedPrompt({ revision: 12, fileName: '초안.hwpx' });
  assert.match(prompt, /automatic live-document notification/);
  assert.match(prompt, /not a request to implement/);
  assert.match(prompt, /Current document revision after the save: 12/);
  assert.match(prompt, /Saved document name: 초안\.hwpx/);
  assert.match(prompt, /get_structure/);
  assert.match(prompt, /Do not edit the local filesystem or live document/);
  assert.match(serverSource, /case 'chat-document-saved'/);
  assert.match(serverSource, /queuePlanningDocumentSaved\(record, msg\)/);
  assert.match(serverSource, /if \(evt\.type === 'turn-end'\) drainPlanningDocumentSaved\(record\)/);
  assert.match(serverSource, /reason: 'document-saved'/);
  assert.match(serverSource, /promptOverride: prompt/);
  assert.match(serverSource, /sessionStatusOverride: 'idle'/);
});
