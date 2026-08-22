import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';

const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const desktopIntegration = readFileSync(new URL('../src/desktop-integration.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const input = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
const textInput = readFileSync(new URL('../src/engine/input-handler-text.ts', import.meta.url), 'utf8');
const keyboardInput = readFileSync(new URL('../src/engine/input-handler-keyboard.ts', import.meta.url), 'utf8');
const dispatcher = readFileSync(new URL('../src/command/dispatcher.ts', import.meta.url), 'utf8');
const toolExecutor = readFileSync(new URL('../src/agent/tool-executor.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');

test('template artifact opens read-only only after its main-chat card is clicked', () => {
  assert.doesNotMatch(bridge, /template-preview-ready/);
  assert.doesNotMatch(bridge, /template-preview-opened/);
  assert.match(desktopIntegration, /templatePreview'\) === '1' \? \{ readOnly: true \}/);
  assert.match(sidebar, /const card = el\('span', 'ag-md-artifact-card'\)/);
  assert.match(sidebar, /openPublishedDocumentInNewWindow\(artifact, undefined, \{ readOnly: artifact\.readOnly === true \}\)/);
  assert.match(css, /\.ag-md-artifact-card\s*\{[^}]*display:\s*flex;[^}]*border:/s);
  assert.match(css, /\.ag-md-artifact-open\s*\{[^}]*flex:\s*1 1 auto;/s);
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
