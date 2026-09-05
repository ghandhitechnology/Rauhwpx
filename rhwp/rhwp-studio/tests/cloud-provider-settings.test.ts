import assert from 'node:assert/strict';
import test from 'node:test';
import { canChangeCloudProviderSettings, cloudProviderSettingsTarget } from '../src/cloud/provider-settings.ts';
import type { CloudSessionState, CloudSnapshot } from '../src/cloud/types.ts';

const binding = { sessionId: 'room', threadId: 'thread', documentId: 'document' };
const base = { ...binding, version: 7, documentName: 'document.hwpx',
  selection: { agent: 'codex' as const, model: 'gpt-5.6-sol', effort: 'high' }, configurationPending: false };
const running = { ...base, kind: 'running' as const, startedAt: new Date(0).toISOString(), turn: 1,
  turnLimit: 100, elapsedMs: 1, timeLimitMs: 60000, currentActivity: '', phase: 'waiting' as const, wait: null };
const snapshot = (session: CloudSessionState) => ({ session, link: { kind: 'ready' } }) as CloudSnapshot;

test('settings stay locked during turns, pending decisions and provider restarts', () => {
  assert.equal(canChangeCloudProviderSettings(running), true);
  assert.equal(canChangeCloudProviderSettings({ ...base, kind: 'queued', position: 1, message: 'Starting', configurationEditable: true }), false);
  for (const phase of ['working', 'redirecting', 'awaiting-plan-approval', 'awaiting-question-answer', 'awaiting-external-effect-approval'] as const) {
    assert.equal(canChangeCloudProviderSettings({ ...running, phase }), false);
  }
  assert.equal(canChangeCloudProviderSettings({ ...running, wait: { id: 'q', kind: 'question', payload: {} } }), false);
  assert.equal(canChangeCloudProviderSettings({ ...running, configurationPending: true }), false);
  assert.equal(canChangeCloudProviderSettings({ ...running, selection: undefined }), false);
});

test('paused selections require server capability and the mounted conversation', () => {
  for (const inactive of [
    { ...base, kind: 'suspended' as const, resumable: true, reason: 'Paused' },
  ]) {
    assert.equal(canChangeCloudProviderSettings(inactive), false);
    const session = { ...inactive, configurationEditable: true };
    const composer = { kind: 'cloud-blocked' as const, reason: 'not-accepting-messages' as const, message: 'Paused' };
    assert.deepEqual(cloudProviderSettingsTarget(snapshot(session), binding, binding.threadId, composer), {
      ...binding, expectedVersion: 7,
    });
    assert.equal(cloudProviderSettingsTarget(snapshot(session), binding, 'other-thread', composer), null);
    assert.equal(cloudProviderSettingsTarget(snapshot(session), { ...binding, documentId: 'other-document' }, binding.threadId, composer), null);
    assert.equal(cloudProviderSettingsTarget(snapshot(session), binding, binding.threadId, { kind: 'workspace-blocked', reason: 'session-selection', message: '' }), null);
    assert.equal(cloudProviderSettingsTarget(snapshot(session), binding, binding.threadId, { ...composer, reason: 'timeline-unavailable' }), null);
    assert.equal(cloudProviderSettingsTarget({ ...snapshot(session), link: { kind: 'failed', error: 'Offline', attempt: 1, canRecreate: true } }, binding, binding.threadId, composer), null);
  }
});
