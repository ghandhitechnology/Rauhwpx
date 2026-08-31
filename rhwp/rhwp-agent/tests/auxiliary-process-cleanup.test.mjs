import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import test from 'node:test';

import { generateChatTitle } from '../agents/title.mjs';
import { generateSkillDraft } from '../skill-generator.mjs';
import { calibrateWritingStyle, STYLE_AXES } from '../style-calibrator.mjs';
import { PROCESS_TREE_CLEANUP_OUTCOME } from '../process-tree.mjs';

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

test('chat title keeps a parsed result from a successful drained close when proof is unavailable', async () => {
  const child = new FakeProcess();
  const title = generateChatTitle('문서 정리', {
    spawnProcess: () => child,
    terminateProcess: async () => null,
  });

  child.stdout.emit('data', `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '문서 정리' },
  })}\n`);
  child.exitCode = 0;
  child.emit('close', 0, null);

  assert.equal(await title, '문서 정리');
});

test('chat title starts hub-owned cleanup at the terminal event before leader exit', async () => {
  const child = new FakeProcess();
  let cleanups = 0;
  const title = generateChatTitle('문서 정리', {
    spawnProcess: () => child,
    cleanupProcessOutcome(proc) {
      cleanups += 1;
      assert.equal(proc, child);
      assert.equal(proc.exitCode, null);
      return PROCESS_TREE_CLEANUP_OUTCOME.PROVEN;
    },
  });

  child.stdout.emit('data', `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '문서 정리' },
  })}\n`);

  assert.equal(await title, '문서 정리');
  assert.equal(cleanups, 1);
});

test('chat title discards parsed output from a nonzero drained close', async () => {
  const child = new FakeProcess();
  const title = generateChatTitle('문서 정리', {
    spawnProcess: () => child,
    terminateProcess: async () => null,
  });

  child.stdout.emit('data', `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '사용하면 안 되는 제목' },
  })}\n`);
  child.exitCode = 1;
  child.emit('close', 1, null);

  assert.equal(await title, null);
});

test('chat title handles an asynchronous stdin pipe failure', async () => {
  const child = new FakeProcess();
  const title = generateChatTitle('문서 정리', {
    spawnProcess: () => child,
    cleanupProcessOutcome: async () => PROCESS_TREE_CLEANUP_OUTCOME.PROVEN,
  });

  child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }));
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

test('skill generation handles an asynchronous stdin pipe failure', async () => {
  const child = new FakeProcess();
  const draft = generateSkillDraft({
    agent: 'claude',
    goal: 'test stdin failure',
    triggerExamples: '',
    nonTriggerExamples: '',
    resourceNotes: '',
  }, {
    spawnProcess: () => child,
    cleanupProcessOutcome: async () => PROCESS_TREE_CLEANUP_OUTCOME.PROVEN,
  });

  child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }));
  await assert.rejects(draft, /pipe closed/);
});

