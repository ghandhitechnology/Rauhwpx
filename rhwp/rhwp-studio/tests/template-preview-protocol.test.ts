import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';

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
