import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createLineReader,
  createTurnProcessLifecycle,
  redactDiagnosticText,
} from '../agents/backend.mjs';

class FakeStream extends EventEmitter {}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode = null;
  signalCode = null;
}

test('provider diagnostics redact explicit and key-shaped credentials', () => {
  const diagnostic = redactDiagnosticText(
    'token=session-secret Authorization: Bearer abcdefghijkl '
      + 'api_key="provider-secret" sk-or-v1-0123456789abcdef '
      + 'sk-ant-api03-abcdefghijklmnop '
      + 'https://user:password@example.com/oauth?code=oauth-code-123&state=state-secret '
      + 'oauth_code=assignment-secret C:\\Users\\tester\\.claude\\logs',
    ['session-secret'],
  );
  assert.doesNotMatch(
    diagnostic,
    /session-secret|abcdefghijkl|provider-secret|0123456789abcdef|password|oauth-code-123|state-secret|assignment-secret/,
  );
  assert.match(diagnostic, /\[redacted\]/);
  assert.ok(diagnostic.includes('C:\\Users\\tester\\.claude\\logs'));
});

test('provider NDJSON line buffering discards oversized frames and recovers at the next newline', () => {
  const frames = [];
  let overflows = 0;
  const read = createLineReader((frame) => frames.push(frame), {
    maxLineBytes: 16,
    onOverflow: () => { overflows += 1; },
  });
  read('{"oversized":"xxxxxxxxxxxxxxxxxxxxxxxx');
  read('\n{"ok":true}\n');
  assert.equal(overflows, 1);
  assert.deepEqual(frames, [{ ok: true }]);
});

test('provider NDJSON preserves UTF-8 code points split across chunks', () => {
  const frames = [];
  const read = createLineReader((frame) => frames.push(frame));
  const encoded = Buffer.from('{"text":"한글🙂"}\n{"tail":"끝"}', 'utf8');
  const koreanSplit = encoded.indexOf(Buffer.from('한', 'utf8')) + 1;
  const emojiSplit = encoded.indexOf(Buffer.from('🙂', 'utf8')) + 2;
  read(encoded.subarray(0, koreanSplit));
  read(encoded.subarray(koreanSplit, emojiSplit));
  read(encoded.subarray(emojiSplit));
  read.end();

  assert.deepEqual(frames, [{ text: '한글🙂' }, { tail: '끝' }]);
});

test('provider NDJSON discard drops a complete buffered frame without a newline', () => {
  const frames = [];
  const read = createLineReader((frame) => frames.push(frame));

  read('{"type":"result","status":"completed"}');
  read.discard();
  read.end();

  assert.deepEqual(frames, []);
});

