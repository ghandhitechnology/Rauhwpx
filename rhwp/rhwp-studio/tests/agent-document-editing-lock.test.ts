import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { deriveAgentEditingLease, planModeAllowsUserEditing } from '../src/agent/editing-lease.ts';

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
  assert.match(bridge, /deriveAgentEditingLease\(\{[\s\S]*turnRunning: this\.turnRunning,[\s\S]*activeToolRequests: this\.activeToolRequests[\s\S]*workflow: this\.workflow,[\s\S]*phase: this\.phase/);
  assert.match(bridge, /case 'turn-start':[\s\S]*this\.editingAgent = event\.agent;[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /case 'turn-end':[\s\S]*this\.turnRunning = false;[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /this\.activeToolRequests \+= 1;[\s\S]*\.finally\(\(\) => \{[\s\S]*this\.activeToolRequests = Math\.max\(0, this\.activeToolRequests - 1\);[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /case 'welcome':[\s\S]*this\.turnRunning = session\.status === 'running';[\s\S]*this\.syncEditingLease\(\)/);
  assert.match(bridge, /stopChat\(\): void[\s\S]*waitForAuthoritativeTurnEnd = this\.state === 'connected' && this\.turnRunning;[\s\S]*if \(!waitForAuthoritativeTurnEnd\) this\.turnRunning = false;[\s\S]*this\.syncEditingLease\(\)/);
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
});

test('planning saves after a user edit notify the hub mid-plan', () => {
  assert.match(bridge, /eventBus\.on\('document-changed', \(\) => this\.markUserDocumentEdit\(\)\)/);
  assert.match(bridge, /eventBus\.on\('document-mutated', \(\) => this\.markUserDocumentEdit\(\)\)/);
  assert.match(bridge, /eventBus\.on\('document-saved', \(\) => this\.notifyPlanningDocumentSaved\(\)\)/);
  assert.match(bridge, /this\.pendingChatStart = null;[\s\S]*this\.notifyPlanningDocumentSaved\(\)/);
  assert.match(bridge, /case 'chat-started':[\s\S]*this\.notifyPlanningDocumentSaved\(\)/);
  assert.match(bridge, /case 'workflow-changed':[\s\S]*this\.notifyPlanningDocumentSaved\(\)/);
  assert.match(bridge, /type: 'chat-document-saved'/);
  assert.match(bridge, /type: 'planning-document-saved'/);
  assert.match(sidebar, /case 'planning-document-saved':/);
  assert.match(sidebar, /문서가 저장되어 계획 중인 에이전트에 알렸습니다/);
});

test('entering plan mode unlocks the lease immediately and holds messages until the hub finishes', () => {
  assert.match(bridge, /this\.beginWorkflowSwitch\(workflow\);[\s\S]*type: 'chat-workflow-set'/);
  assert.match(bridge, /this\.workflowSwitchPending = true;[\s\S]*this\.resetWorkflowState\(workflow\)/);
  assert.match(bridge, /if \(this\.workflowSwitchPending \|\| this\.activeAgent === null \|\| this\.queuedMessages\.length > 0\)/);
  assert.match(bridge, /if \(this\.workflowSwitchPending\) return;/);
  assert.match(bridge, /case 'workflow-changed':[\s\S]*this\.finishWorkflowSwitch\(\);[\s\S]*this\.flushQueuedMessages\(\)/);
  assert.match(bridge, /BACKEND_SWITCH_FAILED[\s\S]*INVALID_WORKFLOW[\s\S]*WORKFLOW_ERROR[\s\S]*this\.revertWorkflowSwitch\(\)/);
  assert.match(bridge, /planModeAllowsUserEditing\(msg\.workflow, msg\.phase\)[\s\S]*this\.workflow = msg\.workflow;[\s\S]*this\.phase = msg\.phase/);
});

test('user input gates remain separate from autonomous agent mutation paths', () => {
  assert.match(input, /executeOperation\(desc:[\s\S]*this\.userEditingLocked && desc\.meta\?\.origin !== 'agent'/);
  assert.match(input, /executeAppliedSnapshot[\s\S]*if \(this\.readOnly\)/);
  assert.doesNotMatch(input.match(/executeAppliedSnapshot[\s\S]*?\n  \}/)?.[0] ?? '', /userEditingLocked/);
  assert.match(pendingEdits, /meta: \{ origin: 'agent', refresh: 'full', scroll: 'preserve' \}/);
  assert.match(textInput, /onInput[\s\S]*this\.readOnly \|\| this\.userEditingLocked/);
  assert.match(keyboardInput, /onKeyDown[\s\S]*this\.readOnly \|\| this\.userEditingLocked/);
  assert.match(input, /format-char'[\s\S]*this\.readOnly \|\| this\.userEditingLocked/);
  assert.match(input, /insertDroppedImageAtClientPoint[\s\S]*this\.readOnly \|\| this\.userEditingLocked/);
  assert.match(toolbar, /querySelectorAll<HTMLButtonElement \| HTMLInputElement \| HTMLSelectElement>\('button, input, select'\)[\s\S]*control\.disabled = !enabled/);
});

test('document replacement and active pointer gestures respect the lease boundary', () => {
  assert.match(main, /canReplaceCurrentDocument[\s\S]*if \(agentEditingLease\.active\)/);
  assert.match(main, /loadFile[\s\S]*canReplaceCurrentDocument\(options\.skipUnsavedGuard\)/);
  assert.match(input, /setUserEditingLocked[\s\S]*_mouse\.onMouseUp\.call\(this, new MouseEvent/);
  assert.match(input, /setUserEditingLocked[\s\S]*this\.cancelImagePlacement\(\)[\s\S]*this\.cancelTextboxPlacement\(\)[\s\S]*this\.cancelPolygonDrawing\(\)/);
  assert.match(input, /setUserEditingLocked[\s\S]*this\.cancelFormOverlayEdit\?\.\(\)[\s\S]*revertCompositionPreview/);
  assert.doesNotMatch(input.match(/setUserEditingLocked[\s\S]*?\n  \}/)?.[0] ?? '', /this\.textarea\.focus\(\)/);
  assert.match(main, /addEventListener\('drop'[\s\S]*if \(agentEditingLease\.active\)[\s\S]*에이전트가 편집을 마친 뒤 파일을 놓을 수 있습니다/);
  assert.match(sidebar, /approve\.disabled = editingLeaseActive;[\s\S]*if \(bridge\.getEditingLease\(\)\.active\) return;[\s\S]*pendingEdits\.approve/);
  assert.match(sidebar, /reject\.disabled = editingLeaseActive;[\s\S]*if \(bridge\.getEditingLease\(\)\.active\) return;[\s\S]*pendingEdits\.reject/);
  assert.match(sidebar, /onEditingLeaseChange\(\(\) => rebuildReview\(\)\)/);
});

test('editing frame reflects the active agent and has responsive reduced-motion treatment', () => {
  assert.match(html, /id="agent-editing-frame"[\s\S]*id="agent-editing-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(main, /editorArea\?\.setAttribute\('aria-busy', lease\.active \? 'true' : 'false'\)/);
  assert.match(main, /statusLabel\.textContent = `\$\{AGENT_LABEL\[lease\.agent\]\}가 문서를 편집 중이에요`/);
  for (const agent of ['claude', 'pi', 'grok', 'cursor']) {
    assert.match(css, new RegExp(`data-editing-agent='${agent}'`));
  }
  assert.match(css, /animation:\s*agent-editing-sweep/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*#agent-editing-frame[\s\S]*animation: none/);
  assert.match(css, /@media \(max-width: 1023px\)[\s\S]*#agent-editing-status/);
});
