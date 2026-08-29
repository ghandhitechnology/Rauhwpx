import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import {
  assistantTextFromJsonl,
  buildChildArgv,
  childExcludeTools,
  childSystemPrompt,
  createSubagentManager,
  normalizeRole,
  resolveSubagentSessionDir,
  spawnIdFromResult,
  terminalFleetStatus,
} from '../pi/extension/subagents.ts';

test('role and child prompt stay on the rhwp document surface', () => {
  assert.equal(normalizeRole('doc-editor'), 'doc-editor');
  assert.equal(normalizeRole('mystery'), 'general');
  assert.match(childSystemPrompt('doc-editor'), /ONE assigned region/);
  assert.match(childSystemPrompt('doc-researcher'), /Never call any document write tool/);
  assert.match(childSystemPrompt('general'), /no subagent tools/);
  assert.equal(childExcludeTools(false), 'subagent_spawn,subagent_wait,subagent_cancel,subagent_check,subagent_list,workflow,ask_user');
  assert.match(childExcludeTools(true), /bash,edit,write/);
});

test('child argv inherits model and strips nested spawn tools', () => {
  const argv = buildChildArgv({
    model: 'openrouter/deepseek/deepseek-chat-v3.1',
    effort: 'high',
    reasoning: true,
    sessionDir: '/pi/sessions',
    sessionId: 'sa-1',
    prompt: '2쪽을 정리해',
    role: 'doc-editor',
    planningRestricted: true,
  });
  assert.deepEqual(argv.slice(0, 6), [
    '--mode', 'json', '--model', 'openrouter/deepseek/deepseek-chat-v3.1', '--thinking', 'high',
  ]);
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'sa-1');
  assert.match(argv[argv.indexOf('--exclude-tools') + 1], /subagent_spawn/);
  assert.match(argv[argv.indexOf('--exclude-tools') + 1], /bash,edit,write/);
  assert.equal(argv.at(-1), '2쪽을 정리해');
});

test('spawn id is read from details or the result text', () => {
  assert.equal(spawnIdFromResult({ details: { id: 'sa-3' } }), 'sa-3');
  assert.equal(spawnIdFromResult({ content: [{ type: 'text', text: 'Started sa-9 "조사"' }] }), 'sa-9');
  assert.equal(spawnIdFromResult({ details: { id: 'nope' } }), null);
});

test('assistant text is folded from jsonl deltas', () => {
  const stdout = [
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '고쳤' } }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '다.' } }),
  ].join('\n');
  assert.equal(assistantTextFromJsonl(stdout), '고쳤다.');
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = null;

  kill(signal) {
    this.killed = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

test('manager caps running children and wait/cancel settle the records', async () => {
  const spawned = [];
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'deepseek/deepseek-chat-v3.1',
    effort: 'high',
    reasoning: true,
    sessionDir: '/pi/sessions',
    env: {
      RHWP_AGENT_WORKFLOW: 'direct',
      PI_CODING_AGENT_DIR: '/pi/agent',
    },
    spawnProcess(command, argv, options) {
      const proc = new FakeChild();
      spawned.push({ command, argv, options, proc });
      return proc;
    },
  });

  const first = manager.spawn({ prompt: '1쪽', name: '1쪽', role: 'doc-editor', cwd: process.cwd() });
  const second = manager.spawn({ prompt: '2쪽', name: '2쪽', role: 'doc-researcher', cwd: process.cwd() });
  assert.equal(first.id, 'sa-1');
  assert.equal(second.role, 'doc-researcher');
  assert.equal(manager.runningCount(), 2);
  assert.equal(spawned[0].command, '/pi/bin/pi');
  assert.equal(spawned[0].argv[spawned[0].argv.indexOf('--session-id') + 1], 'sa-1');
  assert.equal(path.isAbsolute(first.cwd), true);

  spawned[0].proc.stdout.emit('data', `${JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: '1쪽 끝' },
  })}\n`);
  spawned[0].proc.emit('exit', 0, null);
  await manager.waitFor(['sa-1']);
  assert.equal(manager.get('sa-1')?.status, 'done');
  assert.match(manager.snapshot(manager.get('sa-1')), /1쪽 끝/);

  const cancelled = manager.cancel(['sa-2']);
  assert.match(cancelled[0], /Cancelled sa-2/);
  await second.done;
  assert.equal(manager.get('sa-2')?.status, 'error');
  assert.equal(terminalFleetStatus(manager.get('sa-1')), 'completed');
  assert.equal(terminalFleetStatus(manager.get('sa-2')), 'stopped');
});

test('spawn fails fast when no session directory is configured', () => {
  assert.throws(
    () => resolveSubagentSessionDir({}, {}),
    /session dir is not set/,
  );
  assert.equal(
    resolveSubagentSessionDir({}, { PI_CODING_AGENT_DIR: '/pi/agent' }),
    path.resolve('/pi/agent', '..', 'sessions'),
  );
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'deepseek/deepseek-chat-v3.1',
    env: {},
    spawnProcess() {
      throw new Error('should not spawn');
    },
  });
  assert.throws(
    () => manager.spawn({ prompt: '1쪽', name: '1쪽', cwd: process.cwd() }),
    /session dir is not set/,
  );
});

test('waitFor on settled ids does not arm abort', async () => {
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'deepseek/deepseek-chat-v3.1',
    sessionDir: '/pi/sessions',
    env: {},
    spawnProcess() {
      return new FakeChild();
    },
  });
  const rec = manager.spawn({ prompt: '1쪽', name: '1쪽', cwd: process.cwd() });
  rec.proc.emit('exit', 0, null);
  const ac = new AbortController();
  await manager.waitFor([rec.id], ac.signal);
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);

  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  ac.abort();
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
});

test('waitFor still rejects when the signal aborts a running child', async () => {
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'deepseek/deepseek-chat-v3.1',
    sessionDir: '/pi/sessions',
    env: {},
    spawnProcess() {
      return new FakeChild();
    },
  });
  const rec = manager.spawn({ prompt: '1쪽', name: '1쪽', cwd: process.cwd() });
  const ac = new AbortController();
  const waiting = manager.waitFor([rec.id], ac.signal);
  ac.abort();
  await assert.rejects(waiting, /Wait aborted/);
  rec.proc.emit('exit', 0, null);
  await rec.done;
});

test('waitFor throws when the signal is already aborted and a child is still running', async () => {
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'deepseek/deepseek-chat-v3.1',
    sessionDir: '/pi/sessions',
    env: {},
    spawnProcess() {
      return new FakeChild();
    },
  });
  const rec = manager.spawn({ prompt: '1쪽', name: '1쪽', cwd: process.cwd() });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(manager.waitFor([rec.id], ac.signal), /Wait aborted/);
  rec.proc.emit('exit', 0, null);
  await rec.done;
});

test('waitFor on settled ids ignores a signal that is already aborted', async () => {
  const manager = createSubagentManager({
    piBin: '/pi/bin/pi',
    model: 'deepseek/deepseek-chat-v3.1',
    sessionDir: '/pi/sessions',
    env: {},
    spawnProcess() {
      return new FakeChild();
    },
  });
  const rec = manager.spawn({ prompt: '1쪽', name: '1쪽', cwd: process.cwd() });
  rec.proc.emit('exit', 0, null);
  const ac = new AbortController();
  ac.abort();
  await manager.waitFor([rec.id], ac.signal);
  assert.equal(manager.get(rec.id)?.status, 'done');
});
