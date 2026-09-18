import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { agentLeaseBlocksUserEditing, deriveAgentEditingLease, planModeAllowsUserEditing } from '../src/agent/editing-lease.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const bridge = source('../src/agent/bridge.ts');
const main = source('../src/main.ts');
const input = source('../src/engine/input-handler.ts');
const textInput = source('../src/engine/input-handler-text.ts');
const keyboardInput = source('../src/engine/input-handler-keyboard.ts');
const pendingEdits = source('../src/agent/pending-edits.ts');
const sidebar = source('../src/ui/agent-sidebar/index.ts');
const toolbar = source('../src/ui/toolbar.ts');
const html = source('../index.html');
const css = source('../src/styles/editor.css');

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
  assert.match(bridge, /deriveAgentEditingLease\(\{[\s\S]*turnRunning: this\.turnRunning,[\s\S]*activeToolRequests: this\.activeToolRequests[\s\S]*workflow: this\.workflow,[\s\S]*phase: this\.phase,[\s\S]*waitingForUser: this\.pendingUserQuestionId !== null/);
  assert.match(bridge, /case 'turn-start':[\s\S]*this\.editingAgent = event\.agent;[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /case 'turn-end':[\s\S]*this\.turnRunning = false;[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /const releaseEditingLease = \(\) => \{[\s\S]*this\.activeToolRequests = Math\.max\(0, this\.activeToolRequests - 1\);[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /this\.activeToolRequests \+= 1;[\s\S]*\.finally\(\(\) => \{[\s\S]*releaseEditingLease\(\)/);
  assert.match(bridge, /cancelActiveToolRequest[\s\S]*request\.controller\.abort\(\);[\s\S]*request\.releaseEditingLease\(\)/);
  assert.match(bridge, /case 'welcome':[\s\S]*this\.turnRunning = session\.status === 'running';[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /stopChat\(\): void[\s\S]*waitForAuthoritativeTurnEnd = this\.state === 'connected' && this\.turnRunning;[\s\S]*if \(!waitForAuthoritativeTurnEnd\) \{[\s\S]*this\.turnRunning = false;[\s\S]*this\.activeProviderTurnId = null;[\s\S]*this\.abortProviderToolRequests\(\);[\s\S]*\}[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /dispose\(\): void[\s\S]*this\.activeToolRequests = 0;[\s\S]*this\.syncEditingLease\(\)/);
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
  assert.match(main, /agentLeaseBlocksUserEditing\(agentEditingLease, cloudDocumentPublishingEnabled\)/);
  assert.match(main, /if \(!cloudBuild \|\| !loopback[\s\S]*return false;\s*cloudDocumentPublishingEnabled = true/);
  assert.match(main, /isEditable: !documentReadOnly && !agentUserEditingLocked\(\)/);
  assert.match(main, /inputHandler\?\.setUserEditingLocked\(agentUserEditingLocked\(\)\)/);
  assert.match(main, /canReplaceCurrentDocument[\s\S]*if \(agentEditingLease\.active\)/);
});
