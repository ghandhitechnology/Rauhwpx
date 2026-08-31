import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PI_SUBAGENT_MAX_RUNNING,
  PiSubagentCapabilityRegistry,
} from '../pi/subagent-capabilities.mjs';

function activeSession(overrides = {}) {
  return {
    agent: 'pi',
    generation: 7,
    providerRole: 'chat',
    providerCapabilityResource: 'provider.7.pi.chat',
    providerTurnStarted: true,
    status: 'running',
    turnId: 'turn-current',
    ...overrides,
  };
}

test('researcher capabilities are read-only and never expose root control tools', () => {
  const registry = new PiSubagentCapabilityRegistry();
  const registration = registry.register({
    activeSession: activeSession(),
    childId: '550e8400-e29b-41d4-a716-446655440000',
    taskId: 'sa-1',
    role: 'doc-researcher',
    parentProfile: 'direct',
  });

  assert.equal(registration.profile, 'doc-researcher');
  assert.equal(registration.allowedTools.has('get_structure'), true);
  assert.equal(registration.allowedTools.has('search_reference_files'), true);
  assert.equal(registration.allowedTools.has('apply_edits'), false);
  assert.equal(registration.allowedTools.has('update_agent_instructions'), false);
  assert.equal(registration.allowedTools.has('ask_user_question'), false);
  assert.equal(registration.allowedTools.has('delegate_copy_layout'), false);
});

test('editor capabilities inherit the current parent phase without root-only control tools', () => {
  const registry = new PiSubagentCapabilityRegistry();
  const direct = registry.register({
    activeSession: activeSession(),
    childId: '550e8400-e29b-41d4-a716-446655440001',
    taskId: 'sa-1',
    role: 'doc-editor',
    parentProfile: 'direct',
  });
  const planning = registry.register({
    activeSession: activeSession(),
    childId: '550e8400-e29b-41d4-a716-446655440002',
    taskId: 'sa-2',
    role: 'general',
    parentProfile: 'planning',
  });

  assert.equal(direct.allowedTools.has('apply_edits'), true);
  assert.equal(direct.allowedTools.has('ask_user_question'), false);
  assert.equal(direct.allowedTools.has('update_agent_instructions'), false);
  assert.equal(direct.allowedTools.has('publish_artifact'), false);
  assert.equal(direct.allowedTools.has('delegate_copy_layout'), false);
  assert.equal(planning.allowedTools.has('apply_edits'), false);
  assert.equal(planning.allowedTools.has('present_implementation_plan'), false);
  assert.equal(planning.allowedTools.has('download_file'), false);
  assert.equal(planning.allowedTools.has('browserbase_start'), false);
});

test('registrations are bound to one Pi or Rau provider turn and revoke synchronously', () => {
  const registry = new PiSubagentCapabilityRegistry();
  const session = activeSession({ agent: 'rau' });
  const registration = registry.register({
    activeSession: session,
    childId: '550e8400-e29b-41d4-a716-446655440003',
    taskId: 'sa-3',
    role: 'general',
    parentProfile: 'direct',
  });

  assert.equal(registry.isCurrent(registration, session), true);
  assert.equal(registry.isCurrent(registration, activeSession({ agent: 'rau', turnId: 'next-turn' })), false);
  assert.equal(registry.isCurrent(registration, activeSession({ agent: 'pi' })), false);
  assert.equal(registry.revoke(registration.childId), registration);
  assert.equal(registry.isCurrent(registration, session), false);
  assert.equal(registry.get(registration.childId), null);
});

test('re-registering a child id receives a fresh capability resource', () => {
  const registry = new PiSubagentCapabilityRegistry();
  const request = {
    activeSession: activeSession(),
    childId: '550e8400-e29b-41d4-a716-446655440012',
    taskId: 'sa-1',
    role: 'general',
    parentProfile: 'direct',
  };
  const first = registry.register(request);
  registry.revoke(first.childId);
  const second = registry.register(request);
  assert.notEqual(first.resource, second.resource);
});

test('only active root Pi/Rau turns may register bounded child identities', () => {
  const registry = new PiSubagentCapabilityRegistry();
  assert.throws(() => registry.register({
    activeSession: activeSession({ agent: 'claude' }),
    childId: '550e8400-e29b-41d4-a716-446655440004',
    taskId: 'sa-1',
    role: 'general',
    parentProfile: 'direct',
  }), /Pi or Rau root turn/);
  assert.throws(() => registry.register({
    activeSession: activeSession({ providerTurnStarted: false }),
    childId: '550e8400-e29b-41d4-a716-446655440004',
    taskId: 'sa-1',
    role: 'general',
    parentProfile: 'direct',
  }), /active provider turn/);
  assert.throws(() => registry.register({
    activeSession: activeSession(),
    childId: '../escape',
    taskId: 'sa-1',
    role: 'general',
    parentProfile: 'direct',
  }), /childId/);
});

test('the server registry independently caps active children', () => {
  const registry = new PiSubagentCapabilityRegistry();
  for (let index = 0; index < PI_SUBAGENT_MAX_RUNNING; index += 1) {
    registry.register({
      activeSession: activeSession(),
      childId: `550e8400-e29b-41d4-a716-44665544000${index}`,
      taskId: `sa-${index + 1}`,
      role: 'general',
      parentProfile: 'direct',
    });
  }
  assert.throws(() => registry.register({
    activeSession: activeSession(),
    childId: '550e8400-e29b-41d4-a716-446655440099',
    taskId: 'sa-99',
    role: 'general',
    parentProfile: 'direct',
  }), /At most 4 Pi subagents/);
});

test('clearing a settled parent turn removes only that turn registrations', () => {
  const registry = new PiSubagentCapabilityRegistry();
  const first = registry.register({
    activeSession: activeSession(),
    childId: '550e8400-e29b-41d4-a716-446655440010',
    taskId: 'sa-1',
    role: 'general',
    parentProfile: 'direct',
  });
  const second = registry.register({
    activeSession: activeSession({ turnId: 'other-turn' }),
    childId: '550e8400-e29b-41d4-a716-446655440011',
    taskId: 'sa-2',
    role: 'general',
    parentProfile: 'direct',
  });

  assert.deepEqual(registry.clearTurn(activeSession()).map((entry) => entry.childId), [first.childId]);
  assert.equal(registry.get(first.childId), null);
  assert.equal(registry.get(second.childId), second);
});