test('provider lifecycles flush an unterminated terminal frame only after a drained close', () => {
  const backend = readFileSync(new URL('../agents/backend.mjs', import.meta.url), 'utf8');
  const codex = readFileSync(new URL('../agents/codex.mjs', import.meta.url), 'utf8');
  const pi = readFileSync(new URL('../agents/pi.mjs', import.meta.url), 'utf8');
  const claude = readFileSync(new URL('../agents/claude.mjs', import.meta.url), 'utf8');

  assert.match(backend, /if \(fromClose\) flushOutput\(\);\s*else discardOutput\(\);[\s\S]{0,240}completedAtDrain = fromClose && turnCompleted;/);
  assert.match(codex, /if \(fromClose\) endOutput\(\);\s*else discardOutput\(\);\s*completedAtDrain = fromClose && turnCompleted;/);
  assert.match(pi, /if \(fromClose\) endOutput\(\);\s*else discardOutput\(\);\s*completedAtDrain = fromClose && turnCompleted;/);
  assert.match(claude, /if \(fromClose\) endOutput\(\);\s*else discardOutput\(\);\s*lifecycleState\.completedAtDrain = !turnOpen && hasCompletedTurn;/);
  assert.match(backend, /suppressCurrentOutput = \(\) => \{\s*if \(proc === child\) discardOutput\(\)/);
  assert.match(codex, /suppressChildOutput = \(\) => \{\s*if \(proc === child\) discardOutput\(\)/);
  assert.match(pi, /suppressChildOutput = \(\) => \{\s*if \(proc === child\) discardOutput\(\)/);
  assert.match(claude, /suppressChildOutput = \(\) => \{\s*if \(proc === child\) discardOutput\(\)/);
});

/** graceMs 를 짧게 준 수명주기와 이벤트 배열을 함께 돌려준다. */
function makeLifecycle(extra = {}) {
  const events = [];
  const lifecycle = createTurnProcessLifecycle({
    agent: 'grok',
    onEvent: (event) => events.push(event),
    formatExitError: (stderrText, code, signal) => `중단 (${signal ?? code}): ${stderrText.trim()}`,
    terminateProcess: () => {},
    waitForExit: async () => true,
    graceMs: 5,
    ...extra,
  });
  return { lifecycle, events };
}

test('interrupt discards a buffered terminal frame and emits only interrupted', async () => {
  const { lifecycle, events } = makeLifecycle();
  const proc = new FakeProcess();
  let terminalFrames = 0;
  let commits = 0;
  lifecycle.beginTurn();
  lifecycle.attachChild(proc, (frame) => {
    if (frame.type !== 'result') return;
    terminalFrames += 1;
    lifecycle.markTurnCompleted();
    commits += 1;
    lifecycle.endTurn({ type: 'turn-end', agent: 'grok', stopReason: 'completed' });
  });

  proc.stdout.emit('data', '{"type":"result","status":"completed"}');
  lifecycle.interrupt();
  proc.exitCode = 0;
  proc.emit('exit', 0, null);
  proc.emit('close', 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(terminalFrames, 0);
  assert.equal(commits, 0);
  assert.deepEqual(
    events.filter((event) => event.type === 'turn-end'),
    [{ type: 'turn-end', agent: 'grok', stopReason: 'interrupted' }],
  );
});

test('exit grace without close discards a buffered terminal frame and cannot commit', async () => {
  const { lifecycle, events } = makeLifecycle({
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });
  const proc = new FakeProcess();
  let terminalFrames = 0;
  let commits = 0;
  lifecycle.beginTurn();
  lifecycle.attachChild(proc, (frame) => {
    if (frame.type !== 'result') return;
    terminalFrames += 1;
    lifecycle.markTurnCompleted();
    commits += 1;
    lifecycle.endTurn({ type: 'turn-end', agent: 'grok', stopReason: 'completed' });
  });

  proc.stdout.emit('data', '{"type":"result","status":"completed"}');
  proc.exitCode = 0;
  proc.emit('exit', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(terminalFrames, 0);
  assert.equal(commits, 0);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'grok', stopReason: 'exited' });
  assert.equal(await lifecycle.dispose(), false);
});

test('exit grace without close cannot commit a newline-terminated terminal frame', async () => {
  const { lifecycle, events } = makeLifecycle({
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });
  const proc = new FakeProcess();
  let terminalFrames = 0;
  lifecycle.beginTurn();
  lifecycle.attachChild(proc, (frame) => {
    if (frame.type !== 'result') return;
    terminalFrames += 1;
    lifecycle.markTurnCompleted();
  });

  proc.stdout.emit('data', '{"type":"result","status":"completed"}\n');
  proc.exitCode = 0;
  proc.emit('exit', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(terminalFrames, 1, 'the terminated NDJSON frame is parsed before exit');
  assert.equal(
    events.some((event) => event.type === 'turn-end' && event.stopReason === 'completed'),
    false,
  );
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'grok', stopReason: 'exited' });
  assert.equal(await lifecycle.dispose(), false);
});

// 하니스 테스트는 언제나 'close' 를 함께 내므로 이 폴백 경로를 밟지 않는다.
test("an 'exit' without a following 'close' settles the turn after the grace window", async () => {
  const { lifecycle, events } = makeLifecycle();
  const proc = new FakeProcess();
  lifecycle.beginTurn();
  lifecycle.attachChild(proc, () => {});

  proc.stderr.emit('data', 'boom\n');
  proc.exitCode = 3;
  proc.emit('exit', 3, null);

  // 자손이 파이프를 붙들고 있어 'close' 는 오지 않는다.
  assert.deepEqual(events.map((event) => event.type), ['turn-start']);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(events.map((event) => event.type), ['turn-start', 'error', 'turn-end']);
  assert.equal(events[1].message, '중단 (3): boom');
  assert.deepEqual(events[2], { type: 'turn-end', agent: 'grok', stopReason: 'exited' });
  assert.equal(lifecycle.isTurnOpen(), false);
});

test('leader exit retains tree identity through held stdout and delayed disposal', async () => {
  let finishTermination;
  let finishTreeWait;
  let terminationCalls = 0;
  const termination = new Promise((resolve) => { finishTermination = resolve; });
  const treeWait = new Promise((resolve) => { finishTreeWait = resolve; });
  const { lifecycle, events } = makeLifecycle({
    terminateProcess: () => {
      terminationCalls += 1;
      return termination;
    },
    waitForExit: () => treeWait,
  });
  const proc = new FakeProcess();
  lifecycle.beginTurn();
  lifecycle.attachChild(proc, () => {});
  lifecycle.markTurnCompleted();
  proc.exitCode = 0;
  proc.emit('exit', 0, null);

  // A descendant still owns stdout, so no `close` arrives. Grace can settle the
  // turn but cannot authorize success; disposal reuses the in-flight tree proof.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'grok', stopReason: 'exited' });
  let disposalSettled = false;
  const disposed = lifecycle.dispose().then((value) => {
    disposalSettled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposalSettled, false);
  assert.equal(terminationCalls, 1);

  finishTermination(true);
  finishTreeWait(false);
  assert.equal(await disposed, false);
  assert.equal(await lifecycle.dispose(), false);
});

test('an unavailable tree proof never releases direct lifecycle ownership', async () => {
  const { lifecycle } = makeLifecycle({
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });
  const proc = new FakeProcess();
  lifecycle.beginTurn();
  lifecycle.attachChild(proc, () => {});

  const disposed = lifecycle.dispose();
  proc.signalCode = 'SIGTERM';
  proc.emit('exit', null, 'SIGTERM');
  proc.emit('close', null, 'SIGTERM');
  assert.equal(await disposed, false);
  assert.equal(await lifecycle.waitForChildExit(), false);
});

test('a fresh child cannot attach while the previous process tree is still owned', async () => {
  const { lifecycle, events } = makeLifecycle();
  const stale = new FakeProcess();
  lifecycle.beginTurn();
  lifecycle.attachChild(stale, () => {});
  assert.throws(
    () => lifecycle.attachChild(new FakeProcess(), () => {}),
    /process-tree cleanup is still pending/,
  );

  stale.exitCode = 1;
  stale.emit('exit', 1, null);
  stale.emit('close', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(events.map((event) => event.type), ['turn-start', 'error', 'turn-end']);
  assert.equal(lifecycle.isTurnOpen(), false);
});

test('a queued turn waits for cleanup proof and ignores trailing stdout from the old child', async () => {
  let finishTermination;
  let finishTreeWait;
  const termination = new Promise((resolve) => { finishTermination = resolve; });
  const treeWait = new Promise((resolve) => { finishTreeWait = resolve; });
  const { lifecycle, events } = makeLifecycle({
    terminateProcess: () => termination,
    waitForExit: () => treeWait,
  });
  const lines = [];
  const stale = new FakeProcess();
  lifecycle.beginTurn();
  lifecycle.attachChild(stale, (obj) => lines.push(obj));
  lifecycle.interrupt();
  const fresh = new FakeProcess();
  let freshStarted = false;
  lifecycle.queueTurn(() => {}, () => {
    freshStarted = true;
    lifecycle.attachChild(fresh, (obj) => lines.push(obj));
  });

  stale.stdout.emit('data', '{"type":"assistant"}\n{"type":"result"}\n');
  stale.exitCode = 0;
  stale.emit('exit', 0, null);
  stale.emit('close', 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(freshStarted, false, 'the next process cannot spawn before cleanup is proven');
  finishTermination(true);
  finishTreeWait(true);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(lines, [], '이전 턴의 출력은 파싱조차 하지 않는다');
  assert.deepEqual(events.map((event) => event.type), ['turn-start', 'turn-end', 'turn-start']);
  assert.equal(freshStarted, true);
  assert.equal(lifecycle.isTurnOpen(), true);

  fresh.stdout.emit('data', '{"type":"result"}\n');
  assert.deepEqual(lines, [{ type: 'result' }]);
});

test('a successful drained close settles once but quarantines the session without tree proof', async () => {
  const { lifecycle, events } = makeLifecycle({
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });
  const proc = new FakeProcess();
  let spawns = 0;
  lifecycle.queueTurn(() => {}, () => {
    spawns += 1;
    lifecycle.attachChild(proc, () => {});
  });
  lifecycle.markTurnCompleted();
  proc.exitCode = 0;
  proc.emit('exit', 0, null);
  proc.emit('close', 0, null);

  assert.equal(await lifecycle.waitForChildExit(), false);
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'grok', stopReason: 'completed',
  });
  assert.equal(lifecycle.isCleanupUncertain(), true);

  lifecycle.queueTurn(() => {}, () => { spawns += 1; });
  assert.equal(spawns, 1, 'the quarantined session must never spawn again');
  assert.deepEqual(events.map((event) => event.type), ['turn-start', 'turn-end', 'error', 'turn-end']);
  assert.match(events.at(-2).message, /cleanup could not be confirmed/);
  assert.equal(await lifecycle.dispose(), false);
});

test('Windows terminal cleanup starts with a live leader and permits a proven follow-up turn', async () => {
  const children = [new FakeProcess(), new FakeProcess()];
  let spawns = 0;
  let liveCleanupCalls = 0;
  const { lifecycle } = makeLifecycle({
    platform: 'win32',
    terminateProcess(proc) {
      assert.equal(proc.exitCode, null);
      assert.equal(proc.signalCode, null);
      liveCleanupCalls += 1;
      return true;
    },
    waitForExit: async () => true,
  });
  const start = () => {
    const proc = children[spawns];
    spawns += 1;
    lifecycle.attachChild(proc, () => {});
  };

  lifecycle.queueTurn(() => {}, start);
  lifecycle.markTurnCompleted();
  await lifecycle.beginTerminalCleanup();
  children[0].exitCode = 0;
  children[0].emit('exit', 0, null);
  children[0].emit('close', 0, null);
  assert.equal(await lifecycle.waitForChildExit(), true);

  lifecycle.queueTurn(() => {}, start);
  assert.equal(spawns, 2);
  assert.equal(liveCleanupCalls, 1);
  const disposing = lifecycle.dispose();
  children[1].signalCode = 'SIGTERM';
  children[1].emit('exit', null, 'SIGTERM');
  children[1].emit('close', null, 'SIGTERM');
  assert.equal(await disposing, true);
});
