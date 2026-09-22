import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineRecorder, readTimeline } from '../../../cloud/document-runtime/timeline.mjs';
import { CloudLiveTimelineGuard } from '../src/cloud/live-timeline.ts';

function fixture() {
  const recorder = new TimelineRecorder(readTimeline(null, { provider: 'codex', sessionId: 'cloud-test' }));
  recorder.acceptUserMessage('Review the document');
  const guard = new CloudLiveTimelineGuard();
  guard.accept(recorder.export().thread.messages);
  const emit = (type: string, detail = {}) => {
    const event = { type, agent: 'codex', ...detail };
    recorder.consume({ type: 'agent', event });
    guard.observe(event as Parameters<typeof guard.observe>[0]);
  };
  return { recorder, guard, emit };
}

test('operation checkpoints and late operation downloads cannot erase streamed text', () => {
  const { recorder, guard, emit } = fixture();
  emit('turn-start');
  emit('text-delta', { text: 'Reviewing the table. ' });
  const operation = recorder.export();
  assert.equal(operation.thread.messages.length, 1, 'the runtime omits the active turn from operation exports');
  assert.equal(guard.canApply(operation.thread.messages), false);
  emit('text-delta', { text: 'The totals match.' });
  emit('turn-end', { stopReason: 'completed' });
  assert.equal(guard.canApply(operation.thread.messages), false, 'a delayed download stays stale after turn-end');
  const completed = recorder.export();
  assert.equal(guard.canApply(completed.thread.messages), true);
  guard.accept(completed.thread.messages);
  assert.equal(guard.canApply(operation.thread.messages), false, 'accepted history never moves backwards');
});

test('a completed timeline must contain each distinct live turn even when replies repeat', () => {
  const { recorder, guard, emit } = fixture();
  emit('turn-start');
  emit('text-delta', { text: 'Done.' });
  emit('turn-end', { stopReason: 'completed' });
  const first = recorder.export();
  emit('turn-start');
  emit('text-delta', { text: 'Done.' });
  assert.equal(guard.canApply(first.thread.messages), false);
  emit('turn-end', { stopReason: 'completed' });
  assert.equal(guard.canApply(first.thread.messages), false);
  assert.equal(guard.canApply(recorder.export().thread.messages), true);
});

test('missing live deltas do not prevent completed authoritative history from replacing the stream', () => {
  const { recorder, guard, emit } = fixture();
  emit('turn-start');
  emit('text-delta', { text: 'First. ' });
  recorder.consume({ type: 'agent', event: { type: 'text-delta', text: 'Not forwarded. ' } });
  emit('text-delta', { text: 'Last.' });
  emit('turn-end', { stopReason: 'completed' });
  assert.equal(guard.canApply(recorder.export().thread.messages), true);
});

test('tool-only turns wait for their recorded activity', () => {
  const { recorder, guard, emit } = fixture();
  emit('turn-start');
  emit('tool-call', { callId: 'edit-1', tool: 'edit', argsJson: '{}' });
  const operation = recorder.export();
  emit('tool-result', { callId: 'edit-1', ok: true });
  emit('turn-end', { stopReason: 'completed' });
  assert.equal(guard.canApply(operation.thread.messages), false);
  assert.equal(guard.canApply(recorder.export().thread.messages), true);
});

test('long provider errors match the recorder limit', () => {
  const { recorder, guard, emit } = fixture();
  emit('turn-start');
  emit('error', { message: 'failure '.repeat(4000) });
  emit('turn-end', { stopReason: 'failed', errorMessage: 'failure '.repeat(4000) });
  assert.equal(guard.canApply(recorder.export().thread.messages), true);
});
