import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { agentLeaseBlocksUserEditing, deriveAgentEditingLease, planModeAllowsUserEditing } from '../src/agent/editing-lease.ts';

test('agent editing lock blocks mutations but leaves view and copy commands available', () => {
  const executed: string[] = [];
  const definitions = new Map(['edit:copy', 'view:zoom-in', 'format:bold', 'insert:table', 'file:open'].map((id) => [
    id,
    { execute: () => executed.push(id) },
  ]));
  const dispatcher = new CommandDispatcher(
    { get: (id: string) => definitions.get(id) } as any,
    { getContext: () => ({ readOnly: false, userEditingLocked: true, isEditable: false }) } as any,
    new EventBus(),
  );

  assert.equal(dispatcher.dispatch('edit:copy'), true);
  assert.equal(dispatcher.dispatch('view:zoom-in'), true);
  assert.equal(dispatcher.dispatch('format:bold'), false);
  assert.equal(dispatcher.dispatch('insert:table'), false);
  assert.equal(dispatcher.dispatch('file:open'), false);
  assert.deepEqual(executed, ['edit:copy', 'view:zoom-in']);
});

test('bridge owns the lease and retains it until every in-flight tool settles', () => {
  assert.deepEqual(
    deriveAgentEditingLease({ turnRunning: true, activeToolRequests: 0, agent: 'claude' }),
    { active: true, agent: 'claude' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({ turnRunning: false, activeToolRequests: 1, agent: 'codex' }),
    { active: true, agent: 'codex' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({ turnRunning: false, activeToolRequests: 0, agent: 'pi' }),
    { active: false, agent: 'pi' },
  );
});

test('plan mode leaves the document editable while a planning turn is running', () => {
  assert.equal(planModeAllowsUserEditing('plan', 'planning'), true);
  assert.equal(planModeAllowsUserEditing('plan', 'awaiting-approval'), true);
  assert.equal(planModeAllowsUserEditing('question', 'questioning'), true);
  assert.equal(planModeAllowsUserEditing('plan', 'switching'), false);
  assert.equal(planModeAllowsUserEditing('plan', 'implementing'), false);
  assert.equal(planModeAllowsUserEditing('direct', 'direct'), false);
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true, activeToolRequests: 2, agent: 'claude', workflow: 'plan', phase: 'planning',
    }),
    { active: false, agent: 'claude' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true, activeToolRequests: 0, agent: 'codex', workflow: 'plan', phase: 'awaiting-approval',
    }),
    { active: false, agent: 'codex' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true, activeToolRequests: 2, agent: 'codex', workflow: 'question', phase: 'questioning',
    }),
    { active: false, agent: 'codex' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: false, activeToolRequests: 0, agent: 'claude', workflow: 'plan', phase: 'switching',
    }),
    { active: true, agent: 'claude' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true, activeToolRequests: 0, agent: 'grok', workflow: 'plan', phase: 'implementing',
    }),
    { active: true, agent: 'grok' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true, activeToolRequests: 0, agent: 'pi', workflow: 'direct', phase: 'direct',
    }),
    { active: true, agent: 'pi' },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true,
      activeToolRequests: 0,
      agent: 'claude',
      workflow: 'plan',
      phase: 'planning',
      waitingForUser: true,
    }),
    { active: false, agent: 'claude', waitingForUser: true },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true,
      activeToolRequests: 0,
      agent: 'codex',
      workflow: 'question',
      phase: 'questioning',
      waitingForUser: true,
    }),
    { active: false, agent: 'codex', waitingForUser: true },
  );
  assert.deepEqual(
    deriveAgentEditingLease({
      turnRunning: true,
      activeToolRequests: 0,
      agent: 'grok',
      workflow: 'direct',
      phase: 'direct',
      waitingForUser: true,
    }),
    { active: true, agent: 'grok', waitingForUser: true },
  );
});

test('authenticated worker editing is separate from the provider replacement lease', () => {
  const lease = deriveAgentEditingLease({ turnRunning: true, activeToolRequests: 2,
    agent: 'codex', workflow: 'direct', phase: 'direct' });
  assert.equal(lease.active, true);
  assert.equal(agentLeaseBlocksUserEditing(lease), true);
  assert.equal(agentLeaseBlocksUserEditing(lease, true), false);
  assert.equal(lease.active, true);
});