test('skill generation keeps a drained result but retains its unproven workspace', async (t) => {
  const child = new FakeProcess();
  let workspace = null;
  const expected = {
    name: 'audit-skill',
    files: [{ path: 'SKILL.md', content: '---\nname: audit-skill\ndescription: Test\n---\n\nRun the audit.' }],
  };
  const draft = generateSkillDraft({
    agent: 'codex',
    goal: 'test natural close',
    triggerExamples: '',
    nonTriggerExamples: '',
    resourceNotes: '',
  }, {
    spawnProcess(command, args, options) {
      workspace = options.cwd;
      queueMicrotask(() => {
        child.stdout.emit('data', `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify(expected) },
        })}\n`);
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    },
    terminateProcess: async () => null,
  });

  assert.deepEqual(await draft, expected);
  await fs.access(workspace);
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
});

test('skill generation starts hub-owned cleanup from its complete Codex payload', async () => {
  const child = new FakeProcess();
  const expected = {
    name: 'terminal-skill',
    files: [{ path: 'SKILL.md', content: '---\nname: terminal-skill\ndescription: Test\n---\n\nRun it.' }],
  };
  let cleanups = 0;
  const draft = generateSkillDraft({
    agent: 'codex',
    goal: 'test terminal cleanup',
    triggerExamples: '',
    nonTriggerExamples: '',
    resourceNotes: '',
  }, {
    spawnProcess() {
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(expected) },
      })}\n`));
      return child;
    },
    cleanupProcessOutcome(proc) {
      cleanups += 1;
      assert.equal(proc.exitCode, null);
      return PROCESS_TREE_CLEANUP_OUTCOME.PROVEN;
    },
  });

  assert.deepEqual(await draft, expected);
  assert.equal(cleanups, 1);
});

test('skill validation failure cannot clear an earlier unproven-cleanup quarantine', async (t) => {
  const child = new FakeProcess();
  let workspace = null;
  const draft = generateSkillDraft({
    agent: 'codex',
    goal: 'test invalid natural close',
    triggerExamples: '',
    nonTriggerExamples: '',
    resourceNotes: '',
  }, {
    spawnProcess(command, args, options) {
      workspace = options.cwd;
      queueMicrotask(() => {
        child.stdout.emit('data', `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: '{"name":"invalid","files":[]}' },
        })}\n`);
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    },
    terminateProcess: async () => null,
  });

  await assert.rejects(draft, /files must hold 1-30 entries/);
  await fs.access(workspace);
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
});

test('skill generation preserves a natural error and retains an unproven workspace', async (t) => {
  const child = new FakeProcess();
  let workspace = null;
  const draft = generateSkillDraft({
    agent: 'codex',
    goal: 'test natural error close',
    triggerExamples: '',
    nonTriggerExamples: '',
    resourceNotes: '',
  }, {
    spawnProcess(command, args, options) {
      workspace = options.cwd;
      queueMicrotask(() => {
        child.stderr.emit('data', 'provider rejected the request');
        child.exitCode = 2;
        child.emit('close', 2, null);
      });
      return child;
    },
    terminateProcess: async () => null,
  });

  await assert.rejects(draft, /provider rejected the request/);
  await fs.access(workspace);
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
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

test('style calibration keeps a drained result but retains its unproven workspace', async (t) => {
  const child = new FakeProcess();
  const sample = [
    '예산은 3,200만 원이 남았다. 이 속도면 11월에 바닥난다.',
    '보고서는 짧게 쓴다. 표 하나와 문단 세 개면 충분하다.',
  ].join('\n\n').repeat(400);
  const analysis = {
    enoughSample: true,
    pageEquivalent: 10,
    summary: '짧은 문장과 수치가 반복됩니다.',
    unsupportedFiles: [],
    presence: {
      portrait: '숫자에 기대 단정한다.',
      temperature: '건조하다.',
      unevenness: '짧은 문단이 이어진다.',
      stance: '판단을 미루지 않는다.',
      refusals: ['추상적인 도입을 피한다'],
    },
    axes: STYLE_AXES.map((axis) => ({
      axis: axis.id,
      evidenceCount: 2,
      observation: `${axis.ko} 관찰`,
      directives: [`${axis.ko} 습관을 따른다.`],
      patterns: [],
    })),
    adaptation: [],
  };
  let workspace = null;
  const calibration = calibrateWritingStyle({
    agent: 'codex',
    language: 'ko',
    files: [{
      name: 'sample.txt',
      type: 'text/plain',
      size: Buffer.byteLength(sample),
      content: Buffer.from(sample).toString('base64'),
    }],
  }, {
    spawnProcess(command, args, options) {
      workspace = options.cwd;
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify(analysis));
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    },
    terminateProcess: async () => null,
  });

  const result = await calibration;
  assert.equal(result.summary, analysis.summary);
  await fs.access(workspace);
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
});

test('style calibration starts hub-owned cleanup from its complete analysis payload', async () => {
  const child = new FakeProcess();
  const sample = '수치를 먼저 쓴다. 판단은 짧고 분명하다.\n\n'.repeat(2_000);
  const analysis = {
    enoughSample: true,
    pageEquivalent: 10,
    summary: '짧은 문장과 수치가 반복됩니다.',
    unsupportedFiles: [],
    presence: {
      portrait: '숫자에 기대 단정한다.', temperature: '건조하다.',
      unevenness: '짧은 문단이 이어진다.', stance: '판단을 미루지 않는다.', refusals: [],
    },
    axes: STYLE_AXES.map((axis) => ({
      axis: axis.id, evidenceCount: 2, observation: `${axis.ko} 관찰`,
      directives: [`${axis.ko} 습관을 따른다.`], patterns: [],
    })),
    adaptation: [],
  };
  let cleanups = 0;
  const calibration = calibrateWritingStyle({
    agent: 'codex',
    language: 'ko',
    files: [{
      name: 'sample.txt', type: 'text/plain', size: Buffer.byteLength(sample),
      content: Buffer.from(sample).toString('base64'),
    }],
  }, {
    spawnProcess: () => child,
    cleanupProcessOutcome(proc) {
      cleanups += 1;
      assert.equal(proc.exitCode, null);
      return PROCESS_TREE_CLEANUP_OUTCOME.PROVEN;
    },
  });

  while (cleanups === 0) {
    child.stdout.emit('data', `${JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(analysis) },
    })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const result = await calibration;
  assert.equal(result.summary, analysis.summary);
  assert.equal(cleanups, 1);
});

test('style validation failure cannot clear an earlier unproven-cleanup quarantine', async (t) => {
  const child = new FakeProcess();
  const sample = '문장은 짧고 판단은 분명합니다. 표와 수치를 먼저 둡니다.\n\n'.repeat(800);
  let workspace = null;
  const calibration = calibrateWritingStyle({
    agent: 'codex',
    language: 'ko',
    files: [{
      name: 'sample.txt',
      type: 'text/plain',
      size: Buffer.byteLength(sample),
      content: Buffer.from(sample).toString('base64'),
    }],
  }, {
    spawnProcess(command, args, options) {
      workspace = options.cwd;
      queueMicrotask(() => {
        child.stdout.emit('data', '{}');
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    },
    terminateProcess: async () => null,
  });

  await assert.rejects(calibration, { code: 'INVALID_RESULT' });
  await fs.access(workspace);
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
});
