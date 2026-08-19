import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createTurnProcessLifecycle } from '../agents/backend.mjs';

class FakeStream extends EventEmitter {}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode = null;
  signalCode = null;
}

/** graceMs 를 짧게 준 수명주기와 이벤트 배열을 함께 돌려준다. */
function makeLifecycle(extra = {}) {
  const events = [];
  const lifecycle = createTurnProcessLifecycle({
    agent: 'grok',
    onEvent: (event) => events.push(event),
    formatExitError: (stderrText, code, signal) => `중단 (${signal ?? code}): ${stderrText.trim()}`,
    terminateProcess: () => {},
    graceMs: 5,
    ...extra,
  });
  return { lifecycle, events };
}

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

test('a stale child that dies after a respawn cannot close the new turn', async () => {
  const { lifecycle, events } = makeLifecycle();
  const stale = new FakeProcess();
  lifecycle.beginTurn();
  lifecycle.attachChild(stale, () => {});
  // 다음 턴이 새 프로세스를 붙인다 — 이전 프로세스는 더 이상 소유되지 않는다.
  lifecycle.beginTurn();
  lifecycle.attachChild(new FakeProcess(), () => {});

  stale.exitCode = 1;
  stale.emit('exit', 1, null);
  stale.emit('close', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(events.map((event) => event.type), ['turn-start', 'turn-start']);
  assert.equal(lifecycle.isTurnOpen(), true);
});
