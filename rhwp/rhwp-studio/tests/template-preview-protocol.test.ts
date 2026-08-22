import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';

const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const input = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
const textInput = readFileSync(new URL('../src/engine/input-handler-text.ts', import.meta.url), 'utf8');
const keyboardInput = readFileSync(new URL('../src/engine/input-handler-keyboard.ts', import.meta.url), 'utf8');
const dispatcher = readFileSync(new URL('../src/command/dispatcher.ts', import.meta.url), 'utf8');
const toolExecutor = readFileSync(new URL('../src/agent/tool-executor.ts', import.meta.url), 'utf8');

test('verified artifact event opens a new read-only window and acknowledges actual opening', () => {
  assert.match(bridge, /case 'template-preview-ready'/);
  assert.match(bridge, /preview\.stoppedReason !== 'verified-convergence'/);
  assert.match(sidebar, /case 'template-preview-ready'/);
  assert.match(sidebar, /parsePublishedDocumentLink\(e\.artifact\.downloadUrl\)/);
  assert.match(sidebar, /openPublishedDocumentInNewWindow\(artifact, undefined, \{ readOnly: true \}\)/);
  assert.match(sidebar, /\.then\(\(\) => bridge\.acknowledgeTemplatePreview\(e\.jobId\)\)/);
  assert.match(bridge, /type: 'template-preview-opened', jobId/);
});

test('template preview state blocks command, direct input, snapshot, and formatting mutations', () => {
  assert.match(main, /documentReadOnly = new URLSearchParams[\s\S]*templatePreview/);
  assert.match(main, /isEditable: !documentReadOnly/);
  assert.match(main, /inputHandler\.setReadOnly\(documentReadOnly\)/);
  assert.match(input, /executeOperation\(desc:[\s\S]*if \(this\.readOnly\) return/);
  assert.match(input, /executeAppliedSnapshot[\s\S]*This template preview is read-only/);
  assert.match(input, /format-char'[\s\S]*this\.readOnly/);
  assert.match(textInput, /this\.readOnly \|\| this\.agentTemplateLocked/);
  assert.match(textInput, /onInput[\s\S]*if \(this\.readOnly\)/);
  assert.match(keyboardInput, /onKeyDown[\s\S]*if \(this\.readOnly\)/);
  assert.match(keyboardInput, /onCut[\s\S]*if \(this\.readOnly\)/);
  assert.match(keyboardInput, /onPaste[\s\S]*if \(this\.readOnly\)/);
  assert.match(dispatcher, /isBlockedInReadOnly/);
  assert.match(toolExecutor, /isDocumentWriteTool\(tool\) && this\.deps\.isReadOnly\?\.\(\)/);
  assert.match(toolExecutor, /READ_ONLY_TEMPLATE_PREVIEW/);
});

test('read-only dispatcher permits view/copy but rejects document and file mutations', () => {
  const executed: string[] = [];
  const definitions = new Map(['edit:copy', 'view:zoom-in', 'insert:table', 'file:save'].map((id) => [
    id,
    { execute: () => executed.push(id) },
  ]));
  const dispatcherInstance = new CommandDispatcher(
    { get: (id: string) => definitions.get(id) } as any,
    { getContext: () => ({ readOnly: true, isEditable: false }) } as any,
    new EventBus(),
  );
  assert.equal(dispatcherInstance.dispatch('edit:copy'), true);
  assert.equal(dispatcherInstance.dispatch('view:zoom-in'), true);
  assert.equal(dispatcherInstance.dispatch('insert:table'), false);
  assert.equal(dispatcherInstance.dispatch('file:save'), false);
  assert.deepEqual(executed, ['edit:copy', 'view:zoom-in']);
});

test('read-only agent executor rejects mutation tools before touching document services', async () => {
  const executor = new AgentToolExecutor({
    wasm: {} as any,
    inputHandler: {} as any,
    documentState: {} as any,
    revision: {} as any,
    pending: {} as any,
    isReadOnly: () => true,
  });
  await assert.rejects(
    executor.execute('insert_text', {}, 'codex'),
    (error: any) => error?.code === 'READ_ONLY_TEMPLATE_PREVIEW',
  );
});
