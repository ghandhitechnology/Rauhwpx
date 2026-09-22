import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { observeStudioTurn } from '../document-runtime/studio-harness.mjs';

const agent = (type, details = {}) => ({ type: 'agent', event: { type, agent: 'codex', ...details } });

function observe({ batches, workflow = 'direct', control = {}, onSafeBoundary = async () => {}, interruptResults = [] }) {
  let sequence = 0;
  let drains = 0;
  let interruptedAt = null;
  const interruptAttempts = [];
  const bridge = {
    drainEvents() {
      const events = batches[drains++] ?? [];
      return events.map((event) => ({ seq: ++sequence, event }));
    },
    interruptIfIdle(_secret, after) {
      interruptAttempts.push({ drain: drains, after });
      const interrupted = interruptResults.shift() ?? true;
      if (interrupted) interruptedAt = drains;
      return { interrupted };
    },
  };
  const result = observeStudioTurn({
    page: { evaluate: (callback, ...args) => vm.runInNewContext(`(${callback.toString()})(...args)`, {
      args, window: { rauhwpxCloudRuntime: bridge },
    }) },
    bootstrap: 'test', execution: { workflow }, hub: { exitCode: null },
    onEvent: async () => {}, onSafeBoundary, readControl: async () => control,
    timeoutMs: 2_000,
  });
  return { result, interruptedAt: () => interruptedAt, interruptAttempts };
}

for (const request of ['pauseRequested', 'takeoverRequested', 'endRequested', 'redirectRequested']) {
  test(`${request} interrupts after all already-dispatched tools finish`, async () => {
    const checkpoints = [];
    const run = observe({
      control: { [request]: true },
      batches: [
        [agent('turn-start'), agent('tool-call', { callId: 'one', tool: 'insert_text' })],
        [agent('tool-result', { callId: 'one', ok: true }), agent('tool-call', { callId: 'two', tool: 'replace_text' })],
        [agent('tool-result', { callId: 'two', ok: true })],
        [agent('turn-end', { stopReason: 'interrupted' })],
      ],
      onSafeBoundary: async ({ tool }) => checkpoints.push(tool),
    });
    const outcome = await run.result;
    assert.equal(run.interruptedAt(), 3, 'a tool dispatched in the same drained batch must finish before interruption');
    assert.deepEqual(checkpoints, ['insert_text', 'replace_text']);
    assert.equal(outcome.redirected, request === 'redirectRequested');
    assert.equal(outcome.stopped, request !== 'redirectRequested');
  });
}

test('redirecting planning before plan-ready does not fail or create an approval wait', async () => {
  const run = observe({ workflow: 'plan', control: { redirectRequested: true }, batches: [
    [agent('turn-start')], [agent('turn-end', { stopReason: 'interrupted' })],
  ] });
  const outcome = await run.result;
  assert.equal(outcome.redirected, true);
  assert.equal(outcome.wait, undefined);
});

test('provider failure after presenting a plan does not become an approval request', async () => {
  const failure = agent('turn-end', { stopReason: 'error', errorMessage: 'Provider disconnected' });
  const run = observe({ workflow: 'plan', batches: [[
    agent('turn-start'), { type: 'plan-ready', plan: { planId: 'plan-one' } }, failure,
  ]] });
  const outcome = await run.result;
  assert.equal(outcome.errorMessage, 'Provider disconnected');
  assert.equal(outcome.wait, undefined);
});

test('successful planning still waits for explicit approval', async () => {
  const run = observe({ workflow: 'plan', batches: [[
    agent('turn-start'), { type: 'plan-ready', plan: { planId: 'plan-one' } }, agent('turn-end', { stopReason: 'end_turn' }),
  ]] });
  const outcome = await run.result;
  assert.equal(outcome.wait.kind, 'plan-approval');
  assert.equal(outcome.wait.payload.planId, 'plan-one');
  assert.equal(run.interruptedAt(), null);
});

test('a turn that finishes naturally while Pause arrives is not replayed on Resume', async () => {
  const run = observe({ control: { pauseRequested: true }, batches: [
    [agent('turn-start')], [agent('turn-end', { stopReason: 'end_turn' })],
  ] });
  const outcome = await run.result;
  assert.equal(outcome.stopReason, 'end_turn');
  assert.equal(outcome.stopped, undefined);
});

test('a declined browser interrupt drains newer tool events and retries only after they finish', async () => {
  const run = observe({ control: { pauseRequested: true }, interruptResults: [false, true], batches: [
    [agent('turn-start')],
    [agent('tool-call', { callId: 'late', tool: 'insert_text' })],
    [agent('tool-result', { callId: 'late', ok: true })],
    [agent('turn-end', { stopReason: 'interrupted' })],
  ] });
  const outcome = await run.result;
  assert.deepEqual(run.interruptAttempts, [{ drain: 1, after: 1 }, { drain: 3, after: 3 }]);
  assert.equal(run.interruptedAt(), 3);
  assert.equal(outcome.stopped, true);
});
