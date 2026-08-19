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

test('trailing stdout from a killed child never reaches the next turn', async () => {
  const { lifecycle, events } = makeLifecycle();
  const lines = [];
  const stale = new FakeProcess();
  lifecycle.beginTurn();
  lifecycle.attachChild(stale, (obj) => lines.push(obj));
  // 사용자가 중단을 누르고 곧바로 다음 메시지를 보낸다 — 이전 자식은 아직 살아 있다.
  lifecycle.interrupt();
  lifecycle.beginTurn();
  const fresh = new FakeProcess();
  lifecycle.attachChild(fresh, (obj) => lines.push(obj));

  // 죽어가던 프로세스가 버퍼에 남아 있던 NDJSON 을 뒤늦게 흘린다.
  stale.stdout.emit('data', '{"type":"assistant"}\n{"type":"result"}\n');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(lines, [], '이전 턴의 출력은 파싱조차 하지 않는다');
  assert.deepEqual(events.map((event) => event.type), ['turn-start', 'turn-end', 'turn-start']);
  assert.equal(lifecycle.isTurnOpen(), true);

  // 현재 자식의 출력은 그대로 통과한다.
  fresh.stdout.emit('data', '{"type":"result"}\n');
  assert.deepEqual(lines, [{ type: 'result' }]);
});
