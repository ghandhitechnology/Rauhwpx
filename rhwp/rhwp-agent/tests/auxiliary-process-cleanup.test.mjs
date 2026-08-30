import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { generateChatTitle } from '../agents/title.mjs';
import { generateSkillDraft } from '../skill-generator.mjs';
import { calibrateWritingStyle } from '../style-calibrator.mjs';

class FakeStream extends EventEmitter {
  end(value) { this.value = value; }
  setEncoding() {}
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStream();
  exitCode = null;
  signalCode = null;
  pid = 7001;
}

function gatedTermination(child) {
  let release;
  const completion = new Promise((resolve) => { release = resolve; });
  return {
    release,
    terminateProcess(proc) {
      assert.equal(proc, child);
      proc.signalCode = 'SIGTERM';
      proc.emit('exit', null, 'SIGTERM');
      return completion;
    },
  };
}

test('chat-title output cap waits for tree cleanup before returning a fallback', async () => {
  const child = new FakeProcess();
  const gate = gatedTermination(child);
  const title = generateChatTitle('긴 대화', {
    spawnProcess: () => child,
    terminateProcess: gate.terminateProcess,
  });
  let settled = false;
  void title.finally(() => { settled = true; });

  child.stdout.emit('data', 'x'.repeat((64 * 1024) + 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gate.release(true);
  assert.equal(await title, null);
});

test('skill output cap waits for tree cleanup before rejecting', async () => {
  const child = new FakeProcess();
  const gate = gatedTermination(child);
  const draft = generateSkillDraft({
    agent: 'claude',
    goal: 'test cleanup',
    triggerExamples: '',
    nonTriggerExamples: '',
    resourceNotes: '',
  }, {
    spawnProcess: () => child,
    terminateProcess: gate.terminateProcess,
  });
  let settled = false;
  void draft.catch(() => {}).finally(() => { settled = true; });

  child.stdout.emit('data', Buffer.alloc((8 * 1024 * 1024) + 1, 0x78));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gate.release(true);
  await assert.rejects(draft, /8 MiB safety limit/);
});

test('style calibration output cap waits for tree cleanup before rejecting', async () => {
  const child = new FakeProcess();
  const gate = gatedTermination(child);
  const source = Buffer.from('문장은 짧고 판단은 분명합니다.\n\n'.repeat(2_000));
  let spawned = false;
  const calibration = calibrateWritingStyle({
    agent: 'codex',
    language: 'ko',
    files: [{
      name: 'sample.txt',
      type: 'text/plain',
      size: source.byteLength,
      content: source.toString('base64'),
    }],
  }, {
    spawnProcess() {
      spawned = true;
      return child;
    },
    terminateProcess: gate.terminateProcess,
  });
  while (!spawned) await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  void calibration.catch(() => {}).finally(() => { settled = true; });

  child.stdout.emit('data', Buffer.alloc((8 * 1024 * 1024) + 1, 0x78));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gate.release(true);
  await assert.rejects(calibration, { code: 'OUTPUT_TOO_LARGE' });
});
